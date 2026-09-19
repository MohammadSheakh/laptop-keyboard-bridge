const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('keyBridge', {
  getNetworkInfo: () => ipcRenderer.invoke('network:info'),
  getPlatformInfo: () => ipcRenderer.invoke('platform:info'),

  getReceiverState: () => ipcRenderer.invoke('receiver:state'),
  startReceiver: (port) => ipcRenderer.invoke('receiver:start', { port }),
  stopReceiver: () => ipcRenderer.invoke('receiver:stop'),

  connectSender: (args) => ipcRenderer.invoke('sender:connect', args),
  disconnectSender: () => ipcRenderer.invoke('sender:disconnect'),
  setSharing: (enabled) => ipcRenderer.invoke('sender:set-sharing', enabled),
  getSenderTarget: () => ipcRenderer.invoke('sender:target'),

  onReceiverState: (callback) => on('receiver:state', callback),
  onReceiverClientStatus: (callback) => on('receiver:client-status', callback),
  onReceiverError: (callback) => on('receiver:error', callback),
  onReceiverWarning: (callback) => on('receiver:warning', callback),
  onSenderConnectionStatus: (callback) => on('sender:connection-status', callback),
  onSenderSharingStatus: (callback) => on('sender:sharing-status', callback),
  onSenderTargetStatus: (callback) => on('sender:target-status', callback),
  onSenderError: (callback) => on('sender:error', callback),
  onEmergencyStop: (callback) => on('sender:emergency-stop', callback)
});
