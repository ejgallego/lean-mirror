import { Compartment, type Extension } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import { ViewPlugin } from "@codemirror/view";
import type { Highlighter } from "@lezer/highlight";

import { leanFallbackLanguageSupport } from "./language.js";
import type { LeanEditorSession } from "./session.js";
import { leanUtilities, type LeanUtilityOptions } from "./utilities.js";

export interface Lean4Config {
  client?: LSPClient | null;
  session?: LeanEditorSession | null;
  uri?: string;
  languageId?: string;
  utilities?: boolean | LeanUtilityOptions;
  extraExtensions?: readonly Extension[];
  highlightStyle?: Highlighter | false;
}

export interface LeanEditorSessionBindingOptions {
  languageId?: string;
  session: LeanEditorSession;
  uri: string;
}

function readyClient(session: LeanEditorSession): LSPClient | null {
  return session.state.phase === "ready" ? session.client : null;
}

/**
 * Keep one editor view attached to the ready client generation of a session.
 * The surrounding CodeMirror state remains intact while the LSP plugin is
 * removed during disconnect and replaced after reconnection.
 */
export function leanEditorSessionBinding(
  options: LeanEditorSessionBindingOptions,
): Extension {
  const clientCompartment = new Compartment();
  const clientExtension = (client: LSPClient | null): Extension =>
    client ? client.plugin(options.uri, options.languageId ?? "lean4") : [];
  const initialClient = readyClient(options.session);

  const lifecycle = ViewPlugin.define((view) => {
    let client = initialClient;
    let destroyed = false;
    const updateClient = () => {
      const nextClient = readyClient(options.session);
      if (destroyed || nextClient === client) {
        return;
      }
      client = nextClient;
      view.dispatch({
        effects: clientCompartment.reconfigure(clientExtension(client)),
      });
    };
    const unsubscribe = options.session.subscribe(updateClient);
    // The extension may have been created before the view while the session
    // advanced to ready in between. Reconcile once after view construction.
    queueMicrotask(updateClient);
    return {
      destroy() {
        destroyed = true;
        unsubscribe();
      },
    };
  });

  return [clientCompartment.of(clientExtension(initialClient)), lifecycle];
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
  if (config.client && config.session) {
    throw new Error("lean4() accepts either a client or a session, not both.");
  }
  if (!config.client && !config.session) {
    return extensions;
  }
  if (!config.uri) {
    throw new Error("lean4() requires a document URI when a client or session is provided.");
  }
  if (config.session) {
    extensions.push(leanEditorSessionBinding({
      languageId: config.languageId ?? "lean4",
      session: config.session,
      uri: config.uri,
    }));
  } else if (config.client) {
    extensions.push(config.client.plugin(config.uri, config.languageId ?? "lean4"));
  }
  return extensions;
}
