import { faultProxy } from './timer-extension-qa-proxy.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildTimer } from './build-timer-extension.mjs';
import { repoRoot, loadTimerProfile, runCli, isMain, timerError } from './timer-extension-cli.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(check, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(100);
  }
  throw new Error('expected_edge_state_timeout');
}
/** Actual installed Edge, actual native context menu and toolbar popup, disposable profile. */
export class EdgeTimerRunner {
  constructor(profile, artifact) { this.profile = profile; this.artifact = artifact; }
  native(args) {
    const result = spawnSync(process.env.FIN3000_XDOTOOL || 'xdotool', args, {
      env: { ...process.env, DISPLAY: process.env.FIN3000_QA_DISPLAY || process.env.DISPLAY },
      encoding: 'utf8', timeout: 5000,
    });
    if (result.status !== 0) throw new Error('native_input_unavailable');
    return result.stdout.trim();
  }
  async launch() {
    this.context = await chromium.launchPersistentContext(this.profile, {
      executablePath: process.env.FIN3000_EDGE || '/usr/bin/microsoft-edge-stable',
      headless: false, viewport: { width: 1100, height: 800 }, locale: 'de-DE',
      env: { ...process.env, DISPLAY: process.env.FIN3000_QA_DISPLAY || process.env.DISPLAY },
      args: ['--no-sandbox', '--ozone-platform=x11', '--remote-debugging-port=0', '--lang=de', '--disable-features=msEdgeTranslate',
        `--disable-extensions-except=${this.artifact.unpacked}`, `--load-extension=${this.artifact.unpacked}`],
    });
    this.ownerContext = this.context;
    this.debugPort = (await readFile(path.join(this.profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
    this.context.setDefaultTimeout(20_000);
    this.page = this.context.pages()[0];
    this.session = await this.context.newCDPSession(this.page);
    this.version = (await this.session.send('Browser.getVersion')).product;
    this.workerVersions = new Map();
    this.session.on('ServiceWorker.workerVersionUpdated', (event) => { for (const v of event.versions) this.workerVersions.set(v.versionId, v); });
    await this.session.send('ServiceWorker.enable');
    this.worker = this.context.serviceWorkers()[0] || await this.context.waitForEvent('serviceworker');
    assert.equal(await this.worker.evaluate(() => browser.runtime.id), this.artifact.extensionId);
    assert.equal(await this.worker.evaluate(() => browser.identity.getRedirectURL()), this.artifact.oauthRedirect);
    await sleep(600);
  }
  async attachNativePages() {
    // Chromium's action/identity popup targets are not automatically attached
    // by a persistent Playwright launch. Attach after the native target exists.
    this.connections ||= [];
    this.remote = await chromium.connectOverCDP('http://127.0.0.1:' + this.debugPort);
    this.connections.push(this.remote);
    this.context = this.remote.contexts()[0];
    this.context.setDefaultTimeout(20_000);
    this.worker = this.context.serviceWorkers()[0];
  }
  async popup() {
    let popup = this.context.pages().find((p) => p.url().endsWith('/popup.html'));
    if (!popup) {
      this.worker = this.context.serviceWorkers()[0] || await this.context.waitForEvent('serviceworker');
      await this.worker.evaluate(() => browser.action.openPopup());
      await wait(async () => (await this.session.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/popup.html')));
      await this.attachNativePages();
      popup = this.context.pages().find((p) => p.url().endsWith('/popup.html'));
    }
    await popup.locator('#connect').waitFor({ state: 'attached' });
    return popup;
  }
  async closePopup() { this.native(['key', 'Escape']); await sleep(150); }
  async menu(selector = '#nested', frame = this.page) {
    await this.closePopup();
    await this.page.bringToFront();
    const title = 'Fin3000 Edge QA ' + path.basename(this.profile);
    await this.page.evaluate((title) => { document.title = title; }, title);
    const window = await wait(async () => this.native(['search', '--name', title]).split('\n')[0]).catch(() => { throw new Error('native_window_not_found'); });
    this.native(['windowfocus', '--sync', window]);
    await frame.locator(selector).click({ button: 'right', position: { x: 10, y: 10 } });
    await sleep(180);
    // On the supported Edge fixture menu, Fin3000 precedes Send to devices,
    // View source and Inspect; frames add View frame source / Refresh frame.
    // These are real native keyboard events on the versioned fixture.
    this.native(['key', '--delay', '120', 'End', ...Array(frame === this.page ? 3 : 5).fill('Up'), 'Return']);
    await wait(async () => (await this.session.send('Target.getTargets')).targetInfos.find((t) => t.url.endsWith('/popup.html')));
    await this.attachNativePages();
    const popup = this.context.pages().find((p) => p.url().endsWith('/popup.html'));
    await sleep(300); // Edge's native fade-in is not an application transparency bug.
    return popup;
  }
  async state() {
    return (await (await this.popup()).evaluate(() => browser.runtime.sendMessage({ type: 'view' }))).view;
  }
  async login(username, password) {
    const popup = await this.popup();
    await popup.locator('#connect').click();
    this.step = 'identity-window';
    const auth = await wait(async () => this.context.pages().find((p) => /^http:\/\/127.0.0.1:\d+\/(sign-in|oauth)/.test(p.url())));
    this.step = 'login-form';
    await auth.locator('input[type=email]').fill(username);
    await auth.locator('input[type=password]').fill(password);
    await auth.locator('button[type=submit]').click();
    this.step = 'member-consent';
    await auth.locator('[data-testid=oauth-consent-member]').waitFor();
    const member = await auth.locator('[data-testid=oauth-consent-member]').innerText();
    assert.ok(member.includes('Timer'));
    await auth.locator('button.btn-primary').click();
    this.step = 'confirm-password';
    await auth.locator('#consent-password').fill(password);
    await auth.locator('button[type=submit]').click();
    this.step = 'callback';
    await wait(async () => auth.isClosed());
    this.step = 'connected-popup';
    await wait(async () => (await this.state()).connected);
    return member;
  }
  async stopWorker() {
    await this.closePopup();
    const version = await wait(async () => [...this.workerVersions.values()].find((v) => v.scriptURL === this.worker.url() && v.runningStatus === 'running'));
    await this.session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
    await sleep(300);
    // Opening the actual browser action wakes the persisted extension worker.
    this.native(['key', 'Escape']);
    const extensionPage = await this.context.newPage();
    await extensionPage.goto(`chrome-extension://${this.artifact.extensionId}/popup.html`);
    await extensionPage.evaluate(() => browser.runtime.sendMessage({ type: 'view' }));
    this.worker = await wait(async () => this.context.serviceWorkers().find((w) => w.url().endsWith('/background.js')));
    await extensionPage.close();
  }
  async close() { for (const connection of this.connections || []) await connection.close(); this.connections = []; await this.ownerContext?.close(); }
}

export async function smokeEdge(options) {
  if (!process.env.QA_SLUG || !process.env.FIN3000_QA_DISPLAY)
    throw timerError('QA_ENV_REQUIRED', 'QA_SLUG und FIN3000_QA_DISPLAY auf einen eigenen X11-QA-Display setzen.', 3);
  const username = options.username || 'qa-timer-full@fin3000.test';
  if (!username.endsWith('@fin3000.test') || !process.env.FIN3000_QA_PASSWORD)
    throw timerError('QA_ACCOUNT_REQUIRED', 'Disposable QA-Account und FIN3000_QA_PASSWORD erforderlich.', 3);
  const config = await loadTimerProfile('qa', 'edge');
  if (options.fault && options.fault !== 'response-loss') throw timerError('ARGUMENT_INVALID', 'Edge fault muss response-loss sein.');
  const proxy = options.fault ? await faultProxy(config.apiOrigin, options.fault) : null;
  const previousOrigin = process.env.FIN3000_TIMER_API_ORIGIN;
  let artifact;
  try {
    if (proxy) process.env.FIN3000_TIMER_API_ORIGIN = proxy.origin;
    artifact = await buildTimer('qa', undefined, 'edge');
  } catch (error) {
    await proxy?.close();
    throw error;
  } finally {
    if (previousOrigin === undefined) delete process.env.FIN3000_TIMER_API_ORIGIN;
    else process.env.FIN3000_TIMER_API_ORIGIN = previousOrigin;
  }
  const profile = await mkdtemp(path.join(os.tmpdir(), 'fin3000-edge-timer-'));
  const dir = path.join(repoRoot, 'dist/timer-extension/edge/qa/native');
  await mkdir(dir, { recursive: true });
  const html = await readFile(path.join(repoRoot, 'tests/fixtures/timer-extension.html'));
  const fixture = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.url.startsWith('/frame') ? '<p id="frame-target">HTTP Frame Titel</p>' : html);
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  const runner = new EdgeTimerRunner(profile, artifact);
  const checks = [];
  let stage = 'launch';
  try {
    await runner.launch();
    await runner.page.goto(fixtureUrl);
    stage = 'native-context-capture';
    let popup = await runner.menu();
    assert.equal((await runner.state()).notice, 'connectForCapture');
    assert.equal((await runner.state()).connected, false);
    checks.push('native-context-menu', 'native-toolbar-popup', 'fixed-edge-identity');
    stage = 'oauth-consent';
    const member = await runner.login(username, process.env.FIN3000_QA_PASSWORD);
    popup = await runner.popup();
    await wait(async () => (await popup.locator('#description').inputValue()) === 'Ticket Überarbeitung 🧪 prüfen');
    assert.equal((await runner.state()).snapshot.timer, null);
    checks.push('real-pkce-consent', 'exact-visible-text-no-form-or-hidden-content');
    stage = 'start';
    if (proxy) proxy.state.armed = true;
    await popup.locator('#save').click();
    if (proxy) {
      await wait(async () => proxy.state.consumed);
      await runner.stopWorker();
      popup = await runner.popup();
    }
    await wait(async () => !!(await runner.state()).snapshot?.timer && !(await runner.state()).busy, proxy ? 100_000 : 20_000);
    if (proxy) {
      assert.equal(proxy.state.requests, 1); assert.equal(proxy.state.committed, 1); assert.ok(proxy.state.receipts >= 1);
      checks.push('lost-response-and-worker-restart-single-server-effect');
    }
    stage = 'search-and-save';
    await popup.locator('#client').fill('Lunos');
    const clientOption = popup.locator('#client-options [role=option]').first();
    await clientOption.waitFor(); await clientOption.click();
    await popup.locator('#project').fill('QA Timer Suche 200');
    await popup.locator('#project-options [role=option]').first().waitFor();
    await popup.locator('#project').press('ArrowDown');
    await popup.locator('#project').press('Enter');
    await popup.locator('#save').click();
    await wait(async () => (await runner.state()).snapshot?.timer?.project?.name === 'QA Timer Suche 200' && !(await runner.state()).busy);
    await popup.screenshot({ path: path.join(dir, 'running-popup.png') });
    checks.push('start', 'client-pointer-search', 'project-keyboard-search', 'save');
    const timerId = (await runner.state()).snapshot.timer.id;
    stage = 'worker-restart';
    await runner.stopWorker();
    await wait(async () => (await runner.state()).snapshot?.timer?.id === timerId);
    checks.push('actual-service-worker-restart');
    stage = 'browser-restart';
    await runner.close(); await runner.launch();
    await runner.page.goto(fixtureUrl);
    await wait(async () => (await runner.state()).connected && (await runner.state()).snapshot?.timer?.id === timerId);
    checks.push('actual-browser-restart');
    stage = 'context-start-connected';
    popup = await runner.menu('#hostile');
    await wait(async () => (await runner.state()).snapshot?.timer?.description === '<img src=x onerror=alert(1)> Nur Text' && !(await runner.state()).busy);
    assert.equal(await popup.locator('#saved-title img').count(), 0);
    checks.push('connected-context-start', 'html-is-only-text');
    stage = 'stop';
    await popup.locator('#stop').click();
    await wait(async () => !(await runner.state()).snapshot?.timer && !(await runner.state()).busy);
    checks.push('stop');
    stage = 'disconnect';
    await popup.locator('#disconnect').click();
    await wait(async () => !(await runner.state()).connected);
    checks.push('disconnect');
    stage = 'http-frame-capture';
    for (const frameOrigin of [fixtureUrl, fixtureUrl.replace('127.0.0.1', 'localhost')]) {
    await runner.closePopup();
    await runner.page.goto(fixtureUrl);
    await runner.page.evaluate((url) => { document.body.innerHTML = `<iframe id="qa-frame" src="${url}" style="width:800px;height:300px"></iframe>`; }, frameOrigin + 'frame');
    await runner.menu('#frame-target', runner.page.frameLocator('#qa-frame'));
    const pendingText = await runner.worker.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('fin3000-timer', 1);
      request.onsuccess = () => { const db = request.result; const read = db.transaction('state').objectStore('state').get('current');
        read.onsuccess = () => { resolve(read.result?.pendingCapture?.text); db.close(); }; };
    }));
    assert.equal(pendingText, 'HTTP Frame Titel');
    checks.push(frameOrigin === fixtureUrl ? 'native-http-frame-capture' : 'native-cross-origin-frame-capture');
    }
    return { status: 'PASS', browser: 'Microsoft Edge', version: runner.version, binary: process.env.FIN3000_EDGE || '/usr/bin/microsoft-edge-stable', build: artifact.sha256, apiOrigin: config.apiOrigin, frontendOrigin: config.frontendOrigin, account: username, member, fault: options.fault || null, faultCounts: proxy?.state, viewport: '360x580 native popup; 1100x800 webpage', checks };
  } catch (error) {
    const diagnostic = { stage, step: runner.step, error: error.message, browser: runner.version };
    await writeFile(path.join(dir, 'failure.json'), JSON.stringify(diagnostic, null, 2));
    if (!stage.includes('oauth')) await (await runner.popup().catch(() => null))?.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => undefined);
    throw timerError('EDGE_QA_FAILED', `${stage}/${runner.step || ""}: ${error.message}. Diagnose: ${path.join(dir, 'failure.json')}`, 4);
  } finally {
    // Only this explicitly named disposable account is used by the runner.
    try {
      const cleanup = await runner.popup();
      if (await cleanup.locator('#stop').isVisible()) {
        await cleanup.locator('#stop').click();
        await wait(async () => !(await runner.state()).snapshot?.timer && !(await runner.state()).busy);
      }
      if (await cleanup.locator('#disconnect').isVisible()) await cleanup.locator('#disconnect').click();
    } catch { /* Preserve the original failure; the disposable QA stack owns cleanup. */ }
    await runner.close();
    await proxy?.close();
    await new Promise((resolve) => fixture.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url)) await runCli(smokeEdge,
  'Native installed Edge QA. [--fault response-loss] --username qa-timer-full@fin3000.test [--json]. Requires QA_SLUG, FIN3000_QA_PASSWORD, FIN3000_QA_DISPLAY (isolated X11), xdotool. Overrides FIN3000_EDGE, FIN3000_XDOTOOL. Disposable profile; no personal browser data.', ['--username', '--fault']);
