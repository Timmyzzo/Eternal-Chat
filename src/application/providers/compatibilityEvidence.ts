import type { CompatibilityProbeStatus } from "@/domain/provider";

export interface CompatibilityEvidenceInput {
  httpStatus?: number | null;
  observedEffect?: boolean;
  officialDisposition?: "effective" | "ignored" | "rejected";
  translatedTo?: string;
  translationEvidence?: boolean;
}

export interface CompatibilityIdentity {
  endpointId: string;
  modelRef: string;
  apiVersion: string | null;
  protocolProfileId: string;
  protocolProfileRevision: number;
}

export function classifyCompatibilityEvidence(
  evidence: CompatibilityEvidenceInput,
): CompatibilityProbeStatus {
  if (evidence.translationEvidence && evidence.translatedTo) {
    return "translated";
  }
  if (evidence.officialDisposition === "rejected") {
    return "rejected";
  }
  if (
    evidence.httpStatus !== undefined &&
    evidence.httpStatus !== null &&
    evidence.httpStatus >= 400 &&
    evidence.httpStatus < 500
  ) {
    return "rejected";
  }
  if (evidence.observedEffect || evidence.officialDisposition === "effective") {
    return "accepted_effective";
  }
  if (evidence.officialDisposition === "ignored") {
    return "accepted_ignored";
  }
  return "unknown";
}

export function isCompatibilityEvidenceCurrent(
  evidence: CompatibilityIdentity,
  current: CompatibilityIdentity,
): boolean {
  return (
    evidence.endpointId === current.endpointId &&
    evidence.modelRef === current.modelRef &&
    evidence.apiVersion === current.apiVersion &&
    evidence.protocolProfileId === current.protocolProfileId &&
    evidence.protocolProfileRevision === current.protocolProfileRevision
  );
}
