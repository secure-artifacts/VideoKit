const { BrowserWindow, session } = require('electron');
const elevenlabsService = require('./elevenlabs');

let authWindow = null;

function openElevenLabsAuthWindow() {
    if (authWindow) {
        authWindow.focus();
        return;
    }

    const partition = 'persist:elevenlabs';
    const ses = session.fromPartition(partition);

    authWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'ElevenLabs Web Login',
        webPreferences: {
            partition,
            nodeIntegration: false,
            contextIsolation: true,
        }
    });

    // 拦截请求提取 Token / Api Key
    ses.webRequest.onBeforeSendHeaders({
        urls: ['*://api.elevenlabs.io/*', '*://elevenlabs.io/api/*']
    }, (details, callback) => {
        let captured = false;
        let tokenData = {};

        const headers = details.requestHeaders;
        const lowHeaders = {};
        for (const k in headers) {
            lowHeaders[k.toLowerCase()] = headers[k];
        }

        if (lowHeaders['xi-api-key']) {
            tokenData.xiApiKey = lowHeaders['xi-api-key'];
            captured = true;
        }
        if (lowHeaders['authorization']) {
            tokenData.authorization = lowHeaders['authorization'];
            captured = true;
        }

        // 保存获取到的 Token/Cookie
        if (captured) {
            ses.cookies.get({ domain: '.elevenlabs.io' }).then((cookies) => {
                const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                tokenData.cookie = cookieStr;
                
                // 保存到配置中
                const data = elevenlabsService.loadSettings();
                data.web_token = tokenData;
                elevenlabsService.saveSettings(data);
                
                console.log('[ElevenLabs Auth] Captured credentials successfully');
                // 可选：发送事件给主窗口
            }).catch(e => console.error('[ElevenLabs Auth] Cookie get error', e));
        }

        callback({ cancel: false });
    });

    authWindow.loadURL('https://elevenlabs.io/app/home');

    authWindow.on('closed', () => {
        authWindow = null;
    });
}

function clearElevenLabsSession() {
    return new Promise((resolve) => {
        const ses = session.fromPartition('persist:elevenlabs');
        ses.clearStorageData().then(() => {
            const data = elevenlabsService.loadSettings();
            delete data.web_token;
            elevenlabsService.saveSettings(data);
            resolve(true);
        });
    });
}

module.exports = {
    openElevenLabsAuthWindow,
    clearElevenLabsSession
};
