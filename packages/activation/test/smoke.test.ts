import { describe, expect, it } from "vitest";
import { DAY } from "../src/index.js";

describe("scaffold smoke", () => {
  it("workspace resolves the package", () => {
    expect(DAY).toBe(86_400_000);
  });
});
