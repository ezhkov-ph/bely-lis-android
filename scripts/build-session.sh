#!/usr/bin/env bash
set -euo pipefail
project='/mnt/c/Users/alex/Downloads/Firefox ru'
bash "$project/scripts/setup-build-host.sh" disk
if [ "${1:-}" = "update-source" ]; then
  shift
  exec runuser -u alex -- bash "$project/scripts/update-source.sh" "$@"
fi
exec runuser -u alex -- bash "$project/scripts/run-build.sh" "${1:-pipeline}"
