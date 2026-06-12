#!/usr/bin/env bash
set -euo pipefail

RESTORE=/home/byron/round-carplay/restore-20260612-0111-current-round-carplay

cp "$RESTORE/round-carplay.AppImage" /home/byron/round-carplay/round-carplay.AppImage
cp "$RESTORE/round-carplay.desktop" /home/byron/.config/autostart/round-carplay.desktop
mkdir -p /home/byron/.config/round-carplay
cp "$RESTORE/config.json" /home/byron/.config/round-carplay/config.json

sudo reboot
