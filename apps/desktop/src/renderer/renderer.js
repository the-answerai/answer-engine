const bridge = window.answerEngine;
const channelSelect = document.querySelector('#channel');
const banner = document.querySelector('#channel-banner');
const confirmation = document.querySelector('#confirmation');
const confirmationCopy = document.querySelector('#confirmation-copy');
const confirmButton = document.querySelector('#confirm-action');
const cancelButton = document.querySelector('#cancel-action');
const message = document.querySelector('#message');
let pendingAction;
let confirmationTrigger;
let busy = false;
let currentStatus;

function channel() { return channelSelect.value; }
function setText(selector, value) { document.querySelector(selector).textContent = value; }
function describeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function setBusy(value) {
  busy = value;
  syncControlAvailability();
}
function syncControlAvailability() {
  document.querySelectorAll('button, select, input').forEach((control) => { control.disabled = busy; });
  const adoptButton = document.querySelector('[data-action="adopt"]');
  const adoptionAvailable = currentStatus?.legacyAdoptionAvailable === true;
  adoptButton.hidden = !adoptionAvailable;
  if (!busy && adoptionAvailable) {
    document.querySelectorAll('.controls button:not([data-action="adopt"])')
      .forEach((control) => { control.disabled = true; });
  }
  if (!busy && currentStatus?.runtimeMode === 'fixture') {
    document.querySelector('#launch-at-login').disabled = true;
  }
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
  currentStatus = status;
  document.body.dataset.runtimeMode = status.runtimeMode;
  document.querySelector('#mode-badge').hidden = status.runtimeMode !== 'fixture';
  const healthDot = document.querySelector('#health-dot');
  healthDot.className = `health-dot ${status.runtimeMode === 'fixture' ? '' : status.healthy ? 'healthy' : 'unhealthy'}`;
  setText('#health-label', status.runtimeMode === 'fixture'
    ? 'Demo only — no runtime'
    : status.healthy ? 'Healthy and ready' : status.installed ? 'Needs attention' : 'Not installed');
  setText('#release', status.release ?? 'Not available');
  setText('#services', status.runningServices.length ? status.runningServices.join(', ') : 'None running');
  setText('#api-url', status.apiUrl);
  setText('#checked-at', new Date(status.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  setText('#status-detail', status.runtimeMode === 'fixture'
    ? 'This is a simulated launcher preview. No local service, external web app, or logs folder is available.'
    : status.legacyAdoptionAvailable
      ? 'A verified legacy stable home is ready to adopt. Adoption adds ownership metadata only and does not start or migrate data.'
      : status.legacyAdoptionError
        ? status.legacyAdoptionError
        : status.healthy
          ? `${status.channel} is responding. Closing this window will not stop it.`
          : 'Use Repair for an actionable recovery attempt. Your data is preserved.');
  syncControlAvailability();
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
    const status = await bridge.run({ channel: channel(), action });
    renderStatus(status);
    showMessage(status.runtimeMode === 'fixture'
      ? 'Demo mode simulated the control; no runtime action occurred.'
      : `${action[0].toUpperCase()}${action.slice(1)} completed for ${channel()}.`);
  } catch (error) {
    showMessage(`${describeError(error)} No other channel was changed.`, true);
  } finally { setBusy(false); }
}

document.querySelector('#refresh').addEventListener('click', refresh);
channelSelect.addEventListener('change', () => { currentStatus = undefined; updateChannelPresentation(); void refresh(); });
document.querySelector('.controls').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy) return;
  const prompt = button.dataset.confirm;
  if (!prompt) { void run(button.dataset.action); return; }
  pendingAction = button.dataset.action;
  confirmationTrigger = button;
  confirmationCopy.textContent = `${prompt} Selected channel: ${channel().toUpperCase()}.`;
  confirmation.hidden = false;
  confirmButton.focus();
});
confirmButton.addEventListener('click', async () => {
  if (!pendingAction) return;
  const action = pendingAction;
  const returnFocus = confirmationTrigger;
  pendingAction = undefined;
  confirmationTrigger = undefined;
  confirmation.hidden = true;
  await run(action);
  if (returnFocus && !returnFocus.hidden && !returnFocus.disabled) returnFocus.focus();
  else document.querySelector('#refresh').focus();
});
cancelButton.addEventListener('click', () => {
  const returnFocus = confirmationTrigger;
  pendingAction = undefined;
  confirmationTrigger = undefined;
  confirmation.hidden = true;
  returnFocus?.focus();
});
document.querySelector('#open-ui').addEventListener('click', async () => {
  try { const result = await bridge.openUi(channel()); showMessage(result.message, !result.opened); }
  catch (error) { showMessage(describeError(error), true); }
});
document.querySelector('#open-logs').addEventListener('click', async () => {
  try { const result = await bridge.openLogs(channel()); showMessage(result.message, !result.opened); }
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
