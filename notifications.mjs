import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { alertNotification, ICON_URL, errorWithCode } from './tradingview.mjs';
import { writePrivateJson } from './settings.mjs';
import { logEvent } from './logging.mjs';

// Only known codes and our own descriptions may cross into logs or the UI.
export function networkFailure(error, depth = 0) {
  if (!error || depth > 4) return null;
  const reasons = {
    ENOTFOUND: 'DNS lookup failed (ENOTFOUND). Check the server hostname and container DNS.',
    EAI_AGAIN: 'DNS lookup temporarily failed (EAI_AGAIN). Check container DNS.',
    ECONNREFUSED: 'Connection refused (ECONNREFUSED). Check the server port and firewall.',
    ENETUNREACH: 'Network unreachable (ENETUNREACH). Check container routing.',
    EHOSTUNREACH: 'Host unreachable (EHOSTUNREACH). Check routing and firewall.',
    ECONNRESET: 'Connection reset (ECONNRESET). Check the server or reverse proxy.',
    ETIMEDOUT: 'Connection timed out (ETIMEDOUT). Check routing and firewall.',
    UND_ERR_CONNECT_TIMEOUT: 'Connection timed out (UND_ERR_CONNECT_TIMEOUT). Check routing and firewall.',
    UND_ERR_SOCKET: 'Connection closed unexpectedly (UND_ERR_SOCKET). Check the server or reverse proxy.',
    CERT_HAS_EXPIRED: 'TLS certificate expired (CERT_HAS_EXPIRED). Check the server certificate and system clock.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed (DEPTH_ZERO_SELF_SIGNED_CERT). Configure a trusted certificate.',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain is not trusted (SELF_SIGNED_CERT_IN_CHAIN). Check the server certificate chain.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate verification failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Check the server certificate chain.',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS issuer is not trusted (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). Check the server certificate chain.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname mismatch (ERR_TLS_CERT_ALTNAME_INVALID). Check the server URL and certificate.',
  };
  if (Object.hasOwn(reasons, error.code)) return reasons[error.code];
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'Request timed out. Check server reachability and response time.';
  const nested = networkFailure(error.cause, depth + 1);
  if (nested) return nested;
  if (Array.isArray(error.errors)) {
    const messages = [...new Set(error.errors.slice(0, 8).map(e => networkFailure(e, depth + 1)).filter(Boolean))];
    if (messages.length) return messages.join(' ');
  }
  return null;
}

export class Delivery {
  constructor({ url, topic, statePath, token = '', publicUrl = '', retryMs = 1000, onChange = () => {}, log = logEvent }) {
    Object.assign(this, { url, topic, statePath, token, publicUrl, retryMs, onChange, log });
    this.publishFailed = false;
    this.seen = new Set(); this.pending = new Map(); this.chain = Promise.resolve();
    this.status = { lastSent: null, error: null, pending: 0 };
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (!Array.isArray(saved) || !saved.every(id => typeof id === 'string')) throw new Error();
      this.seen = new Set(saved.slice(-10000));
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read deduplication state. Restore data/seen.json before starting.'); }
  }
  changed() { this.status.pending = this.pending.size; this.onChange(); }
  async publish(notification) {
    const failed = message => {
      this.publishFailed = true;
      this.log('ERROR', message);
      return errorWithCode('NTFY', message);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch(`${this.url}/`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          body: JSON.stringify({ topic: this.topic, ...notification }),
        });
      } catch (error) {
        // A timeout may occur after ntfy accepted the message: no blind retry.
        const reason = networkFailure(error) || 'Network or TLS request failed; no recognized error code was available.';
        throw failed(`ntfy: ${reason} Delivery may be uncertain; not automatically retried to avoid duplicates.`);
      }
      if (response.ok) {
        let receipt;
        try { receipt = await response.json(); } catch {}
        if (!receipt?.id || receipt.event !== 'message') throw failed('ntfy did not return a valid delivery receipt.');
        if (this.publishFailed) this.log('INFO', 'ntfy delivery recovered; the server accepted a new notification.');
        this.publishFailed = false;
        this.status.error = null; this.changed(); return;
      }
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        throw failed(`ntfy returned HTTP ${response.status} (redirect). Set NTFY_URL to the final server URL; redirects are not followed.`);
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        this.log('WARN', `ntfy returned HTTP ${response.status}; retry ${attempt + 1}/2 in ${this.retryMs * 2 ** attempt} ms.`);
        await delay(this.retryMs * 2 ** attempt); continue;
      }
      throw failed([401, 403].includes(response.status)
        ? `ntfy denied access (HTTP ${response.status}). Check the server URL, access token and permission to publish to this topic.`
        : `ntfy rejected the notification: HTTP ${response.status}.`);
    }
  }
  enqueue(task) {
    const run = this.chain.then(task);
    this.chain = run.catch(error => {
      if (error.code !== 'NTFY') this.log('ERROR', error.code === 'PROTOCOL'
        ? 'Notification processing failed: unsupported alert format.'
        : 'Could not persist notification state; check disk space and volume permissions.');
      this.status.error = ['NTFY', 'PROTOCOL'].includes(error.code) ? error.message : 'Could not save the notification state locally.';
      this.changed();
    });
    return run;
  }
  alert(payload) {
    let notification;
    try { notification = alertNotification(payload); }
    catch (error) {
      this.log('ERROR', 'Alert rejected: missing or unsupported message, trigger ID or ticker.');
      this.status.error = error.message; this.changed(); return Promise.reject(error);
    }
    const id = String(payload.fire_id);
    if (this.seen.has(id)) return Promise.resolve();
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size >= 1000) {
      this.status.error = 'Notification queue full; an alert could not be added.';
      this.log('ERROR', 'Notification queue full; an alert could not be added.');
      this.changed(); return Promise.reject(errorWithCode('NTFY', this.status.error));
    }
    const run = this.enqueue(async () => {
      await this.publish(notification);
      this.seen.add(id);
      if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
      await writePrivateJson(this.statePath, [...this.seen]);
      this.status.lastSent = new Date().toISOString(); this.changed();
    }).finally(() => { this.pending.delete(id); this.changed(); });
    this.pending.set(id, run); this.changed();
    return run;
  }
  started() {
    this.log('INFO', 'Sending app startup notification to ntfy.');
    return this.enqueue(async () => {
      await this.publish({ title: 'TV ntfy started', message: 'The app has started. This confirms notification delivery to ntfy, not the TradingView connection.', icon: ICON_URL });
      this.log('INFO', 'ntfy accepted the app startup notification.');
    });
  }
  notice(message, needsSettings = false) {
    return this.enqueue(() => this.publish({ title: 'TradingView connection', message, icon: ICON_URL,
      ...(needsSettings && this.publicUrl ? { actions: [{ action: 'view', label: 'Open settings', url: this.publicUrl }] } : {}),
    }));
  }
}
