import type { Extension } from "@codemirror/state";
import {
  LSPClient,
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  languageServerExtensions,
  renameKeymap,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
  type LSPClientConfig,
  type LSPClientExtension,
} from "@codemirror/lsp-client";
import type { Language } from "@codemirror/language";
import { keymap } from "@codemirror/view";

import { leanFallbackLanguage } from "./language.js";

export interface LeanLspFeatureOptions {
  completion?: boolean | Parameters<typeof serverCompletion>[0];
  diagnostics?: boolean;
  hover?: boolean | Parameters<typeof hoverTooltips>[0];
  signatureHelp?: boolean | Parameters<typeof signatureHelp>[0];
  formatKeymap?: boolean;
  renameKeymap?: boolean;
  definitionKeymap?: boolean;
  referencesKeymap?: boolean;
}

export interface LeanLspClientConfig extends Omit<LSPClientConfig, "extensions" | "highlightLanguage"> {
  extensions?: readonly (Extension | LSPClientExtension)[];
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
): readonly (Extension | LSPClientExtension)[] {
  if (Object.keys(options).length === 0) {
    return languageServerExtensions();
  }

  const extensions: (Extension | LSPClientExtension)[] = [];

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
  if (options.formatKeymap !== false) {
    extensions.push(keymap.of(formatKeymap));
  }
  if (options.renameKeymap !== false) {
    extensions.push(keymap.of(renameKeymap));
  }
  if (options.definitionKeymap !== false) {
    extensions.push(keymap.of(jumpToDefinitionKeymap));
  }
  if (options.referencesKeymap !== false) {
    extensions.push(keymap.of(findReferencesKeymap));
  }

  return extensions;
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
  return new LSPClient({
    ...rest,
    extensions: configuredExtensions,
    highlightLanguage: highlight,
  });
}
