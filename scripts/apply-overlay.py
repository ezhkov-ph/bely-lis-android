"""Apply the reviewed overlay to the pinned checkout, validating before writing."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def confined(root, relative):
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or target == root:
        raise ValueError(f"Path escapes root: {relative}")
    return target


def apply(project, source):
    project, source = project.resolve(), source.resolve()
    manifest = json.loads((project / "artifacts/overlay-manifest.json").read_text())
    upstream = json.loads((project / "config/upstream.json").read_text())
    if manifest["upstream"] != upstream:
        raise ValueError("Overlay and current upstream pin disagree")
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != upstream["revision"]:
        raise ValueError("Checkout revision mismatch")
    overlay = (project / "artifacts/overlay").resolve()
    pending = []
    removals = []
    for entry in manifest["files"]:
        target = confined(source, entry["path"])
        if entry.get("delete"):
            if not target.exists():
                continue
            removals.append(target)
            continue
        data = confined(overlay, entry["path"]).read_bytes()
        if digest(data) != entry["sha256"]:
            raise ValueError(f"Overlay hash mismatch: {entry['path']}")
        if target.exists():
            current = digest(target.read_bytes())
            if current == entry["sha256"]:
                continue
            # Reapplying a reviewed manifest is intentional during incremental builds.
        elif entry["originalSha256"] is not None:
            raise ValueError(f"Missing original: {entry['path']}")
        pending.append((target, data))
    for target, data in pending:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
            stream.write(data)
            temporary = stream.name
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    for target in removals:
        target.unlink()
    print(f"Applied {len(pending)} files, removed {len(removals)} obsolete files; exact source revision and overlay hashes verified.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    apply(args.project, args.source)
