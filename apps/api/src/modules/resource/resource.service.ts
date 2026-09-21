import type { CachePolicy } from "./cache-policy";
import type { ResStore, StoredObjectInfo } from "./storage/types";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { and, asc, eq, gt, isNotNull, isNull, like, lte, sql } from "drizzle-orm";
import { AppError, NotFoundError, ValidationError } from "@/shared/lib/errors";
import { ulid } from "@/shared/lib/id";
import { cacheControlFor, effectivePolicy, isCachePolicy } from "./cache-policy";
import { encodeKeyPath, isValidDirectoryPrefix, isValidNamespaceName, objectKey, objectPathProblem } from "./paths";
import { resAliases, resNamespaces, resObjects, resOciTags, resPurges, resStores, resUploads } from "./schema";
import { getStore } from "./storage/registry";

export type ResourceConfig = Pick<
  Config,
  "RES_HOME_URL" | "RES_DOWNLOAD_URL" | "RES_PUBLIC_BUCKET" | "RES_PROTECT_BUCKET" | "RES_DELETE_GRACE_SECONDS" | "RES_UPLOAD_TTL_SECONDS"
>;

export const PUBLIC_STORE = "public";
export const PROTECT_STORE = "protect";
export const PUBLIC_BINDING = "RES_PUBLIC";
export const PROTECT_BINDING = "RES_PROTECT";
/** Uploads land here first; the protected bucket has no public domain. */
const STAGING_PREFIX = "_staging/";
const RE_SHA256 = /^[0-9a-f]{64}$/;

export type NamespaceRow = typeof resNamespaces.$inferSelect;
export type ObjectRow = typeof resObjects.$inferSelect;
export type StoreRow = typeof resStores.$inferSelect;

function now(): string {
  return new Date().toISOString();
}

// ─── Seeds ───

interface NamespaceSeed {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly immutable: boolean;
  readonly siteMode?: boolean;
  readonly cachePolicy: CachePolicy;
}

/** The normative namespaces of the plan; created once, then owned by the admin UI. */
export const DEFAULT_NAMESPACES: readonly NamespaceSeed[] = [
  { name: "mica", title: "Mica OS releases", description: "Product images and update archives of published releases.", immutable: true, cachePolicy: "immutable" },
  { name: "upstream", title: "Third-party inputs", description: "Debian archives, source tarballs and vendor git packs a build pins by sha256.", immutable: true, cachePolicy: "immutable" },
  { name: "oci", title: "Build-env image blobs", description: "Manifests, configs and layers of the build-env images, by digest.", immutable: true, cachePolicy: "immutable" },
  { name: "docs", title: "Documentation", description: "Versioned documentation sites.", immutable: true, siteMode: true, cachePolicy: "standard" },
  { name: "brand", title: "Brand assets", description: "Logos and icons.", immutable: false, cachePolicy: "standard" },
  { name: "status", title: "System status", description: "Build and release status snapshots.", immutable: false, cachePolicy: "short" },
];

export async function seedResources(db: AppDatabase, config: ResourceConfig): Promise<void> {
  const at = now();
  await db.insert(resStores).values([
    { name: PUBLIC_STORE, bucket: config.RES_PUBLIC_BUCKET, binding: PUBLIC_BINDING, visibility: "public", publicBaseUrl: config.RES_DOWNLOAD_URL, createdAt: at },
    { name: PROTECT_STORE, bucket: config.RES_PROTECT_BUCKET, binding: PROTECT_BINDING, visibility: "protected", publicBaseUrl: null, createdAt: at },
  ]).onConflictDoNothing().run();
  await db.insert(resNamespaces).values(DEFAULT_NAMESPACES.map(n => ({
    name: n.name,
    store: PUBLIC_STORE,
    title: n.title,
    description: n.description,
    immutable: n.immutable,
    siteMode: n.siteMode ?? false,
    cachePolicy: n.cachePolicy,
    createdAt: at,
    updatedAt: at,
  }))).onConflictDoNothing().run();
}

