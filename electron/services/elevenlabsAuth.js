const { BrowserWindow, session } = require('electron');
const elevenlabsService = require('./elevenlabs');

const PARTITION = 'persist:elevenlabs';
const LOGIN_URL = 'https://elevenlabs.io/app/home';
const VERIFY_CACHE_MS = 30 * 1000;

let authWindow = null;
let loginState = {
    state: 'idle',
    message: '尚未连接',
    lastVerifiedAt: null,
    quota: null,
};
let lastVerificationAt = 0;
let verificationPromise = null;
let captureTimer = null;
const statusTargets = new Set();

function publicStatus(overrides = {}) {
    const settings = elevenlabsService.loadSettings();
    const hasCredentials = !!(settings.web_token && (
        settings.web_token.authorization ||
        settings.web_token.xiApiKey ||
        settings.web_token.cookie
    ));
    return {
        state: loginState.state,
        hasCredentials,
        // 保留旧字段供设置页兼容；仅返回布尔值，不暴露凭证。
        hasToken: hasCredentials,
        valid: loginState.state === 'ready',
        message: loginState.message,
        lastVerifiedAt: loginState.lastVerifiedAt,
        quota: loginState.quota,
        ...overrides,
    };
}

function emitStatus(overrides = {}) {
    const payload = publicStatus(overrides);
    for (const webContents of statusTargets) {
        if (!webContents || webContents.isDestroyed()) {
            statusTargets.delete(webContents);
            continue;
        }
        try { webContents.send('elevenlabs-web-auth-status', payload); } catch {}
    }
    return payload;
}

function setState(state, message, extra = {}) {
    loginState = { ...loginState, state, message, ...extra };
    return emitStatus();
}

function rememberStatusTarget(webContents) {
    if (webContents && !webContents.isDestroyed()) statusTargets.add(webContents);
}

function errorMessage(error) {
    const text = String(error?.message || error || '验证失败');
    if (/\b401\b|unauthori[sz]ed|invalid.*token/i.test(text)) return '登录已过期，请重新登录';
    if (/\b403\b|forbidden/i.test(text)) return '当前账号无权访问，请重新登录或检查账号权限';
    if (/timeout|超时/i.test(text)) return '连接 ElevenLabs 超时，请检查网络后重试';
    return `登录验证失败：${text.slice(0, 160)}`;
}

async function validateStoredSession({ force = false, webContents = null } = {}) {
    rememberStatusTarget(webContents);
    const settings = elevenlabsService.loadSettings();
    const hasCredentials = !!(settings.web_token && (
        settings.web_token.authorization ||
        settings.web_token.xiApiKey ||
        settings.web_token.cookie
    ));

    if (!hasCredentials) {
        lastVerificationAt = 0;
        return setState('signed_out', '未登录');
    }

    if (!force && loginState.state === 'ready' && Date.now() - lastVerificationAt < VERIFY_CACHE_MS) {
        return publicStatus();
    }
    if (verificationPromise) return verificationPromise;

    setState('verifying', '正在验证 ElevenLabs 登录…');
    verificationPromise = (async () => {
        try {
            const quota = await elevenlabsService.getQuota('__WEB_TOKEN__');
            const remaining = Math.max(0, (quota.limit || 0) - (quota.usage || 0));
            const data = elevenlabsService.loadSettings();
            data.use_web_token = true;
            data.web_token_enabled = true;
            data.web_token_manual_disabled = false;
            data.web_token_auto_disabled = false;
            data.web_token_auto_disabled_reason = '';
            elevenlabsService.saveSettings(data);

            lastVerificationAt = Date.now();
            const ready = setState('ready', `登录有效，剩余额度 ${remaining.toLocaleString()}`, {
                lastVerifiedAt: new Date().toISOString(),
                quota: { ...quota, remaining },
            });
            if (authWindow && !authWindow.isDestroyed()) {
                setTimeout(() => {
                    if (authWindow && !authWindow.isDestroyed()) authWindow.close();
                }, 500);
            }
            return ready;
        } catch (error) {
            const data = elevenlabsService.loadSettings();
            data.web_token_enabled = false;
            data.web_token_auto_disabled = true;
            data.web_token_auto_disabled_reason = 'session_invalid';
            elevenlabsService.saveSettings(data);
            lastVerificationAt = 0;
            return setState('expired', errorMessage(error), { quota: null });
        } finally {
            verificationPromise = null;
        }
    })();
    return verificationPromise;
}

