import { describe, expect, it, vi } from "vitest";

import { createClientRequestHandlingTransport } from "../src/lspProtocol.js";
import { waitFor } from "./support/helpers.js";
import { MockTransport } from "./support/mockTransport.js";

describe("server-to-client request errors", () => {
  it.each(["synchronous", "asynchronous"])("responds to a %s handler failure and keeps serving requests", async (kind) => {
    const error = new Error("request handler failed");
    const transport = new MockTransport();
    const onHandlerError = vi.fn();
    const forwarded = vi.fn();
    const succeed = vi.fn(() => "ready");
    const wrapped = createClientRequestHandlingTransport(transport, {
      fail() {
        if (kind === "asynchronous") return Promise.reject(error);
        throw error;
      },
      succeed,
    }, { onHandlerError });
    wrapped.subscribe(forwarded);

    try {
      expect(() => transport.emitRequest("fail", { token: null }, "failed-request")).not.toThrow();
      transport.emitRequest("succeed", {}, "next-request");
      expect(succeed).toHaveBeenCalledExactlyOnceWith({}, {
        jsonrpc: "2.0", id: "next-request", method: "succeed", params: {},
      });
      await waitFor(() => transport.sent.length === 2);

      expect(transport.sent).toContainEqual({
        jsonrpc: "2.0",
        id: "failed-request",
        error: { code: -32603, message: error.message },
      });
      expect(onHandlerError).toHaveBeenCalledExactlyOnceWith(error, {
        jsonrpc: "2.0", id: "failed-request", method: "fail", params: { token: null },
      });
      expect(transport.sent).toContainEqual({ jsonrpc: "2.0", id: "next-request", result: "ready" });
      expect(forwarded).not.toHaveBeenCalled();
    } finally {
      wrapped.unsubscribe(forwarded);
    }
  });
});
