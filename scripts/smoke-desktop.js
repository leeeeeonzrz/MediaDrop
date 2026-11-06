const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[2] || 9333);
const expectedVersion = process.argv[3] || '2026.10.26';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pages() { return fetch(`http://127.0.0.1:${port}/json`).then(res => res.json()); }
async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
  let id=0; const pending=new Map(), errors=[];
  socket.addEventListener('message',event => {
    const message=JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const request=pending.get(message.id); pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    } else if (message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  function send(method,params={}) { return new Promise((resolve,reject) => { const key=++id; const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timeout: ${method}`))},90000); pending.set(key,{resolve,reject,timer}); socket.send(JSON.stringify({id:key,method,params})); }); }
  await send('Runtime.enable');
  async function evaluate(expression) { const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
  return {socket,send,evaluate,errors};
}
async function main() {
  const connections=[];
  try {
    let target;
    for(let attempt=0;attempt<50;attempt++){try{target=(await pages()).find(page=>page.type==='page' && page.url.startsWith('http://127.0.0.1:') && !page.url.includes('settings'));}catch{}if(target)break;await wait(200);}
    assert(target,'Main renderer missing'); const main=await connect(target);connections.push(main);
    await main.send('Page.reload'); await wait(1500);
    const result=await main.evaluate(`(async()=>{
      const script=await fetch('/static/app.js'); const health=await fetch('/api/health');
      const config=await fetch('/api/config').then(res=>res.json());
      cardData=[{url:'https://example.com/fixture',title:'字幕与新版画质测试',status:'ready',format:'video',preset:'recommended',videoRangeMode:'auto',formats:[{id:'137',label:'1080p H.264',height:1080,hdr:false,vcodec:'avc1'},{id:'248',label:'1080p VP9',height:1080,hdr:false,vcodec:'vp9'}],subtitleTracks:[{code:'zh-Hans',name:'简体中文'},{code:'en',name:'English',automatic:true}],options:{container:'mp4',subtitle_mode:'none',subtitle_languages:'zh-Hans,en'},completedDownloads:{}}];
      renderCard(0); mediaWorkspace.selectCard(0); mediaWorkspace.render();
      setSubtitleMode(0,'burn'); setOption(0,'burn_subtitle_language','zh-Hans');
      const burn=buildDownloadRequest(cardData[0]); const burnControl=Boolean(document.querySelector('#card-0 [data-option="burn_subtitle_language"]'));
      setSubtitleMode(0,'download'); setOption(0,'subtitle_language','zh-Hans');setOption(0,'subtitle_format','ass');
      const subtitle=buildDownloadRequest(cardData[0]);const hiddenFormats=!document.querySelector('#card-0 .format-details');
      setSubtitleMode(0,'embed');setOption(0,'container','webm');
      const webmDisabled=document.querySelector('#card-0 [data-option="embed_thumbnail"]').disabled;
      const languages=document.querySelectorAll('#card-0 [data-change-action="toggle-embed-subtitle"]').length;
      const layout={card:document.getElementById('card-0').getBoundingClientRect().width,localControl:document.getElementById('localBurnBtn').getBoundingClientRect().width};
      cardData=[];mediaWorkspace.render();openSettings('updates');
      return {ready:document.readyState,health:health.status,scriptType:script.headers.get('content-type'),downloadDir:config.download_dir,burn,burnControl,subtitle,hiddenFormats,webmDisabled,languages,layout};
    })()`);
    assert.equal(result.ready,'complete');assert.equal(result.health,200);assert.match(result.scriptType,/javascript/);
    assert.equal(result.burn.options.subtitle_mode,'burn');assert.equal(result.burn.videoRangeMode,'sdr');assert(result.burnControl);
    assert.equal(result.subtitle.format,'subtitle');assert.equal(result.subtitle.options.subtitle_format,'ass');assert.equal(result.subtitle.formatId,null);
    assert(result.hiddenFormats);assert(result.webmDisabled);assert.equal(result.languages,2);assert(result.layout.card>0 && result.layout.localControl>0);
    let settings;
    for(let attempt=0;attempt<30;attempt++){settings=(await pages()).find(page=>page.type==='page' && page.url.includes('settings'));if(settings)break;await wait(100);}
    assert(settings,'Settings window missing');const secondary=await connect(settings);connections.push(secondary);
    for(let attempt=0;attempt<50;attempt++){if(await secondary.evaluate("typeof loadSettings === 'function'"))break;await wait(100);}
    const status=await secondary.evaluate(`(async()=>{
      await loadSettings();mediaWorkspace.settingsTab('updates');document.getElementById('ytdlpChannel').value='stable';await checkYtdlp();
      const version=document.getElementById('ytdlpVersion').textContent;const stable=document.getElementById('ytdlpRelease').options.length;
      document.getElementById('ytdlpChannel').value='nightly';await checkYtdlp();
      return {open:document.getElementById('settingsDrawer').classList.contains('open'),version,stable,nightly:document.getElementById('ytdlpRelease').options.length,installable:!document.getElementById('ytdlpRelease').disabled,enhanced:await fetch('/api/engines').then(res=>res.json())};
    })()`);
    assert(status.open);assert.equal(status.version,expectedVersion);assert(status.stable>1 && status.nightly>1 && status.installable);assert(status.enhanced.youtube.available);
    const screenshot=await main.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'..','build','integration-main.png'),Buffer.from(screenshot.data,'base64'));
    const settingsScreenshot=await secondary.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'..','build','integration-settings.png'),Buffer.from(settingsScreenshot.data,'base64'));
    assert.deepEqual(main.errors,[]);assert.deepEqual(secondary.errors,[]);
    console.log(JSON.stringify({result,status},null,2));console.log('Packaged workspace, subtitles, WebM and settings smoke OK');
  } finally { for(const connection of connections)connection.socket.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