function scheduleCapturedCredentialsValidation(tokenData) {
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = setTimeout(async () => {
        const data = elevenlabsService.loadSettings();
        data.web_token = { ...(data.web_token || {}), ...tokenData };
        data.use_web_token = true;
        elevenlabsService.saveSettings(data);
        setState('captured', '已获取登录凭证，正在验证…');
        await validateStoredSession({ force: true });
    }, 250);
}

function openElevenLabsAuthWindow(webContents = null) {
    rememberStatusTarget(webContents);
    if (authWindow && !authWindow.isDestroyed()) {
        authWindow.focus();
        return publicStatus({ windowOpen: true });
    }

    const ses = session.fromPartition(PARTITION);
    setState('opening', '正在打开 ElevenLabs 登录页面…');

    authWindow = new BrowserWindow({
        width: 1050,
        height: 800,
        title: '登录 ElevenLabs',
        autoHideMenuBar: true,
        webPreferences: {
            partition: PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        }
    });

    ses.webRequest.onBeforeSendHeaders({
        urls: ['*://api.elevenlabs.io/*', '*://elevenlabs.io/api/*']
    }, (details, callback) => {
        const headers = details.requestHeaders || {};
        const normalized = {};
        for (const key of Object.keys(headers)) normalized[key.toLowerCase()] = headers[key];

        const tokenData = {};
        if (normalized['xi-api-key']) tokenData.xiApiKey = normalized['xi-api-key'];
        if (normalized.authorization) tokenData.authorization = normalized.authorization;

        if (tokenData.xiApiKey || tokenData.authorization) {
            ses.cookies.get({ url: 'https://elevenlabs.io/' })
                .then(cookies => {
                    if (cookies.length) {
                        tokenData.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                    }
                    scheduleCapturedCredentialsValidation(tokenData);
                })
                .catch(() => scheduleCapturedCredentialsValidation(tokenData));
        }
        callback({ cancel: false, requestHeaders: details.requestHeaders });
    });

    authWindow.loadURL(LOGIN_URL).catch(error => {
        setState('error', `登录页面打开失败：${error.message}`);
    });
    authWindow.webContents.once('did-finish-load', () => {
        if (loginState.state === 'opening') setState('waiting_login', '请在弹窗中完成登录');
    });
    authWindow.on('closed', () => {
        authWindow = null;
        if (!['ready', 'expired', 'error'].includes(loginState.state)) {
            setState('idle', publicStatus().hasCredentials ? '登录窗口已关闭，尚未验证' : '登录已取消');
        }
    });
    return publicStatus({ windowOpen: true });
}

async function clearElevenLabsSession(webContents = null) {
    rememberStatusTarget(webContents);
    if (captureTimer) clearTimeout(captureTimer);
    captureTimer = null;
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData();
    const data = elevenlabsService.loadSettings();
    delete data.web_token;
    data.use_web_token = false;
    data.web_token_enabled = false;
    data.web_token_auto_disabled = false;
    data.web_token_manual_disabled = false;
    elevenlabsService.saveSettings(data);
    lastVerificationAt = 0;
    return setState('signed_out', '已退出 ElevenLabs 网页账号', {
        lastVerifiedAt: null,
        quota: null,
    });
}

module.exports = {
    openElevenLabsAuthWindow,
    clearElevenLabsSession,
    validateStoredSession,
    publicStatus,
    rememberStatusTarget,
};
