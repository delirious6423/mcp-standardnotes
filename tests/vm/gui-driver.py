#!/usr/bin/env python3
"""Synthetic native-VM input only. Exact assertions; retries are for frame/input timing."""
import atexit
import csv
import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
import gui_owner
from gui_vision import dark_button_regions, operation_caption_region

assert os.environ.get('SN_VM_TEST') == '1'
out = Path('/tmp/sn-gui-test')
mode = sys.argv[1]

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=12, **kwargs)

# Credential screens exist only in memory; failure artifacts are limited to non-credential modes.
persist = mode != 'auth'
owned = gui_owner.owned_gui_pids

def window():
    tree = run(['swaymsg', '-t', 'get_tree']).stdout
    if persist:
        (out / 'tree.json').write_bytes(tree)
    return gui_owner.select_window(json.loads(tree), owned(os.environ))

def eventually(fn, message, seconds=60):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = fn()
        if value:
            return value
        time.sleep(.2)
    raise AssertionError(message)

win = eventually(window, 'native GPUI window did not open')

def png_bytes(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return buffer.getvalue()

def ocr(data, *options):
    return list(csv.DictReader(io.StringIO(run(['tesseract', 'stdin', 'stdout', *options, 'tsv'], input=data).stdout.decode()), delimiter='\t'))

def frame():
    w = window()
    if not w:
        return None, None
    r = w['rect']
    # grim writes the PNG to stdout for '-': nothing is saved while credentials are on screen.
    data = run(['grim', '-g', f"{r['x']},{r['y']} {r['width']}x{r['height']}", '-']).stdout
    if persist:
        (out / 'frame.png').write_bytes(data)
    return Image.open(io.BytesIO(data)), data

def words():
    image, data = frame()
    if image is None:
        return []
    result = [v for v in ocr(data) if v.get('text', '').strip()]
    # Full-frame segmentation treats dark buttons as graphics, not text.
    for box, crop in dark_button_regions(image, result):
        for word in ocr(png_bytes(crop), '--psm', '7'):
            if not word.get('text', '').strip():
                continue
            word['left'] = str(round(box[0] + (int(word['left']) - 16) / 4))
            word['top'] = str(round(box[1] + (int(word['top']) - 16) / 4))
            word['width'] = str(max(1, round(int(word['width']) / 4)))
            word['height'] = str(max(1, round(int(word['height']) / 4)))
            result.append(word)
    return result

def caption():
    """Exact preview caption text via the calibrated crop; no text substitution."""
    image, data = frame()
    if image is None:
        return ''
    region = operation_caption_region(image, [v for v in ocr(data) if v.get('text', '').strip()])
    return ' '.join(w['text'] for w in ocr(png_bytes(region[1]), '--psm', '7')) if region else ''

def screen():
    return ' '.join(w['text'] for w in words())

def has(text):
    return text.casefold() in screen().casefold()

# A mapped but unnamed Wayland surface previously defeated identification.
eventually(lambda: (w := window()) and w.get('name') == 'Standard Notes Agent Connection',
           'native window title missing')
eventually(lambda: has('Standard Notes Agent Connection'), 'framebuffer must show the app heading')

form_row = None
button_row = None

def click(label, bottom=False):
    def locate():
        global form_row, button_row
        items = words()
        center = lambda w: int(w['top']) + int(w['height']) / 2
        if form_row is None:
            form_row = next((center(w) for w in items if w['text'] == 'Password'), None)
        if button_row is None:
            button_row = next((center(w) for label in ('Enable', 'Sign')
                               for w in items if w['text'] == label), None)
        # Repeated words in instructions/status are not interactive controls.
        matches = [w for w in items if re.fullmatch(label, w['text'])]
        row = form_row if label in ('Email', 'Password', 'MFA') else (
            button_row if label in ('Sign', 'Check', 'Enable', 'Disconnect') else None)
        if row is not None:
            matches = [w for w in matches if abs(center(w) - row) <= max(8, int(w['height']))]
        if not matches:
            return None
        return matches[-1] if bottom else matches[0]
    target = eventually(locate, f'button/label not rendered: {label}')
    w = window()['rect']
    x = w['x'] + int(target['left']) + int(target['width'])//2
    y = w['y'] + int(target['top']) + int(target['height'])//2
    # Absolute compositor coordinates avoid fresh virtual-device motion/acceleration.
    response = run(['swaymsg', f'seat seat0 cursor set {x} {y}'])
    assert all(item['success'] for item in json.loads(response.stdout)), 'cursor placement rejected'
    if persist:
        with (out / 'targets.jsonl').open('a') as log:
            log.write(json.dumps({'label': label, 'word': target, 'x': x, 'y': y}) + '\n')
    run(['wlrctl', 'pointer', 'click', 'left'])
    time.sleep(.3)

def type_text(text):
    run(['wtype', '-d', '25', '-'], input=text.encode())
    time.sleep(.2)

sentinel = b'sn-gui-clipboard-sentinel'
clipboard_owner = None

def clipboard():
    result = subprocess.run(['wl-paste', '-n'], capture_output=True, timeout=12)
    # Clipboard ownership is asynchronous; retry only its documented empty state.
    if result.returncode == 1 and b'Nothing is copied' in result.stderr:
        return None
    if result.returncode:
        (out / 'clipboard-error.txt').write_bytes(result.stderr)
    result.check_returncode()
    return result.stdout

def assert_copy_blocked():
    global clipboard_owner
    if clipboard_owner is None:
        clipboard_owner = subprocess.Popen(['wl-copy', '--foreground'], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        clipboard_owner.stdin.write(sentinel); clipboard_owner.stdin.close()
        def cleanup_clipboard():
            if clipboard_owner.poll() is None:
                clipboard_owner.terminate(); clipboard_owner.wait(timeout=5)
        atexit.register(cleanup_clipboard)
        eventually(lambda: clipboard() == sentinel, 'clipboard sentinel not ready')
    for action in ('c', 'x'):
        run(['wtype', '-M', 'ctrl', '-k', 'a', '-k', action, '-m', 'ctrl'])
        time.sleep(.3)
        until = time.monotonic() + 1
        while time.monotonic() < until:
            assert clipboard() == sentinel, 'masked field exposed credentials through clipboard'
            time.sleep(.05)
    run(['wtype', '-k', 'End'])

if mode == 'auth':
    credentials = json.load(sys.stdin)
    eventually(lambda: has('Enter saved account email') and not has('Contacting the local backend'),
               'initial saved-session lookup must finish before typing into disabled inputs')
    click('Email', bottom=True); type_text(credentials['email'])
    run(['wtype', '-M', 'ctrl', '-k', 'a', '-k', 'c', '-m', 'ctrl'])
    eventually(lambda: clipboard() == credentials['email'].encode(), 'positive control: ordinary email Copy must work')
    click('Password'); type_text(credentials['password'])
    assert credentials['password'] not in screen(), 'password visible on screen'
    assert_copy_blocked()
    click('Sign')
    eventually(lambda: has('Multi-factor'), 'native sign-in must show MFA challenge')
    assert clipboard() == sentinel, 'password Copy/Cut leaked after subsequent GUI events'
    click('MFA'); type_text(credentials['mfa'])
    assert credentials['password'] not in screen(), 'MFA retry must retain only masked password'
    assert credentials['mfa'] not in screen(), 'MFA code visible on screen'
    assert_copy_blocked()
    click('Sign')
    eventually(lambda: has('0 notes, 0 tags'), 'GUI login/MFA did not verify counts')
    assert clipboard() == sentinel, 'MFA Copy/Cut leaked after subsequent GUI events'
    click('Check')
    eventually(lambda: has('0 notes, 0 tags'), 'GUI keychain reconnect failed')
    click('Enable')
    eventually(lambda: has('Agent connection enabled'), 'GUI agent configuration did not finish')
    click('Disconnect')
    eventually(lambda: has('Confirm'), 'disconnect needs explicit confirmation')
    click('Confirm')
    eventually(lambda: has('Disconnected.'), 'GUI disconnect did not complete')
    run(['swaymsg', f"[con_id={window()['id']}]", 'kill'])
elif mode == 'close':
    eventually(lambda: has('Saved preview loaded'), 'preview not loaded before dismiss')
    eventually(lambda: has('Approval account (pinned)') and has(os.environ['SN_EMAIL']) and not has('Approval account unavailable'),
               'approval window must show the backend-bound pinned account')
    click('Approve', bottom=True)
    assert window(), 'unchecked Approve must not dismiss the preview'
    run(['swaymsg', f"[con_id={window()['id']}]", 'kill'])
elif mode in ('approve', 'reject'):
    eventually(lambda: has('Saved preview loaded'), 'saved preview missing')
    # The backend binds the preview to its journal account; the GUI must show it, not the placeholder.
    eventually(lambda: has('Approval account (pinned)') and has(os.environ['SN_EMAIL']) and not has('Approval account unavailable'),
               'approval window must show the backend-bound pinned account')
    eventually(lambda: 'Complete plain JSON preview' in caption(), 'full plain-text preview must be visibly labeled')
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
print('PASS: native GUI ' + mode)
