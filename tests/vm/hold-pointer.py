# Keep a pointer and a keyboard with a valid keymap alive across application restarts.
import array, ctypes, os, socket, struct

assert os.environ.get('SN_VM_TEST') == '1'

def keymap_bytes():
    xkb = ctypes.CDLL('libxkbcommon.so.0')
    xkb.xkb_context_new.argtypes = [ctypes.c_int]
    xkb.xkb_context_new.restype = ctypes.c_void_p
    xkb.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
    xkb.xkb_keymap_new_from_names.restype = ctypes.c_void_p
    xkb.xkb_keymap_get_as_string.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xkb.xkb_keymap_get_as_string.restype = ctypes.c_void_p
    xkb.xkb_keymap_unref.argtypes = [ctypes.c_void_p]
    xkb.xkb_context_unref.argtypes = [ctypes.c_void_p]
    free = ctypes.CDLL(None).free
    free.argtypes = [ctypes.c_void_p]
    context = xkb.xkb_context_new(0)
    assert context, 'XKB context unavailable'
    keymap = xkb.xkb_keymap_new_from_names(context, None, 0)
    assert keymap, 'XKB default keymap unavailable'
    text = xkb.xkb_keymap_get_as_string(keymap, 1)
    assert text, 'XKB serialization unavailable'
    result = ctypes.string_at(text) + b'\0'
    free(text)
    xkb.xkb_keymap_unref(keymap)
    xkb.xkb_context_unref(context)
    return result

s = socket.socket(socket.AF_UNIX)
s.connect(os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ["WAYLAND_DISPLAY"]))

def send(obj, op, payload=b""):
    s.sendall(struct.pack("II", obj, ((8 + len(payload)) << 16) | op) + payload)

def string(v):
    b = v.encode() + b"\0"
    return struct.pack("I", len(b)) + b + b"\0" * (-len(b) % 4)

buf = b""
def events():
    global buf
    buf += s.recv(65536)
    while len(buf) >= 8:
        obj, sz_op = struct.unpack("II", buf[:8])
        size, op = sz_op >> 16, sz_op & 0xFFFF
        if len(buf) < size:
            return
        yield obj, op, buf[8:size]
        buf = buf[size:]

send(1, 1, struct.pack("I", 2))  # wl_display.get_registry -> id 2
send(1, 0, struct.pack("I", 3))  # wl_display.sync -> callback id 3
globals_ = {}
done = False
while not done:
    for obj, op, data in events():
        if obj == 2 and op == 0:  # wl_registry.global
            name, n = struct.unpack("II", data[:8])
            iface = data[8:8 + n - 1].decode()
            globals_[iface] = name
        elif obj == 3:
            done = True

def bind(iface, new_id):
    send(2, 0, struct.pack("I", globals_[iface]) + string(iface) + struct.pack("II", 1, new_id))

bind("wl_seat", 4)
bind("zwlr_virtual_pointer_manager_v1", 5)
send(5, 0, struct.pack("II", 4, 6))  # create_virtual_pointer(seat, id 6)
bind('zwp_virtual_keyboard_manager_v1', 7)
send(7, 0, struct.pack('II', 4, 8))
keymap = keymap_bytes()
fd = os.memfd_create('synthetic-keymap', os.MFD_CLOEXEC)
assert os.write(fd, keymap) == len(keymap)
os.lseek(fd, 0, os.SEEK_SET)
payload = struct.pack('II', 1, len(keymap))  # keymap format, size; FD travels out of band.
s.sendmsg([struct.pack('II', 8, ((8 + len(payload)) << 16)) + payload],
          [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [fd]))])
send(1, 0, struct.pack('I', 9))
done = False
while not done:
    for obj, op, data in events():
        if obj == 9 and op == 0:
            done = True
os.close(fd)
print('ready: pointer and valid-keymap keyboard', flush=True)
while True:
    for _ in events():
        pass
