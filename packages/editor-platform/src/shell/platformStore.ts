import type { EditorDiagnostic } from "../core/diagnostics.js";
import type { DocumentIdentity, DocumentSnapshot, DocumentUri } from "../core/documents.js";
import type { LogEvent } from "../core/logs.js";
import type {
  EditorServiceDescriptor,
  EditorServiceSnapshot,
  ServiceEvent,
  ServiceStatus
} from "../services/status.js";
import { serviceStatusFromEvent } from "../services/status.js";
import { ObservableStore } from "./store.js";

export interface EditorPlatformSnapshot {
  services: Readonly<Record<string, EditorServiceSnapshot>>;
  documents: Readonly<Record<DocumentUri, DocumentSnapshot>>;
  activeDocumentUri?: DocumentUri;
  diagnostics: readonly EditorDiagnostic[];
  logs: readonly LogEvent[];
}

export function createEmptyEditorPlatformSnapshot(): EditorPlatformSnapshot {
  return {
    services: {},
    documents: {},
    diagnostics: [],
    logs: []
  };
}

export class EditorPlatformStore extends ObservableStore<EditorPlatformSnapshot> {
  constructor(initialSnapshot: EditorPlatformSnapshot = createEmptyEditorPlatformSnapshot()) {
    super(initialSnapshot);
  }

  upsertService(service: EditorServiceSnapshot): void {
    this.update((snapshot) => ({
      ...snapshot,
      services: {
        ...snapshot.services,
        [service.id]: service
      }
    }));
  }

  setServiceStatus(
    descriptor: EditorServiceDescriptor,
    status: ServiceStatus,
    options: {
      documents?: readonly DocumentIdentity[];
      updatedAt?: number;
    } = {}
  ): void {
    const existing = this.snapshot.services[descriptor.id];
    this.upsertService({
      ...descriptor,
      status,
      documents: options.documents ?? existing?.documents ?? [],
      updatedAt: options.updatedAt ?? Date.now()
    });
  }

  recordServiceEvent(
    descriptor: EditorServiceDescriptor,
    event: ServiceEvent,
    options: {
      documents?: readonly DocumentIdentity[];
    } = {}
  ): void {
    if (event.serviceId !== descriptor.id) {
      throw new Error(`Service event for ${event.serviceId} cannot update ${descriptor.id}.`);
    }

    const statusOptions: {
      documents?: readonly DocumentIdentity[];
      updatedAt?: number;
    } = {
      updatedAt: event.timestamp ?? Date.now()
    };
    if (options.documents !== undefined) {
      statusOptions.documents = options.documents;
    }

    this.setServiceStatus(descriptor, serviceStatusFromEvent(event), statusOptions);
  }

  setDocument(document: DocumentSnapshot): void {
    this.update((snapshot) => ({
      ...snapshot,
      documents: {
        ...snapshot.documents,
        [document.uri]: document
      }
    }));
  }

  setActiveDocument(uri: DocumentUri): void {
    this.update((snapshot) => ({
      ...snapshot,
      activeDocumentUri: uri
    }));
  }

  setDiagnostics(diagnostics: readonly EditorDiagnostic[]): void {
    this.update((snapshot) => ({
      ...snapshot,
      diagnostics: [...diagnostics]
    }));
  }

  setDocumentDiagnostics(uri: DocumentUri, diagnostics: readonly EditorDiagnostic[]): void {
    this.update((snapshot) => ({
      ...snapshot,
      diagnostics: [
        ...snapshot.diagnostics.filter((diagnostic) => diagnostic.uri !== uri),
        ...diagnostics.map((diagnostic) => ({
          ...diagnostic,
          uri: diagnostic.uri ?? uri
        }))
      ]
    }));
  }

  appendLog(event: LogEvent, options: { maxEntries?: number } = {}): void {
    const maxEntries = options.maxEntries ?? 500;
    this.update((snapshot) => ({
      ...snapshot,
      logs: [...snapshot.logs, event].slice(-maxEntries)
    }));
  }
}
