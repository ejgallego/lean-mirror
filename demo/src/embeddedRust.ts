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
  createVersoCommentAdapter,
  type EmbeddedBlockInlineCreateOptions,
  type EmbeddedBlock,
  type EmbeddedBlockInlineHandle,
} from "./embeddedBlocks.js";
import type { DemoSessionApi } from "./demoSession.js";

export interface EmbeddedRustBlock extends EmbeddedBlock {}

const baseRustAdapter = createVersoCommentAdapter<EmbeddedRustBlock>({
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
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticPullTimer: ReturnType<typeof setTimeout> | null = null;
  let diagnosticPullEpoch = 0;
  let syncingFromOuter = false;
  let latestCode = options.block.code;
  let latestDiagnostics = [] as Array<{
    message: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity?: number;
  }>;
  let lastDiagnosticStamp = "";
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
    options.outerView.requestMeasure();
  }

  async function requestDiagnostics(
    session: { documentUri: string },
    epoch: number,
    attempt = 0,
  ): Promise<void> {
    if (!client || destroyed || epoch !== diagnosticPullEpoch) {
      return;
    }
    client.sync();
    const report = await client.request<
      { textDocument: { uri: string } },
      { items?: typeof latestDiagnostics; kind: "full" | "unchanged" }
    >("textDocument/diagnostic", {
      textDocument: { uri: session.documentUri },
    });
    if (destroyed || epoch !== diagnosticPullEpoch || report.kind !== "full") {
      return;
    }
    const pulled = Array.isArray(report.items) ? report.items : [];
    if (pulled.length > 0) {
      latestDiagnostics = pulled;
      applyDiagnostics();
      const stamp = JSON.stringify(
        latestDiagnostics.map((diagnostic) => ({
          message: diagnostic.message,
          severity: diagnostic.severity,
        })),
      );
      if (stamp !== lastDiagnosticStamp) {
        options.log(`Rust diagnostics updated (${latestDiagnostics.length})`);
      }
      lastDiagnosticStamp = stamp;
      return;
    }
    if (attempt >= 3) {
      return;
    }
    diagnosticPullTimer = setTimeout(() => {
      diagnosticPullTimer = null;
      void requestDiagnostics(session, epoch, attempt + 1).catch(() => {});
    }, 250);
  }

  async function persistDocument(session: { documentUri: string }): Promise<void> {
    if (!client || destroyed) {
      return;
    }
    await sessionApi.updateRustDocument(options.block.key, latestCode);
    if (destroyed) {
      return;
    }
    options.log(`Saved ${options.block.title}`);
    client.sync();
    client.notification("textDocument/didSave", {
      textDocument: { uri: session.documentUri },
    });
    if (diagnosticPullTimer) {
      clearTimeout(diagnosticPullTimer);
    }
    const epoch = ++diagnosticPullEpoch;
    diagnosticPullTimer = setTimeout(() => {
      diagnosticPullTimer = null;
      void requestDiagnostics(session, epoch).catch(() => {});
    }, 250);
  }

  function schedulePersist(session: { documentUri: string }): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistDocument(session).catch((error) => {
        if (destroyed) {
          return;
        }
        options.log(
          error instanceof Error
            ? `Rust widget save failed: ${error.message}`
            : "Rust widget save failed.",
        );
      });
    }, 350);
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
            const stamp = JSON.stringify(
              latestDiagnostics.map((diagnostic) => ({
                message: diagnostic.message,
                severity: diagnostic.severity,
              })),
            );
            if (latestDiagnostics.length > 0 && stamp !== lastDiagnosticStamp) {
              options.log(`Rust diagnostics updated (${latestDiagnostics.length})`);
            }
            lastDiagnosticStamp = stamp;
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
              schedulePersist(session);
            }),
          ],
        }),
      });
      applyDiagnostics();
      status.remove();
      options.outerView.requestMeasure();
    } catch (error) {
      status.textContent =
        error instanceof Error ? `rust-analyzer failed: ${error.message}` : "rust-analyzer failed";
    }
  })();

  return {
    destroy() {
      destroyed = true;
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      if (diagnosticPullTimer) {
        clearTimeout(diagnosticPullTimer);
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
        schedulePersist(sessionInfo);
      }
      options.outerView.requestMeasure();
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
