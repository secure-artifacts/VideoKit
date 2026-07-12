const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

function resolveAssetUrl(fileName) {
    if (!fileName) return '';

    const candidates = [];
    if (typeof process.resourcesPath === 'string' && process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'assets', fileName));
    }
    candidates.push(path.join(__dirname, '..', 'assets', fileName));
    candidates.push(path.join(__dirname, '..', 'dist', 'assets', fileName));

    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                return toFileUrl(p);
            }
        } catch { }
    }
    return '';
}

function toFileUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^local-media:\/\//i.test(filePath)) return filePath;

    let cleanPath = filePath;
    if (/^file:\/\//i.test(cleanPath)) {
        try {
            cleanPath = decodeURIComponent(cleanPath.replace(/^file:\/\//i, ''));
        } catch {
            cleanPath = cleanPath.replace(/^file:\/\//i, '');
        }
    }
    // Normalize backslashes to forward slashes for Windows compatibility
    cleanPath = cleanPath.replace(/\\/g, '/');

    if (process.platform === 'win32') {
        // If it starts with "/" and a drive letter like "/C:", keep the slash so it becomes local-media:///C:...
        // If it starts with "C:", prepend "/" so it also becomes local-media:///C:...
        if (!cleanPath.startsWith('/') && /^[a-zA-Z]:/.test(cleanPath)) {
            cleanPath = '/' + cleanPath;
        }
    } else {
        // On macOS/Linux, ensure it starts with "/"
        if (!cleanPath.startsWith('/')) {
            cleanPath = '/' + cleanPath;
        }
    }
    return `local-media://${cleanPath}`;
}

function fileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    let p = filePath.trim();
    if (!p || /^blob:|^data:|^https?:/i.test(p)) return true;
    if (/^local-media:\/\//i.test(p)) {
        try {
            p = decodeURIComponent(p.replace(/^local-media:\/\//i, ''));
        } catch {
            p = p.replace(/^local-media:\/\//i, '');
        }
        if (process.platform === 'win32' && p.startsWith('/') && p.includes(':')) {
            p = p.substring(1);
        }
    } else if (/^file:\/\//i.test(p)) {
        try {
            p = decodeURIComponent(p.replace(/^file:\/\//i, ''));
        } catch {
            p = p.replace(/^file:\/\//i, '');
        }
        if (process.platform === 'win32' && p.startsWith('/') && p.includes(':')) {
            p = p.substring(1);
        }
    }
    try {
        const resolved = path.resolve(p);
        return fs.existsSync(resolved);
    } catch {
        return false;
    }
}

// 暴露 API 给渲染进程
const _autoSaveDir = path.join(require('os').homedir(), '.videokit');
const _autoSavePath = path.join(_autoSaveDir, 'autosave.json');
try { if (!fs.existsSync(_autoSaveDir)) fs.mkdirSync(_autoSaveDir, { recursive: true }); } catch (_) {}

contextBridge.exposeInMainWorld('electronAPI', {
    // 平台信息
    platform: process.platform,
    autoSavePath: _autoSavePath,
    resolveAssetUrl,
    toFileUrl,
    fileExists,
    // 获取 File 对象的本地完整路径（contextIsolation 下 File.path 不可用）
    getFilePath: (file) => {
        try {
            const p = webUtils.getPathForFile(file);
            console.log('[preload.getFilePath] success:', p);
            return p;
        } catch (e) {
            console.error('[preload.getFilePath] FAILED:', e.message, 'file:', typeof file, file?.name);
            return '';
        }
    },
    isDirectory: (filePath) => {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
        } catch {
            return false;
        }
    },
    fsExists: (p) => {
        try { return fs.existsSync(p); } catch { return false; }
    },
    fsStat: (p) => {
        try {
            const s = fs.statSync(p);
            return {
                size: s.size,
                mtimeMs: s.mtimeMs,
                isDirectory: s.isDirectory(),
                isFile: s.isFile()
            };
        } catch {
            return null;
        }
    },
    fsReaddir: (p) => {
        try {
            return fs.readdirSync(p, { withFileTypes: true }).map(e => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile()
            }));
        } catch {
            return [];
        }
    },
    pathJoin: (...args) => path.join(...args),
    pathBasename: (p) => path.basename(p),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // 选择目录
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectDirectories: () => ipcRenderer.invoke('select-directories'),
    selectFiles: (options) => ipcRenderer.invoke('select-files', options),
    saveFile: (options) => ipcRenderer.invoke('save-file', options),

    scanDirectory: (dirPath) => ipcRenderer.invoke('scan-directory', dirPath),
    searchFilesRecursive: (searchDir, fileNames, maxDepth) => ipcRenderer.invoke('search-files-recursive', searchDir, fileNames, maxDepth),
    checkFilesExist: (filePaths) => ipcRenderer.invoke('check-files-exist', filePaths),
    getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),

    // 批量Reels - 烧录字幕
    burnSubtitles: (opts) => ipcRenderer.invoke('burn-subtitles', opts),
    reelsCompose: (opts) => ipcRenderer.invoke('reels-compose', opts),
    concatVideo: (opts) => ipcRenderer.invoke('concat-video', opts),
    reelsComposeWysiwyg: (action, data) => ipcRenderer.invoke('reels-compose-wysiwyg', action, data),
    getMediaDuration: (filePath) => {
        if (!filePath || typeof filePath !== 'string') return 0;
        let cleanPath = filePath;
        if (cleanPath.startsWith('local-media://')) {
            cleanPath = cleanPath.replace(/^local-media:\/\//i, '');
        }
        if (process.platform === 'win32' && cleanPath.startsWith('/') && cleanPath.includes(':')) {
            cleanPath = cleanPath.substring(1);
        }
        return ipcRenderer.invoke('get-media-duration', cleanPath);
    },
    saveRenderedAudio: (wavData) => ipcRenderer.invoke('save-rendered-audio', wavData),
    readFileBuffer: (filePath) => ipcRenderer.invoke('read-file-buffer', filePath),
    // 分层 PNG 序列导出
    savePngFrame: (opts) => ipcRenderer.invoke('save-png-frame', opts),
    exportAudioMp3: (opts) => ipcRenderer.invoke('export-audio-mp3', opts),
    ensureDirectory: (dirPath) => ipcRenderer.invoke('ensure-directory', dirPath),

    // V3 并行影子窗口导出
    parallelWysiwygExport: (opts) => ipcRenderer.invoke('parallel-wysiwyg-export', opts),
    onParallelProgress: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('parallel-export-progress', handler);
        return () => ipcRenderer.removeListener('parallel-export-progress', handler);
    },

    // 自动更新
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getUpdateChannel: () => ipcRenderer.invoke('get-update-channel'),
    setUpdateChannel: (channel) => ipcRenderer.invoke('set-update-channel', channel),
    onUpdateStatus: (callback) => {
        const handler = (_, data) => callback(data);
        ipcRenderer.on('update-status', handler);
        return () => ipcRenderer.removeListener('update-status', handler);
    },

    // 扫描本地字体
    scanFonts: () => ipcRenderer.invoke('scan-fonts'),
    fetchGoogleFonts: () => ipcRenderer.invoke('fetch-google-fonts'),

    // 读取文件内容
    readFileText: (filePath) => {
        try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
    },

    // 写入文件内容 (用于保存工程)
    writeFileText: (filePath, content) => {
        try { fs.writeFileSync(filePath, content, 'utf-8'); return true; } catch (e) { console.error('Write File Error:', e); return false; }
    },

    // ==================== 统一 API 调用接口 ====================
    // 替代 fetch(`${API_BASE}/endpoint`, ...) 的调用方式
    // 用法: const result = await window.electronAPI.apiCall('elevenlabs/voices', { key_index: 0 })
    apiCall: (endpoint, data) => ipcRenderer.invoke('api-call', endpoint, data),

    // 文件上传专用接口
    // 用法: const result = await window.electronAPI.apiUpload('upload', fileArrayBuffer, fileName, { extra: 'data' })
    apiUpload: (endpoint, fileBuffer, fileName, formData) =>
        ipcRenderer.invoke('api-upload', endpoint, fileBuffer, fileName, formData),

    // Wav2Lip 进度事件监听
    onWav2LipProgress: (callback) => {
        ipcRenderer.on('wav2lip-progress', (event, data) => callback(data));
    },

    // 批量下载进度事件监听
    onBatchDownloadProgress: (callback) => {
        ipcRenderer.on('batch-download-progress', (event, data) => callback(data));
    },

    // 链接截图进度事件监听
    onUrlThumbnailProgress: (callback) => {
        ipcRenderer.on('url-thumbnail-progress', (event, data) => callback(event, data));
    },

    onAutoEditProgress: (callback) => {
        const handler = (event, data) => callback(data);
        ipcRenderer.on('auto-edit-progress', handler);
        return () => ipcRenderer.removeListener('auto-edit-progress', handler);
    },

    onSubtitleProgress: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('subtitle-progress', handler);
        return () => ipcRenderer.removeListener('subtitle-progress', handler);
    },

    // 在 Finder/Explorer 中高亮显示文件
    showItemInFolder: (filePath) => {
        ipcRenderer.invoke('show-item-in-folder', filePath).catch(() => {});
    },

    // 用系统默认浏览器打开链接
    openExternal: (url) => {
        ipcRenderer.invoke('open-external-url', url).catch(() => {});
    },

    // 缓存管理
    getCacheInfo: () => ipcRenderer.invoke('get-cache-info'),
    clearCache: () => ipcRenderer.invoke('clear-cache'),
    openCacheFolder: () => ipcRenderer.invoke('open-cache-folder'),
    setCachePath: (newPath) => ipcRenderer.invoke('set-cache-path', newPath),

    // 界面缩放（使用 Electron 原生 webFrame，正确处理布局视口）
    setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
    getZoomFactor: () => webFrame.getZoomFactor(),


    // 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色）
    screenPickColor: () => ipcRenderer.invoke('screen-pick-color'),

    // 模板多窗口
    openTemplateWindow: (templateId, templateName) => ipcRenderer.invoke('open-template-window', templateId, templateName),
});
