const $ = (id) => document.getElementById(id);

const ui = {
  showSender: $('showSender'),
  showReceiver: $('showReceiver'),
  senderPanel: $('senderPanel'),
  receiverPanel: $('receiverPanel'),
  globalStatus: $('globalStatus'),
  errorBox: $('errorBox'),
  warningBox: $('warningBox'),

  targetHost: $('targetHost'),
  targetPort: $('targetPort'),
  pairingCode: $('pairingCode'),
  connectBtn: $('connectBtn'),
  disconnectBtn: $('disconnectBtn'),
  shareBtn: $('shareBtn'),
  senderBadge: $('senderBadge'),
  activeDevice: $('activeDevice'),
  targetHint: $('targetHint'),

  listenPort: $('listenPort'),
  startReceiverBtn: $('startReceiverBtn'),
  stopReceiverBtn: $('stopReceiverBtn'),
  receiverBadge: $('receiverBadge'),
  receiverDetails: $('receiverDetails'),
  receiverCode: $('receiverCode'),
  receiverAddresses: $('receiverAddresses'),
  clientCount: $('clientCount'),
  receiverPlatform: $('receiverPlatform')
};

let senderConnected = false;
let sharing = false;

function setMode(mode) {
  const sender = mode === 'sender';
  ui.senderPanel.classList.toggle('hidden', !sender);
  ui.receiverPanel.classList.toggle('hidden', sender);
  ui.showSender.classList.toggle('active', sender);
  ui.showReceiver.classList.toggle('active', !sender);
  clearError();
}

function setGlobalStatus(text, state = 'neutral') {
  ui.globalStatus.textContent = text;
  ui.globalStatus.className = `status ${state}`;
}

function showError(error) {
  ui.errorBox.textContent = error?.message || String(error);
  ui.errorBox.classList.remove('hidden');
}

function clearError() {
  ui.errorBox.textContent = '';
  ui.errorBox.classList.add('hidden');
}

function showWarning(message) {
  ui.warningBox.textContent = message;
  ui.warningBox.classList.remove('hidden');
}

function clearWarning() {
  ui.warningBox.textContent = '';
  ui.warningBox.classList.add('hidden');
}

function renderSenderConnection(connected) {
  senderConnected = connected;
  ui.senderBadge.textContent = connected ? 'Connected' : 'Disconnected';
  ui.senderBadge.classList.toggle('good', connected);
  ui.connectBtn.disabled = connected;
  ui.disconnectBtn.disabled = !connected;
  ui.shareBtn.disabled = !connected;

  if (!connected) renderTarget({ target: 'laptop' });
  setGlobalStatus(connected ? 'Paired · Laptop active' : 'Idle', connected ? 'good' : 'neutral');
}

function renderTarget(state = {}) {
  const pending = state.pendingTarget;
  const target = state.target || 'laptop';
  sharing = target === 'pc';

  if (pending) {
    ui.activeDevice.textContent = pending === 'pc' ? 'Switching to PC…' : 'Switching to laptop…';
    ui.targetHint.textContent = 'Release all keys to complete the switch.';
    setGlobalStatus('Switching…', 'warn');
    return;
  }

  ui.activeDevice.textContent = target === 'pc' ? 'Linux PC' : 'Windows laptop';
  ui.activeDevice.classList.toggle('remote', target === 'pc');
  ui.shareBtn.textContent = target === 'pc' ? 'Switch to laptop' : 'Switch to PC';
  ui.targetHint.textContent = target === 'pc'
    ? 'Exclusive mode: laptop keystrokes are suppressed and forwarded to the PC.'
    : 'Laptop receives input normally. Press Ctrl + Alt + A to switch to the PC.';

  if (senderConnected) {
    setGlobalStatus(target === 'pc' ? 'PC keyboard active' : 'Laptop keyboard active', 'good');
  }
}

function renderSharing(enabled) {
  sharing = Boolean(enabled);
  renderTarget({ target: sharing ? 'pc' : 'laptop' });
}

