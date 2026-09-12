import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  repoRoot,
  timerRoot,
  loadTimerProfile,
  parseArgs,
  runNode,
} from './timer-extension-cli.mjs';
import { buildTimer } from './build-timer-extension.mjs';
import { inspectTimer } from './inspect-timer-extension.mjs';

let temp,
  Coordinator,
  ApiError,
  emptyState,
  validateStoredState,
  cleanFields,
  badgeText,
  validateConfig;
const ownerId = 'a0000000-0000-4000-8000-000000000001';
const memberId = 'a0000000-0000-4000-8000-000000000002';
const timerId = 'a0000000-0000-4000-8000-000000000003';
const oldVersion = 'a'.repeat(64),
  newVersion = 'b'.repeat(64);
const subject = `tt_${ownerId}_${memberId}_0`;
const principal = {
  protocolVersion: 1,
  subject,
  account: { id: ownerId, name: 'QA account' },
  member: { id: memberId, name: 'QA member' },
  capabilities: Object.fromEntries(
    ['read', 'start', 'update', 'stop', 'discard', 'projects', 'clients'].map((k) => [k, true]),
  ),
  serverNow: new Date().toISOString(),
};
function snapshot(running = true, version = oldVersion) {
  return {
    timer: running
      ? {
          id: timerId,
          version,
          modifiedAt: new Date().toISOString(),
          start: new Date(Date.now() - 120_000).toISOString(),
          description: 'Saved',
          billable: true,
          project: null,
          task: null,
        }
      : null,
    serverNow: new Date().toISOString(),
    commandWindow: 'signed-window',
  };
}
function result(command, version = newVersion) {
  const live = ['start', 'update'].includes(command.action);
  return {
    commandId: command.body.commandId,
    action: command.action,
    outcome: 'applied',
    timerId: live ? timerId : null,
    version: live ? version : null,
    commandWindow: live ? 'receipt-window' : undefined,
    timeEntryId: command.action === 'stop' ? ownerId : null,
    replacedTimerId: null,
    suspiciousDuration: false,
  };
}
const until = async (condition) => {
  for (let i = 0; i < 1000; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Background condition did not settle');
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function harness(running = true) {
  let stored = {
    ...emptyState(),
    auth: {
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      expiresAt: Date.now() + 3600_000,
      refreshing: false,
    },
    principal,
    snapshot: snapshot(running),
    syncedAt: Date.now(),
  };
  const store = {
    read: async () => structuredClone(stored),
    write: async (value) => {
      stored = structuredClone(value);
    },
  };
  const coordinator = new Coordinator(await loadTimerProfile('qa'), store);
  await coordinator.view();
  coordinator.api = {
    principal: async () => principal,
    current: async () => snapshot(running),
    receipt: async () => null,
    command: async (command) => result(command),
  };
  return { coordinator, read: () => structuredClone(stored) };
}
before(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'fin3000-timer-tests-'));
  await writeFile(path.join(temp, 'package.json'), '{"type":"module"}');
  runNode(
    [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(timerRoot, 'tsconfig.json'),
      '--outDir',
      temp,
    ],
    'compile test modules',
  );
  const load = (name) => import(pathToFileURL(path.join(temp, name + '.js')));
  ({ TimerCoordinator: Coordinator, cleanFields, badgeText } = await load('coordinator'));
  ({ ApiError } = await load('api'));
  ({ emptyState, validateStoredState } = await load('state'));
  ({ validateConfig } = await load('config'));
  globalThis.browser = {
    runtime: { getURL: (p) => 'moz-extension://qa/' + p },
    i18n: { getMessage: (k) => k, getUILanguage: () => 'de' },
    notifications: { create: async () => 'notification' },
  };
});
after(async () => {
  delete globalThis.browser;
  await rm(temp, { recursive: true, force: true });
});