// ─── Stores and namespaces ───

export async function listStores(db: AppDatabase): Promise<StoreRow[]> {
  return db.select().from(resStores).orderBy(asc(resStores.name)).all();
}

async function storeRow(db: AppDatabase, name: string): Promise<StoreRow> {
  const row = await db.select().from(resStores).where(eq(resStores.name, name)).get();
  if (!row)
    throw new NotFoundError("store", name);
  return row;
}

export async function listNamespaces(db: AppDatabase): Promise<(NamespaceRow & { visibility: "public" | "protected" })[]> {
  const rows = await db.select({ ns: resNamespaces, visibility: resStores.visibility })
    .from(resNamespaces)
    .innerJoin(resStores, eq(resNamespaces.store, resStores.name))
    .orderBy(asc(resNamespaces.name))
    .all();
  return rows.map(r => ({ ...r.ns, visibility: r.visibility }));
}

export async function getNamespace(db: AppDatabase, name: string): Promise<{ namespace: NamespaceRow; store: StoreRow }> {
  const namespace = await db.select().from(resNamespaces).where(eq(resNamespaces.name, name)).get();
  if (!namespace)
    throw new NotFoundError("namespace", name);
  return { namespace, store: await storeRow(db, namespace.store) };
}

export interface NamespaceInput {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly listable?: boolean | undefined;
  readonly immutable?: boolean | undefined;
  readonly siteMode?: boolean | undefined;
  readonly cachePolicy?: string | undefined;
  readonly examples?: readonly string[] | undefined;
}

function checkNamespaceInput(input: NamespaceInput): void {
  if (input.cachePolicy !== undefined && !isCachePolicy(input.cachePolicy))
    throw new ValidationError("Unknown cache policy", { fieldErrors: { cachePolicy: [`"${input.cachePolicy}" is not a cache policy`] } });
}

export async function createNamespace(db: AppDatabase, input: NamespaceInput & { name: string; store: string; title: string }): Promise<NamespaceRow> {
  if (!isValidNamespaceName(input.name))
    throw new ValidationError("Invalid namespace name", { fieldErrors: { name: ["must be an S3 bucket name and not a reserved segment"] } });
  checkNamespaceInput(input);
  await storeRow(db, input.store);
  const at = now();
  try {
    return (await db.insert(resNamespaces).values({
      name: input.name,
      store: input.store,
      title: input.title,
      description: input.description ?? "",
      listable: input.listable ?? true,
      immutable: input.immutable ?? false,
      siteMode: input.siteMode ?? false,
      cachePolicy: input.cachePolicy ?? "standard",
      examples: JSON.stringify(input.examples ?? []),
      createdAt: at,
      updatedAt: at,
    }).returning().get());
  }
  catch (err) {
    if (await db.select().from(resNamespaces).where(eq(resNamespaces.name, input.name)).get())
      throw new AppError(`Namespace "${input.name}" already exists`, 409, "CONFLICT");
    throw err;
  }
}

/** Returns the updated row and whether objects now carry a stale cache-control. */
export async function updateNamespace(db: AppDatabase, name: string, input: NamespaceInput): Promise<{ namespace: NamespaceRow; staleObjects: number }> {
  checkNamespaceInput(input);
  const { namespace } = await getNamespace(db, name);
  const policyChanged = input.cachePolicy !== undefined && input.cachePolicy !== namespace.cachePolicy;
  const updated = await db.update(resNamespaces).set({
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.listable !== undefined && { listable: input.listable }),
    ...(input.immutable !== undefined && { immutable: input.immutable }),
    ...(input.siteMode !== undefined && { siteMode: input.siteMode }),
    ...(input.cachePolicy !== undefined && { cachePolicy: input.cachePolicy }),
    ...(input.examples !== undefined && { examples: JSON.stringify(input.examples) }),
    updatedAt: now(),
  }).where(eq(resNamespaces.name, name)).returning().get();
  let staleObjects = 0;
  if (policyChanged) {
    const res = await db.update(resObjects).set({ metadataStale: true }).where(and(eq(resObjects.namespace, name), isNull(resObjects.cachePolicy), isNull(resObjects.purgedAt))).run();
    staleObjects = res.rowsAffected;
  }
  return { namespace: updated, staleObjects };
}

