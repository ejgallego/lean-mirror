import type { Extension } from "@codemirror/state";
import { EditorState } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { createWebSocketTransport } from "../../src/index.js";
import { leanUtilities } from "../../src/index.js";
import { EditorView } from "@codemirror/view";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import {
  createCommentFencedAdapter,
  type EmbeddedBlockInlineCreateOptions,
  type EmbeddedBlock,
  type EmbeddedBlockInlineHandle,
} from "./embeddedBlocks.js";
import type { DemoSessionApi } from "./demoSession.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

const baseRustAdapter = createCommentFencedAdapter<EmbeddedRustBlock>({
  defaultTitle(block) {
    return block.label ?? `Rust Block ${block.ordinal}`;
  },
  editorExtensions(): Extension[] {
    return [
      rust(),
      ...leanUtilities({
        activeLine: false,
        defaultKeymap: true,
        drawSelection: true,
        foldGutter: false,
        foldKeymap: false,
        history: true,
        historyKeymap: true,
        indentWithTab: true,
        lineNumbers: false,
        lineWrapping: true,
        search: false,
        searchKeymap: false,
      }),
    ];
  },
  kind: "rust",
});

function createRustInlineHandle(
  sessionApi: DemoSessionApi,
  options: EmbeddedBlockInlineCreateOptions<EmbeddedRustBlock>,
): EmbeddedBlockInlineHandle {
  const container = document.createElement("div");
  container.className = "cm-embedded-block-inline";
  const status = document.createElement("div");
  status.className = "cm-embedded-block-inline-status";
  status.textContent = "Connecting to rust-analyzer";
  container.append(status);

  let destroyed = false;
  let diagnosticsTimer: ReturnType<typeof setTimeout> | null = null;
  let latestDiagnosticResultId: string | undefined;
  let syncingFromOuter = false;
  let latestCode = options.block.code;
  let latestDiagnostics = [] as Array<{
    message: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
  }>;
  let nestedView: EditorView | null = null;
  let socket: WebSocket | null = null;
  let client: LSPClient | null = null;
  let sessionInfo: { documentUri: string } | null = null;

  function positionToOffset(
    doc: EditorState["doc"],
    position: { line: number; character: number },
  ): number {
    const line = doc.line(Math.max(1, Math.min(doc.lines, position.line + 1)));
    return Math.max(line.from, Math.min(line.to, line.from + position.character));
  }

  function severity(value?: number): Diagnostic["severity"] {
    return value === 1 ? "error" : value === 2 ? "warning" : value === 3 ? "info" : "hint";
  }

  function applyDiagnostics(): void {
    if (!nestedView) {
      return;
    }
    nestedView.dispatch(
      setDiagnostics(
        nestedView.state,
        latestDiagnostics.map((diagnostic) => ({
          from: positionToOffset(nestedView!.state.doc, diagnostic.range.start),
          message: diagnostic.message,
          severity: severity(diagnostic.severity),
          to: positionToOffset(nestedView!.state.doc, diagnostic.range.end),
        })),
      ),
    );
  }

  async function requestDiagnostics(session: {
    documentUri: string;
  }): Promise<void> {
    if (!client || destroyed) {
      return;
    }
    client.sync();
    const params: {
      previousResultId?: string;
      textDocument: { uri: string };
    } = {
      textDocument: { uri: session.documentUri },
    };
    if (latestDiagnosticResultId !== undefined) {
      params.previousResultId = latestDiagnosticResultId;
    }

    const report = await client.request<
      {
        previousResultId?: string;
        textDocument: { uri: string };
      },
      {
        items?: typeof latestDiagnostics;
        kind: "full" | "unchanged";
        resultId?: string;
      }
    >("textDocument/diagnostic", params);
    if (destroyed) {
      return;
    }
    if (report.kind === "full") {
      latestDiagnostics = Array.isArray(report.items) ? report.items : [];
      latestDiagnosticResultId = report.resultId;
      applyDiagnostics();
    } else if (report.kind === "unchanged") {
      latestDiagnosticResultId = report.resultId;
    }
  }

  function scheduleDiagnostics(session: { documentUri: string }): void {
    if (diagnosticsTimer) {
      clearTimeout(diagnosticsTimer);
    }
    diagnosticsTimer = setTimeout(() => {
      diagnosticsTimer = null;
      void requestDiagnostics(session).catch((error) => {
        if (!destroyed) {
          status.textContent =
            error instanceof Error
              ? `rust-analyzer diagnostics failed: ${error.message}`
              : "rust-analyzer diagnostics failed";
        }
      });
    }, 300);
  }

  void (async () => {
    try {
      const session = await sessionApi.createRustSession(options.block.key, latestCode);
      sessionInfo = session;
      if (destroyed) {
        return;
      }
      client = new LSPClient({
        extensions: languageServerExtensions(),
        notificationHandlers: {
          "textDocument/publishDiagnostics": (_client, params) => {
            if (params?.uri !== session.documentUri) {
              return false;
            }
            latestDiagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
            applyDiagnostics();
            return true;
          },
        },
        rootUri: session.rootUri,
      });
      socket = await sessionApi.connectWebSocket(session.websocketUrl);
      client.connect(createWebSocketTransport(socket));
      await client.initializing;
      if (destroyed) {
        return;
      }
      status.textContent = "rust-analyzer connected";
      nestedView = new EditorView({
        parent: container,
        state: EditorState.create({
          doc: latestCode,
          extensions: [
            ...baseRustAdapter.editorExtensions(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            client.plugin(session.documentUri, "rust"),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || syncingFromOuter) {
                return;
              }
              latestCode = update.state.doc.toString();
              options.syncOuter(latestCode);
              scheduleDiagnostics(session);
            }),
          ],
        }),
      });
      applyDiagnostics();
      status.remove();
      scheduleDiagnostics(session);
    } catch (error) {
      status.textContent =
        error instanceof Error ? `rust-analyzer failed: ${error.message}` : "rust-analyzer failed";
    }
  })();

  return {
    destroy() {
      destroyed = true;
      if (diagnosticsTimer) {
        clearTimeout(diagnosticsTimer);
      }
      nestedView?.destroy();
      client?.disconnect();
      socket?.close();
    },
    dom: container,
    sync(code: string) {
      latestCode = code;
      if (!nestedView || nestedView.state.doc.toString() === code) {
        return;
      }
      syncingFromOuter = true;
      try {
        nestedView.dispatch({
          changes: {
            from: 0,
            insert: code,
            to: nestedView.state.doc.length,
          },
        });
      } finally {
        syncingFromOuter = false;
      }
      if (sessionInfo) {
        scheduleDiagnostics(sessionInfo);
      }
    },
  };
}

export function createEmbeddedRustAdapter(
  sessionApi: DemoSessionApi,
) {
  return {
    ...baseRustAdapter,
    createInlineHandle(options: EmbeddedBlockInlineCreateOptions<EmbeddedRustBlock>) {
      return createRustInlineHandle(sessionApi, options);
    },
  };
}

export const parseEmbeddedRustBlocks = baseRustAdapter.parseBlocks;
export const serializeEmbeddedRustBlock = baseRustAdapter.serializeBlock;
