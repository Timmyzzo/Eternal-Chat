import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { ThemeProvider } from "@/app/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderApp() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("App", () => {
  it("renders the Phase 1 application shell without pretending chat is available", () => {
    const { container } = renderApp();

    expect(screen.getByRole("heading", { name: "No conversation selected" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(container.querySelector('[data-ui~="app.sidebar"]')).toBeInTheDocument();
    expect(container.querySelector('[data-ui~="chat.composer"]')).toBeInTheDocument();
  });

  it("opens appearance settings and applies a fixed dark theme", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Open appearance settings" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(screen.getByRole("dialog", { name: "Appearance" })).toBeVisible();
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem("eternal-chat.theme")).toBe("dark");
  });
});
