import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  BuiltInToolDefinition,
  ConfigurationPlacement,
  Model,
  ParameterDefinition,
  ProtocolProfile,
  ProviderEndpoint,
} from "@/domain/provider";
import {
  validateParameterCatalog,
  validateToolCatalog,
} from "@/application/providers/configurationSchema";

export type ConfigurationLayer =
  | "conversation_raw"
  | "conversation_schema"
  | "endpoint"
  | "model_raw"
  | "model_schema"
  | "protocol";

export interface FieldContribution {
  layer: ConfigurationLayer;
  value: JsonValue;
}

export interface FieldSourceTrace {
  overridden: FieldContribution[];
  winner: FieldContribution;
}

export interface RequestFieldSources {
  body: Record<string, FieldSourceTrace>;
  headers: Record<string, FieldSourceTrace>;
  path: Record<string, FieldSourceTrace>;
  query: Record<string, FieldSourceTrace>;
}

export interface ConversationRequestOverrides {
  params: JsonValue;
  extraBody: JsonValue;
  extraHeaders: JsonValue;
  extraQuery: JsonValue;
  extraPath: JsonValue;
  toolsOverride: JsonValue;
}

export interface RequestConfigurationInput {
  profile: ProtocolProfile;
  endpoint: ProviderEndpoint;
  model: Model;
  protocolBody: JsonObject;
  conversation: ConversationRequestOverrides;
}

export interface ResolvedRequestConfiguration {
  body: JsonObject;
  headers: JsonObject;
  pathValues: JsonObject;
  query: JsonObject;
  sources: RequestFieldSources;
}

export function emptyRequestFieldSources(): RequestFieldSources {
  return { body: {}, headers: {}, path: {}, query: {} };
}

export function resolveRequestConfiguration(
  input: RequestConfigurationInput,
): ResolvedRequestConfiguration {
  const requestMapping = asObject(input.profile.requestMapping);
  const result: ResolvedRequestConfiguration = {
    body: {},
    headers: {},
    pathValues: {},
    query: {},
    sources: emptyRequestFieldSources(),
  };

  applyObject(result, "body", asObject(requestMapping.baseBody), "protocol");
  applyObject(result, "body", input.protocolBody, "protocol");
  applyObject(result, "header", asObject(requestMapping.defaultHeaders), "protocol");
  applyObject(result, "query", asObject(requestMapping.defaultQuery), "protocol");
  applyObject(result, "path", asObject(requestMapping.defaultPath), "protocol");

  applyObject(result, "body", asObject(input.endpoint.bodyDefaults), "endpoint");
  applyObject(result, "header", asObject(input.endpoint.headers), "endpoint");
  applyObject(result, "query", asObject(input.endpoint.query), "endpoint");
  applyObject(result, "path", asObject(input.endpoint.pathDefaults), "endpoint");

  const definitions = validateParameterCatalog(input.model.paramsSchema);
  applyParameterValues(result, definitions, asObject(input.model.parameterValues), "model_schema");
  applyTools(
    result,
    input.profile,
    validateToolCatalog(input.model.builtInTools),
    asObject(input.model.toolSettings),
    "model_schema",
  );

  applyObject(result, "body", asObject(input.model.extraBody), "model_raw");
  applyObject(result, "header", asObject(input.model.extraHeaders), "model_raw");
  applyObject(result, "query", asObject(input.model.extraQuery), "model_raw");
  applyObject(result, "path", asObject(input.model.extraPath), "model_raw");

  applyParameterValues(
    result,
    definitions,
    asObject(input.conversation.params),
    "conversation_schema",
  );
  const conversationToolSettings = asObject(input.conversation.toolsOverride);
  if (Object.keys(conversationToolSettings).length > 0) {
    applyTools(
      result,
      input.profile,
      validateToolCatalog(input.model.builtInTools),
      deepMergeObjects(asObject(input.model.toolSettings), conversationToolSettings),
      "conversation_schema",
    );
  }

  applyObject(result, "body", asObject(input.conversation.extraBody), "conversation_raw");
  applyObject(result, "header", asObject(input.conversation.extraHeaders), "conversation_raw");
  applyObject(result, "query", asObject(input.conversation.extraQuery), "conversation_raw");
  applyObject(result, "path", asObject(input.conversation.extraPath), "conversation_raw");
  applyModelAndStreamMapping(result, requestMapping, input.model.modelId);

  return result;
}

