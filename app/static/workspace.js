/* Desktop presentation. Download state remains owned by app.js and the server. */
(() => {
  const $ = id => document.getElementById(id);
  const activeStates = new Set(['queued', 'starting', 'downloading', 'paused', 'interrupted', 'cancelling']);
  const attentionStates = new Set(['error', 'info-error', 'missing']);
  const labels = { ...taskStatusLabels, ready: '待开始', loading: '正在解析', 'info-error': '解析失败', cancelling: '正在取消' };
  let tasks = [], selected = null, filter = 'all', folder = '', inspectorVisible = false;
  let entries = [], renderSignature = '';
  const settingsOnly = new URLSearchParams(location.search).has('settings');
  const preferences = {};
  let preferenceWrites = Promise.resolve(), pendingPreferences = 0;
  function preference(key, fallback) { return preferences[key] || fallback; }
  function savePreference(key, value) {
    preferences[key] = value; applyAppearance(); pendingPreferences++;
    preferenceWrites = preferenceWrites.then(async () => {
      try { await postConfig({ ['ui_' + key]: value }); }
      finally { pendingPreferences--; }
    });
  }
  function applyPreferences(data) {
    if (pendingPreferences) return;
    for (const key of ['appearance', 'density', 'quality']) if (data['ui_' + key]) preferences[key] = data['ui_' + key];
    $('defaultQuality').value = preference('quality', 'highest'); qualityNote(); applyAppearance();
  }
  function applyAppearance() {
    const appearance = preference('appearance', 'system');
    document.documentElement.dataset.appearance = appearance;
    document.documentElement.style.colorScheme = appearance === 'system' ? 'light dark' : appearance;
    document.body.dataset.density = preference('density', 'comfortable');
    void updateGlass();
    $('appearance').value = appearance; $('density').value = preference('density', 'comfortable');
  }
  let glassRevision = 0;
  async function updateGlass() {
    const revision = ++glassRevision;
    try {
      const active = await window.electronAPI?.updateNativeGlass?.(preference('appearance', 'system'));
      if (revision === glassRevision) document.body.classList.toggle('native-glass', Boolean(active));
    } catch { if (revision === glassRevision) document.body.classList.remove('native-glass'); }
  }
  function nativeAppearance(value) {
    void updateGlass();
    document.body.classList.toggle('mac-desktop', value.platform === 'darwin');
    document.body.classList.toggle('high-contrast', Boolean(value.contrast));
    document.body.classList.toggle('reduce-motion', Boolean(value.reduceMotion));
    if (/^#[0-9a-f]{6}$/i.test(value.accent)) {
      document.documentElement.style.setProperty('--accent', value.accent);
      const rgb = value.accent.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
      const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      // Preserve the system hue while ensuring white labels have sufficient contrast.
      let color = value.accent.slice(1).match(/../g).map(c => parseInt(c, 16));
      const lightness = values => values.map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
      while (lightness(color) > .175) color = color.map(c => Math.floor(c * .96));
      document.documentElement.style.setProperty('--action', '#' + color.map(c => c.toString(16).padStart(2, '0')).join(''));
      document.documentElement.style.setProperty('--accent-fg', '#ffffff');
    }
  }
  function collect() {
    const ids = new Set(cardData.map(c => c.jobId).filter(Boolean));
    const cards = cardData.map((card, index) => {
      const task = tasks.find(t => t.id === card.jobId);
      return { key: `card:${index}`, card, index, task, status: task?.status || card.status, title: card.title || card.url || '未命名媒体' };
    });
    return [...cards.filter(e => !e.card.dismissed), ...tasks.filter(t => !ids.has(t.id)).map(task => ({ key: `job:${task.id}`, task, status: task.status, title: task.title || task.filename || '未命名媒体' }))];
  }
  function matches(entry, view) { return view === 'all' || (view === 'active' ? activeStates.has(entry.status) : view === 'done' ? entry.status === 'done' : attentionStates.has(entry.status)); }
  function issueKind(e) {
    if (e.status === 'missing') return 'missing';
    return /cookie|login|sign.?in|authentication|登录|认证/i.test([e.task?.error_code,e.task?.error,e.card?.error].join(' ')) ? 'auth' : 'failed';
  }
  function groupFor(e, view) {
    if (view === 'active') return e.status === 'queued' ? '排队等待' : e.status === 'paused' ? '已暂停' : '正在下载';
    if (view === 'attention') return {missing:'文件已移动',auth:'需要登录',failed:'下载或解析失败'}[issueKind(e)];
    if (view === 'all') return ['ready','loading'].includes(e.status) ? '待下载' : activeStates.has(e.status) ? '进行中' : e.status === 'done' ? '最近完成' : attentionStates.has(e.status) ? '需要处理' : '已取消';
    return '';
  }
  function completedDescription(e) {
    const date = e.task?.completed_at;
    return [e.task?.file_size ? fmtSize(e.task.file_size) : '', date ? new Date(date * 1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''].filter(Boolean).join(' · ');
  }
  function mediaDescription(entry) {
    const c = entry.card, t = entry.task;
    if (t?.media_info?.dynamic_range) return [t.media_info.height ? `${t.media_info.height}p` : '', t.media_info.dynamic_range, (t.options?.container || t.format || '视频').toUpperCase()].filter(Boolean).join(' · ');
    if (c?.formats?.length) {
      if (c.format === 'audio') return '音频 · MP3';
      if (c.format === 'image') return '视频封面';
      const explicit = c.formats.find(f => String(f.id) === String(c.selectedFormatId));
      if (explicit) return [explicit.label, explicit.vcodec, explicit.fps ? `${Math.round(explicit.fps)} fps` : '', explicit.filesize ? `视频流${explicit.filesize_is_estimate ? '约' : ''} ${fmtSize(explicit.filesize)}` : ''].filter(Boolean).join(' · ');
      const policy = {highest:'最高画质 · 自动选择',recommended:'均衡 · 优先 1080p',smallest:'节省空间 · 最低可用画质',compatible:'兼容优先 · 优先 H.264 / 1080p'}[c.preset || 'highest'] || '自动选择画质';
      return [policy, {hdr:'仅 HDR',sdr:'仅 SDR',auto:'跟随源动态范围'}[c.videoRangeMode || 'auto'], (c.options?.container || 'mp4').toUpperCase()].join(' · ');
    }
    return { video: t?.kind === 'local_burn' ? '本地硬字幕' : '视频', audio: '音频', image: '封面', subtitle: '字幕' }[t?.format || c?.format] || '媒体';
  }
  function primaryAction(e) {
    const key = attr(e.key);
    if (e.status === 'missing') return `<button data-workspace="locate-file" data-entry-key="${key}">定位文件</button>`;
    if (attentionStates.has(e.status) && issueKind(e) === 'auth') return '<button data-workspace="fix-login">检查登录</button>';
    if (e.status === 'done') return `<button data-workspace="row-open" data-entry-key="${key}">打开文件</button>`;
    if (e.status === 'info-error') return `<button data-workspace="row-reparse" data-entry-key="${key}">重新解析</button>`;
    if (['ready','error','cancelled'].includes(e.status) && e.card) return `<button data-click-action="download-card" data-index="${e.index}">${e.status === 'ready' ? '下载' : '重试'}</button>`;
    if (e.task && e.status !== 'cancelling') {
      const verb = ['downloading','paused'].includes(e.status) ? 'pause' : ['starting','queued','interrupted'].includes(e.status) ? 'cancel' : 'retry';
      return `<button data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="${verb}">${verb === 'pause' ? (e.status === 'paused' ? '继续下载' : '暂停') : verb === 'cancel' ? '取消下载' : '重试'}</button>`;
    }
    return '';
  }
  function secondaryActions(e) {
    let actions = '';
    if (e.status === 'queued' && e.task) actions += `<button data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="reorder" data-direction="up">在队列中上移</button><button data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="reorder" data-direction="down">在队列中下移</button>`;
    if (e.status === 'done' && e.task?.file) actions += `<button data-workspace="row-preview" data-entry-key="${attr(e.key)}">快速查看 <kbd>空格</kbd></button><button data-click-action="reveal-task-file" data-file-path="${attr(e.task.file)}">在 Finder 中显示</button>`;
    if (e.task && activeStates.has(e.status) && !['queued','starting','interrupted','cancelling'].includes(e.status)) actions += `<button data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="cancel">取消下载</button>`;
    if (['done','missing'].includes(e.status)) actions += alternateDownloadActions(e);
    if (!activeStates.has(e.status) && e.status !== 'loading') {
      if (e.card?.url || e.task?.url) actions += `<button data-workspace="row-reparse" data-entry-key="${attr(e.key)}">重新解析链接</button>`;
      if (e.task && ['done','missing'].includes(e.status)) actions += `<button data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="retry">重新下载</button>`;
      if (e.task) actions += `<hr><button class="destructive" data-click-action="task-action" data-job-id="${attr(e.task.id)}" data-task-action="delete">移除记录，保留文件</button>`;
      else actions += `<hr><button class="destructive" data-workspace="remove-entry" data-entry-key="${attr(e.key)}">移除任务</button>`;
    }
    return actions;
  }
  function moreButton(e, suffix) {
    const actions = secondaryActions(e);
    if (!actions) return '';
    const id = 'actions-' + suffix + '-' + e.key.replace(/[^a-zA-Z0-9_-]/g, '-');
    return `<button class="icon-btn more-button" popovertarget="${id}" aria-label="更多操作" title="更多操作">${uiIcon('more')}</button><div class="task-menu" id="${id}" popover>${actions}</div>`;
  }
  function rowActions(e) {
    return `<div class="row-actions">${primaryAction(e)}${moreButton(e, 'row')}</div>`;
  }
  function syncSidebarAccessibility() {
    const narrow = matchMedia('(max-width:820px)').matches;
    const visible = narrow ? document.body.classList.contains('sidebar-revealed') : !document.body.classList.contains('sidebar-collapsed');
    document.querySelector('.sidebar').inert = !visible;
    document.querySelector('.window-toolbar [data-workspace="sidebar"]').setAttribute('aria-expanded', String(visible));
  }
  matchMedia('(max-width:820px)').addEventListener('change', syncSidebarAccessibility);
  function showInspector(show) {
    inspectorVisible = Boolean(show && entries.length);
    document.body.classList.toggle('inspector-collapsed', !inspectorVisible);
    $('inspector').inert = !inspectorVisible;
    document.querySelector('.window-toolbar [data-workspace="inspector"]').setAttribute('aria-pressed', String(inspectorVisible));
  }
  function message(text) { $('workspaceMessage').textContent = text; $('workspaceMessage').hidden = !text; }
  function render() {
    if (settingsOnly) return;
    entries = collect();
    const search = $('completedSearch').value.trim().toLocaleLowerCase();
    const visible = entries.filter(e => matches(e, filter) && (filter !== 'done' || !search || `${e.title} ${e.task?.filename || ''}`.toLocaleLowerCase().includes(search)));
    const order = filter === 'active' ? ['正在下载','排队等待','已暂停'] : filter === 'attention' ? ['需要登录','下载或解析失败','文件已移动'] : ['待下载','进行中','需要处理','最近完成','已取消'];
    visible.sort((a,b) => filter === 'done' ? (b.task?.completed_at || 0)-(a.task?.completed_at || 0) : order.indexOf(groupFor(a,filter))-order.indexOf(groupFor(b,filter)));
    document.body.dataset.taskView = filter;
    document.querySelector('.download-composer').hidden = filter !== 'all';
    $('viewHeading').hidden = filter === 'all';
    const copy = {all:['全部任务',''],active:['进行中','查看下载进度，管理排队和暂停的任务。'],done:['已完成','已保存的文件，随时打开与查找。'],attention:['需要处理','按问题类型处理，让下载继续。']}[filter];
    $('viewTitle').textContent = copy[0]; $('viewDescription').textContent = copy[1];
    $('completedSearchField').hidden = filter !== 'done';
    $('transferSummary').hidden = filter !== 'active' || !visible.length;
    if (filter === 'active') {
      const moving = visible.filter(e=>['downloading','starting','interrupted','cancelling'].includes(e.status));
      const speed = moving.reduce((sum,e)=>sum+(Number((e.task?.progress || e.card?.progress)?.speed_bps)||0),0);
      $('transferSummary').textContent = `${moving.length} 个正在下载 · ${visible.filter(e=>e.status==='queued').length} 个排队 · ${visible.filter(e=>e.status==='paused').length} 个暂停${speed ? ' · 总速度 ' + fmtSize(speed) + '/秒' : ''}`;
    }
    if (!visible.some(e => e.key === selected)) selected = visible[0]?.key || null;
    for (const view of ['all', 'active', 'done', 'attention']) { const count = entries.filter(e => matches(e, view)).length; $('count-' + view).textContent = count; $('count-' + view).hidden = count === 0; }
    $('librarySubtitle').textContent = tasks.length >= 200 ? '最近 200 条记录，以及全部进行中的任务。' : `${visible.length} 个项目`;
    $('batchDownload').hidden = filter !== 'all' || entries.filter(e => e.card?.status === 'ready').length < 2;
    if (!visible.length) showInspector(false);
    $('emptyLibrary').hidden = visible.length > 0;
    const empty = {all:['还没有下载项目','在上方粘贴视频链接，解析后即可选择画质并下载。'],active:['没有正在下载的任务','添加下载后，进度和排队情况会显示在这里。'],done:search ? ['没有匹配的文件','试试其他标题或文件名。'] : ['还没有完成的下载','下载完成后，可以在这里打开文件或在 Finder 中查看。'],attention:['所有任务均正常','暂时没有需要处理的问题。']}[filter];
    $('emptyLibrary').querySelector('h2').textContent = empty[0]; $('emptyLibrary').querySelector('p').textContent = empty[1];
    $('emptyLibrary').querySelector('.empty-mark').innerHTML = uiIcon(filter === 'attention' ? 'check' : filter === 'done' ? 'folder' : 'download');
    const signature = filter + search + JSON.stringify(visible.map(e => [e.key, e.status, e.title, mediaDescription(e), e.task?.progress || e.card?.progress, e.task?.error || e.card?.error, e.key === selected]));
    if (signature !== renderSignature) {
      const focusedKey = document.activeElement?.closest('[data-entry]')?.dataset.entry;
      const focusedAction = document.activeElement?.closest('.row-actions button');
      const actionData = focusedAction ? {...focusedAction.dataset} : null;
      renderSignature = signature;
      let previousGroup = null;
      $('mediaList').innerHTML = visible.map(e => {
        const progress = e.task?.progress || e.card?.progress || {};
        const percent = Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : null;
        const state = progressPhaseLabel(progress.phase) && activeStates.has(e.status) && e.status !== 'paused' ? progressPhaseLabel(progress.phase) : e.task?.kind === 'local_burn' ? taskStatusLabel(e.task) : labels[e.status] || e.status;
        const detail = e.task?.error || e.card?.error;
        const thumb = safeMediaUrl(e.card?.thumbnail || e.task?.thumbnail);
        const group = groupFor(e,filter);
        const groupHeading = group && group !== previousGroup ? `<h3 class="task-group-heading">${esc(group)} <span>${visible.filter(item=>groupFor(item,filter)===group).length}</span></h3>` : ''; previousGroup = group;
        const issueHelp = filter === 'attention' ? ({auth:'需要有效的登录状态，请检查浏览器或 Cookie 设置。',missing:'原保存位置已找不到文件。可以重新定位，也可以再次下载。',failed:'检查错误原因后重试；更多信息可在任务详情中查看。'}[issueKind(e)]) : '';
        return `${groupHeading}<div class="media-row ${e.key === selected ? 'selected' : ''} ${attentionStates.has(e.status) ? 'needs-attention' : ''}"><button class="row-select" data-entry="${attr(e.key)}" aria-pressed="${e.key === selected}"><span class="media-thumbnail">${thumb ? `<img src="${attr(thumb)}" alt="" loading="lazy">` : uiIcon(({audio:'audio',image:'image'})[e.task?.format || e.card?.format] || 'video')}</span><span class="media-copy"><span class="media-title">${esc(e.title)}</span><span class="media-description">${esc(mediaDescription(e))}</span>${activeStates.has(e.status) && percent !== null ? `<progress value="${percent}" max="100" aria-label="下载进度"></progress>` : ''}<span class="media-state">${esc(filter === 'done' ? completedDescription(e) || '下载完成' : state)}${percent !== null && activeStates.has(e.status) ? ` · ${percent.toFixed(1)}%` : ''}${e.status === 'downloading' ? ' · ' + esc([fmtSpeed(progress.speed_bps, progress.speed), fmtEtaEstimate(progress, false)].filter(Boolean).join(' · ')) : ''}${detail ? ' · ' + esc(friendlyError(detail)) : ''}</span>${filter === 'done' && e.task?.filename ? `<span class="media-filename">${esc(e.task.filename)}</span>` : ''}${issueHelp ? `<span class="issue-help">${esc(issueHelp)}</span>` : ''}</span></button>${rowActions(e)}</div>`;
      }).join('');
      if (actionData) [...$('mediaList').querySelectorAll('.row-actions button')].find(b => Object.entries(actionData).every(([key,value]) => b.dataset[key] === value))?.focus();
      if (focusedKey) [...$('mediaList').querySelectorAll('[data-entry]')].find(e => e.dataset.entry === focusedKey)?.focus();
    }
    const entry = entries.find(e => e.key === selected);
    const fileDetail = usesFileDetails(entry);
    $('inspector').dataset.state = entry?.status || 'empty';
    $('inspector').dataset.entryKey = entry?.key || '';
    [...$('cards').children].forEach(el => { el.hidden = fileDetail || el.id !== selected?.replace('card:', 'card-'); });
    $('inspectorEmpty').hidden = Boolean(entry);
    $('jobDetails').hidden = !fileDetail;
    if (fileDetail) renderJobDetails(entry);
    const footer = $('inspectorActions');
    const footerMarkup = entry && entry.status !== 'loading' ? `<div class="inspector-action-row">${fileDetail || entry.status === 'ready' ? primaryAction(entry) : ''}${entry.status === 'done' && entry.task?.file ? `<button class="icon-btn" data-click-action="reveal-task-file" data-file-path="${attr(entry.task.file)}" aria-label="在 Finder 中显示" title="在 Finder 中显示">${uiIcon('folder')}</button>` : ''}${moreButton(entry, 'detail')}</div>` : '';
    if (footer.innerHTML !== footerMarkup) footer.innerHTML = footerMarkup;
    footer.hidden = !footerMarkup;
    if (entry?.card) {
      const card = $('card-' + entry.index);
      if (card && !card.querySelector('.quality-notice') && entry.card.formats?.length && /youtube\.com|youtu\.be/.test(entry.card.url)) {
        const max = Math.max(...entry.card.formats.map(f => Number(f.height) || Number(String(f.label).match(/(\d{3,4})p/)?.[1]) || 0));
        if (max > 0 && max <= 360) {
          const notice = document.createElement('div'); notice.className = 'quality-notice';
          notice.innerHTML = '目前仅获取到 360p，可能未获得完整格式。<button class="secondary-btn" data-workspace="reparse">重新解析</button><button class="secondary-btn" data-click-action="open-settings">检查登录设置</button>';
          card.querySelector('.card-body')?.appendChild(notice);
        }
      }
    }
    const running = entries.filter(e => activeStates.has(e.status));
    $('workspaceStatus').textContent = running.length ? `${running.length} 个任务进行中${running.some(e => e.status === 'paused') ? '（含已暂停）' : ''}` : `${entries.length} 个任务 · 准备就绪`;
  }
  function alternateDownloadActions(e) {
    if (!(e.card?.url || e.task?.url)) return '';
    const current = e.task?.format || e.card?.format;
    return [['audio','下载音频'],['image','下载封面']].filter(([format]) => format !== current)
      .map(([format,label]) => `<button data-workspace="download-alternate" data-entry-key="${attr(e.key)}" data-format="${format}">${label}</button>`).join('');
  }
  function downloadAlternate(entry, format) {
    if (!entry || !['audio','image'].includes(format)) return;
    const c = entry.card, t = entry.task, url = c?.url || t?.url;
    if (!url) return;
    const existing = entries.find(e => (e.card?.url || e.task?.url) === url
      && (e.task?.format || e.card?.format) === format && activeStates.has(e.status));
    if (existing) { choose(existing.key); setFilter('all'); showInspector(true); return; }
    // Create an independent task: never carry over job IDs, polling, or completed files.
    const index = cardData.length;
    cardData.push({url, status:'ready', format, title:c?.title || t?.title || '',
      thumbnail:c?.thumbnail || t?.thumbnail || '', duration:c?.duration, uploader:c?.uploader || '',
      formats:[], hasHdr:false, youtubeEngine:c?.youtubeEngine || t?.options?.youtube_engine,
      skipBrowserCookies:Boolean(c?.skipBrowserCookies ?? t?.options?.skip_browser_cookies),
      selectedFormatId:null, videoRangeMode:'auto', preset:'highest',
      options:{container:'mp4', audio_quality:c?.options?.audio_quality || t?.options?.audio_quality || '192',
        subtitle_languages:'zh.*,en.*'}, completedDownloads:{}});
    renderCard(index); window.mediaWorkspace.selectCard(index); showInspector(true);
    void dlCard(index);
  }
  function usesFileDetails(entry) {
    return Boolean(entry?.task) && !(entry.card && ['error','cancelled'].includes(entry.status));
  }
  function resolveMenuAction(menuId, descriptor) {
    if (!descriptor) return null;
    const current = $(menuId);
    return current && [...current.children].find(node => node.matches('button') && !node.disabled
      && JSON.stringify(Object.fromEntries(Object.entries(node.dataset).filter(([key]) => key !== 'glassId').sort())) === descriptor);
  }
  function menuActionDescriptor(node) {
    return node.matches('button') ? JSON.stringify(Object.fromEntries(Object.entries(node.dataset).filter(([key]) => key !== 'glassId').sort())) : null;
  }
  function renderJobDetails(e) {
    const t = e.task, info = t.media_info || {}, c = e.card;
    const usable = t.status === 'done' && Boolean(t.file);
    const thumb = safeMediaUrl(t.thumbnail || c?.thumbnail);
    const preview = thumb ? `<img src="${attr(thumb)}" alt="">` : uiIcon(({audio:'audio',image:'image'})[t.format] || 'video');
    const properties = [['类型', {video:'视频',audio:'音频',image:'封面'}[t.format] || '视频'],
      ['格式', ['audio','image'].includes(t.format) ? (t.filename?.split('.').pop() || '').toUpperCase() : t.options?.container?.toUpperCase()],
      ['分辨率', info.width && info.height ? `${info.width} × ${info.height}` : ''],
      ['动态范围', t.format === 'video' ? info.dynamic_range || '完成后核验' : ''],
      ['编码', info.codec?.toUpperCase()], ['音频质量', t.format === 'audio' && t.options?.audio_quality ? `${t.options.audio_quality} kbps` : ''], ['文件大小', t.file_size ? fmtSize(t.file_size) : ''],
      ['文件名', t.filename], ['保存位置', t.file]];
    const progress = t.progress || {};
    const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null;
    const transfer = activeStates.has(t.status) ? `<section class="detail-transfer"><div><strong>${esc(progressPhaseLabel(progress.phase) || labels[t.status])}</strong><span>${percent === null ? '' : percent.toFixed(1) + '%'}</span></div><progress max="100"${percent === null ? '' : ` value="${percent}"`} aria-label="下载进度"></progress><p>${esc([fmtSize(progress.downloaded || 0), progress.total ? '/ ' + (progress.total_is_estimate ? '约 ' : '') + fmtSize(progress.total) : '', t.status === 'downloading' ? fmtSpeed(progress.speed_bps, progress.speed) : '', fmtEtaEstimate(progress, t.status === 'paused')].filter(Boolean).join(' · '))}</p></section>` : '';
    const markup = `<div class="detail-identity">${usable ? `<button class="detail-preview ${thumb ? 'has-image' : ''}" data-workspace="preview" draggable="true" data-drag-file title="快速查看；也可拖到 Finder" aria-label="快速查看文件">${preview}</button>` : `<div class="detail-preview ${thumb ? 'has-image' : ''}">${preview}</div>`}<h3>${esc(e.title)}</h3>${c?.uploader || c?.duration ? `<p class="detail-byline">${esc([c.uploader, c.duration ? fmtDur(c.duration) : ''].filter(Boolean).join(' · '))}</p>` : ''}<span class="detail-status ${usable ? 'is-done' : attentionStates.has(t.status) ? 'is-issue' : ''}">${uiIcon(usable ? 'check' : attentionStates.has(t.status) ? 'warning' : 'download')}${esc(t.kind === 'local_burn' ? taskStatusLabel(t) : labels[t.status] || t.status)}</span></div>${transfer}${t.status === 'missing' ? '<p class="detail-notice">原保存位置已找不到文件。定位移动后的文件，即可继续打开和预览。</p>' : ''}${t.error ? `<p class="detail-notice">${esc(friendlyError(t.error))}</p>` : ''}<dl class="detail-properties">${properties.filter(([,value]) => value).map(([label,value]) => `<div><dt>${label}</dt><dd${label === '文件名' && usable ? ' draggable="true" data-drag-file title="拖到 Finder"' : ''}>${esc(value)}</dd></div>`).join('')}</dl>${['done','missing'].includes(t.status) && alternateDownloadActions(e) ? `<section class="detail-alternates" aria-label="下载其他内容"><h4>下载其他内容</h4><div>${alternateDownloadActions(e)}</div><p>直接创建独立任务，无需再次解析链接。</p></section>` : ''}`;
    if ($('jobDetails').innerHTML !== markup) $('jobDetails').innerHTML = markup;
  }
  async function removeEntry(entry) {
    if (entry?.task) await taskAction(entry.task.id, 'delete');
  }
  function choose(key) { selected = key; render(); }
  function setFilter(value) { if (matchMedia('(max-width:820px)').matches) { document.body.classList.remove('sidebar-revealed'); syncSidebarAccessibility(); } filter = value; document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter))); $('libraryTitle').textContent = {all:'全部任务',active:'进行中',done:'已完成',attention:'需要处理'}[filter]; render(); }
  function reparseEntry(entry) {
    const url = entry?.card?.url || entry?.task?.url;
    if (!url) return;
    if (parseController) { message('请等待当前解析完成，再添加其他格式。'); return; }
    openNew(url); void go(); showInspector(true);
  }
  function openNew(text) { if (settingsOnly) return; setFilter('all'); if (text) $('urls').value = text; $('goBtn').disabled = !parseController && !parseUrls($('urls').value).length; $('urls').scrollIntoView({block:'center'}); $('urls').focus(); }
  async function locateFile(key) {
    const entry = entries.find(e=>e.key===key);
    if (!entry?.task) return;
    if (!window.electronAPI?.selectMediaFile) { message('请在桌面应用中重新定位文件。'); return; }
    try {
      const file = await window.electronAPI.selectMediaFile(); if (!file) return;
      const response = await fetch(`/api/jobs/${encodeURIComponent(entry.task.id)}/locate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file})});
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '无法定位文件');
      await refreshTaskCenter();
    } catch(error) { message(friendlyError(error.message)); }
  }
  async function selectedFile(action) {
    const e = entries.find(e => e.key === selected), file = e?.task?.file;
    if (!file) return;
    try { const ok = await window.electronAPI?.[action]?.(file); if (ok === false) message('无法打开此文件，请检查文件是否仍在原位置。'); } catch { message('无法打开此文件。'); }
  }
  function settingsTab(tab) {
    const copy = {general:['通用','调整外观与桌面使用体验。'],download:['下载','选择保存位置与同时下载的任务数量。'],network:['网络与登录','管理连接方式与视频平台登录状态。'],updates:['更新与维护','保持应用与下载工具正常运行。']}[tab];
    if (!copy) return;
    document.querySelectorAll('[data-settings-tab]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.settingsTab === tab)));
    document.querySelectorAll('[data-settings-group]').forEach(s => s.hidden = s.dataset.settingsGroup !== tab);
    $('settingsPageTitle').textContent = copy[0]; $('settingsPageDescription').textContent = copy[1];
    document.querySelector('.drawer-content').scrollTop = 0;
  }
  window.mediaWorkspace = { render, settingsTab, applyPreferences, selectCard(index) { selected = `card:${index}`; setFilter('all'); }, update(value) {
    tasks = value;
    cardData.forEach((card, index) => {
      const task = tasks.find(t => t.id === card.jobId);
      if (!task || card.cancelRequested) return;
      const status = task.status === 'starting' || task.status === 'interrupted' ? 'downloading' : task.status;
      const changed = status !== card.status || JSON.stringify(task.progress) !== JSON.stringify(card.progress);
      card.status = status; card.progress = task.progress; card.error = task.error; card.resumable = task.resumable;
      if (status === 'done') {
        const request = card.activeRequest || buildDownloadRequest({ format: task.format, selectedFormatId: task.format_id, videoRangeMode: task.video_range_mode, preset: task.preset, options: task.options });
        card.completedDownloads ||= {};
        card.completedDownloads[downloadRequestKey(request)] = { filename: task.filename, mediaInfo: task.media_info, request };
        card.filename = task.filename;
      }
      if (changed) renderCardContent(index);
      // The independent task refresh restores polling after a transient connection failure.
      if (activeStates.has(status) && card._downloadAttempt && !card._pollInterval && !card._pollController) pollCard(index, card, card.jobId);
    });
    message(''); render();
  }, connectionLost() { message('暂时无法连接下载服务，正在重试…'); }, message, setFolder(value) { folder = value || ''; $('sidebarFolder').textContent = folder.split('/').filter(Boolean).at(-1) || '下载文件夹'; $('sidebarFolder').title = folder; } };
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[popovertarget]');
    if (trigger) {
      const menu = $(trigger.getAttribute('popovertarget'));
      const rect = trigger.getBoundingClientRect();
      if (window.electronAPI?.showTaskMenu && menu) {
        event.preventDefault();
        const nodes = [...menu.children].filter(node => node.matches('button,hr'));
        const menuId = menu.id;
        const descriptors = nodes.map(menuActionDescriptor);
        const items = nodes.map(node => {
          if (node.matches('hr')) return {separator:true};
          const copy = node.cloneNode(true); copy.querySelectorAll('kbd').forEach(k => k.remove());
          return {label:copy.textContent.trim(),enabled:!node.disabled};
        });
        void window.electronAPI.showTaskMenu({items,point:{x:rect.right,y:rect.bottom}}).then(index => {
          // Resolve the same task/action in the current menu after a progress refresh.
          // Removed or no-longer-available actions are intentionally ignored.
          const target = Number.isInteger(index) ? resolveMenuAction(menuId, descriptors[index]) : null;
          if (target?.isConnected) target.click();
        }).catch(() => { if (menu.isConnected) menu.showPopover(); });
        return;
      }
      menu.style.left = Math.max(8, Math.min(innerWidth - 244, rect.right - 236)) + 'px';
      menu.style.top = Math.max(8, Math.min(innerHeight - 280, rect.bottom + 6)) + 'px';
    }
    const menu = event.target.closest('.task-menu');
    if (menu && event.target.closest('button')) menu.hidePopover();
  });
  document.addEventListener('click', event => {
    const row = event.target.closest('[data-entry]'); if (row) { choose(row.dataset.entry); showInspector(true); }
    const tab = event.target.closest('[data-settings-tab]'); if (tab) settingsTab(tab.dataset.settingsTab);
    const target = event.target.closest('[data-workspace]');
    if (target) switch (target.dataset.workspace) {
      case 'new': openNew(); break;
      case 'filter': setFilter(target.dataset.filter); break;
      case 'sidebar': document.body.classList.toggle(matchMedia('(max-width:820px)').matches ? 'sidebar-revealed' : 'sidebar-collapsed'); syncSidebarAccessibility(); break;
      case 'inspector': showInspector(!inspectorVisible); break;
      case 'row-info': choose(target.dataset.entryKey); showInspector(true); $('inspector').querySelector('button')?.focus(); break;
      case 'fix-login': openSettings('network'); break;
      case 'locate-file': void locateFile(target.dataset.entryKey); break;
      case 'row-preview': choose(target.dataset.entryKey); void selectedFile('previewFile'); break;
      case 'remove-entry': { const e = entries.find(e => e.key === target.dataset.entryKey); if (e?.card && !e.task) { e.card.dismissed = true; e.card.status = 'dismissed'; render(); } break; }
      case 'row-open': choose(target.dataset.entryKey); void selectedFile('openFile'); break;
      case 'download-alternate': downloadAlternate(entries.find(e => e.key === target.dataset.entryKey), target.dataset.format); break;
      case 'row-reparse': { const entry = entries.find(e => e.key === target.dataset.entryKey); reparseEntry(entry); break; }
      case 'folder': if (folder && window.electronAPI) void revealTaskFile(folder); else openSettings(); break;
      case 'batch': void dlAll(); break;
      case 'reparse': { const e = entries.find(e => e.key === selected); reparseEntry(e); break; }
      case 'remove-draft': { const e = entries.find(e => e.key === selected); if (e?.card) {
        if (e.task) { void removeEntry(e); } else { e.card.dismissed = true; e.card.status = 'dismissed'; render(); }
        } break; }
      case 'preview': void selectedFile('previewFile'); break;
      case 'open-file': void selectedFile('openFile'); break;
    }
    if (event.target.closest('[data-click-action="fetch"]') && parseUrls($('urls').value).length) { setFilter('all'); render(); }
  });
  document.addEventListener('keydown', event => {
    const editing = event.target.matches('input,textarea,select,[contenteditable=true]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !window.electronAPI) { event.preventDefault(); openNew(); }
    if ((event.metaKey || event.ctrlKey) && event.key === ',') { event.preventDefault(); openSettings(); }
    if (event.key === ' ' && !editing && !event.target.closest('button,dialog') && selected) { event.preventDefault(); void selectedFile('previewFile'); }
    const row = event.target.closest('[data-entry]');
    if (row && ['ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
      event.preventDefault(); if (event.key === ' ') { void selectedFile('previewFile'); return; }
      const buttons = [...$('mediaList').querySelectorAll('[data-entry]')], next = buttons[buttons.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { choose(next.dataset.entry); [...$('mediaList').querySelectorAll('[data-entry]')].find(b => b.dataset.entry === next.dataset.entry)?.focus(); }
    }
    if (event.key === 'Tab' && $('settingsDrawer').classList.contains('open') && !settingsOnly) {
      const elements = [...$('settingsDrawer').querySelectorAll('button,input,select')].filter(e => !e.disabled && e.getClientRects().length);
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    }
  });
  document.addEventListener('click', event => { if (event.target.closest('[data-click-action="open-settings"]') && !window.electronAPI) $('desktopShell').inert = true; if (event.target.closest('[data-click-action="close-settings"]')) $('desktopShell').inert = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('.task-menu:popover-open')) { $('desktopShell').inert = false; if (inspectorVisible) { showInspector(false); document.querySelector('.window-toolbar [data-workspace="inspector"]').focus(); } } });
  $('completedSearch').addEventListener('input', render);
  $('urls').addEventListener('input', () => { $('urls').style.height = 'auto'; $('urls').style.height = Math.min(160, Math.max(64, $('urls').scrollHeight)) + 'px'; $('goBtn').disabled = !parseController && !parseUrls($('urls').value).length; });
  document.addEventListener('dragstart', event => { if (event.target.closest('[data-drag-file]')) { event.preventDefault(); const file = entries.find(e => e.key === selected)?.task?.file; if (file) window.electronAPI?.dragFile(file); } });
  $('desktopShell').addEventListener('dragover', event => { if ([...event.dataTransfer.types].some(t => ['text/uri-list', 'text/plain'].includes(t))) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } });
  $('desktopShell').addEventListener('drop', event => { const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'); if (text && !event.target.matches('input,textarea')) { event.preventDefault(); openNew(text.split('\n').filter(line => !line.startsWith('#')).join('\n')); } });
  $('defaultQuality').value = preference('quality', 'highest');
  function qualityNote() { document.querySelector('.composer-note').hidden = $('defaultQuality').value === 'highest'; document.querySelector('.composer-note').textContent = ({highest:'保留源动态范围。解析后可调整格式、音轨和字幕。',recommended:'最高 1080p，在文件大小与画质之间取得平衡。',compatible:'优先使用兼容性更好的编码，最高 1080p。'})[$('defaultQuality').value]; }
  qualityNote();
  $('defaultQuality').addEventListener('change', e => { savePreference('quality', e.target.value); qualityNote(); });
  $('appearance').addEventListener('change', e => savePreference('appearance', e.target.value));
  $('density').addEventListener('change', e => savePreference('density', e.target.value));
  window.addEventListener('storage', applyAppearance);
  let activityRevision = 0;
  window.electronAPI?.onWindowActivity?.(active => { activityRevision++; document.body.classList.toggle('window-inactive', !active); });
  window.electronAPI?.getWindowActivity?.().then(active => { if (!activityRevision) document.body.classList.toggle('window-inactive', !active); }).catch(() => {});
  window.addEventListener('focus', () => { void updateGlass(); if (!settingsOnly) void loadSettings(); });
  window.addEventListener('online', () => void refreshTaskCenter());
  window.electronAPI?.onDesktopCommand(command => { if (command === 'new') openNew(); if (command === 'settings') openSettings(); if (command === 'settings-network') settingsTab('network'); if (command === 'refresh') void refreshTaskCenter(); if (command === 'show-active') setFilter('active'); if (command === 'sidebar' || command === 'inspector') document.querySelector(`.window-toolbar [data-workspace="${command}"]`).click(); if (command.startsWith('select-job:')) void refreshTaskCenter().then(() => { setFilter('all'); const id = command.slice(11); const entry = entries.find(e => e.task?.id === id); if (entry) choose(entry.key); }); });
  window.electronAPI?.onAppearance(nativeAppearance);
  window.electronAPI?.getAppearance().then(nativeAppearance).catch(() => {});
  applyAppearance(); settingsTab('general');
  $('settingsDrawer').inert = !settingsOnly;
  if (settingsOnly) { document.body.classList.add('settings-window'); openSettings(); }
  void loadSettings(); render(); syncSidebarAccessibility();
  if (!settingsOnly) $('urls').focus();
})();
