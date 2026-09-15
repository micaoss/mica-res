import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Document { id: string }
interface Attachment { id: string; fileId: string; filename: string; size: number; mimetype: string }

// The generic file routes are the second door into every attachment blob:
// `/api/files/:fileId/{metadata,content}?ref=<referenceId>`. They authorise
// through the owner type's permission hook, so they must agree with the
// owning module's own routes.
describe("/api/files/:id — generic download path", () => {
  it("serves metadata + content for a reference the caller may read, and 404s on a bad ref", async () => {
    const user = await getClient("user@example.com", "admin");

    const doc = await user.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "files-e2e", content: "blob owner" },
    });
    const docId = doc.data.id;

    const fd = new FormData();
    fd.append("file", new File(["hello files route"], "hello.txt", { type: "text/plain" }));
    const upload = await user.raw(`/api/documents/${docId}/attachments`, { method: "POST", formData: fd });
    expect(upload.status).toBe(201);
    const att = (await upload.json() as { data: Attachment }).data;
    expect(att.fileId).toBeTruthy();

    const meta = await user.raw(`/api/files/${att.fileId}/metadata?ref=${att.id}`);
    expect(meta.status).toBe(200);
    const metaBody = await meta.json() as { data: { id: string; filename: string; size: number } };
    expect(metaBody.data.id).toBe(att.fileId);
    expect(metaBody.data.filename).toBe("hello.txt");

    const content = await user.raw(`/api/files/${att.fileId}/content?ref=${att.id}`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("hello files route");

    // No ref → the route cannot authorise → rejected, never served.
    expect((await user.raw(`/api/files/${att.fileId}/metadata`)).status).not.toBe(200);
    // A ref that does not belong to this file → 404 (no existence leak).
    expect((await user.raw(`/api/files/${att.fileId}/metadata?ref=does-not-exist`)).status).toBe(404);

    await user.raw(`/api/documents/${docId}`, { method: "DELETE" });
  });
});
