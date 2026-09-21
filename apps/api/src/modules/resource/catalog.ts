/**
 * Catalog snapshots: what the control plane publishes after every committed
 * change and what the edge reads instead of the database. A snapshot is a
 * set of immutable documents under `_catalog/<version>/` plus one pointer,
 * written last, so a reader never sees half a snapshot.
 *
 * Public documents live in the public store (and are therefore also readable
 * on the download host, which is fine: they list what listings show anyway).
 * A protected namespace's shard lives in its own store.
 */
import type { CachePolicy } from "./cache-policy";
import { objectKey } from "./paths";

export const CATALOG_SCHEMA = "mica-res/catalog/v1";
export const CATALOG_POINTER_SCHEMA = "mica-res/catalog-pointer/v1";
export const SHARD_SCHEMA = "mica-res/catalog-namespace/v1";
export const CATALOG_POINTER_KEY = "_catalog/current.json";

export type Visibility = "public" | "protected";

export interface CatalogPointer {
  readonly schema: typeof CATALOG_POINTER_SCHEMA;
  readonly version: string;
  readonly manifest: string;
}

export interface CatalogSite {
  readonly title: string;
  readonly description: string;
  /** Base URL of the public download host. */
  readonly download: string;
  readonly s3: string;
  readonly home: string;
}

export interface CatalogNamespace {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly visibility: Visibility;
  /** Binding of the store holding the bytes and the shard. */
  readonly store: string;
  readonly listable: boolean;
  readonly immutable: boolean;
  readonly siteMode: boolean;
  readonly cachePolicy: CachePolicy;
  /** Null for a protected namespace: the home page does not count its content. */
  readonly objects: number | null;
  readonly bytes: number | null;
  readonly examples: readonly string[];
  readonly shard: string;
}

export interface CatalogManifest {
  readonly schema: typeof CATALOG_SCHEMA;
  readonly version: string;
  readonly publishedAt: string;
  readonly site: CatalogSite;
  readonly namespaces: readonly CatalogNamespace[];
  /** repository -> tag -> `sha256:<hex>` */
  readonly registry: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Public store key of the digest index. */
  readonly digests: string;
}

export interface CatalogObject {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType: string;
  readonly publishedAt: string;
}

export interface NamespaceShard {
  readonly schema: typeof SHARD_SCHEMA;
  readonly version: string;
  readonly name: string;
  /** Sorted by path, so listings are a range search. */
  readonly objects: readonly CatalogObject[];
  /** alias path -> target path, both inside the namespace. */
  readonly aliases: Readonly<Record<string, string>>;
}

export interface CatalogFile {
  readonly store: string;
  readonly key: string;
  readonly text: string;
}

export interface CatalogInput {
  readonly version: string;
  readonly publishedAt: string;
  readonly site: CatalogSite;
  readonly publicStore: string;
  readonly namespaces: ReadonlyArray<{
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly visibility: Visibility;
    readonly store: string;
    readonly listable: boolean;
    readonly immutable: boolean;
    readonly siteMode: boolean;
    readonly cachePolicy: CachePolicy;
    readonly examples: readonly string[];
  }>;
  /** Live objects only (not soft-deleted). */
  readonly objects: ReadonlyArray<CatalogObject & { readonly namespace: string }>;
  readonly aliases: ReadonlyArray<{ readonly namespace: string; readonly path: string; readonly targetPath: string }>;
  readonly ociTags: ReadonlyArray<{ readonly repository: string; readonly tag: string; readonly digest: string }>;
}

