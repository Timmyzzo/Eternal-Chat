import type { ProviderSelection } from "@/application/chat/chatService";

export function ProviderCatalogSummary({ selections }: { selections: ProviderSelection[] }) {
  if (selections.length === 0) return null;
  return (
    <section className="settings-section provider-catalog-summary">
      <h2>Configured endpoints</h2>
      <div className="provider-catalog-list" role="list">
        {selections.map((selection) => (
          <div
            className="provider-catalog-row"
            data-connection-id={selection.connection.id}
            data-port={selection.endpoint.explicitPort ?? "default"}
            data-profile={selection.profile.codecId}
            key={selection.model.id}
            role="listitem"
          >
            <div>
              <strong>{selection.model.displayName}</strong>
              <span>
                {selection.connection.name} · {formatPort(selection)}
              </span>
            </div>
            <code>{formatEndpoint(selection)}</code>
            <div>
              <span>{selection.profile.name}</span>
              <code>{selection.model.modelId}</code>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatPort(selection: ProviderSelection): string {
  return selection.endpoint.explicitPort === null
    ? "default port"
    : `port ${selection.endpoint.explicitPort}`;
}

function formatEndpoint(selection: ProviderSelection): string {
  try {
    const base = new URL(selection.endpoint.baseUrl);
    if (selection.endpoint.explicitPort !== null) {
      base.port = String(selection.endpoint.explicitPort);
    }
    const prefix = base.toString().replace(/\/$/, "");
    const path = selection.endpoint.pathTemplate.startsWith("/")
      ? selection.endpoint.pathTemplate
      : `/${selection.endpoint.pathTemplate}`;
    return `${prefix}${path}`;
  } catch {
    return `${selection.endpoint.baseUrl}${selection.endpoint.pathTemplate}`;
  }
}
