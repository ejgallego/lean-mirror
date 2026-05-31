import type { Transport } from "@codemirror/lsp-client";

type RequestHandler = (params: unknown, message: RpcMessage) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown, message: RpcMessage) => void | Promise<void>;

type RpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export class MockTransport implements Transport {
  private subscribers = new Set<(message: string) => void>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();

  readonly sent: RpcMessage[] = [];

  send(message: string): void {
    const parsed = JSON.parse(message) as RpcMessage;
    this.sent.push(parsed);
    void this.dispatch(parsed);
  }

  subscribe(handler: (value: string) => void): void {
    this.subscribers.add(handler);
  }

  unsubscribe(handler: (value: string) => void): void {
    this.subscribers.delete(handler);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  requests(method: string): RpcMessage[] {
    return this.sent.filter((message) => message.method === method && message.id != null);
  }

  notifications(method: string): RpcMessage[] {
    return this.sent.filter((message) => message.method === method && message.id == null);
  }

  emitNotification(method: string, params?: unknown): void {
    this.emit({ jsonrpc: "2.0", method, params });
  }

  emitRequest(method: string, params?: unknown, id: number | string = this.sent.length + 1): void {
    this.emit({ jsonrpc: "2.0", id, method, params });
  }

  private emit(message: RpcMessage): void {
    const encoded = JSON.stringify(message);
    for (const subscriber of this.subscribers) {
      subscriber(encoded);
    }
  }

  private async dispatch(message: RpcMessage): Promise<void> {
    if (message.method && message.id != null) {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        return;
      }
      try {
        const result = await handler(message.params, message);
        this.emit({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.emit({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    if (message.method) {
      await this.notificationHandlers.get(message.method)?.(message.params, message);
    }
  }
}
