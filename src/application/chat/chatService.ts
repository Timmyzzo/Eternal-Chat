import { ActiveRequestRegistry } from "@/application/chat/activeRequestRegistry";
import {
  prepareOpenAIDispatch,
  type AuthBinding,
  type CredentialResolver,
  type PreparedDispatch,
} from "@/application/chat/requestAssembler";
import {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  type RetryPolicy,
} from "@/application/chat/retryPolicy";
import { ContextAssembler, preflightLosslessBudget } from "@/application/context/contextAssembler";
import { validateParameterCatalog } from "@/application/providers/configurationSchema";
import { projectTrackedPreset } from "@/application/providers/presetLifecycle";
import {
  classifyCompatibilityEvidence,
  isCompatibilityEvidenceCurrent,
} from "@/application/providers/compatibilityEvidence";
import type {
  Conversation,
  ConversationSearchResult,
  Message,
  MessageBlocks,
  MessagePage,
  MessageSiblingInfo,
  RequestAttempt,
  RequestSnapshot,
} from "@/domain/chat";
import type { LosslessBudgetPreflightResult } from "@/domain/context";
import type { CanonicalContext } from "@/domain/context";
import type { JsonObject, JsonValue } from "@/domain/json";
import type {
  Model,
  ParameterCompatibilityProbe,
  PresetBinding,
  ProtocolProfile,
  ProviderConnection,
  ProviderEndpoint,
} from "@/domain/provider";
import type {
  AssistantSiblingInput,
  FinalizeChatRequestInput,
  FinalizeRequestAttemptInput,
  InterruptWaitingRetryInput,
  MessageParentChain,
  PendingTurn,
  PendingTurnInput,
  ScheduleRetryInput,
} from "@/infrastructure/db/phase3Repository";
import { rootMessageId } from "@/infrastructure/db/phase3Repository";
import type { DesktopBridge } from "@/infrastructure/desktop/desktopBridge";
import type { PipeEvent } from "@/infrastructure/desktop/pipeContract";
import {
  createOfficialProtocolPresets,
  listOfficialModelPresets,
  type OfficialModelPreset,
} from "@/infrastructure/providers/officialPresetRegistry";
import { OPENAI_CHAT_COMPLETIONS_CODEC } from "@/infrastructure/providers/openai/protocolProfiles";

export interface ChatRepository {
  createAssistantSibling(input: AssistantSiblingInput): Promise<Message>;
  createConversation(value: Conversation): Promise<Conversation>;
  createPendingTurn(input: PendingTurnInput): Promise<PendingTurn>;
  createRequestSnapshot(value: RequestSnapshot): Promise<void>;
  finalizeChatRequest(input: FinalizeChatRequestInput): Promise<boolean>;
  finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean>;
  getApplicationRetryPolicy(): Promise<JsonValue | null>;
  interruptWaitingRetry(input: InterruptWaitingRetryInput): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  findLatestLeafDescendant(messageId: string): Promise<string | null>;
  getMessage(id: string): Promise<Message | null>;
  getModel(id: string): Promise<Model | null>;
  getProtocolProfile(id: string): Promise<ProtocolProfile | null>;
  getProviderConnection(id: string): Promise<ProviderConnection | null>;
  getProviderEndpoint(id: string): Promise<ProviderEndpoint | null>;
  getRequestSnapshotByAssistant(assistantMessageId: string): Promise<RequestSnapshot | null>;
  insertModel(value: Model): Promise<void>;
  insertCompatibilityProbe(value: ParameterCompatibilityProbe): Promise<void>;
  insertProtocolProfile(value: ProtocolProfile): Promise<void>;
  insertProviderConnection(value: ProviderConnection): Promise<void>;
  insertProviderEndpoint(value: ProviderEndpoint): Promise<void>;
  updateProtocolProfile(value: ProtocolProfile): Promise<void>;
  updateModel(value: Model): Promise<void>;
  updateProviderEndpoint(value: ProviderEndpoint): Promise<void>;
  updateConversationConfiguration(value: Conversation): Promise<void>;
  updateConversationMetadata(value: Conversation): Promise<void>;
  listActiveBranchPage(
    conversationId: string,
    cursor?: { createdAt: number; id: string } | null,
    limit?: number,
  ): Promise<MessagePage>;
  listConversations(archived?: boolean): Promise<Conversation[]>;
  listMessageSiblingInfo(messageIds: string[]): Promise<MessageSiblingInfo[]>;
  listModels(endpointId?: string): Promise<Model[]>;
  listCompatibilityProbes(modelRef?: string): Promise<ParameterCompatibilityProbe[]>;
  listProtocolProfiles(): Promise<ProtocolProfile[]>;
  listProviderConnections(): Promise<ProviderConnection[]>;
  listProviderEndpoints(connectionId?: string): Promise<ProviderEndpoint[]>;
  listRequestAttempts(snapshotId: string): Promise<RequestAttempt[]>;
  searchConversations(
    query: string,
    archived?: boolean,
    limit?: number,
  ): Promise<ConversationSearchResult[]>;
  setActiveLeaf(conversationId: string, messageId: string, updatedAt: number): Promise<void>;
  markRequestRunning(
    snapshotId: string,
    assistantMessageId: string,
    startedAt: number,
  ): Promise<void>;
  readMessageParentChain(anchorMessageId: string): Promise<MessageParentChain>;
  scheduleRetry(input: ScheduleRetryInput): Promise<void>;
  setApplicationRetryPolicy(policy: JsonValue, updatedAt: number): Promise<void>;
  startLogicalRequest(snapshot: RequestSnapshot, attempt: RequestAttempt): Promise<void>;
  startRetryAttempt(assistantMessageId: string, attempt: RequestAttempt): Promise<void>;
  updateProviderEndpointRetryPolicy(
    endpointId: string,
    retryPolicy: JsonValue | null,
    updatedAt: number,
  ): Promise<void>;
  updateMessage(
    id: string,
    status: Message["status"],
    blocks: MessageBlocks,
    updatedAt: number,
  ): Promise<void>;
}

