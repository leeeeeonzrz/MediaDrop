const assert = require("assert");

async function connect(port) {
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
  const page = targets.find((target) => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
  assert(page?.webSocketDebuggerUrl, "MediaDrop renderer target not found");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function evaluate(send, expression) {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function main() {
  const port = Number(process.argv[2] || 9333);
  const url = process.argv[3] || "https://www.youtube.com/watch?v=GBQMzPEZfy8";
  const { socket, send } = await connect(port);
  const info = await evaluate(send, `(async () => {
    const response = await fetch('/api/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: ${JSON.stringify(url)} }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  assert.strictEqual(info.status, 200, JSON.stringify(info.body));
  const format = info.body.formats.find((item) => item.id === "137") || info.body.formats[0];
  assert(format?.id, "No downloadable video format returned");
  console.log(JSON.stringify({ title: info.body.title, selectedFormat: format }, null, 2));

  const started = await evaluate(send, `(async () => {
    const response = await fetch('/api/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: ${JSON.stringify(url)}, format: 'video', format_id: ${JSON.stringify(format.id)},
        video_range_mode: 'auto', preset: 'custom',
        options: { container: 'mp4', subtitle_mode: 'none' },
        title: ${JSON.stringify(info.body.title || "")},
      }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert(started.body.job_id, "Download job was not created");

  const deadline = Date.now() + 15 * 60 * 1000;
  let lastProgress = "";
  while (Date.now() < deadline) {
    const status = await evaluate(send, `(async () => {
      const response = await fetch('/api/status/${encodeURIComponent(started.body.job_id)}');
      return { status: response.status, body: await response.json() };
    })()`);
    assert.strictEqual(status.status, 200, JSON.stringify(status.body));
    const progress = JSON.stringify(status.body.progress || {});
    if (progress !== lastProgress) {
      console.log(JSON.stringify({ status: status.body.status, progress: status.body.progress }));
      lastProgress = progress;
    }
    if (status.body.status === "done") {
      console.log(JSON.stringify({ status: "done", filename: status.body.filename }, null, 2));
      socket.close();
      return;
    }
    if (status.body.status === "error") {
      throw new Error(`${status.body.error_code || "download_error"}: ${status.body.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for packaged YouTube download");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
