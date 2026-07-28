import { useEffect, useRef, useState, type MouseEvent } from "react";

import { getCachedMarkdown, setCachedMarkdown } from "@/app/safeMarkdownCache";
import { useTheme } from "@/app/ThemeProvider";

interface SafeMarkdownProps {
  completed?: boolean;
  messageId?: string;
  onOpenExternal?: (url: string) => void;
  onRendered?: () => void;
  text: string;
  version?: string | number;
}

const RENDERER_VERSION = "phase8-markdown-v1";
const STREAM_RENDER_INTERVAL_MS = 50;

export function SafeMarkdown({
  completed = false,
  messageId = "ephemeral",
  onOpenExternal,
  onRendered,
  text,
  version = 0,
}: SafeMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const throttledText = useThrottledText(text, completed ? 0 : STREAM_RENDER_INTERVAL_MS);
  const [html, setHtml] = useState(() => renderPlainText(throttledText));

  useEffect(() => {
    let cancelled = false;
    if (!completed) {
      setHtml(renderPlainText(throttledText));
      void renderBaseMarkdown(throttledText).then((rendered) => {
        if (!cancelled) setHtml(rendered);
      });
      return () => {
        cancelled = true;
      };
    }
    void renderCompletedMarkdown({
      messageId,
      text: throttledText,
      theme: resolvedTheme,
      version,
    }).then((rendered) => {
      if (!cancelled) setHtml(rendered);
    });
    return () => {
      cancelled = true;
    };
  }, [completed, messageId, resolvedTheme, throttledText, version]);

  useEffect(() => {
    onRendered?.();
  }, [html, onRendered]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[data-external-url]");
    if (!anchor) return;
    const safeUrl = safeExternalUrl(anchor.dataset.externalUrl);
    if (!safeUrl || !onOpenExternal) return;
    event.preventDefault();
    onOpenExternal(safeUrl);
  };

  return (
    <div
      className="safe-markdown"
      data-markdown-completed={completed}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}

function useThrottledText(text: string, delayMs: number): string {
  const [value, setValue] = useState(text);
  const latestText = useRef(text);
  const lastRenderedAt = useRef(Date.now());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    latestText.current = text;
    if (delayMs === 0) {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      lastRenderedAt.current = Date.now();
      setValue(text);
      return;
    }

    const commit = () => {
      timer.current = null;
      lastRenderedAt.current = Date.now();
      setValue(latestText.current);
    };
    const remaining = Math.max(0, delayMs - (Date.now() - lastRenderedAt.current));
    if (remaining === 0) {
      commit();
    } else if (timer.current === null) {
      timer.current = window.setTimeout(commit, remaining);
    }
  }, [delayMs, text]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return value;
}

async function renderBaseMarkdown(text: string): Promise<string> {
  const renderer = await import("@/app/markdownRenderer");
  return renderer.renderBaseMarkdown(text);
}

async function renderCompletedMarkdown(input: {
  messageId: string;
  text: string;
  theme: "dark" | "light";
  version: string | number;
}): Promise<string> {
  const key = [
    RENDERER_VERSION,
    input.messageId,
    input.version,
    input.theme,
    hashText(input.text),
  ].join(":");
  const cached = getCachedMarkdown(key);
  if (cached !== undefined) {
    return cached;
  }

  const container = document.createElement("div");
  container.innerHTML = await renderBaseMarkdown(input.text);
  const tasks: Promise<void>[] = [];
  if (containsCodeFence(input.text)) {
    tasks.push(enhanceCodeBlocks(container, input.theme));
  }
  if (containsMath(input.text)) {
    tasks.push(enhanceMath(container));
  }
  await Promise.all(tasks);
  const rendered = container.innerHTML;
  setCachedMarkdown(key, rendered);
  return rendered;
}

async function enhanceCodeBlocks(container: HTMLElement, theme: "dark" | "light"): Promise<void> {
  const codeBlocks = [...container.querySelectorAll<HTMLElement>("pre > code")];
  if (codeBlocks.length === 0) return;
  const { codeToHtml } = await import("shiki/bundle/web");
  await Promise.all(
    codeBlocks.map(async (code) => {
      const source = code.textContent ?? "";
      const language = [...code.classList]
        .find((className) => className.startsWith("language-"))
        ?.slice("language-".length);
      let highlighted: string;
      try {
        highlighted = await codeToHtml(source, {
          lang: (language || "text") as never,
          theme: theme === "dark" ? "github-dark" : "github-light",
        });
      } catch {
        highlighted = await codeToHtml(source, {
          lang: "text",
          theme: theme === "dark" ? "github-dark" : "github-light",
        });
      }
      const template = document.createElement("template");
      template.innerHTML = highlighted.trim();
      const replacement = template.content.firstElementChild;
      if (replacement instanceof HTMLElement) {
        replacement.classList.add("message-code", "message-code-highlighted");
        code.parentElement?.replaceWith(replacement);
      }
    }),
  );
}

async function enhanceMath(container: HTMLElement): Promise<void> {
  const [{ default: katex }] = await Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    if (node.parentElement?.closest("pre, code, .katex")) continue;
    if (containsMath(node.data)) textNodes.push(node);
  }
  textNodes.forEach((node) => {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of node.data.matchAll(/\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g)) {
      const index = match.index ?? 0;
      if (index > offset) fragment.append(node.data.slice(offset, index));
      const expression = match[1] ?? match[2] ?? "";
      const displayMode = match[1] !== undefined;
      const element = document.createElement(displayMode ? "div" : "span");
      element.className = displayMode ? "math-block" : "math-inline";
      element.innerHTML = katex.renderToString(expression, {
        displayMode,
        output: "html",
        strict: "ignore",
        throwOnError: false,
        trust: false,
      });
      fragment.append(element);
      offset = index + match[0].length;
    }
    if (offset < node.data.length) fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  });
}

function containsCodeFence(text: string): boolean {
  return /(^|\n)\s*(```|~~~)/.test(text);
}

function containsMath(text: string): boolean {
  return /\$\$[\s\S]+?\$\$|\$[^\n$]+?\$/.test(text);
}

function safeExternalUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function renderPlainText(value: string): string {
  return `<p class="message-paragraph">${escapeHtml(value).replaceAll("\n", "<br>")}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
