import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearMarkdownCache, markdownCacheSize } from "@/app/safeMarkdownCache";
import { SafeMarkdown } from "@/app/SafeMarkdown";
import { ThemeProvider, useTheme } from "@/app/ThemeProvider";

const ASYNC_RENDER_TIMEOUT_MS = 10_000;

const lazyRenderers = vi.hoisted(() => ({
  codeToHtml: vi.fn(async (source: string) => `<pre><code>${source}</code></pre>`),
  renderToString: vi.fn((source: string) => `<span class="katex-fixture">${source}</span>`),
}));

vi.mock("shiki/bundle/web", () => ({ codeToHtml: lazyRenderers.codeToHtml }));
vi.mock("katex", () => ({
  default: { renderToString: lazyRenderers.renderToString },
}));

afterEach(() => {
  clearMarkdownCache();
  lazyRenderers.codeToHtml.mockClear();
  lazyRenderers.renderToString.mockClear();
  vi.useRealTimers();
});

describe("SafeMarkdown", () => {
  it("escapes raw HTML and routes only HTTP(S) links through the safe opener", async () => {
    const user = userEvent.setup();
    const openExternal = vi.fn();
    const { container } = renderMarkdown(
      "<img src=x onerror=alert(1)> [safe](https://example.com/path) [bad](javascript:alert(1))",
      { onOpenExternal: openExternal },
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeVisible();
    const safe = await screen.findByRole(
      "link",
      { name: "safe" },
      { timeout: ASYNC_RENDER_TIMEOUT_MS },
    );
    expect(safe).toHaveAttribute("data-external-url", "https://example.com/path");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();

    await user.click(safe);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/path");
  });

  it("publishes the latest streaming text at least once every 50ms", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { rerender } = render(
      <ThemeProvider>
        <SafeMarkdown text="first" />
      </ThemeProvider>,
    );

    rerender(
      <ThemeProvider>
        <SafeMarkdown text="second" />
      </ThemeProvider>,
    );
    act(() => vi.advanceTimersByTime(10));
    rerender(
      <ThemeProvider>
        <SafeMarkdown text="third" />
      </ThemeProvider>,
    );
    act(() => vi.advanceTimersByTime(39));
    expect(screen.getByText("first")).toBeVisible();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("third")).toBeVisible();
  });

  it("clears the pending streaming render timer when unmounted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { rerender, unmount } = render(
      <ThemeProvider>
        <SafeMarkdown text="first" />
      </ThemeProvider>,
    );

    rerender(
      <ThemeProvider>
        <SafeMarkdown text="second" />
      </ThemeProvider>,
    );
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(clearTimeout).toHaveBeenCalled();
  });

  it("bounds completed HTML at 120 entries and invalidates by theme", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeCacheHarness />
        {Array.from({ length: 120 }, (_, index) => (
          <SafeMarkdown
            completed
            key={index}
            messageId={`cache-${index}`}
            text={`cached value ${index}`}
          />
        ))}
      </ThemeProvider>,
    );

    await waitFor(() => expect(markdownCacheSize()).toBe(120), {
      timeout: ASYNC_RENDER_TIMEOUT_MS,
    });
    await user.click(screen.getByRole("button", { name: "Use dark theme" }));
    await waitFor(
      () => {
        expect(document.documentElement).toHaveClass("dark");
        expect(markdownCacheSize()).toBe(120);
      },
      { timeout: ASYNC_RENDER_TIMEOUT_MS },
    );
  });

  it("loads Shiki and KaTeX only for completed matching content", async () => {
    const { container, rerender } = render(
      <ThemeProvider>
        <SafeMarkdown completed messageId="plain" text="Plain completed text" />
      </ThemeProvider>,
    );
    await waitFor(() => expect(markdownCacheSize()).toBe(1), {
      timeout: ASYNC_RENDER_TIMEOUT_MS,
    });
    expect(lazyRenderers.codeToHtml).not.toHaveBeenCalled();
    expect(lazyRenderers.renderToString).not.toHaveBeenCalled();

    rerender(
      <ThemeProvider>
        <SafeMarkdown
          completed
          messageId="rich"
          text={"```ts\nconst value = 1;\n```\n\nInline $x + y$"}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(lazyRenderers.codeToHtml).toHaveBeenCalledTimes(1), {
      timeout: ASYNC_RENDER_TIMEOUT_MS,
    });
    await waitFor(() => expect(lazyRenderers.renderToString).toHaveBeenCalledTimes(1), {
      timeout: ASYNC_RENDER_TIMEOUT_MS,
    });
    expect(container.querySelector(".message-code-highlighted")).toBeInTheDocument();
    expect(container.querySelector(".katex-fixture")).toHaveTextContent("x + y");
  });
});

function ThemeCacheHarness() {
  const { setMode } = useTheme();
  return (
    <>
      <button onClick={() => setMode("dark")} type="button">
        Use dark theme
      </button>
      <SafeMarkdown completed messageId="theme-cache" text="Theme cache value" />
    </>
  );
}

function renderMarkdown(text: string, props: { onOpenExternal?: (url: string) => void } = {}) {
  return render(
    <ThemeProvider>
      <SafeMarkdown completed messageId="fixture" text={text} {...props} />
    </ThemeProvider>,
  );
}