test('profiles bind identity, redirects, origins and package version', async () => {
  const qa = await loadTimerProfile('qa');
  assert.equal(validateConfig(qa).extensionId, 'timetracker-qa@fin3000.com');
  assert.throws(() => validateConfig({ ...qa, apiOrigin: 'https://evil.example' }));
  assert.throws(() => validateConfig({ ...qa, extensionId: 'other@example.com' }));
  assert.throws(() => validateConfig({ ...qa, unknown: true }));
  assert.throws(() => parseArgs(['--made-up']));
  assert.throws(() => parseArgs(['--profile']));
  assert.equal(parseArgs(['--json', '--profile', 'production']).json, true);
});
test('input whitelist rejects HTML side channels, forged principals and arbitrary task ids', () => {
  assert.deepEqual(
    cleanFields({ description: '<b>literal text</b>', project: null, billable: false }),
    { description: '<b>literal text</b>', project: null, billable: false },
  );
  for (const value of [
    { owner: ownerId },
    { url: 'https://secret' },
    { billable: 'false' },
    { task: timerId },
    { description: 'x'.repeat(501) },
    [],
  ])
    assert.throws(() => cleanFields(value));
  assert.equal(cleanFields({ description: '🧪'.repeat(500) }).description.length, 1000);
});
test('unknown or damaged persisted state blocks loading without deleting data or sending requests', async () => {
  assert.deepEqual(validateStoredState(emptyState()), emptyState());
  for (const raw of [
    null,
    [],
    { ...emptyState(), schema: 2 },
    { ...emptyState(), extra: true },
    { ...emptyState(), auth: { accessToken: 12 } },
    { ...emptyState(), draft: {} },
    { ...emptyState(), command: { action: 'stop' } },
    { ...emptyState(), epoch: -1 },
    { ...emptyState(), pendingCapture: {} },
    { ...emptyState(), stopIntent: { timerId, afterCommandId: ownerId } },
    { ...emptyState(), snapshot: { timer: null } },
  ]) {
    let writes = 0;
    const coordinator = new Coordinator(await loadTimerProfile('qa'), {
      read: async () => validateStoredState(raw),
      write: async () => {
        writes++;
      },
    });
    await assert.rejects(coordinator.view(), /updateRequired/);
    assert.equal(writes, 0);
  }
});
test('public state excludes credentials and private accepted request data', async () => {
  const { coordinator } = await harness();
  const json = JSON.stringify(await coordinator.view());
  assert.ok(!json.includes('secret-access'));
  assert.ok(!json.includes('secret-refresh'));
  assert.ok(!json.includes('refreshing'));
});
test('duplicate clicks have one durable command and one effect', async () => {
  const { coordinator, read } = await harness(false);
  const gate = deferred();
  let calls = 0;
  coordinator.api.command = async (command) => {
    calls++;
    assert.equal(read().command.attempted, true);
    await gate.promise;
    return result(command);
  };
  await coordinator.accept('start', { description: 'Click' }, null, null);
  await assert.rejects(coordinator.accept('start', { description: 'Click' }, null, null), /busy/);
  await until(() => calls === 1);
  gate.resolve();
  await until(() => !read().command);
  assert.equal(calls, 1);
});
test('a submitted partial capture becomes the running timer, so the next save updates it', async () => {
  const { coordinator, read } = await harness(false);
  await coordinator.draft({ description: 'Captured' }, null, subject);
  coordinator.api.current = async () => snapshot(true, newVersion);
  await coordinator.accept(
    'start',
    { description: 'Captured', project: null, billable: true },
    null,
    null,
  );
  await until(() => !read().command);
  assert.equal(read().draft, null);
});
test('Save then Stop survives a closed popup and uses the Save receipt version', async () => {
  const { coordinator, read } = await harness();
  const gate = deferred();
  const calls = [];
  coordinator.api.command = async (command) => {
    calls.push(command);
    if (command.action === 'update') await gate.promise;
    return result(command);
  };
  await coordinator.accept('update', { description: 'Saved edit' }, timerId, oldVersion);
  await until(() => calls.length === 1);
  await coordinator.accept('stop', undefined, timerId, oldVersion);
  assert.equal(read().stopIntent.afterCommandId, calls[0].body.commandId);
  // Simultaneous polling may see another version. The queued Stop must not adopt it.
  coordinator.api.current = async () => snapshot(true, 'c'.repeat(64));
  await coordinator.sync(true);
  gate.resolve();
  await until(() => calls.length === 2 && !read().command);
  assert.equal(calls[1].action, 'stop');
  assert.equal(calls[1].body.expectedVersion, newVersion);
  assert.equal(calls[1].body.commandWindow, 'receipt-window');
});
test('lost mutation response resolves by receipt without a second POST', async () => {
  const { coordinator, read } = await harness();
  let calls = 0,
    committed;
  coordinator.api.command = async (command) => {
    calls++;
    committed = result(command);
    throw new ApiError(0, 'offline');
  };
  coordinator.api.receipt = async () => committed;
  await coordinator.accept('stop', undefined, timerId, oldVersion);
  await until(() => read().failures === 1 && !coordinator.draining);
  assert.equal(read().command.attempted, true);
  coordinator.state.retryAt = 0;
  await coordinator.drain();
  assert.equal(calls, 1);
  assert.equal(read().command, null);
});
test('unknown expired command is never replayed and requires a new user action', async () => {
  const { coordinator, read } = await harness();
  coordinator.api.command = async () => {
    throw new ApiError(0, 'offline');
  };
  await coordinator.accept('stop', undefined, timerId, oldVersion);
  await until(() => read().failures === 1 && !coordinator.draining);
  coordinator.state.command.deadline = Date.now() - 1;
  coordinator.state.retryAt = 0;
  let calls = 0;
  coordinator.api.command = async () => {
    calls++;
    throw new Error('must not retry');
  };
  await coordinator.drain();
  assert.equal(calls, 0);
  assert.equal(read().command, null);
  assert.equal(read().notice, 'expiredAction');
});
test('late replies after disconnect cannot restore another account or timer', async () => {
  const { coordinator, read } = await harness();
  const gate = deferred();
  let called = false;
  coordinator.api.command = async (command) => {
    called = true;
    await gate.promise;
    return result(command);
  };
  await coordinator.accept('stop', undefined, timerId, oldVersion);
  await until(() => called);
  // No external revocation traffic in this isolated unit fixture.
  coordinator.state.auth = null;
  await coordinator.disconnect();
  gate.resolve();
  await until(() => !coordinator.draining);
  assert.equal(read().principal, null);
  assert.equal(read().snapshot, null);
  assert.equal(read().auth, null);
});
test('Stop preserves unsaved fields as bounded recovery draft', async () => {
  const { coordinator, read } = await harness();
  await coordinator.draft({ description: 'Unsaved' }, timerId, subject);
  await coordinator.accept('stop', undefined, timerId, oldVersion);
  await until(() => !read().command);
  assert.equal(read().recovery.fields.description, 'Unsaved');
  assert.equal(read().draft, null);
  assert.ok(read().recovery.expiresAt <= Date.now() + 86_400_000);
});
test('polling cannot silently rebase an unsaved draft over another web edit', async () => {
  const { coordinator, read } = await harness();
  await coordinator.draft({ description: 'My old draft' }, timerId, subject, oldVersion);
  coordinator.api.current = async () => snapshot(true, newVersion);
  await coordinator.sync(true);
  assert.equal(read().draft.version, oldVersion);
  await assert.rejects(
    coordinator.accept('update', { description: 'My old draft' }, timerId, oldVersion),
    /conflict/,
  );
  await coordinator.acknowledge();
  assert.equal(read().draft, null);
  assert.equal(read().recovery.fields.description, 'My old draft');
});
test('expired capture and drafts are removed even when the API is offline', async () => {
  const { coordinator, read } = await harness();
  coordinator.state.pendingCapture = {
    text: 'Expired capture',
    attemptId: '',
    expiresAt: Date.now() - 1,
  };
  coordinator.state.recovery = {
    subject,
    timerId,
    version: oldVersion,
    fields: { description: 'Expired draft' },
    expiresAt: Date.now() - 1,
  };
  coordinator.api.principal = async () => {
    throw new ApiError(0, 'offline');
  };
  await coordinator.tick();
  assert.equal(read().pendingCapture, null);
  assert.equal(read().recovery, null);
});
test('ambiguous refresh marker requires reconnect without reusing refresh token', async () => {
  let stored = {
    ...emptyState(),
    auth: { accessToken: 'a', refreshToken: 'r', expiresAt: 0, refreshing: true },
    principal,
  };
  const coordinator = new Coordinator(await loadTimerProfile('qa'), {
    read: async () => stored,
    write: async (value) => {
      stored = structuredClone(value);
    },
  });
  const view = await coordinator.view();
  assert.equal(view.connected, false);
  assert.equal(view.notice, 'connectAgain');
  assert.equal(stored.auth, null);
});
test('badge is bounded, global, and never claims stale state is current', async () => {
  const { coordinator } = await harness();
  const view = await coordinator.view();
  assert.equal(badgeText(view), '2m');
  assert.equal(badgeText({ ...view, stale: true }), '?');
  assert.equal(badgeText({ ...view, connected: false }), '');
  view.snapshot.timer.start = new Date(Date.now() - 102 * 3600_000).toISOString();
  assert.equal(badgeText(view), '99h+');
});
test('real DOM capture excludes hidden/form content, bounds text, selection and frame', async () => {
  const fixture = await readFile(
    path.join(repoRoot, 'tests/fixtures/timer-extension.html'),
  );
  const source = await readFile(path.join(temp, 'capture.js'), 'utf8');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/capture.js' ? 'text/javascript' : 'text/html');
    res.end(req.url === '/capture.js' ? source : fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.FIN3000_CHROMIUM ? { executablePath: process.env.FIN3000_CHROMIUM } : {}),
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const capture = async (selector, select = false) =>
      page.evaluate(
        async ({ selector, select }) => {
          const target = document.querySelector(selector);
          window.browser = { menus: { getTargetElement: () => target } };
          window.getSelection().removeAllRanges();
          if (select) {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector('#selection-part'));
            window.getSelection().addRange(range);
          }
          return (await import('/capture.js')).captureTarget(1);
        },
        { selector, select },
      );
    assert.equal(await capture('#nested'), 'Ticket Überarbeitung 🧪 prüfen');
    assert.equal(await capture('#empty'), null);
    assert.equal(await capture('#selected', true), 'Ausgewählter Text');
    assert.equal(await capture('#nested', true), 'Ticket Überarbeitung 🧪 prüfen');
    assert.ok((await capture('#hostile')).startsWith('<img'));
    assert.equal(Array.from(await capture('#long')).length, 500);
    assert.equal(
      await page.evaluate(async () => {
        window.browser.menus.getTargetElement = () =>
          document.querySelector('#shadow').shadowRoot.querySelector('#shadow-target');
        window.getSelection().removeAllRanges();
        return (await import('/capture.js')).captureTarget(1);
      }),
      'Offener Shadow-Text',
    );
    assert.equal(
      await page.frames()[1].evaluate(async () => {
        window.browser = {
          menus: { getTargetElement: () => document.querySelector('#frame-target') },
        };
        return (await import('/capture.js')).captureTarget(1);
      }),
      'Text im eigenen Frame',
    );
    assert.equal(
      await page.evaluate(async () => {
        const target = document.createElement('section');
        document.body.append(target);
        for (let i = 0; i < 2200; i++) target.append(document.createElement('span'));
        target.append('TOO_FAR');
        window.browser.menus.getTargetElement = () => target;
        return (await import('/capture.js')).captureTarget(1);
      }),
      null,
    );
    assert.equal(
      await page.evaluate(async () => {
        const target = document.querySelector('#nested');
        target.remove();
        window.browser.menus.getTargetElement = () => target;
        return (await import('/capture.js')).captureTarget(1);
      }),
      null,
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('popup combines search and selection, keeps exact IDs and bounds the menu', async () => {
  const { coordinator } = await harness();
  const state = await coordinator.view();
  const messages = JSON.parse(await readFile(path.join(timerRoot, '_locales/de/messages.json')));
  const documents = {
    '/': [await readFile(path.join(timerRoot, 'popup.html')), 'text/html'],
    '/popup.css': [await readFile(path.join(timerRoot, 'popup.css')), 'text/css'],
    '/src/popup.js': [await readFile(path.join(temp, 'popup.js')), 'text/javascript'],
  };
  const server = createServer((req, res) => {
    const file = documents[req.url];
    res.writeHead(file ? 200 : 404, { 'Content-Type': file?.[1] || 'text/plain' });
    res.end(file?.[0] || '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
      ...(process.env.FIN3000_CHROMIUM ? { executablePath: process.env.FIN3000_CHROMIUM } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 360, height: 580 } });
    await page.addInitScript(
      ({ state, messages }) => {
        window.testCommands = [];
        window.testChoices = [];
        const clients = [
          { id: 'client-lunos', name: 'QA LUNOS Lüftungstechnik GmbH' },
          { id: 'client-usd', name: 'QA USD Kunde Inc.' },
        ];
        const projects = clients.flatMap((client) =>
          Array.from({ length: 201 }, (_, i) => ({
            id: client.id + '-' + i,
            name: 'Gleichnamiges Projekt ' + String(i).padStart(3, '0'),
            client,
          })),
        );
        window.browser = {
          i18n: { getMessage: (key) => messages[key]?.message || key, getUILanguage: () => 'de' },
          runtime: {
            sendMessage: async (message) => {
              if (message.type === 'choices') {
                window.testChoices.push(message);
                if (message.search === 'QA L')
                  await new Promise((resolve) => setTimeout(resolve, 500));
                const rows = (message.kind === 'clients' ? clients : projects).filter(
                  (value) =>
                    (!message.client || value.client.id === message.client) &&
                    (value.name + (value.client?.name || ''))
                      .toLowerCase()
                      .includes(message.search.toLowerCase()),
                );
                const start = (message.page - 1) * 200;
                return {
                  ok: true,
                  page: {
                    results: rows.slice(start, start + 200),
                    next: rows.length > start + 200 ? 'next' : null,
                  },
                };
              }
              if (message.type === 'command') window.testCommands.push(message);
              return { ok: true, view: state };
            },
          },
        };
      },
      { state, messages },
    );
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#editor').waitFor({ state: 'visible' });
    assert.equal(await page.locator('select').count(), 0);
    assert.equal(await page.getByRole('combobox').count(), 2);
    await page.locator('#client').fill('QA L');
    await page.waitForFunction(() => window.testChoices.some((v) => v.search === 'QA L'));
    await page.locator('#client').fill('USD');
    await page.locator('#client-options [data-value="client-usd"]').waitFor();
    await page.waitForTimeout(550);
    assert.equal(
      await page.locator('#client-options [role="option"]').count(),
      1,
      'late query cannot overwrite the newer results',
    );
    await page.locator('#client').press('Enter');
    assert.equal(await page.locator('#client').inputValue(), 'QA USD Kunde Inc.');
    assert.equal(await page.locator('#client').getAttribute('aria-expanded'), 'false');
    await page.locator('#project').click();
    await page.locator('#project-options [data-value="client-usd-0"]').waitFor();
    assert.equal(await page.locator('#project-options [data-value^="client-lunos"]').count(), 0);
    const geometry = await page.evaluate(() => {
      const rect = (id) => document.querySelector(id).getBoundingClientRect().toJSON();
      return {
        panel: rect('#project-panel'),
        stop: rect('#stop'),
        save: rect('#save'),
        footer: rect('footer'),
        height: innerHeight,
        width: document.documentElement.scrollWidth,
      };
    });
    assert.ok(geometry.panel.height <= 210 && geometry.panel.height >= 44);
    assert.ok(geometry.panel.top >= geometry.stop.bottom, 'results do not cover Stop');
    assert.ok(geometry.panel.bottom <= geometry.footer.top + 1, 'results do not cover Save');
    assert.ok(geometry.save.top >= 0 && geometry.save.bottom <= geometry.height);
    assert.equal(geometry.width, 360);
    await page.locator('#project').fill('019');
    await page.locator('#project-options [data-value="client-usd-19"]').waitFor();
    await page.locator('#project').press('Enter');
    assert.equal(await page.locator('#project').getAttribute('data-value'), 'client-usd-19');
    await page.locator('#project').fill('does not exist');
    await page.locator('#project-status').filter({ hasText: 'Keine Ergebnisse' }).waitFor();
    await page.locator('#project').press('Enter');
    assert.equal(await page.evaluate(() => window.testCommands.length), 0);
    await page.locator('#project').press('Escape');
    assert.match(await page.locator('#project').inputValue(), /019.*USD/);
    await page.locator('#save').click();
    const command = await page.evaluate(() => window.testCommands[0]);
    assert.equal(
      command.fields.project,
      'client-usd-19',
      'unselected search text never becomes the selected project',
    );
    await page.locator('#client-clear').click();
    assert.equal(await page.locator('#client').getAttribute('data-value'), '');
    assert.equal(
      await page.locator('#project').getAttribute('data-value'),
      'client-usd-19',
      'customer filter does not silently reassign the timer',
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('built XPI keeps exact permission and file boundaries and rejects contamination', async () => {
  const result = await buildTimer('qa', path.join(temp, 'artifact'));
  assert.equal(result.inspection.locales, 26);
  const manifest = JSON.parse(await readFile(path.join(result.unpacked, 'manifest.json')));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  const config = JSON.parse(await readFile(path.join(result.unpacked, 'config.json')));
  assert.ok(new URL(config.apiOrigin).port, 'runtime keeps the exact QA port');
  await writeFile(path.join(result.unpacked, 'unexpected-secret.txt'), 'synthetic');
  await assert.rejects(inspectTimer(result.unpacked, 'qa'), /Prüfung fehlgeschlagen/);
});


test('Edge profiles bind the public key, browser, exact redirect and environment', async () => {
  const qa = await loadTimerProfile('qa', 'edge');
  const production = await loadTimerProfile('production', 'edge');
  assert.equal(validateConfig(qa).extensionId, 'dmajiladcmjicohaacjjiklgjcaihlbk');
  assert.equal(validateConfig(production).extensionId, 'mefjglidfjkjajheckkgnlhleldpddmo');
  assert.throws(() => validateConfig({ ...qa, oauthClientId: 'fin3000-firefox-timer-qa' }));
  assert.throws(() => validateConfig({ ...production, extensionId: qa.extensionId, redirectUri: qa.redirectUri }));
  assert.throws(() => parseArgs(['--browser', 'safari']));
  const built = await buildTimer('qa', path.join(temp, 'edge-build'), 'edge');
  assert.equal(built.inspection.distribution, 'edge-unpacked-zip');
  const manifestPath = path.join(built.unpacked, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.background.service_worker, 'src/background.js');
  assert.equal(manifest.content_scripts[0].all_frames, true);
  const content = await readFile(path.join(built.unpacked, 'src/edge-content.js'), 'utf8');
  assert.doesNotMatch(content, /^import |^export /m);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, externally_connectable: { matches: ['https://*/*'] } }));
  await assert.rejects(inspectTimer(built.unpacked, 'qa', 'edge'));
});

test('capture intent survives worker loss before sync and is converted atomically to one command', async () => {
  const h = await harness(false);
  const blocked = deferred();
  h.coordinator.api.current = () => blocked.promise;
  void h.coordinator.capture('Durable right click');
  await until(() => !!h.read().pendingCapture?.start);
  const saved = h.read();
  assert.equal(saved.command, null);
  validateStoredState(saved);
  let durable = saved, posts = 0;
  const restarted = new Coordinator(await loadTimerProfile('qa'), {
    read: async () => structuredClone(durable),
    write: async (value) => { durable = structuredClone(value); },
  });
  restarted.api = {
    principal: async () => principal, current: async () => snapshot(false),
    receipt: async () => null,
    command: async (command) => { posts++; assert.equal(durable.pendingCapture, null); assert.equal(command.body.fields.description, 'Durable right click'); return result(command); },
  };
  await restarted.tick();
  await until(() => posts === 1 && !durable.command);
  assert.equal(posts, 1);
  await h.coordinator.disconnect();
  blocked.resolve(snapshot(false));
});

test('expired or superseded capture intent never starts a late timer', async () => {
  for (const mode of ['expired', 'changed-timer']) {
    const h = await harness(false), blocked = deferred();
    h.coordinator.api.current = () => blocked.promise;
    void h.coordinator.capture('Old action');
    await until(() => !!h.read().pendingCapture?.start);
    const saved = h.read();
    if (mode === 'expired') saved.pendingCapture.expiresAt = Date.now() - 1;
    const restarted = new Coordinator(await loadTimerProfile('qa'), { read: async () => saved, write: async () => {} });
    let posts = 0;
    restarted.api = { principal: async () => principal, current: async () => snapshot(true), receipt: async () => null, command: async () => { posts++; throw new Error('unexpected'); } };
    await restarted.tick();
    assert.equal(posts, 0);
    await h.coordinator.disconnect(); blocked.resolve(snapshot(false));
  }
});


test('Edge listener reads only after a trusted contextmenu and exact background message', async () => {
  const built = await buildTimer('qa', path.join(temp, 'edge-capture'), 'edge');
  const engine = await chromium.launch({ executablePath: process.env.FIN3000_CHROMIUM, args: ['--no-sandbox'] });
  const page = await engine.newPage();
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<p id="target">Visible <b>title</b><input value="SECRET"><span hidden>HIDDEN</span></p><p id="other">Neighbor</p><input id="password" type="password" value="SECRET">'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => {
      globalThis.browser = { runtime: { id: 'test', getURL: (p) => 'chrome-extension://test/' + p,
        onMessage: { addListener: (fn) => { globalThis.captureMessage = fn; } } } };
    });
    await page.addScriptTag({ path: path.join(built.unpacked, 'src/edge-content.js') });
    const read = (sender = { id: 'test', url: 'chrome-extension://test/src/background.js' }) => page.evaluate((sender) => globalThis.captureMessage({ type: 'fin3000.capture' }, sender), sender);
    assert.equal(await read(), null);
    await page.locator('#target').dispatchEvent('contextmenu');
    assert.equal(await read(), null, 'synthetic page event cannot capture');
    await page.locator('#target').click({ button: 'right', position: { x: 4, y: 4 } });
    assert.equal(await read({ id: 'test', url: 'https://evil.test', tab: { id: 1 } }), undefined);
    assert.equal(await read(), 'Visible title');
    assert.equal(await read(), null, 'one-shot consumption');
    await page.locator('#target').click({ button: 'right', position: { x: 4, y: 4 } });
    await page.locator('#target').evaluate((node) => node.remove());
    assert.equal(await read(), null, 'detached node');
    await page.locator('#other').click({ button: 'right' });
    await page.keyboard.press('Escape');
    assert.equal(await read(), null, 'abandoned menu');
    await page.locator('#password').click({ button: 'right' });
    assert.equal(await read(), null, 'password field');
  } finally { await engine.close(); await new Promise((r) => server.close(r)); }
});
