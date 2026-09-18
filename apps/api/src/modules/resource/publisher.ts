import type { CachePolicy } from "./cache-policy";
import type { CatalogSite } from "./catalog";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getSetting, setSetting } from "@/modules/settings/settings.service";
import { ulid } from "@/shared/lib/id";
import { buildCatalog, CATALOG_POINTER_KEY } from "./catalog";
import { PUBLIC_BINDING } from "./resource.service";
import { resAliases, resNamespaces, resObjects, resOciTags, resRedirects, resSnapshots, resStores } from "./schema";
import { getStore } from "./storage/registry";

export type PublisherConfig = Pick<Config, "RES_HOME_URL" | "RES_DOWNLOAD_URL" | "RES_S3_URL">;

export const SITE_TITLE_KEY = "res.site.title";
export const SITE_DESCRIPTION_KEY = "res.site.description";
const DIRTY_KEY = "res.catalog.dirty";
const KEEP_SNAPSHOTS = 10;

export const DEFAULT_SITE_TITLE = "Mica OS resources";
export const DEFAULT_SITE_DESCRIPTION = "Public downloads of Mica OS: releases, the third-party inputs a build pins, build-env images and documentation. Every object is pinned by sha256 in the repository that consumes it; verify against your own pin.";

const NO_STORE_JSON = { contentType: "application/json", cacheControl: "no-store" } as const;
const IMMUTABLE_JSON = { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" } as const;

export async function siteSettings(db: AppDatabase, config: PublisherConfig): Promise<CatalogSite> {
  return {
    title: await getSetting(db, SITE_TITLE_KEY) ?? DEFAULT_SITE_TITLE,
    description: await getSetting(db, SITE_DESCRIPTION_KEY) ?? DEFAULT_SITE_DESCRIPTION,
    download: config.RES_DOWNLOAD_URL,
    s3: config.RES_S3_URL,
    home: config.RES_HOME_URL,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the snapshot from the database and write it: every document first,
 * the pointer last. Returns the version written.
 */
export async function publishCatalog(db: AppDatabase, config: PublisherConfig): Promise<string> {
  const version = ulid();
  const publishedAt = new Date().toISOString();
  const namespaceRows = await db.select({ ns: resNamespaces, store: resStores })
    .from(resNamespaces)
    .innerJoin(resStores, eq(resNamespaces.store, resStores.name))
    .all();
  const objects = await db.select().from(resObjects).where(and(isNull(resObjects.deletedAt), isNull(resObjects.purgedAt))).orderBy(asc(resObjects.namespace), asc(resObjects.path)).all();

  const { pointer, files } = buildCatalog({
    version,
    publishedAt,
    site: await siteSettings(db, config),
    publicStore: PUBLIC_BINDING,
    namespaces: namespaceRows.map(({ ns, store }) => ({
      name: ns.name,
      title: ns.title,
      description: ns.description,
      visibility: store.visibility,
      store: store.binding,
      listable: ns.listable,
      immutable: ns.immutable,
      siteMode: ns.siteMode,
      cachePolicy: ns.cachePolicy as CachePolicy,
      examples: JSON.parse(ns.examples) as string[],
    })),
    objects: objects.map(o => ({
      namespace: o.namespace,
      path: o.path,
      sha256: o.sha256,
      size: o.size,
      etag: o.etag,
      contentType: o.contentType,
      publishedAt: o.publishedAt,
    })),
    aliases: await db.select().from(resAliases).all(),
    redirects: await db.select().from(resRedirects).all(),
    ociTags: await db.select().from(resOciTags).all(),
  });

  for (const file of files) {
    await getStore(file.store).putText(file.key, file.text, { sha256: await sha256Hex(file.text), ...IMMUTABLE_JSON });
  }
  const pointerText = `${JSON.stringify(pointer)}\n`;
  await getStore(PUBLIC_BINDING).putText(CATALOG_POINTER_KEY, pointerText, { sha256: await sha256Hex(pointerText), ...NO_STORE_JSON });

  const publicObjects = objects.filter(o => namespaceRows.find(n => n.ns.name === o.namespace)?.store.visibility === "public");
  await db.insert(resSnapshots).values({
    version,
    objects: publicObjects.length,
    bytes: publicObjects.reduce((sum, o) => sum + o.size, 0),
    publishedAt,
  }).run();
  return version;
}

/** Delete the documents of every snapshot but the newest few. */
export async function pruneSnapshots(db: AppDatabase): Promise<number> {
  const live = await db.select().from(resSnapshots).where(isNull(resSnapshots.prunedAt)).orderBy(desc(resSnapshots.version)).all();
  const old = live.slice(KEEP_SNAPSHOTS);
  if (old.length === 0)
    return 0;
  const stores = await db.select().from(resStores).all();
  for (const snapshot of old) {
    for (const store of stores) {
      const s = getStore(store.binding);
      let cursor: string | undefined;
      do {
        const page = await s.list(`_catalog/${snapshot.version}/`, cursor);
        for (const { key } of page.keys)
          await s.delete(key);
        cursor = page.cursor;
      } while (cursor !== undefined);
    }
  }
  await db.update(resSnapshots).set({ prunedAt: new Date().toISOString() }).where(inArray(resSnapshots.version, old.map(s => s.version))).run();
  return old.length;
}

/**
 * Publish after a committed change. A failure never fails the change: the
 * catalog is marked dirty and the background job publishes it again.
 */
export async function republish(db: AppDatabase, config: PublisherConfig, logger: Pick<Logger, "warn">): Promise<"published" | "pending"> {
  try {
    await publishCatalog(db, config);
    await setSetting(db, DIRTY_KEY, "0");
    return "published";
  }
  catch (err) {
    logger.warn({ err }, "catalog publish failed; the background job will retry");
    await setSetting(db, DIRTY_KEY, "1").catch(() => {});
    return "pending";
  }
}

/** Ask the background job to publish; used when no snapshot exists yet. */
export async function markCatalogDirty(db: AppDatabase): Promise<void> {
  await setSetting(db, DIRTY_KEY, "1");
}

/** Whether any catalog snapshot has ever been written. */
export async function hasPublishedCatalog(db: AppDatabase): Promise<boolean> {
  return (await db.select({ version: resSnapshots.version }).from(resSnapshots).limit(1).get()) !== undefined;
}

export async function isCatalogDirty(db: AppDatabase): Promise<boolean> {
  return (await getSetting(db, DIRTY_KEY)) === "1";
}

export async function setSiteSettings(db: AppDatabase, input: { title?: string | undefined; description?: string | undefined }, actorId: string): Promise<void> {
  if (input.title !== undefined)
    await setSetting(db, SITE_TITLE_KEY, input.title, { updatedBy: actorId });
  if (input.description !== undefined)
    await setSetting(db, SITE_DESCRIPTION_KEY, input.description, { updatedBy: actorId });
}
