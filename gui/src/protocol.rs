//! One-shot local JSONL transport. Backend payloads never become logs or error messages.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

const MAX_RESPONSE: u64 = 128 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(90);

/// Safe, locally selected errors; never includes backend messages or response bodies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcError {
    Installation,
    Process,
    Timeout,
    Protocol,
    MfaRequired,
    Backend,
}

impl RpcError {
    /// Text safe for an error label even when the backend returned sensitive data.
    pub fn message(self) -> &'static str {
        match self {
            Self::Installation => {
                "Backend missing. Place dist/ and node_modules/ beside this application (and install or bundle Node.js)."
            }
            Self::Process => {
                "Could not run the local backend. Check Node.js and the portable installation."
            }
            Self::Timeout => {
                "Request timed out. Its result is unknown; check connection or refresh the preview before retrying. No automatic retry was sent."
            }
            Self::Protocol => {
                "The backend returned an invalid or oversized response. Approval could not be verified. Reload the preview before retrying."
            }
            Self::MfaRequired => {
                "Multi-factor authentication required. Enter your current code and sign in again."
            }
            Self::Backend => {
                "The backend could not complete this request. Check connection, credentials, or whether the operation has expired. Backend details are hidden to protect note and account data."
            }
        }
    }
}

/// A request is passed only on stdin, never in process arguments or environment.
#[derive(Serialize)]
pub struct Request {
    id: u8,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<Value>,
}

impl Request {
    /// Create a request for one independent helper process.
    pub fn new(method: &'static str, params: Option<Value>) -> Self {
        Self {
            id: 1,
            method,
            account: None,
            params,
        }
    }

    /// Pin this request to the GUI's selected account, overriding inherited selection.
    pub fn for_account(mut self, account: Option<String>) -> Self {
        self.account = account;
        self
    }

    fn frame(&self) -> Result<Vec<u8>, RpcError> {
        let mut bytes = serde_json::to_vec(self).map_err(|_| RpcError::Protocol)?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    id: u8,
    ok: bool,
    result: Option<Value>,
    error: Option<BackendError>,
}

#[derive(Deserialize)]
struct BackendError {
    code: String,
}

fn parse_response(bytes: &[u8]) -> Result<Value, RpcError> {
    if bytes.len() as u64 > MAX_RESPONSE || !bytes.ends_with(b"\n") {
        return Err(RpcError::Protocol);
    }
    let frame = &bytes[..bytes.len() - 1];
    if frame.contains(&b'\n') {
        return Err(RpcError::Protocol);
    }
    let response: Response = serde_json::from_slice(frame).map_err(|_| RpcError::Protocol)?;
    if response.id != 1 {
        return Err(RpcError::Protocol);
    }
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) => Ok(result),
        (false, None, Some(error)) if error.code == "mfa_required" => Err(RpcError::MfaRequired),
        (false, None, Some(_)) => Err(RpcError::Backend),
        _ => Err(RpcError::Protocol),
    }
}

/// Resolved portable installation; contains paths only, never session data.
#[derive(Clone)]
pub struct Bridge {
    root: PathBuf,
    node: OsString,
    application: PathBuf,
    active: Arc<Mutex<ProcessState>>,
}

#[derive(Default)]
struct ProcessState {
    closed: bool,
    child: Option<Child>,
}

