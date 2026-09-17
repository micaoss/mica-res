import { describe, expect, it } from "vitest";
import { HttpError } from "@/shared/lib/http";
import { formatBytes, needsStepUp, parseGrants } from "./-resources-api";

describe("resources api helpers", () => {
  it("parses one namespace:prefix grant per line", () => {
    expect(parseGrants("vault:team/\n\n  archive  \nvault : ops/ ")).toEqual([
      { namespace: "vault", prefix: "team/" },
      { namespace: "archive", prefix: "" },
      { namespace: "vault", prefix: "ops/" },
    ]);
  });

  it("recognises the step-up refusal and nothing else", () => {
    expect(needsStepUp(new HttpError("x", 403, "STEP_UP_REQUIRED"))).toBe(true);
    expect(needsStepUp(new HttpError("x", 403, "FORBIDDEN"))).toBe(false);
    expect(needsStepUp(new Error("STEP_UP_REQUIRED"))).toBe(false);
  });

  it("formats sizes in binary units", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});
