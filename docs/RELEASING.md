# Releasing (GitHub Actions)

Releases are published automatically by `.github/workflows/release.yml`. Nobody commits version bumps,
creates tags, or runs `npm version` for this: **change `version` in `package.json` (and `package-lock.json`)
in a normal commit/PR, merge to `master`, and the workflow does the rest.**

## Trigger and gate

1. A push to `master` (including a merged pull request) runs the checks workflow (`Node.js CI`,
   `.github/workflows/node.js.yml`; matched by its `name:` field).
2. `release.yml` starts via `workflow_run` only if that run **succeeded**, was a **push** (never a
   pull-request run), on **master**, in **this repository** (never a fork).
3. The *plan* job checks out the exact commit that passed (`head_sha`, not the tip of master), reads
   `package.json` at that commit and compares the version with the highest existing version tag.
   If it is not higher, or the tag exists, the workflow stops successfully.
4. The *build* jobs (one per package type, in parallel, `fail-fast`) build that same commit with
   `npm install` + `npm run dist:<type> -- --publish never`. A failed build means no tag, no release.
5. Only after **all** builds succeed does the *publish* job (the only job with `contents: write`) recheck
   the remote tags, create the tag on the checked commit, create a **draft** release, upload the
   packages, verify the asset count, and then publish the release.

## Versions

The version scheme is CalVer, `YYMM.RELEASE.PATCH[-STAGE.NUMBER]` (see [VERSIONING.md](VERSIONING.md)).

| Version | Meaning | Tag | GitHub release |
|---|---|---|---|
| `2610.1.0` | stable | `v2610.1.0` | normal release (marked latest) |
| `2610.1.0-alpha.1`, `-beta.2`, `-rc.1` | prerelease | `v2610.1.0-beta.2` | **prerelease**, never marked latest |

Ordering: `2610.1.0-alpha.1 < ... < -beta.1 < ... < -rc.1 < 2610.1.0 < 2610.1.1-beta.1 < 2610.2.0 < 2611.1.0-beta.1`
(numeric per component, so `2610.1.9 < 2610.1.10`).

The candidate is compared with the **highest existing version tag** (all stages), not with the parent commit, so a
version bump followed by more commits in the same push is still released. Tags that are not exactly
`v<canonical version>` (for example the old `v0.4.x` tags) are ignored. An unchanged or lower version, or an
existing tag, is a clean skip; a malformed version fails the plan job with a clear message. Tags are never moved,
overwritten or deleted.

**Migration:** `package.json` must hold a CalVer version before the first release. While it still has the old
`0.x.y` form the plan job fails with the validation message above (nothing is built or published).

Native package versions are derived from the canonical version (DEB `2610.1.0~beta.2-1`, ...); see VERSIONING.md.

## Where to change things

* **Node.js version** and **package types / runners**: `.github/release-config.json` only.
  * `nodeVersion` - e.g. `"26.x"`.
  * `packageTypes` - `type` runs `npm run dist:<type>` (add the script to `package.json` too),
    `runner` is the GitHub runner that builds it, `extensions` are the output files to publish.
    Example for later: `{ "type": "exe", "runner": "windows-latest", "extensions": [".exe"] }`.
    Windows/macOS builds need their own runner (and possibly signing secrets); Linux packages build on Linux.
* `verify: "deb"` on a package type makes staging compare the built `.deb` Version field with the derived version.
* Output directory: read from `package.json` -> `build.directories.output` (currently `dist`).

## Downloads

Packages (AppImage, .deb) are release assets on the GitHub **Releases** page, and the release notes link
each of them (the `.deb` shown with its canonical `~` name, see VERSIONING.md for GitHub's `~` to `.` rewrite) plus the auto-generated source tarball
`https://github.com/<owner>/<repo>/archive/refs/tags/<tag>.tar.gz` for the exact tagged commit.
Actions artifacts are only used internally to pass files from build jobs to the publish job (30 days).

## Safety and recovery

* Tag existence (and any higher version tag) is rechecked in the publish job right before tagging.
  If another run creates the same tag first, tag creation fails, the tag is found to exist, and this run
  skips cleanly. Any other failure (permissions, network) fails the run.
* Concurrent runs for the same tag are serialized (`concurrency: release-<tag>`, never cancelled).
* The release is created as a **draft** and only published after all assets are uploaded.
* **Recovery** if the tag exists but the release/upload failed: do *not* delete or move the tag. Open the failed
  run: the draft release (if created) is visible only to maintainers, and the packages are in the run's
  `packages-*` artifacts (30 days). Finish by hand, e.g.
  `gh release upload vX.Y.Z <files>` then `gh release edit vX.Y.Z --draft=false` (or
  `gh release create vX.Y.Z --verify-tag --notes-file ... <files>` if no draft exists). Re-running the
  workflow will skip, because the tag already exists.
* The workflow never commits, pushes branches, runs `npm version`, or publishes to npm.

## Repository settings required

* Settings -> Actions -> General -> Workflow permissions: the default token may stay read-only; the publish job
  requests `contents: write` itself. Actions must be allowed to run workflows (no extra secrets needed).
* If tag protection rules / rulesets restrict creating `v*` tags, allow `github-actions[bot]` to create them.
* `workflow_run` workflows execute from the default branch, so `release.yml` must be on `master`.
