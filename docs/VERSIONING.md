# Versioning policy (CalVer)

Cloudlog Desktop uses **CalVer** with **SemVer-compatible syntax**. The first component identifies a
calendar release line, **not** an API compatibility boundary.

    YYMM.RELEASE.PATCH[-STAGE.NUMBER]          e.g.  2610.1.2-beta.3

| Component | Meaning |
|---|---|
| `YY` | last two digits of the release line's target year |
| `MM` | two-digit target month, 01-12 |
| `RELEASE` | release sequence within that calendar release line, starts at 1 |
| `PATCH` | maintenance revision of that release, starts at 0 |
| `STAGE` | optional prerelease stage: `alpha`, `beta` or `rc` |
| `NUMBER` | prerelease sequence within the stage, starts at 1 |

Numeric components have no leading zeros, except the month inside `YYMM`:
valid `2601.1.0-beta.1`, invalid `2601.01.0-beta.01`.

## Stages

| Stage | Use |
|---|---|
| `alpha` | early testing; functionality may be incomplete or change substantially |
| `beta` | broader testing of the intended release functionality |
| `rc` | release candidate; becomes stable if no blocking issues are found |
| (none) | stable release |

    2610.1.0-alpha.1 < 2610.1.0-alpha.2 < 2610.1.0-beta.1 < 2610.1.0-beta.2 < 2610.1.0-rc.1 < 2610.1.0

Stages may be skipped. Ordering is SemVer's: numeric per component, `alpha < beta < rc < stable`
(so `2610.1.9 < 2610.1.10` and `beta.9 < beta.10`).

## One version, everywhere

The canonical version lives **only** in `package.json` (and `package-lock.json`); change it with
`npm version <version> --no-git-tag-version` (valid CalVer strings are valid SemVer, so npm accepts them) in a normal
commit/PR. It identifies the Git tag (`v<version>`), the application (`app.getVersion()`, About page), the release
page and the AppImage / package file names. Nothing else hard-codes it.

Native package versions are **derived at packaging time**, never maintained by hand
(`.github/scripts/release/platform-versions.js`; `node .github/scripts/release/platform-versions.js 2610.1.0-beta.2`):

| Field | Beta `2610.1.0-beta.2` | Stable `2610.1.0` |
|---|---|---|
| Canonical version / AppImage identity | `2610.1.0-beta.2` | `2610.1.0` |
| Git tag | `v2610.1.0-beta.2` | `v2610.1.0` |
| DEB Version | `2610.1.0~beta.2-1` | `2610.1.0-1` |
| RPM Version / Release | `2610.1.0~beta.2` / `1` | `2610.1.0` / `1` |
| Windows numeric file version | `2610.1.0.2002` | `2610.1.0.9000` |
| macOS short version / build version | `2610.1.0` / `2002` | `2610.1.0` / `9000` |

* **File names:** native packages use their platform's canonical name, so the `~` appears where the platform
  requires it: `cloudlog-desktop_2610.1.0~beta.2-1_amd64.deb` (`<name>_<version>-<revision>_<arch>.deb`; a future RPM
  would be `<name>-<version>-<release>.<arch>.rpm`). The AppImage keeps the canonical version:
  `cloudlog-desktop_2610.1.0-beta.2_x86_64.AppImage`. Staging renames the electron-builder `.deb` output accordingly.
* **GitHub limitation:** GitHub Releases rewrites `~` to `.` in asset *names*, so the downloaded `.deb` from the release
  page is named `cloudlog-desktop_2610.1.0.beta.2-1_amd64.deb`. The release page keeps the `~` name as the asset
  *label* and in the notes' link text; the links point at the stored names. The package's internal `Version` is
  always the correct `2610.1.0~beta.2-1`, and `dpkg -i`/`apt install ./file.deb` do not depend on the file name.
  Rename it back to the `~` form if a tool (e.g. an apt repository builder) expects the canonical name.
* `~` makes the prerelease sort **below** the stable version in dpkg/rpm. electron-builder already converts `-` to `~`
  for deb/rpm; `package.json` adds `--iteration=1` (the Debian revision) for deb, and the release build fails if the
  built `.deb` `Version` field differs from the derived value.
* The numeric build value (Windows 4th component, macOS build) is `1000+N` for alpha.N, `2000+N` for beta.N,
  `3000+N` for rc.N and `9000` for stable (N <= 999). This is a project choice that keeps the stages ordered within
  one `YYMM.RELEASE.PATCH`; the change point is `STAGE_BUILD_BASE` in `platform-versions.js`.
