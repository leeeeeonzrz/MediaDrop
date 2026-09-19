const path = require('path');
const fs = require('fs');
const roots = {chrome:'Google/Chrome',firefox:'Firefox/Profiles',edge:'Microsoft Edge',brave:'BraveSoftware/Brave-Browser',opera:'com.operasoftware.Opera',vivaldi:'Vivaldi'};
async function requestBrowserAccess(browser, {platform=process.platform,home,read=fs.promises.readdir}={}) {
  if (platform !== 'darwin') return {status:'not-required'};
  if (!roots[browser]) return {status:'unsupported'};
  try {
    // Enumerating the selected browser directory invokes macOS App Data consent.
    // Do not inspect Cookie contents or request full disk access.
    await read(path.join(home,'Library','Application Support',roots[browser]));
    return {status:'granted'};
  } catch (e) {
    return {status: ['EPERM','EACCES'].includes(e.code) ? 'denied' : e.code === 'ENOENT' ? 'missing' : 'error'};
  }
}
module.exports = {requestBrowserAccess};
