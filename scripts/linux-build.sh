#!/usr/bin/env bash
set -euo pipefail

project='/mnt/c/Users/alex/Downloads/Firefox ru'
build_root="$project/work/linux-build"
mapfile -t pin < <(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["version"]); print(p["revision"]); print(p["tag"])' "$project/config/upstream.json")
version="${pin[0]}"
revision="${pin[1]}"
tag="${pin[2]}"
source_dir="$build_root/firefox-$version"
mkdir -p "$build_root/logs"

case "${1:-}" in
  check-overlay)
    cd "$project"
    python3 -m unittest discover -s test -p 'test_*.py' -v
    ;;
  status)
    ps -eo pid,etime,comm,wchan:25 | grep -E 'git|mkfs|mke2fs|unattended|dpkg|mount|curl' || true
    df -h "$project" /mnt/ru-browser-build 2>/dev/null || true
    du -h "$source_dir/.git/objects/pack/" 2>/dev/null || true
    tail -n 3 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null || true
    ;;
  inspect)
    test -f "$source_dir/mach"
    git -C "$source_dir" ls-files '*AGENTS.md'
    sed -n '1,100p' "$source_dir/python/mozboot/mozboot/debian.py"
    grep -n -E 'no.system.changes|mobile_android|MOZBUILD_STATE_PATH|RUSTUP_HOME|CARGO_HOME' \
      "$source_dir/python/mozboot/mozboot/bootstrap.py" \
      "$source_dir/python/mozboot/mozboot/base.py" \
      "$source_dir/python/mozboot/mozboot/android.py" | head -n 65
    ;;
  import)
    mountpoint -q /mnt/ru-browser-build || { echo 'Build disk not mounted'; exit 1; }
    test "$(git -C "$source_dir" rev-parse HEAD)" = "$revision"
    native_source='/mnt/ru-browser-build/firefox-source'
    if [ ! -e "$native_source" ]; then
      echo 'Copying the verified checkout into the Linux disk in the project folder.'
      cp -a "$source_dir" "$native_source"
    fi
    test "$(git -C "$native_source" rev-parse HEAD)" = "$revision"
    python3 "$project/scripts/apply-overlay.py" "$project" "$native_source" --allow-existing
    echo 'Source and overlay ready on ext4.'
    ;;
  bootstrap)
    mountpoint -q /mnt/ru-browser-build || exit 1
    export MOZBUILD_STATE_PATH='/mnt/ru-browser-build/mozbuild'
    export CARGO_HOME='/mnt/ru-browser-build/cargo'
    export RUSTUP_HOME='/mnt/ru-browser-build/rustup'
    export GRADLE_USER_HOME='/mnt/ru-browser-build/gradle'
    export PIP_CACHE_DIR='/mnt/ru-browser-build/pip-cache'
    export PATH="$CARGO_HOME/bin:$PATH"
    cd /mnt/ru-browser-build/firefox-source
    ./mach --no-interactive bootstrap --application-choice='GeckoView/Firefox for Android' --no-system-changes \
      > "$build_root/logs/bootstrap.log" 2>&1
    echo 'Mozilla bootstrap complete.'
    ;;
  sources)
    if [ ! -e "$source_dir" ]; then
      echo "Downloading Firefox Android $tag into $source_dir"
      git clone --depth 1 --single-branch --branch "$tag" \
        https://github.com/mozilla-firefox/firefox.git "$source_dir" \
        > "$build_root/logs/clone.log" 2>&1
    fi
    actual=$(git -C "$source_dir" rev-parse HEAD)
    test "$actual" = "$revision" || { echo 'Source revision mismatch'; exit 1; }
    printf 'Source ready: %s\n' "$actual"
    ;;
  *)
    echo 'Usage: linux-build.sh sources' >&2
    exit 2
    ;;
esac
