const form = document.querySelector('#cookies');
const button = document.querySelector('#connect');
const result = document.querySelector('#result');
const labels = { waiting: 'Not connected yet', connecting: 'Connecting…', connected: 'Connected to TradingView', retrying: 'Reconnecting', auth: 'Replace your cookies' };

function show(state) {
  document.querySelector('#status').textContent = labels[state.connection] || 'Unknown status';
  document.querySelector('#detail').textContent = state.detail;
  document.querySelector('#dot').className = `dot ${state.connection}`;
  document.querySelector('#destination').textContent = state.destination;
  const error = document.querySelector('#delivery-error');
  error.hidden = !state.delivery.error;
  error.textContent = state.delivery.error || '';
  if (state.delivery.lastSent) document.querySelector('#last-sent').textContent = `Last alert forwarded: ${new Date(state.delivery.lastSent).toLocaleString('en-GB')}`;
}

const events = new EventSource('/api/events');
events.onmessage = event => show(JSON.parse(event.data));
events.onerror = () => {
  document.querySelector('#status').textContent = 'Settings page disconnected from the app';
  document.querySelector('#detail').textContent = 'Check that the Node.js app is still running. This page will reconnect automatically.';
  document.querySelector('#dot').className = 'dot retrying';
};

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true; button.textContent = 'Checking connection…';
  result.className = ''; result.textContent = 'Checking your session. This may take a moment.';
  try {
    const response = await fetch('/api/cookies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const body = await response.json();
    if (!response.ok) { result.className = 'error'; result.textContent = body.error; }
    else { result.textContent = body.message; form.reset(); }
  } catch { result.className = 'error'; result.textContent = 'The app is unreachable. Check that it is still running.'; }
  finally { button.disabled = false; button.textContent = 'Connect →'; }
});
