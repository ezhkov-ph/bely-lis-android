#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0 || { echo 'This setup step requires root inside WSL.'; exit 1; }
project='/mnt/c/Users/alex/Downloads/Firefox ru'
image="$project/work/linux-build/build.ext4"
mount_dir='/mnt/ru-browser-build'

case "${1:-}" in
  disk)
    mkdir -p "$project/work/linux-build"
    if [ ! -e "$image" ]; then
      # Only a newly created regular file may be formatted; never a device.
      (set -o noclobber; : > "$image")
      test -f "$image" && test ! -L "$image"
      truncate -s 64G "$image"
      mkfs.ext4 -F -m 0 -L ru-browser-build "$image"
    fi
    test -f "$image" && test ! -L "$image"
    mkdir -p "$mount_dir"
    if ! mountpoint -q "$mount_dir"; then
      test -z "$(ls -A "$mount_dir")" || { echo 'Mount directory is not empty'; exit 1; }
      mount -o loop "$image" "$mount_dir"
    fi
    loop_device=$(findmnt -n -o SOURCE --target "$mount_dir")
    backing=$(losetup --noheadings --output BACK-FILE "$loop_device")
    test "$backing" = "$image" || { echo 'Unexpected backing file'; exit 1; }
    chown 1000:1000 "$mount_dir"
    df -h "$mount_dir"
    ;;
  packages)
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends \
      build-essential python3 python3-dev python3-venv python3-pip \
      curl wget git unzip zip xz-utils zstd pkg-config libssl-dev \
      libdbus-1-dev libdbus-glib-1-dev libasound2-dev libpulse-dev \
      libx11-xcb-dev libxt-dev libgtk-3-dev libdrm-dev libgbm-dev \
      libxrandr-dev libxdamage-dev libxcomposite-dev libxfixes-dev \
      nasm yasm m4 autoconf2.13 ca-certificates
    ;;
  *) echo 'Usage: setup-build-host.sh disk|packages' >&2; exit 2 ;;
esac
