/**
 * 设置和文件管理服务
 * 替代 Python server.py 中的设置存储和文件操作
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const archiver = require('archiver');

// ==================== JSON 设置文件管理 ====================

/**
 * 获取可写的 backend 数据目录
 * - 开发模式：项目根目录下的 backend/
 * - 打包模式：用户数据目录下的 backend/（可写）
 */
function getBackendDir() {
    let isPackaged = false;
    try {
        const { app } = require('electron');
        isPackaged = app.isPackaged;
    } catch { }

    if (isPackaged) {
        const { app } = require('electron');
        const userDataBackend = path.join(app.getPath('userData'), 'backend');
        // 首次运行时，从打包资源中复制种子 JSON 文件
        if (!fs.existsSync(userDataBackend)) {
            fs.mkdirSync(userDataBackend, { recursive: true });
            // 尝试从 extraResources 复制初始配置
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

/**
 * 获取安全的临时文件目录（app-scoped，非共享 /tmp）
 * 用于替代 os.tmpdir() 以避免 CWE-377 不安全临时文件问题
 */
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

/**
 * 生成安全的临时文件路径
 */
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
const DEFAULT_GEMINI_PROMPT = `你是一个专业的配音文案标注专家，专门为 ElevenLabs 配音软件准备文案。

【核心用途】
用于 ElevenLabs 配音。场景：祷告 / 宣告 / 属灵鼓励 / 短视频旁白

【情感标签规则（最重要）】
✅ 只使用情感/语气标签（如 [calm] [reverent] [faith-filled] [pause]）
❌ 不要使用 emoji
❌ 不要解释标签含义
标签要求：克制、稳定、不浮夸、不戏剧化

【节奏与结构】
- 合适的停顿，常用 [pause]，停顿要合理，符合正常人说话的情况，只有必须停顿的才加停顿，不然太多停顿听着就像是在背台词了
- 停顿要根据整体文案内容添加的合理自然

【ElevenLabs 特性优化】
针对 ElevenLabs 的特性，它对停顿和标点非常敏感。在 ElevenLabs 中，直接使用 [pause] 标签有时效果不够自然。
**最有效的"停顿"其实是利用标点符号（如 ... 或 ,）以及通过情感词引导模型改变语速。**
- 将情感词放在中括号内并配合 ... 标点，能更好地引导 AI 表现出语气起伏
- 例如：[calm] Lord... I come before You today, with a grateful heart...

【语气取向】
根据文案内容，偏向：力量感、祷告感、安抚感、权柄但不咆哮
避免：情绪炸裂、表演感、过度煽动

【内容处理原则】
❌ 不改原文意思
❌ 不擅自删句
❌ 不加新神学内容

【输出要求 - 分两部分】
你需要输出两个结果，用 ||| 分隔：
1. 加标签结果：带情感标签的完整文案（用于 ElevenLabs 配音）
2. 断句结果：根据标签合理断行后的文案（用于字幕显示）

断行规则：
- 断句合理，符合语言习惯
- 每行不超过 4 个单词，便于字幕显示
- 也不要太短（至少有完整的意思单元）
- 在 [pause] 标签处自然断行
- 断句结果不包含情感标签，只保留纯文本
- ⚠️ 断句结果不包含省略号（...），省略号仅用于配音的加标签结果

输出格式示例：
[calm] Lord... I come before You today, with a grateful heart...
|||
Lord,
I come before You today,
with a grateful heart.

【批量处理输出规则】
你需要处理多条文案，每条以 [编号] 开头。
对于每条文案，输出格式为：[编号] 加标签结果|||断句结果
⚠️ 断句结果中的换行用 \\n 表示（字面的反斜杠n），不要真正换行，保持每条结果在同一行。
每条结果占一行。`;

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
    
    // Retain full existing state and overlay new changes
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
function loadElevenLabsKeysWithStatus() {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    const kws = data.keys_with_status || [];
    if (kws.length > 0) return kws;
    return (data.api_keys || []).map(k => ({ key: k, enabled: true }));
}
function saveElevenLabsKeysWithStatus(keysData) {
    const data = readJSON(getElevenLabsSettingsPath()) || {};
    data.keys_with_status = keysData;
    writeJSON(getElevenLabsSettingsPath(), data);
}

// Replace Rules
function getReplaceRulesPath() { return path.join(getBackendDir(), 'replace_rules.json'); }
function loadReplaceRules() { return readJSON(getReplaceRulesPath()) || { rules: [] }; }
function saveReplaceRules(data) { writeJSON(getReplaceRulesPath(), data); }

// ==================== 文件操作 ====================

function openFolder(folderPath) {
    let expandedPath = folderPath;
    if (expandedPath === '~') {
        expandedPath = os.homedir();
    } else if (expandedPath.startsWith('~/') || expandedPath.startsWith('~\\')) {
        expandedPath = path.join(os.homedir(), expandedPath.slice(2));
    }

    if (!fs.existsSync(expandedPath)) {
        // 尝试创建目录
        try {
            fs.mkdirSync(expandedPath, { recursive: true });
        } catch {
            throw new Error(`路径不存在且创建失败: ${expandedPath}`);
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
            if (err) reject(new Error(`打开文件夹失败: ${err.message}`));
            else resolve({ message: '已打开' });
        });
    });
}

// Upload 目录
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

// ==================== 语言配置 ====================

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
