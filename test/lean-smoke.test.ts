import { diagnosticCount } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { createLeanLspClient, lean4 } from "../src/index.js";
import { createTestView, waitFor } from "./support/helpers.js";

class StdioTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly subscribers = new Set<(message: string) => void>();
  private buffer = Buffer.alloc(0);

  constructor(command: string, args: string[]) {
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
  }

  send(message: string): void {
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
    this.process.kill();
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
      for (const subscriber of this.subscribers) {
        subscriber(body);
      }
    }
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

const leanAvailable = spawnSync("lean", ["--version"], { stdio: "ignore" }).status === 0;
const smokeTest = leanAvailable ? it : it.skip;

describe("real Lean server", () => {
  smokeTest(
    "opens a Lean file, receives diagnostics, and answers hover requests",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "cm-lean4-"));
      const filePath = join(workspace, "Smoke.lean");
      const source = "#check Nat.succ\n#check MissingLeanName\n";
      await writeFile(filePath, source, "utf8");

      const uri = pathToFileURL(filePath).toString();
      const rootUri = pathToFileURL(workspace).toString();
      const transport = new StdioTransport("lean", ["--server"]);
      const client = createLeanLspClient({ rootUri });
      client.connect(transport);

      const view = createTestView(source, lean4({ client, uri }));
      await client.initializing;
      await waitFor(() => diagnosticCount(view.state) > 0, 15_000, 50);

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
});