function applyModelAndStreamMapping(
  result: ResolvedRequestConfiguration,
  requestMapping: JsonObject,
  modelId: string,
): void {
  const modelMapping = asObject(requestMapping.model);
  const placement = readPlacement(modelMapping.placement) ?? "body";
  const path = stringValue(modelMapping.path) ?? "model";
  setPlacedValue(result, "path", "model", modelId, "protocol");
  setPlacedValue(result, placement, path, modelId, "protocol");
  if (requestMapping.forceStream !== false) {
    const streamMapping = asObject(requestMapping.stream);
    const streamPlacement = readPlacement(streamMapping.placement) ?? "body";
    const streamPath = stringValue(streamMapping.path) ?? "stream";
    const streamValue = streamMapping.value ?? true;
    setPlacedValue(result, streamPlacement, streamPath, streamValue, "protocol");
  }
}

function applyParameterValues(
  result: ResolvedRequestConfiguration,
  definitions: ParameterDefinition[],
  values: JsonObject,
  layer: ConfigurationLayer,
): void {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const [id, stored] of Object.entries(values)) {
    const definition = byId.get(id);
    const state = readParameterValue(stored);
    if (!state.enabled) {
      continue;
    }
    if (!definition) {
      mergeBodyObject(result, { [id]: state.value }, layer);
      continue;
    }
    if (shouldOmit(definition, state.value)) {
      continue;
    }
    setPlacedValue(result, definition.placement, definition.path, state.value, layer);
  }
}

function applyTools(
  result: ResolvedRequestConfiguration,
  profile: ProtocolProfile,
  definitions: BuiltInToolDefinition[],
  settings: JsonObject,
  layer: ConfigurationLayer,
): void {
  const descriptors: JsonValue[] = [];
  const choices: JsonValue[] = [];
  for (const definition of definitions) {
    const setting = asObject(settings[definition.id]);
    const mode = stringValue(setting.mode) ?? "off";
    if (mode === "off") {
      continue;
    }
    if (!definition.modeOptions.includes(mode)) {
      throw new Error(`Tool ${definition.id} does not support ${mode} mode`);
    }
    const descriptor = deepMergeObjects(definition.descriptor, asObject(setting.params));
    descriptors.push(descriptor);
    const choice = definition.choiceMapping?.[mode];
    if (choice !== undefined) {
      choices.push(choice);
    }
  }
  if (descriptors.length === 0) {
    return;
  }

  const mapping = asObject(profile.toolsMapping);
  const bodyPath = stringValue(mapping.bodyPath);
  if (!bodyPath) {
    throw new Error(`Protocol profile ${profile.id} cannot encode enabled tools`);
  }
  setPlacedValue(result, "body", bodyPath, descriptors, layer);
  const choicePath = stringValue(mapping.choicePath);
  if (choicePath && choices.length > 0) {
    const required = choices.find((choice) => choice === "required" || isRequiredChoice(choice));
    setPlacedValue(result, "body", choicePath, required ?? choices.at(-1) ?? "auto", layer);
  }
}

function applyObject(
  result: ResolvedRequestConfiguration,
  placement: ConfigurationPlacement,
  source: JsonObject,
  layer: ConfigurationLayer,
): void {
  if (placement === "body") {
    mergeBodyObject(result, source, layer);
    return;
  }
  for (const [path, value] of Object.entries(source)) {
    setPlacedValue(result, placement, path, value, layer);
  }
}

