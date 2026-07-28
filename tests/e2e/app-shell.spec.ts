import { expect, test } from "@playwright/test";

test("the Phase 5 workspace fits both desktop viewports and exposes the inspector", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Phase 5 local fixture" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);

  if (testInfo.project.name === "desktop") {
    await expect(page.getByRole("complementary", { name: "Request inspector" })).toBeVisible();
  } else {
    await expect(page.getByRole("complementary", { name: "Request inspector" })).toBeHidden();
    await page.getByRole("button", { name: "Open request inspector" }).click();
    await expect(page.getByRole("dialog", { name: "Request inspector" })).toBeVisible();
    await page.getByRole("button", { name: "Close request inspector" }).click();
  }

  await page.getByRole("button", { name: "Open appearance settings" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("button", { name: "Close appearance settings" }).click();
});

test("keyboard send streams a response without overlapping the composer", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Playwright streaming check");
  await composer.press("Enter");

  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect(page.getByText(/Phase 5 pipeline/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();

  const overlap = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const footer = document.querySelector<HTMLElement>(".composer-footer");
    if (!list || !footer) return true;
    const listRect = list.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return listRect.bottom > footerRect.top + 1;
  });
  expect(overlap).toBe(false);
});

test("Escape stops generation and preserves interrupted history", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Stop with the keyboard");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.locator('[data-message-status="interrupted"]')).toBeVisible();
  await expect(page.getByText("Generation stopped.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});

test("automatic retry remains inspectable and stoppable without layout overflow", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Retry UI");
  await composer.press("Enter");

  await expect(page.getByText("Attempt 2 / 4")).toBeVisible();
  await expect(page.getByText("HTTP 429")).toBeVisible();
  await expect(page.getByText(/Retrying in/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop automatic retry" })).toBeVisible();

  if (testInfo.project.name === "desktop") {
    const inspector = page.getByRole("complementary", { name: "Request inspector" });
    await expect(inspector.getByRole("heading", { name: "Attempts" })).toBeVisible();
    await expect(inspector.getByText("Attempt 1")).toBeVisible();
  } else {
    await page.getByRole("button", { name: "Open request inspector" }).click();
    const inspector = page.getByRole("dialog", { name: "Request inspector" });
    await expect(inspector.getByRole("heading", { name: "Attempts" })).toBeVisible();
    await expect(inspector.getByText("Attempt 1")).toBeVisible();
    await page.getByRole("button", { name: "Close request inspector" }).click();
  }

  const layout = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".message-list");
    const footer = document.querySelector<HTMLElement>(".composer-footer");
    if (!list || !footer) {
      return { hasOverflow: true, overlapsComposer: true };
    }
    const listRect = list.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    return {
      hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      overlapsComposer: listRect.bottom > footerRect.top + 1,
    };
  });
  expect(layout).toEqual({ hasOverflow: false, overlapsComposer: false });

  await page.getByRole("button", { name: "Stop automatic retry" }).click();
  await expect(page.locator('[data-message-status="interrupted"]')).toBeVisible();
  await expect(page.getByText("retry_cancelled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
});

test("long text wraps without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  const longWord = "phase5".repeat(120);
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(longWord);
  await composer.press("Enter");
  await expect(page.locator(".message-paragraph", { hasText: longWord })).toBeVisible();

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
  await page.keyboard.press("Escape");
});

test("reduced motion keeps sheets usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Open appearance settings" }).click();

  const sheet = page.getByRole("dialog", { name: "Appearance" });
  await expect(sheet).toHaveAttribute("data-motion-reduced", "true");
  await expect(sheet).toBeVisible();
});

test("Phase 6 preset ownership and conversation overrides stay visible in the final preview", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open connection settings" }).click();
  const settings = page.getByRole("dialog", { name: "Connections" });

  await settings
    .getByRole("combobox", { name: "Configuration preset" })
    .selectOption({ label: "xAI Grok 4.20 multi-agent via Responses" });
  await settings.getByRole("combobox", { name: "Reasoning effort" }).selectOption("xhigh");
  await expect(settings.getByRole("combobox", { name: "Reasoning effort" })).toHaveValue("xhigh");
  await settings.getByRole("button", { name: "Copy preset as detached" }).click();
  await expect(settings.getByText("Detached copy")).toBeVisible();
  await settings.getByText("Advanced schemas and overrides").click();
  await settings.getByRole("textbox", { name: "Endpoint body JSON" }).fill('{"custom":true}');
  await settings.getByRole("button", { name: "Reset preset" }).click();
  await expect(settings.getByText("Tracked preset")).toBeVisible();
  await expect(settings.getByRole("textbox", { name: "Endpoint body JSON" })).toHaveValue("{}");

  await settings.getByText("Conversation raw overrides").click();
  await settings
    .getByRole("textbox", { name: "Conversation body JSON" })
    .fill('{"conversation_marker":"phase6"}');
  await settings.getByRole("button", { name: "Save conversation overrides" }).click();
  await settings.getByRole("button", { name: "Close connection settings" }).click();

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Phase 6 override preview");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();

  const inspector =
    testInfo.project.name === "desktop"
      ? page.getByRole("complementary", { name: "Request inspector" })
      : page.getByRole("dialog", { name: "Request inspector" });
  if (testInfo.project.name !== "desktop") {
    await page.getByRole("button", { name: "Open request inspector" }).click();
  }
  const bodyPreview = inspector
    .getByRole("heading", { name: "Body" })
    .locator("xpath=following-sibling::pre[1]");
  await expect(bodyPreview).toContainText('"conversation_marker": "phase6"');
  await expect(bodyPreview).toContainText('"model": "browser-fixture-chat"');
});

