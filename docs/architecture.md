# mica-res - Architecture

`mica-res` is the resource service of Mica OS. It holds no build output of its
own: it mirrors what a build consumes and republishes what a release produced,
so that an offline local build needs one host instead of a dozen.

## Parts

- `src/` -- the Bun CLI: read the producers' locks, enumerate the in-scope
  objects, upload the missing ones through the Worker, write the index, render
  the site.
- `worker/` -- the only public surface of the bucket: read routes, the
  content-addressed write endpoint, the cache policy.
- `mica/brand/` -- the brand assets, the one thing this repository stores in
  git.
- `docs/` -- task, plan, changelog.

## Bucket

```text
blob/<sha256[0:2]>/<sha256>   every byte string, uploaded once
index/<YYYYMMDD-HHMM>.json    immutable snapshot
index/current.json            the one pointer
site/...                      generated static pages
```

The bucket is private. Readable download paths are Worker routes resolved
through the index, so a byte is stored once however many names it has.

## Trust

The mirror is a source, never a trust anchor. Every object it serves is
already pinned by sha256 in a consumer's own `locks/`, or, for a git tree, by
its commit; the consumer verifies against its own lock and falls back to
upstream when the mirror does not answer. Wrong bytes are a refusal, never a
fallback. Nothing in a build reads this repository's index to decide trust.

Writes are content-addressed: the write endpoint refuses a key that is not the
body's sha256 and refuses different bytes under an existing key, and there is
no delete route. A leaked write token can add an unreferenced blob and nothing
else.

## Scope

In: third-party Debian archives, sha256-pinned source tarballs, the build-env
images, mica-build's product images and update archives, and (phase 3) the
vendor git trees as depth-1 packfiles.

Out: our package pools, mica-boards board components, release locks and
`SHA256SUMS`, the 21 upstream docker.io images (they are inside the build-env
images), and the device update service.