function mergeBodyObject(
  result: ResolvedRequestConfiguration,
  source: JsonObject,
  layer: ConfigurationLayer,
  prefix = "",
): void {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const current = readJsonPath(result.body, path);
    if (isObject(value) && isObject(current)) {
      mergeBodyObject(result, value, layer, path);
    } else if (isObject(value)) {
      setJsonPath(result.body, path, {});
      mergeBodyObject(result, value, layer, path);
    } else {
      setPlacedValue(result, "body", path, value, layer);
    }
  }
}

function setPlacedValue(
  result: ResolvedRequestConfiguration,
  placement: ConfigurationPlacement,
  path: string,
  value: JsonValue,
  layer: ConfigurationLayer,
): void {
  if (path.trim() === "") {
    throw new Error(`${placement} path is empty`);
  }
  const target = targetFor(result, placement);
  const traceKey = placement === "header" ? path.toLowerCase() : path;
  const previousKey =
    placement === "header"
      ? Object.keys(target).find((candidate) => candidate.toLowerCase() === path.toLowerCase())
      : undefined;
  if (previousKey && previousKey !== path) {
    delete target[previousKey];
  }
  if (placement === "body") {
    setJsonPath(target, path, clone(value));
  } else {
    target[path] = clone(value);
  }
  const traces = sourcesFor(result.sources, placement);
  const contribution = { layer, value: clone(value) } satisfies FieldContribution;
  const previous = traces[traceKey];
  traces[traceKey] = previous
    ? { overridden: [...previous.overridden, previous.winner], winner: contribution }
    : { overridden: [], winner: contribution };
}

function targetFor(
  result: ResolvedRequestConfiguration,
  placement: ConfigurationPlacement,
): JsonObject {
  if (placement === "body") return result.body;
  if (placement === "header") return result.headers;
  if (placement === "query") return result.query;
  return result.pathValues;
}

function sourcesFor(
  sources: RequestFieldSources,
  placement: ConfigurationPlacement,
): Record<string, FieldSourceTrace> {
  if (placement === "body") return sources.body;
  if (placement === "header") return sources.headers;
  if (placement === "query") return sources.query;
  return sources.path;
}

function readParameterValue(value: JsonValue): { enabled: boolean; value: JsonValue } {
  if (isObject(value) && typeof value.enabled === "boolean" && "value" in value) {
    return { enabled: value.enabled, value: value.value ?? null };
  }
  return { enabled: true, value };
}

function shouldOmit(definition: ParameterDefinition, value: JsonValue): boolean {
  if (definition.omitWhen === "nullish" && value === null) return true;
  if (definition.omitWhen === "default" && definition.default !== undefined) {
    return JSON.stringify(value) === JSON.stringify(definition.default);
  }
  return false;
}

function readPlacement(value: JsonValue | undefined): ConfigurationPlacement | null {
  return value === "body" || value === "header" || value === "path" || value === "query"
    ? value
    : null;
}

function setJsonPath(target: JsonObject, path: string, value: JsonValue): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("JSON path is empty");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    if (!isObject(current[segment])) current[segment] = {};
    current = current[segment] as JsonObject;
  }
  current[segments.at(-1) as string] = value;
}

function readJsonPath(target: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue = target;
  for (const segment of path.split(".").filter(Boolean)) {
    if (!isObject(current)) return undefined;
    const next: JsonValue | undefined = current[segment];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

function deepMergeObjects(...sources: JsonObject[]): JsonObject {
  const output: JsonObject = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const current = output[key];
      output[key] =
        isObject(current) && isObject(value) ? deepMergeObjects(current, value) : clone(value);
    }
  }
  return output;
}

function asObject(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequiredChoice(value: JsonValue): boolean {
  return isObject(value) && (value.type === "required" || value.mode === "ANY");
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}
