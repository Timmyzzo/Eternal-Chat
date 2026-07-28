import type {
  Conversation,
  Message,
  MessageBlocks,
  MessageCursor,
  MessagePage,
  RequestAttempt,
  RequestSnapshot,
} from "@/domain/chat";
import type {
  Model,
  ParameterCompatibilityProbe,
  ProtocolProfile,
  ProviderConnection,
  ProviderEndpoint,
} from "@/domain/provider";
import type { JsonValue } from "@/domain/json";
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

export class InMemoryChatRepository {
  private applicationRetryPolicy: JsonValue | null = null;
  private readonly connections = new Map<string, ProviderConnection>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly endpoints = new Map<string, ProviderEndpoint>();
  private readonly messages = new Map<string, Message>();
  private readonly models = new Map<string, Model>();
  private readonly compatibilityProbes = new Map<string, ParameterCompatibilityProbe>();
  private readonly profiles = new Map<string, ProtocolProfile>();
  private readonly attempts = new Map<string, RequestAttempt>();
  private readonly snapshots = new Map<string, RequestSnapshot>();

  async getApplicationRetryPolicy(): Promise<JsonValue | null> {
    return cloneOrNull(this.applicationRetryPolicy);
  }

  async setApplicationRetryPolicy(policy: JsonValue): Promise<void> {
    this.applicationRetryPolicy = clone(policy);
  }

  async insertProviderConnection(value: ProviderConnection): Promise<void> {
    insertUnique(this.connections, value);
  }

  async getProviderConnection(id: string): Promise<ProviderConnection | null> {
    return cloneOrNull(this.connections.get(id));
  }

  async listProviderConnections(): Promise<ProviderConnection[]> {
    return sorted(this.connections.values(), (value) => value.name);
  }

  async insertProtocolProfile(value: ProtocolProfile): Promise<void> {
    insertUnique(this.profiles, value);
  }

  async updateProtocolProfile(value: ProtocolProfile): Promise<void> {
    if (!this.profiles.has(value.id)) {
      throw new Error(`Protocol profile ${value.id} does not exist`);
    }
    this.profiles.set(value.id, clone(value));
  }

  async getProtocolProfile(id: string): Promise<ProtocolProfile | null> {
    return cloneOrNull(this.profiles.get(id));
  }

  async listProtocolProfiles(): Promise<ProtocolProfile[]> {
    return sorted(this.profiles.values(), (value) => value.name);
  }

  async insertProviderEndpoint(value: ProviderEndpoint): Promise<void> {
    if (!this.connections.has(value.connectionId) || !this.profiles.has(value.protocolProfileId)) {
      throw new Error("Endpoint association is invalid");
    }
    insertUnique(this.endpoints, value);
  }

  async updateProviderEndpoint(value: ProviderEndpoint): Promise<void> {
    if (!this.endpoints.has(value.id)) {
      throw new Error(`Endpoint ${value.id} does not exist`);
    }
    if (!this.connections.has(value.connectionId) || !this.profiles.has(value.protocolProfileId)) {
      throw new Error("Endpoint association is invalid");
    }
    this.endpoints.set(value.id, clone(value));
  }

  async getProviderEndpoint(id: string): Promise<ProviderEndpoint | null> {
    return cloneOrNull(this.endpoints.get(id));
  }

