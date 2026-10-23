"""Prove the protected-search regression fails with the old guard; VM only."""
import os
from pathlib import Path
import subprocess

if os.environ.get("SN_VM_TEST") != "1":
    raise SystemExit("Run only through tests/vm/run.sh inside the disposable VM")
source = Path("src/sn/client.ts")
original = source.read_text()
guard = "if (n.trashed || n.protected) continue;"
assert original.count(guard) == 1, "Search guard moved; update the canary deliberately"
try:
    source.write_text(original.replace(guard, "if (n.trashed) continue;"))
    run = subprocess.run(
        ["npm", "test", "--", "src/sn/safe-write.test.ts", "-t", "does not search protected"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    output = run.stdout + run.stderr
    assert run.returncode == 1 and "AssertionError" in output and "does not search protected" in output, output
finally:
    source.write_text(original)
assert source.read_text() == original
print("PASS regression canary: old protected-search behavior fails its assertion; fixed source restored")

cancellation = "options?.signal?.throwIfAborted();"
assert original.count(cancellation) == 1, "Cancellation boundary moved; update canary deliberately"
try:
    source.write_text(original.replace(cancellation, "// old behavior: cancellation ignored"))
    run = subprocess.run(
        ["npm", "test", "--", "src/sn/safe-write.test.ts", "-t", "cancelled during read-only preflight"],
        capture_output=True, text=True, timeout=60, check=False,
    )
    output = run.stdout + run.stderr
    assert run.returncode == 1 and "AssertionError" in output and "cancelled during read-only preflight" in output, output
finally:
    source.write_text(original)
assert source.read_text() == original
print("PASS regression canary: preflight cancellation fails without the send-boundary guard; fixed source restored")
