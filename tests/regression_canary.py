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
# Send boundaries: single write, batch preflight, between batch chunks; each must have its own failing test.
assert original.count(cancellation) == 3, "Cancellation boundary moved; update canary deliberately"
boundaries = [i for i in range(len(original)) if original.startswith(cancellation, i)]
for at, name in zip(boundaries, ["does not transmit a mutation when cancelled during read-only preflight",
                                 "a batch is cancelled during read-only preflight",
                                 "stops sending further chunks after a server conflict or cancellation"]):
    try:
        source.write_text(original[:at] + "// old behavior: cancellation ignored" + original[at + len(cancellation):])
        run = subprocess.run(
            ["npm", "test", "--", "src/sn/safe-write.test.ts", "-t", name],
            capture_output=True, text=True, timeout=60, check=False,
        )
        output = run.stdout + run.stderr
        assert run.returncode == 1 and "AssertionError" in output and name in output, output
    finally:
        source.write_text(original)
    assert source.read_text() == original
print("PASS regression canary: preflight cancellation fails without any of the three send-boundary guards; fixed source restored")
