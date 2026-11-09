export interface RustPreviewToken {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  tokenType: string;
}

/** Render Rosetta facts using text nodes; server-provided text is never HTML. */
export function renderRustPreview(
  container: HTMLElement,
  source: string,
  tokens: readonly RustPreviewToken[],
  hover: (position: { line: number; character: number }) => Promise<string | null>,
): void {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const offset = (position: { line: number; character: number }) => {
    const start = starts[position.line];
    if (start === undefined || position.character < 0) return null;
    const end = (starts[position.line + 1] ?? source.length + 1) - 1;
    return Math.min(end, start + position.character);
  };
  const code = document.createElement("code");
  const pre = document.createElement("pre");
  pre.className = "rosetta-rust-preview";
  pre.setAttribute("aria-label", "Rust code preview");
  let cursor = 0;
  for (const token of tokens) {
    const from = offset(token.range.start);
    const to = offset(token.range.end);
    if (from === null || to === null || from < cursor || to <= from) continue;
    code.append(document.createTextNode(source.slice(cursor, from)));
    const span = document.createElement("span");
    span.textContent = source.slice(from, to);
    span.dataset.rosettaToken = token.tokenType;
    let hoverEpoch = 0;
    span.addEventListener("mouseleave", () => { hoverEpoch++; });
    span.addEventListener("mouseenter", () => {
      const epoch = ++hoverEpoch;
      void (async () => {
        // An early hover can be empty while Rust's workspace loads. Retry only
        // while the pointer remains over this exact token in this preview.
        for (let attempt = 0; attempt < 12 && span.isConnected && epoch === hoverEpoch; attempt++) {
          const text = await hover(token.range.start);
          if (epoch !== hoverEpoch || !span.isConnected) return;
          if (text) { span.title = text; return; }
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      })();
    });
    code.append(span);
    cursor = to;
  }
  code.append(document.createTextNode(source.slice(cursor)));
  pre.append(code);
  container.replaceChildren(pre);
}
