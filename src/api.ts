import { tokenRequest } from './oauth.js';
import type {
  Auth,
  Command,
  CommandResult,
  Page,
  Principal,
  ProjectChoice,
  Identity,
  Snapshot,
  TimerConfig,
} from './types.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public key: string,
    public retryAt = 0,
  ) {
    super(key);
  }
}
export interface AuthPort {
  get(): { auth: Auth | null; epoch: number };
  save(auth: Auth, epoch: number): Promise<void>;
  invalidate(epoch: number): Promise<void>;
}
const PREFIX = '/api/v1/timetracker/browser/';
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max;
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);
const version = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const date = (v: unknown): v is string => string(v, 50) && Number.isFinite(Date.parse(v));
function invalid(): never {
  throw new ApiError(0, 'updateRequired');
}

export function principalData(value: unknown): Principal {
  if (
    !isObject(value) ||
    value['protocolVersion'] !== 1 ||
    !string(value['subject'], 200) ||
    !date(value['serverNow'])
  )
    invalid();
  for (const key of ['account', 'member']) {
    const identity = value[key];
    if (!isObject(identity) || !id(identity['id']) || !string(identity['name'], 120)) invalid();
  }
  const caps = value['capabilities'];
  if (
    !isObject(caps) ||
    ['read', 'start', 'update', 'stop', 'discard', 'projects', 'clients'].some(
      (k) => typeof caps[k] !== 'boolean',
    )
  )
    invalid();
  return value as unknown as Principal;
}
export function snapshotData(value: unknown): Snapshot {
  if (!isObject(value) || !date(value['serverNow']) || !string(value['commandWindow'], 2048))
    invalid();
  const t = value['timer'];
  if (
    t !== null &&
    (!isObject(t) ||
      !id(t['id']) ||
      !version(t['version']) ||
      !date(t['start']) ||
      !date(t['modifiedAt']) ||
      !string(t['description'], 1000) ||
      typeof t['billable'] !== 'boolean' ||
      !(t['project'] === null || (isObject(t['project']) && id(t['project']['id']))) ||
      !(t['task'] === null || (isObject(t['task']) && id(t['task']['id']))))
  )
    invalid();
  return value as unknown as Snapshot;
}
export function resultData(value: unknown, command: Command): CommandResult {
  if (
    !isObject(value) ||
    value['commandId'] !== command.body.commandId ||
    value['action'] !== command.action ||
    value['outcome'] !== 'applied' ||
    !(value['timerId'] === null || id(value['timerId'])) ||
    !(value['version'] === null || version(value['version'])) ||
    !(value['timeEntryId'] === null || id(value['timeEntryId'])) ||
    typeof value['suspiciousDuration'] !== 'boolean'
  )
    invalid();
  if (
    ['start', 'update'].includes(command.action) &&
    (!id(value['timerId']) || !version(value['version']) || !string(value['commandWindow'], 2048))
  )
    invalid();
  if (
    ['stop', 'discard'].includes(command.action) &&
    (value['timerId'] !== null || value['version'] !== null)
  )
    invalid();
  if (command.action === 'update' && value['timerId'] !== command.body.expectedTimerId) invalid();
  return value as unknown as CommandResult;
}

