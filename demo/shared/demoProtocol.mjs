export const DEMO_ENDPOINTS = Object.freeze({
  document: "/document",
  rustDocument: "/rust-document",
  rustMain: "/rust-main",
  rustSession: "/rust-session",
  session: "/session",
});

export function documentEndpoint(apiBase, uri) {
  return `${apiBase}${DEMO_ENDPOINTS.document}?uri=${encodeURIComponent(uri)}`;
}

export function parseDemoSession(value) {
  const record = expectRecord(value, "DemoSession");
  const documentLanguageIds = optionalStringRecord(record.documentLanguageIds, "documentLanguageIds");
  return {
    rootUri: expectString(record.rootUri, "rootUri"),
    documentUri: expectString(record.documentUri, "documentUri"),
    ...(documentLanguageIds ? { documentLanguageIds } : {}),
    documents: expectStringArray(record.documents, "documents"),
    ...(record.embeddedLeanDocumentUri === undefined
      ? {}
      : { embeddedLeanDocumentUri: expectString(record.embeddedLeanDocumentUri, "embeddedLeanDocumentUri") }),
    initialDoc: expectString(record.initialDoc, "initialDoc"),
    ...(record.rustMainDocumentUri === undefined
      ? {}
      : { rustMainDocumentUri: expectString(record.rustMainDocumentUri, "rustMainDocumentUri") }),
    ...(record.rustMainWebsocketUrl === undefined
      ? {}
      : { rustMainWebsocketUrl: expectString(record.rustMainWebsocketUrl, "rustMainWebsocketUrl") }),
    websocketUrl: expectString(record.websocketUrl, "websocketUrl"),
  };
}

export function parseDocumentResponse(value) {
  const record = expectRecord(value, "DocumentResponse");
  return {
    ...(record.uri === undefined ? {} : { uri: expectString(record.uri, "uri") }),
    text: expectString(record.text, "text"),
  };
}

export function parseCreateRustSessionRequest(value) {
  const record = expectRecord(value, "CreateRustSessionRequest");
  return {
    code: expectString(record.code, "code"),
    key: expectString(record.key, "key"),
  };
}

export function parseRustSession(value) {
  const record = expectRecord(value, "RustSession");
  return {
    documentUri: expectString(record.documentUri, "documentUri"),
    rootUri: expectString(record.rootUri, "rootUri"),
    websocketUrl: expectString(record.websocketUrl, "websocketUrl"),
  };
}

export function parseUpdateRustDocumentRequest(value) {
  const record = expectRecord(value, "UpdateRustDocumentRequest");
  const version = optionalNumber(record.version, "version");
  return {
    code: expectString(record.code, "code"),
    key: expectString(record.key, "key"),
    ...(version === undefined ? {} : { version }),
  };
}

export function parseRustMainUpdateRequest(value) {
  const record = expectRecord(value, "RustMainUpdateRequest");
  return {
    code: expectString(record.code, "code"),
    leanDocument: expectString(record.leanDocument, "leanDocument"),
    revision: expectNumber(record.revision, "revision"),
    uri: expectString(record.uri, "uri"),
  };
}

export function parseRustMainUpdateResult(value) {
  const record = expectRecord(value, "RustMainUpdateResult");
  return {
    leanDocumentUri: expectString(record.leanDocumentUri, "leanDocumentUri"),
    revision: expectNumber(record.revision, "revision"),
    ...(record.stale === undefined ? {} : { stale: expectBoolean(record.stale, "stale") }),
  };
}

function expectRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function expectString(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function expectNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function expectBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function expectStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return [...value];
}

function optionalNumber(value, name) {
  if (value === undefined) {
    return undefined;
  }
  return expectNumber(value, name);
}

function optionalStringRecord(value, name) {
  if (value === undefined) {
    return undefined;
  }
  const record = expectRecord(value, name);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, expectString(entry, `${name}.${key}`)]),
  );
}
