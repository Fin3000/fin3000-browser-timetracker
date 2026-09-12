import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { ProductCliError } from './build-utils.mjs';
import { portsForSlug } from './build-utils.mjs';

export { ProductCliError };
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const timerRoot = repoRoot;
export function timerError(code, cause, exitCode = 2) {
  return new ProductCliError(
    code,
    'Browser-Zeiterfassung: Prüfung fehlgeschlagen.',
    cause,
    'npm run timer-extension:doctor -- --help',
    exitCode,
  );
}
export function parseArgs(args, extra = []) {
  const options = { profile: 'qa', browser: 'firefox', json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json' || key === '--help') options[key.slice(2)] = true;
    else if (['--profile', '--browser', ...extra].includes(key) && args[i + 1] && !args[i + 1].startsWith('--'))
      options[key.slice(2)] = args[++i];
    else throw timerError('ARGUMENT_INVALID', `Unbekanntes oder unvollständiges Argument: ${key}`);
  }
  if (!['qa', 'production'].includes(options.profile))
    throw timerError('PROFILE_INVALID', 'Profil muss qa oder production sein.');
  if (!['firefox', 'edge'].includes(options.browser))
    throw timerError('BROWSER_INVALID', 'Browser muss firefox oder edge sein.');
  return options;
}
export async function loadTimerProfile(name, browser = 'firefox') {
  if (!['qa', 'production'].includes(name))
    throw timerError('PROFILE_INVALID', 'Profil muss qa oder production sein.');
  const profile = JSON.parse(
    await readFile(path.join(timerRoot, 'config', (browser === 'edge' ? 'edge-' : '') + name + '.json'), 'utf8'),
  );
  const keys = [
    '$schema',
    'profile',
    'profileVersion',
    'protocolVersion',
    'extensionId',
    'oauthClientId',
    'redirectUri',
    'apiOrigin',
    'frontendOrigin',
  ];
  if (
    Object.keys(profile).sort().join() !== keys.sort().join() ||
    profile.profile !== name ||
    profile.$schema !== './schema.json'
  )
    throw timerError('PROFILE_INVALID', 'Unbekannte oder fehlende Profilfelder.');
  delete profile.$schema;
  profile.extensionVersion = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;
  if (name === 'qa' && process.env.QA_SLUG) {
    const ports = portsForSlug(process.env.QA_SLUG);
    profile.apiOrigin = `http://127.0.0.1:${ports.backend}`;
    profile.frontendOrigin = `http://127.0.0.1:${ports.frontend}`;
  }
  if (name === 'qa') {
    profile.apiOrigin = process.env.FIN3000_TIMER_API_ORIGIN || profile.apiOrigin;
    profile.frontendOrigin = process.env.FIN3000_TIMER_FRONTEND_ORIGIN || profile.frontendOrigin;
  }
  const prod = name === 'production';
  if (!['firefox', 'edge'].includes(browser)) throw timerError('BROWSER_INVALID', 'Browser muss firefox oder edge sein.');
  const edge = browser === 'edge';
  const identity = edge ? await edgeIdentity(name) : null;
  if (
    profile.profileVersion !== 1 ||
    profile.protocolVersion !== 1 ||
    !/^\d+\.\d+\.\d+$/.test(profile.extensionVersion) ||
    profile.extensionId !== (edge ? identity.extensionId : (prod ? 'timetracker@fin3000.com' : 'timetracker-qa@fin3000.com')) ||
    profile.oauthClientId !== (edge ? 'fin3000-edge-timer' : 'fin3000-firefox-timer') + (prod ? '' : '-qa') ||
    profile.redirectUri !==
      (edge ? `https://${identity.extensionId}.chromiumapp.org/` : `https://${prod ? 'a086c2adfc379a0f654784b1eb316305e2a29c10' : '2ace9a4a44792c4b2d137142c71c42591e8365fd'}.extensions.allizom.org/`)
  )
    throw timerError('PROFILE_INVALID', 'Feste Profilidentität wurde verändert.');
  for (const origin of [profile.apiOrigin, profile.frontendOrigin]) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (!prod && (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)))
    )
      throw timerError('ORIGIN_INVALID', 'QA benötigt eine exakte HTTP-Loopback-Origin.');
  }
  if (
    prod &&
    (profile.apiOrigin !== 'https://api.fin3000.com' ||
      profile.frontendOrigin !== 'https://app.fin3000.com')
  )
    throw timerError('ORIGIN_INVALID', 'Produktions-Origin wurde verändert.');
  return profile;
}
export function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw timerError(
      'CHECK_FAILED',
      `${label}: ${result.stdout || result.stderr || result.error?.message}`,
      4,
    );
  return result.stdout.trim();
}
export function typecheckTimer() {
  runNode(
    [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(timerRoot, 'tsconfig.json'),
      '--noEmit',
    ],
    'TypeScript',
  );
  return { status: 'PASS', check: 'typecheck' };
}
export async function runCli(handler, help, extra = []) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), extra);
    if (options.help) {
      process.stdout.write(help + '\n');
      return;
    }
    const result = await handler(options);
    process.stdout.write(
      options.json
        ? JSON.stringify(result) + '\n'
        : Object.entries(result)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join('\n') + '\n',
    );
  } catch (error) {
    const value =
      error instanceof ProductCliError
        ? error
        : timerError('CHECK_FAILED', error instanceof Error ? error.message : String(error), 4);
    const payload = {
      status: 'FAIL',
      code: value.code,
      problem: value.message,
      cause: value.causeText,
      next: value.next,
    };
    process.stderr.write(
      options?.json || process.argv.includes('--json')
        ? JSON.stringify(payload) + '\n'
        : `${payload.code}: ${payload.cause}\n${payload.next}\n`,
    );
    process.exitCode = value.exitCode;
  }
}
export function isMain(meta) {
  return !!process.argv[1] && meta === pathToFileURL(process.argv[1]).href;
}
// Firefox match patterns reject ports (Mozilla bugs 1362809/1468162).
// Runtime config still pins the full API origin, including the isolated QA port.
export function firefoxHostPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}
if (isMain(import.meta.url)) {
  const command = process.argv.splice(2, 1)[0];
  await runCli(() => {
    if (command === 'typecheck') return typecheckTimer();
    if (command === 'test')
      return {
        status: 'PASS',
        output: runNode(['--test', 'scripts/timer-extension.test.mjs'], 'Timer tests'),
      };
    throw timerError('ARGUMENT_INVALID', 'Befehl muss typecheck oder test sein.');
  }, 'timer-extension-cli.mjs <typecheck|test> [--json] [--help]');
}

export async function edgeIdentity(profile) {
  const identities = JSON.parse(await readFile(path.join(timerRoot, 'config/edge-keys.json'), 'utf8'));
  const identity = identities[profile];
  const expected = profile === 'production' ? 'mefjglidfjkjajheckkgnlhleldpddmo' : 'dmajiladcmjicohaacjjiklgjcaihlbk';
  const derived = createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex')
    .slice(0, 32).replace(/[0-9a-f]/g, (x) => String.fromCharCode(97 + parseInt(x, 16)));
  if (identity.extensionId !== expected || derived !== expected)
    throw timerError('PROFILE_INVALID', 'Edge-Schlüssel und feste Extension-ID passen nicht zusammen.');
  return identity;
}
export function artifactDirectory(profile, browser = 'firefox') {
  return path.join(repoRoot, 'dist/timer-extension', ...(browser === 'edge' ? ['edge'] : []), profile);
}
