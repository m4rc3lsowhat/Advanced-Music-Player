# Releasing AMP

The `Release` workflow builds the Windows installer. A version tag creates a draft GitHub release;
a manual run uploads an installer artifact without creating a release.

## Requirements

Tagged releases require these repository secrets:

| Secret | Purpose |
| --- | --- |
| `EVS_ACCOUNT_NAME` | castLabs EVS account used for VMP signing. |
| `EVS_PASSWD` | castLabs EVS password used for non-interactive authentication. |

These client IDs are optional. If omitted, users can configure their own in the app:

- `SPOTIFY_CLIENT_ID`
- `SOUNDCLOUD_CLIENT_ID`
- `DISCORD_CLIENT_ID`

The workflow-provided `GITHUB_TOKEN` creates or repairs the draft release. Tagged builds fail when
VMP credentials are unavailable, while manual test builds may remain unsigned.

EVS signup requires email verification and must be completed once on your own machine. See
`apps/desktop/DRM-SIGNING.md` for setup and verification.

## Cut a release

1. Update the version in both `package.json` and `apps/desktop/package.json`.
2. Run `corepack pnpm verify` and commit the version change.
3. Tag and push the commit:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Watch the Release workflow in GitHub Actions.
5. Review the draft release and its `AMP Setup X.Y.Z.exe` asset before publishing it.

The workflow rejects a tag that does not match the desktop package version. Per-tag concurrency
prevents duplicate runs, and reruns replace the installer only while the release remains a draft.
