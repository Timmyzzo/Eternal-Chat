import { Fragment, type ReactNode } from "react";

interface SafeMarkdownProps {
  text: string;
}

export function SafeMarkdown({ text }: SafeMarkdownProps) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const nodes: ReactNode[] = [];
  let code: string[] = [];
  let inCode = false;

  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      if (!inCode) {
        code = [];
        inCode = true;
      } else {
        nodes.push(
          <pre className="message-code" key={`code-${index}`}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        inCode = false;
      }
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (line.trim() === "") {
      nodes.push(<span aria-hidden="true" className="message-space" key={`space-${index}`} />);
      return;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading?.[2]) {
      nodes.push(
        <h3 className="message-heading" key={`heading-${index}`}>
          {inlineMarkdown(heading[2], index)}
        </h3>,
      );
      return;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet?.[1]) {
      nodes.push(
        <div className="message-list-item" key={`bullet-${index}`}>
          <span aria-hidden="true">•</span>
          <span>{inlineMarkdown(bullet[1], index)}</span>
        </div>,
      );
      return;
    }
    nodes.push(
      <p className="message-paragraph" key={`paragraph-${index}`}>
        {inlineMarkdown(line, index)}
      </p>,
    );
  });
  if (inCode) {
    nodes.push(
      <pre className="message-code" key="code-unclosed">
        <code>{code.join("\n")}</code>
      </pre>,
    );
  }

  return <div className="safe-markdown">{nodes}</div>;
}

function inlineMarkdown(text: string, lineIndex: number): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) {
      nodes.push(text.slice(offset, index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`${lineIndex}-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={`${lineIndex}-${index}`}>{token.slice(1, -1)}</code>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      nodes.push(
        link ? (
          <a href={link[2]} key={`${lineIndex}-${index}`} rel="noreferrer" target="_blank">
            {link[1]}
          </a>
        ) : (
          <Fragment key={`${lineIndex}-${index}`}>{token}</Fragment>
        ),
      );
    }
    offset = index + token.length;
  }
  if (offset < text.length) {
    nodes.push(text.slice(offset));
  }
  return nodes;
}
