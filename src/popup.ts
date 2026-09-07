import type {
  Identity,
  Page,
  ProjectChoice,
  PublicState,
  TimerFields,
  UIMessage,
} from './types.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const t = (key: string): string =>
  browser.i18n.getMessage(key) || browser.i18n.getMessage('serverError');
const description = $<HTMLTextAreaElement>('description');
const project = createPicker('project', 'projects');
const client = createPicker('client', 'clients');
const billable = $<HTMLInputElement>('billable');
const save = $<HTMLButtonElement>('save');
const stop = $<HTMLButtonElement>('stop');
let view: PublicState | null = null;
let formKey = '',
  dirty = false,
  inFlight = false,
  loadingView = false;
let selectedProject: ProjectChoice | null = null;
let baseline: TimerFields = {};
let baselineVersion: string | null = null;
let clockBase = 0,
  clockAt = 0;
let lastClockSnapshot = '';
let projects = new Map<string, ProjectChoice>();
const pages = { projects: 1, clients: 1 };
const generations = { projects: 0, clients: 0 };
const debounces: Partial<Record<'projects' | 'clients', ReturnType<typeof setTimeout>>> = {};
let draftQueue: Promise<unknown> = Promise.resolve();

function notice(key: string): void {
  $('notice').textContent = t(key);
  $('notice').hidden = false;
}
function fields(): TimerFields {
  return {
    description: description.value.normalize('NFC'),
    project: project.value || null,
    billable: billable.checked,
  };
}
function isNewDraft(): boolean {
  return !!view?.draft && view.draft.timerId === null;
}
function targetId(): string | null {
  return isNewDraft() ? null : view?.snapshot?.timer?.id || null;
}
function sameFields(a: TimerFields, b: TimerFields): boolean {
  return (
    (a.description || '') === (b.description || '') &&
    (a.project || null) === (b.project || null) &&
    (a.billable ?? true) === (b.billable ?? true)
  );
}
async function send(message: UIMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await browser.runtime.sendMessage(message);
    if (!raw || typeof raw !== 'object') throw new Error();
    const result = raw as Record<string, unknown>;
    if (!result['ok']) {
      const key = typeof result['error'] === 'string' ? result['error'] : 'serverError';
      notice(key);
      if (['configuration', 'updateRequired', 'storageError'].includes(key)) {
        for (const control of document.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        >('button:not(#refresh),input,select,textarea'))
          control.disabled = true;
      }
      return null;
    }
    if (result['view']) render(result['view'] as PublicState);
    return result;
  } catch {
    notice('serverError');
    return null;
  }
}
type ChoiceKind = 'projects' | 'clients';
interface Picker {
  kind: ChoiceKind;
  input: HTMLInputElement;
  panel: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  clear: HTMLButtonElement;
  more: HTMLButtonElement;
  value: string;
  label: string;
  query: string;
  items: (ProjectChoice | Identity)[];
  open: boolean;
  loading: boolean;
  error: boolean;
  hasMore: boolean;
  active: number;
}
function pickerFor(kind: ChoiceKind): Picker {
  return kind === 'projects' ? project : client;
}
function emptyLabel(p: Picker): string {
  return t(p.kind === 'projects' ? 'noProject' : 'allClients');
}
function setPickerValue(p: Picker, value: string, label = ''): void {
  p.value = value;
  p.label = label;
  p.input.dataset['value'] = value;
  p.input.title = label;
  if (!p.open) p.input.value = value ? label : '';
  p.clear.hidden = !value;
}
function closePicker(p: Picker): void {
  if (!p.open) return;
  p.open = false;
  p.panel.hidePopover();
  p.input.setAttribute('aria-expanded', 'false');
  p.input.removeAttribute('aria-activedescendant');
  p.input.value = p.value ? p.label : '';
  p.input.placeholder = emptyLabel(p);
}
function positionPicker(p: Picker): void {
  if (!p.open) return;
  const main = document.querySelector('main')!.getBoundingClientRect();
  let rect = p.input.getBoundingClientRect();
  if (rect.bottom <= main.top || rect.top >= main.bottom) {
    closePicker(p);
    return;
  }
  let above = rect.top - main.top - 4;
  let below = main.bottom - rect.bottom - 4;
  if (Math.max(above, below) < 48) {
    p.input.scrollIntoView({ block: 'start' });
    rect = p.input.getBoundingClientRect();
    above = rect.top - main.top - 4;
    below = main.bottom - rect.bottom - 4;
  }
  const upward = above > below;
  const height = Math.max(44, Math.min(208, upward ? above : below));
  p.panel.style.width = `${rect.width}px`;
  p.panel.style.left = `${rect.left}px`;
  p.panel.style.maxHeight = `${height}px`;
  p.panel.style.top = `${Math.max(main.top, Math.min(main.bottom - height, upward ? rect.top - height - 4 : rect.bottom + 4))}px`;
  // The panel shrinks to its contents; anchor its bottom when opening upward.
  p.panel.style.transform = '';
  if (upward) {
    const actual = p.panel.getBoundingClientRect().height;
    p.panel.style.top = `${Math.max(main.top, rect.top - actual - 4)}px`;
  }
}
function highlightOption(p: Picker, index: number, scroll = false): void {
  const rows = Array.from(p.list.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  p.active = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
  rows.forEach((row, i) => row.classList.toggle('active', i === p.active));
  const active = rows[p.active];
  if (active && p.open) {
    p.input.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  } else p.input.removeAttribute('aria-activedescendant');
}
function choose(p: Picker, value: ProjectChoice | Identity | null): void {
  closePicker(p);
  setPickerValue(
    p,
    value?.id || '',
    value ? (p.kind === 'projects' ? projectLabel(value as ProjectChoice) : value.name || '') : '',
  );
  if (p.kind === 'projects') {
    selectedProject = value as ProjectChoice | null;
    if (!view?.snapshot?.timer && selectedProject?.billableDefault !== undefined)
      billable.checked = selectedProject.billableDefault;
    persistDraft();
  } else {
    project.query = '';
    generations.projects++;
    void loadChoices('projects');
  }
}
function drawPicker(p: Picker): void {
  p.list.replaceChildren();
  p.list.setAttribute('aria-busy', String(p.loading));
  p.status.hidden = !p.loading && !p.error && !!p.items.length;
  p.status.textContent = t(p.loading ? 'loading' : p.error ? 'pickerError' : 'noResults');
  p.more.hidden = !p.hasMore || p.error;
  p.more.disabled = p.loading;
  const values: (ProjectChoice | Identity | null)[] =
    p.loading || p.error ? [] : [...(!p.query.trim() ? [null] : []), ...p.items];
  for (const [index, value] of values.entries()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.tabIndex = -1;
    row.className = 'picker-option';
    row.id = `${p.input.id}-option-${index}`;
    row.dataset['value'] = value?.id || '';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String((value?.id || '') === p.value));
    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = value?.name || emptyLabel(p);
    row.append(name);
    if (p.kind === 'projects' && value) {
      const item = value as ProjectChoice;
      const detail = [item.client?.name, item.active === false ? t('archived') : '']
        .filter(Boolean)
        .join(' · ');
      if (detail) {
        const secondary = document.createElement('span');
        secondary.className = 'option-detail';
        secondary.textContent = detail;
        row.append(secondary);
      }
    }
    row.addEventListener('mousedown', (event) => event.preventDefault());
    row.addEventListener('click', () => choose(p, value));
    p.list.append(row);
  }
  highlightOption(
    p,
    Math.max(
      0,
      values.findIndex((v) => (v?.id || '') === p.value),
    ),
  );
  positionPicker(p);
}
function openPicker(p: Picker, query = ''): void {
  if (p.open || p.input.disabled) return;
  closePicker(p.kind === 'projects' ? client : project);
  p.open = true;
  p.query = query;
  p.input.value = query;
  p.input.placeholder = t(p.kind === 'projects' ? 'searchProjects' : 'searchClients');
  p.input.scrollIntoView({ block: 'nearest' });
  p.panel.showPopover();
  p.input.setAttribute('aria-expanded', 'true');
  void loadChoices(p.kind);
}
function createPicker(id: 'project' | 'client', kind: ChoiceKind): Picker {
  const p: Picker = {
    kind,
    input: $<HTMLInputElement>(id),
    panel: $(id + '-panel'),
    list: $(id + '-options'),
    status: $(id + '-status'),
    clear: $<HTMLButtonElement>(id + '-clear'),
    more: $<HTMLButtonElement>('more-' + kind),
    value: '',
    label: '',
    query: '',
    items: [],
    open: false,
    loading: false,
    error: false,
    hasMore: false,
    active: -1,
  };
  p.input.addEventListener('focus', () => openPicker(p));
  p.input.addEventListener('click', () => openPicker(p));
  p.input.addEventListener('input', () => {
    if (!p.open) openPicker(p, p.input.value);
    p.query = p.input.value;
    p.loading = true;
    p.error = false;
    generations[kind]++;
    clearTimeout(debounces[kind]);
    drawPicker(p);
    debounces[kind] = setTimeout(() => {
      void loadChoices(kind);
    }, 250);
  });
  p.input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!p.open) openPicker(p);
      else highlightOption(p, p.active + (event.key === 'ArrowDown' ? 1 : -1), true);
    } else if (event.key === 'Enter' && p.open) {
      event.preventDefault();
      p.list.querySelectorAll<HTMLButtonElement>('[role="option"]')[p.active]?.click();
    } else if (event.key === 'Escape' && p.open) {
      event.preventDefault();
      event.stopPropagation();
      closePicker(p);
    } else if (event.key === 'Tab') closePicker(p);
  });
  p.clear.addEventListener('mousedown', (event) => event.preventDefault());
  p.clear.addEventListener('click', () => choose(p, null));
  p.more.addEventListener('mousedown', (event) => event.preventDefault());
  p.more.addEventListener('click', () => {
    void loadChoices(kind, true);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$(id + '-picker').contains(event.target as Node)) closePicker(p);
  });
  document.addEventListener('focusin', (event) => {
    if (!$(id + '-picker').contains(event.target as Node)) closePicker(p);
  });
  return p;
}

