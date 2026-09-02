#!/usr/bin/env bash
set -euo pipefail
project='/mnt/c/Users/alex/Downloads/Firefox ru'
mapfile -t pin < <(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["version"]); print(p["revision"])' "$project/config/upstream.json")
downloaded="$project/work/linux-build/firefox-${pin[0]}"
native='/mnt/ru-browser-build/firefox-source'
revision="${pin[1]}"
mountpoint -q /mnt/ru-browser-build
test "$(git -C "$downloaded" rev-parse HEAD)" = "$revision"
if [ ! -e "$native" ]; then
  git clone --local --no-hardlinks --no-checkout "$downloaded" "$native"
fi
test "$(git -C "$native" rev-parse HEAD)" = "$revision"
git -C "$native" fsck --connectivity-only
# Stop only our original clone AFTER its complete Git objects have been copied.
# The downloaded NTFS checkout is not deleted or reused for building.
python3 - "$downloaded" <<'PY'
import os, signal, sys
from pathlib import Path
for process in Path('/proc').iterdir():
    if not process.name.isdigit():
        continue
    try:
        args = (process / 'cmdline').read_bytes().split(b'\0')
        if args[:2] == [b'git', b'clone'] and sys.argv[1].encode() in args:
            os.kill(int(process.name), signal.SIGTERM)
            print('Stopped slow NTFS checkout after verifying the copied repository.')
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        pass
PY
git -C "$native" checkout --detach "$revision" > "$project/work/linux-build/logs/native-checkout.log" 2>&1
echo "Native checkout ready: $revision"
git -C "$native" ls-files '*AGENTS.md'
