import type { JsonValue } from "@/domain/json";

export type ConfigurationPlacement = "body" | "header" | "path" | "query";

export interface SourceMetadata {
  sourceUrl: string;
  checkedAt: string;
  revision: number;
  appliesTo?: {
    endpoint?: string;
    models?: string[];
    apiVersion?: string;
  };
}

export type CapabilityState = "unknown" | "reported" | "verified" | "rejected";

export interface CapabilityEntry {
  state: CapabilityState;
  value?: JsonValue;
  source?: SourceMetadata;
  userEdited: boolean;
}

export interface OfficialFieldRecord {
  endpoint: string;
  apiVersion?: string;
  location: "path" | "query" | "header" | "body" | "response" | "stream_event";
  path: string;
  semanticLabel: string;
  type: string;
  required: boolean;
  default?: JsonValue;
  values?: JsonValue[];
  modelScope?: string[];
  conditions?: string[];
  deprecated?: boolean;
  replacement?: string;
  unsupportedBehavior?: "unknown" | "ignored" | "error" | "translated";
  sourceUrl: string;
  checkedAt: string;
  revision: number;
}

export type PresetBinding =
  | {
      mode: "tracked";
      presetId: string;
      baseRevision: number;
      overridePatch: { [key: string]: JsonValue };
    }
  | {
      mode: "detached";
      forkedFromPresetId?: string;
      forkedFromRevision?: number;
    };

export interface ParameterOption {
  label: string;
  value: JsonValue;
  note?: string;
}

export interface ParameterDefinition {
  id: string;
  label: string;
  semanticHint?:
    | "custom"
    | "max_output"
    | "reasoning_effort"
    | "temperature"
    | "thinking_budget"
    | "top_k"
    | "top_p"
    | "verbosity";
  description?: string;
  examples?: string[];
  placement: ConfigurationPlacement;
  path: string;
  type: "boolean" | "integer" | "json" | "number" | "select" | "string";
  control?: "json" | "select" | "slider" | "stepper" | "text" | "toggle";
  default?: JsonValue;
  options?: ParameterOption[];
  allowCustomValue: boolean;
  min?: number;
  max?: number;
  step?: number;
  omitWhen?: "default" | "disabled" | "nullish" | "undefined";
  enabledByDefault?: boolean;
  source?: SourceMetadata;
  compatibility?: JsonValue;
  advanced?: boolean;
}

export interface BuiltInToolDefinition {
  id: string;
  label: string;
  modeOptions: string[];
  descriptor: { [key: string]: JsonValue };
  choiceMapping?: { [key: string]: JsonValue };
  paramsSchema: ParameterDefinition[];
  resultMapping?: JsonValue;
  source?: SourceMetadata;
  compatibility?: JsonValue;
  userEdited: boolean;
}

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
  presetBinding: PresetBinding | null;
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
  pathDefaults: JsonValue;
  source: JsonValue | null;
  presetBinding: PresetBinding | null;
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
  parameterValues: JsonValue;
  builtInTools: JsonValue;
  toolSettings: JsonValue;
  extraBody: JsonValue;
  extraHeaders: JsonValue;
  extraQuery: JsonValue;
  extraPath: JsonValue;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  protocolProfileOverrideId: string | null;
  schemaOrigin: string;
  schemaRevision: number;
  source: JsonValue | null;
  presetBinding: PresetBinding | null;
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
