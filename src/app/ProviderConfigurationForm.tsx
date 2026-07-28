import { useMemo, useState, type FormEvent } from "react";
import { Copy, Plus, RotateCcw } from "lucide-react";

import {
  DynamicCapabilityFields,
  DynamicConfigurationFields,
  DynamicToolFields,
} from "@/app/DynamicConfigurationFields";
import {
  jsonObjectFromText,
  type ChatService,
  type ProviderSelection,
  type SessionCredentialResolver,
} from "@/application/chat/chatService";
import {
  validateCapabilityCatalog,
  validateParameterCatalog,
  validateToolCatalog,
} from "@/application/providers/configurationSchema";
import { createTrackedPresetBinding } from "@/application/providers/presetLifecycle";
import { Button } from "@/components/ui/button";
import type { JsonObject, JsonValue } from "@/domain/json";
import type { CapabilityEntry, PresetBinding, ProtocolProfile } from "@/domain/provider";
import {
  OFFICIAL_PRESET_REGISTRY,
  findOfficialModelPreset,
  type OfficialModelPreset,
} from "@/infrastructure/providers/officialPresetRegistry";
import {
  OPENAI_CHAT_COMPLETIONS_CODEC,
  OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
} from "@/infrastructure/providers/openai/protocolProfiles";

