import { EventEmitter } from 'node:events';
import { fetchChannel, openFeed, readEvent } from './tradingview.mjs';
import { logEvent } from './logging.mjs';

export class Relay extends EventEmitter {
  constructor(delivery, { getChannel = fetchChannel, connect = openFeed, retryMs = 1000, outageMs = 60000, heartbeatMs = 30000, log = logEvent } = {}) {
    super(); Object.assign(this, { delivery, getChannel, connect, retryMs, outageMs, heartbeatMs, log });
    this.state = { connection: 'waiting', detail: 'Enter your TradingView cookies to connect.', connectedAt: null };
    this.generation = 0; this.attempt = 0; this.outageReported = false; this.authReported = false;
  }
  update(connection, detail) {
    const messages = {
      connecting: ['INFO', 'Connecting to TradingView.'],
      connected: ['INFO', 'TradingView connected.'],
      retrying: ['WARN', 'TradingView disconnected or connection failed; reconnecting automatically.'],
      auth: ['ERROR', 'TradingView session rejected; replace both cookies on the settings page.'],
    };
    if (connection !== this.state.connection && messages[connection]) this.log(...messages[connection]);
    this.state = { ...this.state, connection, detail }; this.emit('change');
  }
  notify(message, needsSettings = false) { this.delivery.notice(message, needsSettings).catch(() => {}); }
  async prepare(cookies) {
    const channel = await this.getChannel(cookies);
    return this.connect(channel, cookies);
  }
  activate(cookies, socket) {
    this.stop(); this.cookies = cookies; const generation = this.generation;
    this.attach(socket, generation);
    this.everConnected = true;
    this.authReported = false; this.outageReported = false;
    this.notify('TradingView connected. Price alerts are being forwarded.');
  }
  start(cookies) {
    this.stop(); this.cookies = cookies;
    this.reconnect(this.generation);
  }
  async reconnect(generation) {
    if (generation !== this.generation) return;
    this.update('connecting', 'Connecting to TradingView…');
    try {
      const socket = await this.prepare(this.cookies);
      if (generation !== this.generation) { socket.terminate(); return; }
      this.attach(socket, generation);
      if (!this.everConnected || this.outageReported || this.authReported) {
        this.notify(this.everConnected ? 'TradingView connection restored.' : 'TradingView connected. Price alerts are being forwarded.');
      }
      this.everConnected = true; this.outageReported = false; this.authReported = false;
    } catch (error) {
      if (generation !== this.generation) return;
      if (error.code === 'AUTH') {
        clearTimeout(this.outageTimer); this.outageTimer = null;
        this.update('auth', 'TradingView does not recognize this session. Paste fresh cookies and reconnect.');
        if (!this.authReported) this.notify('TradingView session is invalid. Open the settings page to replace both cookies.', true);
        this.authReported = true;
      } else {
        this.update('retrying', ['HTTP', 'PROTOCOL'].includes(error.code) ? error.message : 'Connection failed. Retrying automatically.');
        this.schedule(generation);
      }
    }
  }
  schedule(generation) {
    if (!this.outageTimer && !this.outageReported) {
      this.outageTimer = setTimeout(() => {
        this.outageTimer = null; this.outageReported = true;
        this.log('WARN', 'TradingView outage threshold reached; automatic reconnection is still active.');
        this.notify('TradingView has been disconnected for more than a minute. Automatic reconnection is active.');
      }, this.outageMs);
    }
    const wait = Math.min(60000, this.retryMs * 2 ** Math.min(this.attempt++, 6));
    const delayMs = Math.round(wait + Math.random() * wait * 0.2);
    this.log('INFO', `TradingView reconnect attempt ${this.attempt} scheduled in ${delayMs} ms.`);
    this.retryTimer = setTimeout(() => this.reconnect(generation), delayMs);
  }
  attach(socket, generation) {
    this.socket = socket;
    clearTimeout(this.outageTimer); this.outageTimer = null;
    this.state.connectedAt = new Date().toISOString();
    this.update('connected', 'TradingView is connected. You can close this page.');
    let alive = true;
    socket.on('pong', () => { alive = true; });
    this.heartbeat = setInterval(() => {
      if (!alive) { this.log('WARN', 'TradingView heartbeat timed out; closing the connection to reconnect.'); socket.terminate(); return; }
      alive = false; socket.ping();
    }, this.heartbeatMs);
    this.stableTimer = setTimeout(() => { this.attempt = 0; }, 30000);
    socket.on('message', data => {
      if (generation !== this.generation) return;
      const event = readEvent(data);
      if (event?.type === 'channel-change') { this.log('INFO', 'TradingView requested a channel refresh; reconnecting.'); socket.terminate(); return; }
      if (event?.type === 'alert') this.delivery.alert(event.payload).catch(() => {});
    });
    socket.once('close', () => {
      if (generation !== this.generation) return;
      clearInterval(this.heartbeat); clearTimeout(this.stableTimer);
      this.update('retrying', 'Connection lost. Reconnecting automatically.');
      this.schedule(generation);
    });
  }
  stop() {
    this.generation++;
    clearTimeout(this.retryTimer); clearTimeout(this.stableTimer); clearTimeout(this.outageTimer);
    clearInterval(this.heartbeat); this.outageTimer = null;
    this.socket?.terminate(); this.socket = null;
    this.attempt = 0;
  }
}
