const { app, BrowserWindow, ipcMain, dialog, powerSaveBlocker, protocol, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpegService = require('./services/ffmpeg');
const { initAutoUpdater } = require('./updater');

// Node.js API 路由器 —— 替代 Python Flask 后端
const { registerAPIHandlers } = require('./apiRouter');

let mainWindow;
let appIsReady = false;
let powerSaveId = null;
let isQuitting = false;

// local-media 用于渲染本地生成的预览图/媒体。必须在 app.ready 前声明权限，
// 否则 video/img 的 range/fetch 行为在部分 Electron 版本里会不稳定。
try {
    protocol.registerSchemesAsPrivileged([{
        scheme: 'local-media',
        privileges: {
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    }]);
} catch (e) {
    console.warn('[Protocol] local-media privilege registration skipped:', e.message);
}

// ── 自定义缓存路径（必须在 app.ready 之前设置）──
const _cacheConfigPath = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, '.videokit-cache-config.json');
function _loadCacheConfig() {
    try {
        if (fs.existsSync(_cacheConfigPath)) {
            const cfg = JSON.parse(fs.readFileSync(_cacheConfigPath, 'utf-8'));
            if (cfg.userDataPath && fs.existsSync(cfg.userDataPath)) {
                return cfg.userDataPath;
            }
        }
    } catch (e) { /* ignore */ }
    return null;
}
const _customUserData = _loadCacheConfig();
if (_customUserData) {
    app.setPath('userData', _customUserData);
}

// 日志文件路径
const logDir = (app && app.isPackaged)
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(__dirname, '..', 'logs');

// 确保日志目录存在
function ensureLogDir() {
    try {
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    } catch (e) {
        console.error('Failed to create log directory:', e);
    }
}

// 写日志到文件
function log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);

    try {
        ensureLogDir();
        const logFile = path.join(logDir, 'app.log');
        fs.appendFileSync(logFile, logMessage + '\n');
    } catch (e) {
        // 忽略日志写入错误
    }
}

// 获取资源路径
function getResourcePath(relativePath) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, relativePath);
    }
    return path.join(__dirname, '..', relativePath);
}

// 获取 FFmpeg 路径并注入到 PATH
function setupFFmpegPath() {
    // macOS: 检查打包的 FFmpeg
    if (process.platform === 'darwin') {
        const vendorFfmpeg = path.join(getResourcePath('vendor'), 'ffmpeg');
        if (fs.existsSync(vendorFfmpeg) && fs.existsSync(path.join(vendorFfmpeg, 'ffmpeg'))) {
            log(`Using vendor FFmpeg on macOS: ${vendorFfmpeg}`);
            process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
            return;
        }

        // 回退到系统安装的 FFmpeg
        const macPaths = [
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/opt/local/bin',
        ];
        const existingPath = process.env.PATH || '';
        const additionalPaths = macPaths.filter(p => !existingPath.includes(p)).join(path.delimiter);
        if (additionalPaths) {
            process.env.PATH = `${additionalPaths}${path.delimiter}${existingPath}`;
        }
    } else if (process.platform === 'win32') {
        // Packaged: extraResources maps vendor/windows/ffmpeg → vendor/ffmpeg
        // Dev: files sit at vendor/windows/ffmpeg/bin
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg', 'bin'),
            path.join(getResourcePath('vendor'), 'windows', 'ffmpeg', 'bin'),
            // 额外的 fallback：直接在 vendor/ffmpeg 下（无 bin 子目录的情况）
            path.join(getResourcePath('vendor'), 'ffmpeg'),
        ];
        log(`[FFmpeg] Windows resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg.exe');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe.exe');
                log(`[FFmpeg]   ffmpeg.exe: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe.exe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (fs.existsSync(ffmpegExe) || fs.existsSync(ffprobeExe)) {
                    log(`Using vendor FFmpeg on Windows: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path!`);
        }
    }
}

// 创建主窗口
function createWindow() {
    if (mainWindow) {
        mainWindow.focus();
        return;
    }

    if (!appIsReady) return;

    const windowOptions = {
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 700,
        title: 'VideoKit',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: false,  // 桌面应用需要加载 file:// 本地媒体预览
            preload: path.join(__dirname, 'preload.js')
        },
    };

    // macOS 专用：隐藏标题栏 + 红绿灯按钮位置
    if (process.platform === 'darwin') {
        windowOptions.titleBarStyle = 'hiddenInset';
        windowOptions.trafficLightPosition = { x: 15, y: 15 };
    }

    mainWindow = new BrowserWindow(windowOptions);

    if (!app.isPackaged) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// 应用启动
