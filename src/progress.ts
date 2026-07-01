import type { LSPClient, LSPClientExtension, Transport } from "@codemirror/lsp-client";
import type * as lsp from "vscode-languageserver-protocol";

import { createClientRequestHandlingTransport } from "./lspProtocol.js";

export const leanFileProgressMethod = "$/lean/fileProgress";

export const LeanFileProgressKind = {
  Processing: 1,
  FatalError: 2,
} as const;

export type LeanFileProgressKindValue =
  | (typeof LeanFileProgressKind)[keyof typeof LeanFileProgressKind]
  | (number & {});

export interface LeanFileProgressProcessingInfo {
  kind?: LeanFileProgressKindValue;
  range: lsp.Range;
}

export interface LeanFileProgressParams {
  processing: readonly LeanFileProgressProcessingInfo[];
  textDocument: lsp.VersionedTextDocumentIdentifier;
}

export interface LeanFileProgressDocumentState {
  hasFatalError: boolean;
  isProcessing: boolean;
  processing: readonly LeanFileProgressProcessingInfo[];
  textDocument: lsp.VersionedTextDocumentIdentifier;
  uri: string;
  version: number;
}

export interface LeanFileProgressUpdate {
  ignored: boolean;
  reason?: "stale";
  state: LeanFileProgressDocumentState | null;
  uri: string | null;
}

export interface LeanFileProgressTrackerOptions {
  acceptStaleVersions?: boolean;
  onUpdate?: (
    update: LeanFileProgressUpdate,
    params: LeanFileProgressParams,
    client: LSPClient,
  ) => void;
  store?: LeanFileProgressStore;
}

export interface LeanFileProgressExtension extends LSPClientExtension {
  clear(): void;
  onClientDisconnect(client: LSPClient): void;
  readonly store: LeanFileProgressStore;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isPosition(value: unknown): value is lsp.Position {
  return (
    isObject(value) &&
    typeof value.line === "number" &&
    typeof value.character === "number"
  );
}

function isRange(value: unknown): value is lsp.Range {
  return isObject(value) && isPosition(value.start) && isPosition(value.end);
}

function parseLeanFileProgressParams(value: unknown): LeanFileProgressParams | null {
  if (!isObject(value) || !isObject(value.textDocument) || !Array.isArray(value.processing)) {
    return null;
  }
  const uri = value.textDocument.uri;
  const version = value.textDocument.version;
  if (typeof uri !== "string" || typeof version !== "number") {
    return null;
  }
  const processing: LeanFileProgressProcessingInfo[] = [];
  for (const item of value.processing) {
    if (!isObject(item) || !isRange(item.range)) {
      return null;
    }
    if (item.kind !== undefined && typeof item.kind !== "number") {
      return null;
    }
    processing.push({
      range: item.range,
      ...(typeof item.kind === "number" ? { kind: item.kind as LeanFileProgressKindValue } : {}),
    });
  }
  return {
    processing,
    textDocument: {
      uri,
      version,
    },
  };
}

function hasFatalError(processing: readonly LeanFileProgressProcessingInfo[]): boolean {
  return processing.some((item) => item.kind === LeanFileProgressKind.FatalError);
}

export class LeanFileProgressStore {
  private readonly documents = new Map<string, LeanFileProgressDocumentState>();

  apply(
    params: LeanFileProgressParams,
    options: {
      acceptStaleVersions?: boolean;
      currentVersion?: number | null;
    } = {},
  ): LeanFileProgressUpdate {
    const uri = params.textDocument.uri;
    const version = params.textDocument.version;
    if (
      !options.acceptStaleVersions &&
      typeof options.currentVersion === "number" &&
      version < options.currentVersion
    ) {
      return {
        ignored: true,
        reason: "stale",
        state: this.get(uri),
        uri,
      };
    }

    if (params.processing.length === 0) {
      this.documents.delete(uri);
      return {
        ignored: false,
        state: null,
        uri,
      };
    }

    const state: LeanFileProgressDocumentState = {
      hasFatalError: hasFatalError(params.processing),
      isProcessing: true,
      processing: params.processing,
      textDocument: params.textDocument,
      uri,
      version,
    };
    this.documents.set(uri, state);
    return {
      ignored: false,
      state,
      uri,
    };
  }

  clear(uri?: string): void {
    if (uri === undefined) {
      this.documents.clear();
    } else {
      this.documents.delete(uri);
    }
  }

  get(uri: string): LeanFileProgressDocumentState | null {
    return this.documents.get(uri) ?? null;
  }

  entries(): readonly LeanFileProgressDocumentState[] {
    return [...this.documents.values()];
  }

