import { faultProxy } from './timer-extension-qa-proxy.mjs';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTimer } from './build-timer-extension.mjs';
import { normalizedZip } from './build-utils.mjs';
import {
  repoRoot,
  loadTimerProfile,
  runCli,
  isMain,
  timerError,
} from './timer-extension-cli.mjs';

const INTERNAL_ID = 'b616e935-3476-4d70-9b88-e76ee8f30e11';
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastTotpStep = -1;
async function qaTotpCode() {
  const secret = process.env.FIN3000_QA_TOTP_SECRET;
  if (!secret || !/^[A-Z2-7]{16,128}$/.test(secret))
    throw timerError(
      'QA_TOTP_REQUIRED',
      'FIN3000_QA_TOTP_SECRET des benannten isolierten QA-Seeds setzen.',
      3,
    );
  while (Math.floor(Date.now() / 30_000) <= lastTotpStep) await pause(100);
  lastTotpStep = Math.floor(Date.now() / 30_000);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(lastTotpStep));
  const hash = createHmac('sha1', key).update(counter).digest(),
    offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function updateFixture(
  artifact,
  folder,
  { bump = 1, protocolVersion = 1, storageVersion = 1 } = {},
) {
  const unpacked = path.join(folder, `update-${bump}`);
  await cp(artifact.unpacked, unpacked, { recursive: true });
  const version = artifact.version.split('.');
  version[2] = String(Number(version[2]) + bump);
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json')));
  manifest.version = version.join('.');
  const config = JSON.parse(await readFile(path.join(unpacked, 'config.json')));
  config.extensionVersion = manifest.version;
  config.protocolVersion = protocolVersion;
  await writeFile(path.join(unpacked, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(unpacked, 'config.json'), JSON.stringify(config));
  if (storageVersion === 2) {
    const file = path.join(unpacked, 'src/state.js');
    let source = await readFile(file, 'utf8');
    if (!source.includes("indexedDB.open('fin3000-timer', 1)"))
      throw new Error('qa_storage_fixture_source_changed');
    source = source
      .replace("indexedDB.open('fin3000-timer', 1)", "indexedDB.open('fin3000-timer', 2)")
      .replace(
        "request.result.createObjectStore('state');",
        "if (!request.result.objectStoreNames.contains('state')) request.result.createObjectStore('state');",
      );
    await writeFile(file, source);
  }
  const xpi = path.join(folder, `qa-update-${bump}.xpi`);
  await normalizedZip(unpacked, xpi);
  return { xpi, version: manifest.version };
}
export class FirefoxTimerRunner {
  constructor(port) {
    this.base = `http://127.0.0.1:${port}`;
    this.sid = null;
  }
  async raw(method, route, data) {
    const response = await fetch(this.base + route, {
      method,
      signal: AbortSignal.timeout(45_000),
      ...(data === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.value?.error || 'webdriver_http_error');
      error.webdriverMessage = body.value?.message;
      throw error;
    }
    return body.value;
  }
  call(method, route, data) {
    return this.raw(method, `/session/${this.sid}${route}`, data);
  }
  async start(options = {}) {
    const session = await this.raw('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': {
            ...(process.env.FIN3000_FIREFOX ? { binary: process.env.FIN3000_FIREFOX } : {}),
            args: [
              ...(options.headed ? [] : ['--headless']),
              ...(options.profile ? ['--profile', options.profile] : []),
            ],
            prefs: {
              'browser.shell.checkDefaultBrowser': false,
              'intl.locale.requested': 'de',
              'extensions.webextensions.uuids': JSON.stringify({
                'timetracker-qa@fin3000.com': INTERNAL_ID,
              }),
              ...(options.packaged ? { 'xpinstall.signatures.required': false } : {}),
            },
          },
        },
      },
    });
    this.sid = session.sessionId;
    this.version = session.capabilities.browserVersion;
    this.profile = session.capabilities['moz:profile'];
    await this.call('POST', '/window/rect', { width: 1280, height: 1000 });
    await this.call('POST', '/timeouts', { implicit: 0, pageLoad: 30_000, script: 15_000 });
  }
  async chrome() {
    await this.call('POST', '/moz/context', { context: 'chrome' });
  }
  async content() {
    await this.call('POST', '/moz/context', { context: 'content' });
  }
  script(script, args = []) {
    return this.call('POST', '/execute/sync', { script, args });
  }
  async wait(check, timeout = 20_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const value = await check();
        if (value) return value;
      } catch {
        /* loading or stale UI */
      }
      await pause(200);
    }
    throw new Error('qa_state_timeout');
  }
  async element(selector) {
    return (await this.call('POST', '/element', { using: 'css selector', value: selector }))[
      ELEMENT
    ];
  }
  async click(selector) {
    await this.call('POST', `/element/${await this.element(selector)}/click`, {});
  }
  async fill(selector, text) {
    const id = await this.element(selector);
    await this.call('POST', `/element/${id}/clear`, {});
    await this.call('POST', `/element/${id}/value`, { text });
  }
  async popup() {
    await this.chrome();
    const widget = await this.script(`
      let CustomizableUI;
      for (const uri of ['moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs','resource:///modules/CustomizableUI.sys.mjs']) {
        try { ({CustomizableUI}=ChromeUtils.importESModule(uri)); break; } catch {}
      }
      if (!CustomizableUI) throw new Error('customizable_ui_unavailable');
      const id='timetracker-qa_fin3000_com-browser-action';
      CustomizableUI.addWidgetToArea(id,CustomizableUI.AREA_NAVBAR);
      return document.getElementById('timetracker-qa_fin3000_com-BAP')?.id || id;
    `);
    const opened = await this.script(
      `return !!document.querySelector('browser.webextension-popup-browser');`,
    );
    if (!opened) await this.click('#' + widget);
    await this.wait(() =>
      this.script(
        `return !!document.querySelector('browser.webextension-popup-browser')?.currentURI?.spec.endsWith('/popup.html');`,
      ),
    );
    return this.popupAction('inspect');
  }
  async popupAction(action, selector = '', value = '') {
    await this.chrome();
    // Privileged QA bridge drives only the native popup DOM. It has no token,
    // storage, network or arbitrary runtime-message operation. No product hook.
    const payload = JSON.stringify({ action, selector, value });
    const frameScript = `(function(){try{
      const p=${payload}; const doc=content.document;
      if(doc.documentURI!=='moz-extension://${INTERNAL_ID}/popup.html')throw new Error('qa_popup_origin');
      if(p.action==='inspect'){
        sendAsyncMessage('Fin3000TimerQA',{text:doc.body.innerText,description:doc.querySelector('#description').value,
          connected:!doc.querySelector('#editor').hidden,busy:doc.querySelector('#timer-form').getAttribute('aria-busy')==='true',
          saveDisabled:doc.querySelector('#save').disabled,savedTitle:doc.querySelector('#saved-title').textContent,
          connectDisabled:doc.querySelector('#connect').disabled,
          stopVisible:!doc.querySelector('#stop').hidden,notice:doc.querySelector('#notice').textContent,
          project:doc.querySelector('#project').dataset.value||'',
          projectExpanded:doc.querySelector('#project').getAttribute('aria-expanded'),
          clientExpanded:doc.querySelector('#client').getAttribute('aria-expanded'),
          pickerStatus:doc.querySelector('#project-status').textContent,
          clients:[...doc.querySelectorAll('#client-options [role=option]')].map(o=>({value:o.dataset.value,label:o.textContent})),
          moreProjects:!doc.querySelector('#more-projects').hidden,recovery:doc.querySelector('#recovery-text').textContent,
          projects:[...doc.querySelectorAll('#project-options [role=option]')].map(o=>({value:o.dataset.value,label:o.textContent})),
          rect:doc.querySelector('#stop').getBoundingClientRect().toJSON()});return;
      }
      const allowed=['#connect','#save','#stop','#description','#client','#client-clear','#project','#project-clear','#more-projects','#billable','#refresh','#disconnect','#discard','#discard-panel summary','#drop-recovery'];
      if(!allowed.includes(p.selector))throw new Error('qa_selector_denied');
      let el=doc.querySelector(p.selector); if(!el)throw new Error('qa_element_missing');
      if(p.action==='fill') {el.value=p.value;el.dispatchEvent(new content.Event('input',{bubbles:true}));}
      else if(p.action==='pick'||p.action==='pointer') {
        if(p.action==='pick'){
          if(!['#client','#project'].includes(p.selector))throw new Error('qa_picker_denied');
          el=[...doc.querySelectorAll(p.selector+'-options [role=option]')].find(o=>o.dataset.value===p.value);
          if(!el)throw new Error('qa_option_missing');
        }
        el.scrollIntoView({block:'nearest',behavior:'instant'});
        const r=el.getBoundingClientRect();sendAsyncMessage('Fin3000TimerQA',{point:{x:r.x+r.width/2,y:r.y+r.height/2}});return;
      }
      else if(p.action==='click') {
        if(el.disabled)throw new Error('qa_control_disabled');
        el.scrollIntoView({block:'center',behavior:'instant'});
        if(p.selector!=='#connect') {el.click();sendAsyncMessage('Fin3000TimerQA',{accepted:true});return;}
        const r=el.getBoundingClientRect();sendAsyncMessage('Fin3000TimerQA',{point:{x:r.x+r.width/2,y:r.y+r.height/2}});return;
      }
      else throw new Error('qa_action_denied');
      sendAsyncMessage('Fin3000TimerQA',{accepted:true});
    }catch(error){sendAsyncMessage('Fin3000TimerQA',{error:error.name+': '+error.message});}})();`;
    const response = await this.call('POST', '/execute/async', {
      script: `
      const done=arguments[arguments.length-1]; const b=document.querySelector('browser.webextension-popup-browser');
      if(!b) {done({error:'qa_popup_closed'});return;}
      const mm=b.messageManager;
      const listener=m=>{mm.removeMessageListener('Fin3000TimerQA',listener);done(m.data);};
      mm.addMessageListener('Fin3000TimerQA',listener);
      mm.loadFrameScript('data:application/javascript;charset=utf-8,'+encodeURIComponent(arguments[0]),false);
    `,
      args: [frameScript],
    });
    if (response.error) throw new Error('popup_' + response.error);
    if (response.point) {
      const rect = await this.script(
        "const b=document.querySelector('browser.webextension-popup-browser');return {...b.getBoundingClientRect().toJSON(),zoom:b.fullZoom};",
      );
      await this.call('POST', '/actions', {
        actions: [
          {
            type: 'pointer',
            id: 'popup-mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              {
                type: 'pointerMove',
                origin: 'viewport',
                x: Math.round(rect.x + response.point.x * rect.zoom),
                y: Math.round(rect.y + response.point.y * rect.zoom),
                duration: 0,
              },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      });
    }
    return response;
  }
  async screenshot(file) {
    await this.chrome();
    const data = await this.call('POST', '/execute/async', {
      script: `
      const done=arguments[arguments.length-1];const b=document.querySelector('browser.webextension-popup-browser');
      b.browsingContext.currentWindowGlobal.drawSnapshot(null,1,'white').then(bitmap=>{
        const c=document.createElementNS('http://www.w3.org/1999/xhtml','canvas');c.width=bitmap.width;c.height=bitmap.height;
        c.getContext('2d').drawImage(bitmap,0,0);done(c.toDataURL());});`,
      args: [],
    });
    await writeFile(file, Buffer.from(data.split(',')[1], 'base64'));
  }
  async installed() {
    await this.chrome();
    return this.call('POST', '/execute/async', {
      script: `
      const done=arguments[arguments.length-1];
      const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      AddonManager.getAddonByID('timetracker-qa@fin3000.com').then(a=>done(a?{version:a.version,temporary:a.temporarilyInstalled,active:a.isActive}:null));`,
      args: [],
    });
  }
  async installPackaged(xpi, accept, updateVersion) {
    await this.chrome();
    const supported = await this.script(
      "const {AppConstants}=ChromeUtils.importESModule('resource://gre/modules/AppConstants.sys.mjs');return !AppConstants.MOZ_REQUIRE_SIGNING;",
    );
    if (!supported)
      throw timerError(
        'PACKAGED_BROWSER_REQUIRED',
        'Paketmodus benötigt Developer Edition/Nightly als FIN3000_FIREFOX.',
        3,
      );
    // Automate only the file chooser; about:addons performs the real install,
    // including Firefox's permission and data-collection consent dialog.
    await this.script(
      `
      const contract='@mozilla.org/filepicker;1',registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
      const original=registrar.contractIDToCID(contract),cid=Components.ID('{c23d905c-0531-4515-adcc-c7a023c2d46b}');
      const file=Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);file.initWithPath(arguments[0]);
      const factory={QueryInterface:ChromeUtils.generateQI(['nsIFactory']),createInstance(iid){return {
        QueryInterface:ChromeUtils.generateQI(['nsIFilePicker']),init(){},appendFilter(){},appendFilters(){},
        get file(){return file;},get files(){const a=Cc['@mozilla.org/array;1'].createInstance(Ci.nsIMutableArray);a.appendElement(file);return a.enumerate();},
        open(callback){Services.tm.dispatchToMainThread(()=>callback.done(Ci.nsIFilePicker.returnOK));}
      }.QueryInterface(iid);}};
      registrar.registerFactory(cid,'Fin3000 disposable QA picker',contract,factory);
      window.fin3000QAPicker={registrar,cid,factory,original,contract};
    `,
      [xpi],
    );
    try {
      await this.content();
      await this.call('POST', '/url', { url: 'about:addons' });
      await this.wait(() => this.element('panel-item[action="install-from-file"]'));
      await this.script("document.querySelector('panel-item[action=install-from-file]').click();");
      await this.chrome();
      const dialog = '#addon-webext-permissions-notification';
      const prompt = await this.wait(async () => {
        if (updateVersion && (await this.installed())?.version === updateVersion) return 'updated';
        return (await this.script(
          `return !!document.querySelector('${dialog}')?.getBoundingClientRect().height;`,
        ))
          ? 'prompt'
          : null;
      });
      if (prompt === 'updated') return;
      const button = await this.wait(() =>
        this.script(`
        const host=document.querySelector('${dialog} .popup-notification-${accept ? 'primary' : 'secondary'}-button');
        const button=host?.shadowRoot?.querySelector('button')||host;
        return button?.getBoundingClientRect().height&&!button.disabled?button.getBoundingClientRect().toJSON():null;
      `),
      );
      await this.call('POST', '/actions', {
        actions: [
          {
            type: 'pointer',
            id: 'install-consent',
            parameters: { pointerType: 'mouse' },
            actions: [
              {
                type: 'pointerMove',
                origin: 'viewport',
                x: Math.round(button.x + button.width / 2),
                y: Math.round(button.y + button.height / 2),
                duration: 0,
              },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      });
      await this.wait(() =>
        this.script(`return !document.querySelector('${dialog}')?.getBoundingClientRect().height;`),
      );
      if (accept)
        await this.wait(async () => {
          const a = await this.installed();
          return a?.active && !a.temporary && (!updateVersion || a.version === updateVersion);
        });
      else if (await this.installed()) throw new Error('qa_denied_install_persisted');
      await this.script("document.getElementById('notification-popup')?.hidePopup();");
    } finally {
      await this.chrome();
      await this.script(
        "const p=window.fin3000QAPicker;if(p){p.registrar.unregisterFactory(p.cid,p.factory);p.registrar.registerFactory(p.original,'',p.contract,null);delete window.fin3000QAPicker;}",
      );
    }
  }
  async nativeContextStart(fixtureUrl) {
    await this.content();
    await this.call('POST', '/url', { url: fixtureUrl });
    // Click the section's padding, so its inline input is not the hit target.
    const rect = await this.script(
      "return document.querySelector('#nested').getBoundingClientRect().toJSON();",
    );
    await this.call('POST', '/actions', {
      actions: [
        {
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            {
              type: 'pointerMove',
              origin: 'viewport',
              x: Math.round(rect.x + 8),
              y: Math.round(rect.y + 8),
              duration: 0,
            },
            { type: 'pointerDown', button: 2 },
            { type: 'pointerUp', button: 2 },
          ],
        },
      ],
    });
    await this.chrome();
    const selector = '#contentAreaContextMenu menuitem[label^="Fin3000"]';
    await this.wait(() => this.element(selector));
    await this.click(selector);
    await this.wait(async () => (await this.popup()).notice);
  }
  async login(username, password) {
    this.step = 'open-identity-window';
    const initialHandles = await this.call('GET', '/window/handles');
    await this.popupAction('click', '#connect');
    const handle = await this.wait(async () =>
      (await this.call('GET', '/window/handles')).find((id) => !initialHandles.includes(id)),
    );
    await this.call('POST', '/window', { handle });
    await this.content();
    this.step = 'login-form';
    await this.wait(() => this.element('input[type="email"]'));
    await this.fill('input[type="email"]', username);
    await this.fill('input[type="password"]', password);
    await this.click('button[type="submit"]');
    this.step = 'member-consent';
    const loginStage = await this.wait(() =>
      this.script(
        "return document.querySelector('#second-factor-code')?'totp':document.querySelector('[data-testid=oauth-consent-member]')?'consent':null;",
      ),
    );
    if (loginStage === 'totp') {
      this.mfa = true;
      await this.fill('#second-factor-code', await qaTotpCode());
      await this.click('button[type="submit"]');
    }
    await this.wait(() => this.element('[data-testid="oauth-consent-member"]'));
    const member = await this.call(
      'GET',
      `/element/${await this.element('[data-testid="oauth-consent-member"]')}/text`,
    );
    if (!member) throw new Error('qa_member_missing');
    await this.click('button.btn-primary');
    this.step = 'password-confirmation';
    await this.wait(() => this.element('#consent-password'));
    await this.fill('#consent-password', password);
    await this.click('button[type="submit"]');
    this.step = 'identity-callback';
    if (this.mfa) {
      const factor = await this.wait(async () => {
        if (!(await this.call('GET', '/window/handles')).includes(handle)) return 'callback';
        return (await this.script("return !!document.querySelector('#consent-factor-code');"))
          ? 'factor'
          : null;
      });
      if (factor === 'factor') {
        await this.fill('#consent-factor-code', await qaTotpCode());
        await this.click('button[type="submit"]');
      }
    }
    await this.wait(async () => !(await this.call('GET', '/window/handles')).includes(handle));
    await this.call('POST', '/window', { handle: initialHandles[0] });
    this.step = 'connected-popup';
    await this.wait(async () => (await this.popup()).connected);
    return member;
  }
  async close() {
    if (this.sid) await this.call('DELETE', '').catch(() => undefined);
    this.sid = null;
  }
}

export async function smokeFirefox(options) {
  if (options.profile !== 'qa')
    throw timerError('QA_ONLY', 'Der Firefox-Runner akzeptiert nur das isolierte QA-Profil.');
  if (!process.env.QA_SLUG)
    throw timerError(
      'QA_SLUG_REQUIRED',
      'QA_SLUG des isolierten Stacks setzen; der Runner startet keine Prüfung gegen Dev-Defaults.',
      3,
    );
  const mode = options.mode || 'temporary';
  const scenario = options.scenario || 'smoke';
  if (
    !['temporary', 'packaged'].includes(mode) ||
    !['smoke', 'auth', 'compatibility', 'interactive'].includes(scenario)
  )
    throw timerError(
      'ARGUMENT_INVALID',
      'Modus temporary|packaged, Szenario smoke|auth|compatibility|interactive.',
    );
  if (scenario === 'compatibility' && mode !== 'packaged')
    throw timerError('ARGUMENT_INVALID', 'Kompatibilitätsprüfung benötigt --mode packaged.');
  if (options.fault && !['request-loss', 'response-loss'].includes(options.fault))
    throw timerError('ARGUMENT_INVALID', 'Fault muss request-loss oder response-loss sein.');
  const originalConfig = await loadTimerProfile('qa');
  const proxy = options.fault ? await faultProxy(originalConfig.apiOrigin, options.fault) : null;
  const previousOrigin = process.env.FIN3000_TIMER_API_ORIGIN;
  let artifact;
  try {
    if (proxy) process.env.FIN3000_TIMER_API_ORIGIN = proxy.origin;
    artifact = await buildTimer('qa');
  } catch (error) {
    await proxy?.close();
    throw error;
  } finally {
    if (previousOrigin === undefined) delete process.env.FIN3000_TIMER_API_ORIGIN;
    else process.env.FIN3000_TIMER_API_ORIGIN = previousOrigin;
  }
  const port = await freePort();
  const driver = spawn(
    process.env.FIN3000_GECKODRIVER || 'geckodriver',
    ['--port', String(port), '--log', 'error', '--allow-system-access'],
    { stdio: 'ignore' },
  );
  let driverError = false;
  driver.on('error', () => {
    driverError = true;
  });
  const runner = new FirefoxTimerRunner(port);
  const fixture = await readFile(
    path.join(repoRoot, 'tests/fixtures/timer-extension.html'),
  );
  const fixtureServer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fixture);
  });
  const artifactDir = path.join(repoRoot, 'dist/timer-extension/qa/native');
  await mkdir(artifactDir, { recursive: true });
  const profile =
    mode === 'packaged'
      ? await mkdtemp(path.join(os.tmpdir(), 'fin3000-timer-firefox-'))
      : undefined;
  let stage = 'bootstrap';
  let interrupted = false;
  const stop = () => {
    interrupted = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runner.wait(async () => {
      if (driverError) throw timerError('GECKODRIVER_REQUIRED', 'FIN3000_GECKODRIVER prüfen.', 3);
      return runner.raw('GET', '/status');
    }, 10_000);
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/timer-extension.html`;
    const startOptions = {
      headed: scenario === 'interactive',
      packaged: mode === 'packaged',
      profile,
    };
    await runner.start(startOptions);
    if (mode === 'packaged') {
      stage = 'packaged-install-deny';
      await runner.installPackaged(artifact.xpi, false);
      stage = 'packaged-install-accept';
      await runner.installPackaged(artifact.xpi, true);
    } else
      await runner.call('POST', '/moz/addon/install', {
        addon: (await readFile(artifact.xpi)).toString('base64'),
        temporary: true,
      });
    stage = 'context-menu';
    await runner.nativeContextStart(fixtureUrl);
    const initial = await runner.popup();
    if (initial.connected || initial.stopVisible)
      throw new Error('qa_capture_started_without_connection');
    const beforeImage = path.join(artifactDir, 'disconnected-popup.png');
    await runner.screenshot(beforeImage);
    if (scenario === 'interactive') {
      process.stderr.write(
        `Isoliertes Firefox-Profil: ${runner.profile}\nTestseite: ${fixtureUrl}\nQA-Webapp: ${artifact.frontendOrigin}\nTemporäre Erweiterung; SIGINT beendet nur diesen QA-Lauf.\n`,
      );
      const seconds = Number(options.duration || 600);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
        throw timerError('ARGUMENT_INVALID', 'Dauer muss 1–3600 Sekunden sein.');
      const until = Date.now() + seconds * 1000;
      while (!interrupted && Date.now() < until) await pause(250);
      return {
        status: 'MANUAL',
        firefox: runner.version,
        mode,
        fixtureUrl,
        screenshot: beforeImage,
      };
    }
    const username = options.username || 'qa-timer-full@fin3000.test';
    const password = process.env.FIN3000_QA_PASSWORD;
    if (!password || !username.endsWith('@fin3000.test'))
      throw timerError(
        'QA_LOGIN_REQUIRED',
        'FIN3000_QA_PASSWORD setzen; nur eine @fin3000.test-Seedidentität ist erlaubt.',
        3,
      );
    stage = 'connect-and-consent';
    const member = await runner.login(username, password);
    const connected = await runner.popup();
    if (scenario === 'auth') {
      await runner.popupAction('click', '#disconnect');
      return {
        status: 'PASS',
        mode,
        firefox: runner.version,
        account: username,
        member,
        mfa: !!runner.mfa,
        checks: ['native-popup', 'oauth-consent', 'actual-member', 'disconnect'],
        frontend: artifact.frontendOrigin,
        api: originalConfig.apiOrigin,
      };
    }
    if (connected.description !== 'Ticket Überarbeitung 🧪 prüfen' || connected.stopVisible) {
      await writeFile(
        path.join(artifactDir, 'failure.json'),
        JSON.stringify({ stage, popup: connected }, null, 2),
      );
      throw new Error('qa_capture_after_login_invalid');
    }
    stage = 'start';
    if (proxy) proxy.state.armed = true;
    await runner.popupAction('click', '#save');
    if (proxy && mode === 'packaged') {
      await runner.wait(() => proxy.state.consumed);
      await runner.close();
      await runner.start(startOptions);
      await runner.popup();
    }
    await runner.wait(
      async () => {
        const v = await runner.popupAction('inspect');
        return v.stopVisible && !v.busy;
      },
      proxy ? 95_000 : 20_000,
    );
    if (
      proxy &&
      (proxy.state.committed !== 1 ||
        proxy.state.receipts < 1 ||
        proxy.state.requests !== (options.fault === 'response-loss' ? 1 : 2))
    ) {
      await writeFile(
        path.join(artifactDir, 'failure.json'),
        JSON.stringify({ stage, fault: proxy.state }, null, 2),
      );
      throw new Error('qa_fault_not_exactly_once');
    }
    const runningImage = path.join(artifactDir, 'running-popup.png');
    await runner.screenshot(runningImage);
    if (mode === 'packaged') {
      stage = 'restart';
      await runner.popupAction('fill', '#description', 'QA Firefox · Entwurf nach Neustart');
      await pause(1000); // let the UI's acknowledged draft render before closing
      stage = 'packaged-update';
      const update = await updateFixture(artifact, profile);
      await runner.installPackaged(update.xpi, true, update.version);
      await runner.wait(async () => {
        const v = await runner.popup();
        return (
          v.connected && v.stopVisible && v.description === 'QA Firefox · Entwurf nach Neustart'
        );
      });
      stage = 'restart';
      await runner.close();
      await runner.start(startOptions);
      const installed = await runner.installed();
      if (!installed?.active || installed.temporary)
        throw new Error('qa_packaged_restart_lost_addon');
      await runner.wait(async () => {
        const v = await runner.popup();
        return (
          v.connected && v.stopVisible && v.description === 'QA Firefox · Entwurf nach Neustart'
        );
      });
      await runner.screenshot(path.join(artifactDir, 'restarted-popup.png'));
    }
    stage = 'client-and-project';
    await runner.popupAction('pointer', '#client');
    await runner.popupAction('fill', '#client', 'Tele Columbus');
    const choices = await runner.wait(async () => {
      const v = await runner.popupAction('inspect');
      return v.clients.some((c) => c.label.includes('Tele Columbus')) ? v : null;
    });
    await runner.screenshot(path.join(artifactDir, 'client-picker.png'));
    const selectedClient = choices.clients.find((c) => c.label.includes('Tele Columbus'));
    await runner.popupAction('pick', '#client', selectedClient.value);
    await runner.popupAction('pointer', '#project');
    const filtered = await runner.wait(async () => {
      const v = await runner.popupAction('inspect');
      return v.projects.some(
        (p) => p.label.includes('gleichnamig') && p.label.includes('Tele Columbus'),
      ) && !v.projects.some((p) => p.label.includes('LUNOS'))
        ? v
        : null;
    });
    await runner.screenshot(path.join(artifactDir, 'project-picker.png'));
    const selectedProject = filtered.projects.find((p) => p.label.includes('gleichnamig'));
    await runner.popupAction('pick', '#project', selectedProject.value);
    await runner.wait(async () => !(await runner.popupAction('inspect')).saveDisabled);
    await runner.popupAction('click', '#save');
    await runner.wait(async () => {
      const v = await runner.popupAction('inspect');
      return v.saveDisabled && !v.busy && v.project === selectedProject.value;
    });
    await runner.popupAction('pointer', '#client-clear');
    await runner.popupAction('pointer', '#project');
    await runner.popupAction('fill', '#project', 'QA Timer Suche');
    await runner.wait(async () => {
      const v = await runner.popupAction('inspect');
      return v.moreProjects && v.projects.some((p) => p.label.includes('QA Timer Suche 199'));
    });
    await runner.popupAction('pointer', '#more-projects');
    await runner.wait(async () =>
      (await runner.popupAction('inspect')).projects.some((p) =>
        p.label.includes('QA Timer Suche 200'),
      ),
    );
    await runner.popupAction('pointer', '#description');
    stage = 'edit';
    await runner.popupAction('fill', '#description', 'QA Firefox · gespeicherte Änderung');
    await runner.wait(async () => !(await runner.popupAction('inspect')).busy);
    await runner.popupAction('click', '#save');
    await runner.wait(
      async () =>
        (await runner.popupAction('inspect')).savedTitle === 'QA Firefox · gespeicherte Änderung',
    );
    if (scenario === 'compatibility') {
      stage = 'packaged-compatibility';
      await runner.popupAction('fill', '#description', 'QA Firefox · Update-Entwurf');
      await pause(1000);
      for (const variant of [
        { bump: 2, protocolVersion: 2, blocked: true },
        { bump: 3, blocked: false },
        { bump: 4, storageVersion: 2, blocked: false },
        { bump: 5, blocked: true },
        { bump: 6, storageVersion: 2, blocked: false },
      ]) {
        const fixture = await updateFixture(artifact, profile, variant);
        await runner.installPackaged(fixture.xpi, true, fixture.version);
        await runner.wait(async () => {
          const v = await runner.popup();
          return variant.blocked
            ? !v.connected && v.connectDisabled && v.saveDisabled && v.notice
            : v.connected && v.stopVisible && v.description === 'QA Firefox · Update-Entwurf';
        });
      }
    }
    stage = 'stop';
    await runner.popupAction('fill', '#description', 'QA Firefox · ungespeicherter Entwurf');
    await pause(500);
    await runner.popupAction('click', '#stop');
    await runner.wait(async () => !(await runner.popupAction('inspect')).stopVisible);
    if ((await runner.popupAction('inspect')).recovery !== 'QA Firefox · ungespeicherter Entwurf')
      throw new Error('qa_dirty_stop_lost_draft');
    await runner.popupAction('click', '#drop-recovery');
    await runner.popupAction('click', '#disconnect');
    return {
      status: 'PASS',
      mode,
      firefox: runner.version,
      version: artifact.version,
      xpiSha256: artifact.sha256,
      account: username,
      member,
      frontend: artifact.frontendOrigin,
      api: artifact.apiOrigin,
      fixtureUrl,
      checks: [
        'native-install',
        'native-context-menu',
        'pending-capture',
        'oauth-consent',
        'start',
        'client-filter',
        'project-selection',
        '201-project-pagination',
        'save',
        'dirty-stop-recovery',
        'stop',
        'disconnect',
      ],
      fault: proxy ? { kind: options.fault, ...proxy.state } : null,
      upstreamApi: originalConfig.apiOrigin,
      update: mode === 'packaged' ? 'PASS_COMPATIBLE_UPDATE' : 'NOT_TESTED_TEMPORARY_ADDON',
      compatibility: scenario === 'compatibility' ? 'PASS_PROTOCOL_AND_IDB_RECOVERY' : 'NOT_TESTED',
      screenshots: [beforeImage, runningImage],
      restart: mode === 'packaged' ? 'PASS_PERSISTENT_PROFILE' : 'NOT_TESTED_TEMPORARY_ADDON',
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'qa_state_timeout') {
      const popupDiagnostic = await runner.popup().catch(() => null);
      await runner.content().catch(() => undefined);
      const diagnostic = await runner
        .script(
          "return {path:location.pathname,inputs:[...document.querySelectorAll('input')].map(e=>({type:e.type,id:e.id})),title:document.title};",
        )
        .catch(() => ({ unavailable: true }));
      await writeFile(
        path.join(artifactDir, 'failure.json'),
        JSON.stringify(
          { stage, step: runner.step, popup: popupDiagnostic, ...diagnostic },
          null,
          2,
        ),
      );
      throw timerError(
        'NATIVE_QA_TIMEOUT',
        `${stage}/${runner.step || ''}: Der erwartete Firefox-Zustand wurde nicht erreicht. Siehe dist/timer-extension/qa/native/failure.json.`,
        4,
      );
    }
    if (error?.exitCode) throw error;
    throw timerError(
      'NATIVE_QA_FAILED',
      `${stage}: ${error instanceof Error ? error.message : 'unknown'}${stage.startsWith('packaged-') && error.webdriverMessage ? ' · ' + error.webdriverMessage : ''}`,
      4,
    );
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await runner.close();
    driver.kill('SIGTERM');
    if (fixtureServer.listening) await new Promise((resolve) => fixtureServer.close(resolve));
    if (profile) await rm(profile, { recursive: true, force: true });
    await proxy?.close();
  }
}
if (isMain(import.meta.url))
  await runCli(
    smokeFirefox,
    'Native Firefox QA on a disposable profile. --mode temporary|packaged --scenario smoke|auth|compatibility|interactive [--fault request-loss|response-loss] [--username qa-timer-full@fin3000.test] [--duration 600] [--json] [--help]. QA_SLUG pairs the isolated stack; FIN3000_QA_PASSWORD supplies the seed password; FIN3000_QA_TOTP_SECRET optionally supplies the named MFA fixture secret. FIN3000_FIREFOX/FIN3000_GECKODRIVER pin binaries. No personal profile is used.',
    ['--mode', '--scenario', '--username', '--duration', '--fault'],
  );
