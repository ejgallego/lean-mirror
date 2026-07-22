import { highlightingFor } from "@codemirror/language";
import type { Text } from "@codemirror/state";
import type {
  LSPClient,
  LSPClientExtension,
  Transport,
} from "@codemirror/lsp-client";
import { LSPPlugin } from "@codemirror/lsp-client";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  logException,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags, type Tag } from "@lezer/highlight";
import type * as lsp from "vscode-languageserver-protocol";

import { createClientRequestHandlingTransport } from "./lspProtocol.js";

export const leanSemanticTokensFullMethod = "textDocument/semanticTokens/full";
export const leanSemanticTokensRefreshMethod = "workspace/semanticTokens/refresh";

const supportedTokenTypes = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
  "leanSorryLike",
] as const;

const supportedTokenModifiers = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
] as const;

export interface LeanSemanticToken {
  readonly character: number;
  readonly from: number;
  readonly length: number;
  readonly line: number;
  readonly modifierBits: number;
  readonly modifiers: readonly string[];
  readonly to: number;
  readonly tokenType: string;
  readonly tokenTypeIndex: number;
}

export interface LeanSemanticTokensErrorContext {
  readonly client: LSPClient;
  readonly uri: string;
}

export interface LeanSemanticTokensOptions {
  /** Delay after edits and server refresh requests. Defaults to 100ms. */
  debounceMs?: number;
  /** Add host-selected classes to a token decoration. */
  className?: (token: LeanSemanticToken) => string | null | undefined;
  onError?: (error: unknown, context: LeanSemanticTokensErrorContext) => void;
}

export interface LeanSemanticTokensExtension extends LSPClientExtension {
  clear(): void;
  onSessionDisconnect(client: LSPClient): void;
  refresh(): void;
  wrapTransport(transport: Transport, client: LSPClient): Transport;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function decodeLeanSemanticTokens(
  doc: Text,
  data: readonly number[],
  legend: lsp.SemanticTokensLegend,
): readonly LeanSemanticToken[] {
  if (data.length % 5 !== 0) {
    throw new TypeError("Semantic token data must contain five integers per token.");
  }

  const tokens: LeanSemanticToken[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = nonNegativeInteger(data[index]!, "Semantic token delta line");
    const deltaStart = nonNegativeInteger(data[index + 1]!, "Semantic token delta start");
    const length = nonNegativeInteger(data[index + 2]!, "Semantic token length");
    const tokenTypeIndex = nonNegativeInteger(data[index + 3]!, "Semantic token type");
    const modifierBits = nonNegativeInteger(data[index + 4]!, "Semantic token modifiers");

    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    if (line >= doc.lines) {
      throw new RangeError(`Semantic token line ${line} exceeds the document.`);
    }
    const documentLine = doc.line(line + 1);
    if (character > documentLine.length || character + length > documentLine.length) {
      throw new RangeError(
        `Semantic token range ${line}:${character}+${length} exceeds its line.`,
      );
    }
    if (length === 0) {
      continue;
    }

    const modifiers = legend.tokenModifiers.filter(
      (_modifier, modifierIndex) =>
        modifierIndex < 31 && (modifierBits & (1 << modifierIndex)) !== 0,
    );
    tokens.push({
      character,
      from: documentLine.from + character,
      length,
      line,
      modifierBits,
      modifiers,
      to: documentLine.from + character + length,
      tokenType: legend.tokenTypes[tokenTypeIndex] ?? `unknown-${tokenTypeIndex}`,
      tokenTypeIndex,
    });
  }
  return tokens;
}

function tokenTag(tokenType: string): Tag {
  switch (tokenType) {
    case "keyword": return tags.keyword;
    case "variable":
    case "parameter": return tags.variableName;
    case "property":
    case "enumMember":
    case "event": return tags.propertyName;
    case "function": return tags.function(tags.variableName);
    case "method": return tags.function(tags.propertyName);
    case "namespace": return tags.namespace;
    case "class": return tags.className;
    case "type":
    case "enum":
    case "interface":
    case "struct":
    case "typeParameter": return tags.typeName;
    case "macro": return tags.macroName;
    case "modifier": return tags.modifier;
    case "comment": return tags.comment;
    case "string": return tags.string;
    case "number": return tags.number;
    case "regexp": return tags.regexp;
    case "operator": return tags.operator;
    case "decorator": return tags.annotation;
    case "leanSorryLike": return tags.invalid;
    default: return tags.name;
  }
}

function tokenTags(token: LeanSemanticToken): readonly Tag[] {
  const base = tokenTag(token.tokenType);
  const result: Tag[] = [base];
  for (const modifier of token.modifiers) {
    switch (modifier) {
      case "declaration":
      case "definition":
        result.push(tags.definition(base));
        break;
      case "readonly":
      case "static":
        result.push(tags.constant(base));
        break;
      case "defaultLibrary":
        result.push(tags.standard(base));
        break;
      case "deprecated":
        result.push(tags.strikethrough);
        break;
    }
  }
  return result;
}

function cssName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase() || "unknown";
}

