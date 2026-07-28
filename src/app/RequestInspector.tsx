import type { InspectionState } from "@/app/requestInspection";
import type { RequestAttempt } from "@/domain/chat";
import type { LosslessBudgetPreflightResult } from "@/domain/context";

export function RequestInspector({
  budget,
  inspection,
  attempts,
}: {
  attempts: RequestAttempt[];
  budget: LosslessBudgetPreflightResult | null;
  inspection: InspectionState | null;
}) {
  return (
    <div className="inspector-content" data-ui="request.inspector">
      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h2>Preflight</h2>
          <span className={`budget-badge budget-${budget?.status ?? "uncertain"}`}>
            {formatBudgetStatus(budget?.status ?? "uncertain")}
          </span>
        </div>
        <dl className="inspector-list">
          <Row label="Input estimate" value={formatNumber(budget?.estimatedInputTokens)} />
          <Row label="Output reserve" value={formatNumber(budget?.reservedOutputTokens)} />
          <Row label="Context window" value={formatNumber(budget?.contextWindow)} />
          <Row label="Remaining" value={formatNumber(budget?.remainingTokens)} />
        </dl>
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h2>Attempts</h2>
          <span>{attempts.length}</span>
        </div>
        {attempts.length > 0 ? (
          <div className="attempt-list">
            {attempts.map((attempt) => (
              <details className="attempt-detail" key={attempt.id}>
                <summary>
                  <span>Attempt {attempt.attemptNo}</span>
                  <span>{attempt.status.replaceAll("_", " ")}</span>
                </summary>
                <dl className="inspector-list">
                  <Row label="Trigger" value={attempt.trigger.replaceAll("_", " ")} />
                  <Row label="HTTP" value={formatNumber(attempt.httpStatus)} />
                  <Row label="Provider code" value={attempt.providerErrorCode ?? "none"} wrap />
                  <Row label="Retry reason" value={attempt.retryReason ?? "none"} wrap />
                  <Row label="Delay" value={formatDuration(attempt.scheduledDelayMs)} />
                  <Row label="Delay source" value={delaySource(attempt)} />
                  <Row
                    label="Safety boundary"
                    value={attempt.firstSemanticEventAt === null ? "not crossed" : "crossed"}
                  />
                  <Row label="Bytes" value={String(attempt.bytesReceived)} />
                </dl>
              </details>
            ))}
          </div>
        ) : (
          <p className="inspector-empty">No attempts</p>
        )}
      </section>

      <section className="inspector-section">
        <div className="inspector-section-heading">
          <h2>Frozen request</h2>
          <span>{inspection ? inspection.snapshot.status : "none"}</span>
        </div>
        {inspection ? (
          <>
            <dl className="inspector-list">
              <Row label="Method" value={inspection.preview.method} />
              <Row label="URL" value={inspection.preview.url} wrap />
              <Row label="Profile revision" value={String(inspection.profileRevision)} />
              <Row label="Model revision" value={String(inspection.modelRevision)} />
              <Row label="Manifest items" value={String(inspection.manifestItems)} />
              <Row label="Context hash" value={inspection.snapshot.contextHash} wrap />
              <Row label="Body hash" value={inspection.snapshot.requestBodyHash} wrap />
            </dl>
            <h3 className="inspector-subheading">Headers</h3>
            <pre className="request-json">{pretty(inspection.preview.headers)}</pre>
            <h3 className="inspector-subheading">Query</h3>
            <pre className="request-json">{pretty(inspection.preview.query)}</pre>
            <h3 className="inspector-subheading">Body</h3>
            <pre className="request-json">{pretty(inspection.preview.body)}</pre>
            <h3 className="inspector-subheading">Field sources</h3>
            <pre className="request-json">{pretty(inspection.preview.sources)}</pre>
          </>
        ) : (
          <p className="inspector-empty">No prepared request</p>
        )}
      </section>
    </div>
  );
}

function Row({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={wrap ? "wrap-value" : undefined}>{value}</dd>
    </div>
  );
}

function formatBudgetStatus(status: string): string {
  return status.replace("_", " ");
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "unknown" : value.toLocaleString();
}

function formatDuration(value: number | null): string {
  return value === null ? "none" : `${value} ms`;
}

function delaySource(attempt: RequestAttempt): string {
  if (attempt.scheduledDelayMs === null) {
    return "none";
  }
  return attempt.retryAfterMs === null ? "full jitter" : "Retry-After";
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
