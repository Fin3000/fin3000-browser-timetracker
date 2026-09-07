// Build primitives extracted from fin3000-frontend f64f9a14; no sibling-repository imports.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, readdir, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

export const productLocales = [
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'es',
  'et',
  'fi',
  'fr',
  'ga',
  'hi',
  'hr',
  'hu',
  'it',
  'lt',
  'lv',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'sk',
  'sv',
  'tr',
  'uk',
];

export class ProductCliError extends Error {
  constructor(code, problem, cause, next, exitCode = 2) {
    super(problem);
    this.code = code;
    this.causeText = cause;
    this.next = next;
    this.exitCode = exitCode;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function filesRecursively(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory())
      result.push(...(await filesRecursively(path.join(directory, entry.name), relative)));
    else result.push(relative);
  }
  return result.sort();
}

export async function normalizedZip(unpacked, zipPath) {
  const files = await filesRecursively(unpacked);
  const epoch = new Date('1980-01-01T00:00:00.000Z');
  for (const relative of files) {
    const absolute = path.join(unpacked, relative);
    await chmod(absolute, 0o644);
    await utimes(absolute, epoch, epoch);
  }
  await rm(zipPath, { force: true });
  const result = spawnSync('zip', ['-X', '-q', zipPath, ...files], {
    cwd: unpacked,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'zip failed');
}

// Version 1 of the Fin3000 isolated QA port contract (frontend scripts/qa-serve.mjs).
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
export function djb2(value) {
  let hash = 5381;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash = (Math.imul(hash, 33) + byte) >>> 0;
  }
  return hash;
}

export function normalizeSlug(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new Error('QA_SLUG must be 1-63 lowercase ASCII letters, digits or hyphens.');
  }
  return value;
}

export function portsForSlug(slug) {
  const offset = djb2(normalizeSlug(slug)) % 500;
  return { backend: 8200 + offset, frontend: 4400 + offset };
}
