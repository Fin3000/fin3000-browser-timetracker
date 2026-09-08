import { build as bundle } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizedZip } from './build-utils.mjs';
import { canonicalJson, productLocales, sha256 } from './build-utils.mjs';
import {
  repoRoot,
  edgeIdentity,
  artifactDirectory,
  timerRoot,
  loadTimerProfile,
  firefoxHostPattern,
  runNode,
  runCli,
  isMain,
} from './timer-extension-cli.mjs';
import { inspectTimer } from './inspect-timer-extension.mjs';

export async function buildTimer(profileName = 'qa', outputOverride, browser = 'firefox') {
  const config = await loadTimerProfile(profileName, browser);
  const output = outputOverride || artifactDirectory(profileName, browser);
  const unpacked = path.join(output, 'unpacked');
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(unpacked, 'src'), { recursive: true });
  runNode(
    [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '-p',
      path.join(timerRoot, 'tsconfig.json'),
      '--outDir',
      path.join(unpacked, 'src'),
    ],
    'Timer compilation',
  );
  if (browser === 'edge') await bundle({ entryPoints: [path.join(timerRoot, 'src/edge-content.ts')], outfile: path.join(unpacked, 'src/edge-content.js'), bundle: true, format: 'iife', target: 'chrome152', logLevel: 'silent' });
  else await rm(path.join(unpacked, 'src/edge-content.js'));
  const template = await readFile(path.join(timerRoot, `manifest.${browser}.template.json`), 'utf8');
  await writeFile(
    path.join(unpacked, 'manifest.json'),
    template
      .replaceAll('__EXTENSION_VERSION__', config.extensionVersion)
      .replaceAll('__EXTENSION_ID__', config.extensionId)
      .replaceAll('__API_ORIGIN__/*', firefoxHostPattern(config.apiOrigin))
      .replaceAll('__EDGE_PUBLIC_KEY__', browser === 'edge' ? (await edgeIdentity(profileName)).key : ''),
  );
  await writeFile(path.join(unpacked, 'config.json'), canonicalJson(config) + '\n');
  for (const name of ['popup.html', 'popup.css', 'PRIVACY.md'])
    await copyFile(path.join(timerRoot, name), path.join(unpacked, name));
  await copyFile(
    path.join(repoRoot, 'assets/icon.png'),
    path.join(unpacked, 'icon.png'),
  );
  await copyFile(
    path.join(repoRoot, 'assets/inter.woff2'),
    path.join(unpacked, 'inter.woff2'),
  );
  await copyFile(path.join(repoRoot, 'assets/Inter-OFL.txt'), path.join(unpacked, 'Inter-OFL.txt'));
  for (const locale of productLocales) {
    await mkdir(path.join(unpacked, '_locales', locale), { recursive: true });
    await copyFile(
      path.join(timerRoot, '_locales', locale, 'messages.json'),
      path.join(unpacked, '_locales', locale, 'messages.json'),
    );
  }
  const inspection = await inspectTimer(unpacked, profileName, browser);
  const xpi = path.join(output, `fin3000-${browser}-timer-${profileName}.${browser === 'edge' ? 'zip' : 'xpi'}`);
  await normalizedZip(unpacked, xpi);
  return {
    status: 'READY',
    profile: profileName,
    version: config.extensionVersion,
    extensionId: config.extensionId,
    oauthRedirect: config.redirectUri,
    apiOrigin: config.apiOrigin,
    frontendOrigin: config.frontendOrigin,
    unpacked,
    ...(browser === 'edge' ? { zip: xpi } : { xpi }),
    browser,
    sha256: sha256(await readFile(xpi)),
    inspection,
  };
}
if (isMain(import.meta.url))
  await runCli(
    (o) => buildTimer(o.profile, undefined, o.browser),
    'Build Firefox XPI (unsigned) or Edge ZIP (unpacked installation). --browser firefox|edge. --profile qa|production [--json] [--help]. QA_SLUG selects isolated ports.',
  );
