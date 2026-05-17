import type {
  EditorPlatformMessageSource,
  EditorPlatformMessageTarget
} from "./endpoint.js";
import type { EditorPlatformMessage } from "./messages.js";
import type { Unsubscribe } from "../shell/store.js";

export interface PostMessageLike<TMessage extends EditorPlatformMessage> {
  postMessage(message: TMessage): unknown;
}

export interface MessageEventLike {
  data: unknown;
}

export interface MessageEventTargetLike {
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

export interface DisposableLike {
  dispose(): void;
}

export interface OnDidReceiveMessageLike {
  onDidReceiveMessage(listener: (message: unknown) => void): DisposableLike;
}

export function createPostMessageTarget<TMessage extends EditorPlatformMessage>(
  target: PostMessageLike<TMessage>
): EditorPlatformMessageTarget<TMessage> {
  return {
    postMessage(message) {
      target.postMessage(message);
    }
  };
}

export function createMessageEventSource(source: MessageEventTargetLike): EditorPlatformMessageSource {
  return {
    subscribe(listener): Unsubscribe {
      const eventListener = (event: MessageEventLike) => {
        listener(event.data);
      };
      source.addEventListener("message", eventListener);
      return () => {
        source.removeEventListener("message", eventListener);
      };
    }
  };
}

export function createOnDidReceiveMessageSource(source: OnDidReceiveMessageLike): EditorPlatformMessageSource {
  return {
    subscribe(listener): Unsubscribe {
      const disposable = source.onDidReceiveMessage(listener);
      return () => {
        disposable.dispose();
      };
    }
  };
}
