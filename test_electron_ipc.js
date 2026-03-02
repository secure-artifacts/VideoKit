const electron = require('electron');
console.log('TYPE:', typeof electron);
if (typeof electron === 'string') {
    console.log('electron is a STRING (path):', electron);
} else {
    console.log('KEYS:', Object.keys(electron).join(', '));
    console.log('ipcMain:', electron.ipcMain);
    console.log('app:', typeof electron.app);
}
if (electron.app && electron.app.quit) {
    electron.app.whenReady().then(() => electron.app.quit());
    setTimeout(() => process.exit(0), 3000);
} else {
    process.exit(0);
}
