# Current Round CarPlay Restore Point

Created: 2026-06-12 01:12 EDT

This restore point captures the known-good Pi 5 round-carplay state before the
LIVI migration experiment.

## AppImage

- Pi path: `/home/byron/round-carplay/round-carplay.AppImage`
- SHA256: `c7970925b08e10af3121cbcfb36497c01bdcbed4e5ece624ad1c6104fe249eb7`
- Size: `133562091`

## Backups

- Pi backup: `/home/byron/round-carplay/restore-20260612-0111-current-round-carplay`
- Mac backup: `/Users/byron/round-carplay-restore-points/20260612-0111-current-round-carplay`

Each backup includes:

- `round-carplay.AppImage`
- `round-carplay.desktop`
- `config.json`
- `sensors.tgz`
- `systemd-user.tgz`
- process/service/socket snapshots

## Restore Pi To This State

```bash
ssh -o ConnectTimeout=6 byron@motocarplay.local '
set -e
RESTORE=/home/byron/round-carplay/restore-20260612-0111-current-round-carplay
cp "$RESTORE/round-carplay.AppImage" /home/byron/round-carplay/round-carplay.AppImage
cp "$RESTORE/round-carplay.desktop" /home/byron/.config/autostart/round-carplay.desktop
mkdir -p /home/byron/.config/round-carplay
cp "$RESTORE/config.json" /home/byron/.config/round-carplay/config.json
sudo reboot
'
```

After reboot, verify:

```bash
ssh -o ConnectTimeout=6 byron@motocarplay.local '
sha256sum /home/byron/round-carplay/round-carplay.AppImage
sed -n "1,80p" ~/.config/autostart/round-carplay.desktop
systemctl --user --no-pager --plain --full status gps.service cht-temp.service imu.service pi-temp.service ambient-temp.service
ss -ltnp | grep ":4000"
'
```
