import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, productLocales } from './build-utils.mjs';
import {
  repoRoot,
  edgeIdentity,
  artifactDirectory,
  loadTimerProfile,
  firefoxHostPattern,
  runCli,
  isMain,
  timerError,
} from './timer-extension-cli.mjs';

async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw timerError('ARTIFACT_INVALID', 'Symlinks sind im Paket nicht erlaubt.', 4);
    if (entry.isDirectory()) result.push(...(await files(root, relative)));
    else result.push(relative);
  }
  return result.sort();
}
export async function inspectTimer(unpacked, profile = 'qa', browser = 'firefox') {
  const config = await loadTimerProfile(profile, browser);
  const builtConfig = JSON.parse(await readFile(path.join(unpacked, 'config.json'), 'utf8'));
  if (canonicalJson(builtConfig) !== canonicalJson(config))
    throw timerError(
      'ARTIFACT_INVALID',
      'Paketprofil stimmt nicht mit der Konfiguration überein.',
      4,
    );
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
  const edge = browser === 'edge';
  const template = JSON.parse((await readFile(path.join(repoRoot, `manifest.${browser}.template.json`), 'utf8'))
    .replaceAll('__EXTENSION_VERSION__', config.extensionVersion)
    .replaceAll('__EXTENSION_ID__', config.extensionId)
    .replaceAll('__API_ORIGIN__/*', firefoxHostPattern(config.apiOrigin))
    .replaceAll('__EDGE_PUBLIC_KEY__', edge ? (await edgeIdentity(profile)).key : ''));
  if (canonicalJson(manifest) !== canonicalJson(template))
    throw timerError('ARTIFACT_INVALID', `Manifest verletzt den ${browser}-Vertrag.`, 4);
  const expected = [
    ...(edge ? ['src/edge-content.js'] : []),
    'manifest.json',
    'config.json',
    'popup.html',
    'popup.css',
    'PRIVACY.md',
    'icon.png',
    'inter.woff2',
    'Inter-OFL.txt',
    ...[
      'api',
      'background',
      'capture',
      'config',
      'coordinator',
      'oauth',
      'popup',
      'state',
      'types',
    ].map((name) => `src/${name}.js`),
    ...productLocales.map((locale) => `_locales/${locale}/messages.json`),
  ].sort();
  if (canonicalJson(await files(unpacked)) !== canonicalJson(expected))
    throw timerError('ARTIFACT_INVALID', 'Fehlende oder zusätzliche Paketdateien.', 4);
  let reference;
  for (const locale of productLocales) {
    const messages = JSON.parse(
      await readFile(path.join(unpacked, '_locales', locale, 'messages.json'), 'utf8'),
    );
    const keys = Object.keys(messages).sort().join();
    if (
      (reference && keys !== reference) ||
      Object.values(messages).some((value) => !value.message || typeof value.message !== 'string')
    )
      throw timerError('LOCALE_INVALID', `Ungültiger Katalog: ${locale}`, 4);
    reference = keys;
  }
  const html = await readFile(path.join(unpacked, 'popup.html'), 'utf8');
  if (/<script(?![^>]*src=)|\son\w+=|https?:\/\//i.test(html))
    throw timerError('ARTIFACT_INVALID', 'Inline- oder Remote-Code im Popup.', 4);
  return {
    status: 'PASS',
    files: expected.length,
    locales: productLocales.length,
    distribution: edge ? 'edge-unpacked-zip' : 'unsigned-firefox-xpi',
  };
}
if (isMain(import.meta.url))
  await runCli(
    (o) =>
      inspectTimer(
        o.path || path.join(artifactDirectory(o.profile, o.browser), 'unpacked'),
        o.profile,
        o.browser,
      ),
    'Inspect browser timer artifact. --browser firefox|edge. --profile qa|production [--path unpacked-directory] [--json] [--help]',
    ['--path'],
  );
