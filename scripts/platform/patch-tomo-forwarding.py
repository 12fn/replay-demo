"""Preserve Core1.2 signed fields in the pinned supplied Tomo forwarding helper.

Run only while building a private derived image. This contains no vendor source.
"""
import hashlib
import importlib.util
from pathlib import Path

EXPECTED = "dd40d79f9abcbd44dc9008846743d3740a684a79d351b1d01382841749bbe9ee"
ADDED = (
    "x-user-preferred-username", "x-requested-workroom-scope",
    "x-verified-workroom-scope", "x-protected-action-type",
    "x-visibility-scope", "x-authz-outcome", "x-authz-reason-class",
)

def main():
    spec = importlib.util.find_spec("kamiwaza_extensions_lib.auth")
    if spec is None or not spec.origin:
        raise RuntimeError("Supplied forwarding helper is missing")
    path = Path(spec.origin)
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED:
        raise RuntimeError("Refuse an unreviewed forwarding helper revision")
    marker = '        "authorization",\n'
    source = raw.decode()
    if source.count(marker) != 1:
        raise RuntimeError("Expected exactly one forwarding allowlist")
    replacement = marker + "".join('        "' + name + '",\n' for name in ADDED)
    path.write_text(source.replace(marker, replacement))
    print("Extended signed-envelope forwarding allowlist by seven fields; signature verification unchanged")

if __name__ == "__main__":
    main()
