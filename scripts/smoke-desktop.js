const assert = require("assert");

async function cdpCommand(socket, state, method, params = {}) {
  const id = state.nextId++;
  const response = new Promise((resolve, reject) => state.pending.set(id, { resolve, reject }));
  socket.send(JSON.stringify({ id, method, params }));
  return response;
}

async function main() {
  const port = Number(process.argv[2] || 9333);
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const target = targets.find((item) => item.type === "page");
  assert(target?.webSocketDebuggerUrl, "No Electron renderer target was found");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const state = { nextId: 1, pending: new Map(), exceptions: [] };
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const pending = state.pending.get(message.id);
      if (!pending) return;
      state.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      state.exceptions.push(message.params.exceptionDetails.text);
    }
  });

  await cdpCommand(socket, state, "Runtime.enable");
  const expression = `
    (async () => {
      const before = {
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        goType: typeof go,
        openSettingsType: typeof openSettings,
      };
      openSettings();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const healthResponse = await fetch('/api/health');
      const health = await healthResponse.json();
      const versionResponse = await fetch('/api/ytdlp/version?channel=stable');
      const version = await versionResponse.json();
      const releasesResponse = await fetch('/api/ytdlp/releases?channel=nightly&limit=3');
      const releases = await releasesResponse.json();
      const scriptResponse = await fetch('/static/app.js');
      return {
        before,
        settingsOpen: document.getElementById('settingsDrawer').classList.contains('open'),
        settingsAriaHidden: document.getElementById('settingsDrawer').getAttribute('aria-hidden'),
        healthStatus: healthResponse.status,
        health,
        ytdlpStatus: versionResponse.status,
        ytdlpVersion: version.current || version.version || null,
        ytdlpChannelControl: document.getElementById('ytdlpChannel')?.tagName || null,
        ytdlpReleaseControl: document.getElementById('ytdlpRelease')?.tagName || null,
        releasesStatus: releasesResponse.status,
        releasesChannel: releases.channel || null,
        releaseVersions: (releases.releases || []).map((release) => release.version),
        installableReleases: (releases.releases || []).filter((release) => release.available).length,
        scriptStatus: scriptResponse.status,
        scriptContentType: scriptResponse.headers.get('content-type'),
      };
    })()
  `;
  const evaluation = await cdpCommand(socket, state, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  socket.close();

  if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text || "Renderer evaluation failed");
  }
  const result = evaluation.result.value;
  assert.strictEqual(result.before.readyState, "complete");
  assert.strictEqual(result.before.goType, "function");
  assert.strictEqual(result.before.openSettingsType, "function");
  assert.strictEqual(result.settingsOpen, true);
  assert.strictEqual(result.settingsAriaHidden, "false");
  assert.strictEqual(result.healthStatus, 200);
  assert.strictEqual(result.ytdlpStatus, 200);
  assert.strictEqual(result.ytdlpVersion, "2026.08.18.122307");
  assert.strictEqual(result.ytdlpChannelControl, "SELECT");
  assert.strictEqual(result.ytdlpReleaseControl, "SELECT");
  assert.strictEqual(result.releasesStatus, 200);
  assert.strictEqual(result.releasesChannel, "nightly");
  assert.strictEqual(result.releaseVersions.length, 3);
  assert(result.installableReleases > 0);
  assert.strictEqual(result.scriptStatus, 200);
  assert.match(result.scriptContentType || "", /javascript/i);
  assert.deepStrictEqual(state.exceptions, []);
  console.log(JSON.stringify(result, null, 2));
  console.log("desktop renderer smoke OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
