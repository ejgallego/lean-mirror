import type { Transport } from "@codemirror/lsp-client";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequestMessage {
  id: JsonRpcId;
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

type JsonRpcResponseMessage =
  | {
      id: JsonRpcId;
      jsonrpc: "2.0";
      result: unknown;
    }
  | {
      error: {
        code: number;
        message: string;
      };
      id: JsonRpcId;
      jsonrpc: "2.0";
    };

export type ClientRequestHandler = (
  params: unknown,
  request: JsonRpcRequestMessage,
) => unknown | Promise<unknown>;

export interface ClientRequestHandlingTransportOptions {
  onHandlerError?: (error: unknown, request: JsonRpcRequestMessage) => void;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequestMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string" &&
    "id" in value
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createClientRequestHandlingTransport(
  transport: Transport,
  requestHandlers: Readonly<Record<string, ClientRequestHandler | undefined>>,
  options: ClientRequestHandlingTransportOptions = {},
): Transport {
  const subscribers = new Map<(message: string) => void, (message: string) => void>();

  function respond(message: JsonRpcResponseMessage): void {
    transport.send(JSON.stringify(message));
  }

  return {
    send(message) {
      transport.send(message);
    },
    subscribe(handler) {
      const wrapped = (message: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          handler(message);
          return;
        }

        if (!isJsonRpcRequest(parsed)) {
          handler(message);
          return;
        }

        const requestHandler = requestHandlers[parsed.method];
        if (!requestHandler) {
          handler(message);
          return;
        }

        void Promise.resolve(requestHandler(parsed.params, parsed)).then(
          (result) => {
            respond({
              jsonrpc: "2.0",
              id: parsed.id,
              result: result ?? null,
            });
          },
          (error: unknown) => {
            options.onHandlerError?.(error, parsed);
            respond({
              jsonrpc: "2.0",
              id: parsed.id,
              error: {
                code: -32603,
                message: errorMessage(error),
              },
            });
          },
        );
      };
      subscribers.set(handler, wrapped);
      transport.subscribe(wrapped);
    },
    unsubscribe(handler) {
      const wrapped = subscribers.get(handler);
      if (!wrapped) {
        return;
      }
      subscribers.delete(handler);
      transport.unsubscribe(wrapped);
    },
  };
}