  async updateProviderEndpointRetryPolicy(
    endpointId: string,
    retryPolicy: JsonValue | null,
    updatedAt: number,
  ): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new Error(`Endpoint ${endpointId} does not exist`);
    }
    this.endpoints.set(endpointId, {
      ...endpoint,
      retryPolicy: cloneOrNull(retryPolicy),
      updatedAt,
    });
  }

  async listProviderEndpoints(connectionId?: string): Promise<ProviderEndpoint[]> {
    return sorted(
      [...this.endpoints.values()].filter(
        (endpoint) => connectionId === undefined || endpoint.connectionId === connectionId,
      ),
      (value) => value.name,
    );
  }

  async insertModel(value: Model): Promise<void> {
    if (!this.endpoints.has(value.endpointId)) {
      throw new Error("Model endpoint is invalid");
    }
    insertUnique(this.models, value);
  }

  async updateModel(value: Model): Promise<void> {
    if (!this.models.has(value.id)) {
      throw new Error(`Model ${value.id} does not exist`);
    }
    if (!this.endpoints.has(value.endpointId)) {
      throw new Error("Model endpoint is invalid");
    }
    this.models.set(value.id, clone(value));
  }

  async getModel(id: string): Promise<Model | null> {
    return cloneOrNull(this.models.get(id));
  }

  async listModels(endpointId?: string): Promise<Model[]> {
    return sorted(
      [...this.models.values()].filter(
        (model) => endpointId === undefined || model.endpointId === endpointId,
      ),
      (value) => value.displayName,
    );
  }

  async insertCompatibilityProbe(value: ParameterCompatibilityProbe): Promise<void> {
    if (!this.endpoints.has(value.endpointId) || !this.models.has(value.modelRef)) {
      throw new Error("Compatibility evidence association is invalid");
    }
    insertUnique(this.compatibilityProbes, value);
  }

  async getCompatibilityProbe(id: string): Promise<ParameterCompatibilityProbe | null> {
    return cloneOrNull(this.compatibilityProbes.get(id));
  }

  async listCompatibilityProbes(modelRef?: string): Promise<ParameterCompatibilityProbe[]> {
    return [...this.compatibilityProbes.values()]
      .filter((probe) => modelRef === undefined || probe.modelRef === modelRef)
      .sort((left, right) => right.checkedAt - left.checkedAt || left.id.localeCompare(right.id))
      .map(clone);
  }

  async createConversation(value: Conversation): Promise<Conversation> {
    if (value.activeLeafMessageId !== null) {
      throw new Error("A new conversation cannot start with an active leaf");
    }
    insertUnique(this.conversations, value);
    const root: Message = {
      id: rootMessageId(value.id),
      conversationId: value.id,
      role: "root",
      blocks: { version: 1, blocks: [] },
      status: "done",
      usage: null,
      modelRef: null,
      parentId: null,
      siblingOrder: 0,
      providerResponseId: null,
      providerPreviousResponseId: null,
      requestSnapshotId: null,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
    this.messages.set(root.id, root);
    return clone(value);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return cloneOrNull(this.conversations.get(id));
  }

  async updateConversationConfiguration(value: Conversation): Promise<void> {
    if (!this.conversations.has(value.id)) {
      throw new Error(`Conversation ${value.id} does not exist`);
    }
    this.conversations.set(value.id, clone(value));
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter((conversation) => !conversation.archived)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
      .map(clone);
  }

  async getMessage(id: string): Promise<Message | null> {
    return cloneOrNull(this.messages.get(id));
  }

  async readMessageParentChain(anchorMessageId: string): Promise<MessageParentChain> {
    const chain: Message[] = [];
    const seen = new Set<string>();
    let currentId: string | null = anchorMessageId;
    while (currentId) {
      if (seen.has(currentId)) {
        return { cycleMessageId: currentId, messages: chain, missingParentId: null };
      }
      seen.add(currentId);
      const message = this.messages.get(currentId);
      if (!message) {
        return { cycleMessageId: null, messages: chain, missingParentId: currentId };
      }
      chain.push(clone(message));
      currentId = message.parentId;
    }
    return { cycleMessageId: null, messages: chain, missingParentId: null };
  }

  async createPendingTurn(input: PendingTurnInput): Promise<PendingTurn> {
    const conversation = this.requireConversation(input.conversationId);
    this.requireMessage(input.parentId);
    const userMessage: Message = {
      id: input.userMessageId,
      conversationId: input.conversationId,
      role: "user",
      blocks: clone(input.userBlocks),
      status: "done",
      usage: null,
      modelRef: null,
      parentId: input.parentId,
      siblingOrder: nextSiblingOrder(this.messages.values(), input.parentId),
      providerResponseId: null,
      providerPreviousResponseId: null,
      requestSnapshotId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    const assistantMessage: Message = {
      id: input.assistantMessageId,
      conversationId: input.conversationId,
      role: "assistant",
      blocks: clone(input.assistantBlocks),
      status: "pending",
      usage: null,
      modelRef: input.assistantModelRef,
      parentId: userMessage.id,
      siblingOrder: 0,
      providerResponseId: null,
      providerPreviousResponseId: null,
      requestSnapshotId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    insertUnique(this.messages, userMessage);
    insertUnique(this.messages, assistantMessage);
    this.conversations.set(conversation.id, {
      ...conversation,
      activeLeafMessageId: assistantMessage.id,
      updatedAt: input.createdAt,
    });
    return { userMessage: clone(userMessage), assistantMessage: clone(assistantMessage) };
  }

  async createAssistantSibling(input: AssistantSiblingInput): Promise<Message> {
    const conversation = this.requireConversation(input.conversationId);
    const parent = this.requireMessage(input.parentUserMessageId);
    if (parent.role !== "user" || parent.conversationId !== input.conversationId) {
      throw new Error("Assistant sibling parent is invalid");
    }
    const assistant: Message = {
      id: input.assistantMessageId,
      conversationId: input.conversationId,
      role: "assistant",
      blocks: clone(input.assistantBlocks),
      status: "pending",
      usage: null,
      modelRef: input.assistantModelRef,
      parentId: parent.id,
      siblingOrder: nextSiblingOrder(this.messages.values(), parent.id),
      providerResponseId: null,
      providerPreviousResponseId: null,
      requestSnapshotId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    insertUnique(this.messages, assistant);
    this.conversations.set(conversation.id, {
      ...conversation,
      activeLeafMessageId: assistant.id,
      updatedAt: input.createdAt,
    });
    return clone(assistant);
  }

  async updateMessage(
    id: string,
    status: Message["status"],
    blocks: MessageBlocks,
    updatedAt: number,
  ): Promise<void> {
    const message = this.requireMessage(id);
    this.messages.set(id, { ...message, blocks: clone(blocks), status, updatedAt });
  }

  async listActiveBranchPage(
    conversationId: string,
    cursor: MessageCursor | null = null,
    limit = 50,
  ): Promise<MessagePage> {
    const conversation = this.requireConversation(conversationId);
    const branch: Message[] = [];
    let currentId = conversation.activeLeafMessageId;
    while (currentId) {
      const message = this.requireMessage(currentId);
      if (message.role !== "root") {
        branch.push(message);
      }
      currentId = message.parentId;
    }
    const filtered = branch
      .filter(
        (message) =>
          !cursor ||
          message.createdAt < cursor.createdAt ||
          (message.createdAt === cursor.createdAt && message.id < cursor.id),
      )
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const messages = filtered.slice(0, limit).map(clone);
    const oldest = messages.at(-1);
    return {
      messages,
      nextCursor:
        filtered.length > limit && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null,
    };
  }

  async createRequestSnapshot(value: RequestSnapshot): Promise<void> {
    insertUnique(this.snapshots, value);
    if (value.assistantMessageId) {
      const assistant = this.requireMessage(value.assistantMessageId);
      this.messages.set(assistant.id, { ...assistant, requestSnapshotId: value.id });
    }
  }

  async startLogicalRequest(snapshot: RequestSnapshot, attempt: RequestAttempt): Promise<void> {
    const assistant = this.requireMessage(snapshot.assistantMessageId ?? "");
    if (
      snapshot.status !== "pending" ||
      snapshot.attemptCount !== 0 ||
      attempt.requestSnapshotId !== snapshot.id ||
      attempt.attemptNo !== 1 ||
      attempt.trigger !== "initial" ||
      attempt.requestBodyHash !== snapshot.requestBodyHash ||
      assistant.status !== "pending" ||
      assistant.requestSnapshotId !== null
    ) {
      throw new Error("The logical request cannot be started");
    }
    insertUnique(this.snapshots, {
      ...snapshot,
      attemptCount: 1,
      startedAt: attempt.startedAt,
      status: "running",
    });
    insertUnique(this.attempts, attempt);
    this.messages.set(assistant.id, {
      ...assistant,
      requestSnapshotId: snapshot.id,
      status: "streaming",
      updatedAt: attempt.startedAt,
    });
  }

  async getRequestAttempt(id: string): Promise<RequestAttempt | null> {
    return cloneOrNull(this.attempts.get(id));
  }

  async listRequestAttempts(snapshotId: string): Promise<RequestAttempt[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.requestSnapshotId === snapshotId)
      .sort((left, right) => left.attemptNo - right.attemptNo)
      .map(clone);
  }

  async scheduleRetry(input: ScheduleRetryInput): Promise<void> {
    const snapshot = this.requireSnapshot(input.snapshotId);
    const assistant = this.requireMessage(input.assistantMessageId);
    const attempt = this.requireAttempt(input.attemptId);
    if (
      snapshot.status !== "running" ||
      assistant.requestSnapshotId !== snapshot.id ||
      (assistant.status !== "pending" && assistant.status !== "streaming") ||
      attempt.requestSnapshotId !== snapshot.id ||
      attempt.status !== "running"
    ) {
      throw new Error("The retry cannot be scheduled");
    }
    this.attempts.set(attempt.id, {
      ...attempt,
      bytesReceived: input.bytesReceived,
      completedAt: input.completedAt,
      firstByteAt: input.firstByteAt,
      firstSemanticEventAt: input.firstSemanticEventAt,
      httpStatus: input.httpStatus,
      providerErrorCode: input.providerErrorCode,
      retryable: true,
      retryAfterMs: input.retryAfterMs,
      retryReason: input.retryReason,
      scheduledDelayMs: input.scheduledDelayMs,
      semanticEventCount: input.semanticEventCount,
      status: "retryable_failed",
    });
    this.messages.set(assistant.id, {
      ...assistant,
      status: "waiting_retry",
      updatedAt: input.completedAt,
    });
  }

  async startRetryAttempt(assistantMessageId: string, attempt: RequestAttempt): Promise<void> {
    const snapshot = this.requireSnapshot(attempt.requestSnapshotId);
    const assistant = this.requireMessage(assistantMessageId);
    if (
      snapshot.status !== "running" ||
      snapshot.attemptCount !== attempt.attemptNo - 1 ||
      snapshot.requestBodyHash !== attempt.requestBodyHash ||
      attempt.trigger !== "automatic_retry" ||
      assistant.requestSnapshotId !== snapshot.id ||
      assistant.status !== "waiting_retry"
    ) {
      throw new Error("The retry attempt cannot be started");
    }
    insertUnique(this.attempts, attempt);
    this.snapshots.set(snapshot.id, { ...snapshot, attemptCount: attempt.attemptNo });
    this.messages.set(assistant.id, {
      ...assistant,
      status: "streaming",
      updatedAt: attempt.startedAt,
    });
  }

  async finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean> {
    const snapshot = this.requireSnapshot(input.snapshotId);
    const assistant = this.requireMessage(input.assistantMessageId);
    const attempt = this.requireAttempt(input.attemptId);
    if (attempt.status !== "running") {
      return false;
    }
    if (
      snapshot.status !== "running" ||
      attempt.requestSnapshotId !== snapshot.id ||
      assistant.requestSnapshotId !== snapshot.id ||
      (assistant.status !== "pending" &&
        assistant.status !== "waiting_retry" &&
        assistant.status !== "streaming")
    ) {
      throw new Error("The request attempt cannot be finalized");
    }
    this.attempts.set(attempt.id, {
      ...attempt,
      bytesReceived: input.bytesReceived,
      completedAt: input.completedAt,
      firstByteAt: input.firstByteAt,
      firstSemanticEventAt: input.firstSemanticEventAt,
      httpStatus: input.httpStatus,
      providerErrorCode: input.providerErrorCode,
      retryable: false,
      retryReason: input.retryReason,
      semanticEventCount: input.semanticEventCount,
      status: input.attemptStatus,
    });
    this.messages.set(assistant.id, {
      ...assistant,
      blocks: clone(input.blocks),
      providerResponseId: input.providerResponseId,
      status: input.status,
      updatedAt: input.completedAt,
      usage: cloneOrNull(input.usage),
    });
    this.snapshots.set(snapshot.id, {
      ...snapshot,
      completedAt: input.completedAt,
      errorCode: input.errorCode,
      finishReason: input.finishReason,
      firstEventAt: input.firstEventAt,
      providerAnchor: cloneOrNull(input.providerAnchor),
      status: input.status,
    });
    return true;
  }

  async interruptWaitingRetry(input: InterruptWaitingRetryInput): Promise<void> {
    const snapshot = this.requireSnapshot(input.snapshotId);
    const assistant = this.requireMessage(input.assistantMessageId);
    if (
      snapshot.status !== "running" ||
      assistant.requestSnapshotId !== snapshot.id ||
      assistant.status !== "waiting_retry"
    ) {
      throw new Error("The waiting retry cannot be interrupted");
    }
    this.messages.set(assistant.id, {
      ...assistant,
      blocks: clone(input.blocks),
      status: input.status,
      updatedAt: input.completedAt,
    });
    this.snapshots.set(snapshot.id, {
      ...snapshot,
      completedAt: input.completedAt,
      errorCode: input.errorCode,
      finishReason: input.finishReason,
      status: input.status,
    });
  }

  async getRequestSnapshotByAssistant(assistantMessageId: string): Promise<RequestSnapshot | null> {
    const snapshot = [...this.snapshots.values()]
      .filter((candidate) => candidate.assistantMessageId === assistantMessageId)
      .sort((left, right) => right.startedAt - left.startedAt)[0];
    return cloneOrNull(snapshot);
  }

  async markRequestRunning(
    snapshotId: string,
    assistantMessageId: string,
    startedAt: number,
  ): Promise<void> {
    const snapshot = this.requireSnapshot(snapshotId);
    const message = this.requireMessage(assistantMessageId);
    if (
      snapshot.status !== "pending" ||
      snapshot.attemptCount !== 0 ||
      message.status !== "pending"
    ) {
      throw new Error("The request is not pending");
    }
    this.snapshots.set(snapshot.id, { ...snapshot, status: "running", startedAt });
    this.messages.set(message.id, { ...message, status: "streaming", updatedAt: startedAt });
  }

  async finalizeChatRequest(input: FinalizeChatRequestInput): Promise<boolean> {
    const snapshot = this.requireSnapshot(input.snapshotId);
    if (
      snapshot.attemptCount !== 0 ||
      (snapshot.status !== "pending" && snapshot.status !== "running")
    ) {
      return false;
    }
    const assistant = this.requireMessage(input.assistantMessageId);
    if (
      assistant.status !== "pending" &&
      assistant.status !== "waiting_retry" &&
      assistant.status !== "streaming"
    ) {
      throw new Error("storage_finalize_failed: assistant message was not active");
    }
    this.messages.set(assistant.id, {
      ...assistant,
      blocks: clone(input.blocks),
      providerResponseId: input.providerResponseId,
      status: input.status,
      updatedAt: input.completedAt,
      usage: cloneOrNull(input.usage),
    });
    this.snapshots.set(snapshot.id, {
      ...snapshot,
      attemptCount: 1,
      completedAt: input.completedAt,
      errorCode: input.errorCode,
      finishReason: input.finishReason,
      firstEventAt: input.firstEventAt,
      providerAnchor: cloneOrNull(input.providerAnchor),
      status: input.status,
    });
    return true;
  }

  private requireConversation(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      throw new Error(`Conversation ${id} does not exist`);
    }
    return conversation;
  }

  private requireMessage(id: string): Message {
    const message = this.messages.get(id);
    if (!message) {
      throw new Error(`Message ${id} does not exist`);
    }
    return message;
  }

  private requireSnapshot(id: string): RequestSnapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      throw new Error(`Snapshot ${id} does not exist`);
    }
    return snapshot;
  }

  private requireAttempt(id: string): RequestAttempt {
    const attempt = this.attempts.get(id);
    if (!attempt) {
      throw new Error(`Attempt ${id} does not exist`);
    }
    return attempt;
  }
}

function nextSiblingOrder(messages: Iterable<Message>, parentId: string): number {
  return (
    Math.max(
      -1,
      ...[...messages]
        .filter((message) => message.parentId === parentId)
        .map((message) => message.siblingOrder),
    ) + 1
  );
}

function insertUnique<T extends { id: string }>(map: Map<string, T>, value: T): void {
  if (map.has(value.id)) {
    throw new Error(`${value.id} already exists`);
  }
  map.set(value.id, clone(value));
}

function sorted<T>(values: Iterable<T>, key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right))).map(clone);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrNull<T>(value: T | undefined | null): T | null {
  return value == null ? null : clone(value);
}