function renderReceiver(state) {
  ui.receiverBadge.textContent = state.running ? 'Listening' : 'Stopped';
  ui.receiverBadge.classList.toggle('good', Boolean(state.running));
  ui.startReceiverBtn.disabled = Boolean(state.running);
  ui.stopReceiverBtn.disabled = !state.running;
  ui.listenPort.disabled = Boolean(state.running);
  ui.receiverDetails.classList.toggle('hidden', !state.running);

  const platform = state.platformInfo || {};
  ui.receiverPlatform.textContent = platform.platform === 'linux'
    ? `Linux · ${platform.linuxSession || 'unknown session'}`
    : (platform.platform || 'unknown');

  if (state.running) {
    ui.receiverCode.textContent = state.clientCount ? 'PAIRED' : (state.pairingCode || '------');
    ui.receiverAddresses.textContent = (state.addresses || []).length
      ? `${state.addresses.join('  ·  ')}:${state.port}`
      : `Port ${state.port}`;
    ui.clientCount.textContent = String(state.clientCount || 0);
    setGlobalStatus(state.clientCount ? 'Laptop connected' : 'Waiting for laptop', state.clientCount ? 'good' : 'warn');
  } else {
    ui.clientCount.textContent = '0';
    setGlobalStatus('Idle', 'neutral');
  }
}

ui.showSender.addEventListener('click', () => setMode('sender'));
ui.showReceiver.addEventListener('click', () => setMode('receiver'));

ui.connectBtn.addEventListener('click', async () => {
  clearError();
  clearWarning();
  ui.connectBtn.disabled = true;
  setGlobalStatus('Connecting…', 'warn');

  try {
    const result = await window.keyBridge.connectSender({
      host: ui.targetHost.value,
      port: ui.targetPort.value,
      code: ui.pairingCode.value
    });
    renderSenderConnection(Boolean(result.connected));
    renderTarget({ target: 'laptop' });
  } catch (error) {
    renderSenderConnection(false);
    showError(error);
  } finally {
    if (!senderConnected) ui.connectBtn.disabled = false;
  }
});

ui.disconnectBtn.addEventListener('click', async () => {
  clearError();
  try {
    await window.keyBridge.disconnectSender();
    renderSenderConnection(false);
  } catch (error) {
    showError(error);
  }
});

ui.shareBtn.addEventListener('click', async () => {
  clearError();
  try {
    const result = await window.keyBridge.setSharing(!sharing);
    renderTarget(result);
  } catch (error) {
    showError(error);
  }
});

ui.startReceiverBtn.addEventListener('click', async () => {
  clearError();
  clearWarning();
  ui.startReceiverBtn.disabled = true;
  try {
    const state = await window.keyBridge.startReceiver(ui.listenPort.value);
    renderReceiver(state);
  } catch (error) {
    ui.startReceiverBtn.disabled = false;
    showError(error);
  }
});

ui.stopReceiverBtn.addEventListener('click', async () => {
  clearError();
  try {
    const state = await window.keyBridge.stopReceiver();
    renderReceiver(state);
  } catch (error) {
    showError(error);
  }
});

window.keyBridge.onSenderConnectionStatus((state) => renderSenderConnection(Boolean(state.connected)));
window.keyBridge.onSenderSharingStatus((state) => { sharing = Boolean(state.enabled); });
window.keyBridge.onSenderTargetStatus((state) => renderTarget(state));
window.keyBridge.onSenderError((error) => showError(error.message || 'Sender error'));
window.keyBridge.onEmergencyStop(() => {
  setGlobalStatus('Emergency stop · release keys', 'warn');
});
window.keyBridge.onReceiverState((state) => renderReceiver(state));
window.keyBridge.onReceiverClientStatus((state) => {
  ui.clientCount.textContent = String(state.clientCount || 0);
  setGlobalStatus(state.connected ? 'Laptop connected' : 'Waiting for laptop', state.connected ? 'good' : 'warn');
});
window.keyBridge.onReceiverError((error) => showError(error.message || 'Receiver input error'));
window.keyBridge.onReceiverWarning((warning) => showWarning(warning.message || String(warning)));

(async function init() {
  try {
    const [info, platformInfo, state] = await Promise.all([
      window.keyBridge.getNetworkInfo(),
      window.keyBridge.getPlatformInfo(),
      window.keyBridge.getReceiverState()
    ]);
    ui.targetPort.value = info.defaultPort;
    ui.listenPort.value = info.defaultPort;
    renderReceiver(state);
    renderTarget({ target: 'laptop' });
    setMode(platformInfo.platform === 'linux' ? 'receiver' : 'sender');

    if (!platformInfo.nativeInputAvailable) {
      showError(`Native keyboard support is unavailable: ${platformInfo.nativeInputError || 'unknown native-module error'}`);
    } else if (platformInfo.platform === 'linux' && platformInfo.linuxSession === 'wayland') {
      showWarning('Wayland detected. This build is intended for X11; native Wayland applications may reject injected keys.');
    }
  } catch (error) {
    showError(error);
  }
})();
