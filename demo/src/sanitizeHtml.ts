const allowedElements = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const blockedElements = new Set([
  "embed",
  "iframe",
  "math",
  "object",
  "script",
  "style",
  "svg",
  "template",
]);

function safeLink(value: string): boolean {
  const trimmed = value.trim();
  if (/^(?:#|\/|\.\/|\.\.\/)/u.test(trimmed)) {
    return true;
  }
  try {
    const protocol = new URL(trimmed, "https://lsp.invalid/").protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function sanitizeElement(element: Element): void {
  const name = element.localName.toLowerCase();
  if (blockedElements.has(name)) {
    element.remove();
    return;
  }

  for (const child of [...element.children]) {
    sanitizeElement(child);
  }

  if (!allowedElements.has(name)) {
    element.replaceWith(...element.childNodes);
    return;
  }

  for (const attribute of [...element.attributes]) {
    const allowed =
      (name === "a" && (attribute.name === "href" || attribute.name === "title")) ||
      ((name === "code" || name === "pre" || name === "span") && attribute.name === "class");
    if (!allowed || (attribute.name === "href" && !safeLink(attribute.value))) {
      element.removeAttribute(attribute.name);
    }
  }
}

export function sanitizeHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of [...template.content.children]) {
    sanitizeElement(element);
  }
  return template.innerHTML;
}
