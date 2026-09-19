const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
function load(platform = 'darwin', release = '25.6.0') {
  const calls = [], handlers = {}, frame = {};
  const sender = { mainFrame: frame, getURL: () => 'http://127.0.0.1:1234/' };
  const win = { isDestroyed: () => false, isFocused: () => true, getNativeWindowHandle: () => Buffer.alloc(8) };
  const electron = { app: {isPackaged: true}, nativeTheme: {}, BrowserWindow: { fromWebContents: () => win }, ipcMain: {handle: (name, fn) => handlers[name] = fn} };
  const context = { module: {exports: {}}, process: {platform, resourcesPath:'/resources'}, __dirname: __dirname, URL, console,
    require: name => name === './glass-inspector' ? require('../glass-inspector') : name === 'node:path' ? path : name === 'node:os' ? {release: () => release} : {apply: (...args) => {calls.push(args); return args[1];}} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../native-glass.js'),'utf8'), context);
  const api = context.module.exports; api.install(electron);
  return {api, electron, calls, win, activity:handlers['window-activity'], handler: handlers['native-glass'], event: {sender, senderFrame: frame}};
}
const t = load();
assert.equal(t.api.windowOptions(t.electron.app).transparent, true);
assert.equal(t.handler(t.event, 'dark'), true);
assert.equal(t.calls[0][2], 'dark');
t.electron.nativeTheme.prefersReducedTransparency = true;
assert.equal(t.handler(t.event, 'light'), false);
assert.equal(t.calls[1][1], false);
assert.equal(t.handler({...t.event, senderFrame:{}}, 'dark'), false);
assert.equal(t.calls.length, 2);
for (const [platform, release] of [['win32','25.0.0'],['darwin','24.0.0']]) {
 const old = load(platform, release); assert.equal(Object.keys(old.api.windowOptions(old.electron.app)).length,0); assert.equal(old.handler(old.event,'system'),false);
}
console.log('Native glass: main-frame ownership, reduced-transparency fallback, and unsupported systems passed');

const { installInspector, validGeometry, inspectorHTML } = require('../glass-inspector');
const rect = {x:600,y:58,width:340,height:650};
assert(validGeometry({bounds:rect,opacity:1}));
for (const bad of [NaN,Infinity,-1,20001]) assert(!validGeometry({bounds:{...rect,width:bad},opacity:1}));
assert(!validGeometry({bounds:rect,opacity:2}));
const documentHTML = inspectorHTML({isPackaged:false});
assert.equal((documentHTML.match(/id="inspector"/g)||[]).length,1,'SVG symbols must never shadow the inspector DOM root');
assert(documentHTML.includes('id="glass-icon-inspector"'));
assert(documentHTML.includes("default-src 'none'"));
const handlers = {}, nativeCalls = [], sent = [], frame = {};
let closed = false;
const sender = {mainFrame:frame,getURL:()=> 'http://127.0.0.1:1234/',getZoomFactor:()=>1.5,focus:()=>{},isDestroyed:()=>false,send:(...args)=>sent.push(args)};
const owner = {isDestroyed:()=>closed,getNativeWindowHandle:()=>Buffer.alloc(8)};
const theme = {};
const bridge = {inspector:(...args)=>{nativeCalls.push(args);return true;}};
installInspector({app:{isPackaged:false},ipcMain:{handle:(key,fn)=>handlers[key]=fn},BrowserWindow:{fromWebContents:()=>owner},nativeTheme:theme},()=>bridge);
const event = {sender,senderFrame:frame};
const state = {bounds:rect,opacity:1,enabled:true,visible:true,appearance:'dark',content:{html:'<p>Example</p>',revision:1}};
assert.equal(handlers['native-inspector']({...event,senderFrame:{}},state),false);
assert.equal(nativeCalls.length,0,'Subframes cannot create native surfaces');
assert.equal(handlers['native-inspector'](event,state),true);
let nativeState = JSON.parse(nativeCalls[0][1]);
assert.equal(nativeState.bounds.width,510,'CSS coordinates must follow browser zoom');
assert.equal(nativeState.appearance,'dark');
nativeCalls[0][3](JSON.stringify({type:'click',id:'1',revision:1}));
assert.equal(sent.length,1);
theme.prefersReducedTransparency = true;
handlers['native-inspector'](event,state);
assert.equal(JSON.parse(nativeCalls[1][1]).enabled,false,'Accessibility settings disable native glass');
closed = true;
nativeCalls[0][3](JSON.stringify({type:'click',id:'1',revision:1}));
assert.equal(sent.length,1,'A destroyed window must not receive late native callbacks');
console.log('Native inspector: isolated document, geometry/zoom, IPC ownership, accessibility fallback and late callbacks passed');

closed = false;
for (const surface of ['sidebar','toolbar']) {
 const html = inspectorHTML({isPackaged:false},surface);
 assert.equal((html.match(/id="inspector"/g)||[]).length,1);
 assert(html.includes('pointer-events:auto'),'Native documents must not inherit hidden sidebar input suppression');
 theme.prefersReducedTransparency = false;
 handlers['native-'+surface](event,state);
 const call = nativeCalls.at(-1);
 assert.equal(JSON.parse(call[1]).surface,surface);
 call[3](JSON.stringify({type:'click',id:'1',revision:1}));
 assert.equal(sent.at(-1)[0],'native-'+surface+'-action','Surface callbacks must not cross-route controls');
}
console.log('Native navigation: isolated input, independent surface identity and action routing passed');

const activity = load();
assert.equal(activity.activity(activity.event),true);
activity.win.isFocused = () => false;
assert.equal(activity.activity(activity.event),false);
assert.equal(activity.activity({...activity.event,senderFrame:{}}),false);
console.log('Window activity: window focus and main-frame ownership passed');
