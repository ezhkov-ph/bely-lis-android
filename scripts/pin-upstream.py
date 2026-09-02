"""Pin a checked-out Firefox release and refresh hashes used by the overlay."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        temporary = stream.name
    os.replace(temporary, path)


def git_bytes(source, revision, path):
    return subprocess.check_output(["git", "-C", str(source), "show", f"{revision}:{path}"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project", type=Path)
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    project, source = args.project.resolve(), args.source.resolve()
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))
    current = json.loads((project / "config/upstream.json").read_text(encoding="utf-8"))
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if revision != candidate["revision"]:
        raise RuntimeError("Checked-out source does not match the candidate revision")
    candidate["sourceFiles"] = current["sourceFiles"]
    atomic_json(project / "config/upstream.json", candidate)

    hashes = {}
    for path in candidate["sourceFiles"]:
        data = git_bytes(source, revision, path)
        destination = project / "work/upstream" / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        hashes[path] = hashlib.sha256(data).hexdigest()
    atomic_json(project / "config/source-hashes.json", {"revision": revision, "files": hashes})
    subprocess.run(
        ["python3", str(project / "scripts/export-branding-sources.py"), str(project), str(source)],
        check=True,
    )

    readme = project / "README.md"
    text = readme.read_text(encoding="utf-8")
    tick = chr(96)
    replacement = (
        f"Текущая основа: **Firefox Android {candidate['version']}**, "
        f"тег {tick}{candidate['tag']}{tick}, ревизия {tick}{candidate['revision']}{tick}."
    )
    text, count = re.subn(
        r"Текущая основа: \*\*Firefox Android [^*]+\*\*, тег \x60[^\x60]+\x60, ревизия \x60[0-9a-f]{40}\x60\.",
        replacement,
        text,
    )
    if count != 1:
        raise RuntimeError("README upstream marker was not found exactly once")
    readme.write_text(text, encoding="utf-8")
    print(f"Pinned Firefox Android {candidate['version']} at {revision}")


if __name__ == "__main__":
    main()
