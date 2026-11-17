import { describe, expect, it } from "vitest";
import { E01_PLACEHOLDER } from "../src/index.js";

describe("scaffold smoke", () => {
  it("workspace resolves the package", () => {
    expect(E01_PLACEHOLDER).toBe(true);
  });
});
