import type { PreparedDispatch } from "@/application/chat/requestAssembler";
import {
  classifyPipeFailure,
  classifyProviderFailure,
  parseRetryAfter,
  planAutomaticRetry,
  type RetryFailure,
  type RetryPlan,
} from "@/application/chat/retryPolicy";
import type {
  MessageBlocks,
  MessageStatus,
  RequestAttempt,
  RequestAttemptStatus,
} from "@/domain/chat";
import type { JsonObject } from "@/domain/json";
import {
  createStreamingMessageState,
  isTerminalStatus,
  isValuableStreamEvent,
  reduceStreamingMessage,
  type StreamDomainEvent,
  type StreamErrorCode,
  type StreamErrorInfo,
  type StreamingMessageState,
} from "@/domain/streaming";
import type {
  FinalizeRequestAttemptInput,
  InterruptWaitingRetryInput,
  ScheduleRetryInput,
} from "@/infrastructure/db/phase3Repository";
import type { DesktopBridge } from "@/infrastructure/desktop/desktopBridge";
import type { PipeError, PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";
import type { OpenAIStreamParser } from "@/infrastructure/providers/openai/streamParsers";

export type ActiveRequestSubscriber = (state: StreamingMessageState) => void;

export interface ActiveRequestPersistence {
  finalizeRequestAttempt(input: FinalizeRequestAttemptInput): Promise<boolean>;
  interruptWaitingRetry(input: InterruptWaitingRetryInput): Promise<void>;
  scheduleRetry(input: ScheduleRetryInput): Promise<void>;
  startLogicalRequest(
    snapshot: PreparedDispatch["requestSnapshot"],
    attempt: RequestAttempt,
  ): Promise<void>;
  startRetryAttempt(assistantMessageId: string, attempt: RequestAttempt): Promise<void>;
  updateMessage(
    id: string,
    status: MessageStatus,
    blocks: MessageBlocks,
    updatedAt: number,
  ): Promise<void>;
}

export interface ActiveRequestRegistryOptions {
  createId?: () => string;
  random?: () => number;
  schedule?: (delayMs: number, callback: () => void) => () => void;
}

interface AttemptRuntime {
  parser: OpenAIStreamParser;
  record: RequestAttempt;
}

interface RegistryEntry {
  cancelRetryTimer: (() => void) | null;
  current: AttemptRuntime;
  dispatch: PreparedDispatch;
  logicalRequestId: string;
  queue: Promise<void>;
  resolved: boolean;
  resolveTerminal: (state: StreamingMessageState) => void;
  retryGeneration: number;
  state: StreamingMessageState;
  stopRequested: boolean;
  subscribers: Set<ActiveRequestSubscriber>;
  terminal: Promise<StreamingMessageState>;
}

const DEFAULT_SCHEDULE = (delayMs: number, callback: () => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

const UTF8_ENCODER = new TextEncoder();

export class ActiveRequestRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly transportOwners = new Map<string, string>();
  private readonly createId: () => string;
  private readonly random: () => number;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;

  constructor(
    private readonly bridge: DesktopBridge,
    private readonly repository: ActiveRequestPersistence,
    private readonly now: () => number = Date.now,
    options: ActiveRequestRegistryOptions = {},
  ) {
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? DEFAULT_SCHEDULE;
  }

  start(dispatch: PreparedDispatch): StreamingMessageState {
    const logicalRequestId = dispatch.transportRequest.requestId;
    if (this.entries.has(logicalRequestId)) {
      throw new Error(`Request ${logicalRequestId} is already registered`);
    }
    if (this.hasActiveForConversation(dispatch.userMessage.conversationId)) {
      throw new Error("This conversation already has an active request");
    }

    const initialAttempt = createAttempt({
      attemptId: `attempt-${this.createId()}`,
      attemptNo: 1,
      requestBodyHash: dispatch.requestSnapshot.requestBodyHash,
      snapshotId: dispatch.requestSnapshot.id,
      startedAt: dispatch.requestSnapshot.startedAt,
      transportRequestId: dispatch.transportRequest.requestId,
      trigger: "initial",
    });
    let resolveTerminal!: (state: StreamingMessageState) => void;
    const terminal = new Promise<StreamingMessageState>((resolve) => {
      resolveTerminal = resolve;
    });
    const state = createStreamingMessageState({
      assistantMessageId: dispatch.assistantPlaceholder.id,
      attemptNo: 1,
      maxAttempts: dispatch.retryPolicy.maxRetries + 1,
      requestId: logicalRequestId,
      startedAt: dispatch.requestSnapshot.startedAt,
      transportRequestId: initialAttempt.transportRequestId,
    });
    state.attempts = [structuredClone(initialAttempt)];
    const entry: RegistryEntry = {
      cancelRetryTimer: null,
      current: { parser: dispatch.parser(), record: initialAttempt },
      dispatch,
      logicalRequestId,
      queue: Promise.resolve(),
      resolved: false,
      resolveTerminal,
      retryGeneration: 0,
      state,
      stopRequested: false,
      subscribers: new Set(),
      terminal,
    };
    this.entries.set(logicalRequestId, entry);
    this.transportOwners.set(initialAttempt.transportRequestId, logicalRequestId);

    this.enqueue(entry, async () => {
      try {
        await this.repository.startLogicalRequest(
          dispatch.requestSnapshot,
          structuredClone(initialAttempt),
        );
      } catch {
        await this.failStorageStart(entry);
        return;
      }

      if (entry.stopRequested) {
        await this.finishRunningAttemptAsCancelled(entry);
        return;
      }
      this.syncAttemptState(entry);
      this.notify(entry);
      this.startTransport(dispatch.transportRequest);
    });
    return cloneState(entry.state);
  }

  stop(requestId: string): void {
    const entry = this.findEntry(requestId);
    if (!entry || isTerminalStatus(entry.state.status)) {
      return;
    }
    entry.stopRequested = true;
    this.cancelWaitingTimer(entry);

    const transportRequestId = entry.current.record.transportRequestId;
    this.enqueue(entry, async () => {
      if (isTerminalStatus(entry.state.status)) {
        return;
      }
      if (entry.state.status === "waiting_retry") {
        await this.finishWaitingRetry(
          entry,
          "retry_cancelled",
          "Automatic retry was stopped.",
          "interrupted",
        );
      } else {
        await this.finishRunningAttemptAsCancelled(entry);
      }
    });
    void this.bridge.cancelStream(transportRequestId).catch(() => undefined);
  }

  subscribe(requestId: string, subscriber: ActiveRequestSubscriber): () => void {
    const entry = this.findEntry(requestId);
    if (!entry) {
      return () => undefined;
    }
    entry.subscribers.add(subscriber);
    this.callSubscriber(entry, subscriber);
    return () => entry.subscribers.delete(subscriber);
  }

  get(requestId: string): StreamingMessageState | null {
    const entry = this.findEntry(requestId);
    return entry ? cloneState(entry.state) : null;
  }

  hasActiveForConversation(conversationId: string): boolean {
    return [...this.entries.values()].some(
      (entry) =>
        entry.dispatch.userMessage.conversationId === conversationId &&
        !isTerminalStatus(entry.state.status),
    );
  }

  latestForConversation(conversationId: string): StreamingMessageState | null {
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.dispatch.userMessage.conversationId === conversationId)
      .sort((left, right) => right.state.startedAt - left.state.startedAt)[0];
    return entry ? cloneState(entry.state) : null;
  }

  whenTerminal(requestId: string): Promise<StreamingMessageState> {
    const entry = this.findEntry(requestId);
    if (!entry) {
      return Promise.reject(new Error(`Request ${requestId} is not registered`));
    }
    return entry.terminal.then(cloneState);
  }

  removeTerminal(requestId: string): void {
    const entry = this.findEntry(requestId);
    if (!entry || !isTerminalStatus(entry.state.status)) {
      return;
    }
    this.entries.delete(entry.logicalRequestId);
    for (const [transportRequestId, owner] of this.transportOwners) {
      if (owner === entry.logicalRequestId) {
        this.transportOwners.delete(transportRequestId);
      }
    }
  }

  private startTransport(request: PipeRequest): void {
    void this.bridge
      .startStream(request, (event) => this.receive(event))
      .catch(() => this.receiveBridgeFailure(request.requestId));
  }

  private receive(event: PipeEvent): void {
    const entry = this.findEntry(event.requestId);
    if (!entry) {
      return;
    }
    this.enqueue(entry, async () => this.handlePipeEvent(entry, event));
  }

  private receiveBridgeFailure(transportRequestId: string): void {
    const entry = this.findEntry(transportRequestId);
    if (!entry) {
      return;
    }
    this.enqueue(entry, async () => {
      await this.handlePipeFailure(entry, {
        kind: "channel_closed",
        message: "The desktop event channel closed.",
      });
    });
  }

  private async handlePipeEvent(entry: RegistryEntry, event: PipeEvent): Promise<void> {
    if (
      isTerminalStatus(entry.state.status) ||
      entry.current.record.status !== "running" ||
      event.requestId !== entry.current.record.transportRequestId
    ) {
      return;
    }

    if (event.type === "data") {
      if (event.data.length > 0 && entry.current.record.firstByteAt === null) {
        entry.current.record.firstByteAt = this.now();
      }
      entry.current.record.bytesReceived += event.data.reduce(
        (total, data) => total + UTF8_ENCODER.encode(data).byteLength,
        0,
      );

      for (const data of event.data) {
        for (const domainEvent of entry.current.parser.push(data)) {
          if (domainEvent.type === "error") {
            await this.handleProviderFailure(entry, domainEvent.error);
          } else {
            await this.applyDomainEvent(entry, domainEvent, this.now());
          }
          if (entry.current.record.status !== "running" || isTerminalStatus(entry.state.status)) {
            return;
          }
        }
      }
      return;
    }

    if (event.type === "done") {
      for (const domainEvent of entry.current.parser.finish()) {
        if (domainEvent.type === "error") {
          await this.handleProviderFailure(entry, domainEvent.error);
        } else {
          await this.applyDomainEvent(entry, domainEvent, this.now());
        }
        if (entry.current.record.status !== "running" || isTerminalStatus(entry.state.status)) {
          return;
        }
      }
      return;
    }

    if (event.error.kind === "cancelled" && entry.stopRequested) {
      await this.finishRunningAttemptAsCancelled(entry);
      return;
    }
    await this.handlePipeFailure(entry, event.error);
  }

  private async applyDomainEvent(
    entry: RegistryEntry,
    event: Exclude<StreamDomainEvent, { type: "error" }>,
    occurredAt: number,
  ): Promise<void> {
    if (isValuableStreamEvent(event)) {
      entry.current.record.semanticEventCount += 1;
      entry.current.record.firstSemanticEventAt ??= occurredAt;
    }
    entry.state = reduceStreamingMessage(entry.state, event, occurredAt);
    this.syncAttemptState(entry);
    this.notify(entry);

    if (event.type === "done") {
      entry.current.record.status = "completed";
      entry.current.record.completedAt = occurredAt;
      this.syncAttemptState(entry);
      await this.persistRunningTerminal(entry, "completed", null, null, null);
    }
  }

  private async handlePipeFailure(entry: RegistryEntry, error: PipeError): Promise<void> {
    const failure = classifyPipeFailure(error, entry.dispatch.retryPolicy);
    await this.handleFailure(
      entry,
      failure,
      parseRetryAfter(error.retryAfter, this.now()),
      transportError(error),
    );
  }

  private async handleProviderFailure(entry: RegistryEntry, error: StreamErrorInfo): Promise<void> {
    const failure = classifyProviderFailure(error, entry.dispatch.retryPolicy);
    await this.handleFailure(entry, failure, { kind: "missing" }, error);
  }

  private async handleFailure(
    entry: RegistryEntry,
    failure: RetryFailure,
    retryAfter: ReturnType<typeof parseRetryAfter>,
    terminalError: StreamErrorInfo,
  ): Promise<void> {
    const occurredAt = this.now();
    const plan = planAutomaticRetry({
      attemptNo: entry.current.record.attemptNo,
      elapsedMs: Math.max(0, occurredAt - entry.dispatch.requestSnapshot.startedAt),
      failure,
      hasValuableOutput: hasValuableOutput(entry.state, entry.current.record),
      policy: entry.dispatch.retryPolicy,
      random: this.random,
      retryAfter,
    });

    if (plan.kind === "retry") {
      await this.scheduleAutomaticRetry(entry, failure, plan, occurredAt);
      return;
    }

    const final = terminalForStoppedRetry(plan, failure, terminalError);
    if (final.status === "interrupted") {
      entry.state = reduceStreamingMessage(
        entry.state,
        {
          type: "interrupted",
          code: final.error.code,
          finishReason: final.error.code,
          message: final.error.message,
        },
        occurredAt,
      );
    } else {
      entry.state = reduceStreamingMessage(
        entry.state,
        { type: "error", error: final.error },
        occurredAt,
      );
    }
    entry.current.record.status = "non_retryable_failed";
    entry.current.record.retryable = false;
    entry.current.record.retryReason = final.retryReason;
    entry.current.record.httpStatus = failure.httpStatus;
    entry.current.record.providerErrorCode = failure.providerCode;
    entry.current.record.completedAt = occurredAt;
    this.syncAttemptState(entry);
    this.notify(entry);
    await this.persistRunningTerminal(
      entry,
      "non_retryable_failed",
      final.retryReason,
      failure.httpStatus,
      failure.providerCode,
    );
  }

  private async scheduleAutomaticRetry(
    entry: RegistryEntry,
    failure: RetryFailure,
    plan: Extract<RetryPlan, { kind: "retry" }>,
    occurredAt: number,
  ): Promise<void> {
    const retryReason = plan.retryAfterInvalid ? "retry_after_invalid" : failure.code;
    const input: ScheduleRetryInput = {
      assistantMessageId: entry.state.assistantMessageId,
      attemptId: entry.current.record.id,
      bytesReceived: entry.current.record.bytesReceived,
      completedAt: occurredAt,
      firstByteAt: entry.current.record.firstByteAt,
      firstSemanticEventAt: entry.current.record.firstSemanticEventAt,
      httpStatus: failure.httpStatus,
      providerErrorCode: failure.providerCode,
      retryAfterMs: plan.retryAfterMs,
      retryReason,
      scheduledDelayMs: plan.delayMs,
      semanticEventCount: entry.current.record.semanticEventCount,
      snapshotId: entry.dispatch.requestSnapshot.id,
    };

    try {
      await this.repository.scheduleRetry(input);
    } catch {
      await this.failStorageTerminal(entry);
      return;
    }

    entry.current.record.status = "retryable_failed";
    entry.current.record.retryable = true;
    entry.current.record.retryReason = retryReason;
    entry.current.record.httpStatus = failure.httpStatus;
    entry.current.record.providerErrorCode = failure.providerCode;
    entry.current.record.retryAfterMs = plan.retryAfterMs;
    entry.current.record.scheduledDelayMs = plan.delayMs;
    entry.current.record.completedAt = occurredAt;
    entry.state = {
      ...entry.state,
      completedAt: null,
      error: null,
      finishReason: null,
      retry: {
        delayMs: plan.delayMs,
        delaySource: plan.delaySource,
        failureCode: failure.code,
        failureMessage: failure.message,
        httpStatus: failure.httpStatus,
        nextAttemptAt: occurredAt + plan.delayMs,
        nextAttemptNo: entry.current.record.attemptNo + 1,
        providerCode: failure.providerCode,
        retryAfterInvalid: plan.retryAfterInvalid,
        retryAfterMs: plan.retryAfterMs,
      },
      status: "waiting_retry",
    };
    this.syncAttemptState(entry);
    this.notify(entry);

    if (entry.stopRequested) {
      return;
    }
    const generation = ++entry.retryGeneration;
    entry.cancelRetryTimer = this.schedule(plan.delayMs, () => {
      if (
        entry.retryGeneration !== generation ||
        entry.stopRequested ||
        entry.state.status !== "waiting_retry"
      ) {
        return;
      }
      entry.cancelRetryTimer = null;
      entry.retryGeneration += 1;
      this.enqueue(entry, async () => this.startNextAttempt(entry));
    });
  }

  private async startNextAttempt(entry: RegistryEntry): Promise<void> {
    if (isTerminalStatus(entry.state.status) || entry.state.status !== "waiting_retry") {
      return;
    }
    if (entry.stopRequested) {
      await this.finishWaitingRetry(
        entry,
        "retry_cancelled",
        "Automatic retry was stopped.",
        "interrupted",
      );
      return;
    }
    if (
      this.now() - entry.dispatch.requestSnapshot.startedAt >
      entry.dispatch.retryPolicy.maxTotalElapsedMs
    ) {
      await this.finishWaitingRetry(
        entry,
        "retry_budget_exhausted",
        "The automatic retry time budget was exhausted.",
        "error",
      );
      return;
    }

    const attemptNo = entry.current.record.attemptNo + 1;
    const attempt = createAttempt({
      attemptId: `attempt-${this.createId()}`,
      attemptNo,
      requestBodyHash: entry.dispatch.requestSnapshot.requestBodyHash,
      snapshotId: entry.dispatch.requestSnapshot.id,
      startedAt: this.now(),
      transportRequestId: `request-${this.createId()}`,
      trigger: "automatic_retry",
    });

    try {
      await this.repository.startRetryAttempt(entry.state.assistantMessageId, attempt);
    } catch {
      await this.failStorageTerminal(entry);
      return;
    }

    entry.current = { parser: entry.dispatch.parser(), record: attempt };
    this.transportOwners.set(attempt.transportRequestId, entry.logicalRequestId);
    entry.state = {
      ...entry.state,
      attemptNo,
      completedAt: null,
      error: null,
      finishReason: null,
      retry: null,
      status: "pending",
      transportRequestId: attempt.transportRequestId,
    };
    this.syncAttemptState(entry, true);
    this.notify(entry);

    if (entry.stopRequested) {
      await this.finishRunningAttemptAsCancelled(entry);
      return;
    }
    this.startTransport({
      ...structuredClone(entry.dispatch.transportRequest),
      requestId: attempt.transportRequestId,
    });
  }

  private async finishRunningAttemptAsCancelled(entry: RegistryEntry): Promise<void> {
    if (isTerminalStatus(entry.state.status)) {
      return;
    }
    const completedAt = this.now();
    entry.state = reduceStreamingMessage(
      entry.state,
      {
        type: "interrupted",
        code: "retry_cancelled",
        finishReason: "cancelled",
        message: "Generation stopped.",
      },
      completedAt,
    );
    entry.current.record.status = "cancelled";
    entry.current.record.retryable = false;
    entry.current.record.retryReason = "retry_cancelled";
    entry.current.record.completedAt = completedAt;
    this.syncAttemptState(entry);
    this.notify(entry);
    await this.persistRunningTerminal(entry, "cancelled", "retry_cancelled", null, null);
  }

  private async finishWaitingRetry(
    entry: RegistryEntry,
    code: Extract<StreamErrorCode, "retry_cancelled" | "retry_budget_exhausted">,
    message: string,
    status: "interrupted" | "error",
  ): Promise<void> {
    if (isTerminalStatus(entry.state.status)) {
      return;
    }
    this.cancelWaitingTimer(entry);
    const completedAt = this.now();
    if (status === "interrupted") {
      entry.state = reduceStreamingMessage(
        entry.state,
        { type: "interrupted", code, finishReason: code, message },
        completedAt,
      );
    } else {
      entry.state = reduceStreamingMessage(
        entry.state,
        { type: "error", error: { code, message, retryable: false } },
        completedAt,
      );
    }
    entry.state = { ...entry.state, retry: null };
    this.notify(entry);

    try {
      await this.repository.interruptWaitingRetry({
        assistantMessageId: entry.state.assistantMessageId,
        blocks: entry.state.blocks,
        completedAt,
        errorCode: code,
        finishReason: status === "interrupted" ? "cancelled" : code,
        snapshotId: entry.dispatch.requestSnapshot.id,
        status,
      });
    } catch {
      entry.state = storageFailedState(entry.state, completedAt);
      this.notify(entry);
    } finally {
      this.resolveEntry(entry);
    }
  }

  private async persistRunningTerminal(
    entry: RegistryEntry,
    attemptStatus: Extract<
      RequestAttemptStatus,
      "completed" | "non_retryable_failed" | "cancelled"
    >,
    retryReason: string | null,
    httpStatus: number | null,
    providerErrorCode: string | null,
  ): Promise<void> {
    if (!isTerminalStatus(entry.state.status) || entry.state.completedAt === null) {
      return;
    }

    const input: FinalizeRequestAttemptInput = {
      assistantMessageId: entry.state.assistantMessageId,
      attemptId: entry.current.record.id,
      attemptStatus,
      blocks: entry.state.blocks,
      bytesReceived: entry.current.record.bytesReceived,
      completedAt: entry.state.completedAt,
      errorCode: entry.state.error?.code ?? retryReason,
      finishReason: entry.state.finishReason,
      firstByteAt: entry.current.record.firstByteAt,
      firstEventAt: entry.state.firstEventAt,
      firstSemanticEventAt: entry.current.record.firstSemanticEventAt,
      httpStatus,
      providerAnchor: providerAnchor(entry.state),
      providerErrorCode,
      providerResponseId: entry.state.responseId,
      retryReason,
      semanticEventCount: entry.current.record.semanticEventCount,
      snapshotId: entry.dispatch.requestSnapshot.id,
      status: entry.state.status,
      usage: entry.state.usage,
    };

    try {
      await this.repository.finalizeRequestAttempt(input);
    } catch {
      entry.state = storageFailedState(entry.state, entry.state.completedAt);
      this.notify(entry);
    } finally {
      this.resolveEntry(entry);
    }
  }

  private async failStorageStart(entry: RegistryEntry): Promise<void> {
    const completedAt = this.now();
    entry.state = storageFailedState(entry.state, completedAt);
    entry.current.record.status = "non_retryable_failed";
    entry.current.record.retryReason = "storage_finalize_failed";
    entry.current.record.completedAt = completedAt;
    this.syncAttemptState(entry);
    this.notify(entry);
    try {
      await this.repository.updateMessage(
        entry.state.assistantMessageId,
        "error",
        entry.state.blocks,
        completedAt,
      );
    } catch {
      // The in-memory terminal state is still resolved so callers cannot hang.
    }
    this.resolveEntry(entry);
  }

  private async failStorageTerminal(entry: RegistryEntry): Promise<void> {
    const completedAt = this.now();
    this.cancelWaitingTimer(entry);
    entry.state = storageFailedState(entry.state, completedAt);
    this.notify(entry);
    try {
      await this.repository.updateMessage(
        entry.state.assistantMessageId,
        "error",
        entry.state.blocks,
        completedAt,
      );
    } catch {
      // Preserve the terminal state even if the fallback write also fails.
    }
    this.resolveEntry(entry);
  }

  private cancelWaitingTimer(entry: RegistryEntry): void {
    entry.retryGeneration += 1;
    entry.cancelRetryTimer?.();
    entry.cancelRetryTimer = null;
  }

  private syncAttemptState(entry: RegistryEntry, appendCurrent = false): void {
    const attempts = entry.state.attempts.map((attempt) => structuredClone(attempt));
    const index = attempts.findIndex((attempt) => attempt.id === entry.current.record.id);
    if (index >= 0) {
      attempts[index] = structuredClone(entry.current.record);
    } else if (appendCurrent) {
      attempts.push(structuredClone(entry.current.record));
    }
    entry.state = {
      ...entry.state,
      attemptNo: entry.current.record.attemptNo,
      attempts,
      transportRequestId: entry.current.record.transportRequestId,
    };
  }

  private findEntry(requestId: string): RegistryEntry | undefined {
    const logicalRequestId = this.entries.has(requestId)
      ? requestId
      : this.transportOwners.get(requestId);
    return logicalRequestId ? this.entries.get(logicalRequestId) : undefined;
  }

  private enqueue(entry: RegistryEntry, operation: () => Promise<void>): void {
    entry.queue = entry.queue.then(operation).catch(async () => {
      if (!isTerminalStatus(entry.state.status)) {
        await this.failStorageTerminal(entry);
      }
    });
  }

  private resolveEntry(entry: RegistryEntry): void {
    if (entry.resolved) {
      return;
    }
    entry.resolved = true;
    this.cancelWaitingTimer(entry);
    entry.resolveTerminal(cloneState(entry.state));
  }

  private notify(entry: RegistryEntry): void {
    entry.subscribers.forEach((subscriber) => this.callSubscriber(entry, subscriber));
  }

  private callSubscriber(entry: RegistryEntry, subscriber: ActiveRequestSubscriber): void {
    try {
      subscriber(cloneState(entry.state));
    } catch {
      entry.subscribers.delete(subscriber);
    }
  }
}

