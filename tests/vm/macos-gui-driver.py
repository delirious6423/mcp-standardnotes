#!/usr/bin/env python3
"""Synthetic macOS VM GUI driver. Quartz input and Vision OCR; no host TCC changes."""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from macos_window_owner import DarwinProcesses, WindowOwner

assert os.environ.get('SN_VM_TEST') == '1'
root = Path('/tmp/sn-acceptance-' + os.environ['SN_MAC_TOKEN'])
helper = str(root / 'macos-gui')
mode = sys.argv[1]
protected_clipboard_count = None
owner = None


def run(args, **kwargs):
    if args[0] == helper and args[1] in ('activate', 'click', 'type', 'key', 'close', 'ocr-window'):
        current = window()  # Revalidate pinned process birth/argv/ancestors before every operation.
        assert current is not None, 'owned native window is no longer available'
        pid, number = current['kCGWindowOwnerPID'], current['kCGWindowNumber']
        if args[1] in ('activate', 'close'):
            assert int(args[2]) == pid, 'native action does not target the bound process'
        if args[1] == 'ocr-window':
            assert int(args[2]) == number, 'capture does not target the bound window'
        kwargs['env'] = {**os.environ, 'SN_GUI_BOUND_PID': str(pid), 'SN_GUI_BOUND_WINDOW': str(number)}
    return subprocess.run(args, check=True, capture_output=True, timeout=15, **kwargs)


def assert_clipboard_unchanged():
    if protected_clipboard_count is not None:
        assert int(run([helper, 'clipboard-count']).stdout) == protected_clipboard_count, 'masked credential clipboard was written, even if restored'
        assert run([helper, 'clipboard-read']).stdout == b'sn-gui-clipboard-sentinel', 'masked credential changed clipboard contents'


# The shared auth fixture isolates client configs with HOME. Security.framework also uses HOME,
# so explicitly point that synthetic home at the VM-owned keychain before any GUI login creates items.
keychain = str(root / 'synthetic.keychain-db')
assert Path(keychain).is_file() and (root / 'owner').read_text() == os.environ['SN_MAC_TOKEN']
assert os.environ.get('SN_VM_TEST') == '1'
assert run(['/usr/sbin/sysctl', '-n', 'hw.model']).stdout.strip().startswith(b'VirtualMac')
assert run(['/usr/sbin/sysctl', '-n', 'kern.hv_vmm_present']).stdout.strip() == b'1'
owner = WindowOwner(mode=mode, environ=os.environ, fixture_pid=os.getppid(), uid=os.getuid(),
                    gui=os.environ['SN_GUI_PATH'], node=os.environ['SN_NODE_PATH'],
                    source=str(Path(__file__).resolve().parents[2]), read=DarwinProcesses())
for directory in ('Preferences', 'Keychains'):
    (Path.home() / 'Library' / directory).mkdir(parents=True, exist_ok=True)
run(['security', 'list-keychains', '-d', 'user', '-s', keychain])
run(['security', 'default-keychain', '-d', 'user', '-s', keychain])
run(['security', 'unlock-keychain', '-p', 'SYNTHETIC-VM-ONLY', keychain])


