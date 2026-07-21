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
  readyState?: number;
  send(data: string): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface WebSocketLifecycleLike {
  readonly readyState: number;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

export interface MessageEventLike {
  data: unknown;
}

export function createWebSocketTransport(socket: WebSocketLike): Transport {
  const handlers = new Map<MessageHandler, (event: MessageEventLike) => void>();
  return {
    send(message) {
      if (socket.readyState === 0) {
        throw new Error(`Cannot send an LSP message while WebSocket readyState is ${socket.readyState}.`);
      }
      if (socket.readyState === 2 || socket.readyState === 3) {
        return;
      }
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

export function waitForWebSocketOpen(socket: WebSocketLifecycleLike): Promise<void> {
  if (socket.readyState === 1) {
    return Promise.resolve();
  }
  if (socket.readyState !== 0) {
    return Promise.reject(
      new Error(`Cannot open WebSocket because readyState is ${socket.readyState}.`),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleError);
    };
    const finish = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action();
    };
    const handleOpen = () => {
      finish(resolve);
    };
    const handleClose = () => {
      finish(() => reject(new Error("WebSocket closed before it opened.")));
    };
    const handleError = () => {
      finish(() => reject(new Error("WebSocket failed before it opened.")));
    };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("close", handleClose);
    socket.addEventListener("error", handleError);

    if (socket.readyState === 1) {
      handleOpen();
    } else if (socket.readyState !== 0) {
      handleClose();
    }
  });
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
