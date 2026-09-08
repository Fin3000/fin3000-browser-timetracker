import { ApiError, TimerApi } from './api.js';
import { connectOAuth, revokeOAuth } from './oauth.js';
import { emptyState, StateStore } from './state.js';
import type {
  Action,
  Command,
  CommandResult,
  PublicState,
  StoredState,
  TimerConfig,
  TimerFields,
} from './types.js';

const DAY = 86_400_000;
const STALE = 75_000;
export function cleanFields(raw: unknown): TimerFields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalidInput');
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !['description', 'project', 'billable', 'task'].includes(k)) ||
    ('description' in v &&
      (typeof v['description'] !== 'string' || Array.from(v['description']).length > 500)) ||
    ('project' in v &&
      v['project'] !== null &&
      (typeof v['project'] !== 'string' || !/^[0-9a-f-]{36}$/.test(v['project']))) ||
    ('billable' in v && typeof v['billable'] !== 'boolean') ||
    ('task' in v && v['task'] !== null)
  )
    throw new Error('invalidInput');
  return structuredClone(v) as TimerFields;
}
export function badgeText(view: PublicState, now = Date.now()): string {
  if (!view.connected) return '';
  if (view.stale || view.busy) return '?';
  if (!view.snapshot?.timer) return '';
  const seconds = Math.max(
    0,
    (Date.parse(view.snapshot.serverNow) +
      now -
      view.syncedAt -
      Date.parse(view.snapshot.timer.start)) /
      1000,
  );
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : minutes < 6000 ? `${Math.floor(minutes / 60)}h` : '99h+';
}

