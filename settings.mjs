import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export function validateCookies(cookies) {
  if (!cookies || [cookies.sessionid, cookies.sessionid_sign].some(value =>
    typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value) || /[;'"\\,]/.test(value))) {
    throw Object.assign(new Error('Enter both cookie values, without the cookie name or a semicolon.'), { code: 'INPUT' });
  }
}

export async function writePrivateJson(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(data) + '\n', { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function saveCookies(path, cookies) {
  validateCookies(cookies);
  await saveEnvValues(path, { TV_SESSIONID: cookies.sessionid, TV_SESSIONID_SIGN: cookies.sessionid_sign });
}

// Internal keys and validated, single-line values only. Preserve unrelated settings.
async function saveEnvValues(path, values) {
  let text = '';
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  text = text.split('\n').filter(line => {
    const key = /^\s*(?:export\s+)?([A-Z_]+)\s*=/.exec(line)?.[1];
    return !Object.hasOwn(values, key);
  }).join('\n').trimEnd();
  text += '\n' + Object.entries(values).map(([key, value]) => `${key}='${value}'`).join('\n') + '\n';
  await writeFile(`${path}.tmp`, text, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export function normalizeNotificationUrl(value) {
  const invalid = () => Object.assign(new Error('Enter a valid http:// or https:// server URL without credentials, a query or a fragment.'), { code: 'INPUT' });
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid();
  return url.href.replace(/\/+$/, '').replaceAll("'", '%27');
}

export function configFromEnv() {
  const url = normalizeNotificationUrl(process.env.NTFY_URL || 'https://ntfy.sh');
  const topic = process.env.NTFY_TOPIC || 'tradingview-alerts';
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) throw new Error('Invalid NTFY_TOPIC.');
  const port = Number(process.env.PORT || 3080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const host = process.env.HOST || '127.0.0.1';
  let publicUrl = '';
  if (process.env.PUBLIC_URL) {
    const address = new URL(process.env.PUBLIC_URL);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password
      || address.pathname !== '/' || address.search || address.hash) throw new Error('Invalid PUBLIC_URL.');
    publicUrl = address.origin;
  }
  return { url, topic, port, host, publicUrl, token: process.env.NTFY_TOKEN || '', statePath: 'data/seen.json' };
}