function createAttempt(input: {
  attemptId: string;
  attemptNo: number;
  requestBodyHash: string;
  snapshotId: string;
  startedAt: number;
  transportRequestId: string;
  trigger: RequestAttempt["trigger"];
}): RequestAttempt {
  return {
    id: input.attemptId,
    requestSnapshotId: input.snapshotId,
    attemptNo: input.attemptNo,
    trigger: input.trigger,
    transportRequestId: input.transportRequestId,
    requestBodyHash: input.requestBodyHash,
    status: "running",
    retryable: false,
    retryReason: null,
    httpStatus: null,
    providerErrorCode: null,
    retryAfterMs: null,
    scheduledDelayMs: null,
    startedAt: input.startedAt,
    firstByteAt: null,
    firstSemanticEventAt: null,
    completedAt: null,
    bytesReceived: 0,
    semanticEventCount: 0,
  };
}

function hasValuableOutput(state: StreamingMessageState, attempt: RequestAttempt): boolean {
  return (
    attempt.semanticEventCount > 0 ||
    state.responseId !== null ||
    state.usage !== null ||
    state.blocks.blocks.some((block) =>
      ["text", "thinking", "tool_call", "source", "citation", "provider_state"].includes(
        block.type,
      ),
    )
  );
}

function terminalForStoppedRetry(
  plan: Extract<RetryPlan, { kind: "stop" }>,
  failure: RetryFailure,
  fallback: StreamErrorInfo,
): {
  error: StreamErrorInfo;
  retryReason: string;
  status: "error" | "interrupted";
} {
  if (plan.code === "retry_disallowed_after_output") {
    return {
      error: {
        code: plan.code,
        details: failureDetails(failure),
        message: "Automatic retry was not allowed after valuable output was received.",
        retryable: false,
      },
      retryReason: plan.code,
      status: "interrupted",
    };
  }
  if (plan.code === "retry_exhausted" || plan.code === "retry_budget_exhausted") {
    return {
      error: {
        code: plan.code,
        details: failureDetails(failure),
        message:
          plan.code === "retry_exhausted"
            ? "The automatic retry attempt limit was exhausted."
            : "The automatic retry time budget was exhausted.",
        retryable: false,
      },
      retryReason: plan.code,
      status: "error",
    };
  }
  if (failure.category === "provider" && failure.code === "provider_embedded_error") {
    return {
      error: {
        code: "provider_embedded_error",
        details: failureDetails(failure),
        message: fallback.message,
        retryable: false,
      },
      retryReason: failure.code,
      status: "error",
    };
  }
  return { error: fallback, retryReason: failure.code, status: "error" };
}

