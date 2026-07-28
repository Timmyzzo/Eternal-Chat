import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
});

markdown.validateLink = (url) => safeExternalUrl(url) !== null;
markdown.renderer.rules.paragraph_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrJoin("class", "message-paragraph");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.heading_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrJoin("class", "message-heading");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index];
  const href = token?.attrGet("href");
  const safeUrl = safeExternalUrl(href ?? undefined);
  if (!token || !safeUrl) {
    return renderer.renderToken(tokens, index, options);
  }
  token.attrSet("href", safeUrl);
  token.attrSet("data-external-url", safeUrl);
  token.attrSet("rel", "noreferrer noopener");
  token.attrSet("target", "_blank");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index];
  const language = token?.info.trim().split(/\s+/, 1)[0] ?? "";
  const languageClass = language ? ` class="language-${escapeAttribute(language)}"` : "";
  return `<pre class="message-code"><code${languageClass}>${escapeHtml(token?.content ?? "")}</code></pre>`;
};

export function renderBaseMarkdown(text: string): string {
  return markdown.render(text);
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
