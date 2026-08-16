const bridge = window.answerEngine;
const channelSelect = document.querySelector('#channel');
const banner = document.querySelector('#channel-banner');
const confirmation = document.querySelector('#confirmation');
const confirmationCopy = document.querySelector('#confirmation-copy');
const confirmButton = document.querySelector('#confirm-action');
const cancelButton = document.querySelector('#cancel-action');
const message = document.querySelector('#message');
let pendingAction;
let busy = false;

function channel() { return channelSelect.value; }
function setText(selector, value) { document.querySelector(selector).textContent = value; }
function describeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, select, input').forEach((control) => { control.disabled = value; });
}
function showMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle('error', error);
}
function updateChannelPresentation() {
  const selected = channel();
  document.body.dataset.channel = selected;
  banner.querySelector('#channel-banner-title').textContent = selected === 'staging'
    ? 'STAGING — isolated runtime'
    : 'Stable runtime';
  banner.querySelector('#channel-banner-copy').textContent = selected === 'staging'
    ? 'Separate ports, storage, credentials, and release history. Never production data.'
    : 'Your primary local data and services.';
}
function renderStatus(status) {
  const healthDot = document.querySelector('#health-dot');
  healthDot.className = `health-dot ${status.healthy ? 'healthy' : 'unhealthy'}`;
  setText('#health-label', status.healthy ? 'Healthy and ready' : status.installed ? 'Needs attention' : 'Not installed');
  setText('#release', status.release ?? 'Not available');
  setText('#services', status.runningServices.length ? status.runningServices.join(', ') : 'None running');
  setText('#api-url', status.apiUrl);
  setText('#checked-at', new Date(status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  setText('#status-detail', status.healthy
    ? `${status.channel} is responding. Closing this window will not stop it.`
    : 'Use Repair for an actionable recovery attempt. Your data is preserved.');
}
async function refresh() {
  if (busy) return;
  setBusy(true);
  showMessage('Checking the selected runtime…');
  try {
    renderStatus(await bridge.getStatus(channel()));
    showMessage('Status is current.');
  } catch (error) {
    showMessage(`${describeError(error)} Try Repair, or open logs for details.`, true);
  } finally { setBusy(false); }
}
async function run(action) {
  setBusy(true);
  showMessage(`${action[0].toUpperCase()}${action.slice(1)} in progress for ${channel()}…`);
  try {
    renderStatus(await bridge.run({ channel: channel(), action }));
    showMessage(`${action[0].toUpperCase()}${action.slice(1)} completed for ${channel()}.`);
  } catch (error) {
    showMessage(`${describeError(error)} No other channel was changed.`, true);
  } finally { setBusy(false); }
}

document.querySelector('#refresh').addEventListener('click', refresh);
channelSelect.addEventListener('change', () => { updateChannelPresentation(); void refresh(); });
document.querySelector('.controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const prompt = button.dataset.confirm;
  if (!prompt) { void run(button.dataset.action); return; }
  pendingAction = button.dataset.action;
  confirmationCopy.textContent = `${prompt} Selected channel: ${channel().toUpperCase()}.`;
  confirmation.hidden = false;
  confirmButton.focus();
});
confirmButton.addEventListener('click', () => {
  if (!pendingAction) return;
  const action = pendingAction;
  pendingAction = undefined;
  confirmation.hidden = true;
  void run(action);
});
cancelButton.addEventListener('click', () => {
  pendingAction = undefined;
  confirmation.hidden = true;
  document.querySelector(`[data-action="stop"]`).focus();
});
document.querySelector('#open-ui').addEventListener('click', async () => {
  try { await bridge.openUi(channel()); showMessage(`Opened the ${channel()} web app.`); }
  catch (error) { showMessage(describeError(error), true); }
});
document.querySelector('#open-logs').addEventListener('click', async () => {
  try { await bridge.openLogs(channel()); showMessage(`Opened ${channel()} logs.`); }
  catch (error) { showMessage(`${describeError(error)} Run Repair to recreate missing runtime folders.`, true); }
});
document.querySelector('#launch-at-login').addEventListener('change', async (event) => {
  try { event.target.checked = await bridge.setLaunchAtLogin(event.target.checked); }
  catch (error) { showMessage(describeError(error), true); }
});

updateChannelPresentation();
void Promise.all([
  refresh(),
  bridge.getLaunchAtLogin().then((enabled) => { document.querySelector('#launch-at-login').checked = enabled; }),
]);
