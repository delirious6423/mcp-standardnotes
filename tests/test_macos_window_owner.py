#!/usr/bin/env python3
"""Pure, host-safe macOS ownership regressions using fake process tables; no native process reads."""
import os
import struct
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'vm'))
from macos_window_owner import OwnershipError, ProcessIdentity, WindowOwner, decode_procargs

UID, GUI, NODE, SOURCE = 501, '/g/standardnotes-connection', '/n/node', '/src'
OP = '11111111-1111-4111-8111-111111111111'
TITLE = 'Standard Notes Agent Connection'


def proc(pid, parent, executable, argv, started=1, uid=UID):
    return ProcessIdentity(pid, parent, uid, (started, 0), executable, tuple(argv))


def table(*items):
    by_pid = {p.pid: p for p in items}
    return lambda pid: by_pid.get(pid)


def window(pid, number=10, name=TITLE, layer=0):
    return {'kCGWindowOwnerPID': pid, 'kCGWindowNumber': number, 'kCGWindowName': name, 'kCGWindowLayer': layer}


FIXTURE = proc(100, 1, NODE, ('node', 'tests/mcp-e2e.mjs'))
SERVER = proc(200, 100, NODE, ('node', 'dist/index.js'))


def gui(pid, parent, operation=OP, started=1):
    return proc(pid, parent, GUI, (GUI, '--approve', operation), started)


def owner(mode, env, items, fixture=100):
    return WindowOwner(mode=mode, environ=env, fixture_pid=fixture, uid=UID, gui=GUI, node=NODE, source=SOURCE, read=table(*items))


class Ownership(unittest.TestCase):
    def test_direct_pid_selects_only_that_process_and_ignores_same_title_windows(self):
        env = {'SN_GUI_TEST_PID': '300', 'SN_GUI_TEST_OPERATION_ID': OP}
        chosen = owner('approve', env, [FIXTURE, gui(300, 100)])
        self.assertEqual(chosen.select([window(999, 5), window(300, 6)])['kCGWindowNumber'], 6)
        self.assertIsNone(chosen.select([window(999, 5)]))

    def test_parent_binds_one_operation_child_not_other_operation_or_title(self):
        env = {'SN_GUI_TEST_PARENT_PID': '200', 'SN_GUI_TEST_OPERATION_ID': OP}
        items = [FIXTURE, SERVER, gui(300, 200), gui(301, 200, OP.replace('1', '2')), gui(302, 999)]
        chosen = owner('approve', env, items)
        self.assertEqual(chosen.select([window(301, 4), window(302, 5), window(300, 6)])['kCGWindowOwnerPID'], 300)

    def test_ambiguity_reuse_replacement_and_ancestor_change_fail_closed(self):
        env = {'SN_GUI_TEST_PARENT_PID': '200', 'SN_GUI_TEST_OPERATION_ID': OP}
        with self.assertRaises(OwnershipError):
            owner('approve', env, [FIXTURE, SERVER, gui(300, 200), gui(301, 200)]).select([window(300, 1), window(301, 2)])
        direct = {'SN_GUI_TEST_PID': '300', 'SN_GUI_TEST_OPERATION_ID': OP}
        live = {'p': gui(300, 100)}
        chosen = WindowOwner(mode='approve', environ=direct, fixture_pid=100, uid=UID, gui=GUI, node=NODE, source=SOURCE,
                             read=lambda pid: live['p'] if pid == 300 else FIXTURE)
        self.assertEqual(chosen.select([window(300, 7)])['kCGWindowNumber'], 7)
        with self.assertRaises(OwnershipError):
            chosen.select([window(300, 8)])  # same process, replaced window
        live['p'] = gui(300, 100, started=2)
        with self.assertRaises(OwnershipError):
            chosen.select([window(300, 7)])  # PID reuse
        with self.assertRaises(OwnershipError):
            owner('approve', env, [SERVER, gui(300, 200)])  # live fixture ancestor is required

    def test_bad_metadata_and_wrong_invocations_are_rejected(self):
        good = {'SN_GUI_TEST_PID': '300', 'SN_GUI_TEST_OPERATION_ID': OP}
        for mode, env in (('approve', {}), ('approve', {**good, 'SN_GUI_TEST_PARENT_PID': '200'}), ('approve', {'SN_GUI_TEST_PID': '300'}),
                          ('auth', good), ('approve', {**good, 'SN_GUI_TEST_PID': '01'}), ('purge', good),
                          ('approve', {'SN_GUI_TEST_PID': '300', 'SN_GUI_TEST_OPERATION_ID': 'x'})):
            with self.assertRaises(OwnershipError):
                owner(mode, env, [FIXTURE, gui(300, 100)])
        with self.assertRaises(OwnershipError):
            owner('approve', good, [FIXTURE, proc(300, 100, '/bin/sleep', (GUI, '--approve', OP))])
        with self.assertRaises(OwnershipError):
            owner('approve', good, [FIXTURE, proc(300, 100, GUI, (GUI, '--approve', OP), uid=0)])
        auth = owner('auth', {'SN_GUI_TEST_PID': '300'}, [proc(100, 1, NODE, ('node', 'tests/gui-rpc-e2e.mjs')), proc(300, 100, GUI, (GUI,))])
        self.assertEqual(auth.select([window(300)])['kCGWindowOwnerPID'], 300)

    def test_layer_and_title_are_required_even_for_the_bound_pid(self):
        env = {'SN_GUI_TEST_PID': '300', 'SN_GUI_TEST_OPERATION_ID': OP}
        chosen = owner('approve', env, [FIXTURE, gui(300, 100)])
        self.assertIsNone(chosen.select([window(300, name='other'), window(300, layer=25)]))


class ProcessArguments(unittest.TestCase):
    def test_reads_exactly_argc_and_never_environment(self):
        data = struct.pack('=i', 2) + b'/exe\0\0\0' + b'/exe\0--approve\0SECRET=1\0'
        self.assertEqual(decode_procargs(data), ('/exe', '--approve'))
        for bad in (b'', struct.pack('=i', 0), struct.pack('=i', 3) + b'/exe\0/exe\0'):
            with self.assertRaises(OwnershipError):
                decode_procargs(bad)


if __name__ == '__main__':
    unittest.main()
