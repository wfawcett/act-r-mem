import assert from "node:assert/strict";
import { activation } from "./activation.ts";

assert.equal(activation([], ["a"]), 0);
assert.equal(activation([{ name: "c", slotValues: ["x"] }], ["a"]), -1);
assert.equal(activation([{ name: "c", slotValues: ["a", "b"] }], ["a", "b"]), 1);
assert.equal(
  activation(
    [
      { name: "c1", slotValues: ["a", "b"] },
      { name: "c2", slotValues: ["x"] },
    ],
    ["a", "b"],
  ),
  0,
);
console.log("passed: activation");
