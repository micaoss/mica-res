import { describe, expect, it, vi } from "vitest";
import { formatDate, formatDateTime } from "./format";

vi.mock("@/app/i18n", () => ({ default: { language: "en" } }));

describe("formatDate()", () => {
  it("formats in the active i18n language", () => {
    expect(formatDate("2026-09-17T08:52:00Z")).toBe(
      new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" }).format(new Date("2026-09-17T08:52:00Z")),
    );
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDate("not a date")).toBe("");
  });
});

describe("formatDateTime()", () => {
  it("accepts a timestamp and includes the time", () => {
    const at = Date.UTC(2026, 8, 17, 8, 52);
    expect(formatDateTime(at)).toBe(
      new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(at)),
    );
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatDateTime(Number.NaN)).toBe("");
  });
});
