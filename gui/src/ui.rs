//! Native GPUI shell. It authorizes a saved preview; it never sends note writes.
use crate::{
    account::AccountState,
    layout::initial_window_bounds,
    preview::{
        approval_account_label, approval_confirmed, bound_preview_account, can_approve,
        preview_rows, valid_operation_id,
    },
    protocol::{Bridge, Request, RpcError},
    settings::mcp_settings_snippet,
};
use gpui::{prelude::*, *};
use gpui_component::{
    Disableable, Root,
    button::{Button, ButtonVariants},
    checkbox::Checkbox,
    input::{Input, InputState},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

const TITLE: &str = "Standard Notes Agent Connection";

struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        Ok((path == "icons/check.svg")
            .then(|| std::borrow::Cow::Borrowed(include_bytes!("../assets/check.svg").as_slice())))
    }
    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(if path == "icons" {
            vec!["icons/check.svg".into()]
        } else {
            Vec::new()
        })
    }
}

#[derive(Clone)]
enum Action {
    Status,
    Check,
    Login,
    Disconnect,
    Pending,
    Preview(String),
    Approve(String),
    Reject(String),
    Configure,
}
impl Action {
    fn method(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Check => "check",
            Self::Login => "login",
            Self::Disconnect => "disconnect",
            Self::Pending => "pending",
            Self::Preview(_) => "preview",
            Self::Approve(_) => "approve",
            Self::Reject(_) => "reject",
            Self::Configure => "configure",
        }
    }
    fn finalizing(&self) -> bool {
        matches!(self, Self::Approve(_) | Self::Reject(_))
    }
}

struct Connection {
    bridge: Result<Bridge, RpcError>,
    email: Entity<InputState>,
    password: Entity<InputState>,
    mfa: Entity<InputState>,
    message: String,
    account: AccountState,
    busy: bool,
    finalizing: bool,
    disconnect_confirmation: bool,
    manual_snippet: Option<String>,
    pending: Vec<String>,
    preview: Option<Value>,
    rows: Arc<Vec<String>>,
    selected: Option<String>,
    consent: bool,
    approval_mode: bool,
    approved_exit: Arc<AtomicBool>,
}

