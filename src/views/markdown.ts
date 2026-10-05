function findClosing(text: string, delimiter: string, from: number): number {
  const index = text.indexOf(delimiter, from);
  return index > from ? index : -1;
}

function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function appendInline(parent: HTMLElement, text: string, depth = 0) {
  if (depth > 8) {
    parent.append(document.createTextNode(text));
    return;
  }

  let plain = "";
  const flush = () => {
    if (plain) parent.append(document.createTextNode(plain));
    plain = "";
  };

  for (let i = 0; i < text.length;) {
    const delimiter = text.startsWith("**", i) ? "**"
      : text.startsWith("__", i) ? "__"
      : text.startsWith("~~", i) ? "~~"
      : text[i] === "`" ? "`"
      : text[i] === "*" && !text.startsWith("***", i) ? "*"
      : text[i] === "_" ? "_"
      : "";

    if (delimiter) {
      const close = findClosing(text, delimiter, i + delimiter.length);
      if (close >= 0 && !(delimiter === "*" && text[close + 1] === "*")) {
        flush();
        const content = text.slice(i + delimiter.length, close);
        if (delimiter === "`") {
          const code = document.createElement("code");
          code.textContent = content;
          parent.append(code);
        } else {
          const tag = delimiter === "**" || delimiter === "__" ? "strong"
            : delimiter === "~~" ? "del" : "em";
          const node = document.createElement(tag);
          appendInline(node, content, depth + 1);
          parent.append(node);
        }
        i = close + delimiter.length;
        continue;
      }
    }

    if (text[i] === "[") {
      const labelEnd = text.indexOf("](", i + 1);
      const linkEnd = labelEnd >= 0 ? text.indexOf(")", labelEnd + 2) : -1;
      const href = linkEnd >= 0 ? safeLink(text.slice(labelEnd + 2, linkEnd)) : null;
      if (labelEnd > i + 1 && linkEnd > labelEnd + 2 && href) {
        flush();
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        appendInline(link, text.slice(i + 1, labelEnd), depth + 1);
        parent.append(link);
        i = linkEnd + 1;
        continue;
      }
    }

    plain += text[i];
    i += 1;
  }

  flush();
}

export function appendMarkdown(parent: HTMLElement, markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: HTMLElement | null = null;
  let list: HTMLOListElement | HTMLUListElement | null = null;
  let codeLines: string[] | null = null;

  const flushParagraph = () => {
    paragraph = null;
  };
  const flushList = () => {
    list = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (codeLines) {
      if (/^\s*```/.test(line)) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.append(code);
        parent.append(pre);
        codeLines = null;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushBlocks();
      codeLines = [];
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const node = document.createElement(`h${heading[1].length}`);
      appendInline(node, heading[2]);
      parent.append(node);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushBlocks();
      const node = document.createElement("blockquote");
      appendInline(node, quote[1]);
      parent.append(node);
      continue;
    }

    const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (item) {
      flushParagraph();
      const ordered = /^\d/.test(item[1]);
      if (!list || (list.tagName === "OL") !== ordered) {
        flushList();
        list = document.createElement(ordered ? "ol" : "ul");
        parent.append(list);
      }
      const entry = document.createElement("li");
      appendInline(entry, item[2]);
      list.append(entry);
      continue;
    }

    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    flushList();
    if (!paragraph) {
      paragraph = document.createElement("p");
      parent.append(paragraph);
    } else {
      paragraph.append(document.createElement("br"));
    }
    appendInline(paragraph, line);
  }

  if (codeLines) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.append(code);
    parent.append(pre);
  }
}
