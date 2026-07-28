import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HistoricalMessage } from "@/app/MessageView";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Message } from "@/domain/chat";

describe("MessageView structured sources", () => {
  it("keeps missing and unsafe source URLs visible but non-interactive", async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn();
    render(
      <TooltipProvider>
        <HistoricalMessage message={messageWithSources()} onOpenExternal={openExternal} />
      </TooltipProvider>,
    );

    await user.click(
      screen.getByRole("region", { name: "Provider process" }).querySelector("summary")!,
    );
    expect(screen.getByRole("button", { name: "Source Missing URL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Source Unsafe URL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Open source Safe URL" })).toBeEnabled();
    expect(screen.getByText(/unsupported provider event future.event/)).toBeVisible();
    expect(openExternal).not.toHaveBeenCalled();
  });
});

function messageWithSources(): Message {
  return {
    id: "assistant-source-safety",
    conversationId: "conversation-source-safety",
    role: "assistant",
    blocks: {
      version: 1,
      blocks: [
        { type: "source", id: "missing", title: "Missing URL", kind: "other" },
        { type: "source", id: "unsafe", title: "Unsafe URL", url: "javascript:alert(1)" },
        { type: "source", id: "safe", title: "Safe URL", url: "https://example.com" },
        {
          type: "provider_state",
          id: "metadata:compatibility_warning",
          provider: "openai_compatible",
          purpose: "compatibility_warning",
          data: { code: "responses_unknown_event", eventType: "future.event" },
        },
      ],
      timeline: [],
    },
    status: "done",
    usage: null,
    modelRef: "model-1",
    parentId: "user-1",
    siblingOrder: 0,
    providerResponseId: "response-1",
    providerPreviousResponseId: null,
    requestSnapshotId: "snapshot-1",
    createdAt: 1,
    updatedAt: 2,
  };
}
