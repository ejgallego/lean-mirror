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

export function forwardLspFrames(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        throw new Error(`Malformed LSP header: ${header}`);
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) {
        return;
      }
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      onMessage(body);
    }
  });
}

export function pipeServerStderr(
  stream,
  {
    ignoredPatterns = defaultIgnorableClosePatterns,
    onLine = (line) => console.error(line),
    shouldSkipFollowingLines = defaultShouldSkipFollowingLines,
  } = {},
) {
  let buffer = "";
  let skipBlock = false;

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
    buffer += chunk.toString("utf8");
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
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

export function attachLspProcess(
  socket,
  child,
  {
    killDelayMs = 120,
    shutdownExitDelayMs = 25,
    state = createLspProcessState(),
  } = {},
) {
  let shuttingDown = false;
  forwardLspFrames(child.stdout, (message) => {
    if (socket.readyState === SOCKET_OPEN) {
      socket.send(message);
    }
  });

  socket.on("message", (message) => {
    const payload = normalizeClientLspPayload(
      Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8"),
    );
    noteClientLspMessage(state, payload);
    child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    child.stdin.write(payload);
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    state.expectedClose = true;
    requestGracefulShutdown(child, state, { exitDelayMs: shutdownExitDelayMs });
    if (!child.killed) {
      setTimeout(() => {
        if (!child.killed) {
          child.kill();
        }
      }, killDelayMs);
    }
    if (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING) {
      socket.close();
    }
  };

  socket.on("close", shutdown);
  socket.on("error", shutdown);
  child.on("exit", () => {
    if (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING) {
      socket.close();
    }
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
