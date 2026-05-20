import type { LogEvent, LogLevel } from "../core/logs.js";

export interface EditorPlatformLogPanelDocument {
  createElement(tagName: string): EditorPlatformLogPanelElement;
}

export interface EditorPlatformLogPanelElement {
  ownerDocument: EditorPlatformLogPanelDocument;
  className: string;
  dataset?: Record<string, string | undefined> | undefined;
  textContent: string | null;
  replaceChildren(...children: any[]): void;
  setAttribute(name: string, value: string): void;
}

export interface EditorPlatformLogPanelClassNames {
  item: string;
}

export interface RenderEditorPlatformLogPanelOptions {
  ariaLabel?: string | undefined;
  classNames?: Partial<EditorPlatformLogPanelClassNames> | undefined;
  emptyText?: string | undefined;
  formatMessage?: ((event: LogEvent) => string) | undefined;
  levels?: readonly LogLevel[] | undefined;
  maxEntries?: number | undefined;
  newestFirst?: boolean | undefined;
}

const defaultClassNames: EditorPlatformLogPanelClassNames = {
  item: "event"
};

export function renderEditorPlatformLogPanel(
  container: EditorPlatformLogPanelElement,
  logs: readonly LogEvent[],
  options: RenderEditorPlatformLogPanelOptions = {}
): void {
  const document = container.ownerDocument;
  const classNames = { ...defaultClassNames, ...options.classNames };
  const events = selectLogEvents(logs, options);

  container.setAttribute("aria-label", options.ariaLabel ?? "Event log");
  if (events.length === 0) {
    container.replaceChildren();
    if (options.emptyText) {
      container.textContent = options.emptyText;
    }
    return;
  }

  container.replaceChildren(
    ...events.map((event) => logEventElement(document, classNames, event, options.formatMessage))
  );
}

function selectLogEvents(
  logs: readonly LogEvent[],
  options: RenderEditorPlatformLogPanelOptions
): readonly LogEvent[] {
  const filtered = options.levels ? logs.filter((event) => options.levels?.includes(event.level)) : logs;
  const maxEntries = options.maxEntries ?? filtered.length;
  const selected = filtered.slice(Math.max(0, filtered.length - maxEntries));
  return options.newestFirst ?? true ? [...selected].reverse() : selected;
}

function logEventElement(
  document: EditorPlatformLogPanelDocument,
  classNames: EditorPlatformLogPanelClassNames,
  event: LogEvent,
  formatMessage: ((event: LogEvent) => string) | undefined
): EditorPlatformLogPanelElement {
  const item = document.createElement("div");
  item.className = classNames.item;
  item.textContent = formatMessage ? formatMessage(event) : event.message;
  if (item.dataset) {
    item.dataset.level = event.level;
    if (event.serviceId) {
      item.dataset.serviceId = event.serviceId;
    }
    if (event.uri) {
      item.dataset.uri = event.uri;
    }
  }
  return item;
}
