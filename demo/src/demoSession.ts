export interface DemoSession {
  rootUri: string;
  documentUri: string;
  documents: string[];
  initialDoc: string;
  websocketUrl: string;
}

export interface DemoSessionApi {
  connectWebSocket(url: string): Promise<WebSocket>;
  fetchDocument(uri: string): Promise<string>;
  fetchSession(): Promise<DemoSession>;
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