export interface ProviderSelection {
  connection: ProviderConnection;
  endpoint: ProviderEndpoint;
  model: Model;
  profile: ProtocolProfile;
}

export interface CompatibilityEvidence {
  current: boolean;
  probe: ParameterCompatibilityProbe;
}

export interface RunCompatibilityProbeInput {
  parameterId: string;
  testedValue: JsonValue;
}

export interface CreateProviderConfigurationInput {
  authBindings: AuthBinding[];
  baseUrl: string;
  connectionId?: string;
  connectionName: string;
  explicitPort: number | null;
  capabilitySchema?: JsonValue;
  paramsSchema?: JsonValue;
  parameterValues?: JsonValue;
  builtInTools?: JsonValue;
  toolSettings?: JsonValue;
  bodyDefaults?: JsonObject;
  extraBody?: JsonObject;
  extraHeaders?: JsonObject;
  extraQuery?: JsonObject;
  extraPath?: JsonObject;
  headers?: JsonObject;
  method?: string;
  modelDisplayName: string;
  modelId: string;
  path: string;
  pathDefaults?: JsonObject;
  profileId: string;
  query?: JsonObject;
  reasoningDeltaPaths?: string[];
  retryPolicy?: JsonValue | null;
  source?: JsonValue | null;
  presetBinding?: PresetBinding | null;
  timeoutMs?: number | null;
}

export type ConversationConfigurationInput = Pick<
  Conversation,
  "extraBody" | "extraHeaders" | "extraPath" | "extraQuery" | "params" | "toolsOverride"
>;

export interface SendMessageResult {
  budget: LosslessBudgetPreflightResult;
  dispatch: PreparedDispatch;
}

export interface ConversationMessageWindow {
  messages: Message[];
  nextCursor: MessagePage["nextCursor"];
  siblings: MessageSiblingInfo[];
}

export class BudgetConfirmationRequiredError extends Error {
  readonly name = "BudgetConfirmationRequiredError";

  constructor(readonly budget: LosslessBudgetPreflightResult) {
    super("The lossless request is over the configured context limit");
  }
}

export class ChatService {
  private applicationRetryPolicy: RetryPolicy = structuredClone(DEFAULT_RETRY_POLICY);
  private readonly assembler: ContextAssembler;
  private readonly preparingConversationIds = new Set<string>();

  constructor(
    private readonly repository: ChatRepository,
    private readonly registry: ActiveRequestRegistry,
    private readonly credentialResolver: CredentialResolver,
    private readonly bridge: DesktopBridge,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    this.assembler = new ContextAssembler(repository);
  }

  async openExternal(url: string): Promise<void> {
    await this.bridge.openExternal(url);
  }

  async ensureProtocolPresets(): Promise<void> {
    const now = this.now();
    for (const preset of createOfficialProtocolPresets(now)) {
      const existing = await this.repository.getProtocolProfile(preset.id);
      if (!existing) {
        await this.repository.insertProtocolProfile(preset);
      } else if (
        existing.presetBinding?.mode === "tracked" &&
        existing.presetBinding.baseRevision < preset.revision
      ) {
        await this.repository.updateProtocolProfile(
          upgradeTrackedProtocolProfile(existing, preset, now),
        );
      }
    }
  }

  async ensureProviderPresets(): Promise<void> {
    const presets = new Map(listOfficialModelPresets().map((preset) => [preset.id, preset]));
    const now = this.now();
    for (const endpoint of await this.repository.listProviderEndpoints()) {
      const binding = endpoint.presetBinding;
      if (binding?.mode === "tracked") {
        const preset = presets.get(binding.presetId);
        if (preset && binding.baseRevision < preset.source.revision) {
          await this.repository.updateProviderEndpoint(
            upgradeTrackedProviderEndpoint(endpoint, preset, now),
          );
        }
      }
      for (const model of await this.repository.listModels(endpoint.id)) {
        const modelBinding = model.presetBinding;
        if (modelBinding?.mode !== "tracked") continue;
        const preset = presets.get(modelBinding.presetId);
        if (preset && modelBinding.baseRevision < preset.source.revision) {
          await this.repository.updateModel(upgradeTrackedModel(model, preset, now));
        }
      }
    }
  }

