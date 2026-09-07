export interface TimerConfig {
  profile: 'qa' | 'production';
  profileVersion: 1;
  protocolVersion: 1;
  extensionVersion: string;
  extensionId: string;
  oauthClientId: string;
  redirectUri: string;
  apiOrigin: string;
  frontendOrigin: string;
}
export interface Identity {
  id: string;
  name: string;
}
export interface Principal {
  protocolVersion: 1;
  subject: string;
  account: Identity;
  member: Identity;
  capabilities: Record<
    'read' | 'start' | 'update' | 'stop' | 'discard' | 'projects' | 'clients',
    boolean
  >;
  serverNow: string;
}
export interface ProjectChoice {
  id: string;
  name?: string;
  color?: string;
  active?: boolean;
  billableDefault?: boolean;
  restricted?: boolean;
  client?: Identity | null;
}
export interface RunningTimer {
  id: string;
  version: string;
  modifiedAt: string;
  start: string;
  description: string;
  billable: boolean;
  project: ProjectChoice | null;
  task: { id: string; name?: string; restricted?: boolean } | null;
}
export interface Snapshot {
  timer: RunningTimer | null;
  serverNow: string;
  commandWindow: string;
}
export type Action = 'start' | 'update' | 'stop' | 'discard';
export interface TimerFields {
  description?: string;
  project?: string | null;
  billable?: boolean;
  task?: null;
}
export interface CommandBody {
  commandId: string;
  commandWindow: string;
  expectedTimerId: string | null;
  expectedVersion: string | null;
  fields?: TimerFields;
}
export interface CommandResult {
  commandId: string;
  action: Action;
  outcome: 'applied';
  timerId: string | null;
  version: string | null;
  commandWindow?: string;
  timeEntryId: string | null;
  replacedTimerId: string | null;
  suspiciousDuration: boolean;
}
export interface Command {
  action: Action;
  body: CommandBody;
  subject: string;
  createdAt: number;
  deadline: number;
  attempted: boolean;
}
export interface Draft {
  subject: string;
  timerId: string | null;
  version: string | null;
  fields: TimerFields;
  expiresAt: number;
}
export interface Auth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshing: boolean;
}
export interface PendingCapture {
  text: string;
  attemptId: string;
  expiresAt: number;
}
export interface StoredState {
  schema: 1;
  epoch: number;
  auth: Auth | null;
  principal: Principal | null;
  snapshot: Snapshot | null;
  syncedAt: number;
  command: Command | null;
  stopIntent: { timerId: string; afterCommandId: string } | null;
  draft: Draft | null;
  recovery: Draft | null;
  pendingCapture: PendingCapture | null;
  connectionAttempt: string | null;
  notice: string | null;
  failures: number;
  retryAt: number;
}
export interface PublicState {
  connected: boolean;
  connecting: boolean;
  principal: Principal | null;
  snapshot: Snapshot | null;
  syncedAt: number;
  busy: Action | null;
  stopQueued: boolean;
  draft: Draft | null;
  recovery: Draft | null;
  notice: string | null;
  stale: boolean;
  retryAt: number;
}
export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
export type UIMessage =
  | {
      type: 'view' | 'sync' | 'acknowledge' | 'connect' | 'disconnect' | 'openApp' | 'dropRecovery';
    }
  | {
      type: 'draft';
      fields: TimerFields;
      timerId: string | null;
      version: string | null;
      subject: string;
    }
  | {
      type: 'command';
      action: Action;
      fields?: TimerFields;
      timerId: string | null;
      version: string | null;
    }
  | {
      type: 'choices';
      kind: 'projects' | 'clients';
      search: string;
      page: number;
      client?: string;
    };
