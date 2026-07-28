import type { ChatService } from "@/application/chat/chatService";
import type { MessageBlock, MessageBlocks } from "@/domain/chat";
import { InMemoryChatRepository } from "@/infrastructure/db/inMemoryChatRepository";
import { rootMessageId } from "@/infrastructure/db/phase3Repository";

export const PHASE8_PERFORMANCE_CONVERSATION_TITLE = "Phase 8 performance seed";
export const PHASE8_LONG_MESSAGE_MARKER = "Phase 8 long response";

const FIXTURE_TIME = 1_900_000_000_000;
const ACTIVE_TURNS = 500;
const BRANCH_MESSAGES = 20;
const SWITCH_CONVERSATIONS = 19;

export interface Phase8PerformanceSeedSummary {
  activePathMessages: number;
  attachmentBlocks: number;
  branchMessages: number;
  codeBlocks: number;
  conversationId: string;
  longTextCharacters: number;
  thinkingBlocks: number;
  toolCalls: number;
  totalMessages: number;
}

export async function seedPhase8PerformanceFixture(
  repository: InMemoryChatRepository,
  service: ChatService,
  modelRef: string,
): Promise<Phase8PerformanceSeedSummary> {
  for (let index = 0; index < SWITCH_CONVERSATIONS; index += 1) {
    const conversation = await service.createConversation(
      `Phase 8 switch ${String(index + 1).padStart(2, "0")}`,
      modelRef,
    );
    const turn = await repository.createPendingTurn({
      conversationId: conversation.id,
      parentId: rootMessageId(conversation.id),
      userMessageId: `phase8-switch-${index}-user`,
      userBlocks: textBlocks(`Short switch fixture ${index + 1}`),
      assistantMessageId: `phase8-switch-${index}-assistant`,
      assistantBlocks: { version: 1, blocks: [] },
      assistantModelRef: modelRef,
      createdAt: FIXTURE_TIME + index * 4,
    });
    await repository.updateMessage(
      turn.assistantMessage.id,
      "done",
      textBlocks(`Short answer ${index + 1}`),
      FIXTURE_TIME + index * 4 + 1,
    );
  }

  const conversation = await service.createConversation(
    PHASE8_PERFORMANCE_CONVERSATION_TITLE,
    modelRef,
  );
  const userMessageIds: string[] = [];
  const assistantMessageIds: string[] = [];
  let parentId = rootMessageId(conversation.id);

  for (let index = 0; index < ACTIVE_TURNS; index += 1) {
    const createdAt = FIXTURE_TIME + 1_000 + index * 4;
    const userMessageId = `phase8-user-${String(index).padStart(4, "0")}`;
    const assistantMessageId = `phase8-assistant-${String(index).padStart(4, "0")}`;
    const turn = await repository.createPendingTurn({
      conversationId: conversation.id,
      parentId,
      userMessageId,
      userBlocks: textBlocks(userFixtureText(index)),
      assistantMessageId,
      assistantBlocks: { version: 1, blocks: [] },
      assistantModelRef: modelRef,
      createdAt,
    });
    await repository.updateMessage(
      assistantMessageId,
      "done",
      index === ACTIVE_TURNS - 1
        ? phase8LongMessageBlocks()
        : textBlocks(assistantFixtureText(index)),
      createdAt + 1,
    );
    userMessageIds.push(turn.userMessage.id);
    assistantMessageIds.push(turn.assistantMessage.id);
    parentId = turn.assistantMessage.id;
  }

  for (let index = 0; index < BRANCH_MESSAGES; index += 1) {
    const parentUserMessageId = userMessageIds[index * 25];
    if (!parentUserMessageId) throw new Error("Phase 8 branch parent was not generated");
    const assistantMessageId = `phase8-branch-assistant-${String(index).padStart(2, "0")}`;
    const branch = await repository.createAssistantSibling({
      conversationId: conversation.id,
      parentUserMessageId,
      assistantMessageId,
      assistantBlocks: { version: 1, blocks: [] },
      assistantModelRef: modelRef,
      createdAt: FIXTURE_TIME + 5_000 + index * 2,
    });
    await repository.updateMessage(
      branch.id,
      "done",
      textBlocks(`Alternative branch ${index + 1}`),
      FIXTURE_TIME + 5_000 + index * 2 + 1,
    );
  }

  const activeLeaf = assistantMessageIds.at(-1);
  if (!activeLeaf) throw new Error("Phase 8 active leaf was not generated");
  await repository.setActiveLeaf(conversation.id, activeLeaf, FIXTURE_TIME + 10_000);

  return {
    activePathMessages: ACTIVE_TURNS * 2,
    attachmentBlocks: 4,
    branchMessages: BRANCH_MESSAGES,
    codeBlocks: 20,
    conversationId: conversation.id,
    longTextCharacters: 50_000,
    thinkingBlocks: 50,
    toolCalls: 100,
    totalMessages: ACTIVE_TURNS * 2 + BRANCH_MESSAGES,
  };
}

