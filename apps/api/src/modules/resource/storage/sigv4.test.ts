import { describe, expect, test } from "bun:test";
import { EMPTY_SHA256, presignUrl, signCanonical, signHeaders, timingSafeEqual } from "./sigv4";

// The worked examples of the Amazon S3 documentation ("Signature Calculations
// for the Authorization Header" and "Authenticating Requests: Using Query
// Parameters"), so the signer is checked against AWS rather than against
// itself.
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const scope = { region: "us-east-1", service: "s3" };
const now = new Date("2013-05-24T00:00:00Z");

describe("SigV4", () => {
  test("signs the documented GET Object example with an Authorization header", async () => {
    const headers = await signHeaders({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      credentials,
      scope,
      now,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
      + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
  });

  test("presigns the documented query-parameter example", async () => {
    const url = await presignUrl({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      expiresSeconds: 86400,
      credentials,
      scope,
      now,
    });
    expect(url).toContain("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
    expect(url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
  });

  test("a verifier recomputes the same signature from the parsed request", async () => {
    const headers = await signHeaders({
      method: "GET",
      url: new URL("https://s3.example.test/bucket/a%20b.txt?list-type=2&prefix=a%2Fb"),
      credentials,
      scope: { region: "auto", service: "s3" },
      now,
    });
    const signature = headers.authorization!.split("Signature=")[1]!;
    const recomputed = await signCanonical({
      method: "GET",
      path: "/bucket/a%20b.txt",
      query: [["prefix", "a/b"], ["list-type", "2"]],
      headers: { "host": "s3.example.test", "x-amz-date": headers["x-amz-date"]!, "x-amz-content-sha256": headers["x-amz-content-sha256"]! },
      payloadHash: headers["x-amz-content-sha256"]!,
    }, credentials, { region: "auto", service: "s3" }, headers["x-amz-date"]!);
    expect(recomputed.signature).toBe(signature);
  });

  test("compares in constant time", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
  });
});
