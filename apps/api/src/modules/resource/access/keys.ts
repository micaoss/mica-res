/**
 * Access keys for protected namespaces. A key is an id plus a secret:
 *
 *   - HTTP: `Authorization: Bearer rk_<id>_<secret>`, or a res-signed URL
 *     (`X-Res-Key`, `X-Res-Expires`, `X-Res-Signature`);
 *   - S3: SigV4 with the id as access key id and the secret as secret key.
 *
 * The control plane never stores the secret in the clear: a hash serves the
 * bearer form, and a copy sealed with RES_KEY_KEK serves SigV4 and URL
 * signing, which need the secret itself. The edge reads both from the access
 * snapshot in the protected bucket.
 */
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { AppError, NotFoundError, ValidationError } from "@/shared/lib/errors";
import { isValidDirectoryPrefix } from "../paths";
import { PROTECT_BINDING } from "../resource.service";
import { resAccessKeys, resNamespaces, resStores } from "../schema";
import { getStore } from "../storage/registry";
import { hmacHex, sha256Hex, timingSafeEqual } from "../storage/sigv4";

export const ACCESS_SNAPSHOT_KEY = "_access/current.json";
export const ACCESS_SNAPSHOT_SCHEMA = "mica-res/access/v1";
export const BEARER_PREFIX = "rk_";

export interface Grant {
  readonly namespace: string;
  /** Empty for the whole namespace, otherwise a directory prefix ending in `/`. */
  readonly prefix: string;
}

export interface AccessSnapshotKey {
  readonly id: string;
  readonly secretHash: string;
  readonly secretSealed: string;
  readonly grants: readonly Grant[];
  readonly expiresAt: string | null;
}

export interface AccessSnapshot {
  readonly schema: typeof ACCESS_SNAPSHOT_SCHEMA;
  readonly publishedAt: string;
  readonly keys: readonly AccessSnapshotKey[];
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomString(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
}

function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function unb64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), c => c.charCodeAt(0));
}

async function kekKey(kek: string | undefined): Promise<CryptoKey> {
  if (!kek)
    throw new AppError("RES_KEY_KEK is not configured; access keys cannot be created or used", 503, "KEK_NOT_CONFIGURED");
  const raw = unb64(kek);
  if (raw.length !== 32)
    throw new AppError("RES_KEY_KEK must be 32 bytes, base64", 503, "KEK_NOT_CONFIGURED");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSecret(kek: string | undefined, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await kekKey(kek), new TextEncoder().encode(secret)));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return b64(out);
}

export async function openSecret(kek: string | undefined, sealed: string): Promise<string> {
  const bytes = unb64(sealed);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await kekKey(kek), bytes.slice(12));
  return new TextDecoder().decode(plain);
}

/** Whether `grants` cover `namespace/path` (or the directory `path/`). */
export function grantsAllow(grants: readonly Grant[], namespace: string, path: string): boolean {
  return grants.some(g => g.namespace === namespace && path.startsWith(g.prefix));
}

/** Whether `grants` reach anything in `namespace` at all (bucket listing). */
export function grantsNamespace(grants: readonly Grant[], namespace: string): boolean {
  return grants.some(g => g.namespace === namespace);
}

async function checkGrants(db: AppDatabase, grants: readonly Grant[]): Promise<void> {
  if (grants.length === 0)
    throw new ValidationError("A key needs at least one grant", { fieldErrors: { grants: ["at least one grant"] } });
  for (const grant of grants) {
    if (!isValidDirectoryPrefix(grant.prefix))
      throw new ValidationError("Invalid grant prefix", { fieldErrors: { grants: [`"${grant.prefix}" must be empty or end with /`] } });
    const row = await db.select({ visibility: resStores.visibility })
      .from(resNamespaces)
      .innerJoin(resStores, eq(resNamespaces.store, resStores.name))
      .where(eq(resNamespaces.name, grant.namespace))
      .get();
    if (!row)
      throw new NotFoundError("namespace", grant.namespace);
    if (row.visibility !== "protected")
      throw new ValidationError("Grants apply to protected namespaces only", { fieldErrors: { grants: [`"${grant.namespace}" is public`] } });
  }
}