// ─── Objects ───

export function publicUrl(store: StoreRow, key: string): string | null {
  return store.publicBaseUrl ? `${store.publicBaseUrl.replace(/\/+$/, "")}/${encodeKeyPath(key)}` : null;
}

function assertPath(namespace: string, path: string): void {
  const problem = objectPathProblem(namespace, path);
  if (problem)
    throw new ValidationError("Invalid object path", { fieldErrors: { path: [problem] } });
}

export async function getLiveObject(db: AppDatabase, namespace: string, path: string): Promise<ObjectRow | undefined> {
  return db.select().from(resObjects).where(and(eq(resObjects.namespace, namespace), eq(resObjects.path, path), isNull(resObjects.purgedAt))).get();
}

export interface ListObjectsQuery {
  readonly prefix?: string | undefined;
  readonly deleted?: "exclude" | "include" | "only" | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

export async function listObjects(db: AppDatabase, namespace: string, query: ListObjectsQuery = {}): Promise<ObjectRow[]> {
  const conditions = [eq(resObjects.namespace, namespace), isNull(resObjects.purgedAt)];
  if (query.prefix)
    conditions.push(like(resObjects.path, `${query.prefix.replace(/[\\%_]/g, c => `\\${c}`)}%`));
  if (query.after)
    conditions.push(gt(resObjects.path, query.after));
  if ((query.deleted ?? "exclude") === "exclude")
    conditions.push(isNull(resObjects.deletedAt));
  else if (query.deleted === "only")
    conditions.push(isNotNull(resObjects.deletedAt));
  return db.select().from(resObjects).where(and(...conditions)).orderBy(asc(resObjects.path)).limit(Math.min(query.limit ?? 1000, 5000)).all();
}

export type ObjectSource
  = | { readonly kind: "upload"; readonly uploadId: string }
    | { readonly kind: "sha256"; readonly sha256: string }
    /** The bytes are already at the key (a migration copied them there). */
    | { readonly kind: "in-place"; readonly sha256: string };

export interface PublishInput {
  readonly namespace: string;
  readonly path: string;
  readonly source: ObjectSource;
  readonly contentType?: string | undefined;
  readonly cachePolicy?: string | null | undefined;
  readonly meta?: Readonly<Record<string, string>> | undefined;
  readonly actorId: string;
}

export type PublishOutcome = "created" | "unchanged" | "replaced" | "restored" | "metadata-updated";

export interface PublishResult {
  readonly object: ObjectRow;
  readonly outcome: PublishOutcome;
  /** Download URLs that must be purged from the CDN. */
  readonly purge: readonly string[];
}

function assertSha(sha256: string): void {
  if (!RE_SHA256.test(sha256))
    throw new ValidationError("Invalid sha256", { fieldErrors: { sha256: ["must be 64 lowercase hex characters"] } });
}

/** Where the bytes for a publish come from, as a copy source. */
async function resolveSource(db: AppDatabase, store: StoreRow, source: ObjectSource, key: string): Promise<{ sha256: string; copyFrom: { bucket: string; key: string } | null; upload: typeof resUploads.$inferSelect | null }> {
  if (source.kind === "in-place") {
    assertSha(source.sha256);
    return { sha256: source.sha256, copyFrom: null, upload: null };
  }
  if (source.kind === "upload") {
    const upload = await db.select().from(resUploads).where(eq(resUploads.id, source.uploadId)).get();
    if (!upload || upload.state !== "pending")
      throw new NotFoundError("upload", source.uploadId);
    const staging = await getStore(PROTECT_BINDING).head(upload.stagingKey);
    if (!staging || staging.size !== upload.size)
      throw new AppError("The upload has not been completed", 409, "UPLOAD_INCOMPLETE");
    const protect = await storeRow(db, PROTECT_STORE);
    return { sha256: upload.sha256, copyFrom: { bucket: protect.bucket, key: upload.stagingKey }, upload };
  }
  assertSha(source.sha256);
  // Any live object in the same store holding these bytes can be copied.
  const holder = await db.select({ namespace: resObjects.namespace, path: resObjects.path })
    .from(resObjects)
    .innerJoin(resNamespaces, eq(resObjects.namespace, resNamespaces.name))
    .where(and(eq(resObjects.sha256, source.sha256), eq(resNamespaces.store, store.name), isNull(resObjects.purgedAt)))
    .get();
  if (!holder)
    throw new AppError(`No object in store "${store.name}" holds sha256 ${source.sha256}; upload it first`, 409, "SOURCE_NOT_FOUND");
  const holderKey = objectKey(holder.namespace, holder.path);
  return { sha256: source.sha256, copyFrom: holderKey === key ? null : { bucket: store.bucket, key: holderKey }, upload: null };
}

export async function publishObject(db: AppDatabase, input: PublishInput): Promise<PublishResult> {
  assertPath(input.namespace, input.path);
  if (input.cachePolicy != null && !isCachePolicy(input.cachePolicy))
    throw new ValidationError("Unknown cache policy", { fieldErrors: { cachePolicy: [`"${input.cachePolicy}" is not a cache policy`] } });
  const { namespace, store } = await getNamespace(db, input.namespace);
  const key = objectKey(input.namespace, input.path);
  const target = getStore(store.binding);
  const existing = await getLiveObject(db, input.namespace, input.path);
  const source = await resolveSource(db, store, input.source, key);

  const contentType = input.contentType ?? existing?.contentType ?? contentTypeFor(input.path);
  const objectPolicy = input.cachePolicy === undefined ? (existing?.cachePolicy ?? null) : input.cachePolicy;
  const meta = { sha256: source.sha256, contentType, cacheControl: cacheControlFor(effectivePolicy(namespace.cachePolicy as CachePolicy, objectPolicy as CachePolicy | null)) };
  const url = publicUrl(store, key);

  if (existing && existing.sha256 !== source.sha256 && namespace.immutable)
    throw new AppError(`${key} is published with different bytes and namespace "${namespace.name}" is immutable`, 409, "IMMUTABLE");

  const sameBytes = existing?.sha256 === source.sha256;
  const sameMetadata = sameBytes && existing!.contentType === contentType && existing!.cachePolicy === objectPolicy && !existing!.metadataStale;

  let stored: StoredObjectInfo | null = null;
  if (!sameMetadata || input.source.kind === "in-place") {
    if (source.copyFrom)
      stored = await target.copyFrom(source.copyFrom, key, meta);
    else if (input.source.kind === "in-place" || sameBytes)
      stored = await rewriteInPlace(target, store, key, meta, input.source.kind === "in-place");
  }

  const at = now();
  const metaJson = JSON.stringify(input.meta ?? (existing ? JSON.parse(existing.meta) as Record<string, string> : {}));
  let row: ObjectRow;
  let outcome: PublishOutcome;
  if (!existing) {
    const info = stored ?? await target.head(key);
    if (!info)
      throw new AppError(`${key} is not in the bucket`, 409, "OBJECT_MISSING");
    row = await db.insert(resObjects).values({
      id: ulid(),
      namespace: input.namespace,
      path: input.path,
      sha256: source.sha256,
      size: info.size,
      etag: info.etag,
      contentType,
      cachePolicy: objectPolicy,
      meta: metaJson,
      publishedAt: at,
      publishedBy: input.actorId,
    }).returning().get();
    outcome = "created";
  }
  else {
    const info = stored ?? { size: existing.size, etag: existing.etag };
    outcome = existing.deletedAt ? "restored" : !sameBytes ? "replaced" : sameMetadata ? "unchanged" : "metadata-updated";
    row = await db.update(resObjects).set({
      sha256: source.sha256,
      size: info.size,
      etag: info.etag,
      contentType,
      cachePolicy: objectPolicy,
      meta: metaJson,
      metadataStale: false,
      deletedAt: null,
      deleteReason: null,
      purgeAfter: null,
      ...(outcome === "unchanged" ? {} : { publishedAt: at, publishedBy: input.actorId }),
    }).where(eq(resObjects.id, existing.id)).returning().get();
  }

  if (source.upload) {
    await db.update(resUploads).set({ state: "consumed" }).where(eq(resUploads.id, source.upload.id)).run();
    await getStore(PROTECT_BINDING).delete(source.upload.stagingKey);
  }

  const purge = url && (outcome === "replaced" || outcome === "metadata-updated") ? [url] : [];
  return { object: row, outcome, purge };
}

/**
 * Rewrite an object's metadata in place (S3 copy onto itself). For a key the
 * migration filled, also checks that the bytes there are the declared ones.
 */
async function rewriteInPlace(target: ResStore, store: StoreRow, key: string, meta: { sha256: string; contentType: string; cacheControl: string }, verify: boolean): Promise<StoredObjectInfo> {
  const current = await target.head(key);
  if (!current)
    throw new AppError(`${key} is not in the bucket`, 409, "OBJECT_MISSING");
  if (verify && current.sha256 !== undefined && current.sha256 !== meta.sha256)
    throw new AppError(`${key} holds sha256 ${current.sha256}, not ${meta.sha256}`, 409, "SHA256_MISMATCH");
  if (current.contentType === meta.contentType && current.cacheControl === meta.cacheControl && current.sha256 === meta.sha256)
    return current;
  return target.copyFrom({ bucket: store.bucket, key }, key, meta);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  gz: "application/gzip",
  xz: "application/x-xz",
  zst: "application/zstd",
  tar: "application/x-tar",
  zip: "application/zip",
  deb: "application/vnd.debian.binary-package",
  woff2: "font/woff2",
};

export function contentTypeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && CONTENT_TYPES[ext]) ?? "application/octet-stream";
}