impl ProcessState {
    fn reap(&mut self) {
        if let Some(mut child) = self.child.take() {
            #[cfg(windows)]
            kill_windows_tree(&mut child);
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
fn kill_windows_tree(child: &mut Child) {
    use std::os::windows::process::CommandExt;
    // Only target a still-live child handle we own, never a guessed or name-matched PID.
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    let taskkill = PathBuf::from(
        std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows")),
    )
    .join("System32")
    .join("taskkill.exe");
    let Ok(mut killer) = Command::new(taskkill)
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let started = Instant::now();
    loop {
        match killer.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = killer.kill();
                let _ = killer.wait();
                return;
            }
        }
    }
}

fn helper(root: &Path) -> PathBuf {
    root.join("dist").join("gui").join("bridge.js")
}

// Node's Windows CLI rejects verbatim script names, although its cwd accepts them.
// Translate only supported absolute prefixes; preserve every remaining UTF-16 code unit.
fn node_script_argument(path: &Path) -> Result<PathBuf, RpcError> {
    #[cfg(windows)]
    {
        use std::{
            os::windows::ffi::{OsStrExt, OsStringExt},
            path::{Component, Prefix},
        };
        if !path.is_absolute() {
            return Err(RpcError::Installation);
        }
        let Some(Component::Prefix(prefix)) = path.components().next() else {
            return Err(RpcError::Installation);
        };
        let skip = match prefix.kind() {
            Prefix::Disk(_) | Prefix::UNC(_, _) => return Ok(path.to_owned()),
            Prefix::VerbatimDisk(_) => 4,
            Prefix::VerbatimUNC(_, _) => 8,
            _ => return Err(RpcError::Installation),
        };
        // Win32 trims trailing dots/spaces and resolves DOS device names. Fail closed rather
        // than translate a verbatim component into a different file/device namespace.
        if !verbatim_components_are_plain_safe(path) {
            return Err(RpcError::Installation);
        }
        let mut units = if skip == 8 {
            vec![92_u16, 92]
        } else {
            Vec::new()
        };
        units.extend(path.as_os_str().encode_wide().skip(skip));
        Ok(PathBuf::from(OsString::from_wide(&units)))
    }
    #[cfg(not(windows))]
    {
        Ok(path.to_owned())
    }
}

#[cfg(windows)]
fn verbatim_components_are_plain_safe(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    path.components().all(|part| match part {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::VerbatimUNC(server, share) => {
                plain_safe_component(server) && plain_safe_component(share)
            }
            _ => true,
        },
        Component::RootDir => true,
        Component::Normal(name) => plain_safe_component(name),
        _ => false,
    })
}

#[cfg(windows)]
fn plain_safe_component(name: &std::ffi::OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;
    let units: Vec<_> = name.encode_wide().collect();
    if matches!(units.last(), Some(32 | 46)) || units.contains(&58) || units.contains(&47) {
        return false;
    }
    let mut stem: Vec<_> = units
        .iter()
        .copied()
        .take_while(|unit| *unit != 46)
        .map(|unit| {
            if (97..=122).contains(&unit) {
                unit - 32
            } else {
                unit
            }
        })
        .collect();
    // Conservatively detect DOS names even with spaces immediately before the extension.
    // This affects rejection only; never rewrite any component in the returned path.
    while stem.last() == Some(&32) {
        stem.pop();
    }
    let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
        .iter()
        .any(|name| stem.iter().copied().eq(name.encode_utf16()));
    let numbered_device = stem.len() == 4
        && (stem[..3] == [67, 79, 77] || stem[..3] == [76, 80, 84])
        && matches!(stem[3], 49..=57 | 178 | 179 | 185);
    !device && !numbered_device
}