def eventually(fn, message, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = fn()
        if result:
            return result
        time.sleep(.3)
    # Never persist a timeout screenshot or OCR: a masking regression may contain credentials.
    raise AssertionError(message)


def window():
    return owner.select(json.loads(run([helper, 'windows']).stdout))


win = eventually(window, 'native GPUI window did not open')
run([helper, 'activate', str(win['kCGWindowOwnerPID'])])
def fits_viewport():
    current = window()
    if not current:
        return False
    rect = current['kCGWindowBounds']
    return rect['X'] >= 0 and rect['Y'] >= 0 and rect['X'] + rect['Width'] <= 1024 and rect['Y'] + rect['Height'] <= 768


eventually(fits_viewport, 'native workflow window is outside the default guest viewport')
time.sleep(.3)


def words():
    win = window()
    if not win:
        return []
    # ScreenCaptureKit CGImage -> Vision -> private stdout pipe; no PNG or raw OCR on disk.
    recognized = run([helper, 'ocr-window', str(win['kCGWindowNumber'])]).stdout
    assert_clipboard_unchanged()
    return json.loads(recognized)


def normalize_counts(text):
    # Vision reads the rendered zero as letter O. Normalize only numeric count positions;
    # all positive and stale-count checks use this same in-memory view.
    return re.sub(r'\bO (?=(?:notes|tags)\b)', '0 ', text)


assert normalize_counts('O notes, O tags.') == '0 notes, 0 tags.'
assert normalize_counts('10 notes, 20 tags.') == '10 notes, 20 tags.'
assert normalize_counts('OPEN notes; O notebook.') == 'OPEN notes; O notebook.'


def screen():
    return normalize_counts(' '.join(item['text'] for item in words()))


def has(text):
    return text.casefold() in screen().casefold()


form_y = action_y = None


def click(label, bottom=False):
    global form_y, action_y
    def locate():
        global form_y, action_y
        observed = words()
        matches = [w for w in observed if re.fullmatch(label, w['text'])]
        if not matches:
            return None
        if mode == 'auth':
            if form_y is None:
                form_y = next(w['y'] for w in observed if w['text'] == 'Password')
                action_y = next(w['y'] for w in observed if w['text'] == 'Sign')
            # Instructions/status also contain email, sign and Check. Target actual control rows.
            if label in ('Email', 'Password', 'MFA') or '@' in label:
                return min(matches, key=lambda w: abs(w['y'] - form_y))
            if label in ('Sign', 'Check', 'Enable', 'Disconnect'):
                return min(matches, key=lambda w: abs(w['y'] - action_y))
        return max(matches, key=lambda w: w['y']) if bottom else min(matches, key=lambda w: w['y'])
    target = eventually(locate, 'button/label not rendered: ' + label)
    rect = window()['kCGWindowBounds']
    # -o removes the shadow so OCR coordinates match the native window bounds.
    x = rect['X'] + target['x'] * rect['Width']
    y = rect['Y'] + target['y'] * rect['Height']
    assert x >= 0 and y >= 0, 'OCR target is outside the guest display'
    run([helper, 'click', str(x), str(y)])
    time.sleep(.35)
    assert_clipboard_unchanged()


def type_text(text):
    run([helper, 'type'], input=text.encode())
    time.sleep(.2)
    assert_clipboard_unchanged()


def assert_copy_blocked():
    global protected_clipboard_count
    if protected_clipboard_count is None:
        run([helper, 'clipboard-write'], input=b'sn-gui-clipboard-sentinel')
        protected_clipboard_count = int(run([helper, 'clipboard-count']).stdout)
    else:
        assert_clipboard_unchanged()  # Never reset the baseline and hide a delayed earlier write.
    for code in (8, 7):  # C and X, native Command modifier.
        run([helper, 'key', '0', 'command'])  # A
        run([helper, 'key', str(code), 'command'])
        # Strict sampling, not retry-until-match: any transient/late write permanently fails.
        for _ in range(6):
            assert_clipboard_unchanged()
            time.sleep(.1)
    run([helper, 'key', '124'])  # Arrow right deselects without deleting.
    assert_clipboard_unchanged()


def close():
    # The helper closes only the bound application's sole, title-checked native window.
    run([helper, 'close', str(window()['kCGWindowOwnerPID'])])


if mode == 'auth':
    credentials = json.load(sys.stdin)
    eventually(lambda: has('Enter saved account email'), 'empty keychain must not show connected')
    eventually(lambda: not has('Contacting') and not has('Loading local connection'), 'initial native status RPC did not finish')
    click('Email', bottom=True)
    type_text(credentials['email'])
    eventually(lambda: has(credentials['email']), 'native keyboard did not fill email')
    # Positive controls prove native Copy/Cut really execute before checking blocked credentials.
    for code in (8, 7):
        run([helper, 'key', '0', 'command'])
        run([helper, 'key', str(code), 'command'])
        eventually(lambda: run([helper, 'clipboard-read']).stdout == credentials['email'].encode(), 'native email clipboard positive control failed')
    eventually(lambda: not has(credentials['email']), 'native Cut positive control did not remove email')
    type_text(credentials['email'])
    eventually(lambda: has(credentials['email']), 'native keyboard did not restore email after Cut control')
    print('PASS: native macOS email Copy/Cut positive controls', flush=True)
    click('Password')
    type_text(credentials['password'])
    assert credentials['password'] not in screen(), 'password visible on screen'
    assert_copy_blocked()
    print('PASS: native macOS masked password and Copy/Cut clipboard sentinel', flush=True)
    click('Sign')
    eventually(lambda: has('Multi-factor'), 'native sign-in must show MFA challenge')
    click('MFA')
    type_text(credentials['mfa'])
    assert credentials['password'] not in screen(), 'MFA retry must retain only masked password'
    assert credentials['mfa'] not in screen(), 'MFA code visible on screen'
    assert_copy_blocked()
    print('PASS: native macOS masked MFA and Copy/Cut clipboard sentinel', flush=True)
    click('Sign')
    eventually(lambda: has('0 notes, 0 tags'), 'GUI login/MFA did not verify counts')
    click('Check')
    eventually(lambda: has('0 notes, 0 tags'), 'GUI keychain reconnect failed')
    print('PASS: native macOS GUI login/MFA and saved Keychain reconnect', flush=True)
    click('Enable')
    eventually(lambda: has('Agent connection enabled'), 'GUI agent configuration did not finish')
    # Missing account B must fail, never fall back to inherited SN_EMAIL/account A.
    click(re.escape(credentials['email']) + r'\.?', bottom=True)
    run([helper, 'key', '0', 'command'])
    type_text('other-account@example.invalid')
    click('Check')
    eventually(lambda: has('The backend could not complete'), 'missing account B must fail closed')
    observed = screen()
    assert 'other-account@example.invalid' in observed and 'not verified' in observed
    assert 'Connected as' not in observed and '0 notes' not in observed, 'failed B check retained stale account A counts'
    click(r'other-account@example\.invalid\.?', bottom=True)
    run([helper, 'key', '0', 'command'])
    type_text(credentials['email'])
    click('Check')
    eventually(lambda: has('0 notes, 0 tags'), 'switching back to A did not resume its saved session')
    print('PASS: native macOS GUI account B selection fails closed without stale A counts; A reconnects', flush=True)
    click('Disconnect')
    eventually(lambda: has('Confirm'), 'disconnect needs explicit confirmation')
    click('Confirm')
    eventually(lambda: has('Disconnected.'), 'GUI disconnect did not complete')
    close()
elif mode == 'close':
    eventually(lambda: has('Saved preview loaded'), 'preview not loaded before dismiss')
    eventually(lambda: has('Approval account (pinned)') and has(os.environ['SN_EMAIL']) and not has('Approval account unavailable'),
               'approval window must show the backend-bound pinned account')
    click('Approve', bottom=True)
    # This run NEVER grants consent. The outer fixture checks prepared/unapproved after exit.
    for _ in range(3):
        assert window() and has('Saved preview loaded'), 'unchecked Approve started or completed a backend action'
        time.sleep(.15)
    close()
elif mode in ('approve', 'reject'):
    eventually(lambda: has('Saved preview loaded'), 'saved preview missing')
    eventually(lambda: has('Approval account (pinned)') and has(os.environ['SN_EMAIL']) and not has('Approval account unavailable'),
               'approval window must show the backend-bound pinned account')
    assert has('Complete plain JSON preview'), 'full plain-text preview must be visibly labeled'
    if mode == 'approve':
        click('Approve', bottom=True)
        assert window(), 'Approve must be disabled before explicit consent'
        click('reviewed', bottom=True)
        click('Approve', bottom=True)
    else:
        click('Reject', bottom=True)
else:
    raise AssertionError('unknown driver mode')
eventually(lambda: not window(), 'GUI did not close after its decision')
assert_clipboard_unchanged()
print('PASS: native macOS GUI ' + mode)
