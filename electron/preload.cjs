/**
 * Electron 预加载：注入与 homo-lyrics-master 完全一致的 window.AMLyricsNative 契约，
 * 并把主进程推送转换成 window.AMLyricsApp 上的回调调用。
 * 使用 contextIsolation: false，保持原前端“直接给 window.AMLyricsApp 赋值”的写法不变。
 */
'use strict';
const { ipcRenderer } = require('electron');

window.AMLyricsNative = {
  notifyReady() { ipcRenderer.send('native:notifyReady'); },
  fetchLyric(title, artist, duration) { ipcRenderer.send('native:fetchLyric', { title, artist, duration }); },
  seekTo(positionMs) { ipcRenderer.send('native:seekTo', positionMs); },
  sendCommand(command) { ipcRenderer.send('native:sendCommand', command); },
  setVolume(volume) { ipcRenderer.send('native:setVolume', volume); },
  setLoopMode(mode) { ipcRenderer.send('native:setLoopMode', mode); },
  setStatusBarStyle(darkText) { ipcRenderer.send('native:setStatusBarStyle', darkText); },
  fetchQueue() { ipcRenderer.send('native:fetchQueue'); },
  share() { ipcRenderer.send('native:share'); },
  openCastPicker() { ipcRenderer.send('native:openCastPicker'); },
  toggleFullscreen() { ipcRenderer.send('native:toggleFullscreen'); },
  getLyricSources() { return ipcRenderer.sendSync('native:getLyricSources'); },
  setLyricSources(priority) { ipcRenderer.send('native:setLyricSources', priority); },
  close() { ipcRenderer.send('native:close'); },
  minimize() { ipcRenderer.send('native:minimize'); },
  dragStart(pointerId) { ipcRenderer.send('native:dragStart', { pointerId }); },
  dragEnd() { ipcRenderer.send('native:dragEnd'); },
  log(message) { ipcRenderer.send('native:log', message); }
};

function forward(channel, method) {
  ipcRenderer.on(channel, (_event, payload) => {
    try {
      const app = window.AMLyricsApp;
      if (app && typeof app[method] === 'function') app[method](payload);
    } catch (error) {
      console.error('[preload] ' + method + ' failed', error);
    }
  });
}

forward('app:playbackUpdate', 'onPlaybackUpdate');
forward('app:lyricResult', 'onLyricResult');
forward('app:lyricError', 'onLyricError');
forward('app:coverUpdate', 'onCoverUpdate');
forward('app:lowFreqUpdate', 'onLowFreqUpdate');
forward('app:volumeUpdate', 'onVolumeUpdate');
forward('app:queueUpdate', 'onQueueUpdate');

ipcRenderer.on('app:fullscreenChange', (_event, value) => {
  window.dispatchEvent(new CustomEvent('homo-fullscreen-change', { detail: value === true }));
});
