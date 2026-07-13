# Widevine playback — production VMP signing (SoundCloud DRM tracks)

This is the runbook for getting **Widevine-gated SoundCloud tracks** (e.g. major-label
tracks like *Pop — Osamason* `1685274354`) to play **natively inside AMP**.

## TL;DR

Those tracks already play for this account in Chrome/Brave/Edge. They fail in AMP with
**HTTP 403** on the license POST because the castLabs Electron build ships a **development
VMP signature**, and SoundCloud's KeyOS license server rejects development-signed clients.

The fix is the official, Google-sanctioned path: stamp the **packaged** app with a
**production VMP signature** from castLabs' free **EVS** service. This is *not* DRM
circumvention — the content is still only ever decrypted inside the Widevine CDM. It's the
same mechanism TIDAL Hi-Fi, soundcloud-rpc, and BetterSoundCloud use.

> **Important:** VMP signatures only exist on **packaged** builds. `pnpm dev` /
> `electron .` run unsigned and will **still 403** on DRM tracks. You must test against a
> packaged build (`pnpm --filter @amp/desktop dist`).

---

## One-time setup (you run this — it needs your email)

The EVS account step is interactive (email verification), so it can't be automated. From a
shell with Python 3 available:

```bash
pip install --upgrade castlabs-evs
python -m castlabs_evs.account signup      # then click the verification link in your email
```

If you already have an account, refresh the session instead:

```bash
python -m castlabs_evs.account reauth
```

Convenience wrappers are wired in `package.json`:

```bash
pnpm --filter @amp/desktop run evs:signup
pnpm --filter @amp/desktop run evs:reauth
```

Requirements:

- **Python 3** on `PATH` (the hook tries `python`, then `python3`, then `py` on Windows;
  override with `AMP_EVS_PYTHON=<path>`).
- The `castlabs-evs` pip package importable as `castlabs_evs`.
- The app must use the castLabs Electron fork (it already does:
  `electron: https://github.com/castlabs/electron-releases#v41.1.1+wvcus`).

---

## Build (signing happens automatically)

```bash
pnpm --filter @amp/desktop dist
```

This runs `electron-builder`, which calls the **`afterPack` hook**
(`scripts/sign-vmp.cjs`). The hook:

1. Skips Linux (no VMP there) and skips entirely if `AMP_SKIP_VMP=1`.
2. Finds a Python interpreter that can `import castlabs_evs`.
3. Runs `python -m castlabs_evs.vmp sign-pkg <packagedAppDir>` **before** the installer is
   assembled, so the signature sidecar files get bundled into the installer.
4. Fails the build loudly if the EVS tool is missing or signing fails (no silent unsigned
   builds), and sanity-checks that `.sig` files were actually written.

---

## Verify it worked

**Static check** (signatures present in the packaged output):

```bash
pnpm --filter @amp/desktop run verify:vmp
# or: node scripts/verify-vmp.mjs <packagedDir>
```

Expect `PASS — N signature file(s) total. Build is VMP-signed.`

**Functional check** (the real acceptance test):

1. Install/launch the **packaged** build (not `pnpm dev`).
2. Play a Widevine-gated track (e.g. `1685274354`).
3. In the startup log (`%TEMP%\spot-cloud-startup.log` on Windows) you should see the
   license POST to `license.media-streaming.soundcloud.cloud` return **200** instead of
   403, and `widevine:components-ready` with a verified status. The track should play.

---

## Escape hatches / env flags

| Variable | Effect |
| --- | --- |
| `AMP_SKIP_VMP=1` | Skip signing — produces an **unsigned** build that will **not** play DRM tracks (dev/CI convenience only). |
| `AMP_EVS_PYTHON=<path>` | Use a specific Python interpreter for the EVS tool. |

---

## Troubleshooting

- **`EVS VMP signing exited with code …`** — usually an expired/missing session. Run
  `python -m castlabs_evs.account reauth` and rebuild.
- **`no .sig signature files were found`** — EVS reported success but signed nothing; the
  build is still development-signed. Re-check that you're signing the castLabs Electron fork.
- **Still 403 after signing** — confirm you launched the **packaged** build, not the dev
  server. If a packaged, verified-VMP build still 403s, the report's secondary hypothesis is
  per-`ClientInfo` filtering; the documented fallback is the browser-handoff path (open the
  track's `permalink_url` in the user's real browser).
- **Linux** — castLabs Linux has no VMP; those builds stay `PLATFORM_UNVERIFIED`. Use the
  browser-handoff fallback for DRM tracks on Linux.

---

## Scope / boundaries

The supported solution is **production VMP signing only** — keys never leave the CDM. Raw-key or
extracted-device-key probes are intentionally not shipped and are outside this path.
