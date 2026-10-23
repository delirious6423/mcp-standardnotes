"""Fail-closed ownership for the disposable macOS GUI fixture; no title fallback."""
import ctypes
import os
import re
import struct
import sys
from dataclasses import dataclass


class OwnershipError(RuntimeError):
    """Static diagnostics only: never include captured text, argv or environment."""


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    parent: int
    uid: int
    started: tuple[int, int]
    executable: str
    argv: tuple[str, ...]


def decode_procargs(data):
    """Read exactly argc NUL-terminated arguments, never the trailing environment."""
    if len(data) < 4:
        raise OwnershipError('invalid process argument frame')
    argc = struct.unpack_from('=i', data)[0]
    if argc < 1 or argc > 4096:
        raise OwnershipError('invalid process argument count')
    end = data.find(b'\0', 4)
    if end < 0:
        raise OwnershipError('missing process executable terminator')
    offset = end + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = []
    for _ in range(argc):
        end = data.find(b'\0', offset)
        if end < 0:
            raise OwnershipError('truncated process arguments')
        argv.append(os.fsdecode(data[offset:end]))
        offset = end + 1
    return tuple(argv)


# SDK sys/proc_info.h: PROC_PIDTBSDINFO=3; pid, parent, uid and microsecond birth time.
class _BsdInfo(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        'flags', 'status', 'xstatus', 'pid', 'parent', 'uid', 'gid', 'ruid',
        'rgid', 'svuid', 'svgid', 'reserved',
    )] + [('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)] + [
        (name, ctypes.c_uint32) for name in ('nfiles', 'pgid', 'pjobc', 'tdev', 'tpgid')
    ] + [('nice', ctypes.c_int32), ('seconds', ctypes.c_uint64), ('micros', ctypes.c_uint64)]


class DarwinProcesses:
    """Read native process identity without shell-splitting ps output or logging argv."""
    def __init__(self):
        if sys.platform != 'darwin':
            raise OwnershipError('native macOS process reader required')
        self.lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.lib.proc_pidpath.restype = ctypes.c_int
        self.sysctl = ctypes.CDLL(None, use_errno=True).sysctl
        self.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        self.sysctl.restype = ctypes.c_int

    def _info(self, pid):
        info = _BsdInfo()
        n = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        if n == 0:
            return None
        if n != ctypes.sizeof(info) or info.pid != pid:
            raise OwnershipError('invalid native process identity')
        if info.status == 5:  # BSD SZOMB: a zombie is not a live owner.
            return None
        return (info.parent, info.uid, info.ruid, info.seconds, info.micros)

    def __call__(self, pid):
        before = self._info(pid)
        if before is None:
            return None
        if before[1] != os.getuid() or before[2] != os.getuid():
            raise OwnershipError('process is not owned by fixture user')
        path = ctypes.create_string_buffer(4096)
        if self.lib.proc_pidpath(pid, path, len(path)) <= 0:
            raise OwnershipError('cannot verify native executable')
        # CTL_KERN=1, KERN_PROCARGS2=49, as declared in the installed macOS SDK.
        mib = (ctypes.c_int * 3)(1, 49, pid)
        data = ctypes.create_string_buffer(1024 * 1024)
        size = ctypes.c_size_t(len(data))
        if self.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0 or size.value > len(data):
            raise OwnershipError('cannot verify native process arguments')
        argv = decode_procargs(data.raw[:size.value])
        if self._info(pid) != before:
            raise OwnershipError('process identity changed during observation')
        return ProcessIdentity(pid, before[0], before[1], (before[3], before[4]),
                               os.path.realpath(os.fsdecode(path.value)), argv)


def _pid(value):
    if not value:
        return None
    if not re.fullmatch(r'[1-9][0-9]*', value) or not 1 < int(value) < 2**31:
        raise OwnershipError('invalid fixture PID metadata')
    return int(value)


class WindowOwner:
    def __init__(self, *, mode, environ, fixture_pid, uid, gui, node, source, read):
        self.read, self.uid = read, uid
        self.gui, self.node, self.source = map(os.path.realpath, (gui, node, source))
        self.direct = _pid(environ.get('SN_GUI_TEST_PID'))
        self.parent = _pid(environ.get('SN_GUI_TEST_PARENT_PID'))
        self.operation = environ.get('SN_GUI_TEST_OPERATION_ID', '')
        if bool(self.direct) == bool(self.parent):
            raise OwnershipError('require exactly one known GUI or MCP parent PID')
        if mode not in ('auth', 'approve', 'reject', 'close'):
            raise OwnershipError('invalid fixture mode')
        if mode == 'auth':
            if not self.direct or self.operation:
                raise OwnershipError('auth requires its exact GUI PID without operation')
        elif not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', self.operation):
            raise OwnershipError('require exact operation UUID metadata')
        self.argv = () if mode == 'auth' else ('--approve', self.operation)
        self.fixture = self._required(fixture_pid)
        script = 'tests/gui-rpc-e2e.mjs' if mode == 'auth' else 'tests/mcp-e2e.mjs'
        self._node(self.fixture, script)
        self.server = None
        if self.parent:
            self.server = self._required(self.parent)
            self._node(self.server, 'dist/index.js')
            if self.server.parent != self.fixture.pid:
                raise OwnershipError('MCP parent is not a child of the live fixture')
        self.bound = None
        self.window_id = None
        if self.direct:
            self.bound = self._required(self.direct)
            if not self._gui(self.bound):
                raise OwnershipError('known GUI PID does not match owned invocation')

    def _required(self, pid):
        process = self.read(pid)
        if process is None or process.pid != pid or process.uid != self.uid:
            raise OwnershipError('fixture process is missing or not owned')
        return process

    def _node(self, process, entry):
        argv = process.argv
        if (process.executable != self.node or len(argv) != 2
                or (argv[0] != 'node' and os.path.realpath(argv[0]) != self.node)
                or argv[1] not in (entry, os.path.join(self.source, entry))):
            raise OwnershipError('fixture Node invocation does not match')

    def _gui(self, process):
        parent = self.server or self.fixture
        return (process.uid == self.uid and process.parent == parent.pid
                and process.executable == self.gui and len(process.argv) == len(self.argv) + 1
                and os.path.realpath(process.argv[0]) == self.gui
                and process.argv[1:] == self.argv)

    def select(self, windows):
        for ancestor in (self.fixture, self.server):
            if ancestor is not None and self.read(ancestor.pid) != ancestor:
                raise OwnershipError('owned ancestor exited or identity changed')
        if self.bound:
            current = self.read(self.bound.pid)
            if current is None:
                return None
            if current != self.bound:
                raise OwnershipError('bound GUI PID was reused or changed identity')
        matches = []
        for window in windows:
            if window.get('kCGWindowName') != 'Standard Notes Agent Connection' or window.get('kCGWindowLayer') != 0:
                continue
            pid = window.get('kCGWindowOwnerPID')
            if self.bound and pid != self.bound.pid:
                continue
            process = self.bound or (self.read(pid) if isinstance(pid, int) and pid > 1 else None)
            if process is not None and self._gui(process):
                matches.append((window, process))
        if len(matches) > 1:
            raise OwnershipError('ambiguous owned GUI windows')
        if not matches:
            return None
        window, process = matches[0]
        number = window.get('kCGWindowNumber')
        if not isinstance(number, int) or number <= 0:
            raise OwnershipError('invalid owned window number')
        if self.window_id is not None and number != self.window_id:
            raise OwnershipError('bound GUI window was replaced')
        self.bound, self.window_id = process, number
        return window
