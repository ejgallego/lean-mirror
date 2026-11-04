import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from "node:http";
import type { createLeanDocumentStore } from "./leanDocuments.mjs";
export function handleLeanDocumentRequest(req: IncomingMessage, res: ServerResponse, options: {
  store: ReturnType<typeof createLeanDocumentStore>;
  maxBodyBytes: number;
  headers?: (req: IncomingMessage) => OutgoingHttpHeaders;
}): Promise<void>;
