const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export const defaultIgnorableClosePatterns = [
  /Watchdog error: Cannot read LSP (?:message|notification): Stream was closed/,
  /client exited without proper shutdown sequence/,
  /called `Result::unwrap\(\)` on an `Err` value: "SendError\(\.\.\)"/,
  /thread 'Worker\d+' panicked at .*rust-analyzer.*reload\.rs/,
];

export function createLspProcessState() {
  return { expectedClose: false, initialized: false, shutdownSent: false };
}

export function encodeLspFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

export function forwardLspFrames(stream, onMessage, {
  maxHeaderBytes = 8192,
  maxFrameBytes = 8 * 1024 * 1024,
  onError = () => stream.destroy(),
} = {}) {
  let buffer = Buffer.alloc(0);
  let stopped = false;
  function dispose() {
    stopped = true;
    buffer = Buffer.alloc(0);
    stream.off("data", data);
    stream.off("end", end);
  }
  function fail(message) {
    dispose();
    onError(new Error(message));
  }
  function end() {
    if (buffer.length) fail("Incomplete LSP frame at end of stream.");
    else dispose();
  }
  function data(chunk) {
    if (stopped) return;
    // A pipe chunk can contain any number of individually valid frames. Bound
    // the retained partial frame, not the aggregate chunk before parsing it.
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length ? Buffer.concat([buffer, incoming]) : incoming;
    while (!stopped) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer.length > maxHeaderBytes) fail("LSP header exceeds the header limit.");
        return;
      }
      if (headerEnd > maxHeaderBytes) { fail("LSP header exceeds the header limit."); return; }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const matches = [...header.matchAll(/^Content-Length:[ \t]*(\d+)[ \t]*$/gim)];
      if (matches.length !== 1) { fail("Malformed or duplicate LSP Content-Length header."); return; }
      const length = Number(matches[0][1]);
      if (!Number.isSafeInteger(length) || length <= 0 || length > maxFrameBytes) {
        fail("LSP Content-Length exceeds the frame limit or is invalid."); return;
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        buffer = Buffer.from(buffer); // Do not retain a large coalesced chunk.
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      try { onMessage(body); }
      catch (error) { dispose(); onError(error); }
    }
  }
  stream.on("data", data);
  stream.on("end", end);
  return { dispose };
}

export function pipeServerStderr(
  stream,
  {
    ignoredPatterns = defaultIgnorableClosePatterns,
    onLine = (line) => console.error(line),
    shouldSkipFollowingLines = defaultShouldSkipFollowingLines,
    maxLineLength = 16_384,
  } = {},
) {
  let buffer = "";
  let skipBlock = false;
  let droppingLine = false;

  function emit(line) {
    const text = line.replace(/\r$/, "");
    if (skipBlock) {
      if (text.trim().length === 0) {
        skipBlock = false;
      }
      return;
    }
    if (ignoredPatterns.some((pattern) => pattern.test(text))) {
      skipBlock = shouldSkipFollowingLines(text);
      return;
    }
    if (text.trim().length === 0) {
      return;
    }
    onLine(text);
  }

  stream.on("data", (chunk) => {
    const parts = chunk.toString("utf8").split("\n");
    for (let index = 0; index < parts.length; index++) {
      const complete = index < parts.length - 1;
      if (!droppingLine) {
        buffer += parts[index].slice(0, maxLineLength + 1 - buffer.length);
        if (buffer.length > maxLineLength) {
          emit(buffer.slice(0, maxLineLength) + " [truncated]");
          buffer = "";
          droppingLine = true;
        } else if (complete) {
          emit(buffer);
          buffer = "";
        }
      }
      if (complete) droppingLine = false;
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      emit(buffer);
      buffer = "";
    }
  });
}

export function writeLspFrame(stream, payload) {
  stream.write(encodeLspFrame(payload));
}

export function normalizeClientLspPayload(payload) {
  try {
    const message = JSON.parse(payload.toString("utf8"));
    if (
      message &&
      typeof message === "object" &&
      message.method === "$/cancelRequest" &&
      "params" in message &&
      (message.params === null || typeof message.params !== "object")
    ) {
      return Buffer.from(
        JSON.stringify({
          ...message,
          params: { id: message.params },
        }),
        "utf8",
      );
    }
  } catch {}
  return payload;
}

export function noteClientLspMessage(state, payload) {
  try {
    const message = JSON.parse(payload.toString("utf8"));
    if (message && typeof message === "object" && message.method === "initialized") {
      state.initialized = true;
    }
  } catch {}
}

