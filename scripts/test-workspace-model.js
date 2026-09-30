const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/static/workspace.js'), 'utf8');
const context = {
  cardData: [{jobId:'live',status:'downloading',title:'Live'}, {status:'ready',title:'Draft'}],
  tasks: [{id:'live',status:'downloading'},{id:'past',status:'done',title:'Past'}],
  activeStates: new Set(['downloading','paused','queued']), attentionStates: new Set(['error','info-error','missing']),
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  function alternateDownloadActions'), source.indexOf('  function renderJobDetails')), context);
vm.runInContext(source.slice(source.indexOf('  function collect()'), source.indexOf('  function mediaDescription')), context);
const entries = context.collect();
assert.equal(entries.length,3,'A download shared by a card and history must appear only once');
assert.equal(entries.filter(e=>e.task?.id==='live').length,1);
assert.equal(entries.find(e=>e.title==='Draft').card.status,'ready');
assert.equal(entries.filter(e=>context.matches(e,'active')).length,1,'Ready drafts must not count as active downloads');
assert.equal(entries.filter(e=>context.matches(e,'done')).length,1);
context.tasks[0].status='error';
assert.equal(context.collect().filter(e=>context.matches(e,'attention')).length,1,'Server errors determine the live task category');
context.cardData=[];
assert.equal(context.collect().length,2,'History survives loss of renderer draft state');
console.log('OK unified task identity, category changes, and persisted history');
context.attr = String;
context.uiIcon = () => '';
context.fmtSize = size => String(size);
vm.runInContext(source.slice(source.indexOf('  function mediaDescription'), source.indexOf('  function syncSidebarAccessibility')), context);
const draft = {format:'video', preset:'smallest',formats:[{id:'high',height:1080,label:'1080p SDR'},{id:'low',height:144,label:'144p SDR'}]};
assert(context.mediaDescription({card:draft}).includes('最低可用画质'));
assert(!context.mediaDescription({card:draft}).includes('1080p'));
for (const status of ['error','cancelled']) {
  const markup = context.rowActions({status,key:'card:0',index:0,card:draft,task:{id:'old',preset:'recommended'}});
  assert(markup.includes('data-click-action="download-card"'), 'Retry must read edited card settings');
  assert(!markup.includes('data-task-action="retry"'));
}
console.log('OK edited retries and honest quality summaries');
for (const status of ['done','error','cancelled','missing']) {
  const markup = context.rowActions({status,key:'job:past',task:{id:'past',status}});
  assert(markup.includes('data-task-action="delete"'), `${status} history needs a visible remove action`);
  assert(markup.includes('保留文件'));
}
const activeMarkup = context.rowActions({status:'downloading',key:'job:live',task:{id:'live'}});
assert(!activeMarkup.includes('data-task-action="delete"'));

(async () => {
  const appSource = fs.readFileSync(require('node:path').join(__dirname, '../app/static/app.js'), 'utf8');
  const card = {jobId:'past',status:'done'};
  const other = {jobId:'live',status:'downloading'};
  let ok = false, refreshed = 0, stopped = 0;
  const harness = {
    cardData:[card,other],
    fetch:async (url, options) => {
      assert.equal(url,'/api/jobs/past'); assert.equal(options.method,'DELETE');
      return {ok,json:async()=>ok ? {} : {error:'Cannot delete'}};
    },
    stopCardPolling:()=>stopped++, refreshTaskCenter:async()=>refreshed++,
    friendlyError:String, setSettingsMsg:()=>{}, window:{mediaWorkspace:{message:()=>{}}},
  };
  vm.createContext(harness);
  vm.runInContext(appSource.slice(appSource.indexOf('async function taskAction'),appSource.indexOf('function taskButtons')),harness);
  await harness.taskAction('past','delete');
  assert.equal(card.status,'done','Failed removal must preserve the card');
  ok = true;
  await harness.taskAction('past','delete');
  assert.equal(card.dismissed,true); assert.equal(card.status,'dismissed');
  assert.equal(other.status,'downloading'); assert.equal(stopped,1); assert.equal(refreshed,1);
  console.log('OK history removal, failed deletion, and active task preservation');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Contextual actions must not squeeze titles or expose destructive controls as the primary action.
for (const status of ['ready','missing','done','downloading','paused','queued','error','cancelled']) {
  const entry = {status,key:'job:test',task:{id:'test',status,file:'/tmp/example.mp4',url:'https://example.com/video'}};
  const main = context.primaryAction(entry);
  assert((main.match(/<button/g) || []).length <= 1, `${status} should have at most one quick action`);
  assert(!main.includes('data-task-action="delete"'));
  if (status === 'missing') { assert(main.includes('定位文件')); assert(!main.includes('retry')); }
  if (status === 'done') { assert(main.includes('打开文件')); assert(!main.includes('retry')); }
  if (status === 'queued') assert(context.secondaryActions(entry).includes('data-direction="up"'));
}
const detailNode = {innerHTML:''};
Object.assign(context, {$:()=>detailNode, esc:String, safeMediaUrl:()=>'', labels:{done:'已完成',missing:'文件已移动'}, fmtDur:String, progressPhaseLabel:()=>'', fmtSpeed:String, fmtEtaEstimate:()=>'', friendlyError:String});
vm.runInContext(source.slice(source.indexOf('  function renderJobDetails'), source.indexOf('  async function removeEntry')),context);
context.renderJobDetails({title:'Completed audio',status:'done',task:{status:'done',format:'audio',filename:'example.mp3',file:'/tmp/example.mp3',file_size:100,options:{audio_quality:'192'}}});
assert(detailNode.innerHTML.includes('192 kbps'));
assert(detailNode.innerHTML.includes('data-drag-file'));
assert(!detailNode.innerHTML.includes('card-dl-btn'));
assert(!detailNode.innerHTML.includes('高级选项'));
context.renderJobDetails({title:'Moved audio',status:'missing',task:{status:'missing',format:'audio',file:'/tmp/example.mp3'}});
assert(!detailNode.innerHTML.includes('data-workspace="preview"'),'Missing files must not offer preview');
assert(detailNode.innerHTML.includes('定位移动后的文件'));
console.log('OK contextual primary actions, queue controls, completed and missing file inspectors');

// Alternate downloads reuse live cards and persisted jobs without calling the parser.
let started = [], selectedCards = [];
Object.assign(context, {entries:[], cardData:[], renderCard:()=>{}, showInspector:()=>{},
  window:{mediaWorkspace:{selectCard:index=>selectedCards.push(index)}},
  dlCard:index=>{started.push(index); context.cardData[index].status='downloading';},
  choose:key=>{context.chosen=key;}, setFilter:()=>{}});
const sourceTask = {id:'original',url:'https://example.com/video',format:'video',status:'done',
  title:'Original',file:'/tmp/original.mp4',options:{youtube_engine:'sabr',skip_browser_cookies:true}};
const before = JSON.stringify(sourceTask);
context.downloadAlternate({task:sourceTask}, 'audio');
assert.equal(started.length,1);
assert.equal(context.cardData[0].format,'audio');
assert.equal(context.cardData[0].youtubeEngine,'sabr');
assert.equal(context.cardData[0].skipBrowserCookies,true);
assert.equal(context.cardData[0].jobId,undefined);
assert.equal(context.cardData[0].options.audio_quality,'192');
assert.equal(JSON.stringify(sourceTask),before,'Original completed file and task must remain unchanged');
context.entries=[{key:'card:0',card:context.cardData[0],status:'downloading'}];
context.downloadAlternate({task:sourceTask}, 'audio');
assert.equal(started.length,1,'Repeated clicks select the existing active task');
assert.equal(context.chosen,'card:0');
context.downloadAlternate({task:sourceTask,card:{url:sourceTask.url,title:'Cached',jobId:'old',
  selectedFormatId:'video-only',options:{audio_quality:'320',subtitles:true}}}, 'image');
assert.equal(started.length,2);
assert.equal(context.cardData[1].format,'image');
assert.equal(context.cardData[1].selectedFormatId,null);
assert.equal(context.cardData[1].options.subtitles,undefined);
context.downloadAlternate({task:sourceTask}, 'video');
assert.equal(started.length,2);
const actions = context.alternateDownloadActions({key:'job:original',task:sourceTask});
assert(actions.includes('下载音频') && actions.includes('下载封面'));
assert(!actions.includes('reparse'));
console.log('OK direct audio/cover downloads, persisted history, duplicate clicks, and source preservation');

for (const status of ['error','cancelled']) {
  assert.equal(context.usesFileDetails({status,task:{status},card:{status}}),false);
  assert.equal(context.usesFileDetails({status,task:{status}}),true);
}
assert.equal(context.usesFileDetails({status:'done',task:{},card:{}}),true);
const menuButton = (id,action) => ({dataset:{jobId:id,taskAction:action,glassId:'1'},disabled:false,matches:q=>q==='button'});
const oldAction = menuButton('original','cancel');
const replacement = menuButton('original','cancel');
context.$ = () => ({children:[replacement]});
const descriptor = context.menuActionDescriptor(oldAction);
assert.equal(context.resolveMenuAction('menu',descriptor),replacement);
replacement.dataset.glassId='9';
assert.equal(context.resolveMenuAction('menu',descriptor),replacement);
replacement.dataset.jobId='other';
assert.equal(context.resolveMenuAction('menu',descriptor),undefined);
replacement.dataset.jobId='original'; replacement.disabled=true;
assert.equal(context.resolveMenuAction('menu',descriptor),undefined);
console.log('OK editable retries and stable task identity across native menu refreshes');
