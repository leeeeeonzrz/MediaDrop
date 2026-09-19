/* Keep the native glass presentation synchronized with the authoritative DOM. */
(() => {
  const api = window.electronAPI;
  if (!api || new URLSearchParams(location.search).has('settings')) return;
  function bindSurface(surface, panel, update, subscribe) {
  if (!panel || !update || !subscribe) return;
  const activeClass = 'native-' + surface + '-active';
  let revision = 0, contentKey = '', content, frame = 0, until = 0, sending = false, queued, failed = false;
  let controls = new Map();
  function snapshot() {
    const next = new Map();
    let id = 0;
    for (const node of panel.querySelectorAll('button,input,select,summary,[data-drag-file]')) {
      if (node.closest('[hidden]')) continue;
      const key = String(++id); node.dataset.glassId = key; next.set(key, node);
    }
    controls = next;
    const copy = panel.cloneNode(true);
    copy.querySelectorAll('[hidden]').forEach(node => node.remove());
    // Inline symbols live in the native document; there is no authenticated web session there.
    const html = copy.innerHTML.replaceAll('/static/icons.svg#', '#glass-icon-');
    const appearance = document.documentElement.dataset.appearance || 'system';
    const colors = {};
    for (const name of ['--accent','--action','--accent-fg']) {
      const value = document.documentElement.style.getPropertyValue(name);
      if (value) colors[name] = value;
    }
    const dragFile = panel.querySelector('[data-file-path]')?.dataset.filePath || '';
    const key = JSON.stringify({html, appearance, colors, dragFile, selection:panel.dataset.entryKey, state:panel.dataset.state, nativeMenus:Boolean(api.showTaskMenu), reduceMotion:document.body.classList.contains('reduce-motion')});
    if (key !== contentKey) { contentKey = key; content = {...JSON.parse(key),revision:++revision}; }
  }
  async function flush() {
    if (sending || !queued) return;
    sending = true;
    const state = queued; queued = null;
    try {
      const active = await update(state);
      const visible = Boolean(active && state.enabled);
      if (document.body.classList.contains(activeClass) !== visible) document.body.classList.toggle(activeClass, visible);
      panel.setAttribute('aria-hidden', String(visible));
    } catch {
      failed = true; document.body.classList.remove(activeClass); panel.removeAttribute('aria-hidden');
    } finally { sending = false; if (queued) void flush(); }
  }
  function sync() {
    frame = 0;
    const rect = panel.getBoundingClientRect();
    const opacity = Number(getComputedStyle(panel).opacity);
    queued = {enabled:!failed && document.body.classList.contains('native-glass') && (surface !== 'sidebar' || innerWidth <= 820), visible:opacity > .001,
      bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}, opacity,
      appearance:document.documentElement.dataset.appearance || 'system', content};
    void flush();
    if (performance.now() < until) frame = requestAnimationFrame(sync);
  }
  function schedule() { snapshot(); until = performance.now() + 350; if (!frame) frame = requestAnimationFrame(sync); }
  new MutationObserver(schedule).observe(panel, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','open','data-state','data-entry-key','checked','selected','aria-pressed']});
  new MutationObserver(schedule).observe(document.body,{attributes:true,attributeFilter:['class']});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['style','data-appearance']});
  new ResizeObserver(schedule).observe(panel);
  window.addEventListener('resize',schedule);
  subscribe(action => {
    if (action.type === 'ready') { schedule(); return; }
    if (action.type === 'unavailable') { failed = true; document.body.classList.remove(activeClass); panel.removeAttribute('aria-hidden'); schedule(); return; }
    if (action.revision !== revision) return; // Never apply a stale action to a newly selected task.
    const target = controls.get(action.id);
    if (action.type === 'close') { if (surface === 'toolbar') return; (surface === 'sidebar' ? document.querySelector('.window-toolbar [data-workspace="sidebar"]') : panel.querySelector('[data-workspace="inspector"]'))?.click(); return; }
    if (action.type === 'preview') { panel.querySelector('[data-workspace="preview"]')?.click(); return; }
    if (!target?.isConnected || target.disabled || target.closest('[hidden]')) return;
    if (action.type === 'click') target.click();
    if (action.type === 'change') {
      if (!target.matches('input,select')) return;
      target.value = action.value; if (target.type === 'checkbox') target.checked = Boolean(action.checked);
      target.dispatchEvent(new Event('change',{bubbles:true}));
    }
    if (action.type === 'disclosure' && target.matches('summary')) target.parentElement.open = Boolean(action.open);
    if (action.type === 'drag' && target.hasAttribute('data-drag-file')) target.dispatchEvent(new Event('dragstart',{bubbles:true,cancelable:true}));
    schedule();
  });
  schedule();
  }
  bindSurface('inspector', document.getElementById('inspector'), api.updateNativeInspector, api.onNativeInspectorAction);
  bindSurface('sidebar', document.querySelector('.sidebar'), api.updateNativeSidebar, api.onNativeSidebarAction);
  bindSurface('toolbar', document.querySelector('.toolbar-actions'), api.updateNativeToolbar, api.onNativeToolbarAction);
})();