export async function createAccessKey(db: AppDatabase, config: Pick<Config, "RES_KEY_KEK">, input: { name: string; grants: readonly Grant[]; expiresAt?: string | undefined; actorId: string }) {
  await checkGrants(db, input.grants);
  const id = `RK${randomString(ID_ALPHABET, 18)}`;
  const secret = randomString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 40);
  const row = await db.insert(resAccessKeys).values({
    id,
    name: input.name,
    secretHash: await sha256Hex(secret),
    secretSealed: await sealSecret(config.RES_KEY_KEK, secret),
    grants: JSON.stringify(input.grants),
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdBy: input.actorId,
    createdAt: new Date().toISOString(),
  }).returning().get();
  return { key: publicView(row), secret, bearer: `${BEARER_PREFIX}${id}_${secret}` };
}

export function publicView(row: typeof resAccessKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    grants: JSON.parse(row.grants) as Grant[],
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export async function listAccessKeys(db: AppDatabase) {
  return (await db.select().from(resAccessKeys).orderBy(asc(resAccessKeys.createdAt)).all()).map(publicView);
}

export async function revokeAccessKey(db: AppDatabase, id: string): Promise<void> {
  const res = await db.update(resAccessKeys).set({ revokedAt: new Date().toISOString() }).where(and(eq(resAccessKeys.id, id), isNull(resAccessKeys.revokedAt))).run();
  if (res.rowsAffected === 0)
    throw new NotFoundError("access key", id);
}

function activeKey(row: typeof resAccessKeys.$inferSelect | undefined, at: Date): row is typeof resAccessKeys.$inferSelect {
  return row !== undefined && row.revokedAt === null && (row.expiresAt === null || new Date(row.expiresAt) > at);
}

/** The string a res-signed URL signs. */
export function signedUrlPayload(method: string, key: string, expires: number): string {
  return `${method.toUpperCase()}\n/${key}\n${expires}`;
}

export async function signUrlWithSecret(secret: string, method: string, key: string, expires: number): Promise<string> {
  return hmacHex(secret, signedUrlPayload(method, key, expires));
}

export async function verifyUrlSignature(secret: string, method: string, key: string, expires: number, signature: string): Promise<boolean> {
  return timingSafeEqual(await signUrlWithSecret(secret, method, key, expires), signature);
}

/** Mint a res-signed download URL on the home host for a protected key. */
export async function mintSignedUrl(db: AppDatabase, config: Pick<Config, "RES_KEY_KEK" | "RES_HOME_URL" | "RES_SIGNED_URL_MAX_TTL_SECONDS">, input: { id: string; namespace: string; path: string; ttlSeconds: number }) {
  const row = await db.select().from(resAccessKeys).where(eq(resAccessKeys.id, input.id)).get();
  if (!activeKey(row, new Date()))
    throw new NotFoundError("access key", input.id);
  if (!grantsAllow(JSON.parse(row.grants) as Grant[], input.namespace, input.path))
    throw new AppError("The key does not grant this path", 403, "FORBIDDEN");
  const ttl = Math.min(input.ttlSeconds, config.RES_SIGNED_URL_MAX_TTL_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const key = `${input.namespace}/${input.path}`;
  const signature = await signUrlWithSecret(await openSecret(config.RES_KEY_KEK, row.secretSealed), "GET", key, expires);
  const url = new URL(`${config.RES_HOME_URL.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("X-Res-Key", row.id);
  url.searchParams.set("X-Res-Expires", String(expires));
  url.searchParams.set("X-Res-Signature", signature);
  return { url: url.toString(), expiresAt: new Date(expires * 1000).toISOString() };
}

/** Write the active keys to the protected bucket for the edge. */
export async function publishAccessSnapshot(db: AppDatabase): Promise<void> {
  const at = new Date();
  const rows = await db.select().from(resAccessKeys).where(isNull(resAccessKeys.revokedAt)).all();
  const snapshot: AccessSnapshot = {
    schema: ACCESS_SNAPSHOT_SCHEMA,
    publishedAt: at.toISOString(),
    keys: rows.filter(r => activeKey(r, at)).map(r => ({
      id: r.id,
      secretHash: r.secretHash,
      secretSealed: r.secretSealed,
      grants: JSON.parse(r.grants) as Grant[],
      expiresAt: r.expiresAt,
    })),
  };
  const text = `${JSON.stringify(snapshot)}\n`;
  await getStore(PROTECT_BINDING).putText(ACCESS_SNAPSHOT_KEY, text, { sha256: await sha256Hex(text), contentType: "application/json", cacheControl: "no-store" });
}
