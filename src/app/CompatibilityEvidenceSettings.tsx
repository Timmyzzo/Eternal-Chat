import { useEffect, useMemo, useState } from "react";

import { validateParameterCatalog } from "@/application/providers/configurationSchema";
import type {
  ChatService,
  CompatibilityEvidence,
  ProviderSelection,
} from "@/application/chat/chatService";
import { Button } from "@/components/ui/button";
import type { JsonObject, JsonValue } from "@/domain/json";
import {
  OPENAI_CHAT_COMPLETIONS_CODEC,
  OPENAI_RESPONSES_CODEC,
} from "@/infrastructure/providers/openai/protocolProfiles";

export function CompatibilityEvidenceSettings({
  selections,
  service,
}: {
  selections: ProviderSelection[];
  service: ChatService;
}) {
  const [modelRef, setModelRef] = useState(selections[0]?.model.id ?? "");
  const [evidence, setEvidence] = useState<CompatibilityEvidence[]>([]);
  const [parameterId, setParameterId] = useState("");
  const [probeValue, setProbeValue] = useState("");
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const selection = useMemo(
    () => selections.find((candidate) => candidate.model.id === modelRef) ?? null,
    [modelRef, selections],
  );
  const parameters = useMemo(
    () => safeParameterCatalog(selection?.model.paramsSchema),
    [selection?.model.paramsSchema],
  );
  const probeSupported =
    selection?.profile.codecId === OPENAI_CHAT_COMPLETIONS_CODEC ||
    selection?.profile.codecId === OPENAI_RESPONSES_CODEC;

  useEffect(() => {
    if (!selections.some((selection) => selection.model.id === modelRef)) {
      setModelRef(selections[0]?.model.id ?? "");
    }
  }, [modelRef, selections]);

  useEffect(() => {
    let cancelled = false;
    if (!modelRef) {
      setEvidence([]);
      return () => {
        cancelled = true;
      };
    }
    void service.listCompatibilityEvidence(modelRef).then((next) => {
      if (!cancelled) setEvidence(next);
    });
    return () => {
      cancelled = true;
    };
  }, [modelRef, service]);

  useEffect(() => {
    const parameter = parameters.find((candidate) => candidate.id === parameterId) ?? parameters[0];
    setParameterId(parameter?.id ?? "");
    setProbeValue(
      parameter ? defaultProbeValue(selection?.model.parameterValues, parameter.id) : "",
    );
    setProbeError(null);
  }, [modelRef, parameterId, parameters, selection?.model.parameterValues]);

  const runProbe = async () => {
    if (!modelRef || !parameterId) return;
    setProbing(true);
    setProbeError(null);
    try {
      await service.runCompatibilityProbe(modelRef, {
        parameterId,
        testedValue: readProbeValue(probeValue),
      });
      setEvidence(await service.listCompatibilityEvidence(modelRef));
    } catch (cause) {
      setProbeError(cause instanceof Error ? cause.message : "The compatibility probe failed.");
    } finally {
      setProbing(false);
    }
  };

  if (selections.length === 0) return null;
  return (
    <section className="settings-section compatibility-evidence">
      <h2>Parameter compatibility</h2>
      <label>
        Model
        <select
          aria-label="Compatibility evidence model"
          onChange={(event) => setModelRef(event.target.value)}
          value={modelRef}
        >
          {selections.map((selection) => (
            <option key={selection.model.id} value={selection.model.id}>
              {selection.model.displayName}
            </option>
          ))}
        </select>
      </label>
      {parameters.length > 0 && probeSupported ? (
        <div className="compatibility-probe-form" data-ui="provider.compatibility-probe">
          <label>
            Parameter
            <select
              aria-label="Compatibility probe parameter"
              onChange={(event) => {
                const nextId = event.target.value;
                setParameterId(nextId);
                setProbeValue(defaultProbeValue(selection?.model.parameterValues, nextId));
              }}
              value={parameterId}
            >
              {parameters.map((parameter) => (
                <option key={parameter.id} value={parameter.id}>
                  {parameter.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Test value
            <input
              aria-label="Compatibility probe value"
              onChange={(event) => setProbeValue(event.target.value)}
              value={probeValue}
            />
          </label>
          <Button
            disabled={probing}
            onClick={() => void runProbe()}
            type="button"
            variant="outline"
          >
            {probing ? "Probing" : "Run minimal probe"}
          </Button>
        </div>
      ) : null}
      {!probeSupported && selection ? (
        <p className="empty-setting">Network probes for this profile are deferred.</p>
      ) : null}
      {probeError ? (
        <p className="form-error" role="alert">
          {probeError}
        </p>
      ) : null}
      {evidence.length === 0 ? (
        <p className="empty-setting">No evidence recorded.</p>
      ) : (
        <div className="compatibility-evidence-list" role="list">
          {evidence.map(({ current, probe }) => (
            <div className="compatibility-evidence-row" key={probe.id} role="listitem">
              <div>
                <strong>{probe.parameterId}</strong>
                <code>{`${probe.placement}:${probe.wirePath}`}</code>
              </div>
              <div>
                <output>{formatStatus(probe.status)}</output>
                <span data-current={current}>{current ? "Current" : "Stale"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function safeParameterCatalog(value: JsonValue | undefined) {
  try {
    return validateParameterCatalog(value ?? []);
  } catch {
    return [];
  }
}

function defaultProbeValue(values: JsonValue | undefined, parameterId: string): string {
  const object = isObject(values) ? values : {};
  const stored = object[parameterId];
  if (stored === undefined) return "";
  return typeof stored === "string" ? stored : JSON.stringify(stored);
}

function readProbeValue(value: string): JsonValue {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return value;
  }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
