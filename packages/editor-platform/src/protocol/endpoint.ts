import type { Unsubscribe } from "../shell/store.js";
import type { EditorPlatformStore } from "../shell/platformStore.js";
import {
  isEditorToHostMessage,
  isHostToEditorMessage,
  platformMessage,
  type EditorPlatformMessage,
  type EditorToHostMessage,
  type HostToEditorMessage
} from "./messages.js";

export type EditorPlatformMessageListener<TMessage extends EditorPlatformMessage> = (message: TMessage) => void;
export type EditorPlatformMessagePredicate<TMessage extends EditorPlatformMessage> = (
  value: unknown
) => value is TMessage;

export interface EditorPlatformMessageTarget<TMessage extends EditorPlatformMessage> {
  postMessage(message: TMessage): void;
}

export interface EditorPlatformMessageSource {
  subscribe(listener: (message: unknown) => void): Unsubscribe;
}

export interface EditorPlatformEndpointOptions<TIncoming extends EditorPlatformMessage> {
  acceptMessage: EditorPlatformMessagePredicate<TIncoming>;
  onInvalidMessage?: (message: unknown) => void;
}

export class EditorPlatformEndpoint<
  TIncoming extends EditorPlatformMessage,
  TOutgoing extends EditorPlatformMessage
> {
  private readonly listeners = new Set<EditorPlatformMessageListener<TIncoming>>();
  private readonly unsubscribeSource: Unsubscribe | undefined;

  constructor(
    private readonly target: EditorPlatformMessageTarget<TOutgoing>,
    source: EditorPlatformMessageSource | undefined,
    private readonly options: EditorPlatformEndpointOptions<TIncoming>
  ) {
    this.unsubscribeSource = source?.subscribe((message) => {
      this.receive(message);
    });
  }

  postMessage(message: TOutgoing): void {
    this.target.postMessage(message);
  }

  subscribe(listener: EditorPlatformMessageListener<TIncoming>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  receive(message: unknown): boolean {
    if (!this.options.acceptMessage(message)) {
      this.options.onInvalidMessage?.(message);
      return false;
    }

    for (const listener of [...this.listeners]) {
      listener(message);
    }
    return true;
  }

  dispose(): void {
    this.listeners.clear();
    this.unsubscribeSource?.();
  }
}

export type HostEndpointOptions = Omit<EditorPlatformEndpointOptions<EditorToHostMessage>, "acceptMessage">;
export type EditorEndpointOptions = Omit<EditorPlatformEndpointOptions<HostToEditorMessage>, "acceptMessage">;

export function createHostEndpoint(
  target: EditorPlatformMessageTarget<HostToEditorMessage>,
  source?: EditorPlatformMessageSource,
  options: HostEndpointOptions = {}
): EditorPlatformEndpoint<EditorToHostMessage, HostToEditorMessage> {
  return new EditorPlatformEndpoint(target, source, {
    ...options,
    acceptMessage: isEditorToHostMessage
  });
}

export function createEditorEndpoint(
  target: EditorPlatformMessageTarget<EditorToHostMessage>,
  source?: EditorPlatformMessageSource,
  options: EditorEndpointOptions = {}
): EditorPlatformEndpoint<HostToEditorMessage, EditorToHostMessage> {
  return new EditorPlatformEndpoint(target, source, {
    ...options,
    acceptMessage: isHostToEditorMessage
  });
}

export function publishPlatformSnapshots(
  store: EditorPlatformStore,
  target: EditorPlatformMessageTarget<HostToEditorMessage>,
  options: { emitCurrent?: boolean } = {}
): Unsubscribe {
  return store.subscribe(
    (snapshot) => {
      target.postMessage(platformMessage("platform-snapshot", { snapshot }));
    },
    { emitCurrent: options.emitCurrent ?? true }
  );
}
