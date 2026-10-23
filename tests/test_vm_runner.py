"""Pure temp-directory regression: editing a running checkout cannot corrupt Bash input."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest


class FrozenRunnerTest(unittest.TestCase):
    def test_runner_survives_live_source_edit(self):
        source = (Path(__file__).parent / "vm/run.sh").read_text()
        prefix = source.split("REPO=", 1)[0]
        self.assertIn("runner_source=", prefix)
        with tempfile.TemporaryDirectory(prefix="sn-frozen-runner-") as directory:
            root = Path(directory)
            script = root / "runner.sh"
            ready = root / "ready"
            script.write_text(prefix + f"touch '{ready}'\nsleep 0.3\necho SNAPSHOT_OK\n")
            env = {k: v for k, v in os.environ.items() if k != "SN_VM_RUNNER_FROZEN"}
            with subprocess.Popen(["bash", str(script)], env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True) as child:
                end = time.monotonic() + 3
                while not ready.exists() and time.monotonic() < end:
                    time.sleep(.01)
                self.assertTrue(ready.exists(), "runner did not start")
                script.write_text("# edited while blocked\n" + script.read_text())
                out, error = child.communicate(timeout=3)
                self.assertEqual((child.returncode, out, error), (0, "SNAPSHOT_OK\n", ""))


if __name__ == "__main__":
    unittest.main()