impl Connection {
    fn new(
        operation: Option<String>,
        approved_exit: Arc<AtomicBool>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let approval_mode = operation.is_some();
        let initial = operation.clone();
        let view = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            view.update(cx, |this, cx| {
                // Do not race a window-close against a durable authorization transaction.
                if this.finalizing {
                    this.message = "Waiting for the authorization result. Closing is available when this finishes.".into();
                    cx.notify();
                    return false;
                }
                if let Ok(bridge) = &this.bridge { bridge.close(); }
                this.clear_secrets(window, cx);
                true
            }).unwrap_or(true)
        });
        cx.defer_in(window, move |this, window, cx| {
            if let Some(id) = initial {
                this.load_preview(id, window, cx);
            } else {
                this.request(Action::Status, None, window, cx);
            }
        });
        Self {
            bridge: Bridge::discover(),
            email: cx.new(|cx| InputState::new(window, cx).placeholder("Email")),
            password: cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("Password")
            }),
            mfa: cx.new(|cx| {
                InputState::new(window, cx)
                    .masked(true)
                    .placeholder("MFA code (optional)")
            }),
            message: "Loading local connection…".into(),
            account: {
                let mut account = AccountState::default();
                if approval_mode {
                    account.begin(std::env::var("SN_EMAIL").ok().as_deref());
                }
                account
            },
            busy: false,
            finalizing: false,
            disconnect_confirmation: false,
            manual_snippet: None,
            pending: Vec::new(),
            preview: None,
            rows: Arc::new(Vec::new()),
            selected: operation,
            consent: false,
            approval_mode,
            approved_exit,
        }
    }

    fn clear_secrets(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // Replace the entire editor state: clearing only its value leaves an undo history.
        self.password = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("Password")
        });
        self.mfa = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("MFA code (optional)")
        });
    }

    fn fill_selected_email(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.email.read(cx).value().is_empty()
            && let Some(email) = self.account.email.clone()
        {
            self.email
                .update(cx, |input, cx| input.set_value(email, window, cx));
        }
    }

    fn secret_focused(&self, window: &Window, cx: &App) -> bool {
        self.password.read(cx).focus_handle(cx).is_focused(window)
            || self.mfa.read(cx).focus_handle(cx).is_focused(window)
    }

    fn load_preview(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || !valid_operation_id(&id) {
            return;
        }
        self.consent = false;
        self.preview = None;
        self.rows = Arc::new(Vec::new());
        self.selected = Some(id.clone());
        self.request(
            Action::Preview(id.clone()),
            Some(json!({"operationId":id})),
            window,
            cx,
        );
    }

    fn login(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let email = self.email.read(cx).value().to_string();
        let password = self.password.read(cx).value().to_string();
        let mfa = self.mfa.read(cx).value().to_string();
        if email.trim().is_empty() || password.is_empty() {
            self.message = "Enter your email and password.".into();
            cx.notify();
            return;
        }
        let mut params = json!({"email":email.trim(),"password":password});
        if !mfa.is_empty() {
            params["mfa"] = json!(mfa);
        }
        self.request(Action::Login, Some(params), window, cx);
    }

    fn request(
        &mut self,
        action: Action,
        params: Option<Value>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        if matches!(action, Action::Check | Action::Login) {
            let email = self.email.read(cx).value().to_string();
            self.account.begin(Some(&email));
            self.preview = None;
            self.rows = Arc::new(Vec::new());
            self.pending.clear();
            self.manual_snippet = None;
            self.selected = None;
            self.consent = false;
        }
        if !self.approval_mode
            && self.account.email.is_none()
            && !matches!(action, Action::Status | Action::Check | Action::Login)
        {
            self.message =
                "Enter saved account email then Check connection, or sign in first.".into();
            cx.notify();
            return;
        }
        if matches!(action, Action::Configure) {
            self.manual_snippet = None;
        }
        let bridge = match &self.bridge {
            Ok(bridge) => bridge.clone(),
            Err(error) => {
                self.message = error.message().into();
                self.clear_secrets(window, cx);
                cx.notify();
                return;
            }
        };
        self.busy = true;
        self.finalizing = action.finalizing();
        self.message = if self.finalizing {
            "Saving your decision locally…"
        } else {
            "Contacting the local backend…"
        }
        .into();
        let request = Request::new(action.method(), params).for_account(self.account.email.clone());
        let task = cx.background_executor().spawn(async move {
            let result = bridge.call(request)?;
            let rows = if matches!(action, Action::Preview(_)) {
                preview_rows(&result).map_err(|_| RpcError::Protocol)?
            } else {
                Vec::new()
            };
            Ok::<_, RpcError>((result, rows, action))
        });
        cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                this.finalizing = false;
                match result {
                    Ok((value, rows, action)) => this.complete(action, value, rows, window, cx),
                    Err(error) => {
                        this.message = error.message().into();
                        // MFA retry deliberately retains password. All other completions clear it.
                        if error != RpcError::MfaRequired {
                            this.clear_secrets(window, cx);
                        }
                        this.consent = false;
                        this.preview = None;
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn complete(
        &mut self,
        action: Action,
        value: Value,
        rows: Vec<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            Action::Status => {
                if self.account.saved_status(&value) {
                    self.fill_selected_email(window, cx);
                    self.request(Action::Pending, None, window, cx);
                } else {
                    self.message = self.account.label();
                }
            }
            Action::Check | Action::Login => {
                self.clear_secrets(window, cx);
                self.message = if self.account.connected(&value) {
                    self.fill_selected_email(window, cx);
                    self.account.label()
                } else {
                    RpcError::Protocol.message().into()
                };
            }
            Action::Disconnect => {
                self.clear_secrets(window, cx);
                self.disconnect_confirmation = false;
                self.manual_snippet = None;
                self.preview = None;
                self.rows = Arc::new(Vec::new());
                self.pending.clear();
                self.consent = false;
                self.account.begin(None);
                self.message = if value["disconnected"] == true {
                    "Disconnected. Local saved session removed; notes were not deleted."
                } else {
                    RpcError::Protocol.message()
                }
                .into();
            }
            Action::Pending => {
                if let Some(items) = value.as_array() {
                    self.pending = items
                        .iter()
                        .filter_map(|item| item["operationId"].as_str())
                        .filter(|id| valid_operation_id(id))
                        .map(str::to_owned)
                        .collect();
                    self.message = format!(
                        "{} pending edits. Select one to inspect the complete saved preview.",
                        self.pending.len()
                    );
                } else {
                    self.message = RpcError::Protocol.message().into();
                }
            }
            Action::Preview(id) => {
                if value["operationId"].as_str() != Some(&id) || value.get("preview").is_none() {
                    self.message = RpcError::Protocol.message().into();
                    return;
                }
                let Some(email) = bound_preview_account(&value, self.account.email.as_deref())
                else {
                    self.preview = None;
                    self.rows = Arc::new(Vec::new());
                    self.consent = false;
                    self.message = "The backend did not bind this preview to a saved account. Approval is disabled; reload only after selecting the correct saved account.".into();
                    return;
                };
                // Pin the authoritative journal identity for every later approval/rejection request.
                self.account.email = Some(email);
                self.preview = Some(value);
                self.rows = Arc::new(rows);
                self.consent = false;
                self.message = "Saved preview loaded. Review all before/after content; approval does not itself write notes.".into();
            }
            Action::Approve(id) => {
                self.consent = false;
                if approval_confirmed(&value, &id) {
                    self.message =
                        "Approval saved. Your agent may now send this exact operation.".into();
                    self.preview = None;
                    self.rows = Arc::new(Vec::new());
                    self.pending.retain(|p| p != &id);
                    if self.approval_mode {
                        self.approved_exit.store(true, Ordering::SeqCst);
                        self.clear_secrets(window, cx);
                        cx.quit();
                    }
                } else {
                    self.preview = None;
                    self.message = RpcError::Protocol.message().into();
                }
            }
            Action::Reject(id) => {
                self.consent = false;
                if value["rejected"] == true && value["operationId"].as_str() == Some(&id) {
                    self.preview = None;
                    self.rows = Arc::new(Vec::new());
                    self.pending.retain(|p| p != &id);
                    self.message =
                        "Rejected. This operation can no longer be approved or committed.".into();
                    if self.approval_mode {
                        self.clear_secrets(window, cx);
                        cx.quit();
                    }
                } else {
                    self.preview = None;
                    self.message = RpcError::Protocol.message().into();
                }
            }
            Action::Configure => {
                if let (Some(configured), Some(preserved)) = (
                    value["configured"].as_array(),
                    value["preserved"].as_array(),
                ) {
                    let manual = value.get("manual").and_then(Value::as_array);
                    let manual_count = manual.map_or(0, Vec::len);
                    self.manual_snippet = manual
                        .and_then(|items| items.first())
                        .and_then(|item| mcp_settings_snippet(&item["entry"]));
                    self.message = format!(
                        "Agent connection enabled for {} clients. {} existing entries preserved. {} existing configs need explicit import.",
                        configured.len(),
                        preserved.len(),
                        manual_count
                    );
                } else {
                    self.message = RpcError::Protocol.message().into();
                }
            }
        }
    }
}

// No content is interpreted as rich text, including status and preview strings.
impl Render for Connection {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact =
            window.viewport_size().width < px(1000.) || window.viewport_size().height < px(760.);
        let busy = self.busy;
        let selected = self.selected.clone().unwrap_or_default();
        let allowed = can_approve(
            self.preview.as_ref(),
            &selected,
            self.consent,
            busy,
            self.account.email.as_deref(),
        );
        let has_preview = self.preview.is_some();
        let mut root = div()
            .flex()
            .flex_col()
            .size_full()
            .p_5()
            .gap_3()
            .bg(rgb(0xf6f8fc))
            .text_color(rgb(0x172033))
            .text_size(px(15.))
            .when(compact, |this| this.p_3().gap_2())
            // Capture the actions, not key chords: popup/OS menu dispatch uses these too.
            // GPUI Component 0.5.1 otherwise copies masked credentials to clipboard/history.
            .capture_action(
                cx.listener(|this, _: &gpui_component::input::Copy, window, cx| {
                    if this.secret_focused(window, cx) {
                        cx.stop_propagation();
                    } else {
                        cx.propagate();
                    }
                }),
            )
            .capture_action(
                cx.listener(|this, _: &gpui_component::input::Cut, window, cx| {
                    if this.secret_focused(window, cx) {
                        cx.stop_propagation();
                    } else {
                        cx.propagate();
                    }
                }),
            );
        root = root.child(div().text_xl().child(TITLE)).child(div().child("Standard Notes sync is end-to-end encrypted. Notes shared with a cloud AI are visible to that AI provider."));
        if self.approval_mode {
            root = root.child(approval_account_label(
                self.preview.as_ref(),
                self.account.email.as_deref(),
            ));
        } else {
            root = root.child(self.account.label())
                .child(div().text_size(px(12.)).child("Email selects a saved account for Check connection. Other actions use the account shown above."));
        }
        if !self.approval_mode {
            root = root
                .child(
                    div()
                        .flex()
                        .gap_2()
                        .child(Input::new(&self.email).disabled(busy).flex_1().min_w_0())
                        .child(Input::new(&self.password).disabled(busy).flex_1().min_w_0())
                        .child(Input::new(&self.mfa).disabled(busy).flex_1().min_w_0()),
                )
                .child(
                    div()
                        .flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            Button::new("login")
                                .primary()
                                .label("Sign in")
                                .disabled(busy)
                                .on_click(
                                    cx.listener(|this, _, window, cx| this.login(window, cx)),
                                ),
                        )
                        .child(
                            Button::new("check")
                                .label("Check connection")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.request(Action::Check, None, window, cx)
                                })),
                        )
                        .child(
                            Button::new("configure")
                                .label("Enable agents")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.request(Action::Configure, None, window, cx)
                                })),
                        )
                        .child(
                            Button::new("disconnect")
                                .label("Disconnect")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.disconnect_confirmation = true;
                                    cx.notify();
                                })),
                        ),
                );
            if self.manual_snippet.is_some() {
                root = root.child(div().flex().gap_2().items_center()
                    .child(Button::new("copy-mcp-settings").label("Copy MCP settings").disabled(busy).on_click(cx.listener(|this, _, _, cx| {
                        if let Some(snippet) = &this.manual_snippet {
                            cx.write_to_clipboard(ClipboardItem::new_string(snippet.clone()));
                            this.message = "MCP settings copied. Import or paste them in your client's MCP settings; existing files were not modified.".into();
                            cx.notify();
                        }
                    })))
                    .child("Paste into your client's MCP settings. Existing configuration is never overwritten."));
            }
            if self.disconnect_confirmation {
                root = root.child(
                    div()
                        .flex()
                        .gap_2()
                        .items_center()
                        .child("Remove this computer's saved session? Notes are not deleted.")
                        .child(
                            Button::new("confirm-disconnect")
                                .label("Confirm disconnect")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.request(Action::Disconnect, None, window, cx)
                                })),
                        )
                        .child(
                            Button::new("cancel-disconnect")
                                .label("Cancel")
                                .disabled(busy)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.disconnect_confirmation = false;
                                    cx.notify();
                                })),
                        ),
                );
            }
        }
        root = root.child(div().p_2().bg(rgb(0xe7edf7)).child(self.message.clone()));
        let mut body = div().flex().flex_1().min_h_0().gap_3();
        if !self.approval_mode {
            body = body.child(
                div()
                    .flex()
                    .flex_col()
                    .w(px(250.))
                    .gap_2()
                    .child(
                        Button::new("refresh")
                            .label("Refresh pending edits")
                            .disabled(busy)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.request(Action::Pending, None, window, cx)
                            })),
                    )
                    .child(
                        uniform_list(
                            "pending",
                            self.pending.len(),
                            cx.processor(|this, range: std::ops::Range<usize>, _, cx| {
                                range
                                    .map(|index| {
                                        let id = this.pending[index].clone();
                                        div().h(px(54.)).child(
                                            Button::new(("pending-edit", index))
                                                .label(format!("Review {}…", &id[..8]))
                                                .disabled(this.busy)
                                                .on_click(cx.listener(
                                                    move |this, _, window, cx| {
                                                        this.load_preview(id.clone(), window, cx)
                                                    },
                                                )),
                                        )
                                    })
                                    .collect::<Vec<_>>()
                            }),
                        )
                        .flex_1()
                        .min_h_0(),
                    ),
            );
        }
        body = body.child(div().flex().flex_col().flex_1().min_w_0().gap_2()
            .child(div().child(if selected.is_empty() { "No saved preview selected".into() } else { format!("Operation {selected}") }))
            .child(div().text_size(px(12.)).child("Complete plain JSON preview. Escapes remain literal; long lines continue on the next numbered row. No content is truncated."))
            .child(uniform_list("preview", self.rows.len(), cx.processor(|this, range: std::ops::Range<usize>, _, _| {
                range.map(|index| div().id(index).flex().w(px(2000.)).h(px(25.)).text_size(px(14.)).font_family("monospace")
                    .child(div().w(px(66.)).flex_shrink_0().text_color(rgb(0x66738a)).child(format!("{}", index + 1)))
                    .child(this.rows[index].clone())).collect::<Vec<_>>()
            })).with_horizontal_sizing_behavior(ListHorizontalSizingBehavior::Unconstrained).flex_1().min_h_0().bg(rgb(0xffffff)).border_1().border_color(rgb(0xc7d1e2)))
            .child(Checkbox::new("consent").label("I reviewed this exact preview and authorize these changes.").checked(self.consent).disabled(busy || !has_preview)
                .on_click(cx.listener(|this, checked, _, cx| { this.consent = *checked; cx.notify(); })))
            .child(div().flex().gap_2()
                .child(Button::new("approve").primary().label("Approve").disabled(!allowed).on_click(cx.listener(|this, _, window, cx| {
                    if let Some(id) = this.selected.clone() && can_approve(this.preview.as_ref(), &id, this.consent, this.busy, this.account.email.as_deref()) { this.request(Action::Approve(id.clone()), Some(json!({"operationId":id})), window, cx); }
                })))
                .child(Button::new("reject").label("Reject").disabled(busy || !has_preview).on_click(cx.listener(|this, _, window, cx| {
                    if let Some(id) = this.selected.clone() { this.request(Action::Reject(id.clone()), Some(json!({"operationId":id})), window, cx); }
                })))
                .child(Button::new("reload-preview").label("Reload preview").disabled(busy || selected.is_empty()).on_click(cx.listener(|this, _, window, cx| {
                    if let Some(id) = this.selected.clone() { this.load_preview(id, window, cx); }
                })))));
        root.child(body)
    }
}

