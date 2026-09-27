# Cloudlog Desktop

An unofficial native desktop client for [Cloudlog](https://github.com/magicbug/Cloudlog) (Wavelog servers work too), built with Electron for Debian-based Linux.

## What it does

| Area | Details |
|---|---|
| Online + offline logging | Every QSO is saved locally first, then uploaded through `api/qso`. If the server is unreachable QSOs queue up and go out automatically when it returns. A "Work offline" switch holds uploads. Failed QSOs show the server's reason and can be retried or discarded. The queue can be saved as ADIF. |
| Contest logging | Session-based. Built-in: CQ WW (SSB/CW), CQ WPX (SSB/CW), ARRL Field Day, NAQP (CW/SSB), plus "Other" (RST + serial, any ADIF contest ID). Auto serial numbers, live dupe check, score/rate summary. Sent as `CONTEST_ID`, `STX`, `SRX`, `STX_STRING`, `SRX_STRING`. |
| Quick logging | One-screen SOTA / POTA / WWFF / IOTA logger for activating or hunting. Enter to log. Fills `MY_*_REF`, `SOTA_REF`, `POTA_REF`, `SIG`, `SIG_INFO`. |
| View logbooks | Downloads a logbook with `api/get_contacts_adif` (delta updates), search and filter, paging. Pending local QSOs appear immediately. |
| Current logbook | Logbooks are your Cloudlog station profiles. Chosen on the Logbooks page; every page logs to it. The list is cached for offline use. |
| Incoming ADIF | TCP and UDP listener (default port 2333). Accepts plain ADIF and the WSJT-X / JTDX UDP "Logged ADIF" message. |
| CAT (Hamlib) | Serial/USB radios (starts `rigctld` for you), network `rigctld`, and a rigctl-compatible port that other programs (WSJT-X, fldigi...) can use. Live frequency/mode/PTT status in the header; frequency and mode are sent to Cloudlog's radio API. |
| Look | Bootswatch Cerulean by default (close to Cloudlog's default look), plus dark themes. |

## Install

    sudo apt install libhamlib-utils
    chmod +x cloudlog-desktop_0.1.0_x86_64.AppImage && ./cloudlog-desktop_0.1.0_x86_64.AppImage

The AppImage uses the system's Hamlib (`rigctld`), so install `libhamlib-utils` first. Serial radios need your user in the `dialout` group.

In the app: Settings > Cloudlog (address + read/write API key, "Save and test connection"), then Logbooks (pick the current one), then start logging.

## Build

    npm install          # also copies the front-end assets into src/renderer/vendor
    npm start            # run
    npm test             # backend tests (needs rigctld: apt install libhamlib-utils)
    npm run dist         # AppImage + deb into dist/

## Layout

    src/main/      Electron main process: cloudlog.js (API), logbook.js (queue/sync/cache), rig.js (Hamlib + relay),
                   adifserver.js, adif.js, contests.js, store.js
    src/renderer/  UI (plain HTML/JS, Bootstrap theme): util.js, app.js, pages/*
    test/          node:test suites (mock Cloudlog server, real rigctld) and a headless UI smoke test

## Notes and limits

- API endpoints used: `api/auth`, `api/station_info`, `api/qso`, `api/radio`, `api/get_contacts_adif`. Logbook download needs a server version that has the last one.
- Data lives in `~/.config/cloudlog-desktop` (settings, local QSO queue, downloaded logbooks). The API key is stored there in plain text.
- Opening the ADIF socket or the Hamlib port to "all interfaces" exposes them to your network; the default is this computer only.

## Changelog

### 0.1.0
- System tray icon (same cloud icon as the window) with Show / Sync now / Quit. Closing the window now minimizes to the tray instead of quitting; the CAT connection and ADIF listener keep running in the background.
- Multiple radios: Settings > Radio now manages any number of radios, each with its own connection and shared Hamlib port. One is "active for logging" at a time and drives the Live/Quick/Contest "follow radio" feature; every radio with "send to Cloudlog" on reports its own frequency independently. Existing single-radio configs migrate automatically.
- Fixed the `get_contacts_adif` error: confirmed against Cloudlog's own source that stock Cloudlog (unlike Wavelog) doesn't expose a logbook-download endpoint at all. The Logbook page now explains this plainly and disables "Update from server" instead of showing a raw error - QSOs you log still upload normally.
- Upload controls: an "instant upload" toggle (upload each QSO the moment it's logged vs. queue for manual/periodic sync) alongside the existing "disable uploading" switch, both in Settings > Cloudlog and on the Logbook page.
- Edit or delete a QSO before it uploads, from the Logbook page's upload queue.
- "Sync now" is now always visible (Dashboard and Logbook), not just when something is waiting.
- Data now always lives in `~/.config/cloudlog-desktop`, independent of how Electron would otherwise derive a folder name.
- Fixed a related timing bug: the periodic auto-retry used to treat "never synced before" as "retry interval already elapsed," so the very first queued QSO after startup could upload almost immediately even with instant-upload turned off.

### 0.3.1
- Radios can now be individually disabled. Every radio starts **off** by default when the app launches; check "Turn on automatically when the app launches" in that radio's settings to have it reconnect on its own, or flip its "Enabled" switch any time to start/stop it live.
- Added a "Force RTS" option (Settings > Radio > Advanced, serial connections only) for rigs that wire PTT to the serial RTS line: Linux raises RTS the instant a serial port is opened, at the driver level, before Hamlib or anything else at the application layer can lower it - so PTT keys up for an instant every time rigctld starts. This uses an LD_PRELOAD shim (`force_rts.so`) that intercepts the `open()` call and clears RTS immediately, which is the standard workaround for this - Hamlib's own PTT/serial config can't prevent it, since the assertion happens before Hamlib's code runs at all.

### 0.3.2
- Fixed a bug where deleting a QSO (or occasionally editing one) could leave the whole app unresponsive to typing until restarted. The cause was `window.confirm()` - Electron's native confirmation dialog - which can desync input handling on some Linux setups; all in-app confirmations now use an ordinary in-page dialog instead. As a second line of defense, any leftover dialog overlay is now also cleared automatically on every page navigation, so even an unrelated future bug of this kind can't strand you - clicking to another tab recovers instead of requiring a restart.
- Moved the "Logbooks" picker (choosing the current logbook) from its own top-level tab into a tab inside Settings, alongside Cloudlog, Radio, Incoming ADIF, Appearance and About.
- Radio settings: choosing "1 - Hamlib Dummy" as the model now hides Serial port, Speed and PTT method (none of them apply to a dummy rig), and shows a "Default frequency" (14.225 MHz) and "Default mode" (USB) pair above Extra Hamlib options - the dummy rig has no real hardware to remember a frequency between runs, so these give it a sane starting point instead of an arbitrary one.