  snapshot(): ReadonlyMap<string, LeanFileProgressDocumentState> {
    return new Map(this.documents);
  }
}

export function leanFileProgress(
  options: LeanFileProgressTrackerOptions = {},
): LeanFileProgressExtension {
  const store = options.store ?? new LeanFileProgressStore();
  const extension: LeanFileProgressExtension = {
    store,
    clear() {
      store.clear();
    },
    onClientDisconnect() {
      store.clear();
    },
    notificationHandlers: {
      [leanFileProgressMethod]: (client, rawParams: unknown) => {
        const params = parseLeanFileProgressParams(rawParams);
        if (!params) {
          return false;
        }
        const file = client.workspace.getFile(params.textDocument.uri);
        const applyOptions: {
          acceptStaleVersions?: boolean;
          currentVersion?: number | null;
        } = {};
        if (options.acceptStaleVersions !== undefined) {
          applyOptions.acceptStaleVersions = options.acceptStaleVersions;
        }
        if (file?.version !== undefined) {
          applyOptions.currentVersion = file.version;
        }
        const update = store.apply(params, applyOptions);
        if (!update.ignored) {
          options.onUpdate?.(update, params, client);
        }
        return true;
      },
    },
  };
  return extension;
}

type WorkDoneProgressToken = string | number;

export interface WorkDoneProgressState {
  cancellable?: boolean;
  message?: string;
  percentage?: number;
  title: string;
  token: WorkDoneProgressToken;
}

export interface WorkDoneProgressUpdate {
  kind: "create" | "begin" | "report" | "end";
  state: WorkDoneProgressState | null;
  token: WorkDoneProgressToken;
}

export interface WorkDoneProgressTrackerOptions {
  onUpdate?: (update: WorkDoneProgressUpdate) => void;
  store?: WorkDoneProgressStore;
}

export interface WorkDoneProgressExtension extends LSPClientExtension {
  clear(): void;
  onClientDisconnect(client: LSPClient): void;
  readonly store: WorkDoneProgressStore;
  wrapTransport(transport: Transport): Transport;
}

function isProgressToken(value: unknown): value is WorkDoneProgressToken {
  return typeof value === "string" || typeof value === "number";
}

function tokenTitle(token: WorkDoneProgressToken): string {
  const text = String(token);
  const rustAnalyzerPrefix = "rustAnalyzer/";
  if (text.startsWith(rustAnalyzerPrefix) && text.length > rustAnalyzerPrefix.length) {
    return text.slice(rustAnalyzerPrefix.length);
  }
  return text;
}

function isWorkDoneProgressValue(
  value: unknown,
): value is lsp.WorkDoneProgressBegin | lsp.WorkDoneProgressReport | lsp.WorkDoneProgressEnd {
  return (
    isObject(value) &&
    (value.kind === "begin" || value.kind === "report" || value.kind === "end")
  );
}

export class WorkDoneProgressStore {
  private readonly active = new Map<WorkDoneProgressToken, WorkDoneProgressState>();
  private readonly created = new Set<WorkDoneProgressToken>();

  create(token: WorkDoneProgressToken): WorkDoneProgressUpdate {
    this.created.add(token);
    return {
      kind: "create",
      state: this.get(token),
      token,
    };
  }

  apply(token: WorkDoneProgressToken, value: lsp.WorkDoneProgressBegin | lsp.WorkDoneProgressReport | lsp.WorkDoneProgressEnd): WorkDoneProgressUpdate {
    if (value.kind === "begin") {
      const state: WorkDoneProgressState = {
        title: value.title,
        token,
        ...(value.cancellable === undefined ? {} : { cancellable: value.cancellable }),
        ...(value.message === undefined ? {} : { message: value.message }),
        ...(value.percentage === undefined ? {} : { percentage: value.percentage }),
      };
      this.active.set(token, state);
      return {
        kind: "begin",
        state,
        token,
      };
    }

    if (value.kind === "report") {
      const previous = this.active.get(token);
      const state: WorkDoneProgressState = {
        title: previous?.title ?? tokenTitle(token),
        token,
        ...(previous?.cancellable === undefined ? {} : { cancellable: previous.cancellable }),
        ...(previous?.message === undefined ? {} : { message: previous.message }),
        ...(previous?.percentage === undefined ? {} : { percentage: previous.percentage }),
        ...(value.cancellable === undefined ? {} : { cancellable: value.cancellable }),
        ...(value.message === undefined ? {} : { message: value.message }),
        ...(value.percentage === undefined ? {} : { percentage: value.percentage }),
      };
      this.active.set(token, state);
      return {
        kind: "report",
        state,
        token,
      };
    }

    const previous = this.active.get(token);
    const state: WorkDoneProgressState = {
      title: previous?.title ?? tokenTitle(token),
      token,
      ...(previous?.cancellable === undefined ? {} : { cancellable: previous.cancellable }),
      ...(value.message === undefined ? previous?.message === undefined ? {} : { message: previous.message } : { message: value.message }),
      ...(previous?.percentage === undefined ? {} : { percentage: previous.percentage }),
    };
    this.active.delete(token);
    this.created.delete(token);
    return {
      kind: "end",
      state,
      token,
    };
  }

  clear(): void {
    this.active.clear();
    this.created.clear();
  }

  get(token: WorkDoneProgressToken): WorkDoneProgressState | null {
    return this.active.get(token) ?? null;
  }

  entries(): readonly WorkDoneProgressState[] {
    return [...this.active.values()];
  }

  hasCreatedToken(token: WorkDoneProgressToken): boolean {
    return this.created.has(token);
  }
}

export function workDoneProgress(
  options: WorkDoneProgressTrackerOptions = {},
): WorkDoneProgressExtension {
  const store = options.store ?? new WorkDoneProgressStore();
  const extension: WorkDoneProgressExtension = {
    store,
    clear() {
      store.clear();
    },
    onClientDisconnect() {
      store.clear();
    },
    clientCapabilities: {
      window: {
        workDoneProgress: true,
      },
    },
    notificationHandlers: {
      "$/progress": (_client, rawParams: unknown) => {
        if (!isObject(rawParams) || !isProgressToken(rawParams.token) || !isWorkDoneProgressValue(rawParams.value)) {
          return false;
        }
        const update = store.apply(rawParams.token, rawParams.value);
        options.onUpdate?.(update);
        return true;
      },
    },
    wrapTransport(transport) {
      return createClientRequestHandlingTransport(transport, {
        "window/workDoneProgress/create": (rawParams) => {
          if (!isObject(rawParams) || !isProgressToken(rawParams.token)) {
            throw new Error("Invalid window/workDoneProgress/create params.");
          }
          const update = store.create(rawParams.token);
          options.onUpdate?.(update);
          return null;
        },
      });
    },
  };
  return extension;
}
