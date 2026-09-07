import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  repoRoot,
  loadTimerProfile,
  runCli,
  isMain,
  timerError,
} from './timer-extension-cli.mjs';

export async function doctorTimer(profile = 'qa') {
  const config = await loadTimerProfile(profile);
  if (Number(process.versions.node.split('.')[0]) < 22)
    throw timerError('NODE_REQUIRED', 'Node 22 oder neuer erforderlich.', 3);
  try {
    await access(path.join(repoRoot, 'node_modules/typescript/bin/tsc'));
  } catch {
    throw timerError('DEPENDENCIES_REQUIRED', 'Zuerst npm ci im Erweiterungs-Repository ausführen.', 3);
  }
  const zip = spawnSync('zip', ['-v'], { encoding: 'utf8' });
  if (zip.status !== 0) throw timerError('ZIP_REQUIRED', 'Das lokale zip-Programm fehlt.', 3);
  const firefox = process.env.FIN3000_FIREFOX || 'firefox';
  const geckodriver = process.env.FIN3000_GECKODRIVER || 'geckodriver';
  const versions = {};
  for (const [name, binary] of Object.entries({ firefox, geckodriver })) {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    versions[name] = result.status === 0 ? result.stdout.trim().split('\n')[0] : 'MISSING';
  }
  let stack = 'NOT_CHECKED_PRODUCTION';
  if (profile === 'qa') {
    if (!process.env.QA_SLUG)
      throw timerError(
        'QA_SLUG_REQUIRED',
        'QA_SLUG des isolierten Backend-/Frontend-Stacks setzen.',
        3,
      );
    const checks = await Promise.allSettled(
      [config.apiOrigin + '/api/v1/auth/branding/', config.frontendOrigin + '/'].map(
        async (url) => {
          const response = await fetch(url, {
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error('unreachable');
          await response.body?.cancel();
        },
      ),
    );
    if (checks.some((r) => r.status === 'rejected'))
      throw timerError(
        'QA_STACK_REQUIRED',
        'Isolierten Backend- und Frontend-Stack mit demselben QA_SLUG starten.',
        3,
      );
    stack = 'REACHABLE';
  }
  return {
    status: 'READY',
    profile,
    node: process.versions.node,
    apiOrigin: config.apiOrigin,
    frontendOrigin: config.frontendOrigin,
    oauthClientId: config.oauthClientId,
    oauthRedirect: config.redirectUri,
    stack,
    ...versions,
    nativeQa: Object.values(versions).includes('MISSING')
      ? 'BLOCKED: FIN3000_FIREFOX und FIN3000_GECKODRIVER setzen.'
      : 'AVAILABLE',
    next: 'npm run timer-extension:build:' + (profile === 'qa' ? 'qa' : 'production'),
  };
}
if (isMain(import.meta.url))
  await runCli(
    (o) => doctorTimer(o.profile),
    'Check local build prerequisites; reports native Firefox QA availability separately. --profile qa|production [--json] [--help]. Binary overrides: FIN3000_FIREFOX, FIN3000_GECKODRIVER.',
  );
