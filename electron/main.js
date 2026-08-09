const { app, BrowserWindow, ipcMain, MessageChannelMain, dialog, powerSaveBlocker, protocol, shell, net, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const ffmpegService = require('./services/ffmpeg');
const { initAutoUpdater } = require('./updater');

// Node.js API 路由器 —— 替代 Python Flask 后端
const { registerAPIHandlers } = require('./apiRouter');

let mainWindow;
let appIsReady = false;
let powerSaveId = null;
let isQuitting = false;
const templateWindows = new Map(); // templateId → BrowserWindow

function _savedBatchTaskCount(raw) {
    if (!raw) return 0;
    try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.tabs)) {
            return data.tabs.reduce((sum, tab) => sum + (Array.isArray(tab?.tasks) ? tab.tasks.length : 0), 0);
        }
        return Array.isArray(data.tasks) ? data.tasks.length : 0;
    } catch {
        return 0;
    }
}

/**
 * 开发版由旧 file:// 页面切到 http://localhost:5173 后，Chromium 会使用另一套
 * localStorage origin。仅在 localhost 没有有效任务时，把旧 file:// 数据复制过来；
 * 当前开发数据始终优先，避免覆盖用户刚做的新工程。
 */
async function migrateLegacyFileStorageToDevOrigin(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;

    let legacyWindow = null;
    try {
        const currentStore = await targetWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        if (currentStore?.videokit_disable_file_origin_migration) {
            log('[StorageMigration] 已有可靠恢复标记，跳过旧 file:// 自动迁移');
            return false;
        }
        const currentBatchCount = _savedBatchTaskCount(currentStore?.reels_batch_config_autosave);

        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
            },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyStore = await legacyWindow.webContents.executeJavaScript(
            'Object.fromEntries(Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return [k,localStorage.getItem(k)]}))',
            true
        );
        const legacyBatchCount = _savedBatchTaskCount(legacyStore?.reels_batch_config_autosave);
        const merged = { ...(currentStore || {}) };
        let copied = 0;
        let restoredLegacyBatch = false;

        for (const [key, value] of Object.entries(legacyStore || {})) {
            if (merged[key] == null) {
                merged[key] = value;
                copied++;
            }
        }
        // 旧 file:// 工程明显更完整时，先备份 localhost 当前工程，再恢复旧工程。
        // 这样既能找回历史内容，也不会丢掉切换来源后新建的少量任务。
        if (legacyBatchCount > currentBatchCount) {
            if (currentStore?.reels_batch_config_autosave) {
                merged.reels_batch_config_autosave_before_file_migration = currentStore.reels_batch_config_autosave;
            }
            merged.reels_batch_config_autosave = legacyStore.reels_batch_config_autosave;
            merged.reels_batch_file_origin_migrated_at = new Date().toISOString();
            copied++;
            restoredLegacyBatch = true;
        }
        if (!copied) return false;

        const serialized = JSON.stringify(merged);
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const data=${serialized};for(const [k,v] of Object.entries(data)){localStorage.setItem(k,v)};return true})()`,
            true
        );
        const finalBatchCount = restoredLegacyBatch ? legacyBatchCount : currentBatchCount;
        log(`[StorageMigration] 已从 file:// 迁移 ${copied} 个本地存储项；批量任务 ${currentBatchCount} -> ${finalBatchCount}`);

        // 批量表格恢复函数在首次 DOMContentLoaded 时已经运行过，迁移后刷新一次，
        // 让所有模块按正常初始化顺序读取迁移后的数据。
        if (restoredLegacyBatch && !targetWindow.isDestroyed()) {
            targetWindow.webContents.reloadIgnoringCache();
        }
        return true;
    } catch (error) {
        log(`[StorageMigration] 旧版数据迁移失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

/** 只读导出旧 file:// 批量配置，用于核对跨 origin 丢失的任务样式。 */
async function snapshotLegacyBatchForStyleAudit(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-audit-request.json');
    if (!fs.existsSync(requestPath)) return false;
    let legacyWindow = null;
    try {
        legacyWindow = new BrowserWindow({
            show: false,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        await legacyWindow.loadFile(path.join(__dirname, '../src/storage-bridge.html'));
        const legacyRaw = await legacyWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!legacyRaw) throw new Error('旧 file:// 批量配置不存在');
        const auditDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(auditDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(auditDir, `legacy-style-audit-${stamp}.json`);
        fs.writeFileSync(outputPath, legacyRaw, 'utf-8');
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-audit-completed.json'));
        log(`[StyleAudit] 已只读导出旧批量配置 ${_savedBatchTaskCount(legacyRaw)} 条: ${outputPath}`);
        return true;
    } catch (error) {
        log(`[StyleAudit] 导出失败: ${error.message}`);
        return false;
    } finally {
        if (legacyWindow && !legacyWindow.isDestroyed()) legacyWindow.destroy();
    }
}

function _naturalTemplateNameSort(a, b) {
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
        numeric: true,
        sensitivity: 'base',
    });
}

/**
 * 从用户明确保存过的分队列模板重建批量任务。模板带创建时间和完整 projectData，
 * 比跨 origin 的“最后一份 localStorage”更适合作为指定日期的恢复来源。
 */
async function recoverPendingBatchFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;

    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const indexPath = path.join(templatesDir, 'index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到符合恢复条件的队列模板');

        const tasks = [];
        const seenTaskIds = new Set();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const templateTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            for (const sourceTask of templateTasks) {
                const task = JSON.parse(JSON.stringify(sourceTask));
                const mediaPath = task.audioPath || task.videoPath || task.bgPath || task.srtPath || '';
                const sourceFolder = mediaPath ? path.dirname(mediaPath) : '';
                const queueNameMatch = String(item.name || '').match(/_([0-9]+)$/);
                const queueName = queueNameMatch ? queueNameMatch[1] : (sourceFolder ? path.basename(sourceFolder) : item.name);
                task._sourceFolder = task._sourceFolder || sourceFolder;
                // 恢复时以“已保存的模板”作为队列边界。不能沿用模板内旧的
                // folderQueueId：多个后续任务队列可能循环使用同一批素材，路径一样
                // 但仍是独立队列。沿用旧 ID 会让启动去重把 18×6 误压成 6 条。
                task._folderQueueId = `template:${item.id}`;
                task._folderQueueName = queueName;
                if (task.id && seenTaskIds.has(task.id)) continue;
                if (task.id) seenTaskIds.add(task.id);
                tasks.push(task);
            }
        }
        if (!tasks.length) throw new Error('匹配模板中没有任务数据');

        const now = new Date().toISOString();
        const recoveryConfig = {
            timestamp: now,
            version: '2.0',
            activeTabId: 'tab_recovered_0806',
            nextTabId: 2,
            projectDir: '',
            projectName: 'Recovered_0806_Project.json',
            recoverySource: {
                label: request.label || '队列模板恢复',
                templateIds: selected.map(item => item.id),
                templateCreatedAt: selected.map(item => item.createdAt),
            },
            tabs: [{
                id: 'tab_recovered_0806',
                name: '批量导入任务',
                materialDir: '',
                folderQueueId: '',
                externalFolderQueuesCombined: true,
                lastRefreshTime: now,
                tasks,
            }],
        };

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""',
            true
        );
        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = now.replace(/[:.]/g, '-');
        if (currentRaw) fs.writeFileSync(path.join(recoveryDir, `before-${stamp}.json`), currentRaw, 'utf-8');
        fs.writeFileSync(path.join(recoveryDir, `recovered-${stamp}.json`), JSON.stringify(recoveryConfig, null, 2), 'utf-8');

        const configJson = JSON.stringify(recoveryConfig);
        const backupKey = `reels_batch_config_backup_${Date.now()}`;
        await targetWindow.webContents.executeJavaScript(
            `(()=>{const old=localStorage.getItem('reels_batch_config_autosave');` +
            `if(old)localStorage.setItem(${JSON.stringify(backupKey)},old);` +
            // 紧接着的 reload 会触发旧页面 beforeunload。必须先禁止旧页面
            // 把内存中的旧 6 条任务又覆盖到刚写好的 108 条恢复配置上。
            `window._skipBatchSaveBeforeUnload=true;` +
            `localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(configJson)});return true})()`,
            true
        );

        const completedPath = path.join(__dirname, '..', '.videokit-recovery-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[TemplateRecovery] 已从 ${selected.length} 个模板恢复 ${tasks.length} 条任务：${request.label || ''}`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[TemplateRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

/** 从指定队列模板只恢复字幕样式，不改动当前任务的素材、字幕和对齐结果。 */
async function recoverPendingStylesFromTemplates(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-style-recovery-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const selected = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort);
        if (!selected.length) throw new Error('没有找到指定的队列模板');

        const queueSources = new Map();
        for (const item of selected) {
            const full = JSON.parse(fs.readFileSync(path.join(templatesDir, `${item.id}.json`), 'utf-8'));
            const queueMatch = String(item.name || '').match(/^0806_([0-9]+)/);
            if (!queueMatch) continue;
            const sourceTasks = Array.isArray(full?.projectData?.tasks) ? full.projectData.tasks : [];
            const byId = new Map(sourceTasks.filter(t => t.id).map(t => [String(t.id), t]));
            const byAudio = new Map(sourceTasks.filter(t => t.audioPath).map(t => [String(t.audioPath), t]));
            const byName = new Map(sourceTasks.filter(t => t.baseName).map(t => [String(t.baseName).toLowerCase(), t]));
            queueSources.set(queueMatch[1], { sourceTasks, byId, byAudio, byName });
        }

        const currentRaw = await targetWindow.webContents.executeJavaScript(
            'localStorage.getItem("reels_batch_config_autosave") || ""', true
        );
        if (!currentRaw) throw new Error('当前批量配置不存在');
        const config = JSON.parse(currentRaw);
        let restored = 0;
        for (const tab of (config.tabs || [])) {
            for (const task of (tab.tasks || [])) {
                const queueName = String(task._folderQueueName || '').trim();
                const source = queueSources.get(queueName);
                if (!source) continue;
                const matched = (task.id && source.byId.get(String(task.id)))
                    || (task.audioPath && source.byAudio.get(String(task.audioPath)))
                    || (task.baseName && source.byName.get(String(task.baseName).toLowerCase()));
                if (!matched) continue;
                // 旧模板的 task.style 是当时真正渲染的队列样式；
                // subtitleStyle 在部分队列只有单条旧副本，不能用它覆盖整队。
                const style = matched.style || matched.subtitleStyle;
                if (!style || typeof style !== 'object' || !Object.keys(style).length) continue;
                task.style = JSON.parse(JSON.stringify(style));
                task.subtitleStyle = JSON.parse(JSON.stringify(style));
                if (matched._subtitlePreset) task._subtitlePreset = matched._subtitlePreset;
                else delete task._subtitlePreset;
                restored++;
            }
        }
        if (!restored) throw new Error('当前任务与队列模板没有匹配上');

        const recoveryDir = path.join(app.getPath('userData'), 'batch-recovery');
        fs.mkdirSync(recoveryDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(recoveryDir, `before-style-recovery-${stamp}.json`), currentRaw, 'utf-8');
        config.timestamp = new Date().toISOString();
        config.styleRecovery = { restored, label: request.label || '', at: config.timestamp };
        const nextRaw = JSON.stringify(config);
        fs.writeFileSync(path.join(recoveryDir, `after-style-recovery-${stamp}.json`), JSON.stringify(config, null, 2), 'utf-8');
        await targetWindow.webContents.executeJavaScript(
            `(()=>{window._skipBatchSaveBeforeUnload=true;localStorage.setItem('reels_batch_config_autosave',${JSON.stringify(nextRaw)});return true})()`,
            true
        );
        fs.renameSync(requestPath, path.join(__dirname, '..', '.videokit-style-recovery-completed.json'));
        log(`[StyleRecovery] 已从 ${selected.length} 个队列模板恢复 ${restored} 条任务的字幕样式`);
        if (!targetWindow.isDestroyed()) targetWindow.webContents.reloadIgnoringCache();
        return true;
    } catch (error) {
        log(`[StyleRecovery] 恢复失败: ${error.message}`);
        return false;
    }
}