function projectLabel(value: ProjectChoice): string {
  return value.restricted
    ? t('restricted')
    : (value.name || t('noProject')) +
        (value.client ? ' · ' + value.client.name : '') +
        (value.active === false ? ' · ' + t('archived') : '');
}
function updateButtons(): void {
  if (!view) return;
  const running = view.snapshot?.timer;
  const action = running && !isNewDraft() ? 'update' : 'start';
  const conflicted = !!running && !isNewDraft() && baselineVersion !== running.version;
  dirty = !sameFields(fields(), baseline);
  $('length').textContent = `${Array.from(description.value).length} / 500`;
  save.textContent = t(action === 'update' ? 'save' : 'start');
  save.disabled =
    conflicted ||
    inFlight ||
    !!view.busy ||
    view.stale ||
    !view.principal?.capabilities[action] ||
    (action === 'update' && !dirty) ||
    Array.from(description.value.normalize('NFC')).length > 500;
  stop.hidden = !running;
  stop.disabled =
    conflicted ||
    inFlight ||
    !view.principal?.capabilities.stop ||
    view.stopQueued ||
    (view.busy !== 'update' && (!!view.busy || view.stale));
  stop.textContent = t(view.stopQueued ? 'stopQueued' : 'stop');
  $('dirty-note').hidden = !running || !dirty;
  $('discard-panel').hidden = !running || !view.principal?.capabilities.discard;
  $<HTMLButtonElement>('discard').disabled = conflicted || inFlight || !!view.busy || view.stale;
  if (conflicted && !view.busy) notice('conflict');
  const oldProject = running?.project?.id || null;
  $('task').hidden = !running?.task;
  if (running?.task)
    $('task').textContent =
      (project.value || null) !== oldProject
        ? t('taskCleared')
        : `${t('task')}: ${running.task.name || t('restricted')}`;
}
function render(next: PublicState): void {
  const oldSubject = view?.principal?.subject;
  view = next;
  if (oldSubject !== next.principal?.subject) {
    projects = new Map();
    for (const p of [project, client]) {
      closePicker(p);
      setPickerValue(p, '');
      p.items = [];
      p.query = '';
    }
    formKey = '';
    dirty = false;
    generations.projects++;
    generations.clients++;
  }
  $('connection').hidden = next.connected;
  $('editor').hidden = !next.connected;
  $('editor-actions').hidden = !next.connected;
  $('timer-form').setAttribute('aria-busy', String(!!next.busy));
  $('disconnect').hidden = !next.connected && !next.connecting;
  $<HTMLButtonElement>('connect').disabled = next.connecting;
  $('connect').textContent = t(next.connecting ? 'connecting' : 'connect');
  $('timer-status').textContent = t(
    next.connected && next.stale ? 'checking' : next.snapshot?.timer ? 'running' : 'idle',
  );
  $('saved-title').textContent =
    next.snapshot?.timer?.description || (next.snapshot?.timer ? t('untitled') : '');
  $('notice').hidden = !next.notice || next.notice === 'confirmed';
  if (next.notice) $('notice').textContent = t(next.notice);
  $('sync-status').textContent = t(next.stale ? 'stale' : 'synced');
  const timer = next.snapshot?.timer;
  const clockKey = `${next.syncedAt}:${timer?.id}:${next.snapshot?.serverNow}`;
  if (clockKey !== lastClockSnapshot) {
    lastClockSnapshot = clockKey;
    clockAt = performance.now();
    clockBase =
      timer && next.snapshot && next.syncedAt
        ? Math.max(
            0,
            Date.parse(next.snapshot.serverNow) +
              Math.max(0, Date.now() - next.syncedAt) -
              Date.parse(timer.start),
          )
        : 0;
  }
  if (!next.connected) {
    stop.hidden = true;
    tickClock();
    return;
  }
  $('account').textContent = next.principal!.account.name;
  $('member').textContent = next.principal!.member.name;
  const key = `${next.principal!.subject}:${isNewDraft() ? 'new' : timer?.id || 'idle'}`;
  if (formKey !== key || (!dirty && !inFlight && !next.busy)) {
    const newForm = formKey !== key;
    formKey = key;
    baseline = {
      description: isNewDraft() ? '' : timer?.description || '',
      project: isNewDraft() ? null : timer?.project?.id || null,
      billable: isNewDraft() ? true : (timer?.billable ?? true),
    };
    baselineVersion =
      next.draft?.timerId && next.draft.timerId === timer?.id
        ? next.draft.version
        : timer?.version || null;
    const restored =
      next.draft &&
      next.draft.subject === next.principal!.subject &&
      next.draft.timerId === targetId()
        ? { ...baseline, ...next.draft.fields }
        : baseline;
    description.value = restored.description || '';
    billable.checked = restored.billable ?? true;
    selectedProject = timer?.project || null;
    const restoredChoice = projects.get(restored.project || '') || selectedProject;
    setPickerValue(
      project,
      restored.project || '',
      restoredChoice ? projectLabel(restoredChoice) : t('project'),
    );
    if (newForm) {
      void loadChoices('projects');
      void loadChoices('clients');
    }
  }
  for (const p of [project, client]) {
    p.input.disabled = !next.principal?.capabilities[p.kind];
    p.clear.disabled = p.input.disabled;
    if (p.input.disabled) closePicker(p);
  }
  $('recovery').hidden = !next.recovery;
  if (next.recovery)
    $('recovery-text').textContent = next.recovery.fields.description || t('untitled');
  if (next.draft?.timerId && next.draft.timerId === timer?.id) baselineVersion = next.draft.version;
  updateButtons();
  tickClock();
}
function tickClock(): void {
  const ms = view?.snapshot?.timer ? clockBase + Math.max(0, performance.now() - clockAt) : 0;
  const total = Math.floor(ms / 1000);
  $('elapsed').textContent = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
}
function persistDraft(): void {
  updateButtons();
  if (!view?.principal) return;
  const msg: UIMessage = {
    type: 'draft',
    fields: fields(),
    timerId: targetId(),
    version: baselineVersion,
    subject: view.principal.subject,
  };
  // Send immediately, preserving input order; accepted drafts outlive the popup.
  draftQueue = draftQueue.then(() => send(msg));
}
async function loadChoices(kind: ChoiceKind, more = false): Promise<void> {
  if (!view?.principal?.capabilities[kind]) return;
  const p = pickerFor(kind);
  const generation = ++generations[kind];
  const subject = view.principal.subject;
  const page = more ? pages[kind] + 1 : 1;
  p.loading = true;
  p.error = false;
  drawPicker(p);
  const result = await send({
    type: 'choices',
    kind,
    search: p.query,
    page,
    ...(kind === 'projects' && client.value ? { client: client.value } : {}),
  });
  if (generation !== generations[kind] || subject !== view?.principal?.subject) return;
  p.loading = false;
  if (!result) {
    p.error = true;
    drawPicker(p);
    return;
  }
  const data = result['page'] as Page<ProjectChoice | Identity>;
  p.items = Array.from(
    new Map([...(more ? p.items : []), ...data.results].map((value) => [value.id, value])).values(),
  );
  for (const value of data.results)
    if (kind === 'projects') projects.set(value.id, value as ProjectChoice);
  const selected = p.items.find((value) => value.id === p.value);
  if (selected)
    setPickerValue(
      p,
      p.value,
      kind === 'projects' ? projectLabel(selected as ProjectChoice) : selected.name || '',
    );
  pages[kind] = page;
  p.hasMore = !!data.next;
  drawPicker(p);
}
async function command(action: 'start' | 'update' | 'stop' | 'discard'): Promise<void> {
  if (!view || inFlight) return;
  inFlight = true;
  updateButtons();
  const running = view.snapshot?.timer;
  const input = fields();
  const result = await send({
    type: 'command',
    action,
    timerId: running?.id || null,
    version: action === 'start' ? running?.version || null : baselineVersion,
    ...(['start', 'update'].includes(action) ? { fields: input } : {}),
  });
  if (result && ['start', 'update'].includes(action)) {
    baseline = input;
    dirty = false;
  }
  inFlight = false;
  updateButtons();
}
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]'))
  el.textContent = t(el.dataset['i18n']!);
