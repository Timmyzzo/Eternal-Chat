// @vitest-environment node

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { createApplicationRuntime } from "@/application/chat/runtime";
import { redactPipeRequest, readAuthBindings } from "@/application/chat/requestAssembler";
import { initializePersistence } from "@/infrastructure/db/startup";
import type { DesktopBridge, NotificationPort } from "@/infrastructure/desktop/desktopBridge";
import type { MessageBlocks } from "@/domain/chat";
import type { PipeEvent, PipeRequest } from "@/infrastructure/desktop/pipeContract";
import {
  OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
  OPENAI_RESPONSES_PROFILE_ID,
} from "@/infrastructure/providers/openai/protocolProfiles";
import { Phase3Repository, rootMessageId } from "@/infrastructure/db/phase3Repository";
import { createTempDatabase } from "@/test/database/tempDatabase";

const TEST_TOKEN = "test-token-not-a-secret";

describe.each([
  {
    name: "Chat Completions",
    profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
    path: "/v1/chat/completions",
    bodyKey: "messages",
  },
  {
    name: "Responses",
    profileId: OPENAI_RESPONSES_PROFILE_ID,
    path: "/v1/responses",
    bodyKey: "input",
  },
])("Phase 5 local SSE $name", ({ profileId, path, bodyKey }) => {
  it("completes config -> send -> stream -> SQLite terminal -> restart using the frozen wire", async () => {
    const fixture = await createTempDatabase();
    const captured: CapturedHttpRequest[] = [];
    const server = await startFixtureServer(captured);
    const port = (server.address() as AddressInfo).port;
    const bridge = new NodeSseDesktopBridge();
    const repository = new Phase3Repository(fixture.database);

    try {
      const runtime = await createApplicationRuntime(repository, bridge);
      const selection = await runtime.service.createProviderConfiguration({
        authBindings: [
          {
            placement: "header",
            name: "Authorization",
            credentialKey: "apiKey",
            prefix: "Bearer ",
          },
        ],
        baseUrl: "http://127.0.0.1/reverse-proxy",
        connectionName: `Local ${bodyKey}`,
        explicitPort: port,
        modelDisplayName: `Local ${bodyKey}`,
        modelId: `fixture-${bodyKey}`,
        path,
        profileId,
        reasoningDeltaPaths: bodyKey === "messages" ? ["reasoning"] : undefined,
        timeoutMs: 5_000,
      });
      runtime.credentials.set(selection.connection.id, TEST_TOKEN);
      const conversation = await runtime.service.createConversation(
        `Local ${bodyKey}`,
        selection.model.id,
      );
      const result = await runtime.service.sendMessage(conversation.id, "Local SSE request");
      const terminal = await runtime.registry.whenTerminal(
        result.dispatch.transportRequest.requestId,
      );

      expect(terminal).toMatchObject({
        status: "done",
        responseId: expect.stringContaining("local-"),
      });
      expect(terminal.blocks.blocks).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "text" })]),
      );
      if (bodyKey === "input") {
        expect(terminal.blocks.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "thinking", visibility: "summary" }),
            expect.objectContaining({
              type: "tool_call",
              id: "local-search-1",
              status: "succeeded",
            }),
            expect.objectContaining({ type: "source", id: "local-source-1" }),
            expect.objectContaining({ type: "citation", id: "local-citation-1" }),
          ]),
        );
        expect(terminal.blocks.timeline?.some((event) => event.type === "tool_result")).toBe(true);
      }
      expect(bridge.requests).toHaveLength(1);
      expect(
        redactPipeRequest(bridge.requests[0]!, readAuthBindings(selection.endpoint.authBindings)),
      ).toEqual(result.dispatch.redactedRequest);
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe(`/reverse-proxy${path}`);
      expect(captured[0]?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
      const body = JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>;
      expect(Array.isArray(body[bodyKey])).toBe(true);
      expect(body.stream).toBe(true);
      expect(body.model).toBe(`fixture-${bodyKey}`);
      expect(body).not.toHaveProperty("previous_response_id");

      const messages = await runtime.service.loadConversationMessages(conversation.id);
      const assistant = messages.at(-1);
      expect(assistant).toMatchObject({
        role: "assistant",
        status: "done",
        providerResponseId: expect.stringContaining("local-"),
      });
      const snapshot = assistant
        ? await runtime.service.getSnapshotForAssistant(assistant.id)
        : null;
      expect(snapshot).toMatchObject({
        status: "done",
        attemptCount: 1,
        endpointId: selection.endpoint.id,
        protocolProfileId: selection.profile.id,
      });
      if (bodyKey === "input") {
        expect(snapshot?.providerAnchor).toMatchObject({
          responseId: "local-responses-id",
          providerState: expect.arrayContaining([
            expect.objectContaining({ purpose: "rollout_ids" }),
          ]),
        });
      }
      expect(JSON.stringify(snapshot)).not.toContain(TEST_TOKEN);

      const restarted = await initializePersistence(Date.now(), async () => fixture.database);
      const restartedRuntime = await createApplicationRuntime(restarted, bridge);
      const restartedMessages = await restartedRuntime.service.loadConversationMessages(
        conversation.id,
      );
      expect(restartedMessages.at(-1)).toMatchObject({
        role: "assistant",
        status: "done",
        providerResponseId: assistant?.providerResponseId,
      });
      expect(restartedMessages.at(-1)?.blocks).toEqual(assistant?.blocks);
    } finally {
      await bridge.close();
      await closeServer(server);
      await fixture.cleanup();
    }
  });
});

