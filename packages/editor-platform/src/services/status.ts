import type { DocumentIdentity } from "../core/documents.js";

export type ServiceKind = "lean-lsp" | "rust-lsp" | "verso-parser" | (string & {});

export type ServiceStatus =
  | {
      state: "stopped";
      message?: string;
    }
  | {
      state: "starting";
      message?: string;
    }
  | {
      state: "initializing";
      message?: string;
    }
  | {
      state: "ready";
      message?: string;
    }
  | {
      state: "stale";
      message?: string;
    }
  | {
      state: "stopping";
      message?: string;
    }
  | {
      state: "failed";
      message: string;
      recoverable?: boolean;
    };

export interface EditorServiceDescriptor {
  id: string;
  kind: ServiceKind;
  label: string;
}

export interface EditorServiceSnapshot extends EditorServiceDescriptor {
  status: ServiceStatus;
  documents: readonly DocumentIdentity[];
  updatedAt: number;
}

export function serviceIsUsable(status: ServiceStatus): boolean {
  return status.state === "ready" || status.state === "stale";
}

export function serviceStatusLabel(status: ServiceStatus): string {
  if (status.message) {
    return status.message;
  }

  switch (status.state) {
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting";
    case "initializing":
      return "Initializing";
    case "ready":
      return "Ready";
    case "stale":
      return "Stale";
    case "stopping":
      return "Stopping";
    case "failed":
      return status.message;
  }
}
