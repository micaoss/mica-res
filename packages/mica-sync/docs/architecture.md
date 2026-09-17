# mica-res - Mirror architecture

> **2026-09-17:** the service this document describes (a single Worker in front
> of a private bucket, content-addressed `blob/` keys, a JSON index, `/w/*`
> write routes) is superseded by the resource service in `apps/` -- see
> `docs/modules/resource.md`. The CLI in `src/` now publishes through the
> control plane; the Worker was removed (it remains in git history), and the
> v1 index under `index/` stays in the bucket, frozen, for the import and the
> `/index/` redirects. The trust model and the scope below still hold.

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

## Reachability, as measured on 2026-09-16

The mirror is proven to serve CI: every upload, the contract gate and the
presence read-back run from GitHub runners against `res.micaos.dev`. **It is
not currently usable from the development network**: the zone's addresses
(`188.114.96.5`, `188.114.97.5`, `2a06:98c1:3120::5`) resolve but do not
route from here or from the workstation -- IPv4 times out, IPv6 has no route,
the `micaos.dev` apex behaves the same, and `www.cloudflare.com` and
`mica-res.cfaa.workers.dev` answer from the same hosts. So it is those
addresses, not Cloudflare, not the Worker and not the bucket.

Until that is measured again, **nothing here claims that a local offline build
fetches from the mirror**. The `workers.dev` hostname is deliberately not used
as a way round it: that would trade a routing problem for a permanent second
name.

## Scope

In: third-party Debian archives, sha256-pinned source tarballs, the build-env
images, mica-build's product images and update archives, and (phase 3) the
vendor git trees as depth-1 packfiles.

Out: our package pools, mica-boards board components, release locks and
`SHA256SUMS`, the 21 upstream docker.io images (they are inside the build-env
images), and the device update service.