export class TimerApi {
  private refreshing?: Promise<string>;
  constructor(
    private config: TimerConfig,
    private port: AuthPort,
  ) {}
  private async token(force = false): Promise<string> {
    const { auth, epoch } = this.port.get();
    if (!auth) throw new ApiError(401, 'connectAgain');
    if (this.refreshing) return this.refreshing;
    if (auth.refreshing) {
      await this.port.invalidate(epoch);
      throw new ApiError(401, 'connectAgain');
    }
    if (!force && auth.expiresAt > Date.now() + 60_000) return auth.accessToken;
    this.refreshing = (async () => {
      await this.port.save({ ...auth, refreshing: true }, epoch);
      try {
        const refreshed = await tokenRequest(this.config, {
          grant_type: 'refresh_token',
          refresh_token: auth.refreshToken,
        });
        await this.port.save(refreshed, epoch);
        if (this.port.get().epoch !== epoch) throw new ApiError(401, 'connectAgain');
        return refreshed.accessToken;
      } catch {
        await this.port.invalidate(epoch);
        throw new ApiError(401, 'connectAgain');
      }
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    if (
      !/^(principal|current|start|stop|discard|projects|clients)\/(\?[^#]*)?$|^receipts\/(start|update|stop|discard)\/[0-9a-f-]{36}\/$/.test(
        path,
      )
    )
      invalid();
    const epoch = this.port.get().epoch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt === 1);
      if (this.port.get().epoch !== epoch) throw new ApiError(401, 'connectAgain');
      let response: Response;
      try {
        response = await fetch(this.config.apiOrigin + PREFIX + path, {
          method,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal: AbortSignal.timeout(method === 'GET' ? 10_000 : 15_000),
          headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json',
            'Accept-Language': browser.i18n.getUILanguage(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        throw new ApiError(0, 'offline');
      }
      if (this.port.get().epoch !== epoch) throw new ApiError(401, 'connectAgain');
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 401) await this.port.invalidate(epoch);
      if (!response.ok) {
        const retry = response.headers.get('Retry-After');
        const retryAt = retry
          ? /^\d+$/.test(retry)
            ? Date.now() + Number(retry) * 1000
            : Date.parse(retry)
          : 0;
        throw new ApiError(
          response.status,
          response.status === 409
            ? 'conflict'
            : response.status === 403
              ? 'permissionDenied'
              : response.status === 429
                ? 'rateLimited'
                : response.status === 400
                  ? 'invalidInput'
                  : response.status === 401
                    ? 'connectAgain'
                    : 'serverError',
          Number.isFinite(retryAt) ? retryAt : 0,
        );
      }
      try {
        return await response.json();
      } catch {
        invalid();
      }
    }
    throw new ApiError(401, 'connectAgain');
  }
  async principal(): Promise<Principal> {
    return principalData(await this.request('principal/'));
  }
  async current(): Promise<Snapshot> {
    return snapshotData(await this.request('current/'));
  }
  async command(command: Command): Promise<CommandResult> {
    return resultData(
      await this.request(
        command.action === 'update' ? 'current/' : command.action + '/',
        command.action === 'update' ? 'PATCH' : 'POST',
        command.body,
      ),
      command,
    );
  }
  async receipt(command: Command): Promise<CommandResult | 'failed' | null> {
    let value;
    try {
      value = await this.request(`receipts/${command.action}/${command.body.commandId}/`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    if (
      !isObject(value) ||
      value['commandId'] !== command.body.commandId ||
      value['action'] !== command.action
    )
      invalid();
    if (value['status'] === 'failed' && [400, 409].includes(Number(value['responseStatus'])))
      return 'failed';
    if (value['status'] !== 'completed') invalid();
    return resultData(value['result'], command);
  }
  async choices(
    kind: 'projects' | 'clients',
    search: string,
    page: number,
    client?: string,
  ): Promise<Page<ProjectChoice | Identity>> {
    if (search.length > 200 || !Number.isInteger(page) || page < 1 || (client && !id(client)))
      throw new ApiError(400, 'invalidInput');
    const params = new URLSearchParams({ search, page: String(page), page_size: '200' });
    if (client && kind === 'projects') params.set('client', client);
    const value = await this.request(`${kind}/?${params}`);
    if (
      !isObject(value) ||
      !Array.isArray(value['results']) ||
      value['results'].length > 200 ||
      value['results'].some((v) => !isObject(v) || !id(v['id']) || !string(v['name'], 500))
    )
      invalid();
    // Pagination URLs are never followed: only this fixed API route is callable.
    return value as unknown as Page<ProjectChoice | Identity>;
  }
}
