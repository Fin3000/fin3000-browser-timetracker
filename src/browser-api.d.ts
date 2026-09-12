/** The browser WebExtension surface used by Firefox and Edge 152+. */
interface TimerMessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}
interface TimerClickInfo {
  menuItemId: string | number;
  targetElementId?: number;
  frameId?: number;
  pageUrl?: string;
  frameUrl?: string;
}
interface TimerTab {
  id?: number;
  incognito?: boolean;
  url?: string;
}
declare const browser: {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        fn: (message: unknown, sender: TimerMessageSender) => Promise<unknown> | undefined,
      ): void;
    };
    onInstalled: { addListener(fn: () => void): void };
    onStartup: { addListener(fn: () => void): void };
  };
  i18n: {
    getMessage(key: string, substitutions?: string | string[]): string;
    getUILanguage(): string;
  };
  menus: {
    create(options: { id: string; title: string; contexts: string[] }): string | number;
    removeAll(): Promise<void>;
    getTargetElement(id: number): Element | null;
    onClicked: { addListener(fn: (info: TimerClickInfo, tab?: TimerTab) => void): void };
  };
  contextMenus?: {
    create(options: { id: string; title: string; contexts: string[] }): string | number;
    removeAll(): Promise<void>;
    onClicked: { addListener(fn: (info: TimerClickInfo, tab?: TimerTab) => void): void };
  };
  scripting: {
    executeScript<A extends unknown[], R>(options: {
      target: { tabId: number; frameIds: number[] };
      func: (...args: A) => R;
      args: A;
    }): Promise<{ frameId: number; result?: R }[]>;
  };
  identity: {
    getRedirectURL(): string;
    launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string>;
  };
  action: {
    openPopup(): Promise<void>;
    setBadgeText(options: { text: string }): Promise<void>;
    setBadgeBackgroundColor(options: { color: string }): Promise<void>;
    setTitle(options: { title: string }): Promise<void>;
  };
  alarms: {
    create(
      name: string,
      options: { delayInMinutes?: number; periodInMinutes?: number; when?: number },
    ): Promise<void>;
    clear(name: string): Promise<boolean>;
    onAlarm: { addListener(fn: (alarm: { name: string }) => void): void };
  };
  notifications: {
    create(
      id: string,
      options: { type: 'basic'; iconUrl: string; title: string; message: string },
    ): Promise<string>;
  };
  tabs: {
    create(options: { url: string }): Promise<TimerTab>;
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  };
};