  async loadApplicationSettings(): Promise<void> {
    const stored = await this.repository.getApplicationRetryPolicy();
    this.applicationRetryPolicy = resolveRetryPolicy(stored);
  }

  getApplicationRetryPolicy(): RetryPolicy {
    return structuredClone(this.applicationRetryPolicy);
  }

  async setApplicationRetryPolicy(value: JsonValue): Promise<RetryPolicy> {
    const policy = resolveRetryPolicy(value);
    await this.repository.setApplicationRetryPolicy(policy, this.now());
    this.applicationRetryPolicy = policy;
    return structuredClone(policy);
  }

  async updateEndpointRetryPolicy(
    endpointId: string,
    override: JsonValue | null,
  ): Promise<RetryPolicy> {
    const endpoint = await this.repository.getProviderEndpoint(endpointId);
    if (!endpoint) {
      throw new Error("The selected endpoint does not exist");
    }
    const effective = resolveRetryPolicy(override, this.applicationRetryPolicy);
    await this.repository.updateProviderEndpointRetryPolicy(endpoint.id, override, this.now());
    return effective;
  }

  async listProviderSelections(): Promise<ProviderSelection[]> {
    const selections: ProviderSelection[] = [];
    for (const connection of await this.repository.listProviderConnections()) {
      for (const endpoint of await this.repository.listProviderEndpoints(connection.id)) {
        for (const model of await this.repository.listModels(endpoint.id)) {
          const profileId = model.protocolProfileOverrideId ?? endpoint.protocolProfileId;
          const profile = await this.repository.getProtocolProfile(profileId);
          if (profile) {
            selections.push({ connection, endpoint, model, profile });
          }
        }
      }
    }
    return selections;
  }

  async listCompatibilityEvidence(modelRef: string): Promise<CompatibilityEvidence[]> {
    const model = await this.repository.getModel(modelRef);
    if (!model) throw new Error("The selected model does not exist");
    const endpoint = await this.repository.getProviderEndpoint(model.endpointId);
    if (!endpoint) throw new Error("The selected endpoint does not exist");
    const profile = await this.repository.getProtocolProfile(
      model.protocolProfileOverrideId ?? endpoint.protocolProfileId,
    );
    if (!profile) throw new Error("The selected protocol profile does not exist");
    const current = {
      endpointId: endpoint.id,
      modelRef: model.id,
      apiVersion: endpoint.apiVersion,
      protocolProfileId: profile.id,
      protocolProfileRevision: profile.revision,
    };
    return (await this.repository.listCompatibilityProbes(model.id)).map((probe) => ({
      current: isCompatibilityEvidenceCurrent(probe, current),
      probe,
    }));
  }

  async runCompatibilityProbe(
    modelRef: string,
    input: RunCompatibilityProbeInput,
  ): Promise<CompatibilityEvidence> {
    const selection = await this.requireSelectionForModel(modelRef);
    const definition = validateParameterCatalog(selection.model.paramsSchema).find(
      (candidate) => candidate.id === input.parameterId,
    );
    if (!definition) throw new Error("The selected parameter does not exist");

    const now = this.now();
    const requestId = `compatibility-probe-${this.createId()}`;
    const context = compatibilityProbeContext(requestId);
    const dispatch = await prepareOpenAIDispatch({
      assistantPlaceholder: compatibilityProbeMessage(
        `${requestId}-assistant`,
        context.conversationId,
        "assistant",
        now,
      ),
      connection: selection.connection,
      context,
      conversationExtraBody: {},
      conversationExtraHeaders: {},
      conversationExtraPath: {},
      conversationExtraQuery: {},
      conversationParams: { [definition.id]: input.testedValue },
      conversationToolsOverride: {},
      credentialResolver: this.credentialResolver,
      endpoint: selection.endpoint,
      model: {
        ...selection.model,
        parameterValues: {},
        toolSettings: {},
      },
      now,
      profile: selection.profile,
      requestId,
      snapshotId: `${requestId}-snapshot`,
      userMessage: compatibilityProbeMessage(
        `${requestId}-user`,
        context.conversationId,
        "user",
        now,
      ),
    });

    const terminal: { event: Extract<PipeEvent, { type: "done" | "error" }> | null } = {
      event: null,
    };
    await this.bridge.startStream(dispatch.transportRequest, (event) => {
      if (event.type === "done" || event.type === "error") terminal.event = event;
    });
    if (!terminal.event) throw new Error("The compatibility probe ended without a terminal event");

    const terminalEvent = terminal.event;
    const httpStatus = terminalEvent.type === "done" ? 200 : (terminalEvent.error.status ?? null);
    const probe: ParameterCompatibilityProbe = {
      id: `probe-${this.createId()}`,
      endpointId: selection.endpoint.id,
      modelRef: selection.model.id,
      protocolProfileId: selection.profile.id,
      protocolProfileRevision: selection.profile.revision,
      apiVersion: selection.endpoint.apiVersion,
      parameterId: definition.id,
      placement: definition.placement,
      wirePath: definition.path,
      testedValue: structuredClone(input.testedValue),
      status: classifyCompatibilityEvidence({ httpStatus }),
      evidenceType: "minimal_probe",
      requestFingerprint: dispatch.requestSnapshot.requestBodyHash,
      httpStatus,
      providerErrorCode: null,
      note: terminalEvent.type === "error" ? terminalEvent.error.message : null,
      checkedAt: this.now(),
    };
    await this.repository.insertCompatibilityProbe(probe);
    return { current: true, probe };
  }

