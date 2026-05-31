export const DEMO_ENDPOINTS = Object.freeze({
  document: "/document",
  regenerateRustMain: "/regenerate-rust-main",
  rustDocument: "/rust-document",
  rustMain: "/rust-main",
  rustSession: "/rust-session",
  session: "/session",
  status: "/status",
  switchExample: "/switch-example",
});

export function documentEndpoint(apiBase, uri) {
  return `${apiBase}${DEMO_ENDPOINTS.document}?uri=${encodeURIComponent(uri)}`;
}

export function parseDemoSession(value) {
  const record = expectRecord(value, "DemoSession");
  const documentLanguageIds = optionalStringRecord(record.documentLanguageIds, "documentLanguageIds");
  const availableExamples = optionalDemoExamples(record.availableExamples, "availableExamples");
  const preparationStatus = optionalDemoPreparationStatus(record.preparationStatus, "preparationStatus");
  return {
    ...(record.activeExampleId === undefined
      ? {}
      : { activeExampleId: expectString(record.activeExampleId, "activeExampleId") }),
    ...(availableExamples ? { availableExamples } : {}),
    ...(record.canRegenerate === undefined ? {} : { canRegenerate: expectBoolean(record.canRegenerate, "canRegenerate") }),
    ...(record.demoProject === undefined ? {} : { demoProject: expectString(record.demoProject, "demoProject") }),
    ...(record.demoSummary === undefined ? {} : { demoSummary: expectString(record.demoSummary, "demoSummary") }),
    ...(record.demoTitle === undefined ? {} : { demoTitle: expectString(record.demoTitle, "demoTitle") }),
    ...(preparationStatus ? { preparationStatus } : {}),
    rootUri: expectString(record.rootUri, "rootUri"),
    documentUri: expectString(record.documentUri, "documentUri"),
    ...(documentLanguageIds ? { documentLanguageIds } : {}),
    documents: expectStringArray(record.documents, "documents"),
    ...(record.embeddedLeanDefaultImports === undefined
      ? {}
      : { embeddedLeanDefaultImports: expectStringArray(record.embeddedLeanDefaultImports, "embeddedLeanDefaultImports") }),
    ...(record.embeddedLeanDocumentUri === undefined
      ? {}
      : { embeddedLeanDocumentUri: expectString(record.embeddedLeanDocumentUri, "embeddedLeanDocumentUri") }),
    ...(record.embeddedLeanPreamble === undefined
      ? {}
      : { embeddedLeanPreamble: expectStringArray(record.embeddedLeanPreamble, "embeddedLeanPreamble") }),
    ...(record.embeddedLeanPostamble === undefined
      ? {}
      : { embeddedLeanPostamble: expectStringArray(record.embeddedLeanPostamble, "embeddedLeanPostamble") }),
    initialDoc: expectString(record.initialDoc, "initialDoc"),
    ...(record.rustRootUri === undefined ? {} : { rustRootUri: expectString(record.rustRootUri, "rustRootUri") }),
    ...(record.rustMainDocumentUri === undefined
      ? {}
      : { rustMainDocumentUri: expectString(record.rustMainDocumentUri, "rustMainDocumentUri") }),
    ...(record.rustMainWebsocketUrl === undefined
      ? {}
      : { rustMainWebsocketUrl: expectString(record.rustMainWebsocketUrl, "rustMainWebsocketUrl") }),
    websocketUrl: expectString(record.websocketUrl, "websocketUrl"),
  };
}

export function parseDemoPreparationStatus(value) {
  return expectDemoPreparationStatus(value, "DemoPreparationStatus");
}

export function parseSwitchExampleRequest(value) {
  const record = expectRecord(value, "SwitchExampleRequest");
  return {
    id: expectString(record.id, "id"),
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

function optionalDemoPreparationStatus(value, name) {
  if (value === undefined) {
    return undefined;
  }
  return expectDemoPreparationStatus(value, name);
}

function expectDemoPreparationStatus(value, name) {
  const record = expectRecord(value, name);
  const phase = expectString(record.phase, `${name}.phase`);
  if (!["idle", "preparing", "ready", "failed"].includes(phase)) {
    throw new Error(`${name}.phase is invalid`);
  }
  return {
    phase,
    message: expectString(record.message, `${name}.message`),
    updatedAt: expectString(record.updatedAt, `${name}.updatedAt`),
    ...(record.detail === undefined ? {} : { detail: expectString(record.detail, `${name}.detail`) }),
  };
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

function optionalDemoExamples(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map((entry, index) => {
    const record = expectRecord(entry, `${name}[${index}]`);
    return {
      id: expectString(record.id, `${name}[${index}].id`),
      label: expectString(record.label, `${name}[${index}].label`),
      ...(record.ready === undefined ? {} : { ready: expectBoolean(record.ready, `${name}[${index}].ready`) }),
      ...(record.summary === undefined
        ? {}
        : { summary: expectString(record.summary, `${name}[${index}].summary`) }),
    };
  });
}
