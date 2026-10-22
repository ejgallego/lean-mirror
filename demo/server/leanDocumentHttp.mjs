import { parseLeanDocumentSave } from "./leanDocuments.mjs";
import { DemoRequestTooLargeError, readBoundedJsonBody } from "./security.mjs";

export async function handleLeanDocumentRequest(req, res, { store, maxBodyBytes, headers = () => ({}) }) {
  const respond = (status, text, json = false) => {
    res.writeHead(status, { ...headers(req), "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8" });
    res.end(text);
  };
  try {
    let snapshot;
    if (req.method === "GET") {
      const uri = new URL(req.url, "http://localhost").searchParams.get("uri");
      if (!uri) { respond(400, "Missing uri parameter"); return; }
      snapshot = await store.read(uri);
    } else if (req.method === "POST") {
      let payload;
      try { payload = parseLeanDocumentSave(await readBoundedJsonBody(req, maxBodyBytes)); }
      catch (error) {
        respond(error instanceof DemoRequestTooLargeError ? 413 : 400, "Invalid or oversized Lean document payload");
        return;
      }
      snapshot = await store.save(payload);
    } else { respond(405, "Method not allowed"); return; }
    respond(200, JSON.stringify(snapshot), true);
  } catch (error) {
    if (error.code === "ERR_LEAN_DOCUMENT_CONFLICT") respond(409, error.message);
    else if (error.code === "ERR_LEAN_DOCUMENT_FORBIDDEN") respond(403, error.message);
    else throw error;
  }
}
