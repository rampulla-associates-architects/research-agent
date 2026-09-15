import { Fragment, forwardRef, useImperativeHandle, useRef, type MouseEvent } from "react";
import { markdownToHtml } from "@/lib/markdown";

type ReportAddress = {
  subtitle?: string;
  title: string;
};

export type ReportController = {
  append: (heading: string, content: string) => void;
  getContent: () => string;
  getStatus: () => unknown;
  update: (update: unknown) => void;
};

type ReportEditorPanelReferenceProps = {
  address: ReportAddress;
};

const toolbarCommands = [
  { cmd: "bold", label: "B", title: "Bold" },
  { cmd: "italic", label: "I", title: "Italic" },
  { cmd: "insertUnorderedList", label: "•", title: "Bullet list" },
  { cmd: "insertOrderedList", label: "1.", title: "Numbered list" }
];

const formatCommands = ["H2", "H3", "P"];

export const ReportEditorPanelReference = forwardRef<ReportController, ReportEditorPanelReferenceProps>(({ address }, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    append(heading, content) {
      const editor = editorRef.current;
      if (editor) updateReportSection(editor, { heading, content, mode: "append" });
    },
    update(update) {
      const editor = editorRef.current;
      if (editor) updateReportSection(editor, getReportUpdate(update));
    },
    getContent() {
      const editor = editorRef.current;
      return editor ? reportEditorToMarkdown(editor).trim() : "";
    },
    getStatus() {
      const editor = editorRef.current;
      return editor ? getReportStatus(editor) : { outline: [], emptySections: [], duplicateSections: [] };
    }
  }));

  return (
    <Fragment>
      <div className="report-toolbar">
        {toolbarCommands.map(({ cmd, label, title }) => (
          <button className="report-toolbar-btn" key={cmd} type="button" title={title} onMouseDown={(event) => runEditorCommand(event, cmd)}>
            {label}
          </button>
        ))}
        {formatCommands.map((tag) => (
          <button className="report-toolbar-btn" key={tag} type="button" title={tag === "P" ? "Paragraph" : `Heading ${tag[1]}`} onMouseDown={(event) => runEditorCommand(event, "formatBlock", tag)}>
            {tag.toLowerCase()}
          </button>
        ))}
      </div>
      <div className="report-editor" contentEditable ref={editorRef} suppressContentEditableWarning>
        <h1>{address.title}</h1>
        {address.subtitle && <p className="report-subtitle">{address.subtitle}</p>}
      </div>
    </Fragment>
  );
});

ReportEditorPanelReference.displayName = "ReportEditorPanelReference";

const runEditorCommand = (event: MouseEvent<HTMLButtonElement>, cmd: string, value: string | null = null) => {
  event.preventDefault();
  document.execCommand(cmd, false, value);
};

const getReportUpdate = (update: unknown) => {
  return update && typeof update === "object" ? update as Record<string, unknown> : {};
};

function updateReportSection(editor: HTMLElement, { heading = "", content = "", mode = "", sectionIndex = null }: Record<string, unknown> = {}) {
  const cleanHeading = String(heading || "").trim();
  const cleanContent = String(content || "").trim();
  const resolvedMode = normalizeReportUpdateMode(mode, cleanHeading);

  if (!cleanHeading && !cleanContent) return;

  if (resolvedMode === "append" || !cleanHeading) {
    appendReportBlock(editor, cleanHeading, cleanContent);
    return;
  }

  const headingElement = findReportHeading(editor, cleanHeading, sectionIndex) || appendReportHeading(editor, cleanHeading);

  if (resolvedMode === "replace_section") {
    removeSectionBody(headingElement);
  }

  if (cleanContent) {
    insertSectionContent(headingElement, cleanContent);
  }

  editor.scrollTop = editor.scrollHeight;
}

