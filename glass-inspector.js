const fs = require('node:fs');
const path = require('node:path');
// All paths are bundled resources. No browser credentials enter the inspector WebKit view.
function inspectorHTML(app, surface = 'inspector') {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin/_internal/static') : path.join(__dirname, 'app/static');
  const css = fs.readFileSync(path.join(base, 'app.css'), 'utf8');
  const script = fs.readFileSync(path.join(base, 'glass-inspector.js'), 'utf8');
  const icons = fs.readFileSync(path.join(base, 'icons.svg'), 'utf8').replace(/id="([^"]+)"/g, 'id="glass-icon-$1"').replace('<svg ', '<svg style="position:absolute;width:0;height:0;overflow:hidden" ');
  const tag = surface === 'sidebar' ? 'nav' : 'aside';
  const label = {inspector:'任务详情',sidebar:'资料库',toolbar:'视图与设置'}[surface];
  const surfaceCSS = surface === 'inspector' ? '' : surface === 'sidebar' ? '#inspector { display:flex; flex-direction:column; padding:14px 12px 18px; gap:4px; border-radius:16px; } #inspector .sidebar-heading { display:flex; }' : '#inspector { display:flex; align-items:center; justify-content:center; gap:2px; padding:3px; border-radius:10px; } #inspector .toolbar-button { width:30px; height:28px; padding:5px; }';
  return `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><style>${css}
html,body { background:transparent !important; margin:0; overflow:hidden; }
body { height:100vh; }
#inspector { position:absolute; inset:0; width:100%; height:100%; border:0; border-radius:16px; clip-path:none; box-shadow:none; background:transparent !important; opacity:1; transform:none; visibility:visible; pointer-events:auto; }
/* Local translucent fills keep text readable without painting over the glass. */
#inspector { --soft:light-dark(#ffffff40,#00000026); --card:light-dark(#ffffff66,#25252566); --muted:light-dark(#555b63,#c0c4ca); }
.inspector-heading,.inspector-actions { background:transparent; }
.inspector .option-section,.detail-notice { background:light-dark(#ffffff38,#00000026); }
.inspector .option-group { background:transparent; }
.inspector .detail-preview:not(.has-image) { background:light-dark(#ffffff40,#ffffff12); }
.inspector .task-menu { background:var(--bg); }
.inspector-scroll { scrollbar-gutter:stable; }
${surfaceCSS}
</style><body>${icons}<${tag} class="${surface === 'toolbar' ? 'toolbar-actions' : surface}" id="inspector" aria-label="${label}"></${tag}><script>${script}</script></body></html>`;
}
function validGeometry(state) {
  const b = state?.bounds;
  return b && ['x','y','width','height'].every(k => Number.isFinite(b[k]) && Math.abs(b[k]) < 20000)
    && b.width >= 0 && b.height >= 0 && Number.isFinite(state.opacity) && state.opacity >= 0 && state.opacity <= 1;
}
function installInspector({app, ipcMain, BrowserWindow, nativeTheme}, load) {
  for (const surface of ['inspector','sidebar','toolbar']) {
  let html;
  const callbacks = new WeakMap();
  const visibility = new WeakMap();
  ipcMain.handle('native-' + surface, (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame || new URL(event.sender.getURL()).hostname !== '127.0.0.1' || !validGeometry(state)) return false;
    const api = load(app);
    if (!api?.inspector) return false;
    const enabled = Boolean(state.enabled) && !nativeTheme.prefersReducedTransparency && !nativeTheme.shouldUseHighContrastColors;
    try {
      if (!callbacks.has(win)) callbacks.set(win, json => {
        if (win.isDestroyed() || event.sender.isDestroyed()) return;
        try {
          const action = JSON.parse(json);
          if (['click','change','disclosure','close','preview','drag','unavailable','ready'].includes(action.type)) event.sender.send('native-' + surface + '-action', action);
        } catch { /* Ignore malformed native events. */ }
      });
      html ||= inspectorHTML(app, surface);
      const content = JSON.stringify(state.content || {});
      if (content.length > 500000) return false;
      if (visibility.get(win) && (!enabled || !state.visible)) event.sender.focus();
      visibility.set(win, enabled && Boolean(state.visible));
      const zoom = event.sender.getZoomFactor();
      const bounds = Object.fromEntries(Object.entries(state.bounds).map(([key,value]) => [key, value * zoom]));
      return api.inspector(win.getNativeWindowHandle(), JSON.stringify({surface, enabled, content, bounds, zoom, visible:Boolean(state.visible), opacity:state.opacity, appearance:['light','dark'].includes(state.appearance) ? state.appearance : 'system'}), html, callbacks.get(win));
    } catch (error) { console.warn('[appearance] Native inspector unavailable:', error.message); return false; }
  });
  }
}
module.exports = {installInspector, validGeometry, inspectorHTML};
