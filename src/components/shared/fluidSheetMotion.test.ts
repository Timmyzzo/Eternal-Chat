import { describe, expect, it } from "vitest";

import { projectGesture, shouldDismissRightSheet } from "@/components/shared/fluidSheetMotion";

describe("fluid sheet motion", () => {
  it("projects release velocity using exponential deceleration", () => {
    expect(projectGesture(1000)).toBeCloseTo(99);
  });

  it("dismisses from either sufficient distance or a decisive flick", () => {
    expect(shouldDismissRightSheet(140, 0, 360)).toBe(true);
    expect(shouldDismissRightSheet(64, 900, 360)).toBe(true);
  });

  it("returns to rest when the gesture reverses", () => {
    expect(shouldDismissRightSheet(96, -800, 360)).toBe(false);
  });
});
