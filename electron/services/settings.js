/**
 * Settings and file management service
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const archiver = require('archiver');

// ==================== JSON Settings ====================

function getBackendDir() {
    let isPackaged = false;
    try {
        const { app } = require('electron');
        isPackaged = app.isPackaged;
    } catch { }

    if (isPackaged) {
        const { app } = require('electron');
        const userDataBackend = path.join(app.getPath('userData'), 'backend');
        if (!fs.existsSync(userDataBackend)) {
            fs.mkdirSync(userDataBackend, { recursive: true });
            const resourceBackend = path.join(process.resourcesPath, 'backend');
            if (fs.existsSync(resourceBackend)) {
                const jsonFiles = fs.readdirSync(resourceBackend).filter(f => f.endsWith('.json'));
                for (const f of jsonFiles) {
                    try {
                        fs.copyFileSync(path.join(resourceBackend, f), path.join(userDataBackend, f));
                    } catch { }
                }
            }
        }
        return userDataBackend;
    }
    return path.join(__dirname, '..', '..', 'backend');
}

function getSecureTmpDir(subDir) {
    let baseDir;
    try {
        const { app } = require('electron');
        baseDir = path.join(app.getPath('userData'), 'tmp');
    } catch {
        baseDir = path.join(os.homedir(), '.videokit_tmp');
    }
    const dir = subDir ? path.join(baseDir, subDir) : baseDir;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function secureTmpFile(prefix, ext) {
    const dir = getSecureTmpDir();
    return path.join(dir, `${prefix}_${crypto.randomUUID()}${ext || ''}`);
}

function readJSON(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Gladia Keys
function getGladiaKeysPath() { return path.join(getBackendDir(), 'gladia_keys.json'); }
function loadGladiaKeys() { return readJSON(getGladiaKeysPath()) || { keys: [] }; }
function saveGladiaKeys(data) { writeJSON(getGladiaKeysPath(), data); }

// Gemini Keys
const DEFAULT_GEMINI_PROMPT = "ElevenLabs 配音文案格式化助手 — 为祷告/宣告/属灵鼓励/短视频旁白文案添加情感标签、拆句断行、排节奏，可直接复制粘贴用于 ElevenLabs 生成配音\n\n## 核心用途\n用于 ElevenLabs 配音\n场景：祷告 / 宣告 / 属灵鼓励 / 短视频旁白\n需要可直接复制粘贴使用\n\n## 情感标签（最重要）\n✅ 只用情感 / 语气标签（如 [calm] [reverent] [faith-filled]）\n❌ 不要 emoji\n❌ 不要解释标签含义\n标签要：克制、稳定、不浮夸、不戏剧化\n\n## 节奏与结构\n每段都有清晰停顿\n常用：[pause]\n适合：跟读、默读、夜间 / 安静场景\n长文也要分层，不能一口气读完\n\n## 语气取向\n偏向：祷告感、安抚感、权柄但不咆哮\n避免：情绪炸裂、表演感、过度煽动\n\n## 内容处理原则\n❌ 不改原文意思\n❌ 不擅自删句\n❌ 不加新神学内容\n❌ 不删除标题\n对于文案中关于上帝的单词、代词都要标准的首字母大写（如 God / He / Him / His / Lord / Father）\n只做三件事：拆句断行、排节奏、加合适的情感标签\n\n## 输出要求 - 分两部分\n你需要输出两个结果，用 ||| 分隔：\n1. 加标签结果：带情感标签的完整文案（用于 ElevenLabs 配音）\n2. 断句结果：根据标签合理断行后的文案（用于字幕显示）\n\n断行规则：\n- 断句合理，符合语言习惯\n- 每行不超过 4 个单词，便于字幕显示\n- 也不要太短（至少有完整的意思单元）\n- 在 [pause] 标签处自然断行\n- 断句结果不包含情感标签，只保留纯文本\n- ⚠️ 断句结果不包含省略号（...），省略号仅用于配音的加标签结果\n\n输出格式示例：\n[calm] Lord... I come before You today, with a grateful heart...\n|||\nLord,\nI come before You today,\nwith a grateful heart.\n\n## 批量处理输出规则\n你需要处理多条文案，每条以 [编号] 开头。\n对于每条文案，输出格式为：[编号] 加标签结果|||断句结果\n⚠️ 断句结果中的换行用 \\\\n 表示（字面的反斜杠n），不要真正换行，保持每条结果在同一行。\n每条结果占一行。";

function getGeminiKeysPath() { return path.join(getBackendDir(), 'gemini_keys.json'); }
function loadGeminiKeys() {
    const data = readJSON(getGeminiKeysPath()) || { keys: [] };
    if (!data.prompt || !data.prompt.trim()) {
        data.prompt = DEFAULT_GEMINI_PROMPT;
    }
    return data;
}
function saveGeminiKeys(data) { writeJSON(getGeminiKeysPath(), data); }

// ElevenLabs Settings
function getElevenLabsSettingsPath() { return path.join(getBackendDir(), 'elevenlabs_settings.json'); }
function loadElevenLabsSettings() {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    let keys = data.api_keys || [];
    if (typeof keys === 'string') keys = [keys];
    if (keys.length === 0 && data.api_key) keys = [data.api_key];
    keys = keys.filter(k => typeof k === 'string' && k.trim());
    return {
        api_key: keys[0] || '',
        api_keys: keys,
        use_web_token: !!data.use_web_token
    };
}
function saveElevenLabsSettings(inputData) {
    const existingData = readJSON(getElevenLabsSettingsPath()) || {};
    let keys = inputData.api_keys || [];
    if (typeof keys === 'string') keys = [keys];
    if (keys.length === 0 && inputData.api_key) keys = [inputData.api_key];
    keys = keys.filter(k => typeof k === 'string' && k.trim());

    const payload = {
        ...existingData,
        api_key: keys[0] || '',
        api_keys: keys
    };

    if (inputData.use_web_token !== undefined) {
        payload.use_web_token = !!inputData.use_web_token;
    }

    writeJSON(getElevenLabsSettingsPath(), payload);
    return payload;
}

// ElevenLabs Keys with Status
function normalizeElevenLabsKeysWithStatus(value) {
    if (Array.isArray(value)) {
        return value
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [{ key: value.trim(), enabled: true }];
    }
    if (value && typeof value === 'object') {
        return Object.values(value)
            .map(entry => typeof entry === 'string' ? { key: entry, enabled: true } : entry)
            .filter(entry => entry && typeof entry === 'object' && typeof entry.key === 'string' && entry.key.trim());
    }
    return [];
}

function loadElevenLabsKeysWithStatus() {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const kws = normalizeElevenLabsKeysWithStatus(data.keys_with_status);
    if (kws.length > 0) return kws;
    const legacyKeys = Array.isArray(data.api_keys) ? data.api_keys : (data.api_keys ? [data.api_keys] : []);
    return legacyKeys.map(k => ({ key: k, enabled: true })).filter(entry => entry.key && entry.key.trim());
}
function saveElevenLabsKeysWithStatus(keysData) {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    data.keys_with_status = normalizeElevenLabsKeysWithStatus(keysData);
    writeJSON(getElevenLabsSettingsPath(), data);
}

// Replace Rules
function getReplaceRulesPath() { return path.join(getBackendDir(), 'replace_rules.json'); }
function loadReplaceRules() { return readJSON(getReplaceRulesPath()) || { rules: [] }; }
function saveReplaceRules(data) { writeJSON(getReplaceRulesPath(), data); }

// ==================== File Operations ====================

function openFolder(folderPath) {
    let expandedPath = folderPath;
    if (expandedPath === '~') {
        expandedPath = os.homedir();
    } else if (expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
        expandedPath = path.join(os.homedir(), expandedPath.slice(2));
    }

    if (!fs.existsSync(expandedPath)) {
        try {
            fs.mkdirSync(expandedPath, { recursive: true });
        } catch {
            throw new Error('路径不存在且创建失败: ' + expandedPath);
        }
    }

    const platform = process.platform;
    let cmd;
    if (platform === 'darwin') {
        cmd = `open "${expandedPath}"`;
    } else if (platform === 'win32') {
        cmd = `explorer "${expandedPath}"`;
    } else {
        cmd = `xdg-open "${expandedPath}"`;
    }

    return new Promise((resolve, reject) => {
        exec(cmd, (err) => {
            if (err) reject(new Error('打开文件夹失败: ' + err.message));
            else resolve({ message: '已打开' });
        });
    });
}

// Upload directory
const UPLOAD_DIR = path.join(getBackendDir(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function uploadFile(buffer, filename) {
    const destPath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(destPath, buffer);
    return { path: destPath };
}

function createZip(files, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', () => resolve(outputPath));
        archive.on('error', reject);
        archive.pipe(output);
        for (const f of files) {
            if (fs.existsSync(f)) {
                archive.file(f, { name: path.basename(f) });
            }
        }
        archive.finalize();
    });
}

// ==================== Language Config ====================

const LANGUAGES = {
    en: { name: 'en', display: '英文', gladia: 'english' },
    ja: { name: 'ja', display: '日文', gladia: 'japanese' },
    ko: { name: 'ko', display: '韩文', gladia: 'korean' },
    es: { name: 'es', display: '西班牙文', gladia: 'spanish' },
    fr: { name: 'fr', display: '法文', gladia: 'french' },
    de: { name: 'de', display: '德文', gladia: 'german' },
    pt: { name: 'pt', display: '葡萄牙文', gladia: 'portuguese' },
    it: { name: 'it', display: '意大利文', gladia: 'italian' },
    zh: { name: 'zh', display: '中文', gladia: 'chinese' },
    ar: { name: 'ar', display: '阿拉伯文', gladia: 'arabic' },
    ru: { name: 'ru', display: '俄文', gladia: 'russian' },
};

function getLanguages() {
    return Object.entries(LANGUAGES).map(([code, lang]) => ({
        code,
        name: lang.name,
        display: lang.display,
    }));
}

module.exports = {
    getBackendDir,
    getSecureTmpDir,
    secureTmpFile,
    readJSON,
    writeJSON,
    loadGladiaKeys,
    saveGladiaKeys,
    loadGeminiKeys,
    saveGeminiKeys,
    loadElevenLabsSettings,
    saveElevenLabsSettings,
    loadElevenLabsKeysWithStatus,
    saveElevenLabsKeysWithStatus,
    loadReplaceRules,
    saveReplaceRules,
    openFolder,
    uploadFile,
    createZip,
    getLanguages,
    LANGUAGES,
    UPLOAD_DIR,
    DEFAULT_GEMINI_PROMPT,
};
