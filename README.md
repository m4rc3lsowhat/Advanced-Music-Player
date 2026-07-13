# AMP — Advanced Music Player

Search Spotify and SoundCloud together, build playlists that mix both, and play it all from one queue. It's a local Electron app — your sessions and listening history stay on your machine.

> Personal project, not a product. It automates what your own browser already does (sign in, read your likes, play what you're entitled to). Staying within Spotify's and SoundCloud's terms is on you; don't redistribute builds.

## Features

- Unified search across Spotify, SoundCloud and YouTube (SoundCloud + YouTube work without signing in)
- Play your own local audio files (mp3, m4a, flac, wav, ogg…) alongside everything else
- One library and playlists that freely mix every source
- Like/save on Spotify and SoundCloud, everywhere — player bar, lists, search, playlists
- Song-seeded radio and daily mixes, scored by tempo / genre / vibe
- Artist and album pages, mood + genre filters, on-device listening stats
- SoundCloud audio downloads for eligible tracks, optional Discord Rich Presence
- Windows audio-reactive gradient (beat-synced)

No crossfade — the Spotify SDK can't do it honestly, so it's left out.

> YouTube plays through YouTube's official embedded player (like YTMDesktop), so it's reliable — but
> that means ads play on a non-Premium account, and the occasional video that disallows embedding is
> skipped. Local files and the other providers are unaffected.

## Download

Grab the latest Windows installer (`AMP Setup x.y.z.exe`) from the
[**Releases** page](https://github.com/alesxxxx/Advanced-Music-Player/releases/latest). Current
published installers were built without VMP signing, so they cannot play encrypted SoundCloud
tracks. Future tagged builds are blocked unless signing and signature verification succeed.

## Run it

```bash
corepack pnpm install
corepack pnpm dev
```

Bring your own API credentials: a Spotify client ID (redirect URI
`http://127.0.0.1:8000/spotify/callback`) and, optionally, a SoundCloud client ID and secret
(callback `musync://soundcloud/callback`). Add them in Settings or provide the matching environment
variables.

## Build a packaged app

```bash
corepack pnpm --filter @amp/desktop dist
```

Builds the Windows installer. Encrypted SoundCloud tracks only play from a **packaged, VMP-signed** build, never from `pnpm dev` — see [`apps/desktop/DRM-SIGNING.md`](apps/desktop/DRM-SIGNING.md). Cutting a release via CI is documented in [`RELEASING.md`](RELEASING.md).

## Notes

- Spotify playback needs Premium (library import doesn't).
- SoundCloud signs in through your own browser — no API key needed to search or play.

## Privacy

Provider sessions, playlists, listening history, and preferences are stored on this device. The
optional SoundCloud Local Connect flow reads SoundCloud cookies from the browser profile you select
and may briefly start an isolated browser copy to decrypt them; those cookies are not sent to an AMP
server. Music-provider requests still go to the selected provider, and Discord presence is sent only
when you enable it. Sessions can be cleared from Settings.

## Layout

- `apps/desktop` — the Electron app (`electron/` main process, `src/` React renderer)
- `packages/core` — shared models and the cross-provider queue engine
