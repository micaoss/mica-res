import type { AccessSnapshot } from "@/modules/resource/access/keys";
import type { CatalogManifest, CatalogNamespace, CatalogPointer, NamespaceShard } from "@/modules/resource/catalog";
import type { ResStore } from "@/modules/resource/storage/types";
import { ACCESS_SNAPSHOT_KEY } from "@/modules/resource/access/keys";
import { CATALOG_POINTER_KEY } from "@/modules/resource/catalog";

/** How long an isolate trusts the pointer and the access snapshot before re-reading. */
export const CATALOG_TTL_MS = 30_000;

interface Timed<T> {
  readonly value: T;
  readonly at: number;
}

export interface CatalogReader {
  manifest: () => Promise<CatalogManifest | null>;
  namespace: (name: string) => Promise<CatalogNamespace | undefined>;
  shard: (ns: CatalogNamespace) => Promise<NamespaceShard | null>;
  digests: () => Promise<Readonly<Record<string, string>>>;
  redirects: () => Promise<Readonly<Record<string, string>>>;
  access: () => Promise<AccessSnapshot | null>;
}

/**
 * Reads the published catalog out of the buckets, never the database. The
 * pointer is re-read at most every 30 s; everything it points at is
 * immutable, so it is memoised by key for the life of the isolate.
 */
export function createCatalogReader(opts: {
  readonly store: (binding: string) => ResStore;
  readonly publicBinding: string;
  readonly protectBinding: string;
  readonly now?: () => number;
}): CatalogReader {
  const now = opts.now ?? Date.now;
  let pointer: Timed<CatalogPointer | null> | undefined;
  let access: Timed<AccessSnapshot | null> | undefined;
  const immutable = new Map<string, unknown>();

  async function readJson<T>(binding: string, key: string): Promise<T | null> {
    const text = await opts.store(binding).getText(key);
    return text === null ? null : JSON.parse(text) as T;
  }

  async function memo<T>(binding: string, key: string): Promise<T | null> {
    const cacheKey = `${binding}:${key}`;
    if (immutable.has(cacheKey))
      return immutable.get(cacheKey) as T | null;
    const value = await readJson<T>(binding, key);
    if (value !== null) {
      // Bounded: a long-lived isolate walks through many versions.
      if (immutable.size > 64)
        immutable.clear();
      immutable.set(cacheKey, value);
    }
    return value;
  }

  const manifest = async (): Promise<CatalogManifest | null> => {
    if (!pointer || now() - pointer.at > CATALOG_TTL_MS)
      pointer = { value: await readJson<CatalogPointer>(opts.publicBinding, CATALOG_POINTER_KEY), at: now() };
    return pointer.value ? memo<CatalogManifest>(opts.publicBinding, pointer.value.manifest) : null;
  };

  return {
    manifest,
    async namespace(name) {
      return (await manifest())?.namespaces.find(n => n.name === name);
    },
    shard(ns) {
      return memo<NamespaceShard>(ns.store, ns.shard);
    },
    async digests() {
      const m = await manifest();
      return m ? (await memo<Record<string, string>>(opts.publicBinding, m.digests)) ?? {} : {};
    },
    async redirects() {
      const m = await manifest();
      return m ? (await memo<Record<string, string>>(opts.publicBinding, m.redirects)) ?? {} : {};
    },
    async access() {
      if (!access || now() - access.at > CATALOG_TTL_MS)
        access = { value: await readJson<AccessSnapshot>(opts.protectBinding, ACCESS_SNAPSHOT_KEY), at: now() };
      return access.value;
    },
  };
}
