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

### ⚠️ electron-builder rewrites the root `package.json` — always restore it after a build

During packaging, electron-builder rewrites `./package.json` in place, stripping
`scripts` + `devDependencies`. If a build is interrupted mid-write it leaves the
file **truncated / invalid JSON**. A subsequent build then reads that broken
package.json and produces an AppImage whose `app.asar` has an unparseable
`package.json` → Electron can't find `main`, falls back to `default_app.asar`,
and **exits 1 with no output → black screen / app never starts** (port 4000
never opens; sensors log `Connection refused`).

So after every build, before committing or rebuilding:

```bash
git checkout -- package.json   # restore scripts + devDependencies
python3 -c "import json; json.load(open('package.json'))"   # verify it parses
```

Never commit the stripped package.json. If the app shows a black screen on the
Pi, diagnose with: `strace -f -e openat ./round-carplay 2>&1 | grep default_app`
— a `default_app.asar` lookup confirms the broken-`package.json` cause.

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
