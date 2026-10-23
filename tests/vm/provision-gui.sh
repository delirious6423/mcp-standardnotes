#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=120 update -qq
apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \
  sway grim wtype wl-clipboard wlrctl jq tesseract-ocr python3-pil fonts-dejavu-core \
  libgl1-mesa-dri libegl-mesa0 mesa-vulkan-drivers vulkan-tools \
  libfontconfig1 libxkbcommon0 libxkbcommon-x11-0 libwayland-client0 \
  libxcb1 libxi6 libx11-xcb1 desktop-file-utils dbus-user-session
