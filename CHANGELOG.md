# Changelog

## Unreleased
- CI: `node.js.yml` is renamed `test.yml` (workflow `Test`, job `test`); `release.yml` is now gated on `Test`. Releases follow the repository's immutable-releases setting.
- CI: new `prerelease.prune.yml`, weekly on Monday at 03:00 EST (08:00 UTC), deletes old prereleases and their tags: per channel the latest release is always kept, plus 1 more `rc`, 3 more `beta` and 2 more `alpha`. Stable releases are never touched, and no special token is needed. It can also be started by hand with a dry-run option.
- Note for maintainers: required status checks named `build (22.x)` etc. are now `test (22.x)`, `test (24.x)`, `test (26.x)`.

## 0.4.4
- New: **Logbook Collections** (see above): named groups of existing logbooks, managed in Settings > Logbooks, with a separate **Active collection** setting that sets the default scope of the Dashboard and the Logbooks page. The Active logbook keeps its meaning (where new QSOs go).
- Dashboard: statistics, Recent QSOs and the queue card follow the Active collection; Recent QSOs has a new rightmost "Logbook" column.
- Logbooks page: opens on the Active collection; the dropdown adds collections next to the individual logbooks; the QSO table and the upload queue each get a new rightmost "Logbook" column. The upload queue otherwise behaves exactly as before.
- Settings from earlier versions keep working: the Active collection starts as "Follow the Active logbook". QSO storage, queue processing and synchronization are unchanged. Radio sharing is unchanged.

