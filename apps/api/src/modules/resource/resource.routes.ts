import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { hasVerifiedTotp, validateStepUpToken } from "@/modules/account/users/totp.service";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { createAccessKey, listAccessKeys, mintSignedUrl, publishAccessSnapshot, revokeAccessKey } from "./access/keys";
import { CACHE_POLICIES } from "./cache-policy";
import { importV1 } from "./import-v1";
import { republish, setSiteSettings, siteSettings } from "./publisher";
import { processPurges, retryPurge } from "./purge";
import {
  createNamespace,
  createUpload,
  deleteAlias,
  deleteObjects,
  enqueuePurge,
  getNamespace,
  listAliases,
  listNamespaces,
  listObjects,
  listPurges,
  listStores,
  publicUrl,
  publishObject,
  pullUpload,
  purgeNow,
  restoreObject,
  setAlias,
  setOciTag,
  setRedirect,
  updateNamespace,
} from "./resource.service";

const nameParam = z.object({ name: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
const cachePolicy = z.enum(CACHE_POLICIES);

const namespaceFields = {
  title: z.string().min(1).max(200),
  description: z.string().max(2000),
  listable: z.boolean(),
  immutable: z.boolean(),
  siteMode: z.boolean(),
  cachePolicy,
  examples: z.array(z.string().max(1024)).max(20),
};

const createNamespaceBody = z.object({
  name: z.string(),
  store: z.string(),
  ...namespaceFields,
}).partial({ description: true, listable: true, immutable: true, siteMode: true, cachePolicy: true, examples: true });

const updateNamespaceBody = z.object(namespaceFields).partial();

const objectSource = z.union([
  z.object({ uploadId: z.string().min(1) }),
  z.object({ sha256 }),
]);

const publishBody = z.object({
  path: z.string().min(1).max(1024),
  source: objectSource,
  contentType: z.string().min(1).max(200).optional(),
  cachePolicy: cachePolicy.nullable().optional(),
  meta: z.record(z.string(), z.string().max(8192)).optional(),
});

const aliasBody = z.object({ path: z.string().min(1).max(1024), target: z.string().min(1).max(1024) });

const batchBody = z.object({
  objects: z.array(publishBody).max(500).default([]),
  aliases: z.array(aliasBody).max(500).default([]),
});

const listQuery = z.object({
  prefix: z.string().max(1024).optional(),
  deleted: z.enum(["exclude", "include", "only"]).optional(),
  after: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

const deleteBody = z.object({
  path: z.string().min(1).max(1024).optional(),
  prefix: z.string().max(1024).optional(),
  reason: z.string().min(1).max(500),
  dryRun: z.boolean().optional(),
});

function source(s: z.infer<typeof objectSource>) {
  return "uploadId" in s ? { kind: "upload" as const, uploadId: s.uploadId } : { kind: "sha256" as const, sha256: s.sha256 };
}

async function record(c: Context<AppEnv>, action: string, resourceType: string, resourceId: string, detail?: Record<string, unknown>) {
  const actor = c.get("user")!;
  await audit(c.get("db"), c.get("logger"), {
    actorId: actor.id,
    actorName: actor.name,
    action,
    resourceType,
    resourceId,
    resourceName: resourceId,
    detail,
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
    result: "success",
  });
}

/** Publish the catalog and queue CDN purges after a committed change. */
async function commit(c: Context<AppEnv>, purge: readonly string[] = []): Promise<"published" | "pending"> {
  const db = c.get("db");
  await enqueuePurge(db, purge);
  return republish(db, c.get("config"), c.get("logger"));
}

/**
 * Deleting is the one irreversible operation. An admin with TOTP enrolled
 * must present a fresh step-up token, like enrolling another device.
 */
async function requireStepUp(c: Context<AppEnv>): Promise<void> {
  const user = c.get("user")!;
  if (!(await hasVerifiedTotp(c.get("db"), user.id)))
    return;
  const token = c.req.header("x-totp-token");
  if (!token || !(await validateStepUpToken(token, user.id)))
    throw new AppError("This action needs a fresh TOTP step-up token in x-totp-token", 403, "STEP_UP_REQUIRED");
}

export function resourceRoutes() {
  const router = new Hono<AppEnv>();
  router.use("/res/*", authRequired);

  const doc = (summary: string, responses: ReturnType<typeof errors>) => describeRoute({ tags: [TAGS.Resource], summary, security: SECURITY.session, responses });

  // ─── Stores and namespaces ───

  router.get("/res/stores", doc("List stores", { ...jsonOk(), ...errors(401, 403) }), adminRequired, async (c) => {
    return c.json({ success: true, data: await listStores(c.get("db")) });
  });

  router.get("/res/namespaces", doc("List namespaces", { ...jsonOk(), ...errors(401) }), async (c) => {
    const rows = await listNamespaces(c.get("db"));
    return c.json({ success: true, data: rows.map(r => ({ ...r, examples: JSON.parse(r.examples) as string[] })) });
  });

  router.post("/res/namespaces", doc("Create a namespace", { ...jsonCreated(), ...errors(401, 403, 404, 409, 422) }), adminRequired, validator("json", createNamespaceBody), async (c) => {
    const body = c.req.valid("json");
    const namespace = await createNamespace(c.get("db"), body);
    await record(c, "res.namespace.created", "res-namespace", namespace.name, { store: body.store });
    const catalog = await commit(c);
    return c.json({ success: true, data: { namespace, catalog } }, 201);
  });

  router.get("/res/namespaces/:name", doc("Get a namespace", { ...jsonOk(), ...errors(401, 403, 404) }), validator("param", nameParam), async (c) => {
    const { namespace, store } = await getNamespace(c.get("db"), c.req.valid("param").name);
    return c.json({ success: true, data: { ...namespace, examples: JSON.parse(namespace.examples) as string[], store } });
  });

  router.patch("/res/namespaces/:name", doc("Update a namespace", { ...jsonOk(), ...errors(401, 403, 404, 422) }), validator("param", nameParam), validator("json", updateNamespaceBody), async (c) => {
    const { name } = c.req.valid("param");
    const result = await updateNamespace(c.get("db"), name, c.req.valid("json"));
    await record(c, "res.namespace.updated", "res-namespace", name, { changes: c.req.valid("json"), staleObjects: result.staleObjects });
    const catalog = await commit(c);
    return c.json({ success: true, data: { ...result, catalog } });
  });

  // ─── Objects ───

  router.get("/res/namespaces/:name/objects", doc("List objects", { ...jsonOk(), ...errors(401, 403, 404) }), validator("param", nameParam), validator("query", listQuery), async (c) => {
    const { name } = c.req.valid("param");
    const db = c.get("db");
    const { store } = await getNamespace(db, name);
    const rows = await listObjects(db, name, c.req.valid("query"));
    return c.json({ success: true, data: rows.map(r => ({ ...r, meta: JSON.parse(r.meta) as Record<string, string>, url: publicUrl(store, `${name}/${r.path}`) })) });
  });

  router.put("/res/namespaces/:name/objects", doc("Publish an object", { ...jsonOk(), ...errors(401, 403, 404, 409, 422) }), validator("param", nameParam), validator("json", publishBody), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const result = await publishObject(c.get("db"), { ...body, namespace: name, source: source(body.source), actorId: c.get("user")!.id });
    if (result.outcome !== "unchanged")
      await record(c, `res.object.${result.outcome}`, "res-object", `${name}/${body.path}`, { sha256: result.object.sha256 });
    const catalog = result.outcome === "unchanged" ? "published" : await commit(c, result.purge);
    return c.json({ success: true, data: { object: result.object, outcome: result.outcome, catalog } });
  });

  router.post("/res/namespaces/:name/batch", doc("Publish objects and aliases in one snapshot", { ...jsonOk(), ...errors(401, 403, 404, 409, 422) }), validator("param", nameParam), validator("json", batchBody), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = c.get("db");
    const actorId = c.get("user")!.id;
    const outcomes: { path: string; outcome: string }[] = [];
    const purge: string[] = [];
    for (const item of body.objects) {
      const result = await publishObject(db, { ...item, namespace: name, source: source(item.source), actorId });
      outcomes.push({ path: item.path, outcome: result.outcome });
      purge.push(...result.purge);
    }
    for (const alias of body.aliases)
      await setAlias(db, { namespace: name, path: alias.path, targetPath: alias.target });
    const changed = outcomes.filter(o => o.outcome !== "unchanged").length + body.aliases.length;
    if (changed > 0)
      await record(c, "res.batch.published", "res-namespace", name, { objects: outcomes.length, changed, aliases: body.aliases.length });
    const catalog = changed > 0 ? await commit(c, purge) : "published";
    return c.json({ success: true, data: { objects: outcomes, aliases: body.aliases.length, catalog } });
  });

  router.post("/res/namespaces/:name/uploads", doc("Start an upload (presigned PUT)", { ...jsonCreated(), ...errors(401, 403, 404, 422, 503) }), validator("param", nameParam), validator("json", z.object({ sha256, size: z.number().int().positive(), contentType: z.string().min(1).max(200) })), async (c) => {
    await getNamespace(c.get("db"), c.req.valid("param").name);
    const upload = await createUpload(c.get("db"), c.get("config"), { ...c.req.valid("json"), actorId: c.get("user")!.id });
    return c.json({ success: true, data: upload }, 201);
  });

  router.post("/res/namespaces/:name/uploads/pull", doc("Pull an origin into a staged upload", { ...jsonCreated(), ...errors(400, 401, 403, 404, 409, 422, 502) }), validator("param", nameParam), validator("json", z.object({ origin: z.string().url().max(4096), sha256, contentType: z.string().min(1).max(200) })), async (c) => {
    await getNamespace(c.get("db"), c.req.valid("param").name);
    const upload = await pullUpload(c.get("db"), c.get("config"), { ...c.req.valid("json"), actorId: c.get("user")!.id });
    return c.json({ success: true, data: upload }, 201);
  });

  router.post("/res/namespaces/:name/objects/delete", doc("Delete objects (soft, with a grace period)", { ...jsonOk(), ...errors(401, 403, 404, 422) }), adminRequired, validator("param", nameParam), validator("json", deleteBody), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!body.dryRun)
      await requireStepUp(c);
    const result = await deleteObjects(c.get("db"), c.get("config"), { ...body, namespace: name });
    if (body.dryRun || result.count === 0)
      return c.json({ success: true, data: { ...result, dryRun: body.dryRun ?? false } });
    await record(c, "res.object.deleted", "res-namespace", name, { count: result.count, path: body.path, prefix: body.prefix, reason: body.reason });
    const catalog = await commit(c);
    return c.json({ success: true, data: { ...result, dryRun: false, catalog } });
  });

  router.post("/res/namespaces/:name/objects/restore", doc("Restore a deleted object", { ...jsonOk(), ...errors(401, 403, 404) }), adminRequired, validator("param", nameParam), validator("json", z.object({ path: z.string().min(1) })), async (c) => {
    const { name } = c.req.valid("param");
    const { path } = c.req.valid("json");
    const object = await restoreObject(c.get("db"), name, path);
    await record(c, "res.object.restored", "res-object", `${name}/${path}`);
    const catalog = await commit(c);
    return c.json({ success: true, data: { object, catalog } });
  });

  router.post("/res/namespaces/:name/objects/purge", doc("Remove a deleted object's bytes at the next sweep", { ...jsonOk(), ...errors(401, 403, 404, 409) }), adminRequired, validator("param", nameParam), validator("json", z.object({ path: z.string().min(1) })), async (c) => {
    await requireStepUp(c);
    const { name } = c.req.valid("param");
    const { path } = c.req.valid("json");
    const object = await purgeNow(c.get("db"), name, path);
    await record(c, "res.object.purge_requested", "res-object", `${name}/${path}`);
    return c.json({ success: true, data: object });
  });

  // ─── Aliases, OCI tags, redirects ───

  router.get("/res/namespaces/:name/aliases", doc("List aliases", { ...jsonOk(), ...errors(401, 403) }), validator("param", nameParam), async (c) => {
    return c.json({ success: true, data: await listAliases(c.get("db"), c.req.valid("param").name) });
  });

  router.put("/res/namespaces/:name/aliases", doc("Set an alias", { ...jsonOk(), ...errors(401, 403, 404, 409, 422) }), validator("param", nameParam), validator("json", aliasBody), async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    await setAlias(c.get("db"), { namespace: name, path: body.path, targetPath: body.target });
    await record(c, "res.alias.set", "res-alias", `${name}/${body.path}`, { target: body.target });
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  router.post("/res/namespaces/:name/aliases/delete", doc("Delete an alias", { ...jsonOk(), ...errors(401, 403, 404) }), validator("param", nameParam), validator("json", z.object({ path: z.string().min(1) })), async (c) => {
    const { name } = c.req.valid("param");
    const { path } = c.req.valid("json");
    if (!(await deleteAlias(c.get("db"), name, path)))
      throw new AppError(`No alias ${name}/${path}`, 404, "NOT_FOUND");
    await record(c, "res.alias.deleted", "res-alias", `${name}/${path}`);
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  router.put("/res/namespaces/:name/oci-tags", doc("Point a registry tag at a manifest", { ...jsonOk(), ...errors(401, 403, 409, 422) }), validator("param", nameParam), validator("json", z.object({ repository: z.string(), tag: z.string(), digest: z.string() })), async (c) => {
    if (c.req.valid("param").name !== "oci")
      throw new AppError("Registry tags live in the oci namespace", 422, "VALIDATION_ERROR");
    const body = c.req.valid("json");
    await setOciTag(c.get("db"), body);
    await record(c, "res.oci_tag.set", "res-oci-tag", `${body.repository}:${body.tag}`, { digest: body.digest });
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  router.put("/res/redirects", doc("Set a legacy /d/ redirect", { ...jsonOk(), ...errors(401, 403, 422) }), adminRequired, validator("json", z.object({ fromPath: z.string(), targetKey: z.string() })), async (c) => {
    const body = c.req.valid("json");
    await setRedirect(c.get("db"), body.fromPath, body.targetKey);
    await record(c, "res.redirect.set", "res-redirect", body.fromPath, { targetKey: body.targetKey });
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  // ─── Site, catalog, purges, import ───

  router.get("/res/site", doc("Get the home page text", { ...jsonOk(), ...errors(401) }), async (c) => {
    return c.json({ success: true, data: await siteSettings(c.get("db"), c.get("config")) });
  });

  router.put("/res/site", doc("Set the home page text", { ...jsonOk(), ...errors(401, 403, 422) }), adminRequired, validator("json", z.object({ title: z.string().min(1).max(200).optional(), description: z.string().max(4000).optional() })), async (c) => {
    await setSiteSettings(c.get("db"), c.req.valid("json"), c.get("user")!.id);
    await record(c, "res.site.updated", "res-site", "site");
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  router.post("/res/catalog/publish", doc("Publish the catalog now", { ...jsonOk(), ...errors(401, 403) }), adminRequired, async (c) => {
    return c.json({ success: true, data: { catalog: await commit(c) } });
  });

  router.get("/res/purges", doc("List CDN purges", { ...jsonOk(), ...errors(401, 403) }), adminRequired, validator("query", z.object({ state: z.enum(["pending", "done", "skipped"]).optional() })), async (c) => {
    const rows = await listPurges(c.get("db"), c.req.valid("query").state);
    return c.json({ success: true, data: rows.map(r => ({ ...r, urls: JSON.parse(r.urls) as string[] })) });
  });

  router.post("/res/purges/:id/retry", doc("Retry a CDN purge", { ...jsonOk(), ...errors(401, 403, 404) }), adminRequired, validator("param", idParam), async (c) => {
    const db = c.get("db");
    if (!(await retryPurge(db, c.req.valid("param").id)))
      throw new AppError("No such purge", 404, "NOT_FOUND");
    return c.json({ success: true, data: await processPurges(db, c.get("config")) });
  });

  router.post("/res/imports/v1", doc("Import a page of the v1 mirror index", { ...jsonOk(), ...errors(401, 403, 404, 422) }), adminRequired, validator("json", z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) })), async (c) => {
    const body = c.req.valid("json");
    const progress = await importV1(c.get("db"), { ...body, actorId: c.get("user")!.id });
    await record(c, "res.import.v1", "res-import", progress.version, { offset: body.offset, created: progress.created, failed: progress.failed.length });
    const catalog = progress.created > 0 || progress.next === null ? await commit(c) : "pending";
    return c.json({ success: true, data: { ...progress, catalog } });
  });

  // ─── Access keys ───

  router.get("/res/access-keys", doc("List access keys", { ...jsonOk(), ...errors(401, 403) }), adminRequired, async (c) => {
    return c.json({ success: true, data: await listAccessKeys(c.get("db")) });
  });

  router.post("/res/access-keys", doc("Create an access key (the secret is shown once)", { ...jsonCreated(), ...errors(401, 403, 404, 422, 503) }), adminRequired, validator("json", z.object({
    name: z.string().min(1).max(200),
    grants: z.array(z.object({ namespace: z.string(), prefix: z.string().default("") })).min(1).max(50),
    expiresAt: z.string().datetime().optional(),
  })), async (c) => {
    const db = c.get("db");
    const created = await createAccessKey(db, c.get("config"), { ...c.req.valid("json"), actorId: c.get("user")!.id });
    await publishAccessSnapshot(db);
    await record(c, "res.access_key.created", "res-access-key", created.key.id, { grants: created.key.grants });
    return c.json({ success: true, data: created }, 201);
  });

  router.post("/res/access-keys/:id/revoke", doc("Revoke an access key", { ...jsonOk(), ...errors(401, 403, 404) }), adminRequired, validator("param", idParam), async (c) => {
    const db = c.get("db");
    const { id } = c.req.valid("param");
    await revokeAccessKey(db, id);
    await publishAccessSnapshot(db);
    await record(c, "res.access_key.revoked", "res-access-key", id);
    return c.json({ success: true, data: null });
  });

  router.post("/res/access-keys/:id/sign", doc("Mint a signed download URL", { ...jsonOk(), ...errors(401, 403, 404, 503) }), adminRequired, validator("param", idParam), validator("json", z.object({ namespace: z.string(), path: z.string().min(1), ttlSeconds: z.number().int().min(60).default(3600) })), async (c) => {
    const signed = await mintSignedUrl(c.get("db"), c.get("config"), { ...c.req.valid("json"), id: c.req.valid("param").id });
    return c.json({ success: true, data: signed });
  });

  return router;
}