async function repairPendingTemplateThumbnails(targetWindow) {
    if (app.isPackaged || !targetWindow || targetWindow.isDestroyed()) return false;
    const requestPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-request.json');
    if (!fs.existsSync(requestPath)) return false;
    try {
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf-8'));
        const matcher = new RegExp(request.templateNamePattern || '.*');
        const templatesDir = path.join(app.getPath('userData'), 'videokit-templates');
        const index = JSON.parse(fs.readFileSync(path.join(templatesDir, 'index.json'), 'utf-8'));
        const ids = index
            .filter(item => matcher.test(String(item.name || '')))
            .filter(item => !request.createdDate || String(item.createdAt || '').startsWith(request.createdDate))
            .sort(_naturalTemplateNameSort)
            .map(item => item.id);
        if (!ids.length) throw new Error('没有找到需要修复封面的模板');

        const expression = `(async()=>{` +
            `localStorage.setItem('videokit_disable_file_origin_migration',${JSON.stringify(request.label || 'template-recovery')});` +
            `if(typeof window._repairTemplateThumbnailsByIds!=='function')throw new Error('封面修复函数未加载');` +
            `return await window._repairTemplateThumbnailsByIds(${JSON.stringify(ids)},{silent:true})` +
            `})()`;
        const result = await targetWindow.webContents.executeJavaScript(expression, true);
        const completedPath = path.join(__dirname, '..', '.videokit-thumbnail-repair-completed.json');
        fs.renameSync(requestPath, completedPath);
        log(`[ThumbnailRepair] ${request.label || ''}：成功 ${result?.repaired || 0}，失败 ${result?.failed || 0}`);
        return true;
    } catch (error) {
        log(`[ThumbnailRepair] 修复失败: ${error.message}`);
        return false;
    }
}