describe("Phase 5A local automatic retry", () => {
  it("persists one assistant, one logical request, and three frozen attempts after two 429s", async () => {
    const fixture = await createTempDatabase();
    const captured: CapturedHttpRequest[] = [];
    const server = await startRetryFixtureServer(captured);
    const port = (server.address() as AddressInfo).port;
    const bridge = new NodeSseDesktopBridge();
    const repository = new Phase3Repository(fixture.database);

    try {
      const runtime = await createApplicationRuntime(repository, bridge);
      const selection = await runtime.service.createProviderConfiguration({
        authBindings: [
          {
            placement: "header",
            name: "Authorization",
            credentialKey: "apiKey",
            prefix: "Bearer ",
          },
        ],
        baseUrl: "http://127.0.0.1/reverse-proxy",
        connectionName: "Local retry fixture",
        explicitPort: port,
        modelDisplayName: "Local retry fixture",
        modelId: "fixture-retry-chat",
        path: "/v1/chat/completions",
        profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
        timeoutMs: 5_000,
      });
      runtime.credentials.set(selection.connection.id, TEST_TOKEN);
      const conversation = await runtime.service.createConversation(
        "Local automatic retry",
        selection.model.id,
      );
      const result = await runtime.service.sendMessage(conversation.id, "Retry this request");
      const terminal = await runtime.registry.whenTerminal(
        result.dispatch.transportRequest.requestId,
      );

      expect(terminal).toMatchObject({
        status: "done",
        attemptNo: 3,
        attempts: [
          { attemptNo: 1, status: "retryable_failed", httpStatus: 429 },
          { attemptNo: 2, status: "retryable_failed", httpStatus: 429 },
          { attemptNo: 3, status: "completed" },
        ],
      });
      expect(bridge.requests).toHaveLength(3);
      expect(captured).toHaveLength(3);
      const frozenWire = bridge.requests.map(({ requestId, ...request }) => {
        void requestId;
        return request;
      });
      expect(frozenWire[1]).toEqual(frozenWire[0]);
      expect(frozenWire[2]).toEqual(frozenWire[0]);
      expect(new Set(bridge.requests.map((request) => request.requestId)).size).toBe(3);

      const messages = await runtime.service.loadConversationMessages(conversation.id);
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      const assistant = messages[1];
      expect(assistant).toMatchObject({ status: "done", role: "assistant" });
      const snapshot = assistant
        ? await runtime.service.getSnapshotForAssistant(assistant.id)
        : null;
      expect(snapshot).toMatchObject({
        id: result.dispatch.requestSnapshot.id,
        attemptCount: 3,
        contextHash: result.dispatch.requestSnapshot.contextHash,
        requestBodyHash: result.dispatch.requestSnapshot.requestBodyHash,
        status: "done",
      });
      expect(JSON.stringify(snapshot)).not.toContain(TEST_TOKEN);
      const attempts = await repository.listRequestAttempts(result.dispatch.requestSnapshot.id);
      expect(attempts).toHaveLength(3);
      expect(
        attempts.every(
          (attempt) => attempt.requestBodyHash === result.dispatch.requestSnapshot.requestBodyHash,
        ),
      ).toBe(true);

      const counts = await fixture.database.select<{
        assistant_count: number;
        snapshot_count: number;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM message WHERE conversation_id = ? AND role = 'assistant')
            AS assistant_count,
          (SELECT COUNT(*) FROM request_snapshot WHERE conversation_id = ?)
            AS snapshot_count`,
        [conversation.id, conversation.id],
      );
      expect(counts[0]).toEqual({ assistant_count: 1, snapshot_count: 1 });
    } finally {
      await bridge.close();
      await closeServer(server);
      await fixture.cleanup();
    }
  });

  it("reuses one persisted client tool result across continuation attempts", async () => {
    const fixture = await createTempDatabase();
    const captured: CapturedHttpRequest[] = [];
    const server = await startRetryFixtureServer(captured);
    const port = (server.address() as AddressInfo).port;
    const bridge = new NodeSseDesktopBridge();
    const repository = new Phase3Repository(fixture.database);
    let toolExecutionCount = 0;
    const executeTool = () => {
      toolExecutionCount += 1;
      return "TOOL_RESULT_CANARY";
    };

    try {
      const runtime = await createApplicationRuntime(repository, bridge);
      const selection = await runtime.service.createProviderConfiguration({
        authBindings: [],
        baseUrl: "http://127.0.0.1/reverse-proxy",
        connectionName: "Local tool retry fixture",
        explicitPort: port,
        modelDisplayName: "Local tool retry fixture",
        modelId: "fixture-tool-retry-chat",
        path: "/v1/chat/completions",
        profileId: OPENAI_CHAT_COMPLETIONS_PROFILE_ID,
        timeoutMs: 5_000,
      });
      const conversation = await runtime.service.createConversation(
        "Tool continuation retry",
        selection.model.id,
      );
      const firstTurn = await repository.createPendingTurn({
        conversationId: conversation.id,
        parentId: rootMessageId(conversation.id),
        userMessageId: "tool-user",
        userBlocks: { version: 1, blocks: [{ type: "text", text: "Run tool" }] },
        assistantMessageId: "tool-assistant",
        assistantBlocks: { version: 1, blocks: [] },
        assistantModelRef: selection.model.id,
        createdAt: 1,
      });
      const toolBlocks: MessageBlocks = {
        version: 1,
        blocks: [
          {
            type: "tool_call",
            id: "tool-call-1",
            name: "fixture_tool",
            args: { value: 1 },
            status: "succeeded",
            source: "client",
            result: { modelContent: executeTool() },
          },
        ],
      };
      await repository.updateMessage(firstTurn.assistantMessage.id, "done", toolBlocks, 2);

      const result = await runtime.service.sendMessage(conversation.id, "Continue after tool");
      await runtime.registry.whenTerminal(result.dispatch.transportRequest.requestId);

      expect(toolExecutionCount).toBe(1);
      expect(captured).toHaveLength(3);
      captured.forEach((request) => {
        expect(countOccurrences(request.body, "TOOL_RESULT_CANARY")).toBe(1);
      });
      expect(new Set(captured.map((request) => request.body)).size).toBe(1);
    } finally {
      await bridge.close();
      await closeServer(server);
      await fixture.cleanup();
    }
  });
});

interface CapturedHttpRequest {
  body: string;
  headers: IncomingMessage["headers"];
  url: string;
}

class NodeSseDesktopBridge implements DesktopBridge {
  readonly notifications: NotificationPort = { async show() {} };
  readonly requests: PipeRequest[] = [];
  private readonly controllers = new Map<string, AbortController>();

  async cancelStream(requestId: string): Promise<void> {
    this.controllers.get(requestId)?.abort();
  }

  async close(): Promise<void> {
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
  }

  async openExternal(): Promise<void> {}

  async startStream(request: PipeRequest, onEvent: (event: PipeEvent) => void): Promise<void> {
    this.requests.push(structuredClone(request));
    const controller = new AbortController();
    this.controllers.set(request.requestId, controller);
    const url = new URL(request.url);
    request.query.forEach((field) => url.searchParams.append(field.name, field.value));
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers.map((field) => [field.name, field.value])),
        body: request.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After") ?? undefined;
        onEvent({
          type: "error",
          requestId: request.requestId,
          error: {
            kind: "http",
            message: "Local fixture HTTP error",
            status: response.status,
            ...(retryAfter === undefined ? {} : { retryAfter }),
          },
        });
        return;
      }
      const data = parseSseData(await response.text());
      onEvent({ type: "data", requestId: request.requestId, data });
      onEvent({ type: "done", requestId: request.requestId });
    } catch (error) {
      onEvent({
        type: "error",
        requestId: request.requestId,
        error: {
          kind: controller.signal.aborted ? "cancelled" : "network",
          message: error instanceof Error ? error.message : "Local fixture transport error",
        },
      });
    } finally {
      this.controllers.delete(request.requestId);
    }
  }
}

async function startFixtureServer(captured: CapturedHttpRequest[]): Promise<Server> {
  const server = createServer(async (request, response) => {
    captured.push({
      body: await readBody(request),
      headers: request.headers,
      url: request.url ?? "",
    });
    writeSseResponse(request.url ?? "", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function startRetryFixtureServer(captured: CapturedHttpRequest[]): Promise<Server> {
  let attempt = 0;
  const server = createServer(async (request, response) => {
    attempt += 1;
    captured.push({
      body: await readBody(request),
      headers: request.headers,
      url: request.url ?? "",
    });
    if (attempt <= 2) {
      response.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "0",
        Connection: "close",
      });
      response.end(JSON.stringify({ error: { code: "rate_limit", message: "retry" } }));
      return;
    }
    writeSseResponse(request.url ?? "", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function writeSseResponse(url: string, response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    Connection: "close",
  });
  const payloads = url.endsWith("/v1/responses")
    ? [
        {
          type: "response.created",
          response: {
            id: "local-responses-id",
            reasoning: { effort: "high" },
            rollout_ids: ["local-rollout-1"],
          },
        },
        {
          type: "response.reasoning_summary_part.added",
          item_id: "local-reasoning-1",
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "local-reasoning-1",
          delta: "local reasoning",
        },
        {
          type: "response.output_item.added",
          item: {
            id: "local-search-1",
            type: "web_search_call",
            action: { type: "search", query: "local phase 7" },
          },
        },
        {
          type: "response.web_search_call.completed",
          item_id: "local-search-1",
          query: "local phase 7",
          results: [
            {
              id: "local-source-1",
              title: "Local source",
              url: "https://example.com/local-phase7",
            },
          ],
        },
        { type: "response.output_text.delta", delta: "local responses answer" },
        {
          type: "response.output_text.annotation.added",
          item_id: "local-search-1",
          annotation: {
            source_id: "local-source-1",
            citation_id: "local-citation-1",
            title: "Local source",
            url: "https://example.com/local-phase7",
            start_index: 0,
            end_index: 5,
          },
        },
        {
          type: "response.reasoning_summary_part.done",
          item_id: "local-reasoning-1",
        },
        {
          type: "response.completed",
          response: {
            id: "local-responses-id",
            usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
          },
        },
      ]
    : [
        {
          id: "local-chat-id",
          choices: [{ delta: { reasoning: "local reasoning" }, finish_reason: null }],
        },
        { choices: [{ delta: { content: "local chat answer" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
      ];
  payloads.forEach((payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`));
  if (!url.endsWith("/v1/responses")) {
    response.write("data: [DONE]\n\n");
  }
  response.end();
}

function parseSseData(value: string): string[] {
  return value
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter((data) => data !== "");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}
