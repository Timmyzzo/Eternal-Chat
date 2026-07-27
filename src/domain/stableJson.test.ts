// @vitest-environment node

import { describe, expect, it } from "vitest";

import { hashStableJson, stableJsonStringify } from "@/domain/stableJson";

describe("stable JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, nested: { b: true, a: [3, 2, 1] } };
    const right = { nested: { a: [3, 2, 1], b: true }, z: 1 };

    expect(stableJsonStringify(left)).toBe(stableJsonStringify(right));
    expect(stableJsonStringify(left)).toBe('{"nested":{"a":[3,2,1],"b":true},"z":1}');
  });

  it("produces the same SHA-256 hash for semantically identical JSON", async () => {
    await expect(hashStableJson({ beta: 2, alpha: { y: false, x: "value" } })).resolves.toBe(
      await hashStableJson({ alpha: { x: "value", y: false }, beta: 2 }),
    );
  });
});