  listConversations(archived = false): Promise<Conversation[]> {
    return this.repository.listConversations(archived);
  }

  listProtocolProfiles(): Promise<ProtocolProfile[]> {
    return this.repository.listProtocolProfiles();
  }

  searchConversations(
    query: string,
    archived = false,
    limit = 40,
  ): Promise<ConversationSearchResult[]> {
    const normalized = query.trim().slice(0, 160);
    return normalized === ""
      ? Promise.resolve([])
      : this.repository.searchConversations(normalized, archived, limit);
  }

  async loadConversationWindow(
    conversationId: string,
    cursor: MessagePage["nextCursor"] = null,
    limit = 50,
  ): Promise<ConversationMessageWindow> {
    const conversation = await this.requireConversation(conversationId);
    if (!conversation.activeLeafMessageId) {
      return { messages: [], nextCursor: null, siblings: [] };
    }
    const page = await this.repository.listActiveBranchPage(conversationId, cursor, limit);
    const messages = orderBranchPage(page.messages);
    return {
      messages,
      nextCursor: page.nextCursor,
      siblings: await this.repository.listMessageSiblingInfo(messages.map((message) => message.id)),
    };
  }

  async loadConversationMessages(conversationId: string): Promise<Message[]> {
    return (await this.loadConversationWindow(conversationId)).messages;
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    const updated = { ...conversation, archived, updatedAt: this.now() };
    await this.repository.updateConversationMetadata(updated);
    return updated;
  }

  async activateSearchResult(result: ConversationSearchResult): Promise<void> {
    if (!result.messageId) {
      await this.requireConversation(result.conversationId);
      return;
    }
    const message = await this.repository.getMessage(result.messageId);
    if (!message || message.conversationId !== result.conversationId || message.role === "root") {
      throw new Error("The search result is no longer available");
    }
    if (this.registry.hasActiveForConversation(result.conversationId)) {
      throw new Error("Stop the active request before changing branches");
    }
    await this.repository.setActiveLeaf(result.conversationId, message.id, this.now());
  }

  async switchMessageSibling(messageId: string, direction: -1 | 1): Promise<string> {
    const message = await this.repository.getMessage(messageId);
    if (!message || message.role === "root") {
      throw new Error("The message branch is no longer available");
    }
    if (this.registry.hasActiveForConversation(message.conversationId)) {
      throw new Error("Stop the active request before changing branches");
    }
    const info = (await this.repository.listMessageSiblingInfo([message.id]))[0];
    if (!info || info.siblingIds.length < 2) {
      return message.id;
    }
    const targetIndex = Math.min(info.siblingIds.length - 1, Math.max(0, info.index + direction));
    const targetId = info.siblingIds[targetIndex];
    if (!targetId) {
      return message.id;
    }
    const targetLeafId = (await this.repository.findLatestLeafDescendant(targetId)) ?? targetId;
    await this.repository.setActiveLeaf(message.conversationId, targetLeafId, this.now());
    return targetId;
  }

  getSnapshotForAssistant(assistantMessageId: string): Promise<RequestSnapshot | null> {
    return this.repository.getRequestSnapshotByAssistant(assistantMessageId);
  }

  async listRequestAttemptsForAssistant(assistantMessageId: string): Promise<RequestAttempt[]> {
    const snapshot = await this.repository.getRequestSnapshotByAssistant(assistantMessageId);
    return snapshot ? this.repository.listRequestAttempts(snapshot.id) : [];
  }

