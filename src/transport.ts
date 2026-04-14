import type { Transport } from "@codemirror/lsp-client";

export type { Transport } from "@codemirror/lsp-client";

type MessageHandler = (message: string) => void;

function decodeMessage(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  throw new TypeError("Expected transport messages to be text or binary JSON payloads.");
}

export interface WebSocketLike {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface MessageEventLike {
  data: unknown;
}

export function createWebSocketTransport(socket: WebSocketLike): Transport {
  const handlers = new Map<MessageHandler, (event: MessageEventLike) => void>();
  return {
    send(message) {
      socket.send(message);
    },
    subscribe(handler) {
      const wrapped = (event: MessageEventLike) => {
        handler(decodeMessage(event.data));
      };
      handlers.set(handler, wrapped);
      socket.addEventListener("message", wrapped);
    },
    unsubscribe(handler) {
      const wrapped = handlers.get(handler);
      if (!wrapped) {
        return;
      }
      handlers.delete(handler);
      socket.removeEventListener("message", wrapped);
    },
  };
}

export interface MessagePortLike {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  start?(): void;
}

export function createMessagePortTransport(port: MessagePortLike): Transport {
  const handlers = new Map<MessageHandler, (event: MessageEventLike) => void>();
  return {
    send(message) {
      port.postMessage(message);
    },
    subscribe(handler) {
      const wrapped = (event: MessageEventLike) => {
        handler(decodeMessage(event.data));
      };
      handlers.set(handler, wrapped);
      port.addEventListener("message", wrapped);
      port.start?.();
    },
    unsubscribe(handler) {
      const wrapped = handlers.get(handler);
      if (!wrapped) {
        return;
      }
      handlers.delete(handler);
      port.removeEventListener("message", wrapped);
    },
  };
}
