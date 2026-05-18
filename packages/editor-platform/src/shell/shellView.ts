import { summarizeDiagnostics, type DiagnosticSummary } from "../core/diagnostics.js";
import type { EditorServiceSnapshot, ServiceStatus } from "../services/status.js";
import { serviceStatusLabel } from "../services/status.js";
import type { EditorPlatformSnapshot } from "./platformStore.js";

export type ServiceLightState = "ready" | "pending" | "stale" | "failed" | "stopped";

export interface EditorServiceStatusView {
  id: string;
  kind: string;
  label: string;
  lightState: ServiceLightState;
  state: ServiceStatus["state"];
  statusLabel: string;
}

export interface EditorPlatformShellView {
  activeDocumentUri?: string;
  diagnosticsSummary: DiagnosticSummary;
  diagnosticsText: string;
  services: readonly EditorServiceStatusView[];
  statusText: string;
}

export interface EditorPlatformShellViewOptions {
  emptyStatusText?: string;
  hostServiceId?: string;
  includeHostService?: boolean;
}

const pendingStates = new Set<ServiceStatus["state"]>(["starting", "initializing", "stopping"]);

export function serviceLightState(status: ServiceStatus): ServiceLightState {
  if (status.state === "ready") {
    return "ready";
  }
  if (status.state === "failed") {
    return "failed";
  }
  if (status.state === "stale") {
    return "stale";
  }
  if (pendingStates.has(status.state)) {
    return "pending";
  }
  return "stopped";
}

export function diagnosticsSummaryText(summary: DiagnosticSummary): string {
  const parts = [
    `${summary.errors} error${summary.errors === 1 ? "" : "s"}`,
    `${summary.warnings} warning${summary.warnings === 1 ? "" : "s"}`
  ];
  if (summary.infos > 0) {
    parts.push(`${summary.infos} info`);
  }
  if (summary.hints > 0) {
    parts.push(`${summary.hints} hint${summary.hints === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export function serviceStatusView(service: EditorServiceSnapshot): EditorServiceStatusView {
  return {
    id: service.id,
    kind: service.kind,
    label: service.label,
    lightState: serviceLightState(service.status),
    state: service.status.state,
    statusLabel: serviceStatusLabel(service.status)
  };
}

export function createEditorPlatformShellView(
  snapshot: EditorPlatformSnapshot,
  options: EditorPlatformShellViewOptions = {}
): EditorPlatformShellView {
  const hostServiceId = options.hostServiceId;
  const host = hostServiceId ? snapshot.services[hostServiceId] : undefined;
  const services = Object.values(snapshot.services).filter(
    (service) => options.includeHostService || service.id !== hostServiceId
  );
  const diagnosticsSummary = summarizeDiagnostics(snapshot.diagnostics);

  return {
    ...(snapshot.activeDocumentUri ? { activeDocumentUri: snapshot.activeDocumentUri } : {}),
    diagnosticsSummary,
    diagnosticsText: diagnosticsSummaryText(diagnosticsSummary),
    services: services.map(serviceStatusView),
    statusText: overallStatusText(host, services, options.emptyStatusText ?? "Booting")
  };
}

function overallStatusText(
  host: EditorServiceSnapshot | undefined,
  services: readonly EditorServiceSnapshot[],
  emptyStatusText: string
): string {
  if (host && host.status.state !== "ready") {
    return serviceStatusLabel(host.status);
  }

  const failed = services.find((service) => service.status.state === "failed");
  if (failed) {
    return `${failed.label}: ${serviceStatusLabel(failed.status)}`;
  }

  const pending = services.find((service) => pendingStates.has(service.status.state));
  if (pending) {
    return `${pending.label}: ${serviceStatusLabel(pending.status)}`;
  }

  const stale = services.find((service) => service.status.state === "stale");
  if (stale) {
    return `${stale.label}: ${serviceStatusLabel(stale.status)}`;
  }

  return host ? serviceStatusLabel(host.status) : emptyStatusText;
}