export function ProviderConfigurationForm({
  credentials,
  onChanged,
  profiles,
  selections,
  service,
}: {
  credentials: SessionCredentialResolver;
  onChanged: (selection: ProviderSelection) => void;
  profiles: ProtocolProfile[];
  selections: ProviderSelection[];
  service: ChatService;
}) {
  const [connectionId, setConnectionId] = useState("new");
  const [presetId, setPresetId] = useState("custom");
  const [presetMode, setPresetMode] = useState<"detached" | "tracked">("detached");
  const [profileId, setProfileId] = useState(OPENAI_CHAT_COMPLETIONS_PROFILE_ID);
  const [connectionName, setConnectionName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [explicitPort, setExplicitPort] = useState("");
  const [path, setPath] = useState("/v1/chat/completions");
  const [modelId, setModelId] = useState("");
  const [modelDisplayName, setModelDisplayName] = useState("");
  const [token, setToken] = useState("");
  const [useCredential, setUseCredential] = useState(true);
  const [authPlacement, setAuthPlacement] = useState<"body" | "header" | "query">("header");
  const [authName, setAuthName] = useState("Authorization");
  const [authPrefix, setAuthPrefix] = useState("Bearer ");
  const [reasoningPaths, setReasoningPaths] = useState("");
  const [endpointHeaders, setEndpointHeaders] = useState("{}");
  const [endpointQuery, setEndpointQuery] = useState("{}");
  const [endpointBody, setEndpointBody] = useState("{}");
  const [endpointPath, setEndpointPath] = useState("{}");
  const [modelBody, setModelBody] = useState("{}");
  const [modelHeaders, setModelHeaders] = useState("{}");
  const [modelQuery, setModelQuery] = useState("{}");
  const [modelPath, setModelPath] = useState("{}");
  const [capabilities, setCapabilities] = useState("{}");
  const [parameterSchema, setParameterSchema] = useState("[]");
  const [parameterValues, setParameterValues] = useState("{}");
  const [toolSchema, setToolSchema] = useState("[]");
  const [toolSettings, setToolSettings] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const profile = useMemo(
    () => profiles.find((candidate) => candidate.id === profileId) ?? profiles[0],
    [profileId, profiles],
  );
  const preset = useMemo(
    () => (presetId === "custom" ? null : findOfficialModelPreset(presetId)),
    [presetId],
  );
  const parsedParameters = useMemo(() => safeParameterCatalog(parameterSchema), [parameterSchema]);
  const parsedTools = useMemo(() => safeToolCatalog(toolSchema), [toolSchema]);
  const parsedCapabilities = useMemo(() => safeCapabilityCatalog(capabilities), [capabilities]);
  const parsedParameterValues = useMemo(() => safeJsonObject(parameterValues), [parameterValues]);
  const parsedToolSettings = useMemo(() => safeJsonObject(toolSettings), [toolSettings]);
  const connections = useMemo(() => uniqueConnections(selections), [selections]);

  const applyPreset = (nextPreset: OfficialModelPreset, mode: "detached" | "tracked") => {
    setPresetId(nextPreset.id);
    setPresetMode(mode);
    setProfileId(nextPreset.endpoint.protocolProfileId);
    setConnectionName(nextPreset.label);
    setBaseUrl(nextPreset.endpoint.baseUrl);
    setPath(nextPreset.endpoint.pathTemplate);
    setModelId(nextPreset.modelId);
    setModelDisplayName(nextPreset.label);
    setCapabilities(pretty(nextPreset.capabilities));
    setParameterSchema(pretty(nextPreset.parameters));
    setParameterValues(pretty(nextPreset.parameterValues));
    setToolSchema(pretty(nextPreset.tools));
    setToolSettings(pretty(nextPreset.toolSettings));
    setExplicitPort("");
    setReasoningPaths("");
    setEndpointBody("{}");
    setEndpointQuery("{}");
    setEndpointPath("{}");
    setModelBody("{}");
    setModelHeaders("{}");
    setModelQuery("{}");
    setModelPath("{}");
    applyAuthDefaults(nextPreset.vendor);
  };

  const applyAuthDefaults = (vendor: OfficialModelPreset["vendor"]) => {
    setUseCredential(true);
    if (vendor === "google") {
      setAuthPlacement("query");
      setAuthName("key");
      setAuthPrefix("");
      setEndpointHeaders("{}");
    } else if (vendor === "anthropic") {
      setAuthPlacement("header");
      setAuthName("x-api-key");
      setAuthPrefix("");
      setEndpointHeaders(pretty({ "anthropic-version": "2023-06-01" }));
    } else {
      setAuthPlacement("header");
      setAuthName("Authorization");
      setAuthPrefix("Bearer ");
      setEndpointHeaders("{}");
    }
  };

  const handlePresetChange = (value: string) => {
    if (value === "custom") {
      setPresetId("custom");
      setPresetMode("detached");
      return;
    }
    applyPreset(findOfficialModelPreset(value), "tracked");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const paramsSchema = readJson(parameterSchema, "Parameter schema");
      const builtInTools = readJson(toolSchema, "Tool schema");
      validateCapabilityCatalog(readJson(capabilities, "Capability schema"));
      validateParameterCatalog(paramsSchema);
      validateToolCatalog(builtInTools);
      const presetBinding = preset
        ? buildPresetBinding(preset, presetMode, {
            ...toJsonObject(preset),
            label: modelDisplayName || modelId,
            modelId,
            endpoint: {
              ...toJsonObject(preset.endpoint),
              baseUrl,
              pathTemplate: path,
              protocolProfileId: profile?.id ?? OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
            },
            capabilities: jsonObjectFromText(capabilities, "Capability schema"),
            parameters: paramsSchema,
            parameterValues: jsonObjectFromText(parameterValues, "Parameter values"),
            tools: builtInTools,
            toolSettings: jsonObjectFromText(toolSettings, "Tool settings"),
          })
        : null;
      const selection = await service.createProviderConfiguration({
        authBindings: useCredential
          ? [
              {
                placement: authPlacement,
                name: authName,
                credentialKey: "apiKey",
                ...(authPrefix ? { prefix: authPrefix } : {}),
              },
            ]
          : [],
        baseUrl,
        ...(connectionId === "new" ? {} : { connectionId }),
        connectionName,
        explicitPort: explicitPort.trim() === "" ? null : Number(explicitPort),
        profileId: profile?.id ?? OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
        path,
        pathDefaults: jsonObjectFromText(endpointPath, "Endpoint path"),
        headers: jsonObjectFromText(endpointHeaders, "Endpoint headers"),
        query: jsonObjectFromText(endpointQuery, "Endpoint query"),
        bodyDefaults: jsonObjectFromText(endpointBody, "Endpoint body"),
        modelId,
        modelDisplayName: modelDisplayName || modelId,
        capabilitySchema: jsonObjectFromText(capabilities, "Capability schema"),
        paramsSchema,
        parameterValues: jsonObjectFromText(parameterValues, "Parameter values"),
        builtInTools,
        toolSettings: jsonObjectFromText(toolSettings, "Tool settings"),
        extraBody: jsonObjectFromText(modelBody, "Model body"),
        extraHeaders: jsonObjectFromText(modelHeaders, "Model headers"),
        extraQuery: jsonObjectFromText(modelQuery, "Model query"),
        extraPath: jsonObjectFromText(modelPath, "Model path"),
        reasoningDeltaPaths: reasoningPaths
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        source: preset?.source as unknown as JsonValue | undefined,
        presetBinding,
      });
      if (token !== "") credentials.set(selection.connection.id, token);
      setToken("");
      onChanged(selection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The connection could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="settings-section connection-form" onSubmit={submit}>
      <h2>New connection</h2>
      <label>
        Connection target
        <select
          aria-label="Connection target"
          onChange={(event) => {
            const nextConnectionId = event.target.value;
            setConnectionId(nextConnectionId);
            if (nextConnectionId !== "new") {
              const existing = connections.find(
                (candidate) => candidate.connection.id === nextConnectionId,
              );
              if (existing) setConnectionName(existing.connection.name);
            }
          }}
          value={connectionId}
        >
          <optgroup label="New connection">
            <option value="new">Create a new connection</option>
          </optgroup>
          {connections.length > 0 ? (
            <optgroup label="Existing connections">
              {connections.map((selection) => (
                <option key={selection.connection.id} value={selection.connection.id}>
                  {selection.connection.name}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <label>
        Configuration preset
        <select
          aria-label="Configuration preset"
          onChange={(event) => handlePresetChange(event.target.value)}
          value={presetId}
        >
          <option value="custom">Custom configuration</option>
          {OFFICIAL_PRESET_REGISTRY.modelPresets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      {preset ? (
        <div className="preset-meta" data-ownership={presetMode}>
          <div>
            <span>{presetMode === "tracked" ? "Tracked preset" : "Detached copy"}</span>
            <a href={preset.source.sourceUrl} rel="noreferrer" target="_blank">
              Official source
            </a>
          </div>
          <small>
            {preset.source.checkedAt} · revision {preset.source.revision}
          </small>
          <div className="preset-actions">
            <Button
              aria-label="Copy preset as detached"
              onClick={() => setPresetMode("detached")}
              type="button"
              variant="outline"
            >
              <Copy aria-hidden="true" className="size-4" />
              Copy
            </Button>
            <Button
              aria-label="Reset preset"
              onClick={() => applyPreset(preset, "tracked")}
              type="button"
              variant="outline"
            >
              <RotateCcw aria-hidden="true" className="size-4" />
              Reset
            </Button>
          </div>
          <details className="field-catalog">
            <summary>Endpoint fields ({preset.endpoint.requestFields.length})</summary>
            <div>
              {preset.endpoint.requestFields.map((field) => (
                <code key={`${field.location}:${field.path}`}>
                  {field.location}:{field.path} · {field.type}
                </code>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      <label>
        Protocol profile
        <select
          onChange={(event) => {
            setProfileId(event.target.value);
            const selected = profiles.find((candidate) => candidate.id === event.target.value);
            if (selected?.codecId === OPENAI_CHAT_COMPLETIONS_CODEC) {
              setPath("/v1/chat/completions");
            }
          }}
          value={profileId}
        >
          {profiles.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Connection name
        <input
          disabled={connectionId !== "new"}
          onChange={(event) => setConnectionName(event.target.value)}
          required={connectionId === "new"}
          value={connectionName}
        />
      </label>
      <div className="form-pair">
        <label>
          Base URL
          <input
            onChange={(event) => setBaseUrl(event.target.value)}
            required
            type="url"
            value={baseUrl}
          />
        </label>
        <label className="port-field">
          Port
          <input
            max="65535"
            min="1"
            onChange={(event) => setExplicitPort(event.target.value)}
            type="number"
            value={explicitPort}
          />
        </label>
      </div>
      <label>
        Path
        <input onChange={(event) => setPath(event.target.value)} required value={path} />
      </label>
      <div className="form-pair">
        <label>
          Model ID
          <input onChange={(event) => setModelId(event.target.value)} required value={modelId} />
        </label>
        <label>
          Display name
          <input
            onChange={(event) => setModelDisplayName(event.target.value)}
            value={modelDisplayName}
          />
        </label>
      </div>

      <DynamicCapabilityFields
        capabilities={parsedCapabilities}
        onChange={(path, value) =>
          setCapabilities(pretty(setCapabilityEntry(parsedCapabilities, path, value)))
        }
      />
      <DynamicConfigurationFields
        definitions={parsedParameters}
        onChange={(id, value) =>
          setParameterValues(pretty({ ...parsedParameterValues, [id]: value }))
        }
        values={parsedParameterValues}
      />
      <DynamicToolFields
        definitions={parsedTools}
        onChange={(id, mode) => setToolSettings(pretty({ ...parsedToolSettings, [id]: { mode } }))}
        settings={parsedToolSettings}
      />

      <label className="checkbox-label">
        <input
          checked={useCredential}
          onChange={(event) => setUseCredential(event.target.checked)}
          type="checkbox"
        />
        Attach session credential
      </label>
      {useCredential ? (
        <>
          <div className="form-pair">
            <label>
              Credential placement
              <select
                onChange={(event) => setAuthPlacement(event.target.value as typeof authPlacement)}
                value={authPlacement}
              >
                <option value="header">Header</option>
                <option value="query">Query</option>
                <option value="body">Body</option>
              </select>
            </label>
            <label>
              Credential field
              <input onChange={(event) => setAuthName(event.target.value)} value={authName} />
            </label>
          </div>
          <label>
            Credential prefix
            <input onChange={(event) => setAuthPrefix(event.target.value)} value={authPrefix} />
          </label>
          <label>
            Session token
            <input
              autoComplete="off"
              onChange={(event) => setToken(event.target.value)}
              type="password"
              value={token}
            />
          </label>
        </>
      ) : null}
      {profile?.codecId === OPENAI_CHAT_COMPLETIONS_CODEC ? (
        <label>
          Reasoning delta paths
          <input
            onChange={(event) => setReasoningPaths(event.target.value)}
            value={reasoningPaths}
          />
        </label>
      ) : null}

      <details className="advanced-settings">
        <summary>Advanced schemas and overrides</summary>
        <JsonField
          label="Capability schema JSON"
          onChange={setCapabilities}
          rows={5}
          value={capabilities}
        />
        <JsonField
          label="Parameter schema JSON"
          onChange={setParameterSchema}
          rows={8}
          value={parameterSchema}
        />
        <JsonField
          label="Parameter values JSON"
          onChange={setParameterValues}
          rows={5}
          value={parameterValues}
        />
        <JsonField label="Tool schema JSON" onChange={setToolSchema} rows={8} value={toolSchema} />
        <JsonField
          label="Tool settings JSON"
          onChange={setToolSettings}
          rows={5}
          value={toolSettings}
        />
        <JsonField
          label="Endpoint body JSON"
          onChange={setEndpointBody}
          rows={4}
          value={endpointBody}
        />
        <JsonField
          label="Endpoint headers JSON"
          onChange={setEndpointHeaders}
          rows={4}
          value={endpointHeaders}
        />
        <JsonField
          label="Endpoint query JSON"
          onChange={setEndpointQuery}
          rows={4}
          value={endpointQuery}
        />
        <JsonField
          label="Endpoint path JSON"
          onChange={setEndpointPath}
          rows={4}
          value={endpointPath}
        />
        <JsonField label="Model body JSON" onChange={setModelBody} rows={4} value={modelBody} />
        <JsonField
          label="Model headers JSON"
          onChange={setModelHeaders}
          rows={4}
          value={modelHeaders}
        />
        <JsonField label="Model query JSON" onChange={setModelQuery} rows={4} value={modelQuery} />
        <JsonField label="Model path JSON" onChange={setModelPath} rows={4} value={modelPath} />
      </details>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button disabled={saving} type="submit">
        <Plus aria-hidden="true" className="size-4" />
        {saving ? "Saving" : "Add connection"}
      </Button>
    </form>
  );
}

function JsonField({
  label,
  onChange,
  rows,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  rows: number;
  value: string;
}) {
  return (
    <label>
      {label}
      <textarea
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        value={value}
      />
    </label>
  );
}

function buildPresetBinding(
  preset: OfficialModelPreset | null,
  mode: "detached" | "tracked",
  current: JsonObject,
): PresetBinding | null {
  if (!preset) return null;
  return mode === "tracked"
    ? createTrackedPresetBinding(
        preset.id,
        preset.source.revision,
        preset as unknown as JsonObject,
        current,
      )
    : { mode, forkedFromPresetId: preset.id, forkedFromRevision: preset.source.revision };
}

function readJson(value: string, label: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function safeParameterCatalog(value: string) {
  try {
    return validateParameterCatalog(readJson(value, "Parameter schema"));
  } catch {
    return [];
  }
}

function safeCapabilityCatalog(value: string): JsonObject {
  try {
    return validateCapabilityCatalog(readJson(value, "Capability schema"));
  } catch {
    return {};
  }
}

function safeToolCatalog(value: string) {
  try {
    return validateToolCatalog(readJson(value, "Tool schema"));
  } catch {
    return [];
  }
}

function safeJsonObject(value: string): JsonObject {
  try {
    return jsonObjectFromText(value, "JSON");
  } catch {
    return {};
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function setCapabilityEntry(
  capabilities: JsonObject,
  path: string,
  value: CapabilityEntry,
): JsonObject {
  const next = structuredClone(capabilities);
  const segments = path.split(".");
  if (segments[0] === "custom" && segments[1]) {
    const custom = isJsonObjectValue(next.custom) ? structuredClone(next.custom) : {};
    custom[segments[1]] = value as unknown as JsonValue;
    next.custom = custom;
  } else {
    next[path] = value as unknown as JsonValue;
  }
  return next;
}

function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonObject(value: unknown): JsonObject {
  return structuredClone(value) as JsonObject;
}

function uniqueConnections(selections: ProviderSelection[]): ProviderSelection[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    if (seen.has(selection.connection.id)) return false;
    seen.add(selection.connection.id);
    return true;
  });
}
