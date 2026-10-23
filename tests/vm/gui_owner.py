"""Fail-closed ownership of the disposable Linux GUI fixture: owned process, never a title match."""
import os
from dataclasses import dataclass

APP_ID = 'standardnotes-connection'


class OwnershipError(RuntimeError):
    """Static diagnostics only: never include argv, environment or captured text."""


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    uid: int
    exe: str
    argv: tuple


def read_proc(pid, root='/proc'):
    """Identity of one process, or None if it vanished or is unreadable."""
    base = os.path.join(root, str(pid))
    try:
        with open(os.path.join(base, 'stat'), 'rb') as f:
            # comm may contain spaces/parentheses; fields resume after the LAST ')'.
            ppid = int(f.read().rsplit(b')', 1)[1].split()[1])
        with open(os.path.join(base, 'cmdline'), 'rb') as f:
            argv = tuple(os.fsdecode(a) for a in f.read().split(b'\0')[:-1])
        return Proc(pid, ppid, os.stat(base).st_uid, os.path.realpath(os.readlink(os.path.join(base, 'exe'))), argv)
    except (OSError, ValueError, IndexError):
        return None


def list_procs(root='/proc'):
    return [p for name in os.listdir(root) if name.isdigit() and (p := read_proc(int(name), root))]


def _is_owned_gui(proc, exe, operation, uid):
    expected = ('--approve', operation) if operation else ()
    return proc.uid == uid and proc.exe == exe and proc.argv[1:] == expected


def owned_gui_pids(env, procs=list_procs, uid=None):
    """Native GUI PIDs this test owns. Needs the ACTUAL executable (not a launcher wrapper).

    SN_GUI_TEST_PID: a known child (auth/manual approval). SN_GUI_TEST_PARENT_PID +
    SN_GUI_TEST_OPERATION_ID: the one `--approve <operation>` child of a live MCP server.
    """
    uid = os.getuid() if uid is None else uid
    exe = env.get('SN_GUI_TEST_EXE', '')
    if not os.path.isabs(exe):
        raise OwnershipError('SN_GUI_TEST_EXE must be the absolute native GUI executable')
    exe = os.path.realpath(exe)
    operation = env.get('SN_GUI_TEST_OPERATION_ID') or None
    pid, parent = env.get('SN_GUI_TEST_PID'), env.get('SN_GUI_TEST_PARENT_PID')
    if bool(pid) == bool(parent):
        raise OwnershipError('exactly one of SN_GUI_TEST_PID or SN_GUI_TEST_PARENT_PID is required')
    if parent and not operation:
        raise OwnershipError('SN_GUI_TEST_OPERATION_ID is required with a parent PID')
    try:
        number = int(pid or parent)
    except ValueError:
        raise OwnershipError('invalid owner PID') from None
    if number <= 1:
        raise OwnershipError('invalid owner PID')
    candidates = [p for p in procs() if (p.pid == number if pid else p.ppid == number)]
    owned = {p.pid for p in candidates if _is_owned_gui(p, exe, operation, uid)}
    if len(owned) > 1:
        raise OwnershipError('ambiguous owned GUI processes')
    return owned


def select_window(tree, pids):
    """The single sway view of an owned GUI process; None if absent; error if ambiguous."""
    found = []

    def walk(node):
        if node.get('pid') in pids and node.get('app_id') == APP_ID:
            found.append(node)
        for child in node.get('nodes', []) + node.get('floating_nodes', []):
            walk(child)

    walk(tree)
    if len(found) > 1:
        raise OwnershipError('ambiguous owned GUI windows')
    return found[0] if found else None
