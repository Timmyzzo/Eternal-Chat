import type { JsonValue } from "@/domain/json";

export interface ProviderConnection {
  id: string;
  name: string;
  vendorHint: string | null;
  description: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProtocolProfile {
  id: string;
  name: string;
  codecId: string;
  requestMapping: JsonValue;
  responseMapping: JsonValue;
  toolsMapping: JsonValue;
  continuationMapping: JsonValue | null;
  source: JsonValue | null;
  userEdited: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderEndpoint {
  id: string;
  connectionId: string;
  name: string;
  baseUrl: string;
  explicitPort: number | null;
  pathTemplate: string;
  method: string;
  apiVersion: string | null;
  protocolProfileId: string;
  authBindings: JsonValue;
  headers: JsonValue;
  query: JsonValue;
  bodyDefaults: JsonValue;
  timeoutMs: number | null;
  retryPolicy: JsonValue | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Model {
  id: string;
  endpointId: string;
  modelId: string;
  displayName: string;
  capabilitySchema: JsonValue;
  paramsSchema: JsonValue;
  builtInTools: JsonValue;
  extraBody: JsonValue;
  extraHeaders: JsonValue;
  extraQuery: JsonValue;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  protocolProfileOverrideId: string | null;
  schemaOrigin: string;
  schemaRevision: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type CompatibilityProbeStatus =
  "unknown" | "accepted_effective" | "accepted_ignored" | "rejected" | "translated";

export interface ParameterCompatibilityProbe {
  id: string;
  endpointId: string;
  modelRef: string;
  protocolProfileId: string;
  protocolProfileRevision: number;
  apiVersion: string | null;
  parameterId: string;
  placement: string;
  wirePath: string;
  testedValue: JsonValue | null;
  status: CompatibilityProbeStatus;
  evidenceType: string;
  requestFingerprint: string | null;
  httpStatus: number | null;
  providerErrorCode: string | null;
  note: string | null;
  checkedAt: number;
}

export interface Artifact {
  id: string;
  contentHash: string;
  relativePath: string;
  mimeType: string | null;
  byteSize: number;
  kind: string;
  originalName: string | null;
  createdAt: number;
  lastAccessedAt: number | null;
}