export function requestGracefulShutdown(
  child,
  state,
  { exitDelayMs = 25 } = {},
) {
  if (state.shutdownSent || child.killed || !state.initialized) {
    return;
  }
  state.shutdownSent = true;
  try {
    writeLspFrame(child.stdin, {
      jsonrpc: "2.0",
      id: 1_000_000,
      method: "shutdown",
      params: null,
    });
    setTimeout(() => {
      if (child.killed) {
        return;
      }
      try {
        writeLspFrame(child.stdin, {
          jsonrpc: "2.0",
          method: "exit",
          params: null,
        });
        child.stdin.end();
      } catch {}
    }, exitDelayMs);
  } catch {}
}

export function attachLspProcess(socket, child, {
  killDelayMs = 120,
  killEscalationMs = 500,
  shutdownExitDelayMs = 25,
  maxQueuedBytes = 8 * 1024 * 1024,
  maxHeaderBytes = 8192,
  maxFrameBytes = 8 * 1024 * 1024,
  onError = (error) => console.error("[demo] LSP session failed:", error.message),
  state = createLspProcessState(),
} = {}) {
  let shuttingDown = false;
  let exited = false;
  let blocked = false;
  let incomingBytes = 0;
  let outgoingBytes = 0;
  let sending = false;
  let terminateTimer;
  let killTimer;
  const incoming = [];
  const outgoing = [];

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    state.expectedClose = true;
    parser.dispose();
    incoming.length = outgoing.length = 0;
    incomingBytes = outgoingBytes = 0;
    child.stdin.off("drain", drain);
    if (!exited) {
      requestGracefulShutdown(child, state, { exitDelayMs: shutdownExitDelayMs });
      if (!state.initialized) child.stdin.end();
      terminateTimer = setTimeout(() => { if (!exited) child.kill("SIGTERM"); }, killDelayMs);
      killTimer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, killDelayMs + killEscalationMs);
    }
    if (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING) socket.close();
  }
  function fail(error) {
    if (shuttingDown) return;
    shutdown();
    onError(error instanceof Error ? error : new Error(String(error)));
  }
  function drain() {
    if (shuttingDown) return;
    blocked = false;
    while (incoming.length && !blocked) {
      const frame = incoming.shift();
      incomingBytes -= frame.length;
      try { blocked = !child.stdin.write(frame); }
      catch (error) { fail(error); return; }
    }
    if (blocked) socket.pause?.();
    else socket.resume?.();
  }
  function sendNext() {
    if (shuttingDown || sending || !outgoing.length) return;
    if (socket.readyState !== SOCKET_OPEN) { shutdown(); return; }
    const message = outgoing.shift();
    const bytes = Buffer.byteLength(message);
    sending = true;
    try {
      socket.send(message, (error) => {
        if (shuttingDown) return;
        sending = false;
        outgoingBytes -= bytes;
        if (error) { fail(error); return; }
        if (outgoingBytes < maxQueuedBytes / 2) child.stdout.resume();
        sendNext();
      });
    } catch (error) { fail(error); }
  }
  const parser = forwardLspFrames(child.stdout, (message) => {
    const bytes = Buffer.byteLength(message);
    if (bytes + outgoingBytes > maxQueuedBytes) { fail(new Error("LSP WebSocket output queue limit exceeded.")); return; }
    outgoing.push(message);
    outgoingBytes += bytes;
    if (outgoingBytes >= maxQueuedBytes / 2) child.stdout.pause();
    sendNext();
  }, { maxHeaderBytes, maxFrameBytes, onError: fail });
  socket.on("message", (message) => {
    if (shuttingDown) return;
    const payload = normalizeClientLspPayload(Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8"));
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    if (payload.length + header.length + incomingBytes + child.stdin.writableLength > maxQueuedBytes) {
      fail(new Error("LSP child input queue limit exceeded.")); return;
    }
    noteClientLspMessage(state, payload);
    const frame = Buffer.concat([header, payload]);
    incoming.push(frame);
    incomingBytes += frame.length;
    if (!blocked) drain();
  });
  socket.on("close", shutdown);
  socket.on("error", fail);
  child.stdin.on("drain", drain);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.on("error", fail);
  child.on("exit", () => {
    exited = true;
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    shutdown();
  });
  return { shutdown, state };
}

function defaultShouldSkipFollowingLines(text) {
  return (
    text.includes("client exited without proper shutdown sequence") ||
    text.includes("SendError") ||
    text.includes("rust-analyzer")
  );
}