function tokenClasses(
  view: EditorView,
  token: LeanSemanticToken,
  options: LeanSemanticTokensOptions,
): string {
  const classes = [
    "cm-lean-semantic-token",
    `cm-lean-semantic-${cssName(token.tokenType)}`,
    ...token.modifiers.map((modifier) => `cm-lean-semantic-${cssName(modifier)}`),
  ];
  const highlighted = highlightingFor(view.state, tokenTags(token));
  if (highlighted) {
    classes.push(...highlighted.split(/\s+/u));
  }
  const custom = options.className?.(token);
  if (custom) {
    classes.push(...custom.split(/\s+/u));
  }
  return [...new Set(classes.filter(Boolean))].join(" ");
}

function tokenDecorations(
  view: EditorView,
  tokens: readonly LeanSemanticToken[],
  options: LeanSemanticTokensOptions,
): DecorationSet {
  return Decoration.set(
    tokens.map((token) =>
      Decoration.mark({
        attributes: { "data-lean-semantic-token": token.tokenType },
        class: tokenClasses(view, token, options),
      }).range(token.from, token.to),
    ),
    true,
  );
}

function semanticTokensProvider(client: LSPClient): lsp.SemanticTokensOptions | null {
  const provider = client.serverCapabilities?.semanticTokensProvider;
  if (
    !provider ||
    typeof provider !== "object" ||
    !provider.full ||
    !provider.legend ||
    !Array.isArray(provider.legend.tokenTypes) ||
    !Array.isArray(provider.legend.tokenModifiers)
  ) {
    return null;
  }
  return provider;
}

function semanticTokenData(response: unknown): readonly number[] | null {
  if (response === null) {
    return null;
  }
  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray((response as { data?: unknown }).data)
  ) {
    throw new TypeError("Invalid semantic token response.");
  }
  return (response as { data: number[] }).data;
}

