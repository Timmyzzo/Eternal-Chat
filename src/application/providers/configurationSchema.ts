import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  BuiltInToolDefinition,
  CapabilityEntry,
  CapabilityState,
  ConfigurationPlacement,
  ParameterDefinition,
} from "@/domain/provider";

const parameterTypes = new Set(["boolean", "integer", "json", "number", "select", "string"]);
const capabilityStates = new Set<CapabilityState>(["unknown", "reported", "verified", "rejected"]);

export function validateCapabilityCatalog(value: JsonValue): JsonObject {
  if (!isObject(value)) {
    throw new Error("Capability catalog must be an object");
  }
  for (const [id, candidate] of Object.entries(value)) {
    if (id === "custom") {
      if (!isObject(candidate)) throw new Error("Capability custom catalog must be an object");
      for (const [customId, customCandidate] of Object.entries(candidate)) {
        validateCapabilityEntry(customCandidate, `custom.${customId}`);
      }
    } else {
      validateCapabilityEntry(candidate, id);
    }
  }
  return value;
}

export function validateParameterCatalog(value: JsonValue): ParameterDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error("Parameter catalog must be an array");
  }
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Parameter ${index + 1} must be an object`);
    const id = requiredString(candidate.id, `Parameter ${index + 1} id is missing`);
    if (ids.has(id)) throw new Error(`Duplicate parameter id: ${id}`);
    ids.add(id);
    requiredString(candidate.label, `Parameter ${id} label is missing`);
    const placement = candidate.placement;
    if (!isPlacement(placement)) throw new Error(`Parameter ${id} placement is invalid`);
    if (typeof candidate.path !== "string" || candidate.path.trim() === "") {
      throw new Error(`Parameter ${id} wire path is empty`);
    }
    if (typeof candidate.type !== "string" || !parameterTypes.has(candidate.type)) {
      throw new Error(`Parameter ${id} type is invalid`);
    }
    if (typeof candidate.allowCustomValue !== "boolean") {
      throw new Error(`Parameter ${id} allowCustomValue is missing`);
    }
    return candidate as unknown as ParameterDefinition;
  });
}

export function validateToolCatalog(value: JsonValue): BuiltInToolDefinition[] {
  if (!Array.isArray(value)) throw new Error("Tool catalog must be an array");
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isObject(candidate)) throw new Error(`Tool ${index + 1} must be an object`);
    const id = requiredString(candidate.id, `Tool ${index + 1} id is missing`);
    if (ids.has(id)) throw new Error(`Duplicate tool id: ${id}`);
    ids.add(id);
    requiredString(candidate.label, `Tool ${id} label is missing`);
    if (!Array.isArray(candidate.modeOptions) || !candidate.modeOptions.every(isNonEmptyString)) {
      throw new Error(`Tool ${id} modeOptions must be a string array`);
    }
    if (!isObject(candidate.descriptor)) {
      throw new Error(`Tool ${id} descriptor must be an object`);
    }
    if (!Array.isArray(candidate.paramsSchema)) {
      throw new Error(`Tool ${id} paramsSchema must be an array`);
    }
    validateParameterCatalog(candidate.paramsSchema);
    return candidate as unknown as BuiltInToolDefinition;
  });
}

function validateCapabilityEntry(value: JsonValue, id: string): CapabilityEntry {
  if (!isObject(value)) throw new Error(`Capability ${id} must be an object`);
  if (typeof value.state !== "string" || !capabilityStates.has(value.state as CapabilityState)) {
    throw new Error(`Capability ${id} state is invalid`);
  }
  if (typeof value.userEdited !== "boolean") {
    throw new Error(`Capability ${id} userEdited is missing`);
  }
  return value as unknown as CapabilityEntry;
}

function requiredString(value: JsonValue | undefined, message: string): string {
  if (!isNonEmptyString(value)) throw new Error(message);
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPlacement(value: JsonValue | undefined): value is ConfigurationPlacement {
  return value === "body" || value === "header" || value === "path" || value === "query";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