function normalizeReportUpdateMode(mode: unknown, heading: string) {
  const value = String(mode || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (value === "append" || value === "append_to_section" || value === "replace_section") return value;
  return heading ? "replace_section" : "append";
}

function appendReportBlock(editor: HTMLElement, heading: string, content: string) {
  if (heading) appendReportHeading(editor, heading);
  if (content) {
    const div = document.createElement("div");
    div.innerHTML = markdownToHtml(content);
    editor.appendChild(div);
  }
  editor.scrollTop = editor.scrollHeight;
}

function appendReportHeading(editor: HTMLElement, heading: string) {
  const h = document.createElement("h2");
  h.textContent = heading;
  editor.appendChild(h);
  return h;
}

function findReportHeading(editor: HTMLElement, heading: string, sectionIndex: unknown) {
  const headings = Array.from(editor.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  if (Number.isInteger(sectionIndex) && headings[sectionIndex as number]) return headings[sectionIndex as number];
  return headings.find((item) => item.textContent?.trim().toLowerCase() === heading.toLowerCase()) || null;
}

function removeSectionBody(heading: Element) {
  const level = Number(heading.tagName.slice(1));
  let node = heading.nextElementSibling;
  while (node && !isSectionBoundary(node, level)) {
    const next = node.nextElementSibling;
    node.remove();
    node = next;
  }
}

function insertSectionContent(heading: Element, content: string) {
  const level = Number(heading.tagName.slice(1));
  const div = document.createElement("div");
  div.innerHTML = markdownToHtml(content);

  let boundary = heading.nextElementSibling;
  while (boundary && !isSectionBoundary(boundary, level)) {
    boundary = boundary.nextElementSibling;
  }

  if (boundary) {
    heading.parentElement?.insertBefore(div, boundary);
  } else {
    heading.parentElement?.appendChild(div);
  }
}

function getReportStatus(editor: HTMLElement) {
  const headings = Array.from(editor.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((heading, index) => {
    const level = Number(heading.tagName.slice(1));
    const title = heading.textContent?.trim() || "";
    const bodyParts: string[] = [];
    let node = heading.nextElementSibling;

    while (node && !isSectionBoundary(node, level)) {
      if (!/^H[1-6]$/.test(node.tagName)) {
        const text = reportNodeToMarkdown(node).trim();
        if (text) bodyParts.push(text);
      }
      node = node.nextElementSibling;
    }

    const bodyText = bodyParts.join("\n").trim();
    return {
      index,
      level,
      title,
      isEmpty: bodyText.length === 0,
      characterCount: bodyText.length,
      preview: bodyText.slice(0, 240)
    };
  });

  const titleCounts = headings.reduce<Record<string, number>>((counts, heading) => {
    const key = heading.title.toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  return {
    outline: headings.map((heading) => ({
      ...heading,
      isDuplicate: titleCounts[heading.title.toLowerCase()] > 1
    })),
    emptySections: headings.filter((heading) => heading.isEmpty).map((heading) => heading.title),
    duplicateSections: Object.entries(titleCounts)
      .filter(([, count]) => count > 1)
      .map(([title, count]) => ({ title, count }))
  };
}

function isSectionBoundary(node: Element, level: number) {
  const match = node.tagName?.match(/^H([1-6])$/);
  return Boolean(match && Number(match[1]) <= level);
}

function reportEditorToMarkdown(editor: HTMLElement) {
  return Array.from(editor.children)
    .map((node) => reportNodeToMarkdown(node).trim())
    .filter(Boolean)
    .join("\n\n");
}

function reportNodeToMarkdown(node: Node | null): string {
  if (!node) return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const element = node as HTMLElement;
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${reportInlineMarkdown(element).trim()}`;
  }
  if (tag === "p") return reportInlineMarkdown(element).trim();
  if (tag === "div" || tag === "section" || tag === "article") {
    return Array.from(element.childNodes)
      .map((child) => reportNodeToMarkdown(child).trim())
      .filter(Boolean)
      .join("\n\n") || reportInlineMarkdown(element).trim();
  }
  if (tag === "ul" || tag === "ol") return reportListToMarkdown(element, tag === "ol");
  if (tag === "blockquote") {
    return reportNodeChildrenToMarkdown(element)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (tag === "table") return reportTableToMarkdown(element);
  if (tag === "pre") return `\`\`\`\n${element.innerText.replace(/\n$/, "")}\n\`\`\``;
  if (tag === "hr") return "---";
  if (tag === "br") return "\n";
  return reportInlineMarkdown(element).trim();
}

function reportNodeChildrenToMarkdown(node: Node) {
  return Array.from(node.childNodes)
    .map((child) => reportNodeToMarkdown(child).trim())
    .filter(Boolean)
    .join("\n\n");
}

function reportInlineMarkdown(node: Node): string {
  return Array.from(node.childNodes).map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent || "";
    if (child.nodeType !== Node.ELEMENT_NODE) return "";

    const element = child as HTMLElement;
    const tag = element.tagName.toLowerCase();
    const text = reportInlineMarkdown(element);
    if (tag === "strong" || tag === "b") return `**${text}**`;
    if (tag === "em" || tag === "i") return `*${text}*`;
    if (tag === "del" || tag === "s") return `~~${text}~~`;
    if (tag === "code") return `\`${element.innerText}\``;
    if (tag === "br") return "\n";
    if (tag === "a") {
      const href = element.getAttribute("href") || "";
      return href ? `[${text || href}](${href})` : text;
    }
    if (tag === "img") {
      const alt = element.getAttribute("alt") || "";
      const src = element.getAttribute("src") || "";
      return src ? `![${alt}](${src})` : "";
    }
    return reportNodeToMarkdown(element) || text;
  }).join("").replace(/[ \t]+\n/g, "\n");
}

function reportListToMarkdown(list: Element, ordered: boolean) {
  return Array.from(list.children).map((item, index) => {
    const marker = ordered ? `${index + 1}.` : "-";
    const content = reportInlineMarkdown(item).trim();
    return `${marker} ${content}`;
  }).join("\n");
}

function reportTableToMarkdown(table: Element) {
  const rows = Array.from(table.querySelectorAll("tr")).map((row) =>
    Array.from(row.children).map((cell) => reportInlineMarkdown(cell).trim().replace(/\|/g, "\\|"))
  );
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
  const header = normalized[0];
  const body = normalized.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}
