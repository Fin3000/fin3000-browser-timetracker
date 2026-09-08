import { captureTarget } from './capture.js';
import { loadConfig } from './config.js';
import { badgeText, TimerCoordinator } from './coordinator.js';
import type { UIMessage } from './types.js';

const MENU = 'fin3000-start-timer';
const menus = browser.menus || browser.contextMenus!;
const instance = loadConfig().then((config) => ({
  config,
  coordinator: new TimerCoordinator(config),
}));
export function trustedPopup(sender: TimerMessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    sender.url === browser.runtime.getURL('popup.html') &&
    !sender.tab
  );
}
function validateMessage(raw: unknown): UIMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalidInput');
  const msg = raw as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    view: [],
    sync: [],
    acknowledge: [],
    connect: [],
    disconnect: [],
    openApp: [],
    dropRecovery: [],
    draft: ['fields', 'timerId', 'version', 'subject'],
    command: ['action', 'fields', 'timerId', 'version'],
    choices: ['kind', 'search', 'page', 'client'],
  };
  const keys = typeof msg['type'] === 'string' ? allowed[msg['type']] : undefined;
  if (!keys || Object.keys(msg).some((k) => k !== 'type' && !keys.includes(k)))
    throw new Error('invalidInput');
  if (
    msg['type'] === 'command' &&
    !['start', 'stop', 'update', 'discard'].includes(String(msg['action']))
  )
    throw new Error('invalidInput');
  if (
    msg['type'] === 'draft' &&
    (typeof msg['subject'] !== 'string' || msg['subject'].length > 200)
  )
    throw new Error('invalidInput');
  if (
    msg['type'] === 'draft' &&
    msg['version'] !== null &&
    (typeof msg['version'] !== 'string' || !/^[0-9a-f]{64}$/.test(msg['version']))
  )
    throw new Error('invalidInput');
  if (
    ['draft', 'command'].includes(String(msg['type'])) &&
    msg['timerId'] !== null &&
    (typeof msg['timerId'] !== 'string' || !/^[0-9a-f-]{36}$/.test(msg['timerId']))
  )
    throw new Error('invalidInput');
  if (
    msg['type'] === 'choices' &&
    (!['projects', 'clients'].includes(String(msg['kind'])) ||
      typeof msg['search'] !== 'string' ||
      msg['search'].length > 200 ||
      typeof msg['page'] !== 'number' ||
      !Number.isInteger(msg['page']) ||
      msg['page'] < 1 ||
      (msg['client'] !== undefined && typeof msg['client'] !== 'string'))
  )
    throw new Error('invalidInput');
  return msg as unknown as UIMessage;
}
async function refreshBadge(): Promise<void> {
  try {
    const { coordinator } = await instance;
    const view = await coordinator.view();
    await Promise.allSettled([
      browser.action.setBadgeText({ text: badgeText(view) }),
      browser.action.setBadgeBackgroundColor({
        color: view.stale || view.busy ? '#64748b' : '#605DFF',
      }),
      browser.action.setTitle({
        title: browser.i18n.getMessage(
          view.stale && view.connected
            ? 'checking'
            : view.snapshot?.timer
              ? 'running'
              : 'extensionName',
        ),
      }),
    ]);
  } catch {
    await browser.action.setBadgeText({ text: '!' });
  }
}
async function setup(): Promise<void> {
  await menus.removeAll();
  menus.create({
    id: MENU,
    title: browser.i18n.getMessage('menuStart'),
    contexts: ['all'],
  });
  await browser.alarms.create('timer-sync', { periodInMinutes: 1 });
  const { coordinator } = await instance;
  await coordinator.tick();
  await refreshBadge();
}
browser.runtime.onInstalled.addListener(() => {
  void setup().catch(() => refreshBadge());
});
browser.runtime.onStartup.addListener(() => {
  void setup().catch(() => refreshBadge());
});
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'timer-sync')
    void instance.then(async ({ coordinator }) => {
      await coordinator.tick();
      await refreshBadge();
    });
});
menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU || tab?.incognito) return;
  // Preserve the menu gesture before any storage or network await.
  void browser.action.openPopup().catch(() => undefined);
  const frameId = info.frameId || 0;
  const url = info.frameUrl || info.pageUrl || tab?.url || '';
  const capture = tab?.id === undefined || !/^https?:\/\//.test(url)
    ? Promise.resolve(null)
    : browser.menus
      ? info.targetElementId === undefined ? Promise.resolve(null) : browser.scripting
          .executeScript({ target: { tabId: tab.id, frameIds: [frameId] },
            func: captureTarget, args: [info.targetElementId] })
          .then((results) => results.find((r) => r.frameId === frameId)?.result || null)
          .catch(() => null)
      : browser.tabs.sendMessage(tab.id, { type: 'fin3000.capture' }, { frameId })
          .then((result) => typeof result === 'string' && Array.from(result).length <= 500 ? result : null)
          .catch(() => null);
  void (async () => {
    const { coordinator } = await instance;
    try {
      await coordinator.capture(await capture);
    } catch (error) {
      await coordinator.notice(
        error instanceof Error && error.message === 'busy' ? 'busy' : 'manualCapture',
      );
    }
    await refreshBadge();
  })();
});
browser.runtime.onMessage.addListener((raw, sender) => {
  if (!trustedPopup(sender)) return undefined;
  return (async () => {
    try {
      const msg = validateMessage(raw);
      const { config, coordinator } = await instance;
      switch (msg.type) {
        case 'view':
          break;
        case 'sync':
          await coordinator.tick();
          break;
        case 'acknowledge':
          await coordinator.acknowledge();
          break;
        case 'connect':
          void coordinator.connect().finally(refreshBadge);
          break;
        case 'disconnect':
          await coordinator.disconnect();
          break;
        case 'draft':
          await coordinator.draft(msg.fields, msg.timerId, msg.subject, msg.version);
          break;
        case 'dropRecovery':
          await coordinator.dropRecovery();
          break;
        case 'command':
          await coordinator.accept(msg.action, msg.fields, msg.timerId, msg.version);
          break;
        case 'choices':
          return {
            ok: true,
            page: await coordinator.choices(msg.kind, msg.search, msg.page, msg.client),
          };
        case 'openApp':
          await browser.tabs.create({ url: config.frontendOrigin + '/timetracker' });
          break;
      }
      await refreshBadge();
      return { ok: true, view: await coordinator.view() };
    } catch (error) {
      const key = error instanceof Error ? error.message : 'serverError';
      return {
        ok: false,
        error: [
          'configuration',
          'updateRequired',
          'storageError',
          'invalidInput',
          'connectAgain',
          'busy',
          'conflict',
          'permissionDenied',
          'refreshFirst',
          'offline',
          'rateLimited',
          'serverError',
        ].includes(key)
          ? key
          : 'serverError',
      };
    }
  })();
});
// Every event-page recreation resumes any durable accepted operation.
void instance
  .then(async ({ coordinator }) => {
    await browser.alarms.create('timer-sync', { periodInMinutes: 1 });
    await coordinator.tick();
    await refreshBadge();
  })
  .catch(() => refreshBadge());