// ─── Uploads ───

/**
 * Start an upload. With R2 S3 credentials the client PUTs straight to R2
 * through a presigned URL; without them it PUTs to this service, which
 * streams the body into staging (bounded by the platform's request-body
 * limit, so about 95 MiB).
 */
export async function createUpload(db: AppDatabase, config: ResourceConfig, input: { sha256: string; size: number; contentType: string; actorId: string }) {
  assertSha(input.sha256);
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > 5 * 1024 ** 3)
    throw new ValidationError("Invalid size", { fieldErrors: { size: ["must be between 1 byte and 5 GiB"] } });
  const id = ulid();
  const stagingKey = `${STAGING_PREFIX}${id}`;
  const expiresAt = new Date(Date.now() + config.RES_UPLOAD_TTL_SECONDS * 1000).toISOString();
  const presigned = await getStore(PROTECT_BINDING).presignPut(stagingKey, {
    sha256: input.sha256,
    size: input.size,
    contentType: input.contentType,
    expiresSeconds: config.RES_UPLOAD_TTL_SECONDS,
  });
  await db.insert(resUploads).values({
    id,
    stagingKey,
    sha256: input.sha256,
    size: input.size,
    contentType: input.contentType,
    state: "pending",
    expiresAt,
    createdBy: input.actorId,
    createdAt: now(),
  }).run();
  return presigned === null
    ? { id, url: `${config.RES_HOME_URL.replace(/\/+$/, "")}/admin/api/res/uploads/${id}/content`, headers: { "content-type": input.contentType }, direct: true, expiresAt }
    : { id, url: presigned.url, headers: presigned.headers, direct: false, expiresAt };
}

