import type { Extension } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import type { Highlighter } from "@lezer/highlight";

import { leanFallbackLanguageSupport } from "./language.js";
import { leanUtilities, type LeanUtilityOptions } from "./utilities.js";

export interface Lean4Config {
  client?: LSPClient | null;
  uri?: string;
  languageId?: string;
  utilities?: boolean | LeanUtilityOptions;
  extraExtensions?: readonly Extension[];
  highlightStyle?: Highlighter | false;
}

export function lean4(config: Lean4Config = {}): Extension[] {
  const extensions: Extension[] = [
    leanFallbackLanguageSupport(
      config.highlightStyle === undefined ? {} : { highlightStyle: config.highlightStyle },
    ),
  ];
  if (config.utilities) {
    extensions.push(
      ...leanUtilities(config.utilities === true ? undefined : config.utilities),
    );
  }
  if (config.extraExtensions) {
    extensions.push(...config.extraExtensions);
  }
  if (!config.client) {
    return extensions;
  }
  if (!config.uri) {
    throw new Error("lean4({ client }) requires a document URI.");
  }
  extensions.push(config.client.plugin(config.uri, config.languageId ?? "lean4"));
  return extensions;
}
