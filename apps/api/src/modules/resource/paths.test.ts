import { describe, expect, test } from "bun:test";
import { cacheControlFor, effectivePolicy, isCachePolicy } from "./cache-policy";
import { encodeKeyPath, isValidDirectoryPrefix, isValidNamespaceName, objectPathProblem, splitKey } from "./paths";

describe("namespace names", () => {
  test("accept S3-valid bucket names", () => {
    expect(isValidNamespaceName("mica")).toBe(true);
    expect(isValidNamespaceName("protect-res")).toBe(true);
  });

  test("refuse reserved first segments, bad shapes and doubled dashes", () => {
    for (const name of ["admin", "v2", "blob", "d", "index", "_site", "Mica", "a", "-mica", "mica-", "mi--ca", "mi.ca"])
      expect(isValidNamespaceName(name)).toBe(false);
  });
});

describe("object paths", () => {
  test("accept the normative shapes", () => {
    expect(objectPathProblem("mica", "uefi-x64/20260916-0845/mica-uefi-x64-dev-20260916-0845.img.gz")).toBeNull();
    expect(objectPathProblem("upstream", "debian/pool/main/b/bash/bash_5.3-1+b1_amd64.deb")).toBeNull();
    expect(objectPathProblem("oci", "blobs/sha256/aa")).toBeNull();
    expect(objectPathProblem("docs", "readme.md")).toBeNull();
  });

  test("refuse empty, relative and odd segments", () => {
    expect(objectPathProblem("mica", "")).not.toBeNull();
    expect(objectPathProblem("mica", "a//b")).not.toBeNull();
    expect(objectPathProblem("mica", "a/../b")).not.toBeNull();
    expect(objectPathProblem("mica", "a/b c")).not.toBeNull();
    expect(objectPathProblem("mica", "a/.hidden")).not.toBeNull();
    expect(objectPathProblem("mica", "a/b/")).not.toBeNull();
  });

  test("require a lowercase first directory but allow mixed-case file names", () => {
    expect(objectPathProblem("mica", "Scope/file")).not.toBeNull();
    expect(objectPathProblem("mica", "README.md")).toBeNull();
    expect(objectPathProblem("mica", "scope/README.md")).toBeNull();
  });

  test("refuse a reserved namespace and an over-long key", () => {
    expect(objectPathProblem("admin", "x")).not.toBeNull();
    expect(objectPathProblem("mica", `${"a".repeat(1100)}`)).not.toBeNull();
    expect(objectPathProblem("mica", Array.from({ length: 17 }).fill("a").join("/"))).not.toBeNull();
  });
});

describe("keys and prefixes", () => {
  test("split a key at its first slash", () => {
    expect(splitKey("mica/a/b")).toEqual({ namespace: "mica", path: "a/b" });
    expect(splitKey("mica")).toBeNull();
    expect(splitKey("mica/")).toBeNull();
  });

  test("validate directory prefixes", () => {
    expect(isValidDirectoryPrefix("")).toBe(true);
    expect(isValidDirectoryPrefix("a/b/")).toBe(true);
    expect(isValidDirectoryPrefix("a/b")).toBe(false);
    expect(isValidDirectoryPrefix("a/../")).toBe(false);
  });

  test("encode each segment for a URL path", () => {
    expect(encodeKeyPath("upstream/debian/pool/x+y~z (1)!.deb")).toBe("upstream/debian/pool/x%2By~z%20%281%29%21.deb");
  });
});

describe("cache policy", () => {
  test("maps each policy to its cache-control", () => {
    expect(cacheControlFor("immutable")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("no-store")).toBe("no-store");
    expect(isCachePolicy("standard")).toBe(true);
    expect(isCachePolicy("forever")).toBe(false);
  });

  test("an object override wins over its namespace", () => {
    expect(effectivePolicy("immutable", "short")).toBe("short");
    expect(effectivePolicy("immutable", null)).toBe("immutable");
  });
});
