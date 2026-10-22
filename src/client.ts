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
import { ConnectionTransport, clientLifetimeSignal, renewClientLifetime, retireClientOperations } from "./clientLifetime.js";
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
  private connectionTransport: ConnectionTransport | null = null;
  private outgoing: Transport | null = null;
  private readonly requestTimeout: number;
  private used = false;

  constructor(
    config: LSPClientConfig,
    private readonly transportExtensions: readonly LeanLspClientExtension[],
  ) {
    super(config);
    this.requestTimeout = config.timeout ?? 3000;
    const signal = renewClientLifetime(this);
    const upstreamInitializing = this.initializing;
    // Keep the upstream initialization resolver bound to this single connection.
    // The public promise also settles when retirement wins the response race.
    this.initializing = new Promise<null>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      void upstreamInitializing.then(() => {
        if (signal.aborted) {
          this.serverCapabilities = null;
          reject(signal.reason);
        } else resolve(null);
      }, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
  }

  override get connected(): boolean { return this.connectionTransport !== null; }

  override connect(transport: Transport): this {
    if (this.used || clientLifetimeSignal(this)?.aborted) {
      throw new Error("Lean LSP clients support one connection. Create a fresh client or use LeanEditorSession.reconnect().");
    }
    this.used = true;
    const owned = new ConnectionTransport(transport, this.requestTimeout);
    this.connectionTransport = owned;
    try {
      let wrapped: Transport = owned;
      for (const extension of this.transportExtensions) {
        wrapped = extension.wrapTransport?.(wrapped, this) ?? wrapped;
      }
      this.outgoing = wrapped;
      super.connect(wrapped);
    } catch (error) {
      this.disconnect();
      throw error;
    }
    return this;
  }

  override disconnect(): void {
    retireClientOperations(this);
    // Initialization may have no external waiter for a direct client.
    void this.initializing.catch(() => undefined);
    try {
      this.connectionTransport?.retire();
    } finally {
      this.connectionTransport = null;
      this.outgoing = null;
      this.serverCapabilities = null;
      // Upstream disconnect resets a mutable initialization resolver. A late
      // initialize continuation would resolve that new promise instead of its
      // original one. Single-use clients retain the original resolver and use
      // the public workspace hook plus the owned wire for teardown.
      this.workspace.disconnected();
    }
  }

  override request<Params, Result>(method: string, params: Params): Promise<Result> {
    const signal = clientLifetimeSignal(this)!;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Result>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      void super.request<Params, Result>(method, params).then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", aborted);
      });
    });
  }

  override notification(method: string, params: unknown): void {
    const outgoing = this.outgoing;
    if (!outgoing) return;
    const send = () => {
      if (this.outgoing === outgoing) outgoing.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    };
    // Final didClose notifications must be sent while teardown still owns the wire.
    if (this.serverCapabilities) send();
    else void this.initializing.then(send, () => undefined);
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
