import type { StoredState } from './types.js';
import { principalData, snapshotData } from './api.js';

export function emptyState(epoch = 0): StoredState {
  return {
    schema: 1,
    epoch,
    auth: null,
    principal: null,
    snapshot: null,
    syncedAt: 0,
    command: null,
    stopIntent: null,
    draft: null,
    recovery: null,
    pendingCapture: null,
    connectionAttempt: null,
    notice: null,
    failures: 0,
    retryAt: 0,
  };
}

export function validateStoredState(raw: unknown): StoredState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('updateRequired');
  const s = raw as StoredState;
  const uuid = (v: unknown): boolean =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
  if (
    s.schema !== 1 ||
    Object.keys(s).sort().join() !== Object.keys(emptyState()).sort().join() ||
    !Number.isSafeInteger(s.epoch) ||
    s.epoch < 0 ||
    !Number.isFinite(s.syncedAt) ||
    !Number.isSafeInteger(s.failures) ||
    s.failures < 0 ||
    !Number.isFinite(s.retryAt) ||
    (s.auth !== null &&
      (typeof s.auth !== 'object' ||
        typeof s.auth.accessToken !== 'string' ||
        typeof s.auth.refreshToken !== 'string' ||
        typeof s.auth.refreshing !== 'boolean' ||
        !Number.isFinite(s.auth.expiresAt))) ||
    (s.principal !== null &&
      (s.principal.protocolVersion !== 1 || typeof s.principal.subject !== 'string')) ||
    (s.command !== null &&
      (!['start', 'update', 'stop', 'discard'].includes(s.command.action) ||
        s.command.subject !== s.principal?.subject ||
        typeof s.command.attempted !== 'boolean' ||
        !Number.isFinite(s.command.deadline) ||
        !Number.isFinite(s.command.createdAt) ||
        !uuid(s.command.body?.commandId) ||
        typeof s.command.body.commandWindow !== 'string')) ||
    (s.connectionAttempt !== null && !uuid(s.connectionAttempt)) ||
    (s.notice !== null && (typeof s.notice !== 'string' || s.notice.length > 64)) ||
    (s.pendingCapture !== null &&
      (typeof s.pendingCapture.text !== 'string' ||
        Array.from(s.pendingCapture.text).length > 500 ||
        !Number.isFinite(s.pendingCapture.expiresAt) ||
        typeof s.pendingCapture.attemptId !== 'string')) ||
    (s.stopIntent !== null &&
      (s.command?.action !== 'update' ||
        s.stopIntent.afterCommandId !== s.command.body.commandId ||
        s.stopIntent.timerId !== s.command.body.expectedTimerId))
  )
    throw new Error('updateRequired');
  if (s.principal !== null) principalData(s.principal);
  if (s.snapshot !== null) {
    if (!s.principal) throw new Error('updateRequired');
    snapshotData(s.snapshot);
  }
  for (const key of ['draft', 'recovery'] as const) {
    const draft = s[key];
    if (
      draft !== null &&
      (typeof draft !== 'object' ||
        draft.subject !== s.principal?.subject ||
        !Number.isFinite(draft.expiresAt) ||
        !draft.fields ||
        typeof draft.fields !== 'object' ||
        (draft.timerId === null
          ? draft.version !== null
          : typeof draft.version !== 'string' || !/^[0-9a-f]{64}$/.test(draft.version)))
    )
      throw new Error('updateRequired');
    if (draft && draft.timerId !== null && !uuid(draft.timerId)) throw new Error('updateRequired');
  }
  return s;
}

/** Only the background owns this store. No tokens pass through runtime UI messages. */
export class StateStore {
  private db?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('fin3000-timer', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('state');
      };
      request.onerror = () =>
        reject(
          new Error(request.error?.name === 'VersionError' ? 'updateRequired' : 'storageError'),
        );
      request.onblocked = () => reject(new Error('storageError'));
      request.onsuccess = () => resolve(request.result);
    });
    return this.db;
  }
  async read(): Promise<StoredState> {
    const db = await this.open();
    const value = await new Promise<StoredState | undefined>((resolve, reject) => {
      const request = db.transaction('state', 'readonly').objectStore('state').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('storageError'));
    });
    return value === undefined ? emptyState() : validateStoredState(value);
  }
  async write(value: StoredState): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
      tx.objectStore('state').put(value, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('storageError'));
      tx.onabort = () => reject(new Error('storageError'));
    });
  }
}
