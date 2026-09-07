import type { TimerConfig } from './types.js';

export function validateConfig(raw: unknown): TimerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('configuration');
  const c = raw as TimerConfig;
  const keys = [
    'profile',
    'profileVersion',
    'protocolVersion',
    'extensionVersion',
    'extensionId',
    'oauthClientId',
    'redirectUri',
    'apiOrigin',
    'frontendOrigin',
  ];
  if (
    Object.keys(c).sort().join() !== keys.sort().join() ||
    c.profileVersion !== 1 ||
    c.protocolVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(c.extensionVersion)
  )
    throw new Error('configuration');
  const prod = c.profile === 'production';
  if (!prod && c.profile !== 'qa') throw new Error('configuration');
  if (
    c.extensionId !== (prod ? 'timetracker@fin3000.com' : 'timetracker-qa@fin3000.com') ||
    c.oauthClientId !== (prod ? 'fin3000-firefox-timer' : 'fin3000-firefox-timer-qa')
  )
    throw new Error('configuration');
  const redirect = prod
    ? 'a086c2adfc379a0f654784b1eb316305e2a29c10'
    : '2ace9a4a44792c4b2d137142c71c42591e8365fd';
  if (c.redirectUri !== `https://${redirect}.extensions.allizom.org/`)
    throw new Error('configuration');
  for (const key of ['apiOrigin', 'frontendOrigin'] as const) {
    const url = new URL(c[key]);
    if (url.origin !== c[key] || url.username || url.password) throw new Error('configuration');
    if (!prod && (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)))
      throw new Error('configuration');
  }
  if (
    prod &&
    (c.apiOrigin !== 'https://api.fin3000.com' || c.frontendOrigin !== 'https://app.fin3000.com')
  )
    throw new Error('configuration');
  return c;
}

let loaded: Promise<TimerConfig> | undefined;
export function loadConfig(): Promise<TimerConfig> {
  loaded ??= fetch(browser.runtime.getURL('config.json'), {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  })
    .then((r) => {
      if (!r.ok) throw new Error('configuration');
      return r.json();
    })
    .then(validateConfig)
    .then((c) => {
      if (
        browser.runtime.id !== c.extensionId ||
        browser.identity.getRedirectURL() !== c.redirectUri
      )
        throw new Error('configuration');
      return c;
    });
  return loaded;
}