function textBlocks(text: string): MessageBlocks {
  return { version: 1, blocks: [{ type: "text", text }] };
}

function userFixtureText(index: number): string {
  const suffix = String(index + 1).padStart(3, "0");
  if (index % 4 === 0) return `Turn ${suffix}\n\n- list item\n- another item`;
  if (index % 4 === 1) return `Turn ${suffix}\n\n> quoted fixture`;
  if (index % 4 === 2)
    return `Turn ${suffix}\n\n| key | value |\n| --- | --- |\n| seed | ${suffix} |`;
  return `Turn ${suffix}: ordinary short message`;
}

function assistantFixtureText(index: number): string {
  return `Assistant fixture ${String(index + 1).padStart(3, "0")} completed.`;
}

function phase8LongMessageBlocks(): MessageBlocks {
  const longText = repeatToLength(
    "Long-form local performance fixture content remains readable and lossless. ",
    50_000,
  );
  const languages = [
    "typescript",
    "javascript",
    "python",
    "rust",
    "go",
    "java",
    "c",
    "cpp",
    "csharp",
    "ruby",
    "php",
    "swift",
    "kotlin",
    "sql",
    "bash",
    "powershell",
    "json",
    "yaml",
    "html",
    "css",
  ];
  const code = languages
    .map(
      (language, index) =>
        `\n\n\`\`\`${language}\n// Phase 8 code block ${index + 1}\nconst value = ${index + 1};\n\`\`\``,
    )
    .join("");
  const blocks: MessageBlock[] = [
    {
      type: "text",
      blockId: "phase8-long-text",
      text: `# ${PHASE8_LONG_MESSAGE_MARKER}\n\n$E = mc^2$\n\n$$a^2 + b^2 = c^2$$\n\n${longText}${code}`,
    },
  ];

  for (let index = 0; index < 50; index += 1) {
    blocks.push({
      type: "thinking",
      blockId: `phase8-thinking-${index}`,
      text: `Provider-returned summary ${index + 1}`,
      visibility: "summary",
      startedAt: FIXTURE_TIME + index * 10,
      finishedAt: FIXTURE_TIME + index * 10 + 5,
    });
  }

  for (let index = 0; index < 100; index += 1) {
    const failed = index % 10 === 9;
    blocks.push({
      type: "tool_call",
      id: `phase8-tool-${index}`,
      name: index % 2 === 0 ? "search" : "fixture_tool",
      args: { query: `Phase 8 query ${index + 1}` },
      status: failed ? "failed" : "succeeded",
      source: index % 2 === 0 ? "provider" : "client",
      startedAt: FIXTURE_TIME + 1_000 + index * 10,
      finishedAt: FIXTURE_TIME + 1_000 + index * 10 + 4,
      result: failed
        ? {
            modelContent: { error: "fixture_failure" },
            error: { code: "fixture_failure" },
          }
        : { modelContent: { result: `tool result ${index + 1}` } },
    });
  }

  for (let index = 0; index < 20; index += 1) {
    const sourceId = `phase8-source-${index}`;
    blocks.push({
      type: "source",
      id: sourceId,
      kind: "web",
      title: `Phase 8 source ${index + 1}`,
      url: `https://example.com/phase8/${index + 1}`,
      toolCallId: `phase8-tool-${index * 5}`,
    });
    blocks.push({
      type: "citation",
      id: `phase8-citation-${index}`,
      sourceId,
      marker: `[${index + 1}]`,
    });
  }

  blocks.push(
    { type: "file", artifactRef: "artifact-phase8-file-1", name: "fixture.txt" },
    { type: "file", artifactRef: "artifact-phase8-file-2", name: "fixture.json" },
    { type: "image", artifactRef: "artifact-phase8-image-1", mime: "image/png" },
    { type: "image", artifactRef: "artifact-phase8-image-2", mime: "image/webp" },
  );

  return { version: 1, blocks };
}

function repeatToLength(value: string, length: number): string {
  return value.repeat(Math.ceil(length / value.length)).slice(0, length);
}
