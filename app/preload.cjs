// The only bridge between the pages and the main process.
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("foolscap", {
  state: call("state:get"),
  start: call("task:start"),
  answer: call("task:answer"),
  prompt: call("task:prompt"),
  enqueue: call("task:enqueue"),
  dequeue: call("task:dequeue"),
  sendNext: call("task:sendNext"),
  cancel: call("task:cancel"),
  close: call("task:close"),
  seen: call("task:seen"),
  openFolder: call("task:openFolder"),
  merge: call("task:merge"),
  discard: call("task:discard"),
  pickRepo: call("repo:pick"),
  setSettings: call("settings:set"),
  refreshAgents: call("agents:refresh"),
  activateKey: call("licence:activate"),
  deactivateKey: call("licence:deactivate"),
  checkKey: call("licence:refresh"),
  openLink: call("licence:open"),
  hooksPlan: call("hooks:plan"),
  hooksEnable: call("hooks:enable"),
  hooksDisable: call("hooks:disable"),
  dismissDigest: call("digest:dismiss"),
  voiceStart: call("voice:start"),
  voicePart: call("voice:part"),
  voiceFinish: call("voice:finish"),
  panelHeight: (height) => ipcRenderer.send("panel:height", height),
  openFull: (focusId) => ipcRenderer.send("view:full", focusId),
  hidePanel: () => ipcRenderer.send("view:hidePanel"),
  quit: () => ipcRenderer.send("app:quit"),
  onState: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  onFocus: (fn) => {
    const listener = (_e, id) => fn(id);
    ipcRenderer.on("focus", listener);
    return () => ipcRenderer.removeListener("focus", listener);
  },
});
