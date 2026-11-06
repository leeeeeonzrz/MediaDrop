const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'static', 'app.js'), 'utf8');
const from = source.indexOf('let youtubeEngineState =');
const to = source.indexOf('async function checkYtdlp()', from);
assert(from >= 0 && to > from, 'Enhanced engine settings functions are missing');
const code = source.slice(from, to);

const currentVersion = '2026.10.27.135913';
const olderVersion = '2026.08.19.233452';
const latestVersion = '2026.11.06.120000';
const installedId = 'installed-older';
const remoteId = 'remote-latest';
const historyNote = '在线仅提供最新增强版；已下载的版本会保留在本机。';

function status(selectedId = 'bundled') {
  const releases = [
    { id: 'bundled', version: currentVersion, source: 'bundled', installed: true, available: true },
    { id: installedId, version: olderVersion, source: 'installed', installed: true, available: true },
    { id: remoteId, version: latestVersion, source: 'remote', installed: selectedId === remoteId, available: true, published_at: '2026-11-06T12:00:00Z' },
  ].map(release => ({ ...release, current: release.id === selectedId }));
  return {
    current: releases.find(release => release.current).version,
    bundled: currentVersion,
    selected_id: selectedId,
    provider_version: '2.0.2',
    mode: 'sabr',
    available: true,
    releases,
    history_note: historyNote,
    warning: '',
  };
}

function response(body, code = 200) {
  return { ok: code >= 200 && code < 300, status: code, json: async () => body };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this._value = '';
  }
  get options() { return this.children; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  get selectedOptions() { return this.children.filter(child => child.value === this.value); }
  appendChild(child) {
    this.children.push(child);
    if (this.tagName === 'SELECT' && this.children.length === 1) this._value = child.value;
    return child;
  }
  replaceChildren(...children) {
    this.children = [];
    this._value = '';
    for (const child of children) this.appendChild(child);
  }
  set innerHTML(value) {
    assert.equal(value, '', 'Use option textContent rather than interpolating server data into markup');
    this.replaceChildren();
  }
  get innerHTML() { return ''; }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
}

function harness(handler = () => response(status())) {
  const ids = ['youtubeEngineVersion', 'youtubeEngineRelease', 'checkYoutubeEngineBtn', 'youtubeEngineUpdate', 'restoreYoutubeEngineBtn', 'youtubeEngineHistory', 'youtubeEngineMsg'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id === 'youtubeEngineRelease' ? 'select' : 'div')]));
  const requests = [];
  let active = 0, maxActive = 0;
  const context = {
    console, Promise, Set, Map, AbortController, AbortSignal,
    document: { getElementById: id => elements[id] || null, createElement: tag => new Element(tag) },
    window: { electronAPI: {} },
    friendlyError: message => String(message),
    setSettingsMsg: () => {},
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      active += 1; maxActive = Math.max(maxActive, active);
      try { return await handler(url, options); }
      finally { active -= 1; }
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return { context, elements, requests, get maxActive() { return maxActive; } };
}

function select(h, id) {
  h.elements.youtubeEngineRelease.value = id;
  h.context.refreshYoutubeEngineControls();
}

function snapshot(h) {
  return {
    version: h.elements.youtubeEngineVersion.textContent,
    selected: h.elements.youtubeEngineRelease.value,
    options: h.elements.youtubeEngineRelease.options.map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
  };
}

function assertControlsEnabled(h) {
  assert.equal(h.elements.youtubeEngineRelease.disabled, false, 'Version choice remained disabled');
  assert.equal(h.elements.checkYoutubeEngineBtn.disabled, false, 'Refresh remained disabled');
  assert.equal(h.elements.youtubeEngineUpdate.disabled, false, 'Selected install or switch remained disabled');
}

async function test(name, run) {
  await run();
  console.log(`OK ${name}`);
}

