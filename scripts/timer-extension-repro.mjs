import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTimer } from './build-timer-extension.mjs';
import { runCli, isMain, timerError } from './timer-extension-cli.mjs';

export async function reproducibleTimer(profile, browser = 'firefox') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fin3000-timer-repro-'));
  try {
    const first = await buildTimer(profile, path.join(root, 'first'), browser);
    const second = await buildTimer(profile, path.join(root, 'second'), browser);
    if (first.sha256 !== second.sha256)
      throw timerError('REPRO_FAILED', 'Die zwei Pakete unterscheiden sich.', 4);
    return { status: 'PASS', profile, sha256: first.sha256 };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url))
  await runCli(
    (o) => reproducibleTimer(o.profile, o.browser),
    'Build twice in isolated temporary folders and compare package SHA-256. --browser firefox|edge. --profile qa|production [--json] [--help]',
  );