app.whenReady().then(async () => {
    appIsReady = true;
    log('=== App Ready (Node.js Backend) ===');

    protocol.handle('local-media', async (request) => {
        // 不用 standard:true → URL 不会被解析为 host/path 格式
        // local-media:///Users/ww/file.mp4 → 直接截取 scheme 后的路径
        const afterScheme = request.url.replace(/^local-media:\/\//, '');
        const filePath = decodeURIComponent(afterScheme);
        const resolved = path.resolve(filePath);

        try {
            if (!fs.existsSync(resolved)) {
                console.error('[local-media] File not found:', resolved);
                return new Response('Not Found', { status: 404 });
            }

            const fileUrl = pathToFileURL(resolved).href;
            const rangeHeader = request.headers.get('Range');
            if (rangeHeader) {
                // 手动处理 Range 请求以确保视频 seek 可靠
                const stat = fs.statSync(resolved);
                const fileSize = stat.size;
                const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
                if (m) {
                    const start = parseInt(m[1], 10);
                    const end = m[2] ? parseInt(m[2], 10) : Math.min(start + 1024 * 1024 - 1, fileSize - 1);
                    const chunkSize = end - start + 1;
                    const buf = Buffer.alloc(chunkSize);
                    const fd = fs.openSync(resolved, 'r');
                    fs.readSync(fd, buf, 0, chunkSize, start);
                    fs.closeSync(fd);

                    const ext = path.extname(resolved).toLowerCase();
                    const mimeMap = {
                        '.mp4':'video/mp4','.webm':'video/webm','.mkv':'video/x-matroska',
                        '.avi':'video/x-msvideo','.mov':'video/quicktime','.m4v':'video/mp4',
                        '.ts':'video/mp2t','.flv':'video/x-flv',
                        '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
                        '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp',
                    };
                    const contentType = mimeMap[ext] || 'application/octet-stream';

                    return new Response(buf, {
                        status: 206,
                        headers: {
                            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                            'Accept-Ranges': 'bytes',
                            'Content-Length': String(chunkSize),
                            'Content-Type': contentType,
                        }
                    });
                }
            }

            // 非 Range 请求: 用 net.fetch 委托给 file:// 协议
            return net.fetch(fileUrl);
        } catch (e) {
            console.error('[local-media] Error:', e.message, 'File:', resolved);
            return new Response('Internal Error: ' + e.message, { status: 500 });
        }
    });

    // 设置 FFmpeg 环境
    setupFFmpegPath();
    log(`FFmpeg PATH configured`);

    // ==================== IPC 处理 - 基本功能 ====================
    ipcMain.handle('get-app-version', () => {
        return app.getVersion();
    });

    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'createDirectory'],
            title: '选择输出目录'
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('select-files', async (event, options = {}) => {
        const props = ['openFile'];
        if (options.multiple !== false) props.push('multiSelections');
        const dialogOpts = {
            properties: props,
            title: options.title || '选择文件',
        };
        if (options.filters) dialogOpts.filters = options.filters;
        const result = await dialog.showOpenDialog(mainWindow, dialogOpts);
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths;
        }
        return null;
    });

    ipcMain.handle('scan-directory', async (event, dirPath) => {
        const fs = require('fs');
        const pathModule = require('path');
        try {
            if (!dirPath || !fs.existsSync(dirPath)) return [];
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const files = [];
            for (const entry of entries) {
                if (!entry.name.startsWith('.')) {
                    const fullPath = pathModule.join(dirPath, entry.name);
                    try {
                        const stat = fs.statSync(fullPath);
                        files.push({
                            name: entry.name,
                            path: fullPath,
                            size: stat.size,
                            mtime: stat.mtimeMs,
                            isDirectory: stat.isDirectory()
                        });
                    } catch { /* skip unreadable files */ }
                }
            }
            return files;
        } catch (e) {
            console.error('scan-directory error:', e);
            return [];
        }
    });

    ipcMain.handle('get-downloads-path', async () => {
        try {
            return app.getPath('downloads');
        } catch (e) {
            return null;
        }
    });

    // IPC: 批量Reels - 烧录字幕到视频
    ipcMain.handle('burn-subtitles', async (event, { videoPath, assContent, outputPath, crf }) => {
        const os = require('os');
        const { execFile } = require('child_process');
        const settingsService = require('./services/settings');
        const assPath = settingsService.secureTmpFile('reels_sub', '.ass');

        // Write ASS content to temp file
        fs.writeFileSync(assPath, assContent, 'utf-8');
        log(`[Reels] Burning subtitles: ${videoPath} → ${outputPath}`);

        return new Promise((resolve, reject) => {
            const args = [
                '-i', videoPath,
                '-vf', `ass='${assPath.replace(/'/g, "'\\''")}' `,
                '-c:a', 'copy',
                '-c:v', 'libx264',
                '-crf', String(crf || 23),
                '-preset', 'medium',
                '-y',
                outputPath
            ];
            execFile('ffmpeg', args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                // Clean up temp ASS file
                try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
                if (err) {
                    log(`[Reels] FFmpeg error: ${stderr}`);
                    reject(new Error(stderr || err.message));
                } else {
                    log(`[Reels] Export done: ${outputPath}`);
                    resolve({ success: true, outputPath });
                }
            });
        });
    });

    // IPC: 批量Reels - 合成背景+配音+字幕（直连通道，避免依赖 apiRouter 路由版本）
    ipcMain.handle('reels-compose', async (event, payload) => {
        const data = payload || {};
        if (!data.background_path) throw new Error('缺少背景素材路径');
        if (!data.voice_path) throw new Error('缺少配音音频路径');
        if (!data.ass_content) throw new Error('缺少 ASS 字幕内容');
        if (!data.output_path) throw new Error('缺少输出路径');
        const res = await ffmpegService.composeReel({
            backgroundPath: data.background_path,
            voicePath: data.voice_path,
            assContent: data.ass_content,
            outputPath: data.output_path,
            crf: parseInt(data.crf || 23, 10),
            useGPU: data.use_gpu === true,
            loopFade: data.loop_fade !== false,
            loopFadeDur: parseFloat(data.loop_fade_dur ?? 1.0),
            voiceVolume: parseFloat(data.voice_volume ?? 1.0),
            bgVolume: parseFloat(data.bg_volume ?? 0.0),
            bgmPath: data.bgm_path || '',
            bgmVolume: parseFloat(data.bgm_volume ?? 0),
        });
        return { success: true, data: res };
    });

    // IPC: WYSIWYG 逐帧渲染导出（与 Canvas 预览 100% 一致）
    const { handleWysiwygIPC, parallelExport } = require('./services/ffmpeg-rawvideo');
    ipcMain.handle('reels-compose-wysiwyg', async (event, action, data) => {
        return handleWysiwygIPC(action, data);
    });

    // IPC: 并行影子窗口导出（V3 多切片渲染）
    ipcMain.handle('parallel-wysiwyg-export', async (event, opts) => {
        return parallelExport(opts, mainWindow);
    });

    // IPC: 视频首尾拼接 (Hook -> Main)
    ipcMain.handle('concat-video', async (event, payload) => {
        return ffmpegService.concatVideo(payload);
    });

    // IPC: 保存 Web Audio 离线渲染的音频（WYSIWYG 混音）
    ipcMain.handle('save-rendered-audio', async (event, wavData) => {
        const settingsService = require('./services/settings');
        const tmpPath = settingsService.secureTmpFile('reels_rendered_audio', '.wav');
        const buffer = Buffer.from(wavData);
        fs.writeFileSync(tmpPath, buffer);
        log(`[WYSIWYG] 保存预渲染音频: ${tmpPath} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return tmpPath;
    });

    // IPC: 保存 PNG 帧（分层 PNG 序列导出用）
    ipcMain.handle('save-png-frame', async (event, { outputPath: pngPath, rawRGBA, width, height, isPng }) => {
        try {
            // 已经是 PNG 数据，直接写入
            if (isPng) {
                fs.writeFileSync(pngPath, Buffer.from(rawRGBA));
                return { ok: true };
            }

            // Raw RGBA → PNG 转换
            try {
                const { PNG } = require('pngjs');
                const png = new PNG({ width, height });
                const buf = Buffer.from(rawRGBA);
                buf.copy(png.data);
                const pngBuffer = PNG.sync.write(png);
                fs.writeFileSync(pngPath, pngBuffer);
                return { ok: true };
            } catch (e) {
                // Fallback: use FFmpeg to convert raw RGBA to PNG
                const settingsService = require('./services/settings');
                const tmpRaw = settingsService.secureTmpFile('frame_raw', '.rgba');
                fs.writeFileSync(tmpRaw, Buffer.from(rawRGBA));
                const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
                const { spawnSync } = require('child_process');
                const result = spawnSync(ffmpeg, [
                    '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba',
                    '-s', `${width}x${height}`,
                    '-i', tmpRaw,
                    '-frames:v', '1',
                    pngPath
                ], { timeout: 10000 });
                try { fs.unlinkSync(tmpRaw); } catch (_) { }
                if (result.status === 0) return { ok: true };
                return { ok: false, error: result.stderr?.toString() || 'FFmpeg failed' };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // IPC: 导出音频为 MP3（分层 PNG 序列导出用）
    ipcMain.handle('export-audio-mp3', async (event, { inputPath, outputPath: mp3Path, volume }) => {
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
        const { spawnSync } = require('child_process');
        const args = ['-y', '-i', inputPath];
        if (volume != null && volume !== 1.0) {
            args.push('-af', `volume=${volume}`);
        }
        args.push('-c:a', 'libmp3lame', '-b:a', '192k', mp3Path);
        const result = spawnSync(ffmpeg, args, { timeout: 120000 });
        if (result.status !== 0) {
            return { ok: false, error: result.stderr?.toString() || 'FFmpeg MP3 export failed' };
        }
        log(`[Layers] 音频导出: ${mp3Path}`);
        return { ok: true, path: mp3Path };
    });

    // IPC: 确保目录存在
    ipcMain.handle('ensure-directory', async (event, dirPath) => {
        try {
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // IPC: 获取媒体时长
    ipcMain.handle('get-media-duration', async (event, filePath) => {
        return ffmpegService.getDuration(filePath);
    });

    // IPC: 读取音频文件为 WAV Buffer（供渲染进程的 Web Audio decodeAudioData 使用）
    // 先用 FFmpeg 转成 WAV（支持 mp4/mp3 等任何格式）
    ipcMain.handle('read-file-buffer', async (event, filePath) => {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
        }
        const settingsService = require('./services/settings');
        const { spawnSync } = require('child_process');
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');

        // 转为 WAV 供 Web Audio 使用
        const wavPath = settingsService.secureTmpFile('voice_decode', '.wav');
        const result = spawnSync(ffmpeg, [
            '-y', '-i', filePath,
            '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            wavPath,
        ], { timeout: 30000 });

        if (result.status !== 0 || !fs.existsSync(wavPath)) {
            // 回退：直接读原文件
            log(`[read-file-buffer] FFmpeg 转 WAV 失败，直接读原文件`);
            return fs.readFileSync(filePath);
        }

        const buf = fs.readFileSync(wavPath);
        try { fs.unlinkSync(wavPath); } catch (_) { }
        log(`[read-file-buffer] ${filePath} → WAV ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
        return buf;
    });

    // IPC: 在 Finder/Explorer 中高亮文件
    ipcMain.handle('show-item-in-folder', (event, fullPath) => {
        if (fullPath && typeof fullPath === 'string') shell.showItemInFolder(fullPath);
    });

    // IPC: 用系统默认浏览器打开链接
    ipcMain.handle('open-external-url', (event, url) => {
        if (url && typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    // IPC: 扫描本地字体目录 + 系统字体
    ipcMain.handle('scan-fonts', async () => {
        try {
            const os = require('os');
            const fontExts = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.dfont']);

            function inferWeightAndStyle(fileName) {
                const base = path.parse(fileName).name.toLowerCase();
                const style = /(italic|oblique)/.test(base) ? 'italic' : 'normal';
                let weight = '400';
                let hasExplicit = false;

                const rules = [
                    [/extra[\s_-]*black|ultra[\s_-]*black/, '900'],
                    [/\bblack\b/, '900'],
                    [/extra[\s_-]*bold|ultra[\s_-]*bold|heavy/, '800'],
                    [/\bsemi[\s_-]*bold\b|\bdemi[\s_-]*bold\b/, '600'],
                    [/\bbold\b/, '700'],
                    [/\bmedium\b/, '500'],
                    [/\bbook\b|\bregular\b|\bnormal\b/, '400'],
                    [/extra[\s_-]*light|ultra[\s_-]*light/, '200'],
                    [/\blight\b/, '300'],
                    [/\bthin\b|\bhairline\b/, '100'],
                ];
                for (const [re, w] of rules) {
                    if (re.test(base)) {
                        weight = w;
                        hasExplicit = true;
                        break;
                    }
                }

                if (!hasExplicit && /variablefont/.test(base)) {
                    weight = '100 900';
                }
                return { weight, style };
            }

            function cleanFamilyNameFromFile(fileName) {
                let raw = path.parse(fileName).name;
                // Split CamelCase: "AppleSDGothicNeo" → "Apple SD Gothic Neo"
                raw = raw.replace(/([a-z])([A-Z])/g, '$1 $2')
                         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
                raw = raw.replace(/[_-]+/g, ' ');
                // Remove weight/style tokens
                const cleaned = raw
                    .replace(/\b(italic|oblique|regular|normal|book|medium|semibold|semi bold|demibold|demi bold|bold|extrabold|extra bold|ultrabold|ultra bold|black|extrablack|extra black|ultrablack|ultra black|heavy|light|extralight|extra light|ultralight|ultra light|thin|hairline|variablefont|wght|wdth|opsz)\b/gi, '')
                    // Remove macOS suffixes like "HB" (Harfbuzz variants)
                    .replace(/\bHB\b$/i, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return cleaned || raw.trim();
            }

            // ── 扫描单个目录 ──
            function scanDir(dirPath, isSystemFont = false) {
                const results = [];
                if (!dirPath || !fs.existsSync(dirPath)) return results;
                try {
                    const items = fs.readdirSync(dirPath, { withFileTypes: true });
                    for (const item of items) {
                        if (item.name.startsWith('.')) continue;
                        const fullPath = path.join(dirPath, item.name);
                        if (item.isDirectory()) {
                            const familyName = item.name.replace(/_/g, ' ');
                            try {
                                const files = fs.readdirSync(fullPath);
                                for (const fontFile of files) {
                                    const ext = path.extname(fontFile).toLowerCase();
                                    if (!fontExts.has(ext)) continue;
                                    const meta = inferWeightAndStyle(fontFile);
                                    results.push({
                                        family: familyName,
                                        path: path.join(fullPath, fontFile),
                                        weight: meta.weight,
                                        style: meta.style,
                                        system: isSystemFont,
                                    });
                                }
                            } catch { /* skip unreadable dirs */ }
                        } else if (item.isFile() && fontExts.has(path.extname(item.name).toLowerCase())) {
                            const familyName = cleanFamilyNameFromFile(item.name).replace(/_/g, ' ');
                            const meta = inferWeightAndStyle(item.name);
                            results.push({
                                family: familyName,
                                path: fullPath,
                                weight: meta.weight,
                                style: meta.style,
                                system: isSystemFont,
                            });
                        }
                    }
                } catch (err) {
                    log(`[Fonts] Error scanning ${dirPath}: ${err.message}`);
                }
                return results;
            }

            const fontList = [];

            // ── 1. 项目内置字体 (assets/fonts) ──
            const fontsDir = app.isPackaged
                ? path.join(process.resourcesPath, 'assets', 'fonts')
                : path.join(__dirname, '..', 'assets', 'fonts');
            fontList.push(...scanDir(fontsDir, false));

            // ── 2. 系统字体目录 ──
            const systemDirs = [];
            if (process.platform === 'darwin') {
                // macOS
                systemDirs.push('/Library/Fonts');
                systemDirs.push(path.join(os.homedir(), 'Library', 'Fonts'));
                // /System/Library/Fonts 包含Apple系统字体（可能受SIP保护但可读）
                systemDirs.push('/System/Library/Fonts');
                systemDirs.push('/System/Library/Fonts/Supplemental');
            } else if (process.platform === 'win32') {
                // Windows
                const winFonts = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
                systemDirs.push(winFonts);
                // 用户字体目录 (Windows 10+)
                const userFonts = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Fonts');
                systemDirs.push(userFonts);
            } else {
                // Linux
                systemDirs.push('/usr/share/fonts');
                systemDirs.push('/usr/local/share/fonts');
                systemDirs.push(path.join(os.homedir(), '.fonts'));
                systemDirs.push(path.join(os.homedir(), '.local', 'share', 'fonts'));
            }

            for (const dir of systemDirs) {
                fontList.push(...scanDir(dir, true));
            }

            // ── 去重（同 family 只保留一个条目用于注册，但保留所有 weight/style 变体）──
            log(`[Fonts] scanned ${fontList.length} font files (${systemDirs.length} system dirs + assets)`);
            return fontList;
        } catch (err) {
            log(`[Fonts] scanning error: ${err.message}`);
            return [];
        }
    });

    // ==================== IPC 处理 - 缓存管理 ====================
    ipcMain.handle('get-cache-info', async () => {
        const userDataPath = app.getPath('userData');
        const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage'];
        let totalSize = 0;
        const details = [];
        for (const dir of cacheDirs) {
            const dirPath = path.join(userDataPath, dir);
            if (fs.existsSync(dirPath)) {
                const size = getDirSize(dirPath);
                totalSize += size;
                details.push({ name: dir, size });
            }
        }
        return { path: userDataPath, totalSize, details };
    });

    ipcMain.handle('clear-cache', async () => {
        const userDataPath = app.getPath('userData');
        const cacheDirs = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage'];
        let freedSize = 0;
        for (const dir of cacheDirs) {
            const dirPath = path.join(userDataPath, dir);
            if (fs.existsSync(dirPath)) {
                try {
                    freedSize += getDirSize(dirPath);
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    log(`[Cache] Cleared: ${dirPath}`);
                } catch (e) {
                    log(`[Cache] Failed to clear ${dirPath}: ${e.message}`);
                }
            }
        }
        return { ok: true, freedSize };
    });

    ipcMain.handle('open-cache-folder', () => {
        const userDataPath = app.getPath('userData');
        shell.openPath(userDataPath);
    });

    ipcMain.handle('set-cache-path', async (event, newPath) => {
        if (!newPath) {
            // 清除自定义路径，恢复默认
            try { fs.unlinkSync(_cacheConfigPath); } catch (_) {}
            return { ok: true, needRestart: true };
        }
        // 确保目录存在
        if (!fs.existsSync(newPath)) {
            try { fs.mkdirSync(newPath, { recursive: true }); } catch (e) {
                return { ok: false, error: '无法创建目录: ' + e.message };
            }
        }
        // 保存配置
        try {
            fs.writeFileSync(_cacheConfigPath, JSON.stringify({ userDataPath: newPath }, null, 2), 'utf-8');
            log(`[Cache] 缓存路径已更改为: ${newPath}，重启后生效`);
            return { ok: true, needRestart: true };
        } catch (e) {
            return { ok: false, error: '保存配置失败: ' + e.message };
        }
    });

    function getDirSize(dirPath) {
        let size = 0;
        try {
            const items = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dirPath, item.name);
                try {
                    if (item.isDirectory()) {
                        size += getDirSize(fullPath);
                    } else {
                        size += fs.statSync(fullPath).size;
                    }
                } catch { /* skip */ }
            }
        } catch { /* skip */ }
        return size;
    }

    // 注册 API 路由（替代 Python Flask 后端）
    registerAPIHandlers();
    log('API handlers registered - no Python backend needed');

    // 防止 macOS App Nap
    if (process.platform === 'darwin') {
        powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
        log(`PowerSaveBlocker started: ${powerSaveId}`);
    }

    // 直接创建窗口（不需要等待后端启动了！）
    createWindow();

    // 自动更新：仅在打包版启用（开发模式跳过）
    if (app.isPackaged && mainWindow) {
        initAutoUpdater(mainWindow, log);
    } else {
        log('[Updater] 开发模式，跳过自动更新初始化');
        // 开发模式下注册 fallback handler，避免前端报错
        ipcMain.handle('get-update-channel', () => ({
            channel: 'stable', currentVersion: app.getVersion(), isBeta: false,
        }));
        ipcMain.handle('set-update-channel', () => ({ success: true, channel: 'stable' }));
    }
});

app.on('window-all-closed', () => {
    isQuitting = true;
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (appIsReady && BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
});
