import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  BuiltInToolDefinition,
  CapabilityEntry,
  CapabilityState,
  ParameterDefinition,
} from "@/domain/provider";

const capabilityStates: CapabilityState[] = ["unknown", "reported", "verified", "rejected"];

export function DynamicCapabilityFields({
  capabilities,
  onChange,
}: {
  capabilities: JsonObject;
  onChange: (path: string, value: CapabilityEntry) => void;
}) {
  const entries = capabilityEntries(capabilities);
  if (entries.length === 0) return null;
  return (
    <div className="dynamic-field-list" data-ui="provider.capability-catalog">
      {entries.map(([path, entry]) => (
        <div className="dynamic-field capability-field" key={path}>
          <span className="dynamic-field-heading">
            <span>{path}</span>
            <small>{capabilityValueLabel(entry.value)}</small>
          </span>
          <select
            aria-label={`${path} state`}
            onChange={(event) =>
              onChange(path, {
                ...entry,
                state: event.target.value as CapabilityState,
                userEdited: true,
              })
            }
            value={entry.state}
          >
            {capabilityStates.map((state) => (
              <option key={state} value={state}>
                {titleCase(state)}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

export function DynamicConfigurationFields({
  definitions,
  onChange,
  values,
}: {
  definitions: ParameterDefinition[];
  onChange: (id: string, value: JsonValue) => void;
  values: JsonObject;
}) {
  if (definitions.length === 0) return null;
  return (
    <div className="dynamic-field-list" data-ui="provider.parameter-catalog">
      {definitions.map((definition) => (
        <ParameterField
          definition={definition}
          key={definition.id}
          onChange={(value) => onChange(definition.id, value)}
          value={values[definition.id] ?? definition.default ?? null}
        />
      ))}
    </div>
  );
}

export function DynamicToolFields({
  definitions,
  onChange,
  settings,
}: {
  definitions: BuiltInToolDefinition[];
  onChange: (id: string, mode: string) => void;
  settings: JsonObject;
}) {
  if (definitions.length === 0) return null;
  return (
    <div className="dynamic-field-list" data-ui="provider.tool-catalog">
      {definitions.map((definition) => {
        const stored = settings[definition.id];
        const mode = isObject(stored) && typeof stored.mode === "string" ? stored.mode : "off";
        return (
          <label className="dynamic-field" key={definition.id}>
            <span className="dynamic-field-heading">
              <span>{definition.label} mode</span>
              <code>{descriptorType(definition.descriptor)}</code>
            </span>
            <select
              aria-label={`${definition.label} mode`}
              onChange={(event) => onChange(definition.id, event.target.value)}
              value={mode}
            >
              {definition.modeOptions.map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function ParameterField({
  definition,
  onChange,
  value,
}: {
  definition: ParameterDefinition;
  onChange: (value: JsonValue) => void;
  value: JsonValue;
}) {
  const options = definition.options ?? [];
  const knownOption = options.find((option) => equalJson(option.value, value));
  const common = (
    <span className="dynamic-field-heading">
      <span>{definition.label}</span>
      <code>{definition.path}</code>
      <small>{compatibilityLabel(definition.compatibility)}</small>
    </span>
  );

  if (definition.type === "boolean") {
    return (
      <label className="dynamic-field dynamic-toggle">
        {common}
        <input
          aria-label={definition.label}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
      </label>
    );
  }
  if (definition.type === "integer" || definition.type === "number") {
    return (
      <label className="dynamic-field">
        {common}
        <input
          aria-label={definition.label}
          max={definition.max}
          min={definition.min}
          onChange={(event) => onChange(Number(event.target.value))}
          step={definition.step ?? (definition.type === "integer" ? 1 : "any")}
          type="number"
          value={typeof value === "number" ? value : ""}
        />
      </label>
    );
  }
  if (options.length > 0) {
    const selected = knownOption ? optionValue(knownOption.value) : "__custom__";
    return (
      <div className="dynamic-field">
        {common}
        <select
          aria-label={definition.label}
          onChange={(event) => {
            const option = options.find(
              (candidate) => optionValue(candidate.value) === event.target.value,
            );
            if (option) onChange(option.value);
          }}
          value={selected}
        >
          {options.map((option) => (
            <option key={optionValue(option.value)} value={optionValue(option.value)}>
              {option.label}
            </option>
          ))}
          {definition.allowCustomValue ? <option value="__custom__">Custom value</option> : null}
        </select>
        {selected === "__custom__" && definition.allowCustomValue ? (
          <input
            aria-label={`${definition.label} custom value`}
            onChange={(event) => onChange(event.target.value)}
            type="text"
            value={typeof value === "string" ? value : JSON.stringify(value)}
          />
        ) : null}
      </div>
    );
  }
  return (
    <label className="dynamic-field">
      {common}
      <input
        aria-label={definition.label}
        onChange={(event) => onChange(event.target.value)}
        type="text"
        value={typeof value === "string" ? value : value === null ? "" : JSON.stringify(value)}
      />
    </label>
  );
}

function compatibilityLabel(value: JsonValue | undefined): string {
  if (typeof value === "string") return value.replaceAll("_", " ");
  if (isObject(value) && typeof value.status === "string") return value.status.replaceAll("_", " ");
  return "unknown";
}

function capabilityEntries(capabilities: JsonObject): Array<[string, CapabilityEntry]> {
  const entries: Array<[string, CapabilityEntry]> = [];
  for (const [id, candidate] of Object.entries(capabilities)) {
    if (id === "custom" && isObject(candidate)) {
      for (const [customId, customCandidate] of Object.entries(candidate)) {
        if (isCapabilityEntry(customCandidate))
          entries.push([`custom.${customId}`, customCandidate]);
      }
    } else if (isCapabilityEntry(candidate)) {
      entries.push([id, candidate]);
    }
  }
  return entries;
}

function capabilityValueLabel(value: JsonValue | undefined): string {
  if (value === undefined) return "No declared value";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

function isCapabilityEntry(value: unknown): value is CapabilityEntry {
  return (
    isObject(value) &&
    typeof value.state === "string" &&
    capabilityStates.includes(value.state as CapabilityState) &&
    typeof value.userEdited === "boolean"
  );
}

function descriptorType(value: JsonObject): string {
  return typeof value.type === "string" ? value.type : (Object.keys(value)[0] ?? "custom");
}

function optionValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}