(async () => {
  await test('enhanced settings distinguish bundled, saved and remote versions', async () => {
    const h = harness();
    await h.context.checkYoutubeEngine();
    assert.match(h.elements.youtubeEngineVersion.textContent, new RegExp(currentVersion));
    assert.equal(h.elements.youtubeEngineHistory.textContent, historyNote);
    const options = h.elements.youtubeEngineRelease.options;
    assert.deepEqual(options.map(option => option.value), ['bundled', installedId, remoteId]);
    assert.match(options[0].textContent, /内置/);
    assert.match(options[1].textContent, /本机|已下载|已保存/);
    assert.match(options[2].textContent, /线上|在线|最新|可下载/);
    select(h, remoteId);
    assert.match(h.elements.youtubeEngineUpdate.textContent, /安装/);
    assertControlsEnabled(h);
    select(h, installedId);
    assert.match(h.elements.youtubeEngineUpdate.textContent, /切换/);
    assertControlsEnabled(h);
  });

  await test('unavailable enhanced releases cannot be installed', async () => {
    const data = status();
    data.releases.push({ id: 'unsupported', version: '2026.11.07.120000', source: 'remote', installed: false, current: false, available: false });
    const h = harness(() => response(data));
    await h.context.checkYoutubeEngine();
    const unsupported = h.elements.youtubeEngineRelease.options.find(option => option.value === 'unsupported');
    assert(!unsupported || unsupported.disabled, 'Unsupported release appears selectable');
    select(h, 'unsupported');
    assert.equal(h.elements.youtubeEngineUpdate.disabled, true);
    await h.context.updateYoutubeEngine();
    assert(!h.requests.some(request => request.url === '/api/youtube/update'));
  });

  await test('failed refresh preserves current version, history and chosen version', async () => {
    let fail = false;
    const h = harness(() => { if (fail) throw new Error('Network offline'); return response(status()); });
    await h.context.checkYoutubeEngine();
    select(h, installedId);
    const before = snapshot(h);
    fail = true;
    await h.context.checkYoutubeEngine();
    assert.deepEqual(snapshot(h), before);
    assert.match(h.elements.youtubeEngineMsg.textContent, /Network offline|网络|失败/);
    assertControlsEnabled(h);
  });

  await test('busy update preserves current engine and explains when to retry', async () => {
    const h = harness(url => url === '/api/youtube/update'
      ? response({ error: '下载或解析任务正在进行，请等待完成后再切换增强引擎', code: 'busy' }, 409)
      : response(status()));
    await h.context.checkYoutubeEngine();
    select(h, remoteId);
    const before = snapshot(h);
    await h.context.updateYoutubeEngine();
    assert.deepEqual(snapshot(h), before);
    assert.match(h.elements.youtubeEngineMsg.textContent, /等待|完成|任务/);
    assertControlsEnabled(h);
    assert.deepEqual(JSON.parse(h.requests.find(request => request.url === '/api/youtube/update').options.body), { id: remoteId });
  });

  await test('busy activation reveals the saved download without changing the active engine', async () => {
    const h = harness(url => {
      if (url === '/api/youtube/update') {
        return response({ error: '新任务正在运行，版本已下载，请等待任务结束后切换', error_code: 'engine_busy' }, 409);
      }
      const data = status();
      if (url === '/api/youtube/version') {
        data.releases = data.releases.map(release => release.id === remoteId
          ? { ...release, source: 'installed', installed: true }
          : release);
      }
      return response(data);
    });
    await h.context.checkYoutubeEngine();
    select(h, remoteId);
    const currentDisplay = h.elements.youtubeEngineVersion.textContent;
    assert.match(h.elements.youtubeEngineUpdate.textContent, /安装/);
    await h.context.updateYoutubeEngine();
    assert.equal(h.elements.youtubeEngineVersion.textContent, currentDisplay);
    assert.equal(h.elements.youtubeEngineRelease.value, remoteId);
    const saved = h.elements.youtubeEngineRelease.options.find(option => option.value === remoteId);
    assert.match(saved.textContent, /已下载/);
    assert.doesNotMatch(saved.textContent, /当前/);
    assert.match(h.elements.youtubeEngineUpdate.textContent, /切换/);
    assert.doesNotMatch(h.elements.youtubeEngineUpdate.textContent, /安装/);
    assert.match(h.elements.youtubeEngineMsg.textContent, /等待|任务.*完成|完成.*重试/);
    assertControlsEnabled(h);
    assert.deepEqual(h.requests.map(request => request.url), [
      '/api/youtube/releases', '/api/youtube/update', '/api/youtube/version',
    ]);
    assert.equal(h.maxActive, 1, 'Busy activation refresh must remain serialized');
  });

  await test('failed installation keeps the selected candidate and installed version', async () => {
    const h = harness(url => url === '/api/youtube/update'
      ? response({ error: '下载失败，请稍后重试' }, 502)
      : response(status()));
    await h.context.checkYoutubeEngine();
    select(h, remoteId);
    const before = snapshot(h);
    await h.context.updateYoutubeEngine();
    assert.deepEqual(snapshot(h), before);
    assert.match(h.elements.youtubeEngineMsg.textContent, /下载失败|重试/);
    assertControlsEnabled(h);
  });

  await test('local status refresh preserves the remote candidate and updates mode', async () => {
    const h = harness(url => {
      const data = status();
      if (url === '/api/youtube/version') {
        data.mode = 'standard';
        data.releases = data.releases.filter(release => release.source !== 'remote');
      }
      return response(data);
    });
    await h.context.checkYoutubeEngine();
    select(h, remoteId);
    await h.context.loadEngineStatus();
    assert.equal(h.elements.youtubeEngineRelease.value, remoteId);
    assert(h.elements.youtubeEngineRelease.options.some(option => option.value === remoteId));
    assert.match(h.elements.youtubeEngineVersion.textContent, /未启用/);
    assertControlsEnabled(h);
  });

  await test('restore built-in activates the bundled entry without downloading', async () => {
    let selected = installedId;
    const h = harness((url, options) => {
      if (url === '/api/youtube/update') selected = JSON.parse(options.body).id;
      return response(status(selected));
    });
    await h.context.checkYoutubeEngine();
    assert.equal(h.elements.restoreYoutubeEngineBtn.disabled, false);
    await h.context.updateYoutubeEngine(true);
    assert.equal(selected, 'bundled');
    assert.match(h.elements.youtubeEngineVersion.textContent, new RegExp(currentVersion));
    assert.equal(h.elements.restoreYoutubeEngineBtn.disabled, true);
    assert.equal(h.requests.filter(request => request.url === '/api/youtube/update').length, 1);
  });

  await test('installation is serialized and captures the version selected at click time', async () => {
    const pending = deferred();
    let selected = 'bundled';
    const h = harness((url, options) => {
      if (url === '/api/youtube/update') {
        assert.equal(JSON.parse(options.body).id, remoteId);
        return pending.promise;
      }
      return response(status(selected));
    });
    await h.context.checkYoutubeEngine();
    select(h, remoteId);
    const installing = h.context.updateYoutubeEngine();
    await Promise.resolve();
    assert.equal(h.elements.youtubeEngineRelease.disabled, true);
    assert.equal(h.elements.checkYoutubeEngineBtn.disabled, true);
    select(h, installedId);
    const refresh = h.context.checkYoutubeEngine();
    const localStatus = h.context.loadEngineStatus();
    assert.equal(h.maxActive, 1, 'Concurrent status request can overwrite an installation result');
    selected = remoteId;
    pending.resolve(response(status(selected)));
    await Promise.all([installing, refresh, localStatus]);
    assert.equal(h.maxActive, 1);
    assert.match(h.elements.youtubeEngineVersion.textContent, new RegExp(latestVersion));
    assert.equal(h.requests.filter(request => request.url === '/api/youtube/update').length, 1);
    assert.equal(h.elements.checkYoutubeEngineBtn.disabled, false);
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