class LeanSemanticTokensRenderer {
  decorations: DecorationSet = Decoration.none;
  private destroyed = false;
  private pendingClient: LSPClient | null = null;
  private pendingParams: lsp.SemanticTokensParams | null = null;
  private requestSerial = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly view: EditorView,
    private readonly options: LeanSemanticTokensOptions,
    private readonly unregister: (renderer: LeanSemanticTokensRenderer) => void,
  ) {
    this.schedule(0);
  }

  get client(): LSPClient | null {
    return LSPPlugin.get(this.view)?.client ?? null;
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) {
      return;
    }
    this.decorations = this.decorations.map(update.changes);
    this.schedule();
  }

  refresh(): void {
    this.schedule();
  }

  clear(): void {
    this.cancelPendingRequest();
    this.requestSerial += 1;
    if (this.decorations.size === 0 || this.destroyed) {
      return;
    }
    this.decorations = Decoration.none;
    this.view.dispatch({});
  }

  disconnect(client: LSPClient): void {
    if (this.client === client || this.pendingClient === client) {
      this.clear();
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.cancelPendingRequest();
    this.requestSerial += 1;
    this.unregister(this);
  }

  private schedule(delay = this.options.debounceMs ?? 100): void {
    if (this.destroyed) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.requestTokens();
    }, Math.max(0, delay));
  }

  private cancelPendingRequest(): void {
    if (this.pendingClient && this.pendingParams) {
      this.pendingClient.cancelRequest(this.pendingParams);
    }
    this.pendingClient = null;
    this.pendingParams = null;
  }

  private async requestTokens(): Promise<void> {
    const plugin = LSPPlugin.get(this.view);
    if (!plugin) {
      return;
    }
    const client = plugin.client;
    const serial = ++this.requestSerial;
    this.cancelPendingRequest();

    try {
      await client.initializing;
      if (
        this.destroyed ||
        serial !== this.requestSerial ||
        LSPPlugin.get(this.view)?.client !== client
      ) {
        return;
      }
      const provider = semanticTokensProvider(client);
      if (!provider) {
        this.clear();
        return;
      }

      client.sync();
      const uri = plugin.uri;
      const doc = this.view.state.doc;
      const version = client.workspace.getFile(uri)?.version ?? null;
      // LSPClient.notification() sends through initializing.then(), even after
      // initialization has resolved. Let didChange reach the transport before
      // the semantic-token request that depends on it.
      await Promise.resolve();
      if (
        this.destroyed ||
        serial !== this.requestSerial ||
        LSPPlugin.get(this.view)?.client !== client ||
        !this.view.state.doc.eq(doc) ||
        (client.workspace.getFile(uri)?.version ?? null) !== version
      ) {
        return;
      }
      const params: lsp.SemanticTokensParams = {
        textDocument: { uri },
      };
      this.pendingClient = client;
      this.pendingParams = params;
      const response = await client.request<lsp.SemanticTokensParams, lsp.SemanticTokens | null>(
        leanSemanticTokensFullMethod,
        params,
      );
      if (this.pendingParams === params) {
        this.pendingClient = null;
        this.pendingParams = null;
      }
      if (
        this.destroyed ||
        serial !== this.requestSerial ||
        LSPPlugin.get(this.view)?.client !== client ||
        !this.view.state.doc.eq(doc) ||
        (client.workspace.getFile(uri)?.version ?? null) !== version
      ) {
        return;
      }

      const data = semanticTokenData(response);
      const tokens = data === null
        ? []
        : decodeLeanSemanticTokens(doc, data, provider.legend);
      this.decorations = tokenDecorations(this.view, tokens, this.options);
      this.view.dispatch({});
    } catch (error) {
      if (this.pendingClient === client) {
        this.pendingClient = null;
        this.pendingParams = null;
      }
      if (this.destroyed || serial !== this.requestSerial) {
        return;
      }
      if (this.options.onError) {
        this.options.onError(error, { client, uri: plugin.uri });
      } else {
        logException(this.view.state, error, "requesting Lean semantic tokens");
      }
    }
  }
}

export function leanSemanticTokens(
  options: LeanSemanticTokensOptions = {},
): LeanSemanticTokensExtension {
  const renderers = new Set<LeanSemanticTokensRenderer>();
  const editorExtension = ViewPlugin.define(
    (view) => {
      const renderer = new LeanSemanticTokensRenderer(
        view,
        options,
        (current) => renderers.delete(current),
      );
      renderers.add(renderer);
      return renderer;
    },
    {
      decorations: (renderer) => renderer.decorations,
    },
  );

  return {
    clear() {
      for (const renderer of [...renderers]) {
        renderer.clear();
      }
    },
    onSessionDisconnect(client) {
      for (const renderer of [...renderers]) {
        renderer.disconnect(client);
      }
    },
    refresh() {
      for (const renderer of [...renderers]) {
        renderer.refresh();
      }
    },
    wrapTransport(transport, client) {
      return createClientRequestHandlingTransport(transport, {
        [leanSemanticTokensRefreshMethod]: () => {
          for (const renderer of [...renderers]) {
            if (renderer.client === client) {
              renderer.refresh();
            }
          }
          return null;
        },
      });
    },
    clientCapabilities: {
      textDocument: {
        semanticTokens: {
          augmentsSyntaxTokens: true,
          dynamicRegistration: false,
          formats: ["relative"],
          multilineTokenSupport: false,
          overlappingTokenSupport: false,
          requests: { full: true },
          tokenModifiers: [...supportedTokenModifiers],
          tokenTypes: [...supportedTokenTypes],
        },
      },
      workspace: {
        semanticTokens: {
          refreshSupport: true,
        },
      },
    },
    editorExtension,
  };
}
