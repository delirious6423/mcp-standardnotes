"""Run the approval CLI in a real pseudo-terminal and type ANSWER only after its prompt appears.

Usage: approve-pty.py ANSWER COMMAND [ARG...]. Prints the terminal output; exits with the CLI's status.
Typed-ahead input is unreliable (BSD script sends EOF right after it), so wait for the prompt like a person.
"""
import os
import pty
import select
import sys
import time

PROMPT = b"to refuse it permanently: "
answer, command = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
output, sent, deadline = b"", False, time.monotonic() + 15
while time.monotonic() < deadline:
    if select.select([fd], [], [], 0.1)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError:  # Linux raises EIO once the child has closed the terminal.
            break
        if not chunk:
            break
        output += chunk
    if not sent and PROMPT in output:
        os.write(fd, answer.encode() + b"\r")
        sent = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(output.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status) if sent else 124)
