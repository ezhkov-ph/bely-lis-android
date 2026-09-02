#!/usr/bin/env bash
set -euo pipefail

version="${1:?version is required}"
revision="${2:?revision is required}"
tag="${3:?tag is required}"
disk='/mnt/ru-browser-build'
source="$disk/firefox-source"
repository='https://github.com/mozilla-firefox/firefox.git'

mountpoint -q "$disk"
if [ ! -e "$source" ]; then
  legacy="$disk/firefox-$version"
  if [ ! -e "$legacy" ]; then
    legacy=$(find "$disk" -maxdepth 1 -type d -name 'firefox-*' -print -quit)
  fi
  test -n "${legacy:-}" && test -d "$legacy/.git"
  mv "$legacy" "$source"
fi
test -d "$source/.git"
test "$(git -C "$source" remote get-url origin)" = "$repository"
git -C "$source" fetch --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
test "$(git -C "$source" rev-parse "refs/tags/$tag^{commit}")" = "$revision"
git -C "$source" checkout --force --detach "$revision"
test "$(git -C "$source" rev-parse HEAD)" = "$revision"
printf 'Source ready: Firefox Android %s at %s\n' "$version" "$revision"
