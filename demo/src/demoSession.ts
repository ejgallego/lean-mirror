export interface DemoSession {
  rootUri: string;
  documentUri: string;
  documents: string[];
  initialDoc: string;
  websocketUrl: string;
}

export interface RustSession {
  documentUri: string;
  rootUri: string;
  websocketUrl: string;
}

export interface DemoSessionApi {
  connectWebSocket(url: string): Promise<WebSocket>;
  fetchDocument(uri: string): Promise<string>;
  fetchSession(): Promise<DemoSession>;
  createRustSession(key: string, code: string): Promise<RustSession>;
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
