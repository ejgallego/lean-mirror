import { diagnosticCount } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Definition,
  RenameParams,
  TextDocumentPositionParams,
  WorkspaceEdit,
} from "vscode-languageserver-protocol";

import {
  applyLeanWorkspaceEdit,
  createLeanLspClient,
  createLeanWorkspace,
  lean4,
  leanJumpToDefinition,
  type LeanServerDocumentLease,
  type LeanWorkspace,
} from "../src/index.js";
import {
  closeReferencePanel,
  findReferences,
} from "../src/codemirror.js";
import { createTestView, waitFor } from "./support/helpers.js";

interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
}

class StdioTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly subscribers = new Set<(message: string) => void>();
  private buffer = Buffer.alloc(0);
  private stderr = "";
  readonly sent: RpcMessage[] = [];
  readonly received: RpcMessage[] = [];

  constructor(command: string, args: string[], cwd?: string) {
    const leanPath = cwd === undefined
      ? undefined
      : [cwd, process.env.LEAN_PATH].filter((entry) => !!entry).join(delimiter);
    const leanSrcPath = cwd === undefined
      ? undefined
      : [cwd, process.env.LEAN_SRC_PATH].filter((entry) => !!entry).join(delimiter);
    this.process = spawn(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      ...(leanPath === undefined
        ? {}
        : {
            env: {
              ...process.env,
              LEAN_PATH: leanPath,
              LEAN_SRC_PATH: leanSrcPath,
            },
          }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  send(message: string): void {
    this.sent.push(JSON.parse(message) as RpcMessage);
    const payload = Buffer.from(message, "utf8");
    this.process.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.process.stdin.write(payload);
  }

  subscribe(handler: (value: string) => void): void {
    this.subscribers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.subscribers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.process.once("exit", () => resolve());
    });
    this.process.kill();
    await exited;
  }

  notifications(method: string, uri?: string): RpcMessage[] {
    return this.sent.filter((message) => {
      if (message.id !== undefined || message.method !== method) {
        return false;
      }
      if (uri === undefined) {
        return true;
      }
      const params = message.params as {
        textDocument?: { uri?: string };
      } | undefined;
      return params?.textDocument?.uri === uri;
    });
  }

  serverNotifications(method: string, uri?: string): RpcMessage[] {
    return this.received.filter((message) => {
      if (message.id !== undefined || message.method !== method) {
        return false;
      }
      if (uri === undefined) {
        return true;
      }
      const params = message.params as {
        uri?: string;
        textDocument?: { uri?: string };
      } | undefined;
      return params?.uri === uri || params?.textDocument?.uri === uri;
    });
  }

  private flush(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Missing Content-Length header: ${header}`);
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) {
        return;
      }
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.received.push(JSON.parse(body) as RpcMessage);
      for (const subscriber of this.subscribers) {
        subscriber(body);
      }
    }
  }

  errorContext(): string {
    return this.stderr.trim();
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

const elanLean = spawnSync("elan", ["which", "lean"], { encoding: "utf8" });
const leanExecutable =
  elanLean.status === 0 && elanLean.stdout.trim() ? elanLean.stdout.trim() : "lean";
const leanAvailable =
  spawnSync(leanExecutable, ["--version"], { stdio: "ignore" }).status === 0;
const smokeTest = leanAvailable ? it : it.skip;

describe("real Lean server", () => {
  smokeTest(
    "opens a Lean file, receives diagnostics and semantic tokens, and answers hover requests",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "cm-lean4-"));
      const filePath = join(workspace, "Smoke.lean");
      const source = "#check Nat.succ\n#check MissingLeanName\n";
      await writeFile(filePath, source, "utf8");

      const uri = pathToFileURL(filePath).toString();
      const rootUri = pathToFileURL(workspace).toString();
      const transport = new StdioTransport(leanExecutable, ["--server"]);
      const client = createLeanLspClient({
        features: { semanticTokens: { debounceMs: 0 } },
        rootUri,
      });
      client.connect(transport);

      const view = createTestView(source, lean4({ client, uri }));
      await client.initializing;
      await waitFor(() => diagnosticCount(view.state) > 0, 15_000, 50);
      await waitFor(
        () => view.dom.querySelector("[data-lean-semantic-token]") !== null,
        15_000,
        50,
      );

      const plugin = LSPPlugin.get(view);
      expect(plugin).not.toBeNull();

      client.sync();
      const hover = await client.request<
        {
          textDocument: { uri: string };
          position: { line: number; character: number };
        },
        { contents: unknown } | null
      >("textDocument/hover", {
        textDocument: { uri },
        position: plugin!.toPosition(source.indexOf("Nat") + 1),
      });

      expect(hover).not.toBeNull();

      view.destroy();
      client.disconnect();
      await transport.close();
      await rm(workspace, { force: true, recursive: true });
    },
    30_000,
  );

  smokeTest(
    "navigates, references, renames, synchronizes, and reopens across Lean files",
    async () => {
      const workspacePath = await mkdtemp(join(tmpdir(), "cm-lean4-workspace-"));
      const helperPath = join(workspacePath, "Helper.lean");
      const mainPath = join(workspacePath, "Main.lean");
      const helperSource = [
        "def crossFileValue : Nat := 41",
        "def stableValue : Nat := 1",
        "",
      ].join("\n");
      const mainSource = [
        "import Helper",
        "",
        "def answer : Nat := crossFileValue + stableValue",
        "#check answer",
        "",
      ].join("\n");
      await Promise.all([
        writeFile(helperPath, helperSource, "utf8"),
        writeFile(mainPath, mainSource, "utf8"),
      ]);
      const initialBuild = spawnSync(
        leanExecutable,
        ["-o", "Helper.olean", "-i", "Helper.ilean", "Helper.lean"],
        { cwd: workspacePath, encoding: "utf8" },
      );
      expect(initialBuild.status, initialBuild.stderr).toBe(0);

      const helperUri = pathToFileURL(helperPath).toString();
      const mainUri = pathToFileURL(mainPath).toString();
      const rootUri = pathToFileURL(workspacePath).toString();
      const views = new Map<string, ReturnType<typeof createTestView>>();
      const transport = new StdioTransport(
        leanExecutable,
        ["--server"],
        workspacePath,
      );
      let client: ReturnType<typeof createLeanLspClient> | null = null;
      let helperLease: LeanServerDocumentLease | null = null;

      try {
        client = createLeanLspClient({
          rootUri,
          timeout: 15_000,
          workspace: createLeanWorkspace({
            async loadDocument(uri) {
              try {
                return await readFile(fileURLToPath(uri), "utf8");
              } catch {
                return null;
              }
            },
            displayDocument(uri, workspace) {
              const existing = views.get(uri);
              if (existing) {
                return existing;
              }
              const file = workspace.getFile(uri);
              if (!file || !client) {
                return null;
              }
              const opened = createTestView(
                file.doc.toString(),
                lean4({ client, uri }),
              );
              views.set(uri, opened);
              return opened;
            },
          }),
        });
        client.connect(transport);
        const mainView = createTestView(mainSource, lean4({ client, uri: mainUri }));
        views.set(mainUri, mainView);

        await client.initializing;
        helperLease = await (client.workspace as LeanWorkspace)
          .acquireServerDocument(helperUri);
        expect(helperLease).not.toBeNull();
        await waitFor(
          () => transport.notifications("textDocument/didOpen", helperUri).length === 1,
          15_000,
          50,
        );
        const leanWorkspace = client.workspace as LeanWorkspace;
        await Promise.all([
          client.request<{ uri: string; version: number }, Record<string, never>>(
            "textDocument/waitForDiagnostics",
            { uri: mainUri, version: leanWorkspace.getFile(mainUri)!.version },
          ),
          client.request<{ uri: string; version: number }, Record<string, never>>(
            "textDocument/waitForDiagnostics",
            { uri: helperUri, version: helperLease!.file.version },
          ),
        ]);

        const mainPlugin = LSPPlugin.get(mainView);
        expect(mainPlugin).not.toBeNull();
        const useOffset = mainView.state.doc.toString().indexOf("crossFileValue");
        mainView.dispatch({ selection: { anchor: useOffset + 2 } });

        const definition = await client.request<
          TextDocumentPositionParams,
          Definition | null
        >("textDocument/definition", {
          textDocument: { uri: mainUri },
          position: mainPlugin!.toPosition(useOffset + 2),
        });
        const definitionUris = (Array.isArray(definition) ? definition : [definition])
          .filter((location) => location !== null)
          .map((location) => (
            "targetUri" in location! ? location.targetUri : location!.uri
          ));
        expect(
          definitionUris,
          JSON.stringify({
            definition,
            position: mainPlugin!.toPosition(useOffset + 2),
            diagnostics: transport.serverNotifications(
              "textDocument/publishDiagnostics",
              mainUri,
            ),
          }),
        ).toContain(helperUri);

        expect(leanJumpToDefinition(mainView)).toBe(true);
        await waitFor(() => views.has(helperUri), 15_000, 50);
        const displayedHelper = views.get(helperUri)!;
        expect(displayedHelper.state.doc.toString()).toContain("crossFileValue");
        expect(displayedHelper.state.selection.main.head).toBeGreaterThanOrEqual(4);

        expect(findReferences(mainView)).toBe(true);
        await waitFor(
          () => mainView.dom.querySelectorAll(".cm-lsp-reference").length >= 2,
          15_000,
          50,
        );
        expect(mainView.dom.querySelector(".cm-lsp-reference-panel")?.textContent)
          .toContain("crossFileValue");
        closeReferencePanel(mainView);

        client.sync();
        const mapping = client.workspaceMapping();
        let rename: WorkspaceEdit | null;
        try {
          rename = await client.request<RenameParams, WorkspaceEdit | null>(
            "textDocument/rename",
            {
              textDocument: { uri: mainUri },
              position: mainPlugin!.toPosition(useOffset + 2),
              newName: "renamedValue",
            },
          );
          expect(rename).not.toBeNull();
          const applied = await applyLeanWorkspaceEdit(client, rename!, {
            mapping,
            userEvent: "rename",
          });
          expect(applied.applied, applied.failureReason).toBe(true);
          expect(new Set(applied.changedUris)).toEqual(
            new Set([mainUri, helperUri]),
          );
        } finally {
          mapping.destroy();
        }

        expect(mainView.state.doc.toString()).toContain(
          "renamedValue + stableValue",
        );
        expect(displayedHelper.state.doc.toString()).toContain(
          "def renamedValue : Nat := 41",
        );
        await Promise.all([
          writeFile(mainPath, mainView.state.doc.toString(), "utf8"),
          writeFile(helperPath, displayedHelper.state.doc.toString(), "utf8"),
        ]);
        const rebuiltHelper = spawnSync(
          leanExecutable,
          ["-o", "Helper.olean", "-i", "Helper.ilean", "Helper.lean"],
          { cwd: workspacePath, encoding: "utf8" },
        );
        expect(rebuiltHelper.status, rebuiltHelper.stderr).toBe(0);
        await waitFor(
          () =>
            transport.notifications("textDocument/didChange", mainUri).length >= 1 &&
            transport.notifications("textDocument/didChange", helperUri).length >= 1,
          15_000,
          50,
        );

        views.delete(helperUri);
        displayedHelper.destroy();
        expect(
          transport.notifications("textDocument/didClose", helperUri),
        ).toHaveLength(0);
        helperLease!.release();
        helperLease = null;
        await waitFor(
          () => transport.notifications("textDocument/didClose", helperUri).length === 1,
          15_000,
          50,
        );
        expect(
          await (client.workspace as LeanWorkspace).unloadDocument(helperUri),
        ).toBe("unloaded");

        await client.request<
          { uri: string; version: number },
          Record<string, never>
        >("textDocument/waitForDiagnostics", {
          uri: mainUri,
          version: (client.workspace as LeanWorkspace).getFile(mainUri)!.version,
        });
        const stableOffset = mainView.state.doc.toString().indexOf("stableValue");
        mainView.dispatch({ selection: { anchor: stableOffset + 2 } });
        const reopenedDefinition = await client.request<
          TextDocumentPositionParams,
          Definition | null
        >("textDocument/definition", {
          textDocument: { uri: mainUri },
          position: mainPlugin!.toPosition(stableOffset + 2),
        });
        const reopenedDefinitionUris = (
          Array.isArray(reopenedDefinition)
            ? reopenedDefinition
            : [reopenedDefinition]
        )
          .filter((location) => location !== null)
          .map((location) => (
            "targetUri" in location! ? location.targetUri : location!.uri
          ));
        expect(
          reopenedDefinitionUris,
          JSON.stringify({
            reopenedDefinition,
            diagnostics: transport.serverNotifications(
              "textDocument/publishDiagnostics",
              mainUri,
            ),
          }),
        ).toContain(helperUri);
        expect(leanJumpToDefinition(mainView)).toBe(true);
        await waitFor(
          () =>
            views.has(helperUri) &&
            transport.notifications("textDocument/didOpen", helperUri).length === 2,
          15_000,
          50,
        );
        expect(views.get(helperUri)?.state.doc.toString()).toContain(
          "def renamedValue : Nat := 41",
        );
      } catch (error) {
        const context = transport.errorContext();
        if (context && error instanceof Error) {
          error.message += `\nlean --server stderr:\n${context}`;
        }
        throw error;
      } finally {
        helperLease?.release();
        for (const view of views.values()) {
          view.destroy();
        }
        client?.disconnect();
        await transport.close();
        await rm(workspacePath, { force: true, recursive: true });
      }
    },
    60_000,
  );
});
