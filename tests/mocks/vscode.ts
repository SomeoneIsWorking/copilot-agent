import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type Listener<T> = (event: T) => unknown;

class Disposable {
  constructor(private readonly disposeFn: () => void = () => {}) {}
  dispose(): void {
    this.disposeFn();
  }
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    });
  };

  fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class CancellationTokenSource {
  private cancelled = false;
  token = {
    isCancellationRequested: false,
  };

  cancel(): void {
    this.cancelled = true;
    this.token.isCancellationRequested = true;
  }

  dispose(): void {
    this.cancelled = true;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
}

export const workspace = {
  fs: {
    readFile: async (uri: { fsPath: string }) => fs.readFile(uri.fsPath),
  },
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T) => defaultValue,
    update: async () => {},
  }),
  onDidChangeConfiguration: () => new Disposable(),
};

export const window = {
  showWarningMessage: async (...items: string[]) => items[0],
};

class MockUri {
  constructor(public readonly fsPath: string) {}

  static file(filePath: string): MockUri {
    return new MockUri(path.resolve(filePath));
  }

  static joinPath(base: MockUri, ...parts: string[]): MockUri {
    return new MockUri(path.join(base.fsPath, ...parts));
  }
}

export const Uri = MockUri;

export const lm: any = {
  selectChatModels: async () => [],
  tools: {
    registerTool: () => {},
  },
};

export const LanguageModelChatMessage = {
  User: (content: string) => ({ role: 'user', content }),
  Assistant: (content: string) => ({ role: 'assistant', content }),
  Tool: (name: string, content: string) => ({ role: 'tool', name, content }),
  System: (content: string) => ({ role: 'system', content }),
};

export type CancellationToken = {
  isCancellationRequested: boolean;
};
