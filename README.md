# Cloudlog Desktop

An unofficial native desktop client for [Cloudlog](https://github.com/magicbug/Cloudlog) (Wavelog servers work too), built with Electron for Debian-based Linux.

## What it does

| Area | Details |
|---|---|
| Online + offline logging | Every QSO is saved locally first, then uploaded through `api/qso`. If the server is unreachable QSOs queue up and go out automatically when it returns. A "Work offline" switch holds uploads. Failed QSOs show the server's reason and can be retried or discarded. The queue can be saved as ADIF. |
| Contest logging | Session-based. Built-in: CQ WW (SSB/CW), CQ WPX (SSB/CW), ARRL Field Day, NAQP (CW/SSB), plus "Other" (RST + serial, any ADIF contest ID). Auto serial numbers, live dupe check, score/rate summary. Sent as `CONTEST_ID`, `STX`, `SRX`, `STX_STRING`, `SRX_STRING`. |
| Quick logging | One-screen SOTA / POTA / WWFF / IOTA logger for activating or hunting. Enter to log. Fills `MY_*_REF`, `SOTA_REF`, `POTA_REF`, `SIG`, `SIG_INFO`. |
| View logbooks | Downloads a logbook with `api/get_contacts_adif` (delta updates), search and filter, paging. Pending local QSOs appear immediately. |
| Active logbook | Logbooks are your Cloudlog station profiles. The Active logbook is chosen in Settings > Logbooks; every page logs new QSOs to it. The list is cached for offline use. |
| Logbook Collections | Named groupings of existing logbooks, with a separate "Active collection" that sets what the Dashboard and the Logbooks page show by default. A view only: QSOs are never moved or copied. See "Logbook Collections" below. |
| Incoming ADIF | TCP and UDP listener (default port 2333). Accepts plain ADIF and the WSJT-X / JTDX UDP "Logged ADIF" message. |
| CAT (Hamlib) | Serial/USB radios (starts `rigctld` for you), network `rigctld`, a rigctl-compatible port that other programs (WSJT-X, fldigi...) can use, and an optional flrig-compatible XML-RPC port for fldigi and other FL-suite programs. Live frequency/mode/PTT status in the header; frequency and mode are sent to Cloudlog's radio API. |
| Look | Bootswatch Cerulean by default (close to Cloudlog's default look), plus dark themes. |

## Install

    # Debian / Ubuntu
    sudo apt install libhamlib-utils

    # Common
    chmod +x cloudlog-desktop_0.1.0_x86_64.AppImage && ./cloudlog-desktop_0.1.0_x86_64.AppImage

The AppImage uses the system's Hamlib (`rigctld`), so install `libhamlib-utils` first. Serial radios need your user in the `dialout` group.

In the app: Settings > Cloudlog (address + read/write API key, "Save and test connection"), then Logbooks (pick the Active logbook), then start logging.

## Build

    npm install          # also copies the front-end assets into src/renderer/vendor
    npm start            # run
    npm test             # backend tests (needs rigctld: apt install libhamlib-utils)
    npm run dist         # AppImage + deb into dist/

## Notes and limits

- API endpoints used: `api/auth`, `api/station_info`, `api/qso`, `api/radio`, `api/get_contacts_adif`. Logbook download needs a server version that has the last one.
- Data lives in `~/.config/cloudlog-desktop`: `settings.json` (settings, API key - stored there in plain text) and `qsocache.sqlite3` (the local QSO cache - your queued/local QSOs and each logbook's downloaded copy, scoped per logbook so switching or clearing one never touches another). Deleting the sqlite file (with the app closed) is equivalent to a full reset of every logbook's local cache; a developer-only `npm run dev:reset-cache` script does the same with a confirmation prompt.
- Settings > Logbooks has a "Clear local cache" button per logbook: it clears that logbook's already-synced/downloaded QSOs (forcing a fresh download next time) without touching any other logbook or any QSO still waiting to upload.
- Opening the ADIF socket, the Hamlib port or the XML-RPC port to "all interfaces" exposes them to your network; the default is this computer only. The XML-RPC port can key your transmitter (PTT) for anyone who can reach it.

## Sharing a radio with fldigi (flrig-compatible XML-RPC)

Settings > Radio (CAT) > "Share this radio (flrig XML-RPC port)" starts an flrig-compatible XML-RPC server for that radio (off by default, port 12345, this computer only). In fldigi choose Rig Control > flrig and enter the address and port. It uses the radio connection the app already has (no second serial/USB/network connection to the radio), runs independently of the Hamlib port, and both can be on at once for the same radio. Each radio needs its own XML-RPC port; saving a port that clashes with another radio's XML-RPC or Hamlib port, or with the radio's own connection, is refused. If the port cannot be opened (for example it is already in use), Settings shows the reason in red, the Dashboard shows no "open" line, and the radio connection and Hamlib port keep working. Changing the sharing settings reconnects that radio, like changing the Hamlib port does.

## Logbook Collections

Terminology: a **Logbook** is one of your Cloudlog station profiles (Cloudlog calls it a Station Location). A **Logbook Collection** is a named grouping of logbooks (what Cloudlog calls a Station Logbook). The **Active logbook** is where new QSOs are recorded. The **Active collection** is the default *viewing* scope: it may be one collection or one individual logbook.

- **Manage collections** in Settings > Logbooks: *New collection*, *Edit* (rename and choose member logbooks), delete. A collection can hold several logbooks and a logbook can be in several collections; a logbook is in a collection at most once. A collection shows each member logbook's QSOs once. A collection with no members shows no QSOs (never everything). Deleting a collection removes only the collection: its logbooks and QSOs are untouched.
- **Active collection** (Settings > Logbooks, grouped "Collections" / "Logbooks"; the default entry is "Follow the Active logbook"). Changing it never changes the Active logbook, and changing the Active logbook never changes a valid explicit Active collection.
- **Single-logbook fallback.** With no explicit selection (every installation starts this way, including upgrades) the Active collection *is* the current Active logbook, and follows it when you change it. No collection is created for this. If a saved selection no longer exists (collection deleted, logbook gone from the server list) the app falls back the same way. If there is no Active logbook either, the Dashboard and Logbooks page show an empty "no logbook selected" state, never all QSOs. An explicit selection of one logbook is kept even when you have no collections, and an empty collection stays selected and shows nothing.
- **Dashboard.** QSO statistics, Recent QSOs (the limit of ten applies after scoping) and the upload-queue card use the Active collection. Recent QSOs has a new rightmost **Logbook** column naming each QSO's own logbook. Queued QSOs are counted by the logbook each one belongs to; queued QSOs of other logbooks are noted as "+N in other logbooks". Existing statistics semantics are unchanged (queued QSOs were already part of the logbook totals, and a QSO that finishes uploading is not counted twice). "Sync now" still uploads everything.
- **Logbooks page.** Opens on the Active collection. The existing dropdown keeps every individual logbook and adds a "Collections" group. Choosing there only changes that page's own view (it is forgotten when you leave); it does not change Settings or the Active logbook. Search, band/mode filters, paging and counts apply to the chosen scope. The QSO table has a new rightmost **Logbook** column. "Update from server" in a collection downloads each member logbook.
- **Upload queue** (top of the Logbooks page): unchanged, still lists every queued QSO whatever the Active collection is, with a new rightmost **Logbook** column showing the logbook each queued QSO belongs to (a QSO queued before any logbook was chosen shows "Unassigned"; it is not assigned to the current logbook until the existing upload logic does so).
- **New logbooks** appear as individual options at once and are not added to any collection. A logbook that disappears from the server list is ignored in collections (the saved membership is left alone until you edit that collection).
- **Storage is unchanged.** Collections and the Active collection are stored only in `settings.json` (`logbookCollections`: collections with member logbook ids, and the explicit selection as a kind plus an id, so a logbook id and a collection id can never be confused). The QSO database, queued QSOs, upload/sync, ADIF import/export and duplicate checks are not changed, and creating, renaming, editing or deleting collections never rewrites a QSO.

