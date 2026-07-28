import type { JsonObject, JsonValue } from "@/domain/json";
import type { PresetBinding } from "@/domain/provider";

export function projectTrackedPreset<T extends JsonObject>(
  preset: T,
  binding: Extract<PresetBinding, { mode: "tracked" }>,
): T {
  return deepMerge(preset, binding.overridePatch) as T;
}

export function createTrackedPresetBinding(
  presetId: string,
  revision: number,
  preset: JsonObject,
  current: JsonObject,
): Extract<PresetBinding, { mode: "tracked" }> {
  return {
    mode: "tracked",
    presetId,
    baseRevision: revision,
    overridePatch: diffObject(preset, current),
  };
}

export function detachPreset<T extends JsonValue>(
  value: T,
  binding: PresetBinding,
): {
  binding: Extract<PresetBinding, { mode: "detached" }>;
  value: T;
} {
  return {
    binding: {
      mode: "detached",
      ...(binding.mode === "tracked"
        ? {
            forkedFromPresetId: binding.presetId,
            forkedFromRevision: binding.baseRevision,
          }
        : {
            ...(binding.forkedFromPresetId
              ? { forkedFromPresetId: binding.forkedFromPresetId }
              : {}),
            ...(binding.forkedFromRevision
              ? { forkedFromRevision: binding.forkedFromRevision }
              : {}),
          }),
    },
    value: structuredClone(value),
  };
}

export function resetTrackedPreset(
  presetId: string,
  revision: number,
): Extract<PresetBinding, { mode: "tracked" }> {
  return { mode: "tracked", presetId, baseRevision: revision, overridePatch: {} };
}

function deepMerge(...sources: JsonObject[]): JsonObject {
  const output: JsonObject = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      const current = output[key];
      output[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : clone(value);
    }
  }
  return output;
}

function diffObject(preset: JsonObject, current: JsonObject): JsonObject {
  const patch: JsonObject = {};
  for (const [key, currentValue] of Object.entries(current)) {
    const presetValue = preset[key];
    if (isObject(presetValue) && isObject(currentValue)) {
      const nested = diffObject(presetValue, currentValue);
      if (Object.keys(nested).length > 0) patch[key] = nested;
    } else if (!equalJson(presetValue, currentValue)) {
      patch[key] = clone(currentValue);
    }
  }
  return patch;
}

function equalJson(left: JsonValue | undefined, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
