import type { Auth, TimerConfig } from './types.js';

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
export function parseTokens(raw: unknown): Auth {
  if (!raw || typeof raw !== 'object') throw new Error('connectAgain');
  const value = raw as Record<string, unknown>;
  if (
    typeof value['access_token'] !== 'string' ||
    !value['access_token'] ||
    value['access_token'].length > 4096 ||
    typeof value['refresh_token'] !== 'string' ||
    !value['refresh_token'] ||
    value['refresh_token'].length > 4096 ||
    String(value['token_type']).toLowerCase() !== 'bearer' ||
    value['scope'] !== 'timer:self' ||
    typeof value['expires_in'] !== 'number' ||
    value['expires_in'] <= 0 ||
    value['expires_in'] > 86_400
  )
    throw new Error('connectAgain');
  return {
    accessToken: value['access_token'],
    refreshToken: value['refresh_token'],
    expiresAt: Date.now() + value['expires_in'] * 1000,
    refreshing: false,
  };
}
export async function tokenRequest(
  config: TimerConfig,
  values: Record<string, string>,
): Promise<Auth> {
  const response = await fetch(config.apiOrigin + '/o/token/', {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.oauthClientId, ...values }),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!response.ok) throw new Error('connectAgain');
  return parseTokens(await response.json());
}
export async function connectOAuth(config: TimerConfig): Promise<Auth> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );
  const url = new URL('/oauth/authorize', config.frontendOrigin);
  url.search = new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'timer:self',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const returned = new URL(
    await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true }),
  );
  const expected = new URL(config.redirectUri);
  if (
    returned.origin !== expected.origin ||
    returned.pathname !== expected.pathname ||
    returned.hash ||
    returned.searchParams.getAll('state').length !== 1 ||
    returned.searchParams.get('state') !== state ||
    returned.searchParams.getAll('code').length !== 1 ||
    returned.searchParams.has('error')
  )
    throw new Error('connectionCancelled');
  const code = returned.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('connectionCancelled');
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: config.redirectUri,
  });
}
export async function revokeOAuth(config: TimerConfig, auth: Auth): Promise<void> {
  await Promise.allSettled(
    [
      ['refresh_token', auth.refreshToken],
      ['access_token', auth.accessToken],
    ].map(([hint, token]) =>
      fetch(config.apiOrigin + '/o/revoke_token/', {
        method: 'POST',
        body: new URLSearchParams({
          client_id: config.oauthClientId,
          token,
          token_type_hint: hint,
        }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      }),
    ),
  );
}
