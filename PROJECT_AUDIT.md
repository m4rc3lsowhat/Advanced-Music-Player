# Project audit

Audit date: 2026-07-13

This review used 54 focused passes across the Electron main process, preload bridge, React UI,
provider gateways, playback adapters, queue engine, local files, persistence, Daily Mixes, radio,
downloads, authentication, release automation, dependencies, tests, and Git history.

## History and repository state

- The visible branch history starts at the rewritten `8b07d31` root commit from 2026-06-12 and
  ends at the v0.3.2 work from 2026-07-08 before this audit branch.
- Older pre-rewrite objects and local stashes still exist in this clone. They are not connected to
  the current branch and are not included by a normal branch push.
- Pattern scans across reachable commits, local refs, stashes, and dangling history found no actual
  OAuth tokens, private keys, or committed `.env` files.
- Current reachable commits use the repository owner's no-reply address and contain no third-party
  co-author trailers.
- Local installer archives remain only in stashes/build folders and are excluded from this change.

## Changes made

### Desktop security and credentials

- Enabled renderer sandboxing and added trusted-frame checks to privileged IPC handlers.
- Removed the raw-key/node-widevine fallback and its device-extraction script.
- Stopped bundling the SoundCloud client secret. User-entered secrets now use Electron secure
  storage, migrate out of the legacy plaintext file, and can be cleared in Settings.
- Restricted navigation, popup, external URL, artwork, pagination, and provider URL handling to
  explicit trusted origins.
- Added download size/time limits, atomic writes, safe temporary files, and tighter cookie reads.
- Removed sensitive token logging and capped/redacted the startup log.

### Playback, radio, and mixes

- Added generation guards for overlapping play, auth, library, local-scan, Spotify-device,
  YouTube-frame, and SoundCloud-widget work.
- Fixed queue tail removal, stale pause/seek handling, duplicate Spotify playback, provider teardown,
  widget/frame leaks, and stale playback events.
- Daily Mixes now use the local date, detect library changes while building, avoid cross-provider
  duplicates, and no longer absorb every transient queue item into their seed library.
- Radio scoring no longer admits negative candidates through a raw fallback and preserves the
  intended candidate pool.
- Spotify collections and saved tracks paginate safely; SoundCloud pagination now detects cycles.
- Local music scans resolve real paths, reject symlink escapes, run metadata work concurrently, and
  restart when folder configuration changes mid-scan.

### Front end, persistence, and performance

- Fixed stale search/detail results, playlist mutation races, false import success, modal polling,
  empty-playlist playback, selection state, keyboard repeats, and several layout limits.
- Added runtime validation for persisted preferences/configuration and made critical writes report
  failures instead of silently claiming success.
- Made session, cache, artwork, folder, and download writes atomic or serialized.
- Added bounded caches, request coalescing, Spotify rate-limit cooldowns, provider pagination caps,
  and concurrent local metadata parsing.
- Audio-reactive work now handles stale captures and only appears on supported Windows builds.

### Build and release

- Updated vulnerable dependencies and overrides; both full and production dependency audits are
  clean.
- Added pull-request/main CI for frozen install, verification, and dependency audit.
- Tagged releases now fail without production VMP signing, verify source before packaging, avoid
  duplicate release creation, and never replace an already-published asset.
- Removed production bundling of renderer/build-only dependencies and narrowed the packaged runtime
  dependency set.
- Added a real tracked `.gitignore` and normalized repository text attributes.

## Validation

- `corepack pnpm verify` passes: queue contracts, feature checks, mix composition, playback guards,
  captcha parsing, remote-like behavior, TypeScript, renderer build, main build, and preload build.
- `corepack pnpm audit` and `corepack pnpm audit --prod` report no known vulnerabilities.
- An unsigned local installer build completes with `AMP_SKIP_VMP=1`; this is a packaging test only,
  and the tagged release workflow rejects that mode.
- The packaged `win-unpacked/AMP.exe` reaches `createMainWindow:bridge-detected:yes` with the sandboxed
  preload and exits cleanly after the bounded smoke test.
- The generated bundled configuration contains only the configured Spotify client ID key and no
  SoundCloud client secret.

## Remaining work

1. Isolate remote Spotify/SoundCloud scripts from the privileged renderer and remove
   `webSecurity: false`. This is the largest remaining security architecture item.
2. Add automated Electron/UI smoke coverage plus direct tests for IPC authorization, session files,
   local scans, cache persistence, Zustand races, and per-track like mutation ordering.
3. Split the large `App.tsx` route bundle. The current main renderer chunk is about 642 kB minified;
   the separately loaded HLS chunk is about 509 kB.
4. Move growing library/membership/stat snapshots out of localStorage into a versioned indexed or
   database-backed store.
5. Correct the descriptions on existing GitHub releases: published v0.1.0-v0.3.2 installers skipped
   VMP signing even though several release descriptions say otherwise. Do not replace those assets;
   publish a new signed version. Remove the orphan duplicate v0.3.0 draft after confirming it is not
   needed.
6. Decide the repository license and add a security policy, contribution guidance, branch rules,
   secret scanning/push protection, and Dependabot security updates.
7. Finish macOS/Linux support or keep public launcher documentation explicitly Windows/macOS-only.

The first item requires a provider-integration redesign. The release-history corrections and
repository policy choices require maintainer decisions, so they were not changed automatically.
