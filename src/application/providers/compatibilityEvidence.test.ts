import { describe, expect, it } from "vitest";

import {
  classifyCompatibilityEvidence,
  isCompatibilityEvidenceCurrent,
} from "@/application/providers/compatibilityEvidence";

describe("Phase 6 compatibility evidence", () => {
  it("does not treat HTTP 200 as proof that a parameter was effective", () => {
    expect(classifyCompatibilityEvidence({ httpStatus: 200 })).toBe("unknown");
    expect(classifyCompatibilityEvidence({ httpStatus: 200, officialDisposition: "ignored" })).toBe(
      "accepted_ignored",
    );
    expect(classifyCompatibilityEvidence({ httpStatus: 200, observedEffect: true })).toBe(
      "accepted_effective",
    );
    expect(classifyCompatibilityEvidence({ httpStatus: 422 })).toBe("rejected");
    expect(classifyCompatibilityEvidence({ httpStatus: 503 })).toBe("unknown");
    expect(
      classifyCompatibilityEvidence({
        httpStatus: 200,
        translatedTo: "reasoning.effort",
        translationEvidence: true,
      }),
    ).toBe("translated");
  });

  it("invalidates evidence when endpoint, model, API version, or profile revision changes", () => {
    const evidence = {
      endpointId: "endpoint-a",
      modelRef: "model-a",
      apiVersion: "2026-07",
      protocolProfileId: "profile-a",
      protocolProfileRevision: 3,
    };
    expect(isCompatibilityEvidenceCurrent(evidence, evidence)).toBe(true);
    expect(
      isCompatibilityEvidenceCurrent(evidence, { ...evidence, protocolProfileRevision: 4 }),
    ).toBe(false);
    expect(
      isCompatibilityEvidenceCurrent(evidence, { ...evidence, endpointId: "endpoint-b" }),
    ).toBe(false);
  });
});
