function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitSourceLines(source) {
  const lines = [];
  let from = 0;
  while (from < source.length) {
    let to = from;
    while (to < source.length && source[to] !== "\n" && source[to] !== "\r") {
      to += 1;
    }
    let end = to;
    if (source[end] === "\r" && source[end + 1] === "\n") {
      end += 2;
    } else if (source[end] === "\r" || source[end] === "\n") {
      end += 1;
    }
    lines.push({ end, from, text: source.slice(from, to) });
    from = end;
  }
  return lines;
}

function parseLineComment(line, prefixes) {
  const ordered = [...prefixes].sort((left, right) => right.length - left.length);
  for (const prefix of ordered) {
    const match = new RegExp(`^(\\s*)${escapeRegExp(prefix)}(\\s?)(.*)$`).exec(line);
    if (match) {
      const indent = match[1] ?? "";
      const padding = match[2] ?? "";
      return {
        content: match[3] ?? "",
        contentOffset: indent.length + prefix.length + padding.length,
        indent,
        prefix,
      };
    }
  }
  return null;
}

function parseFenceHeader(content, kind) {
  if (!content.startsWith("```")) {
    return null;
  }
  const rest = content.slice(3);
  if (!rest.startsWith(kind)) {
    return null;
  }
  const suffix = rest.slice(kind.length);
  if (suffix.length > 0 && !/^[\s,]/.test(suffix)) {
    return null;
  }
  const trimmed = suffix.trim();
  if (trimmed.length === 0) {
    return { info: null, label: null };
  }
  if (trimmed.startsWith(",")) {
    const info = trimmed.slice(1).trim();
    return {
      info,
      label: info.length > 0 ? info.replace(/\s*,\s*/g, " ") : null,
    };
  }
  return { info: trimmed, label: trimmed };
}

function blockKey(kind, label, ordinal, seenKeys) {
  const base = label ? `${kind}:${label}` : `${kind}:${ordinal}`;
  const seen = seenKeys.get(base) ?? 0;
  seenKeys.set(base, seen + 1);
  return seen === 0 ? base : `${base}#${seen + 1}`;
}

export function parseLineCommentFencedBlocks(source, options) {
  const lines = splitSourceLines(source);
  const blocks = [];
  const seenKeys = new Map();
  let ordinal = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const parsed = parseLineComment(line.text, options.linePrefixes);
    if (!parsed) {
      continue;
    }
    const header = parseFenceHeader(parsed.content.trim(), options.kind);
    if (!header) {
      continue;
    }

    const codeLines = [];
    const codeLineStarts = [];
    for (let inner = index + 1; inner < lines.length; inner += 1) {
      const innerLine = lines[inner];
      if (!innerLine) {
        break;
      }
      const innerParsed = parseLineComment(innerLine.text, options.linePrefixes);
      if (!innerParsed) {
        break;
      }
      if (/^```\s*$/.test(innerParsed.content.trim())) {
        ordinal += 1;
        blocks.push({
          code: codeLines.join("\n"),
          codeLineStarts,
          from: line.from,
          indent: parsed.indent,
          info: header.info,
          key: blockKey(options.kind, header.label, ordinal, seenKeys),
          label: header.label,
          linePrefix: parsed.prefix,
          ordinal,
          sourceLine: index + 1,
          to: innerLine.end,
        });
        index = inner;
        break;
      }
      codeLineStarts.push(innerLine.from + innerParsed.contentOffset);
      codeLines.push(innerParsed.content);
    }
  }

  return blocks;
}

export function lineCommentFencedHostFingerprint(source, options) {
  const blocks = parseLineCommentFencedBlocks(source, options);
  if (blocks.length === 0) {
    return source;
  }
  let cursor = 0;
  const parts = [];
  for (const block of blocks) {
    parts.push(source.slice(cursor, block.from));
    cursor = block.to;
  }
  parts.push(source.slice(cursor));
  return parts.join("");
}