test("Phase 6 configures mixed relay endpoints and keeps an unknown Responses model usable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open connection settings" }).click();
  const settings = page.getByRole("dialog", { name: "Connections" });
  const preset = settings.getByRole("combobox", { name: "Configuration preset" });
  const target = settings.getByRole("combobox", { name: "Connection target" });

  await preset.selectOption({ label: "OpenAI GPT via Responses" });
  await target.selectOption({ label: "Local Chat fixture" });
  await settings.getByRole("spinbutton", { name: "Port" }).fill("443");
  await settings.getByRole("textbox", { name: "Model ID" }).fill("unknown-relay-responses");
  await settings.getByRole("textbox", { name: "Display name" }).fill("Unknown relay Responses");
  await settings.getByRole("checkbox", { name: "Attach session credential" }).uncheck();
  await settings.getByRole("button", { name: "Add connection" }).click();
  const responsesRow = settings.locator('.provider-catalog-row[data-port="443"]', {
    hasText: "Unknown relay Responses",
  });
  await expect(responsesRow).toBeVisible();
  await expect(responsesRow).toHaveAttribute("data-profile", "openai_responses");
  await expect(responsesRow).toContainText("port 443");

  await preset.selectOption({ label: "Anthropic Claude Messages" });
  await target.selectOption({ label: "Local Chat fixture" });
  await settings.getByRole("spinbutton", { name: "Port" }).fill("8443");
  await settings.getByRole("textbox", { name: "Model ID" }).fill("unknown-relay-messages");
  await settings.getByRole("textbox", { name: "Display name" }).fill("Unknown relay Messages");
  await settings.getByRole("checkbox", { name: "Attach session credential" }).uncheck();
  await settings.getByRole("button", { name: "Add connection" }).click();
  const messagesRow = settings.locator('.provider-catalog-row[data-port="8443"]', {
    hasText: "Unknown relay Messages",
  });
  await expect(messagesRow).toBeVisible();
  await expect(messagesRow).toHaveAttribute("data-profile", "anthropic_messages");
  await expect(messagesRow).toContainText("port 8443");
  await expect(messagesRow).toHaveAttribute(
    "data-connection-id",
    await responsesRow.getAttribute("data-connection-id"),
  );

  await settings.getByRole("button", { name: "Close connection settings" }).click();
  await page
    .getByRole("combobox", { name: "Model for new conversation" })
    .selectOption({ label: "Unknown relay Responses" });
  await page.getByRole("button", { name: "New conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Unknown model check");
  await composer.press("Enter");
  await expect(page.getByText(/Responses endpoint uses the same registry/)).toBeVisible();
});

test("Phase 7 keeps structured reasoning, search, sources, and the reload timeline", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Model for new conversation" })
    .selectOption({ label: "Browser Responses fixture" });
  await page.getByRole("button", { name: "New conversation" }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Phase 7 structured process");
  await composer.press("Enter");

  await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible();
  await page.getByRole("region", { name: "Provider process" }).locator("summary").click();
  await expect(page.getByText("Phase 7 structured search")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open source Phase 7 source" })).toBeEnabled();
  await page.getByRole("button", { name: "Open process details" }).click();
  const details = page.getByRole("dialog", { name: "Process details" });
  await expect(details).toBeVisible();
  await expect(details.getByText("tool result")).toBeVisible();
  await page.getByRole("button", { name: "Close process details" }).click();
  await expect(details).toBeHidden();

  await page.getByRole("button", { name: "Phase 5 local fixture" }).click();
  await page.locator(".conversation-item", { hasText: "New conversation" }).click();
  await page.getByRole("region", { name: "Provider process" }).locator("summary").click();
  await expect(page.getByRole("button", { name: "Open source Phase 7 source" })).toBeVisible();

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);
});
