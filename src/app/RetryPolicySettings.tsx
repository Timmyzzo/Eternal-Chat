import { useEffect, useMemo, useState } from "react";
import { RotateCcw, Save } from "lucide-react";

import type { ChatService, ProviderSelection } from "@/application/chat/chatService";
import { resolveRetryPolicy, type RetryPolicy } from "@/application/chat/retryPolicy";
import { Button } from "@/components/ui/button";

export function RetryPolicySettings({
  onChanged,
  selections,
  service,
}: {
  onChanged: () => void;
  selections: ProviderSelection[];
  service: ChatService;
}) {
  const endpoints = useMemo(() => uniqueEndpoints(selections), [selections]);
  const [applicationPolicy, setApplicationPolicy] = useState(() =>
    service.getApplicationRetryPolicy(),
  );
  const [endpointId, setEndpointId] = useState(endpoints[0]?.endpoint.id ?? "");
  const selectedEndpoint = endpoints.find((selection) => selection.endpoint.id === endpointId);
  const [endpointPolicy, setEndpointPolicy] = useState(() =>
    resolveRetryPolicy(selectedEndpoint?.endpoint.retryPolicy, applicationPolicy),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"application" | "endpoint" | null>(null);

  useEffect(() => {
    if (!endpoints.some((selection) => selection.endpoint.id === endpointId)) {
      setEndpointId(endpoints[0]?.endpoint.id ?? "");
    }
  }, [endpointId, endpoints]);

  useEffect(() => {
    setEndpointPolicy(
      resolveRetryPolicy(selectedEndpoint?.endpoint.retryPolicy, applicationPolicy),
    );
  }, [applicationPolicy, selectedEndpoint]);

  const saveApplication = async () => {
    setSaving("application");
    setError(null);
    try {
      const saved = await service.setApplicationRetryPolicy(applicationPolicy);
      setApplicationPolicy(saved);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The retry policy could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  const saveEndpoint = async () => {
    if (!selectedEndpoint) {
      return;
    }
    setSaving("endpoint");
    setError(null);
    try {
      const saved = await service.updateEndpointRetryPolicy(
        selectedEndpoint.endpoint.id,
        endpointPolicy,
      );
      setEndpointPolicy(saved);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The retry override could not be saved.");
    } finally {
      setSaving(null);
    }
  };

  const resetEndpoint = async () => {
    if (!selectedEndpoint) {
      return;
    }
    setSaving("endpoint");
    setError(null);
    try {
      const inherited = await service.updateEndpointRetryPolicy(selectedEndpoint.endpoint.id, null);
      setEndpointPolicy(inherited);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The retry override could not be reset.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <section className="settings-section retry-policy-section">
        <div className="settings-section-heading">
          <h2>Application retry</h2>
          <output>Application default</output>
        </div>
        <RetryPolicyEditor
          onChange={setApplicationPolicy}
          policy={applicationPolicy}
          scope="Application"
        />
        <Button
          aria-label="Save application retry policy"
          disabled={saving !== null}
          onClick={() => void saveApplication()}
          type="button"
        >
          <Save aria-hidden="true" className="size-4" />
          {saving === "application" ? "Saving" : "Save default"}
        </Button>
      </section>

      <section className="settings-section retry-policy-section">
        <div className="settings-section-heading">
          <h2>Endpoint retry</h2>
          <span>
            {selectedEndpoint?.endpoint.retryPolicy === null
              ? "Application default"
              : "Endpoint override"}
          </span>
        </div>
        <label>
          Endpoint
          <select onChange={(event) => setEndpointId(event.target.value)} value={endpointId}>
            {endpoints.map((selection) => (
              <option key={selection.endpoint.id} value={selection.endpoint.id}>
                {selection.connection.name} / {selection.endpoint.name}
              </option>
            ))}
          </select>
        </label>
        {selectedEndpoint ? (
          <>
            <RetryPolicyEditor
              onChange={setEndpointPolicy}
              policy={endpointPolicy}
              scope="Endpoint"
            />
            <div className="settings-actions">
              <Button
                aria-label="Save endpoint retry policy"
                disabled={saving !== null}
                onClick={() => void saveEndpoint()}
                type="button"
              >
                <Save aria-hidden="true" className="size-4" />
                Save override
              </Button>
              <Button
                aria-label="Reset endpoint retry policy"
                disabled={saving !== null}
                onClick={() => void resetEndpoint()}
                type="button"
                variant="outline"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Reset
              </Button>
            </div>
          </>
        ) : (
          <p className="inspector-empty">No endpoint</p>
        )}
      </section>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function RetryPolicyEditor({
  onChange,
  policy,
  scope,
}: {
  onChange: (policy: RetryPolicy) => void;
  policy: RetryPolicy;
  scope: "Application" | "Endpoint";
}) {
  const setNumber = (
    key: "maxRetries" | "baseDelayMs" | "maxDelayMs" | "maxTotalElapsedMs",
    value: string,
  ) => onChange({ ...policy, [key]: Number(value) });

  return (
    <div className="retry-policy-fields">
      <label className="checkbox-label">
        <input
          aria-label={`${scope} automatic retry`}
          checked={policy.enabled}
          onChange={(event) => onChange({ ...policy, enabled: event.target.checked })}
          type="checkbox"
        />
        Automatic retry
      </label>
      <div className="form-pair retry-number-pair">
        <label>
          Max retries
          <input
            aria-label={`${scope} max retries`}
            min="0"
            onChange={(event) => setNumber("maxRetries", event.target.value)}
            step="1"
            type="number"
            value={policy.maxRetries}
          />
        </label>
        <label>
          Total budget ms
          <input
            aria-label={`${scope} total budget ms`}
            min="1"
            onChange={(event) => setNumber("maxTotalElapsedMs", event.target.value)}
            step="1"
            type="number"
            value={policy.maxTotalElapsedMs}
          />
        </label>
      </div>
      <div className="form-pair retry-number-pair">
        <label>
          Base delay ms
          <input
            aria-label={`${scope} base delay ms`}
            min="0"
            onChange={(event) => setNumber("baseDelayMs", event.target.value)}
            step="1"
            type="number"
            value={policy.baseDelayMs}
          />
        </label>
        <label>
          Max delay ms
          <input
            aria-label={`${scope} max delay ms`}
            min="0"
            onChange={(event) => setNumber("maxDelayMs", event.target.value)}
            step="1"
            type="number"
            value={policy.maxDelayMs}
          />
        </label>
      </div>
      <label>
        Retryable HTTP statuses
        <input
          aria-label={`${scope} retryable HTTP statuses`}
          onChange={(event) =>
            onChange({ ...policy, retryableHttpStatuses: numberList(event.target.value) })
          }
          value={policy.retryableHttpStatuses.join(", ")}
        />
      </label>
      <label>
        Retryable provider codes
        <input
          aria-label={`${scope} retryable provider codes`}
          onChange={(event) =>
            onChange({ ...policy, retryableProviderCodes: stringList(event.target.value) })
          }
          value={policy.retryableProviderCodes.join(", ")}
        />
      </label>
      <div className="retry-toggle-grid">
        <Toggle
          checked={policy.retryOnConnectionFailure}
          label="Connection failure"
          onChange={(checked) => onChange({ ...policy, retryOnConnectionFailure: checked })}
          scope={scope}
        />
        <Toggle
          checked={policy.retryOnConnectTimeout}
          label="Connect timeout"
          onChange={(checked) => onChange({ ...policy, retryOnConnectTimeout: checked })}
          scope={scope}
        />
        <Toggle
          checked={policy.retryOnFirstByteTimeout}
          label="First byte timeout"
          onChange={(checked) => onChange({ ...policy, retryOnFirstByteTimeout: checked })}
          scope={scope}
        />
      </div>
    </div>
  );
}

function Toggle({
  checked,
  label,
  onChange,
  scope,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  scope: string;
}) {
  return (
    <label className="checkbox-label">
      <input
        aria-label={`${scope} ${label.toLowerCase()}`}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

function numberList(value: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number);
}

function stringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueEndpoints(selections: ProviderSelection[]): ProviderSelection[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    if (seen.has(selection.endpoint.id)) {
      return false;
    }
    seen.add(selection.endpoint.id);
    return true;
  });
}
