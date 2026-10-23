#!/usr/bin/env bash
# Called only by macos-guest.sh; all input, clipboard and screenshot access stays in the VM.
set -euo pipefail
: "${SN_MAC_TOKEN:?owned guest token required}"
ROOT="/tmp/sn-acceptance-$SN_MAC_TOKEN"
[[ "$(< "$ROOT/owner")" == "$SN_MAC_TOKEN" ]] || exit 1
[[ "$(/usr/sbin/sysctl -n hw.model)" == VirtualMac* && "$(/usr/sbin/sysctl -n kern.hv_vmm_present)" == 1 ]] || { echo 'Refusing non-VM macOS host'; exit 1; }
mkdir -p "$ROOT/artifacts" "$ROOT/gui-home" /tmp/sn-gui-test
trap 'if [[ -f /tmp/sn-gui-test/gui.log ]]; then cp /tmp/sn-gui-test/gui.log "$ROOT/artifacts/gui.log"; fi' EXIT
python3 -I tests/test_macos_window_owner.py
swiftc tests/vm/macos-gui.swift -o "$ROOT/macos-gui"
export SN_GUI_PATH="$CARGO_TARGET_DIR/debug/standardnotes-connection"
export SN_CONNECTOR_ROOT="$PWD" SN_NODE_PATH
SN_NODE_PATH=$(command -v node)
"$ROOT/macos-gui" preflight | tee "$ROOT/artifacts/preflight.json"
python3 - "$ROOT" <<'PY'
import json, os, subprocess, sys, time
from pathlib import Path
root=Path(sys.argv[1]); helper=str(root/'macos-gui'); artifacts=root/'artifacts'
permissions=json.loads((artifacts/'preflight.json').read_text())
env={**os.environ,'HOME':str(root/'gui-home'),'KEYCHAIN_SERVICE':'sn-macos-window-'+os.environ['SN_MAC_TOKEN']}
# A restored value must not hide a transient write from the strict credential guard.
counts=[]
probe=b'nonsecret-macos-clipboard-probe'
for value in (probe,b'nonsecret-transient-value',probe):
    subprocess.run([helper,'clipboard-write'],input=value,check=True,timeout=15)
    counts.append(int(subprocess.check_output([helper,'clipboard-count'],timeout=15)))
assert counts[0] < counts[1] < counts[2]
assert subprocess.check_output([helper,'clipboard-read'],timeout=15)==probe
print('PASS: native clipboard changeCount detects transient write/restoration',flush=True)
# The helper acts only on the bound native window: exact GUI PID plus window number.
def bound(child,window):
    return {**os.environ,'SN_GUI_BOUND_PID':str(child.pid),'SN_GUI_BOUND_WINDOW':str(window['kCGWindowNumber'])}
