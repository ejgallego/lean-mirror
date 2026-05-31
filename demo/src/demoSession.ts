import {
  DEMO_ENDPOINTS,
  documentEndpoint,
  parseDemoSession,
  parseDemoPreparationStatus,
  parseDocumentResponse,
  parseRustMainUpdateResult,
  parseRustSession,
  type DemoExample,
  type DemoPreparationStatus,
  type DemoSession,
  type RustMainUpdateRequest,
  type RustMainUpdateResult,
  type RustSession,
} from "../shared/demoProtocol.mjs";

export type {
  DemoExample,
  DemoSession,
  DemoPreparationStatus,
  RustMainUpdateResult,
  RustSession,
};
export type RustMainUpdatePayload = RustMainUpdateRequest;

export interface DemoSessionApi {
  connectWebSocket(url: string): Promise<WebSocket>;
  createRustSession(key: string, code: string): Promise<RustSession>;
  fetchDocument(uri: string): Promise<string>;
  fetchPreparationStatus(): Promise<DemoPreparationStatus>;
  fetchSession(): Promise<DemoSession>;
  regenerateRustMainDocument(payload: RustMainUpdatePayload): Promise<DemoSession>;
  switchExample(id: string): Promise<void>;
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
    async fetchPreparationStatus(): Promise<DemoPreparationStatus> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.status}`);
      if (!response.ok) {
        throw new Error(`Status request failed with ${response.status}`);
      }
      return parseDemoPreparationStatus(await response.json());
    },
    async switchExample(id: string): Promise<void> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.switchExample}`, {
        body: JSON.stringify({ id }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Example switch failed with ${response.status}`);
      }
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
    async regenerateRustMainDocument(payload: RustMainUpdatePayload): Promise<DemoSession> {
      const response = await fetch(`${apiBase}${DEMO_ENDPOINTS.regenerateRustMain}`, {
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Rust main regeneration failed with ${response.status}`);
      }
      return parseDemoSession(await response.json());
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
