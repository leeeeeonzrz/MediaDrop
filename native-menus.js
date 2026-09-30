// Native menus return a choice only; task operations stay in the owning renderer.
function installNativeMenus({ipcMain, BrowserWindow, Menu}) {
  const pending = new WeakMap();
  ipcMain.handle('task-menu', (event, request) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null;
    try { if (new URL(event.sender.getURL()).hostname !== '127.0.0.1') return null; } catch { return null; }
    const items = request?.items;
    if (!Array.isArray(items) || !items.length || items.length > 24 || items.some(item => !item || (item.separator !== true && (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120)))) return null;
    if (pending.has(win)) return null;
    return new Promise(resolve => {
      let choice = null, done = false;
      const finish = () => { if (done) return; done = true; pending.delete(win); win.removeListener('closed', finish); resolve(choice); };
      const menu = Menu.buildFromTemplate(items.map((item, index) => item.separator === true ? {type:'separator'} : {label:item.label, enabled:item.enabled !== false, click:()=>{choice=index;}}));
      pending.set(win, menu); win.once('closed', finish);
      const [width,height] = win.getContentSize(), zoom = event.sender.getZoomFactor();
      const point = request.point;
      const position = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? {x:Math.round(Math.max(0,Math.min(width,point.x*zoom))), y:Math.round(Math.max(0,Math.min(height,point.y*zoom)))} : {};
      try { menu.popup({window:win,...position,callback:finish}); } catch { finish(); }
    });
  });
}
module.exports = {installNativeMenus};
