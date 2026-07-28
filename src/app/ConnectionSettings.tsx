import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

import { ConversationOverrideSettings } from "@/app/ConversationOverrideSettings";
import { CompatibilityEvidenceSettings } from "@/app/CompatibilityEvidenceSettings";
import { ProviderConfigurationForm } from "@/app/ProviderConfigurationForm";
import { ProviderCatalogSummary } from "@/app/ProviderCatalogSummary";
import { RetryPolicySettings } from "@/app/RetryPolicySettings";
import type {
  ChatService,
  ProviderSelection,
  SessionCredentialResolver,
} from "@/application/chat/chatService";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/domain/chat";
import type { ProtocolProfile } from "@/domain/provider";

export function ConnectionSettings({
  conversation,
  credentials,
  onChanged,
  profiles,
  selections,
  service,
}: {
  conversation: Conversation | null;
  credentials: SessionCredentialResolver;
  onChanged: (selection?: ProviderSelection) => void;
  profiles: ProtocolProfile[];
  selections: ProviderSelection[];
  service: ChatService;
}) {
  const [credentialConnectionId, setCredentialConnectionId] = useState(
    selections[0]?.connection.id ?? "",
  );
  const [sessionToken, setSessionToken] = useState("");

  useEffect(() => {
    if (!selections.some((selection) => selection.connection.id === credentialConnectionId)) {
      setCredentialConnectionId(selections[0]?.connection.id ?? "");
    }
  }, [credentialConnectionId, selections]);

  const saveSessionCredential = () => {
    if (credentialConnectionId) {
      credentials.set(credentialConnectionId, sessionToken);
      setSessionToken("");
      onChanged();
    }
  };
  const conversationSelection =
    selections.find((selection) => selection.model.id === conversation?.modelRef) ?? null;

  return (
    <div className="connection-settings">
      <ProviderCatalogSummary selections={selections} />
      {selections.length > 0 ? (
        <section className="settings-section" aria-labelledby="session-credential-heading">
          <h2 id="session-credential-heading">Session credential</h2>
          <label>
            Connection
            <select
              onChange={(event) => setCredentialConnectionId(event.target.value)}
              value={credentialConnectionId}
            >
              {uniqueConnections(selections).map((selection) => (
                <option key={selection.connection.id} value={selection.connection.id}>
                  {selection.connection.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Token
            <input
              autoComplete="off"
              onChange={(event) => setSessionToken(event.target.value)}
              type="password"
              value={sessionToken}
            />
          </label>
          <Button onClick={saveSessionCredential} type="button" variant="outline">
            <KeyRound aria-hidden="true" className="size-4" />
            Set for session
          </Button>
        </section>
      ) : null}

      <RetryPolicySettings
        onChanged={() => onChanged()}
        selections={selections}
        service={service}
      />
      <ConversationOverrideSettings
        conversation={conversation}
        onChanged={() => onChanged()}
        selection={conversationSelection}
        service={service}
      />
      <CompatibilityEvidenceSettings selections={selections} service={service} />
      <ProviderConfigurationForm
        credentials={credentials}
        onChanged={onChanged}
        profiles={profiles}
        selections={selections}
        service={service}
      />
    </div>
  );
}

function uniqueConnections(selections: ProviderSelection[]): ProviderSelection[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    if (seen.has(selection.connection.id)) return false;
    seen.add(selection.connection.id);
    return true;
  });
}
