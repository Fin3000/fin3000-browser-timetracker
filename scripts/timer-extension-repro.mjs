import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTimer } from './build-timer-extension.mjs';
import { runCli, isMain, timerError } from './timer-extension-cli.mjs';

export async function reproducibleTimer(profile) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fin3000-timer-repro-'));
  try {
    const first = await buildTimer(profile, path.join(root, 'first'));
    const second = await buildTimer(profile, path.join(root, 'second'));
    if (first.sha256 !== second.sha256)
      throw timerError('REPRO_FAILED', 'Die zwei XPI-Dateien unterscheiden sich.', 4);
    return { status: 'PASS', profile, sha256: first.sha256 };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url))
  await runCli(
    (o) => reproducibleTimer(o.profile),
    'Build twice in isolated temporary folders and compare XPI SHA-256. --profile qa|production [--json] [--help]',
  );
