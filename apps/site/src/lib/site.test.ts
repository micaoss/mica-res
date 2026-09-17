import type { SiteDocument } from "./site";
import { describe, expect, it } from "vitest";
import { detectLang, messages } from "./i18n";
import { exampleHref, formatBytes, snippets } from "./site";

const doc: SiteDocument = {
  site: { title: "t", description: "d", download: "https://dl.res.micaos.dev", s3: "https://s3.res.micaos.dev", home: "https://res.micaos.dev" },
  namespaces: [
    { name: "vault", title: "V", description: "", visibility: "protected", listable: true, objects: null, bytes: null, examples: [] },
    { name: "mica", title: "M", description: "", visibility: "public", listable: true, objects: 3, bytes: 30, examples: ["mica/uefi-x64/20260917-0000/"] },
  ],
  registry: ["micaoss/mica-build-env"],
  snapshot: { version: "v", publishedAt: "2026-09-17T00:00:00.000Z" },
};

describe("site helpers", () => {
  it("formats sizes in binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GiB");
  });

  it("builds snippets from the live hosts and the first public example", () => {
    const byId = Object.fromEntries(snippets(doc).map(s => [s.id, s.command]));
    expect(byId.curl).toBe("curl -fLO https://dl.res.micaos.dev/mica/uefi-x64/20260917-0000/<file>");
    expect(byId.s3).toBe("aws s3 ls --no-sign-request --endpoint-url https://s3.res.micaos.dev s3://mica/uefi-x64/20260917-0000/");
    expect(byId.docker).toBe("docker pull res.micaos.dev/micaoss/mica-build-env:<tag>");
  });

  it("omits the registry snippet when nothing is mirrored and falls back to a namespace root", () => {
    const bare = { ...doc, registry: [], namespaces: [{ ...doc.namespaces[1]!, examples: [] }] };
    const ids = snippets(bare).map(s => s.id);
    expect(ids).not.toContain("docker");
    expect(snippets(bare).find(s => s.id === "curl")!.command).toBe("curl -fLO https://dl.res.micaos.dev/mica/<file>");
  });

  it("links a directory to its listing and a file to its download", () => {
    expect(exampleHref(doc, "mica/a/")).toBe("/mica/a/");
    expect(exampleHref(doc, "mica/a/b.img")).toBe("https://dl.res.micaos.dev/mica/a/b.img");
  });

  it("picks the stored language, else the browser's", () => {
    expect(detectLang("en", ["zh-CN"])).toBe("en");
    expect(detectLang(null, ["zh-CN", "en"])).toBe("zh");
    expect(detectLang(null, ["de"])).toBe("en");
    expect(messages("zh").namespaces).toBe("命名空间");
  });
});