/// Open the native application. `None` means window creation failed; approval requires a durable ack.
pub fn run(operation: Option<String>) -> Option<bool> {
    let approved = Arc::new(AtomicBool::new(false));
    let result = approved.clone();
    let opened_window = Arc::new(AtomicBool::new(false));
    let opened_result = opened_window.clone();
    Application::new()
        .with_assets(Assets)
        .run(move |cx: &mut App| {
            gpui_component::init(cx);
            cx.on_window_closed(|cx| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            let display = cx
                .primary_display()
                .map(|display| display.bounds())
                .unwrap_or_else(|| Bounds::new(point(px(0.), px(0.)), size(px(1024.), px(768.))));
            let (bounds, minimum) = initial_window_bounds(display);
            let opened = cx.open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    window_min_size: Some(minimum),
                    titlebar: Some(TitlebarOptions {
                        title: Some(TITLE.into()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
                |window, cx| {
                    // Titlebar options alone do not publish Wayland toplevel metadata.
                    window.set_window_title(TITLE);
                    window.set_app_id("standardnotes-connection");
                    let view = cx.new(|cx| Connection::new(operation, approved, window, cx));
                    cx.new(|cx| Root::new(view, window, cx))
                },
            );
            if opened.is_err() {
                tracing::error!("Could not open the native application window");
                cx.quit();
            } else {
                opened_window.store(true, Ordering::SeqCst);
                cx.activate(true);
            }
        });
    opened_result
        .load(Ordering::SeqCst)
        .then(|| result.load(Ordering::SeqCst))
}
