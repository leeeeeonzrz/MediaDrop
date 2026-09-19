/* Presentation-only native inspector. The main renderer owns all task state/actions. */
(() => {
  const surface = document.getElementById('inspector');
  let revision = 0, signature = '', selection = '', nativeMenus = false;
  const send = value => window.webkit.messageHandlers.inspector.postMessage({ ...value, revision });
  window.renderInspector = state => {
    revision = state.revision; nativeMenus = Boolean(state.nativeMenus);
    document.documentElement.style.colorScheme = state.appearance === 'system' ? 'light dark' : state.appearance;
    for (const [name, value] of Object.entries(state.colors || {})) document.documentElement.style.setProperty(name, value);
    surface.dataset.state = state.state;
    document.body.classList.toggle('reduce-motion', state.reduceMotion);
    if (signature === state.html) return;
    const sameSelection = selection === state.selection; selection = state.selection;
    const focused = sameSelection && document.activeElement?.dataset.glassId;
    const scroll = sameSelection ? surface.querySelector('.inspector-scroll')?.scrollTop || 0 : 0;
    const popup = surface.querySelector('.task-menu:popover-open')?.id;
    signature = state.html;
    surface.innerHTML = state.html;
    if (surface.querySelector('.inspector-scroll')) surface.querySelector('.inspector-scroll').scrollTop = scroll;
    if (focused) surface.querySelector(`[data-glass-id="${focused}"]`)?.focus({preventScroll:true});
    if (popup) document.getElementById(popup)?.showPopover();
  };
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-glass-id]');
    if (!target) return;
    if (target.hasAttribute('popovertarget')) {
      if (nativeMenus) { event.preventDefault(); send({type:'click',id:target.dataset.glassId}); return; }
      const menu = document.getElementById(target.getAttribute('popovertarget'));
      const rect = target.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(innerWidth - 244, rect.right - 236)) + 'px';
      menu.style.top = Math.max(8, Math.min(innerHeight - 280, rect.bottom + 6)) + 'px';
      return;
    }
    if (target.matches('summary,input,select')) return;
    const popup = target.closest('.task-menu');
    if (popup) popup.hidePopover();
    send({type:'click', id:target.dataset.glassId});
  });
  document.addEventListener('change', event => {
    const target = event.target.closest('[data-glass-id]');
    if (target) send({type:'change', id:target.dataset.glassId, value:target.value, checked:target.checked});
  });
  document.addEventListener('toggle', event => {
    if (event.target.matches('details')) {
      const id = event.target.querySelector('summary')?.dataset.glassId;
      if (id) send({type:'disclosure',id,open:event.target.open});
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector(':popover-open')) send({type:'close'});
    if (event.key === ' ' && !event.target.closest('button,input,select,textarea,summary')) { event.preventDefault(); send({type:'preview'}); }
  });
  document.addEventListener('dragstart', event => {
    const target = event.target.closest('[data-drag-file]');
    if (target) { event.preventDefault(); send({type:'drag',id:target.dataset.glassId}); }
  });
})();
