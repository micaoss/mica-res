# Mirror URL migration: move to the new resource service URLs

- **From**: mica-res
- **To**: mica-system-base, mica-boards, mica-build, mica
- **Date**: 2026-09-18
- **Action required**: yes -- update to the URLs below. The legacy `/d/...`
  and `/index/...` paths on `res.micaos.dev` will be removed once all four
  changes have landed, and not before 2026-10-02.

## What changed

`res.micaos.dev` has been rebuilt as the Mica OS resource service
(`mica-res/docs/modules/resource.md`). Public files are now served
**directly by R2** on a download host, under readable keys:

| Host | Serves |
| --- | --- |
| `https://dl.res.micaos.dev` | Public files, `<namespace>/<path>`. Served by R2 itself: range requests, ETag, CDN caching. |
| `https://res.micaos.dev` | Directory listings (`/<namespace>/<dir>/`, JSON with `Accept: application/json`), `/blob/<aa>/<sha256>` lookup, `/v2` registry, admin console. |
| `https://s3.res.micaos.dev` | S3 read API, path-style, bucket = namespace. |

The keys are the old readable names without the `/d/` prefix:

| Old URL (legacy) | New URL |
| --- | --- |
| `https://res.micaos.dev/d/upstream/debian/pool/<tail>` | `https://dl.res.micaos.dev/upstream/debian/pool/<tail>` |
| `https://res.micaos.dev/d/upstream/source/<name>/<file>` | `https://dl.res.micaos.dev/upstream/source/<name>/<file>` |
| `https://res.micaos.dev/d/upstream/git/<name>/<commit>.json` and `.pack.NN` | `https://dl.res.micaos.dev/upstream/git/<name>/<commit>.json` and `.pack.NN` |
| `https://res.micaos.dev/d/mica/<scope>/<stamp>/<file>` | `https://dl.res.micaos.dev/mica/<scope>/<stamp>/<file>` |
| `https://res.micaos.dev/index/...` (v1 index) | none -- the v1 index is frozen and will not be updated |

**Unchanged and staying:**

- `https://res.micaos.dev/blob/<sha256[0:2]>/<sha256>` -- lookup by digest,
  answered with a redirect to the file on `dl.res.micaos.dev`. Use it when
  all you have is the sha256.
- `res.micaos.dev/micaoss/mica-build-env@sha256:...` -- the read-only
  registry (`docker pull`), manifests and tags as before, layers redirected
  to the download host.

**Unchanged rules:** the mirror is a source, never a trust anchor. Verify
every byte against your own sha256 pin (or, for a git pack, against the
pinned commit), refuse wrong bytes, and fall back to upstream when the mirror
does not answer. Every new URL is a redirect or a direct file; clients must
follow redirects (`curl -L`), which all current hooks already do.

## Required changes

### mica-system-base

Configuration only.

- `.github/workflows/build.yml:101`: change

  ```yaml
  MICA_BASE_MIRROR: pool:https://res.micaos.dev/d/upstream/debian
  ```

  to

  ```yaml
  MICA_BASE_MIRROR: pool:https://dl.res.micaos.dev/upstream/debian
  ```

  `src/cache.ts mirrorUrl` turns this into
  `https://dl.res.micaos.dev/upstream/debian/pool/<tail>`, which is the key of
  every mirrored Debian archive. No code change.

### mica-boards

Keep `MICA_MIRROR=https://res.micaos.dev` (repository variable used by
`.github/workflows/build.yml`): archives are looked up by digest, which only
this host answers.

- `common/scripts/fetch-source.sh:65`: drop the `d/` prefix of the git pack
  path:

  ```bash
  local prefix="upstream/git/${NAME}/${COMMIT}" manifest plan pack chunk want got i=0 count
  ```

  `res.micaos.dev/upstream/git/...` redirects to the file on the download
  host; `mirror_get` already follows redirects (`curl -fsSL`).
- `common/scripts/fetch-archive.sh:23` (`blob/${SHA:0:2}/${SHA}`): no change.
- Update any comment or test that spells `d/upstream/git`.

### mica-build

- `mirrors.list`: change the base to

  ```text
  https://dl.res.micaos.dev
  ```

- `tools/release-index.py:49` (`mirrors_of`): derive
  `f'{base}/mica/{scope}/{stamp}/{file}'` instead of
  `f'{base}/d/mica/{scope}/{stamp}/{file}'`, and update the docstring at
  lines 19-20.
- Tests that pin the derived URL: `tests/release-test.sh` (the
  `https://res.micaos.dev/d/mica/...` expectations around lines 347, 489,
  497, 502) and the fixtures under `tests/release-lock/vectors/` and
  `tests/rootfs-runtime/` that contain `d/mica`.
- Already-published `mica-index.json` files keep their old mirror URLs. That
  is expected: once `/d/` is removed those mirrors stop answering, and a
  reader falls back to the release's own `url` exactly as for any pruned
  mirror. Nothing needs to be republished.

### mica

- `docs/design/mica-index.md` (section 3.1, around lines 95-113): the
  derivation becomes `<base>/mica/<scope>/<stamp>/<file>` with the base
  `https://dl.res.micaos.dev`, and the paragraph describing
  `res.micaos.dev` should say that public files are served from
  `dl.res.micaos.dev`.

## How to check a change

After the v1 import on mica-res has run (mica-res will announce it), every
key above answers. Spot checks:

```bash
# A Debian archive, straight from R2
curl -fsSI https://dl.res.micaos.dev/upstream/debian/pool/main/b/bash/<file>.deb

# A git pack manifest through the res host (redirect) and directly
curl -fsSL https://res.micaos.dev/upstream/git/<name>/<commit>.json | head -c 200
curl -fsSI https://dl.res.micaos.dev/upstream/git/<name>/<commit>.json

# A product image
curl -fsSI https://dl.res.micaos.dev/mica/<scope>/<stamp>/<file>

# By digest, as mica-boards does
curl -fsSL -o /dev/null -w '%{url_effective}\n' https://res.micaos.dev/blob/<aa>/<sha256>

# Browse what is there
curl -fsS -H 'accept: application/json' https://res.micaos.dev/upstream/git/
```

A build that runs with the mirror unreachable must still pass: that is the
fallback path, and it is unchanged.

## Timeline

1. mica-res runs the v1 import; until then the new keys and the legacy
   paths both answer 404 and every consumer falls back to upstream.
2. Each repository lands the change above and reports it.
3. When all four have landed, and not before 2026-10-02, mica-res removes
   `/d/...` and `/index/...` from `res.micaos.dev`. `/blob/...` and `/v2`
   stay.

Questions: open an issue on `micaoss/mica-res`.
