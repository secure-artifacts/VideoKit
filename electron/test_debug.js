// 在 require('electron') 之前打印 process 信息
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);
console.log('process.versions.node:', process.versions.node);

const electron = require('electron');
console.log('electron type:', typeof electron);
if (typeof electron === 'object' && electron.app) {
    console.log('SUCCESS - got real Electron API');
    electron.app.whenReady().then(() => electron.app.quit());
} else {
    console.log('FAILED - got:', electron);
}
setTimeout(() => process.exit(0), 3000);
