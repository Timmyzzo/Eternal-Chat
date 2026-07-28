import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";

import { DynamicConfigurationFields, DynamicToolFields } from "@/app/DynamicConfigurationFields";
import {
  jsonObjectFromText,
  type ChatService,
  type ProviderSelection,
} from "@/application/chat/chatService";
import {
  validateParameterCatalog,
  validateToolCatalog,
} from "@/application/providers/configurationSchema";
import { Button } from "@/components/ui/button";
import type { Conversation } from "@/domain/chat";
import type { JsonObject } from "@/domain/json";

export function ConversationOverrideSettings({
  conversation,
  onChanged,
  selection,
  service,
}: {
  conversation: Conversation | null;
  onChanged: () => void;
  selection: ProviderSelection | null;
  service: ChatService;
}) {
  const [params, setParams] = useState("{}");
  const [body, setBody] = useState("{}");
  const [headers, setHeaders] = useState("{}");
  const [query, setQuery] = useState("{}");
  const [path, setPath] = useState("{}");
  const [tools, setTools] = useState("{}");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setParams(pretty(conversation?.params ?? {}));
    setBody(pretty(conversation?.extraBody ?? {}));
    setHeaders(pretty(conversation?.extraHeaders ?? {}));
    setQuery(pretty(conversation?.extraQuery ?? {}));
    setPath(pretty(conversation?.extraPath ?? {}));
    setTools(pretty(conversation?.toolsOverride ?? {}));
  }, [conversation]);

  const parameterDefinitions = useMemo(() => {
    try {
      return selection ? validateParameterCatalog(selection.model.paramsSchema) : [];
    } catch {
      return [];
    }
  }, [selection]);
  const toolDefinitions = useMemo(() => {
    try {
      return selection ? validateToolCatalog(selection.model.builtInTools) : [];
    } catch {
      return [];
    }
  }, [selection]);
  const parameterValues = safeObject(params);
  const toolValues = safeObject(tools);

  const save = async () => {
    if (!conversation) return;
    setError(null);
    try {
      await service.updateConversationConfiguration(conversation.id, {
        params: jsonObjectFromText(params, "Conversation parameters"),
        extraBody: jsonObjectFromText(body, "Conversation body"),
        extraHeaders: jsonObjectFromText(headers, "Conversation headers"),
        extraQuery: jsonObjectFromText(query, "Conversation query"),
        extraPath: jsonObjectFromText(path, "Conversation path"),
        toolsOverride: jsonObjectFromText(tools, "Conversation tools"),
      });
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Conversation overrides could not be saved.",
      );
    }
  };

  return (
    <section className="settings-section" data-ui="conversation.overrides">
      <h2>Conversation overrides</h2>
      {conversation ? (
        <>
          <DynamicConfigurationFields
            definitions={parameterDefinitions}
            onChange={(id, value) => setParams(pretty({ ...parameterValues, [id]: value }))}
            values={parameterValues}
          />
          <DynamicToolFields
            definitions={toolDefinitions}
            onChange={(id, mode) => setTools(pretty({ ...toolValues, [id]: { mode } }))}
            settings={toolValues}
          />
          <details className="advanced-settings">
            <summary>Conversation raw overrides</summary>
            <JsonField
              label="Conversation parameter values JSON"
              onChange={setParams}
              value={params}
            />
            <JsonField label="Conversation body JSON" onChange={setBody} value={body} />
            <JsonField label="Conversation headers JSON" onChange={setHeaders} value={headers} />
            <JsonField label="Conversation query JSON" onChange={setQuery} value={query} />
            <JsonField label="Conversation path JSON" onChange={setPath} value={path} />
            <JsonField label="Conversation tools JSON" onChange={setTools} value={tools} />
          </details>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            aria-label="Save conversation overrides"
            onClick={() => void save()}
            type="button"
          >
            <Save aria-hidden="true" className="size-4" />
            Save overrides
          </Button>
        </>
      ) : (
        <p className="inspector-empty">No conversation selected</p>
      )}
    </section>
  );
}

function JsonField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label>
      {label}
      <textarea
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        value={value}
      />
    </label>
  );
}

function safeObject(value: string): JsonObject {
  try {
    return jsonObjectFromText(value, "JSON");
  } catch {
    return {};
  }
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
