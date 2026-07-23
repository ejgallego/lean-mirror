import type { Extension } from "@codemirror/state";
import {
  LSPClient,
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  type LSPClientConfig,
  type LSPClientExtension,
  type Transport,
} from "@codemirror/lsp-client";
import type { Language } from "@codemirror/language";
import { keymap } from "@codemirror/view";

import { leanFallbackLanguage } from "./language.js";
import { leanJumpToDefinitionKeymap } from "./navigation.js";
import { leanRenameKeymap } from "./rename.js";
import {
  leanSemanticTokens,
  type LeanSemanticTokensOptions,
} from "./semanticTokens.js";

export interface LeanLspClientExtension extends LSPClientExtension {
  wrapTransport?(transport: Transport, client: LSPClient): Transport;
}

export interface LeanLspFeatureOptions {
  completion?: boolean | Parameters<typeof serverCompletion>[0];
  diagnostics?: boolean;
  hover?: boolean | Parameters<typeof hoverTooltips>[0];
  signatureHelp?: boolean | Parameters<typeof signatureHelp>[0];
  /** Opt in when the connected server implements textDocument/formatting. */
  formatKeymap?: boolean;
  renameKeymap?: boolean;
  definitionKeymap?: boolean;
  referencesKeymap?: boolean;
  semanticTokens?: boolean | LeanSemanticTokensOptions;
}

export interface LeanLspClientConfig extends Omit<LSPClientConfig, "extensions" | "highlightLanguage"> {
  extensions?: readonly (Extension | LeanLspClientExtension)[];
  features?: LeanLspFeatureOptions;
  highlightLanguage?: LSPClientConfig["highlightLanguage"];
}

function optionEnabled<T extends object>(
  option: boolean | T | undefined,
): option is T {
  return typeof option === "object";
}

export function leanLspExtensions(
  options: LeanLspFeatureOptions = {},
): readonly (Extension | LeanLspClientExtension)[] {
  const extensions: (Extension | LeanLspClientExtension)[] = [];

  if (options.diagnostics !== false) {
    extensions.push(serverDiagnostics());
  }
  if (options.completion !== false) {
    extensions.push(serverCompletion(optionEnabled(options.completion) ? options.completion : undefined));
  }
  if (options.hover !== false) {
    extensions.push(hoverTooltips(optionEnabled(options.hover) ? options.hover : undefined));
  }
  if (options.signatureHelp !== false) {
    extensions.push(signatureHelp(optionEnabled(options.signatureHelp) ? options.signatureHelp : undefined));
  }
  if (options.formatKeymap === true) {
    extensions.push(keymap.of(formatKeymap));
  }
  if (options.renameKeymap !== false) {
    extensions.push(keymap.of(leanRenameKeymap));
  }
  if (options.definitionKeymap !== false) {
    extensions.push(keymap.of(leanJumpToDefinitionKeymap));
  }
  if (options.referencesKeymap !== false) {
    extensions.push(keymap.of(findReferencesKeymap));
  }
  if (options.semanticTokens) {
    extensions.push(
      leanSemanticTokens(
        optionEnabled(options.semanticTokens) ? options.semanticTokens : undefined,
      ),
    );
  }

  return extensions;
}

function hasTransportWrapper(
  extension: Extension | LeanLspClientExtension,
): extension is LeanLspClientExtension & Required<Pick<LeanLspClientExtension, "wrapTransport">> {
  return (
    !!extension &&
    typeof extension === "object" &&
    !Array.isArray(extension) &&
    typeof (extension as LeanLspClientExtension).wrapTransport === "function"
  );
}

class TransportWrappingLspClient extends LSPClient {
  constructor(
    config: LSPClientConfig,
    private readonly transportExtensions: readonly LeanLspClientExtension[],
  ) {
    super(config);
  }

  override connect(transport: Transport): this {
    let wrapped = transport;
    for (const extension of this.transportExtensions) {
      wrapped = extension.wrapTransport?.(wrapped, this) ?? wrapped;
    }
    super.connect(wrapped);
    return this;
  }
}

function defaultHighlightLanguage(
  custom?: LSPClientConfig["highlightLanguage"],
): (name: string) => Language | null {
  return (name) => {
    const normalized = name.trim().toLowerCase();
    const overridden = custom?.(name);
    if (overridden) {
      return overridden;
    }
    if (normalized === "lean" || normalized === "lean4") {
      return leanFallbackLanguage;
    }
    return null;
  };
}

export function createLeanLspClient(config: LeanLspClientConfig = {}): LSPClient {
  const { extensions = [], features, highlightLanguage, ...rest } = config;
  const highlight = defaultHighlightLanguage(highlightLanguage);
  const configuredExtensions = [...extensions, ...leanLspExtensions(features)];
  const transportExtensions = configuredExtensions.filter(hasTransportWrapper);
  return new TransportWrappingLspClient({
    ...rest,
    extensions: configuredExtensions,
    highlightLanguage: highlight,
  }, transportExtensions);
}