for (const [attribute, dataset] of [
  ['placeholder', 'i18nPlaceholder'],
  ['aria-label', 'i18nLabel'],
  ['title', 'i18nTitle'],
]) {
  for (const el of document.querySelectorAll<HTMLElement>(
    '[data-i18n-' + (attribute === 'aria-label' ? 'label' : attribute) + ']',
  )) {
    el.setAttribute(attribute, t(el.dataset[dataset]!));
    if (attribute === 'title') el.setAttribute('aria-label', t(el.dataset[dataset]!));
  }
}
// Popup viewport units are circular during Firefox's initial autosizing.
function fitPopup(): void {
  const width = `${Math.max(320, Math.min(360, screen.availWidth - 32))}px`;
  document.documentElement.style.width = width;
  document.body.style.width = width;
  document.body.style.height = `${Math.max(300, Math.min(580, screen.availHeight - 100))}px`;
}
fitPopup();
window.addEventListener('resize', fitPopup);
document.documentElement.lang = browser.i18n.getUILanguage();
document.documentElement.dir = /^(ar|fa|he|ur)\b/.test(document.documentElement.lang)
  ? 'rtl'
  : 'ltr';
description.addEventListener('input', persistDraft);
billable.addEventListener('change', persistDraft);
document.querySelector('main')!.addEventListener('scroll', () => {
  positionPicker(project);
  positionPicker(client);
});
window.addEventListener('resize', () => {
  positionPicker(project);
  positionPicker(client);
});
$('timer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!save.disabled) void command(view?.snapshot?.timer && !isNewDraft() ? 'update' : 'start');
});
stop.addEventListener('click', () => {
  void command('stop');
});
$('discard').addEventListener('click', () => {
  void command('discard');
});
$('connect').addEventListener('click', () => {
  void send({ type: 'connect' });
});
$('disconnect').addEventListener('click', () => {
  void send({ type: 'disconnect' });
});
$('drop-recovery').addEventListener('click', () => {
  void send({ type: 'dropRecovery' });
});
$('open-app').addEventListener('click', () => {
  void send({ type: 'openApp' });
});
$('refresh').addEventListener('click', () => {
  dirty = false;
  formKey = '';
  void send({ type: 'acknowledge' });
});
async function poll(): Promise<void> {
  if (loadingView) return;
  loadingView = true;
  await send({ type: 'view' });
  loadingView = false;
}
void poll();
void send({ type: 'sync' });
setInterval(() => {
  void poll();
}, 1000);
setInterval(() => {
  void send({ type: 'sync' });
}, 15_000);
setInterval(tickClock, 1000);
