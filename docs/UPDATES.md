# Updates (GitHub Releases)

Cloudlog Desktop can tell you about new releases and, for AppImage installations, install them. Everything is in
`src/main/updater/` (main process; the renderer only shows state in Settings > Updates).

## Discovery

* Source: the repository's GitHub Releases **REST API** (`GET /repos/<owner>/<repo>/releases`), unauthenticated, no
  token or secret in the app. The HTML releases page is never scraped.
* Versions come from release **tags** (`vYYMM.RELEASE.PATCH[-STAGE.NUMBER]`, see VERSIONING.md), never from asset file names.
  Asset names are only used to choose the file for this OS/CPU (`..._<arch>.AppImage`) and to find its checksum.
* Drafts are ignored. All pages are read (the API orders by date, not version, so the first result is not necessarily the
  newest; capped at 10 pages) and the **newest eligible** version is selected with CalVer/SemVer ordering
  (`alpha < beta < rc < stable`, numeric per component). A version that is not newer than the running one is never offered
  (no downgrade, no reinstall).
* Failures (offline, timeout after 15 s, HTTP errors, rate limit, malformed JSON) become a status message, never a crash.

## Supported tag formats and channels

| Tag | Channel |
| --- | --- |
| `v2610.1.0` | stable (GitHub release **not** marked prerelease) |
| `v2610.1.0-rc.1` | release candidate (marked prerelease) |
| `v2610.1.0-beta.2` | beta (marked prerelease) |
| `v2610.1.0-alpha.3` | alpha (marked prerelease) |

GitHub's prerelease flag cannot tell the stages apart, so the **tag decides the stage**. A release is excluded (and listed
under "N GitHub releases ignored by the updater" on the Updates page) when its tag is not in a supported format (for
example `v0.4.4` or `v2610.1.0-gamma.1`) or when the flag contradicts the tag (a stable tag marked prerelease, or a
staged tag not marked prerelease). Such releases are never treated as stable, beta or rc, and never installed.
The release workflow already produces exactly these tags and flags (`plan.js`), so no workflow change was needed for classification.

## Settings

Saved in `settings.json` under `updates`; a key that was never saved has an install-dependent default.

| Setting | Default |
| --- | --- |
| Auto check update (master switch) | on |
| Allow pre-release updates | off for stable; on for rc, beta, alpha installs |
| Allow beta updates | on for beta and alpha installs, otherwise off |
| Allow alpha updates | on for alpha installs, otherwise off |
| Auto-update (AppImage only) | off |

Eligibility: pre-release OFF = stable only. ON = stable + rc. ON + beta = + beta. ON + alpha = + alpha (alpha forces beta ON).
Always stable is eligible, so a pre-release install can receive a newer stable. Dependencies are applied in one atomic
write: alpha ON turns beta ON, beta OFF turns alpha OFF, alpha OFF leaves beta. Turning pre-release OFF only makes
beta/alpha ineffective (their values are kept). A saved alpha ON / beta OFF is repaired and re-saved when loaded.
Defaults are never written over saved values (including after an update changes the installed channel).

**Auto check update** is the master switch: when off there are no automatic or manual checks, downloads or installs and the
related controls are disabled with an explanation; nothing else is changed. The last discovered version and its release link
stay visible (opening the link in a browser is always possible).

## Startup check

One automatic check per launch, delayed a few seconds and asynchronous. Connectivity is a trigger, not a gate: a failed
attempt leaves the check *pending* and it is retried with bounded backoff (5 s, 20 s, 1 min, 3 min, 10 min); after that
it only waits for the OS "online" event (a few extra attempts, never polling; 12 attempts in total per launch). Final
errors (rate limit, malformed reply, 4xx) end it. Once completed nothing recurs. Manual checks are separate and share a
single-flight with it (never two requests at once). A pending check parked by the master switch resumes when it is turned
on and has not completed.

## Installation types

Only a verified **AppImage** self-updates: `APPIMAGE` and `APPDIR` are set, the process runs from inside `APPDIR`,
`APPIMAGE` (symlinks resolved) is a regular file with the ELF + AppImage magic, the CPU architecture has a published AppImage,
and the file can be replaced by this user (writable folder, owned by this user). Debian/other packages and development runs only
notify and link to the release page. No package manager is ever run.

## Checksums and replacement

Releases publish `<asset>.sha256` (SHA-256, `sha256sum` format `<hex>  <asset name>`) for every package. Installing:

1. read the checksum first (missing, empty, malformed, for another file, or ambiguous = stop);
2. check free space, download into a temp file **in the same folder** as the installed AppImage (never over it);
3. re-read the whole file and compare SHA-256; mismatch = delete, stop;
4. re-validate settings/eligibility (disabled channel, master switch, skip for automatic installs);
5. critical step (not cancellable): hard-link (or copy) the current file to a backup, `rename()` the new file over the
   installed path (atomic, same name and location, original permissions kept, executable), check the result and roll back
   from the backup if it fails; then remove temp and backup. If the rollback itself fails the backup is kept and named in the error.

Symlinks: the real file is replaced and the link stays a link; if the resolved path changes during the download nothing is
replaced. No privileges are requested: an unwritable location is reported with the release link. Temp files are removed after
success, failure and cancellation. The app is not restarted for you: "Restart now" uses the normal quit path.

> A checksum published next to a download gives **integrity** (corruption, truncation, wrong asset). It is **not independent
> publisher authentication**: whoever can replace the release asset can replace the checksum file as well. Signatures
> (for example a pinned public key) would be needed for that.

## Skipping

"Skip this version" is saved by version. It silences notifications and automatic installation for that version only; the
version stays listed (labelled *Skipped*) until a newer eligible release appears. A manual check always reports it, and the
Update button stays available for an AppImage install. A release that is no longer eligible under the channel settings stays
visible but is labelled *outside the enabled update channels* and cannot be installed.
