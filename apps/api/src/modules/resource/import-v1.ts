/**
 * One-off, resumable import of the v1 mirror (`mica/resource-index/v1`):
 * every mirrored blob is copied server-side from `blob/<aa>/<sha256>` to its
 * readable key, recorded as an object, and each of its other v1 names becomes
 * a redirect or a registry tag. No byte leaves R2.
 */
import type { AppDatabase } from "@/db";
import { AppError } from "@/shared/lib/errors";
import { objectPathProblem, splitKey } from "./paths";
import { contentTypeFor, getLiveObject, getNamespace, listStores, PUBLIC_BINDING, PUBLIC_STORE, publishObject, setOciTag, setRedirect } from "./resource.service";
import { getStore } from "./storage/registry";

export interface V1Object {
  readonly kind: string;
  readonly state?: string;
  readonly sha256: string;
  readonly size?: number;
  readonly mediaType?: string;
  readonly commit?: string;
  readonly origin?: string;
  readonly path: string;
  readonly readable: readonly string[];
  readonly pins?: readonly unknown[];
}

export interface V1Plan {
  readonly key: string;
  readonly contentType: string;
  readonly meta: Record<string, string>;
  readonly redirects: readonly { fromPath: string; targetKey: string }[];
  readonly tags: readonly { repository: string; tag: string; digest: string }[];
}

const RE_MANIFEST_TAG = /^\/v2\/(.+)\/manifests\/([^/]+)$/;

/** Where a v1 object goes, or why it cannot. */
export function planV1Object(object: V1Object): V1Plan | { skip: string } {
  if (object.state !== "mirrored")
    return { skip: "not mirrored" };
  const meta: Record<string, string> = { kind: object.kind };
  if (object.origin)
    meta.origin = object.origin;
  if (object.commit)
    meta.commit = object.commit;
  if (object.pins)
    meta.pins = JSON.stringify(object.pins);

  const tags = object.readable
    .map(r => RE_MANIFEST_TAG.exec(r))
    .filter((m): m is RegExpExecArray => m !== null && !m[2]!.startsWith("sha256:"))
    .map(m => ({ repository: m[1]!, tag: m[2]!, digest: `sha256:${object.sha256}` }));

  if (object.kind === "oci-blob") {
    return {
      key: `oci/blobs/sha256/${object.sha256}`,
      contentType: object.mediaType ?? "application/octet-stream",
      meta,
      redirects: [],
      tags,
    };
  }

  const names = object.readable.filter(r => r.startsWith("/d/")).toSorted();
  const canonical = names.find(n => n.startsWith("/d/upstream/debian/pool/")) ?? names[0];
  if (!canonical)
    return { skip: "no readable /d/ name" };
  const key = canonical.slice("/d/".length);
  const parts = splitKey(key);
  const problem = parts ? objectPathProblem(parts.namespace, parts.path) : "no path below the namespace";
  if (problem)
    return { skip: `${key}: ${problem}` };
  return {
    key,
    contentType: object.mediaType ?? contentTypeFor(key),
    meta,
    redirects: names.filter(n => n !== canonical).map(fromPath => ({ fromPath, targetKey: key })),
    tags,
  };
}

export interface ImportProgress {
  readonly version: string;
  readonly total: number;
  readonly next: number | null;
  readonly created: number;
  readonly unchanged: number;
  readonly skipped: readonly string[];
  readonly failed: readonly string[];
}

export async function importV1(db: AppDatabase, input: { offset: number; limit: number; actorId: string }): Promise<ImportProgress> {
  const store = getStore(PUBLIC_BINDING);
  const pointerText = await store.getText("index/current.json");
  if (!pointerText)
    throw new AppError("The v1 index pointer index/current.json is not in the public bucket", 404, "NOT_FOUND");
  const pointer = JSON.parse(pointerText) as { version: string };
  const snapshotText = await store.getText(`index/${pointer.version}.json`);
  if (!snapshotText)
    throw new AppError(`The v1 snapshot index/${pointer.version}.json is missing`, 404, "NOT_FOUND");
  const document = JSON.parse(snapshotText) as { schema: string; objects: V1Object[] };
  if (document.schema !== "mica/resource-index/v1")
    throw new AppError(`${document.schema} is not mica/resource-index/v1`, 422, "VALIDATION_ERROR");

  const bucket = (await listStores(db)).find(s => s.name === PUBLIC_STORE)?.bucket;
  if (!bucket)
    throw new AppError("The public store is not configured", 503, "STORE_UNAVAILABLE");

  const slice = document.objects.slice(input.offset, input.offset + input.limit);
  let created = 0;
  let unchanged = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const object of slice) {
    const plan = planV1Object(object);
    if ("skip" in plan) {
      skipped.push(`${object.sha256}: ${plan.skip}`);
      continue;
    }
    const { namespace, path } = splitKey(plan.key)!;
    try {
      const { store: nsStore } = await getNamespace(db, namespace);
      if (nsStore.name !== PUBLIC_STORE)
        throw new Error(`namespace ${namespace} is not in the public store`);
      const live = await getLiveObject(db, namespace, path);
      if (live?.sha256 === object.sha256) {
        unchanged++;
      }
      else {
        await getStore(PUBLIC_BINDING).copyFrom({ bucket, key: object.path }, plan.key, {
          sha256: object.sha256,
          contentType: plan.contentType,
          cacheControl: "public, max-age=31536000, immutable",
        });
        const result = await publishObject(db, {
          namespace,
          path,
          source: { kind: "in-place", sha256: object.sha256 },
          contentType: plan.contentType,
          meta: plan.meta,
          actorId: input.actorId,
        });
        if (result.outcome === "created")
          created++;
        else
          unchanged++;
      }
      for (const r of plan.redirects)
        await setRedirect(db, r.fromPath, r.targetKey);
      for (const t of plan.tags)
        await setOciTag(db, t);
    }
    catch (err) {
      failed.push(`${plan.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const end = input.offset + slice.length;
  return {
    version: pointer.version,
    total: document.objects.length,
    next: end < document.objects.length ? end : null,
    created,
    unchanged,
    skipped,
    failed,
  };
}
