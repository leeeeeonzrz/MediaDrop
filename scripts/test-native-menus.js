const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {installNativeMenus} = require('../native-menus');
(async()=>{
 const win = new EventEmitter(); Object.assign(win,{isDestroyed:()=>false,getContentSize:()=>[800,600]});
 const frame={},sender={mainFrame:frame,getURL:()=> 'http://127.0.0.1:1234/',getZoomFactor:()=>1.5};
 let handle,template,popup;
 installNativeMenus({ipcMain:{handle:(_,fn)=>handle=fn},BrowserWindow:{fromWebContents:()=>win},Menu:{buildFromTemplate:items=>{template=items;return {popup:options=>{popup=options;}};}}});
 const event={sender,senderFrame:frame}; const request={items:[{label:'快速查看'},{separator:true},{label:'移除记录'}],point:{x:900,y:10}};
 assert.equal(handle({...event,senderFrame:{}},request),null);
 assert.equal(handle(event,{items:[{label:'x'.repeat(121)}]}),null);
 const selected=handle(event,request); assert.equal(popup.x,800); assert.equal(popup.y,15);
 assert.equal(handle(event,request),null,'Do not open a second concurrent menu');
 template[2].click();popup.callback();assert.equal(await selected,2);
 const cancelled=handle(event,request);popup.callback();assert.equal(await cancelled,null);
 const closed=handle(event,request);win.emit('closed');assert.equal(await closed,null);
 console.log('Native menus: frame ownership, bounded input, zoom, selection, cancellation and window closure passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
