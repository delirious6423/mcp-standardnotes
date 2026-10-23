#!/usr/bin/env python3
"""Pure, host-safe ownership regressions; reads only synthetic dictionaries and temp /proc trees."""
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'vm'))
from gui_owner import OwnershipError, Proc, owned_gui_pids, read_proc, select_window

EXE = '/opt/sn/standardnotes-connection'
OP = '11111111-1111-4111-8111-111111111111'


def proc(pid, ppid=50, argv=(EXE, '--approve', OP), exe=EXE, uid=1000):
    return Proc(pid, ppid, uid, exe, tuple(argv))


def owned(env, procs):
    return owned_gui_pids({'SN_GUI_TEST_EXE': EXE, **env}, lambda: procs, uid=1000)


class OwnedProcesses(unittest.TestCase):
    def test_exact_pid_for_auth_launch_and_manual_approval(self):
        self.assertEqual(owned({'SN_GUI_TEST_PID': '7'}, [proc(7, argv=(EXE,)), proc(8, argv=(EXE,))]), {7})
        self.assertEqual(owned({'SN_GUI_TEST_PID': '7', 'SN_GUI_TEST_OPERATION_ID': OP}, [proc(7)]), {7})

    def test_parent_binds_exactly_one_operation_child(self):
        procs = [proc(7), proc(8, argv=(EXE, '--approve', OP.replace('1', '2'))), proc(9, ppid=51)]
        self.assertEqual(owned({'SN_GUI_TEST_PARENT_PID': '50', 'SN_GUI_TEST_OPERATION_ID': OP}, procs), {7})

    def test_stale_wrong_binary_user_or_arguments_are_not_owned(self):
        env = {'SN_GUI_TEST_PID': '7', 'SN_GUI_TEST_OPERATION_ID': OP}
        for bad in (proc(7, exe='/bin/sleep'), proc(7, uid=0), proc(7, argv=(EXE, '--approve', 'x')),
                    proc(7, argv=(EXE, '--approve', OP, '--extra'))):
            self.assertEqual(owned(env, [bad]), set())
        self.assertEqual(owned({'SN_GUI_TEST_PID': '7'}, []), set())
        self.assertEqual(owned({'SN_GUI_TEST_PID': '7'}, [proc(7)]), set())  # approval args are not an auth launch

    def test_ambiguity_and_missing_inputs_fail_closed(self):
        env = {'SN_GUI_TEST_PARENT_PID': '50', 'SN_GUI_TEST_OPERATION_ID': OP}
        with self.assertRaises(OwnershipError):
            owned(env, [proc(7), proc(8)])
        for bad in ({}, {'SN_GUI_TEST_PID': '7', 'SN_GUI_TEST_PARENT_PID': '50'}, {'SN_GUI_TEST_PARENT_PID': '50'},
                    {'SN_GUI_TEST_PID': 'x'}, {'SN_GUI_TEST_PID': '1'}):
            with self.assertRaises(OwnershipError):
                owned(bad, [])
        with self.assertRaises(OwnershipError):
            owned_gui_pids({'SN_GUI_TEST_PID': '7'}, lambda: [], uid=1000)  # wrapper/relative path is not accepted


class Windows(unittest.TestCase):
    def view(self, pid, app_id='standardnotes-connection', name='Standard Notes Agent Connection'):
        return {'pid': pid, 'app_id': app_id, 'name': name, 'nodes': []}

    def test_title_alone_never_selects_a_window(self):
        tree = {'nodes': [{'nodes': [self.view(900)]}]}
        self.assertIsNone(select_window(tree, {7}))
        self.assertEqual(select_window(tree, {900})['pid'], 900)
        self.assertIsNone(select_window({'nodes': [self.view(7, app_id='other')]}, {7}))

    def test_floating_found_and_duplicates_rejected(self):
        self.assertEqual(select_window({'floating_nodes': [self.view(7)]}, {7})['pid'], 7)
        with self.assertRaises(OwnershipError):
            select_window({'nodes': [self.view(7), {'floating_nodes': [self.view(8)]}]}, {7, 8})


class ProcReader(unittest.TestCase):
    def test_comm_with_parentheses_and_nul_argv(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root) / '42'
            base.mkdir()
            (base / 'stat').write_bytes(b'42 (a) b (c) S 7 1 1 0 0')
            (base / 'cmdline').write_bytes(b'/x\0--approve\0id\0')
            (base / 'exe').symlink_to('/bin/true')
            result = read_proc(42, root)
            self.assertEqual((result.ppid, result.argv), (7, ('/x', '--approve', 'id')))
            self.assertIsNone(read_proc(43, root))


if __name__ == '__main__':
    unittest.main()
