# Project Notes for Claude

## Deploying to Pi

**Correct rsync target:** `/home/byron/round-carplay/round-carplay.AppImage`

The autostart entry on the Pi runs:
```
/home/byron/round-carplay/round-carplay.AppImage
```

Always sync like this:
```bash
rsync -az --progress "dist/round-carplay-0.1.0-arm64.AppImage" byron@motocarplay.local:/home/byron/round-carplay/round-carplay.AppImage
ssh byron@motocarplay.local "sudo reboot"
```

NOT to `/home/byron/round-carplay-0.1.0-arm64.AppImage` (wrong path, autostart ignores it).

## Build

```bash
npm run build:armLinux   # produces dist/round-carplay-0.1.0-arm64.AppImage
```

## GitHub

Push to the fork remote (not origin):
```bash
git push fork main
```

`origin` = upstream OneMakerShow/round-carplay (no push access)
`fork` = byroncoughlin/round-carplay (our fork)

## Display

- 800×800 round display, 3.4", 235 DPI
- CarPlay square: 565×565px (70.625% of 800)
- Arc strips: 117px (14.625% of 800)
- All sensor overlay content must stay within the circle boundary
