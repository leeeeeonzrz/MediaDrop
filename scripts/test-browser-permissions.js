const assert = require('node:assert/strict');
const {requestBrowserAccess} = require('../browser-permissions');
(async()=>{
  let reads = 0;
  const opts = {platform:'darwin',home:'/test',read:async p=>{reads++;assert.equal(p,'/test/Library/Application Support/Google/Chrome');}};
  assert.equal((await requestBrowserAccess('chrome',opts)).status,'granted');
  assert.equal(reads,1);
  for (const [code,status] of [['EPERM','denied'],['EACCES','denied'],['ENOENT','missing'],['EIO','error']]) {
    assert.equal((await requestBrowserAccess('chrome',{...opts,read:async()=>{throw Object.assign(new Error(),{code});}})).status,status);
  }
  assert.equal((await requestBrowserAccess('../other',opts)).status,'unsupported');
  assert.equal((await requestBrowserAccess('chrome',{...opts,platform:'win32'})).status,'not-required');
  assert.equal(reads,1,'Unsupported browser or platform must not access data');
  console.log('OK browser consent: exact directory, denied/missing distinction, platform and path restrictions');
})().catch(e=>{console.error(e);process.exitCode=1});
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../main.js'),'utf8');
(async()=>{
  for (const choice of [0,1,2]) {
    let shown=false, dialogs=0, requests=0, settings=0;
    const ctx={process:{platform:'darwin'},path:require('node:path'),app:{getPath:()=>'/test'},mainWindow:{},
      fs:{existsSync:()=>shown,writeFileSync:()=>{shown=true}},
      dialog:{showMessageBox:async()=>{dialogs++;return {response:choice}}},
      browserAccess:async b=>{assert.equal(b,'chrome');requests++},openSettingsWindow:()=>settings++};
    vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('async function firstRunBrowserAccess'),source.indexOf('ipcMain.handle("close-settings-window"')),ctx);
    await ctx.firstRunBrowserAccess(); await ctx.firstRunBrowserAccess();
    assert.equal(dialogs,1);assert.equal(requests,choice===0?1:0);assert.equal(settings,choice===1?1:0);
  }
  console.log('OK first-run introduction: consent precedes access, skip and alternative, shown once');
})().catch(e=>{console.error(e);process.exitCode=1});
