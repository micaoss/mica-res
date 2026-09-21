import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// A store is one R2 bucket, reached through a Worker binding. A public store
// has a download base URL (the bucket's custom domain); a protected one has
// none, so its bytes have no anonymous URL at all.
export const resStores = sqliteTable("res_stores", {
  name: text("name").primaryKey(),
  bucket: text("bucket").notNull(),
  binding: text("binding").notNull(),
  visibility: text("visibility", { enum: ["public", "protected"] }).notNull(),
  publicBaseUrl: text("public_base_url"),
  createdAt: text("created_at").notNull(),
});

// A namespace is a top-level directory: the first path segment, the S3
// bucket name on the S3 host. Its visibility always equals its store's.
export const resNamespaces = sqliteTable("res_namespaces", {
  name: text("name").primaryKey(),
  store: text("store").notNull().references(() => resStores.name, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  listable: integer("listable", { mode: "boolean" }).notNull().default(true),
  immutable: integer("immutable", { mode: "boolean" }).notNull().default(false),
  siteMode: integer("site_mode", { mode: "boolean" }).notNull().default(false),
  cachePolicy: text("cache_policy").notNull().default("standard"),
  examples: text("examples").notNull().default("[]"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// One row per published key. A soft delete keeps the row (and the bytes)
// until `purge_after`; the sweeper then deletes the object and sets
// `purged_at`. Only one live row per key: a key published again after a
// purge is a new row.
export const resObjects = sqliteTable("res_objects", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull().references(() => resNamespaces.name, { onDelete: "restrict" }),
  path: text("path").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  etag: text("etag").notNull(),
  contentType: text("content_type").notNull(),
  cachePolicy: text("cache_policy"),
  meta: text("meta").notNull().default("{}"),
  publishedAt: text("published_at").notNull(),
  publishedBy: text("published_by").notNull(),
  deletedAt: text("deleted_at"),
  deleteReason: text("delete_reason"),
  purgeAfter: text("purge_after"),
  purgedAt: text("purged_at"),
  // Set when the namespace's cache policy changed under an object that has
  // no override: its stored cache-control must be rewritten and its URL purged.
  metadataStale: integer("metadata_stale", { mode: "boolean" }).notNull().default(false),
}, t => [
  uniqueIndex("idx_res_objects_key_live").on(t.namespace, t.path).where(sql`purged_at IS NULL`),
  index("idx_res_objects_sha").on(t.sha256),
  index("idx_res_objects_purge_due").on(t.purgeAfter).where(sql`deleted_at IS NOT NULL AND purged_at IS NULL`),
]);

// A mutable pointer inside a namespace (`docs/product/latest` -> a version).
export const resAliases = sqliteTable("res_aliases", {
  namespace: text("namespace").notNull().references(() => resNamespaces.name, { onDelete: "cascade" }),
  path: text("path").notNull(),
  targetPath: text("target_path").notNull(),
  updatedAt: text("updated_at").notNull(),
}, t => [primaryKey({ columns: [t.namespace, t.path] })]);

export const resOciTags = sqliteTable("res_oci_tags", {
  repository: text("repository").notNull(),
  tag: text("tag").notNull(),
  digest: text("digest").notNull(),
  updatedAt: text("updated_at").notNull(),
}, t => [primaryKey({ columns: [t.repository, t.tag] })]);

// An upload in flight: bytes go straight to a staging key in the protected
// store, then a publish copies them to their key.
export const resUploads = sqliteTable("res_uploads", {
  id: text("id").primaryKey(),
  stagingKey: text("staging_key").notNull(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  contentType: text("content_type").notNull(),
  state: text("state", { enum: ["pending", "consumed"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

// Every catalog snapshot written, so old ones can be pruned.
export const resSnapshots = sqliteTable("res_snapshots", {
  version: text("version").primaryKey(),
  objects: integer("objects").notNull(),
  bytes: integer("bytes").notNull(),
  publishedAt: text("published_at").notNull(),
  prunedAt: text("pruned_at"),
});

// CDN purges owed after a replace, a policy change or a delete, retried
// until Cloudflare accepts them.
export const resPurges = sqliteTable("res_purges", {
  id: text("id").primaryKey(),
  urls: text("urls").notNull(),
  state: text("state", { enum: ["pending", "done", "skipped"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, t => [index("idx_res_purges_pending").on(t.createdAt).where(sql`state = 'pending'`)]);

// Keys for protected namespaces. The secret is kept twice: hashed for the
// bearer form, and sealed with RES_KEY_KEK because SigV4 verification needs
// the secret itself.
export const resAccessKeys = sqliteTable("res_access_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  secretHash: text("secret_hash").notNull(),
  secretSealed: text("secret_sealed").notNull(),
  grants: text("grants").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});
