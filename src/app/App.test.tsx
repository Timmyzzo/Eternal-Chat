import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { ThemeProvider } from "@/app/ThemeProvider";
import { createBrowserFixtureRuntime } from "@/application/chat/runtime";
import { TooltipProvider } from "@/components/ui/tooltip";

async function renderApp() {
  const runtime = await createBrowserFixtureRuntime();
  return {
    runtime,
    ...render(
      <ThemeProvider>
        <TooltipProvider>
          <App runtime={runtime} />
        </TooltipProvider>
      </ThemeProvider>,
    ),
  };
}

describe("App", () => {
  it("renders the Phase 5 three-column workspace with an enabled conversation composer", async () => {
    const { container } = await renderApp();

    expect(await screen.findByRole("heading", { name: "Phase 5 local fixture" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(container.querySelector('[data-ui~="app.sidebar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui~="chat.composer"]')).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Request inspector" })).toBeVisible();
  });

  it("sends with Enter and renders the streamed terminal response", async () => {
    const user = userEvent.setup();
    await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });

    await user.type(composer, "Hello from the UI{enter}");
    expect(await screen.findByRole("button", { name: "Stop generation" })).toBeVisible();
    expect(await screen.findByText(/Phase 5 pipeline/)).toBeVisible();
    expect(await screen.findByRole("button", { name: "Regenerate response" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Field sources" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
  });

  it("stops an active request and keeps it as interrupted history", async () => {
    const user = userEvent.setup();
    const { container } = await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });

    await user.type(composer, "Stop this request{enter}");
    await user.click(await screen.findByRole("button", { name: "Stop generation" }));

    await waitFor(() =>
      expect(container.querySelector('[data-message-status="interrupted"]')).toBeInTheDocument(),
    );
    expect(screen.getByText("Generation stopped.")).toBeVisible();
  });

  it("shows retry countdown and attempt details while allowing the wait to be stopped", async () => {
    const user = userEvent.setup();
    const { container } = await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });

    await user.type(composer, "Retry UI{enter}");
    expect(await screen.findByText("Attempt 2 / 4")).toBeVisible();
    expect(screen.getByText("HTTP 429")).toBeVisible();
    expect(screen.getByText(/Retrying in/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop automatic retry" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Attempts" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Stop automatic retry" }));
    await waitFor(() =>
      expect(container.querySelector('[data-message-status="interrupted"]')).toBeInTheDocument(),
    );
    expect(screen.getByText("retry_cancelled")).toBeVisible();
  });

  it("edits the application retry default and exposes endpoint inheritance", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open connection settings" }));

    expect(screen.getByRole("heading", { name: "Application retry" })).toBeVisible();
    expect(screen.getByText("Application default", { selector: "output" })).toBeVisible();
    expect(screen.getByText("Application default", { selector: "span" })).toBeVisible();
    const maxRetries = screen.getByRole("spinbutton", { name: "Application max retries" });
    await user.clear(maxRetries);
    await user.type(maxRetries, "2");
    await user.click(screen.getByRole("button", { name: "Save application retry policy" }));

    await waitFor(() => expect(maxRetries).toHaveValue(2));
    expect(screen.getByRole("button", { name: "Save endpoint retry policy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reset endpoint retry policy" })).toBeVisible();
  });

  it("renders Phase 6 preset catalogs, dynamic fields, ownership actions, and conversation overrides", async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole("button", { name: "Open connection settings" }));

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Configuration preset" }),
      screen.getByRole("option", { name: "xAI Grok 4.20 multi-agent via Responses" }),
    );
    expect(screen.getByRole("link", { name: "Official source" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:\/\//),
    );
    expect(screen.getByText("reasoning.effort")).toBeVisible();
    expect(screen.getByRole("option", { name: "XHigh" })).toBeVisible();
    await user.selectOptions(screen.getByRole("combobox", { name: "Reasoning effort" }), "xhigh");
    expect(screen.getByRole("combobox", { name: "X search mode" })).toHaveValue("off");

    await user.click(screen.getByRole("button", { name: "Copy preset as detached" }));
    expect(screen.getByText("Detached copy")).toBeVisible();
    await user.click(screen.getByText("Advanced schemas and overrides"));
    const endpointBody = screen.getByRole("textbox", { name: "Endpoint body JSON" });
    fireEvent.change(endpointBody, { target: { value: '{"custom":true}' } });
    await user.click(screen.getByRole("button", { name: "Reset preset" }));
    expect(screen.getByText("Tracked preset")).toBeVisible();
    expect(endpointBody).toHaveValue("{}");

    expect(screen.getByRole("heading", { name: "Conversation overrides" })).toBeVisible();
    await user.click(screen.getByText("Conversation raw overrides"));
    expect(screen.getByRole("textbox", { name: "Conversation path JSON" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save conversation overrides" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Parameter compatibility" })).toBeVisible();
    expect(await screen.findByText("Current", { selector: "span" })).toBeVisible();
    expect(screen.getByText("Stale", { selector: "span" })).toBeVisible();
  });

  it("routes a new conversation through the Responses profile", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Model for new conversation" }),
      screen.getByRole("option", { name: "Browser Responses fixture" }),
    );
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await user.type(composer, "Use Responses{enter}");

    expect(await screen.findByText(/Responses endpoint uses the same registry/)).toBeVisible();
    expect(await screen.findByRole("button", { name: "Regenerate response" })).toBeVisible();
    expect(screen.getAllByText(/Reasoning summary/).length).toBeGreaterThan(0);
    const processSummary = screen
      .getByRole("region", { name: "Provider process" })
      .querySelector("summary");
    expect(processSummary).not.toBeNull();
    expect(processSummary).toHaveTextContent("1 tool · 1 source");
    expect(screen.getByText("1 citation linked to this answer")).toBeVisible();
    await user.click(processSummary!);
    expect(screen.getByText("Phase 7 structured search")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open source Phase 7 source" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Open process details" }));
    expect(screen.getByRole("dialog", { name: "Process details" })).toBeVisible();
    expect(screen.getByText("tool result")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close process details" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Process details" })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: "Phase 5 local fixture" }));
    const newConversationItem = screen
      .getAllByRole("button", { name: "New conversation" })
      .find((button) => button.classList.contains("conversation-item"));
    expect(newConversationItem).toBeDefined();
    await user.click(newConversationItem!);
    const reloadedSummary = (
      await screen.findByRole("region", { name: "Provider process" })
    ).querySelector("summary");
    expect(reloadedSummary).not.toBeNull();
    await user.click(reloadedSummary!);
    expect(await screen.findByRole("button", { name: "Open source Phase 7 source" })).toBeVisible();
  });

  it("regenerates an assistant sibling without duplicating the user message", async () => {
    const user = userEvent.setup();
    await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await user.type(composer, "Regenerate this{enter}");
    await screen.findByText(/Phase 5 pipeline/);

    await user.click(await screen.findByRole("button", { name: "Regenerate response" }));
    await screen.findByRole("button", { name: "Stop generation" });
    await screen.findByText(/Phase 5 pipeline/);
    await waitFor(() => expect(screen.getAllByText("Regenerate this")).toHaveLength(1));
  });

  it("keeps a detached request running while another conversation is selected", async () => {
    const user = userEvent.setup();
    await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await user.type(composer, "Background completion{enter}");
    await screen.findByRole("button", { name: "Stop generation" });
    await user.click(screen.getByRole("button", { name: "New conversation" }));

    await new Promise((resolve) => window.setTimeout(resolve, 800));
    await user.click(screen.getByRole("button", { name: "Phase 5 local fixture" }));
    expect(await screen.findByText(/Phase 5 pipeline/)).toBeVisible();
  });

  it("does not rerender completed history while streaming state changes", async () => {
    const user = userEvent.setup();
    await renderApp();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    await user.type(composer, "Render isolation{enter}");
    await screen.findByRole("button", { name: "Stop generation" });
    const userRow = screen.getByText("Render isolation").closest("article");
    const before = userRow?.getAttribute("data-render-count");

    await screen.findByText(/Checking the local fixture/);
    expect(userRow?.getAttribute("data-render-count")).toBe(before);
  });

  it("opens appearance settings and applies a fixed dark theme", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(screen.getByRole("button", { name: "Open appearance settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(screen.getByRole("dialog", { name: "Appearance" })).toBeVisible();
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem("eternal-chat.theme")).toBe("dark");
  });
});