function render(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function buildCatalog(input: CatalogInput): { pointer: CatalogPointer; manifest: CatalogManifest; files: CatalogFile[] } {
  const base = `_catalog/${input.version}`;
  const files: CatalogFile[] = [];
  const byNamespace = new Map<string, CatalogObject[]>();
  for (const o of input.objects) {
    const { namespace, ...object } = o;
    (byNamespace.get(namespace) ?? byNamespace.set(namespace, []).get(namespace)!).push(object);
  }

  const visibilityOf = new Map(input.namespaces.map(n => [n.name, n.visibility]));
  const namespaces: CatalogNamespace[] = [...input.namespaces]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((n) => {
      const objects = (byNamespace.get(n.name) ?? []).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const aliases: Record<string, string> = {};
      for (const a of input.aliases.filter(a => a.namespace === n.name).toSorted((a, b) => (a.path < b.path ? -1 : 1)))
        aliases[a.path] = a.targetPath;
      const shard: NamespaceShard = { schema: SHARD_SCHEMA, version: input.version, name: n.name, objects, aliases };
      const shardKey = `${base}/ns/${n.name}.json`;
      files.push({ store: n.store, key: shardKey, text: render(shard) });
      const isPublic = n.visibility === "public";
      return {
        name: n.name,
        title: n.title,
        description: n.description,
        visibility: n.visibility,
        store: n.store,
        listable: n.listable,
        immutable: n.immutable,
        siteMode: n.siteMode,
        cachePolicy: n.cachePolicy,
        objects: isPublic ? objects.length : null,
        bytes: isPublic ? objects.reduce((sum, o) => sum + o.size, 0) : null,
        examples: isPublic ? n.examples : [],
        shard: shardKey,
      };
    });

  // Only public bytes are reachable by digest: a protected object must never
  // be discoverable through the public index.
  const digests: Record<string, string> = {};
  for (const o of input.objects.toSorted((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1))) {
    if (visibilityOf.get(o.namespace) === "public" && digests[o.sha256] === undefined)
      digests[o.sha256] = objectKey(o.namespace, o.path);
  }
  const registry: Record<string, Record<string, string>> = {};
  for (const t of input.ociTags.toSorted((a, b) => (`${a.repository}:${a.tag}` < `${b.repository}:${b.tag}` ? -1 : 1)))
    (registry[t.repository] ??= {})[t.tag] = t.digest;

  const digestsKey = `${base}/digests.json`;
  files.push({ store: input.publicStore, key: digestsKey, text: render(digests) });

  const manifest: CatalogManifest = {
    schema: CATALOG_SCHEMA,
    version: input.version,
    publishedAt: input.publishedAt,
    site: input.site,
    namespaces,
    registry,
    digests: digestsKey,
  };
  const manifestKey = `${base}/manifest.json`;
  files.push({ store: input.publicStore, key: manifestKey, text: render(manifest) });
  return { pointer: { schema: CATALOG_POINTER_SCHEMA, version: input.version, manifest: manifestKey }, manifest, files };
}

/** Binary search for the first object whose path is >= `from`. */
export function lowerBound(objects: readonly CatalogObject[], from: string): number {
  let lo = 0;
  let hi = objects.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (objects[mid]!.path < from)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}

export function findObject(shard: NamespaceShard, path: string): CatalogObject | undefined {
  const i = lowerBound(shard.objects, path);
  const hit = shard.objects[i];
  return hit?.path === path ? hit : undefined;
}

export interface Listing {
  readonly prefix: string;
  readonly directories: string[];
  readonly objects: CatalogObject[];
  /** The last key considered, when more remain. */
  readonly next: string | undefined;
}

/**
 * S3-style listing: everything under `prefix`, rolled up at `delimiter`,
 * starting strictly after `after`, at most `limit` entries (objects and
 * directories together).
 */
export function listShard(shard: NamespaceShard, opts: { prefix: string; delimiter?: string | undefined; after?: string | undefined; limit: number }): Listing {
  const all = shard.objects;
  const directories: string[] = [];
  const objects: CatalogObject[] = [];
  let i = lowerBound(all, opts.prefix);
  if (opts.after !== undefined && opts.after >= opts.prefix) {
    i = Math.max(i, lowerBound(all, `${opts.after}\u0000`));
    // Resuming after a rolled-up directory skips everything inside it.
    if (opts.delimiter && opts.after.endsWith(opts.delimiter))
      i = Math.max(i, lowerBound(all, `${opts.after}\uFFFF`));
  }
  let last: string | undefined;
  let next: string | undefined;
  for (; i < all.length; i++) {
    const object = all[i]!;
    if (!object.path.startsWith(opts.prefix))
      break;
    if (directories.length + objects.length >= opts.limit) {
      next = last;
      break;
    }
    const rest = object.path.slice(opts.prefix.length);
    const cut = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
    if (cut >= 0) {
      const directory = opts.prefix + rest.slice(0, cut + opts.delimiter!.length);
      directories.push(directory);
      last = directory;
      i = lowerBound(all, `${directory}\uFFFF`) - 1;
      continue;
    }
    objects.push(object);
    last = object.path;
  }
  return { prefix: opts.prefix, directories, objects, next };
}