log=open(artifacts/'startup.stderr','w')
child=subprocess.Popen([env['SN_GUI_PATH']],env=env,stdout=subprocess.DEVNULL,stderr=log)
try:
    deadline=time.monotonic()+30
    window=None
    while time.monotonic()<deadline:
        windows=json.loads(subprocess.check_output([helper,'windows'],timeout=15))
        window=next((w for w in windows if w.get('kCGWindowOwnerPID')==child.pid and w.get('kCGWindowLayer')==0),None)
        if window or child.poll() is not None: break
        time.sleep(.2)
    assert child.poll() is None, 'native GPUI process exited before startup; see startup.stderr'
    assert window, 'native GPUI process created no native macOS window'
    (artifacts/'initial-window.json').write_text(json.dumps(window,indent=2))
    bounds=window['kCGWindowBounds']
    assert permissions['screenWidth']==1024 and permissions['screenHeight']==768, 'small-viewport regression requires real default 1024x768 points'
    assert bounds['X']>=0 and bounds['Y']>=0 and bounds['X']+bounds['Width']<=1024 and bounds['Y']+bounds['Height']<=768, 'native initial window is outside the default guest viewport'
    print('PASS: real native GPUI initial window fully inside default 1024x768 viewport, no AX repositioning',flush=True)
    subprocess.run([helper,'activate',str(child.pid)],check=True,timeout=15,env=bound(child,window))
    time.sleep(2)
    window=next(w for w in json.loads(subprocess.check_output([helper,'windows'],timeout=15)) if w.get('kCGWindowOwnerPID')==child.pid and w.get('kCGWindowLayer')==0)
    (artifacts/'window.json').write_text(json.dumps(window,indent=2))
    # Check the real signed screencapture tool, not just the helper's preflight result.
    image=artifacts/'startup.png'
    capture=subprocess.run(['screencapture','-x','-o','-l',str(window['kCGWindowNumber']),str(image)],capture_output=True,timeout=15)
    (artifacts/'capture.stderr').write_bytes(capture.stderr)
    can_capture=capture.returncode==0 and image.exists()
    can_input=False
    if can_capture:
        words=json.loads(subprocess.check_output([helper,'ocr',str(image)],timeout=30))
        (artifacts/'startup-ocr.json').write_text(json.dumps(words,indent=2))
        text=' '.join(w['text'] for w in words)
        assert 'Password' in text and 'Sign' in text and 'Email' in text, 'real native framebuffer missing login form'
        print('PASS: native framebuffer screenshot + Vision OCR show login form',flush=True)
        # macOS 26 can report preflight=true and still show direct-capture consent asynchronously.
        # Consent uses only the normal OS Allow button for this identified disposable guest request.
        time.sleep(3)
        consent=json.loads(subprocess.check_output([helper,'allow-guest-capture'],timeout=15))
        (artifacts/'guest-capture-consent.json').write_text(json.dumps(consent))
        if consent.get('unexpectedDialog'):
            raise AssertionError('Unexpected guest permission dialog; no button pressed')
        if consent.get('allowed'):
            print('PASS: normal identified guest-only screen capture consent; no TCC database or host changes',flush=True)
            time.sleep(1)
        subprocess.run([helper,'activate',str(child.pid)],check=True,timeout=15,env=bound(child,window))
        time.sleep(.5)
        email=next(w for w in reversed(words) if w['text']=='Email')
        bounds=window['kCGWindowBounds']
        subprocess.run([helper,'click',str(bounds['X']+email['x']*bounds['Width']),str(bounds['Y']+email['y']*bounds['Height'])],check=True,timeout=15,env=bound(child,window))
        subprocess.run([helper,'type'],input=b'synthetic-probe@example.invalid',check=True,timeout=15,env=bound(child,window))
        time.sleep(1)
        probe=artifacts/'input-probe.png'
        subprocess.run(['screencapture','-x','-o','-l',str(window['kCGWindowNumber']),str(probe)],check=True,timeout=15)
        observed=json.loads(subprocess.check_output([helper,'ocr',str(probe)],timeout=30))
        subprocess.run(['screencapture','-x',str(artifacts/'desktop-after-input.png')],check=True,timeout=15)
        (artifacts/'frontmost-after-input.json').write_bytes(subprocess.check_output([helper,'frontmost'],timeout=15))
        (artifacts/'input-probe-ocr.json').write_text(json.dumps(observed,indent=2))
        can_input='synthetic-probe@example.invalid' in ' '.join(w['text'] for w in observed)
        print(('PASS' if can_input else 'BLOCKED')+': native Quartz synthetic email input verified against real framebuffer',flush=True)
        if not can_input:
            desktop_words=json.loads(subprocess.check_output([helper,'ocr',str(artifacts/'desktop-after-input.png')],timeout=30))
            desktop_text=' '.join(w['text'] for w in desktop_words)
            (artifacts/'desktop-ocr.json').write_text(json.dumps(desktop_words,indent=2))
            if 'private window picker' in desktop_text and 'sshd-session' in desktop_text:
                print('BLOCKED: macOS guest Screen Recording direct-capture consent dialog steals input focus; standard in-guest Allow is required. No TCC database changes or host permissions were attempted.',flush=True)
    else:
        print('BLOCKED: native framebuffer screenshot/OCR requires guest Screen Recording permission',flush=True)
finally:
    if child.poll() is None: child.terminate()
    try: child.wait(timeout=10)
    except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=10)
    log.close()
    print('CLEANUP PASS: native startup process terminated and reaped',flush=True)
if not can_capture or not can_input:
    print('BLOCKED: native GUI auth/MFA, clipboard Copy/Cut and consent/Approve/Reject have not passed; inspect preflight and real framebuffer input evidence. No host fallback.',flush=True)
    sys.exit(2)
PY
# The shared synthetic fixtures intentionally name the Linux driver; overlay only the guest copy.
cp tests/vm/macos-gui-driver.py tests/vm/gui-driver.py
SN_GUI_AUTH=1 node tests/gui-rpc-e2e.mjs
SN_E2E_GUI=1 node tests/mcp-e2e.mjs
echo 'PASS: native macOS GUI auth, MFA, masked clipboard, consent approval, rejection and disconnect'