async function logBatchStartupState(targetWindow, label = 'startup') {
    if (!targetWindow || targetWindow.isDestroyed()) return;
    try {
        const state = await targetWindow.webContents.executeJavaScript(
            `(()=>{let saved=null;try{saved=JSON.parse(localStorage.getItem('reels_batch_config_autosave')||'null')}catch(_){}` +
            `return {memoryTasks:window._reelsState?.tasks?.length||0,` +
            `tabs:(window._batchTableState?.tabs||[]).map(t=>({name:t.name,count:t.tasks?.length||0})),` +
            `savedTabs:(saved?.tabs||[]).map(t=>({name:t.name,count:t.tasks?.length||0})),` +
            `savedTotal:(saved?.tabs||[]).reduce((n,t)=>n+(t.tasks?.length||0),0)}})()`,
            true
        );
        log(`[BatchStartup:${label}] ${JSON.stringify(state)}`);
    } catch (error) {
        log(`[BatchStartup:${label}] 读取失败: ${error.message}`);
    }
}

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
        const candidates = [
            path.join(getResourcePath('vendor'), 'ffmpeg'),
            path.join(getResourcePath('vendor'), 'darwin', 'ffmpeg'),
        ];
        log(`[FFmpeg] macOS resource path: ${getResourcePath('vendor')}`);
        let found = false;
        for (const vendorFfmpeg of candidates) {
            log(`[FFmpeg] Checking candidate: ${vendorFfmpeg} exists=${fs.existsSync(vendorFfmpeg)}`);
            if (fs.existsSync(vendorFfmpeg)) {
                const ffmpegExe = path.join(vendorFfmpeg, 'ffmpeg');
                const ffprobeExe = path.join(vendorFfmpeg, 'ffprobe');
                log(`[FFmpeg]   ffmpeg: ${ffmpegExe} exists=${fs.existsSync(ffmpegExe)}`);
                log(`[FFmpeg]   ffprobe: ${ffprobeExe} exists=${fs.existsSync(ffprobeExe)}`);
                if (fs.existsSync(ffmpegExe) || fs.existsSync(ffprobeExe)) {
                    log(`Using vendor FFmpeg on macOS: ${vendorFfmpeg}`);
                    process.env.PATH = `${vendorFfmpeg}${path.delimiter}${process.env.PATH || ''}`;
                    if (fs.existsSync(ffmpegExe)) process.env.FFMPEG_PATH = ffmpegExe;
                    if (fs.existsSync(ffprobeExe)) process.env.FFPROBE_PATH = ffprobeExe;
                    found = true;
                    break;
                }
            }
        }
        if (!found) {
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
            log(`[FFmpeg] WARNING: ffmpeg/ffprobe not found in any candidate path! Fallback to system PATH: ${process.env.PATH}`);
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
            // Reels preview is canvas-driven. Keep its media decoders and
            // animation clock alive when the user briefly switches apps.
            backgroundThrottling: false,
            webSecurity: true,  // Re-enabled for security; local media loads via local-media:// protocol
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
        mainWindow.webContents.once('did-finish-load', async () => {
            const recovered = await recoverPendingBatchFromTemplates(mainWindow);
            const stylesRecovered = recovered ? false : await recoverPendingStylesFromTemplates(mainWindow);
            const repaired = (recovered || stylesRecovered) ? false : await repairPendingTemplateThumbnails(mainWindow);
            const audited = (!recovered && !stylesRecovered && !repaired) ? await snapshotLegacyBatchForStyleAudit(mainWindow) : false;
            if (!recovered && !stylesRecovered && !repaired && !audited) await migrateLegacyFileStorageToDevOrigin(mainWindow);
            setTimeout(() => logBatchStartupState(mainWindow), 2500);
            setTimeout(() => logBatchStartupState(mainWindow, 'settled'), 12000);
        });

        // ── 开发者热启动与热重载机制 (Hot Reload / Relaunch) ──
        if (!global._isWatching) {
            global._isWatching = true;
            const fs = require('fs');

            // 监听主进程目录 (electron/) 变化 ➔ 自动重启 Electron 应用
            let relaunchTimeout;
            const electronDir = path.join(__dirname);
            fs.watch(electronDir, { recursive: true }, (eventType, filename) => {
                if (filename && (filename.endsWith('.js') || filename.endsWith('.json') || filename.endsWith('.html'))) {
                    clearTimeout(relaunchTimeout);
                    relaunchTimeout = setTimeout(() => {
                        log(`[HotReload] 主进程文件改变: ${filename}，正在重启 Electron...`);
                        app.relaunch();
                        app.exit(0);
                    }, 300);
                }
            });

            // 监听渲染进程目录 (src/) 变化 ➔ 自动重载/刷新浏览器窗口
            let reloadTimeout;
            const srcDir = path.join(__dirname, '..', 'src');
            if (fs.existsSync(srcDir)) {
                fs.watch(srcDir, { recursive: true }, (eventType, filename) => {
                    if (filename && (filename.endsWith('.js') || filename.endsWith('.css') || filename.endsWith('.html'))) {
                        clearTimeout(reloadTimeout);
                        reloadTimeout = setTimeout(() => {
                            log(`[HotReload] 渲染进程文件改变: ${filename}，正在刷新页面...`);
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.reloadIgnoringCache();
                            }
                        }, 300);
                    }
                });
            }
        }
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
        const cleanPath = afterScheme.split('?')[0].split('#')[0];
        let filePath = decodeURIComponent(cleanPath);
        // On Windows, if filePath starts with "/" followed by a drive letter (e.g. "/C:"), remove the leading "/"
        if (process.platform === 'win32' && filePath.startsWith('/') && filePath.includes(':')) {
            filePath = filePath.substring(1);
        }
        const resolved = path.resolve(filePath);

        try {
            // SBP-004: Validate file extension for security
            const allowedExtensions = [
                // Video
                '.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.3gp',
                // Audio
                '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif', '.amr',
                // Image
                '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
                // Subtitles/Data
                '.json', '.txt', '.srt', '.vtt', '.fcpxml', '.xml', '.drt', '.zip',
                // Fonts
                '.ttf', '.otf', '.woff', '.woff2'
            ];
            const ext = path.extname(resolved).toLowerCase();
            if (!allowedExtensions.includes(ext)) {
                console.error('[local-media] Access blocked for invalid extension:', ext, 'path:', resolved);
                return new Response('Access Denied', { status: 403 });
            }

            if (!fs.existsSync(resolved)) {
                console.error('[local-media] File not found:', resolved);
                return new Response('Not Found', { status: 404 });
            }

            const stat = fs.statSync(resolved);
            const size = stat.size;
            const mimeTypes = {
                '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
                '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.flv': 'video/x-flv', '.3gp': 'video/3gpp',
                '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
                '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
                '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.amr': 'audio/amr',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
                '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
                '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.xml': 'application/xml',
                '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
            };
            const baseHeaders = {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
                'Access-Control-Allow-Headers': '*',
                'Cache-Control': 'no-cache',
            };

            if (request.method === 'OPTIONS') {
                return new Response(null, { status: 204, headers: baseHeaders });
            }

            const rangeHeader = request.headers.get('range');
            let start = 0;
            let end = Math.max(0, size - 1);
            let status = 200;
            if (rangeHeader) {
                const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
                if (!match) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                if (match[1] === '' && match[2] !== '') {
                    const suffixLength = Math.min(size, parseInt(match[2], 10));
                    start = Math.max(0, size - suffixLength);
                } else {
                    start = parseInt(match[1] || '0', 10);
                    if (match[2] !== '') end = Math.min(end, parseInt(match[2], 10));
                }
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
                    return new Response(null, {
                        status: 416,
                        headers: { ...baseHeaders, 'Content-Range': `bytes */${size}` },
                    });
                }
                status = 206;
            }

            const contentLength = Math.max(0, end - start + 1);
            const headers = {
                ...baseHeaders,
                'Content-Length': String(contentLength),
            };
            if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            if (request.method === 'HEAD') return new Response(null, { status, headers });

            const nodeStream = fs.createReadStream(resolved, { start, end });
            return new Response(Readable.toWeb(nodeStream), { status, headers });
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

    // 批量 Reels 长队列会累积 Chromium Canvas/视频解码器内存。
    // 渲染端已先持久化续传断点；这里强制结束旧渲染进程，
    // render-process-gone 后重载同一窗口，新页面再从断点自动继续。
    ipcMain.on('recycle-renderer', (event) => {
        const webContents = event.sender;
        if (!webContents || webContents.isDestroyed()) return;
        let reloadStarted = false;
        const reloadAfterExit = () => {
            if (reloadStarted || webContents.isDestroyed()) return;
            reloadStarted = true;
            setTimeout(() => {
                if (!webContents.isDestroyed()) webContents.reloadIgnoringCache();
            }, 120);
        };
        webContents.once('render-process-gone', reloadAfterExit);
        setTimeout(() => {
            if (webContents.isDestroyed()) return;
            try {
                webContents.forcefullyCrashRenderer();
            } catch (error) {
                log(`[Reels] 重建渲染进程失败，降级为普通重载: ${error.message}`);
                reloadAfterExit();
            }
        }, 80);
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

    ipcMain.handle('select-directories', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory', 'multiSelections'],
            title: '选择多个视频文件夹（每个文件夹创建一个任务）'
        });
        return !result.canceled ? result.filePaths : [];
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

    // IPC: 递归搜索指定文件名（查找素材功能）
    ipcMain.handle('search-files-recursive', async (event, searchDir, fileNames, maxDepth = 5) => {
        const result = new Map();
        const targetSet = new Set(fileNames.map(n => n.toLowerCase()));

        function walk(dir, depth) {
            if (depth > maxDepth) return;
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue;
                const fullPath = path.join(dir, entry.name);
                if (entry.isFile()) {
                    const lower = entry.name.toLowerCase();
                    if (targetSet.has(lower) && !result.has(lower)) {
                        result.set(lower, fullPath);
                        if (result.size >= targetSet.size) return;
                    }
                } else if (entry.isDirectory()) {
                    walk(fullPath, depth + 1);
                    if (result.size >= targetSet.size) return;
                }
            }
        }

        walk(searchDir, 0);
        const obj = {};
        for (const [k, v] of result) obj[k] = v;
        return obj;
    });

    // IPC: 批量检查文件是否存在
    ipcMain.handle('check-files-exist', async (event, filePaths) => {
        const results = {};
        for (const p of filePaths) {
            try { results[p] = fs.existsSync(p); } catch (_) { results[p] = false; }
        }
        return results;
    });

    ipcMain.handle('get-downloads-path', async () => {
        try {
            return app.getPath('downloads');
        } catch (e) {
            return null;
        }
    });

    // IPC: 批量Reels - 烧录字幕到视频
    ipcMain.handle('burn-subtitles', async (event, { videoPath, assContent, outputPath, crf, useGPU }) => {
        const { execFile, spawnSync } = require('child_process');
        const settingsService = require('./services/settings');
        const assPath = settingsService.secureTmpFile('reels_sub', '.ass');

        if (!outputPath) throw new Error('缺少输出路径');
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });

        // Write ASS content to temp file
        fs.writeFileSync(assPath, assContent, 'utf-8');
        log(`[Reels] Burning subtitles: ${videoPath} → ${outputPath}`);

        return new Promise((resolve, reject) => {
            const ffmpegBin = ffmpegService.resolveCommand ? ffmpegService.resolveCommand('ffmpeg') : 'ffmpeg';
            const platform = process.platform;
            let vcodec = 'libx264';
            let encoderArgs = ['-crf', String(crf || 23), '-preset', 'medium'];

            if (useGPU) {
                if (platform === 'darwin') {
                    vcodec = 'h264_videotoolbox';
                    encoderArgs = ['-b:v', '8M'];
                } else if (platform === 'win32') {
                    const candidates = [
                        { codec: 'h264_nvenc', args: ['-preset', 'p4', '-cq', String(crf || 23), '-b:v', '0'] },
                        { codec: 'h264_amf', args: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(crf || 23), '-qp_p', String(crf || 23)] },
                        { codec: 'h264_qsv', args: ['-global_quality', String(crf || 23)] },
                    ];
                    for (const enc of candidates) {
                        const probe = spawnSync(ffmpegBin, [
                            '-y', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.1',
                            '-c:v', enc.codec, '-frames:v', '1', '-f', 'null', '-'
                        ], { timeout: 10000, stdio: ['ignore', 'ignore', 'pipe'] });
                        if (probe.status === 0) {
                            vcodec = enc.codec;
                            encoderArgs = enc.args;
                            log(`[Reels] burn-subtitles GPU encoder: ${enc.codec}`);
                            break;
                        }
                    }
                }
            }

            const args = [
                '-i', videoPath,
                '-vf', `ass='${ffmpegService.escapeAssPathForFilter(assPath)}'`,
                '-c:a', 'copy',
                '-c:v', vcodec,
                ...encoderArgs,
                '-y',
                outputPath
            ];
            execFile(ffmpegBin, args, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
                // Clean up temp ASS file
                try { fs.unlinkSync(assPath); } catch (e) { /* ignore */ }
                if (err) {
                    log(`[Reels] FFmpeg error: ${stderr}`);
                    reject(new Error(ffmpegService.formatMediaError(stderr || err.message, {
                        action: '字幕烧录',
                        code: err.code,
                    })));
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
            bgmStart: Math.max(0, parseFloat(data.bgm_start ?? 0) || 0),
        });
        return { success: true, data: res };
    });

    // IPC: WYSIWYG 逐帧渲染导出（与 Canvas 预览 100% 一致）
    const { handleWysiwygIPC, attachFramePipeline, parallelExport } = require('./services/ffmpeg-rawvideo');
    ipcMain.handle('reels-compose-wysiwyg', async (event, action, data) => {
        return handleWysiwygIPC(action, data);
    });
    ipcMain.on('reels-frame-pipeline-open', (event, data = {}) => {
        const { port1, port2 } = new MessageChannelMain();
        const result = attachFramePipeline(data.sessionId, port1);
        try {
            event.sender.postMessage('reels-frame-pipeline-ready', {
                requestId: data.requestId,
                ...result,
            }, [port2]);
        } catch (err) {
            try { port1.close(); port2.close(); } catch (_) { }
            console.warn('[WYSIWYG] 无法建立帧流水线:', err.message);
        }
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
                const stderr = result.stderr?.toString() || '';
                log(`[Layers] PNG 帧转换失败 (code=${result.status}): ${stderr}`);
                return {
                    ok: false,
                    error: ffmpegService.formatMediaError(stderr, {
                        action: 'PNG 帧转换',
                        code: result.status,
                    }),
                };
            }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // IPC: 导出音频为 MP3（分层 PNG 序列导出用）
    ipcMain.handle('export-audio-mp3', async (event, { inputPath, outputPath: mp3Path, volume, startTime = 0 }) => {
        if (!inputPath || !fs.existsSync(inputPath)) {
            return { ok: false, error: `音频文件不存在或已被移动，请重新选择：${inputPath || '未选择文件'}` };
        }
        const ffmpeg = ffmpegService.resolveCommand('ffmpeg');
        const { spawnSync } = require('child_process');
        const args = ['-y'];
        if (Number(startTime) > 0) args.push('-ss', Number(startTime).toFixed(3));
        args.push('-i', inputPath);
        if (volume != null && volume !== 1.0) {
            args.push('-af', `volume=${volume}`);
        }
        args.push('-c:a', 'libmp3lame', '-b:a', '192k', mp3Path);
        const result = spawnSync(ffmpeg, args, { timeout: 120000 });
        if (result.status !== 0) {
            const stderr = result.stderr?.toString() || result.error?.message || '';
            log(`[Layers] MP3 导出失败 (code=${result.status}): ${stderr}`);
            return {
                ok: false,
                error: ffmpegService.formatMediaError(stderr, {
                    action: 'MP3 音频导出',
                    code: result.status,
                    missingLabel: '音频文件',
                }),
            };
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
    ipcMain.handle('get-media-duration-detail', async (event, filePath) => {
        return ffmpegService.getDurationDetailed(filePath);
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

    // IPC: 获取 Google Fonts 目录，绕过 CORS
    ipcMain.handle('fetch-google-fonts', async () => {
        try {
            const { net } = require('electron');
            const response = await net.fetch('https://fonts.google.com/metadata/fonts', {
                signal: AbortSignal.timeout(8000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            return text;
        } catch (err) {
            console.error('[Fonts] fetch-google-fonts failed:', err.message);
            throw err;
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

    // ==================== 屏幕取色器（解决 Windows 吸管无法吸取窗口外颜色） ====================
    ipcMain.handle('screen-pick-color', async () => {
        try {
            // 获取主显示器信息
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width: sw, height: sh } = primaryDisplay.size;
            const scaleFactor = primaryDisplay.scaleFactor || 1;

            // 截取整个屏幕
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: sw * scaleFactor, height: sh * scaleFactor },
            });
            if (!sources || sources.length === 0) {
                log('[ColorPicker] No screen source found');
                return null;
            }
            const screenshot = sources[0].thumbnail;
            const dataUrl = screenshot.toDataURL();

            return new Promise((resolve) => {
                // 创建全屏透明窗口，覆盖整个屏幕
                const pickerWin = new BrowserWindow({
                    x: 0, y: 0,
                    width: sw, height: sh,
                    frame: false,
                    transparent: false,
                    alwaysOnTop: true,
                    skipTaskbar: true,
                    fullscreen: false,
                    resizable: false,
                    movable: false,
                    focusable: true,
                    webPreferences: {
                        nodeIntegration: false,
                        contextIsolation: true,
                    },
                });

                pickerWin.setMenuBarVisibility(false);

                // 注入 HTML：显示截图 + 点击取色
                const html = `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100%; height:100%; overflow:hidden; cursor:crosshair; }
  canvas { display:block; width:100%; height:100%; }
  #loupe {
    position:fixed; pointer-events:none; display:none;
    width:120px; height:120px; border-radius:50%;
    border:3px solid #fff; box-shadow:0 0 12px rgba(0,0,0,.6);
    overflow:hidden; z-index:999;
    image-rendering: pixelated;
  }
  #loupe canvas { width:120px; height:120px; image-rendering:pixelated; }
  #crosshair {
    position:fixed; pointer-events:none; display:none;
    width:1px; height:1px; z-index:1000;
  }
  #crosshair::before, #crosshair::after {
    content:''; position:absolute; background:rgba(255,255,255,.6);
  }
  #crosshair::before { width:1px; height:20px; left:0; top:-10px; }
  #crosshair::after { width:20px; height:1px; left:-10px; top:0; }
  #colorLabel {
    position:fixed; pointer-events:none; display:none;
    padding:4px 10px; border-radius:4px;
    font:bold 13px/1.2 monospace; color:#fff;
    background:rgba(0,0,0,.75); z-index:1001;
    white-space:nowrap;
  }
</style></head><body>
<canvas id="c"></canvas>
<div id="loupe"><canvas id="lc" width="120" height="120"></canvas></div>
<div id="crosshair"></div>
<div id="colorLabel"></div>
<script>
  const img = new Image();
  const scaleFactor = ${scaleFactor};
  img.onload = () => {
    const c = document.getElementById('c');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const loupe = document.getElementById('loupe');
    const lc = document.getElementById('lc');
    const lctx = lc.getContext('2d', { willReadFrequently: true });
    const crosshair = document.getElementById('crosshair');
    const colorLabel = document.getElementById('colorLabel');

    function getColor(x, y) {
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return '#' + [d[0],d[1],d[2]].map(v => v.toString(16).padStart(2,'0')).join('');
    }

    document.addEventListener('mousemove', e => {
      const x = e.clientX, y = e.clientY;
      // 放大镜
      loupe.style.display = 'block';
      crosshair.style.display = 'block';
      colorLabel.style.display = 'block';

      // 放大镜位置：跟随鼠标但偏移
      let lx = x + 20, ly = y - 140;
      if (lx + 130 > window.innerWidth) lx = x - 140;
      if (ly < 10) ly = y + 20;
      loupe.style.left = lx + 'px';
      loupe.style.top = ly + 'px';

      // 绘制放大区域 (8x 放大)
      const zoom = 8;
      const srcSize = 15; // 15x15 像素区域
      const px = Math.round(x * scaleFactor);
      const py = Math.round(y * scaleFactor);
      lctx.clearRect(0, 0, 120, 120);
      lctx.imageSmoothingEnabled = false;
      lctx.drawImage(c,
        px - srcSize/2, py - srcSize/2, srcSize, srcSize,
        0, 0, 120, 120
      );
      // 中心十字线
      lctx.strokeStyle = 'rgba(255,255,255,0.8)';
      lctx.lineWidth = 1;
      lctx.strokeRect(56, 56, 8, 8);

      crosshair.style.left = x + 'px';
      crosshair.style.top = y + 'px';

      const hex = getColor(x, y);
      colorLabel.textContent = hex.toUpperCase();
      colorLabel.style.left = (lx) + 'px';
      colorLabel.style.top = (ly + 128) + 'px';
      colorLabel.style.borderLeft = '4px solid ' + hex;
    });

    document.addEventListener('mousedown', e => {
      e.preventDefault();
      const hex = getColor(e.clientX, e.clientY);
      // 使用 document.title 通信回主进程
      document.title = 'PICKED:' + hex;
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.title = 'PICKED:';
      }
    });
  };
  img.src = "${dataUrl}";
</script></body></html>`;

                pickerWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

                // 监听 title 变化获取拾取结果
                pickerWin.webContents.on('page-title-updated', (e, title) => {
                    if (title.startsWith('PICKED:')) {
                        const hex = title.replace('PICKED:', '').trim();
                        pickerWin.destroy();
                        resolve(hex || null);
                    }
                });

                pickerWin.on('closed', () => {
                    resolve(null);
                });

                // 安全超时：30 秒后自动关闭
                setTimeout(() => {
                    if (!pickerWin.isDestroyed()) pickerWin.destroy();
                }, 30000);
            });
        } catch (err) {
            log('[ColorPicker] Error: ' + err.message);
            return null;
        }
    });

    // ==================== 模板多窗口支持 ====================
    ipcMain.handle('open-template-window', (event, templateId, templateName) => {
        // 如果已有该模板的窗口，聚焦它
        if (templateWindows.has(templateId)) {
            const existingWin = templateWindows.get(templateId);
            if (!existingWin.isDestroyed()) {
                existingWin.focus();
                return { success: true, reused: true };
            }
            templateWindows.delete(templateId);
        }

        const winOpts = {
            width: 1200,
            height: 800,
            minWidth: 900,
            minHeight: 700,
            title: `模板: ${templateName || templateId}`,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                backgroundThrottling: false,
                webSecurity: true, // Re-enabled for security; local media loads via local-media:// protocol
                preload: path.join(__dirname, 'preload.js'),
            },
        };

        if (process.platform === 'darwin') {
            winOpts.titleBarStyle = 'hiddenInset';
            winOpts.trafficLightPosition = { x: 15, y: 15 };
        }

        const win = new BrowserWindow(winOpts);

        // 通过 URL hash 传递模板 ID，前端启动时读取
        if (!app.isPackaged) {
            win.loadURL(`http://localhost:5173/#template=${templateId}`);
            win.webContents.openDevTools();
        } else {
            win.loadFile(path.join(__dirname, '../dist/index.html'), {
                hash: `template=${templateId}`,
            });
        }

        templateWindows.set(templateId, win);
        win.on('closed', () => {
            templateWindows.delete(templateId);
        });

        log(`[Template] 打开模板窗口: ${templateName} (${templateId})`);
        return { success: true, reused: false };
    });

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
