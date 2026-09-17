import { describe, expect, it } from "vitest";
import { errorMessage } from "./errors";
import { HttpError } from "./http";

describe("errorMessage()", () => {
  it("hides the server message of a coded API error behind the fallback", () => {
    expect(errorMessage(new HttpError("internal detail", 500, "INTERNAL"), "Something went wrong")).toBe("Something went wrong");
  });

  it("shows the message of an API error without a code", () => {
    expect(errorMessage(new HttpError("Bad Gateway", 502), "Something went wrong")).toBe("Bad Gateway");
  });

  it("shows the message of a plain Error", () => {
    expect(errorMessage(new Error("offline"), "Something went wrong")).toBe("offline");
  });

  it("falls back for a thrown non-Error", () => {
    expect(errorMessage("boom", "Something went wrong")).toBe("Something went wrong");
  });
});
