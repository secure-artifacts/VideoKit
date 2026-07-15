// ==================== IPC API 兼容层 ====================
// 替代原来的 HTTP fetch → Python Flask 调用
// 通过 Electron IPC 直接调用 Node.js 后端

/**
 * apiFetch: fetch() 的 IPC 替代
 * 返回一个类 Response 对象 { ok, status, json(), text() }
 * 用法完全兼容: const response = await apiFetch('elevenlabs/voices', { method: 'GET' })
 */
async function apiFetch(url, options = {}) {
    // 从 URL 中提取 endpoint
    let endpoint = url;
    if (url.includes('/api/')) {
        endpoint = url.split('/api/')[1];
    }
    // 去除查询参数
    const queryIdx = endpoint.indexOf('?');
    let queryParams = {};
    if (queryIdx !== -1) {
        const queryStr = endpoint.slice(queryIdx + 1);
        endpoint = endpoint.slice(0, queryIdx);
        queryStr.split('&').forEach(p => {
            const [k, v] = p.split('=');
            if (k) queryParams[decodeURIComponent(k)] = decodeURIComponent(v || '');
        });
    }

    // 解析请求数据
    let data = {};
    const method = (options.method || 'GET').toUpperCase();

    if (options.body) {
        if (typeof options.body === 'string') {
            try { data = JSON.parse(options.body); } catch { data = { _raw: options.body }; }
        } else if (options.body instanceof FormData) {
            // FormData → 需要走文件上传通道
            return await handleFormDataUpload(endpoint, options.body);
        }
    }

    // 将 GET 方法标记传入数据中
    if (method === 'GET') {
        data._method = 'GET';
    }

    // 合并查询参数
    Object.assign(data, queryParams);

    // 通过 IPC 调用
    const result = await window.electronAPI.apiCall(endpoint, data);

    // 包装成 Response-like 对象
    return {
        ok: result.success,
        status: result.success ? 200 : 500,
        json: async () => result.success ? result.data : { error: result.error },
        text: async () => JSON.stringify(result.success ? result.data : { error: result.error }),
        clone: function () { return this; },
    };
}

/** 处理 FormData 上传 */
async function handleFormDataUpload(endpoint, formData) {
    const file = formData.get('audio_file') || formData.get('file');
    const extraData = {};
    for (const [key, value] of formData.entries()) {
        if (key !== 'audio_file' && key !== 'file' && !(value instanceof File)) {
            extraData[key] = value;
        }
    }

    if (file && file instanceof File) {
        const buffer = await file.arrayBuffer();
        const result = await window.electronAPI.apiUpload(endpoint, buffer, file.name, extraData);
        return {
            ok: result.success,
            status: result.success ? 200 : 500,
            json: async () => result.success ? result.data : { error: result.error },
            text: async () => JSON.stringify(result.success ? result.data : { error: result.error }),
        };
    }

    // 没有文件，退回到普通 API 调用
    const result = await window.electronAPI.apiCall(endpoint, extraData);
    return {
        ok: result.success,
        status: result.success ? 200 : 500,
        json: async () => result.success ? result.data : { error: result.error },
        text: async () => JSON.stringify(result.success ? result.data : { error: result.error }),
    };
}

// API_BASE 保留为占位符（apiFetch 会自动解析）
const API_BASE = 'ipc://api';
const API_ORIGIN = '';

/** 获取 File 对象的本地完整路径 (Electron contextIsolation 下 File.path 不可用) */
function getFileNativePath(file) {
    if (window.electronAPI && window.electronAPI.getFilePath) {
        const p = window.electronAPI.getFilePath(file);
        if (p) return p;
    }
    return file.path || file.name;
}

// 当前选中的文件路径
let currentAudioPath = '';
let currentSrtSrcPath = '';
let currentSrtOrgiPath = '';
let currentSrtRefPath = '';
let currentSeamlessSrtPath = '';
let currentMediaFiles = [];
let currentMediaFileInfos = [];
let currentAudioCutPoints = {};
let currentVideoUrl = '';
let backendReady = false;
let settingsAutoLoaded = false;
let replaceRulesCache = null;

// 音频预览状态
let audioPreviewElement = null;
let currentPreviewFilePath = '';

// ElevenLabs 播放器状态
let audioPlayer = null;
let currentAudioPath_elevenlabs = '';

const LOGO_DEFAULTS = {
    hailuo: { x: 590, y: 1810, w: 475, h: 90 },
    vidu: { x: 700, y: 1810, w: 360, h: 90 },
    veo: { x: 700, y: 1810, w: 360, h: 90 },
    heygen: { x: 700, y: 1810, w: 360, h: 90 },
    dream: { x: 700, y: 1810, w: 360, h: 90 },
    ai_generated: { x: 680, y: 20, w: 380, h: 60 },
    custom: { x: 590, y: 1810, w: 400, h: 90 }
};

const LOGO_PRESET_ASSETS = {
    hailuo: 'Hailuo.png',
    vidu: 'vidu.png',
    veo: 'Veo.png',
    heygen: 'HeyGen.png',
    dream: 'Dream.png',
    ai_generated: 'AI_Generated.png'
};

const logoImageCache = new Map();
const voiceCache = new Map();

// Toast 通知系统
function showToast(message, type = 'info', duration = 4000) {
    const existingToast = document.querySelector('.toast');
    if (existingToast) {
        existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
        <span class="toast-message">${escapeHtml(message)}</span>
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initSubTabs();
    initMediaSidebar();
    initFileInputs();
    initAudioPlayer();
    initMediaModeOptions();
    initMediaToolbox();
    initBatchTTS();
    initSubtitleBatch();
    initKeyTableManagers();
    loadSettings();
    loadWatermarkSettings();  // 加载保存的水印设置
    checkBackendHealth();
    addToastStyles();
    initSubtitleLangPicker();
    initAutoEditLangPicker();
    initVoiceoverWorkflowLangPicker();

    // 启动心跳检测（每30秒检查一次后端状态）
    startHeartbeat();
});

// ==================== 字幕面板语言搜索选择器 ====================

const SUBTITLE_LANG_STORAGE_KEY = 'subtitle_align_language';

/**
 * 所有支持的语言列表 — 与 reels-batch-table.js 的 REELS_ALL_LANGUAGES 保持同步
 * 直接内嵌以避免脚本加载顺序依赖
 */
const SUBTITLE_ALL_LANGUAGES = [
    // ── 常用 (pinned) ──
    { name: '英语', code: 'en', en: 'English', pinned: true },
    { name: '中文', code: 'zh', en: 'Chinese', pinned: true },
    { name: '日语', code: 'ja', en: 'Japanese', pinned: true },
    { name: '韩语', code: 'ko', en: 'Korean', pinned: true },
    { name: '西班牙语', code: 'es', en: 'Spanish', pinned: true },
    { name: '法语', code: 'fr', en: 'French', pinned: true },
    { name: '德语', code: 'de', en: 'German', pinned: true },
    { name: '葡萄牙语', code: 'pt', en: 'Portuguese', pinned: true },
    { name: '俄语', code: 'ru', en: 'Russian', pinned: true },
    { name: '阿拉伯语', code: 'ar', en: 'Arabic', pinned: true },
    { name: '粤语', code: 'yue', en: 'Cantonese', pinned: true },
    { name: '意大利语', code: 'it', en: 'Italian', pinned: true },
    // ── 亚洲 ──
    { name: '印地语', code: 'hi', en: 'Hindi' },
    { name: '泰语', code: 'th', en: 'Thai' },
    { name: '越南语', code: 'vi', en: 'Vietnamese' },
    { name: '印尼语', code: 'id', en: 'Indonesian' },
    { name: '马来语', code: 'ms', en: 'Malay' },
    { name: '泰米尔语', code: 'ta', en: 'Tamil' },
    { name: '泰卢固语', code: 'te', en: 'Telugu' },
    { name: '孟加拉语', code: 'bn', en: 'Bengali' },
    { name: '卡纳达语', code: 'kn', en: 'Kannada' },
    { name: '马拉雅拉姆语', code: 'ml', en: 'Malayalam' },
    { name: '马拉地语', code: 'mr', en: 'Marathi' },
    { name: '古吉拉特语', code: 'gu', en: 'Gujarati' },
    { name: '旁遮普语', code: 'pa', en: 'Punjabi' },
    { name: '僧伽罗语', code: 'si', en: 'Sinhala' },
    { name: '尼泊尔语', code: 'ne', en: 'Nepali' },
    { name: '乌尔都语', code: 'ur', en: 'Urdu' },
    { name: '高棉语', code: 'km', en: 'Khmer' },
    { name: '老挝语', code: 'lo', en: 'Lao' },
    { name: '蒙古语', code: 'mn', en: 'Mongolian' },
    { name: '缅甸语', code: 'my', en: 'Myanmar' },
    { name: '藏语', code: 'bo', en: 'Tibetan' },
    { name: '他加禄语', code: 'tl', en: 'Tagalog' },
    { name: '爪哇语', code: 'jw', en: 'Javanese' },
    { name: '巽他语', code: 'su', en: 'Sundanese' },
    { name: '阿萨姆语', code: 'as', en: 'Assamese' },
    // ── 欧洲 ──
    { name: '荷兰语', code: 'nl', en: 'Dutch' },
    { name: '波兰语', code: 'pl', en: 'Polish' },
    { name: '土耳其语', code: 'tr', en: 'Turkish' },
    { name: '瑞典语', code: 'sv', en: 'Swedish' },
    { name: '芬兰语', code: 'fi', en: 'Finnish' },
    { name: '丹麦语', code: 'da', en: 'Danish' },
    { name: '挪威语', code: 'no', en: 'Norwegian' },
    { name: '新挪威语', code: 'nn', en: 'Nynorsk' },
    { name: '捷克语', code: 'cs', en: 'Czech' },
    { name: '斯洛伐克语', code: 'sk', en: 'Slovak' },
    { name: '匈牙利语', code: 'hu', en: 'Hungarian' },
    { name: '罗马尼亚语', code: 'ro', en: 'Romanian' },
    { name: '保加利亚语', code: 'bg', en: 'Bulgarian' },
    { name: '希腊语', code: 'el', en: 'Greek' },
    { name: '乌克兰语', code: 'uk', en: 'Ukrainian' },
    { name: '白俄罗斯语', code: 'be', en: 'Belarusian' },
    { name: '克罗地亚语', code: 'hr', en: 'Croatian' },
    { name: '塞尔维亚语', code: 'sr', en: 'Serbian' },
    { name: '斯洛文尼亚语', code: 'sl', en: 'Slovenian' },
    { name: '立陶宛语', code: 'lt', en: 'Lithuanian' },
    { name: '拉脱维亚语', code: 'lv', en: 'Latvian' },
    { name: '爱沙尼亚语', code: 'et', en: 'Estonian' },
    { name: '马其顿语', code: 'mk', en: 'Macedonian' },
    { name: '波斯尼亚语', code: 'bs', en: 'Bosnian' },
    { name: '阿尔巴尼亚语', code: 'sq', en: 'Albanian' },
    { name: '冰岛语', code: 'is', en: 'Icelandic' },
    { name: '马耳他语', code: 'mt', en: 'Maltese' },
    { name: '卢森堡语', code: 'lb', en: 'Luxembourgish' },
    { name: '法罗语', code: 'fo', en: 'Faroese' },
    { name: '加泰罗尼亚语', code: 'ca', en: 'Catalan' },
    { name: '加利西亚语', code: 'gl', en: 'Galician' },
    { name: '巴斯克语', code: 'eu', en: 'Basque' },
    { name: '奥克语', code: 'oc', en: 'Occitan' },
    { name: '布列塔尼语', code: 'br', en: 'Breton' },
    { name: '威尔士语', code: 'cy', en: 'Welsh' },
    // ── 中东/中亚 ──
    { name: '波斯语', code: 'fa', en: 'Persian' },
    { name: '希伯来语', code: 'he', en: 'Hebrew' },
    { name: '亚美尼亚语', code: 'hy', en: 'Armenian' },
    { name: '格鲁吉亚语', code: 'ka', en: 'Georgian' },
    { name: '阿塞拜疆语', code: 'az', en: 'Azerbaijani' },
    { name: '哈萨克语', code: 'kk', en: 'Kazakh' },
    { name: '乌兹别克语', code: 'uz', en: 'Uzbek' },
    { name: '土库曼语', code: 'tk', en: 'Turkmen' },
    { name: '塔吉克语', code: 'tg', en: 'Tajik' },
    { name: '普什图语', code: 'ps', en: 'Pashto' },
    { name: '信德语', code: 'sd', en: 'Sindhi' },
    { name: '鞑靼语', code: 'tt', en: 'Tatar' },
    { name: '巴什基尔语', code: 'ba', en: 'Bashkir' },
    // ── 非洲 ──
    { name: '南非荷兰语', code: 'af', en: 'Afrikaans' },
    { name: '斯瓦希里语', code: 'sw', en: 'Swahili' },
    { name: '约鲁巴语', code: 'yo', en: 'Yoruba' },
    { name: '豪萨语', code: 'ha', en: 'Hausa' },
    { name: '索马里语', code: 'so', en: 'Somali' },
    { name: '绍纳语', code: 'sn', en: 'Shona' },
    { name: '阿姆哈拉语', code: 'am', en: 'Amharic' },
    { name: '林加拉语', code: 'ln', en: 'Lingala' },
    { name: '马达加斯加语', code: 'mg', en: 'Malagasy' },
    // ── 其他 ──
    { name: '拉丁语', code: 'la', en: 'Latin' },
    { name: '梵语', code: 'sa', en: 'Sanskrit' },
    { name: '毛利语', code: 'mi', en: 'Maori' },
    { name: '夏威夷语', code: 'haw', en: 'Hawaiian' },
    { name: '海地克里奥尔语', code: 'ht', en: 'Haitian Creole' },
    { name: '意第绪语', code: 'yi', en: 'Yiddish' },
];

function initSearchableLangPicker({
    btnId,
    dropdownId,
    searchId,
    listId,
    hiddenInputId,
    storageKey,
    defaultText = '自动识别',
    defaultValue = 'auto',
    hasAuto = true
}) {
    const btn = document.getElementById(btnId);
    const dropdown = document.getElementById(dropdownId);
    const searchInput = document.getElementById(searchId);
    const listEl = document.getElementById(listId);
    const hiddenInput = document.getElementById(hiddenInputId);
    if (!btn || !dropdown || !listEl || !hiddenInput) return;

    // Restore saved language
    const savedLang = localStorage.getItem(storageKey);
    if (savedLang) {
        if (hasAuto && savedLang === defaultValue) {
            hiddenInput.value = defaultValue;
            btn.querySelector('span').textContent = defaultText;
        } else {
            const found = SUBTITLE_ALL_LANGUAGES.find(l => l.name === savedLang || l.code === savedLang);
            if (found) {
                hiddenInput.value = found.name;
                btn.querySelector('span').textContent = found.name;
            }
        }
    } else {
        hiddenInput.value = defaultValue;
        btn.querySelector('span').textContent = defaultText;
    }

    const renderList = (filter = '') => {
        const q = filter.toLowerCase().trim();
        const filtered = q
            ? SUBTITLE_ALL_LANGUAGES.filter(l =>
                l.name.includes(q) || l.en.toLowerCase().includes(q) || l.code.includes(q))
            : SUBTITLE_ALL_LANGUAGES;

        // Pinned first, then the rest
        const pinned = filtered.filter(l => l.pinned);
        const rest = filtered.filter(l => !l.pinned);
        const sorted = [...pinned, ...rest];

        let html = '';
        if (hasAuto && (!q || defaultText.includes(q))) {
            html += `
                <div class="subtitle-lang-item" data-value="${defaultValue}" data-name="${defaultText}"
                     style="padding:8px 14px;cursor:pointer;font-size:13px;color:var(--text-primary, #ccc);
                            border-bottom:1px solid rgba(255,255,255,0.04);
                            display:flex;justify-content:space-between;align-items:center;
                            transition:background 0.15s;
                            ${hiddenInput.value === defaultValue ? 'background:rgba(76,158,255,0.12);color:#4c9eff;' : ''}
                            font-weight:600;">
                    <span>${defaultText}</span>
                    <span style="font-size:11px;color:var(--text-muted, #666);">Auto</span>
                </div>
            `;
        }

        html += sorted.map(l => `
            <div class="subtitle-lang-item" data-value="${l.name}" data-name="${l.name}"
                 style="padding:8px 14px;cursor:pointer;font-size:13px;color:var(--text-primary, #ccc);
                        border-bottom:1px solid rgba(255,255,255,0.04);
                        display:flex;justify-content:space-between;align-items:center;
                        transition:background 0.15s;
                        ${hiddenInput.value === l.name ? 'background:rgba(76,158,255,0.12);color:#4c9eff;' : ''}
                        ${l.pinned ? 'font-weight:600;' : ''}">
                <span>${l.name}</span>
                <span style="font-size:11px;color:var(--text-muted, #666);">${l.en}</span>
            </div>
        `).join('');

        listEl.innerHTML = html;

        if (sorted.length === 0 && (!hasAuto || (q && !defaultText.includes(q)))) {
            listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted, #555);font-size:12px;">未找到匹配语言</div>';
        }
    };

    // Toggle dropdown
    const toggleHandler = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isOpen = dropdown.style.display !== 'none';

        // Close all other lang dropdowns to avoid overlap
        document.querySelectorAll('[id$="-lang-dropdown"]').forEach(d => {
            if (d !== dropdown) d.style.display = 'none';
        });

        dropdown.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
            searchInput.value = '';
            renderList();
            setTimeout(() => searchInput.focus(), 30);
        }
    };

    btn.addEventListener('click', toggleHandler);

    // Search filter
    searchInput.addEventListener('input', () => {
        renderList(searchInput.value);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());

    // Click item
    listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.subtitle-lang-item');
        if (!item) return;
        const val = item.dataset.value;
        const txt = item.dataset.name;
        hiddenInput.value = val;
        btn.querySelector('span').textContent = txt;
        dropdown.style.display = 'none';
        localStorage.setItem(storageKey, val);

        // Trigger change event
        const event = new Event('change', { bubbles: true });
        hiddenInput.dispatchEvent(event);
    });

    // Hover effect
    listEl.addEventListener('mouseover', (e) => {
        const item = e.target.closest('.subtitle-lang-item');
        if (item) item.style.background = 'rgba(255,255,255,0.08)';
    });
    listEl.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.subtitle-lang-item');
        if (item) item.style.background = hiddenInput.value === item.dataset.value ? 'rgba(76,158,255,0.12)' : '';
    });

    // Click outside to close
    const outsideClickHandler = (e) => {
        if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    };
    document.addEventListener('click', outsideClickHandler);
}

function initSubtitleLangPicker() {
    initSearchableLangPicker({
        btnId: 'subtitle-lang-picker-btn',
        dropdownId: 'subtitle-lang-dropdown',
        searchId: 'subtitle-lang-search',
        listId: 'subtitle-lang-list',
        hiddenInputId: 'language',
        storageKey: SUBTITLE_LANG_STORAGE_KEY,
        defaultText: '英语',
        defaultValue: '英语',
        hasAuto: false
    });
}

function initAutoEditLangPicker() {
    initSearchableLangPicker({
        btnId: 'autoedit-lang-picker-btn',
        dropdownId: 'autoedit-lang-dropdown',
        searchId: 'autoedit-lang-search',
        listId: 'autoedit-lang-list',
        hiddenInputId: 'autoedit-language',
        storageKey: 'autoedit_align_language',
        defaultText: '自动识别',
        defaultValue: 'auto',
        hasAuto: true
    });
}

function initVoiceoverWorkflowLangPicker() {
    initSearchableLangPicker({
        btnId: 'vw-align-lang-picker-btn',
        dropdownId: 'vw-align-lang-dropdown',
        searchId: 'vw-align-lang-search',
        listId: 'vw-align-lang-list',
        hiddenInputId: 'vw-align-lang',
        storageKey: 'voiceover_workflow_align_language',
        defaultText: '中文',
        defaultValue: '中文',
        hasAuto: false
    });
}

// 心跳检测，保持后端活跃
let heartbeatInterval = null;
let lastHeartbeatSuccess = true;

function startHeartbeat() {
    // 每30秒发送一次心跳
    heartbeatInterval = setInterval(async () => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await apiFetch(`${API_BASE}/health`, {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) {
                if (!lastHeartbeatSuccess || !backendReady) {
                    // 之前断开了，现在恢复了
                    updateStatus('后端服务已恢复连接', 'success');
                    backendReady = true;
                    healthCheckSlowMode = false;
                    healthCheckRetries = 0;
                    if (!settingsAutoLoaded) {
                        settingsAutoLoaded = true;
                        loadSettings(true);
                    }
                    showToast('✅ 后端服务已恢复', 'success');
                    lastHeartbeatSuccess = true;
                }
            } else {
                throw new Error('后端响应异常');
            }
        } catch (error) {
            if (lastHeartbeatSuccess) {
                // 之前正常，现在断开了
                updateStatus('后端服务连接断开，尝试重连...', 'error');
                lastHeartbeatSuccess = false;
                backendReady = false;
                // 重新开始健康检查（会尝试重连）
                healthCheckRetries = 0;
                healthCheckSlowMode = false;
                checkBackendHealth();
            }
        }
    }, 30000); // 30秒
}

// 添加 Toast 样式
function addToastStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .toast {
            position: fixed;
            top: 80px;
            left: 50%;
            transform: translateX(-50%) translateY(-20px);
            padding: 12px 24px;
            background: rgba(0, 0, 0, 0.9);
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 9999;
            opacity: 0;
            transition: all 0.3s ease;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            max-width: 80%;
        }
        .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
        .toast-success { border-left: 4px solid #00d9a5; }
        .toast-error { border-left: 4px solid #ff4757; }
        .toast-info { border-left: 4px solid #3498db; }
        .toast-icon { font-size: 16px; font-weight: bold; }
        .toast-success .toast-icon { color: #00d9a5; }
        .toast-error .toast-icon { color: #ff4757; }
        .toast-info .toast-icon { color: #3498db; }
        .toast-message { color: white; font-size: 14px; }
    `;
    document.head.appendChild(style);
}

// 标签页切换
function initTabs() {
    const tabs = document.querySelectorAll('.tab');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            openPanelByName(tab.dataset.tab);
        });
    });
}

function openPanelByName(tabName) {
    if (tabName === 'media' && typeof mtbRestorePortedNodes === 'function') {
        mtbRestorePortedNodes(true);
    }

    const tabs = document.querySelectorAll('.tab');
    const panels = document.querySelectorAll('.panel');
    const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
    const panel = document.getElementById(`${tabName}-panel`);

    if (!tab || !panel) return;

    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));

    tab.classList.add('active');
    panel.classList.add('active');

    const content = document.querySelector('.content');
    if (content?.scrollTo) {
        content.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (content) {
        content.scrollTop = 0;
    }
}

// 子标签页切换
function initSubTabs() {
    const subTabs = document.querySelectorAll('.sub-tab');

    subTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const parent = tab.parentElement.parentElement;
            parent.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
            parent.querySelectorAll('.subtab-content').forEach(c => c.classList.remove('active'));

            tab.classList.add('active');
            const contentId = tab.dataset.subtab + '-subtab';
            document.getElementById(contentId).classList.add('active');

            // 有独立文件输入的子模块，隐藏顶部通用文件输入区域
            const mediaFileSection = document.getElementById('media-file-section');
            if (mediaFileSection) {
                const tabsWithOwnInput = ['media-scene', 'media-smartkf', 'media-thumbnail', 'media-classify', 'media-lipsync', 'media-batchcut', 'media-autoedit', 'media-batchtxt', 'media-unirename', 'media-audiomatch'];
                mediaFileSection.style.display = tabsWithOwnInput.includes(tab.dataset.subtab) ? 'none' : '';
            }

            // 刷新对应的预览
            if (contentId === 'media-logo-subtab') {
                setTimeout(updateLogoPreview, 100);
            } else if (contentId === 'media-watermark-subtab') {
                setTimeout(updateWatermarkPreview, 100);
            }

        });
    });
}

// 初始化媒体工具侧边栏导航
function initMediaSidebar() {
    const sidebarItems = document.querySelectorAll('.media-sidebar .sidebar-item');
    if (sidebarItems.length === 0) return;

    sidebarItems.forEach(item => {
        item.addEventListener('click', () => {
            // 切换高亮状态
            sidebarItems.forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const action = item.dataset.action;
            if (action === 'subtab') {
                const subtabId = item.dataset.subtab;
                switchMediaSubtab(subtabId);
            } else if (action === 'format') {
                const mode = item.dataset.mode;
                switchMediaSubtab('media-format');
                const radio = document.querySelector(`input[name="format-mode"][value="${mode}"]`);
                if (radio) {
                    radio.checked = true;
                    radio.dispatchEvent(new Event('change', { bubbles: true }));
                }

                // 更新当前选中的格式标题
                const titleEl = document.getElementById('active-format-title');
                if (titleEl) {
                    const formatDescriptions = {
                        'h264': '通用 MP4 输出，适合上传和预览',
                        'x264': '高效 H.264 压缩，在保持画质的同时大幅减小视频体积',
                        'dnxhr': '达芬奇/剪映等剪辑软件的代理/高画质编辑格式',
                        'dnxhr_hqx': '达芬奇/剪映等剪辑软件的高动态 10bit 编辑格式',
                        'mp3': '从视频/音频中提取并转换为 MP3 格式',
                        'wav': '将各类媒体文件中的音频提取或转换为无损 WAV 格式',
                        'audio_black': '将音频转换为带黑屏画面的 MP4 视频，方便上传视频平台',
                        'audio_split': '批量对音频文件进行高精度裁切与分段导出',
                        'audio_fx': '批量应用淡入淡出、变速变调等音频特效',
                        'png': '批量将图片格式转换为无损 PNG',
                        'jpg': '批量将图片格式转换为 JPG 格式',
                        'jpeg': '批量将图片格式转换为 JPEG 格式',
                        'txt_wrap': '智能按语义、符号或长度对文本文件进行分行处理'
                    };
                    const formatName = item.textContent.trim();
                    const formatDesc = formatDescriptions[mode] || '';
                    if (formatDesc) {
                        titleEl.innerHTML = `<span class="workbench-title">${formatName}</span><span class="workbench-title-desc">${formatDesc}</span>`;
                    } else {
                        titleEl.innerHTML = `<span class="workbench-title">${formatName}</span>`;
                    }
                    titleEl.style.display = '';
                }
            }
        });
    });

    // 初始化时，触发当前 active 项的点击事件以初始化状态
    const activeItem = document.querySelector('.media-sidebar .sidebar-item.active');
    if (activeItem) {
        activeItem.click();
    }
}

// 切换媒体子版块显示状态
function switchMediaSubtab(subtabId) {
    const panel = document.getElementById('media-panel');
    if (!panel) return;

    // 隐藏所有子版块，并显示选中的版块
    panel.querySelectorAll('.subtab-content').forEach(content => {
        content.classList.toggle('active', content.id === `${subtabId}-subtab`);
    });

    // 非格式转换板块下，隐藏当前格式标题
    if (subtabId !== 'media-format') {
        const titleEl = document.getElementById('active-format-title');
        if (titleEl) titleEl.style.display = 'none';
    }

    // 控制通用输入框可见性
    const mediaFileSection = document.getElementById('media-file-section');
    if (mediaFileSection) {
        const tabsWithOwnInput = ['media-scene', 'media-smartkf', 'media-thumbnail', 'media-classify', 'media-lipsync', 'media-batchcut', 'media-autoedit', 'media-batchtxt', 'media-unirename', 'media-batchrename', 'media-audiomatch'];
        mediaFileSection.style.display = tabsWithOwnInput.includes(subtabId) ? 'none' : '';
    }

    // 文案自动剪辑使用“分析 → 审核 → 导出”独立流程，隐藏旧版通用转换状态和按钮。
    const hideSharedConvertAction = subtabId === 'media-autoedit';
    const mediaStatusSection = document.getElementById('media-status-section');
    const mediaStartButton = document.getElementById('media-start-btn');
    if (mediaStatusSection) mediaStatusSection.style.display = hideSharedConvertAction ? 'none' : '';
    if (mediaStartButton) mediaStartButton.style.display = hideSharedConvertAction ? 'none' : '';

    // 刷新 Logo 或水印预览
    if (subtabId === 'media-logo') {
        setTimeout(updateLogoPreview, 100);
    } else if (subtabId === 'media-watermark') {
        setTimeout(updateWatermarkPreview, 100);
    }
}

// 初始化 Audio 播放器
function initAudioPlayer() {
    audioPlayer = document.getElementById('tts-audio');
    const seekSlider = document.getElementById('seek-slider');
    const btnPlay = document.getElementById('btn-play');

    if (!audioPlayer) return;

    audioPlayer.addEventListener('loadedmetadata', () => {
        seekSlider.max = Math.floor(audioPlayer.duration);
        document.getElementById('total-time').textContent = formatTime(audioPlayer.duration);
        seekSlider.disabled = false;
        btnPlay.disabled = false;
    });

    audioPlayer.addEventListener('timeupdate', () => {
        if (!seekSlider.dragging) {
            seekSlider.value = Math.floor(audioPlayer.currentTime);
            document.getElementById('current-time').textContent = formatTime(audioPlayer.currentTime);
        }
    });

    audioPlayer.addEventListener('ended', () => {
        btnPlay.textContent = '▶ 播放';
        seekSlider.value = 0;
        document.getElementById('current-time').textContent = '00:00';
    });

    seekSlider.addEventListener('input', () => {
        audioPlayer.currentTime = seekSlider.value;
        document.getElementById('current-time').textContent = formatTime(seekSlider.value);
    });

    // 稳定性滑块
    const stabilitySlider = document.getElementById('tts-stability');
    if (stabilitySlider) {
        stabilitySlider.addEventListener('input', (e) => {
            document.getElementById('stability-value').textContent = e.target.value + '%';
        });
    }
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function togglePlayback() {
    const btnPlay = document.getElementById('btn-play');

    if (audioPlayer.paused) {
        audioPlayer.play();
        btnPlay.textContent = '⏸ 暂停';
    } else {
        audioPlayer.pause();
        btnPlay.textContent = '▶ 继续';
    }
}

// 初始化文件输入
function initFileInputs() {
    // 音频文件
    document.getElementById('audio-file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            currentAudioPath = getFileNativePath(file);
            document.getElementById('audio-path').value = file.name;
            showToast(`已选择: ${file.name}`, 'success');
        }
    });

    // 原文本文件
    document.getElementById('source-file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('source-text').value = ev.target.result;
                showToast('原文本已加载', 'success');
            };
            reader.readAsText(file);
        }
    });

    // 翻译文本文件
    document.getElementById('translate-file-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('translate-text').value = ev.target.result;
                showToast('翻译文本已加载', 'success');
            };
            reader.readAsText(file);
        }
    });

    // SRT 文件
    document.getElementById('srt-src-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            currentSrtSrcPath = getFileNativePath(file);
            document.getElementById('srt-src-path').value = file.name;
        }
    });

    document.getElementById('srt-orgi-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            currentSrtOrgiPath = getFileNativePath(file);
            document.getElementById('srt-orgi-path').value = file.name;
        }
    });

    document.getElementById('srt-ref-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            currentSrtRefPath = getFileNativePath(file);
            document.getElementById('srt-ref-path').value = file.name;
        }
    });

    document.getElementById('seamless-srt-input').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            const file = e.target.files[0];
            currentSeamlessSrtPath = getFileNativePath(file);
            document.getElementById('seamless-srt-path').value = file.name;
        }
    });

    // 媒体文件
    document.getElementById('media-input-file').addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            currentMediaFileInfos = Array.from(e.target.files).map(f => ({
                path: getFileNativePath(f),
                name: f.name,
                file: f  // 保存 File 对象引用，用于创建 blob URL 播放
            }));
            currentMediaFiles = currentMediaFileInfos.map(item => item.path);
            document.getElementById('media-input-path').value =
                e.target.files.length === 1 ? e.target.files[0].name : `${e.target.files.length} 个文件`;
            renderAudioSplitFileList();
        }
    });

    // 声音搜索回车
    const voiceSearchInput = document.getElementById('voice-search-input');
    if (voiceSearchInput) {
        voiceSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchVoices();
            }
        });
    }
}

function renderAudioSplitFileList() {
    const list = document.getElementById('audio-split-file-list');
    if (!list) return;

    list.innerHTML = '';

    // 隐藏旧的全局预览播放器
    const globalPlayer = document.getElementById('audio-preview-player');
    if (globalPlayer) globalPlayer.style.display = 'none';

    if (currentMediaFileInfos.length === 0) {
        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.textContent = '请先选择文件。';
        list.appendChild(hint);
        return;
    }

    const nextCutPoints = {};

    currentMediaFileInfos.forEach((file, idx) => {
        // 创建文件卡片
        const card = document.createElement('div');
        card.className = 'audio-file-card';
        card.dataset.idx = idx;
        card.style.cssText = 'background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.05);';

        // 顶部：文件名 + 时长 + 状态
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';

        const playBtn = document.createElement('button');
        playBtn.className = 'btn btn-secondary';
        playBtn.style.cssText = 'padding: 4px 8px; font-size: 12px;';
        playBtn.textContent = '▶️';
        playBtn.onclick = () => playAudioInCard(idx, file);

        const name = document.createElement('div');
        name.style.cssText = 'flex: 1; font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        name.textContent = file.name || `文件 ${idx + 1}`;
        name.title = file.name;

        const duration = document.createElement('span');
        duration.className = 'audio-card-duration';
        duration.id = `audio-card-duration-${idx}`;
        duration.style.cssText = 'font-size: 11px; color: var(--text-muted);';
        duration.textContent = '--:--';

        const status = document.createElement('span');
        status.className = 'audio-card-status';
        status.id = `audio-card-status-${idx}`;
        status.style.cssText = 'font-size: 11px; padding: 2px 6px; border-radius: 3px; background: rgba(128,128,128,0.2); color: var(--text-muted);';
        status.textContent = '待分析';

        header.appendChild(playBtn);
        header.appendChild(name);
        header.appendChild(duration);
        header.appendChild(status);

        // 波形图容器
        const waveformContainer = document.createElement('div');
        waveformContainer.style.cssText = 'position: relative; height: 50px; margin-bottom: 8px; background: var(--bg-secondary); border-radius: 4px; overflow: hidden; cursor: pointer;';
        waveformContainer.dataset.idx = idx;

        const canvas = document.createElement('canvas');
        canvas.id = `audio-waveform-${idx}`;
        canvas.style.cssText = 'width: 100%; height: 100%; pointer-events: none;';

        const progress = document.createElement('div');
        progress.id = `audio-progress-${idx}`;
        progress.style.cssText = 'position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: rgba(102, 126, 234, 0.3); pointer-events: none;';

        // 播放光标
        const cursor = document.createElement('div');
        cursor.id = `audio-cursor-${idx}`;
        cursor.style.cssText = 'position: absolute; top: 0; bottom: 0; width: 2px; background: #f87171; left: 0%; pointer-events: none; display: none;';

        const loading = document.createElement('div');
        loading.id = `audio-loading-${idx}`;
        loading.style.cssText = 'position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-muted); font-size: 11px;';
        loading.textContent = '加载波形...';

        // 点击/拖拽跳转
        const seekToPosition = (e) => {
            const audio = document.getElementById(`audio-element-${idx}`);
            if (!audio) return;

            // 如果音频还没加载，先加载
            if (!audio.src && file.file) {
                audio.src = URL.createObjectURL(file.file);
            }

            // 获取时长（从音频或从 audioCardData）
            const duration = audio.duration || window.audioCardData?.[idx]?.duration;
            if (!duration) return;

            const rect = waveformContainer.getBoundingClientRect();
            const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
            const ratio = x / rect.width;

            // 如果音频已加载完成，直接跳转
            if (audio.readyState >= 1) {
                audio.currentTime = ratio * duration;
            } else {
                // 等待元数据加载完成后跳转
                audio.onloadedmetadata = () => {
                    audio.currentTime = ratio * audio.duration;
                };
            }

            // 更新光标
            cursor.style.left = (ratio * 100) + '%';
            cursor.style.display = 'block';
            progress.style.width = (ratio * 100) + '%';
        };

        waveformContainer.addEventListener('click', seekToPosition);

        // 拖拽支持
        let isDragging = false;
        waveformContainer.addEventListener('mousedown', (e) => {
            isDragging = true;
            seekToPosition(e);
            e.preventDefault();  // 防止选中文字
        });
        waveformContainer.addEventListener('mousemove', (e) => {
            if (isDragging) {
                seekToPosition(e);
            }
        });
        waveformContainer.addEventListener('mouseup', () => {
            isDragging = false;
        });
        waveformContainer.addEventListener('mouseleave', () => {
            isDragging = false;
        });

        waveformContainer.appendChild(canvas);
        waveformContainer.appendChild(progress);
        waveformContainer.appendChild(cursor);
        waveformContainer.appendChild(loading);

        // 分割点输入
        const cutRow = document.createElement('div');
        cutRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        const cutLabel = document.createElement('span');
        cutLabel.style.cssText = 'font-size: 11px; color: var(--text-muted); white-space: nowrap;';
        cutLabel.textContent = '分割点:';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input';
        input.id = `audio-cut-points-${idx}`;
        input.placeholder = '例如: 12.5, 01:10, 02:30.5';
        input.value = currentAudioCutPoints[file.path] || '';
        input.style.cssText = 'flex: 1; padding: 4px 8px; font-size: 12px;';
        input.addEventListener('input', () => {
            currentAudioCutPoints[file.path] = input.value;
        });

        const addCutBtn = document.createElement('button');
        addCutBtn.className = 'btn btn-secondary';
        addCutBtn.style.cssText = 'padding: 4px 8px; font-size: 11px;';
        addCutBtn.textContent = '✂️';
        addCutBtn.title = '在当前播放位置添加分割点';
        addCutBtn.onclick = () => addCutPointToCard(idx, file.path);

        if (currentAudioCutPoints[file.path]) {
            nextCutPoints[file.path] = currentAudioCutPoints[file.path];
        }

        cutRow.appendChild(cutLabel);
        cutRow.appendChild(input);
        cutRow.appendChild(addCutBtn);

        // 隐藏的 audio 元素
        const audio = document.createElement('audio');
        audio.id = `audio-element-${idx}`;
        audio.style.display = 'none';

        card.appendChild(header);
        card.appendChild(waveformContainer);
        card.appendChild(cutRow);
        card.appendChild(audio);
        list.appendChild(card);

        // 异步生成波形
        if (file.file) {
            generateWaveformForCard(idx, file.file);
        }
    });

    currentAudioCutPoints = nextCutPoints;

    // 更新智能分割按钮状态
    if (typeof updateSmartSplitButtonState === 'function') {
        updateSmartSplitButtonState();
    }
}

// 检测是否为视频文件（通过文件扩展名或 MIME 类型）
function isVideoFile(file) {
    const videoExtensions = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
    const fileName = file.name?.toLowerCase() || '';
    const mimeType = file.type?.toLowerCase() || '';

    return videoExtensions.some(ext => fileName.endsWith(ext)) || mimeType.startsWith('video/');
}

// 为单个卡片生成波形
async function generateWaveformForCard(idx, fileObj) {
    const canvas = document.getElementById(`audio-waveform-${idx}`);
    const loading = document.getElementById(`audio-loading-${idx}`);
    const durationEl = document.getElementById(`audio-card-duration-${idx}`);
    if (!canvas) return;

    try {
        // 检测是否为视频文件 - 视频文件无法使用 Web Audio API 解码
        if (isVideoFile(fileObj)) {
            // 对于视频文件，使用 video 元素获取时长
            await generateWaveformForVideo(idx, fileObj, canvas, loading, durationEl);
            return;
        }

        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await fileObj.arrayBuffer();

        let audioBuffer;
        try {
            audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (decodeError) {
            console.warn('音频解码失败，尝试使用媒体元素:', decodeError.message);
            audioContext.close();
            // 解码失败时，回退到视频处理方式
            await generateWaveformForVideo(idx, fileObj, canvas, loading, durationEl);
            return;
        }

        // 更新时长显示
        if (durationEl) {
            durationEl.textContent = formatTimeAudio(audioBuffer.duration);
        }

        // 获取音频数据
        const channelData = audioBuffer.getChannelData(0);
        const samples = 150;
        const blockSize = Math.floor(channelData.length / samples);
        const peaks = [];

        for (let i = 0; i < samples; i++) {
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(channelData[i * blockSize + j]);
            }
            peaks.push(sum / blockSize);
        }

        const maxPeak = Math.max(...peaks);
        const normalizedPeaks = peaks.map(p => p / maxPeak);

        // 保存数据
        if (!window.audioCardData) window.audioCardData = {};
        window.audioCardData[idx] = {
            peaks: normalizedPeaks,
            duration: audioBuffer.duration
        };

        // 绘制波形
        drawWaveform(canvas, normalizedPeaks);
        if (loading) loading.style.display = 'none';

        audioContext.close();
    } catch (error) {
        console.error('波形生成失败:', error);
        if (loading) {
            loading.textContent = '无法加载波形';
            loading.style.color = 'var(--text-muted)';
        }
        // 尝试使用备用方法获取时长
        try {
            await generateWaveformForVideo(idx, fileObj, canvas, loading, durationEl);
        } catch (fallbackError) {
            console.error('备用方法也失败:', fallbackError);
        }
    }
}

// 为视频文件生成简单的占位波形并获取时长
async function generateWaveformForVideo(idx, fileObj, canvas, loading, durationEl) {
    return new Promise((resolve, reject) => {
        const mediaElement = document.createElement('video');
        const blobUrl = URL.createObjectURL(fileObj);

        mediaElement.preload = 'metadata';
        mediaElement.muted = true;

        const timeout = setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            if (loading) {
                loading.textContent = '视频文件 (无波形)';
                loading.style.fontSize = '10px';
            }
            resolve();
        }, 10000); // 10秒超时

        mediaElement.onloadedmetadata = () => {
            clearTimeout(timeout);
            const duration = mediaElement.duration;

            // 更新时长显示
            if (durationEl && isFinite(duration)) {
                durationEl.textContent = formatTimeAudio(duration);
            }

            // 保存数据（生成简单的占位波形）
            if (!window.audioCardData) window.audioCardData = {};
            const fakePeaks = Array(150).fill(0).map(() => 0.3 + Math.random() * 0.4);
            window.audioCardData[idx] = {
                peaks: fakePeaks,
                duration: duration
            };

            // 绘制简单的占位波形
            drawWaveform(canvas, fakePeaks);

            if (loading) {
                loading.textContent = '🎬 视频';
                loading.style.fontSize = '10px';
                loading.style.background = 'rgba(102, 126, 234, 0.2)';
                loading.style.padding = '2px 6px';
                loading.style.borderRadius = '3px';
                loading.style.position = 'absolute';
                loading.style.top = '4px';
                loading.style.right = '4px';
                loading.style.left = 'auto';
                loading.style.bottom = 'auto';
                loading.style.display = 'block';
            }

            URL.revokeObjectURL(blobUrl);
            resolve();
        };

        mediaElement.onerror = (e) => {
            clearTimeout(timeout);
            console.error('视频元数据加载失败:', e);
            if (loading) {
                loading.textContent = '无法加载';
            }
            URL.revokeObjectURL(blobUrl);
            reject(new Error('视频加载失败'));
        };

        mediaElement.src = blobUrl;
    });
}

// 播放卡片中的音频
function playAudioInCard(idx, file) {
    const audio = document.getElementById(`audio-element-${idx}`);
    const playBtn = document.querySelector(`.audio-file-card[data-idx="${idx}"] button`);
    if (!audio || !file.file) return;

    if (audio.paused) {
        // 停止其他正在播放的
        document.querySelectorAll('.audio-file-card audio').forEach(a => {
            if (a.id !== `audio-element-${idx}`) {
                a.pause();
            }
        });
        document.querySelectorAll('.audio-file-card button').forEach(b => {
            if (b.textContent === '⏸️') b.textContent = '▶️';
        });

        if (!audio.src) {
            audio.src = URL.createObjectURL(file.file);
        }
        audio.play();
        playBtn.textContent = '⏸️';

        // 更新进度和光标
        audio.ontimeupdate = () => {
            const progress = document.getElementById(`audio-progress-${idx}`);
            const cursor = document.getElementById(`audio-cursor-${idx}`);
            if (audio.duration) {
                const ratio = (audio.currentTime / audio.duration * 100);
                if (progress) progress.style.width = ratio + '%';
                if (cursor) {
                    cursor.style.left = ratio + '%';
                    cursor.style.display = 'block';
                }
            }
        };
    } else {
        audio.pause();
        playBtn.textContent = '▶️';
    }
}

// 在卡片当前播放位置添加分割点
function addCutPointToCard(idx, filePath) {
    const audio = document.getElementById(`audio-element-${idx}`);
    const input = document.getElementById(`audio-cut-points-${idx}`);
    if (!audio || !input) return;

    const currentTime = audio.currentTime;
    if (currentTime <= 0) {
        showToast('请先播放音频到目标位置', 'warning');
        return;
    }

    const timeStr = formatTimeAudio(currentTime);
    const existing = input.value.trim();
    input.value = existing ? existing + ', ' + timeStr : timeStr;
    currentAudioCutPoints[filePath] = input.value;

    showToast(`已添加分割点: ${timeStr}`, 'success');
}

// ==================== 音频预览功能 ====================

let currentPreviewBlobUrl = null;

function loadAudioForPreview(filePath, fileName, fileObj) {
    const audio = document.getElementById('audio-preview-element');
    const nameEl = document.getElementById('audio-preview-name');
    const seekSlider = document.getElementById('audio-preview-seek');
    const durationEl = document.getElementById('audio-preview-duration');
    const playBtn = document.getElementById('audio-preview-play');

    if (!audio) return;

    currentPreviewFilePath = filePath;
    nameEl.textContent = fileName || '加载中...';

    // 更新智能分割按钮状态
    if (typeof updateSmartSplitButtonState === 'function') {
        updateSmartSplitButtonState();
    }

    // 释放之前的 blob URL
    if (currentPreviewBlobUrl) {
        URL.revokeObjectURL(currentPreviewBlobUrl);
        currentPreviewBlobUrl = null;
    }

    // 使用 File 对象创建 blob URL（解决浏览器安全限制）
    if (fileObj) {
        currentPreviewBlobUrl = URL.createObjectURL(fileObj);
        audio.src = currentPreviewBlobUrl;
    } else {
        // 回退到后端代理
        audio.src = `${API_BASE}/file/proxy?path=${encodeURIComponent(filePath)}`;
    }

    audio.load();

    audio.onloadedmetadata = () => {
        seekSlider.max = audio.duration;  // 使用精确值
        seekSlider.step = 0.1;  // 更精细的步进
        durationEl.textContent = `00:00 / ${formatTimeAudio(audio.duration)}`;
    };

    audio.ontimeupdate = () => {
        seekSlider.value = audio.currentTime;  // 使用精确浮点值
        durationEl.textContent = `${formatTimeAudio(audio.currentTime)} / ${formatTimeAudio(audio.duration)}`;
        updateWaveformProgress(audio.currentTime, audio.duration);
    };

    audio.onended = () => {
        playBtn.textContent = '▶️';
    };

    // 滑杆拖动
    seekSlider.oninput = () => {
        audio.currentTime = seekSlider.value;
    };

    playBtn.textContent = '▶️';

    // 生成波形
    if (fileObj) {
        generateWaveform(fileObj);
    }

    // 波形点击跳转
    const waveformContainer = document.getElementById('audio-waveform-container');
    waveformContainer.onclick = (e) => {
        const rect = waveformContainer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const ratio = x / rect.width;
        if (audio.duration) {
            audio.currentTime = ratio * audio.duration;
        }
    };
}

function toggleAudioPreview() {
    const audio = document.getElementById('audio-preview-element');
    const playBtn = document.getElementById('audio-preview-play');

    if (!audio || !audio.src) return;

    if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸️';
    } else {
        audio.pause();
        playBtn.textContent = '▶️';
    }
}

function addCutPointAtCurrentTime() {
    const audio = document.getElementById('audio-preview-element');
    if (!audio || !currentPreviewFilePath) {
        showToast('请先选择要播放的音频', 'warning');
        return;
    }

    const currentTime = audio.currentTime;
    const timeStr = formatTimeAudio(currentTime);

    // 找到对应文件的输入框
    const fileIdx = currentMediaFileInfos.findIndex(f => f.path === currentPreviewFilePath);
    if (fileIdx === -1) return;

    const input = document.getElementById(`audio-cut-points-${fileIdx}`);
    if (!input) return;

    // 添加裁切点
    const existing = input.value.trim();
    if (existing) {
        input.value = existing + ', ' + timeStr;
    } else {
        input.value = timeStr;
    }

    // 更新缓存
    currentAudioCutPoints[currentPreviewFilePath] = input.value;

    showToast(`已添加裁切点: ${timeStr}`, 'success');
}

function formatTimeAudio(seconds) {
    if (isNaN(seconds)) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
}

// 波形进度更新
function updateWaveformProgress(currentTime, duration) {
    const progress = document.getElementById('audio-waveform-progress');
    const cursor = document.getElementById('audio-waveform-cursor');
    if (!progress || !cursor || !duration) return;

    const ratio = currentTime / duration;
    progress.style.width = (ratio * 100) + '%';
    cursor.style.left = (ratio * 100) + '%';
}

// 存储当前波形数据
let currentWaveformData = {
    peaks: [],
    duration: 0,
    canvas: null
};

// 生成音频波形
async function generateWaveform(fileObj) {
    const canvas = document.getElementById('audio-waveform-canvas');
    const loading = document.getElementById('audio-waveform-loading');
    if (!canvas) return;

    loading.style.display = 'flex';

    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await fileObj.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        // 获取音频数据
        const channelData = audioBuffer.getChannelData(0);
        const samples = 200; // 采样点数量
        const blockSize = Math.floor(channelData.length / samples);
        const peaks = [];

        for (let i = 0; i < samples; i++) {
            let sum = 0;
            for (let j = 0; j < blockSize; j++) {
                sum += Math.abs(channelData[i * blockSize + j]);
            }
            peaks.push(sum / blockSize);
        }

        // 归一化
        const maxPeak = Math.max(...peaks);
        const normalizedPeaks = peaks.map(p => p / maxPeak);

        // 保存波形数据
        currentWaveformData = {
            peaks: normalizedPeaks,
            duration: audioBuffer.duration,
            canvas: canvas
        };

        // 绘制波形（初始无分割点）
        drawWaveform(canvas, normalizedPeaks);
        loading.style.display = 'none';

        audioContext.close();
    } catch (error) {
        console.error('波形生成失败:', error);
        loading.textContent = '波形加载失败';
    }
}

function drawWaveform(canvas, peaks, cutPoints = [], totalDuration = 0) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const barWidth = w / peaks.length;
    const midY = h / 2;

    ctx.clearRect(0, 0, w, h);

    // 绘制波形条
    peaks.forEach((peak, i) => {
        const barHeight = peak * (h * 0.8);
        const x = i * barWidth;

        // 渐变颜色：有声音的部分较亮，静音部分较暗
        const intensity = peak;
        const r = Math.floor(102 + intensity * 50);
        const g = Math.floor(126 + intensity * 30);
        const b = Math.floor(234);

        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.4 + intensity * 0.5})`;
        ctx.fillRect(x, midY - barHeight / 2, barWidth - 1, barHeight);
    });

    // 绘制分割点标记线
    if (cutPoints.length > 0 && totalDuration > 0) {
        ctx.strokeStyle = '#f87171';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);

        cutPoints.forEach((cutTime, idx) => {
            if (cutTime <= 0 || cutTime >= totalDuration) return;
            const x = (cutTime / totalDuration) * w;

            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();

            // 分割点标签
            ctx.fillStyle = '#f87171';
            ctx.font = '10px sans-serif';
            ctx.fillText(`#${idx + 1}`, x + 2, 10);
        });

        ctx.setLineDash([]);
    }
}

function initMediaModeOptions() {
    // 拖拽文件支持
    const dropZone = document.getElementById('media-drop-zone');
    const fileInput = document.getElementById('media-input-file');

    if (dropZone && fileInput) {
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.style.borderColor = 'var(--accent)';
                dropZone.style.background = 'rgba(255,255,255,0.05)';
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.style.borderColor = 'var(--border-color)';
                dropZone.style.background = '';
            });
        });

        dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                // 触发文件输入的 change 事件
                const dataTransfer = new DataTransfer();
                for (const file of files) {
                    dataTransfer.items.add(file);
                }
                fileInput.files = dataTransfer.files;
                fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }

    // Logo 预设切换：显示/隐藏自定义 Logo 设置
    const logoPresets = document.querySelectorAll('input[name="logo-preset"]');
    const customLogoOptions = document.getElementById('custom-logo-options');

    logoPresets.forEach(radio => {
        radio.addEventListener('change', () => {
            if (radio.value === 'custom' && radio.checked) {
                customLogoOptions?.classList.remove('hidden');
            } else {
                customLogoOptions?.classList.add('hidden');
            }
            // 自动加载该预设的默认位置
            resetLogoPosition();
        });
    });

    // 自定义 Logo 文件选择
    const customLogoFile = document.getElementById('custom-logo-file');
    if (customLogoFile) {
        customLogoFile.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                document.getElementById('custom-logo-path').value = file.name;
                // 存储文件路径
                customLogoFile.dataset.filePath = getFileNativePath(file);
                showToast(`已选择 Logo: ${file.name}`, 'success');
                updateLogoPreview();
            }
        });
    }

    // 水印位置切换
    const watermarkPosition = document.getElementById('watermark-position');
    const watermarkCustomPos = document.getElementById('watermark-custom-pos');

    if (watermarkPosition) {
        watermarkPosition.addEventListener('change', () => {
            if (watermarkPosition.value === 'custom') {
                watermarkCustomPos.style.display = 'flex';
            } else {
                watermarkCustomPos.style.display = 'none';
            }
        });
    }

    // 水印预设文本选择
    const watermarkPreset = document.getElementById('watermark-preset');
    const watermarkText = document.getElementById('watermark-text');

    if (watermarkPreset && watermarkText) {
        watermarkPreset.addEventListener('change', () => {
            if (watermarkPreset.value) {
                watermarkText.value = watermarkPreset.value;
                updateWatermarkPreview();
            }
        });
    }

    // 水印颜色同步（颜色选择器 <-> 文本输入）
    const watermarkColor = document.getElementById('watermark-color');
    const watermarkColorText = document.getElementById('watermark-color-text');

    if (watermarkColor && watermarkColorText) {
        watermarkColor.addEventListener('input', () => {
            watermarkColorText.value = watermarkColor.value;
        });
        watermarkColorText.addEventListener('input', () => {
            if (/^#[0-9A-Fa-f]{6}$/.test(watermarkColorText.value)) {
                watermarkColor.value = watermarkColorText.value;
            }
        });
    }

    // 水印透明度标签
    const watermarkOpacity = document.getElementById('watermark-opacity');
    const opacityLabel = document.getElementById('watermark-opacity-label');

    if (watermarkOpacity && opacityLabel) {
        watermarkOpacity.addEventListener('input', () => {
            opacityLabel.textContent = Math.round(watermarkOpacity.value * 100) + '%';
            updateWatermarkPreview();
        });
    }

    // 防抖函数，避免预览闪烁
    const debounce = (fn, delay = 100) => {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    };

    const debouncedWatermarkPreview = debounce(updateWatermarkPreview, 150);
    const debouncedLogoPreview = debounce(updateLogoPreview, 150);

    // 为所有水印参数添加变化监听器，自动刷新预览（带防抖）
    const watermarkInputs = [
        'watermark-text', 'watermark-font', 'watermark-fontsize', 'watermark-color',
        'watermark-stroke', 'watermark-stroke-color', 'watermark-stroke-width',
        'watermark-shadow', 'watermark-position', 'watermark-offset-x', 'watermark-offset-y',
        'watermark-opacity'
    ];
    watermarkInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', debouncedWatermarkPreview);
            el.addEventListener('change', debouncedWatermarkPreview);
        }
    });

    // 为 Logo 参数添加变化监听器（实时刷新预览）
    const logoInputs = ['logo-pos-x', 'logo-pos-y', 'logo-width', 'logo-height'];
    logoInputs.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', debouncedLogoPreview);
            el.addEventListener('change', debouncedLogoPreview);
        }
    });

    const formatModes = document.querySelectorAll('input[name="format-mode"]');
    const audioSplitOptions = document.getElementById('audio-split-options');
    const audioFxOptions = document.getElementById('audio-fx-options');
    const txtWrapOptions = document.getElementById('txt-wrap-options');
    const updateFormatOptions = () => {
        const selected = document.querySelector('input[name="format-mode"]:checked')?.value;
        if (selected === 'audio_split') {
            audioSplitOptions?.classList.remove('hidden');
            renderAudioSplitFileList();
        } else {
            audioSplitOptions?.classList.add('hidden');
        }
        
        if (selected === 'audio_fx') {
            audioFxOptions?.classList.remove('hidden');
        } else {
            audioFxOptions?.classList.add('hidden');
        }

        if (selected === 'txt_wrap') {
            txtWrapOptions?.classList.remove('hidden');
        } else {
            txtWrapOptions?.classList.add('hidden');
        }
    };

    formatModes.forEach(input => {
        input.addEventListener('change', updateFormatOptions);
    });

    updateFormatOptions();

    // 初始化预览
    setTimeout(() => {
        updateLogoPreview();
        updateWatermarkPreview();
    }, 500);
}

// ==================== 预览功能 ====================

function updateLogoPreview() {
    // 获取选中的预设 Logo
    const preset = document.querySelector('input[name="logo-preset"]:checked')?.value || 'hailuo';

    // 获取输入框的实际值
    const posX = parseInt(document.getElementById('logo-pos-x')?.value) || 590;
    const posY = parseInt(document.getElementById('logo-pos-y')?.value) || 1810;
    const logoW = parseInt(document.getElementById('logo-width')?.value) || 400;
    const logoH = parseInt(document.getElementById('logo-height')?.value) || 90;

    // 获取预设标签
    const presetLabels = {
        'hailuo': 'Dream+Hailuo',
        'vidu': 'Dream+Vidu',
        'veo': 'Dream+Veo',
        'heygen': 'Dream+HeyGen',
        'dream': 'Dreamina',
        'ai_generated': 'AI Generated',
        'custom': 'Custom Logo'
    };
    const label = presetLabels[preset] || 'Logo';
    const logoSource = getLogoPreviewSource(preset);

    // 渲染到深色背景
    renderLogoToCanvas('logo-preview-canvas', {
        posX,
        posY,
        logoW,
        logoH,
        label,
        bgType: 'dark',
        sources: logoSource.sources
    });

    // 渲染到浅色开背景
    renderLogoToCanvas('logo-preview-canvas-light', {
        posX,
        posY,
        logoW,
        logoH,
        label,
        bgType: 'light',
        sources: logoSource.sources
    });
}

function getLogoPreviewSource(preset) {
    if (preset === 'custom') {
        const customPath = document.getElementById('custom-logo-file')?.dataset?.filePath;
        if (customPath) {
            return { sources: [normalizeFilePath(customPath)] };
        }
    }

    const assetFile = LOGO_PRESET_ASSETS[preset];
    if (assetFile) {
        const sources = [];
        const electronAsset = window.electronAPI?.resolveAssetUrl?.(assetFile);
        if (electronAsset) {
            sources.push(electronAsset);
        }

        // 保留相对路径兜底（开发环境/非 Electron 环境）
        sources.push(resolveAssetPath(`../assets/${assetFile}`));
        sources.push(resolveAssetPath(`./assets/${assetFile}`));

        return { sources: [...new Set(sources.filter(Boolean))] };
    }

    return { sources: [] };
}

function resolveAssetPath(relativePath) {
    try {
        return new URL(relativePath, window.location.href).toString();
    } catch (e) {
        return relativePath;
    }
}

function normalizeFilePath(pathValue) {
    if (!pathValue) return '';
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        try {
            const u = window.electronAPI.toFileUrl(pathValue);
            if (u) return u;
        } catch (e) {
            console.error('Failed to normalize file path with toFileUrl:', e);
        }
    }
    if (/^file:\/\//i.test(pathValue)) {
        return pathValue;
    }
    if (/^[a-zA-Z]:[/\\]/.test(pathValue)) {
        const replaced = pathValue.replace(/\\/g, '/');
        const parts = replaced.split('/');
        const drive = parts[0];
        const rest = parts.slice(1).map(encodeURIComponent).join('/');
        return `file:///${drive}/${rest}`;
    }
    if (pathValue.startsWith('/')) {
        return 'file://' + pathValue.split('/').map(p => p === '' ? '' : encodeURIComponent(p)).join('/');
    }
    return pathValue;
}

function renderLogoToCanvas(canvasId, params) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Retina 支持
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = 135;
    const displayHeight = 240;

    // 设置实际像素尺寸
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    ctx.scale(dpr, dpr);

    const w = displayWidth;
    const h = displayHeight;

    // 清空并绘制背景
    if (params.bgType === 'dark') {
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#181818');
        gradient.addColorStop(0.5, '#1e1e1e');
        gradient.addColorStop(1, '#2a2a2a');
        ctx.fillStyle = gradient;
    } else {
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#f5f7fa');
        gradient.addColorStop(0.5, '#e4e9f2');
        gradient.addColorStop(1, '#c3cfe2');
        ctx.fillStyle = gradient;
    }
    ctx.fillRect(0, 0, w, h);

    // 缩放比例 (1080x1920 -> 135x240)
    const scale = 135 / 1080;

    // 绘制 Logo 占位区域
    const lx = params.posX * scale;
    const ly = params.posY * scale;
    const lw = params.logoW * scale;
    const lh = params.logoH * scale;

    const imgEntry = params.sources && params.sources.length ? getLogoImage(params.sources) : null;
    const canDrawImage = imgEntry && imgEntry.status === 'loaded' && imgEntry.img;

    // Logo 背景
    ctx.fillStyle = params.bgType === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(lx, ly, lw, lh);

    if (canDrawImage) {
        ctx.drawImage(imgEntry.img, lx, ly, lw, lh);
    }

    // Logo 边框
    ctx.strokeStyle = params.bgType === 'dark' ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(lx, ly, lw, lh);
    ctx.setLineDash([]);

    if (!canDrawImage) {
        // Logo 文字占位
        ctx.fillStyle = params.bgType === 'dark' ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.7)';
        const fontSize = Math.max(8, Math.min(18, lh * 0.6));
        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(params.label, lx + lw / 2, ly + lh / 2);
    }

    // 尺寸提示
    ctx.fillStyle = params.bgType === 'dark' ? 'rgba(255, 255, 255, 0.75)' : 'rgba(0, 0, 0, 0.6)';
    ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`W:${params.logoW} H:${params.logoH}`, 6, 6);

    if (!canDrawImage) {
        ctx.fillStyle = params.bgType === 'dark' ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.45)';
        ctx.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('预览占位', 6, 18);
    }
}

function getLogoImage(sources) {
    const key = sources.join('|');
    let entry = logoImageCache.get(key);
    if (!entry) {
        const img = new Image();
        entry = { img, status: 'loading', sources, index: 0 };
        img.onload = () => {
            entry.status = 'loaded';
            updateLogoPreview();
        };
        img.onerror = () => {
            if (entry.index + 1 < entry.sources.length) {
                entry.index += 1;
                img.src = entry.sources[entry.index];
                return;
            }
            entry.status = 'error';
            updateLogoPreview();
        };
        img.src = sources[0];
        logoImageCache.set(key, entry);
    }
    return entry;
}

function updateWatermarkPreview() {
    // 获取水印参数
    const text = document.getElementById('watermark-text')?.value || 'AI Created';
    const fontSize = parseInt(document.getElementById('watermark-fontsize')?.value) || 24;
    const color = document.getElementById('watermark-color')?.value || '#ffffff';
    const opacity = parseFloat(document.getElementById('watermark-opacity')?.value) || 1;
    const hasStroke = document.getElementById('watermark-stroke')?.checked || false;
    const strokeColor = document.getElementById('watermark-stroke-color')?.value || '#000000';
    const strokeWidth = parseInt(document.getElementById('watermark-stroke-width')?.value) || 2;
    const hasShadow = document.getElementById('watermark-shadow')?.checked || false;
    const position = document.getElementById('watermark-position')?.value || 'top-right';
    const fontFamily = document.getElementById('watermark-font')?.value || 'Arial';
    const offsetX = parseInt(document.getElementById('watermark-offset-x')?.value) || 10;
    const offsetY = parseInt(document.getElementById('watermark-offset-y')?.value) || 10;

    // 渲染到深色背景
    renderWatermarkToCanvas('watermark-preview-canvas', {
        text, fontSize, color, opacity, hasStroke, strokeColor, strokeWidth,
        hasShadow, position, fontFamily, offsetX, offsetY,
        bgType: 'dark'
    });

    // 渲染到浅色背景
    renderWatermarkToCanvas('watermark-preview-canvas-light', {
        text, fontSize, color, opacity, hasStroke, strokeColor, strokeWidth,
        hasShadow, position, fontFamily, offsetX, offsetY,
        bgType: 'light'
    });
}

function renderWatermarkToCanvas(canvasId, params) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Retina 支持
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = 135;
    const displayHeight = 240;

    // 设置实际像素尺寸
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    canvas.style.width = displayWidth + 'px';
    canvas.style.height = displayHeight + 'px';
    ctx.scale(dpr, dpr);

    const w = displayWidth;
    const h = displayHeight;

    // 清空并绘制背景
    if (params.bgType === 'dark') {
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#181818');
        gradient.addColorStop(0.5, '#1e1e1e');
        gradient.addColorStop(1, '#2a2a2a');
        ctx.fillStyle = gradient;
    } else {
        const gradient = ctx.createLinearGradient(0, 0, w, h);
        gradient.addColorStop(0, '#f5f7fa');
        gradient.addColorStop(0.5, '#e4e9f2');
        gradient.addColorStop(1, '#c3cfe2');
        ctx.fillStyle = gradient;
    }
    ctx.fillRect(0, 0, w, h);

    // 缩放比例 (1080x1920 -> 135x240)
    const scale = 135 / 1080;
    // 字体使用更大的缩放比例使预览更清晰 (约2倍)
    const fontScale = scale * 2;
    const scaledFontSize = Math.max(params.fontSize * fontScale, 4);
    const scaledOffsetX = params.offsetX * scale;
    const scaledOffsetY = params.offsetY * scale;

    ctx.font = `${scaledFontSize}px "${params.fontFamily}", -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.globalAlpha = params.opacity;

    // 测量文字宽度
    const textWidth = ctx.measureText(params.text).width;
    const textHeight = scaledFontSize;

    // 计算位置
    let x, y;
    switch (params.position) {
        case 'top-left': x = scaledOffsetX; y = scaledOffsetY + textHeight; break;
        case 'top-right': x = w - textWidth - scaledOffsetX; y = scaledOffsetY + textHeight; break;
        case 'bottom-left': x = scaledOffsetX; y = h - scaledOffsetY; break;
        case 'bottom-right': x = w - textWidth - scaledOffsetX; y = h - scaledOffsetY; break;
        case 'center': x = (w - textWidth) / 2; y = (h + textHeight) / 2; break;
        default: x = w - textWidth - scaledOffsetX; y = scaledOffsetY + textHeight;
    }

    // 阴影
    if (params.hasShadow) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
        ctx.shadowBlur = 4;
    }

    // 描边
    if (params.hasStroke) {
        ctx.strokeStyle = params.strokeColor;
        ctx.lineWidth = params.strokeWidth * scale;
        ctx.strokeText(params.text, x, y);
    }

    // 文字
    ctx.fillStyle = params.color;
    ctx.fillText(params.text, x, y);

    // 重置
    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = 0;
}

// ==================== 水印设置保存/加载 ====================

function saveWatermarkSettings() {
    const settings = {
        text: document.getElementById('watermark-text')?.value || 'AI Generated',
        font: document.getElementById('watermark-font')?.value || 'Arial',
        fontSize: document.getElementById('watermark-fontsize')?.value || '24',
        color: document.getElementById('watermark-color')?.value || '#ffffff',
        opacity: document.getElementById('watermark-opacity')?.value || '1',
        stroke: document.getElementById('watermark-stroke')?.checked || false,
        strokeColor: document.getElementById('watermark-stroke-color')?.value || '#000000',
        strokeWidth: document.getElementById('watermark-stroke-width')?.value || '2',
        shadow: document.getElementById('watermark-shadow')?.checked || false,
        position: document.getElementById('watermark-position')?.value || 'top-right'
    };

    localStorage.setItem('watermarkSettings', JSON.stringify(settings));
    showToast('水印设置已保存', 'success');
}

function loadWatermarkSettings() {
    const saved = localStorage.getItem('watermarkSettings');
    if (!saved) return;

    try {
        const settings = JSON.parse(saved);

        if (settings.text) document.getElementById('watermark-text').value = settings.text;
        if (settings.font) document.getElementById('watermark-font').value = settings.font;
        if (settings.fontSize) document.getElementById('watermark-fontsize').value = settings.fontSize;
        if (settings.color) {
            document.getElementById('watermark-color').value = settings.color;
            document.getElementById('watermark-color-text').value = settings.color;
        }
        if (settings.opacity) {
            document.getElementById('watermark-opacity').value = settings.opacity;
            document.getElementById('watermark-opacity-label').textContent = Math.round(settings.opacity * 100) + '%';
        }
        if (settings.stroke !== undefined) document.getElementById('watermark-stroke').checked = settings.stroke;
        if (settings.strokeColor) document.getElementById('watermark-stroke-color').value = settings.strokeColor;
        if (settings.strokeWidth) document.getElementById('watermark-stroke-width').value = settings.strokeWidth;
        if (settings.shadow !== undefined) document.getElementById('watermark-shadow').checked = settings.shadow;
        if (settings.position) document.getElementById('watermark-position').value = settings.position;

        // 更新预览
        setTimeout(updateWatermarkPreview, 100);
    } catch (e) {
        console.error('加载水印设置失败:', e);
    }
}

// ==================== 位置调整辅助函数 ====================

// Logo 位置调整（方向按钮）
function adjustLogoPos(dx, dy) {
    const posX = document.getElementById('logo-pos-x');
    const posY = document.getElementById('logo-pos-y');
    if (posX) posX.value = parseInt(posX.value) + dx;
    if (posY) posY.value = parseInt(posY.value) + dy;
    updateLogoPreview();
}

// 重置 Logo 位置为当前预设默认值
function resetLogoPosition() {
    const preset = document.querySelector('input[name="logo-preset"]:checked')?.value || 'hailuo';
    const cfg = LOGO_DEFAULTS[preset] || LOGO_DEFAULTS.hailuo;

    document.getElementById('logo-pos-x').value = cfg.x;
    document.getElementById('logo-pos-y').value = cfg.y;
    document.getElementById('logo-width').value = cfg.w;
    document.getElementById('logo-height').value = cfg.h;

    // 同步滑块
    const widthRange = document.getElementById('logo-width-range');
    const heightRange = document.getElementById('logo-height-range');
    if (widthRange) widthRange.value = cfg.w;
    if (heightRange) heightRange.value = cfg.h;

    updateLogoPreview();
    showToast(`已重置为 ${preset} 预设位置`, 'success');
}

function getLogoOverrideFromInputs() {
    const preset = document.querySelector('input[name="logo-preset"]:checked')?.value || 'hailuo';
    const defaults = LOGO_DEFAULTS[preset] || LOGO_DEFAULTS.hailuo;

    const xVal = parseInt(document.getElementById('logo-pos-x')?.value);
    const yVal = parseInt(document.getElementById('logo-pos-y')?.value);
    const wVal = parseInt(document.getElementById('logo-width')?.value);
    const hVal = parseInt(document.getElementById('logo-height')?.value);

    return {
        x: Number.isFinite(xVal) ? xVal : defaults.x,
        y: Number.isFinite(yVal) ? yVal : defaults.y,
        width: Number.isFinite(wVal) ? wVal : defaults.w,
        height: Number.isFinite(hVal) ? hVal : defaults.h
    };
}

// 水印偏移调整（方向按钮）
function adjustWatermarkOffset(dx, dy) {
    const offsetX = document.getElementById('watermark-offset-x');
    const offsetY = document.getElementById('watermark-offset-y');
    if (offsetX) offsetX.value = Math.max(0, parseInt(offsetX.value) + dx);
    if (offsetY) offsetY.value = Math.max(0, parseInt(offsetY.value) + dy);
    updateWatermarkPreview();
}

// 检查后端健康状态
let healthCheckRetries = 0;
const MAX_HEALTH_RETRIES = 20; // 快速重试阶段（约60秒）
let healthCheckSlowMode = false; // 进入慢速重试模式

async function checkBackendHealth() {
    // Node.js 后端在主进程中运行，始终可用
    updateStatus('后端服务已连接 (Node.js)', 'success');
    backendReady = true;
    healthCheckRetries = 0;
    healthCheckSlowMode = false;
    if (!settingsAutoLoaded) {
        settingsAutoLoaded = true;
        loadSettings(true);
    }
}

// 更新状态
function updateStatus(text, type = 'normal', elementId = 'status-text') {
    const statusText = document.getElementById(elementId);
    if (statusText) {
        statusText.textContent = text;
        statusText.className = 'status-text';
        if (type === 'error') statusText.classList.add('error');
        if (type === 'processing') statusText.classList.add('processing');
    }
}

function setIndeterminateProgress(elementId, active) {
    const bar = document.getElementById(elementId);
    if (!bar) return;
    bar.classList.toggle('indeterminate', active);
}

// 清空文本
function clearText(targetId) {
    document.getElementById(targetId).value = '';
    showToast('已清空', 'info');
    refreshKeyTable(targetId);
}

// Global key manager storage
window.keyTableManagers = {};

class ApiKeyTableManager {
    constructor(textareaId, options = {}) {
        this.textarea = document.getElementById(textareaId);
        if (!this.textarea) return;
        
        this.textareaId = textareaId;
        this.title = options.title || 'API Key 列表';
        this.mode = 'table'; // default mode
        
        // Keep track of mask/unmask states of keys (key inputs are masked by default)
        this.visibleKeys = {}; // index -> boolean
        
        this.init();
    }
    
    init() {
        // Create container and insert it before the textarea
        this.container = document.createElement('div');
        this.container.className = 'key-manager-container';
        
        // Hide the original textarea styling or classes, but keep it in the DOM
        this.textarea.style.display = 'none';
        
        // Insert container before the textarea
        this.textarea.parentNode.insertBefore(this.container, this.textarea);
        
        // Render structure
        this.renderHeader();
        
        this.tableView = document.createElement('div');
        this.tableView.className = 'key-manager-table-view';
        this.container.appendChild(this.tableView);
        
        this.textView = document.createElement('div');
        this.textView.className = 'key-manager-text-view';
        this.textView.style.display = 'none';
        this.container.appendChild(this.textView);
        
        // Move the textarea inside the textView container
        this.textView.appendChild(this.textarea);
        
        // Listen to change/input events of the textarea to update the table (when programmatically loaded)
        this.textarea.addEventListener('input', () => {
            if (this.mode === 'table') {
                this.syncTableFromTextarea();
            }
        });
        
        // Populate table from textarea initially
        this.syncTableFromTextarea();
    }
    
    renderHeader() {
        const header = document.createElement('div');
        header.className = 'key-manager-header';
        
        const titleEl = document.createElement('div');
        titleEl.className = 'key-manager-title';
        titleEl.textContent = this.title;
        header.appendChild(titleEl);
        
        const tabs = document.createElement('div');
        tabs.className = 'key-manager-tabs';
        
        const tableTab = document.createElement('button');
        tableTab.className = 'key-manager-tab active';
        tableTab.textContent = '📋 表格模式';
        tableTab.type = 'button';
        tableTab.onclick = () => this.switchMode('table');
        
        const textTab = document.createElement('button');
        textTab.className = 'key-manager-tab';
        textTab.textContent = '✏️ 文本模式';
        textTab.type = 'button';
        textTab.onclick = () => this.switchMode('text');
        
        tabs.appendChild(tableTab);
        tabs.appendChild(textTab);
        header.appendChild(tabs);
        
        this.container.appendChild(header);
        
        this.tableTabBtn = tableTab;
        this.textTabBtn = textTab;
    }
    
    switchMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        
        if (mode === 'table') {
            this.tableTabBtn.classList.add('active');
            this.textTabBtn.classList.remove('active');
            
            // Sync table from text area first (in case user modified the textarea in text mode)
            this.syncTableFromTextarea();
            
            this.tableView.style.display = 'block';
            this.textView.style.display = 'none';
            this.textarea.style.display = 'none';
        } else {
            this.tableTabBtn.classList.remove('active');
            this.textTabBtn.classList.add('active');
            
            // Sync textarea from table inputs first
            this.syncTextareaFromTable();
            
            this.tableView.style.display = 'none';
            this.textView.style.display = 'block';
            this.textarea.style.display = 'block';
        }
    }
    
    syncTableFromTextarea() {
        const keysText = this.textarea.value || '';
        const keys = keysText.split('\n').map(k => k.trim()).filter(Boolean);
        
        // Rebuild table body
        let html = `
            <table class="key-manager-table">
                <thead>
                    <tr>
                        <th style="width: 50px; text-align: center;">序号</th>
                        <th>API Key</th>
                        <th style="width: 70px; text-align: center;">操作</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        if (keys.length === 0) {
            html += `
                <tr>
                    <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 12px;">
                        暂无 Key，请点击下方按钮添加或切换到文本模式导入
                    </td>
                </tr>
            `;
        } else {
            keys.forEach((key, index) => {
                const isVisible = !!this.visibleKeys[index];
                const inputType = isVisible ? 'text' : 'password';
                const eyeLabel = isVisible ? '隐藏' : '显示';
                html += `
                    <tr data-index="${index}">
                        <td class="key-manager-row-num">${index + 1}</td>
                        <td>
                            <div class="key-manager-input-wrap">
                                <input type="${inputType}" class="key-manager-key-input" value="${this.escapeHtml(key)}" placeholder="输入 API Key" data-index="${index}">
                                <button type="button" class="key-manager-eye-btn" data-index="${index}" title="${eyeLabel}">${isVisible ? '🔒' : '👁️'}</button>
                            </div>
                        </td>
                        <td>
                            <button type="button" class="key-manager-delete-btn" data-index="${index}" title="删除">🗑️</button>
                        </td>
                    </tr>
                `;
            });
        }
        
        html += `
                </tbody>
            </table>
            <div class="key-manager-add-row">
                <button type="button" class="key-manager-add-btn">➕ 添加 Key</button>
            </div>
        `;
        
        this.tableView.innerHTML = html;
        
        // Re-bind event listeners for table controls
        this.bindTableEvents();
    }
    
    bindTableEvents() {
        // Eye buttons
        this.tableView.querySelectorAll('.key-manager-eye-btn').forEach(btn => {
            btn.onclick = (e) => {
                const index = parseInt(btn.getAttribute('data-index'));
                this.visibleKeys[index] = !this.visibleKeys[index];
                
                const input = this.tableView.querySelector(`input[data-index="${index}"]`);
                if (input) {
                    input.type = this.visibleKeys[index] ? 'text' : 'password';
                }
                btn.textContent = this.visibleKeys[index] ? '🔒' : '👁️';
                btn.title = this.visibleKeys[index] ? '隐藏' : '显示';
            };
        });
        
        // Key inputs (update textarea on input)
        this.tableView.querySelectorAll('.key-manager-key-input').forEach(input => {
            input.oninput = () => {
                this.syncTextareaFromTable();
            };
        });
        
        // Delete buttons
        this.tableView.querySelectorAll('.key-manager-delete-btn').forEach(btn => {
            btn.onclick = () => {
                const index = parseInt(btn.getAttribute('data-index'));
                
                // Get current keys, remove the one at index
                const keys = this.getKeysFromTable();
                keys.splice(index, 1);
                
                // Update visible states map
                const newVisible = {};
                keys.forEach((_, idx) => {
                    newVisible[idx] = this.visibleKeys[idx < index ? idx : idx + 1] || false;
                });
                this.visibleKeys = newVisible;
                
                // Write back to textarea
                this.textarea.value = keys.join('\n');
                
                // Refresh table
                this.syncTableFromTextarea();
            };
        });
        
        // Add button
        const addBtn = this.tableView.querySelector('.key-manager-add-btn');
        if (addBtn) {
            addBtn.onclick = () => {
                const keys = this.getKeysFromTable();
                keys.push(''); // Add empty key
                
                this.textarea.value = keys.join('\n');
                this.syncTableFromTextarea();
                
                // Focus on the newly added input
                const inputs = this.tableView.querySelectorAll('.key-manager-key-input');
                if (inputs.length > 0) {
                    const lastInput = inputs[inputs.length - 1];
                    lastInput.focus();
                }
            };
        }
    }
    
    getKeysFromTable() {
        const inputs = this.tableView.querySelectorAll('.key-manager-key-input');
        const keys = [];
        inputs.forEach(input => {
            const val = input.value.trim();
            if (val) {
                keys.push(val);
            }
        });
        return keys;
    }
    
    syncTextareaFromTable() {
        // Simply collect all keys from input elements and set the textarea value
        const inputs = this.tableView.querySelectorAll('.key-manager-key-input');
        const keys = [];
        inputs.forEach(input => {
            keys.push(input.value.trim());
        });
        this.textarea.value = keys.filter(Boolean).join('\n');
        
        // Trigger input/change event on the original textarea to let any other listeners react
        this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        this.textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}

// Function to safely initialize all key managers
function initKeyTableManagers() {
    const targets = [
        { id: 'gladia-keys', title: 'Gladia API Key 轮询池' },
        { id: 'gemini-keys', title: 'Gemini API Key 轮询池' },
        { id: 'settings-elevenlabs-keys', title: 'ElevenLabs API Key 轮询池 (全局设置)' },
        { id: 'elevenlabs-api-keys', title: 'ElevenLabs API Key 轮询池 (快捷栏)' }
    ];
    
    targets.forEach(target => {
        if (document.getElementById(target.id) && !window.keyTableManagers[target.id]) {
            window.keyTableManagers[target.id] = new ApiKeyTableManager(target.id, { title: target.title });
        }
    });
}

// Helper to refresh a table programmatically
function refreshKeyTable(id) {
    if (window.keyTableManagers && window.keyTableManagers[id]) {
        window.keyTableManagers[id].syncTableFromTextarea();
    }
}

// 加载设置
async function loadSettings(autoLoadVoices = false) {
    try {
        const response = await apiFetch(`${API_BASE}/settings/gladia-keys`);
        const data = await response.json();
        if (data.keys) {
            document.getElementById('gladia-keys').value = data.keys.join('\n');
            refreshKeyTable('gladia-keys');
        }
    } catch (error) {
        // 忽略
    }

    try {
        const response = await apiFetch(`${API_BASE}/settings/gemini-keys`);
        const data = await response.json();
        if (data.keys) {
            document.getElementById('gemini-keys').value = data.keys.join('\n');
            refreshKeyTable('gemini-keys');
        }
        if (data.model) {
            const modelSelect = document.getElementById('gemini-model');
            if (modelSelect) modelSelect.value = data.model;
        }

        if (data.prompt !== undefined) {
            document.getElementById('gemini-prompt').value = data.prompt;
        }
    } catch (error) {
        // 忽略
    }

    // 加载 ElevenLabs API Keys
    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs`);
        const data = await response.json();
        const keyTextarea = document.getElementById('elevenlabs-api-keys');
        const settingsKeyTextarea = document.getElementById('settings-elevenlabs-keys');
        const radioWeb = document.getElementById('mode-web');
        const radioApi = document.getElementById('mode-apikey');
        
        const keys = Array.isArray(data.api_keys) ? data.api_keys : (data.api_key ? [data.api_key] : []);
        
        if (keyTextarea) {
            keyTextarea.value = keys.join('\n');
            refreshKeyTable('elevenlabs-api-keys');
            if (data.use_web_token && radioWeb) {
                radioWeb.checked = true;
            } else if (radioApi) {
                radioApi.checked = true;
            }
            if (typeof updateWebTokenUI === 'function') {
                updateWebTokenUI();
            }
            if (autoLoadVoices && backendReady) {
                if (keys.length > 0 || data.use_web_token) {
                    loadVoices();
                }
                if (typeof refreshVWVoices === 'function') {
                    refreshVWVoices();
                }
            }
        }
        // 同步填充到「总设置」面板
        if (settingsKeyTextarea) {
            settingsKeyTextarea.value = keys.join('\n');
            refreshKeyTable('settings-elevenlabs-keys');
            const countEl = document.getElementById('settings-elevenlabs-key-count');
            if (countEl) countEl.textContent = keys.length > 0 ? `已配置 ${keys.length} 个密钥` : '';
        }
    } catch (error) {
        // 忽略
    }

    // 加载替换规则
    try {
        const response = await apiFetch(`${API_BASE}/settings/replace-rules`);
        const data = await response.json();
        const rulesTextarea = document.getElementById('replace-rules');
        const langSelect = document.getElementById('replace-language');

        if (!rulesTextarea || !langSelect) return;

        if (typeof data.rules === 'string') {
            if (data.language) {
                langSelect.value = data.language;
            }
            rulesTextarea.value = data.rules || '';
            replaceRulesCache = null;
        } else if (data.rules && typeof data.rules === 'object') {
            replaceRulesCache = data.rules;
            const preferredLang = data.language || langSelect.value;
            if (preferredLang && replaceRulesCache[preferredLang] !== undefined) {
                langSelect.value = preferredLang;
                rulesTextarea.value = replaceRulesCache[preferredLang] || '';
            } else {
                rulesTextarea.value = '';
            }
        } else {
            rulesTextarea.value = '';
            replaceRulesCache = null;
        }
    } catch (error) {
        // 忽略
    }
}

// ==================== 批量字幕对齐功能 ====================

let subtitleBatchTasks = []; // 存储批量任务 {file, fileName, sourceText, translateText}

// 切换批量模式
function toggleSubtitleBatchMode() {
    const batchMode = document.getElementById('subtitle-batch-mode')?.checked;
    const batchSection = document.getElementById('subtitle-batch-section');
    const singleSections = document.querySelectorAll('#subtitle-panel .form-section:not(#subtitle-batch-section):not(:has(#subtitle-batch-mode))');

    // 隐藏/显示 STEP 1-3（单文件模式的输入）
    const step1 = document.querySelector('#audio-path')?.closest('.form-section');
    const step2 = document.querySelector('#source-text')?.closest('.form-section');
    const step3 = document.querySelector('#translate-text')?.closest('.form-section');

    if (batchMode) {
        batchSection?.classList.remove('hidden');
        step1?.classList.add('hidden');
        step2?.classList.add('hidden');
        step3?.classList.add('hidden');
    } else {
        batchSection?.classList.add('hidden');
        step1?.classList.remove('hidden');
        step2?.classList.remove('hidden');
        step3?.classList.remove('hidden');
    }
}

// 初始化批量音频输入
function initSubtitleBatch() {
    const batchInput = document.getElementById('batch-audio-input');
    if (batchInput) {
        batchInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            addAudioFilesToBatch(files);
            e.target.value = ''; // 清空以便再次选择
        });
    }

    // 添加拖拽支持
    const list = document.getElementById('subtitle-batch-list');
    const section = document.getElementById('subtitle-batch-section');

    if (section) {
        section.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            section.style.background = 'rgba(0, 217, 165, 0.1)';
            section.style.border = '2px dashed #00d9a5';
        });

        section.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            section.style.background = '';
            section.style.border = '';
        });

        section.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            section.style.background = '';
            section.style.border = '';

            const files = Array.from(e.dataTransfer.files || []);
            const audioFiles = files.filter(f =>
                /\.(mp4|mov|mkv|wav|mp3|m4a|flv|avi|wmv|json)$/i.test(f.name)
            );

            if (audioFiles.length > 0) {
                addAudioFilesToBatch(audioFiles);
            } else {
                showToast('请拖入音频/视频文件', 'error');
            }
        });
    }
}

// 添加音频文件到批量列表
function addAudioFilesToBatch(files) {
    files.forEach(file => {
        const task = {
            file: file,
            fileName: file.name,
            sourceText: '',
            translateText: '',
            status: 'pending',
            duration: null
        };
        subtitleBatchTasks.push(task);

        // 异步获取时长
        getAudioDuration(file).then(duration => {
            task.duration = duration;
            renderSubtitleBatchList();
        });
    });
    renderSubtitleBatchList();
    showToast(`已添加 ${files.length} 个文件`, 'success');
}

// 获取音频时长
function getAudioDuration(file) {
    return new Promise(resolve => {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        audio.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            resolve(audio.duration);
        };
        audio.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
        };
        audio.src = url;
    });
}

// 格式化时长
function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '--:--';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 批量音频播放器
let batchAudioPlayer = null;
let currentPlayingIndex = -1;

function playBatchAudio(idx, btn) {
    const task = subtitleBatchTasks[idx];
    if (!task || !task.file) return;

    // 如果正在播放同一个，停止
    if (currentPlayingIndex === idx && batchAudioPlayer && !batchAudioPlayer.paused) {
        batchAudioPlayer.pause();
        batchAudioPlayer.currentTime = 0;
        btn.textContent = '▶️';
        currentPlayingIndex = -1;
        return;
    }

    // 停止之前的
    if (batchAudioPlayer) {
        batchAudioPlayer.pause();
        // 重置之前按钮
        const allBtns = document.querySelectorAll('.subtitle-play-btn');
        allBtns.forEach(b => b.textContent = '▶️');
    }

    // 创建新播放器
    const url = URL.createObjectURL(task.file);
    batchAudioPlayer = new Audio(url);
    currentPlayingIndex = idx;

    btn.textContent = '⏸️';

    batchAudioPlayer.play().catch(err => {
        showToast('播放失败: ' + err.message, 'error');
        btn.textContent = '▶️';
    });

    batchAudioPlayer.onended = () => {
        btn.textContent = '▶️';
        currentPlayingIndex = -1;
        URL.revokeObjectURL(url);
    };

    batchAudioPlayer.onerror = () => {
        btn.textContent = '▶️';
        currentPlayingIndex = -1;
        showToast('音频加载失败', 'error');
    };
}

// 渲染批量任务列表
function renderSubtitleBatchList() {
    const list = document.getElementById('subtitle-batch-list');
    const countSpan = document.getElementById('subtitle-batch-count');
    if (!list) return;

    countSpan.textContent = `${subtitleBatchTasks.length} 个任务`;

    if (subtitleBatchTasks.length === 0) {
        list.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-secondary);">暂无任务，点击"批量添加音频"添加文件</div>';
        return;
    }

    list.innerHTML = '';

    subtitleBatchTasks.forEach((task, idx) => {
        const item = document.createElement('div');
        item.className = 'subtitle-batch-item';
        item.style.cssText = 'background: var(--bg-secondary); border-radius: 6px; margin-bottom: 8px; overflow: hidden;';

        // 头部（可折叠）
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; flex-wrap: wrap;';
        header.onclick = () => {
            const body = item.querySelector('.batch-item-body');
            body.classList.toggle('hidden');
            arrow.textContent = body.classList.contains('hidden') ? '▶' : '▼';
        };

        const arrow = document.createElement('span');
        arrow.textContent = '▶';
        arrow.style.cssText = 'font-size: 10px; color: var(--text-secondary);';

        const indexSpan = document.createElement('span');
        indexSpan.textContent = `${idx + 1}.`;
        indexSpan.style.cssText = 'font-weight: 500; color: var(--text-primary); min-width: 24px;';

        const fileName = document.createElement('span');
        fileName.textContent = task.fileName;
        fileName.style.cssText = 'color: var(--text-primary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px;';

        // 时长显示
        const durationSpan = document.createElement('span');
        durationSpan.style.cssText = 'font-size: 11px; color: var(--text-secondary); min-width: 40px;';
        durationSpan.textContent = formatDuration(task.duration);

        // 文案预览（显示前 20 字）
        const previewSpan = document.createElement('span');
        previewSpan.style.cssText = 'flex: 1; font-size: 11px; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        const srcPreview = task.sourceText.trim().substring(0, 15) || '--';
        const transPreview = task.translateText.trim().substring(0, 15) || '--';
        previewSpan.textContent = `原: ${srcPreview}${task.sourceText.length > 15 ? '...' : ''} | 译: ${transPreview}${task.translateText.length > 15 ? '...' : ''}`;

        const statusSpan = document.createElement('span');
        statusSpan.className = 'batch-item-status';
        statusSpan.style.cssText = 'font-size: 11px; padding: 2px 6px; border-radius: 4px;';
        const hasSource = task.sourceText.trim().length > 0;
        const hasTrans = task.translateText.trim().length > 0;
        if (hasSource && hasTrans) {
            statusSpan.textContent = '✅ 就绪';
            statusSpan.style.background = 'rgba(0,255,0,0.2)';
            statusSpan.style.color = '#51cf66';
        } else {
            statusSpan.textContent = '⚠️ 缺字幕';
            statusSpan.style.background = 'rgba(255,165,0,0.2)';
            statusSpan.style.color = '#ffa500';
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-secondary';
        deleteBtn.style.cssText = 'padding: 2px 8px; font-size: 11px;';
        deleteBtn.textContent = '✕';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            subtitleBatchTasks.splice(idx, 1);
            renderSubtitleBatchList();
        };

        // 播放按钮
        const playBtn = document.createElement('button');
        playBtn.className = 'btn btn-secondary subtitle-play-btn';
        playBtn.style.cssText = 'padding: 2px 8px; font-size: 11px;';
        playBtn.textContent = '▶️';
        playBtn.title = '试听音频';
        playBtn.onclick = (e) => {
            e.stopPropagation();
            playBatchAudio(idx, playBtn);
        };

        header.appendChild(arrow);
        header.appendChild(indexSpan);
        header.appendChild(fileName);
        header.appendChild(durationSpan);
        header.appendChild(playBtn);
        header.appendChild(previewSpan);
        header.appendChild(statusSpan);
        header.appendChild(deleteBtn);

        // 内容（可折叠）
        const body = document.createElement('div');
        body.className = 'batch-item-body hidden';
        body.style.cssText = 'padding: 0 12px 12px 12px;';

        const sourceLabel = document.createElement('label');
        sourceLabel.textContent = '原文本:';
        sourceLabel.style.cssText = 'display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;';

        const sourceTextarea = document.createElement('textarea');
        sourceTextarea.className = 'textarea batch-source-text';
        sourceTextarea.style.cssText = 'width: 100%; margin-bottom: 8px;';
        sourceTextarea.rows = 3;
        sourceTextarea.placeholder = '粘贴原文本...';
        sourceTextarea.value = task.sourceText;
        sourceTextarea.oninput = () => {
            subtitleBatchTasks[idx].sourceText = sourceTextarea.value;
            renderSubtitleBatchList(); // 更新状态
        };

        const transLabel = document.createElement('label');
        transLabel.textContent = '译文本:';
        transLabel.style.cssText = 'display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px;';

        const transTextarea = document.createElement('textarea');
        transTextarea.className = 'textarea batch-trans-text';
        transTextarea.style.cssText = 'width: 100%;';
        transTextarea.rows = 3;
        transTextarea.placeholder = '粘贴译文本...';
        transTextarea.value = task.translateText;
        transTextarea.oninput = () => {
            subtitleBatchTasks[idx].translateText = transTextarea.value;
            renderSubtitleBatchList();
        };

        body.appendChild(sourceLabel);
        body.appendChild(sourceTextarea);
        body.appendChild(transLabel);
        body.appendChild(transTextarea);

        item.appendChild(header);
        item.appendChild(body);
        list.appendChild(item);
    });

}

// 批量粘贴字幕文本
async function batchPasteSubtitleText(type) {
    try {
        const clipboardItems = await navigator.clipboard.read();
        let texts = [];
        let isTwoColumn = false;

        // 辅助函数：提取单元格文本，保留换行
        function getCellText(cell) {
            // 将 <br> 转换为换行符
            let html = cell.innerHTML;
            html = html.replace(/<br\s*\/?>/gi, '\n');
            // 创建临时元素获取纯文本
            const temp = document.createElement('div');
            temp.innerHTML = html;
            return temp.textContent.trim();
        }

        for (const item of clipboardItems) {
            // 优先解析 HTML（Google 表格格式）
            if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                const html = await blob.text();
                console.log('解析 HTML:', html.substring(0, 500));

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const rows = doc.querySelectorAll('tr');

                if (rows.length > 0) {
                    // 表格格式
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td, th');
                        if (cells.length >= 2) {
                            // 两列：原文 + 译文
                            isTwoColumn = true;
                            texts.push({
                                source: getCellText(cells[0]),
                                translate: getCellText(cells[1])
                            });
                        } else if (cells.length === 1) {
                            texts.push(getCellText(cells[0]));
                        }
                    });
                } else {
                    // 无表格，尝试解析单元格
                    const cells = doc.querySelectorAll('td, th');
                    cells.forEach(cell => {
                        const text = getCellText(cell);
                        if (text) texts.push(text);
                    });
                }
            }

            // 如果 HTML 没解析到内容，用纯文本
            if (texts.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const text = await blob.text();
                console.log('解析纯文本:', text.substring(0, 200));

                // 按行分割
                const lines = text.split('\n').map(t => t.trim()).filter(Boolean);
                lines.forEach(line => {
                    const parts = line.split('\t');
                    if (parts.length >= 2 && type === 'both') {
                        isTwoColumn = true;
                        texts.push({
                            source: parts[0].trim(),
                            translate: parts[1].trim()
                        });
                    } else {
                        texts.push(line);
                    }
                });
            }
        }

        console.log('解析结果:', texts);

        if (texts.length === 0) {
            showToast('剪贴板没有内容', 'error');
            return;
        }

        // 按顺序填充到任务
        const fillCount = Math.min(texts.length, subtitleBatchTasks.length);

        if (type === 'both') {
            // 两列一起粘贴
            for (let i = 0; i < fillCount; i++) {
                if (!subtitleBatchTasks[i]) continue;
                const item = texts[i];
                if (typeof item === 'object' && item.source !== undefined) {
                    // 已解析为对象格式
                    subtitleBatchTasks[i].sourceText = item.source;
                    subtitleBatchTasks[i].translateText = item.translate || '';
                } else if (typeof item === 'string') {
                    // 字符串，尝试 tab 分割
                    const parts = item.split('\t');
                    subtitleBatchTasks[i].sourceText = parts[0].trim();
                    subtitleBatchTasks[i].translateText = parts[1]?.trim() || '';
                }
            }
            console.log('填充后任务列表:', subtitleBatchTasks);
            renderSubtitleBatchList();
            showToast(`已填充 ${fillCount} 条原文+译文`, 'success');
        } else {
            for (let i = 0; i < fillCount; i++) {
                if (!subtitleBatchTasks[i]) continue;
                const item = texts[i];
                const text = typeof item === 'object' ? (type === 'source' ? item.source : item.translate) : item;
                if (type === 'source') {
                    subtitleBatchTasks[i].sourceText = text || '';
                } else {
                    subtitleBatchTasks[i].translateText = text || '';
                }
            }
            renderSubtitleBatchList();
            showToast(`已填充 ${fillCount} 条${type === 'source' ? '原文' : '译文'}`, 'success');
        }
    } catch (error) {
        showToast('粘贴失败: ' + error.message, 'error');
    }
}

// 清空批量列表
function clearSubtitleBatchList() {
    subtitleBatchTasks = [];
    renderSubtitleBatchList();
    showToast('已清空', 'info');
}

// 批量生成字幕
let isSubtitleBatchProcessing = false;

function formatSubtitleTimingCalibration(calibration) {
    if (!calibration) return '未检测';
    const start = Number(calibration.start_delta || 0).toFixed(2);
    const end = Number(calibration.end_delta || 0).toFixed(2);
    const scale = Number(calibration.scale || 1).toFixed(4);
    if (calibration.applied) {
        return `已校准 起点${start}s / 终点${end}s / 缩放${scale}`;
    }
    return `未校准 起点${start}s / 终点${end}s / 缩放${scale}`;
}

async function startBatchGeneration() {
    // 防止重复点击
    if (isSubtitleBatchProcessing) {
        showToast('正在处理中，请稍候', 'info');
        return;
    }

    console.log('批量任务列表:', subtitleBatchTasks);

    if (subtitleBatchTasks.length === 0) {
        showToast('请先添加任务', 'error');
        return;
    }

    // 只需要原文即可（译文可选）
    const readyTasks = subtitleBatchTasks.filter(t => t.sourceText && t.sourceText.trim());
    console.log('就绪任务:', readyTasks.length);

    if (readyTasks.length === 0) {
        showToast('没有就绪的任务（需要原文）', 'error');
        return;
    }

    const language = document.getElementById('language')?.value || '英语';
    const cutLength = parseFloat(document.getElementById('cut-length')?.value) || 5.0;
    const seamless = document.getElementById('seamless')?.checked || false;
    const exportFcpxml = document.getElementById('export-fcpxml')?.checked || false;
    const sourceUp = document.getElementById('source-up')?.checked || false;
    const mergeSrt = document.getElementById('merge-srt')?.checked || false;

    const gladiaKeysText = document.getElementById('gladia-keys')?.value || '';
    const gladiaKeys = gladiaKeysText.split('\n').map(k => k.trim()).filter(Boolean);

    // 并行数 = Key 数量（至少1个）
    const concurrency = Math.max(gladiaKeys.length, 1);
    console.log(`并行数: ${concurrency}, Key 数量: ${gladiaKeys.length}`);

    const generateBtn = document.getElementById('generate-btn');
    generateBtn.disabled = true;
    generateBtn.textContent = '⏳ 批量处理中...';

    let successCount = 0;
    let failCount = 0;
    let processedCount = 0;

    // 收集需要处理的任务
    const readyTaskIndices = [];
    for (let i = 0; i < subtitleBatchTasks.length; i++) {
        const task = subtitleBatchTasks[i];
        if (task.sourceText && task.sourceText.trim()) {
            readyTaskIndices.push(i);
        }
    }

    const totalTasks = readyTaskIndices.length;
    const sourceTextCandidates = readyTaskIndices.map((idx) => ({
        index: idx,
        fileName: subtitleBatchTasks[idx].fileName,
        sourceText: subtitleBatchTasks[idx].sourceText || '',
        translateText: subtitleBatchTasks[idx].translateText || '',
    }));

    // 处理单个任务
    async function processTask(taskIndex, keyIndex) {
        const task = subtitleBatchTasks[taskIndex];
        const keyToUse = gladiaKeys.length > 0 ? [gladiaKeys[keyIndex % gladiaKeys.length]] : [];

        updateStatus(`处理中 ${processedCount + 1}/${totalTasks}: ${task.fileName}`, 'processing');

        // 创建 FormData 上传文件
        const formData = new FormData();
        formData.append('audio_file', task.file);
        formData.append('source_text', task.sourceText);
        formData.append('translate_text', task.translateText || '');
        if (sourceTextCandidates.length > 1) {
            formData.append('source_text_candidates', JSON.stringify(sourceTextCandidates));
        }
        formData.append('language', language);
        formData.append('audio_cut_length', cutLength);
        formData.append('gladia_keys', JSON.stringify(keyToUse));
        formData.append('gen_merge_srt', mergeSrt);
        formData.append('source_up_order', sourceUp);
        formData.append('export_fcpxml', exportFcpxml);
        formData.append('seamless_fcpxml', seamless);

        try {
            const response = await apiFetch(`${API_BASE}/subtitle/generate-with-file`, {
                method: 'POST',
                body: formData
            });

            processedCount++;

            if (response.ok) {
                successCount++;
                subtitleBatchTasks[taskIndex].status = 'success';
                const result = await response.json();
                subtitleBatchTasks[taskIndex].files = result.files || [];
                subtitleBatchTasks[taskIndex].timingCalibration = result.timing_calibration || null;
                // 更新任务状态
                const items = document.querySelectorAll('.subtitle-batch-item');
                if (items[taskIndex]) {
                    const status = items[taskIndex].querySelector('.batch-item-status');
                    if (status) {
                        status.textContent = '✅ 完成';
                        status.style.background = 'rgba(0,255,0,0.2)';
                        status.style.color = '#51cf66';
                    }
                    // 移除重试按钮
                    const retryBtn = items[taskIndex].querySelector('.subtitle-retry-btn');
                    if (retryBtn) retryBtn.remove();
                }
                return { success: true, taskIndex };
            } else {
                failCount++;
                subtitleBatchTasks[taskIndex].status = 'failed';
                const error = await response.json();
                subtitleBatchTasks[taskIndex].error = error.error || '未知错误';
                const items = document.querySelectorAll('.subtitle-batch-item');
                if (items[taskIndex]) {
                    const status = items[taskIndex].querySelector('.batch-item-status');
                    if (status) {
                        status.textContent = '❌ 失败';
                        status.style.background = 'rgba(255,0,0,0.2)';
                        status.style.color = '#f87171';
                    }
                    addSubtitleRetryButton(items[taskIndex], taskIndex);
                }
                return { success: false, taskIndex };
            }
        } catch (error) {
            processedCount++;
            failCount++;
            subtitleBatchTasks[taskIndex].status = 'failed';
            subtitleBatchTasks[taskIndex].error = error.message;
            console.error(`任务 ${taskIndex + 1} 失败:`, error);
            const items = document.querySelectorAll('.subtitle-batch-item');
            if (items[taskIndex]) {
                const status = items[taskIndex].querySelector('.batch-item-status');
                if (status) {
                    status.textContent = '❌ 失败';
                    status.style.background = 'rgba(255,0,0,0.2)';
                    status.style.color = '#f87171';
                }
                addSubtitleRetryButton(items[taskIndex], taskIndex);
            }
            return { success: false, taskIndex };
        }
    }

    // 并行执行（每个 Key 处理一个任务）
    let taskQueue = [...readyTaskIndices];
    const runningTasks = [];

    async function runParallel() {
        while (taskQueue.length > 0 || runningTasks.length > 0) {
            // 启动新任务直到达到并行数
            while (runningTasks.length < concurrency && taskQueue.length > 0) {
                const taskIndex = taskQueue.shift();
                const keyIndex = runningTasks.length;
                const promise = processTask(taskIndex, keyIndex).then(result => {
                    // 从运行队列移除
                    const idx = runningTasks.indexOf(promise);
                    if (idx > -1) runningTasks.splice(idx, 1);
                    return result;
                });
                runningTasks.push(promise);
            }

            // 等待任意一个任务完成
            if (runningTasks.length > 0) {
                await Promise.race(runningTasks);
            }

            updateStatus(`处理中 ${processedCount}/${totalTasks}`, 'processing');
        }
    }

    await runParallel();

    generateBtn.disabled = false;
    generateBtn.textContent = '🚀 生成字幕';

    if (failCount === 0) {
        updateStatus(`批量完成: ${successCount} 个成功`, 'success');
        showToast(`批量完成: ${successCount} 个成功`, 'success');
    } else {
        updateStatus(`批量完成: ${successCount} 成功, ${failCount} 失败`, 'warning');
        showToast(`批量完成: ${successCount} 成功, ${failCount} 失败（可重试）`, 'warning');
        showSubtitleRetryAllButton();
    }

    // 显示结果和下载按钮
    if (successCount > 0) {
        showSubtitleResultsPanel();
    }

    isSubtitleBatchProcessing = false;
}

// 显示结果面板
function showSubtitleResultsPanel() {
    const section = document.getElementById('subtitle-batch-section');
    if (!section) return;

    // 移除旧的结果面板
    const oldPanel = document.getElementById('subtitle-results-panel');
    if (oldPanel) oldPanel.remove();

    // 收集所有成功的文件
    const allFiles = [];
    subtitleBatchTasks.forEach(task => {
        if (task.status === 'success' && task.files) {
            allFiles.push(...task.files);
        }
    });

    if (allFiles.length === 0) return;

    const panel = document.createElement('div');
    panel.id = 'subtitle-results-panel';
    panel.style.cssText = 'margin-top: 16px; padding: 16px; background: var(--bg-secondary); border-radius: 8px;';

    panel.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <h4 style="margin: 0; color: var(--text-primary);">📁 生成结果 (${allFiles.length} 个文件)</h4>
            <button id="download-all-subtitles-btn" class="btn btn-primary" style="padding: 8px 16px;">
                📦 下载全部 (ZIP)
            </button>
        </div>
        <div id="subtitle-file-list" style="max-height: 200px; overflow-y: auto;"></div>
    `;

    section.appendChild(panel);

    // 渲染文件列表
    const fileList = document.getElementById('subtitle-file-list');
    allFiles.forEach(filePath => {
        const fileName = filePath.split('/').pop();
        const item = document.createElement('div');
        item.style.cssText = 'display: flex; align-items: center; padding: 6px 8px; background: var(--bg-tertiary); border-radius: 4px; margin-bottom: 4px;';
        item.innerHTML = `
            <span style="flex: 1; font-size: 12px; color: var(--text-secondary);">${fileName}</span>
        `;
        fileList.appendChild(item);
    });

    const calibrationRows = subtitleBatchTasks
        .filter(task => task.status === 'success' && task.timingCalibration)
        .map(task => `${task.fileName}: ${formatSubtitleTimingCalibration(task.timingCalibration)}`);
    if (calibrationRows.length > 0) {
        const calibrationPanel = document.createElement('div');
        calibrationPanel.style.cssText = 'margin-top: 12px; padding: 10px; background: var(--bg-tertiary); border-radius: 6px; font-size: 12px; color: var(--text-secondary); white-space: pre-wrap;';
        calibrationPanel.textContent = `时间轴校准结果\n${calibrationRows.join('\n')}`;
        panel.appendChild(calibrationPanel);
    }

    // 下载按钮事件
    document.getElementById('download-all-subtitles-btn').onclick = async () => {
        try {
            showToast('正在打包...', 'info');
            const response = await apiFetch(`${API_BASE}/subtitle/download-zip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ files: allFiles })
            });

            if (response.ok) {
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `subtitles_${Date.now()}.zip`;
                a.click();
                URL.revokeObjectURL(url);
                showToast('下载完成', 'success');
            } else {
                showToast('下载失败', 'error');
            }
        } catch (e) {
            showToast('下载失败: ' + e.message, 'error');
        }
    };
}

// 添加单个重试按钮
function addSubtitleRetryButton(item, index) {
    if (item.querySelector('.subtitle-retry-btn')) return;

    const header = item.querySelector('div');
    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-secondary subtitle-retry-btn';
    retryBtn.style.cssText = 'padding: 2px 8px; font-size: 11px; margin-left: 4px;';
    retryBtn.textContent = '🔄 重试';
    retryBtn.onclick = (e) => {
        e.stopPropagation();
        retrySingleSubtitleTask(index);
    };
    header.appendChild(retryBtn);
}

// 显示"重试所有失败"按钮
function showSubtitleRetryAllButton() {
    const section = document.getElementById('subtitle-batch-section');
    if (!section) return;

    const oldBtn = document.getElementById('subtitle-retry-all-btn');
    if (oldBtn) oldBtn.remove();

    const btn = document.createElement('button');
    btn.id = 'subtitle-retry-all-btn';
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'margin-top: 12px; width: 100%;';
    btn.textContent = '🔄 重试所有失败项';
    btn.onclick = retryAllSubtitleTasks;

    const list = document.getElementById('subtitle-batch-list');
    if (list) {
        list.parentNode.insertBefore(btn, list.nextSibling);
    }
}

// 重试单个任务
async function retrySingleSubtitleTask(index) {
    const task = subtitleBatchTasks[index];
    if (!task) return;

    const items = document.querySelectorAll('.subtitle-batch-item');
    const item = items[index];
    if (item) {
        const status = item.querySelector('.batch-item-status');
        if (status) {
            status.textContent = '⏳ 重试中...';
            status.style.background = 'rgba(255,165,0,0.2)';
            status.style.color = '#ffa500';
        }
    }

    const language = document.getElementById('language')?.value || '英语';
    const cutLength = parseFloat(document.getElementById('cut-length')?.value) || 5.0;
    const seamless = document.getElementById('seamless')?.checked || false;
    const exportFcpxml = document.getElementById('export-fcpxml')?.checked || false;
    const sourceUp = document.getElementById('source-up')?.checked || false;
    const mergeSrt = document.getElementById('merge-srt')?.checked || false;
    const gladiaKeysText = document.getElementById('gladia-keys')?.value || '';
    const gladiaKeys = gladiaKeysText.split('\n').map(k => k.trim()).filter(Boolean);
    const sourceTextCandidates = subtitleBatchTasks
        .map((t, idx) => ({
            index: idx,
            fileName: t.fileName,
            sourceText: t.sourceText || '',
            translateText: t.translateText || '',
        }))
        .filter(c => c.sourceText.trim());

    const formData = new FormData();
    formData.append('audio_file', task.file);
    formData.append('source_text', task.sourceText);
    formData.append('translate_text', task.translateText);
    if (sourceTextCandidates.length > 1) {
        formData.append('source_text_candidates', JSON.stringify(sourceTextCandidates));
    }
    formData.append('language', language);
    formData.append('audio_cut_length', cutLength);
    formData.append('gladia_keys', JSON.stringify(gladiaKeys));
    formData.append('gen_merge_srt', mergeSrt);
    formData.append('source_up_order', sourceUp);
    formData.append('export_fcpxml', exportFcpxml);
    formData.append('seamless_fcpxml', seamless);

    try {
        const response = await apiFetch(`${API_BASE}/subtitle/generate-with-file`, {
            method: 'POST',
            body: formData
        });

        if (response.ok) {
            task.status = 'success';
            if (item) {
                const status = item.querySelector('.batch-item-status');
                if (status) {
                    status.textContent = '✅ 完成';
                    status.style.background = 'rgba(0,255,0,0.2)';
                    status.style.color = '#51cf66';
                }
                const retryBtn = item.querySelector('.subtitle-retry-btn');
                if (retryBtn) retryBtn.remove();
            }
            showToast('重试成功', 'success');

            // 检查是否还有失败项
            const hasFailed = subtitleBatchTasks.some(t => t.status === 'failed');
            if (!hasFailed) {
                const retryAllBtn = document.getElementById('subtitle-retry-all-btn');
                if (retryAllBtn) retryAllBtn.remove();
            }
        } else {
            const error = await response.json();
            task.error = error.error || '未知错误';
            if (item) {
                const status = item.querySelector('.batch-item-status');
                if (status) {
                    status.textContent = '❌ 失败';
                    status.style.background = 'rgba(255,0,0,0.2)';
                    status.style.color = '#f87171';
                }
            }
            showToast('重试失败: ' + (error.error || '未知错误'), 'error');
        }
    } catch (error) {
        task.error = error.message;
        if (item) {
            const status = item.querySelector('.batch-item-status');
            if (status) {
                status.textContent = '❌ 失败';
            }
        }
        showToast('重试失败: ' + error.message, 'error');
    }
}

// 重试所有失败任务
async function retryAllSubtitleTasks() {
    const failedIndexes = subtitleBatchTasks
        .map((t, i) => t.status === 'failed' ? i : -1)
        .filter(i => i >= 0);

    if (failedIndexes.length === 0) {
        showToast('没有失败项需要重试', 'info');
        return;
    }

    showToast(`正在重试 ${failedIndexes.length} 个失败项...`, 'info');

    for (const idx of failedIndexes) {
        await retrySingleSubtitleTask(idx);
    }
}

// ==================== 字幕对齐功能 ====================

async function startGeneration() {
    // 检查是否批量模式
    const batchMode = document.getElementById('subtitle-batch-mode')?.checked;

    if (batchMode) {
        await startBatchGeneration();
        return;
    }

    const audioPath = currentAudioPath;
    const sourceText = document.getElementById('source-text').value;
    const translateText = document.getElementById('translate-text').value;
    const language = document.getElementById('language').value;
    const cutLength = parseFloat(document.getElementById('cut-length').value);

    if (!audioPath) {
        showToast('请先选择音视频文件', 'error');
        return;
    }

    if (!sourceText) {
        showToast('请输入原文本', 'error');
        return;
    }

    // 译文是用户手动提供的双语字幕文案，不是这个页面自动生成的翻译。
    // 两者完全一样时仍允许导出，但必须明示提醒，避免误以为已翻译。
    const normalizedSource = sourceText.replace(/\s+/g, ' ').trim();
    const normalizedTranslation = translateText.replace(/\s+/g, ' ').trim();
    if (normalizedTranslation && normalizedTranslation === normalizedSource) {
        showToast('译文与原文完全一样；将导出重复字幕，本页不会自动翻译。', 'info');
    }

    const seamless = document.getElementById('seamless').checked;
    const exportFcpxml = document.getElementById('export-fcpxml').checked;
    const sourceUp = document.getElementById('source-up').checked;
    const mergeSrt = document.getElementById('merge-srt').checked;

    const gladiaKeysText = document.getElementById('gladia-keys').value;
    const gladiaKeys = gladiaKeysText.split('\n').map(k => k.trim()).filter(Boolean);

    const requestData = {
        audio_path: audioPath,
        source_text: sourceText,
        translate_text: translateText,
        language: language,
        audio_cut_length: cutLength,
        gladia_keys: gladiaKeys,
        gen_merge_srt: mergeSrt,
        source_up_order: sourceUp,
        export_fcpxml: exportFcpxml,
        seamless_fcpxml: seamless
    };

    let unsubscribeProgress = null;
    try {
        updateStatus('开始处理...', 'processing');
        document.getElementById('progress-bar').classList.remove('hidden');
        setIndeterminateProgress('progress-bar', true);
        document.getElementById('generate-btn').disabled = true;

        unsubscribeProgress = window.electronAPI?.onSubtitleProgress?.((progress = {}) => {
            updateStatus(progress.message || '正在处理...', 'processing');
        }) || null;

        const response = await apiFetch(`${API_BASE}/subtitle/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            const error = await response.json();
            let errMsg = error.error || '请求失败';
            
            // 处理匹配度拦截
            if (errMsg.includes('"code":"TEXT_MISMATCH"')) {
                try {
                    const mismatchData = JSON.parse(errMsg);
                    errMsg = `⚠️ 文案匹配度警告！\n\nAI 实际听到的声音与您提供的文案匹配度仅有 ${mismatchData.similarity}%，强行对齐将导致错位。\n\n请修改原文案后再试，或在批量表格中使用此功能进行纠错。`;
                } catch(e) {}
            }
            throw new Error(errMsg);
        }

        const result = await response.json();
        updateStatus('完成！', 'success');
        showToast(`字幕对齐完成${result.files?.length ? `，已生成 ${result.files.length} 个文件` : ''}`, 'success', 5000);
        document.getElementById('progress-bar').classList.add('hidden');
        setIndeterminateProgress('progress-bar', false);
        document.getElementById('generate-btn').disabled = false;

    } catch (error) {
        updateStatus('错误: ' + error.message, 'error');
        showToast('错误: ' + error.message, 'error');
        document.getElementById('progress-bar').classList.add('hidden');
        setIndeterminateProgress('progress-bar', false);
        document.getElementById('generate-btn').disabled = false;
    } finally {
        unsubscribeProgress?.();
    }
}

async function pollStatus() {
    try {
        const response = await apiFetch(`${API_BASE}/status`);
        const status = await response.json();

        if (status.is_processing) {
            updateStatus(status.progress || '处理中...', 'processing');
            setTimeout(pollStatus, 1000);
        } else {
            document.getElementById('progress-bar').classList.add('hidden');
            setIndeterminateProgress('progress-bar', false);
            document.getElementById('generate-btn').disabled = false;

            if (status.error) {
                updateStatus('错误: ' + status.error, 'error');
                showToast('处理失败', 'error');
            } else if (status.result) {
                updateStatus('完成！', 'success');
                showToast('字幕生成完成！', 'success', 5000);
            }
        }
    } catch (error) {
        setTimeout(pollStatus, 2000);
    }
}

// ==================== SRT 工具功能 ====================

async function adjustSrt() {
    if (!currentSrtSrcPath) {
        showToast('请先选择源 SRT 文件', 'error');
        return;
    }

    const intervalTime = parseFloat(document.getElementById('interval-time').value);
    const charTime = parseFloat(document.getElementById('char-time').value);
    const minChar = parseInt(document.getElementById('min-char').value);
    const scale = parseFloat(document.getElementById('scale').value);
    const ignoreChars = document.getElementById('ignore-chars').value;

    try {
        const response = await apiFetch(`${API_BASE}/srt/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                src_path: currentSrtSrcPath,
                interval_time: intervalTime,
                char_time: charTime,
                min_char_count: minChar,
                scale: scale,
                ignore: ignoreChars
            })
        });

        const result = await response.json();

        if (response.ok) {
            showToast('调整完成！', 'success');
            updateStatus('输出: ' + result.output_path, 'success');
        } else {
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

async function computeCharTime() {
    if (!currentSrtRefPath) {
        showToast('请先选择参考 SRT 文件', 'error');
        return;
    }

    try {
        const response = await apiFetch(`${API_BASE}/srt/compute-char-time`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ref_path: currentSrtRefPath,
                interval_time: parseFloat(document.getElementById('interval-time').value)
            })
        });

        const result = await response.json();

        if (response.ok) {
            document.getElementById('char-time').value = result.char_time.toFixed(4);
            showToast('字符时间已计算', 'success');
        } else {
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

async function generateSeamlessSrt() {
    if (!currentSeamlessSrtPath) {
        showToast('请先选择 SRT 文件', 'error');
        return;
    }

    try {
        const response = await apiFetch(`${API_BASE}/srt/seamless`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                src_path: currentSeamlessSrtPath
            })
        });

        const result = await response.json();

        if (response.ok) {
            showToast('生成完成！', 'success');
        } else {
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

// ==================== 媒体转换功能 ====================

async function startMediaConvert() {
    if (currentMediaFileInfos.length === 0) {
        showToast('请先选择要转换的文件', 'error');
        return;
    }

    const outputPath = document.getElementById('media-output-path').value;
    const statusEl = document.getElementById('media-status');

    // 直接使用本地文件路径
    const uploadedPaths = currentMediaFileInfos
        .map(f => f.path)
        .filter(p => p);

    if (uploadedPaths.length === 0) {
        showToast('没有有效的文件路径', 'error');
        return;
    }

    // 设置 uploadedPath 供后续使用
    currentMediaFileInfos.forEach(f => { f.uploadedPath = f.path; });

    // 确定当前激活的子标签页
    const activeSubtab = document.querySelector('#media-panel .subtab-content.active');
    const subtabId = activeSubtab?.id || '';

    // 批量截图有自己的独立处理函数
    if (subtabId === 'media-thumbnail-subtab') {
        startBatchThumbnail();
        return;
    }

    // 画面分类有自己的独立处理函数
    if (subtabId === 'media-classify-subtab') {
        startImageClassify();
        return;
    }

    let payload = {
        files: uploadedPaths,
        output_dir: outputPath
    };

    // 根据子标签页构建请求参数
    if (subtabId === 'media-logo-subtab') {
        // Logo 叠加模式
        const logoPreset = document.querySelector('input[name="logo-preset"]:checked')?.value;

        if (logoPreset === 'custom') {
            // 自定义 Logo
            const customLogoPath = document.getElementById('custom-logo-file')?.dataset?.filePath;
            if (!customLogoPath) {
                showToast('请选择自定义 Logo 图片', 'error');
                return;
            }
            payload.mode = 'custom_logo';
            payload.custom_logo = {
                path: customLogoPath,
                x: parseInt(document.getElementById('logo-pos-x').value) || 590,
                y: parseInt(document.getElementById('logo-pos-y').value) || 1810,
                width: parseInt(document.getElementById('logo-width').value) || 400,
                height: parseInt(document.getElementById('logo-height').value) || 90
            };
        } else {
            payload.mode = logoPreset || 'hailuo';
            payload.logo_override = getLogoOverrideFromInputs();
        }

    } else if (subtabId === 'media-watermark-subtab') {
        // 文字水印模式
        payload.mode = 'watermark';

        const text = document.getElementById('watermark-text').value || 'AI Generated';
        const fontFamily = document.getElementById('watermark-font').value || 'Arial';
        const fontSize = parseInt(document.getElementById('watermark-fontsize').value) || 24;
        const color = document.getElementById('watermark-color').value || '#ffffff';
        const opacity = parseFloat(document.getElementById('watermark-opacity').value) || 1;
        const hasStroke = document.getElementById('watermark-stroke').checked;
        const strokeColor = document.getElementById('watermark-stroke-color').value || '#000000';
        const strokeWidth = parseInt(document.getElementById('watermark-stroke-width').value) || 2;
        const hasShadow = document.getElementById('watermark-shadow').checked;
        const position = document.getElementById('watermark-position').value || 'top-right';

        // 位置转换为 FFmpeg xy 表达式
        let posX = 'w-tw-10', posY = '10';
        switch (position) {
            case 'top-left': posX = '10'; posY = '10'; break;
            case 'top-right': posX = 'w-tw-10'; posY = '10'; break;
            case 'bottom-left': posX = '10'; posY = 'h-th-10'; break;
            case 'bottom-right': posX = 'w-tw-10'; posY = 'h-th-10'; break;
            case 'center': posX = '(w-tw)/2'; posY = '(h-th)/2'; break;
            case 'custom':
                posX = document.getElementById('watermark-pos-x').value || 'w-tw-10';
                posY = document.getElementById('watermark-pos-y').value || '10';
                break;
        }

        payload.watermark = {
            text: text,
            font: fontFamily,
            font_size: fontSize,
            color: color,
            opacity: opacity,
            stroke: hasStroke,
            stroke_color: strokeColor,
            stroke_width: strokeWidth,
            shadow: hasShadow,
            x: posX,
            y: posY
        };

    } else if (subtabId === 'media-format-subtab') {
        // 格式转换模式
        const formatMode = document.querySelector('input[name="format-mode"]:checked')?.value || 'h264';
        payload.mode = formatMode;

        if (formatMode === 'audio_split') {
            const exportMp3 = document.getElementById('export-split-mp3').checked;
            const exportMp4 = document.getElementById('export-split-mp4').checked;

            if (!exportMp3 && !exportMp4) {
                showToast('请至少选择一种导出格式', 'error');
                return;
            }

            const cutPointsMap = {};
            for (let i = 0; i < currentMediaFileInfos.length; i++) {
                const file = currentMediaFileInfos[i];
                const input = document.getElementById(`audio-cut-points-${i}`);
                const value = input ? input.value.trim() : '';

                // 允许不填写裁切点（直接转换整个文件）
                // 使用上传后的路径作为 key
                const serverPath = file.uploadedPath || file.path;
                if (value) {
                    cutPointsMap[serverPath] = value;
                    currentAudioCutPoints[file.path] = value;
                }
            }

            payload.cut_points_map = cutPointsMap;
            payload.export_mp3 = exportMp3;
            payload.export_mp4 = exportMp4;
        } else if (formatMode === 'audio_fx') {
            payload.reverbEnabled = document.getElementById('audio-fx-reverb-enabled')?.checked || false;
            payload.reverbPreset = document.getElementById('audio-fx-reverb-preset')?.value || 'hall';
            payload.reverbMix = parseFloat(document.getElementById('audio-fx-reverb-mix')?.value || '30');
            payload.stereoWidth = parseFloat(document.getElementById('audio-fx-stereo-width')?.value || '100');
            payload.outputFormat = document.getElementById('audio-fx-output-format')?.value || 'mp3';
        } else if (formatMode === 'txt_wrap') {
            payload.txt_wrap_width = parseInt(document.getElementById('txt-wrap-width')?.value || '18');
        }
    } else {
        // 默认：使用第一个子标签页的 Logo 模式
        payload.mode = document.querySelector('input[name="logo-preset"]:checked')?.value || 'hailuo';
    }

    try {
        updateStatus('开始转换...', 'processing', 'media-status');
        document.getElementById('media-progress').classList.remove('hidden');
        setIndeterminateProgress('media-progress', true);

        const response = await apiFetch(`${API_BASE}/media/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        document.getElementById('media-progress').classList.add('hidden');
        setIndeterminateProgress('media-progress', false);

        if (response.ok) {
            updateStatus('转换完成！', 'success', 'media-status');
            showToast(result.message, 'success');

            // 显示下载链接（带时长信息）
            if (result.files && result.files.length > 0) {
                showConvertedFilesDownload(result.files, result.files_info);
            }
        } else {
            updateStatus('错误: ' + result.error, 'error', 'media-status');
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        document.getElementById('media-progress').classList.add('hidden');
        setIndeterminateProgress('media-progress', false);
        updateStatus('请求失败', 'error', 'media-status');
        showToast('请求失败: ' + error.message, 'error');
    }
}

function showConvertedFilesDownload(files, filesInfo) {
    // 在状态区域下方显示下载链接
    const statusSection = document.querySelector('#media-panel .status-section');
    if (!statusSection) return;

    // 移除旧的下载区域
    const oldDownloadArea = document.getElementById('media-download-area');
    if (oldDownloadArea) oldDownloadArea.remove();

    const downloadArea = document.createElement('div');
    downloadArea.id = 'media-download-area';
    downloadArea.style.cssText = 'margin-top: 12px; padding: 12px; background: var(--bg-tertiary); border-radius: 8px;';

    // 标题行和下载全部按钮
    const header = document.createElement('div');
    header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: 500; color: var(--text-primary);';
    title.textContent = `✅ 已生成 ${files.length} 个文件:`;

    const downloadAllBtn = document.createElement('button');
    downloadAllBtn.className = 'btn btn-primary';
    downloadAllBtn.style.cssText = 'padding: 4px 12px; font-size: 12px;';
    downloadAllBtn.textContent = '📦 下载全部';
    downloadAllBtn.onclick = () => downloadAllFiles(files);

    header.appendChild(title);
    header.appendChild(downloadAllBtn);
    downloadArea.appendChild(header);

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto;';

    // 创建路径到时长的映射
    const durationMap = {};
    if (filesInfo) {
        filesInfo.forEach(info => {
            durationMap[info.path] = info.duration;
        });
    }

    files.forEach(filePath => {
        const filename = filePath.split('/').pop();
        // 去掉 UUID 前缀
        let displayName = filename;
        if (filename.includes('_') && filename.split('_')[0].length === 8) {
            displayName = filename.split('_').slice(1).join('_');
        }

        // 获取时长
        const duration = durationMap[filePath];
        const durationStr = duration ? ` (${formatDuration(duration)})` : '';

        const link = document.createElement('a');
        link.href = normalizeFilePath(filePath);
        link.textContent = `📥 ${displayName}${durationStr}`;
        link.style.cssText = 'color: var(--accent); text-decoration: none; font-size: 13px;';
        link.download = displayName;
        list.appendChild(link);
    });

    downloadArea.appendChild(list);
    statusSection.appendChild(downloadArea);
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
}

async function downloadAllFiles(files) {
    showToast('正在打包 ZIP...', 'info');

    try {
        const response = await apiFetch(`${API_BASE}/file/download-zip`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files })
        });

        if (!response.ok) {
            throw new Error('打包失败');
        }

        // 获取 blob 并触发下载
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'converted_files.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('ZIP 打包下载完成', 'success');
    } catch (error) {
        showToast('下载失败: ' + error.message, 'error');
    }
}

async function selectMediaOutputDir() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('media-output-path').value = dir;
        }
    } catch (error) {
        console.error('选择目录失败:', error);
        showToast('选择目录失败', 'error');
    }
}

// ==================== 媒体工具箱 ====================

const MTB_TOOLS = [
    { id: 'mp4', category: 'common', label: 'H.264 MP4', desc: '通用 MP4 输出，适合上传和预览。', mode: 'mp4', input: 'file' },
    { id: 'mov', category: 'common', label: 'MOV 输出', desc: '保留 MOV 容器，使用 H.264 编码。', mode: 'mov', input: 'file' },
    { id: 'webm', category: 'common', label: 'WebM 输出', desc: '网页端更友好的 VP9/WebM。', mode: 'webm', input: 'file' },
    { id: 'gif', category: 'common', label: 'GIF 动图', desc: '快速导出低帧率预览 GIF。', mode: 'gif', input: 'file' },
    { id: 'watermark', category: 'common', label: '文字水印', desc: '给视频叠加可配置文字水印。', mode: 'watermark', input: 'file', options: 'watermark' },
    { id: 'logo', category: 'common', label: 'Logo 叠加', desc: 'Logo 预设、位置尺寸和双背景预览。', portSubtab: 'media-logo', needsGlobalInput: true },

    { id: 'mp3', category: 'audio', label: '提取音频 MP3', desc: '从视频/音频中提取为 192kbps 双声道 MP3。', mode: 'mp3', input: 'file' },
    { id: 'wav', category: 'audio', label: '转 WAV', desc: '转换为 PCM WAV，适合后期处理。', mode: 'wav', input: 'file' },
    { id: 'aac', category: 'audio', label: '转 AAC', desc: '输出 AAC 音频文件。', mode: 'aac', input: 'file' },
    { id: 'flac', category: 'audio', label: '转 FLAC', desc: '输出无损 FLAC 音频。', mode: 'flac', input: 'file' },
    { id: 'audio_black', category: 'audio', label: '音频转黑屏 MP4', desc: '把音频封装成黑屏视频。', mode: 'audio_black', input: 'file' },
    { id: 'audio_fx', category: 'audio', label: '混响 / 立体声', desc: '给音频添加混响并调节立体声宽度。', mode: 'audio_fx', input: 'file', options: 'audio_fx' },
    { id: 'audio_split', category: 'audio', label: '音频裁切', desc: '按裁切点批量导出分段音频。', mode: 'audio_split', input: 'file', options: 'audio_split' },

    { id: 'scene', category: 'analysis', label: '场景检测', desc: '检测镜头切换并导出场景片段。', portSubtab: 'media-scene' },
    { id: 'smartkf', category: 'analysis', label: '智能关键帧', desc: '按场景边界和采样策略提取关键帧。', portSubtab: 'media-smartkf' },
    { id: 'thumbnail', category: 'analysis', label: '批量截图', desc: '从文件夹或链接批量截取画面。', portSubtab: 'media-thumbnail' },
    { id: 'classify', category: 'analysis', label: '画面分类', desc: '对图片/视频帧进行分类整理。', portSubtab: 'media-classify' },

    { id: 'batchcut', category: 'edit', label: '批量剪辑', desc: '批量入出点剪辑和 FCPXML 时间线。', portSubtab: 'media-batchcut' },
    { id: 'autoedit', category: 'edit', label: '文案自动剪辑', desc: '按断行文案识别片段语音，自动裁切、拼接并生成最终字幕。', mode: 'auto_edit', input: 'file', options: 'auto_edit' },
    { id: 'lipsync', category: 'edit', label: '口型同步', desc: '口型同步视频生成流程。', portSubtab: 'media-lipsync' },

    { id: 'txtwrap', category: 'text', label: 'TXT 智能断行', desc: '从表格粘贴文案并批量断行。', portSubtab: 'media-format', legacyFormatMode: 'txt_wrap', needsGlobalInput: true },
    { id: 'batchtxt', category: 'text', label: '批量 TXT 导出', desc: '从表格单元格批量生成 TXT 文件。', portSubtab: 'media-batchtxt' },
    { id: 'rename', category: 'text', label: '统一命名', desc: '不同格式文件统一基础文件名。', portSubtab: 'media-unirename' },
];

const mtbState = {
    category: 'common',
    selectedToolId: 'mp4',
    files: [],
    ported: new Map(),
};

const MTB_HELP = {
    default: {
        purpose: '处理当前选中的媒体文件，并把结果输出到指定目录。',
        steps: ['选择或拖拽一个或多个文件。', '按需要调整参数。', '选择输出目录，或留空使用源文件所在目录。', '点击开始处理，完成后在结果区打开生成文件。'],
        notes: ['路径和文件名尽量使用英文字符，避免 FFmpeg 处理失败。', '批量处理时建议先用 1 个文件测试参数。']
    },
    mp4: {
        purpose: '把视频转成通用 H.264 MP4，适合上传、预览和跨平台播放。',
        steps: ['选择视频文件。', '输出目录可留空。', '点击开始处理。'],
        notes: ['当前使用后端默认 H.264 参数。', '如果需要更细的压缩质量控制，后续可在这里增加 CRF/码率预设。']
    },
    mov: {
        purpose: '把视频转成 MOV 容器，适合某些剪辑软件流程。',
        steps: ['选择视频文件。', '选择输出目录。', '点击开始处理。'],
        notes: ['当前仍使用 H.264 视频编码，只是输出容器为 MOV。']
    },
    webm: {
        purpose: '输出 WebM 视频，适合网页端展示。',
        steps: ['选择视频文件。', '点击开始处理。'],
        notes: ['WebM 编码通常比 MP4 更慢。', '部分剪辑软件对 WebM 支持不完整。']
    },
    gif: {
        purpose: '把视频转成低帧率 GIF 动图，用于快速预览或分享。',
        steps: ['选择一个短视频。', '点击开始处理。'],
        notes: ['GIF 文件可能很大，建议输入短片段。', '当前默认 10fps、宽度约 480px。']
    },
    watermark: {
        purpose: '给视频添加文字水印。',
        steps: ['选择视频文件。', '设置水印文字、字号、颜色、位置。', '点击开始处理。'],
        notes: ['水印会重新编码视频。', '当前提供常用参数；旧版仍有更完整预览。']
    },
    logo: {
        purpose: '给视频叠加预设 Logo 或自定义 Logo。',
        steps: ['在输入区选择视频文件。', '选择 Logo 预设或自定义 Logo。', '调整 X/Y/宽/高，并查看预览。', '点击开始转换。'],
        notes: ['这个工具已直接挂载旧版成熟界面，不是跳转占位。', 'Logo 位置参数按 1080x1920 竖屏设计。']
    },
    mp3: {
        purpose: '从视频或音频文件中提取声音，并转换为 MP3。',
        steps: ['选择音频或视频文件。', '点击开始处理。'],
        notes: ['默认输出 192kbps 双声道 MP3。', '视频输入会自动忽略画面。']
    },
    wav: {
        purpose: '转换为 WAV，适合转录、音频分析和后期处理。',
        steps: ['选择音频或视频文件。', '点击开始处理。'],
        notes: ['WAV 文件体积通常比 MP3 大很多。']
    },
    aac: {
        purpose: '转换为 AAC 音频。',
        steps: ['选择音频或视频文件。', '点击开始处理。'],
        notes: ['适合需要较好兼容性和较小体积的音频输出。']
    },
    flac: {
        purpose: '转换为无损 FLAC 音频。',
        steps: ['选择音频文件。', '点击开始处理。'],
        notes: ['FLAC 比 MP3 大，但保留无损音质。']
    },
    audio_black: {
        purpose: '把音频转成黑屏 MP4，方便上传到只接受视频的平台。',
        steps: ['选择音频文件。', '点击开始处理。'],
        notes: ['输出视频画面为黑屏，音频保持可播放。']
    },
    audio_fx: {
        purpose: '给音频添加混响，并调整立体声宽度。',
        steps: ['选择音频或带音轨的视频。', '设置混响预设、混响量、立体声宽度和输出格式。', '点击开始处理。'],
        notes: ['视频输入会先提取音频再处理。', '混响量建议从 20%-40% 开始测试。']
    },
    audio_split: {
        purpose: '按时间点把音频批量切成多个片段。',
        steps: ['选择一个或多个音频文件。', '输入裁切点，例如 00:29, 00:58.5。', '选择导出 MP3 或黑屏 MP4。', '点击开始处理。'],
        notes: ['对所有文件使用同一组裁切点。', '需要波形预览和每文件独立裁切点时，可继续使用同一工具内挂载的成熟界面。']
    },
    scene: {
        purpose: '检测视频镜头切换，并按场景导出片段或场景帧。',
        steps: ['选择一个或多个视频。', '设置灵敏度和最小间隔。', '点击批量场景检测。', '检查每个文件的检测结果并导出。'],
        notes: ['灵敏度越小，检测出的切点越多。', '先用默认 0.3 测试，再按结果微调。']
    },
    smartkf: {
        purpose: '从视频中提取关键帧，用于素材筛选、画面分析和封面挑选。',
        steps: ['选择本地视频，或切换到链接模式粘贴视频链接。', '设置场景检测和截帧策略。', '点击开始智能关键帧提取。'],
        notes: ['默认会输出首尾帧和场景边界帧。', '增加每场景采样会显著增加输出图片数量。']
    },
    thumbnail: {
        purpose: '批量从视频或链接中截图。',
        steps: ['选择本地文件夹或切换到链接截图。', '设置截图规则和输出格式。', '开始批量截图。'],
        notes: ['大量视频会生成很多图片，建议选择独立输出目录。']
    },
    classify: {
        purpose: '对图片或视频画面进行分类整理。',
        steps: ['选择要分类的图片/视频素材。', '设置分类参数。', '开始分类并查看结果。'],
        notes: ['分类准确度取决于画面内容和模型能力。']
    },
    batchcut: {
        purpose: '按入出点批量剪辑，并可导出 FCPXML 时间线。',
        steps: ['选择单个或多个视频。', '添加或粘贴剪辑片段。', '选择快速或精确模式。', '开始批量剪辑，或导出 FCPXML。'],
        notes: ['快速模式依赖关键帧，速度快但不一定帧级精准。', '精确模式会重编码，速度较慢但入出点更准。']
    },
    autoedit: {
        purpose: '把一组已经切成小段的视频，自动匹配到整段文案中的位置，裁切有效语音后按文案顺序拼接，并生成最终 SRT。',
        steps: ['选择多个视频片段。', '粘贴最终成片文案，断行用于字幕显示。', '选择整段匹配或一行一片段兼容模式。', '点击开始处理。'],
        notes: ['需要已配置 Gladia API Key。', '默认不会把断行当成片段边界；只有选择一行一片段模式时才逐行对应。', '片段里多说、少说或提前结束时，会按词级时间轴寻找最接近文案的范围。']
    },
    lipsync: {
        purpose: '根据音频生成口型同步视频。',
        steps: ['选择输入视频和音频。', '设置口型同步参数。', '开始处理。'],
        notes: ['处理速度和稳定性取决于输入视频质量、人脸清晰度和机器性能。']
    },
    txtwrap: {
        purpose: '把批量文案按指定字符数智能断行。',
        steps: ['粘贴 Google Sheets 整列文案。', '设置每行最大字符数。', '点击开始断行。', '复制结果回表格。'],
        notes: ['这是前端纯处理，不需要 FFmpeg。', '单元格内换行会尽量保留结构。']
    },
    batchtxt: {
        purpose: '从表格文案批量导出 TXT 文件。',
        steps: ['粘贴一列文案。', '设置自动断行、起始编号和补零位数。', '选择输出目录。', '点击批量导出 TXT。'],
        notes: ['每个单元格会生成一个 TXT 文件。', '文件名会自动取文案前缀。']
    },
    rename: {
        purpose: '把不同格式文件统一成同一个基础文件名。',
        steps: ['拖拽或选择多个文件。', '选择以某个文件名为准，或手动输入统一名称。', '选择是否复制模式。', '开始统一命名。'],
        notes: ['关闭复制模式会直接重命名原文件。', '同目录同扩展名冲突时需要谨慎处理。']
    }
};

function initMediaToolbox() {
    if (!document.getElementById('media-toolbox-panel')) return;

    document.querySelectorAll('.mtb-cat').forEach(btn => {
        btn.addEventListener('click', () => mtbSelectCategory(btn.dataset.mtbCategory));
    });

    const input = document.getElementById('mtb-input-file');
    if (input) {
        input.addEventListener('change', (e) => mtbSetFiles(Array.from(e.target.files || [])));
    }

    const drop = document.getElementById('mtb-drop-zone');
    if (drop && input) {
        ['dragenter', 'dragover'].forEach(type => {
            drop.addEventListener(type, (e) => {
                e.preventDefault();
                drop.style.borderColor = 'var(--accent)';
                drop.style.background = 'rgba(255,255,255,0.05)';
            });
        });
        ['dragleave', 'drop'].forEach(type => {
            drop.addEventListener(type, (e) => {
                e.preventDefault();
                drop.style.borderColor = '';
                drop.style.background = '';
            });
        });
        drop.addEventListener('drop', (e) => {
            mtbSetFiles(Array.from(e.dataTransfer.files || []));
        });
    }

    mtbRenderTools();
    mtbSelectTool('mp4');
}

function mtbEsc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function mtbSelectCategory(category) {
    mtbState.category = category || 'common';
    document.querySelectorAll('.mtb-cat').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mtbCategory === mtbState.category);
    });
    mtbRenderTools();
    const first = MTB_TOOLS.find(t => t.category === mtbState.category);
    if (first) mtbSelectTool(first.id);
}

function mtbRenderTools() {
    const grid = document.getElementById('mtb-tool-grid');
    if (!grid) return;
    const tools = MTB_TOOLS.filter(t => t.category === mtbState.category);
    grid.innerHTML = tools.map(t => `
        <button class="mtb-tool-card ${t.id === mtbState.selectedToolId ? 'active' : ''}" data-mtb-tool="${mtbEsc(t.id)}">
            <div class="mtb-tool-name">${mtbEsc(t.label)}</div>
            <div class="mtb-tool-desc">${mtbEsc(t.desc)}</div>
        </button>
    `).join('');
    grid.querySelectorAll('.mtb-tool-card').forEach(card => {
        card.addEventListener('click', () => mtbSelectTool(card.dataset.mtbTool));
    });
}

function mtbCurrentTool() {
    return MTB_TOOLS.find(t => t.id === mtbState.selectedToolId) || MTB_TOOLS[0];
}

function mtbSelectTool(toolId) {
    const tool = MTB_TOOLS.find(t => t.id === toolId) || MTB_TOOLS[0];
    if (!tool) return;
    mtbState.selectedToolId = tool.id;
    mtbRenderTools();

    const title = document.getElementById('mtb-tool-title');
    const desc = document.getElementById('mtb-tool-desc');
    const badge = document.getElementById('mtb-tool-badge');
    if (title) title.textContent = tool.label;
    if (desc) desc.textContent = tool.desc;
    if (badge) badge.textContent = tool.portSubtab ? '已迁移' : '可运行';

    const direct = document.getElementById('mtb-direct-tool');
    const ported = document.getElementById('mtb-ported-tool');
    if (tool.portSubtab) {
        direct?.classList.add('hidden');
        ported?.classList.remove('hidden');
        mtbMountPortedTool(tool);
    } else {
        mtbRestorePortedNodes();
        ported?.classList.add('hidden');
        direct?.classList.remove('hidden');
        mtbRenderOptions(tool);
    }
    mtbSetStatus('就绪');
    mtbRenderResults([]);
}

function mtbShowHelp() {
    const tool = mtbCurrentTool();
    if (!tool) return;
    const help = MTB_HELP[tool.id] || MTB_HELP.default;
    const overlay = document.createElement('div');
    overlay.className = 'mtb-help-overlay';
    overlay.innerHTML = `
        <div class="mtb-help-dialog" role="dialog" aria-modal="true" aria-label="${mtbEsc(tool.label)} 使用说明">
            <div class="mtb-help-header">
                <h3 class="mtb-help-title">${mtbEsc(tool.label)} 使用说明</h3>
                <button class="btn btn-secondary" id="mtb-help-close">关闭</button>
            </div>
            <div class="mtb-help-body">
                <div class="mtb-help-section">
                    <h4>用途</h4>
                    <div>${mtbEsc(help.purpose || tool.desc)}</div>
                </div>
                <div class="mtb-help-section">
                    <h4>操作步骤</h4>
                    <ol>${(help.steps || []).map(s => `<li>${mtbEsc(s)}</li>`).join('')}</ol>
                </div>
                <div class="mtb-help-section">
                    <h4>注意事项</h4>
                    <ul>${(help.notes || []).map(s => `<li>${mtbEsc(s)}</li>`).join('')}</ul>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#mtb-help-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    const onKey = (e) => {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', onKey);
        }
    };
    document.addEventListener('keydown', onKey);
}

function mtbRememberPortableNode(id) {
    if (mtbState.ported.has(id)) return mtbState.ported.get(id);
    const node = document.getElementById(id);
    if (!node || !node.parentNode) return null;
    const placeholder = document.createComment(`mtb-placeholder:${id}`);
    node.parentNode.insertBefore(placeholder, node);
    const meta = { node, parent: placeholder.parentNode, placeholder };
    mtbState.ported.set(id, meta);
    return meta;
}

function mtbRestorePortedNodes(keepActive = false) {
    for (const meta of mtbState.ported.values()) {
        if (!meta || !meta.node || !meta.parent || !meta.placeholder) continue;
        if (meta.node.parentNode !== meta.parent) {
            meta.parent.insertBefore(meta.node, meta.placeholder.nextSibling);
        }
        if (!keepActive && meta.node.classList?.contains('subtab-content')) {
            meta.node.classList.remove('active');
        }
    }
    const global = document.getElementById('mtb-ported-global');
    const content = document.getElementById('mtb-ported-content');
    if (global) global.innerHTML = '';
    if (content) content.innerHTML = '';

    // 恢复通用文件选择区的显示状态 (避免在工具箱或特定子标签中被隐藏后无法恢复)
    const mediaFileSection = document.getElementById('media-file-section');
    if (mediaFileSection) {
        const activeItem = document.querySelector('.media-sidebar .sidebar-item.active');
        let subtabName = 'media-logo';
        if (activeItem) {
            if (activeItem.dataset.action === 'format') {
                subtabName = 'media-format';
            } else if (activeItem.dataset.action === 'subtab') {
                subtabName = activeItem.dataset.subtab;
            }
        }
        const tabsWithOwnInput = ['media-scene', 'media-smartkf', 'media-thumbnail', 'media-classify', 'media-lipsync', 'media-batchcut', 'media-autoedit', 'media-batchtxt', 'media-unirename', 'media-audiomatch'];
        mediaFileSection.style.display = tabsWithOwnInput.includes(subtabName) ? 'none' : '';
    }
}

function mtbSetOldMediaSubtabActive(subtabId) {
    const panel = document.getElementById('media-panel');
    if (!panel || !subtabId) return;

    // 激活对应的 sidebar item
    const sidebarItems = panel.querySelectorAll('.media-sidebar .sidebar-item');
    sidebarItems.forEach(item => {
        let isActive = false;
        if (item.dataset.action === 'subtab' && item.dataset.subtab === subtabId) {
            isActive = true;
        } else if (item.dataset.action === 'format' && subtabId === 'media-format') {
            const selectedMode = document.querySelector('input[name="format-mode"]:checked')?.value || 'h264';
            isActive = (item.dataset.mode === selectedMode);
        }
        item.classList.toggle('active', isActive);
    });

    panel.querySelectorAll('.subtab-content').forEach(node => {
        node.classList.toggle('active', node.id === `${subtabId}-subtab`);
    });
}

function mtbMountPortedTool(tool) {
    const ported = document.getElementById('mtb-ported-tool');
    const global = document.getElementById('mtb-ported-global');
    const contentHost = document.getElementById('mtb-ported-content');
    if (!ported || !global || !contentHost) return;

    mtbRestorePortedNodes();
    mtbSetOldMediaSubtabActive(tool.portSubtab);
    global.innerHTML = '';
    contentHost.innerHTML = '';

    // Some mature tools still depend on the original shared media controls.
    const shouldMountSharedControls = tool.needsGlobalInput || tool.portSubtab === 'media-format';
    const sharedIds = shouldMountSharedControls
        ? ['media-file-section', 'media-output-section', 'media-status-section', 'media-start-btn']
        : ['media-output-section'];
    for (const id of sharedIds) {
        const meta = mtbRememberPortableNode(id);
        if (meta?.node) {
            global.appendChild(meta.node);
            if (id === 'media-file-section') {
                meta.node.style.display = ''; // 挂载到新版工具箱时，强制确保其可见
            }
        }
    }

    const contentId = `${tool.portSubtab}-subtab`;
    const meta = mtbRememberPortableNode(contentId);
    if (meta?.node) {
        meta.node.classList.add('active');
        contentHost.appendChild(meta.node);
    }

    if (tool.legacyFormatMode) {
        const radio = document.querySelector(`input[name="format-mode"][value="${tool.legacyFormatMode}"]`);
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    setTimeout(() => {
        if (tool.portSubtab === 'media-logo') updateLogoPreview();
        if (tool.portSubtab === 'media-watermark') updateWatermarkPreview();
    }, 80);
}

function mtbSetFiles(files) {
    mtbState.files = files.map(f => ({
        path: getFileNativePath(f),
        name: f.name || String(f.path || ''),
        file: f
    })).filter(f => f.path);
    const inputPath = document.getElementById('mtb-input-path');
    if (inputPath) {
        inputPath.value = mtbState.files.length === 0
            ? ''
            : mtbState.files.length === 1
                ? mtbState.files[0].name
                : `${mtbState.files.length} 个文件`;
    }
    mtbRenderFileList();
}

function mtbClearFiles() {
    mtbState.files = [];
    const fileInput = document.getElementById('mtb-input-file');
    const pathInput = document.getElementById('mtb-input-path');
    if (fileInput) fileInput.value = '';
    if (pathInput) pathInput.value = '';
    mtbRenderFileList();
}

function mtbRenderFileList() {
    const list = document.getElementById('mtb-file-list');
    if (!list) return;
    if (mtbState.files.length === 0) {
        list.innerHTML = '<div class="hint">还没有选择文件。</div>';
        return;
    }
    list.innerHTML = mtbState.files.map((f, i) => `
        <div class="mtb-file-row"><strong>${i + 1}</strong><span title="${mtbEsc(f.path)}">${mtbEsc(f.name)}</span></div>
    `).join('');
}

function mtbRenderOptions(tool) {
    const root = document.getElementById('mtb-options');
    if (!root) return;

    if (tool.options === 'watermark') {
        root.innerHTML = `
            <div class="mtb-inline-fields">
                <label>文字 <input id="mtb-wm-text" class="input" value="AI Generated" style="width:180px;"></label>
                <label>字号 <input id="mtb-wm-size" class="input input-small" type="number" value="24" min="4" max="200"></label>
                <label>颜色 <input id="mtb-wm-color" type="color" value="#ffffff"></label>
                <label>透明度 <input id="mtb-wm-opacity" class="input input-small" type="number" value="0.7" min="0" max="1" step="0.1"></label>
                <label>位置
                    <select id="mtb-wm-position" class="select">
                        <option value="top-right">右上角</option>
                        <option value="top-left">左上角</option>
                        <option value="bottom-right">右下角</option>
                        <option value="bottom-left">左下角</option>
                        <option value="center">居中</option>
                    </select>
                </label>
                <label><input id="mtb-wm-stroke" type="checkbox" checked> 描边</label>
                <label><input id="mtb-wm-shadow" type="checkbox"> 阴影</label>
            </div>
        `;
        return;
    }

    if (tool.options === 'audio_fx') {
        root.innerHTML = `
            <div class="mtb-inline-fields">
                <label><input id="mtb-fx-reverb-enabled" type="checkbox" checked> 混响</label>
                <label>预设
                    <select id="mtb-fx-reverb-preset" class="select">
                        <option value="hall">大厅</option>
                        <option value="church">教堂</option>
                        <option value="room">房间</option>
                        <option value="plate">Plate</option>
                    </select>
                </label>
                <label>混响量 <input id="mtb-fx-reverb-mix" class="input input-small" type="number" value="30" min="0" max="100">%</label>
                <label>立体声 <input id="mtb-fx-stereo-width" class="input input-small" type="number" value="130" min="100" max="250">%</label>
                <label>格式
                    <select id="mtb-fx-output-format" class="select">
                        <option value="mp3">MP3</option>
                        <option value="wav">WAV</option>
                        <option value="flac">FLAC</option>
                        <option value="m4a">M4A/AAC</option>
                    </select>
                </label>
            </div>
        `;
        return;
    }

    if (tool.options === 'audio_split') {
        root.innerHTML = `
            <div class="mtb-inline-fields">
                <label style="flex:1; min-width:260px;">裁切点
                    <input id="mtb-split-points" class="input" placeholder="例: 00:29, 00:58.5, 01:30">
                </label>
                <label><input id="mtb-split-mp3" type="checkbox" checked> 导出 MP3</label>
                <label><input id="mtb-split-mp4" type="checkbox"> 导出黑屏 MP4</label>
            </div>
            <p class="hint" style="margin-top:8px;">对所有输入文件使用同一组裁切点；复杂波形编辑可从左侧打开旧版音频裁切。</p>
        `;
        return;
    }

    if (tool.options === 'auto_edit') {
        root.innerHTML = `
            <div class="mtb-autoedit-options">
                <label>断行文案
                    <textarea id="mtb-autoedit-script" class="input" rows="8" placeholder="粘贴最终成片文案，可按字幕节奏断行。系统会自动判断每个片段对应文案里的哪几行。"></textarea>
                </label>
                <div class="mtb-inline-fields">
                    <div style="display:flex; flex-direction:column; gap:4px;">
                        <label>语言</label>
                        <div style="position:relative;display:inline-block;" id="mtb-autoedit-lang-picker-wrap">
                          <button id="mtb-autoedit-lang-picker-btn" class="select" style="min-width:130px;text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
                            <span>自动识别</span><span style="font-size:10px;opacity:0.6;">▾</span>
                          </button>
                          <input type="hidden" id="mtb-autoedit-language" value="auto">
                          <div id="mtb-autoedit-lang-dropdown" style="display:none;position:absolute;bottom:100%;left:0;z-index:9999;background:var(--bg-secondary);border:1px solid var(--border-color, #333);border-radius:8px;width:260px;max-height:360px;box-shadow:0 8px 24px rgba(0,0,0,0.5);overflow:hidden;margin-bottom:4px;">
                            <input id="mtb-autoedit-lang-search" type="text" placeholder="🔍 搜索语言 (中文/English/代码)..." style="width:100%;box-sizing:border-box;padding:8px 12px;border:none;border-bottom:1px solid var(--border-color);background:var(--bg-input);color:var(--text-primary);font-size:13px;outline:none;">
                            <div id="mtb-autoedit-lang-list" style="max-height:300px;overflow-y:auto;"></div>
                          </div>
                        </div>
                    </div>
                    <label>匹配方式
                        <select id="mtb-autoedit-match" class="select">
                            <option value="script" selected>整段文案自动匹配</option>
                            <option value="line_per_clip">一行对应一个片段</option>
                        </select>
                    </label>
                    <label>工作流
                        <select id="mtb-autoedit-workflow" class="select">
                            <option value="cut_first" selected>先剪后合 (常规)</option>
                            <option value="concat_first">先合后剪 (加速)</option>
                        </select>
                    </label>
                    <label>转场
                        <select id="mtb-autoedit-transition" class="select">
                            <option value="none" selected>无转场</option>
                            <option value="crossfade">交叉淡化</option>
                            <option value="fade_black">黑场过渡</option>
                            <option value="fade_white">白场过渡</option>
                        </select>
                    </label>
                    <label>转场时长 <input id="mtb-autoedit-transition-duration" class="input input-small" type="number" value="0.35" min="0.05" max="3" step="0.05"> 秒</label>
                    <label>前留白 <input id="mtb-autoedit-lead" class="input input-small" type="number" value="0.04" min="0" max="2" step="0.01"> 秒</label>
                    <label>后留白 <input id="mtb-autoedit-tail" class="input input-small" type="number" value="0.08" min="0" max="2" step="0.01"> 秒</label>
                    <label>匹配阈值 <input id="mtb-autoedit-score" class="input input-small" type="number" value="0.52" min="0.1" max="1" step="0.01"></label>
                    <label><input id="mtb-autoedit-burn" type="checkbox"> 烧录字幕</label>
                    <label><input id="mtb-autoedit-mp3" type="checkbox" checked> 导出 Voice Changer MP3</label>
                    <label><input id="mtb-autoedit-vc-enabled" type="checkbox"> 高级 Voice Changer</label>
                    <label>音色
                        <input id="mtb-autoedit-vc-voice" class="input input-small" list="mtb-autoedit-vc-voices" placeholder="Voice ID" style="width: 180px;">
                        <datalist id="mtb-autoedit-vc-voices"></datalist>
                    </label>
                    <button type="button" class="btn btn-secondary" onclick="loadAutoEditVoiceChangerVoices('mtb')" style="padding: 4px 10px; font-size: 12px;">加载音色</button>
                    <label><input id="mtb-autoedit-vc-replace" type="checkbox" checked> 替换最终视频声音</label>
                    <label><input id="mtb-autoedit-vc-noise" type="checkbox"> 变声前降噪</label>
                    <label>稳定度 <input id="mtb-autoedit-vc-stability" class="input input-small" type="number" value="0.5" min="0" max="1" step="0.05"></label>
                    <label>相似度 <input id="mtb-autoedit-vc-similarity" class="input input-small" type="number" value="0.75" min="0" max="1" step="0.05"></label>
                    <label style="min-width:280px;flex:1;">手动变声音频
                        <input id="mtb-autoedit-manual-audio" class="input input-small" placeholder="选择已生成的新音频，替换最终视频声音" style="width: 100%;">
                    </label>
                    <button type="button" class="btn btn-secondary" onclick="mtbPickAutoEditManualAudio()" style="padding: 4px 10px; font-size: 12px;">选择音频</button>
                    <button type="button" class="btn btn-secondary" onclick="document.getElementById('mtb-autoedit-manual-audio').value=''" style="padding: 4px 10px; font-size: 12px;">清空</button>
                    <label><input id="mtb-autoedit-force" type="checkbox"> 重新转录</label>
                </div>
                <p class="hint" style="margin-top:8px;">默认把断行当作字幕分句，不当作片段边界；兼容模式才会一行对应一个片段。</p>
            </div>
        `;
        setTimeout(() => {
            initSearchableLangPicker({
                btnId: 'mtb-autoedit-lang-picker-btn',
                dropdownId: 'mtb-autoedit-lang-dropdown',
                searchId: 'mtb-autoedit-lang-search',
                listId: 'mtb-autoedit-lang-list',
                hiddenInputId: 'mtb-autoedit-language',
                storageKey: 'mtb_autoedit_language',
                defaultText: '自动识别',
                defaultValue: 'auto',
                hasAuto: true
            });
        }, 10);
        return;
    }

    root.innerHTML = `
        <div class="mtb-option-grid">
            <label class="mtb-option-card">
                <input type="radio" checked>
                <span class="mtb-option-title">默认参数</span>
                <span class="mtb-option-hint">沿用当前后端默认编码参数，适合稳定批处理。</span>
            </label>
        </div>
    `;
}

async function mtbSelectOutputDir() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) document.getElementById('mtb-output-path').value = dir;
    } catch (error) {
        showToast('选择目录失败: ' + error.message, 'error');
    }
}

async function mtbPickAutoEditManualAudio() {
    try {
        const files = await window.electronAPI?.selectFiles?.({
            properties: ['openFile'],
            filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }],
        });
        const filePath = Array.isArray(files) ? files[0] : files;
        if (filePath) {
            const input = document.getElementById('mtb-autoedit-manual-audio');
            if (input) input.value = filePath;
        }
    } catch (error) {
        showToast('选择音频失败: ' + error.message, 'error');
    }
}

window.mtbPickAutoEditManualAudio = mtbPickAutoEditManualAudio;

function mtbSetStatus(text, type = '') {
    const el = document.getElementById('mtb-status');
    if (!el) return;
    el.textContent = text;
    el.style.color = type === 'error' ? '#ff8a8a' : type === 'success' ? 'var(--success)' : '';
}

function mtbBuildPayload(tool) {
    const files = mtbState.files.map(f => f.path).filter(Boolean);
    const payload = {
        files,
        output_dir: document.getElementById('mtb-output-path')?.value || '',
        mode: tool.mode,
    };

    if (tool.options === 'watermark') {
        const position = document.getElementById('mtb-wm-position')?.value || 'top-right';
        const positions = {
            'top-left': ['10', '10'],
            'top-right': ['w-tw-10', '10'],
            'bottom-left': ['10', 'h-th-10'],
            'bottom-right': ['w-tw-10', 'h-th-10'],
            center: ['(w-tw)/2', '(h-th)/2'],
        };
        const [x, y] = positions[position] || positions['top-right'];
        payload.watermark = {
            text: document.getElementById('mtb-wm-text')?.value || 'AI Generated',
            font: 'Arial',
            font_size: parseInt(document.getElementById('mtb-wm-size')?.value || '24', 10),
            color: document.getElementById('mtb-wm-color')?.value || '#ffffff',
            opacity: parseFloat(document.getElementById('mtb-wm-opacity')?.value || '0.7'),
            stroke: document.getElementById('mtb-wm-stroke')?.checked !== false,
            stroke_color: '#000000',
            stroke_width: 2,
            shadow: document.getElementById('mtb-wm-shadow')?.checked || false,
            x, y,
        };
    } else if (tool.options === 'audio_fx') {
        payload.reverbEnabled = document.getElementById('mtb-fx-reverb-enabled')?.checked || false;
        payload.reverbPreset = document.getElementById('mtb-fx-reverb-preset')?.value || 'hall';
        payload.reverbMix = parseFloat(document.getElementById('mtb-fx-reverb-mix')?.value || '30');
        payload.stereoWidth = parseFloat(document.getElementById('mtb-fx-stereo-width')?.value || '130');
        payload.outputFormat = document.getElementById('mtb-fx-output-format')?.value || 'mp3';
    } else if (tool.options === 'audio_split') {
        const exportMp3 = document.getElementById('mtb-split-mp3')?.checked !== false;
        const exportMp4 = document.getElementById('mtb-split-mp4')?.checked || false;
        const rawPoints = document.getElementById('mtb-split-points')?.value || '';
        payload.export_mp3 = exportMp3;
        payload.export_mp4 = exportMp4;
        payload.cut_points_map = {};
        for (const f of files) payload.cut_points_map[f] = rawPoints;
    } else if (tool.options === 'auto_edit') {
        payload.clips = files;
        payload.script_text = document.getElementById('mtb-autoedit-script')?.value || '';
        payload.language = document.getElementById('mtb-autoedit-language')?.value || 'auto';
        payload.match_mode = document.getElementById('mtb-autoedit-match')?.value || 'script';
        payload.workflow_mode = document.getElementById('mtb-autoedit-workflow')?.value || 'cut_first';
        payload.transition_type = document.getElementById('mtb-autoedit-transition')?.value || 'none';
        payload.transition_duration = parseFloat(document.getElementById('mtb-autoedit-transition-duration')?.value || '0.35');
        payload.lead_pad = parseFloat(document.getElementById('mtb-autoedit-lead')?.value || '0.04');
        payload.tail_pad = parseFloat(document.getElementById('mtb-autoedit-tail')?.value || '0.08');
        payload.min_score = parseFloat(document.getElementById('mtb-autoedit-score')?.value || '0.52');
        payload.burn_subtitles = document.getElementById('mtb-autoedit-burn')?.checked || false;
        payload.export_mp3 = document.getElementById('mtb-autoedit-mp3')?.checked !== false;
        payload.voice_changer_enabled = document.getElementById('mtb-autoedit-vc-enabled')?.checked || false;
        payload.voice_changer_voice_id = document.getElementById('mtb-autoedit-vc-voice')?.value || '';
        payload.voice_changer_replace_audio = document.getElementById('mtb-autoedit-vc-replace')?.checked !== false;
        payload.voice_changer_remove_noise = document.getElementById('mtb-autoedit-vc-noise')?.checked || false;
        payload.voice_changer_model_id = 'eleven_multilingual_sts_v2';
        payload.voice_changer_stability = parseFloat(document.getElementById('mtb-autoedit-vc-stability')?.value || '0.5');
        payload.voice_changer_similarity = parseFloat(document.getElementById('mtb-autoedit-vc-similarity')?.value || '0.75');
        payload.manual_audio_path = document.getElementById('mtb-autoedit-manual-audio')?.value || '';
        payload.manual_audio_replace = Boolean(payload.manual_audio_path.trim());
        payload.force_transcribe = document.getElementById('mtb-autoedit-force')?.checked || false;
        payload.target_width = 1080;
        payload.target_height = 1920;
        payload.fps = 30;
    }
    return payload;
}

async function mtbRunSelectedTool() {
    const tool = MTB_TOOLS.find(t => t.id === mtbState.selectedToolId);
    if (!tool) return;
    if (tool.portSubtab) {
        mtbMountPortedTool(tool);
        return;
    }
    if (mtbState.files.length === 0) {
        showToast('请先选择文件', 'error');
        return;
    }
    if (tool.options === 'audio_split') {
        const exportMp3 = document.getElementById('mtb-split-mp3')?.checked !== false;
        const exportMp4 = document.getElementById('mtb-split-mp4')?.checked || false;
        if (!exportMp3 && !exportMp4) {
            showToast('请至少选择一种导出格式', 'error');
            return;
        }
    }
    if (tool.options === 'auto_edit') {
        const scriptText = document.getElementById('mtb-autoedit-script')?.value || '';
        const lineCount = scriptText.split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;
        if (lineCount === 0) {
            showToast('请先粘贴断行文案', 'error');
            return;
        }
        if (document.getElementById('mtb-autoedit-vc-enabled')?.checked && !document.getElementById('mtb-autoedit-vc-voice')?.value?.trim()) {
            showToast('请先选择或填写 ElevenLabs Voice ID', 'error');
            return;
        }
    }

    const progress = document.getElementById('mtb-progress');
    try {
        mtbSetStatus('处理中...', 'processing');
        progress?.classList.remove('hidden');
        setIndeterminateProgress('mtb-progress', true);
        mtbRenderResults([]);

        const payload = mtbBuildPayload(tool);
        const response = await apiFetch(`${API_BASE}/media/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json();

        progress?.classList.add('hidden');
        setIndeterminateProgress('mtb-progress', false);

        if (!response.ok) {
            throw new Error(result.error || '处理失败');
        }
        mtbSetStatus(result.message || '处理完成', 'success');
        const resultFiles = result.files || [
            result.output_path,
            result.final_video_path && result.final_video_path !== result.output_path ? result.final_video_path : '',
            result.srt_path,
            result.mp3_path,
            result.voice_changed_mp3_path,
            result.voice_changed_video_path,
            result.manual_audio_path,
            result.manual_audio_video_path,
            result.subtitled_path,
        ].filter((p, index, arr) => p && arr.indexOf(p) === index);
        mtbRenderResults(resultFiles, result);
        showToast(result.message || '处理完成', 'success');
    } catch (error) {
        progress?.classList.add('hidden');
        setIndeterminateProgress('mtb-progress', false);
        mtbSetStatus('错误: ' + error.message, 'error');
        showToast('处理失败: ' + error.message, 'error');
    }
}

function mtbRenderResults(files, detail = null) {
    const root = document.getElementById('mtb-result');
    if (!root) return;
    if (!files || files.length === 0) {
        root.innerHTML = '';
        return;
    }
    const segmentHtml = detail?.segments?.length ? `
        <div class="mtb-result-segments">
            ${detail.segments.map(seg => `
                <div class="mtb-result-segment">
                    <strong>输出 #${seg.index}</strong>
                    <span>原片段 #${seg.source_index || seg.index}</span>
                    <span>${mtbEsc(seg.duration)}s</span>
                    <span>匹配 ${Math.round((seg.match_score || 0) * 100)}%</span>
                    <span title="${mtbEsc(seg.matched_text || '')}" style="word-break: break-all; line-height: 1.4;">文案 ${seg.script_start_line || '?'}-${seg.script_end_line || '?'}: ${mtbEsc(String(seg.script || '').replace(/\s*\n\s*/g, ' / '))}</span>
                </div>
            `).join('')}
        </div>
    ` : '';
    root.innerHTML = `
        <div class="mtb-result-list">
            <strong>已生成 ${files.length} 个文件</strong>
            ${files.map(p => {
                const name = String(p).split(/[\\/]/).pop();
                return `<a href="${mtbEsc(normalizeFilePath(p))}" title="${mtbEsc(p)}">打开 ${mtbEsc(name)}</a>`;
            }).join('')}
            ${segmentHtml}
        </div>
    `;
}

// ==================== 批量文案断行（前端纯处理） ====================

// ---- 内部状态 ----
let _wrapOriginals = [];   // 原始文案数组
let _wrapResults   = [];   // 断行结果数组

/**
 * 从 Google Sheets 粘贴的 HTML 中解析单元格。
 * Google Sheets 复制时剪贴板包含 text/html，结构为 <table><tr><td>...</td></tr>...</table>
 * 每个 <td> = 一个单元格，内部 <br> / <p> / <div> = 单元格内换行
 */
function _parseCellsFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const rows = doc.querySelectorAll('tr');
    if (rows.length === 0) return null; // 不是表格格式

    const cells = [];
    rows.forEach(tr => {
        const td = tr.querySelector('td, th');
        if (!td) return;
        // 把 <br> 替换成换行
        const clone = td.cloneNode(true);
        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        clone.querySelectorAll('p, div').forEach(el => {
            el.insertAdjacentText('beforebegin', '\n');
        });
        const text = clone.textContent || '';
        cells.push(text.replace(/^\n+/, '').replace(/\n+$/, '')); // trim 首尾换行
    });

    // 去掉末尾空白单元格
    while (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
    return cells.length > 0 ? cells : null;
}

/**
 * 粘贴事件拦截 — 从剪贴板 HTML 中精确识别表格单元格
 * 如果不是表格格式（纯文本），则整坨内容视为 1 条文案
 */
function _handleTxtWrapPaste(e) {
    e.preventDefault();

    const html = e.clipboardData.getData('text/html');
    const plainText = e.clipboardData.getData('text/plain') || '';

    let cells = null;

    // 优先从 HTML 表格解析
    if (html) {
        cells = _parseCellsFromHTML(html);
    }

    // 无表格结构 → 整坨视为 1 条文案
    if (!cells || cells.length === 0) {
        const trimmed = plainText.trim();
        if (!trimmed) { showToast('剪贴板为空', 'warning'); return; }
        cells = [trimmed];
    }

    // 存储，并在输入框显示预览
    _wrapOriginals = cells;
    _wrapResults = [];

    const inputEl = document.getElementById('txt-wrap-input');
    if (cells.length === 1) {
        inputEl.value = cells[0];
    } else {
        inputEl.value = cells.map((c, i) => `【第${i+1}条】\n${c}`).join('\n─────\n');
    }

    document.getElementById('txt-wrap-counter').textContent = `📥 已识别 ${cells.length} 条文案`;
    showToast(`已识别 ${cells.length} 条文案，点击「开始断行」处理`, 'success');
}

/**
 * 初始化粘贴拦截器
 * initMediaModeOptions 已经监听了 format-mode radio，这里只要绑定 paste
 */
function _initTxtWrapPaste() {
    const input = document.getElementById('txt-wrap-input');
    if (input && !input._wrapPasteBound) {
        input.addEventListener('paste', _handleTxtWrapPaste);
        input._wrapPasteBound = true;
    }
}

// 在 DOM 就绪后绑定
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_initTxtWrapPaste, 300);
});

// ==================== UI 操作 ====================

function hideTxtWrapTable() {
    const w = document.getElementById('txt-wrap-table-wrapper');
    if (w) w.style.display = 'none';
    const c = document.getElementById('txt-wrap-counter');
    if (c) c.textContent = '';
    _wrapOriginals = [];
    _wrapResults = [];
}

/** 主入口 — 开始断行 */
function runBatchTextWrap() {
    // 如果 paste 拦截器已经解析过，用 _wrapOriginals；否则把输入框文本当作一条
    if (_wrapOriginals.length === 0) {
        const raw = document.getElementById('txt-wrap-input')?.value || '';
        if (!raw.trim()) { showToast('请先粘贴文案内容', 'error'); return; }
        _wrapOriginals = [raw.trim()];
    }

    const maxLen = parseInt(document.getElementById('txt-wrap-width')?.value || '18');
    _wrapResults = _wrapOriginals.map(c => _wrapTextSmart(c, maxLen));

    // 渲染表格
    _renderWrapTable();

    document.getElementById('txt-wrap-table-wrapper').style.display = 'block';
    document.getElementById('txt-wrap-table-info').textContent = `📊 共 ${_wrapOriginals.length} 条文案`;
    document.getElementById('txt-wrap-counter').textContent = `✅ 已处理 ${_wrapOriginals.length} 条`;
    showToast(`已完成 ${_wrapOriginals.length} 条文案的智能断行`, 'success');
}

function _renderWrapTable() {
    const tbody = document.getElementById('txt-wrap-result-tbody');
    tbody.innerHTML = '';

    _wrapOriginals.forEach((orig, i) => {
        const tr = document.createElement('tr');
        tr.style.cssText = 'border-bottom: 1px solid rgba(255,255,255,0.05);';
        if (i % 2 === 1) tr.style.background = 'rgba(255,255,255,0.02)';

        // # 列
        const tdNum = document.createElement('td');
        tdNum.style.cssText = 'padding:8px 10px; text-align:center; color:var(--text-muted); font-size:11px; vertical-align:top;';
        tdNum.textContent = i + 1;

        // 原文列
        const tdOrig = document.createElement('td');
        tdOrig.style.cssText = 'padding:8px 10px; white-space:pre-wrap; word-break:break-all; font-family:"SF Mono","Menlo",monospace; font-size:12px; line-height:1.6; vertical-align:top; color:var(--text-secondary);';
        tdOrig.textContent = orig;

        // 结果列
        const tdResult = document.createElement('td');
        tdResult.style.cssText = 'padding:8px 10px; white-space:pre-wrap; word-break:break-all; font-family:"SF Mono","Menlo",monospace; font-size:12px; line-height:1.6; vertical-align:top; color:var(--text-primary); font-weight:500;';
        tdResult.textContent = _wrapResults[i];

        tr.appendChild(tdNum);
        tr.appendChild(tdOrig);
        tr.appendChild(tdResult);
        tbody.appendChild(tr);
    });
}

/** 复制全部结果（仅结果列 → 粘贴到一列） */
function copyWrapResults() {
    if (_wrapResults.length === 0) { showToast('请先执行断行', 'error'); return; }
    const text = _wrapResults.map(c => _quoteForSheets(c)).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        showToast(`已复制 ${_wrapResults.length} 条断行结果`, 'success');
    }).catch(() => {
        _fallbackCopy(text);
    });
}

/** 复制原文 + 结果（两列 tab 分隔 → 粘贴后占两列） */
function copyWrapOriginalAndResults() {
    if (_wrapResults.length === 0) { showToast('请先执行断行', 'error'); return; }
    const rows = _wrapOriginals.map((orig, i) => {
        return _quoteForSheets(orig) + '\t' + _quoteForSheets(_wrapResults[i]);
    });
    const text = rows.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        showToast(`已复制 ${_wrapResults.length} 条（原文+结果两列）`, 'success');
    }).catch(() => {
        _fallbackCopy(text);
    });
}

function _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制到剪贴板', 'success');
}

/** 判断字符是否为 CJK / 全角 / 日韩假名 */
function _isCJK(ch) {
    const c = ch.charCodeAt(0);
    return (c >= 0x2E80 && c <= 0x9FFF) ||   // CJK 部首 / 统一汉字
           (c >= 0x3000 && c <= 0x303F) ||   // CJK 符号
           (c >= 0x3040 && c <= 0x30FF) ||   // 平假名 & 片假名
           (c >= 0xF900 && c <= 0xFAFF) ||   // CJK 兼容
           (c >= 0xFE30 && c <= 0xFE4F) ||   // CJK 兼容形式
           (c >= 0xFF00 && c <= 0xFFEF) ||   // 全角
           (c >= 0x20000 && c <= 0x2FA1F);   // 扩展 B–F
}

/** 判断是否为标点（中/英标点都算） */
const _PUNCT_SET = new Set("，。！？、：；,.!?;:…—–·\u201C\u201D\u201E\u2018\u2019\uFF01\uFF1F");
function _isPunctuation(ch) {
    return _PUNCT_SET.has(ch);
}

/** 连续空行合并为一个 */
function _cleanBlankLines(text) {
    const lines = text.split('\n');
    const out = [];
    let blank = false;
    for (const l of lines) {
        if (l.trim() === '') { if (!blank) { out.push(''); blank = true; } }
        else { out.push(l); blank = false; }
    }
    return out.join('\n');
}

/**
 * 智能断行 — 同时兼容 CJK（逐字）和 Latin（逐词）文本
 *
 * 策略：将段落拆分为 token 列表
 *   - CJK 字符 → 每个字独立 token
 *   - 连续非空白非 CJK 字符 → 一个 Latin word token
 * 然后按宽度累积，两个 Latin word 之间加空格，CJK 之间无间距。
 * 遇到标点且当前行超过一半宽度 → 提前换行。
 */
function _wrapTextSmart(text, maxLen) {
    const paragraphs = text.trim().split(/\n\s*\n/);
    const wrappedLines = [];

    const _PUNCT_NO_SPACE_BEFORE = new Set("，。！？、：；,.!?;:…\u201D\u201E\uFF01\uFF1F）】）」”’)]}>");
    const _PUNCT_NO_SPACE_AFTER = new Set("（【「“‘\u201C\u2018([{<");

    for (const para of paragraphs) {
        // 将段落规范为单行（段内换行 → 空格）
        const flat = para.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (!flat) continue;

        // 分词
        const tokens = [];
        let j = 0;
        while (j < flat.length) {
            if (flat[j] === ' ') { j++; continue; }
            if (_isCJK(flat[j]) || _isPunctuation(flat[j])) {
                tokens.push(flat[j]); j++;
            } else {
                let word = '';
                while (j < flat.length && flat[j] !== ' ' && !_isCJK(flat[j])) {
                    word += flat[j]; j++;
                }
                tokens.push(word);
            }
        }
        if (tokens.length === 0) continue;

        let currentLine = '';
        for (const tok of tokens) {
            // 在 Latin token 之间按规则加空格
            const needSpace = currentLine.length > 0
                && !_isCJK(currentLine[currentLine.length - 1])
                && !_isCJK(tok[0])
                && !_PUNCT_NO_SPACE_BEFORE.has(tok[0])
                && !_PUNCT_NO_SPACE_AFTER.has(currentLine[currentLine.length - 1]);
            const sep = needSpace ? ' ' : '';
            const newLen = currentLine.length + sep.length + tok.length;

            if (!currentLine) {
                currentLine = tok;
            } else if (newLen <= maxLen) {
                currentLine += sep + tok;
            } else {
                wrappedLines.push(currentLine);
                currentLine = tok;
            }

            // 标点断行：当前行超过一半宽度且末尾是标点 → 换行
            if (currentLine && _isPunctuation(currentLine[currentLine.length - 1])) {
                if (currentLine.length > maxLen / 2) {
                    wrappedLines.push(currentLine);
                    currentLine = '';
                }
            }
        }
        if (currentLine) wrappedLines.push(currentLine);
        wrappedLines.push(''); // 段落间空行
    }

    while (wrappedLines.length > 0 && wrappedLines[wrappedLines.length - 1] === '') wrappedLines.pop();
    return _cleanBlankLines(wrappedLines.join('\n'));
}

/** 序列化一个单元格为 Sheets 可粘贴的文本 */
function _quoteForSheets(cell) {
    if (cell.includes('\n') || cell.includes('"') || cell.includes('\t')) {
        return '"' + cell.replace(/"/g, '""') + '"';
    }
    return cell;
}



// ==================== ElevenLabs 功能 ====================

async function saveElevenLabsKey() {
    const rawKeys = document.getElementById('elevenlabs-api-keys').value;
    const apiKeys = rawKeys.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
    const useWebToken = document.getElementById('mode-web')?.checked || false;

    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_keys: apiKeys, use_web_token: useWebToken })
        });

        if (response.ok) {
            showToast('设置已保存', 'success');
            loadVoices();
            if (typeof refreshVWVoices === 'function') {
                refreshVWVoices();
            }
            loadQuota();
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}

function updateWebTokenUI() {
    const isWebMode = document.getElementById('mode-web')?.checked || false;
    
    const panelApiKey = document.getElementById('elevenlabs-apikey-panel');
    const panelWeb = document.getElementById('elevenlabs-web-panel');
    
    if (panelApiKey) panelApiKey.style.display = isWebMode ? 'none' : 'block';
    if (panelWeb) panelWeb.style.display = isWebMode ? 'block' : 'none';
    
    const statusSpan = document.getElementById('web-login-status');
    
    if (statusSpan) {
        if (!isWebMode) {
            if (window._webTokenStatusTimer) clearInterval(window._webTokenStatusTimer);
        } else {
            statusSpan.style.background = 'rgba(255,255,255,0.1)';
            statusSpan.style.color = '#aaa';
            statusSpan.textContent = '检查中...';
            
            const checkStatus = async () => {
                try {
                    const res = await apiFetch(`${API_BASE}/elevenlabs/web-status`);
                    const data = await res.json();
                    if (data.hasToken) {
                        statusSpan.style.background = 'rgba(0, 217, 165, 0.15)';
                        statusSpan.style.color = '#00d9a5';
                        statusSpan.textContent = '🟢 已登录就绪';
                    } else {
                        statusSpan.style.background = 'rgba(255, 107, 107, 0.15)';
                        statusSpan.style.color = '#ff6b6b';
                        statusSpan.textContent = '🔴 未登录 / 无凭证';
                    }
                } catch (e) {
                    statusSpan.textContent = '状态未知';
                }
            };
            
            checkStatus();
            if (window._webTokenStatusTimer) clearInterval(window._webTokenStatusTimer);
            window._webTokenStatusTimer = setInterval(checkStatus, 3000);
        }
    }
}

function toggleWebToken() {
    updateWebTokenUI();
    saveElevenLabsKey();
}

async function openElevenLabsWebLogin() {
    try {
        const res = await apiFetch(`${API_BASE}/elevenlabs/web-login`, { method: 'POST' });
        const json = await res.json();
        showToast(json.message || '已打开登录页面', 'success');
    } catch (e) {
        showToast('打开失败: ' + e.message, 'error');
    }
}

async function clearElevenLabsWebLogin() {
    if (!confirm('确定要清除网页登录凭证吗？')) return;
    try {
        const res = await apiFetch(`${API_BASE}/elevenlabs/web-logout`, { method: 'POST' });
        const json = await res.json();
        showToast(json.message || '凭证已清除', 'success');
        updateWebTokenUI();
    } catch (e) {
        showToast('清除失败: ' + e.message, 'error');
    }
}

async function saveManualWebToken() {
    const textarea = document.getElementById('elevenlabs-manual-token');
    const raw = (textarea?.value || '').trim();
    if (!raw) {
        showToast('请先粘贴 Authorization Token', 'error');
        return;
    }

    // 智能解析: 尝试判断用户粘贴的内容类型
    const payload = {};
    if (raw.startsWith('Bearer ') || raw.startsWith('bearer ') || raw.startsWith('eyJ')) {
        // 看起来是 Authorization header value
        payload.authorization = raw.startsWith('eyJ') ? `Bearer ${raw}` : raw;
    } else if (raw.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(raw)) {
        // 看起来像 xi-api-key
        payload.xiApiKey = raw;
    } else {
        // 默认当做 Authorization
        payload.authorization = raw;
    }

    try {
        const res = await apiFetch(`${API_BASE}/elevenlabs/web-token-manual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            showToast(json.message || '✅ Token 已保存', 'success');
            textarea.value = '';
            // 自动切换到网页模式（后端已经设置了 use_web_token=true）
            const modeWeb = document.getElementById('mode-web');
            if (modeWeb && !modeWeb.checked) {
                modeWeb.checked = true;
            }
            updateWebTokenUI();
            // 自动刷新语音列表以验证 Token 是否工作
            if (typeof loadVoices === 'function') loadVoices();
        } else {
            showToast(json.message || '保存失败', 'error');
        }
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

/**
 * 语音类别标签 — 标示免费/付费
 * premade = ElevenLabs 官方预置语音 (免费API可用)
 * cloned = 用户克隆语音 (需付费订阅)
 * generated = AI 生成语音 (需付费订阅)
 * professional = 专业克隆 (需付费订阅)
 */
function _voiceCategoryLabel(category) {
    const map = {
        premade:      '🆓 [免费]',
        cloned:       '💰 [克隆]',
        generated:    '💰 [生成]',
        professional: '💰 [专业]',
    };
    return map[category] || '🆓 [官方]';
}

/** 当下拉选中变化时，显示完整 Voice ID 在提示区域 */
function _setupVoiceSelectTooltip() {
    const select = document.getElementById('voice-select');
    if (!select) return;

    // 创建或获取 tooltip
    let tip = document.getElementById('voice-id-tip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'voice-id-tip';
        tip.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-top: 4px; font-family: monospace; cursor: pointer; padding: 2px 8px; background: rgba(255,255,255,0.03); border-radius: 4px; display: none; transition: all 0.2s;';
        tip.title = '点击复制 Voice ID';
        tip.onclick = () => {
            const vid = select.value;
            if (vid) {
                navigator.clipboard.writeText(vid).then(() => showToast(`已复制 Voice ID: ${vid}`, 'success'));
            }
        };
        select.parentNode.insertBefore(tip, select.nextSibling);
    }

    const updateTip = () => {
        const opt = select.options[select.selectedIndex];
        if (opt && opt.value) {
            const cat = opt.dataset?.category || 'premade';
            const isFree = cat === 'premade';
            const freeTag = isFree
                ? '<span style="color:#00d9a5;font-size:10px;margin-left:6px;">✅ 免费API可用</span>'
                : '<span style="color:#ff9f43;font-size:10px;margin-left:6px;">💳 需付费订阅</span>';
            tip.innerHTML = `Voice ID: <span style="color:var(--text-primary);">${opt.value}</span>${freeTag}`;
            tip.style.display = 'block';
        } else {
            tip.style.display = 'none';
        }
    };

    select.addEventListener('change', updateTip);
    // Also trigger on initial load
    setTimeout(updateTip, 500);
}

async function loadVoices() {
    updateElevenLabsStatus('连接中...');

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/voices`);
        const data = await response.json();

        const select = document.getElementById('voice-select');
        select.innerHTML = '';
        voiceCache.clear();

        if (data.voices && data.voices.length > 0) {
            data.voices.forEach(voice => {
                const option = document.createElement('option');
                option.value = voice.voice_id;
                // 显示格式: [类别] 名称 (voice_id)
                const shortId = voice.voice_id ? voice.voice_id.slice(0, 8) + '...' : '';
                const catLabel = _voiceCategoryLabel(voice.category);
                option.textContent = `${catLabel} ${voice.name.replace(/^\[[^\]]+\]\s*/, '')} (${shortId})`;
                option.dataset.previewUrl = voice.preview_url || '';
                option.dataset.category = voice.category || 'premade';
                option.dataset.fullVoiceId = voice.voice_id || '';
                select.appendChild(option);

                if (voice.voice_id) {
                    voiceCache.set(voice.voice_id, voice.voice_id);
                }
                if (voice.name) {
                    const cleanName = voice.name.replace(/^\[[^\]]+\]\s*/, '');
                    voiceCache.set(cleanName.toLowerCase(), voice.voice_id);
                }
            });
            updateElevenLabsStatus(`已加载 ${data.voices.length} 个语音`);
            showToast(`已加载 ${data.voices.length} 个语音`, 'success');
        } else {
            select.innerHTML = '<option value="">无可用语音</option>';
            updateElevenLabsStatus('无可用语音');
        }

        syncBatchVoiceOptions();
        _setupVoiceSelectTooltip();

        // 同时加载额度
        loadQuota();
    } catch (error) {
        console.error('加载语音失败:', error);
        updateElevenLabsStatus('加载失败');
    }
}

async function searchVoices() {
    const searchTerm = document.getElementById('voice-search-input').value.trim();

    if (!searchTerm) {
        showToast('请输入搜索关键词', 'error');
        return;
    }

    updateElevenLabsStatus(`搜索 "${searchTerm}"...`);

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ search_term: searchTerm })
        });

        const data = await response.json();
        const select = document.getElementById('voice-select');

        console.log('搜索结果:', data);
        console.log('voice-select 元素:', select);

        if (data.voices && data.voices.length > 0) {
            // 添加搜索结果到下拉框（添加标记）
            let addedCount = 0;
            data.voices.forEach(voice => {
                // 检查是否已存在
                let exists = false;
                for (let i = 0; i < select.options.length; i++) {
                    if (select.options[i].value === voice.voice_id) {
                        exists = true;
                        break;
                    }
                }

                if (!exists && voice.voice_id) {
                    const option = document.createElement('option');
                    option.value = voice.voice_id;
                    const shortId = voice.voice_id ? voice.voice_id.slice(0, 8) + '...' : '';
                    option.textContent = `🔍 ${voice.name} (${shortId})`;
                    option.dataset.previewUrl = voice.preview_url || '';
                    option.dataset.category = 'shared';
                    option.dataset.fullVoiceId = voice.voice_id || '';
                    select.appendChild(option);
                    addedCount++;

                    if (voice.voice_id) {
                        voiceCache.set(voice.voice_id, voice.voice_id);
                    }
                    if (voice.name) {
                        const cleanName = voice.name.replace(/^\[[^\]]+\]\s*/, '');
                        voiceCache.set(cleanName.toLowerCase(), voice.voice_id);
                    }
                }
            });

            console.log(`添加了 ${addedCount} 个声音到下拉框`);
            console.log('下拉框当前选项数:', select.options.length);

            // 显示搜索结果列表
            const resultsDiv = document.getElementById('voice-search-results');
            resultsDiv.innerHTML = '';
            resultsDiv.classList.remove('hidden');

            data.voices.forEach((voice, idx) => {
                const item = document.createElement('div');
                item.style.cssText = 'padding: 10px 12px; cursor: pointer; border-radius: 6px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid rgba(255,255,255,0.05);';
                item.onmouseenter = () => item.style.background = 'rgba(255,255,255,0.08)';
                item.onmouseleave = () => item.style.background = '';

                // 第一行: 序号+名称 + 选择按钮
                const topRow = document.createElement('div');
                topRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = `${idx + 1}. ${voice.name}`;
                nameSpan.style.cssText = 'flex: 1; color: var(--text-primary); font-size: 13px; font-weight: 500;';

                const selectBtn = document.createElement('button');
                selectBtn.className = 'btn btn-primary';
                selectBtn.style.cssText = 'padding: 4px 10px; font-size: 12px; flex-shrink: 0;';
                selectBtn.textContent = '选择';
                selectBtn.onclick = (e) => {
                    e.stopPropagation();
                    select.value = voice.voice_id;
                    syncBatchVoiceOptions();
                    showToast(`已选择: ${voice.name}`, 'success');
                    resultsDiv.classList.add('hidden');
                };

                topRow.appendChild(nameSpan);
                topRow.appendChild(selectBtn);

                // 第二行: Voice ID (可复制) + 类型标签
                const bottomRow = document.createElement('div');
                bottomRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const idSpan = document.createElement('span');
                idSpan.textContent = `ID: ${voice.voice_id || 'N/A'}`;
                idSpan.title = '点击复制 Voice ID';
                idSpan.style.cssText = 'font-size: 11px; color: var(--text-muted); font-family: monospace; cursor: pointer; padding: 1px 6px; background: rgba(255,255,255,0.05); border-radius: 3px; transition: background 0.15s;';
                idSpan.onmouseenter = () => idSpan.style.background = 'rgba(255,255,255,0.12)';
                idSpan.onmouseleave = () => idSpan.style.background = 'rgba(255,255,255,0.05)';
                idSpan.onclick = (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(voice.voice_id || '').then(() => {
                        showToast(`已复制 Voice ID: ${voice.voice_id}`, 'success');
                    });
                };

                const sharedBadge = document.createElement('span');
                sharedBadge.textContent = '🌐 社区共享';
                sharedBadge.style.cssText = 'font-size: 10px; padding: 1px 6px; border-radius: 3px; background: rgba(52,152,219,0.2); color: #5dade2;';

                bottomRow.appendChild(idSpan);
                bottomRow.appendChild(sharedBadge);

                item.appendChild(topRow);
                item.appendChild(bottomRow);
                resultsDiv.appendChild(item);
            });

            // 选中第一个搜索结果
            if (data.voices.length > 0) {
                select.value = data.voices[0].voice_id;
            }

            syncBatchVoiceOptions();

            updateElevenLabsStatus(`找到 ${data.voices.length} 个结果`);
            showToast(`找到 ${data.voices.length} 个声音，请从列表中选择`, 'success');
        } else {
            const resultsDiv = document.getElementById('voice-search-results');
            resultsDiv.innerHTML = '<div style="padding: 12px; color: var(--text-secondary); text-align: center;">没有找到匹配的声音</div>';
            resultsDiv.classList.remove('hidden');
            updateElevenLabsStatus('没有找到匹配的声音');
            showToast('没有找到匹配的声音', 'info');
        }
    } catch (error) {
        console.error('搜索失败:', error);
        updateElevenLabsStatus('搜索失败');
        showToast('搜索失败: ' + error.message, 'error');
    }
}

function updateQuotaSummary(quotas) {
    const quotaBar = document.getElementById('quota-bar-inner');
    const quotaText = document.getElementById('quota-text');
    const quotaMeta = document.getElementById('quota-meta');

    if (!quotaBar || !quotaText) return;

    if (!Array.isArray(quotas) || quotas.length === 0) {
        quotaBar.style.width = '0%';
        quotaText.textContent = 'N/A';
        if (quotaMeta) {
            quotaMeta.textContent = '未配置 API Key';
        }
        return;
    }

    let enabledCount = 0;
    let disabledCount = 0;
    let availableCount = 0;
    let errorCount = 0;
    let usageTotal = 0;
    let limitTotal = 0;

    quotas.forEach((quota) => {
        const enabled = quota && quota.enabled !== false;
        if (enabled) {
            enabledCount += 1;
        } else {
            disabledCount += 1;
        }

        if (quota && quota.error) {
            errorCount += 1;
            return;
        }

        const usage = typeof quota.usage === 'number' ? quota.usage : null;
        const limit = typeof quota.limit === 'number' ? quota.limit : null;

        if (enabled && usage !== null && limit !== null && limit > 0) {
            usageTotal += usage;
            limitTotal += limit;
            const remaining = typeof quota.remaining === 'number' ? quota.remaining : (limit - usage);
            if (remaining > 0) {
                availableCount += 1;
            }
        }
    });

    if (limitTotal > 0) {
        const percent = Math.round((usageTotal / limitTotal) * 100);
        quotaBar.style.width = `${percent}%`;
        quotaText.textContent = `总计 ${usageTotal.toLocaleString()} / ${limitTotal.toLocaleString()} (${percent}%)`;

        if (percent > 90) {
            quotaBar.style.background = '#ff4757';
        } else {
            quotaBar.style.background = 'linear-gradient(135deg, #00d9a5, #00b4d8)';
        }

        if (quotaMeta) {
            const parts = [
                `停用 ${disabledCount}`,
                `有额度 ${availableCount}`
            ];
            if (errorCount > 0) {
                parts.push(`异常 ${errorCount}`);
            }
            quotaMeta.textContent = parts.join(' | ');
        }
    } else {
        quotaBar.style.width = '0%';
        quotaText.textContent = 'N/A';
        if (quotaMeta) {
            const parts = [];
            if (enabledCount > 0) parts.push(`启用 ${enabledCount}`);
            if (disabledCount > 0) parts.push(`停用 ${disabledCount}`);
            if (errorCount > 0) parts.push(`异常 ${errorCount}`);
            quotaMeta.textContent = parts.length ? parts.join(' | ') : '无可用额度';
        }
    }
}

async function loadQuota() {
    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/all-quotas`);
        const data = await response.json();
        updateQuotaSummary(data.keys || []);
    } catch (error) {
        console.error('加载额度失败:', error);
    }
}

// 加载所有 API Key 的额度和管理界面
async function loadAllQuotas() {
    const container = document.getElementById('all-keys-quota');
    const list = document.getElementById('all-keys-list');

    if (!container || !list) return;

    container.classList.remove('hidden');
    list.innerHTML = '<div style="text-align: center; color: var(--text-secondary);">加载中...</div>';

    try {
        // 同时获取 key 列表和额度
        const [keysResponse, quotasResponse] = await Promise.all([
            apiFetch(`${API_BASE}/settings/elevenlabs/keys`),
            apiFetch(`${API_BASE}/elevenlabs/all-quotas`)
        ]);

        const keysData = await keysResponse.json();
        const quotasData = await quotasResponse.json();

        const keys = keysData.keys || [];
        const quotas = quotasData.keys || [];

        updateQuotaSummary(quotas);

        // 创建额度映射
        const quotaMap = {};
        quotas.forEach(q => {
            quotaMap[q.key_prefix] = q;
        });

        if (keys.length > 0) {
            list.innerHTML = '';

            // 排序：启用的在前，停用的在后
            const sortedKeys = keys.map((k, i) => ({ ...k, originalIndex: i }));
            sortedKeys.sort((a, b) => {
                const aEnabled = a.enabled !== false;
                const bEnabled = b.enabled !== false;
                if (aEnabled && !bEnabled) return -1;
                if (!aEnabled && bEnabled) return 1;
                return 0;
            });

            sortedKeys.forEach((keyItem, displayIdx) => {
                const idx = keyItem.originalIndex;
                const keyStr = keyItem.key || '';
                const enabled = keyItem.enabled !== false;
                const keyPrefix = keyStr.slice(0, 8) + '...' + keyStr.slice(-4);
                const quota = quotas[idx] || {};

                // 判断颜色：停用=红色，有额度=绿色，无额度=默认
                let rowBg = 'transparent';
                if (!enabled) {
                    rowBg = 'rgba(255, 107, 107, 0.15)';  // 红色背景
                } else if (quota.remaining && quota.remaining > 200) {
                    rowBg = 'rgba(81, 207, 102, 0.1)';  // 绿色背景
                }

                const item = document.createElement('div');
                item.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 8px; margin-bottom: 4px; border-radius: 6px; background: ${rowBg}; opacity: ${enabled ? 1 : 0.7};`;
                item.dataset.index = idx;

                // 排序按钮
                const orderBtns = document.createElement('div');
                orderBtns.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

                const upBtn = document.createElement('button');
                upBtn.textContent = '▲';
                upBtn.style.cssText = 'padding: 0 4px; font-size: 10px; cursor: pointer; background: none; border: 1px solid rgba(255,255,255,0.2); border-radius: 2px; color: var(--text-secondary);';
                upBtn.onclick = () => moveKey(idx, idx - 1);
                upBtn.disabled = idx === 0;

                const downBtn = document.createElement('button');
                downBtn.textContent = '▼';
                downBtn.style.cssText = 'padding: 0 4px; font-size: 10px; cursor: pointer; background: none; border: 1px solid rgba(255,255,255,0.2); border-radius: 2px; color: var(--text-secondary);';
                downBtn.onclick = () => moveKey(idx, idx + 1);
                downBtn.disabled = idx === keys.length - 1;

                orderBtns.appendChild(upBtn);
                orderBtns.appendChild(downBtn);

                // Key 标签
                const label = document.createElement('span');
                label.style.cssText = 'min-width: 120px; font-size: 12px; color: var(--text-secondary);';
                label.textContent = `${idx + 1}. ${keyPrefix}`;
                if (!enabled) label.textContent += ' (已停用)';

                // 额度条
                const bar = document.createElement('div');
                bar.style.cssText = 'flex: 1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;';

                if (quota.percent !== undefined) {
                    const barInner = document.createElement('div');
                    const color = quota.percent > 90 ? '#ff4757' : (quota.percent > 70 ? '#ffa502' : '#2ed573');
                    barInner.style.cssText = `width: ${quota.percent}%; height: 100%; background: ${color};`;
                    bar.appendChild(barInner);
                }

                // 额度文字
                const text = document.createElement('span');
                text.style.cssText = 'min-width: 100px; font-size: 11px; color: var(--text-primary); text-align: right;';
                if (quota.error) {
                    text.textContent = `❌ 错误`;
                    text.style.color = '#f87171';
                } else if (quota.remaining !== undefined) {
                    text.textContent = `剩余: ${quota.remaining.toLocaleString()}`;
                } else {
                    text.textContent = '--';
                }

                // 操作按钮
                const actions = document.createElement('div');
                actions.style.cssText = 'display: flex; gap: 4px;';

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'btn btn-secondary';
                if (enabled) {
                    toggleBtn.style.cssText = 'padding: 2px 6px; font-size: 10px;';
                    toggleBtn.textContent = '⏸ 停用';
                } else {
                    toggleBtn.style.cssText = 'padding: 2px 6px; font-size: 10px; background: #51cf66; color: #fff;';
                    toggleBtn.textContent = '▶ 启用';
                }
                toggleBtn.onclick = () => toggleKey(idx);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'btn btn-secondary';
                deleteBtn.style.cssText = 'padding: 2px 6px; font-size: 10px; color: #f87171;';
                deleteBtn.textContent = '🗑 删除';
                deleteBtn.onclick = () => deleteKey(idx);

                actions.appendChild(toggleBtn);
                actions.appendChild(deleteBtn);

                item.appendChild(orderBtns);
                item.appendChild(label);
                item.appendChild(bar);
                item.appendChild(text);
                item.appendChild(actions);
                list.appendChild(item);
            });
        } else {
            list.innerHTML = '<div style="text-align: center; color: var(--text-secondary);">没有配置 API Key</div>';
        }
    } catch (error) {
        list.innerHTML = `<div style="text-align: center; color: #f87171;">加载失败: ${escapeHtml(error.message)}</div>`;
    }
}

// 切换 Key 启用/停用
async function toggleKey(index) {
    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs/keys`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'toggle', index })
        });
        const result = await response.json();
        if (response.ok) {
            showToast(result.enabled ? 'Key 已启用' : 'Key 已停用', 'success');
            loadAllQuotas();
        } else {
            showToast('操作失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

// 删除 Key
async function deleteKey(index) {
    if (!confirm('确定要删除这个 API Key 吗？')) return;

    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs/keys`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index })
        });
        const result = await response.json();
        if (response.ok) {
            showToast('Key 已删除', 'success');
            loadAllQuotas();
            loadSettings(true);
        } else {
            showToast('删除失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

// 移动 Key 顺序
async function moveKey(fromIndex, toIndex) {
    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs/keys`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'move', from: fromIndex, to: toIndex })
        });
        const result = await response.json();
        if (response.ok) {
            loadAllQuotas();
        } else {
            showToast('移动失败: ' + result.error, 'error');
        }
    } catch (error) {
        showToast('请求失败: ' + error.message, 'error');
    }
}

async function previewVoice() {
    const select = document.getElementById('voice-select');
    const selectedOption = select.options[select.selectedIndex];

    if (!selectedOption || !selectedOption.value) {
        showToast('请先选择一个语音', 'error');
        return;
    }

    const previewUrl = selectedOption.dataset.previewUrl;

    if (!previewUrl) {
        showToast('该声音没有提供预览样本', 'info');
        return;
    }

    updateElevenLabsStatus('正在试听...');
    audioPlayer.src = previewUrl;
    audioPlayer.play();
    document.getElementById('btn-play').disabled = false;
    document.getElementById('btn-play').textContent = '⏸ 暂停';
}

async function generateTTS() {
    const text = document.getElementById('tts-text')?.value?.trim();
    const voiceId = document.getElementById('voice-select')?.value;
    const modelId = document.getElementById('model-select')?.value || 'eleven_v3';
    const savePath = document.getElementById('tts-save-path')?.value?.trim() || '';

    if (!text) {
        showToast('请输入要转换的文本', 'error');
        return;
    }

    if (!voiceId) {
        showToast('请先选择一个语音', 'error');
        return;
    }

    updateElevenLabsStatus('生成中...');

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: text,
                voice_id: voiceId,
                model_id: modelId,
                stability: parseInt(document.getElementById('tts-stability')?.value || 50) / 100,
                save_path: savePath
            })
        });

        const result = await response.json();

        if (response.ok) {
            updateElevenLabsStatus('生成成功');
            let usedInfo = '';
            if (result.used_key) {
                 usedInfo = result.used_key === '__WEB_TOKEN__' ? ' (使用 网页Token)' : ` (使用 Key: ...${result.used_key.slice(-4)})`;
            }
            showToast(`语音生成成功！${usedInfo}`, 'success');

            // 加载生成的音频
            currentAudioPath_elevenlabs = result.file_path;
            audioPlayer.src = normalizeFilePath(result.file_path);
            document.getElementById('btn-play').disabled = false;
            document.getElementById('seek-slider').disabled = false;

            // 刷新额度
            loadQuota();

            // 自动更新保存路径
            document.getElementById('tts-save-path').value = '';
        } else {
            updateElevenLabsStatus('生成失败');
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        updateElevenLabsStatus('生成失败');
        showToast('请求失败: ' + error.message, 'error');
    }
}

function copyVoiceOptions(sourceSelect, targetSelect, preferredValue = '') {
    if (!targetSelect) return;

    const currentValue = preferredValue || targetSelect.value;
    targetSelect.innerHTML = '';

    if (!sourceSelect || sourceSelect.options.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '请先刷新语音...';
        targetSelect.appendChild(option);
        return;
    }

    Array.from(sourceSelect.options).forEach(option => {
        const cloned = option.cloneNode(true);
        targetSelect.appendChild(cloned);
    });

    if (currentValue) {
        targetSelect.value = currentValue;
    }

    if (!targetSelect.value && targetSelect.options.length > 0) {
        targetSelect.selectedIndex = 0;
    }
}

function syncBatchVoiceOptions() {
    const sourceSelect = document.getElementById('voice-select');
    if (!sourceSelect) return;

    const globalSelect = document.getElementById('tts-batch-voice');
    const globalFallback = (globalSelect && globalSelect.value) || sourceSelect.value;

    if (globalSelect) {
        copyVoiceOptions(sourceSelect, globalSelect, globalFallback);
    }

    const rowSelects = document.querySelectorAll('.batch-voice-select');
    rowSelects.forEach(select => {
        const fallback = select.value || (globalSelect ? globalSelect.value : sourceSelect.value);
        copyVoiceOptions(sourceSelect, select, fallback);
    });

    updateBatchVoiceMode();
}

function applyBatchVoiceToRows(voiceId) {
    if (!voiceId) return;
    const rows = document.querySelectorAll('.batch-row');
    rows.forEach(row => {
        const select = row.querySelector('.batch-voice-select');
        if (select) {
            select.value = voiceId;
        }
    });
}

function updateBatchVoiceMode() {
    const useSameCheckbox = document.getElementById('tts-batch-use-same');
    const globalSelect = document.getElementById('tts-batch-voice');
    if (!useSameCheckbox || !globalSelect) return;

    const useSame = useSameCheckbox.checked;
    globalSelect.disabled = !useSame;

    const globalVoice = globalSelect.value || document.getElementById('voice-select')?.value || '';
    const rows = document.querySelectorAll('.batch-row');

    rows.forEach(row => {
        const select = row.querySelector('.batch-voice-select');
        if (!select) return;

        if (useSame) {
            if (row.dataset.prevVoice === undefined) {
                row.dataset.prevVoice = select.value;
            }
            if (globalVoice) {
                select.value = globalVoice;
            }
        } else if (row.dataset.prevVoice !== undefined) {
            select.value = row.dataset.prevVoice;
            delete row.dataset.prevVoice;
        }

        select.disabled = useSame;
    });
}

function addBatchRow(initialText = '', initialVoiceId = '') {
    const list = document.getElementById('tts-batch-list');
    if (!list) return;

    const row = document.createElement('div');
    row.className = 'batch-row';

    const voiceSelect = document.createElement('select');
    voiceSelect.className = 'select batch-voice-select';
    voiceSelect.dataset.initialVoiceId = initialVoiceId;  // 保存初始 Voice ID

    const textArea = document.createElement('textarea');
    textArea.className = 'textarea batch-text';
    textArea.rows = 3;
    textArea.placeholder = '输入文本...';
    textArea.value = initialText;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn btn-secondary batch-remove';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => {
        row.remove();
        if (list.children.length === 0) {
            addBatchRow();
        } else {
            updateBatchVoiceMode();
        }
    });

    row.appendChild(voiceSelect);
    row.appendChild(textArea);
    row.appendChild(removeButton);
    list.appendChild(row);

    syncBatchVoiceOptions();
    updateBatchVoiceMode();

    // 如果有初始 Voice ID，设置选中
    if (initialVoiceId) {
        setTimeout(() => {
            // 尝试选中对应的 voice
            const options = voiceSelect.querySelectorAll('option');
            for (const opt of options) {
                if (opt.value === initialVoiceId) {
                    voiceSelect.value = initialVoiceId;
                    break;
                }
            }
        }, 100);
    }
}

function clearBatchRows() {
    const list = document.getElementById('tts-batch-list');
    if (!list) return;
    list.innerHTML = '';
    showToast('已清空', 'info');
}

// 从剪贴板批量粘贴（支持 Google 表格/Excel）
// 格式：文案 | Voice ID（可选）
async function batchPasteFromClipboard() {
    try {
        const clipboardItems = await navigator.clipboard.read();
        let rows = [];  // 存储 {text, voiceId} 对象

        for (const item of clipboardItems) {
            console.log('剪贴板类型:', item.types);

            // 尝试读取 HTML 格式（表格）- 按行解析
            if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                const html = await blob.text();
                console.log('HTML 内容:', html.substring(0, 500));

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const tableRows = doc.querySelectorAll('tr');

                if (tableRows.length > 0) {
                    tableRows.forEach(tr => {
                        const cells = tr.querySelectorAll('td, th');
                        if (cells.length >= 1) {
                            const text = cells[0]?.textContent.trim() || '';
                            const voiceId = cells[1]?.textContent.trim() || '';
                            if (text) {
                                rows.push({ text, voiceId: isVoiceId(voiceId) ? voiceId : '' });
                            }
                        }
                    });
                }
            }

            // 如果没有 HTML 或没有提取到内容，尝试纯文本
            if (rows.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const text = await blob.text();
                console.log('纯文本内容:', text.substring(0, 500));

                // Google 表格用 \n 分隔行，\t 分隔列
                const lines = text.split('\n');
                lines.forEach(line => {
                    if (!line.trim()) return;
                    const cells = line.split('\t');
                    const textContent = cells[0]?.trim() || '';
                    const voiceId = cells[1]?.trim() || '';
                    if (textContent) {
                        rows.push({ text: textContent, voiceId: isVoiceId(voiceId) ? voiceId : '' });
                    }
                });
            }
        }

        console.log('解析到的任务:', rows);

        if (rows.length === 0) {
            showToast('剪贴板没有有效内容', 'error');
            return;
        }

        // 清空现有内容
        const list = document.getElementById('tts-batch-list');
        if (!list) return;
        list.innerHTML = '';

        // 统计有多少条指定了 Voice ID
        let withVoiceId = 0;

        // 添加新行
        rows.forEach(row => {
            addBatchRow(row.text, row.voiceId);
            if (row.voiceId) withVoiceId++;
        });

        let msg = `已添加 ${rows.length} 条文案`;
        if (withVoiceId > 0) {
            msg += `，其中 ${withVoiceId} 条指定了 Voice ID`;
        }
        showToast(msg, 'success');
    } catch (error) {
        console.error('粘贴失败:', error);
        showToast('粘贴失败: ' + error.message, 'error');
    }
}

// 判断是否是有效的 Voice ID（ElevenLabs Voice ID 通常是 21 位字符）
function isVoiceId(str) {
    if (!str) return false;
    // ElevenLabs Voice ID 格式：21位字母数字组合
    // 例如：JBFqnCBsd6RMkjVDRZzb
    return /^[a-zA-Z0-9]{10,30}$/.test(str);
}

function initBatchTTS() {
    const list = document.getElementById('tts-batch-list');
    if (!list || list.dataset.initialized === 'true') return;
    list.dataset.initialized = 'true';

    const addButton = document.getElementById('tts-batch-add');
    const clearButton = document.getElementById('tts-batch-clear');
    const generateButton = document.getElementById('tts-batch-generate');
    const useSameCheckbox = document.getElementById('tts-batch-use-same');
    const globalSelect = document.getElementById('tts-batch-voice');

    if (addButton) {
        addButton.addEventListener('click', addBatchRow);
    }

    const pasteButton = document.getElementById('tts-batch-paste');
    if (pasteButton) {
        pasteButton.addEventListener('click', batchPasteFromClipboard);
    }

    if (clearButton) {
        clearButton.addEventListener('click', clearBatchRows);
    }
    if (generateButton) {
        generateButton.addEventListener('click', generateTTSBatch);
    }

    if (useSameCheckbox) {
        useSameCheckbox.addEventListener('change', () => {
            updateBatchVoiceMode();
        });
    }

    if (globalSelect) {
        globalSelect.addEventListener('change', () => {
            if (useSameCheckbox && useSameCheckbox.checked) {
                applyBatchVoiceToRows(globalSelect.value);
            }
        });
    }

    if (list.children.length === 0) {
        addBatchRow();
    } else {
        syncBatchVoiceOptions();
    }
}

async function generateTTSBatch() {
    const list = document.getElementById('tts-batch-list');
    const rows = list ? Array.from(list.querySelectorAll('.batch-row')) : [];
    const generateBtn = document.getElementById('tts-batch-generate');

    if (rows.length === 0) {
        showToast('请先添加文本', 'error');
        return;
    }

    const useSame = document.getElementById('tts-batch-use-same')?.checked;
    const globalVoice = document.getElementById('tts-batch-voice')?.value;
    const modelId = document.getElementById('model-select')?.value || 'eleven_v3';

    if (useSame && !globalVoice) {
        showToast('请选择语音', 'error');
        return;
    }

    // 收集任务
    const tasks = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const text = row.querySelector('.batch-text')?.value.trim();
        if (!text) continue;

        const voiceSelect = row.querySelector('.batch-voice-select');
        const voiceId = useSame ? globalVoice : voiceSelect?.value;

        if (!voiceId) {
            showToast(`第 ${i + 1} 条未选择语音`, 'error');
            return;
        }

        tasks.push({
            rowIndex: i,
            row: row,
            text: text,
            voice_id: voiceId,
            model_id: modelId,
            seq_num: tasks.length + 1  // 序号
        });
    }

    if (tasks.length === 0) {
        showToast('请先输入要生成的文本', 'error');
        return;
    }

    // 获取启用的 Key 数量用于并行
    let enabledKeyCount = 1;
    try {
        const keysResponse = await apiFetch(`${API_BASE}/settings/elevenlabs/keys`);
        const keysData = await keysResponse.json();
        enabledKeyCount = (keysData.keys || []).filter(k => k.enabled !== false).length || 1;
    } catch (e) {
        console.log('获取 Key 数量失败，使用默认并行数 1');
    }

    const concurrency = Math.min(enabledKeyCount, tasks.length);
    console.log(`ElevenLabs 并行数: ${concurrency}, 启用 Key 数: ${enabledKeyCount}`);

    // 更新按钮状态
    const originalText = generateBtn.textContent;
    generateBtn.textContent = '⏳ 生成中...';
    generateBtn.disabled = true;
    generateBtn.style.opacity = '0.6';

    let successCount = 0;
    let failCount = 0;
    let processedCount = 0;
    const totalTasks = tasks.length;

    updateElevenLabsStatus(`批量生成中 (0/${totalTasks})，并行: ${concurrency}...`);

    // 处理单个任务
    async function processTask(task, keyIndex) {
        const { row, text, voice_id, model_id, seq_num, rowIndex } = task;

        // 更新行状态
        let statusSpan = row.querySelector('.batch-status');
        if (!statusSpan) {
            statusSpan = document.createElement('span');
            statusSpan.className = 'batch-status';
            statusSpan.style.cssText = 'font-size: 12px; margin-left: 8px; padding: 2px 6px; border-radius: 4px;';
            row.appendChild(statusSpan);
        }
        statusSpan.textContent = '⏳ 生成中...';
        statusSpan.style.background = 'rgba(255,165,0,0.2)';
        statusSpan.style.color = '#ffa500';

        try {
            const enableCircuitBreaker = document.getElementById('tts-circuit-breaker')?.checked || false;
            const response = await apiFetch(`${API_BASE}/elevenlabs/tts-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    items: [{
                        text,
                        voice_id,
                        model_id,
                        seq_num,
                        key_index: keyIndex  // 指定使用哪个 Key
                    }],
                    default_model_id: model_id,
                    output_format: 'mp3_44100_128',
                    enable_circuit_breaker: enableCircuitBreaker
                })
            });

            const result = await response.json();
            const r = result.results?.[0];
            processedCount++;

            if (r && !r.error) {
                successCount++;
                let keyStr = '';
                if (r.used_key) {
                    keyStr = r.used_key === '__WEB_TOKEN__' ? ' (网)' : ` (...${r.used_key.slice(-4)})`;
                }
                statusSpan.textContent = `✅ 成功${keyStr}`;
                statusSpan.style.background = 'rgba(0,255,0,0.2)';
                statusSpan.style.color = '#51cf66';
                row.dataset.failed = 'false';
                row.dataset.filePath = r.file_path || '';

                // 移除重试按钮
                const retryBtn = row.querySelector('.batch-retry');
                if (retryBtn) retryBtn.remove();

                return { success: true, file_path: r.file_path };
            } else {
                failCount++;
                statusSpan.textContent = `❌ ${(r?.error || '未知错误').substring(0, 20)}`;
                statusSpan.style.background = 'rgba(255,0,0,0.2)';
                statusSpan.style.color = '#f87171';
                row.dataset.failed = 'true';
                row.dataset.error = r?.error || '未知错误';

                // 添加重试按钮
                if (!row.querySelector('.batch-retry')) {
                    const retryBtn = document.createElement('button');
                    retryBtn.className = 'btn btn-secondary batch-retry';
                    retryBtn.style.cssText = 'padding: 4px 8px; font-size: 11px; margin-left: 4px;';
                    retryBtn.textContent = '🔄 重试';
                    retryBtn.onclick = () => retrySingleBatch(row);
                    row.appendChild(retryBtn);
                }

                return { success: false };
            }
        } catch (error) {
            processedCount++;
            failCount++;
            statusSpan.textContent = `❌ ${error.message.substring(0, 20)}`;
            statusSpan.style.background = 'rgba(255,0,0,0.2)';
            statusSpan.style.color = '#f87171';
            row.dataset.failed = 'true';
            row.dataset.error = error.message;
            return { success: false };
        }
    }

    // 并行执行
    const taskQueue = [...tasks];
    const runningTasks = [];
    const successResults = [];

    async function runParallel() {
        while (taskQueue.length > 0 || runningTasks.length > 0) {
            // 启动新任务
            while (runningTasks.length < concurrency && taskQueue.length > 0) {
                const task = taskQueue.shift();
                const keyIndex = runningTasks.length;
                const promise = processTask(task, keyIndex).then(result => {
                    const idx = runningTasks.indexOf(promise);
                    if (idx > -1) runningTasks.splice(idx, 1);
                    if (result.success && result.file_path) {
                        successResults.push(result);
                    }
                    return result;
                });
                runningTasks.push(promise);
            }

            if (runningTasks.length > 0) {
                await Promise.race(runningTasks);
            }

            updateElevenLabsStatus(`批量生成中 (${processedCount}/${totalTasks})...`);
        }
    }

    await runParallel();

    // 完成
    generateBtn.textContent = originalText;
    generateBtn.disabled = false;
    generateBtn.style.opacity = '1';

    loadQuota();

    // 自动下载成功的文件
    if (successResults.length > 0) {
        showToast(`正在下载 ${successResults.length} 个文件...`, 'info');
        for (const r of successResults) {
            const filename = r.file_path.split('/').pop();
            const link = document.createElement('a');
            link.href = normalizeFilePath(r.file_path);
            link.download = filename;
            link.click();
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    if (failCount > 0) {
        updateElevenLabsStatus(`完成: ${successCount} 成功, ${failCount} 失败`);
        showToast(`成功 ${successCount} 个，失败 ${failCount} 个（可点击重试）`, 'warning');
        showRetryAllFailedButton();
    } else {
        updateElevenLabsStatus(`批量完成: ${successCount} 个成功`);
        showToast(`全部成功: ${successCount} 个`, 'success');
    }
}

// 显示"重试所有失败"按钮
function showRetryAllFailedButton() {
    const container = document.querySelector('#tts-batch-list');
    if (!container) return;

    // 移除旧的重试按钮
    const oldBtn = document.getElementById('retry-all-failed-btn');
    if (oldBtn) oldBtn.remove();

    const btn = document.createElement('button');
    btn.id = 'retry-all-failed-btn';
    btn.className = 'btn btn-primary';
    btn.style.cssText = 'margin-top: 12px; width: 100%;';
    btn.textContent = '🔄 重试所有失败项';
    btn.onclick = retryAllFailed;

    container.parentNode.insertBefore(btn, container.nextSibling);
}

// 重试单个失败项
async function retrySingleBatch(row) {
    const text = row.querySelector('.batch-text')?.value?.trim();
    const voiceSelect = row.querySelector('.batch-voice-select');
    const useSame = document.getElementById('tts-batch-use-same')?.checked;
    const globalVoice = document.getElementById('tts-batch-voice')?.value;
    const modelId = document.getElementById('model-select')?.value || 'eleven_v3';
    const voiceId = useSame ? globalVoice : voiceSelect?.value;

    if (!text || !voiceId) {
        showToast('缺少文本或语音', 'error');
        return;
    }

    const statusSpan = row.querySelector('.batch-status');
    if (statusSpan) {
        statusSpan.textContent = '⏳ 重试中...';
        statusSpan.style.background = 'rgba(255,165,0,0.2)';
        statusSpan.style.color = '#ffa500';
    }

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/tts-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [{ text, voice_id: voiceId, model_id: modelId }],
                default_model_id: modelId,
                output_format: 'mp3_44100_128'
            })
        });

        const result = await response.json();
        const r = result.results?.[0];

        if (r && !r.error) {
            statusSpan.textContent = '✅ 成功';
            statusSpan.style.background = 'rgba(0,255,0,0.2)';
            statusSpan.style.color = '#51cf66';
            row.dataset.failed = 'false';

            // 移除重试按钮
            const retryBtn = row.querySelector('.batch-retry');
            if (retryBtn) retryBtn.remove();

            // 下载文件
            if (r.file_path) {
                const filename = r.file_path.split('/').pop();
                const link = document.createElement('a');
                link.href = normalizeFilePath(r.file_path);
                link.download = filename;
                link.click();
            }

            showToast('重试成功', 'success');
            loadQuota();

            // 检查是否还有失败项
            const failedRows = document.querySelectorAll('.batch-row[data-failed="true"]');
            if (failedRows.length === 0) {
                const retryAllBtn = document.getElementById('retry-all-failed-btn');
                if (retryAllBtn) retryAllBtn.remove();
            }
        } else {
            statusSpan.textContent = `❌ ${(r?.error || '未知错误').substring(0, 30)}...`;
            statusSpan.style.background = 'rgba(255,0,0,0.2)';
            statusSpan.style.color = '#f87171';
            showToast('重试失败: ' + (r?.error || '未知错误'), 'error');
        }
    } catch (error) {
        statusSpan.textContent = '❌ 请求失败';
        showToast('重试失败: ' + error.message, 'error');
    }
}

// 重试所有失败项
async function retryAllFailed() {
    const failedRows = document.querySelectorAll('.batch-row[data-failed="true"]');
    if (failedRows.length === 0) {
        showToast('没有失败项需要重试', 'info');
        return;
    }

    showToast(`正在重试 ${failedRows.length} 个失败项...`, 'info');

    for (const row of failedRows) {
        await retrySingleBatch(row);
        await new Promise(resolve => setTimeout(resolve, 1500)); // 间隔 1.5 秒
    }

    loadQuota();
}

async function generateSFX() {
    const prompt = document.getElementById('sfx-prompt').value.trim();
    const duration = parseInt(document.getElementById('sfx-duration').value);
    const savePath = document.getElementById('sfx-save-path').value.trim();

    if (!prompt) {
        showToast('请输入音效描述', 'error');
        return;
    }

    updateElevenLabsStatus('生成音效中...');

    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/sfx`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                prompt: prompt,
                duration: duration,
                save_path: savePath
            })
        });

        const result = await response.json();

        if (response.ok) {
            updateElevenLabsStatus('音效生成成功');
            showToast('音效生成成功！', 'success');

            // 加载生成的音频
            currentAudioPath_elevenlabs = result.file_path;
            audioPlayer.src = normalizeFilePath(result.file_path);
            document.getElementById('btn-play').disabled = false;
            document.getElementById('seek-slider').disabled = false;

            // 刷新额度
            loadQuota();

            // 自动更新保存路径
            document.getElementById('sfx-save-path').value = '';
        } else {
            updateElevenLabsStatus('生成失败');
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        updateElevenLabsStatus('生成失败');
        showToast('请求失败: ' + error.message, 'error');
    }
}

async function browseTtsSavePath() {
    const path = await _showInputDialog('TTS 保存路径', '请输入 TTS 保存路径 (留空使用默认)');
    if (path !== null) {
        document.getElementById('tts-save-path').value = path;
    }
}

async function browseSfxSavePath() {
    const path = await _showInputDialog('SFX 保存路径', '请输入 SFX 保存路径 (留空使用默认)');
    if (path !== null) {
        document.getElementById('sfx-save-path').value = path;
    }
}

function updateElevenLabsStatus(text) {
    const statusEl = document.getElementById('elevenlabs-status');
    if (statusEl) {
        statusEl.textContent = text;
    }
}

// ==================== 视频下载功能 ====================

// 视频下载状态
let videoListData = [];
let isDownloading = false;

async function analyzeVideoUrl() {
    const url = document.getElementById('video-url').value.trim();

    if (!url) {
        showToast('请输入视频链接', 'error');
        return;
    }

    const btnAnalyze = document.getElementById('btn-analyze');
    btnAnalyze.disabled = true;
    btnAnalyze.textContent = '解析中...';
    updateStatus('正在解析链接信息...', 'processing', 'download-status');

    // 重置列表
    videoListData = [];
    document.getElementById('video-table-body').innerHTML = '';
    document.getElementById('video-list-section').style.display = 'none';

    try {
        const response = await apiFetch(`${API_BASE}/video/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        const data = await response.json();

        if (response.ok) {
            // 处理播放列表或单个视频
            const entries = data.entries || [data];
            videoListData = entries;

            displayVideoList(entries);
            document.getElementById('video-list-section').style.display = 'block';
            document.getElementById('video-count').textContent = `共 ${entries.length} 个视频`;

            updateStatus('解析完成', 'success', 'download-status');
            showToast(`解析完成，共 ${entries.length} 个视频`, 'success');
        } else {
            updateStatus('错误: ' + data.error, 'error', 'download-status');
            showToast('错误: ' + data.error, 'error');
        }
    } catch (error) {
        updateStatus('请求失败: ' + error.message, 'error', 'download-status');
        showToast('请求失败', 'error');
    } finally {
        btnAnalyze.disabled = false;
        btnAnalyze.textContent = '🔍 解析链接';
    }
}

function displayVideoList(entries) {
    const tbody = document.getElementById('video-table-body');
    tbody.innerHTML = '';

    entries.forEach((entry, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';

        // 复选框
        const tdCheck = document.createElement('td');
        tdCheck.style.padding = '8px';
        tdCheck.style.textAlign = 'center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.index = index;
        checkbox.className = 'video-checkbox';
        tdCheck.appendChild(checkbox);
        tr.appendChild(tdCheck);

        // 标题
        const tdTitle = document.createElement('td');
        tdTitle.style.padding = '8px';
        tdTitle.textContent = truncateText(entry.title || 'Unknown', 50);
        tdTitle.title = entry.title || '';
        tr.appendChild(tdTitle);

        // 时长
        const tdDuration = document.createElement('td');
        tdDuration.style.padding = '8px';
        tdDuration.style.textAlign = 'center';
        const dur = entry.duration;
        tdDuration.textContent = dur ? `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}` : '--:--';
        tr.appendChild(tdDuration);

        // 状态
        const tdStatus = document.createElement('td');
        tdStatus.style.padding = '8px';
        tdStatus.style.textAlign = 'center';
        tdStatus.id = `video-status-${index}`;
        tdStatus.textContent = '待下载';
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
    });
}

function truncateText(text, maxLen) {
    if (!text) return '';
    return text.length <= maxLen ? text : text.substring(0, maxLen - 1) + '…';
}

function toggleSelectAllVideos() {
    const selectAll = document.getElementById('select-all-videos').checked;
    document.querySelectorAll('.video-checkbox').forEach(cb => {
        cb.checked = selectAll;
    });
}

function toggleAudioOnly() {
    const audioOnly = document.getElementById('audio-only').checked;
    const formatSelect = document.getElementById('video-format');
    const qualitySelect = document.getElementById('video-quality');
    const subtitleCheckbox = document.getElementById('download-subtitle');

    formatSelect.innerHTML = '';

    if (audioOnly) {
        formatSelect.innerHTML = `
            <option value="mp3">mp3</option>
            <option value="m4a">m4a</option>
            <option value="wav">wav</option>
        `;
        qualitySelect.disabled = true;
        subtitleCheckbox.disabled = true;
    } else {
        formatSelect.innerHTML = `
            <option value="mp4">mp4</option>
            <option value="mkv">mkv</option>
            <option value="webm">webm</option>
        `;
        qualitySelect.disabled = false;
        subtitleCheckbox.disabled = false;
    }
}

function toggleVideoDownload() {
    if (isDownloading) {
        // TODO: 实现停止下载
        showToast('正在停止下载...', 'info');
        isDownloading = false;
        document.getElementById('btn-download').textContent = '⬇️ 开始下载';
        document.getElementById('btn-download').classList.remove('btn-danger');
    } else {
        startVideoDownload();
    }
}

async function startVideoDownload() {
    // 获取选中的视频
    const selectedVideos = [];
    document.querySelectorAll('.video-checkbox:checked').forEach(cb => {
        const index = parseInt(cb.dataset.index);
        if (videoListData[index]) {
            selectedVideos.push({
                url: videoListData[index].webpage_url || videoListData[index].url,
                title: videoListData[index].title,
                ui_index: index
            });
        }
    });

    if (selectedVideos.length === 0) {
        showToast('请至少选择一个视频', 'error');
        return;
    }

    const downloadDir = document.getElementById('download-dir').value.trim();
    const format = document.getElementById('video-format').value;
    const quality = document.getElementById('video-quality').value;
    const audioOnly = document.getElementById('audio-only').checked;
    const downloadSubtitle = document.getElementById('download-subtitle').checked;
    const subtitleLang = document.getElementById('subtitle-lang').value;
    const threads = parseInt(document.getElementById('download-threads').value) || 4;

    isDownloading = true;
    document.getElementById('btn-download').textContent = '⏹ 停止下载';
    document.getElementById('btn-download').classList.add('btn-danger');
    setIndeterminateProgress('download-progress', true);

    // 重置状态
    selectedVideos.forEach(v => {
        document.getElementById(`video-status-${v.ui_index}`).textContent = '准备中...';
    });

    try {
        updateStatus('下载中...', 'processing', 'download-status');

        const response = await apiFetch(`${API_BASE}/video/download-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: selectedVideos,
                options: {
                    audio_only: audioOnly,
                    ext: format,
                    quality: quality,
                    subtitles: downloadSubtitle,
                    sub_lang: subtitleLang,
                    concurrency: threads
                },
                output_dir: downloadDir || ''
            })
        });

        const result = await response.json();

        if (response.ok) {
            updateStatus('下载完成！', 'success', 'download-status');
            showToast('下载完成！', 'success');
            document.getElementById('download-progress-inner').style.width = '100%';

            // 更新每个视频状态
            selectedVideos.forEach(v => {
                document.getElementById(`video-status-${v.ui_index}`).textContent = '完成';
            });
        } else {
            updateStatus('错误: ' + result.error, 'error', 'download-status');
            showToast('错误: ' + result.error, 'error');
        }
    } catch (error) {
        updateStatus('请求失败: ' + error.message, 'error', 'download-status');
        showToast('请求失败', 'error');
    } finally {
        setIndeterminateProgress('download-progress', false);
        isDownloading = false;
        document.getElementById('btn-download').textContent = '⬇️ 开始下载';
        document.getElementById('btn-download').classList.remove('btn-danger');
    }
}

async function selectDownloadDir() {
    const dir = await _showInputDialog('下载目录', '请输入下载目录路径');
    if (dir) {
        document.getElementById('download-dir').value = dir;
    }
}

// ==================== 批量粘贴链接下载 ====================

let batchLinksData = []; // 解析后的链接数组
let isBatchDownloading = false;

/**
 * 解析粘贴的批量链接
 */
function parseBatchLinks() {
    const textarea = document.getElementById('batch-links-textarea');
    const raw = textarea.value.trim();
    if (!raw) {
        showToast('请先粘贴链接', 'error');
        return;
    }

    // 解析链接: 每行一个，去重，过滤空行
    const lines = raw.split('\n')
        .map(l => l.trim())
        .filter(l => l && (l.startsWith('http://') || l.startsWith('https://')));

    // 去重
    const unique = [...new Set(lines)];

    if (unique.length === 0) {
        showToast('未检测到有效链接（以 http:// 或 https:// 开头）', 'error');
        return;
    }

    batchLinksData = unique;
    document.getElementById('batch-links-count').textContent = `${unique.length} 个链接`;

    // 渲染链接列表
    renderBatchLinksList(unique);
    document.getElementById('batch-links-list-section').style.display = 'block';

    showToast(`已解析 ${unique.length} 个链接`, 'success');
}

/**
 * 渲染链接列表（带序号和状态）
 */
function renderBatchLinksList(urls) {
    const container = document.getElementById('batch-links-list');
    container.innerHTML = '';

    urls.forEach((url, i) => {
        const row = document.createElement('div');
        row.id = `batch-link-row-${i}`;
        row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.2s;';

        // 序号
        const numSpan = document.createElement('span');
        numSpan.style.cssText = 'flex-shrink: 0; width: 28px; text-align: center; font-weight: 600; color: var(--text-muted); font-size: 11px;';
        numSpan.textContent = `${i + 1}`;
        row.appendChild(numSpan);

        // 来源图标
        const sourceIcon = document.createElement('span');
        sourceIcon.style.cssText = 'flex-shrink: 0; font-size: 14px;';
        let _host = ''; try { _host = new URL(url).hostname; } catch(_) {}
        if (_host.endsWith('facebook.com') || _host.endsWith('fb.com') || _host.endsWith('fb.watch')) {
            sourceIcon.textContent = '📘';
        } else if (_host.endsWith('youtube.com') || _host.endsWith('youtu.be')) {
            sourceIcon.textContent = '▶️';
        } else if (_host.endsWith('instagram.com')) {
            sourceIcon.textContent = '📷';
        } else if (_host.endsWith('tiktok.com')) {
            sourceIcon.textContent = '🎵';
        } else {
            sourceIcon.textContent = '🔗';
        }
        row.appendChild(sourceIcon);

        // URL显示
        const urlSpan = document.createElement('span');
        urlSpan.style.cssText = 'flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary);';
        urlSpan.textContent = url;
        urlSpan.title = url;
        row.appendChild(urlSpan);

        // 状态
        const statusSpan = document.createElement('span');
        statusSpan.id = `batch-link-status-${i}`;
        statusSpan.style.cssText = 'flex-shrink: 0; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: rgba(255,255,255,0.05); color: var(--text-muted);';
        statusSpan.textContent = '等待';
        row.appendChild(statusSpan);

        // 删除按钮
        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'flex-shrink: 0; background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 12px; padding: 2px 4px; opacity: 0.6;';
        delBtn.textContent = '✕';
        delBtn.title = '移除此链接';
        delBtn.onclick = () => {
            batchLinksData.splice(i, 1);
            renderBatchLinksList(batchLinksData);
            document.getElementById('batch-links-count').textContent = `${batchLinksData.length} 个链接`;
        };
        row.appendChild(delBtn);

        container.appendChild(row);
    });
}

/**
 * 选择批量下载目录
 */
async function selectBatchDownloadDir() {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        window.electronAPI.selectDirectory().then(dir => {
            if (dir) document.getElementById('batch-dl-dir').value = dir;
        });
    } else {
        const dir = await _showInputDialog('下载目录', '请输入下载目录路径');
        if (dir) {
            document.getElementById('batch-dl-dir').value = dir;
        }
    }
}

/**
 * 开始批量链接下载
 */
async function startBatchLinksDownload() {
    if (isBatchDownloading) {
        showToast('正在下载中，请等待完成', 'warning');
        return;
    }

    // 如果还没解析，先自动解析
    if (batchLinksData.length === 0) {
        parseBatchLinks();
    }

    if (batchLinksData.length === 0) {
        showToast('没有可下载的链接', 'error');
        return;
    }

    const format = document.getElementById('batch-dl-format').value;
    const quality = document.getElementById('batch-dl-quality').value;
    const audioOnly = document.getElementById('batch-dl-audio-only').checked;
    const outputTemplate = document.getElementById('batch-dl-template').value;
    const outputDir = document.getElementById('batch-dl-dir').value.trim();

    isBatchDownloading = true;
    const btn = document.getElementById('btn-batch-download');
    btn.textContent = '⏳ 下载中...';
    btn.disabled = true;
    btn.style.opacity = '0.6';

    // 显示日志区域
    const logSection = document.getElementById('batch-dl-log-section');
    logSection.style.display = 'block';
    const logEl = document.getElementById('batch-dl-log');
    logEl.innerHTML = '';

    // 重置所有状态
    batchLinksData.forEach((_, i) => {
        const statusEl = document.getElementById(`batch-link-status-${i}`);
        if (statusEl) {
            statusEl.textContent = '等待';
            statusEl.style.background = 'rgba(255,255,255,0.05)';
            statusEl.style.color = 'var(--text-muted)';
        }
    });

    document.getElementById('batch-dl-status').textContent = '下载中...';
    document.getElementById('batch-dl-progress-inner').style.width = '0%';

    // 注册实时进度监听
    const appendLog = (text) => {
        const line = document.createElement('div');
        line.textContent = text;
        logEl.appendChild(line);
        // 限制日志行数
        while (logEl.children.length > 200) {
            logEl.removeChild(logEl.firstChild);
        }
        logEl.scrollTop = logEl.scrollHeight;
    };

    if (window.electronAPI && window.electronAPI.onBatchDownloadProgress) {
        window.electronAPI.onBatchDownloadProgress((data) => {
            const { index, total, status, message } = data;

            // 更新进度条
            if (status === 'done' || status === 'error') {
                const pct = Math.round(((index + 1) / total) * 100);
                document.getElementById('batch-dl-progress-inner').style.width = `${pct}%`;
            }

            // 更新状态标签
            const statusEl = document.getElementById(`batch-link-status-${index}`);
            if (statusEl) {
                if (status === 'downloading' || status === 'progress') {
                    statusEl.textContent = '⬇️ 下载中';
                    statusEl.style.background = 'rgba(102,126,234,0.2)';
                    statusEl.style.color = '#667eea';
                } else if (status === 'done') {
                    statusEl.textContent = '✅ 完成';
                    statusEl.style.background = 'rgba(81,207,102,0.2)';
                    statusEl.style.color = '#51cf66';
                } else if (status === 'error') {
                    statusEl.textContent = '❌ 失败';
                    statusEl.style.background = 'rgba(255,0,0,0.2)';
                    statusEl.style.color = '#f87171';
                }
            }

            // 高亮当前行
            const row = document.getElementById(`batch-link-row-${index}`);
            if (row && (status === 'downloading' || status === 'progress')) {
                row.style.background = 'rgba(102,126,234,0.05)';
            } else if (row && (status === 'done' || status === 'error')) {
                row.style.background = '';
            }

            // 更新状态文本
            document.getElementById('batch-dl-status').textContent = message;

            // 追加日志
            if (status !== 'progress') {
                appendLog(message);
            }
        });
    }

    try {
        appendLog(`🚀 开始批量下载 ${batchLinksData.length} 个链接...`);

        const response = await apiFetch(`${API_BASE}/video/download-batch-links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                urls: batchLinksData,
                output_dir: outputDir || '',
                quality,
                ext: format,
                audio_only: audioOnly,
                output_template: outputTemplate,
            })
        });

        const result = await response.json();

        if (response.ok) {
            document.getElementById('batch-dl-progress-inner').style.width = '100%';
            const msg = `下载完成: ${result.success_count || 0} 成功, ${result.fail_count || 0} 失败`;
            document.getElementById('batch-dl-status').textContent = msg;
            appendLog(`\n✨ ${msg}`);
            if (result.output_path) {
                appendLog(`📂 输出目录: ${result.output_path}`);
            }

            if (result.fail_count === 0) {
                showToast(`全部下载完成: ${result.success_count} 个`, 'success');
            } else {
                showToast(msg, 'warning');
            }
        } else {
            document.getElementById('batch-dl-status').textContent = `错误: ${result.error}`;
            appendLog(`❌ 错误: ${result.error}`);
            showToast('下载失败: ' + result.error, 'error');
        }
    } catch (error) {
        document.getElementById('batch-dl-status').textContent = `请求失败: ${error.message}`;
        appendLog(`❌ 请求失败: ${error.message}`);
        showToast('请求失败: ' + error.message, 'error');
    } finally {
        isBatchDownloading = false;
        btn.textContent = '⬇️ 开始批量下载';
        btn.disabled = false;
        btn.style.opacity = '1';
    }
}

// ==================== 设置功能 ====================

async function saveSettingsElevenLabsKeys() {
    const keysText = document.getElementById('settings-elevenlabs-keys').value;
    const keys = keysText.split('\n').map(k => k.trim()).filter(k => k);

    try {
        const response = await apiFetch(`${API_BASE}/settings/elevenlabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_keys: keys })
        });

        if (response.ok) {
            showToast(`ElevenLabs Keys 已保存！(${keys.length} 个)`, 'success');
            // 同步到 ElevenLabs 面板
            const elTextarea = document.getElementById('elevenlabs-api-keys');
            if (elTextarea) {
                elTextarea.value = keys.join('\n');
                refreshKeyTable('elevenlabs-api-keys');
            }
            const countEl = document.getElementById('settings-elevenlabs-key-count');
            if (countEl) countEl.textContent = keys.length > 0 ? `已配置 ${keys.length} 个密钥` : '';
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}

/** 设置页 ElevenLabs 模式切换 */
function settingsToggleELMode() {
    const isWeb = document.getElementById('settings-mode-web')?.checked || false;
    const apiPanel = document.getElementById('settings-el-apikey-panel');
    const webPanel = document.getElementById('settings-el-web-panel');
    if (apiPanel) apiPanel.style.display = isWeb ? 'none' : 'block';
    if (webPanel) webPanel.style.display = isWeb ? 'block' : 'none';

    // 同步主面板的模式选择
    const mainModeWeb = document.getElementById('mode-web');
    const mainModeApi = document.getElementById('mode-apikey');
    if (isWeb && mainModeWeb) mainModeWeb.checked = true;
    if (!isWeb && mainModeApi) mainModeApi.checked = true;
    if (typeof updateWebTokenUI === 'function') updateWebTokenUI();

    // 检查 web token 状态
    if (isWeb) settingsCheckWebStatus();
}

/** 设置页检查 Web Token 状态 */
async function settingsCheckWebStatus() {
    const statusSpan = document.getElementById('settings-web-login-status');
    if (!statusSpan) return;
    try {
        const res = await apiFetch(`${API_BASE}/elevenlabs/web-status`);
        const data = await res.json();
        if (data.hasToken) {
            statusSpan.style.background = 'rgba(0, 217, 165, 0.15)';
            statusSpan.style.color = '#00d9a5';
            statusSpan.textContent = '🟢 已登录就绪';
        } else {
            statusSpan.style.background = 'rgba(255, 107, 107, 0.15)';
            statusSpan.style.color = '#ff6b6b';
            statusSpan.textContent = '🔴 未登录 / 无凭证';
        }
    } catch (e) {
        statusSpan.textContent = '状态未知';
    }
}

/** 设置页手动粘贴 Token 保存 */
async function settingsSaveManualToken() {
    const textarea = document.getElementById('settings-manual-token');
    const raw = (textarea?.value || '').trim();
    if (!raw) {
        showToast('请先粘贴 Authorization Token', 'error');
        return;
    }
    const payload = {};
    if (raw.startsWith('Bearer ') || raw.startsWith('bearer ') || raw.startsWith('eyJ')) {
        payload.authorization = raw.startsWith('eyJ') ? `Bearer ${raw}` : raw;
    } else if (raw.length >= 20 && /^[a-zA-Z0-9_-]+$/.test(raw)) {
        payload.xiApiKey = raw;
    } else {
        payload.authorization = raw;
    }
    try {
        const res = await apiFetch(`${API_BASE}/elevenlabs/web-token-manual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json();
        if (json.success) {
            showToast(json.message || '✅ Token 已保存', 'success');
            textarea.value = '';
            settingsCheckWebStatus();
            if (typeof updateWebTokenUI === 'function') updateWebTokenUI();
            if (typeof loadVoices === 'function') loadVoices();
        } else {
            showToast(json.message || '保存失败', 'error');
        }
    } catch (e) {
        showToast('保存失败: ' + e.message, 'error');
    }
}

// ==================== 全局界面缩放 ====================

const UI_SCALE_KEY = 'videokit-ui-scale';

/**
 * 应用全局 UI 缩放比例
 * @param {number|string} scale - 缩放百分比 (70-160)
 */
function applyUIScale(scale) {
    scale = Math.max(70, Math.min(160, parseInt(scale) || 100));
    const zoomValue = scale / 100;

    // 优先使用 Electron 原生 webFrame 缩放（正确调整布局视口，不裁切）
    if (window.electronAPI && window.electronAPI.setZoomFactor) {
        window.electronAPI.setZoomFactor(zoomValue);
        // 清除旧的 CSS zoom（如果之前设置过）
        document.body.style.zoom = '';
    } else {
        // 纯浏览器回退
        document.body.style.zoom = zoomValue;
    }

    // 更新滑块和标签
    const slider = document.getElementById('settings-ui-scale');
    const label = document.getElementById('settings-ui-scale-label');
    if (slider) slider.value = scale;
    if (label) label.textContent = scale + '%';

    // 持久化
    localStorage.setItem(UI_SCALE_KEY, String(scale));
}

/** 页面加载时恢复 UI 缩放 */
function initUIScale() {
    const saved = localStorage.getItem(UI_SCALE_KEY);
    const scale = saved ? parseInt(saved) : 100;
    applyUIScale(scale);
}

// 立即执行，确保页面一加载就应用缩放（避免闪烁）
initUIScale();

// 键盘快捷键支持
document.addEventListener('keydown', (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!isCtrl) return;

    const current = parseInt(localStorage.getItem(UI_SCALE_KEY)) || 100;
    if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        applyUIScale(Math.min(160, current + 5));
    } else if (e.key === '-') {
        e.preventDefault();
        applyUIScale(Math.max(70, current - 5));
    } else if (e.key === '0') {
        e.preventDefault();
        applyUIScale(100);
    }
});

// ==================== 全局主题引擎 ====================

const THEME_KEY = 'videokit-theme';
const CUSTOM_THEME_KEY = 'videokit-custom-theme';

/** 预设主题库 */
const THEME_PRESETS = {
    dark: {
        name: '🌙 暗色 (默认)',
        desc: '专业暗色调',
        colors: {
            '--bg-primary': '#181818', '--bg-secondary': '#1e1e1e', '--bg-tertiary': '#252525',
            '--bg-card': '#2a2a2a', '--bg-input': '#141414', '--bg-titlebar': '#111111',
            '--bg-hover': 'rgba(255,255,255,0.05)', '--bg-hover-strong': 'rgba(255,255,255,0.1)',
            '--accent': '#4c9eff', '--accent-hover': '#6bb0ff',
            '--accent-alpha': 'rgba(76,158,255,0.15)',
            '--text-primary': '#e4e4e4', '--text-secondary': '#8b8b8b',
            '--text-muted': '#666666', '--text-color': '#e4e4e4',
            '--border-color': 'rgba(255,255,255,0.08)',
            '--scrollbar-thumb': 'rgba(255,255,255,0.2)', '--scrollbar-thumb-hover': 'rgba(255,255,255,0.3)',
            '--success': '#34d399', '--warning': '#fbbf24', '--error': '#f87171',
            '--shadow': 'rgba(0,0,0,0.3)'
        },
        preview: ['#181818', '#1e1e1e', '#4c9eff', '#e4e4e4']
    },
    light: {
        name: '☀️ 亮色',
        desc: '清新薄荷绿',
        colors: {
            '--bg-primary': '#f0f5f0', '--bg-secondary': '#f7faf6', '--bg-tertiary': '#e6ede5',
            '--bg-card': '#edf3ec', '--bg-input': '#f7faf6', '--bg-titlebar': '#e2ebe0',
            '--bg-hover': 'rgba(46,125,50,0.05)', '--bg-hover-strong': 'rgba(46,125,50,0.1)',
            '--accent': '#2e7d32', '--accent-hover': '#388e3c',
            '--accent-alpha': 'rgba(46,125,50,0.12)',
            '--text-primary': '#1b2e1b', '--text-secondary': '#4a6548',
            '--text-muted': '#7d9a7a', '--text-color': '#1b2e1b',
            '--border-color': 'rgba(46,100,46,0.12)',
            '--scrollbar-thumb': 'rgba(46,100,46,0.2)', '--scrollbar-thumb-hover': 'rgba(46,100,46,0.35)',
            '--success': '#16a34a', '--warning': '#ca8a04', '--error': '#dc2626',
            '--shadow': 'rgba(30,60,30,0.08)'
        },
        preview: ['#f0f5f0', '#f7faf6', '#2e7d32', '#1b2e1b']
    },
    eyecare: {
        name: '🌿 护眼',
        desc: '淡绿护目',
        colors: {
            '--bg-primary': '#1a2318', '--bg-secondary': '#212d1e', '--bg-tertiary': '#2a3826',
            '--bg-card': '#2f3e2b', '--bg-input': '#161e14', '--bg-titlebar': '#141c12',
            '--bg-hover': 'rgba(180,220,160,0.06)', '--bg-hover-strong': 'rgba(180,220,160,0.12)',
            '--accent': '#7bc67e', '--accent-hover': '#95d898',
            '--accent-alpha': 'rgba(123,198,126,0.15)',
            '--text-primary': '#d4e6d0', '--text-secondary': '#8aad85',
            '--text-muted': '#5e7e59', '--text-color': '#d4e6d0',
            '--border-color': 'rgba(120,180,120,0.1)',
            '--scrollbar-thumb': 'rgba(120,180,120,0.25)', '--scrollbar-thumb-hover': 'rgba(120,180,120,0.4)',
            '--success': '#4ade80', '--warning': '#facc15', '--error': '#f87171',
            '--shadow': 'rgba(0,0,0,0.3)'
        },
        preview: ['#1a2318', '#212d1e', '#7bc67e', '#d4e6d0']
    },
    midnight: {
        name: '🌊 午夜蓝',
        desc: '深邃蓝调',
        colors: {
            '--bg-primary': '#0d1117', '--bg-secondary': '#161b22', '--bg-tertiary': '#1c2333',
            '--bg-card': '#21293a', '--bg-input': '#0a0e14', '--bg-titlebar': '#080c12',
            '--bg-hover': 'rgba(130,180,255,0.06)', '--bg-hover-strong': 'rgba(130,180,255,0.1)',
            '--accent': '#58a6ff', '--accent-hover': '#79c0ff',
            '--accent-alpha': 'rgba(88,166,255,0.15)',
            '--text-primary': '#c9d1d9', '--text-secondary': '#7d8590',
            '--text-muted': '#484f58', '--text-color': '#c9d1d9',
            '--border-color': 'rgba(130,180,255,0.08)',
            '--scrollbar-thumb': 'rgba(130,180,255,0.15)', '--scrollbar-thumb-hover': 'rgba(130,180,255,0.25)',
            '--success': '#3fb950', '--warning': '#d29922', '--error': '#f85149',
            '--shadow': 'rgba(0,0,0,0.4)'
        },
        preview: ['#0d1117', '#161b22', '#58a6ff', '#c9d1d9']
    },
    contrast: {
        name: '⚡ 高对比',
        desc: '纯黑高亮',
        colors: {
            '--bg-primary': '#000000', '--bg-secondary': '#0a0a0a', '--bg-tertiary': '#151515',
            '--bg-card': '#1a1a1a', '--bg-input': '#050505', '--bg-titlebar': '#000000',
            '--bg-hover': 'rgba(255,255,255,0.08)', '--bg-hover-strong': 'rgba(255,255,255,0.15)',
            '--accent': '#00d4ff', '--accent-hover': '#33e0ff',
            '--accent-alpha': 'rgba(0,212,255,0.18)',
            '--text-primary': '#ffffff', '--text-secondary': '#b0b0b0',
            '--text-muted': '#808080', '--text-color': '#ffffff',
            '--border-color': 'rgba(255,255,255,0.15)',
            '--scrollbar-thumb': 'rgba(255,255,255,0.3)', '--scrollbar-thumb-hover': 'rgba(255,255,255,0.5)',
            '--success': '#00ff88', '--warning': '#ffcc00', '--error': '#ff4444',
            '--shadow': 'rgba(0,0,0,0.5)'
        },
        preview: ['#000000', '#0a0a0a', '#00d4ff', '#ffffff']
    }
};

/**
 * 应用主题 — 将 CSS 变量覆盖到 :root
 * @param {string} themeId - 预设主题 ID 或 'custom'
 * @param {object} [customColors] - 自定义颜色对象（仅 themeId='custom' 时）
 */
function applyTheme(themeId, customColors) {
    const root = document.documentElement;
    let colors;
    let isLight = false;

    if (themeId === 'custom' && customColors) {
        colors = customColors;
        localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(customColors));
        // 判断自定义主题是否是亮色：检查 bg-primary
        const bgP = customColors['--bg-primary'] || '';
        isLight = _isLightColor(bgP);
    } else if (THEME_PRESETS[themeId]) {
        colors = THEME_PRESETS[themeId].colors;
        isLight = (themeId === 'light');
    } else {
        colors = THEME_PRESETS.dark.colors;
        themeId = 'dark';
    }

    // 设置所有 CSS 变量
    for (const [key, val] of Object.entries(colors)) {
        root.style.setProperty(key, val);
    }

    // 设置 body class 以便 CSS 区分亮色/暗色
    document.body.classList.remove('theme-light', 'theme-dark');
    document.body.classList.add(isLight ? 'theme-light' : 'theme-dark');

    localStorage.setItem(THEME_KEY, themeId);

    // 更新选中状态
    document.querySelectorAll('.theme-card').forEach(card => {
        const isActive = card.dataset.theme === themeId;
        card.style.borderColor = isActive ? 'var(--accent)' : 'var(--border-color)';
        card.style.boxShadow = isActive ? '0 0 0 2px var(--accent-alpha)' : 'none';
    });
}

/** 判断 hex 颜色是否为亮色 */
function _isLightColor(hex) {
    if (!hex || hex.charAt(0) !== '#') return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r * 0.299 + g * 0.587 + b * 0.114) > 140;
}

/** 从主色调生成完整主题 */
function applyCustomThemeFromAccent(hex) {
    const base = document.getElementById('theme-custom-base')?.value || 'dark';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    let colors;
    if (base === 'light') {
        colors = {
            '--bg-primary': '#f5f5f5', '--bg-secondary': '#ffffff', '--bg-tertiary': '#e8e8e8',
            '--bg-card': '#f0f0f0', '--bg-input': '#ffffff', '--bg-titlebar': '#e0e0e0',
            '--bg-hover': 'rgba(0,0,0,0.04)', '--bg-hover-strong': 'rgba(0,0,0,0.08)',
            '--accent': hex, '--accent-hover': _lightenHex(hex, 20),
            '--accent-alpha': `rgba(${r},${g},${b},0.12)`,
            '--text-primary': '#1a1a1a', '--text-secondary': '#555555',
            '--text-muted': '#999999', '--text-color': '#1a1a1a',
            '--border-color': 'rgba(0,0,0,0.1)',
            '--scrollbar-thumb': 'rgba(0,0,0,0.2)', '--scrollbar-thumb-hover': 'rgba(0,0,0,0.35)',
            '--success': '#16a34a', '--warning': '#d97706', '--error': '#dc2626',
            '--shadow': 'rgba(0,0,0,0.08)'
        };
    } else {
        colors = {
            '--bg-primary': '#181818', '--bg-secondary': '#1e1e1e', '--bg-tertiary': '#252525',
            '--bg-card': '#2a2a2a', '--bg-input': '#141414', '--bg-titlebar': '#111111',
            '--bg-hover': 'rgba(255,255,255,0.05)', '--bg-hover-strong': 'rgba(255,255,255,0.1)',
            '--accent': hex, '--accent-hover': _lightenHex(hex, 20),
            '--accent-alpha': `rgba(${r},${g},${b},0.15)`,
            '--text-primary': '#e4e4e4', '--text-secondary': '#8b8b8b',
            '--text-muted': '#666666', '--text-color': '#e4e4e4',
            '--border-color': 'rgba(255,255,255,0.08)',
            '--scrollbar-thumb': 'rgba(255,255,255,0.2)', '--scrollbar-thumb-hover': 'rgba(255,255,255,0.3)',
            '--success': '#34d399', '--warning': '#fbbf24', '--error': '#f87171',
            '--shadow': 'rgba(0,0,0,0.3)'
        };
    }

    applyTheme('custom', colors);
}

/** 辅助：将 hex 颜色加亮 */
function _lightenHex(hex, amount) {
    let r = parseInt(hex.slice(1, 3), 16);
    let g = parseInt(hex.slice(3, 5), 16);
    let b = parseInt(hex.slice(5, 7), 16);
    r = Math.min(255, r + amount);
    g = Math.min(255, g + amount);
    b = Math.min(255, b + amount);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** 渲染主题选择卡片 */
function renderThemeCards() {
    const container = document.getElementById('theme-cards');
    if (!container) return;
    const current = localStorage.getItem(THEME_KEY) || 'dark';

    container.innerHTML = '';
    for (const [id, preset] of Object.entries(THEME_PRESETS)) {
        const isActive = id === current;
        const card = document.createElement('div');
        card.className = 'theme-card';
        card.dataset.theme = id;
        card.style.cssText = `
            padding: 10px 12px; border-radius: 8px; cursor: pointer;
            border: 2px solid ${isActive ? 'var(--accent)' : 'var(--border-color)'};
            background: ${preset.colors['--bg-secondary']};
            box-shadow: ${isActive ? '0 0 0 2px var(--accent-alpha)' : 'none'};
            transition: all 0.2s;
        `;
        card.onmouseenter = () => { if (!card.style.boxShadow.includes('accent')) card.style.borderColor = 'rgba(255,255,255,0.2)'; };
        card.onmouseleave = () => { if (card.dataset.theme !== (localStorage.getItem(THEME_KEY) || 'dark')) card.style.borderColor = 'var(--border-color)'; };
        card.onclick = () => applyTheme(id);

        // 色块预览
        const swatches = preset.preview.map(c =>
            `<div style="width:18px;height:18px;border-radius:4px;background:${c};border:1px solid rgba(128,128,128,0.3);"></div>`
        ).join('');

        card.innerHTML = `
            <div style="display:flex;gap:4px;margin-bottom:8px;">${swatches}</div>
            <div style="font-size:12px;font-weight:600;color:${preset.colors['--text-primary']};">${preset.name}</div>
            <div style="font-size:10px;color:${preset.colors['--text-secondary']};margin-top:2px;">${preset.desc}</div>
        `;
        container.appendChild(card);
    }
}

/** 初始化主题 */
function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'dark';
    if (saved === 'custom') {
        const customColors = JSON.parse(localStorage.getItem(CUSTOM_THEME_KEY) || 'null');
        if (customColors) {
            applyTheme('custom', customColors);
        } else {
            applyTheme('dark');
        }
    } else {
        applyTheme(saved);
    }
}

// 立即初始化主题
initTheme();

// DOM 就绪后渲染卡片
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(renderThemeCards, 200);
});

async function saveGladiaKeys() {
    const keysText = document.getElementById('gladia-keys').value;
    const keys = keysText.split('\n').map(k => k.trim()).filter(Boolean);

    try {
        const response = await apiFetch(`${API_BASE}/settings/gladia-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys })
        });

        if (response.ok) {
            showToast('Gladia Keys 已保存！', 'success');
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}

async function saveGeminiKeys() {
    const keysText = document.getElementById('gemini-keys').value;
    const keys = keysText.split('\n').map(k => k.trim()).filter(Boolean);
    const prompt = document.getElementById('gemini-prompt').value;
    const model = document.getElementById('gemini-model')?.value || null;

    try {
        const response = await apiFetch(`${API_BASE}/settings/gemini-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys, prompt, model })
        });

        if (response.ok) {
            showToast('Gemini 设置已保存！', 'success');
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}

async function testGeminiKeys() {
    const keysText = document.getElementById('gemini-keys').value;
    const keysRaw = keysText.split('\n').map(s => s.trim()).filter(s => s);
    const model = document.getElementById('gemini-model')?.value || 'gemini-2.5-flash';
    const resultsDiv = document.getElementById('gemini-test-results');
    const statusEl = document.getElementById('gemini-test-status');

    if (keysRaw.length === 0) {
        showToast('请先输入至少一个 API Key', 'warning');
        return;
    }

    resultsDiv.style.display = 'block';
    resultsDiv.innerHTML = `<div style="color:var(--text-muted);">⏳ 正在并发测试 ${keysRaw.length} 个 Key（模型: ${model}）...</div>`;
    if (statusEl) statusEl.textContent = '测试中...';

    // 一次发全部，后端自动控制并发（每波20个）
    let allResults = [];
    try {
        const resp = await apiFetch(`${API_BASE}/ai/test-keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys: keysRaw, model })
        });
        const parsed = await resp.json();
        if (!resp.ok) {
            throw new Error(parsed?.error || '后端返回错误');
        }
        if (!Array.isArray(parsed)) {
            throw new Error('返回格式异常: ' + JSON.stringify(parsed).slice(0, 80));
        }
        allResults = parsed;
    } catch (e) {
        // 全部标记失败
        if (allResults.length === 0) {
            keysRaw.forEach((key, i) => {
                allResults.push({ idx: i, key, success: false, error: e.message, latency: 0 });
            });
        }
    }

    // 渲染结果
    let html = '';
    let okCount = 0;
    for (const r of allResults) {
        const keyLabel = r.key && r.key.length > 12 ? r.key.slice(0, 6) + '...' + r.key.slice(-4) : (r.key || '?');
        if (r.success) {
            okCount++;
            html += `<div style="color:#6ee7b7;margin:2px 0;">✅ #${r.idx+1} (${keyLabel}) — ${r.latency}ms</div>`;
        } else {
            html += `<div style="color:#f87171;margin:2px 0;">❌ #${r.idx+1} (${keyLabel}) — ${r.error || '未知错误'}</div>`;
        }
    }
    const failCount = allResults.length - okCount;
    html += `<div style="color:var(--text-secondary);margin-top:6px;border-top:1px solid var(--border-color);padding-top:4px;">结果: ${okCount} 个可用，${failCount} 个失败（共 ${allResults.length} 个）</div>`;
    resultsDiv.innerHTML = html;
    if (statusEl) statusEl.textContent = `✅ ${okCount} 可用 / ❌ ${failCount} 失败`;
}

async function saveReplaceRules() {
    const language = document.getElementById('replace-language').value;
    const rules = document.getElementById('replace-rules').value;

    try {
        const response = await apiFetch(`${API_BASE}/settings/replace-rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language, rules })
        });

        if (response.ok) {
            showToast('替换规则已保存！', 'success');
        }
    } catch (error) {
        showToast('保存失败: ' + error.message, 'error');
    }
}

function showGladiaKeysModal() {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector('[data-tab="settings"]').classList.add('active');
    document.getElementById('settings-panel').classList.add('active');
}

function showTransReplaceModal() {
    showGladiaKeysModal();
}

// ==================== 字幕断行功能 ====================

// 初始化字幕断行滑杆
document.addEventListener('DOMContentLoaded', () => {
    const maxCharsSlider = document.getElementById('subtitle-max-chars');
    if (maxCharsSlider) {
        maxCharsSlider.addEventListener('input', (e) => {
            const value = e.target.value;
            document.getElementById('max-chars-label').textContent = `${value} 字符/行`;

            // 如果有文本，实时重新断行
            const text = document.getElementById('tts-text').value.trim();
            if (text) {
                const cleanText = stripEmotionTags(text);
                doAutoBreak(cleanText, parseInt(value), false);
            }
        });
    }
});

// 去除情绪标签
function stripEmotionTags(text) {
    if (!text) return '';
    let res = "";
    let inTag = false;
    for (let i = 0; i < text.length; i++) {
        let c = text[i];
        if (c === '<' || c === '[' || c === '(') { inTag = true; continue; }
        if (c === '>' || c === ']' || c === ')') { inTag = false; continue; }
        if (!inTag) res += c;
    }
    return res.replace(/\s+/g, ' ').trim();
}

// 自动断行按钮点击
function autoBreakSubtitle() {
    const text = document.getElementById('tts-text').value.trim();
    if (!text) {
        showToast('请先在上方输入要转换的文本', 'error');
        return;
    }

    const cleanText = stripEmotionTags(text);
    const maxChars = parseInt(document.getElementById('subtitle-max-chars').value);
    doAutoBreak(cleanText, maxChars, true);
}

// 执行自动断行核心逻辑
function doAutoBreak(text, maxChars, showMessage = true) {
    // 句末标点符号（强制断行）
    const sentenceEnders = ['.', '!', '?', '。', '！', '？', '；'];
    // 次级断点（超长时可断）
    const softBreaks = [',', '，', ':', '：', ';', ' '];
    // 孤立词阈值
    const orphanThreshold = 8;

    const lines = [];
    let currentLine = '';
    let lastSoftBreak = -1;

    let i = 0;
    while (i < text.length) {
        const char = text[i];
        currentLine += char;

        // 记录次级断点位置
        if (softBreaks.includes(char)) {
            lastSoftBreak = currentLine.length;
        }

        // 检测是否是句末标点
        if (sentenceEnders.includes(char)) {
            // 跳过连续的标点（如 "..." 或 "!?"）
            while (i + 1 < text.length && sentenceEnders.includes(text[i + 1])) {
                i++;
                currentLine += text[i];
            }

            // 跳过引号等收尾标点
            while (i + 1 < text.length && ['"', '"', "'", "'"].includes(text[i + 1])) {
                i++;
                currentLine += text[i];
            }

            lines.push(currentLine.trim());
            currentLine = '';
            lastSoftBreak = -1;
        }
        // 如果行太长，在次级断点处断开
        else if (currentLine.length >= maxChars) {
            if (lastSoftBreak > 10) {
                // 在最后一个次级断点处断开
                const lineToAdd = currentLine.substring(0, lastSoftBreak).trim();
                const remaining = currentLine.substring(lastSoftBreak).trimStart();

                lines.push(lineToAdd);
                currentLine = remaining;
                lastSoftBreak = -1;
            }
            // 如果没有合适的断点，继续累积
        }

        i++;
    }

    // 处理最后剩余的文本
    if (currentLine.trim()) {
        lines.push(currentLine.trim());
    }

    // 智能处理：合并孤立的短片段
    const mergedLines = mergeOrphanWords(lines, orphanThreshold);

    // 设置到字幕输入框
    const result = mergedLines.join('\n');
    document.getElementById('subtitle-text').value = result;

    // 提示（只有手动点击按钮时才显示）
    if (showMessage) {
        updateElevenLabsStatus(`已自动断行为 ${mergedLines.length} 条字幕（每行≤${maxChars}字符）`);
        showToast(`已断行为 ${mergedLines.length} 条字幕`, 'success');
    }
}

// 合并孤立的短片段到前一行
function mergeOrphanWords(lines, threshold) {
    if (lines.length <= 1) return lines;

    const result = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 检查是否是孤立短片段（开头不是大写字母或中文，且很短）
        if (i > 0 && line.length < threshold) {
            const words = line.split(/\s+/);
            const firstWord = words[0] || '';

            // 检查是否是句子的开头
            const isSentenceStart = (
                line.length > 0 && (
                    /[A-Z]/.test(line[0]) || // 大写字母开头
                    /[\u4e00-\u9fff]/.test(line[0]) || // 中文字符
                    ['I', 'A', 'The', 'An', 'He', 'She', 'It', 'We', 'They', 'You', 'My', 'Your', 'Our', 'His', 'Her'].includes(firstWord)
                )
            );

            if (!isSentenceStart) {
                // 不是句子开头的短片段，合并到前一行
                if (result.length > 0) {
                    result[result.length - 1] = result[result.length - 1] + ' ' + line;
                    continue;
                }
            }
        }

        result.push(line);
    }

    return result;
}

// ==================== 智能分割功能 ====================
let smartSplitSegments = [];
let smartSplitTargetFile = null;

// 初始化智能分割事件
document.addEventListener('DOMContentLoaded', () => {
    const analyzeBtn = document.getElementById('smart-split-analyze-btn');

    if (analyzeBtn) {
        analyzeBtn.onclick = analyzeSmartSplit;
    }
});

// 更新分析按钮状态
function updateSmartSplitButtonState() {
    const btn = document.getElementById('smart-split-analyze-btn');

    if (btn) {
        btn.disabled = currentMediaFileInfos.length === 0;
    }
}

// 分析智能分割点（批量分析所有文件）
async function analyzeSmartSplit() {
    if (currentMediaFileInfos.length === 0) {
        showToast('请先添加音频文件', 'warning');
        return;
    }

    const maxDuration = parseInt(document.getElementById('smart-split-max-duration')?.value) || 29;
    const btn = document.getElementById('smart-split-analyze-btn');
    const preview = document.getElementById('smart-split-preview');

    btn.disabled = true;

    const total = currentMediaFileInfos.length;
    let success = 0;
    let allResults = [];  // 存储所有文件的分析结果

    try {
        for (let i = 0; i < currentMediaFileInfos.length; i++) {
            const fileInfo = currentMediaFileInfos[i];
            if (!fileInfo.path) continue;

            btn.textContent = `⏳ 分析中 (${i + 1}/${total})...`;

            try {
                const response = await apiFetch(`${API_BASE}/audio/smart-split-analyze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_path: fileInfo.path,
                        max_duration: maxDuration
                    })
                });

                const data = await response.json();

                if (response.ok && data.segments) {
                    // 直接应用到对应文件的裁切点输入框
                    const cutPoints = data.segments.slice(1).map(seg => formatTimeAudio(seg.start));
                    const cutPointsStr = cutPoints.join(', ');

                    const input = document.getElementById(`audio-cut-points-${i}`);
                    if (input) {
                        input.value = cutPointsStr;
                        currentAudioCutPoints[fileInfo.path] = cutPointsStr;
                    }

                    // 更新卡片状态
                    const statusEl = document.getElementById(`audio-card-status-${i}`);
                    if (statusEl) {
                        statusEl.textContent = `${data.segments.length} 段`;
                        statusEl.style.background = 'rgba(81, 207, 102, 0.2)';
                        statusEl.style.color = '#51cf66';
                    }

                    // 重绘波形显示分割点
                    const canvas = document.getElementById(`audio-waveform-${i}`);
                    const cardData = window.audioCardData?.[i];
                    if (canvas && cardData) {
                        const cutTimes = data.segments.slice(1).map(seg => seg.start);
                        drawWaveform(canvas, cardData.peaks, cutTimes, data.total_duration);
                    }

                    allResults.push({
                        index: i,
                        name: fileInfo.name,
                        segments: data.segments.length,
                        duration: data.total_duration,
                        cutTimes: data.segments.slice(1).map(seg => seg.start)
                    });

                    success++;
                } else {
                    // 更新卡片状态为失败
                    const statusEl = document.getElementById(`audio-card-status-${i}`);
                    if (statusEl) {
                        statusEl.textContent = '分析失败';
                        statusEl.style.background = 'rgba(255, 107, 107, 0.2)';
                        statusEl.style.color = '#f87171';
                    }
                }
            } catch (err) {
                console.error(`分析失败 ${fileInfo.name}:`, err);
                const statusEl = document.getElementById(`audio-card-status-${i}`);
                if (statusEl) {
                    statusEl.textContent = '出错';
                    statusEl.style.background = 'rgba(255, 107, 107, 0.2)';
                    statusEl.style.color = '#f87171';
                }
            }
        }

        // 显示总结
        if (success > 0) {
            const totalSegments = allResults.reduce((sum, r) => sum + r.segments, 0);
            showToast(`批量分析完成: ${success}/${total} 个文件，共 ${totalSegments} 个分割点`, 'success');

            // 更新工具栏状态文本
            const statusEl = document.getElementById('smart-split-status');
            if (statusEl) {
                statusEl.textContent = `✅ 已分析 ${success} 个文件`;
                statusEl.style.color = '#51cf66';
            }
        } else {
            showToast('分析失败，没有成功处理的文件', 'error');
            const statusEl = document.getElementById('smart-split-status');
            if (statusEl) {
                statusEl.textContent = '❌ 分析失败';
                statusEl.style.color = '#f87171';
            }
        }

    } catch (error) {
        showToast('分析失败: ' + error.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 批量分析分割点';
    }
}

// 渲染分割点列表
function renderSmartSplitSegments() {
    const container = document.getElementById('smart-split-segments');
    if (!container) return;

    container.innerHTML = smartSplitSegments.map((seg, idx) => `
        <div class="smart-split-segment" style="display: flex; align-items: center; gap: 8px; padding: 6px; margin-bottom: 4px; background: rgba(255,255,255,0.05); border-radius: 4px;">
            <span style="font-size: 12px; color: var(--text-muted); min-width: 24px;">#${seg.index}</span>
            <input type="text" class="smart-split-start" data-idx="${idx}" value="${formatTimeAudio(seg.start)}" 
                style="width: 70px; padding: 2px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.1); background: var(--bg-tertiary); color: var(--text-primary);">
            <span style="color: var(--text-muted);">-</span>
            <input type="text" class="smart-split-end" data-idx="${idx}" value="${formatTimeAudio(seg.end)}"
                style="width: 70px; padding: 2px 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.1); background: var(--bg-tertiary); color: var(--text-primary);">
            <span style="font-size: 11px; color: var(--text-muted);">(${seg.duration.toFixed(1)}s)</span>
            <button class="btn btn-secondary" onclick="deleteSmartSplitSegment(${idx})" style="padding: 2px 6px; font-size: 10px; color: #f87171;">✕</button>
        </div>
    `).join('');

    // 添加输入事件监听
    container.querySelectorAll('.smart-split-start, .smart-split-end').forEach(input => {
        input.onchange = updateSmartSplitFromInput;
    });
}

// 从输入更新分割点
function updateSmartSplitFromInput(e) {
    const idx = parseInt(e.target.dataset.idx);
    const isStart = e.target.classList.contains('smart-split-start');
    const timeValue = parseTimeInput(e.target.value);

    if (idx >= 0 && idx < smartSplitSegments.length) {
        if (isStart) {
            smartSplitSegments[idx].start = timeValue;
        } else {
            smartSplitSegments[idx].end = timeValue;
        }
        smartSplitSegments[idx].duration = smartSplitSegments[idx].end - smartSplitSegments[idx].start;
    }
}

// 解析时间输入 (mm:ss.s 或 s.ss)
function parseTimeInput(str) {
    str = str.trim();
    if (str.includes(':')) {
        const parts = str.split(':');
        const mins = parseInt(parts[0]) || 0;
        const secs = parseFloat(parts[1]) || 0;
        return mins * 60 + secs;
    } else {
        return parseFloat(str) || 0;
    }
}

// 删除分割点
function deleteSmartSplitSegment(idx) {
    if (idx >= 0 && idx < smartSplitSegments.length) {
        // 如果删除中间的，合并到前一个
        if (idx > 0 && idx < smartSplitSegments.length - 1) {
            smartSplitSegments[idx - 1].end = smartSplitSegments[idx].end;
            smartSplitSegments[idx - 1].duration = smartSplitSegments[idx - 1].end - smartSplitSegments[idx - 1].start;
        }
        smartSplitSegments.splice(idx, 1);
        // 重新编号
        smartSplitSegments.forEach((seg, i) => seg.index = i + 1);
        renderSmartSplitSegments();
    }
}

// 添加分割点
function addSmartSplitPoint() {
    if (smartSplitSegments.length === 0) {
        showToast('请先分析分割点', 'warning');
        return;
    }

    const lastSeg = smartSplitSegments[smartSplitSegments.length - 1];
    const midPoint = (lastSeg.start + lastSeg.end) / 2;

    // 在最后一个片段中间添加分割点
    const newSeg = {
        index: smartSplitSegments.length + 1,
        start: midPoint,
        end: lastSeg.end,
        duration: lastSeg.end - midPoint
    };

    lastSeg.end = midPoint;
    lastSeg.duration = lastSeg.end - lastSeg.start;

    smartSplitSegments.push(newSeg);
    renderSmartSplitSegments();
}

// 应用智能分割点到裁切输入框
function applySmartSplitPoints() {
    if (!smartSplitTargetFile || smartSplitSegments.length === 0) {
        showToast('没有可应用的分割点', 'warning');
        return;
    }

    // 生成裁切点时间（只需要起始时间，不包括第一个0）
    const cutPoints = smartSplitSegments.slice(1).map(seg => formatTimeAudio(seg.start));
    const cutPointsStr = cutPoints.join(', ');

    // 找到对应文件的输入框
    const fileIdx = currentMediaFileInfos.findIndex(f => f.path === smartSplitTargetFile);
    if (fileIdx === -1) {
        showToast('找不到对应文件', 'error');
        return;
    }

    const input = document.getElementById(`audio-cut-points-${fileIdx}`);
    if (input) {
        input.value = cutPointsStr;
        currentAudioCutPoints[smartSplitTargetFile] = cutPointsStr;
        showToast(`已应用 ${smartSplitSegments.length} 个分割片段`, 'success');
    }
}

// ==================== 场景检测模块（批量） ====================

let sceneFiles = [];         // [{path, name}]
let sceneResults = {};       // { filePath: { data, segments } }
let sceneOutputDir = '';

function getSceneOutputFolderMode() {
    return document.getElementById('scene-output-folder-mode')?.value || 'per_video';
}

function createSceneBatchName(kind = 'scenes') {
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    return `scene_batch_${kind}_${stamp}`;
}

// 初始化场景检测
document.addEventListener('DOMContentLoaded', () => {
    const sceneInput = document.getElementById('scene-video-input');
    if (sceneInput) {
        sceneInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const newFiles = Array.from(e.target.files).map(f => ({
                    path: getFileNativePath(f),
                    name: f.name
                }));
                // 合并去重
                newFiles.forEach(nf => {
                    if (!sceneFiles.find(sf => sf.path === nf.path)) {
                        sceneFiles.push(nf);
                    }
                });
                updateSceneFileDisplay();
                renderSceneFileCards();
                showToast(`已添加 ${newFiles.length} 个文件，共 ${sceneFiles.length} 个`, 'success');
            }
        });
    }

    // 拖拽支持
    const dropZone = document.getElementById('scene-drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent)';
            dropZone.style.background = 'rgba(102, 126, 234, 0.05)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
            const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
            const files = Array.from(e.dataTransfer.files).filter(f =>
                videoExts.some(ext => f.name.toLowerCase().endsWith(ext))
            );
            if (files.length > 0) {
                files.forEach(f => {
                    const info = { path: getFileNativePath(f), name: f.name };
                    if (!sceneFiles.find(sf => sf.path === info.path)) {
                        sceneFiles.push(info);
                    }
                });
                updateSceneFileDisplay();
                renderSceneFileCards();
                showToast(`已添加 ${files.length} 个文件`, 'success');
            }
        });
    }
});

function updateSceneFileDisplay() {
    const pathEl = document.getElementById('scene-video-path');
    if (sceneFiles.length === 0) {
        pathEl.value = '';
    } else if (sceneFiles.length === 1) {
        pathEl.value = sceneFiles[0].name;
    } else {
        pathEl.value = `${sceneFiles.length} 个视频文件`;
    }
}

function clearSceneFiles() {
    sceneFiles = [];
    sceneResults = {};
    sceneOutputDir = '';
    updateSceneFileDisplay();
    renderSceneFileCards();
    document.getElementById('scene-export-status').classList.add('hidden');
    document.getElementById('scene-export-all-btn').style.display = 'none';
    document.getElementById('scene-detect-status').textContent = '就绪';
    document.getElementById('scene-detect-status').style.color = '';
}

function renderSceneFileCards() {
    const container = document.getElementById('scene-file-cards');
    container.innerHTML = '';

    if (sceneFiles.length === 0) {
        container.innerHTML = '<p class="hint">请先选择视频文件。</p>';
        return;
    }

    sceneFiles.forEach((file, idx) => {
        const result = sceneResults[file.path];
        const card = document.createElement('div');
        card.className = 'scene-file-card';
        card.dataset.idx = idx;
        card.style.cssText = 'background: var(--bg-tertiary); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.05);';

        // ---- 卡片头部 ----
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        // 文件名
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'flex: 1; font-size: 13px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
        nameEl.textContent = `🎬 ${file.name}`;
        nameEl.title = file.path;

        // 状态标签
        const statusTag = document.createElement('span');
        statusTag.id = `scene-status-${idx}`;
        statusTag.style.cssText = 'font-size: 11px; padding: 2px 8px; border-radius: 3px;';
        if (result) {
            statusTag.textContent = `✅ ${result.scene_points.length} 个切换点`;
            statusTag.style.background = 'rgba(0, 217, 165, 0.15)';
            statusTag.style.color = '#00d9a5';
        } else {
            statusTag.textContent = '待检测';
            statusTag.style.background = 'rgba(128,128,128,0.2)';
            statusTag.style.color = 'var(--text-muted)';
        }

        // 单个文件检测按钮
        const detectBtn = document.createElement('button');
        detectBtn.className = 'btn btn-secondary';
        detectBtn.style.cssText = 'padding: 4px 10px; font-size: 11px;';
        detectBtn.textContent = result ? '🔄 重新检测' : '🔍 检测';
        detectBtn.onclick = () => detectSingleFile(idx);

        // 导出按钮（检测完成后显示）
        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-primary';
        exportBtn.style.cssText = 'padding: 4px 10px; font-size: 11px;';
        exportBtn.textContent = '📦 导出';
        exportBtn.style.display = result ? '' : 'none';
        exportBtn.id = `scene-export-btn-${idx}`;
        exportBtn.onclick = () => exportSingleFile(idx);

        // 裁切按钮
        const trimBtn = document.createElement('button');
        trimBtn.className = 'btn btn-secondary';
        trimBtn.style.cssText = 'padding: 4px 10px; font-size: 11px;';
        trimBtn.textContent = '✂️ 裁切';
        trimBtn.title = '打开手动裁切工具';
        trimBtn.onclick = () => openTrimModal(file.path, file.name);

        // 删除按钮
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn btn-secondary';
        removeBtn.style.cssText = 'padding: 4px 8px; font-size: 11px; color: var(--error);';
        removeBtn.textContent = '✕';
        removeBtn.title = '移除此文件';
        removeBtn.onclick = () => {
            delete sceneResults[sceneFiles[idx].path];
            sceneFiles.splice(idx, 1);
            updateSceneFileDisplay();
            renderSceneFileCards();
            updateSceneExportAllBtn();
        };

        header.appendChild(nameEl);
        header.appendChild(statusTag);
        header.appendChild(detectBtn);
        header.appendChild(exportBtn);
        header.appendChild(trimBtn);
        header.appendChild(removeBtn);
        card.appendChild(header);

        // ---- 视频信息 + 片段列表（检测完成后展示）----
        if (result) {
            // 视频信息
            const infoRow = document.createElement('div');
            infoRow.style.cssText = 'display: flex; gap: 12px; font-size: 11px; color: var(--text-muted); margin-top: 8px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 4px;';
            infoRow.innerHTML = `
                <span>📐 ${result.resolution || '-'}</span>
                <span>🖼️ ${result.fps} FPS</span>
                <span>⏱️ ${formatTimeAudio(result.duration)}</span>
                <span>✂️ ${result.segments.length} 片段</span>
            `;
            card.appendChild(infoRow);

            // 展开/收起按钮
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'btn btn-secondary';
            toggleBtn.style.cssText = 'padding: 2px 10px; font-size: 11px; margin-top: 8px; width: 100%;';
            toggleBtn.textContent = '▼ 展开片段列表';
            const segListContainer = document.createElement('div');
            segListContainer.style.cssText = 'display: none; margin-top: 8px; max-height: 300px; overflow-y: auto;';
            toggleBtn.onclick = () => {
                const hidden = segListContainer.style.display === 'none';
                segListContainer.style.display = hidden ? 'flex' : 'none';
                segListContainer.style.flexDirection = 'column';
                segListContainer.style.gap = '4px';
                toggleBtn.textContent = hidden ? '▲ 收起片段列表' : '▼ 展开片段列表';
            };
            card.appendChild(toggleBtn);

            // 片段列表
            const maxDur = Math.max(...result.segments.map(s => s.duration));
            result.segments.forEach((seg, sIdx) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: var(--bg-secondary); border-radius: 4px; font-size: 12px;';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                cb.className = `scene-cb-${idx}`;
                cb.dataset.segIndex = sIdx;

                const num = document.createElement('span');
                num.style.cssText = 'min-width: 28px; font-weight: 600; color: var(--accent);';
                num.textContent = `#${seg.index}`;

                const time = document.createElement('span');
                time.style.cssText = 'flex: 1; font-family: monospace; color: var(--text-primary);';
                time.textContent = `${seg.start_str} → ${seg.end_str}`;

                const barC = document.createElement('div');
                barC.style.cssText = 'width: 60px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;';
                const bar = document.createElement('div');
                bar.style.cssText = `width: ${Math.max(2, (seg.duration / maxDur) * 100)}%; height: 100%; background: linear-gradient(90deg, #667eea, #764ba2); border-radius: 2px;`;
                barC.appendChild(bar);

                const dur = document.createElement('span');
                dur.style.cssText = 'min-width: 55px; color: var(--text-muted); text-align: right;';
                dur.textContent = seg.duration_str;

                row.appendChild(cb);
                row.appendChild(num);
                row.appendChild(time);
                row.appendChild(barC);
                row.appendChild(dur);
                segListContainer.appendChild(row);
            });

            card.appendChild(segListContainer);
        }

        container.appendChild(card);
    });
}

// 检测单个文件
async function detectSingleFile(idx) {
    const file = sceneFiles[idx];
    if (!file) return;

    const statusTag = document.getElementById(`scene-status-${idx}`);
    if (statusTag) {
        statusTag.textContent = '⏳ 分析中...';
        statusTag.style.background = 'rgba(102, 126, 234, 0.15)';
        statusTag.style.color = 'var(--accent)';
    }

    const threshold = parseFloat(document.getElementById('scene-threshold').value);
    const minInterval = parseFloat(document.getElementById('scene-min-interval').value);

    try {
        const response = await apiFetch(`${API_BASE}/media/scene-detect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: file.path,
                threshold: threshold,
                min_interval: minInterval
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '检测失败');

        sceneResults[file.path] = data;
        renderSceneFileCards();
        updateSceneExportAllBtn();
        showToast(`${file.name}: ${data.message}`, 'success');

    } catch (error) {
        if (statusTag) {
            statusTag.textContent = `❌ ${escapeHtml(error.message)}`;
            statusTag.style.background = 'rgba(255, 71, 87, 0.15)';
            statusTag.style.color = '#ff4757';
        }
        showToast(`${file.name}: ${escapeHtml(error.message)}`, 'error');
    }
}

// 批量检测全部
async function startSceneDetectAll() {
    if (sceneFiles.length === 0) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    const btn = document.getElementById('scene-detect-btn');
    const statusEl = document.getElementById('scene-detect-status');

    btn.disabled = true;
    btn.textContent = '⏳ 批量分析中...';

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < sceneFiles.length; i++) {
        statusEl.textContent = `正在分析 (${i + 1}/${sceneFiles.length}): ${sceneFiles[i].name}`;
        statusEl.style.color = 'var(--accent)';
        await detectSingleFile(i);

        if (sceneResults[sceneFiles[i].path]) {
            successCount++;
        } else {
            failCount++;
        }
    }

    btn.disabled = false;
    btn.textContent = '🔍 批量场景检测';
    const msg = `批量检测完成: ${successCount} 成功${failCount > 0 ? `, ${failCount} 失败` : ''}`;
    statusEl.textContent = msg;
    statusEl.style.color = failCount > 0 ? 'var(--warning)' : 'var(--success)';
    showToast(msg, successCount > 0 ? 'success' : 'error');
}

// 导出单个文件的选中片段
async function exportSingleFile(idx) {
    const file = sceneFiles[idx];
    const result = sceneResults[file.path];
    if (!result) return;

    // 收集选中的片段
    const checkboxes = document.querySelectorAll(`.scene-cb-${idx}`);
    const selectedSegments = [];
    checkboxes.forEach(cb => {
        const sIdx = parseInt(cb.dataset.segIndex);
        if (cb.checked && result.segments[sIdx]) {
            selectedSegments.push(result.segments[sIdx]);
        }
    });

    // 如果没有勾选（列表未展开），默认导出全部
    if (selectedSegments.length === 0 && checkboxes.length === 0) {
        selectedSegments.push(...result.segments);
    }

    if (selectedSegments.length === 0) {
        showToast('请至少选择一个片段', 'error');
        return;
    }

    const outputDir = document.getElementById('media-output-path').value || '';
    const folderMode = getSceneOutputFolderMode();
    const batchName = folderMode === 'batch' ? createSceneBatchName('scenes') : '';
    const statusEl = document.getElementById('scene-export-text');
    const exportSection = document.getElementById('scene-export-status');

    exportSection.classList.remove('hidden');
    statusEl.textContent = `正在导出 ${file.name} 的 ${selectedSegments.length} 个片段...`;

    try {
        const response = await apiFetch(`${API_BASE}/media/scene-split`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: file.path,
                segments: selectedSegments,
                output_dir: outputDir,
                folder_mode: folderMode,
                batch_name: batchName
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '导出失败');

        sceneOutputDir = data.output_dir || '';
        statusEl.textContent = data.message;
        showToast(data.message, 'success');

    } catch (error) {
        statusEl.textContent = `导出失败: ${escapeHtml(error.message)}`;
        showToast(`导出失败: ${escapeHtml(error.message)}`, 'error');
    }
}

// 批量导出全部文件
async function exportAllScenes() {
    const filesToExport = sceneFiles.filter(f => sceneResults[f.path]);
    if (filesToExport.length === 0) {
        showToast('没有已检测的文件可导出', 'error');
        return;
    }

    const outputDir = document.getElementById('media-output-path').value || '';
    const folderMode = getSceneOutputFolderMode();
    const batchName = folderMode === 'batch' ? createSceneBatchName('scenes') : '';
    const statusEl = document.getElementById('scene-export-text');
    const progressEl = document.getElementById('scene-export-progress');
    const exportSection = document.getElementById('scene-export-status');

    exportSection.classList.remove('hidden');
    let totalExported = 0;

    for (let i = 0; i < filesToExport.length; i++) {
        const file = filesToExport[i];
        const result = sceneResults[file.path];
        statusEl.textContent = `正在导出 (${i + 1}/${filesToExport.length}): ${file.name}...`;
        progressEl.querySelector('.progress-bar-inner').style.width = `${((i) / filesToExport.length) * 100}%`;

        try {
            const response = await apiFetch(`${API_BASE}/media/scene-split`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: file.path,
                    segments: result.segments,
                    output_dir: outputDir,
                    folder_mode: folderMode,
                    batch_name: batchName
                })
            });

            const data = await response.json();
            if (response.ok) {
                totalExported += data.files?.length || 0;
                sceneOutputDir = data.output_dir || sceneOutputDir;
            }
        } catch (error) {
            console.error(`导出 ${file.name} 失败:`, error);
        }
    }

    progressEl.querySelector('.progress-bar-inner').style.width = '100%';
    statusEl.textContent = `批量导出完成: 共导出 ${totalExported} 个片段`;
    showToast(`批量导出完成: ${totalExported} 个片段`, 'success');
}

function updateSceneExportAllBtn() {
    const btn = document.getElementById('scene-export-all-btn');
    const hasResults = sceneFiles.some(f => sceneResults[f.path]);
    if (btn) btn.style.display = hasResults ? '' : 'none';
}

async function openSceneOutputDir() {
    let dir = sceneOutputDir;
    if (!dir && sceneFiles.length > 0) {
        const p = sceneFiles[0].path;
        dir = p.substring(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
    }
    if (!dir) {
        showToast('没有输出目录', 'error');
        return;
    }

    try {
        await apiFetch(`${API_BASE}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir })
        });
    } catch (error) {
        showToast('打开目录失败', 'error');
    }
}

// ==================== 一键场景帧 ====================

let sceneFramesOutputDir = '';
const mediaFramePreviewItems = { scene: [], skf: [] };
let mediaFramePreviewSource = '';
let mediaFramePreviewIndex = 0;

// 一键场景帧：批量对所有已添加的视频执行 场景检测 + 导出首帧
async function startSceneDetectFrames() {
    if (sceneFiles.length === 0) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    const btn = document.getElementById('scene-frames-btn');
    const statusEl = document.getElementById('scene-detect-status');
    const exportSection = document.getElementById('scene-export-status');
    const exportText = document.getElementById('scene-export-text');
    const progressBar = document.getElementById('scene-export-progress');

    btn.disabled = true;
    btn.textContent = '⏳ 正在检测导出...';
    exportSection.classList.remove('hidden');

    const threshold = parseFloat(document.getElementById('scene-threshold').value);
    const minInterval = parseFloat(document.getElementById('scene-min-interval').value);
    const framesPerScene = parseInt(document.getElementById('scene-frames-per-scene').value) || 1;
    const imageFormat = document.getElementById('scene-frame-format').value;
    const quality = parseInt(document.getElementById('scene-frame-quality').value);
    const outputDir = document.getElementById('media-output-path')?.value || '';
    const folderMode = getSceneOutputFolderMode();
    const batchName = folderMode === 'batch' ? createSceneBatchName('keyframes') : '';

    let totalFrames = 0;
    let successCount = 0;
    let failCount = 0;
    let allFrameResults = [];

    for (let i = 0; i < sceneFiles.length; i++) {
        const file = sceneFiles[i];
        exportText.textContent = `[${i + 1}/${sceneFiles.length}] 正在处理: ${file.name}...`;
        progressBar.querySelector('.progress-bar-inner').style.width = `${((i) / sceneFiles.length) * 100}%`;
        statusEl.textContent = `处理中 (${i + 1}/${sceneFiles.length})`;
        statusEl.style.color = 'var(--accent)';

        // 更新卡片状态
        const statusTag = document.getElementById(`scene-status-${i}`);
        if (statusTag) {
            statusTag.textContent = '⏳ 场景帧导出...';
            statusTag.style.background = 'rgba(240, 147, 251, 0.15)';
            statusTag.style.color = '#f093fb';
        }

        try {
            const response = await apiFetch(`${API_BASE}/media/scene-detect-frames`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: file.path,
                    threshold: threshold,
                    min_interval: minInterval,
                    frames_per_scene: framesPerScene,
                    format: imageFormat,
                    quality: quality,
                    output_dir: outputDir || '',
                    folder_mode: folderMode,
                    batch_name: batchName
                })
            });

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '导出失败');

            // 同步更新 sceneResults（兼容已有的场景检测数据）
            sceneResults[file.path] = data;
            sceneFramesOutputDir = data.output_dir || sceneFramesOutputDir;
            sceneOutputDir = data.output_dir || sceneOutputDir;

            totalFrames += data.success || 0;
            successCount++;

            // 更新卡片状态
            if (statusTag) {
                statusTag.textContent = `✅ ${data.total_scenes} 场景 · ${data.success} 帧`;
                statusTag.style.background = 'rgba(0, 217, 165, 0.15)';
                statusTag.style.color = '#00d9a5';
            }

            // 将帧结果收集起来
            if (data.frames) {
                allFrameResults.push({
                    fileName: file.name,
                    frames: data.frames,
                    outputDir: data.output_dir
                });
            }

        } catch (error) {
            failCount++;
            if (statusTag) {
                statusTag.textContent = `❌ ${error.message}`;
                statusTag.style.background = 'rgba(255, 71, 87, 0.15)';
                statusTag.style.color = '#ff4757';
            }
        }
    }

    progressBar.querySelector('.progress-bar-inner').style.width = '100%';

    const msg = `场景帧导出完成: ${successCount}/${sceneFiles.length} 个视频，共 ${totalFrames} 帧`;
    exportText.textContent = msg;
    statusEl.textContent = msg;
    statusEl.style.color = failCount > 0 ? 'var(--warning)' : 'var(--success)';

    btn.disabled = false;
    btn.textContent = '🎞️ 一键场景帧';

    showToast(msg, successCount > 0 ? 'success' : 'error');

    // 渲染帧预览
    renderSceneFramesPreview(allFrameResults);

    // 同步刷新卡片（显示片段列表等）
    renderSceneFileCards();
    updateSceneExportAllBtn();
}

// 渲染场景帧预览网格
function renderSceneFramesPreview(allResults) {
    const container = document.getElementById('scene-frames-result');
    const grid = document.getElementById('scene-frames-grid');
    const countEl = document.getElementById('scene-frames-count');

    if (!allResults || allResults.length === 0) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    mediaFramePreviewItems.scene = [];

    let totalCount = 0;
    let html = '';

    allResults.forEach(({ fileName, frames, outputDir }) => {
        const okFrames = frames.filter(f => f.status === 'ok');
        totalCount += okFrames.length;

        // 文件名分隔标题
        if (allResults.length > 1) {
            html += `<div style="grid-column: 1 / -1; font-size: 13px; font-weight: 600; color: var(--text-secondary); padding: 8px 0 4px; border-bottom: 1px solid rgba(255,255,255,0.06);">🎬 ${escapeHtml(fileName)} (${okFrames.length} 帧)</div>`;
        }

        // 按场景分组显示
        let lastScene = -1;
        const hasMultiFrames = okFrames.some(f => f.scene);

        okFrames.forEach(frame => {
            // 场景分组标题（当每场景多帧时显示）
            if (hasMultiFrames && frame.scene && frame.scene !== lastScene) {
                lastScene = frame.scene;
                const sceneFrameCount = okFrames.filter(f => f.scene === frame.scene).length;
                html += `<div style="grid-column: 1 / -1; font-size: 12px; color: var(--accent); padding: 6px 0 2px; display: flex; align-items: center; gap: 6px;">
                    <span style="background: var(--accent); color: #fff; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">场景 ${frame.scene}</span>
                    <span style="color: var(--text-muted); font-size: 11px;">${sceneFrameCount} 帧</span>
                </div>`;
            }

            // 使用 file:// 协议展示本地图片
            const imgSrc = (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function')
                ? window.electronAPI.toFileUrl(frame.output)
                : normalizeFilePath(frame.output);
            const sceneLabel = frame.scene ? `S${frame.scene}` : '';
            const frameLabel = frame.frame ? `f${frame.frame}` : `#${frame.index}`;
            const previewIndex = mediaFramePreviewItems.scene.length;
            mediaFramePreviewItems.scene.push({
                src: imgSrc,
                output: frame.output,
                title: `${fileName} · ${sceneLabel || '场景'} ${frameLabel}`,
                meta: `${frame.time_str || ''}${frame.filename ? ' · ' + frame.filename : ''}`,
            });
            html += `
                <div style="position: relative; background: var(--bg-tertiary); border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.06); transition: transform 0.15s; cursor: pointer;" 
                     onmouseenter="this.style.transform='scale(1.02)'" onmouseleave="this.style.transform='scale(1)'"
                     onclick="openMediaFramePreview('scene', ${previewIndex})"
                     title="${escapeHtml(frame.filename || '')}\n时间: ${escapeHtml(frame.time_str || '')}">
                    <img src="${escapeHtml(imgSrc)}" style="width: 100%; display: block;" loading="lazy"
                         onerror="this.style.display='none'; this.parentElement.querySelector('.img-fallback').style.display='flex'">
                    <div class="img-fallback" style="display: none; width: 100%; min-height: 120px; align-items: center; justify-content: center; background: var(--bg-secondary); color: var(--text-muted); font-size: 11px;">加载失败</div>
                    <div style="position: absolute; bottom: 0; left: 0; right: 0; padding: 4px 8px; background: linear-gradient(transparent, rgba(0,0,0,0.7)); display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-family: monospace; font-size: 11px; color: #fff;">${sceneLabel} ${frameLabel}</span>
                        <span style="font-family: monospace; font-size: 10px; color: rgba(255,255,255,0.7);">${frame.time_str}</span>
                    </div>
                </div>`;
        });
    });

    countEl.textContent = `共 ${totalCount} 帧`;
    grid.innerHTML = html;
}

function _ensureMediaFramePreviewer() {
    let overlay = document.getElementById('media-frame-preview-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'media-frame-preview-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.92);display:none;flex-direction:column;color:#fff;';
    overlay.innerHTML = `
        <div style="height:48px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,0.12);background:rgba(15,15,18,0.96);">
            <div style="min-width:0;flex:1;">
                <div id="media-frame-preview-title" style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
                <div id="media-frame-preview-meta" style="font-size:11px;color:rgba(255,255,255,0.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;"></div>
            </div>
            <span id="media-frame-preview-count" style="font-size:12px;color:rgba(255,255,255,0.7);font-family:monospace;"></span>
            <button class="btn btn-secondary" onclick="mediaFramePreviewPrev()" style="font-size:12px;padding:5px 10px;">上一张</button>
            <button class="btn btn-secondary" onclick="mediaFramePreviewNext()" style="font-size:12px;padding:5px 10px;">下一张</button>
            <button class="btn btn-secondary" onclick="closeMediaFramePreview()" style="font-size:12px;padding:5px 10px;">关闭</button>
        </div>
        <div style="position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px 70px;">
            <button onclick="mediaFramePreviewPrev()" title="上一张" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);width:42px;height:72px;border:1px solid rgba(255,255,255,0.18);border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;font-size:28px;cursor:pointer;">‹</button>
            <img id="media-frame-preview-img" src="" style="max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 12px 40px rgba(0,0,0,0.55);">
            <button onclick="mediaFramePreviewNext()" title="下一张" style="position:absolute;right:14px;top:50%;transform:translateY(-50%);width:42px;height:72px;border:1px solid rgba(255,255,255,0.18);border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;font-size:28px;cursor:pointer;">›</button>
        </div>
    `;
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeMediaFramePreview();
    });
    document.body.appendChild(overlay);

    if (!window.__mediaFramePreviewKeyBound) {
        window.__mediaFramePreviewKeyBound = true;
        document.addEventListener('keydown', (e) => {
            const el = document.getElementById('media-frame-preview-overlay');
            if (!el || el.style.display === 'none') return;
            if (e.key === 'Escape') closeMediaFramePreview();
            else if (e.key === 'ArrowLeft') mediaFramePreviewPrev();
            else if (e.key === 'ArrowRight') mediaFramePreviewNext();
        });
    }
    return overlay;
}

function openMediaFramePreview(source, index) {
    const items = mediaFramePreviewItems[source] || [];
    if (!items.length) return;
    mediaFramePreviewSource = source;
    mediaFramePreviewIndex = Math.max(0, Math.min(items.length - 1, parseInt(index, 10) || 0));
    const overlay = _ensureMediaFramePreviewer();
    overlay.style.display = 'flex';
    _renderMediaFramePreview();
}

function closeMediaFramePreview() {
    const overlay = document.getElementById('media-frame-preview-overlay');
    if (overlay) overlay.style.display = 'none';
}

function mediaFramePreviewPrev() {
    const items = mediaFramePreviewItems[mediaFramePreviewSource] || [];
    if (!items.length) return;
    mediaFramePreviewIndex = (mediaFramePreviewIndex - 1 + items.length) % items.length;
    _renderMediaFramePreview();
}

function mediaFramePreviewNext() {
    const items = mediaFramePreviewItems[mediaFramePreviewSource] || [];
    if (!items.length) return;
    mediaFramePreviewIndex = (mediaFramePreviewIndex + 1) % items.length;
    _renderMediaFramePreview();
}

function _renderMediaFramePreview() {
    const items = mediaFramePreviewItems[mediaFramePreviewSource] || [];
    const item = items[mediaFramePreviewIndex];
    if (!item) return;
    document.getElementById('media-frame-preview-img').src = item.src || '';
    document.getElementById('media-frame-preview-title').textContent = item.title || '';
    document.getElementById('media-frame-preview-meta').textContent = item.meta || item.output || '';
    document.getElementById('media-frame-preview-count').textContent = `${mediaFramePreviewIndex + 1} / ${items.length}`;
}

// 打开场景帧输出目录
async function openSceneFramesDir() {
    const dir = sceneFramesOutputDir || sceneOutputDir;
    if (!dir) {
        showToast('没有输出目录', 'error');
        return;
    }
    try {
        await apiFetch(`${API_BASE}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir })
        });
    } catch (error) {
        showToast('打开目录失败', 'error');
    }
}

// ==================== 🧠 智能关键帧模块 ====================

let smartKfFiles = [];       // 已选择的本地视频文件列表
let smartKfOutputDir = '';   // 输出目录
let smartKfCurrentMode = 'file'; // 'file' | 'url'

// 模式切换
function switchSmartKfMode(mode) {
    smartKfCurrentMode = mode;
    document.getElementById('skf-file-mode').style.display = mode === 'file' ? '' : 'none';
    document.getElementById('skf-url-mode').style.display = mode === 'url' ? '' : 'none';
    document.getElementById('skf-mode-file-btn').classList.toggle('active', mode === 'file');
    document.getElementById('skf-mode-url-btn').classList.toggle('active', mode === 'url');
}

// 通过 Electron 原生对话框选择文件
async function selectSmartKfFiles() {
    if (window.electronAPI?.selectFiles) {
        const files = await window.electronAPI.selectFiles({
            filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'm4v'] }],
            multiple: true,
        });
        if (files && files.length > 0) {
            files.forEach(fp => {
                const name = fp.split('/').pop().split('\\').pop();
                if (!smartKfFiles.some(f => f.path === fp)) {
                    smartKfFiles.push({ name, path: fp });
                }
            });
            updateSmartKfFileDisplay();
            showToast(`已添加 ${files.length} 个文件，共 ${smartKfFiles.length} 个`, 'success');
        }
    } else {
        // 降级：触发 file input
        document.getElementById('skf-video-input')?.click();
    }
}

// 文件选择 & 拖拽
function initSmartKfFileInput() {
    const fileInput = document.getElementById('skf-video-input');
    const dropZone = document.getElementById('skf-drop-zone');

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const newFiles = Array.from(e.target.files).map(f => ({
                    path: getFileNativePath(f),
                    name: f.name
                }));
                newFiles.forEach(nf => {
                    if (!smartKfFiles.find(sf => sf.path === nf.path)) {
                        smartKfFiles.push(nf);
                    }
                });
                updateSmartKfFileDisplay();
                showToast(`已添加 ${newFiles.length} 个文件，共 ${smartKfFiles.length} 个`, 'success');
            }
            fileInput.value = '';
        });
    }

    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent)';
            dropZone.style.background = 'rgba(102, 126, 234, 0.05)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
            const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
            const files = Array.from(e.dataTransfer.files).filter(f =>
                videoExts.some(ext => f.name.toLowerCase().endsWith(ext))
            );
            if (files.length > 0) {
                files.forEach(f => {
                    const info = { path: getFileNativePath(f), name: f.name };
                    if (!smartKfFiles.find(sf => sf.path === info.path)) {
                        smartKfFiles.push(info);
                    }
                });
                updateSmartKfFileDisplay();
                showToast(`已添加 ${files.length} 个文件`, 'success');
            }
        });
    }
}

function updateSmartKfFileDisplay() {
    const pathEl = document.getElementById('skf-video-path');
    if (smartKfFiles.length === 0) {
        pathEl.value = '';
    } else if (smartKfFiles.length === 1) {
        pathEl.value = smartKfFiles[0].path;
    } else {
        pathEl.value = `已选择 ${smartKfFiles.length} 个文件: ${smartKfFiles.map(f => f.name).join(', ')}`;
    }
}

function clearSmartKfFiles() {
    smartKfFiles = [];
    skfMarkers = [];
    skfSelectedIdx = -1;
    skfVideoDuration = 0;
    skfCurrentFilePath = '';
    smartKfOutputDir = '';
    updateSmartKfFileDisplay();
    document.getElementById('skf-video-preview')?.classList.add('hidden');
    document.getElementById('skf-result-section')?.classList.add('hidden');
    const statusEl = document.getElementById('skf-status');
    if (statusEl) {
        statusEl.textContent = '就绪';
        statusEl.style.color = '';
    }
}

// 选择输出目录
async function selectSmartKfOutputDir() {
    if (window.electronAPI?.selectDirectory) {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('skf-output-path').value = dir;
        }
    }
}

// 打开输出目录
async function openSmartKfOutputDir() {
    const dir = smartKfOutputDir || document.getElementById('skf-output-path').value;
    if (!dir) {
        showToast('没有输出目录', 'error');
        return;
    }
    try {
        await apiFetch(`${API_BASE}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir })
        });
    } catch {
        showToast('打开目录失败', 'error');
    }
}

// ========== 视频时间线状态 ==========
let skfMarkers = [];
let skfSelectedIdx = -1;
let skfVideoDuration = 0;
let skfCurrentFilePath = '';

const SKF_TYPE_COLORS = {
    first: '#00d9a5', last: '#00d9a5',
    scene_end: '#ff6b6b', scene_start: '#667eea', sample: '#ffa726', custom: '#e0e0e0',
};
const SKF_TYPE_LABELS = {
    first: '首帧', last: '尾帧',
    scene_end: '场景结束', scene_start: '场景开始', sample: '采样帧', custom: '自定义',
};

function _skfFmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

function _skfMediaUrl(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    if (/^(file|https?|blob|data):/i.test(filePath)) return filePath;
    if (window.electronAPI?.toFileUrl) {
        const fileUrl = window.electronAPI.toFileUrl(filePath);
        if (fileUrl) return fileUrl;
    }
    return normalizeFilePath(filePath);
}

function _skfResolveDuration(data = {}, scenes = []) {
    const direct = [
        data.duration,
        data.video_duration,
        data.media_duration,
    ].map(Number).find(v => Number.isFinite(v) && v > 0);
    if (direct) return direct;

    const candidates = [];
    const collect = (value) => {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) candidates.push(n);
    };

    (scenes || []).forEach(scene => {
        collect(scene.end);
        collect(scene.end_time);
        collect(scene.start);
        collect(scene.start_time);
    });
    (data.segments || []).forEach(scene => {
        collect(scene.end);
        collect(scene.end_time);
    });
    (data.scene_points || []).forEach(point => collect(point.time));

    return candidates.length ? Math.max(...candidates) : 0;
}

// 主入口：分析关键帧（仅检测，不导出）
/** 下拉菜单模式切换 */
function skfModeChanged(mode) {
    const sceneParams = document.querySelector('#skf-threshold')?.closest('.form-section');
    const frameStrategy = document.querySelector('#skf-frames-per-scene')?.closest('.form-section');
    const btn = document.getElementById('skf-start-btn');
    if (mode === 'grid') {
        // 帧网格模式：隐藏场景检测参数
        if (sceneParams) sceneParams.style.display = 'none';
        if (frameStrategy) frameStrategy.style.display = 'none';
        btn.innerHTML = '🖼️ 生成帧网格';
    } else {
        // 场景检测模式：显示参数
        if (sceneParams) sceneParams.style.display = '';
        if (frameStrategy) frameStrategy.style.display = '';
        btn.innerHTML = '🔍 分析关键帧';
    }
}

async function startSmartKeyframes() {
    const mode = document.getElementById('skf-mode')?.value || 'scene';

    // 帧网格模式：跳过 FFmpeg，直接加载视频并生成帧网格
    if (mode === 'grid') {
        await _startGridOnlyMode();
        return;
    }

    // 以下是原有的场景检测模式
    const btn = document.getElementById('skf-start-btn');
    const statusEl = document.getElementById('skf-status');
    const progressSection = document.getElementById('skf-progress-section');
    const progressText = document.getElementById('skf-progress-text');
    const progressBar = document.getElementById('skf-progress-bar');

    const threshold = parseFloat(document.getElementById('skf-threshold').value);
    const minInterval = parseFloat(document.getElementById('skf-min-interval').value);
    const framesPerScene = parseInt(document.getElementById('skf-frames-per-scene').value) || 0;

    if (smartKfCurrentMode === 'url') {
        await _startSmartKeyframesFromUrls({ threshold, minInterval, framesPerScene });
        return;
    }
    if (smartKfFiles.length === 0) { showToast('请先选择视频文件', 'error'); return; }
    if (smartKfFiles.length > 1) {
        await _startSmartKeyframesBatchFiles({ threshold, minInterval, framesPerScene });
        return;
    }

    const file = smartKfFiles[0];
    skfCurrentFilePath = file.path;

    btn.disabled = true;
    btn.textContent = '⏳ 正在分析...';
    progressSection.classList.remove('hidden');
    progressText.textContent = `正在分析: ${file.name}...`;
    progressBar.querySelector('.progress-bar-inner').style.width = '30%';
    statusEl.textContent = '分析中...';
    statusEl.style.color = 'var(--accent)';

    try {
        const response = await apiFetch(`${API_BASE}/media/scene-detect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: file.path, threshold, min_interval: minInterval })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '分析失败');

        progressBar.querySelector('.progress-bar-inner').style.width = '100%';
        const scenes = data.scenes || data.segments || data.scene_list || [];
        const duration = _skfResolveDuration(data, scenes);
        const offset = parseFloat(document.getElementById('skf-boundary-offset')?.value || 0.04);

        skfMarkers = _buildMarkersFromScenes(scenes, duration, framesPerScene, offset);

        const msg = `分析完成: ${scenes.length} 个场景，${skfMarkers.length} 个标记`;
        progressText.textContent = msg;
        statusEl.textContent = msg;
        statusEl.style.color = 'var(--success)';
        showToast(msg, 'success');

        _skfShowVideoTimeline(file.path, duration);
    } catch (error) {
        progressText.textContent = `分析失败: ${error.message}`;
        statusEl.textContent = `❌ ${error.message}`;
        statusEl.style.color = 'var(--error)';
        showToast(`分析失败: ${error.message}`, 'error');
    }

    btn.disabled = false;
    btn.textContent = '🔍 重新分析';
}

/** 帧网格浏览模式：跳过场景检测，直接加载视频并生成帧网格 */
async function _startGridOnlyMode() {
    if (smartKfFiles.length === 0) { showToast('请先选择视频文件', 'error'); return; }
    const file = smartKfFiles[0];
    skfCurrentFilePath = file.path;

    const btn = document.getElementById('skf-start-btn');
    const statusEl = document.getElementById('skf-status');
    btn.disabled = true;
    btn.textContent = '⏳ 加载视频...';
    statusEl.textContent = '加载视频中...';
    statusEl.style.color = 'var(--accent)';

    // 加载视频
    const section = document.getElementById('skf-video-preview');
    const video = document.getElementById('skf-video');
    section.classList.remove('hidden');

    const videoSrc = normalizeFilePath(file.path);
    if (video.getAttribute('data-path') !== file.path) {
        video.setAttribute('data-path', file.path);
        video.src = videoSrc;
        video.load();
    }

    // 等待视频元数据加载
    await new Promise((resolve) => {
        if (video.readyState >= 1) { resolve(); return; }
        video.onloadedmetadata = resolve;
        setTimeout(resolve, 5000); // 超时保护
    });

    skfVideoDuration = video.duration;
    skfMarkers = []; // 帧网格模式不生成标记
    _skfRenderMarkers();

    // 设置时间更新
    video.ontimeupdate = () => {
        const t = video.currentTime, d = skfVideoDuration || 1, pct = (t / d) * 100;
        document.getElementById('skf-playhead').style.left = `${pct}%`;
        document.getElementById('skf-timeline-progress').style.width = `${pct}%`;
        document.getElementById('skf-video-time').textContent = `${_skfFmtTime(t)} / ${_skfFmtTime(d)}`;
    };

    // 直接生成帧网格
    skfShowFrameGrid();

    const msg = `视频已加载 (${_skfFmtTime(video.duration)})，正在生成帧网格...`;
    statusEl.textContent = msg;
    statusEl.style.color = 'var(--success)';

    btn.disabled = false;
    btn.textContent = '🖼️ 重新生成';
}

async function _startSmartKeyframesBatchFiles({ threshold, minInterval, framesPerScene }) {
    const btn = document.getElementById('skf-start-btn');
    const statusEl = document.getElementById('skf-status');
    const progressSection = document.getElementById('skf-progress-section');
    const progressText = document.getElementById('skf-progress-text');
    const progressBar = document.getElementById('skf-progress-bar')?.querySelector('.progress-bar-inner');
    const format = document.getElementById('skf-format').value;
    const quality = parseInt(document.getElementById('skf-quality').value, 10);
    const outputDir = document.getElementById('skf-output-path').value || '';
    const offset = parseFloat(document.getElementById('skf-boundary-offset')?.value || 0.04);
    const cleanOld = document.getElementById('skf-clean-old-tl')?.checked ?? true;

    btn.disabled = true;
    btn.textContent = '⏳ 批量导出中...';
    progressSection.classList.remove('hidden');
    document.getElementById('skf-video-preview')?.classList.add('hidden');
    statusEl.textContent = `批量处理 ${smartKfFiles.length} 个文件...`;
    statusEl.style.color = 'var(--accent)';

    const allResults = [];
    let okFiles = 0;
    try {
        for (let i = 0; i < smartKfFiles.length; i++) {
            const file = smartKfFiles[i];
            const pct = Math.round((i / smartKfFiles.length) * 100);
            if (progressBar) progressBar.style.width = `${pct}%`;
            progressText.textContent = `正在处理 ${i + 1}/${smartKfFiles.length}: ${file.name}`;

            const response = await apiFetch(`${API_BASE}/media/scene-detect-frames`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_path: file.path,
                    threshold,
                    min_interval: minInterval,
                    frames_per_scene: framesPerScene,
                    boundary_offset: offset,
                    format,
                    quality,
                    output_dir: outputDir,
                    clean_old: cleanOld,
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(`${file.name}: ${data.error || '导出失败'}`);

            okFiles++;
            smartKfOutputDir = data.output_dir || smartKfOutputDir;
            allResults.push({ fileName: file.name, frames: data.frames || [], sceneCount: data.total_scenes || 0 });
        }

        if (progressBar) progressBar.style.width = '100%';
        const totalFrames = allResults.reduce((sum, item) => sum + (item.frames || []).filter(f => f.status === 'ok').length, 0);
        const msg = `✅ 批量完成: ${okFiles}/${smartKfFiles.length} 个文件，共 ${totalFrames} 帧`;
        progressText.textContent = msg;
        statusEl.textContent = msg;
        statusEl.style.color = 'var(--success)';
        document.getElementById('skf-open-dir-btn')?.classList.remove('hidden');
        renderSmartKfPreview(allResults);
        showToast(msg, 'success');
    } catch (error) {
        progressText.textContent = `批量失败: ${error.message}`;
        statusEl.textContent = `❌ ${error.message}`;
        statusEl.style.color = 'var(--error)';
        showToast(`批量失败: ${error.message}`, 'error');
    }

    btn.disabled = false;
    btn.textContent = '🔍 分析关键帧';
}

async function _startSmartKeyframesFromUrls({ threshold, minInterval, framesPerScene }) {
    const raw = document.getElementById('skf-url-links')?.value || '';
    const urls = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (urls.length === 0) { showToast('请先粘贴视频链接', 'error'); return; }

    const btn = document.getElementById('skf-start-btn');
    const statusEl = document.getElementById('skf-status');
    const progressSection = document.getElementById('skf-progress-section');
    const progressText = document.getElementById('skf-progress-text');
    const progressBar = document.getElementById('skf-progress-bar')?.querySelector('.progress-bar-inner');
    const format = document.getElementById('skf-format').value;
    const quality = parseInt(document.getElementById('skf-quality').value, 10);
    const outputDir = document.getElementById('skf-output-path').value || '';
    const offset = parseFloat(document.getElementById('skf-boundary-offset')?.value || 0.04);

    btn.disabled = true;
    btn.textContent = '⏳ 下载并分析...';
    progressSection.classList.remove('hidden');
    document.getElementById('skf-video-preview')?.classList.add('hidden');
    if (progressBar) progressBar.style.width = '10%';
    progressText.textContent = `正在处理 ${urls.length} 个链接...`;
    statusEl.textContent = '下载并分析中...';
    statusEl.style.color = 'var(--accent)';

    try {
        const response = await apiFetch(`${API_BASE}/media/download-and-detect-frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                urls,
                threshold,
                min_interval: minInterval,
                frames_per_scene: framesPerScene,
                boundary_offset: offset,
                format,
                quality,
                output_dir: outputDir,
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '链接关键帧处理失败');

        if (progressBar) progressBar.style.width = '100%';
        smartKfOutputDir = data.output_dir || smartKfOutputDir;
        const allResults = (data.results || []).filter(r => r.success).map((r, i) => ({
            fileName: r.url || `链接 ${i + 1}`,
            frames: r.frames || [],
            sceneCount: r.total_scenes || 0,
        }));
        const failed = (data.results || []).filter(r => !r.success);
        const totalFrames = allResults.reduce((sum, item) => sum + (item.frames || []).filter(f => f.status === 'ok').length, 0);
        const msg = failed.length > 0
            ? `⚠️ 链接处理完成: 成功 ${allResults.length}/${urls.length}，失败 ${failed.length}，共 ${totalFrames} 帧`
            : `✅ 链接处理完成: ${allResults.length} 个视频，共 ${totalFrames} 帧`;
        progressText.textContent = msg;
        statusEl.textContent = msg;
        statusEl.style.color = failed.length > 0 ? '#f0ad4e' : 'var(--success)';
        document.getElementById('skf-open-dir-btn')?.classList.remove('hidden');
        renderSmartKfPreview(allResults);
        showToast(msg, failed.length > 0 ? 'warning' : 'success');
    } catch (error) {
        progressText.textContent = `链接处理失败: ${error.message}`;
        statusEl.textContent = `❌ ${error.message}`;
        statusEl.style.color = 'var(--error)';
        showToast(`链接处理失败: ${error.message}`, 'error');
    }

    btn.disabled = false;
    btn.textContent = '🔍 分析关键帧';
}

function _buildMarkersFromScenes(scenes, duration, framesPerScene, offset) {
    const markers = [];
    if (duration <= 0) return markers;
    markers.push({ time: 0, type: 'first', label: '首帧' });

    scenes.forEach((s, i) => {
        const sEnd = parseFloat(s.end || s.end_time || 0);
        const nStart = (i + 1 < scenes.length) ? parseFloat(scenes[i + 1].start || scenes[i + 1].start_time || 0) : duration;

        if (sEnd > 0 && sEnd < duration - 0.1)
            markers.push({ time: Math.max(0, sEnd - offset), type: 'scene_end', label: `S${i + 1} 结束` });
        if (i + 1 < scenes.length && nStart > 0)
            markers.push({ time: Math.min(duration, nStart + offset), type: 'scene_start', label: `S${i + 2} 开始` });

        if (framesPerScene > 0) {
            const sStart = parseFloat(s.start || s.start_time || 0);
            const sDur = sEnd - sStart;
            if (sDur > 0.5) {
                for (let k = 0; k < framesPerScene; k++) {
                    const t = sStart + (sDur * (k + 1)) / (framesPerScene + 1);
                    markers.push({ time: t, type: 'sample', label: `S${i + 1} 采样${k + 1}` });
                }
            }
        }
    });

    if (duration > 0.1) markers.push({ time: Math.max(0, duration - 0.04), type: 'last', label: '尾帧' });
    markers.sort((a, b) => a.time - b.time);
    return markers;
}

function _skfShowVideoTimeline(filePath, duration) {
    const section = document.getElementById('skf-video-preview');
    const video = document.getElementById('skf-video');
    const statusEl = document.getElementById('skf-status');
    section.classList.remove('hidden');
    document.getElementById('skf-frame-grid-section')?.classList.add('hidden');
    skfGridAbort = true;

    const fallbackDuration = Number(duration);
    if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) {
        skfVideoDuration = fallbackDuration;
    } else {
        const currentDuration = Number(video.duration);
        skfVideoDuration = Number.isFinite(currentDuration) && currentDuration > 0 ? currentDuration : 1;
    }
    document.getElementById('skf-video-time').textContent = `${_skfFmtTime(video.currentTime || 0)} / ${_skfFmtTime(skfVideoDuration)}`;
    _skfRenderMarkers();

    // 直接用 file:// 协议加载视频（webSecurity: false 已设置）
    // toFileUrl 正确处理中文/空格/#等特殊字符
    const videoSrc = _skfMediaUrl(filePath);
    if (video.getAttribute('data-path') !== filePath) {
        video.setAttribute('data-path', filePath);
        video.src = videoSrc;
        video.load();
    }

    const onReady = () => {
        const metaDuration = Number(video.duration);
        if (Number.isFinite(metaDuration) && metaDuration > 0) {
            skfVideoDuration = metaDuration;
        } else if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) {
            skfVideoDuration = fallbackDuration;
        }
        _skfRenderMarkers();
        document.getElementById('skf-video-time').textContent = `${_skfFmtTime(video.currentTime || 0)} / ${_skfFmtTime(skfVideoDuration || 1)}`;
    };
    video.onloadedmetadata = onReady;
    video.onerror = () => {
        const code = video.error ? ` code=${video.error.code}` : '';
        console.warn(`[SmartKeyframes] 视频预览加载失败${code}:`, filePath);
        if (statusEl) {
            statusEl.textContent = '⚠️ 视频预览加载失败；标记已按检测结果生成，仍可导出选中帧';
            statusEl.style.color = '#f0ad4e';
        }
        _skfRenderMarkers();
    };
    if (video.readyState >= 1) onReady();

    video.ontimeupdate = () => {
        const t = video.currentTime, d = skfVideoDuration || 1, pct = (t / d) * 100;
        document.getElementById('skf-playhead').style.left = `${pct}%`;
        document.getElementById('skf-timeline-progress').style.width = `${pct}%`;
        document.getElementById('skf-video-time').textContent = `${_skfFmtTime(t)} / ${_skfFmtTime(d)}`;
    };

    skfSelectedIdx = -1;
    _skfUpdateMarkerInfo();
}

function _skfRenderMarkers() {
    const container = document.getElementById('skf-markers-container');
    container.innerHTML = '';
    document.getElementById('skf-marker-count').textContent = `${skfMarkers.length} 个标记`;

    skfMarkers.forEach((mk, idx) => {
        const pct = (mk.time / (skfVideoDuration || 1)) * 100;
        const color = SKF_TYPE_COLORS[mk.type] || '#e0e0e0';
        const sel = idx === skfSelectedIdx;

        const el = document.createElement('div');
        el.style.cssText = `position:absolute;left:${pct}%;top:0;width:3px;height:100%;background:${color};cursor:pointer;transform:translateX(-1px);z-index:${sel ? 8 : 5};opacity:${sel ? 1 : 0.7};transition:opacity 0.15s;`;
        el.title = `${_skfFmtTime(mk.time)} - ${mk.label}`;
        el.onmouseenter = () => el.style.opacity = '1';
        el.onmouseleave = () => { if (idx !== skfSelectedIdx) el.style.opacity = '0.7'; };
        el.onclick = (e) => {
            e.stopPropagation();
            skfSelectedIdx = idx;
            document.getElementById('skf-video').currentTime = mk.time;
            document.getElementById('skf-video').pause();
            _skfRenderMarkers();
            _skfUpdateMarkerInfo();
        };

        const pin = document.createElement('div');
        pin.style.cssText = `position:absolute;top:-5px;left:50%;transform:translateX(-50%);width:${sel ? 12 : 9}px;height:${sel ? 12 : 9}px;border-radius:50%;background:${color};border:2px solid ${sel ? '#fff' : 'rgba(255,255,255,0.5)'};box-shadow:0 1px 3px rgba(0,0,0,0.4);`;
        el.appendChild(pin);
        container.appendChild(el);
    });
}

function _skfUpdateMarkerInfo() {
    const infoEl = document.getElementById('skf-marker-info');
    const removeBtn = document.getElementById('skf-remove-marker-btn');
    const prevBtn = document.getElementById('skf-prev-marker-btn');
    const nextBtn = document.getElementById('skf-next-marker-btn');
    const hasMarkers = skfMarkers.length > 0;
    if (prevBtn) {
        prevBtn.disabled = !hasMarkers;
        prevBtn.style.opacity = hasMarkers ? '1' : '0.5';
    }
    if (nextBtn) {
        nextBtn.disabled = !hasMarkers;
        nextBtn.style.opacity = hasMarkers ? '1' : '0.5';
    }
    if (skfSelectedIdx >= 0 && skfSelectedIdx < skfMarkers.length) {
        const mk = skfMarkers[skfSelectedIdx];
        infoEl.classList.remove('hidden');
        infoEl.innerHTML = `<span style="color:${SKF_TYPE_COLORS[mk.type]}">●</span> #${skfSelectedIdx + 1} <strong>${mk.label}</strong> — ${_skfFmtTime(mk.time)}`;
        removeBtn.disabled = false; removeBtn.style.opacity = '1';
    } else {
        infoEl.classList.add('hidden');
        removeBtn.disabled = true; removeBtn.style.opacity = '0.5';
    }
}

let _skfDragging = false;

function skfTimelineSeek(e) {
    _skfDragging = true;
    _skfSeekToMousePos(e);
    const onMove = (ev) => { if (_skfDragging) _skfSeekToMousePos(ev); };
    const onUp = () => { _skfDragging = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function _skfSeekToMousePos(e) {
    const rect = document.getElementById('skf-timeline').getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const video = document.getElementById('skf-video');
    video.currentTime = pct * (skfVideoDuration || 1);
}

function skfTimelineHover(e) {
    const rect = document.getElementById('skf-timeline').getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const tt = document.getElementById('skf-timeline-tooltip');
    tt.style.display = 'block'; tt.style.left = `${pct * 100}%`;
    tt.textContent = _skfFmtTime(pct * (skfVideoDuration || 1));
}
function skfTimelineHoverEnd() { document.getElementById('skf-timeline-tooltip').style.display = 'none'; }

function skfAddMarkerAtCurrent() {
    const video = document.getElementById('skf-video');
    if (!video.src || skfVideoDuration <= 0) { showToast('请先加载视频', 'warning'); return; }
    const t = video.currentTime;
    if (skfMarkers.some(m => Math.abs(m.time - t) < 0.05)) { showToast('该位置已有标记', 'warning'); return; }
    skfMarkers.push({ time: t, type: 'custom', label: `自定义 ${_skfFmtTime(t)}` });
    skfMarkers.sort((a, b) => a.time - b.time);
    skfSelectedIdx = skfMarkers.findIndex(m => Math.abs(m.time - t) < 0.05);
    _skfRenderMarkers(); _skfUpdateMarkerInfo();
    showToast(`已添加标记: ${_skfFmtTime(t)}`, 'success');
}

function skfJumpMarker(direction) {
    if (!skfMarkers.length) {
        showToast('没有可跳转的标记', 'warning');
        return;
    }

    const video = document.getElementById('skf-video');
    const dir = direction < 0 ? -1 : 1;
    let nextIdx = -1;

    if (skfSelectedIdx >= 0 && skfSelectedIdx < skfMarkers.length) {
        nextIdx = (skfSelectedIdx + dir + skfMarkers.length) % skfMarkers.length;
    } else {
        const currentTime = video?.currentTime || 0;
        if (dir > 0) {
            nextIdx = skfMarkers.findIndex(m => m.time > currentTime + 0.03);
            if (nextIdx === -1) nextIdx = 0;
        } else {
            for (let i = skfMarkers.length - 1; i >= 0; i--) {
                if (skfMarkers[i].time < currentTime - 0.03) {
                    nextIdx = i;
                    break;
                }
            }
            if (nextIdx === -1) nextIdx = skfMarkers.length - 1;
        }
    }

    skfSelectedIdx = nextIdx;
    if (video) {
        video.pause();
        video.currentTime = skfMarkers[nextIdx].time;
    }
    _skfRenderMarkers();
    _skfUpdateMarkerInfo();
}

function skfRemoveSelectedMarker() {
    if (skfSelectedIdx < 0 || skfSelectedIdx >= skfMarkers.length) return;
    const removed = skfMarkers.splice(skfSelectedIdx, 1)[0];
    skfSelectedIdx = -1;
    _skfRenderMarkers(); _skfUpdateMarkerInfo();
    showToast(`已删除: ${removed.label}`, 'success');
}

function skfClearAllMarkers() {
    if (skfMarkers.length === 0) return;
    skfMarkers = []; skfSelectedIdx = -1;
    _skfRenderMarkers(); _skfUpdateMarkerInfo();
    showToast('已清空所有标记', 'success');
}

// ========== 帧网格浏览（纯浏览器端，不缓存/不导出到磁盘） ==========
let skfGridFrames = []; // [{time, dataUrl, selected}]
let skfGridAbort = false;

/** 分析完成后自动生成帧网格 */
function skfShowFrameGrid() {
    const section = document.getElementById('skf-frame-grid-section');
    section.classList.remove('hidden');
    skfRegenerateGrid();
}

/** 重新生成网格（切换间隔时调用） */
async function skfRegenerateGrid() {
    const video = document.getElementById('skf-video');
    if (!video || !video.duration || video.duration === Infinity) {
        showToast('视频未加载', 'error'); return;
    }
    skfGridAbort = true;
    await new Promise(r => setTimeout(r, 100));
    skfGridAbort = false;

    const interval = parseFloat(document.getElementById('skf-grid-interval').value) || 1;
    const duration = video.duration;
    const totalFrames = Math.floor(duration / interval) + 1;

    skfGridFrames = [];
    const grid = document.getElementById('skf-frame-grid');
    grid.innerHTML = '';
    const progressDiv = document.getElementById('skf-grid-progress');
    const progressBar = document.getElementById('skf-grid-progress-bar');
    const progressText = document.getElementById('skf-grid-progress-text');
    progressDiv.classList.remove('hidden');

    // 创建离屏 canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // 缩略图宽度
    const thumbW = 240;
    const aspect = video.videoHeight / video.videoWidth;
    const thumbH = Math.round(thumbW * aspect);
    canvas.width = thumbW;
    canvas.height = thumbH;

    const wasPaused = video.paused;
    const savedTime = video.currentTime;
    video.pause();

    for (let i = 0; i < totalFrames; i++) {
        if (skfGridAbort) break;
        const time = Math.min(i * interval, duration - 0.01);

        // seek to time
        video.currentTime = time;
        await new Promise(resolve => {
            const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
            video.addEventListener('seeked', onSeeked);
            // 超时保护
            setTimeout(resolve, 500);
        });

        // 绘制帧
        ctx.drawImage(video, 0, 0, thumbW, thumbH);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.75);

        const frameObj = { time, dataUrl, selected: false, index: i };
        skfGridFrames.push(frameObj);

        // 创建 DOM 元素
        const cell = document.createElement('div');
        cell.className = 'skf-grid-cell';
        cell.dataset.index = i;
        cell.style.cssText = 'position:relative;cursor:pointer;border-radius:6px;overflow:hidden;border:2px solid transparent;transition:border-color 0.15s,transform 0.1s;';
        cell.innerHTML = `
            <img src="${dataUrl}" style="width:100%;display:block;" draggable="false">
            <div style="position:absolute;bottom:0;left:0;right:0;padding:3px 6px;background:linear-gradient(transparent,rgba(0,0,0,0.8));font-size:11px;color:#fff;font-family:monospace;text-align:center;">${_skfFmtTime(time)}</div>
            <div class="skf-grid-check" style="display:none;position:absolute;top:4px;right:4px;width:22px;height:22px;background:#00d9a5;border-radius:50%;display:none;align-items:center;justify-content:center;font-size:13px;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,0.3);">✓</div>
        `;
        cell.addEventListener('click', () => skfToggleGridFrame(i, cell));
        grid.appendChild(cell);

        // 更新进度
        const pct = Math.round(((i + 1) / totalFrames) * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = `${i + 1}/${totalFrames}`;

        // 让 UI 更新
        if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
    }

    progressDiv.classList.add('hidden');
    // 恢复视频位置
    video.currentTime = savedTime;
    if (!wasPaused) video.play();
    _skfUpdateGridCount();
}

/** 切换帧选中状态 */
function skfToggleGridFrame(index, cell) {
    if (!skfGridFrames[index]) return;
    skfGridFrames[index].selected = !skfGridFrames[index].selected;
    const selected = skfGridFrames[index].selected;
    cell.style.borderColor = selected ? '#00d9a5' : 'transparent';
    cell.style.transform = selected ? 'scale(0.97)' : '';
    const check = cell.querySelector('.skf-grid-check');
    if (check) check.style.display = selected ? 'flex' : 'none';
    _skfUpdateGridCount();
}

function skfSelectAllGrid() {
    document.querySelectorAll('.skf-grid-cell').forEach((cell, i) => {
        if (skfGridFrames[i]) {
            skfGridFrames[i].selected = true;
            cell.style.borderColor = '#00d9a5';
            cell.style.transform = 'scale(0.97)';
            const check = cell.querySelector('.skf-grid-check');
            if (check) check.style.display = 'flex';
        }
    });
    _skfUpdateGridCount();
}

function skfDeselectAllGrid() {
    document.querySelectorAll('.skf-grid-cell').forEach((cell, i) => {
        if (skfGridFrames[i]) {
            skfGridFrames[i].selected = false;
            cell.style.borderColor = 'transparent';
            cell.style.transform = '';
            const check = cell.querySelector('.skf-grid-check');
            if (check) check.style.display = 'none';
        }
    });
    _skfUpdateGridCount();
}

function _skfUpdateGridCount() {
    const sel = skfGridFrames.filter(f => f.selected).length;
    const total = skfGridFrames.length;
    const el = document.getElementById('skf-grid-selected-count');
    if (el) el.textContent = `${sel} / ${total} 已选`;
}

/** 导出选中的网格帧 */
async function skfExportSelectedGridFrames() {
    const selected = skfGridFrames.filter(f => f.selected);
    if (selected.length === 0) { showToast('请先选择要导出的帧', 'error'); return; }
    if (!skfCurrentFilePath) { showToast('没有视频文件', 'error'); return; }

    const format = document.getElementById('skf-format').value;
    const quality = parseInt(document.getElementById('skf-quality').value);
    const outputDir = document.getElementById('skf-output-path').value || '';
    const cleanOld = document.getElementById('skf-grid-clean-old').checked;

    const statusEl = document.getElementById('skf-status');
    statusEl.textContent = `正在导出 ${selected.length} 帧...`; statusEl.style.color = 'var(--accent)';

    try {
        const response = await apiFetch(`${API_BASE}/media/scene-export-frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: skfCurrentFilePath,
                frames: selected.map((f, i) => ({ time: f.time, type: 'grid', label: `网格帧 ${_skfFmtTime(f.time)}`, scene: i + 1 })),
                format, quality, output_dir: outputDir, clean_old: cleanOld,
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '导出失败');

        const msg = `✅ 导出完成: ${data.success || 0} 帧`;
        statusEl.textContent = msg; statusEl.style.color = 'var(--success)';
        showToast(msg, 'success');
        smartKfOutputDir = data.output_dir || smartKfOutputDir;
        document.getElementById('skf-open-dir-btn').classList.remove('hidden');

        if (data.frames) {
            renderSmartKfPreview([{ fileName: skfCurrentFilePath.split('/').pop(), frames: data.frames }]);
        }
    } catch (error) {
        statusEl.textContent = `❌ ${error.message}`; statusEl.style.color = 'var(--error)';
        showToast(`导出失败: ${error.message}`, 'error');
    }
}

async function skfExportMarkedFrames() {
    if (skfMarkers.length === 0) { showToast('没有标记点', 'error'); return; }
    if (!skfCurrentFilePath) { showToast('没有视频文件', 'error'); return; }

    const exportBtn = document.getElementById('skf-export-marked-btn');
    const openDirBtn = document.getElementById('skf-open-dir-btn');
    const statusEl = document.getElementById('skf-status');

    const format = document.getElementById('skf-format').value;
    const quality = parseInt(document.getElementById('skf-quality').value);
    const outputDir = document.getElementById('skf-output-path').value || '';
    const cleanOld = document.getElementById('skf-clean-old-tl').checked;

    exportBtn.disabled = true; exportBtn.textContent = '⏳ 导出中...';
    statusEl.textContent = '正在导出...'; statusEl.style.color = 'var(--accent)';

    try {
        const response = await apiFetch(`${API_BASE}/media/scene-export-frames`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: skfCurrentFilePath,
                frames: skfMarkers.map((m, i) => ({ time: m.time, type: m.type, label: m.label, scene: i + 1 })),
                format, quality, output_dir: outputDir, clean_old: cleanOld,
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '导出失败');

        const msg = `✅ 导出完成: ${data.success || 0} 帧`;
        statusEl.textContent = msg; statusEl.style.color = 'var(--success)';
        showToast(msg, 'success');
        smartKfOutputDir = data.output_dir || smartKfOutputDir;
        openDirBtn.classList.remove('hidden');

        if (data.frames) {
            renderSmartKfPreview([{ fileName: skfCurrentFilePath.split('/').pop(), frames: data.frames }]);
        }
    } catch (error) {
        statusEl.textContent = `❌ ${error.message}`; statusEl.style.color = 'var(--error)';
        showToast(`导出失败: ${error.message}`, 'error');
    }
    exportBtn.disabled = false; exportBtn.textContent = '✅ 导出选中帧';
}

function renderSmartKfPreview(allResults) {
    const container = document.getElementById('skf-result-section');
    const grid = document.getElementById('skf-result-grid');
    const countEl = document.getElementById('skf-result-count');
    if (!allResults || allResults.length === 0) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');

    let totalCount = 0, html = '';
    allResults.forEach(({ fileName, frames, sceneCount }) => {
        const okFrames = frames.filter(f => f.status === 'ok');
        totalCount += okFrames.length;
        okFrames.forEach(frame => {
            const imgSrc = (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function')
                ? window.electronAPI.toFileUrl(frame.output)
                : normalizeFilePath(frame.output);
            const borderColor = SKF_TYPE_COLORS[frame.type] || '#667eea';
            const typeLabel = SKF_TYPE_LABELS[frame.type] || frame.type;
            html += `<div style="position:relative;background:var(--bg-tertiary);border-radius:8px;overflow:hidden;border:2px solid ${borderColor}33;cursor:pointer;"
                     title="${frame.time_str} - ${typeLabel}">
                    <img src="${imgSrc}" style="width:100%;display:block;" loading="lazy"
                         onerror="this.style.display='none';this.parentElement.querySelector('.img-fallback').style.display='flex'">
                    <div class="img-fallback" style="display:none;width:100%;min-height:120px;align-items:center;justify-content:center;background:var(--bg-secondary);color:var(--text-muted);font-size:11px;">加载失败</div>
                    <div style="position:absolute;top:6px;left:6px;"><span style="background:${borderColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;">${typeLabel}</span></div>
                    <div style="position:absolute;bottom:0;left:0;right:0;padding:4px 8px;background:linear-gradient(transparent,rgba(0,0,0,0.75));display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-family:monospace;font-size:11px;color:#fff;">#${frame.index}</span>
                        <span style="font-family:monospace;font-size:10px;color:rgba(255,255,255,0.8);">${frame.time_str}</span>
                    </div></div>`;
        });
    });
    countEl.textContent = `共 ${totalCount} 帧`;
    grid.innerHTML = html;
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => { initSmartKfFileInput(); });
    if (document.readyState !== 'loading') { setTimeout(initSmartKfFileInput, 100); }
}

// ==================== 手动裁切弹窗模块 ====================

let trimState = {
    filePath: '',
    fileName: '',
    duration: 0,
    inTime: 0,
    outTime: 0,
    peaks: [],
    scenePoints: [],   // 场景切割点时间戳
    isPlaying: false,
    animFrameId: null,
    dragging: null,  // 'in' | 'out' | null
    // 缩放状态
    zoom: 1,          // 1 = 全览，10 = 只看 1/10 时长
    viewStart: 0,     // 可见时间窗口起点
    viewEnd: 0        // 可见时间窗口终点
};

async function openTrimModal(filePath, fileName) {
    trimState.filePath = filePath;
    trimState.fileName = fileName;
    trimState.inTime = 0;
    trimState.outTime = 0;
    trimState.isPlaying = false;
    trimState.dragging = null;

    // 从场景检测结果读取切割点
    const fileResult = sceneResults[filePath];
    if (fileResult && fileResult.scene_points) {
        trimState.scenePoints = fileResult.scene_points.map(p => p.time || p);
    } else {
        trimState.scenePoints = [];
    }

    document.getElementById('trim-file-name').textContent = fileName;
    document.getElementById('trim-export-status').textContent = '';

    // 加载视频
    const video = document.getElementById('trim-video-player');
    const videoUrl = normalizeFilePath(filePath);
    video.src = videoUrl;
    video.currentTime = 0;

    video.onloadedmetadata = () => {
        trimState.duration = video.duration;
        trimState.outTime = video.duration;
        trimState.zoom = 1;
        trimState.viewStart = 0;
        trimState.viewEnd = video.duration;
        updateTrimUI();
        updateTrimTimeRuler();
    };

    video.ontimeupdate = () => {
        updateTrimPlayhead();
        document.getElementById('trim-current-time').textContent = formatTrimTime(video.currentTime);
    };

    video.onended = () => {
        trimState.isPlaying = false;
        document.getElementById('trim-play-btn').textContent = '▶ 播放';
    };

    // 显示弹窗
    document.getElementById('trim-modal').style.display = 'flex';

    // 加载波形
    loadTrimWaveform(filePath);

    // 设置事件监听
    setupTrimDragHandles();
    setupTrimTimelineClick();
    setupTrimZoom();
}

function closeTrimModal() {
    const video = document.getElementById('trim-video-player');
    video.pause();
    video.src = '';
    trimState.isPlaying = false;
    if (trimState.animFrameId) {
        cancelAnimationFrame(trimState.animFrameId);
        trimState.animFrameId = null;
    }
    document.getElementById('trim-modal').style.display = 'none';
}

async function loadTrimWaveform(filePath) {
    const canvas = document.getElementById('trim-waveform-canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('trim-timeline-container');

    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;

    // 显示加载中
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⏳ 加载波形中...', canvas.width / 2, canvas.height / 2);

    try {
        const response = await apiFetch(`${API_BASE}/media/waveform`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: filePath, num_peaks: Math.min(600, container.clientWidth) })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);

        trimState.peaks = data.peaks || [];
        if (data.duration && data.duration > 0) {
            trimState.duration = data.duration;
            trimState.outTime = data.duration;
        }
        trimState.viewEnd = trimState.duration;
        drawTrimWaveform();
        updateTrimUI();
        updateTrimTimeRuler();
    } catch (error) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ff4757';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`波形加载失败: ${escapeHtml(error.message)}`, canvas.width / 2, canvas.height / 2);
    }
}

// 将时间转换为可见区域内的百分比 (0-100)
function timeToViewPct(t) {
    const vd = trimState.viewEnd - trimState.viewStart;
    if (vd <= 0) return 0;
    return ((t - trimState.viewStart) / vd) * 100;
}

// 将可见区域内的百分比转换为时间
function viewPctToTime(pct) {
    const vd = trimState.viewEnd - trimState.viewStart;
    return trimState.viewStart + (pct / 100) * vd;
}

function drawTrimWaveform() {
    const canvas = document.getElementById('trim-waveform-canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('trim-timeline-container');
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    const w = canvas.width;
    const h = canvas.height;
    const peaks = trimState.peaks;

    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = 'rgba(30, 32, 40, 0.9)';
    ctx.fillRect(0, 0, w, h);

    if (!peaks.length || trimState.duration <= 0) return;

    const vStart = trimState.viewStart;
    const vEnd = trimState.viewEnd;
    const vDur = vEnd - vStart;
    const mid = h / 2;

    // 根据可见时间窗口绘制波形
    const totalPeaks = peaks.length;
    const startIdx = Math.floor((vStart / trimState.duration) * totalPeaks);
    const endIdx = Math.ceil((vEnd / trimState.duration) * totalPeaks);
    const visiblePeaks = endIdx - startIdx;
    const barWidth = w / Math.max(visiblePeaks, 1);

    for (let i = startIdx; i < endIdx && i < totalPeaks; i++) {
        const barH = peaks[i] * mid * 0.9;
        const x = (i - startIdx) * barWidth;

        const ratio = i / totalPeaks;
        const r = Math.round(46 + ratio * 56);
        const g = Math.round(213 - ratio * 138);
        const b = Math.round(115 + ratio * 47);

        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
        ctx.fillRect(x, mid - barH, Math.max(barWidth - 0.3, 1), barH * 2);
    }

    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // ====== 绘制场景切割点标记 ======
    if (trimState.scenePoints.length > 0) {
        ctx.save();
        trimState.scenePoints.forEach((t, idx) => {
            if (t < vStart || t > vEnd) return; // 只绘制可见范围内的
            const x = ((t - vStart) / vDur) * w;

            // 黄色竖线
            ctx.strokeStyle = 'rgba(255, 215, 0, 0.9)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 2]);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            ctx.setLineDash([]);

            // 顶部三角标记
            ctx.fillStyle = '#ffd700';
            ctx.beginPath();
            ctx.moveTo(x - 5, 0);
            ctx.lineTo(x + 5, 0);
            ctx.lineTo(x, 10);
            ctx.closePath();
            ctx.fill();

            // 切割点编号 + 时间
            ctx.fillStyle = 'rgba(255, 215, 0, 0.95)';
            ctx.font = 'bold 10px sans-serif';
            ctx.textAlign = 'center';
            const yPos = (idx % 2 === 0) ? 22 : h - 4;
            ctx.fillText(`#${idx + 1} ${formatTrimTime(t)}`, x, yPos);
        });
        ctx.restore();
    }

    // ====== 缩放指示器 ======
    if (trimState.zoom > 1.05) {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`🔍 ${trimState.zoom.toFixed(1)}x  [滚轮缩放 / 拖动平移 / 双击复位]`, w - 6, h - 6);
        ctx.restore();
    }
}

function updateTrimUI() {
    const dur = trimState.duration;
    if (dur <= 0) return;

    // 使用可见窗口百分比计算 handle 位置
    const inPct = timeToViewPct(trimState.inTime);
    const outPct = timeToViewPct(trimState.outTime);

    // IN/OUT handle 位置（限制在 0-100 范围内）
    const clampIn = Math.max(-2, Math.min(102, inPct));
    const clampOut = Math.max(-2, Math.min(102, outPct));
    document.getElementById('trim-handle-in').style.left = `${clampIn}%`;
    document.getElementById('trim-handle-out').style.left = `${clampOut}%`;

    // 遮罩
    document.getElementById('trim-mask-left').style.width = `${Math.max(0, clampIn)}%`;
    document.getElementById('trim-mask-right').style.left = `${Math.min(100, clampOut)}%`;
    document.getElementById('trim-mask-right').style.width = `${Math.max(0, 100 - clampOut)}%`;

    // 时间输入框
    document.getElementById('trim-in-time').value = formatTrimTime(trimState.inTime);
    document.getElementById('trim-out-time').value = formatTrimTime(trimState.outTime);
    document.getElementById('trim-total-time').textContent = formatTrimTime(dur);

    // 选区时长
    const selDur = trimState.outTime - trimState.inTime;
    document.getElementById('trim-selection-duration').textContent = formatTrimTime(Math.max(0, selDur));
}

function updateTrimPlayhead() {
    const video = document.getElementById('trim-video-player');
    const dur = trimState.duration;
    if (dur <= 0) return;
    const pct = timeToViewPct(video.currentTime);
    document.getElementById('trim-playhead').style.left = `${Math.max(-1, Math.min(101, pct))}%`;
}

function updateTrimTimeRuler() {
    const ruler = document.getElementById('trim-time-ruler');
    const vStart = trimState.viewStart;
    const vEnd = trimState.viewEnd;
    const vDur = vEnd - vStart;
    const numMarks = 10;
    ruler.innerHTML = '';
    for (let i = 0; i <= numMarks; i++) {
        const t = vStart + (vDur / numMarks) * i;
        const span = document.createElement('span');
        span.textContent = formatTrimTime(t);
        ruler.appendChild(span);
    }
}

function formatTrimTime(s) {
    if (!s || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

function parseTrimTime(str) {
    const parts = str.trim().split(':');
    if (parts.length === 2) {
        return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 3) {
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(str) || 0;
}

// ---- 播放控制 ----
function toggleTrimPlay() {
    const video = document.getElementById('trim-video-player');
    if (video.paused) {
        // 如果播放头超出OUT点，从IN点开始
        if (video.currentTime >= trimState.outTime - 0.05) {
            video.currentTime = trimState.inTime;
        }
        video.play();
        trimState.isPlaying = true;
        document.getElementById('trim-play-btn').textContent = '⏸ 暂停';
        monitorTrimPlayback();
    } else {
        video.pause();
        trimState.isPlaying = false;
        document.getElementById('trim-play-btn').textContent = '▶ 播放';
    }
}

function monitorTrimPlayback() {
    const video = document.getElementById('trim-video-player');
    if (!trimState.isPlaying) return;
    // 到达OUT点自动暂停
    if (video.currentTime >= trimState.outTime - 0.03) {
        video.pause();
        video.currentTime = trimState.outTime;
        trimState.isPlaying = false;
        document.getElementById('trim-play-btn').textContent = '▶ 播放';
        return;
    }
    // 缩放时自动跟随播放头
    if (trimState.zoom > 1.05) {
        const ct = video.currentTime;
        const viewDur = trimState.viewEnd - trimState.viewStart;
        const margin = viewDur * 0.15;
        if (ct > trimState.viewEnd - margin || ct < trimState.viewStart + margin) {
            let newStart = ct - viewDur * 0.3;
            newStart = Math.max(0, Math.min(trimState.duration - viewDur, newStart));
            trimState.viewStart = newStart;
            trimState.viewEnd = newStart + viewDur;
            drawTrimWaveform();
            updateTrimUI();
            updateTrimTimeRuler();
        }
    }
    requestAnimationFrame(monitorTrimPlayback);
}

function trimJumpToIn() {
    document.getElementById('trim-video-player').currentTime = trimState.inTime;
}

function trimJumpToOut() {
    document.getElementById('trim-video-player').currentTime = Math.max(0, trimState.outTime - 0.1);
}

function setTrimSpeed() {
    const speed = parseFloat(document.getElementById('trim-speed').value);
    document.getElementById('trim-video-player').playbackRate = speed;
}

function setTrimInAtCurrent() {
    const t = document.getElementById('trim-video-player').currentTime;
    trimState.inTime = Math.min(t, trimState.outTime - 0.1);
    updateTrimUI();
}

function setTrimOutAtCurrent() {
    const t = document.getElementById('trim-video-player').currentTime;
    trimState.outTime = Math.max(t, trimState.inTime + 0.1);
    updateTrimUI();
}

function onTrimTimeInputChange(which) {
    if (which === 'in') {
        const t = parseTrimTime(document.getElementById('trim-in-time').value);
        trimState.inTime = Math.max(0, Math.min(t, trimState.outTime - 0.1));
    } else {
        const t = parseTrimTime(document.getElementById('trim-out-time').value);
        trimState.outTime = Math.min(trimState.duration, Math.max(t, trimState.inTime + 0.1));
    }
    updateTrimUI();
}

// ---- IN/OUT 手柄 + 播放头拖动 ----
function setupTrimDragHandles() {
    const container = document.getElementById('trim-timeline-container');
    const handleIn = document.getElementById('trim-handle-in');
    const handleOut = document.getElementById('trim-handle-out');
    const playhead = document.getElementById('trim-playhead');

    const startDrag = (which) => (e) => {
        e.preventDefault();
        e.stopPropagation();
        trimState.dragging = which;
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
    };

    handleIn.addEventListener('mousedown', startDrag('in'));
    handleOut.addEventListener('mousedown', startDrag('out'));
    playhead.addEventListener('mousedown', startDrag('playhead'));

    function onDragMove(e) {
        if (!trimState.dragging) return;
        const rect = container.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const t = viewPctToTime(pct * 100);

        if (trimState.dragging === 'in') {
            trimState.inTime = Math.max(0, Math.min(t, trimState.outTime - 0.1));
        } else if (trimState.dragging === 'out') {
            trimState.outTime = Math.min(trimState.duration, Math.max(t, trimState.inTime + 0.1));
        } else if (trimState.dragging === 'playhead') {
            // 拖动播放头 = 实时 scrub
            document.getElementById('trim-video-player').currentTime = Math.max(0, Math.min(trimState.duration, t));
            updateTrimPlayhead();
            return;
        }

        updateTrimUI();
        document.getElementById('trim-video-player').currentTime = t;
    }

    function onDragEnd() {
        trimState.dragging = null;
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
    }
}

// ---- 时间轴点击跳转 ----
function setupTrimTimelineClick() {
    const container = document.getElementById('trim-timeline-container');
    // 点击跳转（通过 mousedown/up 距离判断，避免和拖动平移冲突）
    let clickStartX = 0;
    let clickStartY = 0;
    container.addEventListener('mousedown', (e) => {
        if (e.target.closest('.trim-handle')) return;
        clickStartX = e.clientX;
        clickStartY = e.clientY;
    });
    container.addEventListener('mouseup', (e) => {
        if (trimState.dragging) return;
        if (trimState._panning) return; // 刚拖动完不触发click
        if (e.target.closest('.trim-handle')) return;
        const dx = Math.abs(e.clientX - clickStartX);
        const dy = Math.abs(e.clientY - clickStartY);
        if (dx > 4 || dy > 4) return; // 移动超过4px认为是拖动而不是点击
        const rect = container.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        const t = viewPctToTime(pct * 100);
        document.getElementById('trim-video-player').currentTime = t;
    });
}

// ---- 导出裁切 ----
async function executeTrim() {
    const statusEl = document.getElementById('trim-export-status');
    const inT = trimState.inTime;
    const outT = trimState.outTime;
    const precise = document.getElementById('trim-precise-mode')?.checked ?? true;

    if (outT - inT < 0.1) {
        showToast('选区时长太短', 'error');
        return;
    }

    const modeText = precise ? '精确模式（重编码，可能较慢）' : '快速模式';
    statusEl.textContent = `⏳ 正在裁切（${modeText}）...`;
    statusEl.style.color = 'var(--accent)';

    try {
        const outputDir = document.getElementById('media-output-path')?.value || '';
        const response = await apiFetch(`${API_BASE}/media/trim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: trimState.filePath,
                start: inT,
                end: outT,
                output_dir: outputDir,
                precise: precise
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '裁切失败');

        statusEl.textContent = `✅ ${data.message} (${data.mode || ''})`;
        statusEl.style.color = 'var(--success)';
        showToast(data.message, 'success');
    } catch (error) {
        statusEl.textContent = `❌ ${escapeHtml(error.message)}`;
        statusEl.style.color = 'var(--error)';
        showToast(`裁切失败: ${escapeHtml(error.message)}`, 'error');
    }
}

// ---- 预览选区：从IN播放到OUT自动停止 ----
function previewTrimSelection() {
    const video = document.getElementById('trim-video-player');
    video.currentTime = trimState.inTime;
    video.play();
    trimState.isPlaying = true;
    document.getElementById('trim-play-btn').textContent = '⏸ 暂停';
    monitorTrimPlayback();
}

// ---- 逐帧步进 ----
function trimStepFrame(direction) {
    const video = document.getElementById('trim-video-player');
    video.pause();
    trimState.isPlaying = false;
    document.getElementById('trim-play-btn').textContent = '▶ 播放';

    // 估算帧时长（默认30fps）
    // 如果有检测结果则使用实际fps
    let fps = 30;
    const fileResult = sceneResults[trimState.filePath];
    if (fileResult && fileResult.fps) {
        fps = fileResult.fps;
    }
    const frameDuration = 1 / fps;
    video.currentTime = Math.max(0, Math.min(trimState.duration, video.currentTime + direction * frameDuration));
}

// ---- 波形缩放 + 拖动平移 ----
function setupTrimZoom() {
    const container = document.getElementById('trim-timeline-container');
    trimState._panning = false;
    trimState._panStartX = 0;
    trimState._panStartViewStart = 0;

    // 滚轮 = 缩放（以鼠标位置为中心）
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mousePct = (e.clientX - rect.left) / rect.width;
        const mouseTime = viewPctToTime(mousePct * 100);

        const factor = e.deltaY > 0 ? 0.85 : 1.2;
        trimState.zoom = Math.max(1, Math.min(100, trimState.zoom * factor));

        const newViewDur = trimState.duration / trimState.zoom;
        let newStart = mouseTime - mousePct * newViewDur;
        newStart = Math.max(0, Math.min(trimState.duration - newViewDur, newStart));
        trimState.viewStart = newStart;
        trimState.viewEnd = Math.min(trimState.duration, newStart + newViewDur);

        drawTrimWaveform();
        updateTrimUI();
        updateTrimPlayhead();
        updateTrimTimeRuler();
    }, { passive: false });

    // 拖动平移（缩放后拖动超过4px才开始平移，单击仍可定位）
    container.addEventListener('mousedown', (e) => {
        if (trimState.zoom <= 1.05) return;
        if (e.target.closest('.trim-handle')) return;
        if (trimState.dragging) return;

        // 不立刻进入平移，先记录起点
        trimState._panning = false;
        trimState._panStartX = e.clientX;
        trimState._panStartViewStart = trimState.viewStart;
        let panActivated = false;

        const onPanMove = (ev) => {
            const dx = ev.clientX - trimState._panStartX;
            // 移动超过4px才激活平移
            if (!panActivated && Math.abs(dx) > 4) {
                panActivated = true;
                trimState._panning = true;
                container.style.cursor = 'grabbing';
            }
            if (!panActivated) return;

            const rect = container.getBoundingClientRect();
            const viewDur = trimState.viewEnd - trimState.viewStart;
            const timeDelta = -(dx / rect.width) * viewDur;
            let newStart = trimState._panStartViewStart + timeDelta;
            newStart = Math.max(0, Math.min(trimState.duration - viewDur, newStart));
            trimState.viewStart = newStart;
            trimState.viewEnd = newStart + viewDur;

            drawTrimWaveform();
            updateTrimUI();
            updateTrimPlayhead();
            updateTrimTimeRuler();
        };

        const onPanEnd = () => {
            container.style.cursor = 'pointer';
            if (panActivated) {
                // 延迟重置平移标志，避免触发click
                setTimeout(() => { trimState._panning = false; }, 50);
            }
            document.removeEventListener('mousemove', onPanMove);
            document.removeEventListener('mouseup', onPanEnd);
        };

        document.addEventListener('mousemove', onPanMove);
        document.addEventListener('mouseup', onPanEnd);
    });

    // 双击复位缩放
    container.addEventListener('dblclick', (e) => {
        if (e.target.closest('.trim-handle')) return;
        trimState.zoom = 1;
        trimState.viewStart = 0;
        trimState.viewEnd = trimState.duration;
        drawTrimWaveform();
        updateTrimUI();
        updateTrimPlayhead();
        updateTrimTimeRuler();
    });
}

function trimZoomIn() {
    const center = (trimState.viewStart + trimState.viewEnd) / 2;
    trimState.zoom = Math.min(100, trimState.zoom * 1.5);
    const newViewDur = trimState.duration / trimState.zoom;
    trimState.viewStart = Math.max(0, center - newViewDur / 2);
    trimState.viewEnd = Math.min(trimState.duration, trimState.viewStart + newViewDur);
    drawTrimWaveform();
    updateTrimUI();
    updateTrimPlayhead();
    updateTrimTimeRuler();
}

function trimZoomOut() {
    const center = (trimState.viewStart + trimState.viewEnd) / 2;
    trimState.zoom = Math.max(1, trimState.zoom / 1.5);
    const newViewDur = trimState.duration / trimState.zoom;
    trimState.viewStart = Math.max(0, center - newViewDur / 2);
    trimState.viewEnd = Math.min(trimState.duration, trimState.viewStart + newViewDur);
    if (trimState.zoom <= 1.01) {
        trimState.viewStart = 0;
        trimState.viewEnd = trimState.duration;
    }
    drawTrimWaveform();
    updateTrimUI();
    updateTrimPlayhead();
    updateTrimTimeRuler();
}

function trimZoomReset() {
    trimState.zoom = 1;
    trimState.viewStart = 0;
    trimState.viewEnd = trimState.duration;
    drawTrimWaveform();
    updateTrimUI();
    updateTrimPlayhead();
    updateTrimTimeRuler();
}

// 缩放到当前播放头位置
function trimZoomToPlayhead() {
    const ct = document.getElementById('trim-video-player').currentTime;
    trimState.zoom = Math.min(100, trimState.zoom * 2);
    const newViewDur = trimState.duration / trimState.zoom;
    trimState.viewStart = Math.max(0, ct - newViewDur / 2);
    trimState.viewEnd = Math.min(trimState.duration, trimState.viewStart + newViewDur);
    drawTrimWaveform();
    updateTrimUI();
    updateTrimPlayhead();
    updateTrimTimeRuler();
}

// ESC 关闭裁切弹窗 + 快捷键
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('trim-modal').style.display === 'flex') {
        closeTrimModal();
    }
    if (document.getElementById('trim-modal').style.display === 'flex') {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            trimStepFrame(-1);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            trimStepFrame(1);
        } else if (e.key === ' ') {
            e.preventDefault();
            toggleTrimPlay();
        } else if (e.key === 'i' || e.key === 'I') {
            setTrimInAtCurrent();
        } else if (e.key === 'o' || e.key === 'O') {
            setTrimOutAtCurrent();
        } else if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            trimZoomIn();
        } else if (e.key === '-') {
            e.preventDefault();
            trimZoomOut();
        } else if (e.key === '0') {
            e.preventDefault();
            trimZoomReset();
        }
    }
});


// ==================== 批量视频截图功能 ====================

let thumbnailPollingTimer = null;

async function selectThumbnailFolder() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('thumbnail-folder-path').value = dir;
            // 默认输出目录设为 _thumbnails 子目录
            if (!document.getElementById('thumbnail-output-path').value) {
                document.getElementById('thumbnail-output-path').value = dir + '/_thumbnails';
            }
        }
    } catch (error) {
        // 浏览器环境下手动输入
        console.log('请手动输入文件夹路径');
    }
}

async function selectThumbnailOutputDir() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('thumbnail-output-path').value = dir;
        }
    } catch (error) {
        console.log('请手动输入输出目录路径');
    }
}

async function startBatchThumbnail() {
    const folderPath = document.getElementById('thumbnail-folder-path').value.trim();
    if (!folderPath) {
        showToast('请先选择视频文件夹', 'error');
        return;
    }

    const outputDir = document.getElementById('thumbnail-output-path').value.trim();
    const format = document.getElementById('thumbnail-format').value;
    const quality = parseInt(document.getElementById('thumbnail-quality').value);
    const mode = document.getElementById('thumbnail-mode')?.value || 'first';

    const statusEl = document.getElementById('thumbnail-status');
    const startBtn = document.getElementById('thumbnail-start-btn');
    const progressSection = document.getElementById('thumbnail-progress-section');
    const progressText = document.getElementById('thumbnail-progress-text');
    const progressBar = document.querySelector('#thumbnail-progress-bar .progress-bar-inner');
    const resultSection = document.getElementById('thumbnail-result-section');

    // 重置 UI
    statusEl.textContent = '处理中...';
    startBtn.disabled = true;
    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '正在扫描视频文件...';

    // 启动进度轮询
    thumbnailPollingTimer = setInterval(async () => {
        try {
            const resp = await apiFetch(`${API_BASE}/media/batch-thumbnail-progress`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    folder_path: folderPath,
                    output_dir: outputDir || ''
                })
            });
            const progress = await resp.json();
            if (progress.total > 0) {
                progressBar.style.width = progress.percent + '%';
                progressText.textContent = `已完成 ${progress.done}/${progress.total} (${progress.percent}%)`;
            }
        } catch (e) {
            // 忽略轮询错误
        }
    }, 2000);

    try {
        const response = await apiFetch(`${API_BASE}/media/batch-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folder_path: folderPath,
                output_dir: outputDir,
                format: format,
                quality: quality,
                mode: mode
            })
        });

        const result = await response.json();

        // 停止轮询
        if (thumbnailPollingTimer) {
            clearInterval(thumbnailPollingTimer);
            thumbnailPollingTimer = null;
        }

        if (response.ok) {
            progressBar.style.width = '100%';
            progressText.textContent = '完成!';
            statusEl.textContent = `✅ 完成: ${result.success} 成功, ${result.failed} 失败`;
            showToast(result.message, 'success', 8000);

            // 显示结果
            displayThumbnailResults(result);
        } else {
            statusEl.textContent = '❌ 失败';
            progressText.textContent = '处理失败';
            showToast('错误: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        if (thumbnailPollingTimer) {
            clearInterval(thumbnailPollingTimer);
            thumbnailPollingTimer = null;
        }
        statusEl.textContent = '❌ 请求失败';
        progressText.textContent = '请求失败';
        showToast('请求失败: ' + error.message, 'error');
    } finally {
        startBtn.disabled = false;
    }
}

// ========== 批量截图 - 模式切换 ==========
function switchThumbnailMode(mode) {
    const folderMode = document.getElementById('thumb-folder-mode');
    const urlMode = document.getElementById('thumb-url-mode');
    const folderBtn = document.getElementById('thumb-mode-folder-btn');
    const urlBtn = document.getElementById('thumb-mode-url-btn');

    if (mode === 'url') {
        folderMode.style.display = 'none';
        urlMode.style.display = 'block';
        folderBtn.classList.remove('active');
        urlBtn.classList.add('active');
    } else {
        folderMode.style.display = 'block';
        urlMode.style.display = 'none';
        urlBtn.classList.remove('active');
        folderBtn.classList.add('active');
    }
}

// 链接数量计数
document.addEventListener('DOMContentLoaded', () => {
    const ta = document.getElementById('url-thumb-links');
    if (ta) {
        ta.addEventListener('input', () => {
            const lines = ta.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const countEl = document.getElementById('url-thumb-count');
            if (countEl) countEl.textContent = lines.length > 0 ? `${lines.length} 条链接` : '';
        });
    }
});

// 选择链接截图输出目录
async function selectUrlThumbnailOutputDir() {
    try {
        const result = await apiFetch(`${API_BASE}/file/select-folder`, { method: 'POST' });
        const data = await result.json();
        if (data?.path) document.getElementById('url-thumb-output-path').value = data.path;
    } catch {
        const path = await window.electronAPI?.selectFolder?.();
        if (path) document.getElementById('url-thumb-output-path').value = path;
    }
}

// 打开链接截图输出目录
async function openUrlThumbnailOutputDir() {
    const outPath = document.getElementById('url-thumb-output-path').value.trim()
        || (window.electronAPI?.joinPath?.(window.electronAPI?.getHomeDir?.(), 'Downloads', 'url_thumbnails'));
    if (outPath) {
        await apiFetch(`${API_BASE}/file/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: outPath })
        }).catch(() => {});
    }
}

// 注册 IPC 进度事件（在 Electron 环境下）
let _urlThumbProgressRegistered = false;
function registerUrlThumbnailProgress() {
    if (_urlThumbProgressRegistered) return;
    if (window.electronAPI?.onUrlThumbnailProgress) {
        window.electronAPI.onUrlThumbnailProgress((event, data) => {
            updateUrlThumbnailItem(data);
        });
        _urlThumbProgressRegistered = true;
    }
}

let _urlThumbOutputDir = '';

// 开始链接截图
async function startUrlThumbnail() {
    const ta = document.getElementById('url-thumb-links');
    const urls = (ta.value || '').split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (urls.length === 0) {
        showToast('请输入至少一条视频链接', 'error');
        return;
    }

    const outputDir = document.getElementById('url-thumb-output-path').value.trim();
    const mode = document.getElementById('url-thumb-mode').value;
    const format = document.getElementById('url-thumb-format').value;

    const startBtn = document.getElementById('url-thumb-start-btn');
    const statusEl = document.getElementById('url-thumb-status');
    const progressList = document.getElementById('url-thumb-progress-list');
    const itemsContainer = document.getElementById('url-thumb-items');
    const resultSection = document.getElementById('url-thumb-result-section');

    // 重置 UI
    startBtn.disabled = true;
    statusEl.textContent = '处理中...';
    resultSection.classList.add('hidden');
    progressList.style.display = 'block';
    itemsContainer.innerHTML = '';

    // 初始化进度条目
    urls.forEach((url, i) => {
        const shortUrl = url.length > 60 ? url.substring(0, 57) + '...' : url;
        itemsContainer.innerHTML += `
            <div id="url-thumb-item-${i}" style="display:flex; align-items:center; gap:10px; padding:8px 12px;
                background:var(--bg-tertiary); border-radius:8px; font-size:13px;">
                <span id="url-thumb-icon-${i}" style="font-size:16px;">⏳</span>
                <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary);"
                    title="${escapeHtml(url)}">${escapeHtml(shortUrl)}</span>
                <span id="url-thumb-state-${i}" style="font-size:12px; color:var(--text-muted); white-space:nowrap;">等待中</span>
            </div>`;
    });

    // 注册进度监听
    registerUrlThumbnailProgress();

    try {
        const response = await apiFetch(`${API_BASE}/media/url-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls, output_dir: outputDir, mode, format })
        });
        const result = await response.json();
        _urlThumbOutputDir = result.output_dir || '';

        if (response.ok) {
            statusEl.textContent = `✅ ${result.message}`;
            showToast(result.message, 'success', 6000);
            displayUrlThumbnailResults(result);
        } else {
            statusEl.textContent = '❌ 失败';
            showToast('错误: ' + (result.error || '未知错误'), 'error');
        }
    } catch (e) {
        statusEl.textContent = '❌ 请求失败';
        showToast('请求失败: ' + e.message, 'error');
    } finally {
        startBtn.disabled = false;
    }
}

// 更新单条链接的进度状态
function updateUrlThumbnailItem(data) {
    const { index, status, url } = data;
    const iconEl = document.getElementById(`url-thumb-icon-${index}`);
    const stateEl = document.getElementById(`url-thumb-state-${index}`);
    if (!iconEl || !stateEl) return;

    const statusMap = {
        downloading:   { icon: '⬇️', text: '下载中...', color: '#74c0fc' },
        screenshotting:{ icon: '📸', text: '截图中...', color: '#ffa94d' },
        done:          { icon: '✅', text: '完成',      color: '#51cf66' },
        error:         { icon: '❌', text: '失败',      color: '#f87171' },
    };
    const s = statusMap[status] || { icon: '⏳', text: status, color: 'var(--text-muted)' };
    iconEl.textContent = s.icon;
    stateEl.textContent = s.text;
    stateEl.style.color = s.color;
}

// 展示最终结果
function displayUrlThumbnailResults(result) {
    const resultSection = document.getElementById('url-thumb-result-section');
    const summaryEl = document.getElementById('url-thumb-result-summary');
    const gridEl = document.getElementById('url-thumb-result-grid');

    resultSection.classList.remove('hidden');

    const total = result.results.length;
    const success = result.success || result.results.filter(r => r.success).length;
    const failed = total - success;
    const escapedDir = escapeHtml(result.output_dir || '');

    summaryEl.innerHTML = `
        <div style="display:flex; gap:24px; flex-wrap:wrap; align-items:center;">
            <div style="display:flex; flex-direction:column; align-items:center;">
                <span style="font-size:22px; font-weight:700; color:var(--accent);">${total}</span>
                <span style="font-size:11px; color:var(--text-muted);">总计</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:center;">
                <span style="font-size:22px; font-weight:700; color:#51cf66;">${success}</span>
                <span style="font-size:11px; color:var(--text-muted);">成功</span>
            </div>
            <div style="display:flex; flex-direction:column; align-items:center;">
                <span style="font-size:22px; font-weight:700; color:#f87171;">${failed}</span>
                <span style="font-size:11px; color:var(--text-muted);">失败</span>
            </div>
            <div style="flex:1; font-size:12px; color:var(--text-muted); word-break:break-all;">📁 ${escapedDir}</div>
        </div>`;

    // 图片网格（成功项目）
    gridEl.innerHTML = '';
    for (const r of result.results) {
        if (!r.success) {
            gridEl.innerHTML += `
                <div style="border-radius:8px; overflow:hidden; background:var(--bg-tertiary); padding:8px;
                    border:1px solid var(--border-color); display:flex; flex-direction:column; gap:4px;">
                    <div style="font-size:20px; text-align:center;">❌</div>
                    <div style="font-size:10px; color:#f87171; word-break:break-all; line-height:1.3;">${escapeHtml(r.error || '失败')}</div>
                </div>`;
        } else {
            // 在 Electron 中使用 file:// 协议显示图片
            const imgSrc = (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function')
                ? window.electronAPI.toFileUrl(r.output)
                : '';
            const fileName = r.output.split('/').pop();
            gridEl.innerHTML += `
                <div style="border-radius:8px; overflow:hidden; background:var(--bg-tertiary);
                    border:1px solid var(--border-color); cursor:pointer;"
                    onclick="window.electronAPI?.showItemInFolder?.('${r.output.replace(/'/g, "\\'")}')">
                    ${imgSrc ? `<img src="${imgSrc}" style="width:100%; aspect-ratio:16/9; object-fit:cover; display:block;" onerror="this.style.display='none'">` : ''}
                    <div style="padding:6px 8px; font-size:11px; color:var(--text-secondary); overflow:hidden;
                        text-overflow:ellipsis; white-space:nowrap; title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
                </div>`;
        }
    }
}

function displayThumbnailResults(result) {
    const resultSection = document.getElementById('thumbnail-result-section');
    const summaryEl = document.getElementById('thumbnail-result-summary');
    const errorsEl = document.getElementById('thumbnail-result-errors');

    resultSection.classList.remove('hidden');

    // 汇总信息
    const escapedDir = escapeHtml(result.output_dir).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    summaryEl.innerHTML = `
        <div style="display: flex; gap: 24px; flex-wrap: wrap; align-items: center;">
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: var(--accent);">${result.total}</span>
                <span style="font-size: 12px; color: var(--text-muted);">总计</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: #51cf66;">${result.success}</span>
                <span style="font-size: 12px; color: var(--text-muted);">成功</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: ${result.failed > 0 ? '#f87171' : 'var(--text-muted)'};">${result.failed}</span>
                <span style="font-size: 12px; color: var(--text-muted);">失败</span>
            </div>
            <div style="flex: 1; text-align: right;">
                <span style="font-size: 12px; color: var(--text-muted);">输出目录:</span>
                <a href="#" onclick="openFolderPath('${escapedDir}'); return false;"
                   style="font-size: 12px; color: var(--accent); text-decoration: none; word-break: break-all;">
                    ${result.output_dir}
                </a>
            </div>
        </div>
    `;

    // 显示错误列表
    errorsEl.innerHTML = '';
    if (result.results) {
        const errors = result.results.filter(r => r.status === 'error' || r.status === 'timeout');
        if (errors.length > 0) {
            const errorTitle = document.createElement('h5');
            errorTitle.style.cssText = 'color: #f87171; margin-bottom: 8px;';
            errorTitle.textContent = `⚠️ 失败文件 (${errors.length}):`;
            errorsEl.appendChild(errorTitle);

            errors.forEach(err => {
                const item = document.createElement('div');
                item.style.cssText = 'padding: 4px 8px; font-size: 12px; color: var(--text-secondary); border-bottom: 1px solid rgba(255,255,255,0.05);';
                item.textContent = `${err.file} — ${err.status === 'timeout' ? '超时' : (err.error || '未知错误')}`;
                errorsEl.appendChild(item);
            });
        }
    }
}

async function openThumbnailOutputDir() {
    const folderPath = document.getElementById('thumbnail-folder-path').value.trim();
    const outputDir = document.getElementById('thumbnail-output-path').value.trim() || (folderPath ? folderPath + '/_thumbnails' : '');

    if (!outputDir) {
        showToast('请先设置视频文件夹或输出目录', 'error');
        return;
    }

    try {
        await apiFetch(`${API_BASE}/file/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: outputDir })
        });
    } catch (error) {
        showToast('打开目录失败', 'error');
    }
}

async function openFolderPath(folderPath) {
    try {
        await apiFetch(`${API_BASE}/file/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
        });
    } catch (error) {
        showToast('打开目录失败', 'error');
    }
}


// ==================== 画面分类功能（感知哈希聚类） ====================

async function selectClassifyFolder() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('classify-folder-path').value = dir;
            if (!document.getElementById('classify-output-path').value) {
                document.getElementById('classify-output-path').value = dir + '/_classified';
            }
        }
    } catch (error) {
        console.log('请手动输入文件夹路径');
    }
}

async function selectClassifyOutputDir() {
    try {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            document.getElementById('classify-output-path').value = dir;
        }
    } catch (error) {
        console.log('请手动输入输出目录路径');
    }
}

async function startImageClassify() {
    const folderPath = document.getElementById('classify-folder-path').value.trim();
    if (!folderPath) {
        showToast('请先选择文件夹', 'error');
        return;
    }

    const outputDir = document.getElementById('classify-output-path').value.trim();
    const threshold = parseInt(document.getElementById('classify-threshold').value);
    const action = document.getElementById('classify-action').value;
    const minGroupSize = parseInt(document.getElementById('classify-min-group').value) || 2;

    const statusEl = document.getElementById('classify-status');
    const startBtn = document.getElementById('classify-start-btn');
    const progressSection = document.getElementById('classify-progress-section');
    const progressText = document.getElementById('classify-progress-text');
    const progressBar = document.querySelector('#classify-progress-bar .progress-bar-inner');
    const resultSection = document.getElementById('classify-result-section');

    // 重置 UI
    statusEl.textContent = '处理中...';
    startBtn.disabled = true;
    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '正在扫描文件并计算哈希...（大量文件时可能需要几分钟）';

    // 不定进度动画
    let progressAnim = 0;
    const animTimer = setInterval(() => {
        progressAnim = (progressAnim + 2) % 90;
        progressBar.style.width = (10 + progressAnim) + '%';
    }, 500);

    try {
        const response = await apiFetch(`${API_BASE}/media/image-classify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                folder_path: folderPath,
                output_dir: outputDir,
                threshold: threshold,
                action: action,
                min_group_size: minGroupSize
            })
        });

        clearInterval(animTimer);
        const result = await response.json();

        if (response.ok) {
            progressBar.style.width = '100%';
            progressText.textContent = '完成!';
            statusEl.textContent = `✅ ${result.message}`;
            showToast(result.message, 'success', 8000);

            displayClassifyResults(result);
        } else {
            statusEl.textContent = '❌ 失败';
            progressText.textContent = '处理失败';
            showToast('错误: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        clearInterval(animTimer);
        statusEl.textContent = '❌ 请求失败';
        progressText.textContent = '请求失败';
        showToast('请求失败: ' + error.message, 'error');
    } finally {
        startBtn.disabled = false;
    }
}

function displayClassifyResults(result) {
    const resultSection = document.getElementById('classify-result-section');
    const summaryEl = document.getElementById('classify-result-summary');
    const groupsEl = document.getElementById('classify-result-groups');

    resultSection.classList.remove('hidden');

    const escapedDir = escapeHtml(result.output_dir).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    summaryEl.innerHTML = `
        <div style="display: flex; gap: 20px; flex-wrap: wrap; align-items: center;">
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: var(--accent);">${result.total_files}</span>
                <span style="font-size: 11px; color: var(--text-muted);">总文件</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: #51cf66;">${result.total_groups}</span>
                <span style="font-size: 11px; color: var(--text-muted);">分组数</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: #ffd43b;">${result.large_groups}</span>
                <span style="font-size: 11px; color: var(--text-muted);">多文件组</span>
            </div>
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: var(--text-muted);">${result.single_files}</span>
                <span style="font-size: 11px; color: var(--text-muted);">独立文件</span>
            </div>
            ${result.hash_errors > 0 ? `
            <div style="display: flex; flex-direction: column; align-items: center;">
                <span style="font-size: 24px; font-weight: 600; color: #f87171;">${result.hash_errors}</span>
                <span style="font-size: 11px; color: var(--text-muted);">哈希失败</span>
            </div>` : ''}
            <div style="flex: 1; text-align: right;">
                <span style="font-size: 12px; color: var(--text-muted);">阈值: ${result.threshold} | 输出:</span>
                <a href="#" onclick="openFolderPath('${escapedDir}'); return false;"
                   style="font-size: 12px; color: var(--accent); text-decoration: none; word-break: break-all;">
                    ${result.output_dir}
                </a>
            </div>
        </div>
    `;

    // 显示分组列表
    groupsEl.innerHTML = '';
    if (result.groups && result.groups.length > 0) {
        result.groups.forEach(group => {
            const card = document.createElement('div');
            card.style.cssText = 'padding: 10px 14px; margin-bottom: 6px; background: rgba(255,255,255,0.03); border-radius: 6px; border-left: 3px solid ' +
                (group.count >= 10 ? '#f87171' : group.count >= 5 ? '#ffd43b' : '#51cf66') + ';';

            const header = document.createElement('div');
            header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;';
            header.innerHTML = `
                <span style="font-weight: 500; color: var(--text-primary);">📁 ${group.folder}</span>
                <span style="font-size: 12px; color: var(--text-muted); background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 10px;">${group.count} 个文件</span>
            `;
            card.appendChild(header);

            if (group.sample_files && group.sample_files.length > 0) {
                const samples = document.createElement('div');
                samples.style.cssText = 'font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                samples.textContent = group.sample_files.join(', ') + (group.count > 5 ? ' ...' : '');
                card.appendChild(samples);
            }

            groupsEl.appendChild(card);
        });

        if (result.groups.length >= 100) {
            const more = document.createElement('div');
            more.style.cssText = 'text-align: center; padding: 8px; color: var(--text-muted); font-size: 12px;';
            more.textContent = '（仅显示前 100 组，完整结果请查看输出目录）';
            groupsEl.appendChild(more);
        }
    }
}

async function openClassifyOutputDir() {
    const folderPath = document.getElementById('classify-folder-path').value.trim();
    const outputDir = document.getElementById('classify-output-path').value.trim() || (folderPath ? folderPath + '/_classified' : '');

    if (!outputDir) {
        showToast('请先设置文件夹或输出目录', 'error');
        return;
    }

    try {
        await apiFetch(`${API_BASE}/file/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: outputDir })
        });
    } catch (error) {
        showToast('打开目录失败', 'error');
    }
}


// ==================== Wav2Lip 口型同步 ====================

// 文件选择绑定
document.addEventListener('DOMContentLoaded', () => {
    const faceInput = document.getElementById('lipsync-face-input');
    const audioInput = document.getElementById('lipsync-audio-input');

    if (faceInput) {
        faceInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) document.getElementById('lipsync-face-path').value = getFileNativePath(file);
        });
    }

    if (audioInput) {
        audioInput.addEventListener('change', e => {
            const file = e.target.files[0];
            if (file) document.getElementById('lipsync-audio-path').value = getFileNativePath(file);
        });
    }
});

/**
 * 检查 Wav2Lip 环境
 */
async function checkLipSyncEnv() {
    const statusEl = document.getElementById('lipsync-env-status');
    const detailEl = document.getElementById('lipsync-env-detail');

    statusEl.textContent = '🔍 检测环境中...';
    statusEl.style.color = 'var(--text-muted)';

    try {
        const resp = await apiFetch(`${API_BASE}/wav2lip/check`, { method: 'POST' });
        const result = await resp.json();

        if (result.available) {
            statusEl.textContent = `✅ 环境就绪 | 设备: ${result.device?.toUpperCase() || 'CPU'} | PyTorch: ${result.pytorch || '?'}`;
            statusEl.style.color = '#4ade80';

            // 显示详细信息
            const deps = result.dependencies || {};
            const depsStr = Object.entries(deps)
                .map(([k, v]) => `${v ? '✅' : '❌'} ${k}`)
                .join('  ');
            detailEl.innerHTML = `
                <div>Python: ${result.python || '?'} | MPS: ${result.mps_available ? '✅' : '❌'} | CUDA: ${result.cuda_available ? '✅' : '❌'}</div>
                <div>模型: ${result.model_exists ? `✅ (${result.model_size_mb}MB)` : '❌ 未下载'}</div>
                <div>依赖: ${depsStr}</div>
            `;
            detailEl.style.display = 'block';
        } else {
            statusEl.textContent = `❌ 环境未就绪`;
            statusEl.style.color = '#f87171';
            detailEl.innerHTML = `<div>错误: ${result.error || '未知'}</div>
                <div>Python: ${result.python_path || '?'}</div>
                <div style="margin-top:6px;color:#ffcc44;">
                    请安装: pip3 install torch torchvision opencv-python librosa scipy face-alignment
                </div>`;
            detailEl.style.display = 'block';
        }
    } catch (error) {
        statusEl.textContent = `❌ 检测失败: ${escapeHtml(error.message)}`;
        statusEl.style.color = '#f87171';
        detailEl.style.display = 'none';
    }
}

/**
 * 开始口型同步
 */
async function startLipSync() {
    const facePath = document.getElementById('lipsync-face-path').value.trim();
    const audioPath = document.getElementById('lipsync-audio-path').value.trim();

    if (!facePath) {
        showToast('请选择人脸视频/图片', 'error');
        return;
    }
    if (!audioPath) {
        showToast('请选择驱动音频', 'error');
        return;
    }

    const pads = [
        parseInt(document.getElementById('lipsync-pad-top').value) || 0,
        parseInt(document.getElementById('lipsync-pad-bottom').value) || 10,
        parseInt(document.getElementById('lipsync-pad-left').value) || 0,
        parseInt(document.getElementById('lipsync-pad-right').value) || 0,
    ];
    const resizeFactor = parseInt(document.getElementById('lipsync-resize').value) || 1;
    const batchSize = parseInt(document.getElementById('lipsync-batch').value) || 32;

    const startBtn = document.getElementById('lipsync-start-btn');
    const statusEl = document.getElementById('lipsync-status');
    const progressSection = document.getElementById('lipsync-progress-section');
    const progressText = document.getElementById('lipsync-progress-text');
    const progressBarInner = progressSection?.querySelector('.progress-bar-inner');
    const resultSection = document.getElementById('lipsync-result-section');

    startBtn.disabled = true;
    startBtn.textContent = '⏳ 处理中...';
    statusEl.textContent = '正在启动...';
    statusEl.style.color = 'var(--text-muted)';
    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    if (progressBarInner) progressBarInner.style.width = '0%';

    // 监听实时进度事件
    if (window.electronAPI && window.electronAPI.onWav2LipProgress) {
        window.electronAPI.onWav2LipProgress((data) => {
            if (progressBarInner) progressBarInner.style.width = `${data.percent || 0}%`;
            if (progressText) progressText.textContent = data.message || `${data.percent}%`;
            if (statusEl) {
                statusEl.textContent = `⏳ ${data.message || '处理中...'}`;
                statusEl.style.color = '#60a5fa';
            }
        });
    }

    try {
        const resp = await apiFetch(`${API_BASE}/wav2lip/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                face_path: facePath,
                audio_path: audioPath,
                pads: pads,
                resize_factor: resizeFactor,
                batch_size: batchSize,
            }),
        });

        const result = await resp.json();

        if (resp.ok && result.output_path) {
            // 成功
            if (progressBarInner) progressBarInner.style.width = '100%';
            progressText.textContent = '✅ 完成!';
            statusEl.textContent = '✅ 口型同步完成';
            statusEl.style.color = '#4ade80';

            resultSection.classList.remove('hidden');
            const detailEl = document.getElementById('lipsync-result-detail');
            detailEl.innerHTML = `
                <div>📁 输出: <strong>${result.output_path}</strong></div>
                <div>🎬 帧数: ${result.frames || '?'} | 时长: ${result.duration || '?'}s</div>
                <div>⏱️ 处理耗时: ${result.processing_time || '?'}s | 文件大小: ${result.file_size_mb || '?'} MB</div>
                <div>📱 设备: ${(result.device || 'cpu').toUpperCase()}</div>
            `;

            showToast('🗣️ 口型同步完成!', 'success');
        } else {
            throw new Error(result.error || '处理失败');
        }
    } catch (error) {
        statusEl.textContent = `❌ ${escapeHtml(error.message)}`;
        statusEl.style.color = '#f87171';
        progressText.textContent = `❌ 失败: ${escapeHtml(error.message)}`;
        showToast(`口型同步失败: ${escapeHtml(error.message)}`, 'error');
    } finally {
        startBtn.disabled = false;
        startBtn.textContent = '🗣️ 开始口型同步';
    }
}

// 页面切换到口型同步标签时自动检测
const origSubTabHandler = document.querySelector('[data-subtab="media-lipsync"]');
if (origSubTabHandler) {
    origSubTabHandler.addEventListener('click', () => {
        // 首次切换时自动检测环境
        const statusEl = document.getElementById('lipsync-env-status');
        if (statusEl && statusEl.textContent.includes('检测环境中')) {
            setTimeout(checkLipSyncEnv, 300);
        }
    });
}

// ==================== 文案自动剪辑模块 ====================

let autoEditBatchTasks = [];
let autoEditBatchScriptCells = [];
let autoEditActiveBatchIndex = -1;
let autoEditBatchRunning = false;
let autoEditBatchInputTimer = null;

function setAutoEditBatchRunning(running) {
    autoEditBatchRunning = Boolean(running);
    for (const id of ['autoedit-batch-analyze-btn', 'autoedit-batch-export-btn']) {
        const button = document.getElementById(id);
        if (button) button.disabled = autoEditBatchRunning;
    }
    if (document.getElementById('autoedit-batch-task-list')) renderAutoEditBatchTasks();
}

function getAutoEditRequestSettings() {
    const customOutput = document.getElementById('autoedit-output-mode')?.value === 'custom';
    const manualAudioPath = document.getElementById('autoedit-manual-audio-path')?.value?.trim() || '';
    return {
        language: document.getElementById('autoedit-language')?.value || 'auto',
        match_mode: document.getElementById('autoedit-match-mode')?.value || 'script',
        workflow_mode: document.getElementById('autoedit-workflow-mode')?.value || 'cut_first',
        transition_type: document.getElementById('autoedit-transition-type')?.value || 'none',
        transition_duration: parseFloat(document.getElementById('autoedit-transition-duration')?.value || '0.35'),
        lead_pad: parseFloat(document.getElementById('autoedit-lead-pad')?.value || '0.04'),
        tail_pad: parseFloat(document.getElementById('autoedit-tail-pad')?.value || '0.08'),
        min_score: parseFloat(document.getElementById('autoedit-min-score')?.value || '0.52'),
        burn_subtitles: document.getElementById('autoedit-burn-subtitles')?.checked || false,
        export_mp3: document.getElementById('autoedit-export-mp3')?.checked !== false,
        voice_changer_enabled: document.getElementById('autoedit-voicechanger-enabled')?.checked || false,
        voice_changer_voice_id: document.getElementById('autoedit-voicechanger-voice')?.value || '',
        voice_changer_replace_audio: document.getElementById('autoedit-voicechanger-replace')?.checked !== false,
        voice_changer_remove_noise: document.getElementById('autoedit-voicechanger-noise')?.checked || false,
        voice_changer_model_id: 'eleven_multilingual_sts_v2',
        voice_changer_stability: parseFloat(document.getElementById('autoedit-voicechanger-stability')?.value || '0.5'),
        voice_changer_similarity: parseFloat(document.getElementById('autoedit-voicechanger-similarity')?.value || '0.75'),
        manual_audio_path: manualAudioPath,
        manual_audio_replace: Boolean(manualAudioPath),
        force_transcribe: document.getElementById('autoedit-force-transcribe')?.checked || false,
        target_width: customOutput ? parseInt(document.getElementById('autoedit-target-width')?.value || '1080', 10) : undefined,
        target_height: customOutput ? parseInt(document.getElementById('autoedit-target-height')?.value || '1920', 10) : undefined,
        fps: customOutput ? parseFloat(document.getElementById('autoedit-target-fps')?.value || '0') || undefined : undefined,
        fit_mode: document.getElementById('autoedit-fit-mode')?.value || 'cover'
    };
}

function setAutoEditMode(mode, preserveBatchContext = false) {
    const batch = mode === 'batch';
    if (!batch && !preserveBatchContext) autoEditActiveBatchIndex = -1;
    document.getElementById('autoedit-batch-panel').style.display = batch ? '' : 'none';
    document.getElementById('autoedit-single-panel').style.display = batch ? 'none' : '';
    document.getElementById('autoedit-mode-single').className = `btn ${batch ? 'btn-secondary' : 'btn-primary'}`;
    document.getElementById('autoedit-mode-batch').className = `btn ${batch ? 'btn-primary' : 'btn-secondary'}`;
    if (batch) renderAutoEditBatchTasks();
}

function parseAutoEditClipboardCells(text) {
    const rows = [[]]; let cell = ''; let quoted = false;
    text = String(text || '');
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
        } else if (ch === '\t' && !quoted) {
            rows.at(-1).push(cell); cell = '';
        } else if ((ch === '\n' || ch === '\r') && !quoted) {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            rows.at(-1).push(cell); cell = ''; rows.push([]);
        } else cell += ch;
    }
    rows.at(-1).push(cell);
    const cells = rows.flat().map(v => v.replace(/\r\n/g, '\n').trim());
    // 保留中间空单元格，否则后续文案会向前错配文件夹；只去掉粘贴末尾产生的空行。
    while (cells.length > 0 && cells.at(-1) === '' && /(?:\r?\n)$/.test(text)) cells.pop();
    return cells;
}

function handleAutoEditBatchPaste(event) {
    const text = event.clipboardData?.getData('text/plain');
    if (typeof text !== 'string') return;
    event.preventDefault();
    document.getElementById('autoedit-batch-paste').value = text;
    applyAutoEditBatchScripts(parseAutoEditClipboardCells(text));
}
function handleAutoEditBatchTextInput(value) {
    clearTimeout(autoEditBatchInputTimer);
    autoEditBatchInputTimer = setTimeout(() => {
        applyAutoEditBatchScripts(parseAutoEditClipboardCells(value), { silent: true });
    }, 180);
}
function parseAutoEditBatchPaste() {
    applyAutoEditBatchScripts(parseAutoEditClipboardCells(document.getElementById('autoedit-batch-paste')?.value || ''));
}
function applyAutoEditBatchScripts(cells, options = {}) {
    autoEditBatchScriptCells = Array.isArray(cells) ? cells.slice() : [];
    autoEditBatchTasks.forEach((task, i) => setAutoEditBatchTaskScript(task, cells[i] || ''));
    renderAutoEditBatchTasks();
    if (!options.silent) showToast(`已自动识别 ${cells.length} 个文案单元格`, !autoEditBatchTasks.length || cells.length === autoEditBatchTasks.length ? 'success' : 'info');
}

async function selectAutoEditBatchFolders() {
    const dirs = await window.electronAPI?.selectDirectories?.();
    if (!Array.isArray(dirs) || !dirs.length) return;
    const videoExt = /\.(mp4|mov|mkv|avi|wmv|flv|webm|m4v)$/i;
    autoEditBatchTasks = [];
    for (const folder of dirs) {
        const entries = await window.electronAPI.scanDirectory(folder);
        const clips = entries.filter(x => !x.isDirectory && videoExt.test(x.name))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(x => x.path);
        const index = autoEditBatchTasks.length;
        const script = autoEditBatchScriptCells[index] || '';
        autoEditBatchTasks.push({ folder, name: window.electronAPI.pathBasename(folder), clips, script, thumbnail: '', status: clips.length ? 'waiting' : 'error', message: clips.length ? (script ? '文案已配对' : '等待文案') : '没有视频', result: null });
    }
    renderAutoEditBatchTasks();
    for (const task of autoEditBatchTasks) {
        if (task.clips[0]) { task.thumbnail = await batchCutGenThumb(task.clips[0]); renderAutoEditBatchTasks(); }
    }
}
function clearAutoEditBatchTasks() {
    autoEditBatchTasks = [];
    autoEditBatchScriptCells = [];
    const el = document.getElementById('autoedit-batch-paste'); if (el) el.value = '';
    renderAutoEditBatchTasks();
}
function updateAutoEditBatchScript(index, value) {
    if (!autoEditBatchTasks[index]) return;
    setAutoEditBatchTaskScript(autoEditBatchTasks[index], value);
    autoEditBatchScriptCells[index] = value;
}

function setAutoEditBatchTaskScript(task, value) {
    const nextScript = String(value || '');
    if (task.script === nextScript) return;
    task.script = nextScript;
    // 分析结果与当时的文案一一绑定。文案改动后禁止继续使用旧时间线。
    if (task.result || task.reviewSegments) {
        task.result = null;
        task.reviewSegments = null;
        task.reelsTransferError = '';
        task.status = task.clips?.length ? 'waiting' : 'error';
        task.message = task.clips?.length ? '文案已修改，请重新分析' : '没有视频';
    }
}

function renderAutoEditBatchTasks() {
    const root = document.getElementById('autoedit-batch-task-list'); if (!root) return;
    const summary = document.getElementById('autoedit-batch-summary');
    const scriptCount = autoEditBatchScriptCells.length || autoEditBatchTasks.filter(t => t.script).length;
    if (summary) summary.textContent = `${autoEditBatchTasks.length} 个文件夹 · ${scriptCount} 个文案单元格 · ${autoEditBatchTasks.filter(t => t.script).length} 个已配对`;
    const matchHint = document.getElementById('autoedit-batch-match-hint');
    if (matchHint) {
        matchHint.textContent = !autoEditBatchTasks.length
            ? (scriptCount ? `已识别 ${scriptCount} 个文案；请选择 ${scriptCount} 个文件夹自动配对。` : '粘贴后自动识别；第 N 个单元格对应第 N 个文件夹。')
            : (scriptCount === autoEditBatchTasks.length ? `✅ ${scriptCount} 个文案与文件夹已一一配对` : `⚠️ 文件夹 ${autoEditBatchTasks.length} 个，文案 ${scriptCount} 个，数量不一致`);
        matchHint.style.color = autoEditBatchTasks.length && scriptCount !== autoEditBatchTasks.length ? '#ff9f43' : '';
    }
    if (!autoEditBatchTasks.length) {
        if (!autoEditBatchScriptCells.length) { root.innerHTML = '<div class="hint">先粘贴 Google Sheets 单元格，或先选择多个文件夹。</div>'; return; }
        root.innerHTML = autoEditBatchScriptCells.map((script, i) => {
            const lines = script.split(/\r?\n/).filter(line => line.trim()).length;
            return `<div style="border:1px solid rgba(99,102,241,.3);border-radius:8px;padding:10px;background:rgba(99,102,241,.07);"><div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;"><strong style="color:#a5b4fc;">文案单元格 #${i+1}</strong><span class="hint">${lines} 行</span></div><div style="white-space:pre-wrap;line-height:1.5;max-height:120px;overflow:auto;color:var(--text-primary);">${escapeHtml(script) || '<span style="color:#ff9f43;">空单元格（保留位置）</span>'}</div></div>`;
        }).join('');
        return;
    }
    const colors = { waiting:'#8b95c0', analyzing:'#4dabf7', ready:'#51cf66', warning:'#ff9f43', error:'#ff6b6b' };
    root.innerHTML = autoEditBatchTasks.map((task, i) => {
        const lines = task.script.split(/\r?\n/).filter(x => x.trim()).length;
        const first = task.clips[0]?.split(/[/\\]/).pop() || '没有视频';
        return `<div style="border:1px solid var(--border-color);border-radius:8px;padding:10px;background:var(--bg-tertiary);display:grid;grid-template-columns:128px 1fr;gap:10px;">
          <div>${task.thumbnail ? `<img src="${task.thumbnail}" onclick="playAutoEditBatchSource(${i})" style="width:128px;height:82px;object-fit:cover;border-radius:6px;cursor:pointer;">` : '<div style="width:128px;height:82px;background:#111;border-radius:6px;display:grid;place-items:center;color:#777;">无缩略图</div>'}<div title="${escapeHtml(first)}" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(first)}</div></div>
          <div><div style="display:flex;justify-content:space-between;"><strong>#${i+1} ${escapeHtml(task.name)}</strong><span title="${escapeHtml(task.reelsTransferError || task.message)}" style="color:${colors[task.status] || '#8b95c0'}">${escapeHtml(task.message)}</span></div><div class="hint">${task.clips.length} 个视频 · ${lines} 行文案</div><textarea class="input" rows="3" onchange="updateAutoEditBatchScript(${i},this.value)" ${autoEditBatchRunning?'disabled':''} style="width:100%;margin-top:6px;resize:vertical;">${escapeHtml(task.script)}</textarea>${task.result?.analysis_only ? `<button class="btn btn-secondary" onclick="openAutoEditBatchReview(${i})" ${autoEditBatchRunning?'disabled':''} style="margin-top:6px;">审核时间线</button><button class="btn btn-primary" onclick="exportAutoEditBatchTask(${i})" ${autoEditBatchRunning||task.status==='analyzing'?'disabled':''} style="margin:6px 0 0 6px;">正式导出</button>` : ''}${task.result?.output_path && !task.result?.analysis_only ? `<button class="btn btn-secondary" onclick="showAutoEditBatchOutput(${i})" style="margin-top:6px;">📁 查看成片</button>${task.reelsTransferError ? `<button class="btn btn-secondary" onclick="retryAutoEditBatchTaskToReels(${i})" ${autoEditBatchRunning?'disabled':''} style="margin:6px 0 0 6px;">重送 Reels</button>` : ''}` : ''}</div>
        </div>`;
    }).join('');
}
function playAutoEditBatchSource(index) {
    const source = autoEditBatchTasks[index]?.clips?.[0];
    if (source) window.playVideoClip(source, 0, 0);
}

async function analyzeAutoEditBatchTask(task, settings = task.settings || getAutoEditRequestSettings()) {
    task.status='analyzing'; task.message='正在分析'; renderAutoEditBatchTasks();
    const requestId=`autoedit-batch-analysis-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const unsubscribe=window.electronAPI?.onAutoEditProgress?.(progress=>{
        if(progress?.request_id!==requestId)return;
        task.message=progress.message||'正在分析'; renderAutoEditBatchTasks();
    });
    try {
        task.settings={...settings};
        const response = await apiFetch(`${API_BASE}/media/convert`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ files:task.clips, clips:task.clips, mode:'auto_edit', request_id:requestId, analysis_only:true, script_text:task.script, output_dir:window.electronAPI.pathJoin(task.folder,'_auto_edit'), ...task.settings }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '分析失败');
        task.result=data; const warnings=(data.segments||[]).filter(s=>s.status==='warning').length;
        task.status=warnings?'warning':'ready'; task.message=warnings?`${warnings} 项待审核`:'分析通过';
    } catch (e) { task.status='error'; task.message=e.message; }
    finally { if(typeof unsubscribe==='function')unsubscribe(); }
    renderAutoEditBatchTasks();
}
async function startAutoEditBatchAnalysis() {
    if(autoEditBatchRunning)return showToast('批量任务正在运行，请稍候','info');
    if (!autoEditBatchTasks.length) return showToast('请先选择多个文件夹','error');
    if (autoEditBatchScriptCells.length && autoEditBatchScriptCells.length !== autoEditBatchTasks.length) return showToast(`文件夹 ${autoEditBatchTasks.length} 个，文案单元格 ${autoEditBatchScriptCells.length} 个，请确保数量一致`,'error');
    if (autoEditBatchTasks.some(t=>!t.script.trim())) return showToast('文案单元格数量与文件夹数量不一致','error');
    if (autoEditBatchTasks.some(t=>!t.clips.length)) return showToast('存在没有视频的文件夹','error');
    const n=Math.max(1,Math.min(4,parseInt(document.getElementById('autoedit-batch-concurrency')?.value||'2',10))); let cursor=0;
    const settings={...getAutoEditRequestSettings()};
    setAutoEditBatchRunning(true);
    try {
        const worker=async()=>{ while(cursor<autoEditBatchTasks.length) await analyzeAutoEditBatchTask(autoEditBatchTasks[cursor++],settings); };
        await Promise.all(Array.from({length:Math.min(n,autoEditBatchTasks.length)},worker));
        const failed=autoEditBatchTasks.filter(task=>task.status==='error').length;
        showToast(failed?`批量分析完成，${failed} 个失败`:'批量分析完成',failed?'error':'success');
    } finally { setAutoEditBatchRunning(false); }
}
async function exportAutoEditBatchTask(index, options = {}) {
    const task = autoEditBatchTasks[index];
    if (!task?.result?.analysis_only) return showToast('请先完成该任务的分析', 'error');
    const ownsLock = options.managed !== true;
    if (ownsLock && autoEditBatchRunning) return showToast('批量任务正在运行，请稍候', 'info');
    if(task.status==='analyzing')return;
    if (ownsLock) setAutoEditBatchRunning(true);
    task.status='analyzing'; task.message='正在正式导出'; renderAutoEditBatchTasks();
    const requestId=`autoedit-batch-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const unsubscribe=window.electronAPI?.onAutoEditProgress?.(progress=>{
        if(progress?.request_id!==requestId)return;
        task.message=progress.message||'正在正式导出'; renderAutoEditBatchTasks();
    });
    try {
        let exportStage = '准备审核时间线';
        let exportedData = null;
        try {
            const reviewSegments=task.reviewSegments||(task.result.segments||[]).map(seg=>({source:seg.source,enabled:true,script:seg.script,start:Number(seg.start),end:Number(seg.end),speed:1}));
            exportStage = '调用自动剪辑导出接口';
            const response=await apiFetch(`${API_BASE}/media/convert`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({files:task.clips,clips:task.clips,mode:'auto_edit',request_id:requestId,analysis_only:false,review_segments:reviewSegments,ignore_mismatch:true,force_mismatch:false,script_text:task.script,output_dir:window.electronAPI.pathJoin(task.folder,'_auto_edit'),...(task.settings||getAutoEditRequestSettings()),force_transcribe:false})});
            exportStage = '读取导出结果';
            const data=await response.json(); if(!response.ok) throw new Error(data.error||'导出失败');
            exportedData = data;
            task.result=data; task.status='ready'; task.message='导出完成';
            task.reelsTransferError = '';
        } catch (e) {
            console.error(`[AutoEdit Batch Export] task=${task.name} stage=${exportStage}`, e);
            task.status='error'; task.message=`${exportStage}: ${e.message}`;
        }
        // “导出视频”和“送入 Reels”是两个独立步骤。Reels 页面接收失败时，
        // 不能把已经成功生成在磁盘上的视频误报为“导出失败”。
        if (exportedData && document.getElementById('autoedit-send-reels')?.checked) {
            try {
                await sendAutoEditResultToReels(exportedData, { silent: true });
                task.message = '导出完成 · 已送入 Reels';
            } catch (e) {
                console.error(`[AutoEdit Batch Export] task=${task.name} stage=送入批量 Reels`, e);
                task.status = 'warning';
                task.reelsTransferError = e.message || String(e);
                task.message = `导出已完成 · Reels 接收失败`;
            }
        }
    } finally {
        if(typeof unsubscribe==='function')unsubscribe();
        if(ownsLock)setAutoEditBatchRunning(false);
        renderAutoEditBatchTasks();
    }
}
async function startAutoEditBatchExport() {
    if(autoEditBatchRunning)return showToast('批量任务正在运行，请稍候','info');
    const ready=autoEditBatchTasks.map((task,index)=>({task,index})).filter(x=>x.task.result?.analysis_only);
    if(!ready.length) return showToast('请先完成批量分析','error');
    const risky=ready.filter(x=>(x.task.result.segments||[]).some(s=>s.status==='warning'));
    if(risky.length && !confirm(`${risky.length} 个任务仍有待审核项目。继续将按当前分析结果导出；建议先逐套审核。确定继续吗？`)) return;
    const n=Math.max(1,Math.min(4,parseInt(document.getElementById('autoedit-batch-concurrency')?.value||'2',10))); let cursor=0;
    setAutoEditBatchRunning(true);
    try {
        const worker=async()=>{while(cursor<ready.length) await exportAutoEditBatchTask(ready[cursor++].index,{managed:true});};
        await Promise.all(Array.from({length:Math.min(n,ready.length)},worker));
        const failed=ready.filter(x=>x.task.status==='error').length;
        const reelsFailed=ready.filter(x=>x.task.reelsTransferError).length;
        const summary = failed
            ? `批量导出完成，${failed} 个导出失败${reelsFailed ? `，${reelsFailed} 个 Reels 接收失败` : ''}`
            : (reelsFailed ? `视频全部导出完成，${reelsFailed} 个未送入 Reels` : '批量导出完成');
        showToast(summary,failed?'error':(reelsFailed?'info':'success'));
    } finally { setAutoEditBatchRunning(false); }
}
function showAutoEditBatchOutput(index) {
    const outputPath = autoEditBatchTasks[index]?.result?.output_path;
    if (outputPath && window.electronAPI?.showItemInFolder) window.electronAPI.showItemInFolder(outputPath);
}
async function retryAutoEditBatchTaskToReels(index) {
    const task = autoEditBatchTasks[index];
    if (!task?.result?.output_path) return showToast('该任务还没有可用成片', 'error');
    if (autoEditBatchRunning) return showToast('批量任务正在运行，请稍候', 'info');
    setAutoEditBatchRunning(true);
    task.message = '正在重新送入 Reels';
    renderAutoEditBatchTasks();
    try {
        await sendAutoEditResultToReels(task.result, { silent: true });
        task.status = 'ready';
        task.reelsTransferError = '';
        task.message = '导出完成 · 已送入 Reels';
        showToast('已重新送入批量 Reels', 'success');
    } catch (error) {
        task.status = 'warning';
        task.reelsTransferError = error.message || String(error);
        task.message = '导出已完成 · Reels 接收失败';
        showToast(`Reels 接收失败：${escapeHtml(task.reelsTransferError)}`, 'error');
    }
    finally {
        setAutoEditBatchRunning(false);
        renderAutoEditBatchTasks();
    }
}
function openAutoEditBatchReview(index) {
    const task=autoEditBatchTasks[index]; if(!task?.result)return;
    autoEditFiles=task.clips.map(path=>({path,name:path.split(/[/\\]/).pop(),status:'transcribed'}));
    document.getElementById('autoedit-script').value=task.script; updateAutoEditScriptCount(); renderAutoEditFiles();
    autoEditActiveBatchIndex=index; autoEditLastResult=task.result; autoEditOutputDir=task.result.output_dir||window.electronAPI.pathJoin(task.folder,'_auto_edit'); setAutoEditMode('single',true); renderAutoEditResult(task.result); document.getElementById('autoedit-result-section')?.classList.remove('hidden');
}

let autoEditFiles = [];
let autoEditOutputDir = '';
let autoEditResultFiles = [];
let autoEditLastResult = null;
let autoEditProgressUnsubscribe = null;

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('autoedit-video-input');
    if (input) {
        input.addEventListener('change', (e) => {
            autoEditAddFiles(Array.from(e.target.files || []));
            e.target.value = '';
        });
    }

    const dropZone = document.getElementById('autoedit-drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent)';
            dropZone.style.background = 'rgba(102,126,234,0.05)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
            autoEditAddFiles(Array.from(e.dataTransfer.files || []));
        });
    }

    const scriptInput = document.getElementById('autoedit-script');
    if (scriptInput) {
        scriptInput.addEventListener('input', updateAutoEditScriptCount);
    }
    const matchModeInput = document.getElementById('autoedit-match-mode');
    if (matchModeInput) {
        matchModeInput.addEventListener('change', updateAutoEditScriptCount);
    }
    const manualAudioInput = document.getElementById('autoedit-manual-audio-input');
    if (manualAudioInput) {
        manualAudioInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            const pathInput = document.getElementById('autoedit-manual-audio-path');
            if (file && pathInput) pathInput.value = getFileNativePath(file);
            e.target.value = '';
        });
    }
    const resultAudioInput = document.getElementById('autoedit-result-audio-input');
    if (resultAudioInput) {
        resultAudioInput.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            const pathInput = document.getElementById('autoedit-result-audio-path');
            if (file && pathInput) pathInput.value = getFileNativePath(file);
            e.target.value = '';
        });
    }
});

function autoEditScriptLines() {
    return (document.getElementById('autoedit-script')?.value || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
}

function updateAutoEditScriptCount() {
    const el = document.getElementById('autoedit-script-count');
    if (!el) return;
    const lineCount = autoEditScriptLines().length;
    const fileCount = autoEditFiles.length;
    const matchMode = document.getElementById('autoedit-match-mode')?.value || 'script';
    if (matchMode === 'line_per_clip') {
        el.textContent = `${lineCount} 行文案 · ${fileCount} 个片段 · 一行一片段`;
        el.style.color = lineCount && fileCount && lineCount !== fileCount ? '#fbbf24' : '';
    } else {
        el.textContent = `${lineCount} 行字幕文案 · ${fileCount} 个片段 · 自动匹配`;
        el.style.color = '';
    }
}

function autoEditAddFiles(files) {
    const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
    const newFiles = (files || [])
        .filter(f => videoExts.some(ext => String(f.name || '').toLowerCase().endsWith(ext)))
        .map(f => ({ path: getFileNativePath(f), name: f.name || String(f.path || '') }))
        .filter(f => f.path && !autoEditFiles.some(x => x.path === f.path));

    autoEditFiles.push(...newFiles);
    autoEditFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    renderAutoEditFiles();
    updateAutoEditScriptCount();
    if (newFiles.length > 0) showToast(`已添加 ${newFiles.length} 个视频片段`, 'success');
}

function renderAutoEditFiles() {
    const list = document.getElementById('autoedit-file-list');
    if (!list) return;
    if (autoEditFiles.length === 0) {
        list.innerHTML = '<p class="hint">请先选择视频片段。</p>';
        return;
    }

    const startBtn = document.getElementById('autoedit-start-btn');
    const isProcessing = startBtn && startBtn.disabled;

    list.innerHTML = autoEditFiles.map((file, i) => {
        const statusVal = file.status || '';
        let statusHtml = '';
        if (statusVal === 'transcribing') {
            statusHtml = `<span style="color: var(--accent); font-weight: 600; padding: 2px 6px; background: rgba(102,126,234,0.1); border-radius: 3px; font-size: 11px;">⏳ 转录中</span>`;
        } else if (statusVal === 'cached') {
            statusHtml = `<span style="color: #4dabf7; font-weight: 600; padding: 2px 6px; background: rgba(77,171,247,0.1); border-radius: 3px; font-size: 11px;">✅ 已转录</span>`;
        } else if (statusVal === 'transcribed') {
            statusHtml = `<span style="color: #4dabf7; font-weight: 600; padding: 2px 6px; background: rgba(77,171,247,0.1); border-radius: 3px; font-size: 11px;">✅ 已转录</span>`;
        } else if (statusVal === 'failed') {
            statusHtml = `<span style="color: #ff6b6b; font-weight: 600; padding: 2px 6px; background: rgba(255,107,107,0.1); border-radius: 3px; font-size: 11px;" title="${escapeHtml(file.error || '转录失败')}">❌ 失败</span>`;
        } else if (statusVal === 'empty') {
            statusHtml = `<span style="color:#f59f00;font-weight:600;padding:2px 6px;background:rgba(245,159,0,.1);border-radius:3px;font-size:11px;" title="${escapeHtml(file.error || '识别服务未返回文字结果，请点击右侧重新识别')}">⚠️ 未获得识别结果</span>`;
        } else if (statusVal === 'unmatched') {
            statusHtml = `<span style="color: #f76707; font-weight: 600; padding: 2px 6px; background: rgba(247,103,7,0.1); border-radius: 3px; font-size: 11px;" title="${escapeHtml(file.error || '未匹配到任何断行文案')}">⚠️ 未匹配到文案</span>`;
        } else if (statusVal === 'excluded_duplicate') {
            statusHtml = `<span style="color:#c084fc;font-weight:700;padding:2px 6px;background:rgba(168,85,247,.16);border-radius:3px;font-size:11px;">✓ 重复片段已排除</span>`;
        } else if (statusVal === 'excluded_review') {
            statusHtml = `<span style="color:#adb5bd;font-weight:600;padding:2px 6px;background:rgba(148,163,184,.12);border-radius:3px;font-size:11px;">✓ 审核中已排除</span>`;
        } else if (statusVal === 'pending') {
            statusHtml = `<span style="color: var(--text-muted); padding: 2px 6px; background: rgba(255,255,255,0.03); border-radius: 3px; font-size: 11px;">排队中</span>`;
        } else if (statusVal === 'discarded') {
            statusHtml = `<span style="color: #f08c00; font-weight: 600; padding: 2px 6px; background: rgba(240,140,0,0.15); border-radius: 3px; font-size: 11px;">❌ 未采用</span>`;
        }

        const selectSubtitleBtn = `<button class="btn btn-secondary" onclick="selectAutoEditManualSubtitle(${i})" style="padding: 2px 6px; font-size: 11px;" title="手动指定此视频的 .srt/.json/.txt 字幕文件">🔗 字幕</button>`;

        const actionHtml = isProcessing
            ? ''
            : `
                <div style="display: flex; gap: 4px; align-items: center;">
                    ${selectSubtitleBtn}
                    ${file.status ? `<button class="btn btn-secondary" onclick="clearAutoEditFileCache(${i})" style="padding: 2px 6px; font-size: 11px;" title="清除此视频的转录缓存，下次运行将重新识别">🔄 重新识别</button>` : ''}
                    <button class="btn btn-secondary" onclick="removeAutoEditFile(${i})" style="padding: 2px 6px; font-size: 11px;">移除</button>
                </div>
            `;

        const orderHtml = (file.outputIndex && file.outputIndex < 9999)
            ? `<span style="color: #228be6; font-weight: bold; font-size: 11px; padding: 2px 6px; border: 1px solid rgba(34,139,230,0.3); border-radius: 3px; background: rgba(34,139,230,0.05); margin-right: 6px;">🎬 播放顺序 #${file.outputIndex}</span>`
            : '';

        const subtextHtml = file.manualSubtitlePath
            ? `<div style="font-size: 10px; color: #4dabf7; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="手动指定字幕: ${escapeHtml(file.manualSubtitlePath)}">📄 字幕: ${escapeHtml(file.manualSubtitlePath.split(/[/\\]/).pop())} <span style="cursor: pointer; color: #ff6b6b; font-weight: bold;" onclick="clearAutoEditManualSubtitle(${i}, event)">[清除]</span></div>`
            : '';

        return `
            <div style="display: grid; grid-template-columns: 38px 1fr auto auto; gap: 8px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-size: 12px;">
                <strong style="color: var(--accent);">#${i + 1}</strong>
                <div style="overflow: hidden; display: flex; flex-direction: column;">
                    <span title="${escapeHtml(file.path)}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                        ${orderHtml}${escapeHtml(file.name)}
                    </span>
                    ${subtextHtml}
                </div>
                ${statusHtml}
                ${actionHtml}
            </div>
        `;
    }).join('');
}

async function selectAutoEditManualSubtitle(index) {
    if (index < 0 || index >= autoEditFiles.length) return;
    try {
        if (window.electronAPI?.selectFiles) {
            const result = await window.electronAPI.selectFiles({
                multiple: false,
                title: '选择字幕文件',
                filters: [
                    { name: '字幕/文本文件 (*.srt, *.json, *.txt)', extensions: ['srt', 'json', 'txt'] }
                ]
            });
            if (result && result.length > 0) {
                autoEditFiles[index].manualSubtitlePath = result[0];
                autoEditFiles[index].status = '';
                autoEditFiles[index].error = null;
                renderAutoEditFiles();
                showToast(`已选择字幕文件: ${result[0].split(/[/\\]/).pop()}`, 'success');
            }
        }
    } catch (e) {
        showToast('选择字幕文件失败: ' + e.message, 'error');
    }
}

function clearAutoEditManualSubtitle(index, event) {
    if (event) event.stopPropagation();
    if (index < 0 || index >= autoEditFiles.length) return;
    autoEditFiles[index].manualSubtitlePath = null;
    autoEditFiles[index].status = '';
    autoEditFiles[index].error = null;
    renderAutoEditFiles();
    showToast('已清除手动指定的字幕', 'info');
}

window.selectAutoEditManualSubtitle = selectAutoEditManualSubtitle;
window.clearAutoEditManualSubtitle = clearAutoEditManualSubtitle;

async function clearAutoEditFileCache(index) {
    if (index < 0 || index >= autoEditFiles.length) return;
    const file = autoEditFiles[index];
    try {
        const resp = await apiFetch(`${API_BASE}/media/clear-clip-cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: file.path }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '清除缓存失败');
        
        file.status = '';
        file.outputIndex = null;
        file.error = null;
        renderAutoEditFiles();
        showToast('缓存已清除，正在重新分析；其他片段会继续使用有效缓存', 'info');
        const batchTask = autoEditActiveBatchIndex >= 0 ? autoEditBatchTasks[autoEditActiveBatchIndex] : null;
        await startAutoEditByScript(false, {
            analysisOnly: true,
            outputDirOverride: batchTask ? window.electronAPI.pathJoin(batchTask.folder, '_auto_edit') : undefined,
            requestSettingsOverride: batchTask?.settings,
        });
    } catch (e) {
        showToast(`清除缓存失败: ${escapeHtml(e.message)}`, 'error');
    }
}

window.clearAutoEditFileCache = clearAutoEditFileCache;

function removeAutoEditFile(index) {
    if (index < 0 || index >= autoEditFiles.length) return;
    autoEditFiles.splice(index, 1);
    renderAutoEditFiles();
    updateAutoEditScriptCount();
}

function clearAutoEditFiles() {
    autoEditFiles = [];
    const input = document.getElementById('autoedit-video-input');
    if (input) input.value = '';
    renderAutoEditFiles();
    updateAutoEditScriptCount();
}

function clearAutoEditScript() {
    const input = document.getElementById('autoedit-script');
    if (input) input.value = '';
    updateAutoEditScriptCount();
}

function clearAutoEditManualAudio() {
    const input = document.getElementById('autoedit-manual-audio-path');
    if (input) input.value = '';
}

window.clearAutoEditManualAudio = clearAutoEditManualAudio;

async function loadAutoEditVoiceChangerVoices(scope = 'main') {
    const inputId = scope === 'mtb' ? 'mtb-autoedit-vc-voice' : 'autoedit-voicechanger-voice';
    const listId = scope === 'mtb' ? 'mtb-autoedit-vc-voices' : 'autoedit-voicechanger-voices';
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!list) return;

    const previousValue = input?.value || '';
    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/voices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ include_shared: true }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载音色失败');
        const fallbackVoices = [
            { voice_id: '21m00Tcm4TlvDq8ikWAM', name: '[官方] Rachel', category: 'premade' },
            { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: '[官方] George', category: 'premade' },
        ];
        const voices = Array.isArray(data.voices) && data.voices.length > 0 ? data.voices : fallbackVoices;
        if (data.error && voices === fallbackVoices) {
            showToast(`音色接口返回空，已使用官方默认音色: ${data.error}`, 'info', 6000);
        }
        list.innerHTML = voices.map(v => {
            const id = escapeHtml(v.voice_id || '');
            const name = escapeHtml(v.name || v.voice_id || '');
            const category = escapeHtml(v.category || '');
            return `<option value="${id}" label="${name}${category ? ` · ${category}` : ''}"></option>`;
        }).join('');
        if (input && !input.value && voices[0]?.voice_id) input.value = previousValue || voices[0].voice_id;
        showToast(`已加载 ${voices.length} 个 ElevenLabs 音色`, 'success');
    } catch (error) {
        showToast(`加载音色失败: ${escapeHtml(error.message)}`, 'error');
    }
}

window.loadAutoEditVoiceChangerVoices = loadAutoEditVoiceChangerVoices;

let autoEditIgnoreMismatch = false;

function tokenizeTextForDiff(text) {
    if (!text) return [];
    const regex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]|[a-zA-Z0-9'-]+|[^\s]/g;
    return String(text).match(regex) || [];
}

function tokenizeTextWithIndices(text) {
    if (!text) return [];
    const regex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]|[a-zA-Z0-9'-]+|[^\s]/g;
    const tokens = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        tokens.push({
            word: match[0],
            start: match.index,
            end: regex.lastIndex
        });
    }
    return tokens;
}

function joinTokensSmartly(tokens) {
    let result = '';
    const isWide = (str) => /[^\x00-\xff]/.test(str);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (i === 0) {
            result += token;
        } else {
            const prev = tokens[i - 1];
            if (isWide(token) || isWide(prev)) {
                result += token;
            } else {
                result += ' ' + token;
            }
        }
    }
    return result;
}

function _autoEditLcsWordDiff(wordsA, wordsB) {
    const m = wordsA.length, n = wordsB.length;
    if (m === 0 && n === 0) return [];
    if (m === 0) return wordsB.map(w => ({ type: 'add', word: w }));
    if (n === 0) return wordsA.map(w => ({ type: 'remove', word: w }));
    const MAX = 600;
    const a = m > MAX ? wordsA.slice(0, MAX) : wordsA;
    const b = n > MAX ? wordsB.slice(0, MAX) : wordsB;
    const ml = a.length, nl = b.length;
    const dp = Array.from({ length: ml + 1 }, () => new Uint16Array(nl + 1));
    for (let i = 1; i <= ml; i++) {
        for (let j = 1; j <= nl; j++) {
            dp[i][j] = a[i - 1].toLowerCase() === b[j - 1].toLowerCase()
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    const result = [];
    let i = ml, j = nl;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
            result.unshift({ type: 'same', word: a[i - 1] });
            i--;
            j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'add', word: b[j - 1] });
            j--;
        } else {
            result.unshift({ type: 'remove', word: a[i - 1] });
            i--;
        }
    }
    return result;
}

function _showAutoEditMismatchDialog(mismatches, scriptText, missingBlocks = []) {
    window.autoEditLastMismatches = mismatches;
    window.autoEditLastMissingBlocks = missingBlocks;
    return new Promise((resolve) => {
        mismatches.forEach(m => {
            const fileObj = autoEditFiles.find(f => f.path === m.clipPath);
            m.speed = fileObj ? (fileObj.speed || 1.0) : 1.0;
        });
        let modal = document.getElementById('ae-mismatch-dialog-overlay');
        let content;
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'ae-mismatch-dialog-overlay';
            modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

            const styleEl = document.createElement('style');
            styleEl.textContent = `
                .ae-mismatch-card {
                    cursor: pointer;
                    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
                }
                .ae-mismatch-card:hover {
                    background: rgba(255, 255, 255, 0.04) !important;
                    border-color: rgba(99, 102, 241, 0.4) !important;
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
                }
                .ae-mismatch-card.selected-card-glow {
                    border-color: #6366f1 !important;
                    box-shadow: 0 0 15px rgba(99, 102, 241, 0.3) !important;
                    background: rgba(99, 102, 241, 0.05) !important;
                }
                .ae-script-line {
                    transition: all 0.2s ease;
                }
                .ae-script-line:hover {
                    background: rgba(99, 102, 241, 0.1) !important;
                    color: #fff !important;
                }
                .ae-mismatch-card.ae-card-ignored {
                    opacity: 0.45 !important;
                    background: rgba(255, 255, 255, 0.01) !important;
                    border-style: dotted !important;
                    border-color: rgba(255, 255, 255, 0.1) !important;
                    box-shadow: none !important;
                    transform: none !important;
                }
                @keyframes ae-spin {
                    to { transform: rotate(360deg); }
                }
            `;
            modal.appendChild(styleEl);

            content = document.createElement('div');
            // Wide dialog for 2 columns layout
            content.style.cssText = 'background:#13132a;width:1160px;max-height:85%;border-radius:14px;padding:24px;border:1px solid rgba(255, 255, 255, 0.08);box-shadow:0 20px 60px rgba(0, 0, 0, 0.6);display:flex;flex-direction:column;gap:16px;color:#e8ecff;';
            modal.appendChild(content);
            document.body.appendChild(modal);
        } else {
            content = modal.querySelector('div');
        }

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        const isPunctuation = (str) => {
            return !/[\p{L}\p{N}]/u.test(str);
        };

        const highlightScriptText = (diff) => {
            let html = '';
            const isWide = (str) => /[^\x00-\xff]/.test(str);
            let prevToken = '';
            let isFirst = true;

            for (const d of diff) {
                if (d.type === 'remove') continue;
                
                const token = d.word;
                let spacing = '';
                if (!isFirst) {
                    if (!isWide(token) && !isWide(prevToken)) {
                        spacing = ' ';
                    }
                }
                isFirst = false;
                prevToken = token;

                if (d.type === 'same' || (d.type === 'add' && isPunctuation(d.word))) {
                    html += spacing + escapeHtml(token);
                } else if (d.type === 'add') {
                    html += spacing + `<span style="background:rgba(239,68,68,0.22);color:#ff9e9e;padding:1px 4px;border-radius:3px;font-weight:bold;border-bottom:2px solid #ff4a4a;">${escapeHtml(token)}</span>`;
                }
            }
            return html;
        };

        const highlightRecognizedText = (diff, cardIdx) => {
            let html = '';
            const isWide = (str) => /[^\x00-\xff]/.test(str);
            let prevToken = '';
            let isFirst = true;

            for (let k = 0; k < diff.length; k++) {
                const d = diff[k];
                if (d.type === 'add') continue;
                
                const token = d.word;
                let spacing = '';
                if (!isFirst) {
                    if (!isWide(token) && !isWide(prevToken)) {
                        spacing = ' ';
                    }
                }
                isFirst = false;
                prevToken = token;

                if (isPunctuation(token)) {
                    html += spacing + escapeHtml(token);
                    continue;
                }

                let style = 'cursor:pointer;user-select:none;transition:all 0.15s;border-radius:3px;padding:1px 3px;display:inline-block;line-height:1.2;margin:1px 0;';
                let className = 'ae-rec-word';
                if (d.type === 'remove') {
                    // Extra word: default is ignored (struck out)
                    style += 'background:rgba(245,158,11,0.08);color:#777;text-decoration:line-through;opacity:0.6;';
                    className += ' ae-rec-extra';
                } else {
                    // Same word: default is active/included
                    style += 'background:rgba(255,255,255,0.02);color:#cbd5e1;';
                    className += ' ae-rec-same active';
                }

                html += spacing + `<span class="${className}" data-card-idx="${cardIdx}" data-diff-idx="${k}" style="${style}" title="点击切换：保留 / 剔除">${escapeHtml(token)}</span>`;
            }
            return html;
        };

        const prepareCardDiff = (m) => {
            const wordsA = tokenizeTextForDiff(m.recognizedText);
            const wordsBWithIndices = tokenizeTextWithIndices(m.scriptText);
            const wordsB = wordsBWithIndices.map(t => t.word);
            const diff = _autoEditLcsWordDiff(wordsA, wordsB);
            
            let missingWordCount = 0;
            let extraWordCount = 0;
            let bIdx = 0;
            diff.forEach((d, index) => {
                d.diffIdx = index;
                if (d.type === 'add') {
                    d.wordIdx = missingWordCount++;
                } else if (d.type === 'remove') {
                    d.wordIdx = extraWordCount++;
                }
                if (d.type === 'same' || d.type === 'add') {
                    if (wordsBWithIndices[bIdx]) {
                        d.charStart = wordsBWithIndices[bIdx].start;
                        d.charEnd = wordsBWithIndices[bIdx].end;
                    }
                    bIdx++;
                }
            });
            return {
                diff,
                missingWords: diff.filter(d => d.type === 'add' && !isPunctuation(d.word)),
                extraWords: diff.filter(d => d.type === 'remove' && !isPunctuation(d.word))
            };
        };

        // Combine clips and missing script blocks
        const sequenceItems = [];
        mismatches.forEach((m, idx) => {
            sequenceItems.push({
                type: 'clip',
                originalIndex: idx,
                data: m,
                sortIndex: m.scriptWordStart !== -1 && m.scriptWordStart !== undefined ? m.scriptWordStart : 999999
            });
        });
        missingBlocks.forEach((b, idx) => {
            sequenceItems.push({
                type: 'missing',
                originalIndex: idx,
                data: b,
                sortIndex: b.startIdx !== undefined ? b.startIdx : 999999
            });
        });
        sequenceItems.sort((a, b) => a.sortIndex - b.sortIndex);

        // Build left column: Reference Script Lines
        const rawLines = scriptText.replace(/\r\n/g, '\n').split('\n');
        const cleanedToRawIndex = [];
        for (let i = 0; i < rawLines.length; i++) {
            if (rawLines[i].trim().length > 0) {
                cleanedToRawIndex.push(i);
            }
        }

        const scriptLines = rawLines;
        let scriptLinesHtml = '';
        scriptLines.forEach((lineText, lineIdx) => {
            const trimmed = lineText.trim();
            if (!trimmed) {
                scriptLinesHtml += `<div style="height:12px;"></div>`;
                return;
            }
            
            // Find which card item covers this line index
            const matchingItem = sequenceItems.find(item => {
                if (item.type === 'clip') {
                    if (item.data.scriptWordStart === -1 || item.data.scriptWordStart === undefined) return false;
                    const rawStart = cleanedToRawIndex[item.data.scriptStartLine];
                    const rawEnd = cleanedToRawIndex[item.data.scriptEndLine];
                    return rawStart !== undefined && rawEnd !== undefined && rawStart <= lineIdx && lineIdx <= rawEnd;
                } else {
                    const rawStart = cleanedToRawIndex[item.data.startLine];
                    const rawEnd = cleanedToRawIndex[item.data.endLine];
                    return rawStart !== undefined && rawEnd !== undefined && rawStart <= lineIdx && lineIdx <= rawEnd;
                }
            });
            
            const matchingItemIdx = matchingItem ? sequenceItems.indexOf(matchingItem) : -1;
            const borderStyle = matchingItem
                ? (matchingItem.type === 'missing' ? 'border-left:3px solid #f87171;' : (matchingItem.data.isMismatch ? 'border-left:3px solid #ef4444;' : 'border-left:3px solid #34d399;'))
                : 'border-left:3px solid rgba(255,255,255,0.05);';
                
            scriptLinesHtml += `
                <div class="ae-script-line" data-line-idx="${lineIdx}" data-target-card-idx="${matchingItemIdx}" style="padding:6px 10px;margin-bottom:4px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,0.02);transition:all 0.15s;font-size:12px;line-height:1.5;color:#cbd5e1;${borderStyle}" title="${matchingItemIdx !== -1 ? `点击跳转到第 ${matchingItemIdx + 1} 个片段` : ''}">
                    <div style="font-size:9px;color:#64748b;margin-bottom:1px;font-family:monospace;">L${lineIdx + 1}</div>
                    <div>${escapeHtml(lineText)}</div>
                </div>
            `;
        });

        let html = `
            <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:12px;">
                <span style="font-size:24px;">⚠️</span>
                <div style="flex:1;">
                    <h3 style="margin:0;color:#e8ecff;font-size:16px;font-weight:700;">视频与文案对齐核对面板</h3>
                    <div style="font-size:11px;color:#8b95c0;margin-top:2px;">共有 ${mismatches.length} 个视频片段，${missingBlocks.length} 处丢失文案。</div>
                </div>
                <button id="ae-mismatch-btn-close" style="border:none;background:rgba(255,255,255,0.06);color:#999;border-radius:8px;padding:6px 12px;font-size:18px;cursor:pointer;line-height:1;" title="关闭">✕</button>
            </div>
            
            <div style="display:flex;gap:20px;flex:1;min-height:0;overflow:hidden;">
                <!-- Left Column: Complete Reference Script -->
                <div style="width:340px;display:flex;flex-direction:column;border-right:1px solid rgba(255,255,255,0.08);padding-right:16px;min-height:0;">
                    <div style="font-weight:bold;font-size:13px;color:#a5b4fc;margin-bottom:4px;display:flex;align-items:center;gap:6px;">📖 完整参考文案对照</div>
                    <div style="font-size:11px;color:#8b95c0;margin-bottom:12px;line-height:1.4;">点击段落可跳转定位到右侧对应的片段卡片。</div>
                    <div style="flex:1;overflow-y:auto;padding-right:4px;" class="scroll-container" id="ae-mismatch-script-lines">
                        ${scriptLinesHtml}
                    </div>
                </div>
                
                <!-- Right Column: Card sequence -->
                <div style="flex:1;display:flex;flex-direction:column;min-height:0;">
                    <div style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding-right:6px;" id="ae-mismatch-list-container" class="scroll-container">
        `;

        const errorMismatches = mismatches.filter(m => m.isMismatch);
        if (errorMismatches.length === 0 && missingBlocks.length === 0) {
            html += `
                <div style="padding:16px 20px;color:#fca5a5;font-size:13px;background:rgba(239,68,68,0.1);border-radius:10px;border:1px solid rgba(239,68,68,0.2);line-height:1.6;margin-bottom:12px;">
                    💡 <strong>顺序或行数错乱警告：</strong>没有检测到单个视频片段存在严重文字差异（均达到了对齐度阈值）且没有漏读的行。<br>
                    这可能是因为视频片段顺序与您的文案段落不符，或者文案行数与视频片段数多寡不一。<br>
                    建议点击左下角 <strong>“📊 查看对齐报告”</strong> 了解更多，或在主页面调整视频顺序。
                </div>
            `;
        }

        sequenceItems.forEach((item, itemIdx) => {
            if (item.type === 'clip') {
                const m = item.data;
                const idx = item.originalIndex;
                const { diff, missingWords, extraWords } = prepareCardDiff(m);
                const hasMissing = missingWords.length > 0;
                const hasExtra = extraWords.length > 0;

                let diffHtml = '';
                if (hasMissing) {
                    const wordTags = missingWords.map(d => {
                        return `<span class="ae-word-tag ae-missing-tag active" data-word-idx="${d.wordIdx}" style="display:inline-flex;align-items:center;padding:3px 8px;background:rgba(239,68,68,0.18);color:#ff9e9e;border:1px solid rgba(239,68,68,0.4);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;user-select:none;transition:all 0.15s;" title="点击切换：保留 / 删除">${escapeHtml(d.word)}</span>`;
                    }).join(' ');

                    diffHtml += `
                        <div style="font-size:12px;background:rgba(239,68,68,0.04);padding:10px 14px;border-radius:8px;border:1px solid rgba(239,68,68,0.12);display:flex;flex-direction:column;gap:8px;">
                            <div style="font-weight:bold;color:#ef4444;">⚠️ AI漏读的词（点击单词可单独切换 保留/删除）：</div>
                            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                                ${wordTags}
                            </div>
                        </div>
                    `;
                }
                if (hasExtra) {
                    const wordTags = extraWords.map(d => {
                        return `<span class="ae-word-tag ae-extra-tag" data-word-idx="${d.wordIdx}" style="display:inline-flex;align-items:center;padding:3px 8px;background:rgba(255,255,255,0.03);color:#777;border:1px solid rgba(255,255,255,0.06);border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;user-select:none;text-decoration:line-through;transition:all 0.15s;" title="点击切换：忽略 / 添加">${escapeHtml(d.word)}</span>`;
                    }).join(' ');

                    diffHtml += `
                        <div style="font-size:12px;background:rgba(245,158,11,0.04);padding:10px 14px;border-radius:8px;border:1px solid rgba(245,158,11,0.12);display:flex;flex-direction:column;gap:8px;">
                            <div style="font-weight:bold;color:#f59e0b;">⚠️ AI多读的词（点击单词可单独切换 忽略/添加）：</div>
                            <div style="display:flex;flex-wrap:wrap;gap:6px;">
                                ${wordTags}
                            </div>
                        </div>
                    `;
                }

                if (m.isMismatch) {
                    html += `
                        <div class="ae-mismatch-card ae-mismatch-error-card" id="ae-card-item-${itemIdx}" data-idx="${idx}" style="background:rgba(239,68,68,0.02);border:1px solid rgba(239,68,68,0.15);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,0.03);padding-bottom:8px;flex-direction:column;gap:4px;">
                                <div style="display:flex;justify-content:space-between;align-items:center;width:100%;">
                                    <div style="display:flex;gap:12px;align-items:center;">
                                        <span style="font-weight:bold;font-size:12px;color:#fca5a5;background:rgba(239,68,68,0.2);padding:2px 6px;border-radius:4px;">最终顺序 #${itemIdx + 1}</span>
                                        <span style="font-size:12px;color:#a3aed0;">原序号 #${m.sourceIndex + 1}</span>
                                        <button class="btn btn-secondary" onclick="window.playVideoClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.start || 0}, ${m.end || 0})" style="font-size: 10px; padding: 1px 6px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); color: #60a5fa; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">▶️ 播放片段</button>
                                    </div>
                                    <div style="display:flex;gap:8px;align-items:center;">
                                        <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#a3aed0;margin-right:4px;" title="调整此视频片段的播放速度（同时加快声音与画面）">
                                            <span>⚡️倍速:</span>
                                            <select class="ae-clip-speed" data-idx="${idx}" style="background:#1e1e38;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:1px 4px;font-size:10px;outline:none;cursor:pointer;line-height:1.2;">
                                                <option value="1.0" ${m.speed === 1.0 || !m.speed ? 'selected' : ''}>1.0x</option>
                                                <option value="1.1" ${m.speed === 1.1 ? 'selected' : ''}>1.1x</option>
                                                <option value="1.2" ${m.speed === 1.2 ? 'selected' : ''}>1.2x</option>
                                                <option value="1.25" ${m.speed === 1.25 ? 'selected' : ''}>1.25x</option>
                                                <option value="1.3" ${m.speed === 1.3 ? 'selected' : ''}>1.3x</option>
                                                <option value="1.5" ${m.speed === 1.5 ? 'selected' : ''}>1.5x</option>
                                                <option value="1.75" ${m.speed === 1.75 ? 'selected' : ''}>1.75x</option>
                                                <option value="2.0" ${m.speed === 2.0 ? 'selected' : ''}>2.0x</option>
                                            </select>
                                        </div>
                                        <span style="font-size:11px;background:rgba(239,68,68,0.2);color:#ef4444;padding:2px 6px;border-radius:4px;font-weight:600;">⚠️ 差异度: ${100 - m.similarity}%</span>
                                        <button class="btn btn-secondary" onclick="window.retranscribeAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.35); color: #818cf8; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;" title="清除此视频的转录缓存并重新转录语音">🎙️ 重录</button>
                                        <button class="btn btn-secondary" onclick="window.replaceAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.35); color: #fca5a5; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">🔄 替换</button>
                                        <button class="btn btn-secondary" onclick="window.removeAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #ccc; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;" title="将此视频片段从工作区排除">🔕 忽略</button>
                                    </div>
                                </div>
                                <div style="font-size:12px;color:#e8ecff;word-break:break-all;font-weight:bold;margin-top:2px;">
                                    📹 文件名: ${escapeHtml(m.fileName)}
                                </div>
                                <div style="font-size:11px;color:#8b95c0;word-break:break-all;font-family:monospace;margin-top:2px;">
                                    📁 完整路径: ${escapeHtml(m.clipPath)}
                                </div>
                            </div>

                            <div style="display:flex;gap:10px;font-size:12px;color:#aab;">
                                <div style="flex:1;background:rgba(255,255,255,0.01);padding:6px 8px;border-radius:4px;">
                                    <div style="font-weight:bold;color:#a78bfa;margin-bottom:2px;">参考文案:</div>
                                    <div style="word-break:break-all;line-height:1.4;">${highlightScriptText(diff)}</div>
                                </div>
                                <div style="flex:1;background:rgba(255,255,255,0.01);padding:6px 8px;border-radius:4px;">
                                    <div style="font-weight:bold;color:#60a5fa;margin-bottom:2px;">识别文案:</div>
                                    <div style="word-break:break-all;line-height:1.4;">${highlightRecognizedText(diff)}</div>
                                </div>
                            </div>

                            ${diffHtml}

                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <span style="font-size:11px;color:#80c0ff;font-weight:bold;">✏️ 该片段最终剪辑的字幕片段（可微调）：</span>
                                <textarea class="ae-edit-input" data-idx="${idx}" style="width:100%;min-height:54px;background:#1e1e38;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:8px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit;line-height:1.45;word-break:break-all;">${escapeHtml(m.scriptText)}</textarea>
                            </div>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="ae-mismatch-card ae-mismatch-ok-card" id="ae-card-item-${itemIdx}" data-idx="${idx}" style="background:rgba(16,185,129,0.02);border:1px solid rgba(16,185,129,0.15);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;">
                            <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,0.03);padding-bottom:8px;flex-direction:column;gap:4px;">
                                <div style="display:flex;justify-content:space-between;align-items:center;width:100%;">
                                    <div style="display:flex;gap:12px;align-items:center;">
                                        <span style="font-weight:bold;font-size:12px;color:#a7f3d0;background:rgba(16,185,129,0.2);padding:2px 6px;border-radius:4px;">最终顺序 #${itemIdx + 1}</span>
                                        <span style="font-size:12px;color:#a3aed0;">原序号 #${m.sourceIndex + 1}</span>
                                        <button class="btn btn-secondary" onclick="window.playVideoClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.start || 0}, ${m.end || 0})" style="font-size: 10px; padding: 1px 6px; background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); color: #60a5fa; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">▶️ 播放片段</button>
                                    </div>
                                    <div style="display:flex;gap:8px;align-items:center;">
                                        <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#a3aed0;margin-right:4px;" title="调整此视频片段的播放速度（同时加快声音与画面）">
                                            <span>⚡️倍速:</span>
                                            <select class="ae-clip-speed" data-idx="${idx}" style="background:#1e1e38;color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:1px 4px;font-size:10px;outline:none;cursor:pointer;line-height:1.2;">
                                                <option value="1.0" ${m.speed === 1.0 || !m.speed ? 'selected' : ''}>1.0x</option>
                                                <option value="1.1" ${m.speed === 1.1 ? 'selected' : ''}>1.1x</option>
                                                <option value="1.2" ${m.speed === 1.2 ? 'selected' : ''}>1.2x</option>
                                                <option value="1.25" ${m.speed === 1.25 ? 'selected' : ''}>1.25x</option>
                                                <option value="1.3" ${m.speed === 1.3 ? 'selected' : ''}>1.3x</option>
                                                <option value="1.5" ${m.speed === 1.5 ? 'selected' : ''}>1.5x</option>
                                                <option value="1.75" ${m.speed === 1.75 ? 'selected' : ''}>1.75x</option>
                                                <option value="2.0" ${m.speed === 2.0 ? 'selected' : ''}>2.0x</option>
                                            </select>
                                        </div>
                                        <span style="font-size:11px;background:rgba(16,185,129,0.2);color:#34d399;padding:2px 8px;border-radius:4px;font-weight:600;">✅ 匹配一致 (${m.similarity}%)</span>
                                        <button class="btn btn-secondary" onclick="window.retranscribeAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.35); color: #818cf8; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;" title="清除此视频的转录缓存并重新转录语音">🎙️ 重录</button>
                                        <button class="btn btn-secondary" onclick="window.replaceAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #4ade80; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">🔄 替换</button>
                                        <button class="btn btn-secondary" onclick="window.removeAutoEditClip('${m.clipPath.replace(/\\/g, '\\\\')}', ${m.sourceIndex})" style="font-size: 10px; padding: 1px 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #ccc; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;" title="将此视频片段从工作区排除">🔕 忽略</button>
                                    </div>
                                </div>
                                <div style="font-size:12px;color:#e8ecff;word-break:break-all;font-weight:bold;margin-top:2px;">
                                    📹 文件名: ${escapeHtml(m.fileName)}
                                </div>
                                <div style="font-size:11px;color:#8b95c0;word-break:break-all;font-family:monospace;margin-top:2px;">
                                    📁 完整路径: ${escapeHtml(m.clipPath)}
                                </div>
                            </div>

                            <div style="display:flex;gap:10px;font-size:12px;color:#aab;">
                                <div style="flex:1;background:rgba(255,255,255,0.01);padding:6px 8px;border-radius:4px;">
                                    <div style="font-weight:bold;color:#a78bfa;margin-bottom:2px;">参考文案:</div>
                                    <div style="word-break:break-all;line-height:1.4;">${highlightScriptText(diff)}</div>
                                </div>
                                <div style="flex:1;background:rgba(255,255,255,0.01);padding:6px 8px;border-radius:4px;">
                                    <div style="font-weight:bold;color:#60a5fa;margin-bottom:2px;">识别文案:</div>
                                    <div style="word-break:break-all;line-height:1.4;">${highlightRecognizedText(diff)}</div>
                                </div>
                            </div>

                            ${diffHtml}

                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <span style="font-size:11px;color:#80c0ff;font-weight:bold;">✏️ 该片段最终剪辑的字幕片段（可微调）：</span>
                                <textarea class="ae-edit-input" data-idx="${idx}" style="width:100%;min-height:54px;background:#1e1e38;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:8px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit;line-height:1.45;word-break:break-all;">${escapeHtml(m.scriptText)}</textarea>
                            </div>
                        </div>
                    `;
                }
            } else if (item.type === 'missing') {
                const b = item.data;
                const rawStart = cleanedToRawIndex[b.startLine] !== undefined ? cleanedToRawIndex[b.startLine] + 1 : b.startLine + 1;
                const rawEnd = cleanedToRawIndex[b.endLine] !== undefined ? cleanedToRawIndex[b.endLine] + 1 : b.endLine + 1;
                html += `
                    <div class="ae-mismatch-card ae-missing-card" id="ae-card-item-${itemIdx}" data-missing-idx="${item.originalIndex}" style="background:rgba(239,68,68,0.03);border:1px dashed rgba(239,68,68,0.3);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;">
                         <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.03);padding-bottom:8px;">
                             <div style="display:flex;gap:12px;align-items:center;">
                                 <span style="font-weight:bold;font-size:12px;color:#ff9e9e;background:rgba(239,68,68,0.2);padding:2px 6px;border-radius:4px;">最终顺序 #${itemIdx + 1}</span>
                                 <span style="font-size:11px;background:rgba(239,68,68,0.25);color:#ef4444;padding:2px 6px;border-radius:4px;font-weight:600;">🚫 漏读/丢失文案</span>
                             </div>
                             <div style="display:flex;gap:6px;align-items:center;">
                                 <button class="btn btn-secondary ae-btn-ignore-missing" style="font-size: 10px; padding: 1px 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); color: #ccc; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">🔕 忽略</button>
                                 <button class="btn btn-secondary ae-btn-copy-missing" data-text="${escapeHtml(b.text)}" style="font-size: 10px; padding: 1px 6px; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.35); color: #818cf8; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">📋 复制文案</button>
                                 <button class="btn btn-secondary" onclick="window.addSupplementaryClip(${b.startLine})" style="font-size: 10px; padding: 1px 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #4ade80; border-radius: 4px; cursor: pointer; line-height: 1.2; display: inline-flex; align-items: center; gap: 3px;">➕ 补充片段并重新对齐</button>
                             </div>
                         </div>
                         <div style="font-size:12px;color:#fca5a5;font-weight:bold;">参考文案中被遗漏的句子 (对应行号: ${rawStart} - ${rawEnd}):</div>
                         <div style="background:#1a1a30;padding:10px;border-radius:6px;font-size:12px;color:#ff9e9e;line-height:1.45;word-break:break-all;border:1px solid rgba(239,68,68,0.15);">${escapeHtml(b.text)}</div>
                    </div>
                `;
            }
        });

        html += `
                    </div>
                </div>
            </div>
            
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">
                <button id="ae-mismatch-btn-view-report" class="btn btn-secondary" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;margin-right:auto;background:rgba(34, 197, 94, 0.1);border:1px solid rgba(34, 197, 94, 0.3);color: #4ade80;">📊 查看对齐报告</button>
                <button id="ae-mismatch-btn-skip" class="btn btn-secondary" style="padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;">⏭️ 取消</button>
                <button id="ae-mismatch-btn-use-edited" style="
                    padding:6px 20px;border-radius:6px;border:1px solid #4f46e5;
                    background:linear-gradient(135deg,#4f46e5,#3730a3);color:#fff;
                    font-size:13px;cursor:pointer;font-weight:600;
                    transition:all 0.15s;
                ">🚀 应用修改并继续对齐 (推荐)</button>
            </div>
        `;

        content.innerHTML = html;
        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => document.body.removeChild(modal);

        function updateCardText(idx) {
            const m = mismatches[idx];
            if (!m) return;

            const card = modal.querySelector(`.ae-mismatch-card[data-idx="${idx}"]`);
            if (!card) return;

            const wordsA = tokenizeTextForDiff(m.recognizedText);
            const wordsBWithIndices = tokenizeTextWithIndices(m.scriptText);
            const wordsB = wordsBWithIndices.map(t => t.word);
            const diff = _autoEditLcsWordDiff(wordsA, wordsB);

            let missingWordCount = 0;
            let extraWordCount = 0;
            let bIdx = 0;
            diff.forEach((d, index) => {
                d.diffIdx = index;
                if (d.type === 'add') {
                    d.wordIdx = missingWordCount++;
                } else if (d.type === 'remove') {
                    d.wordIdx = extraWordCount++;
                }
                if (d.type === 'same' || d.type === 'add') {
                    if (wordsBWithIndices[bIdx]) {
                        d.charStart = wordsBWithIndices[bIdx].start;
                        d.charEnd = wordsBWithIndices[bIdx].end;
                    }
                    bIdx++;
                }
            });

            const missingTags = Array.from(card.querySelectorAll('.ae-missing-tag'));
            const recWords = Array.from(card.querySelectorAll('.ae-rec-word'));

            let resultText = '';
            let lastIdx = 0;
            for (let k = 0; k < diff.length; k++) {
                const d = diff[k];
                if (d.type === 'same') {
                    const tag = recWords.find(t => parseInt(t.dataset.diffIdx, 10) === k);
                    const isKeep = tag ? tag.classList.contains('active') : true;
                    if (isKeep) {
                        if (d.charEnd !== undefined) {
                            resultText += m.scriptText.substring(lastIdx, d.charEnd);
                            lastIdx = d.charEnd;
                        }
                    } else {
                        if (d.charStart !== undefined) {
                            resultText += m.scriptText.substring(lastIdx, d.charStart);
                            lastIdx = d.charEnd; // Skip the token but consume its range
                        }
                    }
                } else if (d.type === 'add') {
                    const tag = missingTags.find(t => parseInt(t.dataset.wordIdx, 10) === d.wordIdx);
                    const isKeep = tag ? tag.classList.contains('active') : true;
                    if (isKeep) {
                        if (d.charEnd !== undefined) {
                            resultText += m.scriptText.substring(lastIdx, d.charEnd);
                            lastIdx = d.charEnd;
                        }
                    } else {
                        if (d.charStart !== undefined) {
                            resultText += m.scriptText.substring(lastIdx, d.charStart);
                            lastIdx = d.charEnd; // Skip the token but consume its range
                        }
                    }
                } else if (d.type === 'remove') {
                    const tag = recWords.find(t => parseInt(t.dataset.diffIdx, 10) === k);
                    const isAdd = tag ? tag.classList.contains('active') : false;
                    if (isAdd) {
                        const isWide = (str) => /[^\x00-\xff]/.test(str);
                        const prevChar = resultText.slice(-1);
                        const needSpace = prevChar && prevChar !== ' ' && prevChar !== '\n' && !isWide(prevChar) && !isWide(d.word);
                        resultText += (needSpace ? ' ' : '') + d.word;
                    }
                }
            }
            if (lastIdx < m.scriptText.length) {
                resultText += m.scriptText.substring(lastIdx);
            }

            const input = card.querySelector('.ae-edit-input');
            if (input) input.value = resultText;
        }

        // Setup event listener to click left-side lines to scroll right-side cards
        const lineElements = modal.querySelectorAll('.ae-script-line');
        lineElements.forEach(el => {
            el.addEventListener('click', () => {
                const targetIdx = parseInt(el.dataset.targetCardIdx, 10);
                if (targetIdx !== -1 && !isNaN(targetIdx)) {
                    // Highlight selected line
                    lineElements.forEach(le => {
                        le.style.background = 'rgba(255,255,255,0.02)';
                        le.style.color = '#cbd5e1';
                    });
                    el.style.background = 'rgba(99,102,241,0.2)';
                    el.style.color = '#fff';

                    // Find target card
                    const targetCard = modal.querySelector(`#ae-card-item-${targetIdx}`);
                    if (targetCard) {
                        // Scroll to card
                        targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                        
                        // Add glow highlight to the card
                        const originalBorder = targetCard.style.borderColor;
                        const originalBg = targetCard.style.background;
                        targetCard.style.transition = 'all 0.3s ease';
                        targetCard.style.borderColor = '#6366f1';
                        targetCard.style.boxShadow = '0 0 15px rgba(99,102,241,0.4)';
                        targetCard.style.background = 'rgba(99,102,241,0.08)';
                        
                        setTimeout(() => {
                            targetCard.style.borderColor = originalBorder;
                            targetCard.style.boxShadow = 'none';
                            targetCard.style.background = originalBg;
                        }, 1200);
                    }
                }
            });
        });

        // Setup event listener to click right-side cards to scroll left-side script lines
        const cardElements = modal.querySelectorAll('.ae-mismatch-card');
        cardElements.forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('button, textarea, input, .ae-word-tag') || card.classList.contains('ae-card-ignored')) {
                    return;
                }
                
                const idAttr = card.getAttribute('id') || '';
                const matchIdx = idAttr.match(/^ae-card-item-(\d+)$/);
                if (matchIdx) {
                    const itemIdx = parseInt(matchIdx[1], 10);
                    
                    // Highlight card itself
                    cardElements.forEach(c => {
                        c.classList.remove('selected-card-glow');
                    });
                    card.classList.add('selected-card-glow');
                    
                    // Find all matching script lines on the left
                    const targetLines = modal.querySelectorAll(`.ae-script-line[data-target-card-idx="${itemIdx}"]`);
                    if (targetLines.length > 0) {
                        // Highlight target lines on the left
                        lineElements.forEach(le => {
                            le.style.background = 'rgba(255,255,255,0.02)';
                            le.style.color = '#cbd5e1';
                        });
                        
                        targetLines.forEach(tl => {
                            tl.style.background = 'rgba(99, 102, 241, 0.2)';
                            tl.style.color = '#fff';
                        });
                        
                        // Scroll first matching line into view inside container
                        const firstLine = targetLines[0];
                        firstLine.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }
            });
        });

        // Setup copy missing text buttons click listener
        modal.querySelectorAll('.ae-btn-copy-missing').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const text = btn.getAttribute('data-text');
                window.copyTextToClipboard(text);
            });
        });

        // Setup ignore missing text buttons click listener
        modal.querySelectorAll('.ae-btn-ignore-missing').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const card = btn.closest('.ae-missing-card');
                if (card) {
                    card.classList.toggle('ae-card-ignored');
                    const isIgnored = card.classList.contains('ae-card-ignored');
                    if (isIgnored) {
                        btn.textContent = '🔔 已忽略';
                        btn.style.background = 'rgba(34, 197, 94, 0.15)';
                        btn.style.borderColor = 'rgba(34, 197, 94, 0.35)';
                        btn.style.color = '#4ade80';
                    } else {
                        btn.textContent = '🔕 忽略';
                        btn.style.background = 'rgba(255,255,255,0.06)';
                        btn.style.borderColor = 'rgba(255,255,255,0.15)';
                        btn.style.color = '#ccc';
                    }
                }
            });
        });

        // Initialize diff logic and tags event listeners
        sequenceItems.forEach((item) => {
            if (item.type === 'clip') {
                const idx = item.originalIndex;
                const m = mismatches[idx];
                const card = modal.querySelector(`.ae-mismatch-card[data-idx="${idx}"]`);
                if (card && m) {
                    const cardDiffData = prepareCardDiff(m);
                    const diff = cardDiffData.diff;

                    // Bind missing word tags
                    card.querySelectorAll('.ae-missing-tag').forEach(tag => {
                        tag.addEventListener('click', () => {
                            tag.classList.toggle('active');
                            if (tag.classList.contains('active')) {
                                tag.style.background = 'rgba(239,68,68,0.18)';
                                tag.style.color = '#ff9e9e';
                                tag.style.borderColor = 'rgba(239,68,68,0.4)';
                                tag.style.textDecoration = 'none';
                            } else {
                                tag.style.background = 'rgba(255,255,255,0.03)';
                                tag.style.color = '#777';
                                tag.style.borderColor = 'rgba(255,255,255,0.06)';
                                tag.style.textDecoration = 'line-through';
                            }
                            updateCardText(idx);
                        });
                    });

                    // Bind extra word tags
                    card.querySelectorAll('.ae-extra-tag').forEach(tag => {
                        tag.addEventListener('click', () => {
                            tag.classList.toggle('active');
                            const wordIdx = parseInt(tag.dataset.wordIdx, 10);
                            
                            // Find corresponding diff item and sync it
                            const extraWord = diff.find(d => d.type === 'remove' && d.wordIdx === wordIdx);
                            if (extraWord) {
                                const recTag = card.querySelector(`.ae-rec-word.ae-rec-extra[data-diff-idx="${extraWord.diffIdx}"]`);
                                if (recTag) {
                                    if (tag.classList.contains('active')) {
                                        recTag.classList.add('active');
                                        recTag.style.background = 'rgba(245,158,11,0.22)';
                                        recTag.style.color = '#ffd84a';
                                        recTag.style.textDecoration = 'none';
                                        recTag.style.opacity = '1';
                                        recTag.style.borderBottom = '2px solid #f59e0b';
                                    } else {
                                        recTag.classList.remove('active');
                                        recTag.style.background = 'rgba(255,255,255,0.03)';
                                        recTag.style.color = '#777';
                                        recTag.style.textDecoration = 'line-through';
                                        recTag.style.opacity = '0.5';
                                        recTag.style.borderBottom = 'none';
                                    }
                                }
                            }

                            if (tag.classList.contains('active')) {
                                tag.style.background = 'rgba(245,158,11,0.2)';
                                tag.style.color = '#ffd84a';
                                tag.style.borderColor = 'rgba(245,158,11,0.4)';
                                tag.style.textDecoration = 'none';
                            } else {
                                tag.style.background = 'rgba(255,255,255,0.03)';
                                tag.style.color = '#777';
                                tag.style.borderColor = 'rgba(255,255,255,0.06)';
                                tag.style.textDecoration = 'line-through';
                            }
                            updateCardText(idx);
                        });
                    });

                    // Bind clickable recognized text words
                    card.querySelectorAll('.ae-rec-word').forEach(tag => {
                        tag.addEventListener('click', () => {
                            tag.classList.toggle('active');
                            const diffIdx = parseInt(tag.dataset.diffIdx, 10);
                            const isSame = tag.classList.contains('ae-rec-same');
                            
                            if (tag.classList.contains('active')) {
                                if (isSame) {
                                    tag.style.background = 'rgba(255,255,255,0.02)';
                                    tag.style.color = '#cbd5e1';
                                    tag.style.textDecoration = 'none';
                                    tag.style.opacity = '1';
                                } else {
                                    tag.style.background = 'rgba(245,158,11,0.22)';
                                    tag.style.color = '#ffd84a';
                                    tag.style.textDecoration = 'none';
                                    tag.style.opacity = '1';
                                    tag.style.borderBottom = '2px solid #f59e0b';
                                }
                            } else {
                                tag.style.background = 'rgba(255,255,255,0.03)';
                                tag.style.color = '#777';
                                tag.style.textDecoration = 'line-through';
                                tag.style.opacity = '0.5';
                                tag.style.borderBottom = 'none';
                            }

                            // Sync with extra tag panel if applicable
                            if (!isSame) {
                                const extraWord = diff[diffIdx];
                                if (extraWord) {
                                    const panelTag = card.querySelector(`.ae-extra-tag[data-word-idx="${extraWord.wordIdx}"]`);
                                    if (panelTag) {
                                        if (tag.classList.contains('active')) {
                                            panelTag.classList.add('active');
                                            panelTag.style.background = 'rgba(245,158,11,0.2)';
                                            panelTag.style.color = '#ffd84a';
                                            panelTag.style.borderColor = 'rgba(245,158,11,0.4)';
                                            panelTag.style.textDecoration = 'none';
                                        } else {
                                            panelTag.classList.remove('active');
                                            panelTag.style.background = 'rgba(255,255,255,0.03)';
                                            panelTag.style.color = '#777';
                                            panelTag.style.borderColor = 'rgba(255,255,255,0.06)';
                                            panelTag.style.textDecoration = 'line-through';
                                        }
                                    }
                                }
                            }

                            updateCardText(idx);
                        });
                    });

                    updateCardText(idx);
                }
            }
        });

        modal.querySelector('#ae-mismatch-btn-close').addEventListener('click', () => { cleanup(); resolve(null); });
        modal.querySelector('#ae-mismatch-btn-skip').addEventListener('click', () => { cleanup(); resolve(null); });

        const viewReportBtn = modal.querySelector('#ae-mismatch-btn-view-report');
        if (viewReportBtn) {
            viewReportBtn.addEventListener('click', () => {
                viewAutoEditReport();
            });
        }

        modal.querySelector('#ae-mismatch-btn-use-edited').addEventListener('click', () => {
            const clipEdits = [];
            mismatches.forEach((m, idx) => {
                const card = modal.querySelector(`.ae-mismatch-card[data-idx="${idx}"]`);
                const input = card ? card.querySelector('.ae-edit-input') : null;
                const speedSelect = card ? card.querySelector('.ae-clip-speed') : null;
                const speed = speedSelect ? parseFloat(speedSelect.value) : 1.0;
                const finalText = input ? input.value : m.scriptText;
                if (finalText === m.scriptText && speed === (m.speed || 1.0)) return;
                clipEdits.push({
                    clipIndex: m.clipIndex,
                    originalScript: m.scriptText,
                    finalText,
                    speed
                });
            });
            const ignoredMissingBlocks = Array.from(modal.querySelectorAll('.ae-missing-card.ae-card-ignored'))
                .map(card => missingBlocks[parseInt(card.dataset.missingIdx, 10)])
                .filter(Boolean);
            window.showAutoEditModalLoading('🚀 正在应用您的修改并重新对齐，请稍候...');
            resolve({ clipEdits, ignoredMissingBlocks, confirmed: true });
        });
    });
}

async function startAutoEditByScript(isRetry = false, options = {}) {
    if (autoEditFiles.length === 0) {
        showToast('请先选择视频片段', 'error');
        return;
    }

    const scriptText = options.scriptTextOverride ?? document.getElementById('autoedit-script')?.value ?? '';
    const scriptLines = String(scriptText || '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    if (scriptLines.length === 0) {
        showToast('请先粘贴断行文案', 'error');
        return;
    }
    const matchMode = document.getElementById('autoedit-match-mode')?.value || 'script';
    if (matchMode === 'line_per_clip' && autoEditFiles.length !== scriptLines.length) {
        showToast(`一行一片段模式下数量不一致，将处理前 ${Math.min(autoEditFiles.length, scriptLines.length)} 组`, 'info', 6000);
    }
    if (document.getElementById('autoedit-voicechanger-enabled')?.checked && !document.getElementById('autoedit-voicechanger-voice')?.value?.trim()) {
        showToast('请先选择或填写 ElevenLabs Voice ID', 'error');
        return;
    }

    const outputDir = options.outputDirOverride ?? document.getElementById('media-output-path')?.value ?? '';
    const requestSettings = options.requestSettingsOverride || getAutoEditRequestSettings();
    const requestId = options.requestId || `autoedit-single-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const statusEl = document.getElementById('autoedit-status');
    const startBtn = document.getElementById('autoedit-start-btn');
    const progressSection = document.getElementById('autoedit-progress-section');
    const progressText = document.getElementById('autoedit-progress-text');
    const progressBar = document.querySelector('#autoedit-progress-bar .progress-bar-inner');
    const resultSection = document.getElementById('autoedit-result-section');

    const mainReportBtn = document.getElementById('autoedit-main-view-report-btn');
    if (mainReportBtn) mainReportBtn.style.display = 'none';
    const mainReopenBtn = document.getElementById('autoedit-main-reopen-dialog-btn');
    if (mainReopenBtn) mainReopenBtn.style.display = 'none';

    startBtn.disabled = true;
    startBtn.textContent = '⏳ 正在自动剪辑...';
    statusEl.textContent = `⏳ 正在匹配 ${autoEditFiles.length} 个片段与 ${scriptLines.length} 行字幕文案...`;
    statusEl.style.color = 'var(--accent)';
    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    if (progressBar) progressBar.style.width = '12%';
    progressText.textContent = '正在转录并匹配文案，较长视频会需要一些时间...';

    // Initialize individual clip statuses to pending
    autoEditFiles.forEach(f => {
        f.status = 'pending';
        f.error = null;
    });
    renderAutoEditFiles();

    if (typeof autoEditProgressUnsubscribe === 'function') {
        autoEditProgressUnsubscribe();
        autoEditProgressUnsubscribe = null;
    }
    if (window.electronAPI?.onAutoEditProgress) {
        autoEditProgressUnsubscribe = window.electronAPI.onAutoEditProgress((progress = {}) => {
            if (progress.request_id && progress.request_id !== requestId) return;
            const pct = Math.max(0, Math.min(100, Number(progress.percent) || 0));
            if (progressBar) progressBar.style.width = `${pct}%`;
            const msg = progress.message || '正在处理...';
            progressText.textContent = msg;
            statusEl.textContent = `⏳ ${msg}`;

            // Update modal loading overlay elements if present
            const modalTitle = document.getElementById('ae-modal-loading-title');
            const modalSubtitle = document.getElementById('ae-modal-loading-subtitle');
            const modalProgressContainer = document.getElementById('ae-modal-loading-progress-bar-container');
            const modalProgressBar = document.getElementById('ae-modal-loading-progress-bar');
            
            if (modalTitle || modalSubtitle) {
                if (modalProgressContainer) modalProgressContainer.style.display = 'block';
                if (modalProgressBar) modalProgressBar.style.width = `${pct}%`;
                if (modalSubtitle) modalSubtitle.textContent = `${msg} (${pct}%)`;
            }

            // Update individual clip status in real-time
            if (progress.clip_index !== undefined && progress.clip_status) {
                const idx = progress.clip_index;
                if (autoEditFiles[idx]) {
                    autoEditFiles[idx].status = progress.clip_status;
                    if (progress.clip_error) {
                        autoEditFiles[idx].error = progress.clip_error;
                    }
                    renderAutoEditFiles();
                }
            }
        });
    }

    try {
        const resp = await apiFetch(`${API_BASE}/media/convert`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clips: autoEditFiles.map(f => f.path),
                files: autoEditFiles.map(f => f.path),
                mode: 'auto_edit',
                request_id: requestId,
                ignore_mismatch: autoEditIgnoreMismatch || (options.reviewSegments?.length > 0),
                force_mismatch: (options.analysisOnly || options.reviewSegments?.length > 0) ? false : (document.getElementById('autoedit-force-mismatch')?.checked || false),
                analysis_only: options.analysisOnly === true,
                review_segments: options.reviewSegments || [],
                clip_speeds: autoEditFiles.reduce((map, f) => {
                    if (f.speed && f.speed !== 1.0) {
                        map[f.path] = f.speed;
                    }
                    return map;
                }, {}),
                script_text: scriptText,
                output_dir: outputDir,
                ...requestSettings,
                manual_subtitle_map: autoEditFiles.reduce((map, f) => {
                    if (f.manualSubtitlePath) {
                        map[f.path] = f.manualSubtitlePath;
                    }
                    return map;
                }, {}),
                manual_transcripts: autoEditFiles.reduce((map, f) => {
                    if (f.manualTranscript) {
                        map[f.path] = f.manualTranscript;
                    }
                    return map;
                }, {}),
            })
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '文案自动剪辑失败');

        // 标记最终播放顺序，但保留用户选择/文件名排序后的输入顺序。
        // 后续重新匹配仍会使用这个稳定输入顺序，避免上一次输出顺序反过来影响下一次匹配结果。
        const segments = data.segments || [];
        autoEditFiles.forEach((file) => {
            const matchedSeg = segments.find(seg => seg.source === file.path);
            if (matchedSeg) {
                file.outputIndex = matchedSeg.index;
                file.matchScore = matchedSeg.match_score;
                const isTextEmpty = !matchedSeg.recognized_text || matchedSeg.recognized_text.trim() === '' || matchedSeg.recognized_text.startsWith('(转录失败:');
                if (matchedSeg.transcription_source === 'failed') {
                    file.status = 'failed';
                    file.error = String(matchedSeg.recognized_text || '识别服务失败').replace(/^\(转录失败:\s*|\)$/g, '');
                } else if (isTextEmpty) {
                    file.status = 'empty';
                    file.error = '识别服务未返回有效文字结果，请重新识别';
                } else {
                    file.status = matchedSeg.match_score > 0 ? 'transcribed' : 'unmatched';
                }
            } else {
                file.outputIndex = 9999;
                file.status = 'unmatched';
            }
        });
        renderAutoEditFiles();

        if (progressBar) progressBar.style.width = '100%';
        progressText.textContent = data.analysis_only ? '✅ 分析完成，请审核时间线' : '✅ 自动剪辑完成';
        statusEl.textContent = `✅ ${data.message || '自动剪辑完成'}`;
        statusEl.style.color = 'var(--success)';
        autoEditOutputDir = data.output_dir || '';
        autoEditLastResult = data;

        const mainReportBtn = document.getElementById('autoedit-main-view-report-btn');
        if (mainReportBtn) mainReportBtn.style.display = 'inline-block';
        const mainReopenBtn = document.getElementById('autoedit-main-reopen-dialog-btn');
        if (mainReopenBtn) mainReopenBtn.style.display = 'inline-block';

        renderAutoEditResult(data);
        resultSection.classList.remove('hidden');
        const sendBtn = document.getElementById('autoedit-send-reels-btn');
        if (sendBtn) sendBtn.style.display = '';
        if (!data.analysis_only && document.getElementById('autoedit-send-reels')?.checked) {
            try {
                await sendAutoEditResultToReels(data, { silent: true });
            } catch (sendError) {
                console.warn('[AutoEdit] send to Reels failed:', sendError);
            }
        }
        autoEditIgnoreMismatch = false;
        if (autoEditActiveBatchIndex >= 0 && autoEditBatchTasks[autoEditActiveBatchIndex]) {
            const task = autoEditBatchTasks[autoEditActiveBatchIndex];
            task.result = data;
            const warnings = (data.segments || []).filter(segment => segment.status === 'warning').length;
            task.status = data.analysis_only && warnings ? 'warning' : 'ready';
            task.message = data.analysis_only ? (warnings ? `${warnings} 项待审核` : '重新分析通过') : '导出完成';
            if (!data.analysis_only) autoEditActiveBatchIndex = -1;
        }
        // Close any open mismatch dialogs on success
        const mismatchOverlay = document.getElementById('ae-mismatch-dialog-overlay');
        if (mismatchOverlay) mismatchOverlay.remove();

        showToast(data.analysis_only ? '分析完成，请审核后正式导出' : '文案自动剪辑完成', 'success');
    } catch (error) {
        if (error.message.includes('"code":"AUTOEDIT_TEXT_MISMATCH"')) {
            try {
                const mismatchData = JSON.parse(error.message);
                const mismatches = mismatchData.mismatches;
                
                autoEditLastResult = {
                    report_path: mismatchData.report_path,
                    output_dir: mismatchData.output_dir
                };
                autoEditOutputDir = mismatchData.output_dir || '';
                
                const mainReportBtn = document.getElementById('autoedit-main-view-report-btn');
                if (mainReportBtn) mainReportBtn.style.display = 'inline-block';
                const mainReopenBtn = document.getElementById('autoedit-main-reopen-dialog-btn');
                if (mainReopenBtn) mainReopenBtn.style.display = 'inline-block';
                
                const dialogResult = await _showAutoEditMismatchDialog(mismatches, scriptText, mismatchData.missingBlocks || []);
                const clipEdits = Array.isArray(dialogResult) ? dialogResult : (dialogResult?.clipEdits || []);
                const ignoredMissingBlocks = Array.isArray(dialogResult) ? [] : (dialogResult?.ignoredMissingBlocks || []);
                if (dialogResult && (dialogResult.confirmed || clipEdits.length > 0 || ignoredMissingBlocks.length > 0)) {
                    const rawLines = scriptText.replace(/\r\n/g, '\n').split('\n');
                    const cleanedToRawIndex = [];
                    for (let i = 0; i < rawLines.length; i++) {
                        if (rawLines[i].trim().length > 0) {
                            cleanedToRawIndex.push(i);
                        }
                    }
                    const operations = [];
                    for (const r of clipEdits) {
                        const mismatch = mismatches.find(m => m.clipIndex === r.clipIndex);
                        if (!mismatch) continue;
                        const fileObj = autoEditFiles.find(f => f.path === mismatch.clipPath);
                        if (fileObj) {
                            fileObj.speed = r.speed || 1.0;
                        }
                        if (mismatch.similarity >= 50 && mismatch.scriptStartLine !== -1) {
                            const cleanStart = mismatch.scriptStartLine;
                            const cleanEnd = mismatch.scriptEndLine;
                            operations.push({
                                cleanStart,
                                cleanEnd,
                                newLines: r.finalText.replace(/\r\n/g, '\n').split('\n'),
                            });
                        } else {
                            const fileObj = autoEditFiles.find(f => f.path === mismatch.clipPath);
                            if (fileObj) {
                                fileObj.manualTranscript = r.finalText;
                                console.log(`[src/app.js] Low similarity mismatch detected (${mismatch.similarity}%). Stored manual transcript override for re-alignment:`, r.finalText);
                            }
                        }
                    }
                    for (const block of ignoredMissingBlocks) {
                        operations.push({
                            cleanStart: block.startLine,
                            cleanEnd: block.endLine,
                            newLines: [],
                        });
                    }
                    operations.sort((a, b) => {
                        if (b.cleanStart !== a.cleanStart) return b.cleanStart - a.cleanStart;
                        return b.cleanEnd - a.cleanEnd;
                    });
                    for (const op of operations) {
                        const rawStart = cleanedToRawIndex[op.cleanStart];
                        const rawEnd = cleanedToRawIndex[op.cleanEnd];
                        if (rawStart === undefined || rawEnd === undefined) continue;
                        rawLines.splice(rawStart, rawEnd - rawStart + 1, ...op.newLines);
                    }
                    const newScriptText = rawLines.join('\n');
                    autoEditIgnoreMismatch = true;
                    setTimeout(() => {
                        startAutoEditByScript(true, { scriptTextOverride: newScriptText });
                    }, 100);
                    return;
                } else {
                    const mismatchOverlay = document.getElementById('ae-mismatch-dialog-overlay');
                    if (mismatchOverlay) mismatchOverlay.remove();

                    statusEl.textContent = '❌ 用户取消剪辑 (文案不匹配)';
                    statusEl.style.color = 'var(--error)';
                    progressText.textContent = '❌ 取消剪辑';
                    return;
                }
            } catch (e) {
                console.error('[AutoEdit] Mismatch dialog error:', e);
                const mismatchOverlay = document.getElementById('ae-mismatch-dialog-overlay');
                if (mismatchOverlay) mismatchOverlay.remove();
            }
        } else {
            const mismatchOverlay = document.getElementById('ae-mismatch-dialog-overlay');
            if (mismatchOverlay) mismatchOverlay.remove();
        }
        autoEditIgnoreMismatch = false;
        statusEl.textContent = `❌ ${escapeHtml(error.message)}`;
        statusEl.style.color = 'var(--error)';
        progressText.textContent = `❌ 失败: ${escapeHtml(error.message)}`;
        showToast(`文案自动剪辑失败: ${escapeHtml(error.message)}`, 'error');
    } finally {
        if (typeof autoEditProgressUnsubscribe === 'function') {
            autoEditProgressUnsubscribe();
            autoEditProgressUnsubscribe = null;
        }
        startBtn.disabled = false;
        startBtn.textContent = '① 快速分析与匹配';
        renderAutoEditFiles();
    }
}

function renderAutoEditResult(data) {
    const root = document.getElementById('autoedit-result-list');
    if (!root) return;
    const files = [
        data.output_path ? { label: '拼接视频', path: data.output_path } : null,
        data.final_video_path && data.final_video_path !== data.output_path ? { label: '最终视频', path: data.final_video_path } : null,
        data.srt_path ? { label: '最终字幕', path: data.srt_path } : null,
        data.mp3_path ? { label: 'Voice Changer MP3', path: data.mp3_path } : null,
        data.voice_changed_mp3_path ? { label: '变声 MP3', path: data.voice_changed_mp3_path } : null,
        data.voice_changed_video_path ? { label: '变声视频', path: data.voice_changed_video_path } : null,
        data.manual_audio_path ? { label: '手动新音频', path: data.manual_audio_path } : null,
        data.manual_audio_video_path ? { label: '手动换声视频', path: data.manual_audio_video_path } : null,
        data.subtitled_path ? { label: '烧录字幕视频', path: data.subtitled_path } : null,
        data.project_path ? { label: '分析项目', path: data.project_path } : null,
    ].filter(Boolean);
    autoEditResultFiles = files;

    const fileHtml = files.map((f, i) => `
        <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border-color); font-size: 12px;">
            <span style="font-weight: 600; min-width: 90px;">${escapeHtml(f.label)}</span>
            <span title="${escapeHtml(f.path)}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(f.path)}</span>
            <button class="btn btn-secondary" onclick="showAutoEditResultFile(${i})" style="padding: 2px 8px; font-size: 11px; margin-left: auto;">定位</button>
        </div>
    `).join('');

    const segments = data.segments || [];
    const isReview = data.analysis_only === true;
    const settings = data.output_settings || {};
    const originalScriptLines = String(document.getElementById('autoedit-script')?.value || data.script_text || '')
        .split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const scriptLineUsage = new Map();
    segments.forEach(seg => {
        const start = Number(seg.script_start_line);
        const end = Number(seg.script_end_line || seg.script_start_line);
        if (!Number.isFinite(start) || start < 1) return;
        for (let line = start; line <= end; line++) scriptLineUsage.set(line, (scriptLineUsage.get(line) || 0) + 1);
    });
    const coveredScriptLines = originalScriptLines.filter((_, index) => scriptLineUsage.has(index + 1)).length;
    const missingScriptBlocks = [];
    for (let line = 1; line <= originalScriptLines.length; line++) {
        if (scriptLineUsage.has(line)) continue;
        const start = line;
        while (line + 1 <= originalScriptLines.length && !scriptLineUsage.has(line + 1)) line++;
        missingScriptBlocks.push({ start, end: line, text: originalScriptLines.slice(start - 1, line).join('\n') });
    }
    const scriptCoverageHtml = isReview && originalScriptLines.length ? `
        <details open style="margin:10px 0;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-tertiary);padding:10px;">
            <summary style="cursor:pointer;font-weight:700;color:var(--text-secondary);">整体文案覆盖：${coveredScriptLines}/${originalScriptLines.length} 行（${Math.round(coveredScriptLines / originalScriptLines.length * 100)}%） <span id="ae-overall-duplicate-status" class="ae-overall-status"></span> <span id="ae-overall-missing-status" class="ae-overall-status"></span></summary>
            <div style="display:grid;gap:4px;margin-top:9px;max-height:260px;overflow:auto;">
                ${originalScriptLines.map((line, index) => {
                    const usage = scriptLineUsage.get(index + 1) || 0;
                    const color = usage === 0 ? '#ff6b6b' : (usage > 1 ? '#ff9f43' : '#51cf66');
                    const label = usage === 0 ? '未对上' : (usage > 1 ? `重复占用 ×${usage}` : '已对上');
                    return `<div class="ae-coverage-line" onclick="locateAutoEditScriptLine(${index + 1},this)" title="点击快速定位到审核时间线" style="display:grid;grid-template-columns:62px 90px 1fr 58px;gap:7px;align-items:start;padding:5px 7px;border-radius:5px;background:${usage === 0 ? 'rgba(255,107,107,.08)' : (usage > 1 ? 'rgba(255,159,67,.08)' : 'rgba(81,207,102,.045)')};font-size:12px;cursor:pointer;"><span style="color:var(--text-muted);">第 ${index + 1} 行</span><strong style="color:${color};">${label}</strong><span style="white-space:pre-wrap;word-break:break-word;">${escapeHtml(line)}</span><span style="color:#60a5fa;font-weight:700;white-space:nowrap;">🎯 定位</span></div>`;
                }).join('')}
            </div>
        </details>` : '';
    const reviewTextKey = text => String(text || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
    const reviewTextCounts = new Map();
    segments.forEach(seg => {
        const key = reviewTextKey(seg.script);
        if (key) reviewTextCounts.set(key, (reviewTextCounts.get(key) || 0) + 1);
    });
    const reviewDuplicateGroups = new Map();
    let nextDuplicateGroup = 1;
    segments.forEach(seg => {
        const key = reviewTextKey(seg.script);
        if (key && (reviewTextCounts.get(key) || 0) > 1 && !reviewDuplicateGroups.has(key)) {
            reviewDuplicateGroups.set(key, nextDuplicateGroup++);
        }
    });
    const missingPlaceholderHtml = isReview ? missingScriptBlocks.map((block, index) => `
        <div class="autoedit-missing-placeholder" data-warning="true" data-unmatched="true" data-script-start-line="${block.start}" data-script-end-line="${block.end}">
            <div class="ae-missing-placeholder-icon">!</div>
            <div>
                <div class="ae-missing-placeholder-title">缺失占位 #${index + 1} · 文案第 ${block.start}${block.end > block.start ? `–${block.end}` : ''} 行：没有找到对应片段</div>
                <div class="ae-missing-placeholder-text">${escapeHtml(block.text)}</div>
                <div class="ae-missing-placeholder-help">这段内容可能实际已经读过，但因特殊符号、缩写或识别文字差异没有匹配成功。请重点核对上下片段的“目标文案”和“实际识别文字”，确认内容是否被错误分配。</div>
                <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:7px;">
                    <button class="btn btn-secondary" onclick="locateAutoEditScriptLine(${Math.max(1, block.start - 1)})" style="padding:3px 9px;font-size:11px;">↑ 核对上一个片段</button>
                    <button class="btn btn-secondary" onclick="locateAutoEditScriptLine(${Math.min(originalScriptLines.length, block.end + 1)})" style="padding:3px 9px;font-size:11px;">↓ 核对下一个片段</button>
                </div>
            </div>
        </div>`).join('') : '';
    const segmentHtml = segments.length ? `
        <div style="margin-top: 12px;">
            <div style="font-weight: 600; margin-bottom: 8px; color: var(--text-secondary);">${isReview ? '② 审核时间线（可改顺序、字幕和入出点）' : '片段匹配明细'}</div>
            ${isReview ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;padding:7px;background:var(--bg-tertiary);border-radius:6px;">
                <span class="hint">筛选:</span>
                <button class="btn btn-secondary" onclick="filterAutoEditReview('all')" style="padding:3px 9px;font-size:11px;">全部</button>
                <button class="btn btn-secondary" onclick="filterAutoEditReview('warning')" style="padding:3px 9px;font-size:11px;">只看警告</button>
                <button class="btn btn-secondary" onclick="filterAutoEditReview('duplicate')" style="padding:3px 9px;font-size:11px;">只看重复</button>
                <button class="btn btn-secondary" onclick="filterAutoEditReview('unmatched')" style="padding:3px 9px;font-size:11px;">只看未匹配</button>
                <button class="btn btn-secondary" onclick="toggleAllAutoEditDetails(true)" style="padding:3px 9px;font-size:11px;margin-left:auto;">展开异常</button>
                <button class="btn btn-secondary" onclick="toggleAllAutoEditDetails(false)" style="padding:3px 9px;font-size:11px;">全部收起</button>
            </div>` : ''}
            ${missingPlaceholderHtml}
            ${segments.map((seg, reviewIndex) => {
                const duplicateText = (reviewTextCounts.get(reviewTextKey(seg.script)) || 0) > 1;
                const duplicateGroup = reviewDuplicateGroups.get(reviewTextKey(seg.script));
                const matchPercent = Math.round((seg.match_score || 0) * 100);
                const isCriticalMatch = matchPercent < 50;
                const isLowMatch = matchPercent >= 50 && matchPercent < 75;
                const reviewWarning = seg.status === 'warning' || matchPercent < 75;
                const matchRiskBadge = isCriticalMatch
                    ? `<strong class="ae-match-risk-badge ae-match-risk-critical">⛔ 严重低匹配 ${matchPercent}% · 很可能匹配错误</strong>`
                    : (isLowMatch ? `<strong class="ae-match-risk-badge ae-match-risk-low">⚠ 低匹配 ${matchPercent}% · 请重点核对</strong>` : '');
                const reviewUnmatched = !seg.script || !seg.recognized_text;
                const detailsOpen = duplicateText || reviewWarning || reviewUnmatched;
                const srcTag = seg.transcription_source === 'cache'
                    ? '<span style="padding: 1px 4px; border-radius: 3px; font-size: 10px; background: rgba(81,207,102,0.15); color:#51cf66; font-weight:600; text-align:center;">缓存</span>'
                    : (seg.transcription_source === 'gladia'
                        ? '<span style="padding: 1px 4px; border-radius: 3px; font-size: 10px; background: rgba(255,143,0,0.15); color:#ff9f43; font-weight:600; text-align:center;">转录</span>'
                        : (seg.transcription_source === 'failed'
                            ? '<span style="padding: 1px 4px; border-radius: 3px; font-size: 10px; background: rgba(239,68,68,0.15); color:#ef4444; font-weight:600; text-align:center;">失败</span>'
                            : '<span style="padding: 1px 4px; border-radius: 3px; font-size: 10px; background: rgba(255,255,255,0.05); color:var(--text-muted); text-align:center;">-</span>'));
                
                const isUnmatched = !seg.script_start_line || seg.script_start_line === '?';
                const matchedTextHtml = isUnmatched
                    ? '<span style="color: #ff9f43; font-weight: 500;">⚠️ 未匹配到文案或未获得识别结果</span>'
                    : `文案 ${seg.script_start_line}-${seg.script_end_line}: ${escapeHtml(String(seg.script || '').replace(/\s*\n\s*/g, ' / '))}`;
                
                const rowStyle = isUnmatched
                    ? 'display: grid; grid-template-columns: 70px 90px 70px 80px 60px 1fr 100px; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border-color); font-size: 12px; background: rgba(255, 159, 67, 0.05); border-radius: 4px;'
                    : 'display: grid; grid-template-columns: 70px 90px 70px 80px 60px 1fr 100px; gap: 8px; align-items: center; padding: 5px 8px; border-bottom: 1px solid var(--border-color); font-size: 12px;';
                
                if (isReview) return `
                    <div class="autoedit-review-row ${duplicateText ? 'ae-duplicate-row' : ''} ${reviewWarning && !duplicateText ? 'ae-warning-row' : ''} ${isCriticalMatch ? 'ae-critical-match-row' : ''}" data-review-index="${reviewIndex}" data-script-start-line="${Number(seg.script_start_line) || 0}" data-script-end-line="${Number(seg.script_end_line || seg.script_start_line) || 0}" data-source="${escapeHtml(encodeURIComponent(seg.source || ''))}" data-word-timeline="${escapeHtml(encodeURIComponent(JSON.stringify(seg.word_timeline || [])))}" data-original-text-key="${escapeHtml(reviewTextKey(seg.script))}" data-original-script="${escapeHtml(encodeURIComponent(seg.script || ''))}" data-warning="${reviewWarning}" data-critical-match="${isCriticalMatch}" data-duplicate="${duplicateText}" data-unmatched="${reviewUnmatched}" draggable="true" ondragstart="autoEditReviewDragStart(event,${reviewIndex})" ondragover="event.preventDefault()" ondrop="autoEditReviewDrop(event,${reviewIndex})" style="display:grid;grid-template-columns:42px 38px 1fr 112px 112px 90px;gap:8px;align-items:center;padding:10px 8px;border-bottom:1px solid ${duplicateText ? '#ff6b6b' : 'var(--border-color)'};cursor:grab;">
                        <input type="checkbox" class="ae-review-enabled" checked title="是否导出" onchange="handleAutoEditReviewEnabled(this)">
                        <div style="display:flex;flex-direction:column;gap:2px;"><button class="btn btn-secondary" onclick="moveAutoEditReviewRow(${reviewIndex},-1)" style="padding:1px 5px;">↑</button><button class="btn btn-secondary" onclick="moveAutoEditReviewRow(${reviewIndex},1)" style="padding:1px 5px;">↓</button></div>
                        <div><div style="font-size:11px;color:var(--text-muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">#${seg.source_index} · ${escapeHtml((seg.source || '').split(/[/\\]/).pop())} ${matchRiskBadge || `<span>匹配 ${matchPercent}%</span>`}${duplicateText ? ` · <strong class="ae-live-duplicate-badge" style="color:#ff6b6b;">⚠ 重复组 ${duplicateGroup}</strong>` : ''}${seg.ambiguity ? ` · ⚠️ ${escapeHtml(seg.ambiguity)}` : ''} · 双击放大编辑</div><textarea class="input ae-review-script" rows="2" ondblclick="openAutoEditLargeScriptEditor(this)" oninput="handleAutoEditScriptChanged(this)" style="width:100%;resize:vertical;">${escapeHtml(seg.script || '')}</textarea><div class="ae-missing-words-status"></div></div>
                        <label style="font-size:11px;">入点<div><button class="btn btn-secondary" onclick="nudgeAutoEditTime(this,'.ae-review-start',-.1)" style="padding:1px 4px;">−</button><input type="number" class="input ae-review-start" value="${Number(seg.start || 0).toFixed(3)}" min="0" step="0.01" style="width:72px;"><button class="btn btn-secondary" onclick="nudgeAutoEditTime(this,'.ae-review-start',.1)" style="padding:1px 4px;">+</button></div></label>
                        <label style="font-size:11px;">出点<div><button class="btn btn-secondary" onclick="nudgeAutoEditTime(this,'.ae-review-end',-.1)" style="padding:1px 4px;">−</button><input type="number" class="input ae-review-end" value="${Number(seg.end || 0).toFixed(3)}" min="0" step="0.01" style="width:72px;"><button class="btn btn-secondary" onclick="nudgeAutoEditTime(this,'.ae-review-end',.1)" style="padding:1px 4px;">+</button></div></label>
                        <div style="display:flex;flex-direction:column;gap:5px;"><button class="btn btn-primary" title="按照当前入点和出点播放裁切后的内容" onclick="playAutoEditReviewSource(this,true)" style="font-size:11px;padding:4px 8px;">▶ 剪后预览</button><button class="btn btn-secondary" title="播放未裁切的完整原始视频" onclick="playAutoEditReviewSource(this,false)" style="font-size:11px;padding:3px 8px;">原片预览</button><button class="btn btn-secondary" onclick="toggleAutoEditReviewDetails(this)" style="font-size:11px;padding:3px 8px;">${detailsOpen ? '收起详情' : '展开详情'}</button></div>
                        <div class="ae-review-details" style="grid-column:3 / -1;display:${detailsOpen ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:10px;padding:10px;border-radius:7px;background:rgba(0,0,0,.18);cursor:default;">
                            <div><div style="font-size:11px;color:#60a5fa;font-weight:700;margin-bottom:5px;">实际识别文字</div><div style="white-space:pre-wrap;word-break:break-word;line-height:1.55;min-height:54px;padding:8px;background:#111225;border-radius:5px;color:#d7defa;">${escapeHtml(seg.recognized_text || '(没有识别到有效语音)')}</div></div>
                            <div><div style="font-size:11px;color:#a5b4fc;font-weight:700;margin-bottom:5px;">目标文案</div><div style="white-space:pre-wrap;word-break:break-word;line-height:1.55;min-height:54px;padding:8px;background:#111225;border-radius:5px;color:#fff;">${escapeHtml(seg.script || '(尚未匹配文案)')}</div></div>
                            <div style="grid-column:1 / -1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.06);padding-top:8px;">
                                <span class="hint">更多操作:</span>
                                <label style="font-size:11px;">速度 <input class="input ae-review-speed" type="number" value="1" min="0.25" max="4" step="0.05" style="width:65px;"></label>
                                <button class="btn btn-secondary" onclick="retranscribeAutoEditReviewRow(this,${reviewIndex})" style="font-size:11px;padding:3px 8px;">重新转录此片段</button>
                                <button class="btn btn-secondary" onclick="replaceAutoEditReviewRow(this,${seg.source_index || reviewIndex})" style="font-size:11px;padding:3px 8px;color:#fca5a5;border-color:rgba(239,68,68,.35);">替换当前片段</button>
                                <button class="btn btn-primary" onclick="recalculateAutoEditReviewRow(this)" style="font-size:11px;padding:3px 9px;">按文案重算切点</button>
                            </div>
                        </div>
                    </div>`;
                return `
                    <div style="${rowStyle}">
                        <strong style="color: var(--accent);">输出 #${seg.index}</strong>
                        <span>原片段 #${seg.source_index || seg.index}</span>
                        <span>${escapeHtml(seg.duration)}s</span>
                        <span>匹配 ${Math.round((seg.match_score || 0) * 100)}%</span>
                        ${srcTag}
                        <span title="${escapeHtml(seg.matched_text || '')}" style="word-break: break-all; line-height: 1.4;">${matchedTextHtml}</span>
                        <button class="btn btn-secondary" onclick="playAutoEditResultSegment(${reviewIndex})" style="font-size: 11px; padding: 2px 8px; white-space: nowrap; margin-left: auto;">▶️ 播放片段</button>
                    </div>
                `;
            }).join('')}
        </div>
    ` : '';

    root.innerHTML = `
        <div style="margin-bottom:8px;color:var(--success);font-weight:600;">${isReview ? '✅ 第一步分析完成' : `✅ 已处理 ${data.used_clip_count || segments.length || 0} 组片段`}</div>
        ${isReview ? `<div style="margin-bottom:10px;padding:8px 10px;border-radius:6px;background:rgba(99,102,241,.08);color:#a5b4fc;">输出将跟随第一个素材：${settings.width || '?'}×${settings.height || '?'}，${Number(settings.fps || 0).toFixed(3)} fps。黄色项目建议重点检查。</div>` : ''}
        ${scriptCoverageHtml}
        ${fileHtml || '<p class="hint">没有返回输出文件。</p>'}
        <div style="margin-top: 10px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            ${isReview ? '<button class="btn btn-primary" onclick="exportReviewedAutoEdit()" style="padding:7px 16px;">③ 按审核结果正式导出</button>' : ''}
            <button class="btn btn-primary" onclick="sendAutoEditResultToReels()" style="padding: 5px 12px; font-size: 12px;">🎬 送入批量 Reels</button>
            <button class="btn btn-secondary" id="autoedit-rename-btn" onclick="renameAutoEditOriginalClips()" style="padding: 5px 12px; font-size: 12px; background: rgba(79, 70, 229, 0.1); border: 1px solid rgba(79, 70, 229, 0.3); color: #818cf8;">✏️ 一键重命名本地原视频</button>
            <button class="btn btn-secondary" id="autoedit-view-report-btn" onclick="viewAutoEditReport()" style="padding: 5px 12px; font-size: 12px; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); color: #4ade80;">📊 查看对齐报告</button>
        </div>
        ${segmentHtml}
    `;
    if (isReview) refreshAutoEditDuplicateMarks();
}

function getAutoEditReviewRowSource(button) {
    const encoded = button?.closest('.autoedit-review-row')?.dataset?.source || '';
    try { return decodeURIComponent(encoded); } catch (_) { return ''; }
}
function playAutoEditReviewSource(button, cutPreview) {
    const row = button?.closest('.autoedit-review-row');
    const source = getAutoEditReviewRowSource(button);
    if (!source || !row) return;
    if (!cutPreview) return window.playVideoClip(source, 0, 0);
    window.playVideoClip(
        source,
        Number(row.querySelector('.ae-review-start')?.value),
        Number(row.querySelector('.ae-review-end')?.value),
        row.querySelector('.ae-review-script')?.value || '',
        row.dataset.wordTimeline || ''
    );
}
function retranscribeAutoEditReviewRow(button, reviewIndex) {
    const source = getAutoEditReviewRowSource(button);
    if (source) retranscribeAutoEditReviewClip(source, reviewIndex);
}
function replaceAutoEditReviewRow(button, sourceIndex) {
    const source = getAutoEditReviewRowSource(button);
    if (source) window.replaceAutoEditClip(source, sourceIndex);
}
function recalculateAutoEditReviewRow(button) {
    const timeline = button?.closest('.autoedit-review-row')?.dataset?.wordTimeline || '';
    recalculateAutoEditCutFromScript(button, timeline);
}
function playAutoEditResultSegment(index) {
    const segment = autoEditLastResult?.segments?.[index];
    if (segment?.source) window.playVideoClip(segment.source, Number(segment.start) || 0, Number(segment.end) || 0);
}

function toggleAutoEditReviewFullscreen() {
    const section = document.getElementById('autoedit-result-section');
    const button = document.getElementById('autoedit-expand-review-btn');
    if (!section) return;
    const expanded = section.classList.toggle('autoedit-review-fullscreen');
    document.body.style.overflow = expanded ? 'hidden' : '';
    if (button) button.textContent = expanded ? '✕ 退出放大' : '⛶ 放大审核';
}

function locateAutoEditScriptLine(lineNumber, coverageLine) {
    const rows = Array.from(document.querySelectorAll('.autoedit-review-row'));
    const placeholders = Array.from(document.querySelectorAll('.autoedit-missing-placeholder'));
    if (!rows.length && !placeholders.length) return;
    const exactPlaceholders = placeholders.filter(row => {
        const start = Number(row.dataset.scriptStartLine || 0);
        const end = Number(row.dataset.scriptEndLine || start);
        return start > 0 && start <= lineNumber && lineNumber <= end;
    });
    const exact = rows.filter(row => {
        const start = Number(row.dataset.scriptStartLine || 0);
        const end = Number(row.dataset.scriptEndLine || start);
        return start > 0 && start <= lineNumber && lineNumber <= end;
    });
    let targets = exactPlaceholders.length ? exactPlaceholders : exact;
    let usedNearest = false;
    if (!targets.length) {
        const candidates = rows.filter(row => Number(row.dataset.scriptStartLine || 0) > 0);
        if (candidates.length) {
            candidates.sort((a, b) => {
                const distance = row => {
                    const start = Number(row.dataset.scriptStartLine || 0);
                    const end = Number(row.dataset.scriptEndLine || start);
                    return lineNumber < start ? start - lineNumber : Math.max(0, lineNumber - end);
                };
                return distance(a) - distance(b);
            });
            targets = [candidates[0]];
            usedNearest = true;
        }
    }
    document.querySelectorAll('.ae-coverage-line').forEach(line => line.classList.remove('ae-coverage-line-active'));
    coverageLine?.classList.add('ae-coverage-line-active');
    [...rows, ...placeholders].forEach(row => row.classList.remove('ae-quick-locate-target'));
    targets.forEach(row => row.classList.add('ae-quick-locate-target'));
    targets[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (targets.length) {
        showToast(usedNearest ? `第 ${lineNumber} 行未对上，已定位到最接近的片段` : `已定位第 ${lineNumber} 行对应的${targets.length > 1 ? ` ${targets.length} 个` : ''}片段`, usedNearest ? 'info' : 'success');
        setTimeout(() => targets.forEach(row => row.classList.remove('ae-quick-locate-target')), 2200);
    } else {
        showToast(`第 ${lineNumber} 行没有可定位的片段`, 'info');
    }
}

async function loadAutoEditProjectFile(file) {
    if (!file) return;
    try {
        const project = JSON.parse(await file.text());
        if (!Array.isArray(project.clips) || !Array.isArray(project.segments)) throw new Error('项目文件结构无效');
        autoEditFiles = project.clips.map(path => ({ path, name: String(path).split(/[/\\]/).pop(), status: 'transcribed' }));
        const scriptInput = document.getElementById('autoedit-script');
        if (scriptInput) scriptInput.value = project.script_text || '';
        updateAutoEditScriptCount();
        renderAutoEditFiles();
        autoEditLastResult = { ...project, analysis_only: true, project_path: file.path || '' };
        renderAutoEditResult(autoEditLastResult);
        document.getElementById('autoedit-result-section')?.classList.remove('hidden');
        showToast('分析项目已恢复，可继续审核和导出', 'success');
    } catch (error) {
        showToast(`打开分析项目失败: ${escapeHtml(error.message)}`, 'error');
    }
}

function moveAutoEditReviewRow(index, delta) {
    if (!autoEditLastResult?.analysis_only) return;
    const next = index + delta;
    const list = autoEditLastResult.segments || [];
    if (next < 0 || next >= list.length) return;
    [list[index], list[next]] = [list[next], list[index]];
    renderAutoEditResult(autoEditLastResult);
}

function autoEditWords(text) {
    return String(text || '').normalize('NFKC').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || [];
}

function findAutoEditMissingWords(originalText, currentText) {
    const original = autoEditWords(originalText);
    const current = autoEditWords(currentText);
    const a = original.map(word => word.toLocaleLowerCase());
    const b = current.map(word => word.toLocaleLowerCase());
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const kept = new Set();
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { kept.add(i); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
        else j++;
    }
    return original.filter((_, index) => !kept.has(index));
}

function updateAutoEditMissingWords(row) {
    const textarea = row.querySelector('.ae-review-script');
    const status = row.querySelector('.ae-missing-words-status');
    if (!textarea || !status) return;
    let original = '';
    try { original = decodeURIComponent(row.dataset.originalScript || ''); } catch (_) { original = ''; }
    const missing = findAutoEditMissingWords(original, textarea.value);
    const fingerprint = encodeURIComponent(textarea.value);
    const confirmed = missing.length > 0 && row.dataset.missingConfirmedFor === fingerprint;
    row.dataset.missingCount = String(missing.length);
    row.dataset.missingConfirmed = confirmed ? 'true' : 'false';
    row.classList.toggle('ae-missing-words-row', missing.length > 0 && !confirmed);
    row.classList.toggle('ae-missing-confirmed-row', confirmed);
    if (!missing.length) {
        status.innerHTML = '';
    } else if (confirmed) {
        status.innerHTML = `<span class="ae-missing-confirmed-badge">✓ 缺少 ${missing.length} 个单词，已确认是故意删除</span>`;
    } else {
        const preview = missing.slice(0, 12).map(escapeHtml).join('、') + (missing.length > 12 ? '…' : '');
        status.innerHTML = `<span class="ae-missing-warning-badge">⚠ 缺少 ${missing.length} 个单词：${preview}</span><button type="button" class="btn btn-secondary" onclick="confirmAutoEditMissingWords(this)" style="padding:2px 8px;font-size:11px;">确认是故意删除</button>`;
    }
}

function handleAutoEditScriptChanged(textarea) {
    const row = textarea.closest('.autoedit-review-row');
    if (!row) return;
    row.dataset.missingConfirmedFor = '';
    updateAutoEditMissingWords(row);
    refreshAutoEditDuplicateMarks();
}

function confirmAutoEditMissingWords(button) {
    const row = button.closest('.autoedit-review-row');
    const textarea = row?.querySelector('.ae-review-script');
    if (!row || !textarea) return;
    row.dataset.missingConfirmedFor = encodeURIComponent(textarea.value);
    updateAutoEditMissingWords(row);
    refreshAutoEditDuplicateMarks();
    showToast('已确认此次删词，继续修改后需要重新确认', 'success');
}

function refreshAutoEditDuplicateMarks() {
    const rows = Array.from(document.querySelectorAll('.autoedit-review-row'));
    const keyOf = text => String(text || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
    const counts = new Map();
    const allCounts = new Map();
    rows.forEach(row => {
        const allKey = row.dataset.originalTextKey || keyOf(row.querySelector('.ae-review-script')?.value);
        const currentKey = keyOf(row.querySelector('.ae-review-script')?.value);
        row.dataset.allTextKey = allKey;
        if (allKey) allCounts.set(allKey, (allCounts.get(allKey) || 0) + 1);
        if (row.querySelector('.ae-review-enabled')?.checked === false) {
            row.dataset.textKey = '';
            return;
        }
        const key = currentKey;
        row.dataset.textKey = key;
        if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    const groups = new Map();
    let groupNumber = 1;
    rows.forEach(row => {
        const key = row.dataset.allTextKey;
        if (key && (allCounts.get(key) || 0) > 1 && !groups.has(key)) groups.set(key, groupNumber++);
    });
    rows.forEach(row => {
        const enabled = row.querySelector('.ae-review-enabled')?.checked !== false;
        const allKey = row.dataset.allTextKey;
        const currentKey = row.dataset.textKey;
        const duplicate = enabled && currentKey && (counts.get(currentKey) || 0) > 1;
        const resolved = enabled && allKey && (allCounts.get(allKey) || 0) > 1 && (!currentKey || (counts.get(currentKey) || 0) === 1);
        row.style.borderLeft = duplicate ? '5px solid #a855f7' : '4px solid transparent';
        row.classList.toggle('ae-duplicate-row', Boolean(duplicate));
        row.dataset.duplicate = duplicate ? 'true' : 'false';
        let badge = row.querySelector('.ae-live-duplicate-badge');
        let resolvedBadge = row.querySelector('.ae-resolved-duplicate-badge');
        if (duplicate && !badge) {
            badge = document.createElement('strong');
            badge.className = 'ae-live-duplicate-badge';
            badge.style.cssText = 'color:#c084fc;font-size:11px;margin-left:6px;';
            badge.textContent = `⚠ 重复组 ${groups.get(allKey)}`;
            row.querySelector('.ae-review-script')?.before(badge);
        } else if (duplicate && badge) {
            badge.textContent = `⚠ 重复组 ${groups.get(allKey)}`;
        } else if (!duplicate && badge) badge.remove();
        if (resolved && !resolvedBadge) {
            resolvedBadge = document.createElement('strong');
            resolvedBadge.className = 'ae-resolved-duplicate-badge';
            resolvedBadge.style.cssText = 'color:#51cf66;font-size:11px;margin-left:6px;';
            row.querySelector('.ae-review-script')?.before(resolvedBadge);
        }
        if (resolved && resolvedBadge) resolvedBadge.textContent = `✓ 重复组 ${groups.get(allKey)} 已排除`;
        else if (!resolved && resolvedBadge) resolvedBadge.remove();
        updateAutoEditMissingWords(row);
    });

    // 顶部状态必须跟随当前审核结果，而不是停留在首次分析状态。
    const duplicateGroupCount = Array.from(counts.values()).filter(count => count > 1).length;
    const originalDuplicateGroupCount = Array.from(allCounts.values()).filter(count => count > 1).length;
    const resolvedGroupCount = Array.from(allCounts.entries())
        .filter(([key, count]) => count > 1 && (counts.get(key) || 0) <= 1).length;
    const status = document.getElementById('ae-overall-duplicate-status');
    if (status) {
        status.className = 'ae-overall-status';
        if (duplicateGroupCount > 0) {
            status.classList.add('ae-overall-status-pending');
            status.textContent = `⚠ 仍有 ${duplicateGroupCount} 组重复未处理`;
        } else if (resolvedGroupCount > 0 || originalDuplicateGroupCount > 0) {
            status.classList.add('ae-overall-status-resolved');
            status.textContent = `✓ 重复已处理（${Math.max(resolvedGroupCount, originalDuplicateGroupCount)} 组）`;
        } else {
            status.classList.add('ae-overall-status-clean');
            status.textContent = '✓ 未发现重复';
        }
    }
    const missingStatus = document.getElementById('ae-overall-missing-status');
    if (missingStatus) {
        const enabledRows = rows.filter(row => row.querySelector('.ae-review-enabled')?.checked !== false);
        const pending = enabledRows.filter(row => Number(row.dataset.missingCount || 0) > 0 && row.dataset.missingConfirmed !== 'true');
        const confirmed = enabledRows.filter(row => Number(row.dataset.missingCount || 0) > 0 && row.dataset.missingConfirmed === 'true');
        missingStatus.className = 'ae-overall-status';
        if (pending.length) {
            missingStatus.classList.add('ae-overall-status-pending');
            missingStatus.textContent = `⚠ ${pending.length} 段存在未确认删词`;
        } else if (confirmed.length) {
            missingStatus.classList.add('ae-overall-status-resolved');
            missingStatus.textContent = `✓ ${confirmed.length} 段删词已确认`;
        } else {
            missingStatus.textContent = '';
        }
    }
}

function handleAutoEditReviewEnabled(checkbox) {
    const row = checkbox.closest('.autoedit-review-row');
    if (!row) return;
    const enabled = checkbox.checked;
    const wasDuplicate = row.dataset.duplicate === 'true' || row.classList.contains('ae-duplicate-row');
    let source = '';
    try { source = decodeURIComponent(row.dataset.source || ''); } catch (_) { source = ''; }
    const file = autoEditFiles.find(item => item.path === source);
    if (file) {
        if (!enabled) {
            if (!file.statusBeforeReviewExclusion) file.statusBeforeReviewExclusion = file.status || 'transcribed';
            file.status = wasDuplicate ? 'excluded_duplicate' : 'excluded_review';
            row.dataset.exclusionReason = wasDuplicate ? 'duplicate' : 'review';
        } else {
            file.status = file.statusBeforeReviewExclusion || 'transcribed';
            delete file.statusBeforeReviewExclusion;
            row.dataset.exclusionReason = '';
        }
        renderAutoEditFiles();
    }
    row.classList.toggle('ae-review-excluded', !enabled);
    let badge = row.querySelector('.ae-review-excluded-badge');
    if (!enabled && !badge) {
        badge = document.createElement('strong');
        badge.className = 'ae-review-excluded-badge';
        badge.textContent = row.dataset.exclusionReason === 'duplicate' ? '重复片段已排除 · 不会进入成片' : '已排除 · 不会进入成片';
        badge.style.cssText = 'grid-column:3 / -1;color:#adb5bd;font-size:12px;padding:3px 8px;border:1px dashed rgba(173,181,189,.35);border-radius:5px;width:max-content;';
        row.appendChild(badge);
        showToast('已排除此片段，正式导出时会跳过', 'info');
    } else if (enabled && badge) {
        badge.remove();
        showToast('已重新启用此片段', 'success');
    }
    refreshAutoEditDuplicateMarks();
}

function toggleAutoEditReviewDetails(button) {
    const details = button.closest('.autoedit-review-row')?.querySelector('.ae-review-details');
    if (!details) return;
    const opening = details.style.display === 'none';
    details.style.display = opening ? 'grid' : 'none';
    button.textContent = opening ? '收起详情' : '展开详情';
}

function openAutoEditLargeScriptEditor(sourceTextarea) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;z-index:100001;padding:24px;';
    const modal = document.createElement('div');
    modal.style.cssText = 'width:min(900px,92vw);height:min(650px,86vh);background:#151526;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 70px rgba(0,0,0,.7);';
    const title = document.createElement('div');
    title.textContent = '✏️ 放大编辑剪辑文案';
    title.style.cssText = 'font-size:16px;font-weight:700;color:#e8ecff;';
    const editor = document.createElement('textarea');
    editor.className = 'input';
    editor.value = sourceTextarea.value;
    editor.style.cssText = 'flex:1;width:100%;resize:none;font-size:20px;line-height:1.65;padding:16px;background:#0d0d18;color:#fff;border-radius:8px;';
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:flex-end;';
    const hint = document.createElement('span');
    hint.textContent = '保存后可点击“按文案重算切点”';
    hint.style.cssText = 'font-size:12px;color:#8b95c0;margin-right:auto;';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary'; cancel.textContent = '取消';
    const save = document.createElement('button');
    save.className = 'btn btn-primary'; save.textContent = '保存修改';
    const close = () => overlay.remove();
    cancel.onclick = close;
    save.onclick = () => {
        sourceTextarea.value = editor.value;
        sourceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        sourceTextarea.closest('.autoedit-review-row').dataset.modified = 'true';
        close();
        showToast('文案修改已保存，请按需要重算切点', 'success');
    };
    overlay.onclick = event => { if (event.target === overlay) close(); };
    footer.append(hint, cancel, save); modal.append(title, editor, footer); overlay.appendChild(modal); document.body.appendChild(overlay);
    editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length);
}

function filterAutoEditReview(type) {
    document.querySelectorAll('.autoedit-review-row').forEach(row => {
        const show = type === 'all' || row.dataset[type] === 'true';
        row.style.display = show ? 'grid' : 'none';
    });
    document.querySelectorAll('.autoedit-missing-placeholder').forEach(row => {
        row.style.display = (type === 'all' || type === 'warning' || type === 'unmatched') ? 'grid' : 'none';
    });
}

function toggleAllAutoEditDetails(openProblems) {
    document.querySelectorAll('.autoedit-review-row').forEach(row => {
        const details = row.querySelector('.ae-review-details');
        const button = Array.from(row.querySelectorAll('button')).find(btn => /详情/.test(btn.textContent));
        if (!details) return;
        const shouldOpen = openProblems && (row.dataset.warning === 'true' || row.dataset.duplicate === 'true' || row.dataset.unmatched === 'true');
        details.style.display = shouldOpen ? 'grid' : 'none';
        if (button) button.textContent = shouldOpen ? '收起详情' : '展开详情';
    });
}

async function retranscribeAutoEditReviewClip(filePath) {
    if (!confirm('将清除此片段的转录缓存并重新执行快速分析，其他片段会继续使用缓存。是否继续？')) return;
    try {
        const result = await window.electronAPI.apiCall('media/clear-clip-cache', { file_path: filePath });
        if (!result?.success) throw new Error(result?.error || '清除转录缓存失败');
        const batchTask = autoEditActiveBatchIndex >= 0 ? autoEditBatchTasks[autoEditActiveBatchIndex] : null;
        await startAutoEditByScript(false, {
            analysisOnly: true,
            outputDirOverride: batchTask ? window.electronAPI.pathJoin(batchTask.folder, '_auto_edit') : undefined,
            requestSettingsOverride: batchTask?.settings,
        });
    } catch (error) {
        showToast(`重新转录失败: ${escapeHtml(error.message)}`, 'error');
    }
}

function recalculateAutoEditCutFromScript(button, encodedTimeline) {
    const row = button.closest('.autoedit-review-row');
    if (!row) return;
    let timeline = [];
    try { timeline = JSON.parse(decodeURIComponent(encodedTimeline || '')); } catch (_) {}
    if (!timeline.length) return showToast('当前分析结果没有逐词时间轴，请重新执行快速分析', 'error');

    const targetText = row.querySelector('.ae-review-script')?.value || '';
    const numberWords = {zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10'};
    const normalize = value => {
        const token=String(value || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
        return numberWords[token] || token;
    };
    const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(targetText);
    const targetTokens = hasCJK
        ? Array.from(targetText).map(normalize).filter(Boolean)
        : targetText.split(/\s+/).map(normalize).filter(Boolean);
    const sourceTokens = timeline.map(item => normalize(item.word));
    if (!targetTokens.length) return showToast('目标文案为空，无法重算切点', 'error');

    const editDistance = (a, b) => {
        const prev=Array.from({length:b.length+1},(_,i)=>i);
        for(let i=1;i<=a.length;i++){
            let diagonal=prev[0]; prev[0]=i;
            for(let j=1;j<=b.length;j++){
                const old=prev[j];
                prev[j]=Math.min(prev[j]+1,prev[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));
                diagonal=old;
            }
        }
        return prev[b.length];
    };
    const targetJoined=targetTokens.join('');
    const variation=Math.max(2,Math.ceil(targetTokens.length*.35));
    let best=null;
    for(let start=0;start<sourceTokens.length;start++){
        const minEnd=Math.min(sourceTokens.length-1,start+Math.max(1,targetTokens.length-variation)-1);
        const maxEnd=Math.min(sourceTokens.length-1,start+targetTokens.length+variation-1);
        for(let end=minEnd;end<=maxEnd;end++){
            const candidate=sourceTokens.slice(start,end+1).join('');
            const score=1-editDistance(targetJoined,candidate)/Math.max(1,targetJoined.length,candidate.length);
            if(!best||score>best.score||(score===best.score&&(end-start)<(best.end-best.start)))best={start,end,score};
        }
    }
    if (!best || best.score < 0.62) return showToast('修改文案与实际识别文字差异过大，无法安全重算切点；请检查文字或重新转录', 'error', 7000);

    const first = timeline[best.start];
    const last = timeline[best.end];
    const leadPad = Math.max(0, parseFloat(document.getElementById('autoedit-lead-pad')?.value || '0.04'));
    const tailPad = Math.max(0, parseFloat(document.getElementById('autoedit-tail-pad')?.value || '0.08'));
    const startInput = row.querySelector('.ae-review-start');
    const endInput = row.querySelector('.ae-review-end');
    startInput.value = Math.max(0, Number(first.start) - leadPad).toFixed(3);
    endInput.value = Math.max(Number(first.start), Number(last.end) + tailPad).toFixed(3);
    row.dataset.modified = 'true';
    showToast(`切点已更新为 ${startInput.value}s - ${endInput.value}s（定位相似度 ${Math.round(best.score*100)}%）`, best.score < .8 ? 'info' : 'success');
}

let autoEditReviewDragIndex = -1;
function autoEditReviewDragStart(event, index) {
    autoEditReviewDragIndex = index;
    event.dataTransfer.effectAllowed = 'move';
}
function autoEditReviewDrop(event, index) {
    event.preventDefault();
    if (autoEditReviewDragIndex < 0 || autoEditReviewDragIndex === index || !autoEditLastResult?.segments) return;
    const [item] = autoEditLastResult.segments.splice(autoEditReviewDragIndex, 1);
    autoEditLastResult.segments.splice(index, 0, item);
    autoEditReviewDragIndex = -1;
    renderAutoEditResult(autoEditLastResult);
}
function nudgeAutoEditTime(button, selector, delta) {
    const input = button.closest('.autoedit-review-row')?.querySelector(selector);
    if (!input) return;
    input.value = Math.max(0, (Number(input.value) || 0) + delta).toFixed(3);
}

async function exportReviewedAutoEdit() {
    if (!autoEditLastResult?.analysis_only) return;
    const rows = Array.from(document.querySelectorAll('.autoedit-review-row'));
    const reviewSegments = rows.map((row, index) => {
        const original = autoEditLastResult.segments[index];
        return {
            source: original.source,
            enabled: row.querySelector('.ae-review-enabled')?.checked !== false,
            script: row.querySelector('.ae-review-script')?.value || original.script,
            start: Number(row.querySelector('.ae-review-start')?.value),
            end: Number(row.querySelector('.ae-review-end')?.value),
            speed: Number(row.querySelector('.ae-review-speed')?.value || 1),
        };
    });
    const enabledRows = rows.filter(row => row.querySelector('.ae-review-enabled')?.checked !== false);
    const excludedCount = rows.length - enabledRows.length;
    const duplicateCount = enabledRows.filter(row => row.dataset.duplicate === 'true').length;
    const unmatchedCount = enabledRows.filter(row => row.dataset.unmatched === 'true').length;
    const warningCount = enabledRows.filter(row => row.dataset.warning === 'true' && row.dataset.duplicate !== 'true' && row.dataset.unmatched !== 'true').length;
    const unconfirmedMissingCount = enabledRows.filter(row => Number(row.dataset.missingCount || 0) > 0 && row.dataset.missingConfirmed !== 'true').length;
    const missingPlaceholderCount = document.querySelectorAll('.autoedit-missing-placeholder').length;
    if (duplicateCount || unmatchedCount || warningCount || unconfirmedMissingCount || missingPlaceholderCount) {
        const details = [
            duplicateCount ? `未处理重复片段: ${duplicateCount} 个` : '',
            unmatchedCount ? `未匹配/无识别文字: ${unmatchedCount} 个` : '',
            warningCount ? `低匹配警告: ${warningCount} 个` : '',
            unconfirmedMissingCount ? `手动删词尚未确认: ${unconfirmedMissingCount} 个片段` : '',
            missingPlaceholderCount ? `没有找到对应片段的文案: ${missingPlaceholderCount} 处` : '',
            excludedCount ? `已排除片段: ${excludedCount} 个` : '',
        ].filter(Boolean).join('\n');
        const confirmed = confirm(`当前审核时间线仍有风险项：\n\n${details}\n\n这些问题可能导致重复内容、错误字幕或漏剪。确定仍然开始正式导出吗？`);
        if (!confirmed) {
            showToast('已取消导出，请先处理警告项目', 'info');
            return;
        }
    }
    const invalid = reviewSegments.find(s => s.enabled && (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start));
    if (invalid) {
        showToast('审核时间线存在无效入出点，请确保出点大于入点', 'error');
        return;
    }
    reviewSegments.forEach(review => {
        const file = autoEditFiles.find(item => item.path === review.source);
        if (file) file.speed = Number.isFinite(review.speed) && review.speed > 0 ? review.speed : 1;
    });
    const batchTask = autoEditActiveBatchIndex >= 0 ? autoEditBatchTasks[autoEditActiveBatchIndex] : null;
    if (batchTask) {
        batchTask.reviewSegments = reviewSegments.map(item => ({ ...item }));
        batchTask.status = 'warning';
        batchTask.message = '已审核，等待导出';
    }
    await startAutoEditByScript(false, {
        reviewSegments,
        outputDirOverride: batchTask ? window.electronAPI.pathJoin(batchTask.folder, '_auto_edit') : undefined,
        requestSettingsOverride: { ...(batchTask?.settings || getAutoEditRequestSettings()), force_transcribe: false },
    });
}

async function renameAutoEditOriginalClips() {
    if (!autoEditLastResult || !autoEditLastResult.segments || autoEditLastResult.segments.length === 0) {
        showToast('没有可重命名的片段数据', 'error');
        return;
    }

    const confirmRename = confirm('确定要一键重命名这些本地视频文件吗？这会在文件名最前面添加 01-, 02- 形式的播放顺序编号（也会同步重命名它们的转录缓存，防止下次运行重复转录耗费 API）。');
    if (!confirmRename) return;

    const renameBtn = document.getElementById('autoedit-rename-btn');
    if (renameBtn) {
        renameBtn.disabled = true;
        renameBtn.textContent = '⏳ 正在重命名...';
    }

    try {
        const clips = autoEditLastResult.segments.map(seg => ({
            source: seg.source,
            index: seg.index
        }));

        const resp = await apiFetch(`${API_BASE}/media/rename-original-clips`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clips })
        });

        const resData = await resp.json();
        if (!resp.ok) throw new Error(resData.error || '重命名失败');

        const renamed = resData.renamed || [];
        if (renamed.length === 0) {
            showToast('未检测到需要重命名的文件，或文件已被重命名', 'warning');
            return;
        }

        // 更新前端文件名列表状态，避免文件丢失
        renamed.forEach(r => {
            const f = autoEditFiles.find(file => file.path === r.oldPath);
            if (f) {
                f.path = r.newPath;
                f.name = r.newPath.split(/[/\\]/).pop();
            }
            // 同时更新结果数据里的 source
            const seg = autoEditLastResult.segments.find(s => s.source === r.oldPath);
            if (seg) {
                seg.source = r.newPath;
            }
        });

        // 重新渲染列表与结果面板
        renderAutoEditFiles();
        renderAutoEditResult(autoEditLastResult);
        showToast(`成功重命名 ${renamed.length} 个视频文件并已自动同步重命名对应的转录缓存！`, 'success', 5000);
    } catch (err) {
        console.error(err);
        showToast(`重命名失败: ${err.message}`, 'error');
    } finally {
        if (renameBtn) {
            renameBtn.disabled = false;
            renameBtn.textContent = '✏️ 一键重命名本地原视频';
        }
    }
}

window.renameAutoEditOriginalClips = renameAutoEditOriginalClips;

async function replaceAutoEditResultAudio() {
    if (!autoEditLastResult?.output_path && !autoEditLastResult?.final_video_path) {
        showToast('请先完成一次文案自动剪辑', 'error');
        return;
    }
    const audioPath = document.getElementById('autoedit-result-audio-path')?.value?.trim() || '';
    if (!audioPath) {
        showToast('请先选择换声后的新音频', 'error');
        return;
    }

    const scriptText = document.getElementById('autoedit-script')?.value || '';
    if (!scriptText.trim()) {
        showToast('缺少原文案，无法按新音频重新生成字幕', 'error');
        return;
    }

    const videoPath = autoEditLastResult.manual_audio_video_path || autoEditLastResult.voice_changed_video_path || autoEditLastResult.output_path;
    try {
        showToast('正在替换音频并重新转录新音频...', 'info', 4000);
        const resp = await apiFetch(`${API_BASE}/media/replace-audio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_path: videoPath,
                audio_path: audioPath,
                output_dir: autoEditLastResult.output_dir || '',
                script_text: scriptText,
                language: document.getElementById('autoedit-language')?.value || 'auto',
                min_score: parseFloat(document.getElementById('autoedit-min-score')?.value || '0.52'),
                regenerate_subtitles: true,
                burn_subtitles: document.getElementById('autoedit-burn-subtitles')?.checked || false,
            }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '替换音频失败');
        autoEditLastResult = {
            ...autoEditLastResult,
            manual_audio_path: audioPath,
            manual_audio_video_path: data.output_path,
            srt_path: data.srt_path || autoEditLastResult.srt_path,
            subtitled_path: data.subtitled_path || '',
            final_video_path: data.final_video_path || data.output_path,
        };
        renderAutoEditResult(autoEditLastResult);
        showToast(data.message || '已用新音频替换视频声音并刷新字幕', 'success');
    } catch (error) {
        showToast(`替换音频失败: ${escapeHtml(error.message)}`, 'error');
    }
}

window.replaceAutoEditResultAudio = replaceAutoEditResultAudio;

async function viewAutoEditReport() {
    if (!autoEditLastResult || !autoEditLastResult.report_path) {
        showToast('没有找到对齐报告文件路径', 'error');
        return;
    }
    const reportPath = autoEditLastResult.report_path;
    if (!window.electronAPI || !window.electronAPI.readFileText) {
        showToast('当前环境不支持读取本地文件', 'error');
        return;
    }
    const reportText = window.electronAPI.readFileText(reportPath);
    if (!reportText) {
        showToast('对齐报告文件为空或读取失败', 'error');
        return;
    }

    _showReportDialog(reportText, reportPath);
}

window.playVideoClip = function(filePath, startVal = 0, endVal = 0, scriptText = '', encodedWordTimeline = '') {
    if (!filePath) return;
    
    const startNum = parseFloat(startVal) || 0;
    const endNum = parseFloat(endVal) || 0;
    let wordTimeline = [];
    try { wordTimeline = encodedWordTimeline ? JSON.parse(decodeURIComponent(encodedWordTimeline)) : []; } catch (_) {}
    
    // Create background overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:100000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    
    const container = document.createElement('div');
    container.style.cssText = `background:#13132a;width:${scriptText ? '1000px' : '640px'};max-width:92vw;border-radius:14px;padding:20px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 20px 60px rgba(0,0,0,0.7);display:flex;flex-direction:column;gap:14px;color:#e8ecff;position:relative;`;
    
    const titleBar = document.createElement('div');
    titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:10px;';
    
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:14px;font-weight:600;color:#e8ecff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:480px;';
    
    const parts = filePath.split(/[/\\]/);
    const fileName = parts[parts.length - 1];
    titleEl.textContent = `▶️ 正在播放片段: ${fileName}${endNum > startNum ? ` [范围: ${startNum.toFixed(2)}s - ${endNum.toFixed(2)}s]` : ''}`;
    
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'border:none;background:rgba(255,255,255,0.06);color:#999;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;line-height:1;transition:all 0.2s;';
    closeBtn.textContent = '关闭';
    closeBtn.onmouseover = () => { closeBtn.style.background = 'rgba(255,255,255,0.1)'; closeBtn.style.color = '#fff'; };
    closeBtn.onmouseout = () => { closeBtn.style.background = 'rgba(255,255,255,0.06)'; closeBtn.style.color = '#999'; };
    
    const destroy = () => {
        videoEl.pause();
        videoEl.src = '';
        document.body.removeChild(overlay);
    };
    closeBtn.onclick = destroy;
    
    titleBar.appendChild(titleEl);
    titleBar.appendChild(closeBtn);
    
    const videoUrl = (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function')
        ? window.electronAPI.toFileUrl(filePath)
        : normalizeFilePath(filePath);
    const videoEl = document.createElement('video');
    videoEl.src = videoUrl;
    const hasCutRange = endNum > startNum;
    videoEl.controls = !hasCutRange;
    videoEl.autoplay = !hasCutRange;
    videoEl.style.cssText = 'width:100%;max-height:450px;border-radius:8px;outline:none;background:#000;border:1px solid rgba(255,255,255,0.05);';
    const videoWrap = document.createElement('div');
    videoWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;min-width:0;';
    videoWrap.appendChild(videoEl);

    if (hasCutRange) {
        const clipDuration = Math.max(.01, endNum - startNum);
        const formatTime = seconds => {
            const safe = Math.max(0, Number(seconds) || 0);
            const minutes = Math.floor(safe / 60);
            const secs = Math.floor(safe % 60);
            const tenths = Math.floor((safe % 1) * 10);
            return `${minutes}:${String(secs).padStart(2, '0')}.${tenths}`;
        };
        const rangeHint = document.createElement('div');
        rangeHint.style.cssText = 'display:flex;justify-content:space-between;gap:12px;padding:7px 10px;border-radius:7px;background:rgba(99,102,241,.12);border:1px solid rgba(129,140,248,.25);font-size:12px;color:#c7d2fe;';
        rangeHint.innerHTML = `<strong>剪后片段 ${formatTime(clipDuration)}</strong><span>原片 ${formatTime(startNum)} → ${formatTime(endNum)}，到出点自动停止</span>`;

        const controls = document.createElement('div');
        controls.style.cssText = 'display:grid;grid-template-columns:auto auto 1fr auto auto;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:#0b0b16;border:1px solid rgba(255,255,255,.08);';
        const playButton = document.createElement('button');
        playButton.className = 'btn btn-primary';
        playButton.textContent = '▶';
        playButton.title = '播放剪后片段';
        playButton.style.cssText = 'padding:4px 10px;min-width:38px;';
        const timeLabel = document.createElement('span');
        timeLabel.textContent = `0:00.0 / ${formatTime(clipDuration)}`;
        timeLabel.style.cssText = 'font-variant-numeric:tabular-nums;font-size:13px;color:#fff;white-space:nowrap;';
        const seek = document.createElement('input');
        seek.type = 'range'; seek.min = '0'; seek.max = String(clipDuration); seek.step = '0.01'; seek.value = '0';
        seek.title = '剪后片段进度';
        seek.style.cssText = 'width:100%;accent-color:#818cf8;';
        const muteButton = document.createElement('button');
        muteButton.className = 'btn btn-secondary'; muteButton.textContent = '🔊'; muteButton.title = '静音/恢复声音';
        muteButton.style.cssText = 'padding:3px 8px;';
        const fullscreenButton = document.createElement('button');
        fullscreenButton.className = 'btn btn-secondary'; fullscreenButton.textContent = '⛶'; fullscreenButton.title = '全屏';
        fullscreenButton.style.cssText = 'padding:3px 8px;';
        controls.append(playButton, timeLabel, seek, muteButton, fullscreenButton);
        videoWrap.append(rangeHint, controls);

        let resetting = false;
        const resetToStart = () => {
            resetting = true;
            videoEl.pause();
            videoEl.currentTime = startNum;
            seek.value = '0';
            timeLabel.textContent = `0:00.0 / ${formatTime(clipDuration)}`;
            playButton.textContent = '▶';
            setTimeout(() => { resetting = false; }, 0);
        };
        videoEl.addEventListener('loadedmetadata', () => {
            videoEl.currentTime = startNum;
            videoEl.addEventListener('seeked', () => videoEl.play().catch(() => {}), { once: true });
        }, { once: true });
        videoEl.addEventListener('play', () => { playButton.textContent = '❚❚'; });
        videoEl.addEventListener('pause', () => { if (!resetting) playButton.textContent = '▶'; });
        videoEl.addEventListener('timeupdate', () => {
            if (videoEl.currentTime >= endNum - .015) return resetToStart();
            const relative = Math.max(0, Math.min(clipDuration, videoEl.currentTime - startNum));
            seek.value = String(relative);
            timeLabel.textContent = `${formatTime(relative)} / ${formatTime(clipDuration)}`;
        });
        playButton.onclick = () => {
            if (videoEl.paused) {
                if (videoEl.currentTime < startNum || videoEl.currentTime >= endNum - .015) videoEl.currentTime = startNum;
                videoEl.play().catch(() => {});
            } else videoEl.pause();
        };
        seek.oninput = () => { videoEl.currentTime = startNum + Number(seek.value || 0); };
        muteButton.onclick = () => { videoEl.muted = !videoEl.muted; muteButton.textContent = videoEl.muted ? '🔇' : '🔊'; };
        fullscreenButton.onclick = () => videoEl.requestFullscreen?.();
    } else if (startNum > 0) {
        videoEl.addEventListener('loadedmetadata', () => { videoEl.currentTime = startNum; }, { once: true });
    }
    
    videoEl.onerror = (e) => {
        console.error('[playVideoClip] Video load error code:', videoEl.error ? videoEl.error.code : 'unknown', 'message:', videoEl.error ? videoEl.error.message : '', 'URL:', videoUrl);
    };
    
    container.appendChild(titleBar);
    if (scriptText) {
        const previewBody = document.createElement('div');
        previewBody.style.cssText = 'display:grid;grid-template-columns:minmax(0,1.65fr) minmax(260px,1fr);gap:16px;align-items:stretch;';
        const scriptPanel = document.createElement('div');
        scriptPanel.style.cssText = 'background:#0d0d1d;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:16px;display:flex;flex-direction:column;min-height:220px;max-height:450px;overflow:auto;';
        const scriptTitle = document.createElement('div');
        scriptTitle.textContent = wordTimeline.length ? '实际朗读（跟随播放高亮）' : '对应文案';
        scriptTitle.style.cssText = 'font-size:12px;font-weight:700;color:#a5b4fc;margin-bottom:10px;position:sticky;top:0;background:#0d0d1d;padding-bottom:6px;';
        const scriptContent = document.createElement('div');
        scriptContent.style.cssText = 'font-size:18px;line-height:1.65;white-space:pre-wrap;word-break:break-word;color:#fff;';
        if (wordTimeline.length) {
            wordTimeline.forEach((item, index) => {
                const span = document.createElement('span');
                span.className = 'ae-preview-word';
                span.dataset.wordIndex = index;
                span.textContent = `${item.word}${/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(item.word || '') ? '' : ' '}`;
                span.style.cssText = 'border-radius:4px;padding:1px 2px;transition:background .12s,color .12s;';
                scriptContent.appendChild(span);
            });
            const targetTitle = document.createElement('div');
            targetTitle.textContent = '目标文案';
            targetTitle.style.cssText = 'font-size:11px;font-weight:700;color:#a5b4fc;margin-top:16px;margin-bottom:5px;border-top:1px solid rgba(255,255,255,.08);padding-top:10px;';
            const targetText = document.createElement('div');
            targetText.textContent = scriptText;
            targetText.style.cssText = 'font-size:14px;line-height:1.55;white-space:pre-wrap;color:#aeb6d8;';
            scriptContent.append(targetTitle, targetText);
        } else {
            scriptContent.textContent = scriptText;
        }
        scriptPanel.append(scriptTitle, scriptContent);
        previewBody.append(videoWrap, scriptPanel);
        container.appendChild(previewBody);

        if (wordTimeline.length) {
            let activeWord = -1;
            videoEl.addEventListener('timeupdate', () => {
                const time = videoEl.currentTime;
                let next = wordTimeline.findIndex(item => time >= Number(item.start) && time <= Number(item.end));
                if (next < 0) next = wordTimeline.findIndex(item => Number(item.start) > time);
                if (next === activeWord) return;
                scriptContent.querySelectorAll('.ae-preview-word').forEach((span, index) => {
                    const active = index === next;
                    span.style.background = active ? '#facc15' : 'transparent';
                    span.style.color = active ? '#111' : '#fff';
                    span.style.fontWeight = active ? '800' : '400';
                    if (active) span.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                });
                activeWord = next;
            });
        }
    } else {
        container.appendChild(videoWrap);
    }
    overlay.appendChild(container);
    
    overlay.onclick = (e) => {
        if (e.target === overlay) destroy();
    };
    
    document.body.appendChild(overlay);
};

window.replaceAutoEditClip = async function(originalPath, index) {
    if (!window.electronAPI || !window.electronAPI.selectFiles) {
        showToast('当前环境不支持选择文件', 'error');
        return;
    }
    const files = await window.electronAPI.selectFiles({
        title: '选择替换的视频片段',
        properties: ['openFile'],
        filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] }]
    });
    if (!files || files.length === 0) return;
    const newClipPath = files[0];
    
    window.showAutoEditModalLoading('🔄 正在备份、替换视频文件并重新对齐，请稍候...');
    
    const result = await window.electronAPI.apiCall('media/auto-edit-replace-clip', {
        originalClipPath: originalPath,
        newClipPath: newClipPath
    });
    
    if (result && result.success) {
        // Update the file path in autoEditFiles
        const updatedPath = result.updatedPath || (result.data && result.data.updatedPath) || originalPath;
        const targetPath = String(originalPath || '').replace(/\\/g, '/');
        let fileIdx = autoEditFiles.findIndex(f => String(f.path || '').replace(/\\/g, '/') === targetPath);
        if (fileIdx !== -1) {
            autoEditFiles[fileIdx].path = updatedPath;
            autoEditFiles[fileIdx].name = updatedPath.split(/[/\\]/).pop();
            autoEditFiles[fileIdx].status = '';
            autoEditFiles[fileIdx].error = null;
            renderAutoEditFiles();
        }

        const reportModal = document.getElementById('ae-report-dialog-overlay');
        if (reportModal) reportModal.remove();

        showToast(`片段已替换，原文件已备份到 ${result.backupPath || result.data?.backupPath || 'backup_clips'}`, 'success', 5000);
        await startAutoEditByScript(false, { analysisOnly: true });
    } else {
        showToast(`替换失败: ${result ? result.error : '未知错误'}`, 'error');
    }
};

window.reopenAutoEditMismatchDialog = function() {
    if (!window.autoEditLastMismatches) {
        showToast('没有上一次的对齐核对数据', 'error');
        return;
    }
    const scriptText = document.getElementById('autoedit-script')?.value || '';
    _showAutoEditMismatchDialog(window.autoEditLastMismatches, scriptText, window.autoEditLastMissingBlocks || []).then(dialogResult => {
        if (!dialogResult) return;
        const clipEdits = Array.isArray(dialogResult) ? dialogResult : (dialogResult?.clipEdits || []);
        const ignoredMissingBlocks = Array.isArray(dialogResult) ? [] : (dialogResult?.ignoredMissingBlocks || []);
        if (dialogResult && (dialogResult.confirmed || clipEdits.length > 0 || ignoredMissingBlocks.length > 0)) {
            const rawLines = scriptText.replace(/\r\n/g, '\n').split('\n');
            const cleanedToRawIndex = [];
            for (let i = 0; i < rawLines.length; i++) {
                if (rawLines[i].trim().length > 0) {
                    cleanedToRawIndex.push(i);
                }
            }
            const operations = [];
            for (const r of clipEdits) {
                const mismatch = window.autoEditLastMismatches.find(m => m.clipIndex === r.clipIndex);
                if (!mismatch) continue;
                const fileObj = autoEditFiles.find(f => f.path === mismatch.clipPath);
                if (fileObj) {
                    fileObj.speed = r.speed || 1.0;
                }
                if (mismatch.similarity >= 50 && mismatch.scriptStartLine !== -1) {
                    const cleanStart = mismatch.scriptStartLine;
                    const cleanEnd = mismatch.scriptEndLine;
                    operations.push({
                        cleanStart,
                        cleanEnd,
                        newLines: r.finalText.replace(/\r\n/g, '\n').split('\n'),
                    });
                } else {
                    const fileObj = autoEditFiles.find(f => f.path === mismatch.clipPath);
                    if (fileObj) {
                        fileObj.manualTranscript = r.finalText;
                    }
                }
            }
            for (const block of ignoredMissingBlocks) {
                operations.push({
                    cleanStart: block.startLine,
                    cleanEnd: block.endLine,
                    newLines: [],
                });
            }
            operations.sort((a, b) => {
                if (b.cleanStart !== a.cleanStart) return b.cleanStart - a.cleanStart;
                return b.cleanEnd - a.cleanEnd;
            });
            for (const op of operations) {
                const rawStart = cleanedToRawIndex[op.cleanStart];
                const rawEnd = cleanedToRawIndex[op.cleanEnd];
                if (rawStart === undefined || rawEnd === undefined) continue;
                rawLines.splice(rawStart, rawEnd - rawStart + 1, ...op.newLines);
            }
            const newScriptText = rawLines.join('\n');
            autoEditIgnoreMismatch = true;
            setTimeout(() => {
                startAutoEditByScript(true, { scriptTextOverride: newScriptText });
            }, 100);
        }
    });
};

window.copyTextToClipboard = function(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast('已复制到剪贴板', 'success');
    }).catch(err => {
        console.error('复制失败:', err);
        showToast('复制失败', 'error');
    });
};

window.showAutoEditModalLoading = function(message) {
    const modal = document.getElementById('ae-mismatch-dialog-overlay');
    if (!modal) return;
    const content = modal.querySelector('div');
    if (!content) return;
    content.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;gap:20px;height:300px;text-align:center;">
            <div style="width:50px;height:50px;border:3px solid rgba(255,255,255,0.1);border-radius:50%;border-top-color:#6366f1;animation:ae-spin 1s linear infinite;margin-bottom:10px;"></div>
            <div id="ae-modal-loading-title" style="font-size:15px;color:#a5b4fc;font-weight:600;">${message || '正在重新处理中，请稍候...'}</div>
            <div id="ae-modal-loading-progress-bar-container" style="width:280px;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin-top:5px;display:none;">
                <div id="ae-modal-loading-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#6366f1,#4f46e5);transition:width 0.2s ease;"></div>
            </div>
            <div id="ae-modal-loading-subtitle" style="font-size:12px;color:#8b95c0;font-weight:400;margin-top:2px;"></div>
        </div>
    `;
};

window.retranscribeAutoEditClip = async function(originalPath, index) {
    window.showAutoEditModalLoading('🎙️ 正在清空此片段的转录缓存，请稍候...');
    const result = await window.electronAPI.apiCall('media/clear-clip-cache', {
        file_path: originalPath
    });
    
    if (result && result.success) {
        // Find in autoEditFiles and reset status
        const targetPath = String(originalPath || '').replace(/\\/g, '/');
        let fileIdx = autoEditFiles.findIndex(f => String(f.path || '').replace(/\\/g, '/') === targetPath);
        if (fileIdx !== -1) {
            autoEditFiles[fileIdx].status = '';
            autoEditFiles[fileIdx].error = null;
            renderAutoEditFiles();
        }
        
        window.showAutoEditModalLoading('🎙️ 缓存已清空，正在重新对齐，请稍候...');
        
        // Close modals safely
        const reportModal = document.getElementById('ae-report-dialog-overlay');
        if (reportModal) reportModal.remove();
        
        // Re-run
        startAutoEditByScript(true);
    } else {
        showToast(`清除缓存失败: ${result ? result.error : '未知错误'}`, 'error');
        startAutoEditByScript(true);
    }
};

window.removeAutoEditClip = async function(filePath, index) {
    const targetPath = String(filePath || '').replace(/\\/g, '/');
    let fileIdx = autoEditFiles.findIndex(f => String(f.path || '').replace(/\\/g, '/') === targetPath);
    if (fileIdx !== -1) {
        const baseName = autoEditFiles[fileIdx].name;
        window.showAutoEditModalLoading(`🔕 正在从工作区排除片段 ${baseName}，请稍候...`);
        autoEditFiles.splice(fileIdx, 1);
        renderAutoEditFiles();
        showToast(`已排除片段: ${baseName}`, 'success');
        
        // Close modals safely
        const reportModal = document.getElementById('ae-report-dialog-overlay');
        if (reportModal) reportModal.remove();
        
        // Re-run
        startAutoEditByScript(true);
    } else {
        showToast('找不到指定的视频片段，已取消忽略，避免误删其他片段', 'error');
    }
};

window.addSupplementaryClip = async function(targetLineIdx) {
    if (!window.electronAPI || !window.electronAPI.selectFiles) {
        showToast('当前环境不支持选择文件', 'error');
        return;
    }
    const files = await window.electronAPI.selectFiles({
        title: '选择要补充的视频片段',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv'] }]
    });
    if (!files || files.length === 0) return;
    
    window.showAutoEditModalLoading('➕ 正在导入补充视频片段并重新对齐，请稍候...');

    // Helper to get normalized folder path
    const getNormalizedDir = (p) => {
        const clean = p.replace(/\\/g, '/');
        const idx = clean.lastIndexOf('/');
        return idx !== -1 ? clean.substring(0, idx) : '';
    };

    // 1. Calculate the majority directory of the current files
    let majorityDir = '';
    if (autoEditFiles.length > 0) {
        const counts = {};
        autoEditFiles.forEach(f => {
            const d = getNormalizedDir(f.path);
            if (d) counts[d] = (counts[d] || 0) + 1;
        });
        let maxCount = 0;
        for (const [d, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                majorityDir = d;
            }
        }
        if (!majorityDir && autoEditFiles.length > 0) {
            majorityDir = getNormalizedDir(autoEditFiles[0].path);
        }
    }

    const addedFiles = [];
    const skippedFiles = [];

    // 2. Process each file
    for (const filePath of files) {
        const baseName = filePath.split(/[/\\]/).pop();
        const fileDir = getNormalizedDir(filePath);

        // Check if exact source path is already in the list
        const isExactDuplicate = autoEditFiles.some(f => f.path.replace(/\\/g, '/') === filePath.replace(/\\/g, '/'));
        if (isExactDuplicate) {
            skippedFiles.push(baseName);
            continue;
        }

        let finalPath = filePath;
        // If the directory differs from the majority directory, copy it
        if (majorityDir && fileDir !== majorityDir) {
            const copyResult = await window.electronAPI.apiCall('media/copy-file', {
                srcPath: filePath,
                destDir: majorityDir,
                destFileName: baseName
            });
            if (copyResult && copyResult.success && copyResult.data.path) {
                finalPath = copyResult.data.path;
            }
        }

        // Check if the copied final path is already in the list
        const isFinalDuplicate = autoEditFiles.some(f => f.path.replace(/\\/g, '/') === finalPath.replace(/\\/g, '/'));
        if (isFinalDuplicate) {
            const finalBase = finalPath.split(/[/\\]/).pop();
            skippedFiles.push(finalBase);
            continue;
        }

        addedFiles.push({
            name: finalPath.split(/[/\\]/).pop(),
            path: finalPath,
            status: '',
            error: null
        });
    }

    // 3. Show feedback for duplicates
    if (skippedFiles.length > 0) {
        showToast(`⚠️ 已跳过重复视频: ${skippedFiles.join(', ')}`, 'warning', 6000);
    }

    if (addedFiles.length === 0) {
        // Re-run anyway to restore the nuclear warning modal
        startAutoEditByScript(true);
        return;
    }

    if (targetLineIdx !== undefined && targetLineIdx !== null && targetLineIdx !== '') {
        // Find correct insertion index in autoEditFiles based on targetLineIdx
        let insertIndex = autoEditFiles.length;
        const mismatches = window.autoEditLastMismatches;
        
        const filePositions = autoEditFiles.map((f, idx) => {
            const m = mismatches?.find(x => x.clipPath.replace(/\\/g, '/') === f.path.replace(/\\/g, '/'));
            return {
                index: idx,
                line: (m && m.scriptStartLine !== -1 && m.scriptStartLine !== undefined) ? m.scriptStartLine : 999999
            };
        });
        
        const nextFileIdx = filePositions.findIndex(p => p.line > targetLineIdx);
        if (nextFileIdx !== -1) {
            insertIndex = nextFileIdx;
        }
        
        autoEditFiles.splice(insertIndex, 0, ...addedFiles);
    } else {
        autoEditFiles.push(...addedFiles);
        autoEditFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    }
    renderAutoEditFiles();
    
    // Close modals safely
    const reportModal = document.getElementById('ae-report-dialog-overlay');
    if (reportModal) reportModal.remove();
    
    // Re-run
    startAutoEditByScript(true);
};

function parseMarkdownToHtml(md) {
    let html = String(md || '');
    
    // Escape HTML first to prevent XSS issues but keep our rendering safe
    html = html.replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
    
    // Restore safe inline diff HTML tags
    html = html.replace(/&lt;del style=&quot;([\s\S]*?)&quot;&gt;([\s\S]*?)&lt;\/del&gt;/g, '<del style="$1">$2</del>');
    html = html.replace(/&lt;ins style=&quot;([\s\S]*?)&quot;&gt;([\s\S]*?)&lt;\/ins&gt;/g, '<ins style="$1">$2</ins>');
    html = html.replace(/&lt;details( open)?&gt;/g, '<details$1>');
    html = html.replace(/&lt;\/details&gt;/g, '</details>');
    html = html.replace(/&lt;summary&gt;/g, '<summary>');
    html = html.replace(/&lt;\/summary&gt;/g, '</summary>');
    html = html.replace(/&lt;b&gt;/g, '<b>');
    html = html.replace(/&lt;\/b&gt;/g, '</b>');

    // Parse replace clip action tag
    html = html.replace(/\[action:replace-clip\|path:(.*?)\|index:(\d+)\]/g, (m, filePath, index) => {
        const safePath = filePath.replace(/\\/g, '\\\\');
        return `<div style="display:inline-block;margin:4px 8px 6px 14px;"><button class="btn btn-secondary" onclick="window.replaceAutoEditClip('${safePath}', ${index})" style="font-size:11px;padding:3px 10px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;font-family:inherit;transition:all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.22)'" onmouseout="this.style.background='rgba(239,68,68,0.12)'">🔄 替换此片段并重新对齐</button></div>`;
    });

    // Parse re-transcribe clip action tag
    html = html.replace(/\[action:retranscribe-clip\|path:(.*?)\|index:(\d+)\]/g, (m, filePath, index) => {
        const safePath = filePath.replace(/\\/g, '\\\\');
        return `<div style="display:inline-block;margin:4px 8px 6px 0;"><button class="btn btn-secondary" onclick="window.retranscribeAutoEditClip('${safePath}', ${index})" style="font-size:11px;padding:3px 10px;background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);color:#818cf8;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;font-family:inherit;transition:all 0.2s;" onmouseover="this.style.background='rgba(99,102,241,0.22)'" onmouseout="this.style.background='rgba(99,102,241,0.12)'">🎙️ 重录/重新转录此片段</button></div>`;
    });

    // Parse add supplementary clip action tag
    html = html.replace(/\[action:add-supplementary-clip(?:\|line:(\d+))?\]/g, (m, lineIdx) => {
        const lineArg = lineIdx !== undefined ? parseInt(lineIdx, 10) : '';
        return `<div style="display:inline-block;margin:4px 8px 6px 14px;"><button class="btn btn-secondary" onclick="window.addSupplementaryClip(${lineArg})" style="font-size:11px;padding:3px 10px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);color:#4ade80;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;font-family:inherit;transition:all 0.2s;" onmouseover="this.style.background='rgba(16,185,129,0.22)'" onmouseout="this.style.background='rgba(16,185,129,0.12)'">➕ 补充视频片段并重新对齐</button></div>`;
    });

    // Parse video path button
    html = html.replace(/-\s+\*\*视频路径\*\*:\s+`(.*?)`(\s+\[time:([\d\.]+),([\d\.]+)\])?/g, (m, filePath, hasTime, start, end) => {
        const safePath = filePath.replace(/\\/g, '\\\\');
        const startVal = start ? parseFloat(start) : 0;
        const endVal = end ? parseFloat(end) : 0;
        return `<div style="margin:6px 0;padding-left:14px;position:relative;"><button class="btn btn-secondary" onclick="window.playVideoClip('${safePath}', ${startVal}, ${endVal})" style="font-size:11px;padding:3px 10px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.3);color:#60a5fa;border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;line-height:1.2;font-family:inherit;transition:all 0.2s;" onmouseover="this.style.background='rgba(59,130,246,0.22)'" onmouseout="this.style.background='rgba(59,130,246,0.12)'">▶️ 播放当前片段</button></div>`;
    });
    
    // Parse triple backticks code blocks
    html = html.replace(/&lt;!--\s*slide\s*--&gt;/g, '');
    html = html.replace(/```(?:text)?([\s\S]*?)```/g, (m, code) => {
        return `<pre style="background:#070714;padding:12px;border-radius:8px;overflow-x:auto;color:#a5b4fc;font-family:'Courier New',Courier,monospace;font-size:12px;line-height:1.5;margin:8px 0;border:1px solid rgba(255,255,255,0.05);white-space:pre-wrap;word-break:break-all;">${code.trim()}</pre>`;
    });
    
    // Parse headers
    html = html.replace(/^#\s+(.*?)$/gm, '<h2 style="font-size:18px;font-weight:700;color:#fff;margin:16px 0 10px 0;border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:6px;">$1</h2>');
    html = html.replace(/^##\s+(.*?)$/gm, '<h3 style="font-size:14px;font-weight:600;color:#e8ecff;margin:14px 0 8px 0;border-left:3px solid var(--accent);padding-left:8px;">$1</h3>');
    html = html.replace(/^###\s+(.*?)$/gm, '<h4 style="font-size:13px;font-weight:600;color:#a5b4fc;margin:12px 0 6px 0;">$1</h4>');
    
    // Parse bold text
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="color:#fff;font-weight:600;">$1</strong>');
    
    // Parse inline code
    html = html.replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-family:monospace;font-size:11px;color:#ff9e9e;">$1</code>');
    
    // Parse list items
    html = html.replace(/^-\s+(.*?)$/gm, '<div style="margin:4px 0;padding-left:14px;position:relative;line-height:1.5;"><span style="position:absolute;left:2px;color:var(--accent);">•</span>$1</div>');
    
    // Parse dividers
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.06);margin:16px 0;" />');
    
    // Format line breaks for general paragraphs (preserving already converted block tags)
    const lines = html.split('\n');
    const processedLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '<div style="height:8px;"></div>';
        if (trimmed.startsWith('<h') || trimmed.startsWith('<div') || trimmed.startsWith('<pre') || trimmed.startsWith('<hr') || trimmed.startsWith('</pre>') || trimmed.startsWith('<details') || trimmed.startsWith('</details>') || trimmed.startsWith('<summary') || trimmed.startsWith('</summary>')) {
            return line;
        }
        return `<p style="margin:6px 0;line-height:1.6;color:#c7cfeb;">${line}</p>`;
    });
    
    return processedLines.join('\n');
}

function _showReportDialog(reportText, reportPath) {
    const modal = document.createElement('div');
    modal.id = 'ae-report-dialog-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    const content = document.createElement('div');
    content.style.cssText = 'background:#13132a;width:720px;max-height:80%;border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 20px 60px rgba(0,0,0,0.6);display:flex;flex-direction:column;gap:16px;color:#e8ecff;';

    const htmlContent = parseMarkdownToHtml(reportText);

    content.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.06);padding-bottom:12px;">
            <span style="font-size:24px;">📊</span>
            <div style="flex:1;">
                <h3 style="margin:0;color:#e8ecff;font-size:16px;font-weight:700;">文案与视频音频对齐报告</h3>
                <div style="font-size:11px;color:#8b95c0;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${reportPath}">报告文件: ${reportPath}</div>
            </div>
            <button id="ae-report-dialog-close" style="border:none;background:rgba(255,255,255,0.06);color:#999;border-radius:8px;padding:6px 12px;font-size:14px;cursor:pointer;line-height:1;transition:all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)';this.style.color='#fff';" onmouseout="this.style.background='rgba(255,255,255,0.06)';this.style.color='#999';">关闭</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding-right:8px;font-size:13px;" class="scroll-container">
            ${htmlContent}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:12px;">
            <button id="ae-report-dialog-folder" class="btn btn-secondary" style="font-size:12px;padding:6px 14px;">📁 打开输出文件夹</button>
            <button id="ae-report-dialog-confirm" class="btn btn-primary" style="font-size:12px;padding:6px 18px;">好的</button>
        </div>
    `;

    modal.appendChild(content);
    document.body.appendChild(modal);

    const closeBtn = content.querySelector('#ae-report-dialog-close');
    const confirmBtn = content.querySelector('#ae-report-dialog-confirm');
    const folderBtn = content.querySelector('#ae-report-dialog-folder');

    const destroy = () => {
        document.body.removeChild(modal);
    };

    closeBtn.onclick = destroy;
    confirmBtn.onclick = destroy;
    folderBtn.onclick = () => {
        if (window.electronAPI?.showItemInFolder) {
            window.electronAPI.showItemInFolder(reportPath);
        }
        destroy();
    };

    modal.onclick = (e) => {
        if (e.target === modal) destroy();
    };
}

window.viewAutoEditReport = viewAutoEditReport;

function showAutoEditResultFile(index) {
    const item = autoEditResultFiles[index];
    if (item?.path && window.electronAPI?.showItemInFolder) {
        window.electronAPI.showItemInFolder(item.path);
    }
}

function openAutoEditOutputDir() {
    if (autoEditOutputDir && window.electronAPI?.showItemInFolder) {
        window.electronAPI.showItemInFolder(autoEditOutputDir);
    } else {
        showToast('还没有输出目录', 'info');
    }
}

async function sendAutoEditResultToReels(result = null, options = {}) {
    const data = result || autoEditLastResult;
    if (!data?.output_path || !data?.srt_path) {
        const error = new Error('还没有可送入批量 Reels 的自动剪辑结果');
        if (!options.silent) showToast(error.message, 'error');
        throw error;
    }
    if (typeof window.reelsCreateTaskFromAutoEditResult !== 'function') {
        const error = new Error('批量 Reels 接收功能未加载');
        if (!options.silent) showToast('批量 Reels 接收功能未加载，请先打开批量 Reels 页面后再试', 'error');
        throw error;
    }

    try {
        const task = await window.reelsCreateTaskFromAutoEditResult(data);
        if (typeof openPanelByName === 'function') openPanelByName('batch-reels');
        if (!options.silent) {
            showToast(`已送入批量 Reels: ${task?.fileName || '自动剪辑任务'}`, 'success');
        }
    } catch (error) {
        if (!options.silent) showToast(`送入批量 Reels 失败: ${escapeHtml(error.message)}`, 'error');
        throw error;
    }
}

function openAutoEditFromReels() {
    if (typeof openPanelByName === 'function') openPanelByName('media');
    if (typeof switchMediaSubtab === 'function') switchMediaSubtab('media-autoedit');

    document.querySelectorAll('.media-sidebar .sidebar-item').forEach(item => {
        item.classList.toggle('active', item.dataset.subtab === 'media-autoedit');
    });

    const sendCheckbox = document.getElementById('autoedit-send-reels');
    if (sendCheckbox) sendCheckbox.checked = true;
}

// ==================== 批量剪辑模块 ====================

let batchCutFilePath = '';
let batchCutSegments = [];  // [{name, start, end, checked, videoPath?, videoDuration?, clipColor?}]
let batchCutOutputDir = '';
let batchCutPreviewIndex = -1;
let batchCutPreviewSrc = '';
let batchCutMultiMode = false;

// ===== 达芬奇 Clip Color 调色板（16 种标准色）=====
const DAVINCI_CLIP_COLORS = {
    '':          { label: '无颜色', hex: 'transparent' },
    'Orange':    { label: '🟠 橙色',   hex: '#FF8C00' },
    'Apricot':   { label: '🍑 杏色',   hex: '#FFA07A' },
    'Yellow':    { label: '🟡 黄色',   hex: '#FFD700' },
    'Lime':      { label: '🟢 青柠',   hex: '#32CD32' },
    'Olive':     { label: '🫒 橄榄',   hex: '#808000' },
    'Green':     { label: '💚 绿色',   hex: '#228B22' },
    'Teal':      { label: '🩵 蓝绿',   hex: '#008080' },
    'Navy':      { label: '🔵 海军蓝', hex: '#000080' },
    'Blue':      { label: '💙 蓝色',   hex: '#4169E1' },
    'Purple':    { label: '💜 紫色',   hex: '#8A2BE2' },
    'Violet':    { label: '🟣 紫罗兰', hex: '#EE82EE' },
    'Pink':      { label: '💗 粉色',   hex: '#FF69B4' },
    'Tan':       { label: '🟤 棕褐',   hex: '#D2B48C' },
    'Beige':     { label: '🏷️ 米色',   hex: '#F5F5DC' },
    'Brown':     { label: '🤎 棕色',   hex: '#8B4513' },
    'Chocolate': { label: '🍫 巧克力', hex: '#D2691E' },
};

/** 更新片段 clipColor */
function batchCutSetClipColor(index, color) {
    if (batchCutSegments[index]) {
        batchCutSegments[index].clipColor = color;
        renderBatchCutSegments();
    }
}

/** 为所有片段随机分配 Clip Color（相邻不重复） */
function batchCutRandomColors() {
    if (batchCutSegments.length === 0) {
        showToast('没有片段可着色', 'info');
        return;
    }
    // 收集有效颜色 key（排除空值）
    const colorKeys = Object.keys(DAVINCI_CLIP_COLORS).filter(k => k !== '');
    // Fisher-Yates 洗牌
    const shuffled = [...colorKeys];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // 依次分配（循环使用），确保相邻不同色
    for (let i = 0; i < batchCutSegments.length; i++) {
        batchCutSegments[i].clipColor = shuffled[i % shuffled.length];
    }
    renderBatchCutSegments();
    showToast(`🎨 已为 ${batchCutSegments.length} 个片段随机着色`, 'success');
}

// 初始化批量剪辑文件输入
document.addEventListener('DOMContentLoaded', () => {
    const batchCutInput = document.getElementById('batchcut-video-input');
    if (batchCutInput) {
        batchCutInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                batchCutFilePath = getFileNativePath(file);
                document.getElementById('batchcut-video-path').value = file.name;
                loadBatchCutVideoInfo(batchCutFilePath);
            }
        });
    }

    // 拖拽支持（单视频）
    const dropZone = document.getElementById('batchcut-drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent)';
            dropZone.style.background = 'rgba(102,126,234,0.05)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-color)';
            dropZone.style.background = '';
            const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
            const file = Array.from(e.dataTransfer.files).find(f =>
                videoExts.some(ext => f.name.toLowerCase().endsWith(ext))
            );
            if (file) {
                batchCutFilePath = getFileNativePath(file);
                document.getElementById('batchcut-video-path').value = file.name;
                loadBatchCutVideoInfo(batchCutFilePath);
            }
        });
    }

    // === 多视频模式文件输入 ===
    const multiInput = document.getElementById('batchcut-multi-input');
    if (multiInput) {
        multiInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                batchCutMultiAddFiles(Array.from(e.target.files));
                e.target.value = ''; // 重置，允许重复选择
            }
        });
    }
    // 拖拽支持（多视频）
    const multiDrop = document.getElementById('batchcut-multi-drop-zone');
    if (multiDrop) {
        multiDrop.addEventListener('dragover', (e) => {
            e.preventDefault();
            multiDrop.style.borderColor = 'var(--accent)';
            multiDrop.style.background = 'rgba(102,126,234,0.05)';
        });
        multiDrop.addEventListener('dragleave', () => {
            multiDrop.style.borderColor = 'var(--border-color)';
            multiDrop.style.background = '';
        });
        multiDrop.addEventListener('drop', (e) => {
            e.preventDefault();
            multiDrop.style.borderColor = 'var(--border-color)';
            multiDrop.style.background = '';
            const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
            const files = Array.from(e.dataTransfer.files).filter(f =>
                videoExts.some(ext => f.name.toLowerCase().endsWith(ext))
            );
            if (files.length > 0) batchCutMultiAddFiles(files);
        });
    }
});

// 加载视频信息（自动检测帧率）
async function loadBatchCutVideoInfo(filePath) {
    const infoEl = document.getElementById('batchcut-video-info');
    infoEl.style.display = 'block';
    infoEl.innerHTML = '⏳ 正在读取视频信息...';
    try {
        const resp = await apiFetch(`${API_BASE}/media/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: filePath })
        });
        const data = await resp.json();
        console.log('[batchcut] media/info response:', data);
        if (!resp.ok) throw new Error(data.error || '获取视频信息失败');
        if (data.duration) {
            const fpsText = data.frame_rate ? ` | 帧率: <strong>${data.frame_rate} fps</strong>` : '';
            const resText = data.resolution ? ` | 分辨率: <strong>${data.resolution}</strong>` : '';
            infoEl.innerHTML = `📹 时长: <strong>${formatBatchCutTime(data.duration)}</strong> (${data.duration.toFixed(3)}s)${fpsText}${resText}`;

            // 自动设置帧率选择器
            if (data.frame_rate) {
                const fpsSelect = document.getElementById('batchcut-fps');
                const fps = parseFloat(data.frame_rate);
                // 尝试匹配已有选项
                let matched = false;
                for (const opt of fpsSelect.options) {
                    if (Math.abs(parseFloat(opt.value) - fps) < 0.05) {
                        opt.selected = true;
                        matched = true;
                        break;
                    }
                }
                // 没有匹配到 → 添加自定义选项
                if (!matched) {
                    const newOpt = document.createElement('option');
                    newOpt.value = fps;
                    newOpt.textContent = `${fps} fps (检测)`;
                    newOpt.selected = true;
                    fpsSelect.appendChild(newOpt);
                }
            }
        } else {
            infoEl.innerHTML = '⚠️ 无法获取视频信息';
        }
    } catch (e) {
        infoEl.innerHTML = `❌ ${escapeHtml(e.message)}`;
    }
}

// ---- 剪辑点预览 ----

// 格式化时码显示（HH:MM:SS:FF 格式）
function formatPreviewTimecode(seconds) {
    if (seconds == null || isNaN(seconds)) return '--:--:--:--';
    const fps = parseFloat(document.getElementById('batchcut-fps')?.value || 25);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * fps);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

// ===== 多视频模式函数 =====

// 切换多视频模式
function toggleBatchCutMultiMode() {
    batchCutMultiMode = document.getElementById('batchcut-multi-mode')?.checked || false;

    // 切换 UI 区域可见性
    const show = el => { if (el) el.style.display = ''; };
    const hide = el => { if (el) el.style.display = 'none'; };

    const singleSection = document.getElementById('batchcut-single-section');
    const multiSection = document.getElementById('batchcut-multi-section');
    const previewSection = document.getElementById('batchcut-preview-section');
    const singleToolbar = document.getElementById('batchcut-single-toolbar');
    const multiToolbar = document.getElementById('batchcut-multi-toolbar');
    const timeHints = document.getElementById('batchcut-time-hints');
    const cutOptions = document.getElementById('batchcut-cut-options');
    const startBtn = document.getElementById('batchcut-start-btn');

    if (batchCutMultiMode) {
        hide(singleSection);
        show(multiSection);
        hide(previewSection);
        hide(singleToolbar);
        show(multiToolbar);
        hide(timeHints);
        hide(cutOptions);
        hide(startBtn);
    } else {
        show(singleSection);
        hide(multiSection);
        show(singleToolbar);
        hide(multiToolbar);
        show(timeHints);
        show(cutOptions);
        show(startBtn);
    }

    // 清空片段并重新渲染
    batchCutSegments = [];
    batchCutPreviewIndex = -1;
    renderBatchCutTableHeader();
    renderBatchCutSegments();
}

// 多视频模式：添加文件
async function batchCutMultiAddFiles(files) {
    const videoExts = ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'];
    const validFiles = files.filter(f =>
        videoExts.some(ext => f.name.toLowerCase().endsWith(ext))
    );
    if (validFiles.length === 0) {
        showToast('没有找到有效的视频文件', 'error');
        return;
    }

    // 按文件名自然排序
    validFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    showToast(`正在加载 ${validFiles.length} 个视频...`, 'info');

    for (const file of validFiles) {
        const filePath = getFileNativePath(file);
        const name = file.name.replace(/\.[^.]+$/, ''); // 去掉扩展名

        // 检查是否已添加
        if (batchCutSegments.some(s => s.videoPath === filePath)) continue;

        // 获取时长
        let duration = 0;
        try {
            const resp = await apiFetch(`${API_BASE}/media/info`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_path: filePath })
            });
            const info = await resp.json();
            if (info.duration) duration = info.duration;
        } catch (e) {
            console.warn('获取视频时长失败:', filePath, e.message);
        }

        const subtitles = [''];
        while (subtitles.length < batchCutSubtitleCols.length) subtitles.push('');

        batchCutSegments.push({
            name,
            start: '',
            end: '',
            subtitles,
            checked: true,
            videoPath: filePath,
            videoDuration: duration
        });
    }

    renderBatchCutTableHeader();
    renderBatchCutSegments();
    showToast(`已添加 ${validFiles.length} 个视频`, 'success');

    // 异步生成缩略图
    batchCutGenerateThumbnails();
}

// 多视频模式：选择文件夹
async function batchCutMultiSelectFolder() {
    try {
        // Electron 的 dialog API
        if (window.electronAPI?.selectFolder) {
            const folderPath = await window.electronAPI.selectFolder();
            if (!folderPath) return;
            // 请求后端扫描文件夹中的视频文件
            showToast('请通过「选择多个视频」按钮选取文件', 'info');
        } else {
            // 回退：使用 file input
            document.getElementById('batchcut-multi-input')?.click();
        }
    } catch (e) {
        showToast('选择文件夹失败: ' + e.message, 'error');
    }
}

// 多视频模式：粘贴文案（复用粘贴弹窗）
function batchCutMultiPasteText() {
    if (batchCutSegments.length === 0) {
        showToast('请先添加视频文件', 'error');
        return;
    }
    openBatchCutPasteModal('multi');
}

// 视频缩略图生成
function batchCutGenThumb(videoPath) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.preload = 'metadata';
        const src = window.electronAPI?.toFileUrl?.(videoPath) || normalizeFilePath(videoPath);
        video.src = src;

        const timeout = setTimeout(() => { resolve(''); }, 5000);

        video.addEventListener('loadeddata', () => {
            video.currentTime = Math.min(1, video.duration * 0.1 || 0.5);
        }, { once: true });

        video.addEventListener('seeked', () => {
            clearTimeout(timeout);
            try {
                const canvas = document.createElement('canvas');
                const w = 80, h = Math.round(80 * video.videoHeight / video.videoWidth) || 60;
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(video, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.6));
            } catch (e) {
                resolve('');
            }
            video.src = '';
        }, { once: true });

        video.addEventListener('error', () => { clearTimeout(timeout); resolve(''); }, { once: true });
    });
}

async function batchCutGenerateThumbnails() {
    for (const seg of batchCutSegments) {
        if (seg.videoPath && !seg.thumbnail) {
            seg.thumbnail = await batchCutGenThumb(seg.videoPath);
            renderBatchCutSegments(); // 渐进式更新
        }
    }
}

// ===== 视频名称自动匹配 =====

// 归一化文件名（去扩展名、特殊字符、转小写）
function normalizeVideoName(str) {
    return (str || '')
        .replace(/\.[^.]+$/, '')       // 去扩展名
        .replace(/[_\-\.\s]+/g, ' ')   // 特殊字符转空格
        .trim()
        .toLowerCase();
}

// 计算两个字符串的相似度（Dice coefficient on bigrams）
function stringSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    // 子串包含检查
    if (a.includes(b) || b.includes(a)) return 0.9;

    const bigrams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const setA = bigrams(a), setB = bigrams(b);
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const g of setA) if (setB.has(g)) inter++;
    return (2 * inter) / (setA.size + setB.size);
}

// 检测哪一列是视频名称列
function batchCutDetectVideoNameCol(rows, maxCols) {
    if (batchCutSegments.length === 0 || maxCols === 0) {
        return { col: -1, matchMap: {} };
    }

    // 获取所有视频文件名（归一化）
    const videoNames = batchCutSegments.map(s =>
        normalizeVideoName((s.videoPath || '').split('/').pop().split('\\').pop())
    );

    let bestCol = -1, bestMatchCount = 0, bestMatchMap = {};

    for (let ci = 0; ci < maxCols; ci++) {
        const matchMap = {};
        const usedVideos = new Set();
        let matchCount = 0;

        for (let ri = 0; ri < rows.length; ri++) {
            const cellNorm = normalizeVideoName(rows[ri]?.[ci] || '');
            if (!cellNorm) continue;

            // 找最佳匹配的视频
            let bestSim = 0, bestVi = -1;
            for (let vi = 0; vi < videoNames.length; vi++) {
                if (usedVideos.has(vi)) continue;
                const sim = stringSimilarity(cellNorm, videoNames[vi]);
                if (sim > bestSim) { bestSim = sim; bestVi = vi; }
            }

            if (bestSim >= 0.4 && bestVi >= 0) {
                matchMap[ri] = bestVi;
                usedVideos.add(bestVi);
                matchCount++;
            }
        }

        // 需要至少 30% 的行匹配上
        if (matchCount > bestMatchCount && matchCount >= rows.length * 0.3) {
            bestCol = ci;
            bestMatchCount = matchCount;
            bestMatchMap = matchMap;
        }
    }

    return { col: bestCol, matchMap: bestMatchMap };
}

// 预览某个片段的入出点
function batchCutPreviewSegment(index) {
    if (!batchCutFilePath) {
        showToast('请先选择视频文件', 'error');
        return;
    }
    const seg = batchCutSegments[index];
    if (!seg) return;

    batchCutPreviewIndex = index;

    // 显示预览区域
    const section = document.getElementById('batchcut-preview-section');
    section.style.display = '';

    const videoIn = document.getElementById('batchcut-preview-in');
    const videoOut = document.getElementById('batchcut-preview-out');
    const infoEl = document.getElementById('batchcut-preview-info');

    // 构建视频 src（Electron 本地文件，处理 Windows 反斜杠/中文/空格）
    const videoSrc = window.electronAPI?.toFileUrl?.(batchCutFilePath) || normalizeFilePath(batchCutFilePath);
    if (!videoSrc) {
        showToast('预览失败：无效的视频路径', 'error');
        return;
    }

    // 设置视频源（只在路径变化时重新加载）
    if (batchCutPreviewSrc !== batchCutFilePath) {
        batchCutPreviewSrc = batchCutFilePath;
        videoIn.src = videoSrc.replace(/[<>"]/g, '');
        videoOut.src = videoSrc.replace(/[<>"]/g, '');
        videoIn.onerror = () => {
            console.warn('Preview IN video load error:', videoIn.error?.message, videoSrc);
            showToast('入点预览加载失败，请检查文件路径/编码', 'error');
        };
        videoOut.onerror = () => {
            console.warn('Preview OUT video load error:', videoOut.error?.message, videoSrc);
            showToast('出点预览加载失败，请检查文件路径/编码', 'error');
        };
        videoIn.load();
        videoOut.load();
    }

    const startTime = parseBatchCutTime(seg.start);
    const endTime = seg.end ? parseBatchCutTime(seg.end) : null;

    infoEl.innerHTML = `正在预览: <strong>${escapeHtml(seg.name || '片段' + (index + 1))}</strong> — 入点 ${seg.start}${seg.end ? ' → 出点 ' + seg.end : ' → 结尾'}`;

    // 入点 seek
    const seekIn = () => {
        if (startTime != null) {
            videoIn.currentTime = startTime;
            document.getElementById('batchcut-preview-in-tc').textContent = formatPreviewTimecode(startTime);
        }
    };

    // 出点 seek
    const seekOut = () => {
        if (endTime != null) {
            videoOut.currentTime = endTime;
            document.getElementById('batchcut-preview-out-tc').textContent = formatPreviewTimecode(endTime);
        } else {
            // 到结尾 → seek 到最后
            if (videoOut.duration && isFinite(videoOut.duration)) {
                videoOut.currentTime = Math.max(0, videoOut.duration - 0.1);
                document.getElementById('batchcut-preview-out-tc').textContent = formatPreviewTimecode(videoOut.duration);
            } else {
                document.getElementById('batchcut-preview-out-tc').textContent = '→ 结尾';
            }
        }
    };

    // 视频加载后再 seek
    if (videoIn.readyState >= 1) {
        seekIn();
    } else {
        videoIn.addEventListener('loadedmetadata', seekIn, { once: true });
    }
    if (videoOut.readyState >= 1) {
        seekOut();
    } else {
        videoOut.addEventListener('loadedmetadata', seekOut, { once: true });
    }

    // 更新 timecode 实时显示
    videoIn.ontimeupdate = () => {
        document.getElementById('batchcut-preview-in-tc').textContent = formatPreviewTimecode(videoIn.currentTime);
    };
    videoOut.ontimeupdate = () => {
        document.getElementById('batchcut-preview-out-tc').textContent = formatPreviewTimecode(videoOut.currentTime);
    };

    // 重新渲染列表以高亮当前行
    renderBatchCutSegments();

    // 滚动到预览区
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 逐帧步进
function batchCutPreviewStep(which, direction) {
    const fps = parseFloat(document.getElementById('batchcut-fps')?.value || 25);
    const step = 1 / fps * direction;
    const video = document.getElementById(which === 'out' ? 'batchcut-preview-out' : 'batchcut-preview-in');
    if (video && video.src) {
        video.pause();
        video.currentTime = Math.max(0, video.currentTime + step);
    }
}

// 播放预览（从入点/出点播放 3 秒）
function batchCutPreviewPlay(which) {
    const video = document.getElementById(which === 'out' ? 'batchcut-preview-out' : 'batchcut-preview-in');
    if (!video || !video.src || video.readyState < 2) {
        showToast('视频尚未加载，请先点击片段的 👁️ 按钮', 'info');
        return;
    }

    if (!video.paused) {
        video.pause();
        return;
    }

    const startPos = video.currentTime;
    video.play().catch(err => {
        console.warn('Preview play failed:', err.message);
        showToast('播放失败: ' + err.message, 'error');
    });

    // 3 秒后自动暂停
    const stopAt = startPos + 3;
    const checkStop = () => {
        if (video.currentTime >= stopAt || video.paused) {
            video.pause();
            video.removeEventListener('timeupdate', checkStop);
        }
    };
    video.addEventListener('timeupdate', checkStop);
}

// 时间格式化
function formatBatchCutTime(seconds) {
    if (!seconds || seconds < 0) return '00:00.000';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// 时间解析（支持 HH:MM:SS:FF / HH:MM:SS.mmm / MM:SS / 纯秒）
function parseBatchCutTime(str) {
    if (str === null || str === undefined) return null;
    if (typeof str === 'number') return Number.isFinite(str) && str >= 0 ? str : null;

    const raw = String(str).trim();
    if (!raw) return null;

    // 单时间解析：明确拒绝时间范围文本（如 "14:16-18:43"）
    if (/[—~～]/.test(raw) || /\d\s*-\s*\d/.test(raw)) return null;

    // 兼容 "23： 25" / "00 : 01 : 02 : 12" 这类带空格时码
    const normalized = raw.replace(/：/g, ':').replace(/\s+/g, '');
    const parts = normalized.split(':');
    const isNum = (token) => /^\d+(?:\.\d+)?$/.test(token);
    const fps = parseFloat(document.getElementById('batchcut-fps')?.value || 25);
    if (!Number.isFinite(fps) || fps <= 0) return null;
    const nominalFps = Math.round(fps);

    // HH:MM:SS:FF / HH:MM:SS;FF（; 表示 drop-frame 时码）
    const tcMatch = normalized.match(/^(\d+):(\d+):(\d+)([:;])(\d+)$/);
    if (tcMatch) {
        const hh = parseInt(tcMatch[1], 10);
        const mm = parseInt(tcMatch[2], 10);
        const ss = parseInt(tcMatch[3], 10);
        const sep = tcMatch[4];
        const ff = parseInt(tcMatch[5], 10);

        if (ff >= nominalFps) return null;

        const totalSecondsNominal = hh * 3600 + mm * 60 + ss;
        let totalFrames = totalSecondsNominal * nominalFps + ff;

        // 仅对 29.97 / 59.94 的 ";" 时码应用 drop-frame 规则
        const is2997 = Math.abs(fps - 29.97) < 0.02;
        const is5994 = Math.abs(fps - 59.94) < 0.02;
        if (sep === ';' && (is2997 || is5994)) {
            const dropFrames = nominalFps === 60 ? 4 : 2;
            const totalMinutes = hh * 60 + mm;
            const dropped = dropFrames * (totalMinutes - Math.floor(totalMinutes / 10));
            totalFrames -= dropped;
        }

        return totalFrames / fps;
    }

    if (parts.length === 4) {
        // HH:MM:SS:FF（兼容没有 ; 的 NLE 时码）
        if (!parts.every(isNum)) return null;
        const hh = parseFloat(parts[0]);
        const mm = parseFloat(parts[1]);
        const ss = parseFloat(parts[2]);
        const ff = parseFloat(parts[3]);
        if (ff >= nominalFps) return null;
        const totalFrames = Math.round((hh * 3600 + mm * 60 + ss) * nominalFps + ff);
        return totalFrames / fps;
    } else if (parts.length === 3) {
        if (!parts.every(isNum)) return null;
        return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
        if (!parts.every(isNum)) return null;
        return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 1) {
        if (!isNum(parts[0])) return null;
        return parseFloat(parts[0]);
    }
    return null;
}

// ===== 动态字幕列配置 =====
let batchCutSubtitleCols = [
    { label: '标题字幕', fontSize: 32, color: '#ffe500', position: 'center', bold: true, font: 'Playfair Display', fontFace: 'SemiBold', tracking: 0 },
    { label: '内容字幕', fontSize: 32, color: '#ffe500', position: 'center', bold: true, font: 'Playfair Display', fontFace: 'SemiBold', tracking: 0 },
];

// 添加字幕列
function addBatchCutSubtitleColumn() {
    const idx = batchCutSubtitleCols.length + 1;
    batchCutSubtitleCols.push({
        label: `字幕${idx}`,
        fontSize: 32,
        color: '#ffe500',
        position: 'center',
        bold: true,
        font: 'Playfair Display',
        fontFace: 'SemiBold',
        tracking: 0
    });
    // 给现有片段补空字符串
    for (const seg of batchCutSegments) {
        if (!seg.subtitles) seg.subtitles = [];
        while (seg.subtitles.length < batchCutSubtitleCols.length) seg.subtitles.push('');
    }
    renderBatchCutTableHeader();
    renderBatchCutSegments();
    renderFcpxmlStylePanel();
}

// 删除字幕列
function removeBatchCutSubtitleColumn(colIdx) {
    if (batchCutSubtitleCols.length <= 1) {
        showToast('至少保留一个字幕列', 'info');
        return;
    }
    batchCutSubtitleCols.splice(colIdx, 1);
    for (const seg of batchCutSegments) {
        if (seg.subtitles) seg.subtitles.splice(colIdx, 1);
    }
    renderBatchCutTableHeader();
    renderBatchCutSegments();
    renderFcpxmlStylePanel();
}

// 获取 grid-template-columns
function batchCutGridCols() {
    const subCols = batchCutSubtitleCols.map(() => '1fr').join(' ');
    if (batchCutMultiMode) {
        // 多视频模式：# + ✓ + 🎨色 + 视频缩略图+文件名 + 字幕列 + 操作（含上下移动）
        return `40px 30px 56px minmax(120px, 180px) ${subCols} 90px`;
    }
    // 单视频模式：# + ✓ + 🎨色 + 字幕列 + 入点 + 出点 + 预览 + 操作
    return `40px 30px 56px ${subCols} 120px 120px 40px 50px`;
}

// 渲染表头
function renderBatchCutTableHeader() {
    const el = document.getElementById('batchcut-table-header');
    if (!el) return;
    const subHeaders = batchCutSubtitleCols.map((col, ci) => {
        const removeBtn = batchCutSubtitleCols.length > 1
            ? `<span onclick="removeBatchCutSubtitleColumn(${ci})" style="cursor:pointer; margin-left:2px; opacity:0.5;" title="删除此列">✕</span>`
            : '';
        return `<span contenteditable="true" style="outline:none; cursor:text;" onblur="batchCutSubtitleCols[${ci}].label=this.textContent.trim()||'字幕';renderFcpxmlStylePanel();">${escapeHtml(col.label)}${removeBtn}</span>`;
    }).join('');

    const videoCol = batchCutMultiMode ? '<span>🎬 视频文件</span>' : '';
    const colorHeader = '<span style="text-align: center;" title="达芬奇 Clip Color">🎨</span>';
    const timeHeaders = batchCutMultiMode ? '' : `
        <span>入点</span>
        <span>出点</span>
        <span style="text-align: center;">👁️</span>`;

    el.innerHTML = `<div style="display: grid; grid-template-columns: ${batchCutGridCols()}; gap: 6px; padding: 6px 8px; background: var(--bg-tertiary); border-radius: 6px 6px 0 0; font-size: 11px; color: var(--text-muted); font-weight: 600;">
        <span style="text-align: center;">#</span>
        <span style="text-align: center;">✓</span>
        ${colorHeader}
        ${videoCol}
        ${subHeaders}
        ${timeHeaders}
        <span style="text-align: center;">操作</span>
    </div>`;
}

// 渲染样式面板
function renderFcpxmlStylePanel() {
    const container = document.getElementById('fcpxml-style-container');
    if (!container) return;
    const inputStyle = `font-size: 12px; padding: 2px 4px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px;`;
    container.innerHTML = batchCutSubtitleCols.map((col, ci) => `
        <div style="padding: 8px 12px; background: var(--bg-tertiary); border-radius: 6px; min-width: 280px; flex: 1;">
          <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px;">${escapeHtml(col.label)}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; align-items: center;">
            <label style="font-size: 11px; color: var(--text-muted);">字体</label>
            <input type="text" value="${escapeHtml(col.font || 'Playfair Display')}"
              onchange="batchCutSubtitleCols[${ci}].font=this.value.trim()||'Playfair Display'"
              style="width: 120px; ${inputStyle}">
            <label style="font-size: 11px; color: var(--text-muted);">字形</label>
            <input type="text" value="${escapeHtml(col.fontFace || 'SemiBold')}"
              onchange="batchCutSubtitleCols[${ci}].fontFace=this.value.trim()||'SemiBold'"
              style="width: 80px; ${inputStyle}">
            <label style="font-size: 11px; color: var(--text-muted);">字号</label>
            <input type="number" value="${col.fontSize}" min="12" max="200" step="1"
              onchange="batchCutSubtitleCols[${ci}].fontSize=parseInt(this.value)||33"
              style="width: 50px; ${inputStyle}">
            <label style="font-size: 11px; color: var(--text-muted);">颜色</label>
            <input type="color" value="${col.color || '#ffe500'}"
              onchange="batchCutSubtitleCols[${ci}].color=this.value"
              style="width: 30px; height: 24px; border: none; cursor: pointer;">
            <label style="font-size: 11px; color: var(--text-muted);">字距</label>
            <input type="number" value="${col.tracking || 11}" min="0" max="100" step="1"
              onchange="batchCutSubtitleCols[${ci}].tracking=parseInt(this.value)||0"
              style="width: 45px; ${inputStyle}">
            <label style="font-size: 11px; color: var(--text-muted);">位置</label>
            <select onchange="batchCutSubtitleCols[${ci}].position=this.value"
              style="font-size: 11px; padding: 2px; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px;">
              <option value="top" ${col.position === 'top' ? 'selected' : ''}>上方</option>
              <option value="center" ${col.position === 'center' ? 'selected' : ''}>居中</option>
              <option value="bottom" ${col.position === 'bottom' ? 'selected' : ''}>下方</option>
            </select>
            <label style="font-size: 11px; color: var(--text-muted);">
              <input type="checkbox" ${col.bold ? 'checked' : ''} onchange="batchCutSubtitleCols[${ci}].bold=this.checked"> 粗
            </label>
          </div>
        </div>
    `).join('');
}

// 页面初始化时渲染
setTimeout(() => { renderBatchCutTableHeader(); renderFcpxmlStylePanel(); }, 0);

// 添加一行
function batchCutAddRow(name = '', start = '', end = '') {
    const subtitles = [name];
    // 补齐其余字幕列为空
    while (subtitles.length < batchCutSubtitleCols.length) subtitles.push('');
    batchCutSegments.push({ name, start, end, subtitles, checked: true });
    renderBatchCutSegments();
}

// 渲染片段列表
function renderBatchCutSegments() {
    const container = document.getElementById('batchcut-segment-list');
    const countEl = document.getElementById('batchcut-segment-count');

    if (batchCutSegments.length === 0) {
        container.innerHTML = '<p class="hint" style="padding: 20px; text-align: center;">点击「添加行」或「粘贴入出点」来添加剪辑片段</p>';
        countEl.textContent = '0 个片段';
        return;
    }

    countEl.textContent = `${batchCutSegments.length} 个片段（已选 ${batchCutSegments.filter(s => s.checked).length}）`;

    container.innerHTML = batchCutSegments.map((seg, i) => {
        // 确保 subtitles 数组长度匹配
        if (!seg.subtitles) seg.subtitles = [seg.name || ''];
        while (seg.subtitles.length < batchCutSubtitleCols.length) seg.subtitles.push('');

        const subInputs = batchCutSubtitleCols.map((col, ci) => `
            <textarea class="input" style="font-size: 12px; padding: 3px 6px; resize: vertical; min-height: 28px; height: ${Math.max(28, ((seg.subtitles[ci] || '').split('\n').length) * 20)}px; line-height: 1.4; overflow-y: auto;"
                placeholder="${escapeHtml(col.label)}（可选）"
                onchange="batchCutUpdateSubtitle(${i}, ${ci}, this.value)">${escapeHtml(seg.subtitles[ci] || '')}</textarea>
        `).join('');

        // 多视频模式：显示缩略图 + 视频文件名 + 时长
        const thumbImg = seg.thumbnail
            ? `<img src="${seg.thumbnail}" style="width: 48px; height: 36px; object-fit: cover; border-radius: 3px; flex-shrink: 0;">`
            : `<span style="width: 48px; height: 36px; background: var(--bg-tertiary); border-radius: 3px; display: inline-flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;">🎬</span>`;
        const videoCol = batchCutMultiMode ? `
            <span style="display: flex; align-items: center; gap: 6px; overflow: hidden;" title="${escapeHtml(seg.videoPath || '')}">
                ${thumbImg}
                <span style="font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; flex: 1;">
                    ${escapeHtml((seg.videoPath || '').split('/').pop().split('\\').pop().replace(/\.[^.]+$/, ''))}
                    ${seg.videoDuration ? `<br><span style="direction: ltr; color: var(--text-muted);">${formatBatchCutTime(seg.videoDuration)}</span>` : ''}
                </span>
            </span>` : '';

        // 单视频模式：时间点 + 预览
        const timeCols = batchCutMultiMode ? '' : `
            <input type="text" class="input" style="font-size: 12px; padding: 3px 6px; font-family: monospace;"
                placeholder="00:00.000" value="${escapeHtml(seg.start)}"
                onchange="batchCutUpdateRow(${i}, 'start', this.value)">
            <input type="text" class="input" style="font-size: 12px; padding: 3px 6px; font-family: monospace;"
                placeholder="留空=结尾" value="${escapeHtml(seg.end)}"
                onchange="batchCutUpdateRow(${i}, 'end', this.value)">
            <button class="btn btn-secondary" onclick="batchCutPreviewSegment(${i})"
                style="padding: 2px 6px; font-size: 11px; ${batchCutPreviewIndex === i ? 'color: var(--accent); font-weight: bold;' : ''}" title="预览此片段">👁️</button>`;

        // 片段颜色选择器
        const curColor = seg.clipColor || '';
        const curColorHex = (DAVINCI_CLIP_COLORS[curColor] || {}).hex || 'transparent';
        const colorOptions = Object.entries(DAVINCI_CLIP_COLORS).map(([key, val]) => {
            const dotStyle = key ? `width:12px;height:12px;border-radius:50%;background:${val.hex};display:inline-block;vertical-align:middle;margin-right:4px;border:1px solid rgba(255,255,255,0.2);` : '';
            return `<option value="${key}" ${curColor === key ? 'selected' : ''}>${val.label}</option>`;
        }).join('');
        const colorDot = curColor
            ? `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;background:${curColorHex};border:2px solid rgba(255,255,255,0.3);vertical-align:middle;box-shadow:0 0 4px ${curColorHex}44;"></span>`
            : `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;border:2px dashed var(--border-color);vertical-align:middle;opacity:0.4;"></span>`;
        const colorCol = `<span style="text-align: center; position: relative;" class="batchcut-color-cell">
            <select onchange="batchCutSetClipColor(${i}, this.value)" style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" title="达芬奇 Clip Color">${colorOptions}</select>
            ${colorDot}
        </span>`;

        return `
        <div class="batchcut-row" data-index="${i}" ${batchCutMultiMode ? `draggable="true" ondragstart="batchCutDragStart(event, ${i})" ondragover="batchCutDragOver(event)" ondragenter="batchCutDragEnter(event)" ondragleave="batchCutDragLeave(event)" ondrop="batchCutDrop(event, ${i})" ondragend="batchCutDragEnd(event)"` : ''} style="display: grid; grid-template-columns: ${batchCutGridCols()}; gap: 6px; padding: 4px 8px; align-items: center; border-bottom: 1px solid var(--border-color); ${!seg.checked ? 'opacity: 0.5;' : ''} ${batchCutPreviewIndex === i ? 'background: rgba(102,126,234,0.1); border-left: 3px solid var(--accent);' : ''} ${batchCutMultiMode ? 'cursor: grab;' : ''} transition: background 0.15s, border-top 0.15s;">
            <span style="text-align: center; font-size: 11px; color: var(--text-muted); ${batchCutMultiMode ? 'cursor: grab;' : ''}" ${batchCutMultiMode ? 'title="拖拽排序"' : ''}>${batchCutMultiMode ? `<span style="font-size:13px; opacity:0.5;">☰</span><br>${i + 1}` : (i + 1)}</span>
            <span style="text-align: center;">
                <input type="checkbox" ${seg.checked ? 'checked' : ''}
                    onchange="batchCutToggleRow(${i}, this.checked)">
            </span>
            ${colorCol}
            ${videoCol}
            ${subInputs}
            ${timeCols}
            <span style="display: flex; gap: 2px; align-items: center; justify-content: center;">
                ${batchCutMultiMode ? `<button class="btn btn-secondary" onclick="batchCutMoveRow(${i}, -1)" style="padding: 1px 4px; font-size: 10px; min-width: 22px;" title="上移" ${i === 0 ? 'disabled' : ''}>⬆</button><button class="btn btn-secondary" onclick="batchCutMoveRow(${i}, 1)" style="padding: 1px 4px; font-size: 10px; min-width: 22px;" title="下移" ${i === batchCutSegments.length - 1 ? 'disabled' : ''}>⬇</button>` : ''}
                <button class="btn btn-secondary" onclick="batchCutRemoveRow(${i})" style="padding: 1px 4px; font-size: 10px; color: #f87171; min-width: 22px;" title="删除此行">🗑</button>
            </span>
        </div>`;
    }).join('');
}

// ===== 拖拽排序 =====
let batchCutDragIdx = -1;

function batchCutDragStart(e, idx) {
    batchCutDragIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', idx);
    // 拖拽时半透明
    setTimeout(() => { e.target.style.opacity = '0.4'; }, 0);
}

function batchCutDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}

function batchCutDragEnter(e) {
    e.preventDefault();
    const row = e.target.closest('.batchcut-row');
    if (row) row.style.borderTop = '3px solid var(--accent)';
}

function batchCutDragLeave(e) {
    const row = e.target.closest('.batchcut-row');
    if (row) row.style.borderTop = '';
}

function batchCutDrop(e, targetIdx) {
    e.preventDefault();
    const row = e.target.closest('.batchcut-row');
    if (row) row.style.borderTop = '';

    if (batchCutDragIdx < 0 || batchCutDragIdx === targetIdx) return;

    // 多视频模式：只移动视频信息，字幕保持不动
    const videoFields = ['videoPath', 'videoDuration', 'thumbnail'];
    // 取出拖动源的视频信息
    const movedVideo = {};
    for (const f of videoFields) movedVideo[f] = batchCutSegments[batchCutDragIdx][f];

    // 移位：将中间行的视频信息依次补位
    if (batchCutDragIdx < targetIdx) {
        for (let i = batchCutDragIdx; i < targetIdx; i++) {
            for (const f of videoFields) batchCutSegments[i][f] = batchCutSegments[i + 1][f];
        }
    } else {
        for (let i = batchCutDragIdx; i > targetIdx; i--) {
            for (const f of videoFields) batchCutSegments[i][f] = batchCutSegments[i - 1][f];
        }
    }
    // 放置到目标位置
    for (const f of videoFields) batchCutSegments[targetIdx][f] = movedVideo[f];

    batchCutDragIdx = -1;
    renderBatchCutSegments();
}

function batchCutDragEnd(e) {
    e.target.style.opacity = '';
    batchCutDragIdx = -1;
    // 清除所有行的边框
    document.querySelectorAll('.batchcut-row').forEach(r => r.style.borderTop = '');
}

// 更新字幕单元格
function batchCutUpdateSubtitle(rowIdx, colIdx, value) {
    if (batchCutSegments[rowIdx]) {
        if (!batchCutSegments[rowIdx].subtitles) batchCutSegments[rowIdx].subtitles = [];
        batchCutSegments[rowIdx].subtitles[colIdx] = value;
        // 第一列同步到 name
        if (colIdx === 0) batchCutSegments[rowIdx].name = value;
    }
}

// HTML 转义辅助
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 更新行数据
function batchCutUpdateRow(index, field, value) {
    if (batchCutSegments[index]) {
        batchCutSegments[index][field] = value;
    }
}

// 切换行选中
function batchCutToggleRow(index, checked) {
    if (batchCutSegments[index]) {
        batchCutSegments[index].checked = checked;
        const countEl = document.getElementById('batchcut-segment-count');
        countEl.textContent = `${batchCutSegments.length} 个片段（已选 ${batchCutSegments.filter(s => s.checked).length}）`;
    }
}

// 删除行
function batchCutRemoveRow(index) {
    batchCutSegments.splice(index, 1);
    renderBatchCutSegments();
}

// 上移/下移行
function batchCutMoveRow(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= batchCutSegments.length) return;

    if (batchCutMultiMode) {
        // 多视频模式：只交换视频信息，字幕保持不动
        const videoFields = ['videoPath', 'videoDuration', 'thumbnail'];
        for (const f of videoFields) {
            const tmp = batchCutSegments[index][f];
            batchCutSegments[index][f] = batchCutSegments[newIndex][f];
            batchCutSegments[newIndex][f] = tmp;
        }
    } else {
        // 单视频模式：整行交换
        const temp = batchCutSegments[index];
        batchCutSegments[index] = batchCutSegments[newIndex];
        batchCutSegments[newIndex] = temp;
    }
    renderBatchCutSegments();
}

// 清空所有
function batchCutClearAll() {
    batchCutSegments = [];
    // 重置字幕列为默认 2 列
    batchCutSubtitleCols = [
        { label: '标题字幕', fontSize: 32, color: '#ffe500', position: 'center', bold: true, font: 'Playfair Display', fontFace: 'SemiBold', tracking: 0 },
        { label: '内容字幕', fontSize: 32, color: '#ffe500', position: 'center', bold: true, font: 'Playfair Display', fontFace: 'SemiBold', tracking: 0 },
    ];
    renderBatchCutTableHeader();
    renderBatchCutSegments();
    renderFcpxmlStylePanel();
}

// ---- 粘贴弹窗管理 ----
let batchCutPasteMode = 'inout'; // 'inout' | 'youtube' | 'table'

function batchCutPasteFromText() {
    openBatchCutPasteModal('inout');
}

function batchCutPasteYouTubeTimestamps() {
    openBatchCutPasteModal('youtube');
}

function batchCutPasteTable() {
    openBatchCutPasteModal('table');
}

function openBatchCutPasteModal(mode) {
    const modal = document.getElementById('batchcut-paste-modal');
    modal.style.display = 'flex';
    document.getElementById('batchcut-paste-textarea').value = '';
    document.getElementById('batchcut-paste-preview').style.display = 'none';
    document.getElementById('batchcut-paste-status').textContent = '';
    tableSkipCols = new Set();
    switchPasteMode(mode || 'inout');
}

function closeBatchCutPasteModal() {
    document.getElementById('batchcut-paste-modal').style.display = 'none';
}

function switchPasteMode(mode) {
    batchCutPasteMode = mode;
    const modes = ['inout', 'youtube', 'table', 'multi'];
    for (const m of modes) {
        const btn = document.getElementById(`paste-mode-${m}`);
        const help = document.getElementById(`paste-help-${m}`);
        if (btn) {
            btn.style.borderBottomColor = m === mode ? 'var(--accent)' : 'transparent';
            btn.style.color = m === mode ? 'var(--accent)' : 'var(--text-muted)';
        }
        if (help) help.style.display = m === mode ? '' : 'none';
    }
    // 多视频模式：隐藏模式切换标签栏，改标题
    const tabs = document.getElementById('paste-mode-tabs');
    const title = document.getElementById('batchcut-paste-title');
    if (mode === 'multi') {
        if (tabs) tabs.style.display = 'none';
        if (title) title.textContent = '📋 粘贴文案（多视频模式）';
    } else {
        if (tabs) tabs.style.display = 'flex';
        if (title) title.textContent = '📋 粘贴剪辑片段';
    }
    // 有内容时自动更新预览
    const text = document.getElementById('batchcut-paste-textarea').value;
    if (text.trim()) previewBatchCutPaste();
}

// 解析入出点文本 → 返回 [{name, start, end}]
function parseInOutText(text) {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const result = [];

    for (const line of lines) {
        let parts = line.split('\t').map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length < 2) parts = line.split(/\s+/).map(s => s.trim()).filter(Boolean);

        let name = '', startStr = '', endStr = '';

        if (parts.length >= 3) {
            const firstIsTime = parseBatchCutTime(parts[0]) !== null && /[:.]/.test(parts[0]);
            if (firstIsTime) {
                name = `片段${result.length + 1}`;
                startStr = parts[0];
                endStr = parts[1];
            } else {
                name = parts[0];
                startStr = parts[1];
                endStr = parts[2];
            }
        } else if (parts.length === 2) {
            const firstIsTime = parseBatchCutTime(parts[0]) !== null;
            const secondIsTime = parseBatchCutTime(parts[1]) !== null;
            if (firstIsTime && secondIsTime) {
                name = `片段${result.length + 1}`;
                startStr = parts[0];
                endStr = parts[1];
            } else if (firstIsTime) {
                name = parts[1];
                startStr = parts[0];
                endStr = '';
            } else if (secondIsTime) {
                name = parts[0];
                startStr = parts[1];
                endStr = '';
            }
        }

        if (startStr) {
            result.push({ name: name || `片段${result.length + 1}`, start: startStr, end: endStr });
        }
    }
    return result;
}

// ====== 表格模式解析 ======
// 用于解析多列表格粘贴（从 Excel / Google Sheets 复制）
// 返回 { headers: [...], segments: [{name, start, end, subtitles: [...]}], columnMapping: {...} }

// TSV 解析器（支持带引号的单元格内换行，兼容 Google Sheets / Excel 复制格式）
function parseTsvWithQuotes(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuote = false;
    let i = 0;

    while (i < text.length) {
        const ch = text[i];

        if (inQuote) {
            if (ch === '"') {
                // 双引号转义: "" → "
                if (i + 1 < text.length && text[i + 1] === '"') {
                    cell += '"';
                    i += 2;
                    continue;
                }
                // 引号结束
                inQuote = false;
                i++;
                continue;
            }
            // 引号内的所有字符（包括换行）都属于当前单元格
            cell += ch;
            i++;
        } else {
            if (ch === '"' && cell === '') {
                // 引号开始（只有在单元格开头才算）
                inQuote = true;
                i++;
            } else if (ch === '\t') {
                // Tab = 列分隔
                row.push(cell.trim());
                cell = '';
                i++;
            } else if (ch === '\n' || ch === '\r') {
                // 换行 = 行分隔（处理 \r\n）
                row.push(cell.trim());
                if (row.some(c => c !== '')) rows.push(row);
                row = [];
                cell = '';
                if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') i++;
                i++;
            } else {
                cell += ch;
                i++;
            }
        }
    }
    // 最后一个单元格/行
    row.push(cell.trim());
    if (row.some(c => c !== '')) rows.push(row);

    // 清理单元格内的换行 → 空格（字幕中不需要保留多行）
    return rows.map(r => r.map(c => c.replace(/[\r\n]+/g, ' ').trim()));
}

// 表格模式的列跳过状态
let tableSkipCols = new Set();

function toggleTableSkipCol(colIdx) {
    if (tableSkipCols.has(colIdx)) tableSkipCols.delete(colIdx);
    else tableSkipCols.add(colIdx);
    previewBatchCutPaste();
}

function parseTableText(text, skipCols) {
    if (!text.trim()) return { segments: [], columnMapping: null };

    const skip = skipCols || new Set();
    const rows = parseTsvWithQuotes(text);
    const maxCols = Math.max(...rows.map(r => r.length));

    if (maxCols < 2) {
        return { segments: parseInOutText(text).map(s => ({ ...s, subtitles: [] })), columnMapping: null };
    }

    const dataRows = rows;

    function parseTimeRangeCell(cell) {
        if (!cell) return null;
        const m = String(cell).match(/^(.+?)\s*[—\-~～]+\s*(.+)$/);
        if (!m) return null;
        const start = m[1].trim();
        const end = m[2].trim();
        if (!start || !end) return null;
        if (parseBatchCutTime(start) === null || parseBatchCutTime(end) === null) return null;
        return { start, end };
    }

    function isTimeRangeCell(cell) {
        return !!parseTimeRangeCell(cell);
    }

    function isTimeCell(cell) {
        if (!cell) return false;
        if (isTimeRangeCell(cell)) return false;
        return parseBatchCutTime(cell) !== null && /[:：]/.test(cell);
    }

    // 统计每列类型
    const colScores = [];
    for (let ci = 0; ci < maxCols; ci++) {
        let timeRangeCount = 0, timeCount = 0, textCount = 0;
        for (const row of dataRows) {
            const cell = (row[ci] || '').trim();
            if (!cell) continue;
            if (isTimeRangeCell(cell)) timeRangeCount++;
            else if (isTimeCell(cell)) timeCount++;
            else textCount++;
        }
        colScores.push({ col: ci, timeRangeCount, timeCount, textCount });
    }

    // 找时间列（跳过 skip 列）
    let timeRangeCol = -1, startCol = -1, endCol = -1;
    const bestTimeRange = colScores.find(c => !skip.has(c.col) && c.timeRangeCount > dataRows.length * 0.3);
    if (bestTimeRange) {
        timeRangeCol = bestTimeRange.col;
    } else {
        const timeCandidates = colScores.filter(c => !skip.has(c.col) && c.timeCount > dataRows.length * 0.3).map(c => c.col);
        if (timeCandidates.length >= 2) { startCol = timeCandidates[0]; endCol = timeCandidates[1]; }
        else if (timeCandidates.length === 1) { startCol = timeCandidates[0]; }
    }

    const timeColSet = new Set([timeRangeCol, startCol, endCol].filter(c => c >= 0));

    // 所有非时间、非skip 列都是字幕列
    const subtitleCols = [];
    for (let ci = 0; ci < maxCols; ci++) {
        if (timeColSet.has(ci) || skip.has(ci)) continue;
        subtitleCols.push(ci);
    }

    function parseTimeRange(cell) {
        if (!cell) return { start: '', end: '' };
        const parsed = parseTimeRangeCell(cell);
        if (parsed) return parsed;
        return { start: String(cell).trim(), end: '' };
    }

    const segments = [];
    for (const row of dataRows) {
        let start = '', end = '';
        if (timeRangeCol >= 0) {
            const p = parseTimeRange(row[timeRangeCol] || '');
            start = p.start; end = p.end;
        } else {
            if (startCol >= 0) start = (row[startCol] || '').trim();
            if (endCol >= 0) end = (row[endCol] || '').trim();
        }
        if (!start) continue;

        const subtitles = subtitleCols.map(ci => (row[ci] || '').trim());
        // 片段名 = 第一个字幕列的值
        const name = subtitles[0] || `片段${segments.length + 1}`;
        segments.push({ name, start, end, subtitles });
    }

    const columnMapping = {
        timeRangeCol, startCol, endCol, subtitleCols, maxCols,
        subtitleHeaders: subtitleCols.map((ci, si) => `字幕${si + 1}`)
    };

    return { segments, columnMapping };
}

// 解析YouTube时间戳文本 → 返回 [{name, start, end}]
function parseYouTubeText(text) {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const stamps = [];

    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(/^(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s+(.+)$/);
        if (match) {
            const timeStr = match[1];
            const name = match[2].trim();
            const timeVal = parseBatchCutTime(timeStr);
            if (timeVal !== null) { stamps.push({ time: timeVal, timeStr, name }); continue; }
        }
        const match2 = trimmed.match(/^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/);
        if (match2) {
            const name = match2[1].trim();
            const timeStr = match2[2];
            const timeVal = parseBatchCutTime(timeStr);
            if (timeVal !== null) { stamps.push({ time: timeVal, timeStr, name }); }
        }
    }

    stamps.sort((a, b) => a.time - b.time);

    const result = [];
    for (let i = 0; i < stamps.length; i++) {
        result.push({
            name: stamps[i].name,
            start: stamps[i].timeStr,
            end: (i < stamps.length - 1) ? stamps[i + 1].timeStr : ''
        });
    }
    return result;
}

// 预览解析结果
function previewBatchCutPaste() {
    const text = document.getElementById('batchcut-paste-textarea').value;
    const previewEl = document.getElementById('batchcut-paste-preview');
    const statusEl = document.getElementById('batchcut-paste-status');

    if (!text.trim()) {
        previewEl.style.display = 'none';
        statusEl.textContent = '⚠️ 请先粘贴内容';
        statusEl.style.color = 'var(--warning, #f59e0b)';
        return;
    }

    const segments = batchCutPasteMode === 'youtube' ? parseYouTubeText(text)
        : (batchCutPasteMode === 'table' || batchCutPasteMode === 'multi') ? null
            : parseInOutText(text);

    // 多视频文案模式
    if (batchCutPasteMode === 'multi') {
        const rows = parseTsvWithQuotes(text);
        if (rows.length === 0) {
            previewEl.style.display = 'block';
            previewEl.innerHTML = '<div style="color: #f87171; padding: 8px;">❌ 未解析到任何内容</div>';
            statusEl.textContent = '解析失败';
            statusEl.style.color = '#f87171';
            return;
        }
        const maxCols = Math.max(...rows.map(r => r.length));
        const isSingleCol = maxCols <= 1;

        // === 自动检测视频名称列 ===
        const matchResult = batchCutDetectVideoNameCol(rows, maxCols);
        const videoNameCol = matchResult.col; // -1 = 未检测到
        const matchMap = matchResult.matchMap; // row index -> segment index

        // 构建列头
        const colHeaders = [];
        for (let ci = 0; ci < maxCols; ci++) {
            if (ci === videoNameCol) {
                colHeaders.push({ label: '🔗 视频名称', isMatch: true, ci });
            } else {
                colHeaders.push({ label: isSingleCol ? '字幕' : `字幕${colHeaders.filter(h => !h.isMatch).length + 1}`, isMatch: false, ci });
            }
        }

        const gridCols = `30px ${colHeaders.map(h => h.isMatch ? '150px' : '1fr').join(' ')} ${videoNameCol >= 0 ? '80px' : ''}`;

        const matchedCount = Object.keys(matchMap).length;
        const matchInfo = videoNameCol >= 0
            ? `<div style="margin: 6px 0; padding: 6px 10px; border-radius: 6px; font-size: 11px; ${matchedCount === rows.length ? 'background: #10b98115; color: #10b981;' : 'background: #f59e0b15; color: #f59e0b;'}">
                🔗 检测到视频名称列（第 ${videoNameCol + 1} 列），已匹配 ${matchedCount}/${rows.length} 个视频
                ${matchedCount < rows.length ? '<br>⚠️ 未匹配的行将按顺序填充' : ' ✅ 全部匹配！'}
               </div>`
            : (batchCutSegments.length > 0 ? '<div style="margin: 6px 0; font-size: 11px; color: var(--text-muted);">💡 如果表格中有一列是视频文件名，系统会自动匹配</div>' : '');

        previewEl.style.display = 'block';
        previewEl.innerHTML = `
            <div style="font-weight: 600; color: var(--text-secondary); margin-bottom: 4px;">
                ✅ 解析出 ${rows.length} 行文案
                ${batchCutSegments.length ? `（视频共 ${batchCutSegments.length} 个）` : ''}
            </div>
            ${matchInfo}
            <div style="display: grid; grid-template-columns: ${gridCols}; gap: 4px 8px; font-size: 11px; max-height: 200px; overflow-y: auto;">
                <span style="color: var(--text-muted); font-weight: 600;">#</span>
                ${colHeaders.map(h => `<span style="color: ${h.isMatch ? '#f59e0b' : 'var(--text-muted)'}; font-weight: 600;">${escapeHtml(h.label)}</span>`).join('')}
                ${videoNameCol >= 0 ? '<span style="color: var(--text-muted); font-weight: 600;">匹配</span>' : ''}
                ${rows.slice(0, 50).map((row, i) => {
                    const matched = matchMap[i] !== undefined;
                    const matchedSeg = matched ? batchCutSegments[matchMap[i]] : null;
                    const matchLabel = videoNameCol >= 0
                        ? (matched ? `<span style="color: #10b981;">✅ ${(matchedSeg.videoPath || '').split('/').pop().split('\\').pop().slice(-15)}</span>` : '<span style="color: #f87171;">❌</span>')
                        : '';
                    return `
                        <span style="color: var(--text-muted);">${i + 1}</span>
                        ${colHeaders.map(h => {
                            const val = row[h.ci] || '—';
                            const style = h.isMatch ? 'color: #f59e0b; font-weight: 500;' : 'color: var(--text-secondary);';
                            return `<span style="${style} font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(val)}</span>`;
                        }).join('')}
                        ${videoNameCol >= 0 ? `<span style="font-size: 10px;">${matchLabel}</span>` : ''}
                    `;
                }).join('')}
            </div>
        `;
        statusEl.textContent = `已解析 ${rows.length} 行文案${videoNameCol >= 0 ? `，匹配 ${matchedCount} 个视频` : ''}，点击「确认导入」填充`;
        statusEl.style.color = 'var(--success, #4ade80)';
        return;
    }

    // 表格模式走单独逻辑
    if (batchCutPasteMode === 'table') {
        const result = parseTableText(text, tableSkipCols);
        if (result.segments.length === 0) {
            previewEl.style.display = 'block';
            previewEl.innerHTML = '<div style="color: #f87171; padding: 8px;">❌ 未能解析出任何片段，请检查是否包含 Tab 分隔的列</div>';
            statusEl.textContent = '解析失败';
            statusEl.style.color = '#f87171';
            return;
        }

        const cm = result.columnMapping;
        const subHeaders = cm ? cm.subtitleHeaders : [];
        const mc = cm ? cm.maxCols : 0;

        // 获取第一行原始数据做样本
        const rawRows = parseTsvWithQuotes(text);
        const sampleRow = rawRows[0] || [];

        // 构建列角色标签（可点击切换忽略）
        let colTags = '<div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 10px;">';
        for (let ci = 0; ci < mc; ci++) {
            const isSkipped = tableSkipCols.has(ci);
            const isTime = ci === cm.timeRangeCol || ci === cm.startCol || ci === cm.endCol;
            const subIdx = cm.subtitleCols.indexOf(ci);

            let label, color;
            if (isSkipped) { label = '已忽略'; color = '#6b7280'; }
            else if (isTime) { label = '时间'; color = '#f59e0b'; }
            else if (subIdx >= 0) { label = `字幕${subIdx + 1}`; color = '#10b981'; }
            else { label = '?'; color = '#6b7280'; }

            const sample = (sampleRow[ci] || '').replace(/[\r\n]+/g, ' ');
            const sampleShort = sample.length > 10 ? sample.slice(0, 10) + '…' : sample;
            const canToggle = !isTime;

            colTags += `<span ${canToggle ? `onclick="toggleTableSkipCol(${ci})"` : ''} style="cursor: ${canToggle ? 'pointer' : 'default'}; padding: 3px 8px; border-radius: 4px; font-size: 11px; border: 1px solid ${color}40; background: ${isSkipped ? '#6b728018' : color + '15'}; color: ${color}; ${isSkipped ? 'text-decoration: line-through; opacity: 0.6;' : ''}">`
                + `列${ci + 1} ${label} <span style="color:var(--text-muted);font-size:10px">${escapeHtml(sampleShort)}</span>`
                + `${canToggle ? (isSkipped ? ' ↩' : ' ✕') : ''}</span>`;
        }
        colTags += '</div>';

        // 预览网格
        const gridCols = `30px 80px 80px ${subHeaders.map(() => '1fr').join(' ')}`;
        const subColTH = subHeaders.map(h => `<span style="color: var(--text-muted); font-weight: 600;">${escapeHtml(h)}</span>`).join('');

        previewEl.style.display = 'block';
        previewEl.innerHTML = `
            <div style="font-weight: 600; color: var(--text-secondary); margin-bottom: 6px;">
                ✅ 解析出 ${result.segments.length} 个片段，${subHeaders.length} 个字幕列
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 6px;">💡 点击列标签可切换忽略</div>
            ${colTags}
            <div style="display: grid; grid-template-columns: ${gridCols}; gap: 4px 8px; font-size: 11px; max-height: 200px; overflow-y: auto;">
                <span style="color: var(--text-muted); font-weight: 600;">#</span>
                <span style="color: var(--text-muted); font-weight: 600;">入点</span>
                <span style="color: var(--text-muted); font-weight: 600;">出点</span>
                ${subColTH}
                ${result.segments.map((s, i) => `
                    <span style="color: var(--text-muted);">${i + 1}</span>
                    <span style="font-family: monospace; color: var(--accent);">${escapeHtml(s.start)}</span>
                    <span style="font-family: monospace; color: ${s.end ? '#f87171' : 'var(--text-muted)'};">${s.end ? escapeHtml(s.end) : '→'}</span>
                    ${(s.subtitles || []).map(sub => `<span style="color: var(--text-secondary); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(sub || '—')}</span>`).join('')}
                `).join('')}
            </div>
        `;
        statusEl.textContent = `已解析 ${result.segments.length} 个片段 + ${subHeaders.length} 个字幕列，点击「确认导入」`;
        statusEl.style.color = 'var(--success, #4ade80)';
        return;
    }

    if (segments.length === 0) {
        previewEl.style.display = 'block';
        previewEl.innerHTML = '<div style="color: #f87171; padding: 8px;">❌ 未能解析出任何片段，请检查格式</div>';
        statusEl.textContent = '解析失败';
        statusEl.style.color = '#f87171';
        return;
    }

    previewEl.style.display = 'block';
    previewEl.innerHTML = `
        <div style="font-weight: 600; color: var(--text-secondary); margin-bottom: 8px;">
            ✅ 解析出 ${segments.length} 个片段：
        </div>
        <div style="display: grid; grid-template-columns: 30px 1fr 100px 100px; gap: 4px 8px; font-size: 11px;">
            <span style="color: var(--text-muted); font-weight: 600;">#</span>
            <span style="color: var(--text-muted); font-weight: 600;">名称</span>
            <span style="color: var(--text-muted); font-weight: 600;">入点</span>
            <span style="color: var(--text-muted); font-weight: 600;">出点</span>
            ${segments.map((s, i) => `
                <span style="color: var(--text-muted);">${i + 1}</span>
                <span style="color: var(--text-primary); font-weight: 500;">${escapeHtml(s.name)}</span>
                <span style="font-family: monospace; color: var(--accent);">${escapeHtml(s.start)}</span>
                <span style="font-family: monospace; color: ${s.end ? '#f87171' : 'var(--text-muted)'};">${s.end ? escapeHtml(s.end) : '→ 结尾'}</span>
            `).join('')}
        </div>
    `;
    statusEl.textContent = `已解析 ${segments.length} 个片段，点击「确认导入」添加`;
    statusEl.style.color = 'var(--success, #4ade80)';
}

// 确认导入
function confirmBatchCutPaste() {
    const text = document.getElementById('batchcut-paste-textarea').value;
    if (!text.trim()) { showToast('请先粘贴内容', 'error'); return; }

    if (batchCutPasteMode === 'table') {
        const result = parseTableText(text, tableSkipCols);
        if (result.segments.length === 0) { showToast('未能解析任何片段', 'error'); return; }

        const cm = result.columnMapping;
        const subHeaders = cm ? cm.subtitleHeaders : [];

        // 自动配置字幕列，以匹配表格表头
        if (subHeaders.length > 0) {
            // 重新设置字幕列配置
            batchCutSubtitleCols = subHeaders.map((label, i) => ({
                label: label,
                fontSize: 32,
                color: '#ffe500',
                position: 'center',
                bold: true,
                font: 'Playfair Display',
                fontFace: 'SemiBold',
                tracking: 0
            }));
        }

        for (const seg of result.segments) {
            const subs = (seg.subtitles || []).slice();
            while (subs.length < batchCutSubtitleCols.length) subs.push('');
            batchCutSegments.push({ name: seg.name, start: seg.start, end: seg.end, subtitles: subs, checked: true });
        }

        renderBatchCutTableHeader();
        renderBatchCutSegments();
        renderFcpxmlStylePanel();
        closeBatchCutPasteModal();
        showToast(`已从表格导入 ${result.segments.length} 个片段 + ${subHeaders.length} 个字幕列`, 'success');
        return;
    }

    // 多视频文案模式：填充到现有视频片段 + 自动匹配
    if (batchCutPasteMode === 'multi') {
        const rows = parseTsvWithQuotes(text);
        if (rows.length === 0) { showToast('未解析到任何内容', 'error'); return; }

        const maxCols = Math.max(...rows.map(r => r.length));

        // 检测视频名称列
        const matchResult = batchCutDetectVideoNameCol(rows, maxCols);
        const videoNameCol = matchResult.col;
        const matchMap = matchResult.matchMap;

        // 如果检测到名称列，先重新排序视频
        if (videoNameCol >= 0 && Object.keys(matchMap).length > 0) {
            // 收集所有视频信息的副本
            const videoInfos = batchCutSegments.map(s => ({
                videoPath: s.videoPath, videoDuration: s.videoDuration, thumbnail: s.thumbnail
            }));
            const used = new Set();

            // 按匹配结果重新分配视频
            for (let ri = 0; ri < Math.min(rows.length, batchCutSegments.length); ri++) {
                if (matchMap[ri] !== undefined) {
                    const vi = matchMap[ri];
                    batchCutSegments[ri].videoPath = videoInfos[vi].videoPath;
                    batchCutSegments[ri].videoDuration = videoInfos[vi].videoDuration;
                    batchCutSegments[ri].thumbnail = videoInfos[vi].thumbnail;
                    used.add(vi);
                }
            }
            // 未匹配的行，顺序填充剩余视频
            const remaining = videoInfos.map((v, i) => ({ ...v, i })).filter(v => !used.has(v.i));
            let ri2 = 0;
            for (let ri = 0; ri < Math.min(rows.length, batchCutSegments.length); ri++) {
                if (matchMap[ri] === undefined && ri2 < remaining.length) {
                    batchCutSegments[ri].videoPath = remaining[ri2].videoPath;
                    batchCutSegments[ri].videoDuration = remaining[ri2].videoDuration;
                    batchCutSegments[ri].thumbnail = remaining[ri2].thumbnail;
                    ri2++;
                }
            }
        }

        // 确定字幕列（排除视频名称列）
        const subtitleColIndices = [];
        for (let ci = 0; ci < maxCols; ci++) {
            if (ci !== videoNameCol) subtitleColIndices.push(ci);
        }
        const subtitleCount = subtitleColIndices.length;

        // 自动调整字幕列数量
        if (subtitleCount > batchCutSubtitleCols.length) {
            while (batchCutSubtitleCols.length < subtitleCount) {
                batchCutSubtitleCols.push({
                    label: `字幕${batchCutSubtitleCols.length + 1}`,
                    fontSize: 32, color: '#ffe500', position: 'center',
                    bold: true, font: 'Playfair Display', fontFace: 'SemiBold', tracking: 0
                });
            }
        }

        // 填充字幕
        const fillCount = Math.min(rows.length, batchCutSegments.length);
        for (let i = 0; i < fillCount; i++) {
            if (!batchCutSegments[i].subtitles) batchCutSegments[i].subtitles = [];
            for (let si = 0; si < subtitleColIndices.length; si++) {
                batchCutSegments[i].subtitles[si] = rows[i][subtitleColIndices[si]] || '';
            }
            while (batchCutSegments[i].subtitles.length < batchCutSubtitleCols.length) {
                batchCutSegments[i].subtitles.push('');
            }
            batchCutSegments[i].name = (rows[i][subtitleColIndices[0]] || '').slice(0, 40) || batchCutSegments[i].name;
        }

        renderBatchCutTableHeader();
        renderBatchCutSegments();
        renderFcpxmlStylePanel();
        closeBatchCutPasteModal();

        const matchedCount = Object.keys(matchMap).length;
        if (videoNameCol >= 0) {
            showToast(`已填充 ${fillCount} 行文案，自动匹配了 ${matchedCount} 个视频`, 'success');
        } else if (rows.length > batchCutSegments.length) {
            showToast(`已填充 ${fillCount} 行（文案 ${rows.length} 行 > 视频 ${batchCutSegments.length} 个，多余已忽略）`, 'info');
        } else {
            showToast(`已填充 ${fillCount} 行文案（${subtitleCount} 个字幕列）`, 'success');
        }
        return;
    }

    const segments = batchCutPasteMode === 'youtube' ? parseYouTubeText(text) : parseInOutText(text);
    if (segments.length === 0) { showToast('未能解析任何片段，请检查格式', 'error'); return; }

    for (const seg of segments) {
        const subs = [seg.name || ''];
        while (subs.length < batchCutSubtitleCols.length) subs.push('');
        batchCutSegments.push({ name: seg.name, start: seg.start, end: seg.end, subtitles: subs, checked: true });
    }

    renderBatchCutSegments();
    closeBatchCutPasteModal();
    const modeLabel = batchCutPasteMode === 'youtube' ? '时间戳' : '入出点';
    showToast(`已从${modeLabel}导入 ${segments.length} 个片段`, 'success');
}

// ESC 关闭粘贴弹窗
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('batchcut-paste-modal')?.style.display === 'flex') {
        closeBatchCutPasteModal();
    }
});

// 占位 - 保留原函数名兼容

// 切换精确/快速模式时显示/隐藏余量设置
function toggleBatchCutPaddingUI() {
    const precise = document.getElementById('batchcut-precise-mode')?.checked;
    const paddingRow = document.getElementById('batchcut-padding-row');
    if (paddingRow) {
        paddingRow.style.display = precise ? 'none' : 'flex';
    }
}

// 开始批量剪辑
async function startBatchCut() {
    if (!batchCutFilePath) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    const selectedSegments = batchCutSegments.filter(s => s.checked);
    if (selectedSegments.length === 0) {
        showToast('请至少选中一个片段', 'error');
        return;
    }

    const precise = document.getElementById('batchcut-precise-mode')?.checked ?? false;

    // 快速模式余量
    const paddingBefore = precise ? 0 : (parseFloat(document.getElementById('batchcut-padding-before')?.value) || 0);
    const paddingAfter = precise ? 0 : (parseFloat(document.getElementById('batchcut-padding-after')?.value) || 0);

    // 验证时间
    const segments = [];
    for (let i = 0; i < selectedSegments.length; i++) {
        const seg = selectedSegments[i];
        let start = parseBatchCutTime(seg.start);
        if (start === null) {
            showToast(`片段 "${seg.name}" 的开始时间无效: ${seg.start}`, 'error');
            return;
        }
        let end = seg.end ? parseBatchCutTime(seg.end) : null;
        if (seg.end && end === null) {
            showToast(`片段 "${seg.name}" 的结束时间无效: ${seg.end}`, 'error');
            return;
        }
        if (end !== null && end <= start) {
            showToast(`片段 "${seg.name}" 的结束时间必须大于开始时间`, 'error');
            return;
        }

        // 应用余量（快速模式）
        if (paddingBefore > 0) {
            start = Math.max(0, start - paddingBefore);
        }
        if (paddingAfter > 0 && end !== null) {
            end = end + paddingAfter;
        }

        segments.push({
            name: seg.name || `片段${i + 1}`,
            start: start,
            end: end
        });
    }

    const outputDir = document.getElementById('media-output-path')?.value || '';
    const statusEl = document.getElementById('batchcut-status');
    const startBtn = document.getElementById('batchcut-start-btn');
    const progressSection = document.getElementById('batchcut-progress-section');
    const progressText = document.getElementById('batchcut-progress-text');
    const progressBar = progressSection.querySelector('.progress-bar-inner');
    const resultSection = document.getElementById('batchcut-result-section');

    // UI 状态
    startBtn.disabled = true;
    startBtn.textContent = '⏳ 正在剪辑...';
    progressSection.classList.remove('hidden');
    resultSection.classList.add('hidden');
    progressBar.style.width = '0%';
    const modeText = precise ? '精确模式（重编码）' : `快速模式（余量 ${paddingBefore}s/${paddingAfter}s）`;
    statusEl.textContent = `⏳ 正在剪辑 ${segments.length} 个片段（${modeText}）...`;
    statusEl.style.color = 'var(--accent)';
    progressText.textContent = `正在剪辑 ${segments.length} 个片段...`;

    try {
        const resp = await apiFetch(`${API_BASE}/media/batch-cut`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: batchCutFilePath,
                segments: segments,
                output_dir: outputDir,
                precise: precise
            })
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '批量剪辑失败');

        // 成功
        progressBar.style.width = '100%';
        progressText.textContent = '✅ 剪辑完成!';
        statusEl.textContent = `✅ ${data.message}`;
        statusEl.style.color = 'var(--success)';
        batchCutOutputDir = data.output_dir || '';

        // 渲染结果
        resultSection.classList.remove('hidden');
        const resultList = document.getElementById('batchcut-result-list');
        if (data.files && data.files.length > 0) {
            resultList.innerHTML = data.files.map((f, i) => `
                <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border-color); font-size: 12px;">
                    <span style="color: var(--success);">✅</span>
                    <span style="font-weight: 600; min-width: 60px;">${f.name}</span>
                    <span style="color: var(--text-muted);">${formatBatchCutTime(f.start)} → ${formatBatchCutTime(f.end)}</span>
                    <span style="color: var(--text-muted);">(${f.duration}s)</span>
                    <span style="color: var(--text-muted); margin-left: auto;">${f.mode}</span>
                </div>
            `).join('');
        } else {
            resultList.innerHTML = '<p style="color: var(--text-muted);">没有导出任何片段</p>';
        }

        showToast(`🎞️ 已导出 ${data.files?.length || 0} 个片段`, 'success');

        // 自动打开输出目录
        if (document.getElementById('batchcut-open-after')?.checked && batchCutOutputDir) {
            openBatchCutOutputDir();
        }
    } catch (error) {
        statusEl.textContent = `❌ ${escapeHtml(error.message)}`;
        statusEl.style.color = 'var(--error)';
        progressText.textContent = `❌ 失败: ${escapeHtml(error.message)}`;
        showToast(`批量剪辑失败: ${escapeHtml(error.message)}`, 'error');
    } finally {
        startBtn.disabled = false;
        startBtn.textContent = '🎞️ 开始批量剪辑';
    }
}

// 导出 FCPXML 时间线（给达芬奇 / Final Cut Pro）
async function exportBatchCutFcpxml() {
    // 多视频模式不需要单一视频文件
    if (!batchCutMultiMode && !batchCutFilePath) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    const selectedSegments = batchCutSegments.filter(s => s.checked);
    if (selectedSegments.length === 0) {
        showToast('请至少选中一个片段', 'error');
        return;
    }

    // 多视频模式：检查所有片段是否有视频路径
    if (batchCutMultiMode) {
        const missingVideo = selectedSegments.find(s => !s.videoPath);
        if (missingVideo) {
            showToast('存在没有视频文件的片段，请检查', 'error');
            return;
        }
    }

    // 构建片段数据
    const segments = [];
    for (let i = 0; i < selectedSegments.length; i++) {
        const seg = selectedSegments[i];

        if (batchCutMultiMode) {
            // 多视频模式：整段视频，无需时间点
            segments.push({
                name: seg.name || `片段${i + 1}`,
                subtitles: (seg.subtitles || [seg.name || '']).slice(),
                start: 0,
                end: null,
                videoPath: seg.videoPath,
                videoDuration: seg.videoDuration || 0,
                clipColor: seg.clipColor || ''
            });
        } else {
            // 单视频模式：验证时间点
            const start = parseBatchCutTime(seg.start);
            if (start === null) {
                showToast(`片段 "${seg.name}" 的入点无效: ${seg.start}`, 'error');
                return;
            }
            const end = seg.end ? parseBatchCutTime(seg.end) : null;
            if (seg.end && end === null) {
                showToast(`片段 "${seg.name}" 的出点无效: ${seg.end}`, 'error');
                return;
            }
            if (end !== null && end <= start) {
                showToast(`片段 "${seg.name}" 的出点必须大于入点`, 'error');
                return;
            }
            segments.push({
                name: seg.name || `片段${i + 1}`,
                subtitles: (seg.subtitles || [seg.name || '']).slice(),
                start: start,
                end: end,
                clipColor: seg.clipColor || ''
            });
        }
    }

    const outputDir = document.getElementById('media-output-path')?.value || '';

    try {
        showToast('正在导出 FCPXML 时间线...', 'info');

        // 获取视频信息（帧率、时长）— 分辨率强制竖屏 1080x1920
        let duration = 0, fps = 30, resolution = '1080x1920';
        const infoFilePath = batchCutMultiMode ? (selectedSegments[0]?.videoPath || '') : batchCutFilePath;
        if (infoFilePath) {
            try {
                const infoResp = await apiFetch(`${API_BASE}/media/info`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ file_path: infoFilePath })
                });
                const info = await infoResp.json();
                if (info.duration) duration = info.duration;
                if (info.frame_rate) fps = parseFloat(info.frame_rate);
            } catch (e) {
                console.warn('获取视频信息失败，使用默认值:', e.message);
            }
        }

        // 直接使用动态字幕列配置
        const subtitleStyle = {
            columns: batchCutSubtitleCols.map(col => ({
                label: col.label,
                font: col.font,
                fontFace: col.fontFace,
                fontSize: col.fontSize,
                color: col.color,
                position: col.position,
                bold: !!col.bold,
                tracking: col.tracking
            }))
        };

        const resp = await apiFetch(`${API_BASE}/media/export-fcpxml-timeline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: batchCutMultiMode ? '' : batchCutFilePath,
                multi_video: batchCutMultiMode,
                segments: segments,
                output_dir: outputDir,
                duration: duration,
                fps: fps,
                resolution: resolution,
                subtitle_style: subtitleStyle
            })
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '导出失败');

        showToast(`✅ 时间线文件已导出 (${segments.length} 个片段)`, 'success');
        if (data.marker_edl_path) {
            showToast('已生成标签专用 Marker EDL：达芬奇请用 Timeline > Import > Timeline Markers from EDL', 'info');
        }
        if (data.color_script_path) {
            showToast('🎨 已生成 Clip Color 脚本：导入FCPXML后在达芬奇中运行 .py 脚本即可自动着色', 'info', 8000);
        }

        // 显示结果
        const statusEl = document.getElementById('batchcut-status');
        if (statusEl) {
            const markerInfo = data.marker_edl_path ? ` | 标签EDL: ${data.marker_edl_path}` : '';
            const colorInfo = data.color_script_path ? ` | 🎨 着色脚本: ${data.color_script_path}` : '';
            statusEl.textContent = `✅ FCPXML: ${data.path || data.file_path}${markerInfo}${colorInfo}`;
            statusEl.style.color = 'var(--success)';
        }
    } catch (e) {
        showToast('导出 FCPXML 失败: ' + e.message, 'error');
    }
}

// 打开输出目录
async function openBatchCutOutputDir() {
    const dir = batchCutOutputDir || document.getElementById('media-output-path')?.value;
    if (!dir) {
        showToast('没有可打开的目录', 'info');
        return;
    }
    try {
        await apiFetch(`${API_BASE}/open-folder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dir })
        });
    } catch (e) {
        showToast(`打开目录失败: ${escapeHtml(e.message)}`, 'error');
    }
}

// ===== 发送到达芬奇 =====
async function sendBatchCutToDaVinci() {
    if (!batchCutFilePath) {
        showToast('请先选择视频文件', 'error');
        return;
    }

    const selectedSegments = batchCutSegments.filter(s => s.checked);
    if (selectedSegments.length === 0) {
        showToast('请至少选中一个片段', 'error');
        return;
    }

    // 验证并转换时间
    const segments = [];
    for (let i = 0; i < selectedSegments.length; i++) {
        const seg = selectedSegments[i];
        const start = parseBatchCutTime(seg.start);
        if (start === null) {
            showToast(`片段 "${seg.name}" 的入点无效: ${seg.start}`, 'error');
            return;
        }
        const end = seg.end ? parseBatchCutTime(seg.end) : null;
        if (seg.end && end === null) {
            showToast(`片段 "${seg.name}" 的出点无效: ${seg.end}`, 'error');
            return;
        }
        if (end !== null && end <= start) {
            showToast(`片段 "${seg.name}" 的出点必须大于入点`, 'error');
            return;
        }
        segments.push({
            name: seg.name || `片段${i + 1}`,
            subtitles: (seg.subtitles || [seg.name || '']).slice(),
            start: start,
            end: end
        });
    }

    // 获取帧率
    let fps = 25;
    try {
        const infoResp = await apiFetch(`${API_BASE}/media/info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: batchCutFilePath })
        });
        const info = await infoResp.json();
        if (info.frame_rate) fps = parseFloat(info.frame_rate);
    } catch (e) {
        console.warn('获取帧率失败，使用默认25fps:', e.message);
    }

    try {
        showToast('正在发送到达芬奇...', 'info');
        const statusEl = document.getElementById('batchcut-status');
        if (statusEl) { statusEl.textContent = '⏳ 正在连接达芬奇...'; statusEl.style.color = 'var(--text-muted)'; }

        const resp = await apiFetch(`${API_BASE}/media/send-to-davinci`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_path: batchCutFilePath,
                segments: segments,
                fps: fps
            })
        });

        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || '发送失败');

        if (data.mode === 'fcpxml') {
            // FCPXML 导入方案（免费版）
            showToast(data.message || '✅ 已导出 FCPXML 并在达芬奇中打开', 'success');
            if (statusEl) {
                statusEl.textContent = `✅ FCPXML 已在达芬奇中打开 (${data.segments_count} 个片段)`;
                statusEl.style.color = 'var(--success)';
            }
        } else {
            showToast(data.message || `✅ 已发送到达芬奇 (${segments.length} 个片段)`, 'success');
            if (statusEl) {
                statusEl.textContent = `✅ 达芬奇时间线: ${data.timeline_name} | ${data.markers_added} 个标记`;
                statusEl.style.color = 'var(--success)';
            }
        }
    } catch (e) {
        showToast('发送到达芬奇失败: ' + e.message, 'error');
        const statusEl = document.getElementById('batchcut-status');
        if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--error)'; }
    }
}

// ═══════════════════════════════════════════════════════
// 📋 批量 TXT 导出
// ═══════════════════════════════════════════════════════

let _batchTxtCells = [];
let _batchTxtRawCells = []; // 保存原始未断行的数据

/**
 * 智能断行 —— 如果文本没有换行符，按语言规则自动插入换行
 * 英文: ~5 个单词一行 | 中文: ~16 个字符一行
 */
function _smartLineBreakBatchTxt(text) {
    if (!text || typeof text !== 'string') return text;
    const autoBreak = document.getElementById('batchtxt-auto-break')?.checked ?? true;
    if (!autoBreak) return text;

    const trimmed = text.trim();
    // 已有换行 → 保留
    if (trimmed.includes('\n')) return trimmed;
    // 很短不断
    if (trimmed.length <= 10) return trimmed;

    // 从 UI 读取自定义参数
    const wordsPerLine = parseInt(document.getElementById('batchtxt-words-per-line')?.value, 10) || 5;
    const maxChars = parseInt(document.getElementById('batchtxt-chars-per-line')?.value, 10) || 16;

    // CJK 检测
    const cjkCount = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const isCJK = cjkCount / trimmed.length > 0.3;

    if (isCJK) {
        const lines = [];
        let pos = 0;
        while (pos < trimmed.length) {
            let end = Math.min(pos + maxChars, trimmed.length);
            if (end < trimmed.length) {
                const chunk = trimmed.slice(pos, end + 4);
                const breakAt = chunk.search(/[，。！？；、\s,\.!?;]/g);
                if (breakAt > maxChars * 0.5) end = pos + breakAt + 1;
            }
            lines.push(trimmed.slice(pos, end).trim());
            pos = end;
            while (pos < trimmed.length && trimmed[pos] === ' ') pos++;
        }
        return lines.filter(l => l).join('\n');
    } else {
        const words = trimmed.split(/\s+/);
        if (words.length <= wordsPerLine) return trimmed;
        const lines = [];
        for (let i = 0; i < words.length; i += wordsPerLine) {
            lines.push(words.slice(i, i + wordsPerLine).join(' '));
        }
        return lines.join('\n');
    }
}

/** 切换自动断行时重新处理 */
function batchTxtToggleAutoBreak() {
    if (_batchTxtRawCells.length > 0) {
        _batchTxtCells = _batchTxtRawCells.map(cell => _smartLineBreakBatchTxt(cell));
        _renderBatchTxtTable();
    }
}

async function selectBatchTxtOutputDir() {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        const dir = await window.electronAPI.selectDirectory();
        if (dir) document.getElementById('batchtxt-output-dir').value = dir;
    }
}

/**
 * 从文案内容生成文件名（与一键配音命名规则一致）
 */
function _batchTxtMakeFileName(text, num, padding) {
    const today = new Date();
    const dateSuffix = `${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const numStr = padding > 0 ? String(num).padStart(padding, '0') : String(num);

    const firstLine = text.split('\n')[0];
    // Recursively strip HTML tags and brackets to prevent XSS
    let cleanText = firstLine;
    while (/<[^>]*>/g.test(cleanText)) { cleanText = cleanText.replace(/<[^>]*>/g, ''); }
    cleanText = cleanText.replace(/\[[^\]]+\]/g, '').replace(/[<>\[\]()]/g, '');
    let textPrefix = cleanText.split(/\s+/).slice(0, 15).join('_').slice(0, 60);
    textPrefix = textPrefix.replace(/[^a-zA-Z0-9\u4e00-\u9fff _-]/g, '').replace(/\s+/g, '_').trim();
    if (!textPrefix) textPrefix = 'text';

    return `${numStr}-${textPrefix}_${dateSuffix}.txt`;
}

/**
 * 解析 Google Sheets 粘贴的纯文本，正确处理含换行的单元格
 */
function _parseGoogleSheetsCells(rawText) {
    const results = [];
    const len = rawText.length;
    let i = 0;

    while (i < len) {
        while (i < len && rawText[i] === ' ') i++;
        if (i >= len) break;

        let cell = '';
        if (rawText[i] === '"') {
            i++;
            while (i < len) {
                if (rawText[i] === '"') {
                    if (i + 1 < len && rawText[i + 1] === '"') { cell += '"'; i += 2; }
                    else { i++; break; }
                } else { cell += rawText[i]; i++; }
            }
        } else {
            while (i < len && rawText[i] !== '\t' && rawText[i] !== '\n' && rawText[i] !== '\r') {
                cell += rawText[i]; i++;
            }
        }

        // 跳过其他列
        while (i < len && rawText[i] === '\t') {
            i++;
            if (i < len && rawText[i] === '"') {
                i++;
                while (i < len) {
                    if (rawText[i] === '"') {
                        if (i + 1 < len && rawText[i + 1] === '"') { i += 2; }
                        else { i++; break; }
                    } else { i++; }
                }
            } else {
                while (i < len && rawText[i] !== '\t' && rawText[i] !== '\n' && rawText[i] !== '\r') i++;
            }
        }

        if (i < len && rawText[i] === '\r') i++;
        if (i < len && rawText[i] === '\n') i++;

        const trimmed = cell.trim();
        if (trimmed) results.push(trimmed);
    }

    return results;
}

/**
 * 从剪贴板粘贴并解析
 */
async function batchTxtPaste() {
    try {
        const clipboardItems = await navigator.clipboard.read();
        let parsed = [];

        for (const item of clipboardItems) {
            // 优先尝试 HTML（谷歌表格会带 HTML 格式）
            if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                const html = await blob.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const rows = doc.querySelectorAll('tr');

                if (rows.length > 0) {
                    rows.forEach(tr => {
                        const cell = tr.querySelector('td, th');
                        if (!cell) return;
                        // 保留 <br> 换行
                        let clone = cell.cloneNode(true);
                        clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                        clone.querySelectorAll('p, div').forEach(el => el.insertAdjacentText('beforebegin', '\n'));
                        const text = clone.textContent.trim();
                        if (text) parsed.push(text);
                    });
                }
            }

            // 如果 HTML 没解析到，用纯文本
            if (parsed.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const rawText = await blob.text();
                parsed = _parseGoogleSheetsCells(rawText);
            }
        }

        if (parsed.length === 0) {
            showToast('未识别到有效文案', 'warning');
            return;
        }

        _batchTxtRawCells = [...parsed];
        _batchTxtCells = parsed.map(cell => _smartLineBreakBatchTxt(cell));
        _renderBatchTxtTable();
        showToast(`已识别 ${parsed.length} 条文案`, 'success');
    } catch (err) {
        showToast('粘贴失败: ' + err.message, 'error');
    }
}

function batchTxtClear() {
    _batchTxtCells = [];
    _renderBatchTxtTable();
}

function batchTxtRemoveCell(idx) {
    _batchTxtCells.splice(idx, 1);
    _renderBatchTxtTable();
}

function _renderBatchTxtTable() {
    const listEl = document.getElementById('batchtxt-list');
    const countEl = document.getElementById('batchtxt-count');
    if (!listEl) return;

    if (_batchTxtCells.length === 0) {
        listEl.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;">
            点击「📋 粘贴文案」从谷歌表格粘贴内容</div>`;
        if (countEl) countEl.textContent = '';
        return;
    }

    const startNum = parseInt(document.getElementById('batchtxt-start-num')?.value || '1', 10) || 1;
    const padding = parseInt(document.getElementById('batchtxt-padding')?.value || '2', 10);

    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    listEl.innerHTML = _batchTxtCells.map((cell, i) => {
        const num = startNum + i;
        const lineCount = cell.split('\n').length;
        const fileName = _batchTxtMakeFileName(cell, num, padding);

        return `<div style="background:var(--bg-secondary);border-radius:6px;padding:10px 12px;position:relative;">
            <div style="display:flex;align-items:flex-start;gap:10px;">
                <span style="background:var(--accent-color);color:#fff;font-size:11px;font-weight:600;
                    padding:2px 8px;border-radius:10px;flex-shrink:0;margin-top:1px;">${num}</span>
                <div style="flex:1;min-width:0;">
                    <div style="font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.5;
                        color:var(--text-primary);margin-bottom:6px;">${escHtml(cell)}</div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <span style="font-size:10px;font-family:monospace;color:var(--accent-color);
                            background:rgba(233,69,96,0.1);padding:2px 6px;border-radius:4px;
                            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;"
                            title="${escHtml(fileName).replace(/"/g, '&quot;').replace(/'/g, '&#39;')}">📄 ${escHtml(fileName)}</span>
                        <span style="font-size:10px;color:var(--text-muted);">${lineCount}行</span>
                    </div>
                </div>
                <button class="btn" style="padding:2px 6px;font-size:11px;flex-shrink:0;"
                    onclick="batchTxtRemoveCell(${i})">✕</button>
            </div>
        </div>`;
    }).join('');

    if (countEl) countEl.textContent = `共 ${_batchTxtCells.length} 条文案`;
}

async function startBatchTxtExport() {
    const statusEl = document.getElementById('batchtxt-status');

    if (_batchTxtCells.length === 0) {
        if (statusEl) { statusEl.textContent = '⚠️ 请先粘贴文案'; statusEl.style.color = 'var(--warning)'; }
        return;
    }

    let outputDir = (document.getElementById('batchtxt-output-dir')?.value || '').trim();
    if (!outputDir) {
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            outputDir = await window.electronAPI.selectDirectory();
            if (outputDir) document.getElementById('batchtxt-output-dir').value = outputDir;
        }
    }
    if (!outputDir) {
        if (statusEl) { statusEl.textContent = '⚠️ 请选择输出目录'; statusEl.style.color = 'var(--warning)'; }
        return;
    }

    const startNum = parseInt(document.getElementById('batchtxt-start-num')?.value || '1', 10) || 1;
    const padding = parseInt(document.getElementById('batchtxt-padding')?.value || '2', 10);
    const cells = _batchTxtCells;

    if (statusEl) { statusEl.textContent = `导出中... 0/${cells.length}`; statusEl.style.color = ''; }

    let okCount = 0;
    try {
        for (let i = 0; i < cells.length; i++) {
            const num = startNum + i;
            const fileName = _batchTxtMakeFileName(cells[i], num, padding);
            const filePath = outputDir + (outputDir.includes('\\') ? '\\' : '/') + fileName;

            await window.electronAPI.apiCall('file/write-text', {
                path: filePath,
                content: cells[i],
            });
            okCount++;
            if (statusEl) statusEl.textContent = `导出中... ${okCount}/${cells.length}`;
        }
        if (statusEl) {
            statusEl.textContent = `✅ 成功导出 ${okCount} 个 TXT 文件`;
            statusEl.style.color = 'var(--success)';
        }
        showToast(`批量导出完成: ${okCount} 个 TXT 文件`, 'success');
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = `❌ 导出失败: ${err.message}`;
            statusEl.style.color = 'var(--error)';
        }
    }
}

// 编号/补零变化时刷新表格预览
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const startNumEl = document.getElementById('batchtxt-start-num');
        const paddingEl = document.getElementById('batchtxt-padding');
        if (startNumEl) startNumEl.addEventListener('change', () => _renderBatchTxtTable());
        if (paddingEl) paddingEl.addEventListener('change', () => _renderBatchTxtTable());
    }, 300);
});

// ═══════════════════════════════════════════════════════
// 🏷️ 统一命名工具
// ═══════════════════════════════════════════════════════

let _uniRenameFiles = [];

function _initUniRename() {
    const fileInput = document.getElementById('unirename-file-input');
    const dropZone = document.getElementById('unirename-drop-zone');

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            _addUniRenameFiles(files);
            e.target.value = '';
        });
    }

    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-color)';
            dropZone.style.backgroundColor = 'rgba(233, 69, 96, 0.08)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = '';
            dropZone.style.backgroundColor = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '';
            dropZone.style.backgroundColor = '';
            const files = Array.from(e.dataTransfer.files || []);
            _addUniRenameFiles(files);
        });
    }
}

function _addUniRenameFiles(files) {
    for (const f of files) {
        // 避免重复
        if (_uniRenameFiles.some(x => x.path === getFileNativePath(f))) continue;
        _uniRenameFiles.push({
            name: f.name,
            path: getFileNativePath(f),
            ext: (f.name.match(/\.[^.]+$/) || [''])[0],
        });
    }
    _renderUniRenameList();
    _updateUniRenamePickSelect();
}

function _renderUniRenameList() {
    const container = document.getElementById('unirename-file-list');
    if (!container) return;
    if (_uniRenameFiles.length === 0) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = _uniRenameFiles.map((f, i) => `
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>
            <span style="color:var(--text-muted);font-size:11px;">${f.ext}</span>
            <button class="btn" style="padding:1px 5px;font-size:10px;" onclick="_removeUniRenameFile(${i})">✕</button>
        </div>
    `).join('') + `<div style="margin-top:6px;font-size:11px;color:var(--text-muted);">${_uniRenameFiles.length} 个文件</div>`;
}

function _removeUniRenameFile(idx) {
    _uniRenameFiles.splice(idx, 1);
    _renderUniRenameList();
    _updateUniRenamePickSelect();
}

/**
 * 更新「以文件名为准」的下拉列表
 */
function _updateUniRenamePickSelect() {
    const sel = document.getElementById('unirename-pick-select');
    if (!sel) return;
    const prevVal = sel.value;
    sel.innerHTML = _uniRenameFiles.length === 0
        ? '<option value="">— 请先添加文件 —</option>'
        : _uniRenameFiles.map((f, i) => {
            const base = f.name.replace(/\.[^.]+$/, '');
            return `<option value="${i}">${base} (${f.ext})</option>`;
        }).join('');
    // 恢复之前的选择
    if (prevVal && sel.querySelector(`option[value="${prevVal}"]`)) {
        sel.value = prevVal;
    } else if (_uniRenameFiles.length > 0) {
        // 默认优先选 .txt 文件
        const txtIdx = _uniRenameFiles.findIndex(f => f.ext.toLowerCase() === '.txt');
        sel.value = String(txtIdx >= 0 ? txtIdx : 0);
    }
}

/**
 * 切换命名模式：pick / custom
 */
function uniRenameToggleMode() {
    const mode = document.querySelector('input[name="unirename-mode"]:checked')?.value || 'pick';
    const pickRow = document.getElementById('unirename-pick-row');
    const customRow = document.getElementById('unirename-custom-row');
    if (pickRow) pickRow.style.display = mode === 'pick' ? 'flex' : 'none';
    if (customRow) customRow.style.display = mode === 'custom' ? 'flex' : 'none';
}

/**
 * 下拉选择文件名改变时的处理
 */
function uniRenameOnPickChange() {
    // 无需额外处理，startUniRename 会从下拉框读取
}

async function startUniRename() {
    const statusEl = document.getElementById('unirename-status');
    const mode = document.querySelector('input[name="unirename-mode"]:checked')?.value || 'pick';

    let baseName = '';
    if (mode === 'pick') {
        const pickIdx = parseInt(document.getElementById('unirename-pick-select')?.value, 10);
        if (isNaN(pickIdx) || !_uniRenameFiles[pickIdx]) {
            if (statusEl) { statusEl.textContent = '⚠️ 请选择一个文件名'; statusEl.style.color = 'var(--warning)'; }
            return;
        }
        baseName = _uniRenameFiles[pickIdx].name.replace(/\.[^.]+$/, '');
    } else {
        baseName = (document.getElementById('unirename-basename')?.value || '').trim();
        if (!baseName) {
            if (statusEl) { statusEl.textContent = '⚠️ 请输入统一名称'; statusEl.style.color = 'var(--warning)'; }
            return;
        }
    }

    if (_uniRenameFiles.length === 0) {
        if (statusEl) { statusEl.textContent = '⚠️ 请先添加文件'; statusEl.style.color = 'var(--warning)'; }
        return;
    }

    const copyMode = document.getElementById('unirename-copy-mode')?.checked ?? true;
    if (statusEl) { statusEl.textContent = `处理中... 0/${_uniRenameFiles.length}`; statusEl.style.color = ''; }

    let okCount = 0;
    try {
        for (let i = 0; i < _uniRenameFiles.length; i++) {
            const f = _uniRenameFiles[i];
            const dir = f.path.replace(/[\\/][^\\/]+$/, '');
            const sep = dir.includes('\\') ? '\\' : '/';
            const newPath = `${dir}${sep}${baseName}${f.ext}`;

            const result = await window.electronAPI.apiCall('file/rename', {
                source: f.path,
                target: newPath,
                copy: copyMode,
            });
            okCount++;
            if (statusEl) statusEl.textContent = `处理中... ${okCount}/${_uniRenameFiles.length}`;
        }
        if (statusEl) {
            statusEl.textContent = `✅ 成功${copyMode ? '复制' : '重命名'} ${okCount} 个文件 → ${baseName}.*`;
            statusEl.style.color = 'var(--success)';
        }
        showToast(`统一命名完成: ${okCount} 个文件`, 'success');
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = `❌ 失败: ${err.message}`;
            statusEl.style.color = 'var(--error)';
        }
    }
}

// 初始化统一命名模块
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_initUniRename, 200);
});

// ==================== 版本 & 更新检查 ====================

// 初始化版本显示 + 更新监听
document.addEventListener('DOMContentLoaded', () => {
    // 加载版本号
    if (window.electronAPI?.getAppVersion) {
        window.electronAPI.getAppVersion().then(ver => {
            const el = document.getElementById('app-version-display');
            if (el && ver) el.textContent = `v${ver}`;
        }).catch(() => { });
    }

    // 监听更新状态事件
    if (window.electronAPI?.onUpdateStatus) {
        window.electronAPI.onUpdateStatus((data) => {
            const statusEl = document.getElementById('update-status-text');
            const progressBar = document.getElementById('update-progress-bar');
            const progressInner = document.getElementById('update-progress-inner');
            const btn = document.getElementById('check-update-btn');

            if (!statusEl) return;

            switch (data.status) {
                case 'checking':
                    statusEl.textContent = '⏳ 正在检查...';
                    statusEl.style.color = 'var(--text-secondary)';
                    if (btn) btn.disabled = true;
                    break;
                case 'available':
                    statusEl.textContent = `🎉 发现新版本 ${data.version}`;
                    statusEl.style.color = '#00d9a5';
                    if (btn) { btn.disabled = false; btn.textContent = '📥 下载更新'; }
                    break;
                case 'up-to-date':
                    statusEl.textContent = '✅ 已是最新版本';
                    statusEl.style.color = '#00d9a5';
                    if (btn) { btn.disabled = false; btn.textContent = '🔄 检查更新'; }
                    break;
                case 'downloading':
                    statusEl.textContent = `⬇️ 下载中 ${data.percent || 0}%`;
                    statusEl.style.color = 'var(--accent-color)';
                    if (progressBar) progressBar.classList.remove('hidden');
                    if (progressInner) progressInner.style.width = `${data.percent || 0}%`;
                    if (btn) btn.disabled = true;
                    break;
                case 'downloaded':
                    statusEl.textContent = `✅ v${data.version} 已下载，重启即可安装`;
                    statusEl.style.color = '#00d9a5';
                    if (progressBar) progressBar.classList.add('hidden');
                    if (btn) { btn.disabled = false; btn.textContent = '🔄 重启安装'; btn.onclick = () => window.electronAPI.installUpdate(); }
                    break;
                case 'error':
                    statusEl.textContent = `❌ ${data.message}`;
                    statusEl.style.color = '#ff4757';
                    if (progressBar) progressBar.classList.add('hidden');
                    if (btn) { btn.disabled = false; btn.textContent = '🔄 重试'; }
                    break;
            }
        });
    }
});

// 手动检查更新
async function checkAppUpdate() {
    const statusEl = document.getElementById('update-status-text');
    const btn = document.getElementById('check-update-btn');

    if (!window.electronAPI?.checkForUpdates) {
        if (statusEl) {
            statusEl.textContent = '⚠️ 仅打包版支持自动更新';
            statusEl.style.color = '#f0ad4e';
        }
        return;
    }

    if (btn) btn.disabled = true;
    if (statusEl) {
        statusEl.textContent = '⏳ 正在检查...';
        statusEl.style.color = 'var(--text-secondary)';
    }

    try {
        const result = await window.electronAPI.checkForUpdates();
        if (!result.success && statusEl) {
            statusEl.textContent = `❌ ${result.error || '检查失败'}`;
            statusEl.style.color = '#ff4757';
        }
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = `❌ ${e.message || '检查失败'}`;
            statusEl.style.color = '#ff4757';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * 切换更新通道 (stable / beta)
 */
async function switchUpdateChannel(channel) {
    const hintEl = document.getElementById('update-channel-hint');
    if (!window.electronAPI?.setUpdateChannel) {
        if (hintEl) hintEl.textContent = '⚠️ 仅打包版支持';
        return;
    }

    try {
        const result = await window.electronAPI.setUpdateChannel(channel);
        if (hintEl) {
            hintEl.textContent = channel === 'beta'
                ? '将收到测试版 + 正式版更新'
                : '只接收正式版更新';
        }
        // 切换后立即检查更新
        checkAppUpdate();
    } catch (e) {
        if (hintEl) hintEl.textContent = '❌ 切换失败';
    }
}

/**
 * 初始化更新通道 UI 状态
 */
async function initUpdateChannelUI() {
    if (!window.electronAPI?.getUpdateChannel) return;
    try {
        const info = await window.electronAPI.getUpdateChannel();
        const selectEl = document.getElementById('update-channel-select');
        const hintEl = document.getElementById('update-channel-hint');
        if (selectEl) selectEl.value = info.channel;
        if (hintEl) {
            hintEl.textContent = info.channel === 'beta'
                ? '将收到测试版 + 正式版更新'
                : '只接收正式版更新';
        }
        // 如果当前运行的就是测试版，在版本号旁显示标记
        if (info.isBeta) {
            const versionDisplay = document.getElementById('app-version-display');
            if (versionDisplay && !versionDisplay.textContent.includes('🧪')) {
                versionDisplay.textContent += ' 🧪 测试版';
            }
        }
    } catch (e) { /* 忽略 */ }
}

/**
 * 动态加载并展示 GitHub Releases 历史版本下载列表
 */
async function loadHistoryVersions() {
    const container = document.getElementById('history-versions-section');
    const listEl = document.getElementById('history-versions-list');
    if (!container || !listEl) return;

    try {
        const response = await fetch('https://api.github.com/repos/secure-artifacts/VideoKit/releases');
        if (!response.ok) throw new Error('API 请求失败');
        const releases = await response.json();
        
        listEl.innerHTML = '';
        if (Array.isArray(releases) && releases.length > 0) {
            // 过滤掉低于 4.4.6 的历史版本（因为旧版存在漏洞，不建议用户降级）
            const allowedReleases = releases.filter(rel => {
                const tagName = rel.tag_name;
                const match = tagName.match(/^v?(\d+)\.(\d+)\.(\d+)/);
                if (!match) return false;
                const major = parseInt(match[1], 10);
                const minor = parseInt(match[2], 10);
                const patch = parseInt(match[3], 10);
                if (major > 4) return true;
                if (major < 4) return false;
                if (minor > 4) return true;
                if (minor < 4) return false;
                return patch >= 6;
            });

            if (allowedReleases.length > 0) {
                container.style.display = 'block';
                // 展示最近的 5 个版本
                allowedReleases.slice(0, 5).forEach(rel => {
                const verName = rel.tag_name;
                const relDate = new Date(rel.published_at).toLocaleDateString();
                const isPrerelease = rel.prerelease ? ' 🧪' : '';
                
                // 查找对应的 Win、Mac 和 Linux 安装包
                let winAsset = rel.assets.find(a => a.name.endsWith('.exe'));
                let macAsset = rel.assets.find(a => a.name.endsWith('.dmg') || (a.name.endsWith('.zip') && a.name.toLowerCase().includes('mac')));
                let linuxAsset = rel.assets.find(a => a.name.endsWith('.AppImage') || a.name.endsWith('.deb') || (a.name.endsWith('.zip') && a.name.toLowerCase().includes('linux')));
                
                const itemDiv = document.createElement('div');
                itemDiv.style.cssText = 'display: flex; align-items: center; justify-content: space-between; font-size: 11px; padding: 6px 4px; border-bottom: 1px solid rgba(255,255,255,0.05);';
                
                const label = document.createElement('span');
                label.innerHTML = `${verName}${isPrerelease} <span style="opacity:0.6;font-size:10px;">(${relDate})</span>`;
                label.style.fontWeight = '500';
                itemDiv.appendChild(label);
                
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display: flex; gap: 8px;';
                
                if (winAsset) {
                    const btn = document.createElement('a');
                    btn.href = '#';
                    btn.textContent = '🪟 Win版';
                    btn.style.cssText = 'color: #3897f5; text-decoration: none; cursor: pointer; font-weight: bold;';
                    btn.onclick = (e) => {
                        e.preventDefault();
                        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
                            window.electronAPI.openExternal(winAsset.browser_download_url);
                        } else {
                            window.open(winAsset.browser_download_url, '_blank');
                        }
                    };
                    btnGroup.appendChild(btn);
                }
                if (macAsset) {
                    const btn = document.createElement('a');
                    btn.href = '#';
                    btn.textContent = '🍎 Mac版';
                    btn.style.cssText = 'color: #2ed573; text-decoration: none; cursor: pointer; font-weight: bold;';
                    btn.onclick = (e) => {
                        e.preventDefault();
                        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
                            window.electronAPI.openExternal(macAsset.browser_download_url);
                        } else {
                            window.open(macAsset.browser_download_url, '_blank');
                        }
                    };
                    btnGroup.appendChild(btn);
                }
                if (linuxAsset) {
                    const btn = document.createElement('a');
                    btn.href = '#';
                    btn.textContent = '🐧 Linux版';
                    btn.style.cssText = 'color: #ffa502; text-decoration: none; cursor: pointer; font-weight: bold;';
                    btn.onclick = (e) => {
                        e.preventDefault();
                        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
                            window.electronAPI.openExternal(linuxAsset.browser_download_url);
                        } else {
                            window.open(linuxAsset.browser_download_url, '_blank');
                        }
                    };
                    btnGroup.appendChild(btn);
                }
                
                // 退回 Releases 详情页
                if (!winAsset && !macAsset && !linuxAsset) {
                    const btn = document.createElement('a');
                    btn.href = '#';
                    btn.textContent = '🔗 详情页';
                    btn.style.cssText = 'color: #ff9f43; text-decoration: none; cursor: pointer;';
                    btn.onclick = (e) => {
                        e.preventDefault();
                        if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
                            window.electronAPI.openExternal(rel.html_url);
                        } else {
                            window.open(rel.html_url, '_blank');
                        }
                    };
                    btnGroup.appendChild(btn);
                }
                
                itemDiv.appendChild(btnGroup);
                listEl.appendChild(itemDiv);
            });
            }
        }
    } catch (e) {
        console.error('加载历史版本失败:', e);
        listEl.innerHTML = '<div style="color: var(--text-muted); font-size: 11px; padding: 4px;">加载失败，请检查网络连接</div>';
    }
}

// 页面加载时初始化通道 UI & 加载历史版本列表
document.addEventListener('DOMContentLoaded', () => {
    initUpdateChannelUI();
    loadHistoryVersions();
});

// ==================== 全局屏幕取色器 ====================
// 解决 Windows 上 <input type="color"> 吸管无法吸取窗口外颜色的问题
// 在每个颜色选择器旁边添加一个🎯吸管按钮，点击后调用主进程截屏取色

(function initGlobalEyeDropper() {
    // 仅在 Electron 环境且支持 screenPickColor 时启用
    if (!window.electronAPI?.screenPickColor) return;

    const MARKER = '_eyedropper-attached';
    const BUTTON_CLASS = 'vk-eyedropper-btn';

    // 注入全局样式
    const style = document.createElement('style');
    style.textContent = `
        .vk-eyedropper-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            padding: 0;
            margin-left: 2px;
            border: 1px solid var(--border-color, rgba(255,255,255,0.15));
            border-radius: 4px;
            background: var(--bg-secondary, rgba(255,255,255,0.06));
            cursor: pointer;
            font-size: 12px;
            line-height: 1;
            vertical-align: middle;
            transition: background 0.15s, border-color 0.15s;
            flex-shrink: 0;
        }
        .vk-eyedropper-btn:hover {
            background: var(--bg-hover, rgba(255,255,255,0.12));
            border-color: var(--accent, #4c9eff);
        }
        .vk-eyedropper-btn:active {
            transform: scale(0.92);
        }
        .vk-eyedropper-btn.picking {
            background: var(--accent, #4c9eff);
            border-color: var(--accent, #4c9eff);
            animation: vk-pulse 0.8s ease-in-out infinite alternate;
        }
        @keyframes vk-pulse {
            from { opacity: 0.7; }
            to { opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    function attachEyedropper(input) {
        if (input[MARKER]) return;
        input[MARKER] = true;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BUTTON_CLASS;
        btn.title = '屏幕取色 (可吸取窗口外颜色)';
        btn.textContent = '💉';
        btn.setAttribute('tabindex', '-1');

        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            btn.classList.add('picking');
            try {
                const hex = await window.electronAPI.screenPickColor();
                if (hex) {
                    // 更新 input 值
                    input.value = hex;
                    // 触发 input 和 change 事件，确保所有监听器都能收到
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (err) {
                console.error('[EyeDropper] Error:', err);
            } finally {
                btn.classList.remove('picking');
            }
        });

        // 将按钮插入到 input 后面
        input.insertAdjacentElement('afterend', btn);
    }

    function scanAndAttach(root) {
        const inputs = (root || document).querySelectorAll('input[type="color"]');
        inputs.forEach(attachEyedropper);
    }

    // 初始扫描
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => scanAndAttach(), 500);
    });

    // 监听动态添加的颜色输入框
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.matches?.('input[type="color"]')) {
                    attachEyedropper(node);
                } else if (node.querySelectorAll) {
                    node.querySelectorAll('input[type="color"]').forEach(attachEyedropper);
                }
            }
        }
    });

    // 页面加载后启动观察
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        scanAndAttach();
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }
})();

// ═══════════════════════════════════════════════════════
// 🏷️ 批量重命名工具
// ═══════════════════════════════════════════════════════

let _batchRenameFiles = [];

function _initBatchRename() {
    const fileInput = document.getElementById('batchrename-file-input');
    const dropZone = document.getElementById('batchrename-drop-zone');

    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const files = Array.from(e.target.files || []);
            _addBatchRenameFiles(files);
            e.target.value = '';
        });
    }

    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-color)';
            dropZone.style.backgroundColor = 'rgba(233, 69, 96, 0.08)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = '';
            dropZone.style.backgroundColor = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = '';
            dropZone.style.backgroundColor = '';
            const files = Array.from(e.dataTransfer.files || []);
            _addBatchRenameFiles(files);
        });
    }
}

function _addBatchRenameFiles(files) {
    for (const f of files) {
        if (_batchRenameFiles.some(x => x.path === getFileNativePath(f))) continue;
        _batchRenameFiles.push({
            name: f.name,
            path: getFileNativePath(f),
            ext: (f.name.match(/\.[^.]+$/) || [''])[0],
        });
    }
    _renderBatchRenameList();
}

function _removeBatchRenameFile(idx) {
    _batchRenameFiles.splice(idx, 1);
    _renderBatchRenameList();
}

function clearBatchRenameList() {
    _batchRenameFiles = [];
    _renderBatchRenameList();
    const statusEl = document.getElementById('batchrename-status');
    if (statusEl) { statusEl.textContent = '就绪'; statusEl.style.color = ''; }
}

function toggleBatchRenameNumOptions() {
    const enable = document.getElementById('batchrename-enable-num')?.checked ?? false;
    const opts = document.getElementById('batchrename-num-options');
    if (opts) opts.style.display = enable ? 'flex' : 'none';
}

function _calculateNewName(file, idx) {
    const ext = file.ext;
    const base = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

    // 1. 字符串替换
    let processedBase = base;
    const findText = document.getElementById('batchrename-replace-find')?.value || '';
    const replaceText = document.getElementById('batchrename-replace-with')?.value || '';
    if (findText) {
        const isRegex = document.getElementById('batchrename-replace-regex')?.checked ?? false;
        const caseSensitive = document.getElementById('batchrename-replace-case')?.checked ?? true;
        if (isRegex) {
            try {
                const flags = (caseSensitive ? '' : 'i') + 'g';
                const regex = new RegExp(findText, flags);
                processedBase = processedBase.replace(regex, replaceText);
            } catch (e) {
                // 正则语法错误，跳过替换
            }
        } else {
            if (caseSensitive) {
                processedBase = processedBase.split(findText).join(replaceText);
            } else {
                const escapedFind = findText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const regex = new RegExp(escapedFind, 'gi');
                processedBase = processedBase.replace(regex, replaceText);
            }
        }
    }

    // 2. 添加前后缀
    const prefix = document.getElementById('batchrename-prefix')?.value || '';
    const suffix = document.getElementById('batchrename-suffix')?.value || '';
    processedBase = prefix + processedBase + suffix;

    // 3. 大小写转换
    const caseMode = document.getElementById('batchrename-case-mode')?.value || 'none';
    if (caseMode === 'lower') {
        processedBase = processedBase.toLowerCase();
    } else if (caseMode === 'upper') {
        processedBase = processedBase.toUpperCase();
    }

    // 4. 序号处理
    let finalBase = processedBase;
    const enableNum = document.getElementById('batchrename-enable-num')?.checked ?? false;
    if (enableNum) {
        const numBase = (document.getElementById('batchrename-num-base')?.value || '').trim();
        const numPos = document.getElementById('batchrename-num-pos')?.value || 'suffix';
        const numStart = parseInt(document.getElementById('batchrename-num-start')?.value, 10);
        const start = isNaN(numStart) ? 1 : numStart;
        const numWidth = parseInt(document.getElementById('batchrename-num-width')?.value, 10);
        const width = isNaN(numWidth) ? 2 : numWidth;

        const currentNum = start + idx;
        const numStr = String(currentNum).padStart(width, '0');

        if (numPos === 'complete') {
            finalBase = (numBase || '') + numStr;
        } else if (numPos === 'prefix') {
            finalBase = numStr + (numBase || processedBase);
        } else { // suffix
            finalBase = (numBase || processedBase) + numStr;
        }
    }

    return finalBase + ext;
}

function _renderBatchRenameList() {
    const listEl = document.getElementById('batchrename-file-list');
    const countEl = document.getElementById('batchrename-count');
    if (!listEl) return;

    if (_batchRenameFiles.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:13px;">请先选择或拖拽文件到上方区域</div>`;
        if (countEl) countEl.textContent = '0 个文件';
        return;
    }

    const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    listEl.innerHTML = _batchRenameFiles.map((f, i) => {
        const newName = _calculateNewName(f, i);
        const isChanged = f.name !== newName;
        const newNameStyle = isChanged ? 'color: var(--accent-color); font-weight: 600;' : 'color: var(--text-secondary);';
        
        return `<div style="background:var(--bg-secondary); border-radius:6px; padding:10px 12px; display:flex; align-items:center; gap:12px; border: 1px solid var(--border-color);">
            <div style="flex:1; min-width:0; display:flex; flex-direction:column; gap:4px;">
                <div style="font-size:12px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escHtml(f.name)}">
                    原名: ${escHtml(f.name)}
                </div>
                <div style="font-size:13px; ${newNameStyle} white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escHtml(newName)}">
                    新名: ${escHtml(newName)}
                </div>
                <div style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                    路径: ${escHtml(f.path)}
                </div>
            </div>
            <button class="btn" style="padding:2px 6px; font-size:11px; flex-shrink:0;" onclick="_removeBatchRenameFile(${i})">✕</button>
        </div>`;
    }).join('');

    if (countEl) countEl.textContent = `${_batchRenameFiles.length} 个文件`;
}

async function startBatchRename() {
    const statusEl = document.getElementById('batchrename-status');
    if (_batchRenameFiles.length === 0) {
        if (statusEl) { statusEl.textContent = '⚠️ 请先选择或拖拽文件'; statusEl.style.color = 'var(--warning)'; }
        return;
    }

    const copyMode = document.getElementById('batchrename-copy-mode')?.checked ?? false;
    if (statusEl) { statusEl.textContent = `处理中... 0/${_batchRenameFiles.length}`; statusEl.style.color = ''; }

    let okCount = 0;
    try {
        for (let i = 0; i < _batchRenameFiles.length; i++) {
            const f = _batchRenameFiles[i];
            const newName = _calculateNewName(f, i);
            const dir = f.path.replace(/[\\/][^\\/]+$/, '');
            const sep = dir.includes('\\') ? '\\' : '/';
            const newPath = `${dir}${sep}${newName}`;

            await window.electronAPI.apiCall('file/rename', {
                source: f.path,
                target: newPath,
                copy: copyMode,
            });
            okCount++;
            if (statusEl) statusEl.textContent = `处理中... ${okCount}/${_batchRenameFiles.length}`;
        }
        
        if (statusEl) {
            statusEl.textContent = `✅ 成功${copyMode ? '复制' : '重命名'} ${okCount} 个文件`;
            statusEl.style.color = 'var(--success)';
        }
        showToast(`批量重命名完成: ${okCount} 个文件`, 'success');
        
        if (!copyMode) {
            _batchRenameFiles = [];
            _renderBatchRenameList();
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = `❌ 失败: ${err.message}`;
            statusEl.style.color = 'var(--error)';
        }
        showToast('批量重命名失败: ' + err.message, 'error');
    }
}

// 初始化批量重命名模块与音频检测对齐模块
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(_initBatchRename, 200);
    setTimeout(initAudioMatchFileInputs, 200);
});

// ==================== 音频检测与对齐模块 ====================
let amOriginalPath = '';
let amConvertedPath = '';
let amOriginalBuffer = null;
let amConvertedBuffer = null;
let amAlignedBuffer = null;
let amAudioContext = null;
let amOriginalEnvelope = null;
let amConvertedEnvelope = null;
let amSegments = [];
let amCurrentPlaySources = [];
let amOffsetMs = 0;
let amPlaybackTime = 0;
let amPlayheadAnimationId = null;
let amPlaybackStartOffset = 0;
let amPlaybackStartTimeInContext = 0;
let amCurrentPlayType = null;

function toArrayBuffer(buf) {
    if (!buf) return null;
    if (buf instanceof ArrayBuffer) {
        return buf;
    }
    if (ArrayBuffer.isView(buf)) {
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (buf.type === 'Buffer' && Array.isArray(buf.data)) {
        return new Uint8Array(buf.data).buffer;
    }
    if (buf.buffer instanceof ArrayBuffer) {
        return buf.buffer;
    }
    return null;
}

// 2阶 IIR 带通滤波器，限制频率在人声区间 200Hz - 3400Hz，过滤环境背景音乐(BGM)、低频交流声和高频噪声
function bandpassFilter(samples, sampleRate) {
    const output = new Float32Array(samples.length);
    const dt = 1.0 / sampleRate;
    const rcLP = 1.0 / (2.0 * Math.PI * 3400);
    const alphaLP = dt / (rcLP + dt);
    const rcHP = 1.0 / (2.0 * Math.PI * 200);
    const alphaHP = rcHP / (rcHP + dt);
    
    let lpVal = 0;
    let hpVal = 0;
    let prevIn = 0;
    
    for (let i = 0; i < samples.length; i++) {
        // 低通滤波器 3400Hz
        lpVal = lpVal + alphaLP * (samples[i] - lpVal);
        // 高通滤波器 200Hz (作用于低通结果上)
        hpVal = alphaHP * (hpVal + lpVal - prevIn);
        prevIn = lpVal;
        output[i] = hpVal;
    }
    return output;
}

function initAudioMatchFileInputs() {
    const origInput = document.getElementById('am-original-input');
    const convInput = document.getElementById('am-converted-input');
    if (origInput) {
        origInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                amOriginalPath = window.electronAPI?.getFilePath?.(file) || file.path || '';
                document.getElementById('am-original-path').value = amOriginalPath || file.name;
            }
        });
    }
    if (convInput) {
        convInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                const file = e.target.files[0];
                amConvertedPath = window.electronAPI?.getFilePath?.(file) || file.path || '';
                document.getElementById('am-converted-path').value = amConvertedPath || file.name;
            }
        });
    }

    // 拖拽支持
    const origCard = document.getElementById('am-original-card');
    const convCard = document.getElementById('am-converted-card');
    const mediaExts = ['.mp4', '.mov', '.mkv', '.wav', '.mp3', '.m4a'];

    if (origCard) {
        origCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            origCard.style.borderColor = '#a78bfa';
            origCard.style.background = 'rgba(167, 139, 250, 0.08)';
        });
        origCard.addEventListener('dragleave', () => {
            origCard.style.borderColor = 'rgba(255,255,255,0.15)';
            origCard.style.background = 'rgba(255,255,255,0.02)';
        });
        origCard.addEventListener('drop', (e) => {
            e.preventDefault();
            origCard.style.borderColor = 'rgba(255,255,255,0.15)';
            origCard.style.background = 'rgba(255,255,255,0.02)';
            
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                const matched = mediaExts.some(ext => file.name.toLowerCase().endsWith(ext));
                if (matched) {
                    amOriginalPath = window.electronAPI?.getFilePath?.(file) || file.path || '';
                    document.getElementById('am-original-path').value = amOriginalPath || file.name;
                    showToast('已拖入并加载原始音频/视频', 'success');
                } else {
                    showToast('不支持的文件格式，仅支持 mp4, mov, mkv, wav, mp3, m4a', 'warning');
                }
            }
        });
    }

    if (convCard) {
        convCard.addEventListener('dragover', (e) => {
            e.preventDefault();
            convCard.style.borderColor = '#60a5fa';
            convCard.style.background = 'rgba(96, 165, 250, 0.08)';
        });
        convCard.addEventListener('dragleave', () => {
            convCard.style.borderColor = 'rgba(255,255,255,0.15)';
            convCard.style.background = 'rgba(255,255,255,0.02)';
        });
        convCard.addEventListener('drop', (e) => {
            e.preventDefault();
            convCard.style.borderColor = 'rgba(255,255,255,0.15)';
            convCard.style.background = 'rgba(255,255,255,0.02)';
            
            if (e.dataTransfer.files.length > 0) {
                const file = e.dataTransfer.files[0];
                const matched = mediaExts.some(ext => file.name.toLowerCase().endsWith(ext));
                if (matched) {
                    amConvertedPath = window.electronAPI?.getFilePath?.(file) || file.path || '';
                    document.getElementById('am-converted-path').value = amConvertedPath || file.name;
                    showToast('已拖入并加载变声后音频/视频', 'success');
                } else {
                    showToast('不支持的文件格式，仅支持 mp4, mov, mkv, wav, mp3, m4a', 'warning');
                }
            }
        });
    }

    // 点击波形图跳转播放轴支持
    const origCanvas = document.getElementById('am-canvas-original');
    const convCanvas = document.getElementById('am-canvas-converted');
    const diffCanvas = document.getElementById('am-canvas-diff');

    const handleCanvasClick = (e, canvasEl) => {
        if (!amOriginalBuffer) return;
        const rect = canvasEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = rect.width;
        const clickRatio = Math.max(0, Math.min(1, x / w));
        const clickedTime = clickRatio * amOriginalBuffer.duration;

        // 如果正在播放，停止并从点击的时刻重新开始播放当前类型
        if (amCurrentPlayType) {
            playAudioMatchAudio(amCurrentPlayType, clickedTime);
        } else {
            // 否则仅更新播放时间并重画界面线
            amPlaybackTime = clickedTime;
            drawAudioMatchWaveforms();
        }
    };

    if (origCanvas) {
        origCanvas.addEventListener('click', (e) => handleCanvasClick(e, origCanvas));
    }
    if (convCanvas) {
        convCanvas.addEventListener('click', (e) => handleCanvasClick(e, convCanvas));
    }
    if (diffCanvas) {
        diffCanvas.addEventListener('click', (e) => handleCanvasClick(e, diffCanvas));
    }
}

async function selectAudioMatchFile(type) {
    const filters = [{ name: '媒体文件', extensions: ['mp4', 'mov', 'mkv', 'wav', 'mp3', 'm4a'] }];
    if (window.electronAPI?.selectFiles) {
        const files = await window.electronAPI.selectFiles({
            filters,
            multiple: false,
            title: type === 'original' ? '选择原始音视频' : '选择变声后音视频'
        });
        if (files && files.length > 0) {
            const filePath = files[0];
            if (type === 'original') {
                amOriginalPath = filePath;
                document.getElementById('am-original-path').value = filePath;
            } else {
                amConvertedPath = filePath;
                document.getElementById('am-converted-path').value = filePath;
            }
        }
    } else {
        const input = document.getElementById(type === 'original' ? 'am-original-input' : 'am-converted-input');
        if (input) input.click();
    }
}

async function runAudioMatchAnalysis() {
    if (!amOriginalPath || !amConvertedPath) {
        showToast('请先选择两个音频/视频文件', 'error');
        return;
    }

    // 重置播放轴状态
    amPlaybackTime = 0;
    amCurrentPlayType = null;
    cancelPlayheadAnimation();

    const statusSec = document.getElementById('am-status-section');
    const statusText = document.getElementById('am-status-text');
    const progressBarInner = document.querySelector('#am-progress-bar .progress-bar-inner');
    
    statusSec.classList.remove('hidden');
    progressBarInner.style.width = '10%';
    statusText.textContent = '读取原始音频中...';

    try {
        if (!amAudioContext) {
            amAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        const origData = await window.electronAPI.readFileBuffer(amOriginalPath);
        progressBarInner.style.width = '30%';
        statusText.textContent = '解码原始音频中...';
        
        const origArrayBuf = toArrayBuffer(origData);
        if (!origArrayBuf) throw new Error('无法转换原始音频数据为 ArrayBuffer');
        amOriginalBuffer = await amAudioContext.decodeAudioData(origArrayBuf);

        progressBarInner.style.width = '45%';
        statusText.textContent = '读取变声音频中...';
        const convData = await window.electronAPI.readFileBuffer(amConvertedPath);
        progressBarInner.style.width = '60%';
        statusText.textContent = '解码变声音频中...';
        
        const convArrayBuf = toArrayBuffer(convData);
        if (!convArrayBuf) throw new Error('无法转换变声音频数据为 ArrayBuffer');
        amConvertedBuffer = await amAudioContext.decodeAudioData(convArrayBuf);

        progressBarInner.style.width = '80%';
        statusText.textContent = '正在计算音频特征包络...';

        amOriginalEnvelope = extractEnvelope(amOriginalBuffer, 100);
        amConvertedEnvelope = extractEnvelope(amConvertedBuffer, 100);

        statusText.textContent = '正在计算频谱包络对齐偏置...';
        // 动态计算最大偏置搜索范围，最大支持15秒（1500帧）
        const maxLagFrames = Math.min(1500, Math.floor(Math.min(amOriginalEnvelope.length, amConvertedEnvelope.length) * 0.9));
        const crossCorr = computeCrossCorrelation(amOriginalEnvelope, amConvertedEnvelope, maxLagFrames);
        amOffsetMs = Math.round(crossCorr.bestLag * 10);

        // 动态设置滑动条的最大/最小范围
        const maxOffsetLimit = Math.round(Math.min(amOriginalBuffer.duration, amConvertedBuffer.duration) * 0.8 * 1000);
        const rangeEl = document.getElementById('am-offset-range');
        if (rangeEl) {
            rangeEl.min = -maxOffsetLimit;
            rangeEl.max = maxOffsetLimit;
        }

        document.getElementById('am-offset-range').value = amOffsetMs;
        document.getElementById('am-offset-val-text').textContent = `${amOffsetMs} ms`;

        detectSpeechSegments();
        drawAudioMatchWaveforms();

        document.getElementById('am-btn-autoalign').disabled = false;
        document.getElementById('am-btn-export').disabled = true;
        document.getElementById('am-play-aligned').disabled = true;

        progressBarInner.style.width = '100%';
        statusText.textContent = '分析对比完成！';
        setTimeout(() => statusSec.classList.add('hidden'), 1000);

        document.getElementById('am-visualizer-section').classList.remove('hidden');
        document.getElementById('am-results-section').classList.remove('hidden');

        const driftText = amOffsetMs !== 0 ? `检测到整体时间漂移: ${amOffsetMs} ms` : '音轨完美对齐，无时间偏移';
        document.getElementById('am-align-info').textContent = `${driftText} (匹配度 ${Math.round(crossCorr.maxVal * 100)}%)`;

        showToast('音频特征分析完成', 'success');
    } catch (e) {
        console.error('Audio Match Analysis failed:', e);
        statusText.textContent = `❌ 失败: ${e.message}`;
        progressBarInner.style.background = 'var(--error)';
        showToast(`分析失败: ${e.message}`, 'error');
    }
}

function extractEnvelope(audioBuffer, framesPerSec) {
    const rawChData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    
    // 应用带通滤波器，保留 200Hz - 3400Hz 的人声频率区间，过滤 BGM 低音和高频噪音
    const chData = bandpassFilter(rawChData, sampleRate);
    
    const samplesPerFrame = Math.round(sampleRate / framesPerSec);
    const numFrames = Math.ceil(chData.length / samplesPerFrame);
    const envelope = new Float32Array(numFrames);

    for (let f = 0; f < numFrames; f++) {
        const startIdx = f * samplesPerFrame;
        const endIdx = Math.min(startIdx + samplesPerFrame, chData.length);
        let sum = 0;
        for (let i = startIdx; i < endIdx; i++) {
            sum += chData[i] * chData[i];
        }
        envelope[f] = Math.sqrt(sum / (endIdx - startIdx || 1));
    }

    // 1. 平滑处理 (Moving Average)
    const smoothEnv = new Float32Array(numFrames);
    const win = 3;
    for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        let count = 0;
        for (let j = Math.max(0, i - win); j <= Math.min(numFrames - 1, i + win); j++) {
            sum += envelope[j];
            count++;
        }
        smoothEnv[i] = sum / count;
    }

    // 2. 去除环境噪音底噪 (减去第5百分位数)
    const sortedVals = [...smoothEnv].sort((a, b) => a - b);
    const noiseFloor = sortedVals[Math.floor(smoothEnv.length * 0.05)] || 0;
    for (let i = 0; i < numFrames; i++) {
        smoothEnv[i] = Math.max(0, smoothEnv[i] - noiseFloor);
    }

    // 3. 归一化到 [0, 1] 区间，消除绝对音量差异，极大地提高频谱形状匹配精度
    let maxVal = 0;
    for (let i = 0; i < numFrames; i++) {
        if (smoothEnv[i] > maxVal) maxVal = smoothEnv[i];
    }
    if (maxVal > 0) {
        for (let i = 0; i < numFrames; i++) {
            smoothEnv[i] /= maxVal;
        }
    }

    return smoothEnv;
}

function computeCrossCorrelation(env1, env2, maxLagFrames) {
    let bestLag = 0;
    let maxVal = -1;

    // 使用去均值皮尔逊相关系数 (Pearson Correlation Coefficient) 进行全局对齐，去除直流偏置
    for (let lag = -maxLagFrames; lag <= maxLagFrames; lag++) {
        let count = 0;
        let sum1 = 0;
        let sum2 = 0;

        // 1. 第一轮循环：计算当前重叠范围内的总和，用于算均值
        for (let t = 0; t < env1.length; t++) {
            const t2 = t + lag;
            if (t2 >= 0 && t2 < env2.length) {
                sum1 += env1[t];
                sum2 += env2[t2];
                count++;
            }
        }

        if (count < 50) continue; // 要求至少 500ms 重叠

        const mean1 = sum1 / count;
        const mean2 = sum2 / count;

        // 2. 第二轮循环：计算去均值的余弦相似度
        let sumCross = 0;
        let sum1Sq = 0;
        let sum2Sq = 0;

        for (let t = 0; t < env1.length; t++) {
            const t2 = t + lag;
            if (t2 >= 0 && t2 < env2.length) {
                const v1 = env1[t] - mean1;
                const v2 = env2[t2] - mean2;
                sumCross += v1 * v2;
                sum1Sq += v1 * v1;
                sum2Sq += v2 * v2;
            }
        }

        if (sum1Sq > 0 && sum2Sq > 0) {
            const val = sumCross / Math.sqrt(sum1Sq * sum2Sq);
            if (val > maxVal) {
                maxVal = val;
                bestLag = lag;
            }
        }
    }

    return { bestLag, maxVal };
}

function detectSpeechSegments() {
    if (!amOriginalEnvelope) return;
    
    // 归一化后，VAD threshold 使用 0.06 极为稳定
    const threshold = 0.06;
    const minSilenceFrames = 30; // 300ms 停顿切分句子
    const minSpeechFrames = 15;  // 150ms 最小语音长度
    
    amSegments = [];
    let inSpeech = false;
    let speechStart = 0;
    let silenceCount = 0;

    for (let i = 0; i < amOriginalEnvelope.length; i++) {
        const v = amOriginalEnvelope[i];
        if (v >= threshold) {
            if (!inSpeech) {
                inSpeech = true;
                speechStart = i;
            }
            silenceCount = 0;
        } else {
            if (inSpeech) {
                silenceCount++;
                if (silenceCount >= minSilenceFrames) {
                    const speechEnd = i - silenceCount + 1;
                    if (speechEnd - speechStart >= minSpeechFrames) {
                        amSegments.push({
                            startFrame: speechStart,
                            endFrame: speechEnd,
                            startTime: speechStart * 0.01,
                            endTime: speechEnd * 0.01
                        });
                    }
                    inSpeech = false;
                }
            }
        }
    }
    
    if (inSpeech) {
        const speechEnd = amOriginalEnvelope.length;
        if (speechEnd - speechStart >= minSpeechFrames) {
            amSegments.push({
                startFrame: speechStart,
                endFrame: speechEnd,
                startTime: speechStart * 0.01,
                endTime: speechEnd * 0.01
            });
        }
    }

    const resultsList = document.getElementById('am-results-list');
    resultsList.innerHTML = '';

    let mismatchCount = 0;
    let totalSegments = amSegments.length;

    amSegments.forEach((seg, idx) => {
        const offsetFrames = Math.round(amOffsetMs / 10);
        const alignedStartFrame = seg.startFrame + offsetFrames;
        
        const segOrig = amOriginalEnvelope.slice(seg.startFrame, seg.endFrame + 1);

        // 局部滑动相关搜索：限制在紧凑的 ±1.5 秒 (±150 帧) 以内，防止误匹配到其他句子
        // 并使用去均值的皮尔逊相关系数，以确保比对精度
        let bestLocalCorr = -1;
        let bestLocalLag = 0;
        const maxLocalLag = 150; 

        for (let lag = -maxLocalLag; lag <= maxLocalLag; lag++) {
            let count = 0;
            let sum1 = 0;
            let sum2 = 0;
            
            for (let j = 0; j < segOrig.length; j++) {
                const convIdx = alignedStartFrame + j + lag;
                if (convIdx >= 0 && convIdx < amConvertedEnvelope.length) {
                    sum1 += segOrig[j];
                    sum2 += amConvertedEnvelope[convIdx];
                    count++;
                }
            }
            
            if (count < 10) continue; // 至少需要有 100ms 重叠
            
            const mean1 = sum1 / count;
            const mean2 = sum2 / count;
            
            let sCross = 0, sOrigSq = 0, sConvSq = 0;
            for (let j = 0; j < segOrig.length; j++) {
                const convIdx = alignedStartFrame + j + lag;
                if (convIdx >= 0 && convIdx < amConvertedEnvelope.length) {
                    const v1 = segOrig[j] - mean1;
                    const v2 = amConvertedEnvelope[convIdx] - mean2;
                    sCross += v1 * v2;
                    sOrigSq += v1 * v1;
                    sConvSq += v2 * v2;
                }
            }
            
            if (sOrigSq > 0 && sConvSq > 0) {
                const corr = sCross / Math.sqrt(sOrigSq * sConvSq);
                if (corr > bestLocalCorr) {
                    bestLocalCorr = corr;
                    bestLocalLag = lag;
                }
            }
        }

        // 最终匹配到的实际变声音频中的起始位置
        const matchedStartFrame = alignedStartFrame + bestLocalLag;
        const matchedEndFrame = matchedStartFrame + segOrig.length;

        // 计算目标变声音频在这个实际对齐的时间段内的平均能量
        let sumConv = 0;
        let count = 0;
        const checkStart = Math.max(0, matchedStartFrame);
        const checkEnd = Math.min(amConvertedEnvelope.length - 1, matchedEndFrame);
        for (let f = checkStart; f <= checkEnd; f++) {
            sumConv += amConvertedEnvelope[f];
            count++;
        }
        const avgEnergyConv = sumConv / (count || 1);

        let status = 'match';
        let statusText = '';
        let color = '';
        
        // 局部对于全局偏差的毫秒值
        const driftMs = bestLocalLag * 10;

        // 判定条件：
        // 1. 平均能量过低 (即目标音轨在该片段是静音，说明漏变了)
        // 2. 皮尔逊相关系数过低 (小于 0.45，说明人声波形趋势完全对不上，很可能是其他句子或噪音)
        // 3. 局部偏移漂移过大 (大于 400ms，说明时间线严重撕裂，也是未对齐的体现)
        if (avgEnergyConv < 0.02) {
            status = 'mismatch';
            statusText = '❌ 变声片段缺失或完全静音';
            color = '#f87171';
            mismatchCount++;
        } else if (bestLocalCorr < 0.45) {
            status = 'mismatch';
            statusText = `❌ 频谱内容不匹配 (相似度 ${Math.round(bestLocalCorr * 100)}%)`;
            color = '#f87171';
            mismatchCount++;
        } else if (Math.abs(driftMs) > 400) {
            status = 'mismatch';
            statusText = `❌ 严重时间错位: ${driftMs > 0 ? '+' : ''}${driftMs} ms (相似度 ${Math.round(bestLocalCorr * 100)}%)`;
            color = '#f87171';
            mismatchCount++;
        } else if (Math.abs(driftMs) > 80) { // 局部偏移在 80ms - 400ms 之间，属于微小漂移
            status = 'drift';
            statusText = `⚠️ 局部时间漂移: ${driftMs > 0 ? '+' : ''}${driftMs} ms (相似度 ${Math.round(bestLocalCorr * 100)}%)`;
            color = '#fb923c';
        } else {
            status = 'match';
            statusText = `✅ 正常对齐 (相似度 ${Math.round(bestLocalCorr * 100)}%)`;
            color = '#34d399';
        }

        seg.status = status;
        seg.correlation = bestLocalCorr;
        seg.avgEnergyConv = avgEnergyConv;
        // 保存该句子的最佳绝对偏移量 (在 converted 轨中的帧偏移)
        seg.localLag = offsetFrames + bestLocalLag; 

        const item = document.createElement('div');
        item.style.cssText = `display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:rgba(255,255,255,0.02); border-left:4px solid ${color}; border-radius:4px; font-size:12px;`;
        item.innerHTML = `
            <div>
                <span style="font-weight:bold; color:#e8ecff;">片段 #${idx + 1} (${seg.startTime.toFixed(2)}s - ${seg.endTime.toFixed(2)}s)</span>
                <span style="margin-left:12px; color:#a3aed0;">${statusText}</span>
            </div>
            <div style="font-family:monospace; color:#8b95c0;">相似度: ${Math.round(bestLocalCorr * 100)}%</div>
        `;
        resultsList.appendChild(item);
    });

    if (totalSegments === 0) {
        resultsList.innerHTML = '<div style="color:#8b95c0; font-size:12px; text-align:center; padding:12px;">未检测到明显的语音片段</div>';
    }
}

function drawAudioMatchWaveforms() {
    if (!amOriginalBuffer || !amConvertedBuffer) return;

    const drawWave = (canvasId, buffer, offsetMs = 0) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.parentElement.clientWidth;
        canvas.width = w;
        canvas.height = 80;
        
        ctx.clearRect(0, 0, w, 80);
        
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(0, 40);
        ctx.lineTo(w, 40);
        ctx.stroke();

        const chData = buffer.getChannelData(0);
        const sampleRate = buffer.sampleRate;
        const totalDuration = buffer.duration;
        const offsetSec = offsetMs / 1000;

        ctx.lineWidth = 1.5;
        ctx.strokeStyle = canvasId.includes('original') ? '#a78bfa' : '#60a5fa';
        ctx.beginPath();

        const step = Math.ceil(chData.length / w);
        for (let x = 0; x < w; x++) {
            const time = (x / w) * totalDuration;
            const actualTime = time - offsetSec;
            if (actualTime < 0 || actualTime > totalDuration) continue;
            
            const idx = Math.floor(actualTime * sampleRate);
            if (idx >= 0 && idx < chData.length) {
                let min = 1.0, max = -1.0;
                const endStep = Math.min(idx + step, chData.length);
                for (let k = idx; k < endStep; k++) {
                    const val = chData[k];
                    if (val < min) min = val;
                    if (val > max) max = val;
                }
                const y1 = 40 + min * 35;
                const y2 = 40 + max * 35;
                ctx.moveTo(x, y1);
                ctx.lineTo(x, y2);
            }
        }
        ctx.stroke();

        // 绘制播放轴红线
        if (amOriginalBuffer) {
            const playheadX = (amPlaybackTime / amOriginalBuffer.duration) * w;
            if (playheadX >= 0 && playheadX <= w) {
                ctx.strokeStyle = '#f43f5e';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(playheadX, 0);
                ctx.lineTo(playheadX, 80);
                ctx.stroke();
            }
        }
    };

    drawWave('am-canvas-original', amOriginalBuffer, 0);
    drawWave('am-canvas-converted', amConvertedBuffer, amOffsetMs);

    const diffCanvas = document.getElementById('am-canvas-diff');
    if (diffCanvas) {
        const ctx = diffCanvas.getContext('2d');
        const w = diffCanvas.parentElement.clientWidth;
        diffCanvas.width = w;
        diffCanvas.height = 30;
        ctx.clearRect(0, 0, w, 30);

        const totalDuration = amOriginalBuffer.duration;

        amSegments.forEach(seg => {
            const x1 = (seg.startTime / totalDuration) * w;
            const x2 = (seg.endTime / totalDuration) * w;
            const width = x2 - x1;

            let color = 'rgba(16, 185, 129, 0.35)';
            if (seg.status === 'mismatch') {
                color = 'rgba(239, 68, 68, 0.45)';
            } else if (seg.status === 'drift') {
                color = 'rgba(245, 158, 11, 0.45)';
            }

            ctx.fillStyle = color;
            ctx.fillRect(x1, 0, width, 30);

            ctx.strokeStyle = color.replace('0.35', '0.8').replace('0.45', '0.8');
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, 0, width, 30);
        });

        // 绘制播放轴红线
        const playheadX = (amPlaybackTime / totalDuration) * w;
        if (playheadX >= 0 && playheadX <= w) {
            ctx.strokeStyle = '#f43f5e';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(playheadX, 0);
            ctx.lineTo(playheadX, 30);
            ctx.stroke();
        }
    }
}

function updateAudioMatchManualOffset(val) {
    amOffsetMs = val;
    const txt = document.getElementById('am-offset-val-text');
    if (txt) txt.textContent = `${val} ms`;
    const rng = document.getElementById('am-offset-range');
    if (rng) rng.value = val;
    detectSpeechSegments();
    drawAudioMatchWaveforms();
}

function adjustAudioMatchManualOffset(delta) {
    const range = document.getElementById('am-offset-range');
    if (!range) return;
    const newVal = Math.max(parseInt(range.min), Math.min(parseInt(range.max), amOffsetMs + delta));
    updateAudioMatchManualOffset(newVal);
}

function resetAudioMatchManualOffset() {
    updateAudioMatchManualOffset(0);
}

async function runAudioMatchAutoAlign() {
    if (!amOriginalBuffer || !amConvertedBuffer) return;

    const statusSec = document.getElementById('am-status-section');
    const statusText = document.getElementById('am-status-text');
    const progressBarInner = document.querySelector('#am-progress-bar .progress-bar-inner');
    
    statusSec.classList.remove('hidden');
    progressBarInner.style.width = '20%';
    statusText.textContent = '正在执行自动剪辑拼接对齐...';

    try {
        const sr = amOriginalBuffer.sampleRate;
        const totalSamples = amOriginalBuffer.length;
        const channels = amOriginalBuffer.numberOfChannels;
        
        amAlignedBuffer = amAudioContext.createBuffer(channels, totalSamples, sr);
        const fallbackOriginal = document.getElementById('am-opt-fallback-voice').checked;

        for (let ch = 0; ch < channels; ch++) {
            const origData = amOriginalBuffer.getChannelData(ch);
            const convData = amConvertedBuffer.getChannelData(ch < amConvertedBuffer.numberOfChannels ? ch : 0);
            const alignedData = amAlignedBuffer.getChannelData(ch);

            alignedData.fill(0);

            amSegments.forEach(seg => {
                const origStart = Math.floor(seg.startTime * sr);
                const origEnd = Math.floor(seg.endTime * sr);

                if (seg.status === 'mismatch' && !fallbackOriginal) {
                    return;
                }

                if (seg.status === 'mismatch' && fallbackOriginal) {
                    for (let i = origStart; i < origEnd; i++) {
                        if (i >= 0 && i < totalSamples) {
                            alignedData[i] = origData[i];
                        }
                    }
                    return;
                }

                // 局部分段精确微调对齐：直接使用该句子计算出来的最匹配绝对对齐位移
                const segmentOffsetMs = (seg.localLag || 0) * 10;
                const offsetSamples = Math.round((segmentOffsetMs / 1000) * sr);
                
                for (let i = origStart; i < origEnd; i++) {
                    const convIdx = i + offsetSamples;
                    if (i >= 0 && i < totalSamples) {
                        if (convIdx >= 0 && convIdx < convData.length) {
                            alignedData[i] = convData[convIdx];
                        } else if (fallbackOriginal) {
                            alignedData[i] = origData[i];
                        }
                    }
                }
            });

            if (fallbackOriginal) {
                let speechMask = new Uint8Array(totalSamples);
                amSegments.forEach(seg => {
                    const origStart = Math.floor(seg.startTime * sr);
                    const origEnd = Math.floor(seg.endTime * sr);
                    for (let i = origStart; i < origEnd; i++) {
                        if (i >= 0 && i < totalSamples) speechMask[i] = 1;
                    }
                });

                for (let i = 0; i < totalSamples; i++) {
                    if (speechMask[i] === 0) {
                        alignedData[i] = origData[i];
                    }
                }
            }
        }

        progressBarInner.style.width = '80%';
        statusText.textContent = '音频对齐拼接成功！';

        document.getElementById('am-btn-export').disabled = false;
        document.getElementById('am-play-aligned').disabled = false;

        progressBarInner.style.width = '100%';
        setTimeout(() => statusSec.classList.add('hidden'), 1000);
        showToast('音轨对齐剪辑拼接成功，现在可以试听或导出！', 'success');
    } catch (e) {
        console.error('Audio Match Auto Align failed:', e);
        statusText.textContent = `❌ 失败: ${e.message}`;
        progressBarInner.style.background = 'var(--error)';
        showToast(`对齐失败: ${e.message}`, 'error');
    }
}

function startPlayheadAnimation(startOffset) {
    cancelPlayheadAnimation();
    amPlaybackStartOffset = startOffset;
    amPlaybackStartTimeInContext = amAudioContext.currentTime;

    function update() {
        if (!amCurrentPlayType) return;
        const elapsed = amAudioContext.currentTime - amPlaybackStartTimeInContext;
        amPlaybackTime = amPlaybackStartOffset + elapsed;
        
        const maxDur = amOriginalBuffer ? amOriginalBuffer.duration : 0;
        if (amPlaybackTime >= maxDur) {
            amPlaybackTime = 0; // 播放结束复位到起点
            stopAudioMatchAudio();
            return;
        }

        drawAudioMatchWaveforms();
        amPlayheadAnimationId = requestAnimationFrame(update);
    }
    amPlayheadAnimationId = requestAnimationFrame(update);
}

function cancelPlayheadAnimation() {
    if (amPlayheadAnimationId) {
        cancelAnimationFrame(amPlayheadAnimationId);
        amPlayheadAnimationId = null;
    }
}

function playAudioMatchAudio(type, startOffset = null) {
    stopAudioMatchAudio();

    if (!amAudioContext) {
        amAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (startOffset === null) {
        startOffset = amPlaybackTime; // 默认从当前播放轴位置播放
    }

    const maxDur = amOriginalBuffer ? amOriginalBuffer.duration : 0;
    if (startOffset < 0 || startOffset >= maxDur) {
        startOffset = 0;
    }

    amCurrentPlayType = type;
    amPlaybackTime = startOffset;

    if (type === 'both') {
        if (!amOriginalBuffer || !amConvertedBuffer) {
            amCurrentPlayType = null;
            return;
        }
        try {
            const now = amAudioContext.currentTime;
            
            const srcOrig = amAudioContext.createBufferSource();
            srcOrig.buffer = amOriginalBuffer;
            srcOrig.connect(amAudioContext.destination);

            const srcConv = amAudioContext.createBufferSource();
            srcConv.buffer = amConvertedBuffer;
            srcConv.connect(amAudioContext.destination);

            // 应用当前滑动条对应的全局对齐偏移（单位：秒）来让两路音频重合播放
            const offsetSec = amOffsetMs / 1000;
            
            // 原音轨直接从 startOffset 开始播
            srcOrig.start(now, startOffset);

            // 变声音轨需要根据偏移量定位
            const convOffset = startOffset - offsetSec;
            if (convOffset >= 0) {
                srcConv.start(now, convOffset);
            } else {
                srcConv.start(now - convOffset, 0);
            }

            amCurrentPlaySources.push(srcOrig, srcConv);

            const btn = document.getElementById('am-play-both');
            if (btn) {
                btn.textContent = '⏸️ 正在对比播放';
                btn.style.borderColor = 'var(--success)';
            }

            let endedCount = 0;
            const onEndedHandler = () => {
                endedCount++;
                if (endedCount >= 2) {
                    stopAudioMatchAudio();
                }
            };
            srcOrig.onended = onEndedHandler;
            srcConv.onended = onEndedHandler;

            startPlayheadAnimation(startOffset);
        } catch (e) {
            showToast(`播放失败: ${e.message}`, 'error');
            amCurrentPlayType = null;
        }
        return;
    }

    let buffer = null;
    if (type === 'original') buffer = amOriginalBuffer;
    else if (type === 'converted') buffer = amConvertedBuffer;
    else if (type === 'aligned') buffer = amAlignedBuffer;

    if (!buffer) {
        amCurrentPlayType = null;
        return;
    }

    try {
        const src = amAudioContext.createBufferSource();
        src.buffer = buffer;
        src.connect(amAudioContext.destination);
        src.start(amAudioContext.currentTime, startOffset);

        amCurrentPlaySources.push(src);

        const btn = document.getElementById(
            type === 'original' ? 'am-play-orig' : (type === 'converted' ? 'am-play-conv' : 'am-play-aligned')
        );
        if (btn) {
            btn.textContent = '⏸️ 正在播放';
            btn.style.borderColor = 'var(--success)';
        }
        
        src.onended = () => {
            stopAudioMatchAudio();
        };

        startPlayheadAnimation(startOffset);
    } catch (e) {
        showToast(`播放失败: ${e.message}`, 'error');
        amCurrentPlayType = null;
    }
}

function stopAudioMatchAudio() {
    amCurrentPlayType = null;
    cancelPlayheadAnimation();

    if (amCurrentPlaySources && amCurrentPlaySources.length > 0) {
        amCurrentPlaySources.forEach(src => {
            try { src.stop(); } catch (_) {}
        });
        amCurrentPlaySources = [];
    }
    const o = document.getElementById('am-play-orig');
    if (o) { o.textContent = '🔊 试听原音'; o.style.borderColor = ''; }
    const c = document.getElementById('am-play-conv');
    if (c) { c.textContent = '🔊 试听变声'; c.style.borderColor = ''; }
    const a = document.getElementById('am-play-aligned');
    if (a) { a.textContent = '🔊 试听对齐后'; a.style.borderColor = ''; }
    const b = document.getElementById('am-play-both');
    if (b) { b.textContent = '🔊 同时对比试听'; b.style.borderColor = ''; }

    drawAudioMatchWaveforms();
}

async function exportAudioMatchResult() {
    if (!amAlignedBuffer) {
        showToast('请先执行自动对齐', 'error');
        return;
    }

    const statusSec = document.getElementById('am-status-section');
    const statusText = document.getElementById('am-status-text');
    const progressBarInner = document.querySelector('#am-progress-bar .progress-bar-inner');
    
    statusSec.classList.remove('hidden');
    progressBarInner.style.width = '10%';
    statusText.textContent = '正在生成无损 WAV 编码数据...';

    try {
        const wavArrayBuffer = bufferToWav(amAlignedBuffer);
        progressBarInner.style.width = '40%';
        statusText.textContent = '正在保存临时对齐音频...';

        const tempWavPath = await window.electronAPI.saveRenderedAudio(wavArrayBuffer);
        
        const isVideo = /\.(mp4|mov|mkv|avi|wmv|flv|webm)$/i.test(amOriginalPath);
        const originalDir = amOriginalPath.substring(0, amOriginalPath.lastIndexOf('/') + 1) || amOriginalPath.substring(0, amOriginalPath.lastIndexOf('\\') + 1);
        const originalName = amOriginalPath.substring(amOriginalPath.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '') || amOriginalPath.substring(amOriginalPath.lastIndexOf('\\') + 1).replace(/\.[^.]+$/, '');
        
        progressBarInner.style.width = '60%';
        
        if (isVideo) {
            statusText.textContent = '正在利用 FFmpeg 合成音视频并替换音轨...';
            const outputPath = originalDir + originalName + '_aligned_voice.mp4';
            
            const response = await apiFetch(`${API_BASE}/media/replace-audio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    video_path: amOriginalPath,
                    audio_path: tempWavPath,
                    output_path: outputPath
                })
            });
            
            const result = await response.json();
            if (response.ok && result.success) {
                progressBarInner.style.width = '100%';
                statusText.textContent = '导出完成！';
                showToast(`对齐视频成功导出到: ${outputPath}`, 'success');
                window.electronAPI?.showItemInFolder?.(outputPath);
            } else {
                throw new Error(result.error || '替换音轨失败');
            }
        } else {
            statusText.textContent = '正在转换音频格式并导出...';
            const ext = amOriginalPath.substring(amOriginalPath.lastIndexOf('.') + 1).toLowerCase();
            const formatMode = ['mp3', 'wav', 'm4a'].includes(ext) ? ext : 'mp3';
            const outputPath = originalDir + originalName + '_aligned_voice.' + formatMode;
            
            const response = await apiFetch(`${API_BASE}/media/convert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    files: [tempWavPath],
                    mode: formatMode,
                    output_dir: originalDir
                })
            });
            
            const result = await response.json();
            if (response.ok && result.files && result.files.length > 0) {
                progressBarInner.style.width = '100%';
                statusText.textContent = '导出完成！';
                showToast(`对齐音频已导出到原始目录`, 'success');
                window.electronAPI?.showItemInFolder?.(result.files[0]);
            } else {
                throw new Error(result.message || '转换音频失败');
            }
        }
        
        setTimeout(() => statusSec.classList.add('hidden'), 1000);
    } catch (e) {
        console.error('Export aligned media failed:', e);
        statusText.textContent = `❌ 导出失败: ${e.message}`;
        progressBarInner.style.background = 'var(--error)';
        showToast(`导出失败: ${e.message}`, 'error');
    }
}

// WAV Encoder Helpers
function bufferToWav(buffer) {
    const numOfChan = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    
    let result;
    if (numOfChan === 2) {
        result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else {
        result = buffer.getChannelData(0);
    }
    
    return writeWavFile(result, numOfChan, sampleRate, format, bitDepth);
}

function interleave(inputL, inputR) {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    
    while (index < length) {
        result[index++] = inputL[inputIndex];
        result[index++] = inputR[inputIndex];
        inputIndex++;
    }
    return result;
}

function writeWavFile(samples, numOfChan, sampleRate, format, bitDepth) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numOfChan, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numOfChan * 2, true);
    view.setUint16(32, numOfChan * 2, true);
    view.setUint16(34, bitDepth, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);
    
    floatTo16BitPCM(view, 44, samples);
    
    return buffer;
}

function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, input[i]));
        output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Expose functions to window
window.selectAudioMatchFile = selectAudioMatchFile;
window.runAudioMatchAnalysis = runAudioMatchAnalysis;
window.runAudioMatchAutoAlign = runAudioMatchAutoAlign;
window.exportAudioMatchResult = exportAudioMatchResult;
window.updateAudioMatchManualOffset = updateAudioMatchManualOffset;
window.adjustAudioMatchManualOffset = adjustAudioMatchManualOffset;
window.resetAudioMatchManualOffset = resetAudioMatchManualOffset;
window.playAudioMatchAudio = playAudioMatchAudio;
window.stopAudioMatchAudio = stopAudioMatchAudio;
