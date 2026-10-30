#!/usr/bin/env bash
set -euo pipefail

version="${1:?version is required}"
revision="${2:?revision is required}"
tag="${3:?tag is required}"
bundle="${4:-}"
project='/mnt/c/Users/alex/Downloads/Firefox ru'
disk='/mnt/ru-browser-build'
source="$disk/firefox-source"
repository='https://github.com/mozilla-firefox/firefox.git'

mountpoint -q "$disk"
if [ ! -e "$source" ]; then
  legacy="$disk/firefox-$version"
  if [ ! -e "$legacy" ]; then
    legacy=$(find "$disk" -maxdepth 1 -type d -name 'firefox-*' -print -quit)
  fi
  if [ -n "${legacy:-}" ] && [ -d "$legacy/.git" ]; then
    mv "$legacy" "$source"
  else
    # The build disk can be recreated or cleaned independently of the Windows
    # workspace.  Bootstrap an empty checkout so the normal fetch below can
    # recover the pinned release instead of failing with no diagnostic.
    git init "$source"
    git -C "$source" remote add origin "$repository"
  fi
fi
test -d "$source/.git"
origin=$(git -C "$source" remote get-url origin)
if [ "$origin" != "$repository" ]; then
  case "$origin" in
    "$project"/work/linux-build/firefox-*)
      git -C "$source" remote set-url origin "$repository"
      ;;
    *)
      printf 'Unexpected source origin: %s\n' "$origin" >&2
      exit 1
      ;;
  esac
fi
test "$(git -C "$source" remote get-url origin)" = "$repository"
if [ -n "$bundle" ] && [ -f "$bundle" ]; then
  if ! git -C "$source" fetch --force "$bundle" "refs/tags/$tag:refs/tags/$tag"; then
    printf 'Bundle is incomplete; fetching the release tag from origin.\n' >&2
    git -C "$source" fetch --force --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  fi
else
  git -C "$source" fetch --force --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
fi
test "$(git -C "$source" rev-parse "refs/tags/$tag^{commit}")" = "$revision"
previous_revision=$(git -C "$source" rev-parse HEAD 2>/dev/null || true)
git -C "$source" reset --hard
if [ "$previous_revision" = "$revision" ]; then
  git -C "$source" clean -fd -e obj-ru-arm64/
else
  git -C "$source" clean -fd
fi
git -C "$source" checkout --force --detach "$revision"
if [ "$previous_revision" != "$revision" ]; then
  rm -rf "$source/obj-ru-arm64"
else
  printf 'Keeping object files for retry of the same verified revision.\n'
fi
test "$(git -C "$source" rev-parse HEAD)" = "$revision"
printf 'Source ready: Firefox Android %s at %s\n' "$version" "$revision"
