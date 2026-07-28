import { expect, test } from "@playwright/test";

const PHASE8_INPUT_LATENCY_P95_BUDGET_MS = 60;
const RESIZE_OBSERVER_LOOP_ERROR = "ResizeObserver loop completed with undelivered notifications.";

test.beforeEach(async ({ page }) => {
  await page.addInitScript((knownMessage) => {
    const diagnosticWindow = window as Window & { phase8ResizeObserverLoopErrors?: number };
    diagnosticWindow.phase8ResizeObserverLoopErrors = 0;
    window.addEventListener(
      "error",
      (event) => {
        if (event.message !== knownMessage) return;
        diagnosticWindow.phase8ResizeObserverLoopErrors =
          (diagnosticWindow.phase8ResizeObserverLoopErrors ?? 0) + 1;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
  }, RESIZE_OBSERVER_LOOP_ERROR);
});

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

test("Escape leaves generation running until the explicit stop command", async ({ page }) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Stop with the keyboard");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
  await expect(page.locator('[data-message-status="interrupted"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Stop generation" }).click();

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

test("Phase 8 keeps the 1000-message seed virtualized, responsive, and layout-stable", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/?fixture=phase8-performance");

  await expect(
    page.getByRole("heading", { level: 1, name: "Phase 8 performance seed" }),
  ).toBeVisible();
  await expect(page.getByText("Phase 8 long response")).toBeVisible();
  await expect(page.locator(".message-code")).toHaveCount(20);
  await expect(page.locator(".message-code-highlighted")).toHaveCount(20, { timeout: 60_000 });
  await expect(page.locator(".katex").first()).toBeVisible();

  const historicalRenderCounts = await readHistoricalRenderCounts(page);
  const inputLatencyP95 = await page.evaluate(async () => {
    const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!composer || !setter) return Number.POSITIVE_INFINITY;
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      setter.call(composer, `Latency sample ${index}`);
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    return samples[Math.ceil(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  });
  expect(inputLatencyP95).toBeLessThan(PHASE8_INPUT_LATENCY_P95_BUDGET_MS);
  expect(await readHistoricalRenderCounts(page)).toEqual(historicalRenderCounts);

  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Phase 8 long response")).toBeVisible();
  const scroll = await measureRapidScroll(page);
  const metrics = await page.evaluate(() => {
    const virtualList = document.querySelector<HTMLElement>(".message-virtual-list");
    const messageRows = virtualList?.querySelectorAll(".message-row").length ?? 0;
    const renderedElements = virtualList?.querySelectorAll("*").length ?? 0;
    const codeFits = [...document.querySelectorAll<HTMLElement>(".message-code")].every((block) => {
      const row = block.closest<HTMLElement>(".message-row");
      if (!row) return false;
      return block.getBoundingClientRect().right <= row.getBoundingClientRect().right + 1;
    });
    return {
      codeFits,
      hasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      messageRows,
      renderedElements,
    };
  });
  expect(metrics.messageRows).toBeLessThanOrEqual(60);
  expect(metrics.renderedElements).toBeLessThan(3_000);
  expect(metrics.codeFits).toBe(true);
  expect(metrics.hasOverflow).toBe(false);
  expect(scroll.medianFrameMs).toBeLessThan(1_000 / 55);
  expect(scroll.longestBelow40FpsRun).toBeLessThan(12);

  const resizeObserverLoopErrors = await page.evaluate(
    () =>
      (window as Window & { phase8ResizeObserverLoopErrors?: number })
        .phase8ResizeObserverLoopErrors ?? 0,
  );
  console.info(
    "Phase 8 interaction metrics",
    JSON.stringify({
      inputLatencyP95,
      resizeObserverLoopErrors,
      scroll,
    }),
  );
  expect(pageErrors).toEqual([]);
});

test("Phase 8 releases memory across 100 conversation switches", async ({
  context,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Precise heap sampling runs once on desktop");
  test.setTimeout(120_000);
  await page.goto("/?fixture=phase8-performance");
  await expect(page.getByText("Phase 8 long response")).toBeVisible();
  await expect(page.locator(".message-code-highlighted")).toHaveCount(20, { timeout: 60_000 });

  await page.getByRole("button", { exact: true, name: "Phase 8 switch 01" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Phase 8 switch 01" })).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Phase 8 performance seed" }).click();
  await expect(page.getByText("Phase 8 long response")).toBeVisible();

  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.collectGarbage");
  const samples = [await readResourceSample(page, cdp, 0)];
  const titles = [
    ...Array.from(
      { length: 19 },
      (_, index) => `Phase 8 switch ${String(index + 1).padStart(2, "0")}`,
    ),
    "Phase 8 performance seed",
  ];
  for (let index = 0; index < 100; index += 1) {
    const title = titles[index % titles.length]!;
    await page.getByRole("button", { exact: true, name: title }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    if ((index + 1) % titles.length === 0) {
      await cdp.send("HeapProfiler.collectGarbage");
      samples.push(await readResourceSample(page, cdp, index + 1));
    }
  }
  const baseline = samples[0]!;
  const final = samples.at(-1)!;
  const heapGrowth = samples.map((sample) => sample.heapBytes - baseline.heapBytes);
  const listenerGrowth = samples.map(
    (sample) => sample.jsEventListeners - baseline.jsEventListeners,
  );
  console.info("Phase 8 switch resource curve", JSON.stringify(samples));
  expect(Math.max(...heapGrowth)).toBeLessThan(20 * 1024 * 1024);
  expect(final.heapBytes - baseline.heapBytes).toBeLessThan(20 * 1024 * 1024);
  expect(Math.max(...listenerGrowth)).toBeLessThanOrEqual(8);
  expect(final.jsEventListeners - baseline.jsEventListeners).toBeLessThanOrEqual(2);
  expect(final.documents).toBe(baseline.documents);
  expect(final.nodes - baseline.nodes).toBeLessThan(1_000);
});

async function measureRapidScroll(page: import("@playwright/test").Page): Promise<{
  framesBelow40FpsRatio: number;
  longestBelow40FpsRun: number;
  medianFrameMs: number;
  p95FrameMs: number;
}> {
  return page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>(".message-virtual-list");
    if (!viewport) {
      return {
        framesBelow40FpsRatio: 1,
        longestBelow40FpsRun: Number.POSITIVE_INFINITY,
        medianFrameMs: Number.POSITIVE_INFINITY,
        p95FrameMs: Number.POSITIVE_INFINITY,
      };
    }
    const frameIntervals: number[] = [];
    let previousFrame: number | null = null;
    const frameCount = 90;
    for (let index = 0; index < frameCount; index += 1) {
      const frame = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
      if (previousFrame !== null) frameIntervals.push(frame - previousFrame);
      previousFrame = frame;
      const progress = index / (frameCount - 1);
      const travel = progress <= 0.5 ? progress * 2 : (1 - progress) * 2;
      viewport.scrollTop = travel * Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
    const sorted = [...frameIntervals].sort((left, right) => left - right);
    const medianFrameMs = sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
    const p95FrameMs = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    let currentBelow40FpsRun = 0;
    let longestBelow40FpsRun = 0;
    for (const interval of frameIntervals) {
      if (interval > 1_000 / 40) {
        currentBelow40FpsRun += 1;
        longestBelow40FpsRun = Math.max(longestBelow40FpsRun, currentBelow40FpsRun);
      } else {
        currentBelow40FpsRun = 0;
      }
    }
    return {
      framesBelow40FpsRatio:
        frameIntervals.filter((interval) => interval > 1_000 / 40).length / frameIntervals.length,
      longestBelow40FpsRun,
      medianFrameMs,
      p95FrameMs,
    };
  });
}

async function readHistoricalRenderCounts(
  page: import("@playwright/test").Page,
): Promise<Record<string, string>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".message-row[data-message-id]")].map((row) => [
        row.dataset.messageId ?? "",
        row.dataset.renderCount ?? "",
      ]),
    ),
  );
}

async function readResourceSample(
  page: import("@playwright/test").Page,
  cdp: import("@playwright/test").CDPSession,
  switches: number,
): Promise<{
  documents: number;
  heapBytes: number;
  jsEventListeners: number;
  nodes: number;
  switches: number;
}> {
  const counters = await cdp.send("Memory.getDOMCounters");
  return {
    documents: counters.documents,
    heapBytes: await readUsedHeap(page),
    jsEventListeners: counters.jsEventListeners,
    nodes: counters.nodes,
    switches,
  };
}

async function readUsedHeap(page: import("@playwright/test").Page): Promise<number> {
  const bytes = await page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
    return memory?.usedJSHeapSize ?? null;
  });
  expect(bytes).not.toBeNull();
  return bytes ?? Number.POSITIVE_INFINITY;
}
