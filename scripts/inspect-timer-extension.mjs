import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, productLocales } from './build-utils.mjs';
import {
  repoRoot,
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
export async function inspectTimer(unpacked, profile = 'qa') {
  const config = await loadTimerProfile(profile);
  const builtConfig = JSON.parse(await readFile(path.join(unpacked, 'config.json'), 'utf8'));
  if (canonicalJson(builtConfig) !== canonicalJson(config))
    throw timerError(
      'ARTIFACT_INVALID',
      'Paketprofil stimmt nicht mit der Konfiguration überein.',
      4,
    );
  const manifest = JSON.parse(await readFile(path.join(unpacked, 'manifest.json'), 'utf8'));
  const permissions = ['activeTab', 'scripting', 'menus', 'identity', 'alarms', 'notifications'];
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== config.extensionVersion ||
    manifest.incognito !== 'not_allowed' ||
    canonicalJson(manifest.permissions) !== canonicalJson(permissions) ||
    canonicalJson(manifest.host_permissions) !==
      canonicalJson([firefoxHostPattern(config.apiOrigin)]) ||
    canonicalJson(manifest.background) !==
      canonicalJson({ scripts: ['src/background.js'], type: 'module' }) ||
    manifest.browser_specific_settings?.gecko?.id !== config.extensionId ||
    manifest.browser_specific_settings.gecko.strict_min_version !== '140.0' ||
    canonicalJson(manifest.browser_specific_settings.gecko.data_collection_permissions) !==
      canonicalJson({ required: ['authenticationInfo', 'websiteContent'] }) ||
    [
      'content_scripts',
      'externally_connectable',
      'web_accessible_resources',
      'optional_permissions',
      'optional_host_permissions',
    ].some((key) => key in manifest)
  )
    throw timerError('ARTIFACT_INVALID', 'Manifest verletzt den Firefox-Vertrag.', 4);
  const expected = [
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
    distribution: 'unsigned-firefox-xpi',
  };
}
if (isMain(import.meta.url))
  await runCli(
    (o) =>
      inspectTimer(
        o.path || path.join(repoRoot, 'dist/timer-extension', o.profile, 'unpacked'),
        o.profile,
      ),
    'Inspect Firefox timer artifact. --profile qa|production [--path unpacked-directory] [--json] [--help]',
    ['--path'],
  );
