export interface DemoSession {
  rootUri: string;
  documentUri: string;
  documentLanguageIds?: Record<string, string>;
  documents: string[];
  embeddedLeanDocumentUri?: string;
  initialDoc: string;
  rustMainDocumentUri?: string;
  rustMainWebsocketUrl?: string;
  websocketUrl: string;
}

export interface RustSession {
  documentUri: string;
  rootUri: string;
  websocketUrl: string;
}

export interface DemoSessionApi {
  connectWebSocket(url: string): Promise<WebSocket>;
  createRustSession(key: string, code: string): Promise<RustSession>;
  fetchDocument(uri: string): Promise<string>;
  fetchSession(): Promise<DemoSession>;
  updateRustDocument(key: string, code: string, version?: number): Promise<void>;
  updateRustMainDocument(payload: RustMainUpdatePayload): Promise<RustMainUpdateResult>;
}

export interface RustMainUpdatePayload {
  code: string;
  leanDocument: string;
  revision: number;
  uri: string;
}

export interface RustMainUpdateResult {
  leanDocumentUri: string;
  revision: number;
  stale?: boolean;
}

export function createDemoSessionApi(apiBase: string): DemoSessionApi {
  return {
    async fetchSession(): Promise<DemoSession> {
      const response = await fetch(`${apiBase}/session`);
      if (!response.ok) {
        throw new Error(`Session request failed with ${response.status}`);
      }
      return response.json() as Promise<DemoSession>;
    },
    async fetchDocument(uri: string): Promise<string> {
      const response = await fetch(`${apiBase}/document?uri=${encodeURIComponent(uri)}`);
      if (!response.ok) {
        throw new Error(`Document request failed with ${response.status}`);
      }
      const payload = (await response.json()) as { text: string };
      return payload.text;
    },
    async createRustSession(key: string, code: string): Promise<RustSession> {
      const response = await fetch(`${apiBase}/rust-session`, {
        body: JSON.stringify({ code, key }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Rust session request failed with ${response.status}`);
      }
      return response.json() as Promise<RustSession>;
    },
    async updateRustDocument(key: string, code: string, version?: number): Promise<void> {
      const response = await fetch(`${apiBase}/rust-document`, {
        body: JSON.stringify({ code, key, version }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Rust document update failed with ${response.status}`);
      }
    },
    async updateRustMainDocument(payload: RustMainUpdatePayload): Promise<RustMainUpdateResult> {
      const response = await fetch(`${apiBase}/rust-main`, {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Rust main update failed with ${response.status}`);
      }
      return response.json() as Promise<RustMainUpdateResult>;
    },
    async connectWebSocket(url: string): Promise<WebSocket> {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener(
          "error",
          () => reject(new Error("WebSocket connection failed.")),
          { once: true },
        );
      });
      return socket;
    },
  };
}