## 0.4.3
- New: two separate callbook enrichment controls in Settings > Callbook Lookup > "Add missing details to QSOs", each with its own "On a new QSO" switch and its own "On upload" switch (four independent on/off settings in all):
  - **Add Lookup Data to QSO Log Event** fills a missing Name (the other operator's name), State, County and Country.
  - **Add Lookup Grid if QSO Grid is Missing** fills a missing Gridsquare.
- Lookup results now also carry State, County and Country (QRZ and HamQTH). County is saved as `ST,County` for United States contacts (the ADIF form) and as the provider gives it otherwise. Country is the provider's country name; no DXCC number is added.

## 0.4.2
- New: flrig-compatible XML-RPC radio sharing, so fldigi and other FL-suite programs can use a radio managed by Cloudlog Desktop. Per radio, in Settings > Radio (CAT): an on/off switch (off by default), "Listen on" (default: this computer only) and a port (default 12345). It is independent of the Hamlib port: either, or both together, can share the same radio, and neither opens another connection to the radio. See "Sharing a radio with fldigi" above for the supported methods, error behaviour and limitations.
- Settings > Radio (CAT) > "This radio's CAT status" shows "Shared XmlRPC port" directly below "Shared Hamlib port" when XML-RPC sharing is on (also when Hamlib sharing is off): listening address and port with the number of clients, "Starting…", or the reason it could not open the port.
- Settings files from earlier versions keep working; XML-RPC sharing is off until you turn it on.

## 0.4.1
- Incoming ADIF can now receive WSJT-X and JTDX by IP multicast. Settings > Incoming ADIF has a new "WSJT-X / JTDX multicast" section with an on/off switch, the multicast address (default `224.0.0.1`), the port (default `2237`) and the network interface (default "This computer only"). Multicast switch is off until you turn it on.
- Note: Linux often ships with multicast switched off on the loopback interface (`lo`). In that case "This computer only" cannot work: the listener is not started, the status turns red with the reason, and nothing falls back to another interface. Either run `sudo ip link set lo multicast on` or pick another interface (for example your Ethernet or Wi-Fi interface).

## 0.3.7
- Dashboard: the Recent QSOs table no longer has a Station column, and its Notes column is replaced by Country.
- Logbook: Station is replaced by Grid (the contact's grid square) and Notes is replaced by Country. A contact with no grid or country simply shows an empty cell.
- Logbook: the Previous and Next buttons are now clearly visible at all times (in the default Cerulean theme they were pale grey on white and only showed up when hovered). They are still disabled on the first and last page.
- Logbook: the table now fits the window instead of a fixed height, so there is a single scrollbar (the table's) and Previous/Next stay on screen at any window size. The upload queue above it keeps its size, and a long queue list scrolls on its own.

## 0.3.6
- The top bar now reads "Cloudlog Desktop". The cloud icon beside it is a button that opens your configured Cloudlog server (Settings > Cloudlog > Address) in your default browser; only http and https addresses are opened, and an empty or invalid address shows a message pointing you to Settings instead.
- Settings moved to a hamburger button ("Settings menu") at the far right of the top bar, replacing the Settings entry in the main navigation.
- Settings > About now lists the running version, the detected Hamlib version, the `rigctld` in use and the real data folder (with "Not available" / "Not configured" when they cannot be determined), and links to Cloudlog, WaveLog, the project's GitHub page and the GPLv3 license, all opened in your default browser.

## 0.3.5
- Fixed Live QSO logging duplicate records when you pressed Enter. The Enter-to-log handler was attached to the shared page container each time the page was opened and never removed, so every visit to Live QSO added another copy and one keypress saved the same QSO once per visit (eight records after eight visits). The handler is now removed when you leave the page, and a save that is already in progress ignores further Enter presses and button clicks until it finishes or fails.
- Fixed Quick log logging duplicate records when you pressed Enter, for the same reason (four records after four visits).
- Fixed the Quick log error `Cannot read properties of null (reading 'value')`. It came from Enter handlers left behind by other pages running against the Quick log form, and from reading form fields after a save or duplicate check finished once the page had already been left. Quick log now reads its form before saving and no longer touches the page if you have navigated away.
- The Contest page had the same leftover Enter handler; it is now removed on leaving the page too (no other Contest behaviour changed).
- Holding Enter down (key auto-repeat) no longer repeats the save.

## 0.3.4
- Live QSO: configurable callbook lookup. Settings > Callbook Lookup lets you choose Disabled / No lookup, QRZ, or HamQTH; leaving the callsign field (not while you're still typing) fills Name, QTH and Grid Square from the provider when it has them, without overwriting anything you've typed yourself. Lookups are never repeated for the same callsign, and a failed or skipped lookup never blocks logging.
- QRZ lookup signs in with your QRZ username and password (QRZ's documented callsign-lookup service requires this; QRZ API keys only work with its separate Logbook API, which can't look up callsigns), and requires an active QRZ XML Logbook Data subscription for full results. HamQTH lookup uses your HamQTH username and password and reuses its session until it expires.
- Both providers' passwords are stored encrypted with your system keyring when one is available (Settings > Callbook Lookup shows show/hide controls and never redisplays a saved password), and switching providers keeps both providers' saved logins.
- "Work offline" now also disables callbook lookup - no QRZ or HamQTH request is made while it's on - and the Live QSO screen stays fully usable either way.
- Live QSO now has QRZ and HamQTH buttons next to the callsign field that open that callsign's public profile page in your browser. They stay hidden while you're typing and appear once you leave the field with a valid callsign. They need no login, work with either provider selected (or lookup disabled), and remain available offline.

## 0.3.3
- The local QSO cache (queued/pending uploads, and each logbook's downloaded copy) now lives in a SQLite database (`qsocache.sqlite3`) instead of `qsos.json`/per-logbook JSON files. Built for logbooks well beyond 100,000 QSOs: indexed keyset pagination (no more full-logbook loads to render the Logbook page), indexed callsign history/dupe checks (Contest and Quick pages), and indexed pending/failed/synced lookups. All database access stays in the Electron main process, behind a dedicated cache module - the renderer only ever calls narrow, validated IPC methods.
- Settings > Logbooks: a "Clear local cache" button per logbook. It only clears that logbook's already-synced/downloaded QSOs (so the next view/refresh re-downloads them) - it never touches another logbook, your settings, or a QSO still waiting to upload.
- The old `qsos.json`/`remote-*.json` files, if present from a previous version, are left on disk untouched and unused; this release does not migrate or read them.

## 0.3.2
- Fixed a bug where deleting a QSO (or occasionally editing one) could leave the whole app unresponsive to typing until restarted. The cause was `window.confirm()` - Electron's native confirmation dialog - which can desync input handling on some Linux setups; all in-app confirmations now use an ordinary in-page dialog instead. As a second line of defense, any leftover dialog overlay is now also cleared automatically on every page navigation, so even an unrelated future bug of this kind can't strand you - clicking to another tab recovers instead of requiring a restart.
- Moved the "Logbooks" picker (choosing the current logbook) from its own top-level tab into a tab inside Settings, alongside Cloudlog, Radio, Incoming ADIF, Appearance and About.
- Radio settings: choosing "1 - Hamlib Dummy" as the model now hides Serial port, Speed and PTT method (none of them apply to a dummy rig), and shows a "Default frequency" (14.225 MHz) and "Default mode" (USB) pair above Extra Hamlib options - the dummy rig has no real hardware to remember a frequency between runs, so these give it a sane starting point instead of an arbitrary one.

## 0.3.1
- Radios can now be individually disabled. Every radio starts **off** by default when the app launches; check "Turn on automatically when the app launches" in that radio's settings to have it reconnect on its own, or flip its "Enabled" switch any time to start/stop it live.
- Added a "Force RTS" option (Settings > Radio > Advanced, serial connections only) for rigs that wire PTT to the serial RTS line: Linux raises RTS the instant a serial port is opened, at the driver level, before Hamlib or anything else at the application layer can lower it - so PTT keys up for an instant every time rigctld starts. This uses an LD_PRELOAD shim (`force_rts.so`) that intercepts the `open()` call and clears RTS immediately, which is the standard workaround for this - Hamlib's own PTT/serial config can't prevent it, since the assertion happens before Hamlib's code runs at all.

## 0.1.0
- System tray icon (same cloud icon as the window) with Show / Sync now / Quit. Closing the window now minimizes to the tray instead of quitting; the CAT connection and ADIF listener keep running in the background.
- Multiple radios: Settings > Radio now manages any number of radios, each with its own connection and shared Hamlib port. One is "active for logging" at a time and drives the Live/Quick/Contest "follow radio" feature; every radio with "send to Cloudlog" on reports its own frequency independently. Existing single-radio configs migrate automatically.
- Fixed the `get_contacts_adif` error: confirmed against Cloudlog's own source that stock Cloudlog (unlike Wavelog) doesn't expose a logbook-download endpoint at all. The Logbook page now explains this plainly and disables "Update from server" instead of showing a raw error - QSOs you log still upload normally.
- Upload controls: an "instant upload" toggle (upload each QSO the moment it's logged vs. queue for manual/periodic sync) alongside the existing "disable uploading" switch, both in Settings > Cloudlog and on the Logbook page.
- Edit or delete a QSO before it uploads, from the Logbook page's upload queue.
- "Sync now" is now always visible (Dashboard and Logbook), not just when something is waiting.
- Data now always lives in `~/.config/cloudlog-desktop`, independent of how Electron would otherwise derive a folder name.
- Fixed a related timing bug: the periodic auto-retry used to treat "never synced before" as "retry interval already elapsed," so the very first queued QSO after startup could upload almost immediately even with instant-upload turned off.
