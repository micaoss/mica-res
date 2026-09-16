# mica-res

The resource service of Mica OS: the tooling, the index and the site behind
`res.micaos.dev`, so that a local build takes its third-party inputs, the
build-env images and the published product images from one host instead of a
dozen. The artefacts live in R2; this repository holds what produces and
describes them, plus the brand assets.

The mirror is a source, never a trust anchor: every object it serves is already
pinned by sha256 in the repository that consumes it, and a consumer verifies
against its own lock and falls back to upstream. See `docs/architecture.md` for
the bucket layout and the scope, and `docs/plan/` for the phases.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run check` | Lint, typecheck and tests |
| `bun src/cli.ts sync [--sizes]` | Enumerate what the bucket should hold; writes nothing |
| `bun src/cli.ts index --check <file>` | Read an index snapshot |

## mica/brand/logo

| File | Description |
| --- | --- |
| `mica-os-icon.svg` | Icon, 512×512, dark rounded square |
| `mica-os-icon-dark.svg` | Icon without the square, for dark surfaces |
| `mica-os-icon.png` | Icon, 512×512, transparent outside the rounded corners |
| `mica-os-wordmark.svg` | Wordmark, 1394×353, for light surfaces |
| `mica-os-wordmark-dark.svg` | Wordmark, 1394×353, for dark surfaces |
| `mica-os-wordmark.png` | Wordmark, 1394×353, transparent background |
| `mica-os-github-avatar.png` | GitHub organisation avatar, 512×512 |