/** A single durable writer; network waits never hold the state queue. */
export class TimerCoordinator {
  private state: StoredState = emptyState();
  private queue: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private syncing?: Promise<void>;
  private draining = false;
  private api: TimerApi;
  constructor(
    private config: TimerConfig,
    private store = new StateStore(),
  ) {
    this.ready = this.store.read().then(async (state) => {
      this.state = state;
      if (state.auth?.refreshing) {
        this.state = emptyState(state.epoch + 1);
        this.state.notice = 'connectAgain';
      }
      if (state.connectionAttempt) {
        this.state.connectionAttempt = null;
        this.state.pendingCapture = null;
        this.state.notice = 'connectionCancelled';
      }
      this.expireDrafts();
      await this.store.write(this.state);
    });
    this.api = new TimerApi(config, {
      get: () => ({ auth: this.state.auth, epoch: this.state.epoch }),
      save: (auth, epoch) =>
        this.edit(() => {
          if (this.state.epoch !== epoch) throw new Error('connectAgain');
          this.state.auth = auth;
        }),
      invalidate: (epoch) =>
        this.edit(() => {
          if (this.state.epoch === epoch) {
            this.state = emptyState(epoch + 1);
            this.state.notice = 'connectAgain';
          }
        }),
    });
  }
  private edit<T>(change: () => T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ready;
      const before = structuredClone(this.state);
      try {
        const value = change();
        await this.store.write(this.state);
        return value;
      } catch (error) {
        this.state = before;
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  private expireDrafts(): void {
    for (const key of ['draft', 'recovery', 'pendingCapture'] as const) {
      if (this.state[key] && this.state[key]!.expiresAt <= Date.now()) this.state[key] = null;
    }
  }
  async view(): Promise<PublicState> {
    await this.ready;
    const s = this.state;
    return structuredClone({
      connected: !!s.auth && !!s.principal,
      connecting: !!s.connectionAttempt,
      principal: s.principal,
      snapshot: s.snapshot,
      syncedAt: s.syncedAt,
      busy: s.command?.action || (s.pendingCapture?.start ? 'start' : null),
      stopQueued: !!s.stopIntent,
      draft: s.draft && s.draft.expiresAt > Date.now() ? s.draft : null,
      recovery: s.recovery && s.recovery.expiresAt > Date.now() ? s.recovery : null,
      notice: s.notice,
      stale:
        !s.syncedAt || Date.now() - s.syncedAt > STALE || Date.now() < s.syncedAt || !!s.failures,
      retryAt: s.retryAt,
    });
  }
  async connect(): Promise<void> {
    const attempt = crypto.randomUUID();
    const epoch = await this.edit(() => {
      if (this.state.connectionAttempt || this.state.auth) throw new Error('busy');
      this.state.epoch++;
      this.state.connectionAttempt = attempt;
      this.state.notice = null;
      if (this.state.pendingCapture) this.state.pendingCapture.attemptId = attempt;
      return this.state.epoch;
    });
    try {
      const auth = await connectOAuth(this.config);
      await this.edit(() => {
        if (this.state.epoch !== epoch || this.state.connectionAttempt !== attempt)
          throw new Error('connectionCancelled');
        this.state.auth = auth;
      });
      await this.sync(true);
      await this.edit(() => {
        if (this.state.epoch !== epoch || !this.state.principal)
          throw new Error('connectionCancelled');
        this.expireDrafts();
        const capture = this.state.pendingCapture;
        if (capture?.attemptId === attempt) {
          this.state.draft = {
            subject: this.state.principal.subject,
            timerId: null,
            version: null,
            fields: { description: capture.text },
            expiresAt: Date.now() + DAY,
          };
          this.state.notice = 'captureReady';
        }
        this.state.pendingCapture = null;
        this.state.connectionAttempt = null;
      });
    } catch {
      await this.edit(() => {
        if (this.state.epoch === epoch) {
          this.state = emptyState(epoch + 1);
          this.state.notice = 'connectionCancelled';
        }
      });
    }
  }
  async disconnect(): Promise<void> {
    const auth = await this.edit(() => {
      const previous = this.state.auth;
      this.state = emptyState(this.state.epoch + 1);
      this.state.notice = 'disconnected';
      return previous;
    });
    if (auth) void revokeOAuth(this.config, auth);
  }
  async sync(force = false): Promise<void> {
    await this.ready;
    if (this.syncing) return this.syncing;
    if (!this.state.auth || (!force && this.state.retryAt > Date.now())) return;
    const epoch = this.state.epoch;
    this.syncing = (async () => {
      try {
        const principal = await this.api.principal();
        const snapshot = await this.api.current();
        await this.edit(() => {
          if (this.state.epoch !== epoch) return;
          const old = this.state.principal?.subject;
          if (old && old !== principal.subject) {
            this.state.draft = null;
            this.state.recovery = null;
            this.state.command = null;
            this.state.stopIntent = null;
          }
          this.state.principal = principal;
          this.state.snapshot = snapshot;
          this.state.syncedAt = Date.now();
          this.state.failures = 0;
          this.state.retryAt = 0;
          if (['offline', 'serverError', 'rateLimited'].includes(this.state.notice || ''))
            this.state.notice = null;
          if (this.state.draft?.timerId && this.state.draft.timerId !== snapshot.timer?.id) {
            this.state.recovery = this.state.draft;
            this.state.draft = null;
          }
          this.expireDrafts();
        });
      } catch (error) {
        await this.failure(error, epoch);
      }
    })();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
    }
  }
  private async failure(error: unknown, epoch: number): Promise<void> {
    await this.edit(() => {
      if (this.state.epoch !== epoch) return;
      this.state.notice = error instanceof ApiError ? error.key : 'serverError';
      this.state.failures++;
      const delay = Math.min(15, 2 ** Math.min(4, this.state.failures - 1)) * 60_000;
      this.state.retryAt = Math.max(
        Date.now() + delay,
        error instanceof ApiError ? error.retryAt : 0,
      );
    });
  }
  async draft(
    fields: unknown,
    timerId: string | null,
    subject: string,
    version?: string | null,
  ): Promise<void> {
    const cleaned = cleanFields(fields);
    await this.edit(() => {
      if (
        !this.state.principal ||
        subject !== this.state.principal.subject ||
        (timerId && timerId !== this.state.snapshot?.timer?.id)
      )
        throw new Error('conflict');
      const base =
        this.state.draft?.timerId === timerId
          ? this.state.draft.version
          : (version ?? this.state.snapshot?.timer?.version ?? null);
      this.state.draft = {
        subject,
        timerId,
        version: timerId ? base : null,
        fields: cleaned,
        expiresAt: Date.now() + DAY,
      };
    });
  }
  async dropRecovery(): Promise<void> {
    await this.edit(() => {
      this.state.recovery = null;
    });
  }
  async acknowledge(): Promise<void> {
    await this.sync(true);
    await this.edit(() => {
      const draft = this.state.draft;
      if (
        !this.state.failures &&
        draft?.timerId &&
        draft.version !== this.state.snapshot?.timer?.version
      ) {
        this.state.recovery = draft;
        this.state.draft = null;
      }
    });
  }
  async notice(key: string): Promise<void> {
    await this.edit(() => {
      this.state.notice = key;
    });
  }
  async capture(text: string | null): Promise<void> {
    if (!text) { await this.notice('manualCapture'); return; }
    cleanFields({ description: text });
    await this.edit(() => {
      const s = this.state;
      if (s.command || s.pendingCapture?.start) throw new Error('busy');
      const connected = !!s.auth && !!s.principal && !s.connectionAttempt;
      s.pendingCapture = {
        text, expiresAt: Date.now() + (connected ? 60_000 : 600_000), attemptId: '',
        ...(connected ? { start: { subject: s.principal!.subject,
          timerId: s.snapshot?.timer?.id || null,
          version: s.snapshot?.timer?.version || null } } : {}),
      };
      s.notice = connected ? 'checking' : 'connectForCapture';
    });
    await this.resumeCapture();
  }
  private async resumeCapture(): Promise<void> {
    await this.ready;
    if (!this.state.pendingCapture?.start || !this.state.auth) return;
    await this.sync(true);
    await this.edit(() => {
      const s = this.state;
      this.expireDrafts();
      const capture = s.pendingCapture;
      if (!capture?.start || !s.auth || !s.principal || !s.snapshot || s.command) return;
      if (s.failures || s.retryAt > Date.now() || !s.syncedAt || Date.now() - s.syncedAt > STALE) return;
      s.pendingCapture = null;
      if (capture.start.subject !== s.principal.subject ||
          capture.start.timerId !== (s.snapshot.timer?.id || null) ||
          capture.start.version !== (s.snapshot.timer?.version || null)) {
        s.notice = 'conflict'; return;
      }
      if (!s.principal.capabilities.start) { s.notice = 'permissionDenied'; return; }
      // Consume the intent and persist the immutable command in one transaction.
      s.command = this.makeCommand('start', { description: capture.text });
      s.notice = 'checking';
    });
    void this.drain();
  }
  private makeCommand(
    action: Action,
    fields?: TimerFields,
    expected?: { id: string; version: string; window: string },
  ): Command {
    const snapshot = this.state.snapshot!;
    return {
      action,
      subject: this.state.principal!.subject,
      createdAt: Date.now(),
      deadline: expected ? Date.now() + 290_000 : this.state.syncedAt + 290_000,
      attempted: false,
      body: {
        commandId: crypto.randomUUID(),
        commandWindow: expected?.window || snapshot.commandWindow,
        expectedTimerId: expected?.id || snapshot.timer?.id || null,
        expectedVersion: expected?.version || snapshot.timer?.version || null,
        ...(fields === undefined ? {} : { fields }),
      },
    };
  }
  async accept(
    action: Action,
    raw: unknown,
    timerId: string | null,
    version: string | null,
  ): Promise<void> {
    const fields = raw === undefined ? undefined : cleanFields(raw);
    await this.edit(() => {
      const s = this.state;
      if (!s.auth || !s.principal || !s.snapshot) throw new Error('connectAgain');
      if (s.pendingCapture?.start) throw new Error('busy');
      if (!s.principal.capabilities[action]) throw new Error('permissionDenied');
      if (
        s.snapshot.timer?.id !== (timerId || undefined) ||
        s.snapshot.timer?.version !== (version || undefined)
      )
        throw new Error('conflict');
      if (s.command) {
        if (
          action === 'stop' &&
          s.command.action === 'update' &&
          timerId &&
          s.command.body.expectedTimerId === timerId
        ) {
          s.stopIntent = { timerId, afterCommandId: s.command.body.commandId };
          return;
        }
        throw new Error('busy');
      }
      if (
        s.retryAt > Date.now() ||
        Date.now() - s.syncedAt > STALE ||
        Date.now() < s.syncedAt ||
        s.failures
      )
        throw new Error('refreshFirst');
      if (action !== 'start' && !timerId) throw new Error('conflict');
      if (['stop', 'discard'].includes(action) && fields !== undefined)
        throw new Error('invalidInput');
      s.command = this.makeCommand(action, fields);
      s.notice = 'checking';
    });
    void this.drain();
  }
  private async finish(command: Command, result: CommandResult | 'failed'): Promise<void> {
    await this.edit(() => {
      const s = this.state;
      if (
        s.command?.body.commandId !== command.body.commandId ||
        s.principal?.subject !== command.subject
      )
        return;
      s.command = null;
      s.notice =
        result === 'failed' ? 'conflict' : result.suspiciousDuration ? 'longTimer' : 'confirmed';
      if (result === 'failed') {
        s.stopIntent = null;
        return;
      }
      if (s.draft && ['stop', 'discard'].includes(command.action)) {
        s.recovery = s.draft;
        s.draft = null;
      }
      if (s.draft && ['update', 'start'].includes(command.action)) {
        // Captures are partial drafts; submitting also adds project/billable.
        // Clear only fields covered by this receipt, preserving edits made later.
        const saved = command.body.fields || {};
        if (
          Object.entries(s.draft.fields).every(
            ([key, value]) => saved[key as keyof TimerFields] === value,
          )
        )
          s.draft = null;
        else {
          s.draft.timerId = result.timerId;
          s.draft.version = result.version;
        }
      }
      if (
        s.stopIntent?.afterCommandId === command.body.commandId &&
        command.action === 'update' &&
        result.timerId === s.stopIntent.timerId &&
        result.version &&
        result.commandWindow
      ) {
        // The receipt's exact version is authoritative for this queued Stop.
        s.command = this.makeCommand('stop', undefined, {
          id: result.timerId,
          version: result.version,
          window: result.commandWindow,
        });
        s.notice = 'checking';
      }
      s.stopIntent = null;
      // A fresh snapshot is required before accepting unrelated actions.
      s.syncedAt = 0;
    });
    if (result !== 'failed')
      void browser.notifications
        .create('timer-result', {
          type: 'basic',
          iconUrl: browser.runtime.getURL('icon.png'),
          title: browser.i18n.getMessage('extensionName'),
          message: browser.i18n.getMessage('confirmed'),
        })
        .catch(() => undefined);
  }
  async drain(): Promise<void> {
    await this.ready;
    if (this.draining || !this.state.command || !this.state.auth || this.state.retryAt > Date.now())
      return;
    this.draining = true;
    try {
      while (this.state.command && this.state.auth && this.state.retryAt <= Date.now()) {
        const command = structuredClone(this.state.command);
        const epoch = this.state.epoch;
        try {
          let result = command.attempted ? await this.api.receipt(command) : null;
          if (result === null) {
            if (Date.now() >= command.deadline) {
              await this.edit(() => {
                if (this.state.epoch !== epoch) return;
                this.state.command = null;
                this.state.stopIntent = null;
                this.state.notice = 'expiredAction';
                this.state.syncedAt = 0;
              });
              break;
            }
            await this.edit(() => {
              if (this.state.command?.body.commandId === command.body.commandId)
                this.state.command.attempted = true;
            });
            result = await this.api.command(command);
          }
          if (this.state.epoch === epoch) await this.finish(command, result);
        } catch (error) {
          if (this.state.epoch !== epoch) break;
          if (error instanceof ApiError && [400, 403, 409].includes(error.status)) {
            // A definitive server rejection has no unconfirmed success effect.
            await this.finish(command, 'failed');
            if (error.status === 403) await this.notice('permissionDenied');
          } else {
            await this.failure(error, epoch);
            break;
          }
        }
      }
    } finally {
      this.draining = false;
    }
    await this.sync();
  }
  async choices(
    kind: 'projects' | 'clients',
    search: string,
    page: number,
    client?: string,
  ): Promise<unknown> {
    await this.ready;
    if (!this.state.principal?.capabilities[kind]) throw new Error('permissionDenied');
    const epoch = this.state.epoch;
    const result = await this.api.choices(kind, search, page, client);
    if (epoch !== this.state.epoch) throw new Error('connectAgain');
    return result;
  }
  async tick(): Promise<void> {
    // Retention also advances while disconnected or offline.
    await this.edit(() => this.expireDrafts());
    await this.resumeCapture();
    await this.drain();
    await this.sync();
  }
}
