import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Delivery } from './notifications.mjs';
import { Relay } from './relay.mjs';
import { logEvent } from './logging.mjs';
import { configFromEnv, saveCookies, validateCookies } from './settings.mjs';

export function createApp({ relay, delivery, config, envPath = '.env' }) {
  const streams = new Set();
  let saving = false;
  const snapshot = () => ({ ...relay.state, delivery: delivery.status, destination: `${config.url}/${config.topic}`, saving });
  const broadcast = () => {
    const event = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const stream of streams) stream.write(event);
  };
  relay.on('change', broadcast);
  delivery.onChange = broadcast;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const port = server.address()?.port;
    const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
    if (config.publicUrl) origins.push(config.publicUrl);
    const allowedOrigins = origins.filter(origin => new URL(origin).host === req.headers.host);
    if (!allowedOrigins.length) {
      reply(403, { error: 'Use the configured address of the settings page.' }); return;
    }
    try {
      if (req.method === 'GET' && req.url === '/api/status') { reply(200, snapshot()); return; }
      if (req.method === 'GET' && req.url === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`data: ${JSON.stringify(snapshot())}\n\n`); streams.add(res);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 20000);
        res.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
        return;
      }
      if (req.method === 'POST' && req.url === '/api/cookies') {
        if (!allowedOrigins.includes(req.headers.origin) || req.headers['content-type'] !== 'application/json') {
          reply(403, { error: 'This action is only available from the settings page.' }); return;
        }
        if (saving) { reply(409, { error: 'Another settings check is in progress. Please wait.' }); return; }
        saving = true; broadcast();
        let candidate;
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 12000) { reply(413, { error: 'Input is too large.' }); return; }
          }
          let input;
          try { input = JSON.parse(body); }
          catch { reply(400, { error: 'Invalid request.' }); return; }
          const cookies = input;
          validateCookies(cookies);
          candidate = await relay.prepare(cookies);
          if (candidate.readyState !== 1) throw new Error();
          await saveCookies(envPath, cookies);
          if (candidate.readyState === 1) {
            relay.activate(cookies, candidate);
            reply(200, { message: 'Cookies saved. TradingView is connected.' });
          } else {
            relay.start(cookies);
            reply(200, { message: 'Cookies verified and saved. Reconnecting now.' });
          }
        } catch (error) {
          candidate?.terminate();
          const safe = ['INPUT', 'AUTH', 'HTTP', 'PROTOCOL', 'NETWORK', 'NTFY'].includes(error.code);
          reply(error.code === 'INPUT' ? 400 : 502, { error: safe ? error.message : 'Connecting or saving failed. Please try again.' });
        } finally { saving = false; broadcast(); }
        return;
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css'], '/client.js': ['client.js', 'text/javascript'], '/logo.png': ['logo.png', 'image/png'], '/favicon.ico': ['favicon.ico', 'image/x-icon'], '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'] };
      if (req.method === 'GET' && files[req.url]) {
        const [file, type] = files[req.url];
        const data = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }); res.end(data); return;
      }
      reply(404, { error: 'Not found.' });
    } catch { if (!res.headersSent) reply(500, { error: 'The request could not be processed.' }); else res.end(); }
  });
  server.on('close', () => relay.off('change', broadcast));
  server.closeStreams = () => { for (const stream of streams) stream.end(); };
  return server;
}

async function main() {
  try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = configFromEnv();
  const delivery = new Delivery(config); await delivery.load();
  const relay = new Relay(delivery);
  const server = createApp({ relay, delivery, config });
  server.listen(config.port, config.host, () => {
    logEvent('INFO', `Settings page: ${config.publicUrl || `http://localhost:${config.port}`}`);
    logEvent('INFO', 'App started. Cookies, tokens, private channels and alert content are not logged.');
    delivery.started().catch(() => {});
    const cookies = { sessionid: process.env.TV_SESSIONID, sessionid_sign: process.env.TV_SESSIONID_SIGN };
    if (cookies.sessionid && cookies.sessionid_sign) relay.start(cookies);
    else logEvent('INFO', 'No complete saved TradingView session; waiting for cookies on the settings page.');
  });
  server.on('error', () => { logEvent('ERROR', 'Could not start the web server. Check that the port is available.'); process.exitCode = 1; });
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    logEvent('INFO', 'Stopping app; waiting for queued notifications.'); relay.stop(); server.closeStreams(); server.close();
    const timeout = setTimeout(() => { logEvent('ERROR', 'Shutdown timed out while draining the notification queue.'); process.exit(1); }, 15000);
    await delivery.chain; clearTimeout(timeout); server.closeAllConnections();
    logEvent('INFO', 'App stopped.');
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { logEvent('ERROR', 'Startup failed. Check configuration, saved state and local file permissions.'); process.exitCode = 1; });
}