  async createProviderConfiguration(
    input: CreateProviderConfigurationInput,
  ): Promise<ProviderSelection> {
    const now = this.now();
    const baseProfile = await this.repository.getProtocolProfile(input.profileId);
    if (!baseProfile) {
      throw new Error("The selected protocol profile does not exist");
    }

    let profile = baseProfile;
    if (
      baseProfile.codecId === OPENAI_CHAT_COMPLETIONS_CODEC &&
      input.reasoningDeltaPaths &&
      input.reasoningDeltaPaths.length > 0
    ) {
      profile = {
        ...baseProfile,
        id: `profile-${this.createId()}`,
        name: `${baseProfile.name} (custom mapping)`,
        responseMapping: { reasoningDeltaPaths: input.reasoningDeltaPaths },
        source: { kind: "user", basedOn: baseProfile.id },
        presetBinding: {
          mode: "detached",
          forkedFromPresetId: baseProfile.id,
          forkedFromRevision: baseProfile.revision,
        },
        userEdited: true,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.insertProtocolProfile(profile);
    }

    const existingConnection = input.connectionId
      ? await this.repository.getProviderConnection(input.connectionId)
      : null;
    if (input.connectionId && !existingConnection) {
      throw new Error("The selected provider connection does not exist");
    }
    const connection: ProviderConnection = existingConnection ?? {
      id: `connection-${this.createId()}`,
      name: input.connectionName.trim(),
      vendorHint: null,
      description: "Phase 6 configurable provider connection",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const endpoint: ProviderEndpoint = {
      id: `endpoint-${this.createId()}`,
      connectionId: connection.id,
      name: `${connection.name} endpoint`,
      baseUrl: input.baseUrl.trim(),
      explicitPort: input.explicitPort,
      pathTemplate: input.path.trim(),
      method: (input.method ?? "POST").trim().toUpperCase(),
      apiVersion: null,
      protocolProfileId: profile.id,
      authBindings: input.authBindings.map((binding) => ({
        credentialKey: binding.credentialKey,
        name: binding.name,
        placement: binding.placement,
        ...(binding.prefix ? { prefix: binding.prefix } : {}),
      })),
      headers: input.headers ?? {},
      query: input.query ?? {},
      bodyDefaults: input.bodyDefaults ?? {},
      pathDefaults: input.pathDefaults ?? {},
      source: input.source ?? null,
      presetBinding: input.presetBinding ?? null,
      timeoutMs: input.timeoutMs ?? 60_000,
      retryPolicy: input.retryPolicy ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const model: Model = {
      id: `model-${this.createId()}`,
      endpointId: endpoint.id,
      modelId: input.modelId.trim(),
      displayName: input.modelDisplayName.trim(),
      capabilitySchema: input.capabilitySchema ?? {},
      paramsSchema: input.paramsSchema ?? [],
      parameterValues: input.parameterValues ?? {},
      builtInTools: input.builtInTools ?? [],
      toolSettings: input.toolSettings ?? {},
      extraBody: input.extraBody ?? {},
      extraHeaders: input.extraHeaders ?? {},
      extraQuery: input.extraQuery ?? {},
      extraPath: input.extraPath ?? {},
      contextWindow: null,
      maxOutputTokens: null,
      protocolProfileOverrideId: null,
      schemaOrigin: "user",
      schemaRevision: 1,
      source: input.source ?? null,
      presetBinding: input.presetBinding ?? null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    if (!existingConnection) {
      await this.repository.insertProviderConnection(connection);
    }
    await this.repository.insertProviderEndpoint(endpoint);
    await this.repository.insertModel(model);
    return { connection, endpoint, model, profile };
  }

  async createConversation(title: string, modelRef: string): Promise<Conversation> {
    const now = this.now();
    return this.repository.createConversation({
      id: `conversation-${this.createId()}`,
      title: title.trim() || "New conversation",
      modelRef,
      systemPrompt: "",
      params: {},
      extraBody: {},
      extraHeaders: {},
      extraQuery: {},
      extraPath: {},
      toolsOverride: {},
      contextPolicy: { mode: "lossless" },
      activeLeafMessageId: null,
      archived: false,
      starred: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateConversationConfiguration(
    conversationId: string,
    input: ConversationConfigurationInput,
  ): Promise<Conversation> {
    const conversation = await this.requireConversation(conversationId);
    const updated: Conversation = {
      ...conversation,
      params: structuredClone(input.params),
      extraBody: structuredClone(input.extraBody),
      extraHeaders: structuredClone(input.extraHeaders),
      extraQuery: structuredClone(input.extraQuery),
      extraPath: structuredClone(input.extraPath),
      toolsOverride: structuredClone(input.toolsOverride),
      updatedAt: this.now(),
    };
    await this.repository.updateConversationConfiguration(updated);
    return updated;
  }

  async preflightMessage(
    conversationId: string,
    draft: string,
  ): Promise<LosslessBudgetPreflightResult> {
    const conversation = await this.requireConversation(conversationId);
    const selection = await this.requireSelection(conversation);
    return this.preflightConversation(
      conversation,
      selection.model,
      conversation.activeLeafMessageId,
      draft,
    );
  }

  async sendMessage(
    conversationId: string,
    text: string,
    allowOverLimit = false,
  ): Promise<SendMessageResult> {
    const draft = text.trim();
    if (draft === "") {
      throw new Error("A message is required");
    }
    return this.withConversationRequestSlot(conversationId, async () => {
      const budget = await this.preflightMessage(conversationId, draft);
      if (budget.status === "over_limit" && !allowOverLimit) {
        throw new BudgetConfirmationRequiredError(budget);
      }

      const conversation = await this.requireConversation(conversationId);
      const selection = await this.requireSelection(conversation);
      const now = this.now();
      const turn = await this.repository.createPendingTurn({
        conversationId,
        parentId: conversation.activeLeafMessageId ?? rootMessageId(conversationId),
        userMessageId: `message-${this.createId()}`,
        userBlocks: { version: 1, blocks: [{ type: "text", text: draft }] },
        assistantMessageId: `message-${this.createId()}`,
        assistantBlocks: { version: 1, blocks: [] },
        assistantModelRef: selection.model.id,
        createdAt: now,
      });
      const dispatch = await this.prepareTurn(conversation, selection, turn, now);
      this.registry.start(dispatch);
      return { budget, dispatch };
    });
  }

  async editUserMessage(
    userMessageId: string,
    text: string,
    allowOverLimit = false,
  ): Promise<SendMessageResult> {
    const previousUser = await this.repository.getMessage(userMessageId);
    const draft = text.trim();
    if (!previousUser || previousUser.role !== "user" || !previousUser.parentId) {
      throw new Error("The user message cannot be edited");
    }
    if (draft === "") {
      throw new Error("A message is required");
    }
    const parentId = previousUser.parentId;
    const conversation = await this.requireConversation(previousUser.conversationId);
    return this.withConversationRequestSlot(conversation.id, async () => {
      const selection = await this.requireSelection(conversation);
      const budget = await this.preflightConversation(
        conversation,
        selection.model,
        parentId,
        draft,
      );
      if (budget.status === "over_limit" && !allowOverLimit) {
        throw new BudgetConfirmationRequiredError(budget);
      }

      const now = this.now();
      const turn = await this.repository.createPendingTurn({
        conversationId: conversation.id,
        parentId,
        userMessageId: `message-${this.createId()}`,
        userBlocks: { version: 1, blocks: [{ type: "text", text: draft }] },
        assistantMessageId: `message-${this.createId()}`,
        assistantBlocks: { version: 1, blocks: [] },
        assistantModelRef: selection.model.id,
        createdAt: now,
      });
      const dispatch = await this.prepareTurn(conversation, selection, turn, now);
      this.registry.start(dispatch);
      return { budget, dispatch };
    });
  }

  async regenerate(assistantMessageId: string, allowOverLimit = false): Promise<SendMessageResult> {
    const previousAssistant = await this.repository.getMessage(assistantMessageId);
    if (
      !previousAssistant ||
      previousAssistant.role !== "assistant" ||
      !previousAssistant.parentId
    ) {
      throw new Error("The assistant message cannot be regenerated");
    }
    const parentUser = await this.repository.getMessage(previousAssistant.parentId);
    if (!parentUser || parentUser.role !== "user") {
      throw new Error("The assistant parent is not a user message");
    }
    const conversation = await this.requireConversation(previousAssistant.conversationId);
    return this.withConversationRequestSlot(conversation.id, async () => {
      const selection = await this.requireSelection(conversation);
      const budget = await this.preflightConversation(
        conversation,
        selection.model,
        parentUser.id,
        "",
      );
      if (budget.status === "over_limit" && !allowOverLimit) {
        throw new BudgetConfirmationRequiredError(budget);
      }

      const now = this.now();
      const assistant = await this.repository.createAssistantSibling({
        conversationId: conversation.id,
        parentUserMessageId: parentUser.id,
        assistantMessageId: `message-${this.createId()}`,
        assistantBlocks: { version: 1, blocks: [] },
        assistantModelRef: selection.model.id,
        createdAt: now,
      });
      const dispatch = await this.prepareTurn(
        conversation,
        selection,
        { userMessage: parentUser, assistantMessage: assistant },
        now,
      );
      this.registry.start(dispatch);
      return { budget, dispatch };
    });
  }

  private async preflightConversation(
    conversation: Conversation,
    model: Model,
    anchorMessageId: string | null,
    draft: string,
  ): Promise<LosslessBudgetPreflightResult> {
    const messages = anchorMessageId
      ? (await this.repository.readMessageParentChain(anchorMessageId)).messages
          .filter((message) => message.role !== "root")
          .reverse()
          .map((message) => ({ blocks: message.blocks, role: message.role }))
      : [];
    const input = JSON.stringify({
      draft,
      messages,
      systemPrompt: conversation.systemPrompt,
    });
    return preflightLosslessBudget({
      contextWindow: model.contextWindow,
      estimatedInputTokens: Math.max(1, Math.ceil(input.length / 4)),
      reservedOutputTokens: model.maxOutputTokens,
    });
  }

  private async withConversationRequestSlot<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      this.preparingConversationIds.has(conversationId) ||
      this.registry.hasActiveForConversation(conversationId)
    ) {
      throw new Error("This conversation already has an active request");
    }
    this.preparingConversationIds.add(conversationId);
    try {
      return await operation();
    } finally {
      this.preparingConversationIds.delete(conversationId);
    }
  }

  private async prepareTurn(
    conversation: Conversation,
    selection: ProviderSelection,
    turn: PendingTurn,
    now: number,
  ): Promise<PreparedDispatch> {
    try {
      const context = await this.assembler.assemble({
        anchorMessageId: turn.userMessage.id,
        conversationId: conversation.id,
      });
      const dispatch = await prepareOpenAIDispatch({
        applicationRetryPolicy: this.applicationRetryPolicy,
        assistantPlaceholder: turn.assistantMessage,
        connection: selection.connection,
        context,
        conversationExtraBody: conversation.extraBody,
        conversationExtraHeaders: conversation.extraHeaders,
        conversationExtraQuery: conversation.extraQuery,
        conversationExtraPath: conversation.extraPath,
        conversationParams: conversation.params,
        conversationToolsOverride: conversation.toolsOverride,
        credentialResolver: this.credentialResolver,
        endpoint: selection.endpoint,
        model: selection.model,
        now,
        profile: selection.profile,
        requestId: `request-${this.createId()}`,
        snapshotId: `snapshot-${this.createId()}`,
        userMessage: turn.userMessage,
      });
      return dispatch;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The request could not be prepared.";
      await this.repository.updateMessage(
        turn.assistantMessage.id,
        "error",
        {
          version: 1,
          blocks: [{ type: "error", code: "prepare_failed", message, retryable: false }],
        },
        this.now(),
      );
      throw error;
    }
  }

  private async requireConversation(conversationId: string): Promise<Conversation> {
    const conversation = await this.repository.getConversation(conversationId);
    if (!conversation) {
      throw new Error("The conversation does not exist");
    }
    return conversation;
  }

  private async requireSelection(conversation: Conversation): Promise<ProviderSelection> {
    if (!conversation.modelRef) {
      throw new Error("The conversation has no selected model");
    }
    const model = await this.repository.getModel(conversation.modelRef);
    if (!model) {
      throw new Error("The selected model does not exist");
    }
    const endpoint = await this.repository.getProviderEndpoint(model.endpointId);
    if (!endpoint) {
      throw new Error("The selected endpoint does not exist");
    }
    const connection = await this.repository.getProviderConnection(endpoint.connectionId);
    if (!connection) {
      throw new Error("The selected connection does not exist");
    }
    const profile = await this.repository.getProtocolProfile(
      model.protocolProfileOverrideId ?? endpoint.protocolProfileId,
    );
    if (!profile) {
      throw new Error("The selected protocol profile does not exist");
    }
    return { connection, endpoint, model, profile };
  }

  private async requireSelectionForModel(modelRef: string): Promise<ProviderSelection> {
    const model = await this.repository.getModel(modelRef);
    if (!model) throw new Error("The selected model does not exist");
    const endpoint = await this.repository.getProviderEndpoint(model.endpointId);
    if (!endpoint) throw new Error("The selected endpoint does not exist");
    const connection = await this.repository.getProviderConnection(endpoint.connectionId);
    if (!connection) throw new Error("The selected connection does not exist");
    const profile = await this.repository.getProtocolProfile(
      model.protocolProfileOverrideId ?? endpoint.protocolProfileId,
    );
    if (!profile) throw new Error("The selected protocol profile does not exist");
    return { connection, endpoint, model, profile };
  }
}

function orderBranchPage(messages: Message[]): Message[] {
  if (messages.length < 2) {
    return messages;
  }
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = new Map<string, Message[]>();
  messages.forEach((message) => {
    if (!message.parentId || !byId.has(message.parentId)) {
      return;
    }
    const existing = children.get(message.parentId) ?? [];
    existing.push(message);
    children.set(message.parentId, existing);
  });
  const roots = messages
    .filter((message) => !message.parentId || !byId.has(message.parentId))
    .sort(compareMessages);
  const ordered: Message[] = [];
  const seen = new Set<string>();
  const visit = (message: Message) => {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    ordered.push(message);
    (children.get(message.id) ?? []).sort(compareMessages).forEach(visit);
  };
  roots.forEach(visit);
  messages
    .filter((message) => !seen.has(message.id))
    .sort(compareMessages)
    .forEach(visit);
  return ordered;
}

function compareMessages(left: Message, right: Message): number {
  return (
    left.createdAt - right.createdAt ||
    left.siblingOrder - right.siblingOrder ||
    left.id.localeCompare(right.id)
  );
}

function upgradeTrackedProviderEndpoint(
  existing: ProviderEndpoint,
  preset: OfficialModelPreset,
  now: number,
): ProviderEndpoint {
  if (existing.presetBinding?.mode !== "tracked") return existing;
  const projected = projectTrackedPreset(preset as unknown as JsonObject, existing.presetBinding);
  const endpoint = jsonObjectValue(projected.endpoint);
  return {
    ...existing,
    baseUrl: stringValue(endpoint.baseUrl) ?? preset.endpoint.baseUrl,
    method: stringValue(endpoint.method) ?? preset.endpoint.method,
    pathTemplate: stringValue(endpoint.pathTemplate) ?? preset.endpoint.pathTemplate,
    protocolProfileId: stringValue(endpoint.protocolProfileId) ?? preset.endpoint.protocolProfileId,
    apiVersion: preset.source.appliesTo?.apiVersion ?? null,
    source: (projected.source ?? preset.source) as JsonValue,
    presetBinding: { ...existing.presetBinding, baseRevision: preset.source.revision },
    updatedAt: now,
  };
}

function upgradeTrackedModel(existing: Model, preset: OfficialModelPreset, now: number): Model {
  if (existing.presetBinding?.mode !== "tracked") return existing;
  const projected = projectTrackedPreset(preset as unknown as JsonObject, existing.presetBinding);
  return {
    ...existing,
    modelId: stringValue(projected.modelId) ?? preset.modelId,
    displayName: stringValue(projected.label) ?? preset.label,
    capabilitySchema: projected.capabilities ?? preset.capabilities,
    paramsSchema: projected.parameters ?? (preset.parameters as unknown as JsonValue),
    parameterValues: projected.parameterValues ?? preset.parameterValues,
    builtInTools: projected.tools ?? (preset.tools as unknown as JsonValue),
    toolSettings: projected.toolSettings ?? preset.toolSettings,
    schemaOrigin: "official",
    schemaRevision: preset.source.revision,
    source: (projected.source ?? preset.source) as JsonValue,
    presetBinding: { ...existing.presetBinding, baseRevision: preset.source.revision },
    updatedAt: now,
  };
}

function compatibilityProbeContext(requestId: string): CanonicalContext {
  const conversationId = `${requestId}-conversation`;
  const messageId = `${requestId}-user`;
  return {
    version: 1,
    conversationId,
    anchorMessageId: messageId,
    contextHash: "compatibility-probe",
    system: [],
    turns: [
      {
        messageId,
        role: "user",
        blocks: [
          {
            type: "text",
            text: "Reply with OK.",
            provenance: { messageId, blockIndex: 0 },
          },
        ],
      },
    ],
    manifest: {
      version: 1,
      conversationId,
      anchorMessageId: messageId,
      hash: "compatibility-probe",
      items: [],
      policy: "lossless",
    },
  };
}

function compatibilityProbeMessage(
  id: string,
  conversationId: string,
  role: "user" | "assistant",
  now: number,
): Message {
  return {
    id,
    conversationId,
    role,
    blocks:
      role === "user"
        ? { version: 1, blocks: [{ type: "text", text: "Reply with OK." }] }
        : { version: 1, blocks: [] },
    status: role === "user" ? "done" : "pending",
    usage: null,
    modelRef: null,
    parentId: null,
    siblingOrder: 0,
    providerResponseId: null,
    providerPreviousResponseId: null,
    requestSnapshotId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function jsonObjectValue(value: JsonValue | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function upgradeTrackedProtocolProfile(
  existing: ProtocolProfile,
  preset: ProtocolProfile,
  now: number,
): ProtocolProfile {
  if (existing.presetBinding?.mode !== "tracked") return existing;
  const projected = projectTrackedPreset(
    {
      name: preset.name,
      codecId: preset.codecId,
      requestMapping: preset.requestMapping,
      responseMapping: preset.responseMapping,
      toolsMapping: preset.toolsMapping,
      continuationMapping: preset.continuationMapping,
      source: preset.source,
      userEdited: false,
    } as JsonObject,
    existing.presetBinding,
  );
  return {
    ...preset,
    name: typeof projected.name === "string" ? projected.name : preset.name,
    codecId: typeof projected.codecId === "string" ? projected.codecId : preset.codecId,
    requestMapping: projected.requestMapping ?? preset.requestMapping,
    responseMapping: projected.responseMapping ?? preset.responseMapping,
    toolsMapping: projected.toolsMapping ?? preset.toolsMapping,
    continuationMapping: projected.continuationMapping ?? preset.continuationMapping,
    source: projected.source ?? preset.source,
    userEdited:
      typeof projected.userEdited === "boolean" ? projected.userEdited : existing.userEdited,
    presetBinding: { ...existing.presetBinding, baseRevision: preset.revision },
    createdAt: existing.createdAt,
    updatedAt: now,
  };
}

export class SessionCredentialResolver implements CredentialResolver {
  private readonly values = new Map<string, string>();

  clear(connectionId: string, credentialKey = "apiKey"): void {
    this.values.delete(keyFor(connectionId, credentialKey));
  }

  async resolve(connectionId: string, credentialKey: string): Promise<string | null> {
    return this.values.get(keyFor(connectionId, credentialKey)) ?? null;
  }

  set(connectionId: string, value: string, credentialKey = "apiKey"): void {
    const key = keyFor(connectionId, credentialKey);
    if (value === "") {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

function keyFor(connectionId: string, credentialKey: string): string {
  return `${connectionId}\u0000${credentialKey}`;
}

export function jsonObjectFromText(value: string, label: string): JsonObject {
  const trimmed = value.trim();
  if (trimmed === "") {
    return {};
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!isJsonObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}
