import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Namespace { name: string; visibility: string }

// On Bun the buckets are in memory (no R2 binding), so these cover the control
// plane's contract end to end; the byte paths are covered by the unit suites
// and the workerd smoke test.
describe("/api/res (resource service control plane)", () => {
  it("seeds the normative namespaces and lists them for any signed-in user", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.json<{ data: Namespace[] }>("/api/res/namespaces");
    expect(res.data.map(n => n.name)).toEqual(expect.arrayContaining(["brand", "docs", "mica", "oci", "status", "upstream"]));
  });

  it("lets an admin create a protected namespace and publish the catalog", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const name = `e2e-${Date.now()}`;
    const created = await admin.raw("/api/res/namespaces", { method: "POST", body: { name, store: "protect", title: "E2E vault" } });
    expect(created.status).toBe(201);
    const published = await admin.json<{ data: { catalog: string } }>("/api/res/catalog/publish", { method: "POST" });
    expect(published.data.catalog).toBe("published");
  });

  it("refuses a reserved namespace name", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const res = await admin.raw("/api/res/namespaces", { method: "POST", body: { name: "admin", store: "public", title: "x" } });
    expect(res.status).toBe(422);
  });

  it("starts an upload with a presigned URL and answers a delete dry run", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const upload = await admin.json<{ data: { id: string; url: string } }>("/api/res/namespaces/brand/uploads", {
      method: "POST",
      body: { sha256: "a".repeat(64), size: 3, contentType: "text/plain" },
    });
    expect(upload.data.url).toContain("_staging/");
    const dry = await admin.json<{ data: { count: number } }>("/api/res/namespaces/brand/objects/delete", {
      method: "POST",
      body: { prefix: "nothing/", reason: "e2e", dryRun: true },
    });
    expect(dry.data.count).toBe(0);
  });

  it("keeps publishing, deleting and access keys away from a non-admin", async () => {
    const user = await getClient("user@example.com", "admin");
    const upload = await user.raw("/api/res/namespaces/brand/uploads", { method: "POST", body: { sha256: "a".repeat(64), size: 3, contentType: "text/plain" } });
    expect(upload.status).toBe(403);
    const del = await user.raw("/api/res/namespaces/brand/objects/delete", { method: "POST", body: { prefix: "", reason: "x", dryRun: true } });
    expect(del.status).toBe(403);
    const keys = await user.raw("/api/res/access-keys");
    expect(keys.status).toBe(403);
  });
});