impl Bridge {
    /// Find an explicit root or a portable executable ancestor; there is no implicit checkout lookup.
    pub fn discover() -> Result<Self, RpcError> {
        let exe = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|_| RpcError::Installation)?;
        let root = if let Some(root) = std::env::var_os("SN_CONNECTOR_ROOT") {
            PathBuf::from(root)
        } else if let Some(root) = exe
            .parent()
            .and_then(|parent| parent.ancestors().find(|p| helper(p).is_file()))
        {
            root.to_owned()
        } else {
            return Err(RpcError::Installation);
        };
        if !helper(&root).is_file() {
            return Err(RpcError::Installation);
        }
        let bundled = exe
            .parent()
            .ok_or(RpcError::Installation)?
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let node = std::env::var_os("SN_NODE_PATH").unwrap_or_else(|| {
            if bundled.is_file() {
                bundled.into_os_string()
            } else {
                OsString::from("node")
            }
        });
        Ok(Self {
            root,
            node,
            application: exe,
            active: Arc::new(Mutex::new(ProcessState::default())),
        })
    }

    /// Close the transport and kill/reap its exact pending child before closing the window.
    pub fn close(&self) {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        active.closed = true;
        active.reap();
    }

    /// Blocking call: run exclusively on a background executor, never the UI thread.
    pub fn call(&self, request: Request) -> Result<Value, RpcError> {
        let bytes = request.frame()?;
        let mut command = Command::new(&self.node);
        command
            .arg(node_script_argument(&helper(&self.root))?)
            .current_dir(&self.root)
            // Non-secret installation metadata: future approvals launch this exact native app.
            .env("SN_GUI_PATH", &self.application)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Prevent an extra console window in the portable Windows application.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let (mut stdin, stdout) = {
            let mut active = self.active.lock().map_err(|_| RpcError::Process)?;
            if active.closed || active.child.is_some() {
                return Err(RpcError::Process);
            }
            let mut child = command.spawn().map_err(|_| RpcError::Process)?;
            let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RpcError::Process);
            };
            active.child = Some(child);
            (stdin, stdout)
        };
        let _owned_child = OwnedChild(self.active.clone());
        let (sender, receiver) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let result = (|| {
                stdin.write_all(&bytes).map_err(|_| RpcError::Process)?;
                drop(stdin);
                let mut response = Vec::new();
                stdout
                    .take(MAX_RESPONSE + 1)
                    .read_to_end(&mut response)
                    .map_err(|_| RpcError::Process)?;
                parse_response(&response)
            })();
            let _ = sender.send(result);
        });
        let started = Instant::now();
        loop {
            let status = {
                let mut active = self.active.lock().map_err(|_| RpcError::Process)?;
                active
                    .child
                    .as_mut()
                    .ok_or(RpcError::Process)?
                    .try_wait()
                    .map_err(|_| RpcError::Process)?
            };
            if let Some(status) = status {
                if !status.success() {
                    return Err(RpcError::Process);
                }
                return receiver
                    .recv_timeout(TIMEOUT.saturating_sub(started.elapsed()))
                    .map_err(|_| RpcError::Timeout)?;
            }
            if started.elapsed() >= TIMEOUT {
                return Err(RpcError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

struct OwnedChild(Arc<Mutex<ProcessState>>);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Kill/reap only the exact child this request created, including every error path.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_are_one_line_with_secrets_only_in_stdin_payload() {
        let bytes = Request::new("login", Some(json!({"password":"synthetic\npassword"})))
            .frame()
            .expect("synthetic request serializes");
        assert_eq!(bytes.iter().filter(|&&b| b == b'\n').count(), 1);
        assert!(bytes.ends_with(b"\n"));
        let value: Value = serde_json::from_slice(&bytes).expect("request frame is JSON");
        assert_eq!(value["params"]["password"], "synthetic\npassword");
    }

    #[test]
    fn response_requires_exact_id_and_single_complete_frame() {
        assert_eq!(
            parse_response(b"{\"id\":1,\"ok\":true,\"result\":{}}\n"),
            Ok(json!({}))
        );
        for bytes in [
            b"{\"id\":2,\"ok\":true,\"result\":{}}\n".as_slice(),
            b"{\"id\":1,\"ok\":true,\"result\":{}}",
            b"{}\n{}\n",
            b"{\"id\":1,\"ok\":true,\"result\":{},\"error\":{\"code\":\"bad\"}}\n",
            b"not json\n",
        ] {
            assert_eq!(parse_response(bytes), Err(RpcError::Protocol));
        }
    }

    #[test]
    fn explicit_account_is_only_an_optional_stdin_field() {
        let implicit: Value = serde_json::from_slice(
            &Request::new("status", None)
                .frame()
                .expect("status serializes"),
        )
        .expect("valid JSON");
        assert!(implicit.get("account").is_none());
        let explicit: Value = serde_json::from_slice(
            &Request::new("pending", None)
                .for_account(Some("b@example.invalid".into()))
                .frame()
                .expect("account request serializes"),
        )
        .expect("valid JSON");
        assert_eq!(explicit["account"], "b@example.invalid");
        assert_eq!(explicit["method"], "pending");
    }

    #[cfg(not(windows))]
    #[test]
    fn native_non_windows_helper_argument_is_unchanged() {
        let path = Path::new("/synthetic space/漢字/dist/gui/bridge.js");
        assert_eq!(node_script_argument(path), Ok(path.to_owned()));
    }

    #[cfg(windows)]
    #[test]
    fn windows_node_drive_arguments_preserve_spaces_and_unicode() {
        for (input, expected) in [
            (
                r"\\?\C:\sn project\dist\gui\bridge.js",
                r"C:\sn project\dist\gui\bridge.js",
            ),
            (
                r"\\?\D:\漢字 café\dist\gui\bridge.js",
                r"D:\漢字 café\dist\gui\bridge.js",
            ),
            (
                r"C:\ordinary space\漢字\dist\gui\bridge.js",
                r"C:\ordinary space\漢字\dist\gui\bridge.js",
            ),
        ] {
            let result =
                node_script_argument(Path::new(input)).expect("supported absolute drive path");
            assert_eq!(result, Path::new(expected));
            assert!(result.is_absolute());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_node_unc_arguments_stay_absolute() {
        for (input, expected) in [
            (
                r"\\?\UNC\server\share\漢字 space\dist\gui\bridge.js",
                r"\\server\share\漢字 space\dist\gui\bridge.js",
            ),
            (
                r"\\server\share\ordinary space\dist\gui\bridge.js",
                r"\\server\share\ordinary space\dist\gui\bridge.js",
            ),
        ] {
            let result =
                node_script_argument(Path::new(input)).expect("supported absolute UNC path");
            assert_eq!(result, Path::new(expected));
            assert!(result.is_absolute());
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_node_argument_preserves_unpaired_utf16() {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let mut original: Vec<_> = r"\\?\C:\synthetic ".encode_utf16().collect();
        original.push(0xd800);
        original.extend(r"\dist\gui\bridge.js".encode_utf16());
        let result = node_script_argument(Path::new(&OsString::from_wide(&original)))
            .expect("UTF-16 path stays lossless");
        assert_eq!(
            result.as_os_str().encode_wide().collect::<Vec<_>>(),
            original[4..]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_node_argument_rejects_relative_and_ambiguous_namespaces() {
        for input in [
            r"C:relative\bridge.js",
            r"relative\bridge.js",
            r"\\.\pipe\script",
            r"\\?\Volume{test}\bridge.js",
            r"\\?\C:\folder.\dist\gui\bridge.js",
            r"\\?\C:\folder \dist\gui\bridge.js",
            r"\\?\C:\NUL\dist\gui\bridge.js",
            r"\\?\C:\COM1.txt\dist\gui\bridge.js",
            r"\\?\C:\alpha/beta\dist\gui\bridge.js",
            r"\\?\C:\NUL .txt\dist\gui\bridge.js",
            r"\\?\C:\com1 .txt\dist\gui\bridge.js",
            r"\\?\UNC\server\share.\dist\gui\bridge.js",
        ] {
            assert_eq!(
                node_script_argument(Path::new(input)),
                Err(RpcError::Installation)
            );
        }
    }

    #[test]
    fn backend_messages_never_reach_errors() {
        assert_eq!(parse_response(b"{\"id\":1,\"ok\":false,\"error\":{\"code\":\"mfa_required\",\"message\":\"synthetic secret\"}}\n"), Err(RpcError::MfaRequired));
        assert_eq!(parse_response(b"{\"id\":1,\"ok\":false,\"error\":{\"code\":\"synthetic secret\",\"message\":\"synthetic secret\"}}\n"), Err(RpcError::Backend));
        assert!(!RpcError::Backend.message().contains("synthetic secret"));
    }
}
