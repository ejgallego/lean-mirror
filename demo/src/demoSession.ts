import {
  DEMO_ENDPOINTS,
  documentEndpoint,
  parseDemoSession,
  parseDocumentResponse,
  parseRustMainUpdateResult,
  parseRustSession,
  type DemoSession,
  type RustMainUpdateRequest,
  type RustMainUpdateResult,
  type RustSession,
} from "../shared/demoProtocol.mjs";

export type { DemoSession, RustMainUpdateRequest as RustMainUpdatePayload, RustMainUpdateResult, RustSession };

export interface DemoSessionApi {
  connectWebSocket(url: string): Promise<WebSocket>;
  createRustSession(key: string, code: string): Promise<RustSession>;
  fetchDocument(uri: string): Promise<string>;
  fetchSession(): Promise<DemoSession>;
  updateRustDocument(key: string, code: string, version?: number): Promise<void>;
  updateRustMainDocument(payload: RustMainUpdateRequest): Promise<RustMainUpdateResult>;
}

export function createDemoSessionApi(apiBase: string): DemoSessionApi {
  return {
    async fetchSession(): Promise<DemoSession> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.session}`);
      if (!response.ok) {
        throw new Error(`Session request failed with ${response.status}`);
      }
      return parseDemoSession(await response.json());
    },
    async fetchDocument(uri: string): Promise<string> {
      const response = await fetch(documentEndpoint(apiBase, uri));
      if (!response.ok) {
        throw new Error(`Document request failed with ${response.status}`);
      }
      const payload = parseDocumentResponse(await response.json());
      return payload.text;
    },
    async createRustSession(key: string, code: string): Promise<RustSession> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.rustSession}`, {
        body: JSON.stringify({ code, key }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Rust session request failed with ${response.status}`);
      }
      return parseRustSession(await response.json());
    },
    async updateRustDocument(key: string, code: string, version?: number): Promise<void> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.rustDocument}`, {
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
    async updateRustMainDocument(payload: RustMainUpdateRequest): Promise<RustMainUpdateResult> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.rustMain}`, {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(`Rust main update failed with ${response.status}`);
      }
      return parseRustMainUpdateResult(await response.json());
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
