#!/usr/bin/env bash
set -euo pipefail
project='/mnt/c/Users/alex/Downloads/Firefox ru'
mount_dir='/mnt/ru-browser-build'
bash "$project/scripts/setup-build-host.sh" disk
if [ "${1:-}" = "update-source" ]; then
  shift
  exec runuser -u alex -- bash "$project/scripts/update-source.sh" "$@"
fi
if [ "${1:-}" = "update-source-pin" ]; then
  shift
  version="${1:?version is required}"
  revision="${2:?revision is required}"
  tag="${3:?tag is required}"
  bundle="${4:-}"
  candidate="${5:?candidate is required}"
  runuser -u alex -- bash "$project/scripts/update-source.sh" "$version" "$revision" "$tag" "$bundle"
  exec runuser -u alex -- python3 "$project/scripts/pin-upstream.py" "$project" "$mount_dir/firefox-source" "$candidate"
fi
if [ "${1:-}" = "validate-and-release" ]; then
  runuser -u alex -- python3 "$project/scripts/validate-branding.py"
  runuser -u alex -- python3 -m unittest discover -s "$project/test" -p 'test_*.py'
  runuser -u alex -- python3 "$project/scripts/apply-overlay.py" "$project" "$mount_dir/firefox-source"
  exec runuser -u alex -- bash "$project/scripts/run-build.sh" release-applied
fi
exec runuser -u alex -- bash "$project/scripts/run-build.sh" "${1:-pipeline}"