/** Receive an upload's bytes here when the store cannot presign. */
export async function writeUploadBody(db: AppDatabase, id: string, body: ReadableStream<Uint8Array>, actorId: string): Promise<{ id: string; size: number }> {
  const upload = await db.select().from(resUploads).where(eq(resUploads.id, id)).get();
  if (!upload || upload.state !== "pending" || upload.createdBy !== actorId)
    throw new NotFoundError("upload", id);
  if (new Date(upload.expiresAt) <= new Date())
    throw new AppError("The upload has expired", 409, "UPLOAD_EXPIRED");
  try {
    await getStore(PROTECT_BINDING).putStream(upload.stagingKey, body, upload.size, {
      sha256: upload.sha256,
      contentType: upload.contentType,
      cacheControl: "no-store",
    });
  }
  catch {
    throw new AppError("The uploaded bytes do not match the declared sha256 and size", 409, "SHA256_MISMATCH");
  }
  return { id, size: upload.size };
}

/**
 * Stream `origin` into a staging key, with R2 enforcing the sha256. The
 * origin is a hint, never a trust anchor: only https, redirects followed by
 * hand with every hop re-checked, and the answer never echoes what was
 * fetched -- that is what keeps this from being an open fetcher.
 */
export async function pullUpload(db: AppDatabase, config: ResourceConfig, input: { origin: string; sha256: string; contentType: string; actorId: string }, fetcher: typeof fetch = fetch) {
  assertSha(input.sha256);
  let target = input.origin;
  let download: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    if (!target.startsWith("https://"))
      throw new AppError("The origin must be https", 400, "ORIGIN_NOT_HTTPS");
    const answer = await fetcher(target, { redirect: "manual" });
    if (answer.status < 300 || answer.status > 399) {
      download = answer;
      break;
    }
    const location = answer.headers.get("location");
    if (!location)
      throw new AppError("The origin redirected without a location", 502, "ORIGIN_FAILED");
    target = new URL(location, target).toString();
  }
  if (!download)
    throw new AppError("The origin redirected too often", 502, "ORIGIN_FAILED");
  if (!download.ok || !download.body)
    throw new AppError(`The origin answered ${download.status}`, 502, "ORIGIN_FAILED");
  const size = Number(download.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new AppError("The origin did not declare a content length", 502, "ORIGIN_FAILED");

  const id = ulid();
  const stagingKey = `${STAGING_PREFIX}${id}`;
  try {
    await getStore(PROTECT_BINDING).putStream(stagingKey, download.body, size, { sha256: input.sha256, contentType: input.contentType, cacheControl: "no-store" });
  }
  catch {
    throw new AppError("The pulled bytes do not match the sha256", 409, "SHA256_MISMATCH");
  }
  await db.insert(resUploads).values({
    id,
    stagingKey,
    sha256: input.sha256,
    size,
    contentType: input.contentType,
    state: "pending",
    expiresAt: new Date(Date.now() + config.RES_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    createdBy: input.actorId,
    createdAt: now(),
  }).run();
  return { id, size };
}

// ─── Aliases, redirects, OCI tags ───

export async function setAlias(db: AppDatabase, input: { namespace: string; path: string; targetPath: string }): Promise<void> {
  assertPath(input.namespace, input.path);
  assertPath(input.namespace, input.targetPath);
  await getNamespace(db, input.namespace);
  if (await getLiveObject(db, input.namespace, input.path))
    throw new AppError(`${objectKey(input.namespace, input.path)} is an object, not an alias`, 409, "CONFLICT");
  const at = now();
  await db.insert(resAliases).values({ ...input, updatedAt: at }).onConflictDoUpdate({ target: [resAliases.namespace, resAliases.path], set: { targetPath: input.targetPath, updatedAt: at } }).run();
}

export async function deleteAlias(db: AppDatabase, namespace: string, path: string): Promise<boolean> {
  const res = await db.delete(resAliases).where(and(eq(resAliases.namespace, namespace), eq(resAliases.path, path))).run();
  return res.rowsAffected > 0;
}

export async function listAliases(db: AppDatabase, namespace: string) {
  return db.select().from(resAliases).where(eq(resAliases.namespace, namespace)).orderBy(asc(resAliases.path)).all();
}

const RE_REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const RE_TAG = /^\w[\w.-]{0,127}$/;

export async function setOciTag(db: AppDatabase, input: { repository: string; tag: string; digest: string }): Promise<void> {
  if (!RE_REPOSITORY.test(input.repository) || !RE_TAG.test(input.tag) || !/^sha256:[0-9a-f]{64}$/.test(input.digest))
    throw new ValidationError("Invalid tag", { fieldErrors: { tag: ["repository, tag or digest is malformed"] } });
  const hex = input.digest.slice("sha256:".length);
  if (!await getLiveObject(db, "oci", `blobs/sha256/${hex}`))
    throw new AppError(`oci/blobs/sha256/${hex} is not published`, 409, "SOURCE_NOT_FOUND");
  const at = now();
  await db.insert(resOciTags).values({ ...input, updatedAt: at }).onConflictDoUpdate({ target: [resOciTags.repository, resOciTags.tag], set: { digest: input.digest, updatedAt: at } }).run();
}

// ─── Deletion ───

export interface DeleteInput {
  readonly namespace: string;
  readonly path?: string | undefined;
  readonly prefix?: string | undefined;
  readonly reason: string;
  readonly dryRun?: boolean | undefined;
}

export async function deleteObjects(db: AppDatabase, config: ResourceConfig, input: DeleteInput): Promise<{ count: number; keys: string[] }> {
  if ((input.path === undefined) === (input.prefix === undefined))
    throw new ValidationError("Give exactly one of path or prefix", { fieldErrors: { path: ["exactly one of path or prefix"] } });
  if (input.prefix !== undefined && !isValidDirectoryPrefix(input.prefix))
    throw new ValidationError("Invalid prefix", { fieldErrors: { prefix: ["must be empty or end with /"] } });
  await getNamespace(db, input.namespace);
  const target = and(
    eq(resObjects.namespace, input.namespace),
    isNull(resObjects.purgedAt),
    isNull(resObjects.deletedAt),
    input.path !== undefined ? eq(resObjects.path, input.path) : like(resObjects.path, `${input.prefix!.replace(/[\\%_]/g, c => `\\${c}`)}%`),
  );
  const rows = await db.select({ path: resObjects.path }).from(resObjects).where(target).orderBy(asc(resObjects.path)).all();
  const keys = rows.map(r => objectKey(input.namespace, r.path));
  if (input.dryRun || rows.length === 0)
    return { count: rows.length, keys };
  const at = new Date();
  await db.update(resObjects).set({
    deletedAt: at.toISOString(),
    deleteReason: input.reason,
    purgeAfter: new Date(at.getTime() + config.RES_DELETE_GRACE_SECONDS * 1000).toISOString(),
  }).where(target).run();
  return { count: rows.length, keys };
}

export async function restoreObject(db: AppDatabase, namespace: string, path: string): Promise<ObjectRow> {
  const row = await getLiveObject(db, namespace, path);
  if (!row?.deletedAt)
    throw new NotFoundError("deleted object", objectKey(namespace, path));
  return db.update(resObjects).set({ deletedAt: null, deleteReason: null, purgeAfter: null }).where(eq(resObjects.id, row.id)).returning().get();
}

/** Remove the bytes of a deleted object at the next sweep instead of after the grace period. */
export async function purgeNow(db: AppDatabase, namespace: string, path: string): Promise<ObjectRow> {
  const row = await getLiveObject(db, namespace, path);
  if (!row?.deletedAt)
    throw new AppError("Only a deleted object can be purged", 409, "NOT_DELETED");
  // One minute past now outlasts the edge's 30 s catalog TTL, so no reader
  // is still sent to the bytes when they go.
  return db.update(resObjects).set({ purgeAfter: new Date(Date.now() + 60_000).toISOString() }).where(eq(resObjects.id, row.id)).returning().get();
}

/** Delete the bytes of every object whose grace period has passed. */
export async function sweepDeletedObjects(db: AppDatabase, limit = 200): Promise<{ purged: number; urls: string[] }> {
  const due = await db.select({ object: resObjects, store: resStores })
    .from(resObjects)
    .innerJoin(resNamespaces, eq(resObjects.namespace, resNamespaces.name))
    .innerJoin(resStores, eq(resNamespaces.store, resStores.name))
    .where(and(isNotNull(resObjects.deletedAt), isNull(resObjects.purgedAt), lte(resObjects.purgeAfter, now())))
    .limit(limit)
    .all();
  const urls: string[] = [];
  for (const { object, store } of due) {
    const key = objectKey(object.namespace, object.path);
    await getStore(store.binding).delete(key);
    await db.update(resObjects).set({ purgedAt: now() }).where(eq(resObjects.id, object.id)).run();
    const url = publicUrl(store, key);
    if (url)
      urls.push(url);
  }
  return { purged: due.length, urls };
}

/** Rewrite the cache-control of objects whose namespace policy changed. */
export async function refreshStaleMetadata(db: AppDatabase, limit = 100): Promise<string[]> {
  const stale = await db.select({ object: resObjects, namespace: resNamespaces, store: resStores })
    .from(resObjects)
    .innerJoin(resNamespaces, eq(resObjects.namespace, resNamespaces.name))
    .innerJoin(resStores, eq(resNamespaces.store, resStores.name))
    .where(and(eq(resObjects.metadataStale, true), isNull(resObjects.purgedAt)))
    .limit(limit)
    .all();
  const urls: string[] = [];
  for (const { object, namespace, store } of stale) {
    const key = objectKey(object.namespace, object.path);
    const meta = {
      sha256: object.sha256,
      contentType: object.contentType,
      cacheControl: cacheControlFor(effectivePolicy(namespace.cachePolicy as CachePolicy, object.cachePolicy as CachePolicy | null)),
    };
    const info = await getStore(store.binding).copyFrom({ bucket: store.bucket, key }, key, meta);
    await db.update(resObjects).set({ metadataStale: false, etag: info.etag }).where(eq(resObjects.id, object.id)).run();
    const url = publicUrl(store, key);
    if (url)
      urls.push(url);
  }
  return urls;
}

/** Drop staging bytes of uploads nobody published. */
export async function expireUploads(db: AppDatabase, limit = 200): Promise<number> {
  const expired = await db.select().from(resUploads).where(and(eq(resUploads.state, "pending"), lte(resUploads.expiresAt, now()))).limit(limit).all();
  for (const upload of expired) {
    await getStore(PROTECT_BINDING).delete(upload.stagingKey);
    await db.delete(resUploads).where(eq(resUploads.id, upload.id)).run();
  }
  return expired.length;
}

// ─── Purge queue ───

export async function enqueuePurge(db: AppDatabase, urls: readonly string[]): Promise<void> {
  if (urls.length === 0)
    return;
  const at = now();
  // Cloudflare accepts at most 30 URLs per purge call.
  for (let i = 0; i < urls.length; i += 30) {
    await db.insert(resPurges).values({ id: ulid(), urls: JSON.stringify(urls.slice(i, i + 30)), state: "pending", createdAt: at, updatedAt: at }).run();
  }
}

export async function listPurges(db: AppDatabase, state?: "pending" | "done" | "skipped") {
  return db.select().from(resPurges).where(state ? eq(resPurges.state, state) : sql`1 = 1`).orderBy(sql`${resPurges.createdAt} DESC`).limit(200).all();
}