function failureDetails(failure: RetryFailure): JsonObject {
  return {
    category: failure.category,
    code: failure.code,
    ...(failure.httpStatus === null ? {} : { httpStatus: failure.httpStatus }),
    ...(failure.providerCode === null ? {} : { providerCode: failure.providerCode }),
  };
}

function transportError(error: PipeError): StreamErrorInfo {
  return {
    code: "transport_error",
    details: {
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
    },
    message: error.status
      ? `The transport failed with HTTP ${error.status}.`
      : error.message || "The transport request failed.",
    retryable: false,
  };
}

function storageFailedState(
  state: StreamingMessageState,
  completedAt: number,
): StreamingMessageState {
  const error: StreamErrorInfo = {
    code: "storage_finalize_failed",
    message: "The request could not be started or finalized in local storage.",
    retryable: false,
  };
  const activeState = isTerminalStatus(state.status)
    ? { ...state, completedAt: null, status: "streaming" as const }
    : state;
  return reduceStreamingMessage(activeState, { type: "error", error }, completedAt);
}

function providerAnchor(state: StreamingMessageState): JsonObject | null {
  if (!state.responseId && !state.error) {
    return null;
  }
  return {
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.error?.details ? { error: state.error.details } : {}),
  };
}

function cloneState(state: StreamingMessageState): StreamingMessageState {
  return structuredClone(state);
}
