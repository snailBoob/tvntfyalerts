import WebSocket from 'ws';
import { validateCookies } from './settings.mjs';

export const ICON_URL = 'https://static.tradingview.com/static/images/favicon/apple-touch-icon-180x180.png';
export const errorWithCode = (code, message) => Object.assign(new Error(message), { code });

// Server-provided JSON only; never execute scripts from the chart page.
export function extractUser(html) {
  const match = /\bvar\s+user\s*=\s*(?=\{)/.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function cookieHeader(cookies) {
  validateCookies(cookies);
  return `sessionid=${cookies.sessionid}; sessionid_sign=${cookies.sessionid_sign}`;
}

export async function fetchChannel(cookies, url = 'https://www.tradingview.com/chart/') {
  const response = await fetch(url, {
    headers: { Cookie: cookieHeader(cookies) }, redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401) throw errorWithCode('AUTH', 'TradingView rejected the session. Replace both cookies.');
  if (!response.ok) throw errorWithCode('HTTP', `TradingView page: HTTP ${response.status}. This does not prove that your cookies have expired.`);
  const html = await response.text();
  if (/\bvar\s+is_authenticated\s*=\s*false\s*;/.test(html)) throw errorWithCode('AUTH', 'TradingView does not recognize this session. Replace both cookies.');
  const user = extractUser(html);
  if (typeof user?.private_channel !== 'string' || !/^[A-Za-z0-9_-]+$/.test(user.private_channel)) {
    throw errorWithCode('PROTOCOL', 'No valid personal channel found on the TradingView page.');
  }
  return user.private_channel;
}

export function openFeed(channel, cookies, base = 'wss://pushstream.tradingview.com/message-pipe-ws/') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}private_${channel}`, {
      headers: { Cookie: cookieHeader(cookies), Origin: 'https://www.tradingview.com' },
      handshakeTimeout: 15000, followRedirects: false, maxPayload: 1024 * 1024,
    });
    socket.on('error', () => reject(errorWithCode('NETWORK', 'WebSocket connection failed.')));
    socket.once('unexpected-response', (_request, response) => {
      reject(errorWithCode(response.statusCode === 401 ? 'AUTH' : 'HTTP', `WebSocket-handshake: HTTP ${response.statusCode}.`));
      response.resume(); socket.terminate();
    });
    socket.once('close', () => reject(errorWithCode('NETWORK', 'WebSocket connection closed.')));
    socket.once('open', () => resolve(socket));
  });
}

export function readEvent(data) {
  let envelope;
  try { envelope = JSON.parse(data.toString()); } catch { return null; }
  if (!(typeof envelope?.id === 'number' && envelope.id > 0)) return null;
  const text = envelope.text;
  if (text?.channel === 'pushstream_set_user_channel') return { type: 'channel-change' };
  if (text?.channel !== 'pricealerts' || text.content?.m !== 'alert_fired') return null;
  return { type: 'alert', payload: text.content.p };
}

export function alertNotification(payload) {
  if (!payload || typeof payload.message !== 'string' || !payload.message.length
    || !((typeof payload.fire_id === 'string' && payload.fire_id.length) || Number.isSafeInteger(payload.fire_id))) {
    throw errorWithCode('PROTOCOL', 'The alert is missing a usable message or trigger ID.');
  }
  let symbol = payload.pro_symbol ?? payload.symbol;
  if (typeof symbol === 'string' && (symbol.startsWith('=') || symbol.startsWith('{'))) {
    try { symbol = JSON.parse(symbol.replace(/^=/, '')).symbol; } catch { symbol = null; }
  }
  if (typeof symbol !== 'string' || !/^[A-Za-z0-9_-]+:[^\s<>]{1,150}$/.test(symbol)) {
    throw errorWithCode('PROTOCOL', 'The alert does not contain a recognizable exchange:ticker.');
  }
  const url = new URL('https://www.tradingview.com/chart/');
  url.searchParams.set('symbol', symbol);
  return { title: symbol, message: payload.message, icon: ICON_URL,
    actions: [{ action: 'view', label: 'TradingView', url: url.href }] };
}
