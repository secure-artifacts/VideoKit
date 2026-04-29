/**
 * reels-batch-table.js — 批量文字卡片表格管理
 *
 * 表格驱动的批量生产面板：
 *   - 每行 = 一个 Reel 任务
 *   - 列: # | 背景素材 | 音频 | 字幕 | 标题 | 内容 | 模板
 *   - 支持从 Google Sheets 粘贴 标题+内容
 *   - 每行可独立选择卡片模板
 *   - 拖拽/批量分配素材
 */

// ═══════════════════════════════════════════════════════
// 1. Core State & Config
// ═══════════════════════════════════════════════════════

let _dragSrcIdx = null; // 拖拽排序：源行索引（模块级，供 panel drop 判断）
const _VOICE_HINT_REGEX = /(^|[\s._-])(voice|audio|dub|dubbing|narration|vo|配音|人声|旁白|解说|口播)([\s._-]|$)/i;
const _VOICE_VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']);

function _looksLikeVoiceTrack(name = '') {
    return _VOICE_HINT_REGEX.test(name || '');
}

const _batchTableState = {
    visible: false,
    container: null,
    // ── 多标签页 ──
    tabs: [
        { id: 'tab_1', name: '默认', materialDir: '', lastRefreshTime: null, tasks: [] }
    ],
    activeTabId: 'tab_1',
    nextTabId: 2,
    // ── 视频分配模式（默认关闭） ──
    videoDropRouteEnabled: false,
    videoDropRouteMode: 'bg', // 'bg' | 'audio'
    // ── 批量选择 ──
    selectedRows: new Set(),
    actionsCollapsed: false,
    mediaPoolOpen: false,
    // ── 工程管理 ──
    projectDir: '',
    projectName: 'UntitledProject.json',
};

// ── 标签页辅助 ──
function _getActiveTab() {
    return _batchTableState.tabs.find(t => t.id === _batchTableState.activeTabId) || _batchTableState.tabs[0];
}

function _syncTasksToActiveTab() {
    const tab = _getActiveTab();
    if (tab) {
        tab.tasks = _serializeTasks(window._reelsState.tasks);
        // DEBUG
        const _dbg = tab.tasks.slice(0, 3).map((t, i) => `[${i}] bgScale=${t.bgScale}`);
        console.log('[BatchTable._syncTasksToActiveTab] 保存到 tab:', _dbg.join(', '));
    }
}

function _loadTabTasks(tab) {
    window._reelsState.tasks = (tab.tasks || []).map(t => ({ ...t }));
    window._reelsState.selectedIdx = -1;
}

function _switchToTab(tabId) {
    if (tabId === _batchTableState.activeTabId) return;
    // Save current tab tasks
    _syncTasksToActiveTab();
    _batchTableState.activeTabId = tabId;
    const tab = _getActiveTab();
    _loadTabTasks(tab);
    _batchTableState.selectedRows = new Set();
    _renderBatchTable();
}

function _addTab(name) {
    const id = 'tab_' + _batchTableState.nextTabId++;
    const tab = { id, name: name || `标签${_batchTableState.tabs.length + 1}`, materialDir: '', lastRefreshTime: null, tasks: [] };
    _batchTableState.tabs.push(tab);
    _switchToTab(id);
}

function _removeTab(tabId) {
    if (_batchTableState.tabs.length <= 1) { alert('至少保留一个标签页'); return; }
    const idx = _batchTableState.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    if (!confirm(`确定删除标签「${_batchTableState.tabs[idx].name}」及其所有任务？`)) return;
    _batchTableState.tabs.splice(idx, 1);
    if (_batchTableState.activeTabId === tabId) {
        _batchTableState.activeTabId = _batchTableState.tabs[Math.min(idx, _batchTableState.tabs.length - 1)].id;
        _loadTabTasks(_getActiveTab());
    }
    _renderBatchTable();
}

async function _renameTab(tabId) {
    const tab = _batchTableState.tabs.find(t => t.id === tabId);
    if (!tab) return;
    const newName = await _showInputDialog('重命名标签', '输入标签名称');
    if (newName && newName.trim()) {
        tab.name = newName.trim();
        _renderBatchTable();
    }
}

// ═══════════════════════════════════════════════════════
// 2. Initialization
// ═══════════════════════════════════════════════════════

function _initBatchTable() {
    // 容器
    let container = document.getElementById('reels-batch-table-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'reels-batch-table-container';
        container.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;background:rgba(0,0,0,0.85);overflow:hidden;';
        document.body.appendChild(container);
    }
    _batchTableState.container = container;
}

// ═══════════════════════════════════════════════════════
// 3. Toggle visibility
// ═══════════════════════════════════════════════════════

function reelsToggleBatchTable() {
    if (!_batchTableState.container) _initBatchTable();
    _batchTableState.visible = !_batchTableState.visible;
    if (_batchTableState.visible) {
        // DEBUG
        const _dbg = (window._reelsState?.tasks || []).slice(0, 3).map((t, i) => `[${i}]bgScale=${t.bgScale}`);
        console.log('[BatchTable.toggle] 打开表格，当前 tasks:', _dbg.join(', '));
        // Sync current tasks into active tab on open
        _syncTasksToActiveTab();
        _renderBatchTable();
        _batchTableState.container.style.display = 'flex';
    } else {
        // 关闭时先保存输入框中的值到 task
        _applyBatchTableChanges();
        console.log('[BatchTable.toggle] 关闭表格，已保存 changes');
        _batchTableState.container.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════
// 3b. Language list for subtitle alignment
// ═══════════════════════════════════════════════════════

const REELS_LANG_STORAGE_KEY = 'reels_align_language';

const REELS_ALL_LANGUAGES = [
    // ── 常用 ──
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
    { name: '意大利语', code: 'it', en: 'Italian' },
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

function _initLangPicker(container) {
    const btn = container.querySelector('#rbt-lang-picker-btn');
    const dropdown = container.querySelector('#rbt-lang-dropdown');
    const searchInput = container.querySelector('#rbt-lang-search');
    const listEl = container.querySelector('#rbt-lang-list');
    const hiddenInput = container.querySelector('#rbt-align-lang');
    if (!btn || !dropdown || !listEl || !hiddenInput) return;

    // Restore saved language
    const savedLang = localStorage.getItem(REELS_LANG_STORAGE_KEY);
    if (savedLang) {
        const found = REELS_ALL_LANGUAGES.find(l => l.name === savedLang);
        if (found) {
            hiddenInput.value = found.name;
            btn.textContent = found.name + ' ▾';
        }
    }

    const renderList = (filter = '') => {
        const q = filter.toLowerCase().trim();
        const filtered = q
            ? REELS_ALL_LANGUAGES.filter(l =>
                l.name.includes(q) || l.en.toLowerCase().includes(q) || l.code.includes(q))
            : REELS_ALL_LANGUAGES;

        // Pinned first, then the rest
        const pinned = filtered.filter(l => l.pinned);
        const rest = filtered.filter(l => !l.pinned);
        const sorted = [...pinned, ...rest];

        listEl.innerHTML = sorted.map(l => `
            <div class="rbt-lang-item" data-name="${l.name}"
                 style="padding:6px 12px;cursor:pointer;font-size:12px;color:#ccc;
                        border-bottom:1px solid rgba(255,255,255,0.04);
                        display:flex;justify-content:space-between;align-items:center;
                        ${hiddenInput.value === l.name ? 'background:rgba(0,212,255,0.12);color:var(--accent);' : ''}
                        ${l.pinned ? 'font-weight:600;' : ''}">
                <span>${l.name}</span>
                <span style="font-size:10px;color:#666;">${l.en}</span>
            </div>
        `).join('');

        if (sorted.length === 0) {
            listEl.innerHTML = '<div style="padding:12px;text-align:center;color:#555;font-size:11px;">未找到匹配语言</div>';
        }
    };

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display !== 'none';
        dropdown.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
            searchInput.value = '';
            renderList();
            setTimeout(() => searchInput.focus(), 30);
        }
    });

    // Search filter
    searchInput.addEventListener('input', () => {
        renderList(searchInput.value);
    });
    searchInput.addEventListener('click', (e) => e.stopPropagation());

    // Click item
    listEl.addEventListener('click', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (!item) return;
        const name = item.dataset.name;
        hiddenInput.value = name;
        btn.textContent = name + ' ▾';
        dropdown.style.display = 'none';
        // Persist
        localStorage.setItem(REELS_LANG_STORAGE_KEY, name);
    });

    // Hover effect
    listEl.addEventListener('mouseover', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (item) item.style.background = 'rgba(255,255,255,0.08)';
    });
    listEl.addEventListener('mouseout', (e) => {
        const item = e.target.closest('.rbt-lang-item');
        if (item) item.style.background = hiddenInput.value === item.dataset.name ? 'rgba(0,212,255,0.12)' : '';
    });

    // Click outside to close
    document.addEventListener('click', (e) => {
        if (!container.querySelector('#rbt-lang-picker-wrap')?.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

// ═══════════════════════════════════════════════════════
// 4. Render the batch table
// ═══════════════════════════════════════════════════════

let _isRenderingBatchTable = false; // 防止 _applyBatchTableChanges 与 _renderBatchTable 互相触发
let _skipNextApply = false; // 粘贴等操作已直接写入 state，跳过 DOM→state 同步防止旧值覆盖

function _renderBatchTable() {
    const container = _batchTableState.container;
    const state = window._reelsState;
    if (!state) return;

    // ── 重绘前先保存所有输入框的值到 task 对象，防止未保存内容丢失 ──
    // 但如果是粘贴操作刚直接写过 state，就跳过，避免旧 DOM 值覆盖新数据
    if (_skipNextApply) {
        _skipNextApply = false;
    } else if (!_isRenderingBatchTable) {
        _isRenderingBatchTable = true;
        try { _applyBatchTableChanges(); } catch(e) { console.warn('[BatchTable] applyChanges error:', e); }
        _isRenderingBatchTable = false;
    }

    // ── 保存滚动位置（在 innerHTML 销毁前） ──
    const oldScrollWrap = container.querySelector('.rbt-table-wrap');
    const _savedScrollTop = oldScrollWrap ? oldScrollWrap.scrollTop : 0;
    const _savedScrollLeft = oldScrollWrap ? oldScrollWrap.scrollLeft : 0;

    // DEBUG: 追踪 bgScale 持久化
    const _dbgScales = (state.tasks || []).slice(0, 3).map((t, i) => `[${i}] bgScale=${t.bgScale} bgDur=${t.bgDurScale} audioDur=${t.audioDurScale}`);
    console.log('[BatchTable._renderBatchTable] 渲染前 task scales:', _dbgScales.join(', '));

    // 自动保存当前配置到 localStorage
    _batchAutoSave();
    const tasks = state.tasks || [];
    const activeTab = _getActiveTab();

    // 获取已保存的卡片模板列表
    const cardTemplates = _getOverlayGroupPresetList();
    const subtitlePresets = _getSubtitlePresetList();

    // 标签栏 HTML
    const tabsHtml = _batchTableState.tabs.map(tab => {
        const isActive = tab.id === _batchTableState.activeTabId;
        return `<div class="rbt-tab ${isActive ? 'rbt-tab-active' : ''}" data-tab-id="${tab.id}">
            <span class="rbt-tab-name" title="双击重命名">${_escHtml(tab.name)}</span>
            ${_batchTableState.tabs.length > 1 ? `<span class="rbt-tab-close" data-tab-id="${tab.id}" title="关闭标签">×</span>` : ''}
        </div>`;
    }).join('');

    // 素材文件夹信息
    const matDir = activeTab.materialDir || '';
    const matDirShort = matDir ? matDir.split(/[\\/]/).slice(-2).join('/') : '';
    const lastRefresh = activeTab.lastRefreshTime ? new Date(activeTab.lastRefreshTime).toLocaleTimeString() : '';

    // 批量选择子模板选项
    const batchSubOpts = _renderSubtitlePresetOptions(subtitlePresets, '');
    const batchCardOpts = _renderOverlayPresetOptions(cardTemplates, '');

    container.innerHTML = `
        <div class="rbt-panel">
            <!-- ═══ 标签栏与工程管理 ═══ -->
            <div class="rbt-tabbar" style="display:flex; justify-content:space-between; align-items:center;">
                <div class="rbt-tabs-scroll" style="flex:1;">
                    ${tabsHtml}
                    <div class="rbt-tab rbt-tab-add" title="新建标签页">＋</div>
                </div>
                <div style="padding-right:12px; display:flex; align-items:center; gap:8px;">
                    <span style="font-size:11px;color:#888;">📦 当前工程:</span>
                    <span id="rbt-project-mgr-btn" style="font-size:12px;color:var(--accent);cursor:pointer;text-decoration:underline;font-weight:bold;" title="点击设置保存目录与管理多工程">${_escHtml(_batchTableState.projectName || 'UntitledProject.json')}</span>
                </div>
            </div>

            <!-- ═══ Body Split: Media Sidebar + Main Content ═══ -->
            <div class="rbt-body-row">

            ${_batchTableState.mediaPoolOpen ? `
            <!-- ═══ LEFT: Media Pool Sidebar ═══ -->
            <div class="rbt-media-sidebar" id="rbt-media-sidebar">
                <div class="rbt-ms-header">
                    <span style="font-weight:bold; color:var(--accent-color); font-size:13px;">🗃️ 素材池</span>
                    <button id="rbt-close-media-sidebar" class="rbt-btn" style="padding:1px 6px; font-size:10px; background:#3a2020; border-color:#5a3030; color:#f87171;">✕</button>
                </div>
                <div class="rbt-ms-resize-handle" id="rbt-ms-resize"></div>
                <div class="rbt-ms-actions">
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-files" title="选择多个文件">📄 文件</button>
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-folder" title="选择文件夹，拆散其中所有文件">📁 目录</button>
                    <button class="rbt-btn rbt-ms-btn" id="rbt-ms-import-seq" title="整个目录作为一个序列帧素材">🎞️ 序列帧</button>
                </div>
                <div class="rbt-ms-linked-dir">
                    <div style="font-size:10px; color:var(--text-muted); font-weight:bold; margin-bottom:4px;">🔗 绑定文件夹</div>
                    <div style="display:flex; gap:4px; align-items:center;">
                        <span id="rbt-ms-dir-path" style="flex:1; font-size:10px; color:var(--text-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${_escHtml(matDir)}">${matDirShort || '<i style="color:var(--text-muted)">未绑定</i>'}</span>
                        <button class="rbt-btn" id="rbt-ms-select-dir" style="padding:1px 6px; font-size:9px;">📂</button>
                        <button class="rbt-btn" id="rbt-ms-refresh-dir" style="padding:1px 6px; font-size:9px; background:#1a3a2a; border-color:#2a5a3a; color:#8f8;" ${!matDir ? 'disabled' : ''}>🔄</button>
                    </div>
                    ${lastRefresh ? `<div style="font-size:9px; color:var(--text-muted); margin-top:2px;">上次: ${lastRefresh}</div>` : ''}
                </div>
                <div class="rbt-ms-collapsible-header" id="rbt-ms-toggle-filters" title="点击折叠/展开分类">
                    <span class="rbt-ms-toggle-icon" id="rbt-ms-toggle-icon">▾</span>
                    <span style="font-size:10px;font-weight:bold;color:var(--text-secondary);">分类 & 角色</span>
                    <span style="flex:1;"></span>
                    <span style="font-size:9px;color:var(--text-muted);">点击折叠</span>
                </div>
                <div class="rbt-ms-collapsible-body" id="rbt-ms-filters-body">
                <div class="rbt-ms-filters" id="rbt-ms-filter-list">
                    <div class="rbt-ms-filter active" data-filter="all">📁 全部 <span class="rbt-ms-count">(0)</span></div>
                    <div class="rbt-ms-section">[ 视觉 ]</div>
                    <div class="rbt-ms-filter" data-filter="bg">🖼️ 背景</div>
                    <div class="rbt-ms-filter" data-filter="overlay">🎬 覆层</div>
                    <div class="rbt-ms-filter" data-filter="hook">🪝 钩子</div>
                    <div class="rbt-ms-filter" data-filter="universal">♾️ 通用</div>
                    <div class="rbt-ms-section">[ 音频 ]</div>
                    <div class="rbt-ms-filter" data-filter="voice">🎙 人声</div>
                    <div class="rbt-ms-filter" data-filter="bgm">🎵 配乐</div>
                    <div class="rbt-ms-section">[ 文本 ]</div>
                    <div class="rbt-ms-filter" data-filter="text">📝 字幕</div>
                </div>
                <div class="rbt-ms-bulk">
                    <select class="rbt-select" id="rbt-ms-bulk-role" style="width:100%; height:24px; font-size:11px;">
                        <option value="">-- 批量改角色 --</option>
                        <option value="bg">🖼 背景素材</option>
                        <option value="overlay">🎬 视频覆层</option>
                        <option value="hook">🪝 钩子视频</option>
                        <option value="universal">♾️ 通用视觉</option>
                        <option value="voice">🎙 人声配音</option>
                        <option value="bgm">🎵 全局配乐</option>
                    </select>
                    <button class="rbt-btn" id="rbt-ms-apply-bulk" style="width:100%; margin-top:4px; font-size:11px;">应用角色</button>
                </div>
                </div>
                <div class="rbt-ms-pool" id="rbt-ms-pool">
                    <div style="color:var(--text-muted); font-size:12px; text-align:center; padding:20px 8px;">
                        📥 拖拽文件到此处<br>或点击上方按钮导入
                    </div>
                </div>
                <div class="rbt-ms-footer">
                    <button class="rbt-btn" id="rbt-ms-clear" style="width:100%; border-color:rgba(239,68,68,0.3); color:#f87171; font-size:11px;">🧹 清空素材池</button>
                </div>
            </div>
            ` : ''}

            <!-- ═══ RIGHT: Main Task Content ═══ -->
            <div class="rbt-main-col">

            <div class="rbt-header" style="display:flex; align-items:center; padding:4px 12px; gap:8px; height:auto; min-height:auto; max-height:none; flex-direction:row;">
                <button id="rbt-toggle-actions-btn" class="rbt-btn" style="padding:2px 8px;font-size:11px;" title="隐藏/显示操作面板">${_batchTableState.actionsCollapsed ? '🔽 展开操作面板' : '🔼 收起操作面板'}</button>
                <span style="flex:1;"></span>
                ${!_batchTableState.mediaPoolOpen && matDir ? `<span style="font-size:10px; color:var(--text-muted);">📁 ${_escHtml(matDirShort)}</span>` : ''}
            </div>

            <div class="rbt-header" style="height:auto; max-height:none; padding:8px 12px; flex-direction:column; gap:6px; align-items:stretch;">
                <div id="rbt-actions-wrapper" style="display:${_batchTableState.actionsCollapsed ? 'none' : 'flex'}; flex-direction:column; gap:0;">
                
                    <!-- === 1. 基础系统与工程管理 === -->
                    <div class="rbt-actions" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">工程管理:</span>
                        <button class="rbt-btn" id="rbt-add-row-btn" style="padding:2px 8px;font-size:11px;background:rgba(40,80,40,0.6);border:1px solid rgba(80,180,80,0.3);color:#a0e0b0;">添加行</button>
                        <button class="rbt-btn" id="rbt-clear-btn" style="padding:2px 8px;font-size:11px;background:rgba(120,40,40,0.6);border:1px solid rgba(220,80,80,0.3);color:#f48484;" title="清空全部">清空</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-save-config-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">保存工程</button>
                        <button class="rbt-btn" id="rbt-load-config-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">加载工程</button>
                        <input type="file" id="rbt-file-config" class="rbt-hidden-input" accept=".json">
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-col-settings-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">列设置</button>
                        <button class="rbt-btn" id="rbt-close-btn" style="padding:2px 8px;font-size:11px;background:rgba(120,40,40,0.6);border:1px solid rgba(220,80,80,0.3);color:#f48484;">关闭界面</button>
                    </div>

                    <!-- === 2. 核心数据调度与录入 === -->
                    <div class="rbt-actions" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">数据录入:</span>
                        <button id="rbt-open-media-pool-btn" class="rbt-btn" style="background:${_batchTableState.mediaPoolOpen ? 'rgba(50,70,160,0.6)' : 'rgba(40,60,120,0.6)'}; color:#9bb0ff; border:1px solid rgba(80,120,220,0.3); font-size:11px; padding:2px 8px;">${_batchTableState.mediaPoolOpen ? '收起素材池' : '打开素材池'}</button>
                        <button class="rbt-btn" id="rbt-cycle-fill-btn" style="background:rgba(255,255,255,0.05); color:#ccc; border:1px solid rgba(255,255,255,0.1); padding:2px 8px; font-size:11px;" title="打开素材循环填充面板">素材使用设置</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-paste-txtcontent" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从剪贴板粘贴到人声字幕列">人声对齐字幕（断行后）</button>
                        <button class="rbt-btn" id="rbt-paste-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格粘贴覆层文案(支持标题/内容/结尾多列格式)">粘贴覆层文案</button>
                        <button class="rbt-btn" id="rbt-paste-scroll-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="从 Google 表格批量粘贴滚动字幕">粘贴滚动字幕</button>
                        <button class="rbt-btn" id="rbt-paste-clip-ab" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="A/B双版文案">粘贴剪辑文案 (A/B版)</button>
                    </div>

                    <!-- === 4. 批量参数修剪 (Scaling) === -->
                    <div class="rbt-actions" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">整体参数缩放:</span>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的背景图片缩放">BG
                            <input type="number" id="rbt-batch-bgscale" min="50" max="300" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的背景素材时长缩放">BG时长
                            <input type="number" id="rbt-batch-bgdurscale" min="10" max="500" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;" title="批量设置选中行的人声音频素材时长缩放">音频时长
                            <input type="number" id="rbt-batch-audiodurscale" min="10" max="500" value="100" step="5" style="width:45px;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#ccc;padding:2px;font-size:11px;text-align:center;"> %
                        </label>
                        <button class="rbt-btn" id="rbt-apply-batch-scale" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用缩放</button>
                    </div>

                    <!-- === 5. AI与配音网络引擎 (AI & Voices) === -->
                    <div class="rbt-actions" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:none; padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">人声流水线:</span>
                        <span style="font-size:11px;color:#888;">AI模型:</span>
                        <select id="rbt-tts-model" class="rbt-select" style="width:145px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="eleven_v3">v3 (情感标签)</option>
                            <option value="eleven_turbo_v2_5">Eleven Turbo v2.5</option>
                            <option value="eleven_multilingual_v2">Eleven Multilingual v2</option>
                            <option value="eleven_monolingual_v1">Eleven Monolingual v1</option>
                        </select>
                        <span style="font-size:11px;color:#888;">配音音色:</span>
                        <input list="rbt-tts-voices-list" id="rbt-tts-default-voice" class="rbt-select" style="width:110px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;" placeholder="输入或选择音色ID" />
                        <datalist id="rbt-tts-voices-list"></datalist>
                        <button class="rbt-btn" id="rbt-refresh-voices-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="刷新列表">刷新</button>
                        <button class="rbt-btn" id="rbt-apply-voice-all-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="应用全部空行">应用全部</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-paste-ai-raw-btn" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">粘贴AI原文案</button>
                        <button class="rbt-btn" id="rbt-paste-tts-btn" style="font-size:11px;padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">粘贴TTS素材</button>
                        <!-- 幽灵事件锚点 -->
                        <div style="display:none;">
                            <button id="rbt-ai-gemini-btn"></button><button id="rbt-ai-tts-all-btn"></button><button id="rbt-ai-auto-all-btn"></button><button id="rbt-export-selected-btn"></button>
                        </div>
                    </div>

                    <!-- === 6. 字幕对齐后处理 (Alignment) === -->
                    <div class="rbt-actions" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center; border-bottom:none; padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">对齐设定:</span>
                        <select id="rbt-align-source" class="rbt-select" style="width:auto;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="audio">用人声对齐</option>
                            <option value="video">视频对齐</option>
                        </select>
                        <select id="rbt-align-txt-col" class="rbt-select" style="width:auto;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="txtContent">选列：[人声字幕]</option>
                            <option value="ttsText">选列：[TTS文案]</option>
                            <option value="overlay_title">选列：[覆层标题]</option>
                            <option value="overlay_body">选列：[覆层内容]</option>
                        </select>
                        <div style="position:relative;display:flex;align-items:center;">
                            <button class="rbt-btn" id="rbt-lang-picker-btn" style="padding:2px 8px;font-size:11px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;width:95px;display:flex;justify-content:space-between;align-items:center;height:24px;">英语 ▾</button>
                            <div id="rbt-lang-dropdown" style="display:none;position:absolute;top:100%;left:0;margin-top:4px;width:180px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,0.8);">
                                <div style="padding:4px;border-bottom:1px solid rgba(255,255,255,0.05);background:rgba(0,0,0,0.2);">
                                    <input type="text" id="rbt-lang-search" placeholder="搜索语种..." style="width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:2px 6px;font-size:11px;border-radius:2px;box-sizing:border-box;">
                                </div>
                                <div id="rbt-lang-list" style="max-height:220px;overflow-y:auto;"></div>
                            </div>
                            <input type="hidden" id="rbt-align-lang" value="英语">
                        </div>
                        <button class="rbt-btn" id="rbt-align-all-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">一键对齐字幕</button>
                        <label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#999;cursor:pointer;"><input type="checkbox" id="rbt-force-realign" style="margin:0;transform:scale(0.8);"> 强制覆盖已对齐任务</label>
                    </div>

                    <!-- === 7. 终极任务执行台 (Execution Block) === -->
                    <div class="rbt-actions" style="display:flex; gap:8px; align-items:center; border-bottom:none; padding-bottom:6px; margin-bottom:6px;">
                        <span style="font-size:11px; color:#aaa; font-weight:bold; margin-right:4px;">执行动作:</span>
                        <select id="rbt-unified-execute-mode" class="rbt-select" style="width:auto; height:24px; font-size:11px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.1); border-radius:4px; padding:0 8px; color:#ccc; cursor:pointer; outline:none;">
                            <option value="rbt-ai-auto-all-btn">一键: 执行AI大全家桶 (改写+配音合成+对齐生成)</option>
                            <option value="rbt-ai-gemini-btn">分步: 仅执行 AI 改写及处理文案</option>
                            <option value="rbt-ai-tts-all-btn">分步: 仅执行 批量生成配音及本地时间轴提取</option>
                        </select>
                        <button class="rbt-btn" id="rbt-unified-execute-btn" style="background:rgba(255,255,255,0.1); color:#fff; border:1px solid rgba(255,255,255,0.2); font-size:11px; padding:2px 16px; border-radius:4px; cursor:pointer;">启动流水线执行</button>
                        <button class="rbt-btn" id="rbt-ai-settings-btn" style="padding:2px 10px;font-size:11px;background:rgba(168,85,247,0.15);border:1px solid rgba(168,85,247,0.3);color:#a78bfa;border-radius:4px;cursor:pointer;" title="配置 Gemini API Key 和自定义 Prompt 指令">⚙️ AI设置</button>
                    </div>

                    <!-- === 8. 批量模板配置 (Select/Preset/Templates) === -->
                    <div class="rbt-actions" id="rbt-batch-bar" style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:0; padding-bottom:0; border-bottom:none;">
                        <span style="font-size:11px;color:var(--text-secondary);font-weight:bold;margin-right:4px;">批量预设:</span>
                        <label style="display:flex;align-items:center;font-size:11px;color:#ccc;cursor:pointer;gap:4px;"><input type="checkbox" id="rbt-select-all" style="margin:0;transform:scale(0.8);"> 全选</label>
                        <button class="rbt-btn" id="rbt-invert-select" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">反选</button>
                        <button class="rbt-btn" id="rbt-deselect-all" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">取消</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <button class="rbt-btn" id="rbt-ai-preset-btn" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;" title="一键覆盖选中行参数">任务预设设置</button>
                        <button class="rbt-btn" id="rbt-import-task-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入任务组合预设 JSON 文件">📥</button>
                        <span style="color:rgba(255,255,255,0.2);margin:0 2px;">|</span>
                        <select id="rbt-batch-sub-tpl" style="display:none;"><option value="">字幕模板...</option>${batchSubOpts}</select>
                        <div id="rbt-sub-tpl-trigger" class="rbt-select rbt-select-trigger" style="width:130px;height:24px;font-size:11px;padding:0 8px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;display:flex;align-items:center;">
                            <span id="rbt-sub-tpl-label" style="flex:1;">字幕模板...</span><span style="font-size:8px;">▼</span>
                        </div>
                        <button class="rbt-btn" id="rbt-apply-batch-sub" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用</button>
                        <button class="rbt-btn" id="rbt-import-sub-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入字幕预设 JSON 文件">📥</button>
                        <select id="rbt-batch-card-tpl" class="rbt-select" style="width:90px;height:24px;font-size:11px;padding:0 4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:#ccc;">
                            <option value="">覆层预设...</option>${batchCardOpts}
                        </select>
                        <button class="rbt-btn" id="rbt-apply-batch-card" style="padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#ccc;">应用</button>
                        <button class="rbt-btn" id="rbt-import-card-preset-btn" style="padding:2px 6px;font-size:10px;background:rgba(100,100,255,0.1);border:1px solid rgba(100,100,255,0.2);color:#8b8bfa;" title="导入覆层预设 JSON 文件">📥</button>
                        <span id="rbt-selected-count" style="margin-left:auto;font-size:11px;color:#aaa;"></span>
                    </div>

                </div>
            </div>

            <!-- hidden file inputs -->
            <input type="file" id="rbt-file-bg" class="rbt-hidden-input" accept=".mp4,.mov,.mkv,.avi,.wmv,.flv,.webm,.jpg,.jpeg,.png,.webp" multiple>
            <input type="file" id="rbt-file-audio" class="rbt-hidden-input" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm" multiple>
            <input type="file" id="rbt-file-srt" class="rbt-hidden-input" accept=".srt" multiple>
            <input type="file" id="rbt-file-txt" class="rbt-hidden-input" accept=".txt" multiple>
            <input type="file" id="rbt-file-bgm" class="rbt-hidden-input" accept=".mp3,.wav,.m4a,.aac,.flac,.ogg">
            <input type="file" id="rbt-file-single" class="rbt-hidden-input" accept="*/*">
            <input type="file" id="rbt-file-folder" class="rbt-hidden-input" webkitdirectory directory multiple>
            <div class="rbt-table-wrap">
                <table class="rbt-table" id="rbt-table">
                    <thead>
                        <tr>
                            <th class="rbt-col-drag" style="width:24px;"></th>
                            <th class="rbt-col-chk" style="width:30px;text-align:center;">
                                <input type="checkbox" id="rbt-header-select-all" style="margin:0;transform:scale(0.9);cursor:pointer;" title="全选所有行">
                            </th>
                            <th class="rbt-col-num">#</th>

                            <!-- 元数据与配置列 -->
                            <th class="rbt-col-act">操作</th>
                            <th class="rbt-col-tpl">字幕模板</th>
                            <th class="rbt-col-tpl">覆层预设</th>
                            <th class="rbt-col-dur">时长(s)</th>
                            <th class="rbt-col-exportname"><div class="rbt-th-wrap"><span>导出命名</span><button class="rbt-th-paste" data-paste-col="exportName" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="exportName" title="清空该列">清</button></div></th>

                            <!-- 🌟 视频封面层 (Gold) -->
                            <th class="rbt-col-cover-media rbt-grp-cover"><div class="rbt-th-wrap"><span>封面素材</span><button class="rbt-th-folder" data-folder-col="cover_media" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="cover_media" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cover-text rbt-grp-cover"><div class="rbt-th-wrap"><span>封面文案</span><button class="rbt-th-paste" data-paste-col="cover_text" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="cover_text" title="清空该列">清</button></div></th>

                            <!-- 🟦 画面基础层 (Blue) -->
                            <th class="rbt-col-hook rbt-grp-video"><div class="rbt-th-wrap"><span>前置Hook</span><button class="rbt-th-clear" data-clear-col="hook" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bg rbt-grp-video"><div class="rbt-th-wrap"><span>背景素材</span><button class="rbt-th-folder" data-folder-col="bg" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="bg" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgscale rbt-grp-video"><div class="rbt-th-wrap"><span>背景缩放</span><button class="rbt-th-clear" data-clear-col="bgScale" title="清空该列">清</button></div></th>
                            <th class="rbt-col-bgdurscale rbt-grp-video"><div class="rbt-th-wrap"><span>背景时长</span><button class="rbt-th-clear" data-clear-col="bgDurScale" title="清空该列">清</button></div></th>

                            <!-- 🎬 视频覆层 (Cyan) -->
                            <th class="rbt-col-contentvideo rbt-grp-cv"><div class="rbt-th-wrap"><span>内容视频</span><button class="rbt-th-folder" data-folder-col="contentvideo" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="contentvideo" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvtrim rbt-grp-cv"><div class="rbt-th-wrap"><span>✂️ 裁切</span><button class="rbt-th-clear" data-clear-col="cvTrim" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvscale rbt-grp-cv"><div class="rbt-th-wrap"><span>视频缩放</span><button class="rbt-th-clear" data-clear-col="cvScale" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvpos rbt-grp-cv"><div class="rbt-th-wrap"><span>视频位置</span><button class="rbt-th-clear" data-clear-col="cvPos" title="清空该列">清</button></div></th>
                            <th class="rbt-col-cvvol rbt-grp-cv"><div class="rbt-th-wrap"><span>🔊 覆层音量</span><button class="rbt-th-clear" data-clear-col="cvVol" title="清空该列">清</button></div></th>

                            <th class="rbt-col-bgm rbt-grp-video"><div class="rbt-th-wrap"><span>配乐</span><button class="rbt-th-folder" data-folder-col="bgm" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="bgm" title="清空该列">清</button></div></th>

                            <!-- 🟪 人声与音频层 (Purple) -->
                            <th class="rbt-col-ai_script rbt-grp-audio"><div class="rbt-th-wrap"><span>AI 原文案</span><button class="rbt-th-paste" data-paste-col="aiScript" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="ai_script" title="清空该列">清</button></div></th>
                            <th class="rbt-col-tts_text rbt-grp-audio"><div class="rbt-th-wrap"><span>TTS文案</span><button class="rbt-th-paste" data-paste-col="ttsText" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="tts_text" title="清空该列">清</button></div></th>
                            <th class="rbt-col-tts_voice rbt-grp-audio"><div class="rbt-th-wrap"><span>TTS音色</span><button class="rbt-th-paste" data-paste-col="ttsVoiceId" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="tts_voice" title="清空该列">清</button></div></th>
                            <th class="rbt-col-srt rbt-grp-audio"><div class="rbt-th-wrap"><span>字幕SRT</span><button class="rbt-th-folder" data-folder-col="srt" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="srt" title="清空该列">清</button></div></th>
                            <th class="rbt-col-txtcontent rbt-grp-audio"><div class="rbt-th-wrap"><span>人声对齐字幕（断行后）</span><button class="rbt-th-paste" data-paste-col="txtContent" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="txt" title="清空该列">清</button></div></th>
                            <th class="rbt-col-audio rbt-grp-audio"><div class="rbt-th-wrap"><span>人声音频层</span><button class="rbt-th-folder" data-folder-col="audio" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="audio" title="清空该列">清</button></div></th>
                            <th class="rbt-col-audiodurscale rbt-grp-audio"><div class="rbt-th-wrap"><span>人声变速</span><button class="rbt-th-clear" data-clear-col="audioDurScale" title="清空该列">清</button></div></th>

                            <!-- 🟧 覆层 (Amber) -->
                            <th class="rbt-col-pip rbt-grp-ovl"><div class="rbt-th-wrap"><span>图像覆层</span><button class="rbt-th-folder" data-folder-col="pip" title="选择文件夹批量分配">📁</button><button class="rbt-th-clear" data-clear-col="pip" title="清空该列">清</button></div></th>
                            <th class="rbt-col-title rbt-grp-ovl"><div class="rbt-th-wrap"><span>覆层标题</span><button class="rbt-th-paste" data-paste-col="overlay_title" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_title" title="清空该列">清</button></div></th>
                            <th class="rbt-col-body rbt-grp-ovl"><div class="rbt-th-wrap"><span>覆层内容</span><button class="rbt-th-paste" data-paste-col="overlay_body" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_body" title="清空该列">清</button></div></th>
                            <th class="rbt-col-footer rbt-grp-ovl"><div class="rbt-th-wrap"><span>覆层结尾</span><button class="rbt-th-paste" data-paste-col="overlay_footer" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="overlay_footer" title="清空该列">清</button></div></th>
                            <th class="rbt-col-scroll-title rbt-grp-ovl"><div class="rbt-th-wrap"><span>滚动标题</span><button class="rbt-th-paste" data-paste-col="scroll_title" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="scroll_title" title="清空该列">清</button></div></th>
                            <th class="rbt-col-scroll-body rbt-grp-ovl"><div class="rbt-th-wrap"><span>滚动内容</span><button class="rbt-th-paste" data-paste-col="scroll_body" title="从剪贴板粘贴到该列">📋</button><button class="rbt-th-clear" data-clear-col="scroll_body" title="清空该列">清</button></div></th>
                        </tr>
                    </thead>
                    <tbody id="rbt-tbody">
                        ${tasks.map((t, i) => _renderBatchRow(t, i, subtitlePresets, cardTemplates)).join('')}
                    </tbody>
                </table>
            </div>
            <div class="rbt-footer">
                <span id="rbt-count">${tasks.length} 个任务</span>
                <span id="rbt-align-progress" style="font-size:12px;color:#a0d0ff;margin-left:12px;"></span>
                <div class="rbt-footer-hint">提示: 先粘贴文案创建行 → 再批量添加素材自动按顺序分配 | 设置素材文件夹后可一键刷新同步最新文件</div>
                <button class="rbt-btn rbt-btn-primary" id="rbt-apply-btn">✅ 应用更改并关闭</button>
            </div>

            </div><!-- /rbt-main-col -->
            </div><!-- /rbt-body-row -->
        </div>
            <div id="rbt-hook-modal" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99999;align-items:center;justify-content:center;">
                <div style="background:#181818;padding:20px;border-radius:8px;border:1px solid #333;width:400px;display:flex;flex-direction:column;gap:12px;">
                    <h3 style="margin:0;color:#fff;font-size:14px;display:flex;align-items:center;gap:6px;">🪝 前置/Hook 设置</h3>
                    
                    <div style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:8px;">
                        <span>Hook:</span>
                        <input type="text" id="rbt-hook-path" style="flex:1;background:#222;color:#ccc;border:1px solid #333;padding:4px;font-size:11px;" readonly placeholder="未选择 (留空则从正片开始)">
                        <button class="rbt-btn" id="rbt-hook-select-btn" style="padding:4px 8px;">浏览素材</button>
                        <input type="file" id="rbt-hook-file-input" style="display:none;" accept=".mp4,.mov,.mkv,.webm,.avi,.jpg,.jpeg,.png,.webp">
                    </div>

                    <div id="rbt-hook-preview-container" style="display:none;width:100%;height:160px;background:#000;border-radius:4px;overflow:hidden;position:relative;border:1px solid #333;">
                        <video id="rbt-hook-preview-video" style="width:100%;height:100%;object-fit:contain;" controls preload="metadata"></video>
                        <img id="rbt-hook-preview-img" style="width:100%;height:100%;object-fit:contain;display:none;">
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <span style="font-size:11px;color:#888;">裁切区间 (秒，留空表示使用原文件长度)</span>
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <button class="rbt-btn" id="rbt-hook-mark-start" style="padding:3px 8px;font-size:11px;" title="将当前视频播放位置设为起始点">⏩ 设为起点</button>
                            <input type="number" id="rbt-hook-start" style="width:60px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;" placeholder="Start" step="0.1" min="0">
                            <span style="color:#666;">至</span>
                            <input type="number" id="rbt-hook-end" style="width:60px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;" placeholder="End" step="0.1" min="0">
                            <button class="rbt-btn" id="rbt-hook-mark-end" style="padding:3px 8px;font-size:11px;" title="将当前视频播放位置设为结束点">⏪ 设为终点</button>
                            <span style="flex:1;"></span>
                            <span style="font-size:11px;color:#888;">播放变速:</span>
                            <input type="number" id="rbt-hook-speed" list="rbt-hook-speed-presets" value="1" step="0.05" min="0.1" max="10" style="background:#111;color:#fff;border:1px solid #333;padding:4px;width:70px;text-align:center;">
                            <datalist id="rbt-hook-speed-presets">
                                <option value="0.25">0.25x</option>
                                <option value="0.5">0.5x</option>
                                <option value="0.75">0.75x</option>
                                <option value="1">1.0x</option>
                                <option value="1.25">1.25x</option>
                                <option value="1.5">1.5x</option>
                                <option value="2">2.0x</option>
                                <option value="3">3.0x</option>
                            </datalist>
                        </div>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <span style="font-size:11px;color:#888;">正片转场 (Transition)</span>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <select id="rbt-hook-transition" style="flex:1;background:#111;color:#fff;border:1px solid #333;padding:4px;font-size:11px;">
                                <option value="none" selected>⚡ 无转场 (直接硬切)</option>
                                <option value="fade">⚫ Fade 黑场淡入淡出</option>
                                <option value="fadeblack">⚫ FadeBlack 强黑场过渡</option>
                                <option value="fadewhite">⚪ FadeWhite 强白场过渡</option>
                                <option value="dissolve">✨ Dissolve 溶解叠化</option>
                                <option value="wipeleft">⬅️ Wipe Left 向左擦除</option>
                                <option value="wiperight">➡️ Wipe Right 向右擦除</option>
                                <option value="slideleft">🔙 Slide Left 向左推移</option>
                                <option value="slideright">🔜 Slide Right 向右推移</option>
                                <option value="rectcrop">🔲 RectCrop 矩形扩散</option>
                                <option value="circlecrop">⭕ CircleCrop 圆形扩散</option>
                            </select>
                            <span style="font-size:11px;color:#888;">时长(s):</span>
                            <input type="number" id="rbt-hook-trans-dur" value="0.5" step="0.1" min="0.1" max="5.0" style="width:50px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;">
                        </div>
                    </div>
                    
                    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
                        <button class="rbt-btn" id="rbt-hook-cancel" style="padding:6px 16px;">取消</button>
                        <button class="rbt-btn rbt-btn-primary" id="rbt-hook-save" style="padding:6px 16px;">保存配置</button>
                    </div>
                </div>
            </div>

            <!-- Cover Modal -->
            <div id="rbt-cover-modal" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:99999;align-items:center;justify-content:center;">
                <div style="background:#181818;padding:20px;border-radius:8px;border:1px solid #333;width:420px;display:flex;flex-direction:column;gap:12px;">
                    <h3 style="margin:0;color:#fff;font-size:14px;display:flex;align-items:center;justify-content:space-between;">
                        <span>🌟 视频封面设置</span>
                        <div style="display:flex;gap:4px;font-weight:normal;">
                            <select id="rbt-cover-preset-sel" style="width:110px;background:#222;color:#ccc;border:1px solid #444;font-size:11px;padding:2px;border-radius:4px;">
                                <option value="">---预设---</option>
                            </select>
                            <button id="rbt-cover-preset-save" class="rbt-btn" style="padding:2px 6px;font-size:11px;" title="保存当前所有设置到预设库">💾 保存</button>
                            <button id="rbt-cover-preset-del" class="rbt-btn" style="padding:2px 6px;font-size:11px;color:#f66;" title="删除选项">❌</button>
                        </div>
                    </h3>
                    
                    <div style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="rbt-cover-enabled" style="margin:0;transform:scale(1.2);">
                        <label for="rbt-cover-enabled" style="font-weight:bold;color:#ffd700;cursor:pointer;">启用封面</label>
                        <span style="flex:1;"></span>
                        <input type="checkbox" id="rbt-cover-export-separate" style="margin:0;">
                        <label for="rbt-cover-export-separate" style="color:#aaa;cursor:pointer;">同时单独导出(PNG)</label>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <div style="font-size:11px;color:#888;">封面背景图 (留空则使用背景视频第一帧)</div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <input type="text" id="rbt-cover-bg-path" style="flex:1;background:#111;color:#ccc;border:1px solid #333;padding:4px;font-size:11px;" readonly placeholder="未选择 (使用背景首帧)">
                            <button class="rbt-btn" id="rbt-cover-bg-btn" style="padding:4px 8px;">浏览素材</button>
                            <input type="file" id="rbt-cover-file-input" style="display:none;" accept=".jpg,.jpeg,.png,.webp,.bmp">
                        </div>
                        <div id="rbt-cover-preview-container" style="display:none;width:100%;height:140px;background:#000;border-radius:4px;overflow:hidden;position:relative;border:1px solid #333;align-items:center;justify-content:center;">
                            <img id="rbt-cover-preview-img" style="max-width:100%;max-height:100%;object-fit:contain;display:none;">
                            <span id="rbt-cover-preview-hint" style="color:#666;font-size:12px;">自动提取视频第1帧</span>
                        </div>
                    </div>

                    <div style="background:#222;padding:10px;border-radius:4px;display:flex;flex-direction:column;gap:8px;border:1px solid #333;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="font-size:11px;color:#888;">与正片合并滞留(秒):</span>
                            <input type="number" id="rbt-cover-duration" value="0" step="0.1" min="0" max="10.0" style="width:50px;background:#111;color:#fff;border:1px solid #333;padding:4px;text-align:center;">
                            <span style="font-size:10px;color:#666;">(仅提取图片设为0)</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;margin-top:2px;">
                            <span style="font-size:11px;color:#888;">套用文字卡片模版:</span>
                            <select id="rbt-cover-overlay-sel" style="flex:1;background:#111;color:#ffd700;border:1px solid #544414;padding:4px;font-size:11px;border-radius:4px;outline:none;">
                                <option value="">-- 使用独立卡片配置 --</option>
                            </select>
                        </div>
                        <div style="display:flex;align-items:center;justify-content:center;margin-top:4px;">
                            <button class="rbt-btn" id="rbt-cover-edit-overlay-btn" style="width:100%;padding:6px;background:rgba(255,215,0,0.1);border:1px solid rgba(255,215,0,0.3);color:#ffd700;">✏️ 定制该封面的专属排版</button>
                        </div>
                    </div>
                    
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
                        <button class="rbt-btn" id="rbt-cover-batch-apply" style="padding:6px 12px;background:#321;border:1px solid #643;color:#fc8;">应用到全部行</button>
                        <div style="display:flex;gap:8px;">
                            <button class="rbt-btn" id="rbt-cover-cancel" style="padding:6px 16px;">取消</button>
                            <button class="rbt-btn rbt-btn-primary" id="rbt-cover-save" style="padding:6px 16px;">保存单行配置</button>
                        </div>
                    </div>
                </div>
            </div>

        </div>
    `;

    // CSS
    _injectBatchTableCSS();

    // 事件
    _bindBatchTableEvents();

    // 应用列显示设置
    _applyColVisibility();

    // 更新批量选中计数
    _updateBatchSelectCount();

    // ── 恢复滚动位置 ──
    const newScrollWrap = container.querySelector('.rbt-table-wrap');
    if (newScrollWrap && (_savedScrollTop || _savedScrollLeft)) {
        newScrollWrap.scrollTop = _savedScrollTop;
        newScrollWrap.scrollLeft = _savedScrollLeft;
    }
}

function _applyOverlayField(task, fieldCategory, str) {
    if (!task.overlays) task.overlays = [];
    if (fieldCategory.startsWith('scroll_')) {
        let ov = task.overlays.find(o => o && o.type === 'scroll');
        if (!ov) {
            ov = window.ReelsOverlay ? window.ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }) : { scroll_title:'', content:'', type: 'scroll' };
            ov.scroll_title = '';
            ov.content = '';
            task.overlays.push(ov);
        }
        if (fieldCategory === 'scroll_title') ov.scroll_title = str;
        if (fieldCategory === 'scroll_body') ov.content = str;
    } else if (fieldCategory.startsWith('overlay_')) {
        let ov = task.overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === ''));
        if (!ov) {
            ov = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text:'', body_text:'', footer_text:'', type: 'textcard' };
            ov.title_text = '';
            ov.body_text = '';
            ov.footer_text = '';
            task.overlays.push(ov);
        }
        if (fieldCategory === 'overlay_title') ov.title_text = str;
        if (fieldCategory === 'overlay_body') ov.body_text = str;
        if (fieldCategory === 'overlay_footer') ov.footer_text = str;
    } else if (fieldCategory === 'cover_text') {
        if (!task.cover) task.cover = { enabled: true, overlays: [] };
        let ov = (task.cover.overlays && task.cover.overlays.length > 0) ? task.cover.overlays[0] : null;
        if (!ov) {
            ov = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text:'', body_text:'', footer_text:'', type: 'textcard' };
            task.cover.overlays = [ov];
        }
        ov.title_text = str;
    }
}

function _syncSelectedTaskOverlayMgrIfNeeded(taskIdx) {
    const state = window._reelsState;
    if (!state || state.selectedIdx !== taskIdx) return;
    const task = state.tasks && state.tasks[taskIdx];
    if (!task || !state.overlayProxy || !state.overlayProxy.overlayMgr) return;
    const mgr = state.overlayProxy.overlayMgr;
    mgr.overlays = task.overlays ? [...task.overlays] : [];
    if (state.overlayPanel) {
        state.overlayPanel.deselectOverlay();
        state.overlayPanel._refreshList();
    }
}

function _renderBatchRow(task, idx, subtitlePresets, cardTemplates) {
    // 提取覆层信息
    const ov = (task.overlays || []).find(o => o && (o.type === 'textcard' || !o.type || o.type === ''));
    const title = ov ? (ov.title_text || '') : '';
    const body = ov ? (ov.body_text || '') : '';
    const footer = ov ? (ov.footer_text || '') : '';
    // 滚动字幕覆层信息
    const scrollOv = (task.overlays || []).find(o => o && o.type === 'scroll');
    const scrollTitle = scrollOv ? (scrollOv.scroll_title || '') : '';
    const scrollBody = scrollOv ? (scrollOv.content || '') : '';
    const bgName = _shortName(task.bgPath || task.videoPath || '');
    const audioName = _shortName(task.audioPath || '');
    const srtName = _shortName(task.srtPath || '');
    const txtName = _shortName(task.txtPath || '');
    const txtStatus = task.txtContent ? (task.aligned ? '✅' : '⏳') : '';
    const bgmName = _shortName(task.bgmPath || '');

    // 缩略图生成
    const bgMode = task.bgMode || 'single';
    const bgClipPool = task.bgClipPool || [];
    let bgContent = bgName || '<span class="rbt-placeholder">拖拽/双击</span>';
    const bgPath = task.bgPath || task.videoPath;

    if (bgMode === 'multi' && bgClipPool.length > 0) {
        // 多素材模式 — 显示素材池信息
        const transLabel = {none:'硬切', crossfade:'交叉淡化', fade_black:'黑场过渡', fade_white:'白场过渡', slide_left:'左滑', slide_right:'右滑', wipe:'擦除'}[task.bgTransition || 'crossfade'] || '交叉淡化';
        const thumbs = bgClipPool.slice(0, 3).map(p => {
            const url = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(p) : `file://${p}`;
            const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(p);
            return isImg
                ? `<img class="rbt-thumb-previewable" src="${_escHtml(url)}" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid #333;cursor:zoom-in;">`
                : `<video class="rbt-thumb-previewable" src="${_escHtml(url)}#t=1" preload="metadata" style="width:24px;height:24px;object-fit:cover;border-radius:3px;border:1px solid #333;background:#000;cursor:zoom-in;"></video>`;
        }).join('');
        bgContent = `<div style="display:flex;flex-direction:column;gap:3px;">
            <div style="display:flex;align-items:center;gap:4px;">
                <span style="font-size:9px;background:#2a1f5e;color:#b8a0ff;padding:1px 5px;border-radius:3px;font-weight:600;">多素材</span>
                <span style="font-size:10px;color:#aaa;">${bgClipPool.length}个素材</span>
                <button class="rbt-bg-pool-manage" data-idx="${idx}" style="font-size:9px;background:transparent;border:1px solid #444;color:#8af;border-radius:3px;padding:1px 5px;cursor:pointer;" title="管理素材池">管理</button>
            </div>
            <div style="display:flex;gap:2px;align-items:center;">${thumbs}${bgClipPool.length > 3 ? `<span style="font-size:9px;color:#666;">+${bgClipPool.length - 3}</span>` : ''}</div>
            <div style="font-size:9px;color:#888;">✨${transLabel} ${task.bgTransDur || 0.5}s</div>
        </div>`;
    } else if (bgPath) {
        const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(bgPath);
        const urlObj = task.bgSrcUrl || (window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(bgPath) : `file://${bgPath}`);
        if (isImg) {
            bgContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable" src="${_escHtml(urlObj)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(bgPath)}">${_escHtml(_shortName(bgPath))}</span>
                         </div>`;
        } else {
            bgContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <video class="rbt-thumb-previewable" src="${_escHtml(urlObj)}#t=1" preload="metadata" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;"></video>
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(bgPath)}">${_escHtml(_shortName(bgPath))}</span>
                         </div>`;
        }
    } else {
        bgContent = `<span class="rbt-file-name" title="">${bgContent}</span>`;
    }

    // Hook缩略图生成
    const hookName = _shortName(task.hookFile || '');
    let hookContent = hookName || '<span class="rbt-placeholder">双击添加/设置</span>';
    if (task.hookFile) {
        const hIsImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(task.hookFile);
        const hUrlObj = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(task.hookFile) : `file://${task.hookFile}`;
        hookContent = `<div class="rbt-hook-set" style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="双击重新配置\n${_escHtml(task.hookFile)}">
                            ${hIsImg ? 
                                `<img class="rbt-thumb-previewable" src="${_escHtml(hUrlObj)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;cursor:zoom-in;">` :
                                `<video class="rbt-thumb-previewable" src="${_escHtml(hUrlObj)}#t=0.5" preload="metadata" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;background:#111;cursor:zoom-in;"></video>`
                            }
                            <div style="flex:1;display:flex;flex-direction:column;min-width:0;line-height:1.2;">
                              <span class="rbt-file-name" style="font-size:10px;word-break:break-all;">${_escHtml(hookName)}</span>
                              <span style="font-size:9px;color:#a0d0ff;zoom:0.9;">${task.hookTransition && task.hookTransition !== 'none' ? `✨${task.hookTransition}(${task.hookTransDuration || 0.5}s)` : '⚡硬切'} | ${task.hookSpeed ? task.hookSpeed + 'x' : '1x'} <span style="color:#666;margin-left:2px;">(双击设置)</span></span>
                            </div>
                       </div>`;
    } else {
        hookContent = `<div class="rbt-hook-set" style="cursor:pointer;color:#888;font-size:10px;" title="双击配置Hook属性">➕ 双击设置</div>`;
    }

    // PIP缩略图生成
    const pipPath = task.pipPath || '';
    const pipName = _shortName(pipPath);
    let pipContent = pipName || '<span class="rbt-placeholder">拖拽/双击</span>';
    if (pipPath) {
        const isPipImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(pipPath);
        const pipUrlObj = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(pipPath) : `file://${pipPath}`;
        if (isPipImg) {
            pipContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <img class="rbt-thumb-previewable" src="${_escHtml(pipUrlObj)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(pipPath)}">${_escHtml(pipName)}</span>
                         </div>`;
        } else {
            pipContent = `<div style="display:flex;align-items:center;gap:6px;">
                            <video class="rbt-thumb-previewable" src="${_escHtml(pipUrlObj)}#t=1" preload="metadata" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;"></video>
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(pipPath)}">${_escHtml(pipName)}</span>
                         </div>`;
        }
    } else {
        pipContent = `<span class="rbt-file-name" style="width:100%;" title="">${pipContent}</span>`;
    }

    const subTplOptions = _renderSubtitlePresetOptions(subtitlePresets, task._subtitlePreset || '');
    const cardTplOptions = _renderOverlayPresetOptions(cardTemplates, task._overlayPresetName || '');

    // --- Cover Cover --- 
    const coverEnabled = task.cover && task.cover.enabled;
    const coverBgPath = task.cover && task.cover.bgPath ? task.cover.bgPath : '';
    let coverContent = '';
    if (coverEnabled) {
        if (coverBgPath) {
             const cIsImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(coverBgPath);
             const cUrlObj = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(coverBgPath) : `file://${coverBgPath}`;
             coverContent = `<div class="rbt-cover-set" style="display:flex;align-items:center;gap:4px;cursor:pointer;" title="双击配置封面">
                                 ${cIsImg ? 
                                     `<img class="rbt-thumb-previewable" src="${_escHtml(cUrlObj)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;">` :
                                     `<video class="rbt-thumb-previewable" src="${_escHtml(cUrlObj)}#t=0.5" style="width:28px;height:28px;object-fit:cover;border-radius:3px;flex-shrink:0;background:#111;"></video>`
                                 }
                                 <div style="flex:1;min-width:0;font-size:9px;color:#ffd700;line-height:1.1;">✨封面开启<br>已设底图</div>
                            </div>`;
        } else {
             coverContent = `<div class="rbt-cover-set" style="cursor:pointer;color:#ffd700;font-size:10px;line-height:1.2;" title="双击配置封面"><span style="display:inline-block;background:rgba(255,215,0,0.15);padding:2px 4px;border-radius:2px;border:1px solid rgba(255,215,0,0.3);">✨封面开启<br><span style="font-size:8px;color:#aaa;">(取第1帧)</span></span></div>`;
        }
    } else {
        coverContent = `<div class="rbt-cover-set" style="cursor:pointer;color:#888;font-size:10px;display:flex;align-items:center;" title="双击添加封面"><span class="rbt-file-name" style="width:100%;"><span class="rbt-placeholder">拖拽/双击</span></span></div>`;
    }

    const coverOvl = (task.cover && task.cover.overlays && task.cover.overlays.length > 0) ? task.cover.overlays[0] : null;
    let coverTextStr = '';
    if (coverOvl) {
        coverTextStr = coverOvl.title_text || coverOvl.body_text || '<自定义>';
    }

    return `
        <tr data-idx="${idx}" draggable="true" class="rbt-row ${idx === (window._reelsState?.selectedIdx || -1) ? 'rbt-row-selected' : ''} ${task._justRefreshed ? 'rbt-row-refreshed' : ''}">
            <td class="rbt-col-drag"><span class="rbt-drag-handle" title="拖拽调整顺序">☰</span></td>
            <td class="rbt-col-chk" style="text-align:center;"><input type="checkbox" class="rbt-row-check" data-idx="${idx}" ${_batchTableState.selectedRows.has(idx) ? 'checked' : ''}></td>
            <td class="rbt-col-num">${idx + 1}</td>
            <td class="rbt-col-act">
                <button class="rbt-row-btn rbt-select-btn" data-idx="${idx}" title="预览此任务">👁</button>
                <button class="rbt-row-btn rbt-clone-btn" data-idx="${idx}" title="复制此行">📋</button>
                <button class="rbt-row-btn rbt-delete-btn" data-idx="${idx}" title="删除此行">🗑</button>
            </td>
            <td class="rbt-col-tpl">
                <div class="rbt-sub-tpl-trigger rbt-select" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:0 4px;height:22px;display:flex;align-items:center;justify-content:space-between;user-select:none;" title="点击选择字幕模板（含样式预览）">
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${task._subtitlePreset ? _escHtml(task._subtitlePreset) : '默认'}</span>
                    <span style="font-size:8px;margin-left:2px;flex-shrink:0;">▼</span>
                </div>
            </td>
            <td class="rbt-col-tpl">
                <select class="rbt-select rbt-card-tpl-select" data-idx="${idx}">
                    <option value="">无预设</option>
                    ${cardTplOptions}
                </select>
            </td>
            <td class="rbt-col-dur">
                <input type="number" class="rbt-textarea rbt-dur-input" data-idx="${idx}" min="0" max="600" step="0.5"
                    value="${task.customDuration ? task.customDuration : ''}" placeholder="自动" style="width:55px;text-align:center;" title="留空=自动跟随音频/视频时长，输入数字=自定义秒数">
            </td>
            <td class="rbt-col-exportname">
                <input type="text" class="rbt-textarea rbt-exportname-input" data-idx="${idx}" 
                    value="${_escHtml(task.exportName || '')}" placeholder="自动提取文案前50字" style="width:100px;font-size:11px;" title="留空则默认使用文案的前50个字符作为导出名字">
            </td>
            <td class="rbt-col-cover-media rbt-droppable" data-field="cover_media">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;">${coverContent}</div>
                    ${coverEnabled ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="cover_media" title="关闭封面功能">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-cover-text rbt-droppable" data-field="cover_text">
                <div style="display:flex;align-items:center;gap:2px;">
                    <textarea class="rbt-textarea rbt-cover-text-input" data-idx="${idx}" rows="1" placeholder="暂无" title="封面主标题文案">${_escHtml(coverTextStr)}</textarea>
                </div>
            </td>
            <td class="rbt-col-hook rbt-droppable" data-field="hook">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;">${hookContent}</div>
                    ${task.hookFile ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="hook" title="清除前置Hook">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-bg rbt-droppable" data-field="bg">
                <div style="display:flex;align-items:center;gap:2px;">
                    <button class="rbt-bg-pool-manage" data-idx="${idx}" style="flex:0 0 auto;width:20px;height:20px;border-radius:4px;border:1px solid ${bgMode === 'multi' ? '#7c5cff' : '#333'};background:${bgMode === 'multi' ? '#2a1f5e' : 'transparent'};color:${bgMode === 'multi' ? '#b8a0ff' : '#666'};font-size:11px;cursor:pointer;padding:0;line-height:18px;" title="${bgMode === 'multi' ? '多素材模式 - 点击管理' : '单素材模式 - 点击切换到多素材'}">${bgMode === 'multi' ? '🎞' : '🔁'}</button>
                    <div style="flex:1;min-width:0;overflow:hidden;">${bgContent}</div>
                    ${(bgPath || (bgMode === 'multi' && bgClipPool.length > 0)) ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="bg" title="清除背景">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-bgscale">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.bgScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-bgscale-input" data-idx="${idx}" min="50" max="300" step="5"
                                   value="${task.bgScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-bgscale-slider" data-idx="${idx}" min="50" max="300" value="${task.bgScale || 100}"
                               style="width:60px;height:12px;accent-color:#4fc3f7;" title="背景图片缩放比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgdurscale">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.bgDurScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-bgdurscale-input" data-idx="${idx}" min="10" max="500" step="5"
                                   value="${task.bgDurScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-bgdurscale-slider" data-idx="${idx}" min="10" max="500" value="${task.bgDurScale || 100}"
                               style="width:60px;height:12px;accent-color:#81c784;" title="背景素材时长缩放比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-contentvideo rbt-droppable" data-field="contentvideo">
                ${(() => {
                    const cvPath = task.contentVideoPath || '';
                    const cvName = _shortName(cvPath);
                    let cvContent = cvName || '<span class="rbt-placeholder">拖拽/双击</span>';
                    if (cvPath) {
                        const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(cvPath);
                        const cvUrl = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(cvPath) : `file://${cvPath}`;
                        cvContent = `<div style="display:flex;align-items:center;gap:6px;">
                            ${isImg
                                ? `<img class="rbt-thumb-previewable" src="${_escHtml(cvUrl)}" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;cursor:zoom-in;">`
                                : `<video class="rbt-thumb-previewable" src="${_escHtml(cvUrl)}#t=1" preload="metadata" style="width:32px;height:32px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#000;cursor:zoom-in;"></video>`}
                            <span class="rbt-file-name" style="flex:1;font-size:10px;word-break:break-all;" title="${_escHtml(cvPath)}">${_escHtml(cvName)}</span>
                        </div>`;
                    }
                    return `<div style="display:flex;align-items:center;gap:2px;">
                        <div style="flex:1;min-width:0;overflow:hidden;">${cvContent}</div>
                        ${cvPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="contentvideo" title="清除内容视频">✕</button>` : ''}
                    </div>`;
                })()}
            </td>
            <td class="rbt-col-cvtrim">
                <div class="rbt-cv-trim-cell" data-idx="${idx}" style="cursor:pointer;font-size:10px;padding:2px 4px;border-radius:4px;text-align:center;
                    ${task.contentVideoTrimStart != null || task.contentVideoTrimEnd != null
                        ? 'background:rgba(76,158,255,0.15);color:#4c9eff;border:1px solid rgba(76,158,255,0.3);'
                        : 'color:#666;border:1px dashed #333;'}"
                    title="双击设置裁切区间">
                    ${task.contentVideoTrimStart != null || task.contentVideoTrimEnd != null
                        ? `✂️ ${task.contentVideoTrimStart != null ? Number(task.contentVideoTrimStart).toFixed(1) : '0'}s → ${task.contentVideoTrimEnd != null ? Number(task.contentVideoTrimEnd).toFixed(1) : '尾'}`
                        : '全段'}
                </div>
            </td>
            <td class="rbt-col-cvscale">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.contentVideoScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-cvscale-input" data-idx="${idx}" min="10" max="300" step="5"
                                   value="${task.contentVideoScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-cvscale-slider" data-idx="${idx}" min="10" max="300" value="${task.contentVideoScale || 100}"
                               style="width:60px;height:12px;accent-color:#00bcd4;" title="视频覆层缩放比例 (100%=自动适配宽度)">
                    </div>
                </div>
            </td>
            <td class="rbt-col-cvpos">
                <div style="display:flex;flex-direction:column;gap:2px;font-size:10px;">
                    <div style="display:flex;align-items:center;gap:2px;">
                        <span style="color:#666;min-width:12px;">X:</span>
                        <input type="text" class="rbt-cvpos-x" data-idx="${idx}" value="${task.contentVideoX || 'center'}"
                               style="width:50px;font-size:10px;padding:1px 3px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;text-align:center;"
                               placeholder="center" title="center = 水平居中, 或输入像素值">
                    </div>
                    <div style="display:flex;align-items:center;gap:2px;">
                        <span style="color:#666;min-width:12px;">Y:</span>
                        <input type="text" class="rbt-cvpos-y" data-idx="${idx}" value="${task.contentVideoY || 'center'}"
                               style="width:50px;font-size:10px;padding:1px 3px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;text-align:center;"
                               placeholder="center" title="center = 垂直居中, 或输入像素值">
                    </div>
                </div>
            </td>
            <td class="rbt-col-cvvol">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">🔊 ${task.contentVideoVolume != null ? task.contentVideoVolume : 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-cvvol-input" data-idx="${idx}" min="0" max="200" step="5"
                                   value="${task.contentVideoVolume != null ? task.contentVideoVolume : 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-cvvol-slider" data-idx="${idx}" min="0" max="200" value="${task.contentVideoVolume != null ? task.contentVideoVolume : 100}"
                               style="width:60px;height:12px;accent-color:#00bcd4;" title="内容视频音量 (0=静音, 100=原始, 200=加倍)">
                    </div>
                </div>
            </td>
            <td class="rbt-col-bgm">
                <div style="display:flex;align-items:center;gap:4px;">
                    <input type="checkbox" class="rbt-bgm-check" data-idx="${idx}" title="勾选后可批量设置配乐">
                    <span class="rbt-file-name rbt-bgm-pick" data-idx="${idx}" title="拖拽/双击 | ${_escHtml(task.bgmPath || '')}"
                          style="cursor:pointer;flex:1;">${bgmName || '<span class="rbt-placeholder">拖拽/双击</span>'}</span>
                    ${bgmName ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="bgm" title="清除配乐">✕</button>` : ''}
                </div>
                <div class="rbt-clutter-free-scale" style="height:18px; margin-top:2px;">
                    <div class="rbt-scale-display" style="font-size:10px;">🎵 Vol: ${task.bgmVolume != null ? task.bgmVolume : 30}%</div>
                    <div class="rbt-scale-controls" style="flex-direction:row; inset:0;">
                        <span style="font-size:10px;color:#888;white-space:nowrap;">🔉</span>
                        <input type="range" class="rbt-bgm-vol" data-idx="${idx}" min="0" max="100" value="${task.bgmVolume != null ? task.bgmVolume : 30}"
                               style="flex:1; min-width:0; height:12px; accent-color:#9b59b6;" title="配乐音量">
                        <span class="rbt-bgm-vol-label" style="font-size:10px;color:#888;min-width:28px;text-align:right;">${task.bgmVolume != null ? task.bgmVolume : 30}%</span>
                    </div>
                </div>
            </td>
            <td class="rbt-col-ai_script">
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-ai-script-input" data-idx="${idx}" rows="2" placeholder="粘贴需要被处理的原文案..." title="双击放大编辑">${_escHtml(task.aiScript || '')}</textarea>
                    ${task.aiScript ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="ai_script" title="清除原文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-tts_text">
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-tts-text-input" data-idx="${idx}" rows="2" placeholder="粘贴配音文案..." 
                              style="${task.aiTtsDiffWarning ? 'border:1px solid #ef4444; background:rgba(239, 68, 68, 0.1);' : ''}"
                              title="${task.aiTtsDiffWarning ? '⚠️ 警告：检测到配音文案与原文存在字符差异！请检查是否发生了改词！' : '双击放大编辑'}">${_escHtml(task.ttsText || '')}</textarea>
                    ${task.ttsText ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="tts_text" title="清除文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
                <div style="display:flex;align-items:center;min-height:14px;margin-top:2px;">
                    ${task.aiTtsDiffWarning ? `<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="tts" data-idx="${idx}" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>` : ''}
                </div>
            </td>
            <td class="rbt-col-tts_voice">
                <div style="display:flex;flex-direction:column;gap:4px;">
                    <input type="text" class="rbt-input rbt-tts-voice-input" data-idx="${idx}" value="${_escHtml(task.ttsVoiceId || '')}" placeholder="Voice ID" style="width:80px;font-size:10px;padding:2px;border:1px solid #333;background:#111;color:#fff;">
                    <button class="rbt-btn rbt-tts-gen-btn" data-idx="${idx}" style="font-size:10px;padding:2px;background:#5e5ce6;color:#fff;border:none;">▶ 生成配音</button>
                    ${task.status === 'generating' ? '<span style="font-size:10px;color:#ffd43b;">Generating...</span>' : task.status === 'success' ? '<span style="font-size:10px;color:#4ade80;font-weight:bold;">✅ 最新生成完成</span>' : task.status === 'error' ? '<span style="font-size:10px;color:#ff3333;">❌ 出错</span>' : ''}
                </div>
            </td>
            <td class="rbt-col-srt rbt-droppable" data-field="srt">
                <div style="display:flex;align-items:center;gap:2px;">
                    <span class="rbt-file-name" style="flex:1" title="拖拽/双击 | ${_escHtml(task.srtPath || '')}">${srtName || '<span class="rbt-placeholder">拖拽/双击</span>'}</span>
                    ${srtName ? `<button class="rbt-srt-edit-btn" data-idx="${idx}" title="编辑这套外部SRT文件内容" style="padding:0 4px;font-size:10px;background:#384050;border:1px solid #556;color:#ccc;cursor:pointer;border-radius:3px;">✎ 直接修改</button><button class="rbt-field-clear" data-idx="${idx}" data-field="srt" title="清除字幕">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-txtcontent">
                <div style="position:relative;">
                    <textarea class="rbt-textarea rbt-txtcontent-input" data-idx="${idx}" rows="2" 
                              ${task.srtPath ? 'disabled placeholder="[已使用外部SRT]"' : 'placeholder="粘贴或输入文案..."'} 
                              style="${task.srtPath ? 'opacity:0.3;cursor:not-allowed;' : ''} ${task.aiTextDiffWarning ? 'border:1px solid #ef4444; background:rgba(239, 68, 68, 0.1);' : ''}"
                              title="${task.aiTextDiffWarning ? '⚠️ 警告：AI断行产生的文本与【🧠 AI 原文案】存在字符差异。可能发生了改词或删词，请仔细检查比对！\n\n如有错误请直接修改。' : (task.srtPath ? '外部SRT优先级更高，文案处于禁用状态' : '双击放大编辑')}">${_escHtml(task.txtContent || '')}</textarea>
                    ${task.txtContent && !task.srtPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="txt" title="清除文案" style="position:absolute;top:2px;right:2px;">✕</button>` : ''}
                </div>
                <div style="display:flex;align-items:center;gap:4px;margin-top:2px;min-height:14px;">
                    <span style="font-size:10px;color:${task.aligned ? '#4ade80' : task.txtContent && !task.srtPath ? '#facc15' : '#666'};">${task.aligned ? '✅ 已对齐' : task.txtContent && !task.srtPath ? '⏳ 待对齐' : ''}</span>
                    ${task.aiTextDiffWarning ? `<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="txt" data-idx="${idx}" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>` : ''}
                </div>
            </td>
            <td class="rbt-col-audio rbt-droppable" data-field="audio">
                <div style="display:flex;align-items:center;gap:2px;">
                    ${audioName ? `<button class="rbt-table-play-btn" data-src="${_escHtml(task.audioPath)}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:0 4px;" title="点击试听">▶️</button>` : ''}
                    <span class="rbt-file-name" style="flex:1" title="拖拽/双击 | ${_escHtml(task.audioPath || '')}">${audioName || '<span class="rbt-placeholder">拖拽/双击</span>'}</span>
                    ${audioName ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="audio" title="清除人声">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-audiodurscale">
                <div class="rbt-clutter-free-scale">
                    <div class="rbt-scale-display">${task.audioDurScale || 100}%</div>
                    <div class="rbt-scale-controls">
                        <div style="display:flex;align-items:center;gap:2px;">
                            <input type="number" class="rbt-audiodurscale-input" data-idx="${idx}" min="10" max="500" step="5"
                                   value="${task.audioDurScale || 100}" style="width:42px;text-align:center;font-size:10px;padding:1px 2px;background:#181818;color:#ccc;border:1px solid #333;border-radius:3px;">
                            <span style="font-size:10px;color:#666;">%</span>
                        </div>
                        <input type="range" class="rbt-audiodurscale-slider" data-idx="${idx}" min="10" max="500" value="${task.audioDurScale || 100}"
                               style="width:60px;height:12px;accent-color:#ffb74d;" title="人声变速比例">
                    </div>
                </div>
            </td>
            <td class="rbt-col-pip rbt-droppable" data-field="pip">
                <div style="display:flex;align-items:center;gap:2px;">
                    <div style="flex:1;min-width:0;overflow:hidden;display:flex;">${pipContent}</div>
                    ${task.pipPath ? `<button class="rbt-field-clear" data-idx="${idx}" data-field="pip" title="清除图像覆层">✕</button>` : ''}
                </div>
            </td>
            <td class="rbt-col-title">
                <textarea class="rbt-textarea rbt-title-input" data-idx="${idx}" rows="2" title="双击放大编辑" style="${title === '标题文字' ? 'color:#ff5555;' : ''}">${_escHtml(title)}</textarea>
            </td>
            <td class="rbt-col-body">
                <textarea class="rbt-textarea rbt-body-input" data-idx="${idx}" rows="2" title="双击放大编辑" style="${body === '内容文字' ? 'color:#ff5555;' : ''}">${_escHtml(body)}</textarea>
            </td>
            <td class="rbt-col-footer">
                <textarea class="rbt-textarea rbt-footer-input" data-idx="${idx}" rows="2" title="双击放大编辑">${_escHtml(footer)}</textarea>
            </td>
            <td class="rbt-col-scroll-title">
                <textarea class="rbt-textarea rbt-scroll-title-input" data-idx="${idx}" rows="2" title="双击放大编辑">${_escHtml(scrollTitle)}</textarea>
            </td>
            <td class="rbt-col-scroll-body">
                <textarea class="rbt-textarea rbt-scroll-body-input" data-idx="${idx}" rows="2" title="双击放大编辑">${_escHtml(scrollBody)}</textarea>
            </td>
        </tr>
    `;
}


// ═══════════════════════════════════════════════════════
// 5. Event Binding
// ═══════════════════════════════════════════════════════

function _bindBatchTableEvents() {
    const container = _batchTableState.container;

    // Toggle actions panel
    const toggleActionsBtn = container.querySelector('#rbt-toggle-actions-btn');
    if (toggleActionsBtn) {
        toggleActionsBtn.addEventListener('click', () => {
            _batchTableState.actionsCollapsed = !_batchTableState.actionsCollapsed;
            _renderBatchTable();
        });
    }

    // Toggle modern UI mode
    const toggleUIModeBtn = container.querySelector('#rbt-toggle-ui-mode-btn');
    if (toggleUIModeBtn) {
        toggleUIModeBtn.addEventListener('click', () => {
            // _batchTableState.useModernUI = !_batchTableState.useModernUI; 废弃
            _renderBatchTable();
        });
    }

    // Toggle "更多操作" dropdown
    container.querySelector('#rbt-more-tools-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dd = container.querySelector('#rbt-more-tools-dropdown');
        if (dd) dd.classList.toggle('show');
    });

    // Close
    container.querySelector('#rbt-close-btn')?.addEventListener('click', () => reelsToggleBatchTable());
    container.querySelector('#rbt-apply-btn')?.addEventListener('click', () => {
        _applyBatchTableChanges();
        reelsToggleBatchTable();
    });

    // ── Language searchable picker ──
    _initLangPicker(container);


    // ══ Tab bar events ══
    const tabBar = container.querySelector('.rbt-tabs-scroll');
    if (tabBar) {
        tabBar.addEventListener('click', (e) => {
            // Add new tab
            if (e.target.closest('.rbt-tab-add')) {
                _addTab();
                return;
            }
            // Close tab
            const closeEl = e.target.closest('.rbt-tab-close');
            if (closeEl) {
                e.stopPropagation();
                _removeTab(closeEl.dataset.tabId);
                return;
            }
            // Switch tab
            const tabEl = e.target.closest('.rbt-tab');
            if (tabEl && tabEl.dataset.tabId) {
                _switchToTab(tabEl.dataset.tabId);
            }
        });
        tabBar.addEventListener('dblclick', (e) => {
            const tabEl = e.target.closest('.rbt-tab');
            if (tabEl && tabEl.dataset.tabId && !tabEl.classList.contains('rbt-tab-add')) {
                _renameTab(tabEl.dataset.tabId);
            }
        });
    }
    
    // ══ Global Hover Preview ══
    let hoverTooltip = container.querySelector('#rbt-hover-preview-tooltip');
    if (!hoverTooltip) {
        hoverTooltip = document.createElement('div');
        hoverTooltip.id = 'rbt-hover-preview-tooltip';
        hoverTooltip.style.cssText = 'position:fixed; z-index:999999; display:none; background:#000; border:1px solid #48548a; border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,0.8); overflow:hidden; pointer-events:none;';
        document.body.appendChild(hoverTooltip); // attach to body to prevent clipping
    }
    
    let previewTimeout;
    container.addEventListener('mouseover', (e) => {
        const target = e.target;
        if (target.classList.contains('rbt-thumb-previewable')) {
            clearTimeout(previewTimeout);
            previewTimeout = setTimeout(() => {
                const src = target.getAttribute('src');
                if (!src) return;
                
                const isVideo = target.tagName === 'VIDEO';
                const pureSrc = src.split('#')[0]; // strip hash
                
                const rect = target.getBoundingClientRect();
                
                if (isVideo) {
                    hoverTooltip.innerHTML = `<video src="${_escHtml(pureSrc)}" autoplay loop muted style="max-width:360px; max-height:360px; display:block; object-fit:contain; background:#000;"></video>`;
                } else {
                    hoverTooltip.innerHTML = `<img src="${_escHtml(pureSrc)}" style="max-width:360px; max-height:360px; display:block; object-fit:contain; background:#111;">`;
                }
                
                hoverTooltip.style.display = 'block';
                
                let top = rect.top - 10;
                let left = rect.right + 15;
                
                // Keep tooltip on screen
                if (top + 360 > window.innerHeight) {
                    top = window.innerHeight - 380;
                }
                if (left + 360 > window.innerWidth) {
                    left = rect.left - 380; 
                }
                
                hoverTooltip.style.top = `${Math.max(10, top)}px`;
                hoverTooltip.style.left = `${Math.max(10, left)}px`;
                
                if (isVideo) {
                    const v = hoverTooltip.querySelector('video');
                    if (v) {
                        v.playbackRate = 1.5;
                        v.play().catch(()=>{});
                    }
                }
            }, 300);
        }
    });

    container.addEventListener('mouseout', (e) => {
        const target = e.target;
        if (target.classList.contains('rbt-thumb-previewable')) {
            clearTimeout(previewTimeout);
            hoverTooltip.style.display = 'none';
            hoverTooltip.innerHTML = '';
        }
    });

    // ══ Material folder selection & refresh (now in sidebar) ══
    container.querySelector('#rbt-select-mat-dir')?.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                const tab = _getActiveTab();
                tab.materialDir = dir;
                _renderBatchTable();
            }
        } else {
            alert('请在桌面应用中使用此功能');
        }
    });
    container.querySelector('#rbt-refresh-mat')?.addEventListener('click', () => {
        _refreshMaterialFolder();
    });
    // Sidebar versions of the same (rbt-ms-select-dir / rbt-ms-refresh-dir)
    container.querySelector('#rbt-ms-select-dir')?.addEventListener('click', async () => {
        if (window.electronAPI && window.electronAPI.selectDirectory) {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                const tab = _getActiveTab();
                tab.materialDir = dir;
                _renderBatchTable();
            }
        } else {
            alert('请在桌面应用中使用此功能');
        }
    });
    container.querySelector('#rbt-ms-refresh-dir')?.addEventListener('click', () => {
        _refreshMaterialFolder();
    });

    // ══ Hook Batch settings ══
    container.querySelector('#rbt-upload-hook')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) {
            alert('请先在左侧勾选需要批量配置前置Hook的行');
            return;
        }
        _openHookModal(-1);
    });

    const hookModal = container.querySelector('#rbt-hook-modal');
    if (hookModal) {
        container.querySelector('#rbt-hook-select-btn')?.addEventListener('click', () => {
            container.querySelector('#rbt-hook-file-input')?.click();
        });
        
        container.querySelector('#rbt-hook-file-input')?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
            container.querySelector('#rbt-hook-path').value = filePath;
            _updateHookPreview();
            e.target.value = '';
        });
        
        container.querySelector('#rbt-hook-start')?.addEventListener('input', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const startInput = container.querySelector('#rbt-hook-start');
            if (videoPreview && startInput && videoPreview.readyState >= 1) {
                const startTime = parseFloat(startInput.value) || 0;
                videoPreview.currentTime = startTime;
            }
        });

        container.querySelector('#rbt-hook-mark-start')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const startInput = container.querySelector('#rbt-hook-start');
            if (videoPreview && startInput && videoPreview.readyState >= 1) {
                startInput.value = Math.round(videoPreview.currentTime * 10) / 10;
            }
        });

        container.querySelector('#rbt-hook-mark-end')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            const endInput = container.querySelector('#rbt-hook-end');
            if (videoPreview && endInput && videoPreview.readyState >= 1) {
                endInput.value = Math.round(videoPreview.currentTime * 10) / 10;
            }
        });

        container.querySelector('#rbt-hook-cancel')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            if (videoPreview) {
                videoPreview.pause();
                videoPreview.removeAttribute('src');
                videoPreview.load();
            }
            hookModal.style.display = 'none';
        });
        container.querySelector('#rbt-hook-save')?.addEventListener('click', () => {
            const videoPreview = container.querySelector('#rbt-hook-preview-video');
            if (videoPreview) {
                videoPreview.pause();
                videoPreview.removeAttribute('src');
                videoPreview.load();
            }
            const idxStr = hookModal.dataset.editIdx;
            if (!idxStr) return;
            const idx = parseInt(idxStr);
            const hookFile = container.querySelector('#rbt-hook-path').value.trim();
            const startVal = container.querySelector('#rbt-hook-start').value;
            const endVal = container.querySelector('#rbt-hook-end').value;
            const hookSpeed = parseFloat(container.querySelector('#rbt-hook-speed').value) || 1;
            const hookTrans = container.querySelector('#rbt-hook-transition').value || 'none';
            const hookTransDur = parseFloat(container.querySelector('#rbt-hook-trans-dur').value) || 0.5;
            const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
            const selectedIndices = _getSelectedIndices();
            const shouldRefreshPreview = (
                typeof reelsSelectTask === 'function' &&
                selectedIdx >= 0 &&
                (idx === selectedIdx || (idx < 0 && selectedIndices.includes(selectedIdx)))
            );

            const applyToTask = (task) => {
                task.hookFile = hookFile;
                task.hookTrimStart = startVal !== '' ? parseFloat(startVal) : null;
                task.hookTrimEnd = endVal !== '' ? parseFloat(endVal) : null;
                task.hookSpeed = hookSpeed;
                task.hookTransition = hookTrans;
                task.hookTransDuration = hookTransDur;
                if (!task.hook) task.hook = {};
                task.hook.enabled = !!hookFile;
                task.hook.path = hookFile || '';
            };

            if (idx >= 0) {
                applyToTask(window._reelsState.tasks[idx]);
            } else {
                selectedIndices.forEach(i => {
                    const task = window._reelsState.tasks[i];
                    if (task) applyToTask(task);
                });
            }
            hookModal.style.display = 'none';
            _renderBatchTable();
            if (shouldRefreshPreview) {
                reelsSelectTask(selectedIdx);
            }
        });
    }

    // ══ Cover modal events ══
    const coverModal = container.querySelector('#rbt-cover-modal');
    if (coverModal) {
        // 关闭及空白区域点击
        coverModal.addEventListener('click', (e) => {
            if (e.target === coverModal) {
                coverModal.style.display = 'none';
            }
        });
        container.querySelector('#rbt-cover-cancel')?.addEventListener('click', () => {
            coverModal.style.display = 'none';
        });

        // 取背景图按钮
        container.querySelector('#rbt-cover-bg-btn')?.addEventListener('click', () => {
             container.querySelector('#rbt-cover-file-input')?.click();
        });
        container.querySelector('#rbt-cover-file-input')?.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                let filePath = '';
                if (window.electronAPI && window.electronAPI.getFilePath) {
                    filePath = window.electronAPI.getFilePath(e.target.files[0]) || e.target.files[0].path;
                } else {
                    filePath = e.target.files[0].path;
                }
                container.querySelector('#rbt-cover-bg-path').value = filePath;
                
                // 更新预览
                const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filePath);
                const url = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(filePath) : `file://${filePath}`;
                const previewImg = container.querySelector('#rbt-cover-preview-img');
                const hint = container.querySelector('#rbt-cover-preview-hint');
                previewImg.style.display = 'block';
                hint.style.display = 'none';
                previewImg.src = url;
            }
        });

        // 保存配置
        container.querySelector('#rbt-cover-save')?.addEventListener('click', () => {
            const idxStr = coverModal.dataset.editIdx;
            if (!idxStr) return;
            const idx = parseInt(idxStr);
            const coverEnabled = container.querySelector('#rbt-cover-enabled').checked;
            const separateExport = container.querySelector('#rbt-cover-export-separate').checked;
            const coverBgPath = container.querySelector('#rbt-cover-bg-path').value.trim();
            const coverDuration = parseFloat(container.querySelector('#rbt-cover-duration').value) || 0;
            const selectedIdx = window._reelsState ? window._reelsState.selectedIdx : -1;
            const selectedIndices = _getSelectedIndices();
            const shouldRefreshPreview = (
                typeof reelsSelectTask === 'function' &&
                selectedIdx >= 0 &&
                (idx === selectedIdx || (idx < 0 && selectedIndices.includes(selectedIdx)))
            );

            const applyToTask = (task) => {
                if (!task.cover) task.cover = {};
                task.cover.enabled = coverEnabled;
                task.cover.exportSeparate = separateExport;
                task.cover.bgPath = coverBgPath;
                task.cover.duration = coverDuration;
                if (!task.cover.overlays) task.cover.overlays = [];
                
                const selOvlTpl = container.querySelector('#rbt-cover-overlay-sel')?.value || '';
                if (selOvlTpl && window.ReelsOverlay) {
                    let presets = {};
                    try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
                    const presetData = presets[selOvlTpl];
                    if (presetData && Array.isArray(presetData)) {
                        const newOvls = presetData.map(o => JSON.parse(JSON.stringify(o)));
                        const oldTextOvl = task.cover.overlays.find(o => o.type === 'textcard' || o.type === 'scroll') || {title_text: task.title || ''};
                        const title = oldTextOvl.title_text || '';
                        for (const ov of newOvls) {
                            if (ov.type === 'textcard') { ov.title_text = title; } 
                            else if (ov.type === 'scroll') { ov.content = title; }
                        }
                        task.cover.overlays = newOvls;
                    }
                }
                task.cover.overlayTpl = selOvlTpl;
            };

            if (idx >= 0) {
                applyToTask(window._reelsState.tasks[idx]);
            } else {
                selectedIndices.forEach(i => {
                    const task = window._reelsState.tasks[i];
                    if (task) applyToTask(task);
                });
            }
            coverModal.style.display = 'none';
            _renderBatchTable();
            if (shouldRefreshPreview) {
                reelsSelectTask(selectedIdx);
            }
        });

        // 绑定批量应用按钮
        container.querySelector('#rbt-cover-batch-apply')?.addEventListener('click', () => {
             const idxStr = coverModal.dataset.editIdx;
             if (!idxStr) return;
             // First trigger single save to apply current UI values to the current task
             container.querySelector('#rbt-cover-save').click();
             
             const idx = parseInt(idxStr);
             const sourceTask = window._reelsState.tasks[idx];
             if (!sourceTask || !sourceTask.cover) return;

             for (let i = 0; i < window._reelsState.tasks.length; i++) {
                 if (i === idx) continue;
                 const t = window._reelsState.tasks[i];
                 t.cover = JSON.parse(JSON.stringify(sourceTask.cover));
                 // Inherit local title logic
                 const tTitle = t.title || t.baseName || '';
                 const ovs = t.cover.overlays || [];
                 for (const ov of ovs) {
                     if (ov.type === 'textcard') { ov.title_text = tTitle; } 
                     else if (ov.type === 'scroll') { ov.content = tTitle; }
                 }
             }
             if (typeof showToast === 'function') showToast('已将该封面配置应用到全部行！', 'success');
             _renderBatchTable();
        });

        // Cover Preset Handlers
        const presetSel = container.querySelector('#rbt-cover-preset-sel');
        container.querySelector('#rbt-cover-preset-save')?.addEventListener('click', async () => {
             const pname = await _showInputDialog('保存封面预设', '请输入预设名称 (例如: 蓝底黄字模版)');
             if (!pname) return;
             const newP = {
                  enabled: container.querySelector('#rbt-cover-enabled').checked,
                  exportSeparate: container.querySelector('#rbt-cover-export-separate').checked,
                  bgPath: container.querySelector('#rbt-cover-bg-path').value.trim(),
                  duration: parseFloat(container.querySelector('#rbt-cover-duration').value) || 0,
                  overlayTpl: container.querySelector('#rbt-cover-overlay-sel')?.value || ''
             };
             let pStore = {};
             try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch(e){}
             pStore[pname] = newP;
             localStorage.setItem('videokit_cover_presets', JSON.stringify(pStore));
             if (typeof showToast === 'function') showToast('预设已保存！', 'success');
             if (typeof _openCoverModal === 'function') _openCoverModal(parseInt(coverModal.dataset.editIdx));
             if(presetSel) presetSel.value = pname;
        });

        container.querySelector('#rbt-cover-preset-del')?.addEventListener('click', () => {
             if(!presetSel) return;
             const pname = presetSel.value;
             if (!pname) return alert('请先在下拉框选择一个已有预设名称');
             let pStore = {};
             try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch(e){}
             delete pStore[pname];
             localStorage.setItem('videokit_cover_presets', JSON.stringify(pStore));
             presetSel.value = '';
             if (typeof showToast === 'function') showToast('预设已删除！', 'success');
             if (typeof _openCoverModal === 'function') _openCoverModal(parseInt(coverModal.dataset.editIdx));
        });

        presetSel?.addEventListener('change', () => {
             const pname = presetSel.value;
             if (!pname) return;
             let pStore = {};
             try { pStore = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch(e){}
             const p = pStore[pname];
             if (p) {
                 container.querySelector('#rbt-cover-enabled').checked = p.enabled;
                 container.querySelector('#rbt-cover-export-separate').checked = p.exportSeparate;
                 container.querySelector('#rbt-cover-bg-path').value = p.bgPath || '';
                 container.querySelector('#rbt-cover-duration').value = p.duration || 0;
                 if (container.querySelector('#rbt-cover-overlay-sel')) container.querySelector('#rbt-cover-overlay-sel').value = p.overlayTpl || '';
                 
                 const prevImg = container.querySelector('#rbt-cover-preview-img');
                 const hint = container.querySelector('#rbt-cover-preview-hint');
                 if (p.bgPath && prevImg && hint) {
                     const url = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(p.bgPath) : `file://${p.bgPath}`;
                     prevImg.src = url;
                     prevImg.style.display = 'block';
                     hint.style.display = 'none';
                 } else if (prevImg && hint) {
                     prevImg.style.display = 'none';
                     hint.style.display = 'block';
                 }
             }
        });

        // 绑定编辑覆层卡的拉起
        container.querySelector('#rbt-cover-edit-overlay-btn')?.addEventListener('click', () => {
             const idxStr = coverModal.dataset.editIdx;
             if (!idxStr) return;
             const idx = parseInt(idxStr);
             const task = window._reelsState.tasks[idx];
             if (!task) return;
             
             // 先强制把当前的UI设定落盘保存一下
             container.querySelector('#rbt-cover-save').click();
             
             // 虽然刚才click关掉了modal，但不影响后续开Edit
             if (typeof reelsToggleCoverEditMode === 'function') {
                 reelsToggleCoverEditMode(true);
             }
        });
    }

    // ══ Batch selection events ══
    const handleSelectAll = (e) => {
        const checked = e.target.checked;
        const tasks = window._reelsState.tasks || [];
        _batchTableState.selectedRows = new Set(checked ? tasks.map((_, i) => i) : []);
        container.querySelectorAll('.rbt-row-check').forEach(cb => cb.checked = checked);
        const sa = container.querySelector('#rbt-select-all');
        const ha = container.querySelector('#rbt-header-select-all');
        if (sa && sa !== e.target) sa.checked = checked;
        if (ha && ha !== e.target) ha.checked = checked;
        _updateBatchSelectCount();
    };
    container.querySelector('#rbt-select-all')?.addEventListener('change', handleSelectAll);
    container.querySelector('#rbt-header-select-all')?.addEventListener('change', handleSelectAll);
    container.querySelector('#rbt-invert-select')?.addEventListener('click', () => {
        const tasks = window._reelsState.tasks || [];
        const newSet = new Set();
        for (let i = 0; i < tasks.length; i++) {
            if (!_batchTableState.selectedRows.has(i)) newSet.add(i);
        }
        _batchTableState.selectedRows = newSet;
        container.querySelectorAll('.rbt-row-check').forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            cb.checked = newSet.has(idx);
        });
        _updateBatchSelectCount();
    });
    container.querySelector('#rbt-deselect-all')?.addEventListener('click', () => {
        _batchTableState.selectedRows = new Set();
        container.querySelectorAll('.rbt-row-check').forEach(cb => cb.checked = false);
        const selectAll = container.querySelector('#rbt-select-all');
        if (selectAll) selectAll.checked = false;
        _updateBatchSelectCount();
    });

    // ══ Batch template apply ══
    container.querySelector('#rbt-apply-batch-sub')?.addEventListener('click', () => {
        const val = container.querySelector('#rbt-batch-sub-tpl')?.value;
        if (!val) { alert('请先选择字幕模板'); return; }
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (task) task._subtitlePreset = val;
        }
        _renderBatchTable();
        alert(`✅ 已将字幕模板「${val}」应用到 ${indices.length} 行`);
    });

    // ══ 字幕模板自定义下拉框交互 (使用统一选择器) ══
    const subTplTrigger = container.querySelector('#rbt-sub-tpl-trigger');
    const subTplSelect = container.querySelector('#rbt-batch-sub-tpl');
    const subTplLabel = container.querySelector('#rbt-sub-tpl-label');
    
    if (subTplTrigger) {
        subTplTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            const currentVal = subTplSelect?.value || '';
            _openStyledPresetPicker(subTplTrigger, currentVal, (val) => {
                if (subTplSelect) subTplSelect.value = val;
                if (subTplLabel) {
                    subTplLabel.textContent = val || '字幕模板...';
                    subTplLabel.style.color = val ? '#fff' : '';
                }
            });
        });
    }
    container.querySelector('#rbt-apply-batch-card')?.addEventListener('click', () => {
        const val = container.querySelector('#rbt-batch-card-tpl')?.value;
        if (!val) { alert('请先选择覆层预设'); return; }
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        
        const tasksToApply = indices.map(idx => window._reelsState.tasks[idx]).filter(Boolean);
        
        _promptOverlayPresetOptions(val, tasksToApply, (opts) => {
            const failedRows = [];
            for (const idx of indices) {
                const task = window._reelsState.tasks[idx];
                if (task) {
                    task._overlayPresetName = val;
                    const result = _applyAndVerifyOverlayGroupPresetToTask(task, val, opts);
                    if (!result.ok) failedRows.push(`${idx + 1}行(${result.reason})`);
                }
            }
            _skipNextApply = true;
            _renderBatchTable();
            if (failedRows.length > 0) {
                alert(`⚠️ 覆层预设「${val}」有 ${failedRows.length}/${indices.length} 行未通过校验：\n${failedRows.slice(0, 8).join('\n')}${failedRows.length > 8 ? '\n...' : ''}`);
            } else {
                alert(`✅ 已校验：覆层预设「${val}」已应用到 ${indices.length} 行`);
            }
        });
    });

    // ══ Batch scale apply ══
    container.querySelector('#rbt-apply-batch-scale')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        if (indices.length === 0) { alert('请先勾选需要批量设置的行'); return; }
        const bgScale = parseInt(container.querySelector('#rbt-batch-bgscale')?.value) || 100;
        const bgDurScale = parseInt(container.querySelector('#rbt-batch-bgdurscale')?.value) || 100;
        const audioDurScale = parseInt(container.querySelector('#rbt-batch-audiodurscale')?.value) || 100;
        const parts = [];
        for (const idx of indices) {
            const task = window._reelsState.tasks[idx];
            if (!task) continue;
            task.bgScale = bgScale;
            task.bgDurScale = bgDurScale;
            task.audioDurScale = audioDurScale;
        }
        if (bgScale !== 100) parts.push(`背景缩放${bgScale}%`);
        if (bgDurScale !== 100) parts.push(`背景时长${bgDurScale}%`);
        if (audioDurScale !== 100) parts.push(`音频时长${audioDurScale}%`);
        _renderBatchTable();
        alert(`✅ 已将缩放设置 ${parts.length > 0 ? '(' + parts.join(', ') + ')' : '(100%)'} 应用到 ${indices.length} 行`);
    });
    // Toggle Media Pool Sidebar
    container.querySelector('#rbt-open-media-pool-btn')?.addEventListener('click', () => {
        _batchTableState.mediaPoolOpen = !_batchTableState.mediaPoolOpen;
        _renderBatchTable();
    });
    container.querySelector('#rbt-close-media-sidebar')?.addEventListener('click', () => {
        _batchTableState.mediaPoolOpen = false;
        _renderBatchTable();
    });

    // Collapsible filters toggle
    const _msToggle = container.querySelector('#rbt-ms-toggle-filters');
    const _msBody = container.querySelector('#rbt-ms-filters-body');
    const _msIcon = container.querySelector('#rbt-ms-toggle-icon');
    if (_msToggle && _msBody) {
        // Restore collapsed state
        const _msCollapsed = localStorage.getItem('rbt_ms_filters_collapsed') === '1';
        if (_msCollapsed) {
            _msBody.classList.add('collapsed');
            if (_msIcon) _msIcon.textContent = '▸';
        }
        _msToggle.addEventListener('click', () => {
            const nowCollapsed = !_msBody.classList.contains('collapsed');
            _msBody.classList.toggle('collapsed', nowCollapsed);
            if (_msIcon) _msIcon.textContent = nowCollapsed ? '▸' : '▾';
            localStorage.setItem('rbt_ms_filters_collapsed', nowCollapsed ? '1' : '0');
        });
    }

    // Media sidebar import buttons
    _bindMediaSidebarEvents(container);

    // Add row
    container.querySelector('#rbt-add-row-btn')?.addEventListener('click', () => {
        _batchAddEmptyRow();
        _renderBatchTable();
    });

    // Clear
    container.querySelector('#rbt-clear-btn')?.addEventListener('click', () => {
        if (confirm('确定清空所有任务？')) {
            window._reelsState.tasks = [];
            _renderBatchTable();
        }
    });

    // AI Processing
    // AI Processing
    container.querySelector('#rbt-ai-gemini-btn')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');
        
        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const validIdxs = targetIdxs.filter(i => tasks[i].aiScript && tasks[i].aiScript.trim().length > 0);
        
        let msg = `即将开始【批量 AI 处理文案】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 有效数据：检测到 ${validIdxs.length} 行「🧠 AI 原文案」列有内容将被处理\n`;
        if (validIdxs.length > 0) msg += `· 对应行号：[ ${validIdxs.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有任何行填写了「🧠 AI 原文案」，执行将失败！\n\n`;
        msg += `【处理规则】\n1. 读取有效行的「🧠 AI 原文案」。\n2. 使用选择的「Prompt指令预设」调用模型。\n3. 结果自动填入「🤖 TTS文案」列。\n\n是否确认开始执行此操作？`;
        
        if (!confirm(msg)) return;
        _ensureAIColumnsVisible();
        _runGeminiBatchProcessing();
    });
    
    container.querySelector('#rbt-ai-tts-all-btn')?.addEventListener('click', () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');
        
        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const validIdxs = targetIdxs.filter(i => tasks[i].ttsText && tasks[i].ttsText.trim().length > 0);
        
        let msg = `即将开始【分步配音字幕】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 有效数据：检测到 ${validIdxs.length} 行「🤖 TTS文案」将生成配音\n`;
        if (validIdxs.length > 0) msg += `· 对应行号：[ ${validIdxs.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有任何行填写了「🤖 TTS文案」，执行将失败！\n\n`;
        msg += `【处理规则】\n1. 读取有效行的「🤖 TTS文案」。\n2. 依据当前配置的「发音人」合成音频。\n3. 生成完毕后本地持久化保存至该任务。\n\n是否确认开始执行？`;
        
        if (!confirm(msg)) return;
        _ensureAIColumnsVisible();
        _runTTSBatchProcessing();
    });

    // 绑定新的融合执行大按钮
    container.querySelector('#rbt-unified-execute-btn')?.addEventListener('click', () => {
        const modeBtnId = container.querySelector('#rbt-unified-execute-mode').value;
        const targetBtn = container.querySelector('#' + modeBtnId);
        if (targetBtn) {
            targetBtn.click(); // 通过隐藏按钮触发原生绑定事件
        }
    });
    container.querySelector('#rbt-ai-auto-all-btn')?.addEventListener('click', async () => {
        const indices = _getSelectedIndices();
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) return alert('❌ 当前表格为空，无法执行！');
        
        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
        const aiValid = targetIdxs.filter(i => tasks[i].aiScript && tasks[i].aiScript.trim().length > 0);
        const hasTxtContent = targetIdxs.some(i => tasks[i].txtContent && tasks[i].txtContent.trim().length > 0);
        
        let msg = `即将开始【🚀 自动全家桶 (AI改写 + 配音 + 字幕对齐)】操作：\n\n`;
        msg += `【预期处理数据清单】\n`;
        msg += `· 目标范围：${indices.length > 0 ? `已选中的 ${indices.length} 行` : `全部 ${tasks.length} 行`}\n`;
        msg += `· 发动机一：检测到 ${aiValid.length} 行「🧠 AI 原文案」作为源头数据将被 AI 改写\n`;
        if (aiValid.length > 0) msg += `· 对应行号：[ ${aiValid.map(i => i + 1).join(', ')} ]\n\n`;
        else msg += `\n⚠️ 警告：当前目标中没有填写「🧠 AI 原文案」，第一阶段将失败！\n\n`;
        msg += `【三步流水线】\n`;
        msg += `① 读取「🧠 AI 原文案」→ Gemini 改写 → 填入「🤖 TTS文案」+ 「人声字幕」\n`;
        msg += `② 读取「🤖 TTS文案」→ ElevenLabs 合成配音\n`;
        msg += `③ 配音 + 「人声字幕」→ Gladia 转录对齐 → 生成 SRT 时间轴\n\n`;
        if (!hasTxtContent) msg += `💡 提示：「人声字幕」列暂无内容，第③步将跳过（可先在AI Prompt中配置断句输出）\n\n`;
        msg += `是否确认开启一条龙处理流程？`;
        
        if (!confirm(msg)) return;
        
        _ensureAIColumnsVisible();
        // Step 1: Run Gemini AI Script processing
        showToast('🚀 全家桶 Step 1/3：AI 文案处理中...', 'info');
        const aiSuccess = await _runGeminiBatchProcessing();
        if (!aiSuccess) return; // Halt if AI step was aborted or failed
        
        // Wait briefly for UI to render
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Step 2: Run TTS Generation
        showToast('🚀 全家桶 Step 2/3：TTS 配音生成中...', 'info');
        await _runTTSBatchProcessing();
        
        // Wait briefly for TTS results to settle
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Step 3: Run Subtitle Alignment (only if there are tasks with txtContent + audio)
        const tasksWithTextAndAudio = targetIdxs.filter(idx => {
            const t = tasks[idx];
            return (t.txtContent && t.txtContent.trim()) && t.audioPath;
        });
        if (tasksWithTextAndAudio.length > 0) {
            showToast(`🚀 全家桶 Step 3/3：字幕对齐中 (${tasksWithTextAndAudio.length} 行)...`, 'info');
            await _batchAlignAllTasks(true); // 强制使用专业对齐重新执行
            showToast('🎉 全家桶三步流水线全部完成！', 'success', 5000);
        } else {
            showToast('✅ 全家桶完成（AI + 配音）。无人声字幕，跳过对齐步骤。', 'success', 5000);
        }
    });

    container.querySelector('#rbt-ai-preset-btn')?.addEventListener('click', () => {
        _applyAiPresetBatch();
    });

    // ── AI 设置弹窗 ──
    container.querySelector('#rbt-ai-settings-btn')?.addEventListener('click', () => {
        _openAISettingsModal();
    });

    // ── 导入字幕预设 ──
    container.querySelector('#rbt-import-sub-preset-btn')?.addEventListener('click', () => {
        if (typeof reelsImportPresets === 'function') {
            reelsImportPresets();
        } else {
            alert('字幕预设导入功能未加载');
        }
    });

    // ── 导入覆层预设 ──
    container.querySelector('#rbt-import-card-preset-btn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    // data 应该是 { presetName: { overlays: [...] }, ... } 格式
                    const key = 'reels_overlay_group_presets';
                    let existing = {};
                    try { existing = JSON.parse(localStorage.getItem(key) || '{}'); } catch (ex) {}
                    let added = 0, skipped = 0;
                    for (const [name, val] of Object.entries(data)) {
                        if (existing[name]) { skipped++; continue; }
                        existing[name] = val;
                        added++;
                    }
                    localStorage.setItem(key, JSON.stringify(existing));
                    _renderBatchTable();
                    if (typeof showToast === 'function') showToast(`覆层预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`, 'success');
                    else alert(`覆层预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`);
                } catch (ex) {
                    alert('文件解析失败: ' + ex.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // ── 导入任务组合预设 ──
    container.querySelector('#rbt-import-task-preset-btn')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    const key = 'rbt_task_presets';
                    let existing = {};
                    try { existing = JSON.parse(localStorage.getItem(key) || '{}'); } catch (ex) {}
                    let added = 0, skipped = 0;
                    for (const [name, val] of Object.entries(data)) {
                        if (existing[name]) { skipped++; continue; }
                        existing[name] = val;
                        added++;
                    }
                    localStorage.setItem(key, JSON.stringify(existing));
                    if (typeof showToast === 'function') showToast(`任务预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`, 'success');
                    else alert(`任务预设导入完成：新增 ${added} 个，跳过 ${skipped} 个`);
                } catch (ex) {
                    alert('文件解析失败: ' + ex.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    });

    // ══ TTS Model & Voice controls ══
    // 恢复已保存的模型选择
    const savedModel = localStorage.getItem('rbt_tts_model') || 'eleven_v3';
    const modelSelect = container.querySelector('#rbt-tts-model');
    if (modelSelect) modelSelect.value = savedModel;
    modelSelect?.addEventListener('change', () => {
        localStorage.setItem('rbt_tts_model', modelSelect.value);
    });

    // 刷新音色列表
    container.querySelector('#rbt-refresh-voices-btn')?.addEventListener('click', () => {
        _rbtVoiceCache = null; // 清除缓存，强制重新从API加载
        _rbtLoadVoiceList();
    });
    // 应用音色到全部空行
    container.querySelector('#rbt-apply-voice-all-btn')?.addEventListener('click', () => {
        const voiceSelect = container.querySelector('#rbt-tts-default-voice');
        const voiceId = voiceSelect?.value;
        const voiceName = voiceSelect?.options[voiceSelect.selectedIndex]?.text || '';
        if (!voiceId) { alert('请先选择一个音色'); return; }
        const tasks = window._reelsState?.tasks || [];
        let applied = 0;
        for (const task of tasks) {
            if (!task.ttsVoiceId || !task.ttsVoiceId.trim()) {
                task.ttsVoiceId = voiceId;
                applied++;
            }
        }
        _renderBatchTable();
        showToast(`已将音色「${voiceName}」应用到 ${applied} 个空行`, 'success');
    });
    // 首次自动加载音色列表
    _rbtLoadVoiceList();

    // PIP Batch upload
    container.querySelector('#rbt-upload-pip')?.addEventListener('click', () => {
        // reuse the same file input but redirect variable
        _batchTableState._pipBatchMode = true;
        let fileInput = container.querySelector('#rbt-file-pip');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'rbt-file-pip';
            fileInput.multiple = true;
            fileInput.style.display = 'none';
            fileInput.accept = 'image/*,video/*';
            container.appendChild(fileInput);
            fileInput.addEventListener('change', (e) => {
                _batchAssignFiles(Array.from(e.target.files), 'pip');
                e.target.value = '';
            });
        }
        fileInput.click();
    });



    // Column visibility settings
    container.querySelector('#rbt-col-settings-btn')?.addEventListener('click', (e) => {
        _showColumnSettingsPopup(e.target);
    });

    // 循环填充素材
    container.querySelector('#rbt-cycle-fill-btn')?.addEventListener('click', () => {
        _showCycleFillDialog();
    });

    // Cycle fill materials
    container.querySelector('#rbt-cycle-fill-btn')?.addEventListener('click', () => {
        _showCycleFillDialog();
    });

    // Save config (Legacy manual export)
    container.querySelector('#rbt-save-config-btn')?.addEventListener('click', () => {
        _batchExportConfig();
    });

    // Project Manager
    container.querySelector('#rbt-project-mgr-btn')?.addEventListener('click', () => {
        _showProjectManager();
    });

    // Load config (Legacy manual import)
    container.querySelector('#rbt-load-config-btn')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-config').click();
    });
    container.querySelector('#rbt-file-config')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) _batchImportConfig(file);
        e.target.value = '';
    });

    // ── 读取文件夹 ──
    container.querySelector('#rbt-upload-folder')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-folder').click();
    });
    container.querySelector('#rbt-file-folder')?.addEventListener('change', (e) => {
        _batchImportFolder(Array.from(e.target.files));
        e.target.value = '';
    });

    // ── 批量上传按钮 ──
    container.querySelector('#rbt-upload-bg')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-bg').click();
    });
    container.querySelector('#rbt-upload-audio')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-audio').click();
    });
    container.querySelector('#rbt-upload-srt')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-srt').click();
    });
    container.querySelector('#rbt-upload-txt')?.addEventListener('click', () => {
        container.querySelector('#rbt-file-txt').click();
    });
    container.querySelector('#rbt-paste-txtcontent')?.addEventListener('click', () => {
        _batchPasteTxtContent();
    });
    container.querySelector('#rbt-paste-btn')?.addEventListener('click', () => {
        _batchPasteFromSheet();
    });
    container.querySelector('#rbt-paste-scroll-btn')?.addEventListener('click', () => {
        _batchPasteScrollFromSheet();
    });
    container.querySelector('#rbt-paste-ai-raw-btn')?.addEventListener('click', () => {
        _batchPasteAiScript();
    });
    container.querySelector('#rbt-paste-tts-btn')?.addEventListener('click', () => {
        _batchPasteTTSContent();
    });

    // ── 内容视频层相关事件 ──
    container.querySelector('#rbt-upload-content-video')?.addEventListener('click', () => {
        let fileInput = container.querySelector('#rbt-file-contentvideo');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.id = 'rbt-file-contentvideo';
            fileInput.multiple = true;
            fileInput.style.display = 'none';
            fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
            container.appendChild(fileInput);
            fileInput.addEventListener('change', (e) => {
                _batchAssignFiles(Array.from(e.target.files), 'contentvideo');
                e.target.value = '';
            });
        }
        fileInput.click();
    });

    // ✂️ 粘贴剪辑文案 (A/B 双版本)
    container.querySelector('#rbt-paste-clip-ab')?.addEventListener('click', () => {
        _showClipAbPasteModal();
    });

    // 内容视频缩放: input + slider
    container.addEventListener('input', (e) => {
        if (e.target.classList.contains('rbt-cvscale-input') || e.target.classList.contains('rbt-cvscale-slider')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = parseInt(e.target.value) || 100;
            task.contentVideoScale = val;
            // Sync input <-> slider
            const row = e.target.closest('tr');
            if (row) {
                const sibling = row.querySelector(e.target.classList.contains('rbt-cvscale-input') ? '.rbt-cvscale-slider' : '.rbt-cvscale-input');
                if (sibling) sibling.value = val;
                const display = row.querySelector('.rbt-col-cvscale .rbt-scale-display');
                if (display) display.textContent = val + '%';
            }
        }
    });

    // 内容视频音量: input + slider
    container.addEventListener('input', (e) => {
        if (e.target.classList.contains('rbt-cvvol-input') || e.target.classList.contains('rbt-cvvol-slider')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = parseInt(e.target.value) || 0;
            task.contentVideoVolume = val;
            // Sync input <-> slider
            const row = e.target.closest('tr');
            if (row) {
                const sibling = row.querySelector(e.target.classList.contains('rbt-cvvol-input') ? '.rbt-cvvol-slider' : '.rbt-cvvol-input');
                if (sibling) sibling.value = val;
                const display = row.querySelector('.rbt-col-cvvol .rbt-scale-display');
                if (display) display.textContent = '🔊 ' + val + '%';
            }
            // 实时同步预览音量
            if (window._reelsState && window._reelsState.selectedIdx === idx) {
                const cvVideo = document.getElementById('reels-preview-contentvideo');
                if (cvVideo) {
                    cvVideo.volume = Math.min(1.0, val / 100);
                    cvVideo.muted = val === 0;
                }
            }
        }
    });

    // 内容视频位置 X/Y
    container.addEventListener('change', (e) => {
        if (e.target.classList.contains('rbt-cvpos-x') || e.target.classList.contains('rbt-cvpos-y')) {
            const idx = parseInt(e.target.dataset.idx);
            const task = window._reelsState.tasks[idx];
            if (!task) return;
            const val = e.target.value.trim() || 'center';
            if (e.target.classList.contains('rbt-cvpos-x')) task.contentVideoX = val;
            else task.contentVideoY = val;
        }
    });

    // 裁切单元格双击 → 打开裁切弹窗
    container.addEventListener('dblclick', (e) => {
        const trimCell = e.target.closest('.rbt-cv-trim-cell');
        if (trimCell) {
            const idx = parseInt(trimCell.dataset.idx);
            _showTrimModal(idx);
            return;
        }
    });

    container.querySelector('#rbt-align-all-btn')?.addEventListener('click', () => {
        _batchAlignAllTasks();
    });
    container.querySelector('#rbt-video-drop-route-enabled')?.addEventListener('change', (e) => {
        _batchTableState.videoDropRouteEnabled = !!e.target.checked;
        const modeEl = container.querySelector('#rbt-video-drop-route-mode');
        if (modeEl) {
            modeEl.disabled = !_batchTableState.videoDropRouteEnabled;
            modeEl.style.opacity = _batchTableState.videoDropRouteEnabled ? '' : '.6';
        }
    });
    container.querySelector('#rbt-video-drop-route-mode')?.addEventListener('change', (e) => {
        _batchTableState.videoDropRouteMode = e.target.value === 'audio' ? 'audio' : 'bg';
    });

    // ── 批量文件选完后按顺序分配到各行 ──
    container.querySelector('#rbt-file-bg')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'bg');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-audio')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'audio');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-srt')?.addEventListener('change', (e) => {
        _batchAssignFiles(Array.from(e.target.files), 'srt');
        e.target.value = '';
    });
    container.querySelector('#rbt-file-txt')?.addEventListener('change', (e) => {
        _batchAssignTxtFiles(Array.from(e.target.files));
        e.target.value = '';
    });

    // ── 配乐批量设置 ──
    container.querySelector('#rbt-set-bgm-btn')?.addEventListener('click', () => {
        // 点击“设置配乐”按钮，先选文件，然后应用到勾选的行
        _batchTableState._bgmBatchMode = true;
        container.querySelector('#rbt-file-bgm').click();
    });
    container.querySelector('#rbt-file-bgm')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
        const state = window._reelsState;

        if (_batchTableState._bgmBatchMode) {
            // 批量模式：应用到所有勾选的行
            const checks = container.querySelectorAll('.rbt-bgm-check:checked');
            let targets;
            if (checks.length > 0) {
                targets = Array.from(checks).map(c => state.tasks[parseInt(c.dataset.idx)]).filter(Boolean);
            } else {
                // 没有勾选任何行，应用到全部
                targets = state.tasks;
            }
            for (const t of targets) {
                t.bgmPath = filePath;
            }
            _renderBatchTable();
            if (typeof _renderTaskList === 'function') _renderTaskList();
            alert(`✅ 已将配乐设置到 ${targets.length} 个任务`);
        } else if (_batchTableState._bgmSingleIdx != null) {
            // 单行模式
            const task = state.tasks[_batchTableState._bgmSingleIdx];
            if (task) {
                task.bgmPath = filePath;
                _renderBatchTable();
                if (typeof _renderTaskList === 'function') _renderTaskList();
            }
        }
        _batchTableState._bgmBatchMode = false;
        _batchTableState._bgmSingleIdx = null;
        e.target.value = '';
    });

    // ── 单行文件选择 ──
    container.querySelector('#rbt-file-single')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const { idx, field } = _batchTableState._pendingSingle || {};
        if (idx != null && field) {
            _assignSingleFile(idx, field, file);
        }
        _batchTableState._pendingSingle = null;
        e.target.value = '';
    });

    // ── 表格内输入框快捷批量粘贴 ──
    container.querySelector('#rbt-tbody')?.addEventListener('paste', (e) => {
        const target = e.target;
        if (!target.matches('textarea, input.rbt-input, input.rbt-tts-voice-input')) return;

        const pastedData = (e.clipboardData || window.clipboardData).getData('text');
        if (!pastedData) return;

        // 使用 TSV 引号解析器，正确处理 Google Sheets 单元格内的换行
        const tsvRows = _parseBatchTSV(pastedData);
        
        const startIdx = parseInt(target.dataset.idx, 10);
        if (isNaN(startIdx)) return;

        let fieldCategory = null;
        if (target.classList.contains('rbt-ai-script-input')) fieldCategory = 'aiScript';
        else if (target.classList.contains('rbt-tts-text-input')) fieldCategory = 'ttsText';
        else if (target.classList.contains('rbt-txtcontent-input')) fieldCategory = 'txtContent';
        else if (target.classList.contains('rbt-title-input')) fieldCategory = 'overlay_title';
        else if (target.classList.contains('rbt-body-input')) fieldCategory = 'overlay_body';
        else if (target.classList.contains('rbt-footer-input')) fieldCategory = 'overlay_footer';
        else if (target.classList.contains('rbt-scroll-title-input')) fieldCategory = 'scroll_title';
        else if (target.classList.contains('rbt-scroll-body-input')) fieldCategory = 'scroll_body';
        else if (target.classList.contains('rbt-tts-voice-input')) fieldCategory = 'ttsVoiceId';
        else if (target.dataset.field) fieldCategory = target.dataset.field;

        let maxCols = Math.max(...tsvRows.map(r => r.length));
        while(maxCols > 1) {
            let hasData = false;
            for (let r=0; r<tsvRows.length; r++) {
                if (tsvRows[r][maxCols-1] && tsvRows[r][maxCols-1].trim() !== '') {
                    hasData = true; break;
                }
            }
            if (hasData) break;
            maxCols--;
        }

        if (maxCols > 1) {
            e.preventDefault();
            _showMultiColumnPasteModal(tsvRows, startIdx, fieldCategory);
            return;
        }

        const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);

        if (lines.length > 1) {
            e.preventDefault();

            if (!fieldCategory) return;

            const state = window._reelsState;
            let filled = 0, created = 0;
            let dataIdx = 0;

            for (let i = startIdx; i < state.tasks.length && dataIdx < lines.length; i++) {
                const task = state.tasks[i];
                const str = lines[dataIdx];
                if (fieldCategory === 'aiScript') task.aiScript = str;
                else if (fieldCategory === 'ttsText') task.ttsText = str;
                else if (fieldCategory === 'txtContent') { task.txtContent = str; task.aligned = false; }
                else if (fieldCategory === 'ttsVoiceId') task.ttsVoiceId = str;
                else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                    _applyOverlayField(task, fieldCategory, str);
                }
                dataIdx++;
                filled++;
            }

            const newRows = lines.slice(dataIdx);
            if (newRows.length > 0) {
                if (confirm(`粘贴了 ${lines.length} 行数据，当前表格剩下行数不足以装下。\\n是否自动创建 ${newRows.length} 行新任务并继续向下填充？`)) {
                    for (const str of newRows) {
                        const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
                        const newTask = {
                            baseName: taskName,
                            fileName: `${taskName}.mp4`,
                            bgPath: null, bgSrcUrl: null,
                            audioPath: null, srtPath: null,
                            segments: [],
                            videoPath: null, srcUrl: null,
                            overlays: [],
                            aligned: false,
                            bgScale: 100, bgDurScale: 100, audioDurScale: 100
                        };
                        
                        if (fieldCategory === 'aiScript') newTask.aiScript = str;
                        else if (fieldCategory === 'ttsText') newTask.ttsText = str;
                        else if (fieldCategory === 'txtContent') { newTask.txtContent = str; newTask.aligned = false; }
                        else if (fieldCategory === 'ttsVoiceId') newTask.ttsVoiceId = str;
                        else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                            _applyOverlayField(newTask, fieldCategory, str);
                        }
                        
                        state.tasks.push(newTask);
                        created++;
                    }
                }
            }

            const scrollWrap = container.querySelector('.rbt-table-wrap');
            const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
            const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
            
            _skipNextApply = true; // 粘贴已直接写入 state，跳过 DOM→state 同步
            _renderBatchTable();
            
            const newScrollWrap = container.querySelector('.rbt-table-wrap');
            if (newScrollWrap) {
                newScrollWrap.scrollTop = scrollTop;
                newScrollWrap.scrollLeft = scrollLeft;
            }
            if (typeof showToast === 'function') {
                showToast(`✅ 快捷批量粘贴成功：向下覆盖填充 ${filled} 行，新建 ${created} 行`, 'success');
            } else {
                alert(`✅ 快捷批量粘贴成功：向下覆盖填充 ${filled} 行，新建 ${created} 行`);
            }
        }
    });

    // ── 拖拽文件到批量表格 ──
    const panel = container.querySelector('.rbt-panel') || container;
    let _dropOverlay = null;
    const _showDropOverlay = () => {
        if (_dropOverlay) return;
        _dropOverlay = document.createElement('div');
        _dropOverlay.style.cssText = 'position:absolute;inset:0;z-index:99;background:rgba(80,140,255,0.15);border:3px dashed #4a9eff;border-radius:12px;display:flex;align-items:center;justify-content:center;pointer-events:none;';
        _dropOverlay.innerHTML = '<span style="font-size:24px;color:#4a9eff;font-weight:700;text-shadow:0 2px 8px rgba(0,0,0,0.5);">📂 拖放文件到这里</span>';
        panel.style.position = 'relative';
        panel.appendChild(_dropOverlay);
    };
    const _hideDropOverlay = () => {
        if (_dropOverlay) { _dropOverlay.remove(); _dropOverlay = null; }
    };
    let _dragCounter = 0;
    panel.addEventListener('dragenter', (e) => {
        e.preventDefault();
        // Don't show panel overlay when dragging over sidebar
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;
        _dragCounter++;
        _showDropOverlay();
    });
    panel.addEventListener('dragleave', (e) => { 
        e.preventDefault(); 
        if (e.target.classList && e.target.classList.contains('rbt-droppable')) {
            e.target.classList.remove('rbt-drag-over');
        }
        _dragCounter--; 
        if (_dragCounter <= 0) { 
            _dragCounter = 0; 
            _hideDropOverlay(); 
            panel.querySelectorAll('.rbt-droppable.rbt-drag-over').forEach(c => c.classList.remove('rbt-drag-over'));
        } 
    });
    panel.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Let media sidebar handle its own dragover
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;
        // 内部行拖拽时不覆盖 dropEffect
        if (_dragSrcIdx == null) e.dataTransfer.dropEffect = 'copy';
        
        // Highlight logic for specific droppable columns
        const cell = e.target.closest('.rbt-droppable');
        panel.querySelectorAll('.rbt-droppable.rbt-drag-over').forEach(c => {
            if (c !== cell) c.classList.remove('rbt-drag-over');
        });
        if (cell) cell.classList.add('rbt-drag-over');
    });
    panel.addEventListener('drop', (e) => {
        _dragCounter = 0;
        _hideDropOverlay();
        panel.querySelectorAll('.rbt-droppable.rbt-drag-over').forEach(c => c.classList.remove('rbt-drag-over'));
        // If drop lands inside media sidebar, let the sidebar's own handler deal with it
        if (e.target.closest && e.target.closest('#rbt-media-sidebar')) return;

        // Handle Pool Item Drop to Row
        let poolIdxStr = e.dataTransfer.getData('application/x-media-pool-idx');
        if (poolIdxStr) {
            e.preventDefault();
            const poolIdx = parseInt(poolIdxStr);
            const rowEl = e.target.closest('.rbt-row');
            if (!rowEl) return;
            const taskIdx = parseInt(rowEl.dataset.idx);
            
            const dropCell = e.target.closest('.rbt-droppable');
            const targetField = dropCell ? dropCell.dataset.field : null;

            const item = window._mediaPool.items[poolIdx];
            const task = window._reelsState.tasks[taskIdx];
            if (item && task) {
                if (targetField === 'contentvideo') { task.contentVideoPath = item.path; }
                else if (targetField === 'bg') { task.bgPath = item.path; task.videoPath = item.path; }
                else if (targetField === 'hook') {
                    if (!task.hook) task.hook = {};
                    task.hook.enabled = true;
                    task.hook.path = item.path;
                    task.hookFile = item.path;
                }
                else if (targetField === 'audio') { task.audioPath = item.path; }
                else if (targetField === 'srt') { task.srtPath = item.path; }
                else if (targetField === 'cover_media') { if (!task.cover) task.cover = {}; task.cover.enabled = true; task.cover.bgPath = item.path; }
                else if (targetField === 'pip') { task.pipPath = item.path; }
                // Default fallback if dropped on non-specific column
                else if (item.type === 'seq') { task.bgPath = item.path; task.videoPath = item.path; }
                else if (item.isAudio) { task.audioPath = item.path; }
                else if (item.ext === 'srt') { task.srtPath = item.path; }
                else if (item.ext === 'txt') { task.txtContent = ''; task.txtPath = item.path; }
                else { task.bgPath = item.path; task.videoPath = item.path; }
                
                _renderBatchTable();
                if (typeof showToast === 'function') showToast(`✅ 已将素材 ${item.name} 分配到第 ${taskIdx + 1} 行`, 'success');
            }
            return;
        }

        // 如果是内部行拖拽排序（无文件），不拦截，让 tbody 的 drop 处理
        if (_dragSrcIdx != null) return;

        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();

        // ── 精确落到 cover_media 单元格时，直接设为封面背景 ──
        const dropCell = e.target.closest('.rbt-droppable');
        if (dropCell && dropCell.dataset.field === 'cover_media') {
            const row = dropCell.closest('.rbt-row');
            if (row && files[0]) {
                const idx = parseInt(row.dataset.idx);
                const task = window._reelsState.tasks[idx];
                if (task) {
                    let filePath = files[0].path;
                    if (!filePath && window.electronAPI && window.electronAPI.getFilePath) {
                        try { filePath = window.electronAPI.getFilePath(files[0]); } catch (_) {}
                    }
                    filePath = filePath || files[0].name;
                    if (!task.cover) task.cover = {};
                    task.cover.enabled = true;
                    task.cover.bgPath = filePath;
                    if (!task.cover.overlays) task.cover.overlays = [];
                    _renderBatchTable();
                    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
                    if (typeof showToast === 'function') showToast(`✅ 已设置第 ${idx + 1} 行封面背景`, 'success');
                }
            }
            return;
        }

        // 按扩展名分类
        const bgExts = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp']);
        const audioExts = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
        const groups = { hook: [], bg: [], audio: [], srt: [], txt: [] };
        const forcedVideoRoute = _batchTableState.videoDropRouteEnabled
            ? _batchTableState.videoDropRouteMode
            : null;

        for (const f of files) {
            const ext = (f.name || '').split('.').pop().toLowerCase();
            if (ext === 'srt') groups.srt.push(f);
            else if (ext === 'txt') groups.txt.push(f);
            else if (audioExts.has(ext)) groups.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'audio') groups.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'bg') groups.bg.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && forcedVideoRoute === 'hook') groups.hook.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(f.name || '')) groups.audio.push(f);
            else if (bgExts.has(ext)) {
                if (forcedVideoRoute === 'hook') groups.hook.push(f);
                else groups.bg.push(f);
            }
        }

        // 按类型依次分配（最多的类型先处理，其他自动填充）
        const assignments = [];
        if (groups.hook.length) assignments.push(['hook', groups.hook]);
        if (groups.bg.length) assignments.push(['bg', groups.bg]);
        if (groups.audio.length) assignments.push(['audio', groups.audio]);
        if (groups.srt.length) assignments.push(['srt', groups.srt]);
        if (groups.txt.length) assignments.push(['txt', groups.txt]);

        if (assignments.length === 0) {
            alert('未识别到支持的文件类型');
            return;
        }

        // 依次批量分配（异步串行）
        (async () => {
            for (const [field, fieldFiles] of assignments) {
                await _batchAssignFiles(fieldFiles, field);
            }
        })();
    });

    // ── 批量清空列（勾选优先，未勾选则全部） ──
    const _getClearTargets = () => {
        const state = window._reelsState;
        if (!state || !state.tasks) return { state: null, indices: [], label: '0行' };
        let indices = _getSelectedIndices();
        const label = indices.length > 0 ? `勾选的 ${indices.length} 行` : '所有行';
        if (indices.length === 0) indices = state.tasks.map((_, i) => i);
        return { state, indices, label };
    };

    const _clearTaskField = (task, field) => {
        if (!task) return;
        switch (field) {
            case 'cover_media':
                if (task.cover) {
                    task.cover.enabled = false;
                    task.cover.bgPath = '';
                }
                break;
            case 'cover_text':
                if (task.cover && task.cover.overlays && task.cover.overlays.length > 0) {
                    task.cover.overlays[0].title_text = '';
                    task.cover.overlays[0].body_text = '';
                }
                break;
            case 'hook':
                task.hookFile = '';
                task.hookTrimStart = null;
                task.hookTrimEnd = null;
                task.hookSpeed = 1;
                task.hookTransition = 'none';
                task.hookTransDuration = 0.5;
                if (!task.hook) task.hook = {};
                task.hook.enabled = false;
                task.hook.path = '';
                break;
            case 'bg':
                task.bgPath = '';
                task.videoPath = '';
                task.bgSrcUrl = '';
                task.bgMode = 'single';
                task.bgClipPool = [];
                task.bgTransition = 'crossfade';
                break;
            case 'tts_text':
                task.ttsText = '';
                break;
            case 'tts_voice':
                task.ttsVoiceId = '';
                break;
            case 'pip':
                task.pipPath = '';
                break;
            case 'audio':
                task.audioPath = '';
                break;
            case 'srt':
                task.srtPath = '';
                task.aligned = false;
                break;
            case 'txt':
                task.txtContent = '';
                task.aligned = false;
                break;
            case 'ai_script':
                task.aiScript = '';
                break;
            case 'bgm':
                task.bgmPath = '';
                break;
            case 'contentvideo':
                task.contentVideoPath = '';
                task.contentVideoTrimStart = null;
                task.contentVideoTrimEnd = null;
                task.contentVideoScale = 100;
                task.contentVideoX = 'center';
                task.contentVideoY = 'center';
                break;
            case 'overlay':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) {
                        ov.title_text = '';
                        ov.body_text = '';
                        ov.footer_text = '';
                        ov.scroll_title = '';
                        ov.content = '';
                    }
                }
                break;
            case 'overlay_title':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) ov.title_text = '';
                }
                break;
            case 'overlay_body':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) ov.body_text = '';
                }
                break;
            case 'overlay_footer':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) ov.footer_text = '';
                }
                break;
            case 'scroll_title':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) ov.scroll_title = '';
                }
                break;
            case 'scroll_body':
                if (task.overlays && task.overlays.length > 0) {
                    for (const ov of task.overlays) ov.content = '';
                }
                break;
            case 'exportName':
                task.exportName = '';
                break;
            default:
                break;
        }
    };

    // ── 列标题清空按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.rbt-th-clear');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const field = btn.dataset.clearCol;
        if (!field) return;
        const labelMap = {
            hook: 'Hook',
            bg: '背景',
            contentvideo: '视频覆层',
            tts_text: 'TTS文案',
            tts_voice: 'TTS音色',
            pip: '图像覆层',
            audio: '人声',
            srt: 'SRT',
            txt: 'TXT文案',
            ai_script: 'AI原文案',
            bgm: '配乐',
            overlay_title: '覆层标题',
            overlay_body: '覆层内容',
            overlay_footer: '覆层结尾',
            scroll_title: '滚动标题',
            scroll_body: '滚动内容',
            cover_media: '封面素材',
            cover_text: '封面文案'
        };
        const { state, indices, label } = _getClearTargets();
        if (!state || indices.length === 0) return;
        const fieldLabel = labelMap[field] || '该列';
        if (!confirm(`确定清空${label}的${fieldLabel}？`)) return;
        for (const idx of indices) _clearTaskField(state.tasks[idx], field);
        
        const scrollWrap = container.querySelector('.rbt-table-wrap');
        const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
        const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
        _skipNextApply = true; // 清空已直接写入 state
        _renderBatchTable();
        const newScrollWrap = container.querySelector('.rbt-table-wrap');
        if (newScrollWrap) {
            newScrollWrap.scrollTop = scrollTop;
            newScrollWrap.scrollLeft = scrollLeft;
        }
        
        if (typeof showToast === 'function') showToast(`✅ 已清空${label}的${fieldLabel}`, 'success');
    });

    // ── 列标题粘贴按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.rbt-th-paste');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const fieldCategory = btn.dataset.pasteCol;
        if (!fieldCategory) return;

        let raw = '';
        try { raw = await navigator.clipboard.readText(); } catch (ex) {
            showToast('无法读取剪贴板，请使用 Ctrl+V 在输入框中粘贴', 'error');
            return;
        }
        if (!raw || !raw.trim()) { showToast('剪贴板为空', 'error'); return; }

        const tsvRows = _parseBatchTSV(raw);
        let maxCols = Math.max(...tsvRows.map(r => r.length));
        while(maxCols > 1) {
            let hasData = false;
            for (let r=0; r<tsvRows.length; r++) {
                if (tsvRows[r][maxCols-1] && tsvRows[r][maxCols-1].trim() !== '') { hasData = true; break; }
            }
            if (hasData) break;
            maxCols--;
        }
        if (maxCols > 1) {
            _showMultiColumnPasteModal(tsvRows, 0, fieldCategory);
            return;
        }

        const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);
        if (!lines.length) { showToast('未检测到有效数据', 'error'); return; }

        const state = window._reelsState;
        if (!state) return;

        let filled = 0, created = 0;
        let dataIdx = 0;

        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            const str = lines[dataIdx];
            if (fieldCategory === 'aiScript') task.aiScript = str;
            else if (fieldCategory === 'ttsText') task.ttsText = str;
            else if (fieldCategory === 'txtContent') { task.txtContent = str; task.aligned = false; }
            else if (fieldCategory === 'ttsVoiceId') task.ttsVoiceId = str;
            else if (fieldCategory === 'exportName') task.exportName = str;
            else if (fieldCategory === 'cover_text') {
                if (!task.cover) task.cover = { enabled: true, overlays: [] };
                if (task.cover.overlays && task.cover.overlays.length > 0) task.cover.overlays[0].title_text = str;
                else task.cover.overlays = [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }];
            }
            else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                _applyOverlayField(task, fieldCategory, str);
            }
            dataIdx++;
            filled++;
        }

        const newRows = lines.slice(dataIdx);
        if (newRows.length > 0) {
            if (confirm(`剪贴板有 ${lines.length} 条数据，当前只有 ${state.tasks.length} 行。\n是否自动创建 ${newRows.length} 行新任务？`)) {
                for (const str of newRows) {
                    const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
                    const newTask = {
                        baseName: taskName, fileName: `${taskName}.mp4`,
                        bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
                        segments: [], videoPath: null, srcUrl: null, overlays: [],
                        aligned: false, bgScale: 100, bgDurScale: 100, audioDurScale: 100
                    };
                    if (fieldCategory === 'aiScript') newTask.aiScript = str;
                    else if (fieldCategory === 'ttsText') newTask.ttsText = str;
                    else if (fieldCategory === 'txtContent') { newTask.txtContent = str; }
                    else if (fieldCategory === 'ttsVoiceId') newTask.ttsVoiceId = str;
                    else if (fieldCategory === 'exportName') newTask.exportName = str;
                    else if (fieldCategory === 'cover_text') {
                        newTask.cover = { enabled: true, overlays: [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }] };
                    }
                    else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                        _applyOverlayField(newTask, fieldCategory, str);
                    }
                    state.tasks.push(newTask);
                    created++;
                }
            }
        }

        const scrollWrap = container.querySelector('.rbt-table-wrap');
        const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
        const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
        
        _skipNextApply = true; // 粘贴已直接写入 state，跳过 DOM→state 同步
        _renderBatchTable();
        
        const newScrollWrap = container.querySelector('.rbt-table-wrap');
        if (newScrollWrap) {
            newScrollWrap.scrollTop = scrollTop;
            newScrollWrap.scrollLeft = scrollLeft;
        }

        showToast(`✅ 粘贴到列完成：覆盖 ${filled} 行，新建 ${created} 行`, 'success');
    });

    // ── 列标题文件夹按钮 ──
    container.querySelector('#rbt-table thead')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('.rbt-th-folder');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const colType = btn.dataset.folderCol;
        if (!colType) return;

        if (!window.electronAPI || !window.electronAPI.selectDirectory) {
            showToast('请在桌面应用中使用此功能', 'error');
            return;
        }

        const dir = await window.electronAPI.selectDirectory();
        if (!dir) return;

        btn.textContent = '⏳';
        btn.disabled = true;

        try {
            const files = await window.electronAPI.scanDirectory(dir);
            if (!files || files.length === 0) {
                showToast('文件夹为空或无法读取', 'error');
                return;
            }

            // 按列类型过滤匹配的文件扩展名
            const extMap = {
                bg:    new Set(['mp4','mov','mkv','avi','wmv','flv','webm','jpg','jpeg','png','webp','gif','bmp']),
                audio: new Set(['mp3','wav','m4a','aac','flac','ogg','wma','mp4','mov']),
                srt:   new Set(['srt']),
                bgm:   new Set(['mp3','wav','m4a','aac','flac','ogg']),
                pip:   new Set(['jpg','jpeg','png','webp','gif','bmp','svg']),
                contentvideo: new Set(['mp4','mov','mkv','avi','wmv','flv','webm']),
            };
            const validExts = extMap[colType] || extMap.bg;

            const matched = files
                .filter(f => {
                    const ext = (f.name || '').split('.').pop().toLowerCase();
                    return validExts.has(ext);
                })
                .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }));

            if (matched.length === 0) {
                showToast(`文件夹中没有找到匹配的文件`, 'error');
                return;
            }

            const state = window._reelsState;
            if (!state) return;

            let filled = 0, created = 0;
            let dataIdx = 0;

            // 分配到现有行
            for (let i = 0; i < state.tasks.length && dataIdx < matched.length; i++) {
                const task = state.tasks[i];
                const fpath = matched[dataIdx].path;
                if (colType === 'bg') {
                    task.bgPath = fpath; task.videoPath = fpath; task.bgSrcUrl = '';
                } else if (colType === 'audio') {
                    task.audioPath = fpath;
                } else if (colType === 'srt') {
                    task.srtPath = fpath;
                } else if (colType === 'bgm') {
                    task.bgmPath = fpath;
                } else if (colType === 'pip') {
                    if (!task.overlays) task.overlays = [];
                    const pipOverlay = task.overlays.find(o => o && o.type === 'pip');
                    if (pipOverlay) { pipOverlay.src = fpath; }
                    else { task.overlays.push({ type: 'pip', src: fpath, x: 0, y: 0, w: 200, h: 200, start: 0, end: 9999 }); }
                } else if (colType === 'contentvideo') {
                    task.contentVideoPath = fpath;
                    if (task.contentVideoScale == null) task.contentVideoScale = 100;
                    if (task.contentVideoX == null) task.contentVideoX = 'center';
                    if (task.contentVideoY == null) task.contentVideoY = 'center';
                }
                dataIdx++;
                filled++;
            }

            // 超出部分提示创建新行
            const remaining = matched.length - dataIdx;
            if (remaining > 0) {
                if (confirm(`文件夹有 ${matched.length} 个文件，当前只有 ${state.tasks.length} 行。\n是否自动创建 ${remaining} 行新任务？`)) {
                    for (; dataIdx < matched.length; dataIdx++) {
                        const fpath = matched[dataIdx].path;
                        const fname = matched[dataIdx].name || '';
                        const baseName = fname.replace(/\.[^.]+$/, '');
                        const newTask = {
                            baseName, fileName: `${baseName}.mp4`,
                            bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
                            segments: [], videoPath: null, srcUrl: null, overlays: [],
                            aligned: false, bgScale: 100, bgDurScale: 100, audioDurScale: 100
                        };
                        if (colType === 'bg') { newTask.bgPath = fpath; newTask.videoPath = fpath; }
                        else if (colType === 'audio') newTask.audioPath = fpath;
                        else if (colType === 'srt') newTask.srtPath = fpath;
                        else if (colType === 'bgm') newTask.bgmPath = fpath;
                        else if (colType === 'pip') {
                            newTask.overlays = [{ type: 'pip', src: fpath, x: 0, y: 0, w: 200, h: 200, start: 0, end: 9999 }];
                        } else if (colType === 'contentvideo') {
                            newTask.contentVideoPath = fpath;
                            newTask.contentVideoScale = 100;
                            newTask.contentVideoX = 'center';
                            newTask.contentVideoY = 'center';
                        }
                        state.tasks.push(newTask);
                        created++;
                    }
                }
            }

            _renderBatchTable();
            const colLabels = { bg: '背景素材', audio: '人声音频', srt: '字幕SRT', bgm: '配乐', pip: '图片覆层', contentvideo: '视频覆层' };
            showToast(`✅ ${colLabels[colType] || colType}：分配 ${filled} 个文件，新建 ${created} 行`, 'success');
        } finally {
            btn.textContent = '📁';
            btn.disabled = false;
        }
    });

    // 仅导出选中行（表格数据不变）
    container.querySelector('#rbt-export-selected-btn')?.addEventListener('click', () => {
        const selected = _batchTableState.selectedRows;
        if (selected.size === 0) return;
        _applyBatchTableChanges(); // 先同步输入框到 tasks
        const allTasks = window._reelsState.tasks;
        const exported = [...selected].sort((a, b) => a - b).map(i => allTasks[i]).filter(Boolean);
        // 临时替换 tasks 为选中行，关闭表格
        const backup = allTasks.slice();
        window._reelsState.tasks = exported;
        window._reelsState.selectedIdx = 0;
        reelsToggleBatchTable();
        if (typeof _renderTaskList === 'function') _renderTaskList();
        // 恢复完整 tasks 到 tab（表格下次打开还是全部）
        const tab = _getActiveTab();
        if (tab) tab.tasks = _serializeTasks(backup);
        if (typeof showToast === 'function') showToast(`📤 已导出 ${exported.length} 行到主面板（表格数据不变）`, 'success');
    });

    // ── 拖拽排序 ──
    _dragSrcIdx = null;
    let _dragMouseTarget = null; // 追踪实际点击的元素
    const tbody2 = container.querySelector('#rbt-tbody');
    if (tbody2) {
        // 记录鼠标按下的实际元素，dragstart时用它判断是否从手柄发起
        tbody2.addEventListener('mousedown', (e) => {
            _dragMouseTarget = e.target;
        });
        tbody2.addEventListener('dragstart', (e) => {
            const row = e.target.closest('.rbt-row');
            if (!row) { e.preventDefault(); return; }
            // Only allow drag from the handle
            if (!_dragMouseTarget || !_dragMouseTarget.closest('.rbt-drag-handle')) { e.preventDefault(); return; }
            _dragSrcIdx = parseInt(row.dataset.idx);
            row.classList.add('rbt-dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(_dragSrcIdx));
        });
        tbody2.addEventListener('dragend', (e) => {
            const row = e.target.closest('.rbt-row');
            if (row) row.classList.remove('rbt-dragging');
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            _dragSrcIdx = null;
        });
        tbody2.addEventListener('dragover', (e) => {
            const hasPoolItem = e.dataTransfer.types.includes('application/x-media-pool-idx');
            // Allow dragover if dragging a row OR dragging a pool item
            if (_dragSrcIdx == null && !hasPoolItem) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = hasPoolItem ? 'copy' : 'move';
            const row = e.target.closest('.rbt-row');
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            if (row) row.classList.add('rbt-drag-over-row');
        });
        tbody2.addEventListener('dragleave', (e) => {
            const row = e.target.closest('.rbt-row');
            if (row) row.classList.remove('rbt-drag-over-row');
        });
        tbody2.addEventListener('drop', (e) => {
            tbody2.querySelectorAll('.rbt-drag-over-row').forEach(r => r.classList.remove('rbt-drag-over-row'));
            // If dragging from media pool, panel's drop handler will catch it, do not reorder rows here
            if (_dragSrcIdx == null) return;
            
            e.preventDefault();
            const row = e.target.closest('.rbt-row');
            if (!row || _dragSrcIdx == null) return;
            const dstIdx = parseInt(row.dataset.idx);
            if (dstIdx === _dragSrcIdx) return;
            const tasks = window._reelsState.tasks;
            if (!tasks) return;
            const [moved] = tasks.splice(_dragSrcIdx, 1);
            tasks.splice(dstIdx, 0, moved);
            _batchTableState.selectedRows = new Set();
            _dragSrcIdx = null;
            // 保存滚动位置，渲染后恢复
            const scrollWrap = container.querySelector('.rbt-table-wrap');
            const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
            _renderBatchTable();
            const scrollWrap2 = container.querySelector('.rbt-table-wrap');
            if (scrollWrap2) scrollWrap2.scrollTop = scrollTop;
            if (typeof showToast === 'function') showToast(`已移动到第 ${dstIdx + 1} 行`, 'info');
        });
    }

    // Per-row events (delegated)
    const tbody = container.querySelector('#rbt-tbody');
    if (tbody) {
        // Windows 兼容：点击缩放显示值切换控件可见性（无 hover 时的替代方案）
        tbody.addEventListener('click', (e) => {
            if (e.target.classList.contains('rbt-scale-display')) {
                const td = e.target.closest('td');
                if (td) {
                    // 移除其他 active
                    document.querySelectorAll('td.rbt-scale-active').forEach(el => {
                        if (el !== td) el.classList.remove('rbt-scale-active');
                    });
                    td.classList.toggle('rbt-scale-active');
                    // 聚焦第一个输入框
                    const firstInput = td.querySelector('input[type="number"], input[type="range"]');
                    if (firstInput && td.classList.contains('rbt-scale-active')) {
                        setTimeout(() => firstInput.focus(), 50);
                    }
                }
            }
        });
        // 音量滑块实时更新标签
        tbody.addEventListener('input', (e) => {
            if (e.target.classList.contains('rbt-bgm-vol')) {
                const label = e.target.parentElement.querySelector('.rbt-bgm-vol-label');
                if (label) label.textContent = e.target.value + '%';
                // Sync volume to task for real-time preview
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    task.bgmVolume = parseInt(e.target.value) || 0;
                    // If this is the selected task, update preview audio immediately
                    if (idx === window._reelsState.selectedIdx && typeof _applyPreviewAudioMix === 'function') {
                        _applyPreviewAudioMix();
                    }
                }
            }
            // ── 背景缩放 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-bgscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-bgscale-input');
                if (numInput) numInput.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} bgScale=${task.bgScale}`); }
            }
            if (e.target.classList.contains('rbt-bgscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-bgscale-slider');
                if (slider) slider.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} bgScale=${task.bgScale}`); }
            }
            // ── 背景时长缩放 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-bgdurscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-bgdurscale-input');
                if (numInput) numInput.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgDurScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} bgDurScale=${task.bgDurScale}`); }
            }
            if (e.target.classList.contains('rbt-bgdurscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-bgdurscale-slider');
                if (slider) slider.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.bgDurScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} bgDurScale=${task.bgDurScale}`); }
            }
            // ── 音频变速 slider↔input 同步 ──
            if (e.target.classList.contains('rbt-audiodurscale-slider')) {
                const numInput = e.target.parentElement.querySelector('.rbt-audiodurscale-input');
                if (numInput) numInput.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.audioDurScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} audioDurScale=${task.audioDurScale}`); }
            }
            if (e.target.classList.contains('rbt-audiodurscale-input')) {
                const slider = e.target.closest('td').querySelector('.rbt-audiodurscale-slider');
                if (slider) slider.value = e.target.value;
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) { task.audioDurScale = parseInt(e.target.value) || 100; console.log(`[Scale] row${idx} audioDurScale=${task.audioDurScale}`); }
            }
            if (e.target.classList.contains('rbt-tts-text-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) task.ttsText = e.target.value;
            }
            if (e.target.classList.contains('rbt-tts-voice-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) task.ttsVoiceId = e.target.value;
            }
            if (e.target.classList.contains('rbt-ai-script-input') || e.target.classList.contains('rbt-txtcontent-input') || e.target.classList.contains('rbt-tts-text-input')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState && window._reelsState.tasks[idx];
                if (task) {
                    if (e.target.classList.contains('rbt-ai-script-input')) task.aiScript = e.target.value;
                    if (e.target.classList.contains('rbt-txtcontent-input')) task.txtContent = e.target.value;
                    if (e.target.classList.contains('rbt-tts-text-input')) task.ttsText = e.target.value;
                    
                    const normalizeText = (str) => {
                        let s = (str || '');
                        s = s.replace(/\[.*?\]/g, ''); 
                        s = s.replace(/<.*?>/g, ''); 
                        return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
                    };
                    const origNorm = normalizeText(task.aiScript);
                    
                    const isDiffTxt = (origNorm !== normalizeText(task.txtContent)) && (task.txtContent && task.txtContent.trim().length > 0) && (task.aiScript && task.aiScript.trim().length > 0);
                    task.aiTextDiffWarning = !!isDiffTxt;
                    
                    const isDiffTts = (origNorm !== normalizeText(task.ttsText)) && (task.ttsText && task.ttsText.trim().length > 0) && (task.aiScript && task.aiScript.trim().length > 0);
                    task.aiTtsDiffWarning = !!isDiffTts;
                    
                    // 实时更新UI报警状态
                    const row = e.target.closest('tr.rbt-row');
                    if (row) {
                        const txtArea = row.querySelector('.rbt-txtcontent-input');
                        if (txtArea) {
                            if (isDiffTxt) {
                                txtArea.style.border = '1px solid #ef4444';
                                txtArea.style.background = 'rgba(239, 68, 68, 0.1)';
                                txtArea.title = '⚠️ 警告：AI断行产生的文本与【🧠 AI 原文案】存在字符差异。可能发生了改词或删词，请仔细检查比对！\n\n如有错误请直接修改。';
                            } else {
                                txtArea.style.border = '';
                                txtArea.style.background = '';
                                txtArea.title = txtArea.disabled ? '外部SRT优先级更高，文案处于禁用状态' : '双击放大编辑';
                            }
                        }
                        const tagSpan = row.querySelector('.rbt-col-txtcontent .diff-warning-badge');
                        if (isDiffTxt && !tagSpan) {
                            const wrapper = row.querySelector('.rbt-col-txtcontent > div');
                            if (wrapper) wrapper.insertAdjacentHTML('beforeend', '<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="txt" data-idx="' + idx + '" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>');
                        } else if (!isDiffTxt && tagSpan) {
                            tagSpan.remove();
                        }
                        
                        const ttsArea = row.querySelector('.rbt-tts-text-input');
                        if (ttsArea) {
                            if (isDiffTts) {
                                ttsArea.style.border = '1px solid #ef4444';
                                ttsArea.style.background = 'rgba(239, 68, 68, 0.1)';
                                ttsArea.title = '⚠️ 警告：检测到配音文案与原文存在字符差异！请检查是否发生了改词！';
                            } else {
                                ttsArea.style.border = '';
                                ttsArea.style.background = '';
                                ttsArea.title = '双击放大编辑';
                            }
                        }
                        
                        const tagSpanTts = row.querySelector('.rbt-col-tts_text .diff-warning-badge');
                        if (isDiffTts && !tagSpanTts) {
                            const wrapperTts = row.querySelector('.rbt-col-tts_text > div');
                            if (wrapperTts) wrapperTts.insertAdjacentHTML('beforeend', '<div class="diff-warning-badge" style="margin-top:6px;font-size:12px;color:#ef4444;font-weight:bold;text-align:right;">⚠️词汇变动警告 <span class="diff-modal-btn" data-field="tts" data-idx="' + idx + '" style="color:#3b82f6;cursor:pointer;margin-left:8px;text-decoration:underline;">[🔍比对]</span></div>');
                        } else if (!isDiffTts && tagSpanTts) {
                            tagSpanTts.remove();
                        }
                    }
                }
            }
        });
        // Row checkbox change handler
        tbody.addEventListener('change', (e) => {
            if (e.target.classList.contains('rbt-row-check')) {
                const idx = parseInt(e.target.dataset.idx);
                if (e.target.checked) {
                    _batchTableState.selectedRows.add(idx);
                } else {
                    _batchTableState.selectedRows.delete(idx);
                }
                _updateBatchSelectCount();
            } else if (e.target.classList.contains('rbt-card-tpl-select')) {
                const idx = parseInt(e.target.dataset.idx);
                const task = window._reelsState?.tasks?.[idx];
                const presetName = e.target.value || '';
                const selectEl = e.target;
                if (task) {
                    if (presetName) {
                        _promptOverlayPresetOptions(presetName, [task], (opts) => {
                            const result = _applyAndVerifyOverlayGroupPresetToTask(task, presetName, opts);
                            if (!result.ok) {
                                alert(`⚠️ 第 ${idx + 1} 行覆层预设未通过校验：${result.reason}`);
                            }
                            _syncSelectedTaskOverlayMgrIfNeeded(idx);
                            if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                            _renderBatchTable(); // Force re-render to update inputs
                        });
                    } else {
                        task._overlayPresetName = '';
                        _syncSelectedTaskOverlayMgrIfNeeded(idx);
                        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
                        _renderBatchTable();
                    }
                }
            }
        });
        tbody.addEventListener('click', (e) => {
            // 预览按钮
            const selectBtn = e.target.closest('.rbt-select-btn');
            if (selectBtn) {
                const idx = parseInt(selectBtn.dataset.idx);
                _applyBatchTableChanges();
                reelsToggleBatchTable();
                if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
                return;
            }
            // 对比差异按钮
            const diffBtn = e.target.closest('.rbt-diff-btn, .diff-modal-btn');
            if (diffBtn) {
                const idx = parseInt(diffBtn.dataset.idx);
                const field = diffBtn.dataset.field;
                const task = window._reelsState.tasks[idx];
                if (task) {
                    if (field === 'txt') {
                        _showDiffModal(task.aiScript, task.txtContent, 'txt', idx);
                    } else if (field === 'tts') {
                        _showDiffModal(task.aiScript, task.ttsText, 'tts', idx);
                    }
                }
                return;
            }
            // 复制行按钮
            const cloneBtn = e.target.closest('.rbt-clone-btn');
            if (cloneBtn) {
                const idx = parseInt(cloneBtn.dataset.idx);
                const src = window._reelsState.tasks[idx];
                if (src) {
                    const copy = JSON.parse(JSON.stringify(src));
                    copy.baseName = (copy.baseName || 'copy') + '_copy';
                    copy.fileName = copy.baseName + '.mp4';
                    // 清掉不可序列化的引用
                    delete copy._video;
                    delete copy._bgThumb;
                    window._reelsState.tasks.splice(idx + 1, 0, copy);
                    _renderBatchTable();
                }
                return;
            }
            // 删除按钮
            const delBtn = e.target.closest('.rbt-delete-btn');
            if (delBtn) {
                const idx = parseInt(delBtn.dataset.idx);
                window._reelsState.tasks.splice(idx, 1);
                _renderBatchTable();
                return;
            }
            // 模板选择器触发
            const subTplBtn = e.target.closest('.rbt-sub-tpl-trigger');
            if (subTplBtn) {
                e.stopPropagation();
                const idx = parseInt(subTplBtn.dataset.idx);
                const task = window._reelsState.tasks[idx];
                const currentVal = task._subtitlePreset || '';
                _openStyledPresetPicker(subTplBtn, currentVal, (val) => {
                    task._subtitlePreset = val;
                    const span = subTplBtn.querySelector('span');
                    if (span) span.textContent = val || '默认';
                    // 不必全表重新渲染，只做数据记录
                });
                return;
            }
            // 多素材池管理按钮
            const poolBtn = e.target.closest('.rbt-bg-pool-manage');
            if (poolBtn) {
                e.stopPropagation();
                const idx = parseInt(poolBtn.dataset.idx);
                _showBgPoolDialog(idx);
                return;
            }
            // 单字段清除按钮
            const clearBtn = e.target.closest('.rbt-field-clear');
            if (clearBtn) {
                e.stopPropagation();
                const idx = parseInt(clearBtn.dataset.idx);
                const field = clearBtn.dataset.field;
                const task = window._reelsState.tasks[idx];
                if (!task) return;
                switch (field) {
                    case 'cover_media':
                        if (task.cover) {
                            task.cover.enabled = false;
                            task.cover.bgPath = '';
                        }
                        break;
                    case 'hook': 
                        task.hookFile = ''; 
                        task.hookTrimStart = null;
                        task.hookTrimEnd = null;
                        task.hookSpeed = 1; 
                        task.hookTransition = 'none'; 
                        task.hookTransDuration = 0.5;
                        if (!task.hook) task.hook = {};
                        task.hook.enabled = false;
                        task.hook.path = '';
                        break;
                    case 'bg': task.bgPath = ''; task.videoPath = ''; task.bgSrcUrl = ''; task.bgMode = 'single'; task.bgClipPool = []; task.bgTransition = 'crossfade'; task.bgTransDur = 0.5; break;
                    case 'contentvideo': task.contentVideoPath = ''; task.contentVideoTrimStart = null; task.contentVideoTrimEnd = null; task.contentVideoScale = 100; task.contentVideoX = 'center'; task.contentVideoY = 'center'; break;
                    case 'tts_text': task.ttsText = ''; break;
                    case 'pip': task.pipPath = ''; break;
                    case 'audio': task.audioPath = ''; break;
                    case 'srt': task.srtPath = ''; task.aligned = false; break;
                    case 'txt': task.txtContent = ''; task.aligned = false; break;
                    case 'ai_script': task.aiScript = ''; break;
                    case 'bgm': task.bgmPath = ''; break;
                }
                _renderBatchTable();
                return;
            }
            // SRT Edit button
            const srtEditBtn = e.target.closest('.rbt-srt-edit-btn');
            if (srtEditBtn) {
                e.stopPropagation();
                const idx = parseInt(srtEditBtn.dataset.idx);
                _showSrtFileEditorModal(idx);
                return;
            }
            // TTS 生成按钮
            const ttsGenBtn = e.target.closest('.rbt-tts-gen-btn');
            if (ttsGenBtn) {
                e.stopPropagation();
                const idx = parseInt(ttsGenBtn.dataset.idx);
                _runSingleTTS(idx);
                return;
            }
            // 音频播放试听按钮
            const playBtn = e.target.closest('.rbt-table-play-btn');
            if (playBtn) {
                e.stopPropagation();
                const src = playBtn.dataset.src;
                if (!src) return;
                
                if (!window._rbtGlobalAudio) {
                    window._rbtGlobalAudio = new Audio();
                }
                
                const isPlayingThis = (playBtn.textContent === '⏸️');
                // 重置所有播放按钮图标
                document.querySelectorAll('.rbt-table-play-btn').forEach(btn => btn.textContent = '▶️');
                
                if (isPlayingThis) {
                    window._rbtGlobalAudio.pause();
                    window._rbtGlobalAudio.currentTime = 0;
                } else {
                    window._rbtGlobalAudio.src = 'file://' + src;
                    window._rbtGlobalAudio.play().catch(err => console.error('Audio play failed:', err));
                    playBtn.textContent = '⏸️';
                    window._rbtGlobalAudio.onended = () => { playBtn.textContent = '▶️'; };
                    window._rbtGlobalAudio.onerror = () => { playBtn.textContent = '▶️'; alert('播放失败！文件可能不存在或路径不合法'); };
                }
                return;
            }
        });
        // 双击放大编辑 及 双击文件单元格
        tbody.addEventListener('dblclick', (e) => {
            if (e.target.tagName === 'TEXTAREA' && e.target.classList.contains('rbt-textarea')) {
                if (e.target.disabled && e.target.classList.contains('rbt-txtcontent-input')) {
                    const idx = parseInt(e.target.dataset.idx);
                    const task = window._reelsState.tasks[idx];
                    if (task && task.srtPath) {
                        _showSrtFileEditorModal(idx);
                        return;
                    }
                }
                _showTextEditorModal(e.target);
                return;
            }
            const hookSet = e.target.closest('.rbt-hook-set');
            if (hookSet) {
                const row = hookSet.closest('.rbt-row');
                if (row) {
                    _openHookModal(parseInt(row.dataset.idx));
                }
                return;
            }
            const coverSet = e.target.closest('.rbt-cover-set');
            if (coverSet) {
                const row = coverSet.closest('.rbt-row');
                if (row) {
                    _openCoverModal(parseInt(row.dataset.idx));
                }
                return;
            }
            // 双击文件单元格 → 选择文件
            const cell = e.target.closest('.rbt-droppable');
            if (cell && cell.dataset.field !== 'hook' && cell.dataset.field !== 'cover_media' && cell.dataset.field !== 'cover_text') {
                const row = cell.closest('.rbt-row');
                if (!row) return;
                const idx = parseInt(row.dataset.idx);
                const field = cell.dataset.field;
                _pickSingleFile(idx, field);
                return;
            }
            // 双击配乐单元格 → 选择配乐文件
            const bgmPick = e.target.closest('.rbt-bgm-pick');
            if (bgmPick) {
                const idx = parseInt(bgmPick.dataset.idx);
                _batchTableState._bgmBatchMode = false;
                _batchTableState._bgmSingleIdx = idx;
                container.querySelector('#rbt-file-bgm').click();
                return;
            }
        });
    }
}

// ═══════════════════════════════════════════════════════
// 5.4 Multi-column Paste Modal
// ═══════════════════════════════════════════════════════
function _showMultiColumnPasteModal(tsvRows, startIdx, initialFieldCategory = null) {
    let wrap = document.getElementById('rbt-multicol-paste-modal');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'rbt-multicol-paste-modal';
        wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
        
        const content = document.createElement('div');
        content.style.cssText = 'width:90%;max-width:900px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);max-height:85vh;';
        
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:12px;';
        header.innerHTML = '<h3 style="margin:0;color:var(--accent);font-size:18px;">📊 多列数据粘贴向导</h3>';
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:20px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { wrap.style.display = 'none'; };
        header.appendChild(closeBtn);
        
        const bodyContent = document.createElement('div');
        bodyContent.id = 'rbt-multicol-body';
        bodyContent.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column;gap:12px;padding-right:8px;';
        
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;border-top:1px solid #333;padding-top:16px;margin-top:8px;';
        
        const hint = document.createElement('span');
        hint.id = 'rbt-multicol-hint';
        hint.style.cssText = 'color:#aaa;font-size:13px;flex:1;';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:14px;';
        cancelBtn.onclick = () => { wrap.style.display = 'none'; };
        
        const exeBtn = document.createElement('button');
        exeBtn.innerText = '✅ 确认导入';
        exeBtn.id = 'rbt-multicol-exec';
        exeBtn.style.cssText = 'padding:8px 24px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:bold;';
        
        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(exeBtn);
        
        content.appendChild(header);
        content.appendChild(bodyContent);
        content.appendChild(footer);
        wrap.appendChild(content);
        document.body.appendChild(wrap);
    }
    
    const FIELD_OPTS = [
        { v: '', l: '-- 不导入 (忽略) --' },
        { v: 'exportName', l: '📝 导出命名' },
        { v: 'cover_text', l: '🌟 封面文案' },
        { v: 'aiScript', l: '🧠 AI 原文案' },
        { v: 'ttsText', l: '🤖 TTS文案' },
        { v: 'ttsVoiceId', l: '🗣️ TTS音色' },
        { v: 'txtContent', l: '📃 人声字幕' },
        { v: 'overlay_title', l: '🔠 覆层标题' },
        { v: 'overlay_body', l: '🔠 覆层内容' },
        { v: 'overlay_footer', l: '🔠 覆层结尾' },
        { v: 'scroll_title', l: '⏫ 滚动标题' },
        { v: 'scroll_body', l: '⏫ 滚动内容' }
    ];
    
    let maxCols = Math.max(...tsvRows.map(r => r.length));
    while(maxCols > 1) {
        let hasData = false;
        for (let r=0; r<tsvRows.length; r++) {
            if (tsvRows[r][maxCols-1] && tsvRows[r][maxCols-1].trim() !== '') {
                hasData = true; break;
            }
        }
        if (hasData) break;
        maxCols--;
    }

    const validRowsCount = tsvRows.filter(r => r.some(c => c && c.trim().length > 0)).length;
    document.getElementById('rbt-multicol-hint').innerText = `已检测到 ${maxCols} 列，共包含 ${validRowsCount} 行有效数据。`;
    
    const bodyStr = [];
    bodyStr.push(`<div style="display:grid;grid-template-columns:80px 180px 1fr;gap:12px;font-weight:bold;color:#888;padding-bottom:8px;border-bottom:1px solid #333;">
        <div>来源列</div>
        <div>目标列选择</div>
        <div>预览该列前3行数据</div>
    </div>`);
    
    for (let c = 0; c < maxCols; c++) {
        const previewItems = [];
        for (let r = 0; r < Math.min(3, tsvRows.length); r++) {
            const cell = (tsvRows[r][c] || '').trim();
            if (cell) previewItems.push(cell.length > 40 ? _escHtml(cell.substring(0, 40)) + '...' : _escHtml(cell));
        }
        let previewStr = previewItems.join('<br/><span style="color:#555;">---</span><br/>');
        if (!previewStr) previewStr = '<i style="color:#666">（空数据）</i>';
        
        let selectHtml = `<select class="rbt-multicol-select" data-col="${c}" style="width:100%;padding:8px;background:#222;color:#eee;border:1px solid #444;border-radius:4px;outline:none;font-size:13px;">`;
        for (const opt of FIELD_OPTS) {
            let selected = '';
            if (c === 0 && opt.v === initialFieldCategory) selected = 'selected';
            selectHtml += `<option value="${opt.v}" ${selected}>${opt.l}</option>`;
        }
        selectHtml += `</select>`;
        
        bodyStr.push(`<div style="display:grid;grid-template-columns:80px 180px 1fr;gap:12px;align-items:start;background:#1e1e1e;padding:12px;border-radius:6px;">
            <div style="font-size:16px;color:#ccc;font-weight:bold;padding-top:6px;">列 ${c + 1}</div>
            <div>${selectHtml}</div>
            <div style="font-size:12px;color:#999;line-height:1.4;background:#111;padding:8px;border-radius:4px;max-height:80px;overflow:hidden;text-overflow:ellipsis;">${previewStr}</div>
        </div>`);
    }
    
    document.getElementById('rbt-multicol-body').innerHTML = bodyStr.join('');
    
    const exeBtn = document.getElementById('rbt-multicol-exec');
    exeBtn.onclick = () => {
        const selects = document.querySelectorAll('.rbt-multicol-select');
        const mapping = [];
        selects.forEach(s => mapping.push(s.value));
        
        _execMultiColumnPaste(tsvRows, startIdx, mapping, maxCols);
        wrap.style.display = 'none';
    };
    
    wrap.style.display = 'flex';
}

function _execMultiColumnPaste(tsvRows, startIdx, colMappings, maxCols) {
    const state = window._reelsState;
    const container = _batchTableState.container;
    if (!state || !container) return;
    
    const validRows = tsvRows.filter(r => {
        for(let i=0; i<maxCols; i++){
            if(r[i] && r[i].trim().length > 0) return true;
        }
        return false;
    });
    if (validRows.length === 0) return;
    
    let overflown = validRows.length - (state.tasks.length - startIdx);
    if (overflown > 0) {
        if (!confirm(`剪贴板包含 ${validRows.length} 行数据，当前表格剩余空间不足。\n是否自动创建 ${overflown} 行新任务并继续向下填充？`)) {
            overflown = 0; // proceed with what fits
        } else {
            for (let i = 0; i < overflown; i++) {
                const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
                const newTask = {
                    baseName: taskName,
                    fileName: `${taskName}.mp4`,
                    bgPath: null, bgSrcUrl: null,
                    audioPath: null, srtPath: null,
                    segments: [],
                    videoPath: null, srcUrl: null,
                    overlays: [],
                    aligned: false,
                    bgScale: 100, bgDurScale: 100, audioDurScale: 100
                };
                state.tasks.push(newTask);
            }
        }
    }
    
    let filled = 0;
    for (let rIdx=0; rIdx < validRows.length; rIdx++) {
        const rowData = validRows[rIdx];
        const taskIdx = startIdx + rIdx;
        if (taskIdx >= state.tasks.length) break;
        
        const task = state.tasks[taskIdx];
        let rowModified = false;
        
        for (let cIdx = 0; cIdx < maxCols; cIdx++) {
            const fieldCategory = colMappings[cIdx];
            if (!fieldCategory) continue;
            
            let str = (rowData[cIdx] || '').trim();
            
            if (fieldCategory === 'aiScript') task.aiScript = str;
            else if (fieldCategory === 'ttsText') task.ttsText = str;
            else if (fieldCategory === 'txtContent') { task.txtContent = str; task.aligned = false; }
            else if (fieldCategory === 'ttsVoiceId') task.ttsVoiceId = str;
            else if (fieldCategory === 'exportName') task.exportName = str;
            else if (fieldCategory === 'cover_text') {
                if (!task.cover) task.cover = { enabled: true, overlays: [] };
                if (task.cover.overlays && task.cover.overlays.length > 0) task.cover.overlays[0].title_text = str;
                else task.cover.overlays = [{ title_text: str, body_text: '', footer_text: '', type: 'textcard' }];
            }
            else if (fieldCategory.startsWith('overlay_') || fieldCategory.startsWith('scroll_')) {
                _applyOverlayField(task, fieldCategory, str);
            }
            rowModified = true;
        }
        if(rowModified) filled++;
    }
    
    
    const scrollWrap = container.querySelector('.rbt-table-wrap');
    const scrollTop = scrollWrap ? scrollWrap.scrollTop : 0;
    const scrollLeft = scrollWrap ? scrollWrap.scrollLeft : 0;
    
    _skipNextApply = true; // 粘贴已直接写入 state，跳过 DOM→state 同步
    _renderBatchTable();
    
    const newScrollWrap = container.querySelector('.rbt-table-wrap');
    if (newScrollWrap) {
        newScrollWrap.scrollTop = scrollTop;
        newScrollWrap.scrollLeft = scrollLeft;
    }
    
    if (typeof showToast === 'function') {
        showToast(`✅ 多列粘贴成功：影响了 ${filled} 行。`, 'success');
    }
}

// ═══════════════════════════════════════════════════════
// 5.5 Text Editor Modal
// ═══════════════════════════════════════════════════════

async function _showSrtFileEditorModal(idx) {
    const task = window._reelsState.tasks[idx];
    if (!task || !task.srtPath) return;

    if (!window.electronAPI || !window.electronAPI.readFileText || !window.electronAPI.writeFileText) {
        alert('无法读写本地文件，当前环境不支持。');
        return;
    }

    let srtContent = '';
    try {
        srtContent = await window.electronAPI.readFileText(task.srtPath);
    } catch (e) {
        alert('读取 SRT 文件失败:\n' + e.message);
        return;
    }

    let editorWrap = document.getElementById('rbt-srt-editor-modal');
    if (!editorWrap) {
        editorWrap = document.createElement('div');
        editorWrap.id = 'rbt-srt-editor-modal';
        editorWrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);';
        
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        
        const title = document.createElement('h3');
        title.id = 'rbt-srt-editor-title';
        title.style.cssText = 'margin:0;color:#ff9800;font-size:16px;display:flex;align-items:center;gap:8px;';
        
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { editorWrap.remove(); };
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        
        const ta = document.createElement('textarea');
        ta.id = 'rbt-srt-editor-textarea';
        ta.style.cssText = 'width:100%;height:450px;background:#111;color:#eee;border:1px solid #333;border-radius:6px;padding:12px;font-size:14px;line-height:1.6;box-sizing:border-box;font-family:monospace;resize:vertical;';
        
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;';
        
        const hint = document.createElement('span');
        hint.style.cssText = 'color:#666;font-size:12px;flex:1;';
        hint.innerText = '小提示：直接修改文字即可。请不要破坏原有的时间轴格式。按 Esc 键退出，Ctrl+Enter 保存。';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消 (Esc)';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = () => { editorWrap.remove(); };
        
        const saveBtn = document.createElement('button');
        saveBtn.innerText = '保存到源文件 (Ctrl+Enter)';
        saveBtn.id = 'rbt-srt-editor-save';
        saveBtn.style.cssText = 'padding:8px 24px;background:#ff9800;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;';
        
        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        
        modalContent.appendChild(header);
        modalContent.appendChild(ta);
        modalContent.appendChild(footer);
        editorWrap.appendChild(modalContent);
        document.body.appendChild(editorWrap);
        
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorWrap.remove();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            }
        });
        
        modalContent.addEventListener('click', (e) => e.stopPropagation());
        editorWrap.addEventListener('click', () => { editorWrap.remove(); });
    } else {
        editorWrap.style.display = 'flex';
    }

    document.getElementById('rbt-srt-editor-title').innerHTML = `📝 修改外部 SRT 字幕 <span style="font-size:11px;color:#aaa;font-weight:400;margin-left:8px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${task.srtPath}</span>`;
    const textarea = document.getElementById('rbt-srt-editor-textarea');
    textarea.value = srtContent;
    
    document.getElementById('rbt-srt-editor-save').onclick = async () => {
        const newText = textarea.value;
        try {
            await window.electronAPI.writeFileText(task.srtPath, newText);
            editorWrap.remove();
            
            // Show a tiny success toast
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#2e7d32;color:#fff;padding:8px 16px;border-radius:20px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:999999;font-size:13px;font-weight:bold;animation:rbt-fade-in-out 2s forwards;';
            toast.innerText = '✅ SRT 原文件已保存';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);
            
            _renderBatchTable();
        } catch (e) {
            alert('保存修改失败:\n' + e.message);
        }
    };
}

function _showTextEditorModal(textareaEl) {
    let editorWrap = document.getElementById('rbt-text-editor-modal');
    if (!editorWrap) {
        editorWrap = document.createElement('div');
        editorWrap.id = 'rbt-text-editor-modal';
        editorWrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.85);display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
        
        const modalContent = document.createElement('div');
        modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);';
        
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
        
        const title = document.createElement('h3');
        title.id = 'rbt-text-editor-title';
        title.style.cssText = 'margin:0;color:var(--accent);font-size:16px;';
        title.innerText = '大屏幕文案编辑';
        
        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '✕';
        closeBtn.style.cssText = 'background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;padding:4px;';
        closeBtn.onclick = () => { editorWrap.style.display = 'none'; };
        
        header.appendChild(title);
        header.appendChild(closeBtn);
        
        const ta = document.createElement('textarea');
        ta.id = 'rbt-text-editor-textarea';
        ta.style.cssText = 'width:100%;height:450px;background:#111;color:#eee;border:1px solid #333;border-radius:6px;padding:12px;font-size:14px;line-height:1.6;box-sizing:border-box;font-family:monospace;resize:vertical;';
        
        const footer = document.createElement('div');
        footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;align-items:center;';
        
        const hint = document.createElement('span');
        hint.style.cssText = 'color:#666;font-size:12px;flex:1;';
        hint.innerText = '小提示：按 Esc 键可退出，Ctrl+Enter 可快速保存';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '取消 (Esc)';
        cancelBtn.style.cssText = 'padding:8px 20px;background:#333;color:#ccc;border:1px solid #444;border-radius:6px;cursor:pointer;font-size:13px;';
        cancelBtn.onclick = () => { editorWrap.style.display = 'none'; };
        
        const saveBtn = document.createElement('button');
        saveBtn.innerText = '保存内容 (Ctrl+Enter)';
        saveBtn.id = 'rbt-text-editor-save';
        saveBtn.style.cssText = 'padding:8px 24px;background:var(--accent);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:bold;';
        
        footer.appendChild(hint);
        footer.appendChild(cancelBtn);
        footer.appendChild(saveBtn);
        
        modalContent.appendChild(header);
        modalContent.appendChild(ta);
        modalContent.appendChild(footer);
        editorWrap.appendChild(modalContent);
        document.body.appendChild(editorWrap);
        
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                editorWrap.style.display = 'none';
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                saveBtn.click();
            }
        });
        
        // Block clicks from closing modal if clicking inside model content
        modalContent.addEventListener('click', (e) => e.stopPropagation());
        // Close modal if clicking outside
        editorWrap.addEventListener('click', () => { editorWrap.style.display = 'none'; });
    }

    const modalTitle = document.getElementById('rbt-text-editor-title');
    const modalTa = document.getElementById('rbt-text-editor-textarea');
    const saveBtn = document.getElementById('rbt-text-editor-save');
    
    let titleStr = "大屏幕文案编辑";
    if (textareaEl.classList.contains('rbt-txtcontent-input')) titleStr = "编辑【人声字幕】";
    else if (textareaEl.classList.contains('rbt-title-input')) titleStr = "编辑【覆层标题】";
    else if (textareaEl.classList.contains('rbt-body-input')) titleStr = "编辑【覆层内容】";
    else if (textareaEl.classList.contains('rbt-footer-input')) titleStr = "编辑【覆层结尾】";
    else if (textareaEl.classList.contains('rbt-scroll-title-input')) titleStr = "编辑【滚动标题】";
    else if (textareaEl.classList.contains('rbt-scroll-body-input')) titleStr = "编辑【滚动内容】";
    else if (textareaEl.classList.contains('rbt-ai-script-input')) titleStr = "编辑【AI 原文案】";
    modalTitle.innerText = titleStr;
    
    modalTa.value = textareaEl.value;
    editorWrap.style.display = 'flex';
    modalTa.focus();
    // highlight text gently
    modalTa.setSelectionRange(modalTa.value.length, modalTa.value.length);
    
    saveBtn.onclick = () => {
        textareaEl.value = modalTa.value;
        // manually dispatch events so batch system picks it up immediately
        textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        textareaEl.dispatchEvent(new Event('change', { bubbles: true }));
        editorWrap.style.display = 'none';
    };
}

function _showDiffModal(origText, newText, field, taskIdx) {
    let wrap = document.getElementById('rbt-diff-modal');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'rbt-diff-modal';
        wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:99999;display:flex;justify-content:center;align-items:center;';
        document.body.appendChild(wrap);
    }
    wrap.innerHTML = '';
    
    // Simple block tokenization
    const tokenize = str => str.split(/([a-zA-Z]+|[\u4e00-\u9fa5]|\s+|\[.*?\]|<.*?>)/).filter(Boolean);
    const a = tokenize(origText || '');
    const b = tokenize(newText || '');
    
    // To prevent JS out of memory or stack error for giant blocks
    let diffTokens = [];
    if (a.length > 3000 || b.length > 3000) {
        diffTokens = [{val: '\n⚠️ 文本太长，无法进行高亮对比。请直接肉眼比对以下结果：\n\n【当前文本】\n' + newText + '\n\n【AI 原文案】\n' + origText, type: 'del'}];
    } else {
        const m = a.length, n = b.length;
        const dp = Array(m + 1);
        for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
        
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        
        let i = m, j = n;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
                diffTokens.unshift({ val: b[j - 1], type: 'eq' });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                diffTokens.unshift({ val: b[j - 1], type: 'add' });
                j--;
            } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
                diffTokens.unshift({ val: a[i - 1], type: 'del' });
                i--;
            }
        }
    }
    
    // Initialize interaction state
    diffTokens.forEach(t => {
        if (t.type === 'eq') {
            t.inResult = true;
        } else if (t.type === 'add') {
            // If the user manually added a tag or formatting, WE MUST PRESERVE IT default.
            t.inResult = true;

        } else if (t.type === 'del') {
            // AI deleted this from original text.
            // Punctuation, spaces, and tags from the original MUST be preserved automatically!
            if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                t.inResult = true; 
            } else {
                t.inResult = false; // Real deleted words default to dropped, must click to restore.
            }
        }
    });

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;overflow-y:auto;line-height:1.6;font-size:15px;white-space:pre-wrap;font-family:monospace;padding:12px;background:#111;border-radius:6px;border:1px solid #333;';
    
    function renderDiff() {
        let html = '';
        diffTokens.forEach((t, i) => {
            if (t.type === 'eq') {
                html += _escHtml(t.val);
            } else if (t.type === 'add') {
                if (/^\[.*?\]$|^<.*?>$/.test(t.val)) {
                   html += `<span style="color:#aaa;" title="已保留您手动添加的标签">${_escHtml(t.val)}</span>`;
                } else if (/(^\s+$)/.test(t.val)) {
                   html += t.val; 
                } else if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                   html += `<span style="color:#aaa;" title="已保留您手动修改的标点">${_escHtml(t.val)}</span>`;
                } else {
                   if (t.inResult) {
                       html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(74,222,128,0.3);color:#4ade80;text-decoration:underline;" title="点击抛弃该词 (恢复原文)">${_escHtml(t.val)}</span>`;
                   } else {
                       html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(0,0,0,0.5);color:#555;text-decoration:line-through;" title="重新选中此词">${_escHtml(t.val)}</span>`;
                   }
                }
            } else if (t.type === 'del') {
                if (/^\[.*?\]$|^<.*?>$/.test(t.val)) {
                   html += `<span style="color:#aaa;" title="已自动保留该原文标签">${_escHtml(t.val)}</span>`;
                } else if (/(^\s+$)/.test(t.val)) {
                   html += t.val; 
                } else if (/^[^a-zA-Z0-9\u4e00-\u9fa5]+$/.test(t.val)) {
                   html += `<span style="color:#aaa;">${_escHtml(t.val)}</span>`;
                } else {
                   if (!t.inResult) {
                       html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(239,68,68,0.3);color:#ef4444;text-decoration:line-through;" title="点击恢复此词">${_escHtml(t.val)}</span>`;
                   } else {
                       html += `<span class="rbt-diff-tok" data-idx="${i}" style="cursor:pointer;background:rgba(234,179,8,0.3);color:#eab308;border-bottom:2px solid #eab308;" title="取消恢复">${_escHtml(t.val)}</span>`;
                   }
                }
            }
        });
        body.innerHTML = html.replace(/\n/g, '<br/>');
    }
    
    body.addEventListener('click', e => {
        const span = e.target.closest('.rbt-diff-tok');
        if (span) {
            const idx = parseInt(span.dataset.idx);
            const t = diffTokens[idx];
            t.inResult = !t.inResult;
            // auto-restore surrounding whitespace if restoring a deleted word
            if (t.inResult && t.type === 'del') {
                if (idx > 0 && /(^\s+$)/.test(diffTokens[idx-1].val) && diffTokens[idx-1].type === 'del') {
                    diffTokens[idx-1].inResult = true;
                }
                if (idx < diffTokens.length - 1 && /(^\s+$)/.test(diffTokens[idx+1].val) && diffTokens[idx+1].type === 'del') {
                    diffTokens[idx+1].inResult = true;
                }
            }
            // auto-reject surrounding whitespace if rejecting an added word
            if (!t.inResult && t.type === 'add') {
                if (idx > 0 && /(^\s+$)/.test(diffTokens[idx-1].val) && diffTokens[idx-1].type === 'add') {
                    diffTokens[idx-1].inResult = false;
                }
                if (idx < diffTokens.length - 1 && /(^\s+$)/.test(diffTokens[idx+1].val) && diffTokens[idx+1].type === 'add') {
                    diffTokens[idx+1].inResult = false;
                }
            }
            renderDiff();
        }
    });

    renderDiff();

    const modalContent = document.createElement('div');
    modalContent.style.cssText = 'width:80%;max-width:800px;background:#181818;border:1px solid var(--border-color);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;box-shadow:0 12px 32px rgba(0,0,0,0.8);color:#eee;max-height:80vh;';
    
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:10px;';
    header.innerHTML = `<h3 style="margin:0;color:#ffb74d;">🔍 原文比对 (文本篡改高亮)</h3>
                        <button id="rbt-diff-close" style="background:transparent;border:none;color:#aaa;font-size:18px;cursor:pointer;">✕</button>`;
    
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#888;display:flex;gap:16px;align-items:center;';
    hint.innerHTML = `
        <span><span style="color:#4ade80;text-decoration:underline;">绿色下划线</span> = 当前多出来的词 (或改错的词)</span>
        <span><span style="color:#ef4444;text-decoration:line-through;">红色删除线</span> = 被悄悄删掉的词 (原文)</span>
        <span style="margin-left:auto;color:#3b82f6;font-weight:bold;">💡 互动提示：直接点击高亮的词即可一键恢复或剔除！</span>
    `;

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;margin-top:10px;';
    footer.innerHTML = `
        <button id="rbt-diff-restore" style="padding:10px 24px;background:#374151;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;">🔄 强制还原为原文</button>
        <button id="rbt-diff-apply" style="padding:10px 24px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:14px;box-shadow:0 4px 12px rgba(59,130,246,0.4);">✅ 应用并覆盖到表格</button>
    `;
    
    modalContent.appendChild(header);
    modalContent.appendChild(hint);
    modalContent.appendChild(body);
    modalContent.appendChild(footer);
    wrap.appendChild(modalContent);
    
    wrap.style.display = 'flex';
    
    wrap.querySelector('#rbt-diff-close').onclick = () => wrap.style.display = 'none';
    
    wrap.querySelector('#rbt-diff-restore').onclick = () => {
        const task = window._reelsState.tasks[taskIdx];
        if (!task || !task.aiScript) return;
        const finalText = task.aiScript;
        if (field === 'txt') {
            task.txtContent = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-txtcontent-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                    ta.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        } else if (field === 'tts') {
            task.ttsText = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-tts-text-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                    ta.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        }
        wrap.style.display = 'none';
        
        // Full reset of table row to ensure absolutely zero weird state bugs
        if (typeof _renderBatchTable === 'function') setTimeout(_renderBatchTable, 50);
    };
    
    wrap.querySelector('#rbt-diff-apply').onclick = () => {
        const finalText = diffTokens.filter(t => t.inResult).map(t => t.val).join('');
        const task = window._reelsState.tasks[taskIdx];
        if (field === 'txt' && task) {
            task.txtContent = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-txtcontent-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                    ta.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        } else if (field === 'tts' && task) {
            task.ttsText = finalText;
            const tr = document.querySelector(`tr.rbt-row[data-idx="${taskIdx}"]`);
            if (tr) {
                const ta = tr.querySelector('.rbt-tts-text-input');
                if (ta) {
                    ta.value = finalText;
                    ta.dispatchEvent(new Event('input', {bubbles: true}));
                    ta.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        }
        wrap.style.display = 'none';
        
        if (typeof _renderBatchTable === 'function') setTimeout(_renderBatchTable, 50);
    };
    
    wrap.onclick = (e) => { if (e.target === wrap) wrap.style.display = 'none'; };
}

// ═══════════════════════════════════════════════════════
// 6. Apply changes from table → tasks
// ═══════════════════════════════════════════════════════

function _applyBatchTableChanges() {
    const container = _batchTableState.container;
    if (!container) return;
    const state = window._reelsState;
    if (!state) return;

    const titleInputs = container.querySelectorAll('.rbt-title-input');
    const bodyInputs = container.querySelectorAll('.rbt-body-input');
    const footerInputs = container.querySelectorAll('.rbt-footer-input');
    const cardTplSelects = container.querySelectorAll('.rbt-card-tpl-select');

    titleInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && (!task.overlays || !task.overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === '')))) return;
        _applyOverlayField(task, 'overlay_title', el.value);
    });

    bodyInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && (!task.overlays || !task.overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === '')))) return;
        _applyOverlayField(task, 'overlay_body', el.value);
    });

    footerInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (el.value.trim() === '' && (!task.overlays || !task.overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === '')))) return;
        _applyOverlayField(task, 'overlay_footer', el.value);
    });

    // ── 滚动字幕列 ──
    const scrollTitleInputs = container.querySelectorAll('.rbt-scroll-title-input');
    const scrollBodyInputs = container.querySelectorAll('.rbt-scroll-body-input');

    scrollTitleInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const val = el.value.trim();
        let scrollOv = (task.overlays || []).find(o => o && o.type === 'scroll');
        if (!scrollOv && val) {
            const ReelsOverlay = window.ReelsOverlay;
            if (ReelsOverlay) {
                scrollOv = ReelsOverlay.createScrollOverlay({
                    scroll_title: val, content: '', start: 0, end: 9999,
                });

                if (!task.overlays) task.overlays = [];
                task.overlays.push(scrollOv);
            }
        } else if (scrollOv) {
            scrollOv.scroll_title = el.value;
        }
    });

    scrollBodyInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const val = el.value.trim();
        let scrollOv = (task.overlays || []).find(o => o && o.type === 'scroll');
        if (!scrollOv && val) {
            const ReelsOverlay = window.ReelsOverlay;
            if (ReelsOverlay) {
                scrollOv = ReelsOverlay.createScrollOverlay({
                    scroll_title: '', content: val, start: 0, end: 9999,
                });
                if (!task.overlays) task.overlays = [];
                task.overlays.push(scrollOv);
            }
        } else if (scrollOv) {
            scrollOv.content = el.value;
        }
    });

    // ── 封面卡片文案 ──
    const coverTextInputs = container.querySelectorAll('.rbt-cover-text-input');
    coverTextInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        if (!task.cover) return; // 只当封面启用或创建时绑定
        
        const overlays = task.cover.overlays || [];
        if (overlays.length > 0) {
            overlays[0].title_text = el.value;
        } else if (el.value.trim() !== '') {
            const textOvl = window.ReelsOverlay ? window.ReelsOverlay.createTextCardOverlay({ start: 0, end: 9999 }) : { title_text: el.value, body_text: '', footer_text: '', type: 'textcard' };
            textOvl.title_text = el.value;
            task.cover.overlays = [textOvl];
        }
    });


    // 自定义时长
    const durInputs = container.querySelectorAll('.rbt-dur-input');
    durInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const v = parseFloat(el.value) || 0;
        task.customDuration = v > 0 ? v : 0;
    });

    // 导出命名
    container.querySelectorAll('.rbt-exportname-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.exportName = el.value.trim();
    });

    // 背景缩放
    container.querySelectorAll('.rbt-bgscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgScale = parseInt(el.value) || 100;
    });

    // 背景时长缩放
    container.querySelectorAll('.rbt-bgdurscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgDurScale = parseInt(el.value) || 100;
    });

    // 音频时长缩放
    container.querySelectorAll('.rbt-audiodurscale-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.audioDurScale = parseInt(el.value) || 100;
    });

    // TTS 文案
    container.querySelectorAll('.rbt-tts-text-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.ttsText = el.value;
    });

    // TTS 音色 ID
    container.querySelectorAll('.rbt-tts-voice-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.ttsVoiceId = el.value;
    });

    // AI 原文案
    container.querySelectorAll('.rbt-ai-script-input').forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (task) task.aiScript = el.value;
    });

    // 人声字幕（用于字幕对齐）
    const txtContentInputs = container.querySelectorAll('.rbt-txtcontent-input');
    txtContentInputs.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const newContent = el.value.trim();
        if (newContent !== (task.txtContent || '').trim()) {
            task.txtContent = newContent;
            task.aligned = false; // 内容变了重置对齐状态
        }
    });

    // 覆盖层组预设 
    // 字幕模板已通过 _openStyledPresetPicker 实时更新到了 task._subtitlePreset

    // 覆盖层组预设
    cardTplSelects.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        const presetName = el.value;
        if (presetName && task._overlayPresetName !== presetName) {
            const result = _applyAndVerifyOverlayGroupPresetToTask(task, presetName);
            if (!result.ok) {
                console.warn(`[BatchTable] 第 ${idx + 1} 行覆层预设未通过校验:`, result.reason);
            }
        } else if (!presetName && task._overlayPresetName) {
            task._overlayPresetName = '';
        }
    });

    // 配乐音量
    const bgmVols = container.querySelectorAll('.rbt-bgm-vol');
    bgmVols.forEach(el => {
        const idx = parseInt(el.dataset.idx);
        const task = state.tasks[idx];
        if (!task) return;
        task.bgmVolume = parseInt(el.value) || 0;
    });

    // 刷新任务列表
    if (typeof _renderTaskList === 'function') _renderTaskList();

    // 同步当前选中任务的覆层到 overlayMgr
    const selIdx = state.selectedIdx;
    const selTask = state.tasks[selIdx];
    if (selTask && state.overlayProxy && state.overlayProxy.overlayMgr) {
        _syncSelectedTaskOverlayMgrIfNeeded(selIdx);
    }
}

// ═══════════════════════════════════════════════════════
// 7. Paste from Google Sheets
// ═══════════════════════════════════════════════════════

async function _batchPasteFromSheet() {
    // ── 第一步：让用户选模式 ──
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    // ── 第二步：获取文本 ──
    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const rows = _parseBatchTSV(raw);
    if (!rows.length) {
        alert('未检测到有效数据');
        return;
    }

    const isSingleColumn = rows.every(r => r.length === 1);
    let splitMode = 0;
    if (isSingleColumn) {
        const modeStr = await _showSplitPromptDialog('检测到您粘贴的内容只有一列。\\n如果这列内容内部自带多行文本，你可以选用以下格式快速智能拆分：');
        if (modeStr === '2') splitMode = 2;
        else if (modeStr === '3') splitMode = 3;
    }

    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;

    if (splitMode > 0) {
        let hasErrors = true;
        while (hasErrors) {
            let badRows = [];
            for (let i = 0; i < rows.length; i++) {
                const rowText = rows[i][0] || '';
                const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0 && ((splitMode === 2 && lines.length < 2) || (splitMode === 3 && lines.length < 3))) {
                    badRows.push({ index: i, text: rowText });
                }
            }
            if (badRows.length === 0) {
                hasErrors = false;
                break;
            }
            const newTexts = await _showBatchEditDialog(badRows, splitMode, rows.length);
            if (!newTexts) return;
            for (const ans of newTexts) {
                if (ans.skip) rows[ans.index][0] = '';
                else rows[ans.index][0] = ans.text;
            }
        }
    }

    // 解析每行数据
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let title = '', body = '', footer = '';
        if (splitMode > 0) {
            let rowText = row[0] || '';
            let lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length === 0) continue;

            if (splitMode === 2) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 2) body = lines.slice(1).join('\n');
            } else if (splitMode === 3) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 3) {
                    footer = lines[lines.length - 1];
                    body = lines.slice(1, lines.length - 1).join('\n');
                } else if (lines.length === 2) {
                    body = lines[1];
                }
            }
        } else {
            if (row.length >= 4) {
                // 四列格式：名称 | 标题 | 内容 | 结尾
                title = row[1] || '';
                body = row[2] || '';
                footer = row[3] || '';
            } else if (row.length >= 3) {
                // 三列格式：标题 | 内容 | 结尾
                title = row[0] || '';
                body = row[1] || '';
                footer = row[2] || '';
            } else {
                // 两列/单列格式：标题 | 内容
                title = row[0] || '';
                body = row[1] || '';
            }
        }
        if (!title && !body && !footer) continue;
        entries.push({ title, body, footer });
    }

    if (!entries.length) {
        alert('未检测到有效文案数据');
        return;
    }

    let filled = 0, created = 0;

    if (mode === 'fill') {
        // ═══ 补全模式：只填没有文案的空行 ═══
        let entryIdx = 0;
        for (let i = 0; i < state.tasks.length && entryIdx < entries.length; i++) {
            const task = state.tasks[i];
            const ov = (task.overlays && task.overlays.length > 0) ? task.overlays[0] : null;
            // 判断是不是空文案（title 和 body 都空，或者是默认占位符）
            const titleVal = ov ? (ov.title_text || '') : '';
            const bodyVal = ov ? (ov.body_text || '') : '';
            const isDefault = (t) => !t || t === '标题文字' || t === '内容文字';
            const isEmpty = isDefault(titleVal) && isDefault(bodyVal);

            if (isEmpty) {
                _setTaskText(task, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, entries[entryIdx].footer);
                entryIdx++;
                filled++;
            }
        }
        // 剩余的追加为新行
        while (entryIdx < entries.length) {
            _createNewTextRow(state, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay, entries[entryIdx].footer);
            entryIdx++;
            created++;
        }

    } else if (mode === 'new') {
        // ═══ 添加新行模式：全部新建 ═══
        for (const entry of entries) {
            _createNewTextRow(state, entry.title, entry.body, ReelsOverlay, entry.footer);
            created++;
        }

    } else if (mode === 'overwrite') {
        // ═══ 覆盖模式：从第1行开始往下覆盖 ═══
        for (let i = 0; i < entries.length; i++) {
            if (i < state.tasks.length) {
                _setTaskText(state.tasks[i], entries[i].title, entries[i].body, ReelsOverlay, entries[i].footer);
                filled++;
            } else {
                _createNewTextRow(state, entries[i].title, entries[i].body, ReelsOverlay, entries[i].footer);
                created++;
            }
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 粘贴完成：${parts.join('，')}`);
}

async function _batchPasteScrollFromSheet() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const rows = _parseBatchTSV(raw);
    if (!rows.length) {
        alert('未检测到有效数据');
        return;
    }

    const isSingleColumn = rows.every(r => r.length === 1);
    let splitMode = 0;
    if (isSingleColumn) {
        const modeStr = await _showSplitPromptDialog('检测到您粘贴的内容只有一列且支持滚动。\\n如果单列内容有多行文本，你可以套用智能格式提取：');
        if (modeStr === '2') splitMode = 2;
        else if (modeStr === '3') splitMode = 3;
    }

    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;

    if (splitMode > 0) {
        let hasErrors = true;
        while (hasErrors) {
            let badRows = [];
            for (let i = 0; i < rows.length; i++) {
                const rowText = rows[i][0] || '';
                const lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
                if (lines.length > 0 && ((splitMode === 2 && lines.length < 2) || (splitMode === 3 && lines.length < 3))) {
                    badRows.push({ index: i, text: rowText });
                }
            }
            if (badRows.length === 0) {
                hasErrors = false;
                break;
            }
            const newTexts = await _showBatchEditDialog(badRows, splitMode, rows.length);
            if (!newTexts) return;
            for (const ans of newTexts) {
                if (ans.skip) rows[ans.index][0] = '';
                else rows[ans.index][0] = ans.text;
            }
        }
    }

    // 解析每行数据
    const entries = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        let title = '', body = '';
        if (splitMode > 0) {
            let rowText = row[0] || '';
            let lines = rowText.split('\n').map(l => l.trim()).filter(l => l);
            if (lines.length === 0) continue;

            if (splitMode === 2) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 2) body = lines.slice(1).join('\n');
            } else if (splitMode === 3) {
                if (lines.length >= 1) title = lines[0];
                if (lines.length >= 3) {
                    body = lines.slice(1, lines.length - 1).join('\n');
                } else if (lines.length === 2) {
                    body = lines[1];
                }
            }
        } else {
            if (row.length >= 3) {
                title = row[1] || '';
                body = row[2] || '';
            } else if (row.length === 2) {
                title = row[0] || '';
                body = row[1] || '';
            } else {
                body = row[0] || ''; // 单列时不提取title，默认全做body
            }
        }
        if (!title && !body) continue;
        entries.push({ title, body });
    }

    if (!entries.length) {
        alert('未检测到有效滚动字幕数据');
        return;
    }

    let filled = 0, created = 0;

    if (mode === 'fill') {
        let entryIdx = 0;
        for (let i = 0; i < state.tasks.length && entryIdx < entries.length; i++) {
            const task = state.tasks[i];
            const scrollOv = (task.overlays || []).find(o => o && o.type === 'scroll');
            const isEmpty = !scrollOv || (!(scrollOv.scroll_title || '').trim() && !(scrollOv.content || '').trim());
            if (isEmpty) {
                _setTaskScrollText(task, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay);
                entryIdx++;
                filled++;
            }
        }
        while (entryIdx < entries.length) {
            _createNewScrollRow(state, entries[entryIdx].title, entries[entryIdx].body, ReelsOverlay);
            entryIdx++;
            created++;
        }
    } else if (mode === 'new') {
        for (const entry of entries) {
            _createNewScrollRow(state, entry.title, entry.body, ReelsOverlay);
            created++;
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < entries.length; i++) {
            if (i < state.tasks.length) {
                _setTaskScrollText(state.tasks[i], entries[i].title, entries[i].body, ReelsOverlay);
                filled++;
            } else {
                _createNewScrollRow(state, entries[i].title, entries[i].body, ReelsOverlay);
                created++;
            }
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 滚动字幕粘贴完成：${parts.join('，')}`);
}

// ═══════════════════════════════════════════════════════
// Column visibility settings (per tab, saved to localStorage)
// ═══════════════════════════════════════════════════════

const _RBT_COLUMNS = [
    { key: 'exportname', label: '📝 导出命名', default: true },
    { key: 'cover-media', label: '🌟 封面素材', default: true },
    { key: 'cover-text', label: '🌟 封面文案', default: true },
    { key: 'hook', label: '🪝 前置Hook', default: true },
    { key: 'bg', label: '🖼 背景素材', default: true },
    { key: 'bgscale', label: '🔍 背景缩放', default: true },
    { key: 'bgdurscale', label: '⏱️ 背景时长', default: true },
    { key: 'contentvideo', label: '🎬 内容视频', default: true },
    { key: 'cvtrim', label: '✂️ 裁切', default: true },
    { key: 'cvscale', label: '🔍 视频缩放', default: true },
    { key: 'cvpos', label: '📐 视频位置', default: true },
    { key: 'cvvol', label: '🔊 覆层音量', default: true },
    { key: 'pip', label: '🖼️ 图像覆层', default: true },
    { key: 'tts_text', label: '🤖 TTS文案', default: true },
    { key: 'tts_voice', label: '🗣 TTS音色', default: true },
    { key: 'audio', label: '🎙 人声音频层', default: true },
    { key: 'audiodurscale', label: '⏱️ 人声变速', default: true },
    { key: 'ai_script', label: '🧠 AI 原文案', default: true },
    { key: 'bgm', label: '🎵 配乐', default: true },
    { key: 'srt', label: '📝 字幕SRT', default: true },
    { key: 'txtcontent', label: '📃 人声对齐字幕（断行后）', default: true },
    { key: 'title', label: '📌 覆层标题', default: true },
    { key: 'body', label: '📌 覆层内容', default: true },
    { key: 'footer', label: '📌 覆层结尾', default: true },
    { key: 'scroll-title', label: '📜 滚动标题', default: true },
    { key: 'scroll-body', label: '📜 滚动内容', default: true },
    { key: 'dur', label: '⏱️ 时长(s)', default: true },
    { key: 'tpl', label: '🎬 字幕模板+覆层预设', default: true },
];

function _getColVisStorageKey() {
    const tabId = _batchTableState.activeTabId || 'default';
    return `rbt-col-vis-${tabId}`;
}

function _getColVisibility() {
    const key = _getColVisStorageKey();
    // 一次性迁移：将旧存储的列设置重置为全显示（版本号升级触发）
    const RESET_VERSION = 'v3-add-cover-export';
    const resetKey = key + '-reset-version';
    if (localStorage.getItem(resetKey) !== RESET_VERSION) {
        localStorage.removeItem(key);
        localStorage.setItem(resetKey, RESET_VERSION);
    }
    const saved = localStorage.getItem(key);
    // 始终以 _RBT_COLUMNS 的 default 为基准，合并已保存的设置
    const vis = {};
    for (const col of _RBT_COLUMNS) vis[col.key] = col.default;
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            for (const col of _RBT_COLUMNS) {
                if (col.key in parsed) vis[col.key] = parsed[col.key];
            }
        } catch (e) { }
    }
    return vis;
}

function _saveColVisibility(vis) {
    const key = _getColVisStorageKey();
    localStorage.setItem(key, JSON.stringify(vis));
}

/** 点击 AI 按钮时自动显示 TTS 相关列 */
function _ensureAIColumnsVisible() {
    const vis = _getColVisibility();
    let changed = false;
    for (const colKey of ['tts_text', 'tts_voice', 'ai_script']) {
        if (!vis[colKey]) {
            vis[colKey] = true;
            changed = true;
        }
    }
    if (changed) {
        _saveColVisibility(vis);
        _applyColVisibility();
    }
}

function _applyColVisibility() {
    const vis = _getColVisibility();
    // Remove old style
    let styleEl = document.getElementById('rbt-col-vis-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'rbt-col-vis-style';
        document.head.appendChild(styleEl);
    }
    const rules = [];
    for (const col of _RBT_COLUMNS) {
        if (col.key === 'tpl') {
            // tpl maps to two columns (字幕模板 + 覆层预设), both share .rbt-col-tpl
            if (!vis[col.key]) rules.push(`.rbt-col-tpl { display: none !important; }`);
        } else {
            if (!vis[col.key]) rules.push(`.rbt-col-${col.key} { display: none !important; }`);
        }
    }
    styleEl.textContent = rules.join('\n');
}

// ═══════════════════════════════════════════════════════
// 统一字幕模板样式预览选择器 (全局复用)
// ═══════════════════════════════════════════════════════

/**
 * 生成单个预设的带样式 HTML
 * @param {string} name - 预设名称
 * @param {object} presetsMap - { name: styleObj, ... }
 * @returns {string} HTML
 */
function _buildPresetStyledItemHTML(name, presetsMap) {
    try {
        const style = (presetsMap && presetsMap[name]) || {};
        const m = window.ReelsStyleEngine ? ReelsStyleEngine.mergeStyle(style) : { ...style };
        const tc = m.color_text || m.color || '#FFFFFF';
        const sc = m.color_outline || m.stroke_color || '#000000';
        const bw = m.border_width || m.stroke_width || 3;
        const useStk = m.use_stroke !== false && m.stroke !== false;
        const bgC = m.color_bg || m.bg_color || '#000000';
        const useBg = m.use_box || m.bg_enabled || false;
        const bgR = Math.round((m.box_radius || m.bg_radius || 8) * 0.4);
        
        let ts = 'none';
        if (useStk && bw > 0) {
            const s = Math.max(1, Math.round(bw * 0.5));
            ts = `${s}px 0 0 ${sc}, -${s}px 0 0 ${sc}, 0 ${s}px 0 ${sc}, 0 -${s}px 0 ${sc}, ${s}px ${s}px 0 ${sc}, -${s}px -${s}px 0 ${sc}`;
        }
        if (m.shadow_blur > 0) {
            const extra = `2px 2px ${m.shadow_blur}px ${m.color_shadow || '#000'}`;
            ts = ts === 'none' ? extra : ts + ', ' + extra;
        }
        
        let bgCss = '';
        if (useBg) {
            const bgGradCols = m.bg_gradient_colors || [];
            if (m.bg_gradient_enabled && bgGradCols.length >= 2) {
                bgCss = `background:linear-gradient(90deg,${bgGradCols.join(',')});`;
            } else {
                bgCss = `background:${bgC};`;
            }
            // Fix text alignment: apply negative left margin to offset the left padding
            bgCss += `border-radius:${bgR}px;padding:2px 8px;margin-left:-8px;`;
        }
        
        const fw = m.bold || m.font_weight >= 700 ? 'bold' : 'normal';
        const fsStyle = m.italic ? 'font-style:italic;' : '';
        const ffStyle = m.font_family ? `font-family:"${m.font_family}",sans-serif;` : '';
        const ttStyle = m.text_transform ? `text-transform:${m.text_transform};` : '';
        const lsStyle = m.letter_spacing ? `letter-spacing:${m.letter_spacing}px;` : '';
        
        const eName = _escHtml(name);
        
        // Accurate Preview for Karaoke/Dynamic Box
        let htmlName = '';
        if (m.karaoke_highlight || m.dynamic_box) {
            let splitIdx = eName.lastIndexOf('_');
            if (splitIdx === -1) splitIdx = eName.lastIndexOf('+');
            if (splitIdx === -1) splitIdx = eName.lastIndexOf('-');
            
            let part1, part2;
            if (splitIdx !== -1 && splitIdx < eName.length - 1) {
                part1 = eName.substring(0, splitIdx + 1); // includes delimiter
                part2 = eName.substring(splitIdx + 1);
            } else {
                const len = eName.length;
                part1 = eName.substring(0, Math.max(0, len - 3));
                part2 = eName.substring(Math.max(0, len - 3));
            }
            
            let highStyle = `color:${m.color_high || tc};`;
            if (m.dynamic_box) {
                const dynBg = m.color_high_bg || '#FFD700';
                const dynR = Math.round((m.dynamic_radius || 6) * 0.4);
                highStyle += `background:${dynBg};border-radius:${dynR}px;padding:1px 4px;margin:0 1px;`;
            }
            htmlName = `<span style="color:${tc};text-shadow:${ts};">${part1}</span><span style="${highStyle}text-shadow:${ts};">${part2}</span>`;
        } else {
            htmlName = `<span style="color:${tc};text-shadow:${ts};">${eName}</span>`;
        }

        return `<div class="rbt-sub-styled-item" data-val="${eName}" style="padding:5px 18px;cursor:pointer;border-bottom:1px solid #2a2a3e;">
            <span style="font-size:15px;font-weight:${fw};line-height:1.5;${bgCss}${fsStyle}${ffStyle}${ttStyle}${lsStyle}display:inline-block;">
                ${htmlName}
            </span>
        </div>`;
    } catch(e) {
        return `<div class="rbt-sub-styled-item" data-val="${_escHtml(name)}" style="padding:5px 18px;cursor:pointer;border-bottom:1px solid #2a2a3e;color:#ccc;font-size:13px;">${_escHtml(name)}</div>`;
    }
}

/**
 * 打开统一的字幕模板选择器弹窗（position:fixed 挂到 body，不会被裁切）
 * @param {HTMLElement} anchorEl - 触发元素，用于定位
 * @param {string} currentVal - 当前选中值
 * @param {function} onSelect - 回调 (selectedName) => void
 */
window._openStyledPresetPicker = _openStyledPresetPicker;
function _openStyledPresetPicker(anchorEl, currentVal, onSelect) {
    // 关闭已有弹窗
    const existing = document.getElementById('rbt-styled-preset-picker');
    if (existing) { existing.remove(); return; }

    let presetsMap = {};
    let names = [];
    let categorized = [];
    try {
        if (window.ReelsStyleEngine && ReelsStyleEngine.getPresetsByCategory) {
            const catData = ReelsStyleEngine.getPresetsByCategory();
            presetsMap = catData.presetsMap || {};
            categorized = catData.categorized || [];
            names = Object.keys(presetsMap);
        } else {
            const data = window.ReelsStyleEngine ? ReelsStyleEngine.loadSubtitlePresets() : { presets: {} };
            presetsMap = data.presets || {};
            names = Object.keys(presetsMap);
        }
    } catch(e) { }

    if (names.length === 0) {
        alert('暂无字幕预设。请在字幕面板中保存预设后再使用。');
        return;
    }

    const popup = document.createElement('div');
    popup.id = 'rbt-styled-preset-picker';

    // 定位：基于触发元素
    const rect = anchorEl.getBoundingClientRect();
    const panelW = 340;
    const panelMaxH = Math.min(500, window.innerHeight - 60);
    let left = Math.min(rect.left, window.innerWidth - panelW - 10);
    let top = rect.bottom + 4;
    // 如果下方空间不够，改为上方弹出
    if (top + panelMaxH > window.innerHeight) {
        top = Math.max(10, rect.top - panelMaxH - 4);
    }

    Object.assign(popup.style, {
        position: 'fixed',
        left: left + 'px',
        top: top + 'px',
        width: panelW + 'px',
        maxHeight: panelMaxH + 'px',
        overflowY: 'auto',
        zIndex: '99999',
        background: '#1a1a2e',
        border: '1px solid #444',
        borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        padding: '0',
    });

    // 搜索区
    const searchHtml = `
        <div style="padding:10px; border-bottom:1px solid #2a2a3e; background:rgba(0,0,0,0.2); position:sticky; top:0; z-index:10;">
            <input type="text" id="rbt-ssp-search" placeholder="搜索预设..." style="width:100%; box-sizing:border-box; background:#000; border:1px solid #555; border-radius:4px; color:#eee; font-size:12px; padding:6px; outline:none;" autocomplete="off">
        </div>
    `;

    // 默认项
    const defaultHtml = `
        <div class="rbt-sub-styled-item" data-val="" style="margin:8px 10px; padding:8px 12px; font-size:12px; color:#aaa; border:1px dashed #444; border-radius:6px; cursor:pointer; text-align:center; transition:background 0.2s;">
            -- 不使用/恢复默认 --
        </div>
    `;

    // 列表区 — 按分类折叠
    let listHtml = '<div id="rbt-ssp-list" style="padding-bottom:8px;">';
    if (categorized.length > 0) {
        for (const group of categorized) {
            const isUserPresets = group.category.includes('我的预设');
            listHtml += `<details class="rbt-ssp-category" ${isUserPresets ? 'open' : 'open'} style="margin:0;">
                <summary style="cursor:pointer;padding:8px 14px;font-size:12px;font-weight:700;color:#8af;background:rgba(74,158,255,0.05);border-bottom:1px solid #2a2a3e;user-select:none;position:sticky;top:0;z-index:5;">
                    ${_escHtml(group.category)} <span style="font-size:10px;color:#666;font-weight:400;">(${group.names.length})</span>
                </summary>
                <div class="rbt-ssp-cat-items">
                    ${group.names.map(n => _buildPresetStyledItemHTML(n, presetsMap)).join('')}
                </div>
            </details>`;
        }
    } else {
        // Fallback: flat list
        listHtml += names.map(n => _buildPresetStyledItemHTML(n, presetsMap)).join('');
    }
    listHtml += '</div>';

    popup.innerHTML = searchHtml + defaultHtml + listHtml;
    document.body.appendChild(popup);

    // 标记当前选中项
    if (currentVal) {
        const activeItem = popup.querySelector(`.rbt-sub-styled-item[data-val="${CSS.escape(currentVal)}"]`);
        if (activeItem) {
            activeItem.style.background = 'rgba(74,158,255,0.15)';
            activeItem.style.borderLeft = '3px solid #4a9eff';
        }
    }

    const searchInput = popup.querySelector('#rbt-ssp-search');
    const listContainer = popup.querySelector('#rbt-ssp-list');

    // 搜索逻辑（支持分类折叠）
    setTimeout(() => searchInput.focus(), 30);
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase();
        // Filter items
        listContainer.querySelectorAll('.rbt-sub-styled-item').forEach(el => {
            const val = (el.dataset.val || '').toLowerCase();
            el.style.display = val.includes(q) ? 'block' : 'none';
        });
        // Show/hide empty categories
        listContainer.querySelectorAll('.rbt-ssp-category').forEach(details => {
            const items = details.querySelectorAll('.rbt-sub-styled-item');
            const hasVisible = Array.from(items).some(el => el.style.display !== 'none');
            details.style.display = hasVisible ? 'block' : 'none';
            if (q && hasVisible) details.open = true;
        });
    });

    // 点击项 → 应用预设但不关闭（方便快速切换对比）
    let _activeItem = null;
    popup.querySelectorAll('.rbt-sub-styled-item').forEach(item => {
        item.addEventListener('click', () => {
            const val = item.dataset.val;
            // 更新选中高亮
            if (_activeItem) {
                _activeItem.style.background = 'transparent';
                _activeItem.style.borderLeft = '';
            }
            item.style.background = 'rgba(74,158,255,0.15)';
            item.style.borderLeft = '3px solid #4a9eff';
            _activeItem = item;
            if (onSelect) onSelect(val);
        });
        item.addEventListener('mouseenter', () => {
            if (item !== _activeItem) item.style.background = 'rgba(74,158,255,0.1)';
        });
        item.addEventListener('mouseleave', () => {
            if (item !== _activeItem) item.style.background = 'transparent';
        });
    });

    // 鼠标移开弹窗后延迟关闭
    let _closeTimer = null;
    popup.addEventListener('mouseleave', () => {
        _closeTimer = setTimeout(() => {
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
        }, 600);
    });
    popup.addEventListener('mouseenter', () => {
        if (_closeTimer) { clearTimeout(_closeTimer); _closeTimer = null; }
    });

    // 点击外部关闭
    const outsideHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) {
            popup.remove();
            document.removeEventListener('mousedown', outsideHandler);
        }
    };
    requestAnimationFrame(() => {
        document.addEventListener('mousedown', outsideHandler);
    });
}

function _showColumnSettingsPopup(anchor) {
    // Remove existing popup
    const existing = document.getElementById('rbt-col-settings-popup');
    if (existing) { existing.remove(); return; }

    const vis = _getColVisibility();
    const popup = document.createElement('div');
    popup.id = 'rbt-col-settings-popup';
    // Position near anchor
    const rect = anchor.getBoundingClientRect();
    const maxHeight = Math.max(200, window.innerHeight - rect.bottom - 16);
    
    popup.style.cssText = `position:fixed;z-index:100000;background:#141420;border:1px solid #2a2a4a;border-radius:10px;padding:16px;min-width:320px;max-width:380px;box-shadow:0 12px 40px rgba(0,0,0,0.7);` +
                          `top:${rect.bottom + 4}px;right:${window.innerWidth - rect.right}px;max-height:${maxHeight}px;overflow-y:auto;`;

    // ── 预设方案定义 ──
    const presets = [
        {
            name: '🎥 HeyGen匹配字幕',
            desc: '背景视频 + 根据背景素材声音对齐字幕',
            cols: ['bg','bgscale','bgdurscale','srt','txtcontent','dur','tpl','exportname']
        },
        {
            name: '🎨 无字幕动画Reels',
            desc: '背景素材 + 覆层(标题/内容/结尾) + 图像覆层 + 配乐',
            cols: ['bg','bgscale','bgdurscale','bgm','title','body','footer','dur','tpl','exportname']
        },
        {
            name: '📝 动态字幕(手动)',
            desc: '背景素材 + 手动提供人声音频/SRT/对齐字幕 + 配乐',
            cols: ['bg','bgscale','bgdurscale','audio','audiodurscale','bgm','srt','txtcontent','dur','tpl','exportname']
        },
        {
            name: '🤖 动态字幕(AI自动)',
            desc: '背景素材 + AI文案→TTS→字幕 全自动流水线 + 配乐',
            cols: ['bg','bgscale','bgdurscale','ai_script','tts_text','tts_voice','audio','audiodurscale','bgm','srt','txtcontent','dur','tpl','exportname']
        },
        {
            name: '🔄 滚动字幕(手动)',
            desc: '背景素材 + 手动提供人声音频 + 滚动标题/内容 + 配乐',
            cols: ['bg','bgscale','bgdurscale','audio','audiodurscale','bgm','scroll-title','scroll-body','dur','tpl','exportname']
        },
        {
            name: '🔄 滚动字幕(AI自动)',
            desc: '背景素材 + AI文案→TTS→人声 + 滚动标题/内容 + 配乐',
            cols: ['bg','bgscale','bgdurscale','ai_script','tts_text','tts_voice','audio','audiodurscale','bgm','scroll-title','scroll-body','dur','tpl','exportname']
        },
        {
            name: '✂️ 达芬奇剪辑',
            desc: '背景 + 内容视频(裁切/缩放/位置/音量) + 覆层文案 + 配乐',
            cols: ['bg','bgscale','bgdurscale','contentvideo','cvtrim','cvscale','cvpos','cvvol','bgm','title','body','footer','dur','tpl','exportname']
        },
        {
            name: '🎙 加Hook版口播',
            desc: 'Hook + 封面 + 背景 + 全套人声/字幕 + 配乐',
            cols: ['hook','cover-media','cover-text','bg','bgscale','bgdurscale','ai_script','tts_text','tts_voice','audio','audiodurscale','bgm','srt','txtcontent','dur','tpl','exportname']
        }
    ];

    // ── 列分类 ──
    const colGroups = [
        { label: '封面', keys: ['cover-media','cover-text'] },
        { label: '素材 & 背景', keys: ['hook','bg','bgscale','bgdurscale','pip'] },
        { label: '🎬 内容视频', keys: ['contentvideo','cvtrim','cvscale','cvpos','cvvol'] },
        { label: 'AI 配音与文案', keys: ['ai_script','tts_text','tts_voice'] },
        { label: '音频', keys: ['audio','audiodurscale','bgm'] },
        { label: '字幕 & 文本', keys: ['srt','txtcontent'] },
        { label: '覆层文案', keys: ['title','body','footer'] },
        { label: '滚动字幕', keys: ['scroll-title','scroll-body'] },
        { label: '其他', keys: ['dur','tpl','exportname'] },
    ];

    // Build column label map
    const colLabelMap = {};
    for (const col of _RBT_COLUMNS) colLabelMap[col.key] = col.label;

    let html = '<div style="font-size:13px;font-weight:600;color:#ddd;margin-bottom:10px;">⚙️ 列显示设置</div>';

    // ── Presets ──
    html += '<div style="margin-bottom:12px;">';
    html += '<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;margin-bottom:6px;">快捷预设（一键配置）</div>';
    html += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    for (let i = 0; i < presets.length; i++) {
        const p = presets[i];
        html += `<button class="rbt-col-preset-btn" data-preset="${i}" title="${p.desc}"
            style="padding:3px 10px;border-radius:4px;border:1px solid #333;background:#1e1e38;color:#ccc;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;"
            onmouseover="this.style.background='#2a2a5a';this.style.borderColor='var(--accent)';this.style.color='#fff'"
            onmouseout="this.style.background='#1e1e38';this.style.borderColor='#333';this.style.color='#ccc'"
        >${p.name}</button>`;
    }
    // 显示完整（全部列）按钮
    html += `<button id="rbt-col-preset-showall" title="显示所有列"
        style="padding:3px 10px;border-radius:4px;border:1px solid #50c878;background:rgba(80,200,120,0.1);color:#50c878;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap;font-weight:600;"
        onmouseover="this.style.background='rgba(80,200,120,0.25)';this.style.color='#6fea9d'"
        onmouseout="this.style.background='rgba(80,200,120,0.1)';this.style.color='#50c878'"
    >📋 显示完整</button>`;
    html += '</div></div>';

    // ── Categorized columns ──
    html += '<div style="border-top:1px solid #2a2a4a;padding-top:10px;">';
    for (const group of colGroups) {
        html += `<div style="margin-bottom:8px;">`;
        html += `<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;margin-bottom:4px;">${group.label}</div>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:3px 10px;">`;
        for (const key of group.keys) {
            const label = colLabelMap[key] || key;
            const checked = vis[key] !== false ? 'checked' : '';
            html += `<label style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:11px;color:#bbb;cursor:pointer;min-width:120px;">
                <input type="checkbox" class="rbt-col-vis-chk" data-col="${key}" ${checked} style="accent-color:var(--accent);margin:0;">
                ${label}
            </label>`;
        }
        html += `</div></div>`;
    }
    html += '</div>';

    // ── custom presets ──
    const CUSTOM_PRESET_KEY = 'rbt-col-custom-presets';
    const _loadCustomPresets = () => { try { return JSON.parse(localStorage.getItem(CUSTOM_PRESET_KEY) || '{}'); } catch(e) { return {}; } };
    const _saveCustomPresets = (p) => localStorage.setItem(CUSTOM_PRESET_KEY, JSON.stringify(p));

    const customPresets = _loadCustomPresets();
    const customNames = Object.keys(customPresets);
    html += '<div style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a4a;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    html += '<div style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;">我的预设</div>';
    html += '<button id="rbt-col-save-preset" style="font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid #4a9eff;background:transparent;color:#4a9eff;cursor:pointer;" title="保存当前列配置为自定义预设">💾 保存当前</button>';
    html += '</div>';
    if (customNames.length > 0) {
        html += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">';
        for (const name of customNames) {
            html += `<div style="display:inline-flex;align-items:center;gap:2px;background:#1e1e38;border:1px solid #333;border-radius:4px;padding:1px 2px 1px 8px;">
                <button class="rbt-col-custom-btn" data-custom-name="${_escHtml(name)}" style="border:none;background:transparent;color:#ccc;font-size:11px;cursor:pointer;padding:2px 4px;" title="加载预设">${_escHtml(name)}</button>
                <button class="rbt-col-custom-del" data-custom-name="${_escHtml(name)}" style="border:none;background:transparent;color:#f87171;font-size:10px;cursor:pointer;padding:2px 4px;line-height:1;" title="删除">✕</button>
            </div>`;
        }
        html += '</div>';
    } else {
        html += '<div style="font-size:10px;color:#555;margin-bottom:6px;padding:4px 0;">暂无自定义预设</div>';
    }
    html += '</div>';

    // ── Footer buttons ──
    html += `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #2a2a4a;display:flex;gap:8px;justify-content:space-between;align-items:center;">
        <div style="display:flex;gap:4px;">
            <button id="rbt-col-export" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#8af;cursor:pointer;" title="导出列配置为 JSON 文件">📤 导出</button>
            <button id="rbt-col-import" style="font-size:10px;padding:3px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#8af;cursor:pointer;" title="从 JSON 文件导入列配置">📥 导入</button>
            <input type="file" id="rbt-col-import-input" accept=".json" style="display:none;">
        </div>
        <div style="display:flex;gap:6px;">
            <button id="rbt-col-vis-all" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">全选</button>
            <button id="rbt-col-vis-none" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">全不选</button>
            <button id="rbt-col-vis-reset" style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;">恢复默认</button>
            <button id="rbt-col-vis-close" style="font-size:11px;padding:4px 10px;border-radius:4px;border:none;background:var(--accent);color:#000;cursor:pointer;font-weight:600;">完成</button>
        </div>
    </div>`;
    popup.innerHTML = html;
    document.body.appendChild(popup);

    // Helper: sync checkboxes with vis state
    const _syncCheckboxes = () => {
        popup.querySelectorAll('.rbt-col-vis-chk').forEach(chk => {
            chk.checked = vis[chk.dataset.col] !== false;
        });
    };

    // Event: preset buttons
    popup.querySelectorAll('.rbt-col-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = presets[parseInt(btn.dataset.preset)];
            // Turn all off first, then turn on only preset cols
            for (const col of _RBT_COLUMNS) vis[col.key] = false;
            for (const k of p.cols) vis[k] = true;
            _saveColVisibility(vis);
            _applyColVisibility();
            _syncCheckboxes();
        });
    });

    // Event: 显示完整（全部列）
    popup.querySelector('#rbt-col-preset-showall')?.addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = true;
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
    });

    // Event: checkbox change
    popup.querySelectorAll('.rbt-col-vis-chk').forEach(chk => {
        chk.addEventListener('change', () => {
            vis[chk.dataset.col] = chk.checked;
            _saveColVisibility(vis);
            _applyColVisibility();
        });
    });

    // Event: select all
    popup.querySelector('#rbt-col-vis-all').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = true;
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
    });

    // Event: select none
    popup.querySelector('#rbt-col-vis-none').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = false;
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
    });

    // Event: reset
    popup.querySelector('#rbt-col-vis-reset').addEventListener('click', () => {
        for (const col of _RBT_COLUMNS) vis[col.key] = col.default;
        _saveColVisibility(vis);
        _applyColVisibility();
        _syncCheckboxes();
    });

    // Event: close
    popup.querySelector('#rbt-col-vis-close').addEventListener('click', () => {
        popup.remove();
    });

    // ── 自定义预设事件 ──
    // 保存当前配置
    popup.querySelector('#rbt-col-save-preset')?.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:9999;border-radius:12px;';
        overlay.innerHTML = `
            <div style="background:#2d2d2d;padding:15px;border-radius:8px;border:1px solid #444;width:80%;max-width:300px;">
                <div style="color:#eee;font-size:13px;margin-bottom:8px;">请输入预设名称：</div>
                <input type="text" id="_col-preset-input" style="width:100%;box-sizing:border-box;background:#111;color:#fff;border:1px solid #555;padding:6px;border-radius:4px;outline:none;margin-bottom:12px;" />
                <div style="display:flex;justify-content:flex-end;gap:8px;">
                    <button id="_col-preset-cancel" style="padding:4px 10px;background:#444;color:#eee;border:none;border-radius:4px;cursor:pointer;font-size:12px;">取消</button>
                    <button id="_col-preset-confirm" style="padding:4px 10px;background:#4a9eff;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">保存</button>
                </div>
            </div>
        `;
        popup.appendChild(overlay);
        const input = overlay.querySelector('#_col-preset-input');
        input.focus();

        const closePrompt = () => overlay.remove();
        
        const confirmSave = () => {
            const name = input.value;
            if (!name || !name.trim()) {
                closePrompt();
                return;
            }
            const cp = _loadCustomPresets();
            const enabledCols = _RBT_COLUMNS.filter(c => vis[c.key]).map(c => c.key);
            cp[name.trim()] = enabledCols;
            _saveCustomPresets(cp);
            closePrompt();
            popup.remove();
            _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
            if (typeof showToast === 'function') showToast(`✅ 预设 "${name.trim()}" 已保存`, 'success');
        };

        overlay.querySelector('#_col-preset-cancel').onclick = closePrompt;
        overlay.querySelector('#_col-preset-confirm').onclick = confirmSave;
        input.onkeydown = (e) => { 
            if (e.key === 'Enter') confirmSave(); 
            if (e.key === 'Escape') closePrompt(); 
        };
    });

    // 加载自定义预设
    popup.querySelectorAll('.rbt-col-custom-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cp = _loadCustomPresets();
            const cols = cp[btn.dataset.customName];
            if (!cols) return;
            for (const col of _RBT_COLUMNS) vis[col.key] = false;
            for (const k of cols) vis[k] = true;
            _saveColVisibility(vis);
            _applyColVisibility();
            _syncCheckboxes();
        });
    });

    // 删除自定义预设
    popup.querySelectorAll('.rbt-col-custom-del').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.dataset.customName;
            if (!confirm(`确定删除预设 "${name}"？`)) return;
            const cp = _loadCustomPresets();
            delete cp[name];
            _saveCustomPresets(cp);
            popup.remove();
            _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
        });
    });

    // ── JSON 导出/导入 ──
    popup.querySelector('#rbt-col-export')?.addEventListener('click', () => {
        const exportData = {
            version: 1,
            type: 'rbt-col-visibility',
            columns: { ...vis },
            customPresets: _loadCustomPresets(),
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `列显示预设_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        if (typeof showToast === 'function') showToast('📤 列配置已导出', 'success');
    });

    const importInput = popup.querySelector('#rbt-col-import-input');
    popup.querySelector('#rbt-col-import')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.type !== 'rbt-col-visibility') throw new Error('格式不匹配');
                // 导入列配置
                if (data.columns) {
                    for (const col of _RBT_COLUMNS) {
                        if (col.key in data.columns) vis[col.key] = data.columns[col.key];
                    }
                    _saveColVisibility(vis);
                    _applyColVisibility();
                }
                // 导入自定义预设（合并）
                if (data.customPresets) {
                    const existing = _loadCustomPresets();
                    Object.assign(existing, data.customPresets);
                    _saveCustomPresets(existing);
                }
                popup.remove();
                _showColumnSettingsPopup(document.querySelector('[data-action="col-settings"]') || document.body);
                if (typeof showToast === 'function') showToast('📥 列配置已导入', 'success');
            } catch (err) {
                alert('导入失败: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // Click outside to close
    setTimeout(() => {
        const handler = (e) => {
            if (!popup.contains(e.target) && e.target !== anchor) {
                popup.remove();
                document.removeEventListener('mousedown', handler);
            }
        };
        document.addEventListener('mousedown', handler);
    }, 100);
}

// ═══════════════════════════════════════════════════════
// Multi-Clip Background Pool — 多素材随机拼接管理
// ═══════════════════════════════════════════════════════

function _showBgPoolDialog(taskIdx) {
    const state = window._reelsState;
    if (!state || !state.tasks[taskIdx]) return;
    const task = state.tasks[taskIdx];

    // Init fields if missing
    if (!task.bgClipPool) task.bgClipPool = [];
    if (!task.bgTransition) task.bgTransition = 'crossfade';
    if (!task.bgTransDur) task.bgTransDur = 0.5;
    if (!task.bgMode) task.bgMode = task.bgClipPool.length > 0 ? 'multi' : 'single';

    document.getElementById('rbt-bgpool-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-bgpool-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1a1a2e;border:1px solid #2a2a5a;border-radius:14px;padding:24px;width:580px;max-height:80vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.7);';

    const _renderPoolUI = () => {
        const pool = task.bgClipPool;
        const thumbsHtml = pool.map((p, i) => {
            const name = p.replace(/\\/g, '/').split('/').pop();
            const url = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(p) : `file://${p}`;
            const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(p);
            return `<div class="bgpool-item" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:#12122e;border:1px solid #2a2a4a;border-radius:6px;">
                ${isImg
                    ? `<img class="rbt-thumb-previewable" src="${_escHtml(url)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;cursor:zoom-in;">`
                    : `<video class="rbt-thumb-previewable" src="${_escHtml(url)}#t=1" preload="metadata" style="width:40px;height:40px;object-fit:cover;border-radius:4px;background:#000;cursor:zoom-in;"></video>`
                }
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;" title="${_escHtml(p)}">${_escHtml(name)}</span>
                <button class="bgpool-remove" data-pool-idx="${i}" style="width:20px;height:20px;border:1px solid #444;border-radius:4px;background:transparent;color:#f87171;font-size:12px;cursor:pointer;padding:0;line-height:18px;">✕</button>
            </div>`;
        }).join('');

        box.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <div style="font-size:15px;font-weight:700;color:#ddd;">🎞 多素材背景池 — 第 ${taskIdx + 1} 行</div>
                <button id="bgpool-close" style="width:28px;height:28px;border-radius:6px;border:1px solid #444;background:transparent;color:#aaa;font-size:14px;cursor:pointer;">✕</button>
            </div>

            <!-- 模式切换 -->
            <div style="display:flex;gap:8px;margin-bottom:14px;">
                <button class="bgpool-mode-btn" data-mode="single" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgMode === 'single' ? 'var(--accent)' : '#333'};background:${task.bgMode === 'single' ? 'rgba(78,205,196,0.15)' : '#12122e'};color:${task.bgMode === 'single' ? 'var(--accent)' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🔁 单素材循环<br><span style="font-size:10px;font-weight:400;">一个背景视频/图片循环播放</span>
                </button>
                <button class="bgpool-mode-btn" data-mode="multi" style="flex:1;padding:8px;border-radius:6px;border:1px solid ${task.bgMode === 'multi' ? '#b8a0ff' : '#333'};background:${task.bgMode === 'multi' ? 'rgba(100,60,200,0.15)' : '#12122e'};color:${task.bgMode === 'multi' ? '#b8a0ff' : '#888'};font-size:12px;cursor:pointer;font-weight:600;">
                    🎞 多素材拼接<br><span style="font-size:10px;font-weight:400;">从素材池随机组合，自动匹配时长</span>
                </button>
            </div>

            ${task.bgMode === 'multi' ? `
            <!-- 转场设置 -->
            <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px;padding:10px;background:#12122e;border:1px solid #2a2a4a;border-radius:8px;">
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">转场效果:</span>
                <select id="bgpool-transition" style="flex:1;padding:4px 8px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;outline:none;">
                    <option value="none" ${task.bgTransition === 'none' ? 'selected' : ''}>⚡ 无转场（硬切）</option>
                    <option value="crossfade" ${task.bgTransition === 'crossfade' ? 'selected' : ''}>✨ 交叉淡化</option>
                    <option value="fade_black" ${task.bgTransition === 'fade_black' ? 'selected' : ''}>⬛ 黑场过渡</option>
                    <option value="fade_white" ${task.bgTransition === 'fade_white' ? 'selected' : ''}>⬜ 白场过渡</option>
                    <option value="slide_left" ${task.bgTransition === 'slide_left' ? 'selected' : ''}>◀ 左滑入</option>
                    <option value="slide_right" ${task.bgTransition === 'slide_right' ? 'selected' : ''}>▶ 右滑入</option>
                    <option value="wipe" ${task.bgTransition === 'wipe' ? 'selected' : ''}>🔲 擦除</option>
                </select>
                <span style="font-size:11px;color:#aaa;white-space:nowrap;">时长:</span>
                <input type="number" id="bgpool-trans-dur" min="0.1" max="3" step="0.1" value="${task.bgTransDur || 0.5}"
                    style="width:55px;padding:4px;font-size:11px;background:#1e1e38;color:#ccc;border:1px solid #333;border-radius:4px;text-align:center;">
                <span style="font-size:10px;color:#666;">秒</span>
            </div>

            <!-- 素材池列表 -->
            <div style="margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                    <span style="font-size:12px;color:#aaa;font-weight:600;">素材池 (${pool.length}个)</span>
                    <div style="display:flex;gap:6px;">
                        <button id="bgpool-add-folder" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#8af;cursor:pointer;">📂 从文件夹导入</button>
                        <button id="bgpool-add-files" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#8af;cursor:pointer;">📄 选择文件</button>
                        <button id="bgpool-clear-all" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #553333;background:transparent;color:#f87171;cursor:pointer;">🗑 清空</button>
                    </div>
                </div>
                <div id="bgpool-list" style="display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;padding-right:4px;">
                    ${thumbsHtml || '<div style="text-align:center;padding:24px;color:#555;font-size:12px;">暂无素材，请从文件夹导入或拖拽文件到此处</div>'}
                </div>
            </div>

            <!-- 拖拽区域 -->
            <div id="bgpool-dropzone" style="border:2px dashed #333;border-radius:8px;padding:16px;text-align:center;color:#555;font-size:11px;margin-bottom:14px;transition:border-color .2s,color .2s;">
                🎬 拖拽视频/图片文件到此处添加到素材池
            </div>

            <!-- 批量应用 -->
            <div style="padding:10px;background:#12122e;border:1px solid #2a2a4a;border-radius:8px;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:11px;color:#aaa;">批量应用:</span>
                    <button id="bgpool-apply-selected" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">📋 应用到勾选行</button>
                    <button id="bgpool-apply-all" style="font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid #444;background:#1e1e38;color:#ccc;cursor:pointer;">📋 应用到所有行</button>
                </div>
            </div>
            ` : ''}

            <div style="display:flex;justify-content:flex-end;gap:8px;">
                <button id="bgpool-done" style="padding:6px 20px;border-radius:6px;border:none;background:var(--accent);color:#000;font-weight:600;font-size:12px;cursor:pointer;">完成</button>
            </div>

            <input type="file" id="bgpool-file-input" multiple accept="video/*,image/*" style="display:none;">
            <input type="file" id="bgpool-folder-input" webkitdirectory style="display:none;">
        `;

        // ── Events ──
        box.querySelector('#bgpool-close')?.addEventListener('click', () => overlay.remove());
        box.querySelector('#bgpool-done')?.addEventListener('click', () => {
            _renderBatchTable();
            overlay.remove();
        });

        // Mode switch
        box.querySelectorAll('.bgpool-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                task.bgMode = btn.dataset.mode;
                _renderPoolUI();
            });
        });

        // Transition settings
        box.querySelector('#bgpool-transition')?.addEventListener('change', (e) => {
            task.bgTransition = e.target.value;
        });
        box.querySelector('#bgpool-trans-dur')?.addEventListener('change', (e) => {
            task.bgTransDur = Math.max(0.1, Math.min(3, parseFloat(e.target.value) || 0.5));
        });

        // Remove clip
        box.querySelectorAll('.bgpool-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const pi = parseInt(btn.dataset.poolIdx);
                task.bgClipPool.splice(pi, 1);
                _renderPoolUI();
            });
        });

        // Add files
        const fileInput = box.querySelector('#bgpool-file-input');
        box.querySelector('#bgpool-add-files')?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            for (const f of files) {
                const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
            }
            e.target.value = '';
            _renderPoolUI();
        });

        // Add folder
        const folderInput = box.querySelector('#bgpool-folder-input');
        box.querySelector('#bgpool-add-folder')?.addEventListener('click', () => folderInput?.click());
        folderInput?.addEventListener('change', (e) => {
            const files = Array.from(e.target.files);
            const mediaExt = /\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|webp|gif|bmp)$/i;
            for (const f of files) {
                if (!mediaExt.test(f.name)) continue;
                const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
            }
            e.target.value = '';
            _renderPoolUI();
        });

        // Clear all
        box.querySelector('#bgpool-clear-all')?.addEventListener('click', () => {
            if (confirm('确定清空所有素材？')) {
                task.bgClipPool = [];
                _renderPoolUI();
            }
        });

        // Drag & drop zone
        const dropzone = box.querySelector('#bgpool-dropzone');
        if (dropzone) {
            dropzone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = '#b8a0ff';
                dropzone.style.color = '#b8a0ff';
            });
            dropzone.addEventListener('dragleave', () => {
                dropzone.style.borderColor = '#333';
                dropzone.style.color = '#555';
            });
            dropzone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropzone.style.borderColor = '#333';
                dropzone.style.color = '#555';
                const files = Array.from(e.dataTransfer.files);
                const mediaExt = /\.(mp4|mov|avi|mkv|webm|jpg|jpeg|png|webp|gif|bmp)$/i;
                for (const f of files) {
                    if (!mediaExt.test(f.name)) continue;
                    const path = typeof getFileNativePath === 'function' ? getFileNativePath(f) : (f.path || f.name);
                    if (path && !task.bgClipPool.includes(path)) task.bgClipPool.push(path);
                }
                _renderPoolUI();
            });
        }

        // Batch apply
        const _applyPoolToTask = (targetTask) => {
            targetTask.bgMode = task.bgMode;
            targetTask.bgClipPool = [...task.bgClipPool];
            targetTask.bgTransition = task.bgTransition;
            targetTask.bgTransDur = task.bgTransDur;
        };

        box.querySelector('#bgpool-apply-selected')?.addEventListener('click', () => {
            const indices = _getSelectedIndices();
            if (indices.length === 0) { alert('请先勾选要应用的行'); return; }
            for (const i of indices) {
                if (i !== taskIdx && state.tasks[i]) _applyPoolToTask(state.tasks[i]);
            }
            if (typeof showToast === 'function') showToast(`✅ 素材池已应用到 ${indices.length} 行`, 'success');
        });

        box.querySelector('#bgpool-apply-all')?.addEventListener('click', () => {
            for (let i = 0; i < state.tasks.length; i++) {
                if (i !== taskIdx) _applyPoolToTask(state.tasks[i]);
            }
            if (typeof showToast === 'function') showToast(`✅ 素材池已应用到全部 ${state.tasks.length} 行`, 'success');
        });
    };

    _renderPoolUI();
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Click outside to close
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { _renderBatchTable(); overlay.remove(); }
    });
}

// ═══════════════════════════════════════════════════════
// Cycle Fill — 循环填充素材（加权交错分配）
// ═══════════════════════════════════════════════════════

function _showCycleFillDialog() {
    const state = window._reelsState;
    if (!state) return;
    const tasks = state.tasks || [];

    // 移除已有弹窗
    document.getElementById('rbt-cycle-fill-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-cycle-fill-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.style.cssText = 'background:#1e1e2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:480px;max-width:600px;max-height:80vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.6);';

    // 收集已有素材（去重）
    const existingBg = [...new Set(tasks.map(t => t.bgPath || t.videoPath).filter(Boolean))];
    const existingAudio = [...new Set(tasks.map(t => t.audioPath).filter(Boolean))];
    const existingBgm = [...new Set(tasks.map(t => t.bgmPath).filter(Boolean))];

    // 文件扩展名映射
    const EXT_MAP = {
        bg: new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']),
        audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm']),
        bgm: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']),
    };

    const fieldOptions = [
        { key: 'bg', label: '🖼 背景素材', items: [...existingBg], origItems: existingBg },
        { key: 'audio', label: '🔊 音频', items: [...existingAudio], origItems: existingAudio },
        { key: 'bgm', label: '🎵 配乐', items: [...existingBgm], origItems: existingBgm },
    ];

    // 素材池持久化
    const POOL_STORAGE_KEY = 'rbt-cycle-pool';
    function _loadSavedPool() {
        try { return JSON.parse(localStorage.getItem(POOL_STORAGE_KEY) || '{}'); } catch (e) { return {}; }
    }
    function _savePool(fieldKey, paths) {
        const pools = _loadSavedPool();
        pools[fieldKey] = paths;
        localStorage.setItem(POOL_STORAGE_KEY, JSON.stringify(pools));
    }

    let selectedField = fieldOptions.find(f => f.items.length > 0)?.key || 'bg';
    let sourceMode = 'existing'; // 'existing' | 'folder'

    // 如果有已保存的素材池，自动切换到 folder 模式
    const savedPools = _loadSavedPool();
    if (savedPools[selectedField] && savedPools[selectedField].length > 0) {
        sourceMode = 'folder';
        const field = fieldOptions.find(f => f.key === selectedField);
        if (field) field.items = savedPools[selectedField];
    }

    function _shortN(p) { return (p || '').replace(/\\/g, '/').split('/').pop() || ''; }

    // 隐藏文件选择器
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        const exts = EXT_MAP[selectedField];
        const paths = files
            .filter(f => exts.has((f.name || '').split('.').pop().toLowerCase()))
            .map(f => (typeof getFileNativePath === 'function') ? getFileNativePath(f) : (f.path || f.name))
            .filter(p => {
                // 必须是绝对路径，防止仅存文件名导致 FFmpeg 找不到文件
                if (!p || (!p.startsWith('/') && !/^[A-Z]:\\/i.test(p))) {
                    console.warn('[CycleFill] 跳过无完整路径的文件:', p);
                    return false;
                }
                return true;
            });
        if (paths.length === 0) {
            alert('所选文件中没有匹配该字段类型的文件');
            return;
        }
        const field = fieldOptions.find(f => f.key === selectedField);
        if (field) {
            field.items = paths;
            _savePool(selectedField, paths); // 保存到 localStorage
            renderContent();
        }
        e.target.value = '';
    });
    box.appendChild(fileInput);

    function renderContent() {
        const field = fieldOptions.find(f => f.key === selectedField);
        const items = field ? field.items : [];
        const totalRows = tasks.length || 0;
        const emptyRows = field ? tasks.filter(t => {
            if (field.key === 'bg') return !t.bgPath && !t.videoPath;
            if (field.key === 'audio') return !t.audioPath;
            if (field.key === 'bgm') return !t.bgmPath;
            return true;
        }).length : 0;

        // 保留fileInput
        const existingFileInput = box.querySelector('input[type="file"]');

        box.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--accent);">🔄 素材使用与分配设置</div>

            <!-- Global Setting Block (Moved from main UI) -->
            <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:16px; padding:10px; background:rgba(255,255,255,0.05); border-radius:8px; border:1px solid rgba(255,255,255,0.1);">
                <button class="rbt-btn" id="rbt-cf-upload-hook">🪝 设置钩子视频 (Hook)</button>
                <div style="width:1px; height:20px; background:rgba(255,255,255,0.2);"></div>
                <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#ccc;cursor:pointer;">
                    <input type="checkbox" id="rbt-cf-video-drop-route-enabled" ${_batchTableState.videoDropRouteEnabled ? 'checked' : ''} style="accent-color:var(--accent);">
                    视频分配模式：
                </label>
                <select id="rbt-cf-video-drop-route-mode" class="rbt-select" style="height:26px;padding:0 6px;${_batchTableState.videoDropRouteEnabled ? '' : 'opacity:.5;'}" ${_batchTableState.videoDropRouteEnabled ? '' : 'disabled'}>
                    <option value="hook" ${_batchTableState.videoDropRouteMode === 'hook' ? 'selected' : ''}>🪝 分配到前置Hook</option>
                    <option value="bg" ${_batchTableState.videoDropRouteMode === 'bg' ? 'selected' : ''}>🎬 分配到背景层</option>
                    <option value="audio" ${_batchTableState.videoDropRouteMode === 'audio' ? 'selected' : ''}>🎙 分配到人声层</option>
                </select>
            </div>
            <div style="margin-bottom:12px;">
                <span style="font-size:12px;color:#888;">选择字段：</span>
                ${fieldOptions.map(f => `
                    <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;color:${f.key === selectedField ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                        <input type="radio" name="rbt-cf-field" value="${f.key}" ${f.key === selectedField ? 'checked' : ''} style="accent-color:var(--accent);">
                        ${f.label} (${f.items.length})
                    </label>
                `).join('')}
            </div>
            <div style="margin-bottom:10px;">
                <span style="font-size:12px;color:#888;">素材来源：</span>
                <label style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:13px;color:${sourceMode === 'existing' ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                    <input type="radio" name="rbt-cf-source" value="existing" ${sourceMode === 'existing' ? 'checked' : ''} style="accent-color:var(--accent);">
                    从已有行提取
                </label>
                <label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:13px;color:${sourceMode === 'folder' ? 'var(--accent)' : '#aaa'};cursor:pointer;">
                    <input type="radio" name="rbt-cf-source" value="folder" ${sourceMode === 'folder' ? 'checked' : ''} style="accent-color:var(--accent);">
                    从文件选取
                </label>
                ${sourceMode === 'folder' ? `<button id="rbt-cf-pick-files" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid #555;background:#2a2a3a;color:#ccc;cursor:pointer;">📂 选择文件...</button>` : ''}
                ${sourceMode === 'folder' && items.length > 0 ? `<button id="rbt-cf-clear-pool" style="font-size:11px;padding:3px 10px;border-radius:4px;border:1px solid #555;background:#3a2a2a;color:#f88;cursor:pointer;margin-left:4px;">✕ 清空素材池</button>` : ''}
            </div>


            <div style="font-size:11px;color:#666;margin-bottom:8px;">
                共 ${totalRows} 行，其中 ${emptyRows} 行该字段为空 | 素材池: ${items.length} 个
            </div>
            ${items.length === 0 ? `
                <div style="text-align:center;padding:30px;color:#666;">
                    ${sourceMode === 'existing' ? '当前没有该类型的素材。<br>请先通过批量添加素材到表格中。' : '请点击「选择文件」按钮添加素材文件。'}
                </div>
            ` : `
                <div style="border:1px solid #333;border-radius:8px;overflow:hidden;margin-bottom:12px;">
                    <div style="display:flex;padding:6px 12px;background:#141414;font-size:11px;color:#888;border-bottom:1px solid #333;">
                        <span style="flex:1;">素材文件</span>
                        <span style="width:100px;text-align:center;">权重</span>
                        <span style="width:60px;text-align:center;">预计次数</span>
                    </div>
                    <div id="rbt-cf-items" style="max-height:200px;overflow-y:auto;">
                        ${items.map((item, i) => `
                            <div style="display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #222;font-size:12px;color:#ccc;" data-idx="${i}">
                                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_escHtml(item)}">${_shortN(item)}</span>
                                <span style="width:100px;text-align:center;">
                                    <input type="number" class="rbt-cf-weight" data-idx="${i}" value="1" min="1" max="20"
                                        style="width:50px;text-align:center;background:#1a1a3a;color:#ddd;border:1px solid #444;border-radius:4px;padding:2px 4px;font-size:12px;">
                                </span>
                                <span class="rbt-cf-count" data-idx="${i}" style="width:60px;text-align:center;color:#888;">—</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div id="rbt-cf-preview" style="font-size:11px;color:#666;margin-bottom:12px;max-height:60px;overflow-y:auto;line-height:1.6;"></div>
            `}
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                <button id="rbt-cf-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;">取消</button>
                ${items.length > 0 && emptyRows > 0 ? `
                    <button id="rbt-cf-fill-empty" style="padding:8px 16px;border-radius:6px;border:none;background:#2a5a3a;color:#8f8;cursor:pointer;font-size:13px;font-weight:600;">填充空行 (${emptyRows}行)</button>
                ` : ''}
                ${items.length > 0 ? `
                    <button id="rbt-cf-fill-all" style="padding:8px 16px;border-radius:6px;border:none;background:var(--accent);color:#000;cursor:pointer;font-size:13px;font-weight:600;">覆盖全部 (${totalRows}行)</button>
                ` : ''}
            </div>
        `;

        // 重新挂 fileInput
        box.appendChild(fileInput);

        // Bind events
        box.querySelectorAll('input[name="rbt-cf-field"]').forEach(r => {
            r.addEventListener('change', () => {
                selectedField = r.value;
                const field = fieldOptions.find(f => f.key === selectedField);
                if (sourceMode === 'existing' && field) {
                    field.items = [...field.origItems];
                } else if (sourceMode === 'folder' && field) {
                    // 加载已保存的素材池
                    const saved = _loadSavedPool()[selectedField];
                    field.items = saved && saved.length > 0 ? saved : [];
                }
                renderContent();
            });
        });
        box.querySelectorAll('input[name="rbt-cf-source"]').forEach(r => {
            r.addEventListener('change', () => {
                sourceMode = r.value;
                const field = fieldOptions.find(f => f.key === selectedField);
                if (sourceMode === 'existing' && field) {
                    field.items = [...field.origItems];
                } else if (sourceMode === 'folder' && field) {
                    // 加载已保存的素材池
                    const saved = _loadSavedPool()[selectedField];
                    field.items = saved && saved.length > 0 ? saved : [];
                }
                renderContent();
            });
        });
        box.querySelector('#rbt-cf-pick-files')?.addEventListener('click', () => {
            const exts = [...EXT_MAP[selectedField]].map(e => '.' + e).join(',');
            fileInput.accept = exts;
            fileInput.click();
        });
        box.querySelector('#rbt-cf-clear-pool')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            if (field) field.items = [];
            _savePool(selectedField, []);
            renderContent();
        });
        box.querySelectorAll('.rbt-cf-weight').forEach(w => {
            w.addEventListener('input', updatePreview);
        });
        box.querySelector('#rbt-cf-cancel')?.addEventListener('click', () => overlay.remove());
        box.querySelector('#rbt-cf-fill-empty')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            _doCycleFill(selectedField, field.items, _getWeights(), 'empty');
            overlay.remove();
        });
        box.querySelector('#rbt-cf-fill-all')?.addEventListener('click', () => {
            const field = fieldOptions.find(f => f.key === selectedField);
            _doCycleFill(selectedField, field.items, _getWeights(), 'all');
            overlay.remove();
        });

        // ==========================================
        // 绑定“独立素材使用与分配设置”的相关事件
        // ==========================================
        box.querySelector('#rbt-cf-upload-hook')?.addEventListener('click', () => {
            const indices = _getSelectedIndices();
            if (indices.length === 0) {
                alert('请先在左侧勾选需要批量配置前置Hook的行（可先关闭此面板去勾选）');
                return;
            }
            overlay.remove(); // 关掉本面板，打开Hook面板
            _openHookModal(-1);
        });

        box.querySelector('#rbt-cf-video-drop-route-enabled')?.addEventListener('change', (e) => {
            _batchTableState.videoDropRouteEnabled = e.target.checked;
            renderContent(); // 触发重渲染，更新下拉框的禁用状态
        });

        box.querySelector('#rbt-cf-video-drop-route-mode')?.addEventListener('change', (e) => {
            _batchTableState.videoDropRouteMode = e.target.value;
        });
        // ==========================================

        updatePreview();
    }

    function _getWeights() {
        const weights = [];
        box.querySelectorAll('.rbt-cf-weight').forEach(w => {
            weights[parseInt(w.dataset.idx)] = Math.max(1, parseInt(w.value) || 1);
        });
        return weights;
    }

    function updatePreview() {
        const field = fieldOptions.find(f => f.key === selectedField);
        if (!field || !field.items.length) return;
        const weights = _getWeights();
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        const totalRows = tasks.length || 1;

        // 更新各素材预计次数
        box.querySelectorAll('.rbt-cf-count').forEach(span => {
            const i = parseInt(span.dataset.idx);
            const count = Math.round(totalRows * (weights[i] || 1) / totalWeight);
            span.textContent = count + '次';
        });

        // 小预览
        const preview = box.querySelector('#rbt-cf-preview');
        if (preview) {
            const previewCount = Math.min(totalRows, 30);
            const seq = _generateCycleSequence(field.items, weights, previewCount);
            const names = seq.map(idx => _shortN(field.items[idx]));
            const truncated = totalRows > 30 ? ' ...' : '';
            preview.textContent = '预览: ' + names.join(' → ') + truncated;
        }
    }

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    renderContent();
}

/**
 * 加权交错分配算法 — 优先队列法，保证不相邻重复
 * @returns {number[]} 素材索引序列
 */
function _generateCycleSequence(items, weights, count) {
    if (items.length === 0) return [];
    if (items.length === 1) return new Array(count).fill(0);

    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const seq = [];
    // 每个素材的剩余份额
    const remaining = weights.map((w, i) => ({ idx: i, rem: (w / totalWeight) * count }));
    let lastIdx = -1;

    for (let i = 0; i < count; i++) {
        // 找剩余份额最大的（排除上一个用过的）
        let best = -1, bestRem = -Infinity;
        for (const r of remaining) {
            if (r.idx === lastIdx) continue;
            if (r.rem > bestRem) { bestRem = r.rem; best = r.idx; }
        }
        if (best === -1) best = remaining[0].idx; // fallback
        seq.push(best);
        remaining.find(r => r.idx === best).rem -= 1;
        lastIdx = best;
    }

    return seq;
}

/**
 * 执行循环填充
 */
function _doCycleFill(fieldKey, items, weights, mode) {
    const state = window._reelsState;
    if (!state || !items.length) return;

    let targetIndices;
    if (mode === 'empty') {
        targetIndices = state.tasks.map((t, i) => {
            if (fieldKey === 'bg' && !t.bgPath && !t.videoPath) return i;
            if (fieldKey === 'audio' && !t.audioPath) return i;
            if (fieldKey === 'bgm' && !t.bgmPath) return i;
            return -1;
        }).filter(i => i >= 0);
    } else {
        targetIndices = state.tasks.map((_, i) => i);
    }

    if (targetIndices.length === 0) {
        alert('没有需要填充的行');
        return;
    }

    const seq = _generateCycleSequence(items, weights, targetIndices.length);
    const fieldLabel = fieldKey === 'bg' ? '背景' : fieldKey === 'audio' ? '音频' : '配乐';

    for (let i = 0; i < targetIndices.length; i++) {
        const task = state.tasks[targetIndices[i]];
        const filePath = items[seq[i]];
        if (fieldKey === 'bg') {
            const isImg = /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filePath);
            if (isImg) {
                task.bgPath = filePath;
                task.videoPath = '';
            } else {
                task.videoPath = filePath;
                task.bgPath = filePath;
            }
            if (window.electronAPI && window.electronAPI.toFileUrl) {
                task.bgSrcUrl = window.electronAPI.toFileUrl(filePath);
            }
        } else if (fieldKey === 'audio') {
            task.audioPath = filePath;
        } else if (fieldKey === 'bgm') {
            task.bgmPath = filePath;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已循环填充 ${targetIndices.length} 行的${fieldLabel}`);
}

/**
 * 批量粘贴TTS打听： 1. TTS文案(带情感)   2. 断行文案(字幕文本)   3. TTS音色
 */
async function _batchPasteTTSContent() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let validRows = [];
    try {
        const clipboardItems = await navigator.clipboard.read();
        for (const item of clipboardItems) {
            // 优先解析 HTML
            if (item.types.includes('text/html')) {
                const blob = await item.getType('text/html');
                const html = await blob.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const tableRows = doc.querySelectorAll('tr');

                // 辅助函数：获取单元格文本，保留换行
                const getCellTextWithBreaks = (cell) => {
                    if (!cell) return '';
                    let clone = cell.cloneNode(true);
                    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                    clone.querySelectorAll('p, div').forEach(el => el.insertAdjacentText('beforebegin', '\n'));
                    return clone.textContent.trim();
                };

                tableRows.forEach(tr => {
                    const cells = tr.querySelectorAll('td, th');
                    if (cells.length >= 2) {
                        const ttsText = getCellTextWithBreaks(cells[0]);
                        const subtitleText = getCellTextWithBreaks(cells[1]);
                        const voiceId = cells[2]?.textContent.trim() || '';
                        if (ttsText || subtitleText) {
                            validRows.push([ttsText, subtitleText, voiceId]);
                        }
                    } else if (cells.length === 1) {
                        // 兼容只有一列的情况
                        validRows.push([getCellTextWithBreaks(cells[0]), '', '']);
                    }
                });
            }

            // 如果 HTML 没数据，或者不支持，尝试纯文本
            if (validRows.length === 0 && item.types.includes('text/plain')) {
                const blob = await item.getType('text/plain');
                const raw = await blob.text();
                const rows = typeof _parseBatchTSV === 'function' ? _parseBatchTSV(raw) : raw.split(/\n/).map(line => line.split('\t'));
                validRows = rows.filter(r => r.join('').trim().length > 0);
            }
        }
    } catch (e) {
        // 降级：让用户在弹窗里直接粘贴纯文本
        let raw = await _showPasteDialog('📋 粘贴TTS素材 (1.情感播报词 2.画面文本 3.音色ID)');
        if (!raw || !raw.trim()) return;
        const rows = typeof _parseBatchTSV === 'function' ? _parseBatchTSV(raw) : raw.split(/\n/).map(line => line.split('\t'));
        validRows = rows.filter(r => r.join('').trim().length > 0);
    }

    if (!validRows.length) {
        alert('未检测到可以导入数据');
        return;
    }

    const maxCols = Math.max(...validRows.map(r => r.length));
    if (maxCols > 1) {
        _showMultiColumnPasteModal(validRows, 0, 'ttsText');
        return;
    }

    const state = window._reelsState;
    const tab = _getActiveTab();
    const tasks = tab.tasks;

    let addedCount = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < tasks.length && dataIdx < validRows.length; i++) {
            const task = tasks[i];
            const isTextEmpty = !task.ttsText && !task.txtContent;
            if (isTextEmpty) {
                const row = validRows[dataIdx];
                let ttsText = row[0] || '';
                let txtContent = row.length >= 2 ? row[1] || '' : '';
                let voiceId = row.length >= 3 ? row[2] || '' : '';
                
                if (ttsText.trim()) task.ttsText = ttsText.trim();
                if (txtContent.trim()) { task.txtContent = txtContent.trim(); task.aligned = false; }
                if (voiceId.trim()) task.ttsVoiceId = voiceId.trim();

                dataIdx++;
                addedCount++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < tasks.length && dataIdx < validRows.length; i++) {
            const task = tasks[i];
            const row = validRows[dataIdx];
            let ttsText = row[0] || '';
            let txtContent = row.length >= 2 ? row[1] || '' : '';
            let voiceId = row.length >= 3 ? row[2] || '' : '';

            task.ttsText = '';
            task.txtContent = '';

            if (ttsText.trim()) task.ttsText = ttsText.trim();
            if (txtContent.trim()) { task.txtContent = txtContent.trim(); task.aligned = false; }
            if (voiceId.trim()) task.ttsVoiceId = voiceId.trim();

            dataIdx++;
            addedCount++;
        }
    }

    // mode === 'new' or remaining rows
    for (; dataIdx < validRows.length; dataIdx++) {
        const row = validRows[dataIdx];
        const taskName = `tts_task_${String(tasks.length + 1).padStart(3, '0')}`;
        const ttask = {
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            bgScale: 100, bgDurScale: 100, audioDurScale: 100
        };

        let ttsText = row[0] || '';
        let txtContent = row.length >= 2 ? row[1] || '' : '';
        let voiceId = row.length >= 3 ? row[2] || '' : '';

        if (ttsText.trim()) ttask.ttsText = ttsText.trim();
        if (txtContent.trim()) { ttask.txtContent = txtContent.trim(); ttask.aligned = false; }
        if (voiceId.trim()) ttask.ttsVoiceId = voiceId.trim();

        tasks.push(ttask);
        addedCount++;
    }

    _loadTabTasks(tab);
    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已成功通过【${mode === 'fill' ? '补全' : (mode === 'overwrite' ? '覆盖' : '新行')}】模式导入 ${addedCount} 条TTS记录`);
}

/**
 * 从剪贴板批量粘贴文案到「人声字幕」列 (txtContent)
 * 支持：
 * - 单列：每行一条文案
 * - 多列表格：取第一列
 * - Google 表格 / Excel 复制过来的都支持
 */
async function _batchPasteTxtContent() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    const tsvRows = _parseBatchTSV(raw);
    if (tsvRows.length === 0) return showToast('未能解析到文本', 'error');

    const maxCols = Math.max(...tsvRows.map(r => r.length));
    if (maxCols > 1) {
        _showMultiColumnPasteModal(tsvRows, 0, 'txtContent');
        return;
    }

    // 解析行 — 支持 TSV 表格格式（取第一列）和纯文本（每行一条）
    const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);

    if (!lines.length) {
        alert('未提取到有效文本数据');
        return;
    }

    const state = window._reelsState;
    if (!state) return;

    let filled = 0, created = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            if (!task.txtContent || !task.txtContent.trim()) {
                task.txtContent = lines[dataIdx];
                task.aligned = false;
                dataIdx++;
                filled++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            task.txtContent = lines[dataIdx];
            task.aligned = false;
            dataIdx++;
            filled++;
        }
    }

    for (; dataIdx < lines.length; dataIdx++) {
        const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
        state.tasks.push({
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: null, bgSrcUrl: null,
            audioPath: null, srtPath: null,
            segments: [],
            videoPath: null, srcUrl: null,
            overlays: [],
            txtContent: lines[dataIdx],
            aligned: false,
            bgScale: 100, bgDurScale: 100, audioDurScale: 100
        });
        created++;
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const parts = [];
    if (filled) parts.push(`填充 ${filled} 行`);
    if (created) parts.push(`新建 ${created} 行`);
    alert(`✅ 人声字幕粘贴完成通过模式 [${mode}]：${parts.join('，')}`);
}

/**
 * 从剪贴板粘贴数据到「AI 原文案」
 */
async function _batchPasteAiScript() {
    const mode = await _showPasteModeDialog();
    if (!mode) return;

    let raw = '';
    try {
        raw = await navigator.clipboard.readText();
    } catch (e) {
        raw = await _showPasteDialog();
    }
    if (!raw || !raw.trim()) return;

    // 使用 TSV 引号解析器，正确处理 Google Sheets 单元格内的换行
    const tsvRows = _parseBatchTSV(raw);
    const lines = tsvRows.map(row => (row[0] || '').trim()).filter(s => s.length > 0);

    if (!lines.length) {
        alert('未提取到有效文本数据');
        return;
    }

    const state = window._reelsState;
    if (!state) return;

    let filled = 0, created = 0;
    let dataIdx = 0;

    if (mode === 'fill') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            if (!task.aiScript || !task.aiScript.trim()) {
                task.aiScript = lines[dataIdx];
                dataIdx++;
                filled++;
            }
        }
    } else if (mode === 'overwrite') {
        for (let i = 0; i < state.tasks.length && dataIdx < lines.length; i++) {
            const task = state.tasks[i];
            task.aiScript = lines[dataIdx];
            dataIdx++;
            filled++;
        }
    }

    const newRows = lines.slice(dataIdx);
    if (newRows.length > 0 && confirm(`还有 ${newRows.length} 条数据尚未匹配到任务行。是否自动创建 ${newRows.length} 行新任务并填充？`)) {
        for (const str of newRows) {
            const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
            state.tasks.push({
                baseName: taskName,
                fileName: `${taskName}.mp4`,
                bgPath: null, bgSrcUrl: null,
                audioPath: null, srtPath: null,
                segments: [],
                videoPath: null, srcUrl: null,
                overlays: [],
                aiScript: str,
                aligned: false,
                bgScale: 100, bgDurScale: 100, audioDurScale: 100
            });
            created++;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    showToast(`✅ 粘贴AI原文案成功：覆盖/填充 ${filled} 行，新建 ${created} 行`, 'success');
}

// ── 辅助：设置一行的文案 ──
function _setTaskText(task, title, body, ReelsOverlay, footer) {
    if (!task.overlays) task.overlays = [];
    if (!task.overlays[0]) {
        task.overlays[0] = ReelsOverlay.createTextCardOverlay({
            title_text: '', body_text: '', footer_text: '',
            start: 0, end: 9999,
        });
    }
    task.overlays[0].title_text = title;
    task.overlays[0].body_text = body;
    if (footer !== undefined && footer !== '') {
        task.overlays[0].footer_text = footer;
    }
}

// ── 辅助：新建一行并填入文案 ──
function _createNewTextRow(state, title, body, ReelsOverlay, footer) {
    const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
    state.tasks.push({
        baseName: taskName,
        fileName: `${taskName}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: [ReelsOverlay.createTextCardOverlay({
            title_text: title,
            body_text: body,
            footer_text: footer || '',
            start: 0, end: 9999,
        })],
    });
}

// ── 辅助：设置滚动字幕文案 ──
function _setTaskScrollText(task, title, body, ReelsOverlay) {
    if (!task.overlays) task.overlays = [];
    let scrollOv = task.overlays.find(o => o && o.type === 'scroll');
    if (!scrollOv) {
        scrollOv = ReelsOverlay.createScrollOverlay({
            scroll_title: title, content: body,
            start: 0, end: 9999,
        });
        task.overlays.push(scrollOv);
    } else {
        scrollOv.scroll_title = title;
        scrollOv.content = body;
    }
}

// ── 辅助：新建一行并填入滚动字幕 ──
function _createNewScrollRow(state, title, body, ReelsOverlay) {
    const taskName = `scroll_${String(state.tasks.length + 1).padStart(3, '0')}`;
    state.tasks.push({
        baseName: taskName,
        fileName: `${taskName}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: [ReelsOverlay.createScrollOverlay({
            scroll_title: title,
            content: body,
            start: 0, end: 9999,
        })],
    });
}

// ── 模式选择弹窗 ──
function _showPasteModeDialog() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

        const box = document.createElement('div');
        box.style.cssText = 'background:#1e1e2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:360px;box-shadow:0 10px 40px rgba(0,0,0,0.6);';
        box.innerHTML = `
            <div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--accent);">📋 选择粘贴模式</div>
            <div style="display:flex;flex-direction:column;gap:10px;">
                <button class="rbt-paste-mode-btn" data-mode="fill" style="padding:12px 16px;border-radius:8px;border:1px solid #2a6b3a;background:#1a3a2a;color:#8f8;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">🔄 补全模式</div>
                    <div style="color:#aaa;font-size:12px;">只填充空行（没有文案的行），已有文案的行保持不动。多出的文案追加为新行。</div>
                </button>
                <button class="rbt-paste-mode-btn" data-mode="overwrite" style="padding:12px 16px;border-radius:8px;border:1px solid #b48b00;background:#3a3020;color:#ffd700;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">⚡ 覆盖模式</div>
                    <div style="color:#aaa;font-size:12px;">从第1行开始逐行覆盖文案（不改变背景/音频等其它数据）。多出的追加为新行。</div>
                </button>
                <button class="rbt-paste-mode-btn" data-mode="new" style="padding:12px 16px;border-radius:8px;border:1px solid #4466aa;background:#1a2540;color:#88bbff;cursor:pointer;text-align:left;font-size:13px;">
                    <div style="font-weight:700;font-size:14px;margin-bottom:4px;">➕ 新行模式</div>
                    <div style="color:#aaa;font-size:12px;">全部作为新行添加到末尾，不影响任何现有行。</div>
                </button>
            </div>
            <div style="margin-top:14px;text-align:right;">
                <button class="rbt-paste-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:13px;">取消</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (val) => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            resolve(val);
        };

        box.querySelectorAll('.rbt-paste-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => close(btn.dataset.mode));
            btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; btn.style.transform = 'scale(1.01)'; });
            btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; btn.style.transform = 'scale(1)'; });
        });
        box.querySelector('.rbt-paste-cancel').addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    });
}

function _showPasteDialog(titleStr = '📋 粘贴表格数据') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:10001;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:500px;">
                <h3 style="margin:0 0 12px;color:var(--accent);">${titleStr}</h3>
                <textarea id="rbt-paste-area" style="width:100%;height:200px;background:#141414;border:1px solid var(--border-color);border-radius:8px;color:#ddd;font-size:13px;padding:12px;" placeholder="从 Google 表格粘贴..."></textarea>
                <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
                    <button id="rbt-paste-cancel" style="padding:8px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消</button>
                    <button id="rbt-paste-ok" style="padding:8px 16px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">导入</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = v => { document.body.removeChild(overlay); resolve(v); };
        overlay.querySelector('#rbt-paste-cancel').onclick = () => close(null);
        overlay.querySelector('#rbt-paste-ok').onclick = () => close(overlay.querySelector('#rbt-paste-area').value);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
        setTimeout(() => overlay.querySelector('#rbt-paste-area')?.focus(), 100);
    });
}

function _showSplitPromptDialog(messageText) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.8);z-index:10001;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
        
        const htmlMessage = messageText.replace(/\\n/g, '<br>');
        
        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:400px;color:#ddd;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid #333;">
                <h3 style="margin:0 0 16px;color:#a78bfa;font-size:16px;">🪄 智能分段提取</h3>
                <div style="font-size:13px;line-height:1.6;margin-bottom:20px;color:#ccc;">${htmlMessage}</div>
                
                <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px;">
                    <button class="rbt-split-btn" data-val="2" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 拆为两段 ]</div>
                        <div style="font-size:12px;color:#aaa;">首行提取为标题，其余内容合并为正文</div>
                    </button>
                    <button class="rbt-split-btn" data-val="3" style="padding:12px;background:#2a2a3a;border:1px solid #4a4a6a;border-radius:8px;color:#cce;cursor:pointer;text-align:left;transition:all 0.2s;">
                        <div style="font-weight:bold;margin-bottom:4px;color:#a78bfa;font-size:14px;">[ 拆为三段 ]</div>
                        <div style="font-size:12px;color:#aaa;">首行标题，末行做结尾标签，中间所有为正文</div>
                    </button>
                </div>
                
                <div style="display:flex;justify-content:flex-end;">
                    <button id="rbt-split-cancel" style="padding:8px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;">保留全文原文，不提取</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        const close = v => { document.body.removeChild(overlay); resolve(v); };
        
        overlay.querySelector('#rbt-split-cancel').onclick = () => close(null);
        
        overlay.querySelectorAll('.rbt-split-btn').forEach(btn => {
             btn.onmouseenter = () => btn.style.background = '#32324a';
             btn.onmouseleave = () => btn.style.background = '#2a2a3a';
             btn.onclick = () => close(btn.dataset.val);
        });
        
        overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    });
}

function _showBatchEditDialog(badRows, minLines, totalRows) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:10002;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';
        
        let boxesHtml = '';
        for (let idx = 0; idx < badRows.length; idx++) {
            const r = badRows[idx];
            boxesHtml += `
            <div style="background:#141414;border:1px solid #444;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <span style="font-size:11px;color:#a78bfa;font-weight:bold;"># 第 ${r.index + 1} 行</span>
                    <label style="font-size:10px;color:#888;cursor:pointer;"><input type="checkbox" class="rbt-skip-chk" data-i="${idx}" style="vertical-align:middle;margin-right:2px;">彻底放弃此行</label>
                </div>
                <textarea class="rbt-box-display" data-i="${idx}" title="可以直接输入编辑，双击则全屏放大修改" style="flex:1;background:#0d0d0d;border:1px dashed #555;border-radius:4px;padding:6px;font-size:12px;color:#ccc;overflow-y:auto;white-space:pre-wrap;word-break:break-all;transition:all 0.2s;min-height:90px;max-height:140px;resize:none;font-family:system-ui;line-height:1.4;">${typeof _escHtml === 'function' ? _escHtml(r.text) : r.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            </div>`;
        }

        overlay.innerHTML = `
            <div style="background:#1e1e1e;border-radius:12px;padding:24px;width:960px;max-width:90vw;max-height:90vh;display:flex;flex-direction:column;color:#ddd;box-shadow:0 10px 40px rgba(0,0,0,0.7);border:1px solid #333;">
                <h3 style="margin:0 0 12px;color:#f87171;font-size:18px;display:flex;align-items:center;gap:6px;">
                    ⚠️ 分段提取中断 (${badRows.length}/${totalRows} 行数据不合规)
                </h3>
                <div style="font-size:13px;line-height:1.5;margin-bottom:16px;color:#bbb;">
                    您选择了拆分为 <strong style="color:var(--accent);">${minLines} 段</strong>，但以下贴入的文案<strong style="color:#f87171;">没有按要求换行</strong>导致程序无法智能切割。<br>
                    请 <strong style="color:#d8b4fe;border-bottom:1px solid #d8b4fe;padding-bottom:1px;">双击</strong> 以下卡片进入放大编辑模式，补上回车把文案断开！
                </div>
                
                <div style="flex:1;overflow-y:auto;margin-bottom:20px;padding-right:8px;">
                    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:12px;">
                        ${boxesHtml}
                    </div>
                </div>
                
                <div style="display:flex;gap:12px;justify-content:flex-end;">
                    <button id="rbt-batch-edit-cancel" style="padding:8px 20px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消整批导入</button>
                    <button id="rbt-batch-edit-ok" style="padding:8px 20px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">✅ 修改好了，继续提取验证</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        
        let activeEditIndex = -1;
        const largeEditOverlay = document.createElement('div');
        largeEditOverlay.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.9);z-index:10;display:none;flex-direction:column;padding:40px;border-radius:12px;';
        largeEditOverlay.innerHTML = `
            <div style="font-size:16px;color:#a78bfa;font-weight:bold;margin-bottom:12px;">✏️ 放大编辑文案</div>
            <textarea id="rbt-large-edit-area" style="flex:1;background:#141414;border:1px solid #5b6abf;border-radius:8px;padding:16px;font-size:16px;color:#fff;resize:none;font-family:system-ui;margin-bottom:20px;line-height:1.5;box-shadow:inset 0 2px 10px rgba(0,0,0,0.5);"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:12px;">
                <button id="rbt-large-edit-cancel" style="padding:8px 24px;border-radius:6px;background:#333;color:#ccc;border:1px solid #555;cursor:pointer;">取消</button>
                <button id="rbt-large-edit-ok" style="padding:8px 24px;border-radius:6px;background:var(--accent);color:#000;font-weight:bold;border:none;cursor:pointer;">✅ 确定应用修改</button>
            </div>
        `;
        overlay.querySelector('div').appendChild(largeEditOverlay);
        
        const largeArea = largeEditOverlay.querySelector('#rbt-large-edit-area');
        
        const displays = overlay.querySelectorAll('.rbt-box-display');
        displays.forEach(disp => {
            disp.addEventListener('dblclick', () => {
                activeEditIndex = disp.dataset.i;
                largeArea.value = disp.value;
                largeEditOverlay.style.display = 'flex';
                largeArea.focus();
            });
            disp.addEventListener('input', () => {
                badRows[disp.dataset.i].text = disp.value;
            });
        });
        
        largeEditOverlay.querySelector('#rbt-large-edit-cancel').onclick = () => {
            largeEditOverlay.style.display = 'none';
        };
        
        largeEditOverlay.querySelector('#rbt-large-edit-ok').onclick = () => {
            if (activeEditIndex >= 0) {
                badRows[activeEditIndex].text = largeArea.value;
                const disp = overlay.querySelector(`.rbt-box-display[data-i="${activeEditIndex}"]`);
                disp.value = largeArea.value;
                // Add a visual flash to show update success
                disp.style.borderColor = '#a78bfa';
                setTimeout(() => disp.style.borderColor = '#555', 500);
            }
            largeEditOverlay.style.display = 'none';
        };

        const close = (val) => { document.body.removeChild(overlay); resolve(val); };
        
        overlay.querySelector('#rbt-batch-edit-cancel').onclick = () => close(null);
        
        overlay.querySelector('#rbt-batch-edit-ok').onclick = () => {
            const skips = overlay.querySelectorAll('.rbt-skip-chk');
            const disps = overlay.querySelectorAll('.rbt-box-display');
            const result = badRows.map((r, i) => ({
                index: r.index,
                text: disps[i].value,
                skip: skips[i].checked
            }));
            close(result);
        };
    });
}

// ═══════════════════════════════════════════════════════
// 8. TSV Parser (same as overlay panel)
// ═══════════════════════════════════════════════════════

function _parseBatchTSV(raw) {
    const rows = [];
    let i = 0;
    const len = raw.length;
    while (i < len) {
        const cells = [];
        while (i < len) {
            let cell = '';
            if (raw[i] === '"') {
                i++;
                while (i < len) {
                    if (raw[i] === '"') {
                        if (i + 1 < len && raw[i + 1] === '"') { cell += '"'; i += 2; }
                        else { i++; break; }
                    } else { cell += raw[i++]; }
                }
            } else {
                while (i < len && raw[i] !== '\t' && raw[i] !== '\n' && raw[i] !== '\r') { cell += raw[i++]; }
            }
            cells.push(cell);
            if (i < len && raw[i] === '\t') { i++; continue; }
            if (i < len && (raw[i] === '\n' || raw[i] === '\r')) {
                if (raw[i] === '\r' && i + 1 < len && raw[i + 1] === '\n') i++;
                i++;
                break;
            }
        }
        if (cells.length > 0 && cells.some(c => c.trim())) {
            rows.push(cells);
        }
    }
    return rows;
}

// ═══════════════════════════════════════════════════════
// 9. Template helpers
// ═══════════════════════════════════════════════════════

function _renderSubtitlePresetOptions(subtitlePresets, selectedValue = '') {
    const builtinNames = window.REELS_BUILTIN_PRESETS ? Object.keys(window.REELS_BUILTIN_PRESETS) : [];
    const builtins = subtitlePresets.filter(t => builtinNames.includes(t));
    const customs = subtitlePresets.filter(t => !builtinNames.includes(t));
    
    let html = '';
    if (customs.length > 0) {
        html += `<optgroup label="我的预设">` + customs.map(t => `<option value="${_escHtml(t)}" ${selectedValue === t ? 'selected' : ''}>${_escHtml(t)}</option>`).join('') + `</optgroup>`;
    }
    if (builtins.length > 0) {
        html += `<optgroup label="内置预设">` + builtins.map(t => `<option value="${_escHtml(t)}" ${selectedValue === t ? 'selected' : ''}>${_escHtml(t)}</option>`).join('') + `</optgroup>`;
    }
    return html;
}

function _renderOverlayPresetOptions(cardTemplates, selectedValue = '') {
    const builtinNames = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];
    const builtins = cardTemplates.filter(t => builtinNames.includes(t.name));
    const customs = cardTemplates.filter(t => !builtinNames.includes(t.name));
    
    let html = '';
    if (customs.length > 0) {
        html += `<optgroup label="我的预设">` + customs.map(t => `<option value="${_escHtml(t.name)}" ${selectedValue === t.name ? 'selected' : ''}>${_escHtml(t.name)} (${t.count}层)</option>`).join('') + `</optgroup>`;
    }
    if (builtins.length > 0) {
        html += `<optgroup label="内置预设">` + builtins.map(t => `<option value="${_escHtml(t.name)}" ${selectedValue === t.name ? 'selected' : ''}>${_escHtml(t.name)} (${t.count}层)</option>`).join('') + `</optgroup>`;
    }
    return html;
}

function _renderTaskPresetOptions(taskPresetNames, selectedValue = '') {
    if (taskPresetNames.length === 0) return '';
    return `<optgroup label="我的预设">` + taskPresetNames.map(n => `<option value="${_escHtml(n)}" ${selectedValue === n ? 'selected' : ''}>${_escHtml(n)}</option>`).join('') + `</optgroup>`;
}

function _getSubtitlePresetList() {
    try {
        if (window.ReelsStyleEngine && typeof ReelsStyleEngine.loadSubtitlePresets === 'function') {
            const data = ReelsStyleEngine.loadSubtitlePresets();
            const presetsMap = data.presets || {};
            if (window.REELS_BUILTIN_PRESETS) {
                for (const k of Object.keys(window.REELS_BUILTIN_PRESETS)) {
                    if (!presetsMap[k]) presetsMap[k] = window.REELS_BUILTIN_PRESETS[k];
                }
            }
            return Object.keys(presetsMap);
        }
    } catch (e) { }
    return window.REELS_BUILTIN_PRESETS ? Object.keys(window.REELS_BUILTIN_PRESETS) : [];
}

function _getOverlayGroupPresetList() {
    const list = [];
    const seen = new Set();

    // 1. 获取覆层组预设
    try {
        const stored = localStorage.getItem('reels_overlay_group_presets');
        const obj = stored ? JSON.parse(stored) : {};
        // 确保内置预设始终存在
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
                if (!obj[k]) obj[k] = v;
            }
        }
        for (const name of Object.keys(obj)) {
            list.push({ name, count: Array.isArray(obj[name]) ? obj[name].length : 0 });
            seen.add(name);
        }
    } catch (e) { }

    // 2. 兼容旧的单卡片模板
    try {
        const stored = localStorage.getItem('reels_card_templates');
        if (stored) {
            const obj = JSON.parse(stored);
            for (const name of Object.keys(obj)) {
                if (!seen.has(name)) {
                    list.push({ name, count: 1 });
                    seen.add(name);
                }
            }
        }
    } catch (e) { }

    return list;
}

function _getOverlayPresetDefinition(presetName) {
    try {
        const groupStored = localStorage.getItem('reels_overlay_group_presets');
        if (groupStored) {
            const presets = JSON.parse(groupStored);
            if (Array.isArray(presets[presetName])) {
                return { kind: 'group', layers: presets[presetName] };
            }
        }
    } catch (e) { }
    try {
        const cardStored = localStorage.getItem('reels_card_templates');
        if (cardStored) {
            const templates = JSON.parse(cardStored);
            if (templates[presetName]) {
                return { kind: 'card', template: templates[presetName] };
            }
        }
    } catch (e) { }
    return null;
}

const RBT_OVERLAY_PRESET_TEXT_KEYS = new Set([
    'title_text', 'body_text', 'footer_text', 'content', 'scroll_title',
    'title_styled_ranges', 'body_styled_ranges', 'footer_styled_ranges',
    'scroll_title_styled_ranges', 'scroll_styled_ranges',
]);

const RBT_OVERLAY_PRESET_RUNTIME_KEYS = new Set([
    'id', '_img', '_imgLoaded', '_templateName', '_selected', '_exporting',
    '_exportDuration', '_renderedW', '_renderedH', '_renderedY',
]);

function _overlayPresetValueEqual(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (typeof a === 'number' || typeof b === 'number') {
        const na = Number(a);
        const nb = Number(b);
        return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.0001;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

function _overlayMatchesPresetLayer(actual, presetLayer) {
    if (!actual || !presetLayer) return false;
    if ((actual.type || '') !== (presetLayer.type || '')) return false;
    const preserveText = !presetLayer.fixed_text;
    for (const [key, expected] of Object.entries(presetLayer)) {
        if (RBT_OVERLAY_PRESET_RUNTIME_KEYS.has(key)) continue;
        if (preserveText && RBT_OVERLAY_PRESET_TEXT_KEYS.has(key)) continue;
        if (!_overlayPresetValueEqual(actual[key], expected)) return false;
    }
    return true;
}

function _verifyOverlayGroupPresetApplied(task, presetName) {
    const def = _getOverlayPresetDefinition(presetName);
    if (!def) return { ok: false, reason: '找不到预设' };
    if (!task || task._overlayPresetName !== presetName) {
        return { ok: false, reason: '任务未记录目标预设名' };
    }

    const overlays = Array.isArray(task.overlays) ? task.overlays : [];
    if (def.kind === 'group') {
        if (overlays.length < def.layers.length) {
            return { ok: false, reason: `覆层数量不足：${overlays.length}/${def.layers.length}` };
        }
        for (let i = 0; i < def.layers.length; i++) {
            if (!_overlayMatchesPresetLayer(overlays[i], def.layers[i])) {
                return { ok: false, reason: `第 ${i + 1} 层与预设不一致` };
            }
        }
        return { ok: true };
    }

    const cardOv = overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === ''));
    if (!cardOv) return { ok: false, reason: '未找到文字卡片覆层' };
    const keepKeys = new Set(['id', 'type', 'title_text', 'body_text', 'footer_text', 'start', 'end']);
    for (const [key, expected] of Object.entries(def.template)) {
        if (keepKeys.has(key)) continue;
        if (!_overlayPresetValueEqual(cardOv[key], expected)) {
            return { ok: false, reason: `文字卡片字段 ${key} 未应用` };
        }
    }
    return { ok: true };
}

function _promptOverlayPresetOptions(presetName, tasks, callback) {
    let presetHasScroll = false;
    try {
        const groupStored = localStorage.getItem('reels_overlay_group_presets');
        if (groupStored) {
            const presets = JSON.parse(groupStored);
            if (presets[presetName] && Array.isArray(presets[presetName])) {
                presetHasScroll = presets[presetName].some(o => o.type === 'scroll');
            }
        }
    } catch(e) {}
    
    let taskHasScrollText = false;
    for (const task of tasks) {
        if (task.overlays) {
            const scrollOv = task.overlays.find(o => o && o.type === 'scroll');
            if (scrollOv) {
                if ((scrollOv.scroll_title || '').trim() || (scrollOv.content || '').trim()) {
                    taskHasScrollText = true;
                    break;
                }
            }
        }
    }

    let addScroll = false;
    let clearText = false;

    // Use setTimeout so the UI dropdown can close before the blocking alert/confirm appears
    setTimeout(() => {
        if (taskHasScrollText) {
            if (!presetHasScroll) {
                if (confirm(`当前预设【${presetName}】不包含滚动字幕，但您已经填写了滚动文案。\n\n是否清空您现有的滚动文案？\n(点“确定”清空，点“取消”保留您的文案)`)) {
                    clearText = true;
                }
            } else {
                if (confirm(`当前预设【${presetName}】自带了滚动字幕样式和默认文案。\n\n是否使用预设的默认文案并清空您的原有文案？\n(点“取消”将强行保留您自己的文案)`)) {
                    clearText = true;
                }
            }
        }
        callback({ addScroll, clearText });
    }, 10);
}

function _applyAndVerifyOverlayGroupPresetToTask(task, presetName, opts = { addScroll: false, clearText: false }) {
    _applyOverlayGroupPresetToTask(task, presetName, opts);
    let result = _verifyOverlayGroupPresetApplied(task, presetName);
    if (!result.ok) {
        console.warn('[BatchTable] 覆层预设校验失败，重试一次:', presetName, result.reason);
        _applyOverlayGroupPresetToTask(task, presetName, opts);
        result = _verifyOverlayGroupPresetApplied(task, presetName);
    }
    return result;
}

function _applyOverlayGroupPresetToTask(task, presetName, opts = { addScroll: false, clearText: false }) {
    try {
        // Try group presets first
        const groupStored = localStorage.getItem('reels_overlay_group_presets');
        if (groupStored) {
            const presets = JSON.parse(groupStored);
            if (presets[presetName] && Array.isArray(presets[presetName])) {
                const layers = presets[presetName];
                const oldOverlays = task.overlays || [];
                const textDonors = [...oldOverlays]; // 仅用于提取文本内容
                
                // 构建预设覆层，仅迁移文本内容
                const newOverlays = layers.map(layerData => {
                    const clone = JSON.parse(JSON.stringify(layerData));
                    clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                    
                    if (!clone.fixed_text) {
                        // 从旧覆层中按类型匹配，提取文本内容
                        const matchIdx = textDonors.findIndex(o => o.type === clone.type);
                        if (matchIdx !== -1) {
                            const old = textDonors.splice(matchIdx, 1)[0];
                            if (old.title_text) clone.title_text = old.title_text;
                            if (old.body_text) clone.body_text = old.body_text;
                            if (old.footer_text) clone.footer_text = old.footer_text;
                            
                            if (clone.type === 'scroll' && opts.clearText) {
                                clone.scroll_title = '';
                                clone.content = '';
                            } else {
                                if (old.content) clone.content = old.content;
                                if (old.scroll_title) clone.scroll_title = old.scroll_title;
                            }
                        } else if (clone.type === 'scroll' && opts.clearText) {
                            clone.scroll_title = '';
                            clone.content = '';
                        }
                    } else if (clone.type === 'scroll' && opts.clearText) {
                        // 如果预设自带文本但用户要求清空
                        clone.scroll_title = '';
                        clone.content = '';
                    }
                    return clone;
                });
                
                // ── 保留预设中没有的覆层类型（如用户独立设置的 scroll、image 等）──
                const presetTypes = new Set(newOverlays.map(o => o.type));
                const survivingOverlays = oldOverlays.filter(o => o && o.type && !presetTypes.has(o.type));
                
                if (opts.clearText) {
                    survivingOverlays.forEach(o => {
                        if (o.type === 'scroll') {
                            o.scroll_title = '';
                            o.content = '';
                        }
                    });
                }
                
                if (!presetTypes.has('scroll') && opts.addScroll) {
                    const hasScroll = survivingOverlays.some(o => o.type === 'scroll');
                    if (!hasScroll) {
                        const ReelsOverlay = window.ReelsOverlay;
                        if (ReelsOverlay) {
                            survivingOverlays.push(ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }));
                        } else {
                            survivingOverlays.push({ type: 'scroll', scroll_title: '', content: '', start: 0, end: 9999 });
                        }
                    }
                }
                
                task.overlays = [...newOverlays, ...survivingOverlays];
                task._overlayPresetName = presetName;
                return true;
            }
        }

        // Fallback: single card template
        const cardStored = localStorage.getItem('reels_card_templates');
        if (cardStored) {
            const templates = JSON.parse(cardStored);
            const tpl = templates[presetName];
            if (tpl) {
                if (!task.overlays) task.overlays = [];
                // 找到现有的 textcard 覆层，或创建一个新的（不覆盖其它类型覆层）
                let cardOv = task.overlays.find(o => o && (o.type === 'textcard' || !o.type || o.type === ''));
                if (!cardOv) {
                    const ReelsOverlay = window.ReelsOverlay;
                    if (ReelsOverlay) {
                        cardOv = ReelsOverlay.createTextCardOverlay({
                            title_text: '', body_text: '',
                            start: 0, end: 9999,
                        });
                        task.overlays.unshift(cardOv); // 插入到数组开头，保留后面的 scroll 等覆层
                    }
                }
                if (cardOv) {
                    const keepKeys = ['id', 'type', 'title_text', 'body_text', 'start', 'end'];
                    for (const [k, v] of Object.entries(tpl)) {
                        if (!keepKeys.includes(k)) cardOv[k] = v;
                    }
                }
                
                if (opts.clearText) {
                    task.overlays.forEach(o => {
                        if (o && o.type === 'scroll') {
                            o.scroll_title = '';
                            o.content = '';
                        }
                    });
                }
                
                if (opts.addScroll) {
                    const hasScroll = task.overlays.some(o => o && o.type === 'scroll');
                    if (!hasScroll) {
                        const ReelsOverlay = window.ReelsOverlay;
                        if (ReelsOverlay) {
                            task.overlays.push(ReelsOverlay.createScrollOverlay({ start: 0, end: 9999 }));
                        } else {
                            task.overlays.push({ type: 'scroll', scroll_title: '', content: '', start: 0, end: 9999 });
                        }
                    }
                }
                
                task._overlayPresetName = presetName;
                return true;
            }
        }
    } catch (e) {
        console.warn('[BatchTable] 应用覆层预设失败:', presetName, e);
    }
    return false;
}

function _batchAddEmptyRow() {
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state || !ReelsOverlay) return;
    const taskName = `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
    state.tasks.push({
        baseName: taskName,
        fileName: `${taskName}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: [],
        ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
    });
}

// ═══════════════════════════════════════════════════════
// TTS 音色列表加载
// ═══════════════════════════════════════════════════════

let _rbtVoiceCache = null;

async function _rbtLoadVoiceList() {
    const inputEl = document.getElementById('rbt-tts-default-voice');
    if (!inputEl) return;
    
    // 记录当前选择
    const prevValue = inputEl.value || localStorage.getItem('rbt_tts_voice') || '';
    
    inputEl.placeholder = '加载中...';
    
    try {
        // 如果有缓存，先用缓存
        if (_rbtVoiceCache && _rbtVoiceCache.length > 0) {
            _populateVoiceSelect(inputEl, _rbtVoiceCache, prevValue);
            return;
        }
        
        const response = await apiFetch(`${API_BASE}/elevenlabs/voices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const data = await response.json();
        
        if (data.voices && data.voices.length > 0) {
            _rbtVoiceCache = data.voices;
            _populateVoiceSelect(inputEl, data.voices, prevValue);
            inputEl.placeholder = '输入或选择音色ID';
        } else {
            inputEl.placeholder = '无可用音色';
        }
    } catch (err) {
        console.warn('[RBT] 加载音色列表失败:', err.message);
        inputEl.placeholder = '加载失败';
    }
}

function _populateVoiceSelect(inputEl, voices, prevValue) {
    let datalist = document.getElementById('rbt-tts-voices-list');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'rbt-tts-voices-list';
        inputEl.parentNode.insertBefore(datalist, inputEl.nextSibling);
    }
    datalist.innerHTML = '';
    for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.voice_id;
        opt.textContent = `${v.name}`;
        datalist.appendChild(opt);
    }
    
    // 持久化选择
    inputEl.addEventListener('change', () => {
        localStorage.setItem('rbt_tts_voice', inputEl.value.trim());
    });
    
    // 恢复上次选择
    if (prevValue && inputEl.value !== prevValue) {
        inputEl.value = prevValue;
    }
}

// ═══════════════════════════════════════════════════════
// AI 处理与一键配音生成
// ═══════════════════════════════════════════════════════

async function _runSingleTTS(idx) {
    // 先同步 DOM 输入框的值到 state
    try { _applyBatchTableChanges(); } catch(e) {}
    const state = window._reelsState;
    if (!state || !state.tasks[idx]) return;
    const task = state.tasks[idx];
    
    if (!task.ttsText) {
        alert(`第 ${idx+1} 行缺少 TTS文案，无法生成配音。`);
        return;
    }
    const defaultVoice = document.getElementById('rbt-tts-default-voice')?.value || 'pNInz6obpgDQGcFmaJcg';
    const voiceId = task.ttsVoiceId || defaultVoice; // 任务级优先，否则用全局选择
    const modelId = localStorage.getItem('rbt_tts_model') || 'eleven_v3';

    task.status = 'generating';
    _skipNextApply = true;
    _renderBatchTable();
    
    try {
        const response = await apiFetch(`${API_BASE}/elevenlabs/tts-workflow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: task.ttsText,
                voice_id: voiceId,
                model_id: modelId,
                task_index: idx,
                need_split: false,
                max_duration: 60,
                subtitle_text: task.txtContent || '', // 「字幕文本」列（中文断句）用于 Gladia 转录对齐生成 SRT
                export_mp4: false,
                export_fcpxml: false,
                seamless_fcpxml: true,
                output_dir: '' 
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '生成失败');
        
        task.audioPath = data.audio_path;
        if (data.srt_path) {
            task.srtPath = data.srt_path;
            // 自动加载srt用于对齐预览（只有路径，无File对象，走Electron回退）
            _readSrtFileToTask(task, null);
            task.aligned = true; // 既然同时成功了srt，说明是对齐完的结果
        }
        task.status = 'success';
        _skipNextApply = true;
        _renderBatchTable();
        
        // 5秒后清除成功状态，恢复原样
        setTimeout(() => {
            if (task.status === 'success') {
                task.status = '';
                _renderBatchTable();
            }
        }, 5000);
        
        return true;
    } catch (e) {
        task.status = 'error';
        _skipNextApply = true;
        _renderBatchTable();
        showToast('生成报错: ' + e.message, 'error', 8000);
        return false;
    }
}

async function _runTTSBatchProcessing() {
    // 先同步 DOM 输入框的值到 state，确保能读到用户填入的数据
    try { _applyBatchTableChanges(); } catch(e) {}
    const indices = _getSelectedIndices();
    const tasks = window._reelsState?.tasks || [];
    if (tasks.length === 0) {
        alert('❌ 任务拒绝执行\n\n【原因】：当前表格完全为空。\n【操作】：请先新建任务行，或从上方导入媒体/通过链接粘贴数据。');
        return false;
    }
    
    const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
    
    // Validate if there's actually anything to TTS
    const hasTtsText = targetIdxs.some(idx => tasks[idx].ttsText && tasks[idx].ttsText.trim().length > 0);
    if (!hasTtsText) {
        alert('❌ 任务拒绝执行 (数据缺失)\n\n【缺失数据列】：「🤖 TTS文案」列内容为空\n【当前需要】    ：生成配音必须依赖该列提供的纯文本内容。\n\n【建议操作】：\n1. 手动双击「🤖 TTS文案」单元格输入文字；\n2. 或者先在「🧠 AI 原文案」列填入长文本，并点击【🪄 AI处理文案】让模型自动填充该列。');
        return false;
    }

    const hasExistingAudio = targetIdxs.some(idx => tasks[idx].ttsText && tasks[idx].ttsText.trim() && tasks[idx].audioPath);
    let forceOverwrite = false;
    if (hasExistingAudio) {
        forceOverwrite = confirm('⚠️ 检测到目标中存在【已经生成过配音】的行。\n\n▶ 点击【确定】则强制重新生成，覆盖它们的原配音和原对齐。\n▶ 点击【取消】则保护它们，仅对还没生成的空白行进行生成。\n\n是否强行覆盖重造已有音频？');
    }
    
    let success = 0;
    let failed = 0;
    for (const idx of targetIdxs) {
        const task = tasks[idx];
        const canRun = (forceOverwrite || !task.audioPath) && task.ttsText && task.ttsText.trim().length > 0;
        if (canRun) {
            const isSuccess = await _runSingleTTS(idx);
            if (isSuccess) success++;
            else failed++;
        }
    }
    
    if (failed > 0) {
        showToast(`批量配音结束：处理 ${success} 行，失败 ${failed} 行，请查看具体报错！`, 'error', 5000);
    } else if (success > 0) {
        showToast(`批量配音生成完毕，共成功处理 ${success} 行`, 'success');
    } else {
        showToast(`没有可用行需要生成配音`, 'info');
    }
}

async function _runGeminiBatchProcessing() {
    // 先同步 DOM 输入框的值到 state，确保能读到用户填入的数据
    try { _applyBatchTableChanges(); } catch(e) {}
    const indices = _getSelectedIndices();
    const tasks = window._reelsState?.tasks || [];
    if (tasks.length === 0) {
        alert('❌ 任务拒绝执行\n\n【原因】：当前表格完全为空。\n【操作】：请先新建任务行并填入数据。');
        return false;
    }
    const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);
    
    showToast(`正在使用 AI 处理 ${targetIdxs.length} 行文案...`, 'info');
    
    try {
        const payload = targetIdxs.map(idx => ({
            idx: idx,
            text: tasks[idx].aiScript || ''
        })).filter(o => o.text.trim().length > 0);

        if (payload.length === 0) {
            alert('❌ 任务拒绝执行 (数据缺失)\n\n【缺失数据列】：「🧠 AI 原文案」列内容为空\n【当前需要】    ：大模型需要基于原始参考素材进行改写。\n\n【建议操作】：请先在「🧠 AI 原文案」列中双击粘贴您想要改写的长文章、大纲或参考内容，然后再执行此操作。');
            return false;
        }

        let lineBreakMode = 'ai';
        let lbMaxChars = 16;
        try {
            const settingsResp = await apiFetch('settings/gemini-keys');
            const settingsData = await settingsResp.json();
            if (settingsData) {
                if (settingsData.lineBreakMode) lineBreakMode = settingsData.lineBreakMode;
                if (settingsData.lbMaxChars) lbMaxChars = settingsData.lbMaxChars;
            }
        } catch (e) {
            console.warn('获取 Gemini 设置失败，使用默认 AI 断行', e);
        }

        const response = await apiFetch(`${API_BASE}/ai/process-scripts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scripts: payload })
        });
        
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'AI处理请求失败');
        
        console.log('[AI文案] API 响应数据:', JSON.stringify(data).slice(0, 500));
        console.log('[AI文案] results 类型:', typeof data.results, '长度:', Array.isArray(data.results) ? data.results.length : 'N/A');
        
        let count = 0;
        if (data.results && Array.isArray(data.results)) {
            for (const res of data.results) {
                console.log(`[AI文案] 结果项 idx=${res.idx}, tts_text=${(res.tts_text||'').slice(0,50)}...`);
                const task = tasks[res.idx];
                if (task) {
                    if (task.ttsText !== res.tts_text) {
                        task.audioPath = null;
                        task.srtPath = null;
                        task.aligned = false;
                    }
                    task.ttsText = res.tts_text;
                    if (lineBreakMode === 'script') {
                        // 使用系统自带脚本断行，剔除大括号和尖括号标签
                        const cleanText = (res.tts_text || '').replace(/\[.*?\]/g, '').replace(/<.*?>/g, '').trim();
                        task.txtContent = typeof _rbtSmartLineBreak === 'function' ? _rbtSmartLineBreak(cleanText, lbMaxChars) : cleanText;
                    } else {
                        // AI 原生断行
                        task.txtContent = res.display_text;
                    }
                    // --- 自动比对：提取字母/数字/汉字（忽略标点和换行空格），如果不一致则报警 ---
                    const normalizeText = (str) => {
                        let s = (str || '');
                        s = s.replace(/\[.*?\]/g, ''); // 去除方括号标签 e.g. [calm]
                        s = s.replace(/<.*?>/g, ''); // 去除尖括号标签 e.g. <break>
                        return s.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '').toLowerCase();
                    };
                    const origNorm = normalizeText(task.aiScript);
                    
                    const newNorm = normalizeText(res.display_text);
                    task.aiTextDiffWarning = (origNorm !== newNorm);
                    
                    const ttsNorm = normalizeText(res.tts_text);
                    task.aiTtsDiffWarning = (origNorm !== ttsNorm);
                    
                    if (task.aiTextDiffWarning || task.aiTtsDiffWarning) {
                        console.warn(`[AI文案] 警告！任务 ${res.idx} 存在字符篡改`);
                    }
                    // -------------------------------------------------------------------------
                    
                    count++;
                } else {
                    console.warn(`[AI文案] 找不到 idx=${res.idx} 对应的任务 (tasks.length=${tasks.length})`);
                }
            }
        } else {
            console.warn('[AI文案] data.results 不是数组!', data);
        }
        _skipNextApply = true; // AI 结果已直接写入 state
        _renderBatchTable();
        
        if (count === 0 && payload.length > 0) {
            alert(`⚠️ AI 处理完成但未能解析出结果\n\n发送了 ${payload.length} 条原文案，但模型返回的内容无法正确解析为 TTS 文案。\n\n可能原因：\n1. 模型输出格式异常（未按 [编号] 格式返回）\n2. API 返回了空内容\n\n请打开开发者工具 (Ctrl+Shift+I) 查看控制台日志，搜索 "[AI文案]" 获取详细信息。`);
            showToast(`⚠️ AI处理完成但解析结果为 0 条 (期望 ${payload.length} 条)`, 'error');
        } else {
            showToast(`✅ AI文案处理完成 (共 ${count}/${payload.length} 行)`, 'success');
        }
        return true;
    } catch (e) {
        showToast('AI处理报错: ' + e.message, 'error');
        return false;
    }
}

function _applyAiPresetBatch() {
    const STORAGE_KEY = 'rbt_task_presets';
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('rbt_ai_presets') || '{}'); } catch(e) {}

    // 动态获取可用的预设列表
    const subtitlePresets = typeof _getSubtitlePresetList === 'function' ? _getSubtitlePresetList() : [];
    const cardTemplates = typeof _getOverlayGroupPresetList === 'function' ? _getOverlayGroupPresetList() : [];

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:24px;min-width:420px;max-width:520px;color:#eee;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.8);';

    const presetNames = Object.keys(presets);
    const optionsHtml = _renderTaskPresetOptions(presetNames, '');

    const stplOptionsHtml = _renderSubtitlePresetOptions(subtitlePresets, '');
    const ctplOptionsHtml = _renderOverlayPresetOptions(cardTemplates, '');

    dialog.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:16px;color:#a78bfa;">📝 任务预设管理</h3>
        <div style="margin-bottom:12px;">
            <label style="font-size:12px;color:#aaa;">选择已保存的任务完整预设</label>
            <select id="_preset-sel" style="width:100%;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;margin-top:4px;font-size:13px;">
                <option value="">-- 选择组合预设 --</option>
                ${optionsHtml}
            </select>
        </div>
        <div style="border-top:1px solid #333;padding-top:12px;margin-bottom:12px;">
            <label style="font-size:12px;color:#aaa;">或单独配置各项参数组合</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
                <div><label style="font-size:11px;color:#888;">Voice ID</label><input id="_p-voice" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;" placeholder="如 pNInz6obpgDQGcFmaJcg"></div>
                <div><label style="font-size:11px;color:#888;">字幕模板</label><select id="_p-tpl" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"><option value="">无</option>${stplOptionsHtml}</select></div>
                <div><label style="font-size:11px;color:#888;">覆层预设</label><select id="_p-overlay" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"><option value="">无</option>${ctplOptionsHtml}</select></div>
                <div><label style="font-size:11px;color:#888;">背景缩放 %</label><input id="_p-bgscale" type="number" value="100" min="50" max="300" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
                <div><label style="font-size:11px;color:#888;">背景变速 %</label><input id="_p-bgdurscale" type="number" value="100" min="10" max="500" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
                <div><label style="font-size:11px;color:#888;">音频变速 %</label><input id="_p-audioscale" type="number" value="100" min="10" max="500" style="width:100%;padding:5px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:11px;"></div>
            </div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
            <input id="_p-save-name" style="flex:1;padding:6px;background:#222;color:#fff;border:1px solid #444;border-radius:4px;font-size:12px;" placeholder="预设名称（可保存）">
            <button id="_p-save-btn" style="padding:6px 12px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">💾 保存</button>
            ${presetNames.length > 0 ? '<button id="_p-del-btn" style="padding:6px 10px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;">🗑</button>' : ''}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #333;padding-top:12px;">
            <button id="_p-cancel" style="padding:8px 20px;background:#333;color:#aaa;border:1px solid #555;border-radius:6px;cursor:pointer;">取消</button>
            <button id="_p-apply" style="padding:8px 20px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">✅ 应用到选中行</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const sel = dialog.querySelector('#_preset-sel');
    const fillFields = (p) => {
        dialog.querySelector('#_p-voice').value = p.voiceId || '';
        dialog.querySelector('#_p-tpl').value = p.tpl || '';
        dialog.querySelector('#_p-overlay').value = p.overlayTpl || '';
        dialog.querySelector('#_p-bgscale').value = p.bgScale || 100;
        dialog.querySelector('#_p-bgdurscale').value = p.bgDurScale || 100;
        dialog.querySelector('#_p-audioscale').value = p.audioDurScale || 100;
    };
    sel.addEventListener('change', () => {
        const p = presets[sel.value];
        if (p) fillFields(p);
    });

    dialog.querySelector('#_p-save-btn').addEventListener('click', () => {
        const name = dialog.querySelector('#_p-save-name').value.trim();
        if (!name) { alert('请输入预设名称'); return; }
        presets[name] = _readPresetFields(dialog);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
        showToast(`预设「${name}」已保存`, 'success');
    });

    dialog.querySelector('#_p-del-btn')?.addEventListener('click', () => {
        const name = sel.value;
        if (!name) { alert('请先选择要删除的预设'); return; }
        if (!confirm(`确定删除预设「${name}」？`)) return;
        delete presets[name];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
        sel.querySelector(`option[value="${name}"]`)?.remove();
        showToast(`预设「${name}」已删除`, 'info');
    });

    dialog.querySelector('#_p-cancel').addEventListener('click', () => overlay.remove());

    dialog.querySelector('#_p-apply').addEventListener('click', () => {
        const preset = _readPresetFields(dialog);
        const indices = _getSelectedIndices();
        const tasks = window._reelsState.tasks;
        const targetIdxs = indices.length > 0 ? indices : tasks.map((_, i) => i);

        for (const idx of targetIdxs) {
            const task = tasks[idx];
            if (preset.voiceId) task.ttsVoiceId = preset.voiceId;
            if (preset.tpl) task._subtitlePreset = preset.tpl;
            if (preset.overlayTpl) {
                task._overlayPresetName = preset.overlayTpl;
                _applyOverlayGroupPresetToTask(task, preset.overlayTpl);
            }
            if (preset.bgScale !== undefined && preset.bgScale !== 100) task.bgScale = preset.bgScale;
            if (preset.bgDurScale !== undefined && preset.bgDurScale !== 100) task.bgDurScale = preset.bgDurScale;
            if (preset.audioDurScale !== undefined && preset.audioDurScale !== 100) task.audioDurScale = preset.audioDurScale;
        }
        overlay.remove();
        _skipNextApply = true;
        _renderBatchTable();
        showToast(`预设已应用到 ${targetIdxs.length} 行`, 'success');
    });
}

function _readPresetFields(dialog) {
    return {
        voiceId: dialog.querySelector('#_p-voice').value.trim(),
        tpl: dialog.querySelector('#_p-tpl').value.trim(),
        overlayTpl: dialog.querySelector('#_p-overlay').value.trim(),
        bgScale: parseInt(dialog.querySelector('#_p-bgscale').value) || 100,
        bgDurScale: parseInt(dialog.querySelector('#_p-bgdurscale').value) || 100,
        audioDurScale: parseInt(dialog.querySelector('#_p-audioscale').value) || 100,
    };
}

async function _openAISettingsModal() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);';
    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1a1a2e;border:1px solid #444;border-radius:12px;padding:24px;width:600px;max-width:90vw;color:#eee;font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,0.8);';

    dialog.innerHTML = `
        <h3 style="margin:0 0 16px;font-size:16px;color:#a78bfa;">⚙️ AI 设置 (Gemini)</h3>
        <p style="font-size:12px;color:#aaa;margin-bottom:16px;">配置用于 <b>文案改写流水线</b> 的 Gemini API Keys。支持轮询。</p>
        
        <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">API Keys (每行一个)</label>
            <textarea id="_ai-keys" rows="4" style="width:100%;box-sizing:border-box;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;" placeholder="每行一个 API Key&#10;支持 AIzaSy... (旧格式) 和 AQ... (新格式)"></textarea>
        </div>

        <div style="margin-bottom:12px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">模型选择</label>
            <select id="_ai-model" style="width:100%;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:13px;cursor:pointer;">
                <option value="gemini-2.5-flash">⚡ gemini-2.5-flash (GA·快速)</option>
                <option value="gemini-2.5-flash-lite">⚡ gemini-2.5-flash-lite (GA·最快最省)</option>
                <option value="gemini-2.5-pro">🧠 gemini-2.5-pro (GA·强推理)</option>
                <option value="gemini-3-flash-preview">gemini-3-flash-preview (Preview)</option>
                <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (Preview·最新)</option>
                <option value="gemini-3.1-flash-lite-preview" selected>gemini-3.1-flash-lite-preview (Preview·Lite⚡·默认)</option>
                <option value="gemma-4-31b-it">💎 Gemma 4 31B (Dense·256K·30RPM)</option>
                <option value="gemma-4-26b-it">💎 Gemma 4 26B MoE (256K·30RPM)</option>
            </select>
        </div>
        
        <div style="margin-bottom:16px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">自定义 Prompt (系统指令)</label>
            <textarea id="_ai-prompt" rows="6" style="width:100%;box-sizing:border-box;padding:8px;background:#222;color:#fff;border:1px solid #555;border-radius:6px;font-size:12px;resize:vertical;" placeholder="不填则使用系统默认提示词...\n可以通过改变这个提示词让 AI 写出更符合您要求的短文本。"></textarea>
        </div>
        
        <div style="margin-bottom:16px;">
            <label style="display:block;font-size:12px;color:#ccc;margin-bottom:6px;">字幕断行模式</label>
            <div style="display:block;gap:8px;">
                <label style="display:flex;align-items:center;font-size:12px;color:#eee;cursor:pointer;margin-bottom:6px;">
                    <input type="radio" name="_ai-lb-mode" value="ai" checked style="margin-right:6px;"> 
                    【AI 智能断行】: 完全由 AI 根据 Prompt 语义逻辑自动折行 (使用提示词中要求输出的 ||| 的断句结果)
                </label>
                <label style="display:flex;align-items:center;font-size:12px;color:#eee;cursor:pointer;">
                    <input type="radio" name="_ai-lb-mode" value="script" style="margin-right:6px;"> 
                    【脚本自动断行】: 忽略大模型的排版，使用 VideoKit 工具的 "智能分段 / 格式转换" 脚本强制拆分
                </label>
                <div id="_ai-lb-script-settings" style="margin-top:8px;margin-left:24px;display:none;align-items:center;gap:8px;">
                    <span style="color:#aaa;font-size:12px;">每行最大字符数:</span>
                    <input type="number" id="_ai-lb-max-chars" value="16" min="5" max="50" style="width:50px;background:#222;border:1px solid #555;color:#fff;border-radius:4px;padding:2px 4px;font-size:12px;text-align:center;">
                    <span style="color:#888;font-size:11px;">(中文字符上限，推荐 12-18)</span>
                </div>
            </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #333;padding-top:12px;">
            <button id="_ai-cancel" style="padding:8px 20px;background:#333;color:#aaa;border:1px solid #555;border-radius:6px;cursor:pointer;">取消</button>
            <button id="_ai-save" style="padding:8px 20px;background:linear-gradient(135deg,#a855f7,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:600;">💾 保存设置</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    dialog.querySelector('#_ai-cancel').addEventListener('click', () => overlay.remove());

    try {
        const resp = await apiFetch('settings/gemini-keys', { method: 'GET' });
        const data = await resp.json();
        if (data) {
            dialog.querySelector('#_ai-keys').value = (data.keys || []).join('\\n');
            if (data.model) dialog.querySelector('#_ai-model').value = data.model;
            if (data.prompt) dialog.querySelector('#_ai-prompt').value = data.prompt;
            if (data.lineBreakMode === 'script') {
                dialog.querySelector('input[name="_ai-lb-mode"][value="script"]').checked = true;
                dialog.querySelector('#_ai-lb-script-settings').style.display = 'flex';
            } else {
                dialog.querySelector('input[name="_ai-lb-mode"][value="ai"]').checked = true;
            }
            if (data.lbMaxChars) dialog.querySelector('#_ai-lb-max-chars').value = data.lbMaxChars;
        }
    } catch (e) {
        console.warn('获取 Gemini 设置失败', e);
    }

    const lbModeRadios = dialog.querySelectorAll('input[name="_ai-lb-mode"]');
    const scriptSettings = dialog.querySelector('#_ai-lb-script-settings');
    lbModeRadios.forEach(radio => radio.addEventListener('change', () => {
        scriptSettings.style.display = radio.value === 'script' ? 'flex' : 'none';
    }));

    dialog.querySelector('#_ai-save').addEventListener('click', async () => {
        const keyLines = dialog.querySelector('#_ai-keys').value.split('\\n').map(s => s.trim()).filter(s => s);
        const promptRaw = dialog.querySelector('#_ai-prompt').value; // let it be empty if space only
        const lbMode = dialog.querySelector('input[name="_ai-lb-mode"]:checked')?.value || 'ai';
        const selectedModel = dialog.querySelector('#_ai-model').value;
        const payload = {
            keys: keyLines,
            model: selectedModel,
            prompt: promptRaw || null,
            lineBreakMode: lbMode,
            lbMaxChars: parseInt(dialog.querySelector('#_ai-lb-max-chars').value) || 16
        };
        try {
            dialog.querySelector('#_ai-save').textContent = '保存中...';
            const res = await apiFetch('settings/gemini-keys', { method: 'POST', body: JSON.stringify(payload) });
            if (res.ok) {
                showToast('✅ AI设置保存成功', 'success');
                overlay.remove();
            } else {
                throw new Error('保存失败');
            }
        } catch (e) {
            alert('保存失败: ' + e.message);
            dialog.querySelector('#_ai-save').textContent = '💾 保存设置';
        }
    });
}

const _BG_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const _AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
const _SRT_EXTS = new Set(['srt']);
const _TXT_EXTS = new Set(['txt']);

/**
 * 读取文件夹 → 自动按类型分类 → 同名配对 → 创建任务行
 */
function _batchImportFolder(files) {
    if (!files || !files.length) return;
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    if (!state) return;

    // 按类型分桶
    const bgFiles = [];
    const audioFiles = [];
    const srtFiles = [];
    const txtFiles = [];

    for (const f of files) {
        const name = f.name || '';
        // 跳过隐藏文件和系统文件
        if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') continue;
        const ext = name.split('.').pop().toLowerCase();
        if (_AUDIO_EXTS.has(ext)) audioFiles.push(f);
        else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(name)) audioFiles.push(f);
        else if (_BG_EXTS.has(ext)) bgFiles.push(f);
        else if (_SRT_EXTS.has(ext)) srtFiles.push(f);
        else if (_TXT_EXTS.has(ext)) txtFiles.push(f);
    }

    if (!bgFiles.length && !audioFiles.length && !srtFiles.length && !txtFiles.length) {
        alert('文件夹中未找到支持的媒体文件');
        return;
    }

    // 提取基础匹配键（去除扩展名并应用 stopwords 过滤）
    function matchKey(f) {
        if (typeof window._buildAudioSubtitleMatchKey === 'function') {
            return window._buildAudioSubtitleMatchKey(f.name || '');
        }
        // 如果外部函数不可用，回退到基础去头尾处理
        const name = f.name || '';
        const dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name).trim().toLowerCase();
    }

    // 建立同名配对映射: matchKey → { bg, audio, srt, txt }
    const groups = new Map();

    function addToGroup(file, field) {
        const key = matchKey(file);
        if (!groups.has(key)) groups.set(key, { bg: null, audio: null, srt: null, txt: null });
        // 如果已经有该字段，优先保留第一个遇到的以稳定排序
        if (!groups.get(key)[field]) {
            groups.get(key)[field] = file;
        }
    }

    bgFiles.forEach(f => addToGroup(f, 'bg'));
    audioFiles.forEach(f => addToGroup(f, 'audio'));
    srtFiles.forEach(f => addToGroup(f, 'srt'));
    txtFiles.forEach(f => addToGroup(f, 'txt'));

    // 按名称排序
    const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));

    let created = 0;
    for (const bn of sortedKeys) {
        const g = groups.get(bn);
        const taskName = bn || `task_${String(state.tasks.length + 1).padStart(3, '0')}`;

        const task = {
            baseName: taskName,
            fileName: `${taskName}.mp4`,
            bgPath: g.bg ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.bg) : (g.bg.path || g.bg.name)) : null,
            bgSrcUrl: null,
            audioPath: g.audio ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.audio) : (g.audio.path || g.audio.name)) : null,
            srtPath: g.srt ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.srt) : (g.srt.path || g.srt.name)) : null,
            txtPath: g.txt ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.txt) : (g.txt.path || g.txt.name)) : null,
            txtContent: null,
            aligned: false,
            segments: [],
            videoPath: g.bg ? ((typeof getFileNativePath === 'function') ? getFileNativePath(g.bg) : (g.bg.path || g.bg.name)) : null,
            srcUrl: null,
            overlays: [],
        };

        // 生成预览 URL
        if (g.bg) {
            try { task.bgSrcUrl = URL.createObjectURL(g.bg); } catch (e) { }
        }

        // 读取 SRT 内容
        if (g.srt) {
            _readSrtFileToTask(task, g.srt);
        }

        // 读取 TXT 内容
        if (g.txt) {
            _readTxtFileToTask(task, g.txt);
        }

        state.tasks.push(task);
        created++;
    }

    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    const summary = [];
    if (bgFiles.length) summary.push(`${bgFiles.length} 个背景`);
    if (audioFiles.length) summary.push(`${audioFiles.length} 个音频`);
    if (srtFiles.length) summary.push(`${srtFiles.length} 个字幕`);
    if (txtFiles.length) summary.push(`${txtFiles.length} 个TXT文案`);
    alert(`✅ 从文件夹导入 ${created} 个任务\n检测到: ${summary.join(', ')}\n同名文件已自动配对`);
}

// ═══════════════════════════════════════════════════════
// 9b. File assignment helpers
// ═══════════════════════════════════════════════════════

function _openHookModal(idx) {
    const container = _batchTableState.container;
    if (!container) return;
    const hookModal = container.querySelector('#rbt-hook-modal');
    if (!hookModal) return;

    hookModal.dataset.editIdx = String(idx);

    // Initial clear
    const pathInput = container.querySelector('#rbt-hook-path');
    const startInput = container.querySelector('#rbt-hook-start');
    const endInput = container.querySelector('#rbt-hook-end');
    const speedInput = container.querySelector('#rbt-hook-speed');
    const transInput = container.querySelector('#rbt-hook-transition');
    const durInput = container.querySelector('#rbt-hook-trans-dur');

    if (pathInput) pathInput.value = '';
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    if (speedInput) speedInput.value = '1';
    if (transInput) transInput.value = 'none';
    if (durInput) durInput.value = '0.5';

    let targetTask = null;
    if (idx >= 0) {
        targetTask = window._reelsState.tasks[idx];
    } else {
        const indices = _getSelectedIndices();
        if (indices.length > 0) {
            targetTask = window._reelsState.tasks[indices[0]];
        }
    }

    if (targetTask) {
        const resolvedHookPath = targetTask.hookFile || ((targetTask.hook && targetTask.hook.enabled !== false) ? (targetTask.hook.path || '') : '');
        if (pathInput) pathInput.value = resolvedHookPath;
        if (startInput) startInput.value = targetTask.hookTrimStart != null ? targetTask.hookTrimStart : '';
        if (endInput) endInput.value = targetTask.hookTrimEnd != null ? targetTask.hookTrimEnd : '';
        if (speedInput) speedInput.value = targetTask.hookSpeed || '1';
        if (transInput) transInput.value = targetTask.hookTransition || 'none';
        if (durInput) durInput.value = targetTask.hookTransDuration || '0.5';
    }

    _updateHookPreview();
    hookModal.style.display = 'flex';
}

function _updateHookPreview() {
    const container = _batchTableState.container;
    if (!container) return;
    const pathInput = container.querySelector('#rbt-hook-path');
    const previewContainer = container.querySelector('#rbt-hook-preview-container');
    const videoPreview = container.querySelector('#rbt-hook-preview-video');
    const imgPreview = container.querySelector('#rbt-hook-preview-img');
    const startInput = container.querySelector('#rbt-hook-start');
    
    if (!pathInput || !previewContainer || !videoPreview || !imgPreview) return;
    
    const filePath = pathInput.value.trim();
    if (!filePath) {
        previewContainer.style.display = 'none';
        videoPreview.src = '';
        imgPreview.src = '';
        return;
    }
    
    previewContainer.style.display = 'block';
    const fileUrl = (window.electronAPI && window.electronAPI.toFileUrl)
        ? window.electronAPI.toFileUrl(filePath)
        : 'file://' + filePath;
    const ext = filePath.split('.').pop().toLowerCase();
    
    if (['mp4', 'webm', 'ogg', 'mov', 'mkv'].includes(ext)) {
        imgPreview.style.display = 'none';
        videoPreview.style.display = 'block';
        // Use decodeURIComponent for comparison to handle encoded paths
        const currentSrc = videoPreview.src || '';
        const isSameSrc = currentSrc === fileUrl || decodeURIComponent(currentSrc) === decodeURIComponent(fileUrl);
        if (!isSameSrc) {
            videoPreview.src = fileUrl;
            videoPreview.onloadedmetadata = () => {
                const startTime = parseFloat(startInput?.value) || 0;
                videoPreview.currentTime = startTime;
            };
        } else {
            const startTime = parseFloat(startInput?.value) || 0;
            videoPreview.currentTime = startTime;
        }
    } else if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        videoPreview.style.display = 'none';
        imgPreview.style.display = 'block';
        imgPreview.src = fileUrl;
    } else {
        previewContainer.style.display = 'none';
    }
}

function _openCoverModal(idx) {
    const container = _batchTableState.container;
    if (!container) return;
    const coverModal = container.querySelector('#rbt-cover-modal');
    if (!coverModal) return;

    coverModal.dataset.editIdx = String(idx);

    const enabledCb = container.querySelector('#rbt-cover-enabled');
    const separateExportCb = container.querySelector('#rbt-cover-export-separate');
    const bgPathInput = container.querySelector('#rbt-cover-bg-path');
    const durationInput = container.querySelector('#rbt-cover-duration');
    const previewContainer = container.querySelector('#rbt-cover-preview-container');
    const previewImg = container.querySelector('#rbt-cover-preview-img');
    const hintText = container.querySelector('#rbt-cover-preview-hint');

    // Default clear
    if (enabledCb) enabledCb.checked = false;
    if (separateExportCb) separateExportCb.checked = true; // default on
    if (bgPathInput) bgPathInput.value = '';
    if (durationInput) durationInput.value = '0';
    if (previewContainer) previewContainer.style.display = 'flex';
    if (previewImg) { previewImg.src = ''; previewImg.style.display = 'none'; }
    if (hintText) hintText.style.display = 'block';

    let targetTask = null;
    if (idx >= 0) {
        targetTask = window._reelsState.tasks[idx];
    }

    if (targetTask && targetTask.cover) {
        if (enabledCb) enabledCb.checked = !!targetTask.cover.enabled;
        if (separateExportCb) separateExportCb.checked = targetTask.cover.exportSeparate !== false;
        if (durationInput) durationInput.value = targetTask.cover.duration || '0';
        if (bgPathInput && targetTask.cover.bgPath) {
            bgPathInput.value = targetTask.cover.bgPath;
            if (previewImg && hintText) {
                const filePath = targetTask.cover.bgPath;
                const url = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(filePath) : `file://${filePath}`;
                previewImg.src = url;
                previewImg.style.display = 'block';
                hintText.style.display = 'none';
            }
        }
    }

    const overlaySel = container.querySelector('#rbt-cover-overlay-sel');
    if (overlaySel) {
        let currentVal = overlaySel.value;
        overlaySel.innerHTML = '<option value="">-- 使用独立卡片配置 --</option>';
        if (window.ReelsOverlay) {
            let presets = {};
            try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
            for (const key of Object.keys(presets)) {
                const option = document.createElement('option');
                option.value = key; option.textContent = key;
                overlaySel.appendChild(option);
            }
        }
        if (targetTask && targetTask.cover && targetTask.cover.overlayTpl) currentVal = targetTask.cover.overlayTpl;
        overlaySel.value = currentVal || '';
    }

    const presetSel = container.querySelector('#rbt-cover-preset-sel');
    if (presetSel) {
        let savedPresets = {};
        try { savedPresets = JSON.parse(localStorage.getItem('videokit_cover_presets') || '{}'); } catch(e){}
        presetSel.innerHTML = '<option value="">---预设---</option>';
        for (const key of Object.keys(savedPresets)) {
            const option = document.createElement('option');
            option.value = key; option.textContent = key;
            presetSel.appendChild(option);
        }
        presetSel.value = '';
    }

    coverModal.style.display = 'flex';
}

/**
 * 显示批量分配模式对话框
 */
function _showBatchModeDialog(fileCount, field) {
    const fieldLabel = { bg: '背景素材', audio: '音频', srt: '字幕', txt: 'TXT', hook: 'Hook', pip: '图像覆层' }[field] || field;
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px;min-width:320px;color:#eee;font-size:14px;';
        const isSingle = fileCount === 1;
        dialog.innerHTML = `
            <h3 style="margin:0 0 14px;font-size:16px;">📂 批量${fieldLabel} · ${fileCount} 个文件</h3>
            <div style="display:flex;flex-direction:column;gap:8px;">
                <button data-mode="fill" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#2a3a4a;color:#cce;cursor:pointer;text-align:left;font-size:13px;">
                    📥 <b>补全</b> — 填入空位，多余的添加新行
                </button>
                <button data-mode="overwrite" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#4a2a2a;color:#ecc;cursor:pointer;text-align:left;font-size:13px;">
                    ✏️ <b>覆盖</b> — 从第1行开始覆盖
                </button>
                <button data-mode="append" style="padding:10px 16px;border:1px solid #555;border-radius:8px;background:#2a4a2a;color:#cec;cursor:pointer;text-align:left;font-size:13px;">
                    ➕ <b>添加新行</b> — 全部作为新行追加
                </button>
                ${isSingle ? `<button data-mode="applyall" style="padding:10px 16px;border:1px solid #7b5aab;border-radius:8px;background:#3a2a5a;color:#d0b0ff;cursor:pointer;text-align:left;font-size:13px;">
                    🔄 <b>应用到全部行</b> — 所有行都用这个文件
                </button>` : ''}
                ${field === 'bg' ? `<button data-mode="fill_hook" style="padding:10px 16px;border:1px solid #7a6a4a;border-radius:8px;background:#3a3a2a;color:#e0d0a0;cursor:pointer;text-align:left;font-size:13px;margin-bottom:8px;">
                    🪝 <b>填充到前置Hook</b> — 将视频/图片填入Hook列
                </button>
                <button data-mode="fill_audio" style="padding:10px 16px;border:1px solid #5a8a5a;border-radius:8px;background:#2a4a3a;color:#a0e0c0;cursor:pointer;text-align:left;font-size:13px;">
                    🎙 <b>填充到音频</b> — 将视频填入音频列
                </button>` : ''}
            </div>
            <button data-mode="cancel" style="margin-top:12px;padding:6px 16px;border:1px solid #555;border-radius:6px;background:#333;color:#aaa;cursor:pointer;width:100%;font-size:13px;">取消</button>
        `;
        dialog.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve(btn.dataset.mode);
            });
        });
        overlay.appendChild(dialog);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve('cancel'); } });
        document.body.appendChild(overlay);
    });
}

/** 将文件应用到任务 */
function _assignFileToTask(task, file, field) {
    const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
    if (field === 'hook') {
        task.hookFile = filePath;
        if (task.hookSpeed == null) task.hookSpeed = 1;
        if (task.hookTransition == null) task.hookTransition = 'none';
        if (task.hookTransDuration == null) task.hookTransDuration = 0.5;
    } else if (field === 'bg') {
        task.bgPath = filePath;
        task.videoPath = filePath;
        try { task.bgSrcUrl = URL.createObjectURL(file); } catch (e) { }
    } else if (field === 'audio') {
        task.audioPath = filePath;
    } else if (field === 'srt') {
        task.srtPath = filePath;
        _readSrtFileToTask(task, file);
    } else if (field === 'txt') {
        task.txtPath = filePath;
        _readTxtFileToTask(task, file);
    } else if (field === 'pip') {
        task.pipPath = filePath;
    } else if (field === 'contentvideo') {
        task.contentVideoPath = filePath;
        if (task.contentVideoScale == null) task.contentVideoScale = 100;
        if (task.contentVideoX == null) task.contentVideoX = 'center';
        if (task.contentVideoY == null) task.contentVideoY = 'center';
    }
}

/** 创建空行 */
function _createEmptyTask() {
    const state = window._reelsState;
    const ReelsOverlay = window.ReelsOverlay;
    const taskName = `card_${String((state.tasks || []).length + 1).padStart(3, '0')}`;
    return {
        baseName: taskName,
        fileName: `${taskName}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: [],
        ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
    };
}

/**
 * 批量分配文件到各行 — 支持多种模式
 */
async function _batchAssignFiles(files, field) {
    const state = window._reelsState;
    if (!state || !files || files.length === 0) return;

    files.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    const mode = await _showBatchModeDialog(files.length, field);
    if (mode === 'cancel') return;

    if (mode === 'applyall') {
        // 应用单个文件到所有现有行
        const file = files[0];
        for (const task of state.tasks) {
            _assignFileToTask(task, file, field);
        }
    } else if (mode === 'fill') {
        // 补全：填入空位
        let taskIdx = 0;
        for (const file of files) {
            // 找空位
            while (taskIdx < state.tasks.length) {
                const tk = state.tasks[taskIdx];
                let occupied = false;
                if (field === 'hook') occupied = !!tk.hookFile;
                else if (field === 'bg') occupied = !!(tk.bgPath || tk.videoPath);
                else if (field === 'audio') occupied = !!tk.audioPath;
                else if (field === 'srt') occupied = !!tk.srtPath;
                else if (field === 'txt') occupied = !!tk.txtPath;
                else if (field === 'pip') occupied = !!tk.pipPath;
                else if (field === 'contentvideo') occupied = !!tk.contentVideoPath;
                if (!occupied) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                const newTask = _createEmptyTask();
                state.tasks.push(newTask);
            }
            _assignFileToTask(state.tasks[taskIdx], file, field);
            taskIdx++;
        }
    } else if (mode === 'overwrite') {
        // 覆盖：从第1行开始
        for (let i = 0; i < files.length; i++) {
            if (i >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[i], files[i], field);
        }
    } else if (mode === 'append') {
        // 添加新行
        for (const file of files) {
            const newTask = _createEmptyTask();
            _assignFileToTask(newTask, file, field);
            state.tasks.push(newTask);
        }
    } else if (mode === 'fill_audio') {
        // 将视频文件填充到音频列（补全空位）
        let taskIdx = 0;
        for (const file of files) {
            while (taskIdx < state.tasks.length) {
                if (!state.tasks[taskIdx].audioPath) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[taskIdx], file, 'audio');
            taskIdx++;
        }
    } else if (mode === 'fill_hook') {
        // 将文件填充到Hook列（补全空位）
        let taskIdx = 0;
        for (const file of files) {
            while (taskIdx < state.tasks.length) {
                if (!state.tasks[taskIdx].hookFile) break;
                taskIdx++;
            }
            if (taskIdx >= state.tasks.length) {
                state.tasks.push(_createEmptyTask());
            }
            _assignFileToTask(state.tasks[taskIdx], file, 'hook');
            taskIdx++;
        }
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
}

/**
 * 批量分配 TXT 文件到各行
 * 1. 先按 matchKey 尝试匹配已有行（同名视频/音频）
 * 2. 没匹配到则顺序找「有背景但还没有 txtContent」的行
 * 3. 还没有就新建行
 */
function _batchAssignTxtFiles(files) {
    const state = window._reelsState;
    if (!state) return;
    const ReelsOverlay = window.ReelsOverlay;

    function getMatchKey(name) {
        if (typeof window._buildAudioSubtitleMatchKey === 'function') {
            return window._buildAudioSubtitleMatchKey(name || '');
        }
        const n = String(name || '');
        const dot = n.lastIndexOf('.');
        return (dot > 0 ? n.substring(0, dot) : n).trim().toLowerCase();
    }

    files.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    let fallbackIdx = 0;
    for (const file of files) {
        const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);
        const key = getMatchKey(file.name);

        // 尝试按名字匹配已有行（用 matchKey 比较）
        let targetTask = state.tasks.find(t => {
            const bgKey = getMatchKey(t.bgPath || t.videoPath || '');
            const audioKey = getMatchKey(t.audioPath || '');
            const baseKey = getMatchKey(t.baseName || '');
            return (bgKey && bgKey === key) || (audioKey && audioKey === key) || (baseKey && baseKey === key);
        });

        // 没匹配到：顺序找「有背景但还没有 txtContent」的行
        if (!targetTask) {
            while (fallbackIdx < state.tasks.length) {
                const tk = state.tasks[fallbackIdx];
                if (!tk.txtContent && !tk.srtPath) {
                    targetTask = tk;
                    break;
                }
                fallbackIdx++;
            }
        }

        // 还没找到则新建行
        if (!targetTask) {
            const baseName = key || `card_${String(state.tasks.length + 1).padStart(3, '0')}`;
            targetTask = {
                baseName: baseName,
                fileName: `${baseName}.mp4`,
                bgPath: null, bgSrcUrl: null,
                audioPath: null, srtPath: null,
                segments: [],
                videoPath: null, srcUrl: null,
                overlays: [],
            };
            state.tasks.push(targetTask);
            fallbackIdx = state.tasks.length;
        }

        targetTask.txtPath = filePath;
        targetTask.aligned = false;

        // 异步读取文件内容
        _readTxtFileToTask(targetTask, file);

        fallbackIdx++;
    }

    _skipNextApply = true;
    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    alert(`✅ 已分配 ${files.length} 个 TXT 文案文件`);
}

/**
 * 点击单元格 → 选择一个文件
 */
function _pickSingleFile(idx, field) {
    const container = _batchTableState.container;
    if (!container) return;
    const fileInput = container.querySelector('#rbt-file-single');
    if (!fileInput) return;

    // 根据字段设置 accept
    if (field === 'bg') {
        fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm,.jpg,.jpeg,.png,.webp';
    } else if (field === 'audio') {
        fileInput.accept = '.mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
    } else if (field === 'srt') {
        fileInput.accept = '.srt';
    } else if (field === 'txt') {
        fileInput.accept = '.txt';
    } else if (field === 'pip') {
        fileInput.accept = 'image/*,video/*';
    } else if (field === 'contentvideo') {
        fileInput.accept = '.mp4,.mov,.mkv,.avi,.wmv,.flv,.webm';
    }

    _batchTableState._pendingSingle = { idx, field };
    fileInput.click();
}

/**
 * 分配单个文件到指定行
 */
function _assignSingleFile(idx, field, file) {
    const state = window._reelsState;
    if (!state || !state.tasks[idx]) return;
    const task = state.tasks[idx];
    const filePath = (typeof getFileNativePath === 'function') ? getFileNativePath(file) : (file.path || file.name);

    console.log(`[BatchTable] _assignSingleFile idx=${idx} field=${field} filePath=${filePath} file.name=${file.name}`);

    if (field === 'bg') {
        task.bgPath = filePath;
        task.videoPath = filePath;
        try { task.bgSrcUrl = URL.createObjectURL(file); } catch (e) { }
    } else if (field === 'audio') {
        task.audioPath = filePath;
    } else if (field === 'srt') {
        task.srtPath = filePath;
        _readSrtFileToTask(task, file);
        console.log(`[BatchTable] After _readSrtFileToTask: segments.length=${(task.segments||[]).length}`);
    } else if (field === 'txt') {
        task.txtPath = filePath;
        _readTxtFileToTask(task, file);
    } else if (field === 'pip') {
        task.pipPath = filePath;
    } else if (field === 'contentvideo') {
        task.contentVideoPath = filePath;
        if (task.contentVideoScale == null) task.contentVideoScale = 100;
        if (task.contentVideoX == null) task.contentVideoX = 'center';
        if (task.contentVideoY == null) task.contentVideoY = 'center';
    }

    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
}

/**
 * 读取 SRT 文件内容到 task.segments
 */
function _readSrtFileToTask(task, file) {
    const filePath = task.srtPath;
    console.log('[SRT] _readSrtFileToTask called, filePath:', filePath, 'hasFile:', !!file);

    // 优先用 FileReader — 直接读 File 对象的 blob 内容，不依赖路径，Electron 和浏览器通用
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            const content = ev.target.result;
            console.log('[SRT] FileReader result, content length:', content?.length);
            if (!content) { console.warn('[SRT] FileReader returned empty'); return; }
            _parseSrtContent(task, content);
            console.log('[SRT] ✅ loaded via FileReader, segments:', task.segments?.length);
            if (_batchTableState.visible) _renderBatchTable();
            if (typeof _renderTaskList === 'function') _renderTaskList();
        };
        reader.onerror = (err) => {
            console.warn('[SRT] FileReader error:', err, '— trying electronAPI fallback');
            _readSrtViaElectronAPI(task, filePath);
        };
        reader.readAsText(file);
        return;
    }

    // 回退：用 Electron 同步 API（当只有路径没有 File 对象时）
    _readSrtViaElectronAPI(task, filePath);
}

function _readSrtViaElectronAPI(task, filePath) {
    if (filePath && window.electronAPI && window.electronAPI.readFileText) {
        try {
            const content = window.electronAPI.readFileText(filePath);
            if (content) {
                _parseSrtContent(task, content);
                console.log('[SRT] ✅ loaded via electronAPI:', filePath, 'segments:', task.segments?.length);
                if (_batchTableState.visible) _renderBatchTable();
                if (typeof _renderTaskList === 'function') _renderTaskList();
                return;
            }
        } catch (e) {
            console.warn('[SRT] electronAPI.readFileText error:', e);
        }
    }
    console.warn('[SRT] ❌ Failed to load SRT:', filePath);
}

function _parseSrtContent(task, content) {
    // parseSRT 定义在 reels-canvas-renderer.js，暴露在 window.parseSRT
    const parser = (typeof parseSRT === 'function') ? parseSRT : window.parseSRT;
    if (parser) {
        const rawSegs = parser(content).map(seg => ({ ...seg, _timeUnit: 'sec' }));
        task.segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
    } else {
        console.error('[SRT] parseSRT function not found!');
        task.segments = [];
    }
}

/**
 * 读取 TXT 文件内容到 task.txtContent
 */
function _readTxtFileToTask(task, file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        task.txtContent = ev.target.result || '';
        task.aligned = false;
        // 刷新表格显示加载的文案
        if (_batchTableState.visible) _renderBatchTable();
    };
    reader.readAsText(file);
}

/**
 * 智能断行 (批量表格内用)
 * 英文 ~5 词/行，中文 ~16 字/行，已有换行保留
 */
function _rbtSmartLineBreak(text, customMaxChars) {
    if (!text || typeof text !== 'string') return text;
    const defaultMaxChars = customMaxChars || 16;
    // 按行处理，保留已有换行
    const lines = text.split('\n');
    const result = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length <= 10) { result.push(trimmed); continue; }

        const cjkCount = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
        const isCJK = cjkCount / trimmed.length > 0.3;

        if (isCJK) {
            const maxChars = defaultMaxChars;
            let pos = 0;
            while (pos < trimmed.length) {
                let end = Math.min(pos + maxChars, trimmed.length);
                if (end < trimmed.length) {
                    const chunk = trimmed.slice(pos, end + 4);
                    const breakAt = chunk.search(/[，。！？；、\s,\.!?;]/g);
                    if (breakAt > maxChars * 0.5) end = pos + breakAt + 1;
                }
                result.push(trimmed.slice(pos, end).trim());
                pos = end;
                while (pos < trimmed.length && trimmed[pos] === ' ') pos++;
            }
        } else {
            const words = trimmed.split(/\s+/);
            if (words.length <= 5) { result.push(trimmed); continue; }
            for (let i = 0; i < words.length; i += 5) {
                result.push(words.slice(i, i + 5).join(' '));
            }
        }
    }
    return result.filter(l => l).join('\n');
}

// ═══════════════════════════════════════════════════════
// 10. Batch Alignment (对齐字幕)
// ═══════════════════════════════════════════════════════

async function _batchAlignAllTasks(overrideForce = false) {
    // 先同步表格输入到 task
    _applyBatchTableChanges();

    const state = window._reelsState;
    if (!state) return;

    const alignSource = document.getElementById('rbt-align-source')?.value || 'audio';
    const forceRealign = document.getElementById('rbt-force-realign')?.checked || false;

    const textSourceCol = document.getElementById('rbt-align-txt-col')?.value || 'txtContent';

    const getSourceText = (t) => {
        if (textSourceCol === 'ttsText') return t.ttsText || '';
        if (textSourceCol === 'txtContent') return t.txtContent || '';
        if (textSourceCol === 'overlay_title') return (t.overlays && t.overlays[0]) ? t.overlays[0].title_text || '' : '';
        if (textSourceCol === 'overlay_body') return (t.overlays && t.overlays[0]) ? t.overlays[0].body_text || '' : '';
        if (textSourceCol === 'scroll_body') {
            const sov = (t.overlays || []).find(o => o && o.type === 'scroll');
            return sov ? sov.content || '' : '';
        }
        return '';
    };

    // 筛选需要对齐的任务: 选定的文本列有内容 + 有音频源 + (未对齐 或 强制)
    const tasksToAlign = state.tasks.filter(t => {
        const text = getSourceText(t);
        if (!text || !text.trim()) return false;
        if (t.aligned && !forceRealign && !overrideForce) return false;
        const hasAudio = alignSource === 'video'
            ? (t.bgPath || t.videoPath)
            : t.audioPath;
        return !!hasAudio;
    });

    if (tasksToAlign.length === 0) {
        alert('没有需要对齐的任务。\n请确认：\n1. 人声字幕列有文案\n2. 有音频/视频文件\n3. 尚未对齐');
        return;
    }

    let lbMaxChars = 16;
    try {
        const settingsResp = await apiFetch('settings/gemini-keys');
        const settingsData = await settingsResp.json();
        if (settingsData && settingsData.lbMaxChars) lbMaxChars = settingsData.lbMaxChars;
    } catch(e) {}

    const progressEl = document.getElementById('rbt-align-progress');
    const alignBtn = document.getElementById('rbt-align-all-btn');
    if (alignBtn) { alignBtn.disabled = true; alignBtn.textContent = '⏳ 对齐中...'; }

    let ok = 0, fail = 0;
    const failDetails = [];
    const language = document.getElementById('rbt-align-lang')?.value || '英语';

    for (let i = 0; i < tasksToAlign.length; i++) {
        const task = tasksToAlign[i];
        const taskName = task.baseName || task.fileName || `任务${i + 1}`;
        if (progressEl) progressEl.textContent = `🔗 对齐 ${i + 1}/${tasksToAlign.length}: ${taskName}`;

        try {
            // 确定音频路径
            const audioPath = alignSource === 'video'
                ? (task.bgPath || task.videoPath)
                : task.audioPath;

            if (!audioPath) throw new Error('没有音频文件');

            // 自动断行文案
            const sourceText = _rbtSmartLineBreak(getSourceText(task), lbMaxChars);

            // 调用对齐API（使用 apiFetch + API_BASE）
            const audioDir = audioPath.replace(/[\\/][^\\/]+$/, '');
            const resp = await apiFetch(`${API_BASE}/subtitle/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audio_path: audioPath,
                    source_text: sourceText,
                    language: language,
                    audio_cut_length: 5.0,
                    output_dir: audioDir,
                    force: (task.aligned || overrideForce) ? true : false,  // 已对齐过则强制重新转录
                }),
            });

            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || '对齐失败');
            }

            const data = await resp.json();

            // 保存 SRT 路径并解析 segments
            if (data.files && data.files.length > 0) {
                const srtFile = data.files.find(f => f.endsWith('_source.srt')) || data.files[0];
                task.srtPath = srtFile;

                if (window.electronAPI && window.electronAPI.readFileText) {
                    const srtContent = await window.electronAPI.readFileText(srtFile);
                    const rawSegs = (typeof parseSRT === 'function' ? parseSRT(srtContent) : []).map(seg => ({ ...seg, _timeUnit: 'sec' }));
                    task.segments = window.ReelsSubtitleProcessor
                        ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                        : rawSegs;
                }
            }

            task.aligned = true;
            ok++;
        } catch (err) {
            console.error('[BatchAlign] Failed:', taskName, err);
            failDetails.push(`${taskName}: ${err.message}`);
            fail++;
        }
    }

    // 完成
    if (alignBtn) { alignBtn.disabled = false; alignBtn.textContent = '🔗 对齐字幕'; }
    if (progressEl) {
        progressEl.textContent = fail > 0
            ? `⚠️ 对齐完成 ${ok}/${tasksToAlign.length}，失败 ${fail}`
            : `✅ 全部对齐完成 (${ok}个)`;
        setTimeout(() => { if (progressEl) progressEl.textContent = ''; }, 8000);
    }

    _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();

    if (fail > 0) {
        alert(`对齐完成 ${ok}/${tasksToAlign.length}\n\n失败:\n${failDetails.slice(0, 5).join('\n')}`);
    } else {
        alert(`✅ 字幕对齐完成 ${ok} 个任务\nSRT 文件已自动保存到音频文件所在目录`);
    }
}

// ═══════════════════════════════════════════════════════
// 10b. Batch selection helpers
// ═══════════════════════════════════════════════════════

function _getSelectedIndices() {
    return Array.from(_batchTableState.selectedRows).sort((a, b) => a - b);
}

function _updateBatchSelectCount() {
    const container = _batchTableState.container;
    if (!container) return;
    const el = container.querySelector('#rbt-selected-count');
    const exportBtn = container.querySelector('#rbt-export-selected-btn');
    const count = _batchTableState.selectedRows.size;
    if (el) el.textContent = count > 0 ? `已选 ${count} 行` : '';
    if (exportBtn) exportBtn.style.display = count > 0 ? '' : 'none';
    
    const tasks = window._reelsState?.tasks || [];
    const allSelected = tasks.length > 0 && count === tasks.length;
    const sa = container.querySelector('#rbt-select-all');
    const ha = container.querySelector('#rbt-header-select-all');
    if (sa) sa.checked = allSelected;
    if (ha) ha.checked = allSelected;
}

// ═══════════════════════════════════════════════════════
// 10c. Material folder refresh
// ═══════════════════════════════════════════════════════

const _MAT_BG_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);
const _MAT_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma']);
const _MAT_SRT_EXTS = new Set(['srt']);
const _MAT_TXT_EXTS = new Set(['txt']);

function _shuffleArray(arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function _randomUniqueFirstAssign(targetTasks, poolPaths, applyFn) {
    if (!Array.isArray(targetTasks) || targetTasks.length === 0) return 0;
    const uniquePool = Array.from(new Set((poolPaths || []).filter(Boolean)));
    if (uniquePool.length === 0) return 0;

    // 先使用不重复随机序列；不够时再重复（每轮重洗）
    let deck = _shuffleArray(uniquePool);
    let cursor = 0;
    let filled = 0;
    for (const task of targetTasks) {
        if (!task) continue;
        if (cursor >= deck.length) {
            deck = _shuffleArray(uniquePool);
            cursor = 0;
        }
        const path = deck[cursor++];
        if (!path) continue;
        applyFn(task, path);
        filled++;
    }
    return filled;
}

async function _refreshMaterialFolder() {
    const tab = _getActiveTab();
    if (!tab.materialDir) {
        alert('请先设置素材文件夹');
        return;
    }

    const refreshBtn = _batchTableState.container?.querySelector('#rbt-refresh-mat');
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.textContent = '⏳ 扫描中...';
    }

    try {
        let files;
        if (window.electronAPI && window.electronAPI.scanDirectory) {
            files = await window.electronAPI.scanDirectory(tab.materialDir);
        } else {
            alert('请在桌面应用中使用此功能');
            return;
        }

        if (!files || files.length === 0) {
            alert('文件夹为空或无法读取');
            return;
        }

        // Classify files
        const classified = { bg: [], audio: [], srt: [], txt: [] };
        for (const f of files) {
            const ext = (f.name || '').split('.').pop().toLowerCase();
            if (_MAT_AUDIO_EXTS.has(ext)) classified.audio.push(f);
            else if (_VOICE_VIDEO_EXTS.has(ext) && _looksLikeVoiceTrack(f.name || '')) classified.audio.push(f);
            else if (_MAT_BG_EXTS.has(ext)) classified.bg.push(f);
            else if (_MAT_SRT_EXTS.has(ext)) classified.srt.push(f);
            else if (_MAT_TXT_EXTS.has(ext)) classified.txt.push(f);
        }

        const state = window._reelsState;
        const tasks = state.tasks || [];

        // Build a map: baseName → task index for existing tasks
        const existingMap = new Map();
        tasks.forEach((t, i) => {
            const bgBase = _baseFileName(t.bgPath || t.videoPath || '');
            const audioBase = _baseFileName(t.audioPath || '');
            if (bgBase) existingMap.set(bgBase, i);
            if (audioBase) existingMap.set(audioBase, i);
        });

        let newCount = 0, updateCount = 0, randomFillCount = 0;

        // Match by baseName: group files
        const groups = new Map(); // baseName → { bg, audio, srt, txt }
        const matchedBgPaths = new Set();
        const allFiles = [
            ...classified.bg.map(f => ({ ...f, type: 'bg' })),
            ...classified.audio.map(f => ({ ...f, type: 'audio' })),
            ...classified.srt.map(f => ({ ...f, type: 'srt' })),
            ...classified.txt.map(f => ({ ...f, type: 'txt' })),
        ];
        for (const f of allFiles) {
            const base = _baseFileName(f.name);
            if (!groups.has(base)) groups.set(base, {});
            groups.get(base)[f.type] = f;
        }

        // Process each group
        for (const [base, group] of groups) {
            let taskIdx = existingMap.get(base);
            let task;
            if (group.bg && group.bg.path) matchedBgPaths.add(group.bg.path);

            if (taskIdx != null) {
                task = tasks[taskIdx];
                // Update existing task if files changed
                let changed = false;
                if (group.bg && task.bgPath !== group.bg.path) {
                    task.bgPath = group.bg.path; task.videoPath = group.bg.path; task.bgSrcUrl = ''; changed = true;
                }
                if (group.audio && task.audioPath !== group.audio.path) {
                    task.audioPath = group.audio.path; changed = true;
                }
                if (group.srt && task.srtPath !== group.srt.path) {
                    task.srtPath = group.srt.path; changed = true;
                }
                if (changed) {
                    task._justRefreshed = true;
                    updateCount++;
                }
            } else {
                // Create new task
                task = _createEmptyTask();
                task.baseName = base;
                if (group.bg) {
                    task.bgPath = group.bg.path;
                    task.videoPath = group.bg.path;
                }
                if (group.audio) { task.audioPath = group.audio.path; }
                if (group.srt) { task.srtPath = group.srt.path; }
                task._justRefreshed = true;
                tasks.push(task);
                newCount++;
            }
        }

        // 随机补齐背景：
        // 1) 优先使用“未参与同名匹配”的背景素材
        // 2) 素材不足时允许重复随机分配
        const unmatchedTasks = tasks.filter(t => !(t.bgPath || t.videoPath));
        if (unmatchedTasks.length > 0 && classified.bg.length > 0) {
            const bgAllPaths = classified.bg.map(f => f.path).filter(Boolean);
            const bgUnmatchedFirst = bgAllPaths.filter(p => !matchedBgPaths.has(p));
            const primaryPool = bgUnmatchedFirst.length > 0 ? bgUnmatchedFirst : bgAllPaths;

            randomFillCount = _randomUniqueFirstAssign(unmatchedTasks, primaryPool, (task, bgPath) => {
                task.bgPath = bgPath;
                task.videoPath = bgPath;
                task.bgSrcUrl = '';
                task._justRefreshed = true;
            });
        }

        tab.lastRefreshTime = Date.now();
        state.tasks = tasks;

        _renderBatchTable();

        // Clear _justRefreshed flags after animation
        setTimeout(() => {
            for (const t of state.tasks) delete t._justRefreshed;
        }, 3500);

        const summary = [];
        if (newCount > 0) summary.push(`🆕 新增 ${newCount} 行`);
        if (updateCount > 0) summary.push(`🔄 更新 ${updateCount} 行`);
        if (randomFillCount > 0) summary.push(`🎲 随机补齐背景 ${randomFillCount} 行（未匹配优先）`);
        if (summary.length === 0) summary.push('✅ 没有新变化');
        alert(`刷新完成\n${summary.join('\n')}\n\n文件夹: ${tab.materialDir}\n共 ${files.length} 个文件`);

    } catch (err) {
        console.error('[BatchTable] Refresh error:', err);
        alert(`刷新失败: ${err.message}`);
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.textContent = '🔄 一键刷新';
        }
    }
}

function _baseFileName(filePath) {
    if (!filePath) return '';
    const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
    return name.replace(/\.[^.]+$/, '').toLowerCase().trim();
}

// ═══════════════════════════════════════════════════════
// 11. Utility
// ═══════════════════════════════════════════════════════

function _shortName(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/');
    const name = parts[parts.length - 1] || '';
    return name.length > 20 ? name.slice(0, 18) + '…' : name;
}

function _escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════
// 11. CSS injection
// ═══════════════════════════════════════════════════════

let _batchTableCSSInjected = false;
function _injectBatchTableCSS() {
    if (_batchTableCSSInjected) return;
    _batchTableCSSInjected = true;
    const style = document.createElement('style');
    style.textContent = `
        .rbt-panel {
            position:relative;
            display:flex; flex-direction:column; width:95vw; max-width:1600px; height:90vh;
            background:#0d0d1e; border:1px solid #1a1a3a; border-radius:12px;
            box-shadow:0 30px 80px rgba(0,0,0,0.7); margin:auto; overflow:hidden;
            resize: both; min-height: 400px; min-width: 800px;
        }
        .rbt-body-row {
            display:flex; flex:1; overflow:hidden; min-height:0;
        }
        .rbt-main-col {
            flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0;
        }
        /* ═══ Media Pool Sidebar ═══ */
        .rbt-media-sidebar {
            width:240px; min-width:180px; max-width:500px;
            background:#12121e; border-right:none;
            display:flex; flex-direction:column; overflow:hidden;
            position:relative;
        }
        .rbt-ms-resize-handle {
            position:absolute; top:0; right:0; width:5px; height:100%;
            cursor:col-resize; background:transparent; z-index:10;
            border-right:1px solid #2a2a3a;
            transition: background 0.15s;
        }
        .rbt-ms-resize-handle:hover, .rbt-ms-resize-handle.active {
            background:rgba(124,92,255,0.4); border-right-color:#7c5cff;
        }
        .rbt-ms-header {
            display:flex; align-items:center; justify-content:space-between;
            padding:8px 10px; border-bottom:1px solid #2a2a3a; background:#0e0e1a;
        }
        .rbt-ms-actions {
            display:flex; gap:4px; padding:8px 8px 4px 8px; flex-wrap:wrap;
        }
        .rbt-ms-btn {
            font-size:10px !important; padding:2px 6px !important; flex:1; text-align:center;
        }
        .rbt-ms-filters {
            padding:4px 8px; border-bottom:1px solid #1a1a2a;
        }
        .rbt-ms-filter {
            padding:5px 8px; font-size:11px; color:#888; cursor:pointer; border-radius:4px;
            transition: background 0.15s;
        }
        .rbt-ms-filter:hover { background:#1e1e30; color:#ccc; }
        .rbt-ms-filter.active { background:#2a2a3e; color:#fff; font-weight:bold; }
        .rbt-ms-section {
            font-size:9px; color:#444; font-weight:bold; padding:6px 8px 2px 8px; text-transform:uppercase;
        }
        .rbt-ms-bulk { padding:8px; border-bottom:1px solid #1a1a2a; }
        .rbt-ms-pool {
            flex:1; overflow-y:auto; padding:8px;
        }
        .rbt-ms-footer { padding:8px; border-top:1px solid #1a1a2a; }
        .rbt-ms-linked-dir {
            padding:8px; border-bottom:1px solid #1a1a2a; background:rgba(0,0,0,0.15);
        }
        .rbt-ms-collapsible-header {
            display:flex; align-items:center; gap:6px; padding:6px 10px;
            cursor:pointer; user-select:none;
            border-bottom:1px solid var(--border-color, #1a1a2a);
            background:var(--bg-hover, rgba(255,255,255,0.03));
            transition: background 0.15s;
        }
        .rbt-ms-collapsible-header:hover {
            background:var(--bg-hover-strong, rgba(255,255,255,0.06));
        }
        .rbt-ms-toggle-icon {
            font-size:10px; color:var(--text-muted); transition:transform 0.2s;
            width:12px; display:inline-flex; justify-content:center;
        }
        .rbt-ms-collapsible-body {
            overflow:hidden; transition: max-height 0.25s ease;
        }
        .rbt-ms-collapsible-body.collapsed {
            max-height:0 !important; overflow:hidden; border-bottom:none;
        }
        .rbt-header {
            display:flex; justify-content:space-between; align-items:center;
            padding:0 12px; height:36px; min-height:36px; max-height:36px;
            border-bottom:1px solid #1a1a3a; background:#101028;
            gap:8px; flex-shrink:0;
        }
        .rbt-header h2 { margin:0; font-size:18px; color:var(--accent); white-space:nowrap; flex-shrink:0; }
        .rbt-actions { display:none; }
        .rbt-btn {
            padding:0 10px; height:26px; line-height:26px;
            border-radius:4px; border:1px solid #333; background:#1e1e38;
            color:#ccc; font-size:11px; cursor:pointer; transition:all .15s;
            white-space:nowrap; box-sizing:border-box;
            display:inline-flex; justify-content:center; align-items:center; text-align:center;
        }
        .rbt-btn:hover { background:#2a2a48; color:#fff; }
        .rbt-btn-accent { background:var(--accent); color:#000; border-color:var(--accent); font-weight:bold; }
        .rbt-btn-accent:hover { background:#00BBDD; }
        .rbt-btn-primary { background:var(--accent); color:#000; border:none; font-weight:bold; padding:0 24px; height:26px; line-height:26px; font-size:14px; }
        .rbt-btn-primary:hover { background:#00BBDD; }
        .rbt-btn-danger { border-color:#f44; color:#f44; }
        .rbt-btn-danger:hover { background:#f44; color:#fff; }
        .rbt-btn-folder { background:#2a6b3a; color:#8f8; border-color:#3a8b4a; font-weight:600; }
        .rbt-btn-folder:hover { background:#3a8b4a; color:#fff; }
        .rbt-btn-voice { background:#182838; border-color:#2a4058; color:#90b8d8; }
        .rbt-btn-voice:hover { background:#2a4058; color:#c0daf0; }
        .rbt-btn-other { background:#2a2038; border-color:#403058; color:#b8a0d0; }
        .rbt-btn-other:hover { background:#403058; color:#d8c8f0; }
        .rbt-table-wrap {
            flex:1; overflow:auto; padding:0;
        }
        .rbt-table {
            width:100%; border-collapse:collapse; font-size:12px;
        }
        .rbt-table thead { position:sticky; top:0; z-index:2; }
        .rbt-table th {
            padding:6px 10px; height:34px; background:#181836; color:#c0c8dd; font-weight:600;
            text-align:left; white-space:nowrap; font-size:11px;
            border-bottom:2px solid #3a3a6a;
            border-right:1px solid #2e2e58;
            box-shadow:inset -1px 0 0 rgba(255,255,255,0.03);
            transition: background 0.2s;
        }
        /* 列分组专属主题色（顶部颜色条 + 极光背景色） */
        .rbt-table th.rbt-grp-video { background:#151c36; box-shadow: inset 0 3px 0 #3b82f6, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-audio { background:#1a1636; box-shadow: inset 0 3px 0 #8b5cf6, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-sub   { background:#101e38; box-shadow: inset 0 3px 0 #0ea5e9, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-media { background:#10212e; box-shadow: inset 0 3px 0 #10b981, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-ovl   { background:#221d28; box-shadow: inset 0 3px 0 #f59e0b, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th.rbt-grp-scr   { background:#24162e; box-shadow: inset 0 3px 0 #f43f5e, inset -1px 0 0 rgba(255,255,255,0.03); }
        .rbt-table th:last-child { border-right:none; }
        .rbt-col-toggle {
            display:flex; align-items:center; gap:8px; padding:6px 12px; font-size:11px; color:#ccc; cursor:pointer; transition:background .15s;
        }
        .rbt-col-toggle:hover { background:rgba(255,255,255,0.06); }
        .rbt-col-toggle input[type="checkbox"] { margin:0; transform:scale(0.9); cursor:pointer; }
        .rbt-th-wrap {
            display:flex; align-items:center; gap:4px; min-width:0;
        }
        .rbt-th-wrap > span {
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;
        }
        .rbt-th-paste {
            flex:0 0 auto;
            width:20px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #2a5a3a;
            background:#1a2f24; color:#6fc88a;
            font-size:10px; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-paste:hover {
            border-color:#4ade80; color:#fff; background:#2a5a3a;
            transform:scale(1.1);
        }
        .rbt-th-folder {
            flex:0 0 auto;
            width:20px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #5a4a2a;
            background:#2f2a1a; color:#d4a54a;
            font-size:10px; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-folder:hover {
            border-color:#f0c050; color:#fff; background:#5a4a2a;
            transform:scale(1.1);
        }
        .rbt-th-clear {
            flex:0 0 auto;
            width:18px; height:18px; line-height:16px;
            border-radius:4px; border:1px solid #384078;
            background:#1a1f44; color:#b8c6ff;
            font-size:10px; font-weight:700; cursor:pointer;
            padding:0; transition:all .15s;
            opacity:0; pointer-events:none;
        }
        .rbt-th-clear:hover {
            border-color:#ff6b6b; color:#fff; background:#5a1f2a;
        }
        .rbt-table th:hover .rbt-th-paste,
        .rbt-table th:hover .rbt-th-folder,
        .rbt-table th:hover .rbt-th-clear {
            opacity: 1; pointer-events: auto;
        }
        .rbt-table td {
            padding:3px 6px; vertical-align:middle;
            border-bottom:1px solid #1c1c3a;
            border-right:1px solid #1a1a38;
        }
        .rbt-table td:last-child { border-right:none; }
        .rbt-row { transition: background 0.1s; }
        .rbt-row:nth-child(even) { background:rgba(255,255,255,0.018); }
        .rbt-row:hover { background:rgba(0,212,255,0.06); }
        .rbt-row-selected { background:rgba(0,212,255,0.1) !important; }
        .rbt-col-num { width:36px; text-align:center; color:#556; font-weight:bold; font-size:11px; }

        /* 统一缩放设置列宽 (Scale Settings): 70px */
        .rbt-col-bgscale, .rbt-col-bgdurscale, .rbt-col-audiodurscale { width:70px; text-align:center; }

        /* 统一选择文件列宽 (File Selectors): 140px */
        .rbt-col-hook, .rbt-col-bg, .rbt-col-audio, .rbt-col-srt, .rbt-col-bgm, .rbt-col-pip { width:140px; }

        /* 统一输入文本列宽 (Text Inputs): 200px */
        .rbt-col-ai_script, .rbt-col-tts_text, .rbt-col-txtcontent, .rbt-col-title, .rbt-col-body, .rbt-col-footer, .rbt-col-scroll-title, .rbt-col-scroll-body { min-width:200px; width:200px; }

        /* 其他杂项列宽 */
        .rbt-col-tts_voice { width:100px; }
        .rbt-col-dur { width:70px; text-align:center; }
        .rbt-col-tpl { width:120px; }
        .rbt-col-act { width:70px; white-space:nowrap; }
        .rbt-file-name {
            display:block; padding:3px 6px; background:#101020; border:1px solid #1e1e3a;
            border-radius:3px; color:#8888cc; font-size:11px; min-height:24px; line-height:18px;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:default;
            transition: all 0.2s;
        }
        /* 方案A2: 极其透明的文字 + 小图标 */
        .rbt-file-name:has(.rbt-placeholder) {
            background: rgba(255,255,255,0.015);
            border-color: transparent;
            text-align: center;
            position: relative; /* 必须加relative才能让伪元素绝对居中 */
        }
        
        /* 默认状态单独居中显示的完美 + 号 */
        .rbt-file-name:has(.rbt-placeholder)::after {
            content: '+';
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #666;
            font-size: 15px;
            font-weight: 300;
            pointer-events: none;
            transition: opacity 0.2s;
        }

        .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder {
            opacity: 0; /* 文本彻底隐形，但仍撑起布局宽度 */
            transition: opacity 0.2s;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
        /* 当文字出现时，也给文字前面补一个 + 号，保证排版平滑 */
        .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder::before {
            content: '+';
            color: inherit;
            font-size: 13px;
        }
        
        /* 悬浮状态：绝对居中的十字消失，文本底色现身 */
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder)::after,
        .rbt-file-name:has(.rbt-placeholder):hover::after {
            opacity: 0;
        }
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder) .rbt-placeholder,
        .rbt-file-name:has(.rbt-placeholder):hover .rbt-placeholder {
            opacity: 1;
            color: #889;
        }
        
        .rbt-row:hover .rbt-file-name:has(.rbt-placeholder) {
            border-color: transparent;
        }
        .rbt-file-name:has(.rbt-placeholder):hover {
            background: rgba(255,255,255,0.05);
            border-color: #445;
            border-style: dashed;
        }
        .rbt-placeholder { color:#888; font-style:italic; }
        .rbt-textarea {
            width:100%; padding:4px 6px; background:transparent; border:1px solid transparent;
            border-radius:3px; color:#ddd; font-size:12px; resize:none; min-height:28px;
            font-family:inherit; line-height:1.4; transition:all .2s;
        }
        .rbt-textarea:hover {
            background: rgba(255,255,255,0.03); 
            border-color: rgba(255,255,255,0.1);
        }
        .rbt-textarea:focus { 
            background: #0e0e1c;
            border-color:#4a9eff; 
            outline:none; 
            box-shadow:0 0 0 1px rgba(74,158,255,0.3); 
        }
        .rbt-select {
            width:100%; padding:0 4px; height:24px; background:#0e0e1c; border:1px solid #1e1e3a;
            border-radius:3px; color:#ddd; font-size:11px;
        }
        .rbt-row-btn {
            padding:2px 5px; background:none; border:1px solid transparent;
            cursor:pointer; font-size:13px; border-radius:3px;
        }
        .rbt-row-btn:hover { background:rgba(255,255,255,0.1); }
        .rbt-field-clear {
            background:none; border:none; color:#888; cursor:pointer;
            font-size:11px; padding:1px 4px; border-radius:3px; line-height:1;
            flex-shrink:0; opacity:0.6; transition:all 0.15s;
        }
        .rbt-field-clear:hover { color:var(--error); opacity:1; background:rgba(255,107,107,0.15); }
        .rbt-footer {
            display:flex; justify-content:space-between; align-items:center;
            padding:0 16px; height:36px; min-height:36px;
            border-top:1px solid #1a1a3a; background:#101028;
        }
        #rbt-count { color:#888; font-size:13px; }
        .rbt-droppable.rbt-drag-over {
            border-color:var(--accent) !important; background:rgba(0,212,255,0.1) !important;
        }
        .rbt-hidden-input { display:none !important; }
        .rbt-sep {
            display:inline-block; width:1px; height:16px; background:#333; margin:0 4px;
            flex-shrink:0;
        }
        .rbt-group-label {
            font-size:10px; color:#888; font-weight:600; white-space:nowrap;
            border-bottom:1px solid #555; padding-bottom:1px; margin-right:2px;
        }
        .rbt-file-name { cursor:pointer !important; }
        .rbt-file-name:hover { border-color:var(--accent) !important; color:var(--accent) !important; }
        .rbt-footer-hint { font-size:11px; color:#555; }

        /* ══ Tab bar ══ */
        .rbt-tabbar {
            display:flex; align-items:stretch; background:#0a0a1e; border-bottom:1px solid #1a1a3a;
            padding:0 12px; height:36px; min-height:36px; max-height:36px;
            overflow-x:auto; flex-shrink:0;
        }
        .rbt-tabs-scroll {
            display:flex; align-items:stretch; gap:2px; flex:1; min-width:0;
        }
        .rbt-tab {
            display:flex; align-items:center; gap:6px; padding:0 14px; cursor:pointer;
            font-size:12px; color:#888; border:1px solid transparent; border-bottom:none;
            border-radius:6px 6px 0 0; transition:all .15s; position:relative; white-space:nowrap;
            background:transparent; user-select:none; height:35px;
        }
        .rbt-tab:hover { color:#ccc; background:rgba(255,255,255,0.05); }
        .rbt-tab-active {
            color:var(--accent) !important; background:#101028 !important;
            border-color:#1a1a3a #1a1a3a transparent; font-weight:600;
        }
        .rbt-tab-active::after {
            content:''; position:absolute; bottom:-1px; left:0; right:0; height:2px; background:var(--accent);
        }
        .rbt-tab-close {
            font-size:14px; line-height:1; opacity:0.4; transition:all .15s; padding:0 2px;
        }
        .rbt-tab-close:hover { opacity:1; color:var(--error); }
        .rbt-tab-add {
            color:#555; font-size:16px; font-weight:700; padding:0 12px;
        }
        .rbt-tab-add:hover { color:var(--accent); }

        /* ══ Material folder bar ══ */
        .rbt-material-bar {
            display:flex; align-items:center; gap:8px; padding:0 12px;
            height:36px; min-height:36px; max-height:36px;
            background:#0e0e24; border-bottom:1px solid #1a1a3a; flex-shrink:0;
        }
        .rbt-mat-path {
            font-size:11px; color:#8b8b8b; background:#141420; padding:0 10px;
            height:26px; line-height:26px;
            border-radius:4px; border:1px solid #2a2a4a; max-width:300px;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .rbt-btn-refresh {
            background:linear-gradient(135deg, #1a6b3a, #2a8b4a) !important;
            color:#8f8 !important; border-color:#3a8b4a !important; font-weight:600;
            transition:all .2s;
        }
        .rbt-btn-refresh:hover:not(:disabled) {
            background:linear-gradient(135deg, #2a8b4a, #3aab5a) !important;
            box-shadow:0 0 12px rgba(0,255,100,0.3);
        }
        .rbt-btn-refresh:disabled { opacity:0.4; cursor:not-allowed; }
        .rbt-refresh-time { font-size:10px; color:#666; margin-left:4px; }

        /* ══ Batch actions bar ══ */
        .rbt-batch-actions-bar {
            display:flex; align-items:center; gap:8px; padding:8px 12px;
            min-height:44px; height:auto;
            background:transparent;
            border-bottom:none; flex-shrink:0;
            flex-wrap:wrap;
        }
        .rbt-batch-label {
            display:flex; align-items:center; gap:4px; font-size:11px; color:#aaa; cursor:pointer;
        }
        .rbt-batch-label input[type="checkbox"] {
            width:16px; height:16px; margin:0;
            accent-color:#7f8fff;
        }
        .rbt-batch-group {
            display:flex; align-items:center; gap:6px;
            padding:5px 8px;
            background:rgba(18, 21, 54, 0.9);
            border:1px solid rgba(88, 101, 188, 0.45);
            border-radius:10px;
            box-shadow:inset 0 0 0 1px rgba(255,255,255,0.025);
            flex-shrink:0;
        }
        .rbt-batch-group-plain {
            background:rgba(18, 21, 54, 0.6);
            border:1px solid rgba(88, 101, 188, 0.3);
            box-shadow:inset 0 0 0 1px rgba(255,255,255,0.02);
            padding:5px 8px;
            gap:6px;
        }
        .rbt-batch-group-plain .rbt-mini-label {
            color:#c1c8e8;
        }
        .rbt-batch-group-emphasis {
            background:linear-gradient(180deg, rgba(70, 64, 180, 0.18) 0%, rgba(36, 36, 92, 0.78) 100%);
            border-color:rgba(129, 140, 248, 0.55);
            box-shadow:0 0 0 1px rgba(129,140,248,0.18), inset 0 0 0 1px rgba(255,255,255,0.03);
        }
        .rbt-mini-label {
            font-size:11px; color:#c9d4ff; font-weight:600; letter-spacing:.2px; white-space:nowrap;
        }
        .rbt-mini-label-emphasis {
            color:#d6ccff;
            font-weight:700;
        }
        .rbt-batch-actions-bar .rbt-btn,
        .rbt-batch-actions-bar .rbt-select {
            height:26px;
            line-height:26px;
            border-radius:4px;
            font-size:11px;
            padding:0 10px;
            border:1px solid #333;
            background:#1e1e38;
            color:#ccc;
        }
        .rbt-batch-actions-bar .rbt-btn:hover,
        .rbt-batch-actions-bar .rbt-select:hover {
            background:#2a2a48;
            color:#fff;
        }
        .rbt-batch-actions-bar .rbt-btn:active {
            transform:translateY(1px);
        }
        .rbt-batch-actions-bar .rbt-select {
            line-height:normal;
        }
        .rbt-btn-hero {
            font-weight:700;
            color:#f5f7ff;
            border-color:#7f8fff !important;
            background:linear-gradient(135deg, #4f46e5 0%, #4338ca 55%, #3730a3 100%) !important;
            box-shadow:0 10px 20px rgba(67,56,202,0.28), inset 0 0 0 1px rgba(255,255,255,0.16);
        }
        .rbt-btn-hero:hover {
            border-color:#9aa6ff !important;
            background:linear-gradient(135deg, #5f57f0 0%, #4d44dd 55%, #3f39b3 100%) !important;
            box-shadow:0 12px 24px rgba(79,70,229,0.36), inset 0 0 0 1px rgba(255,255,255,0.2);
        }
        .rbt-select-trigger {
            cursor:pointer;
            display:inline-flex;
            align-items:center;
            justify-content:space-between;
            user-select:none;
            gap:8px;
        }
        .rbt-select-trigger-label {
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
        }
        .rbt-select-caret {
            font-size:10px;
            opacity:0.85;
        }
        .rbt-batch-summary {
            font-size:12px;
            color:var(--accent);
            margin-left:auto;
            font-weight:600;
        }
        .rbt-scale-pack {
            display:flex; align-items:center; gap:4px;
            font-size:11px; white-space:nowrap; font-weight:600;
            padding:0 2px;
            color:#c9d4ff;
        }
        .rbt-scale-bg { color:#cfd8ff; }
        .rbt-scale-bgdur { color:#cfd8ff; }
        .rbt-scale-audiodur { color:#cfd8ff; }
        .rbt-scale-pack input {
            width:48px; height:26px;
            font-size:11px; font-weight:600; color:#ddd;
            padding:0 4px; text-align:center;
            background:#0e0e1c;
            border:1px solid #1e1e3a;
            border-radius:4px;
            outline:none;
            box-sizing:border-box;
        }
        .rbt-scale-pack input:hover {
            border-color:#333;
            background:#121228;
        }
        .rbt-scale-pack input:focus {
            border-color:var(--accent);
            box-shadow:0 0 0 1px rgba(0,212,255,0.2);
        }

        /* ══ Row refresh animation ══ */
        .rbt-row-refreshed {
            animation: rbt-refresh-glow 3s ease-out;
        }
        @keyframes rbt-refresh-glow {
            0%   { background:rgba(0,255,100,0.25); box-shadow:inset 0 0 20px rgba(0,255,100,0.15); }
            30%  { background:rgba(0,255,100,0.15); }
            100% { background:transparent; box-shadow:none; }
        }

        /* ══ Drag handle & reorder ══ */
        .rbt-col-drag { width:24px; text-align:center; padding:0 2px !important; }
        .rbt-drag-handle {
            cursor:grab; color:#555; font-size:14px; user-select:none;
            display:inline-block; padding:4px 2px; line-height:1; transition:color .15s;
        }
        .rbt-drag-handle:hover { color:var(--accent); }
        .rbt-drag-handle:active { cursor:grabbing; }
        .rbt-row.rbt-dragging {
            opacity:0.4; background:rgba(0,212,255,0.05) !important;
        }
        .rbt-row.rbt-drag-over-row {
            border-top:2px solid var(--accent) !important;
            background:rgba(0,212,255,0.08) !important;
        }

        /* 解决控件拥挤：隐藏冗余滑块，悬浮显示 */
        .rbt-clutter-free-scale {
            position: relative;
            width: 100%;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .rbt-clutter-free-scale > .rbt-scale-display {
            font-size: 11px;
            color: #888;
            pointer-events: none;
            transition: opacity 0.15s;
        }
        .rbt-clutter-free-scale > .rbt-scale-controls {
            position: absolute;
            inset: -2px 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.15s;
            z-index: 5;
        }
        td:hover .rbt-clutter-free-scale > .rbt-scale-display,
        .rbt-clutter-free-scale:focus-within > .rbt-scale-display,
        td.rbt-scale-active .rbt-clutter-free-scale > .rbt-scale-display {
            opacity: 0;
        }
        td:hover .rbt-clutter-free-scale > .rbt-scale-controls,
        .rbt-clutter-free-scale:focus-within > .rbt-scale-controls,
        td.rbt-scale-active .rbt-clutter-free-scale > .rbt-scale-controls {
            opacity: 1;
            pointer-events: auto;
        }
        /* ═══ 主题兼容层 — 仅在亮色模式下覆盖默认暗黑样式 ═══ */
        body.theme-light .rbt-panel { background:var(--bg-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-header, body.theme-light .rbt-footer { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-tabbar { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-tab-active { background:var(--bg-secondary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-material-bar { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-media-sidebar { background:var(--bg-secondary) !important; }
        body.theme-light .rbt-ms-header { background:var(--bg-titlebar) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-resize-handle { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-filters { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-bulk, body.theme-light .rbt-ms-footer, body.theme-light .rbt-ms-linked-dir { border-color:var(--border-color) !important; }
        body.theme-light .rbt-table th { background:var(--bg-secondary) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-table td { border-color:var(--border-color) !important; }
        body.theme-light .rbt-file-name { background:var(--bg-input) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-textarea { color:var(--text-primary) !important; }
        body.theme-light .rbt-textarea:focus { background:var(--bg-input) !important; }
        body.theme-light .rbt-select { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-scale-pack input { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-btn { border-color:var(--border-color) !important; }
        body.theme-light .rbt-mat-path { background:var(--bg-input) !important; border-color:var(--border-color) !important; color:var(--text-secondary) !important; }
        body.theme-light .rbt-batch-actions-bar .rbt-btn, body.theme-light .rbt-batch-actions-bar .rbt-select { border-color:var(--border-color) !important; color:var(--text-primary); }
        body.theme-light .rbt-sep { background:var(--border-color) !important; }
        body.theme-light #rbt-count { color:var(--text-secondary) !important; }
        body.theme-light .rbt-footer-hint { color:var(--text-muted) !important; }
        
        /* 操作行 border 和标签文字 */
        body.theme-light .rbt-actions { border-color:var(--border-color) !important; }
        body.theme-light .rbt-col-num { color:var(--text-muted) !important; }
        body.theme-light .rbt-placeholder { color:var(--text-muted) !important; }
        body.theme-light .rbt-tab { color:var(--text-secondary) !important; }
        body.theme-light .rbt-tab:hover { color:var(--text-primary) !important; background:var(--bg-hover) !important; }
        body.theme-light .rbt-tab-active { color:var(--accent) !important; }
        body.theme-light .rbt-tab-add { color:var(--text-muted) !important; }
        body.theme-light .rbt-batch-label { color:var(--text-secondary) !important; }
        body.theme-light .rbt-group-label { color:var(--text-secondary) !important; border-color:var(--text-muted) !important; }
        body.theme-light .rbt-ms-filter { color:var(--text-secondary) !important; }
        body.theme-light .rbt-ms-filter:hover { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-ms-filter.active { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-ms-section { color:var(--text-muted) !important; }
        body.theme-light .rbt-refresh-time { color:var(--text-muted) !important; }
        body.theme-light .rbt-btn:hover { background:var(--bg-hover-strong) !important; color:var(--text-primary) !important; }
        body.theme-light .rbt-scale-display { color:var(--text-secondary) !important; }
        body.theme-light #rbt-lang-dropdown { background:var(--bg-secondary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-linked-dir { background:var(--bg-hover, rgba(0,0,0,0.04)) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-bulk { border-color:var(--border-color) !important; }
        body.theme-light .rbt-ms-pool { background:var(--bg-primary) !important; }
        body.theme-light .rbt-ms-collapsible-header { border-color:var(--border-color) !important; }
        body.theme-light .rbt-btn { background:var(--bg-card, #2a2a38) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        
        /* 针对亮色模式下特定颜色按钮的优化 (重新找回彩色但适配亮版) */
        body.theme-light #rbt-add-row-btn { background:rgba(40,160,40,0.15) !important; color:#0d612e !important; border-color:rgba(40,160,40,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-clear-btn, body.theme-light #rbt-close-btn, body.theme-light #rbt-ms-clear { background:rgba(220,40,40,0.1) !important; color:#c51818 !important; border-color:rgba(220,40,40,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-open-media-pool-btn { background:rgba(60,100,220,0.1) !important; color:#2040b0 !important; border-color:rgba(60,100,220,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-ai-settings-btn { background:rgba(140,60,220,0.1) !important; color:#6b21a8 !important; border-color:rgba(140,60,220,0.3) !important; font-weight:bold; }
        body.theme-light #rbt-import-task-preset-btn, body.theme-light #rbt-import-sub-preset-btn, body.theme-light #rbt-import-card-preset-btn { background:rgba(60,100,220,0.08) !important; color:#1a3bb0 !important; border-color:rgba(60,100,220,0.2) !important; }
        
        /* 操作栏内联元素覆盖 — 强制主题色 */
        body.theme-light .rbt-actions label { color:var(--text-primary) !important; }
        body.theme-light .rbt-actions span { color:var(--text-secondary) !important; }
        body.theme-light .rbt-actions input[type="number"],
        body.theme-light .rbt-actions input[type="text"] { background:var(--bg-input) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-actions select { background:var(--bg-input) !important; color:var(--text-primary) !important; border-color:var(--border-color) !important; }
        body.theme-light .rbt-btn-primary { color:#fff !important; }
        body.theme-light .rbt-btn-accent { color:#000 !important; }
    `;
    document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════
// 12. Config Save / Load / Auto-save
// ═══════════════════════════════════════════════════════

const BATCH_CONFIG_KEY = 'reels_batch_config_autosave';

/** 序列化任务数据（去掉不可序列化的部分） */
function _serializeTasks(tasks) {
    return (tasks || []).map(t => {
        const o = { ...t };
        // 去掉 DOM / Video 等不可序列化的引用
        delete o._video;
        delete o._bgThumb;
        // 去掉 blob: URL（页面刷新后失效，渲染时会从 bgPath 重新生成 file:// URL）
        if (o.bgSrcUrl && String(o.bgSrcUrl).startsWith('blob:')) o.bgSrcUrl = null;
        if (o.srcUrl && String(o.srcUrl).startsWith('blob:')) o.srcUrl = null;
        return o;
    });
}

/** 自动保存到 localStorage (含所有标签页，如果配置了工程路径则自动写入硬盘) */
function _batchAutoSave() {
    try {
        // Sync current tasks to active tab first
        _syncTasksToActiveTab();
        const data = {
            timestamp: new Date().toISOString(),
            version: '2.0',
            activeTabId: _batchTableState.activeTabId,
            nextTabId: _batchTableState.nextTabId,
            projectDir: _batchTableState.projectDir || '',
            projectName: _batchTableState.projectName || 'UntitledProject.json',
            tabs: _batchTableState.tabs.map(tab => ({
                id: tab.id,
                name: tab.name,
                materialDir: tab.materialDir || '',
                lastRefreshTime: tab.lastRefreshTime || null,
                tasks: _serializeTasks(tab.tasks),
            })),
        };
        const jsonStr = JSON.stringify(data);
        localStorage.setItem(BATCH_CONFIG_KEY, jsonStr);

        // 如果设置了工程目录与文件名，同时写入物理硬盘 (Electron环境)
        if (_batchTableState.projectDir && _batchTableState.projectName && window.electronAPI && window.electronAPI.writeFileText) {
            // 需要自己拼路径，也可以借助 path.join，但简单拼凑即可，处理一下末尾斜杠
            const dir = _batchTableState.projectDir.replace(/[/\\]$/, '');
            const sep = dir.includes('\\') ? '\\' : '/';
            const fullPath = dir + sep + _batchTableState.projectName;
            window.electronAPI.writeFileText(fullPath, JSON.stringify(data, null, 2));
        }

    } catch (e) {
        console.warn('[BatchTable] Auto-save failed:', e.message);
    }
}

/** 自动恢复 */
function _batchAutoRestore() {
    try {
        const raw = localStorage.getItem(BATCH_CONFIG_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);

        if (data.version === '2.0' && data.tabs && data.tabs.length > 0) {
            // v2: multi-tab format
            _batchTableState.projectDir = data.projectDir || '';
            _batchTableState.projectName = data.projectName || 'UntitledProject.json';
            _batchTableState.tabs = data.tabs.map(t => ({
                id: t.id,
                name: t.name,
                materialDir: t.materialDir || '',
                lastRefreshTime: t.lastRefreshTime || null,
                tasks: t.tasks || [],
            }));
            _batchTableState.activeTabId = data.activeTabId || _batchTableState.tabs[0].id;
            _batchTableState.nextTabId = data.nextTabId || _batchTableState.tabs.length + 1;
            // Load active tab's tasks
            const activeTab = _getActiveTab();
            if (activeTab && activeTab.tasks.length > 0) {
                const existing = window._reelsState.tasks || [];
                if (existing.length === 0) {
                    window._reelsState.tasks = activeTab.tasks.map(t => ({ ...t }));
                }
            }
            console.log(`[BatchTable] Auto-restored ${_batchTableState.tabs.length} tabs from ${data.timestamp}`);
        } else if (data.tasks && data.tasks.length > 0) {
            // v1: legacy single-list format — migrate to tab
            const existing = window._reelsState.tasks || [];
            if (existing.length === 0) {
                window._reelsState.tasks = data.tasks;
                _batchTableState.tabs[0].tasks = data.tasks;
                console.log(`[BatchTable] Auto-restored ${data.tasks.length} tasks (v1) from ${data.timestamp}`);
            }
        }
    } catch (e) {
        console.warn('[BatchTable] Auto-restore failed:', e.message);
    }
}

/** 显示工程管理器 */
async function _showProjectManager() {
    let popup = document.getElementById('rbt-project-mgr-popup');
    if (popup) { popup.remove(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'rbt-project-mgr-popup';
    overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100vw; height:100vh;
        background:rgba(0,0,0,0.75); z-index:100000;
        display:flex; justify-content:center; align-items:center;
    `;

    // Fetch projects
    let projects = [];
    let loadError = null;
    if (_batchTableState.projectDir && window.electronAPI && window.electronAPI.scanDirectory) {
        try {
            const files = await window.electronAPI.scanDirectory(_batchTableState.projectDir);
            // filter *.json
            projects = files.filter(f => f.toLowerCase().endsWith('.json')).map(f => {
                const sep = f.includes('\\') ? '\\' : '/';
                const parts = f.split(sep);
                return { path: f, filename: parts[parts.length - 1] };
            });
            // sort by filename or basic length
            projects.sort((a,b) => a.filename.localeCompare(b.filename));
        } catch (e) {
            loadError = e.message;
        }
    }

    const currentName = _batchTableState.projectName || 'UntitledProject.json';
    const projListHtml = projects.length > 0 ? projects.map(p => {
        const isCurrent = p.filename === currentName;
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:${isCurrent ? 'rgba(0,212,255,0.1)' : 'rgba(255,255,255,0.02)'}; border:1px solid ${isCurrent ? 'var(--accent)' : '#333'}; border-radius:6px; margin-bottom:6px;">
                <span style="font-size:13px; color:${isCurrent ? '#fff' : '#ccc'};">${_escHtml(p.filename)}${isCurrent ? ' <span style="color:var(--accent);font-size:10px;">(当前)</span>' : ''}</span>
                <div>
                    ${!isCurrent ? `<button class="rbt-btn" style="padding:2px 8px; font-size:11px;" onclick="window._extLoadProject('${_escHtml(p.path)}')">📂 加载</button>` : ''}
                </div>
            </div>
        `;
    }).join('') : `<div style="color:#666; font-size:13px; text-align:center; padding:20px;">没有找到任何 .json 工程文件</div>`;

    overlay.innerHTML = `
        <div style="background:#141420; border:1px solid #2a2a4a; border-radius:10px; width:460px; max-height:85vh; display:flex; flex-direction:column; box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <div style="padding:12px 16px; border-bottom:1px solid #2a2a4a; display:flex; justify-content:space-between; align-items:center;">
                <h3 style="margin:0; font-size:16px; font-weight:600; color:#eee;">📦 工程管理</h3>
                <span class="rbt-close-btn" style="cursor:pointer; color:#888; font-size:18px;">&times;</span>
            </div>
            <div style="padding:16px; overflow-y:auto; flex:1;">
                
                <div style="margin-bottom:16px;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">默认工程保存目录 (实时自动写入磁盘)</label>
                    <div style="display:flex; gap:8px;">
                        <input type="text" id="rbt-mgr-dir-input" value="${_escHtml(_batchTableState.projectDir || '')}" class="rbt-input" style="flex:1;" readonly placeholder="未设置目录，仅在浏览器缓存">
                        <button class="rbt-btn" id="rbt-mgr-pick-dir-btn">浏览...</button>
                    </div>
                </div>

                <div style="margin-bottom:20px; padding-top:16px; border-top:1px dashed #333;">
                    <label style="display:block; font-size:11px; color:#aaa; margin-bottom:4px;">新建 / 重命名工程</label>
                    <div style="display:flex; gap:8px;">
                        <input type="text" id="rbt-mgr-name-input" value="${_escHtml(currentName)}" class="rbt-input" style="flex:1;" placeholder="例如: 项目一.json">
                        <button class="rbt-btn" id="rbt-mgr-new-btn">应用为新工程</button>
                    </div>
                    <div style="font-size:10px; color:#777; margin-top:4px;">注意：应用后当前界面数据将关联到这个新文件名，并在目录内自动保存。</div>
                </div>

                <div>
                    <div style="font-size:12px; color:#ccc; margin-bottom:8px; border-bottom:1px solid #333; padding-bottom:4px;">当前目录下的工程 (${projects.length}) :</div>
                    ${loadError ? `<div style="color:var(--rbt-red); font-size:12px; padding:10px;">读取目录报错: ${_escHtml(loadError)}</div>` : projListHtml}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('.rbt-close-btn').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#rbt-mgr-pick-dir-btn').addEventListener('click', async () => {
        if (!window.electronAPI || !window.electronAPI.selectDirectory) {
            alert('环境不支持选择目录 (需Electron)');
            return;
        }
        const dir = await window.electronAPI.selectDirectory();
        if (dir) {
            _batchTableState.projectDir = dir;
            // Immediate save
            _batchAutoSave();
            overlay.remove();
            _showProjectManager(); // reload UI
        }
    });

    overlay.querySelector('#rbt-mgr-new-btn').addEventListener('click', () => {
        let nname = overlay.querySelector('#rbt-mgr-name-input').value.trim();
        if (!nname) return;
        if (!nname.toLowerCase().endsWith('.json')) nname += '.json';
        if (_batchTableState.projectName !== nname) {
            _batchTableState.projectName = nname;
            _batchAutoSave(); // trigger auto save instantly
            _renderBatchTable(); // refresh UI header
            overlay.remove();
            _showProjectManager();
        }
    });
}

// 全局辅助用于点击加载工程 (只能挂在 window 上因为是在 innerHTML 里生成的 onclick)
window._extLoadProject = async (pathStr) => {
    if (!window.electronAPI || !window.electronAPI.readFileText) return;
    const content = window.electronAPI.readFileText(pathStr);
    if (!content) {
        alert('无法读取或文件为空!');
        return;
    }
    try {
        const file = new File([content], _batchTableState.projectName || 'project.json', { type: 'application/json' });
        
        // 我们利用现成的导入逻辑，稍微魔改下跳过 input.click
        // 因为现成的 _batchImportConfig 需要传入 file (FileReader)，它会确认。
        const data = JSON.parse(content);
        if (data.version === '2.0' && data.tabs) {
            if (!confirm(`将从硬盘加载 [${pathStr}]\n这将替换当前界面的所有任务数据！\n确定加载？`)) return;
            _batchTableState.tabs = data.tabs.map(t => ({
                id: t.id,
                name: t.name,
                materialDir: t.materialDir || '',
                lastRefreshTime: t.lastRefreshTime || null,
                tasks: t.tasks || [],
            }));
            const parts = pathStr.split(/[/\\]/);
            _batchTableState.projectName = parts[parts.length - 1]; // update current name
            _batchTableState.activeTabId = data.activeTabId || _batchTableState.tabs[0].id;
            _batchTableState.nextTabId = data.nextTabId || _batchTableState.tabs.length + 1;
            const activeTab = _getActiveTab();
            _loadTabTasks(activeTab);
            _renderBatchTable();
            _batchAutoSave(); // instantly resync localStorage

            const popup = document.getElementById('rbt-project-mgr-popup');
            if (popup) popup.remove();
            
            const total = _batchTableState.tabs.reduce((s, t) => s + (t.tasks || []).length, 0);
            alert(`✅ 已成功加载工程！`);
        } else {
            alert('文件格式不正确或版本过旧(仅支持v2.0多标签工程)');
        }
    } catch (e) {
        alert('加载工程解析失败: ' + e.message);
    }
};

/** 导出所有标签页为 JSON 工程文件 */
function _batchExportConfig() {
    _syncTasksToActiveTab();
    const totalTasks = _batchTableState.tabs.reduce((sum, t) => sum + (t.tasks || []).length, 0);
    if (totalTasks === 0) {
        alert('没有任务可以保存');
        return;
    }
    const data = {
        version: '2.0',
        timestamp: new Date().toISOString(),
        activeTabId: _batchTableState.activeTabId,
        nextTabId: _batchTableState.nextTabId,
        tabs: _batchTableState.tabs.map(tab => ({
            id: tab.id,
            name: tab.name,
            materialDir: tab.materialDir || '',
            lastRefreshTime: tab.lastRefreshTime || null,
            tasks: _serializeTasks(tab.tasks),
        })),
    };
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `batch_project_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    console.log(`[BatchTable] Exported project: ${_batchTableState.tabs.length} tabs, ${totalTasks} tasks`);
}

/** 从 JSON 文件导入工程配置 */
function _batchImportConfig(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);

            if (data.version === '2.0' && data.tabs && data.tabs.length > 0) {
                // v2: multi-tab project
                if (!confirm(`将加载 ${data.tabs.length} 个标签页的工程文件。\n\n确定 = 替换全部\n取消 = 放弃`)) return;
                _batchTableState.tabs = data.tabs.map(t => ({
                    id: t.id,
                    name: t.name,
                    materialDir: t.materialDir || '',
                    lastRefreshTime: t.lastRefreshTime || null,
                    tasks: t.tasks || [],
                }));
                _batchTableState.activeTabId = data.activeTabId || _batchTableState.tabs[0].id;
                _batchTableState.nextTabId = data.nextTabId || _batchTableState.tabs.length + 1;
                const activeTab = _getActiveTab();
                _loadTabTasks(activeTab);
                _renderBatchTable();
                const total = _batchTableState.tabs.reduce((s, t) => s + (t.tasks || []).length, 0);
                alert(`✅ 成功加载工程: ${_batchTableState.tabs.length} 个标签页, ${total} 个任务\n(${data.timestamp || ''})`);
            } else {
                // v1: legacy single-task-list
                const tasks = data.tasks;
                if (!Array.isArray(tasks) || tasks.length === 0) {
                    alert('配置文件中没有任务数据');
                    return;
                }
                const mode = (window._reelsState.tasks || []).length > 0
                    ? confirm(`当前有 ${window._reelsState.tasks.length} 个任务。\n\n确定 = 替换全部\n取消 = 追加到末尾`)
                        ? 'replace'
                        : 'append'
                    : 'replace';

                if (mode === 'replace') {
                    window._reelsState.tasks = tasks;
                } else {
                    window._reelsState.tasks = (window._reelsState.tasks || []).concat(tasks);
                }
                _syncTasksToActiveTab();
                _renderBatchTable();
                alert(`成功加载 ${tasks.length} 个任务 (${data.timestamp || ''})`);
            }
        } catch (err) {
            alert(`配置文件解析失败: ${err.message}`);
        }
    };
    reader.readAsText(file);
}

// ═══════════════════════════════════════════════════════
// 13. Auto-initialize
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    _batchAutoRestore();

    // 如果未设置工程路径，优先使用设置页自定义目录，否则用"下载"文件夹
    if (!_batchTableState.projectDir) {
        const customDir = localStorage.getItem('vk_default_output_dir');
        if (customDir) {
            _batchTableState.projectDir = customDir;
            _batchAutoSave();
        } else if (window.electronAPI && window.electronAPI.getDownloadsPath) {
            try {
                const dlPath = await window.electronAPI.getDownloadsPath();
                if (dlPath) {
                    _batchTableState.projectDir = dlPath;
                    _batchAutoSave();
                }
            } catch (err) {
                console.warn('Failed to set default project dir:', err);
            }
        }
    }

    _initBatchTable();

    // 每30秒自动保存一次（安全网）
    setInterval(() => {
        if (window._reelsState && (window._reelsState.tasks || []).length > 0) {
            _batchAutoSave();
        }
    }, 30000);
});

// 关闭/刷新前保存
window.addEventListener('beforeunload', () => {
    if (window._reelsState && (window._reelsState.tasks || []).length > 0) {
        _batchAutoSave();
    }
});

// ═══════════════════════════════════════════════════════
// ✂️ Trim Modal — 裁切区间编辑弹窗
// ═══════════════════════════════════════════════════════

function _showTrimModal(idx) {
    const state = window._reelsState;
    const task = state.tasks[idx];
    if (!task) return;

    // Remove existing
    const existing = document.getElementById('rbt-trim-modal');
    if (existing) existing.remove();

    const trimStart = task.contentVideoTrimStart != null ? task.contentVideoTrimStart : '';
    const trimEnd = task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : '';
    const cvPath = task.contentVideoPath || task.bgPath || '';
    const cvName = cvPath ? cvPath.split('/').pop().split('\\').pop() : '(未选择视频)';

    const overlay = document.createElement('div');
    overlay.id = 'rbt-trim-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';

    overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #333;border-radius:14px;padding:24px;min-width:400px;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,0.8);">
        <div style="font-size:15px;font-weight:700;color:#eee;margin-bottom:16px;display:flex;align-items:center;gap:8px;">
            ✂️ 片段裁切设置
            <span style="font-size:11px;color:#666;font-weight:400;margin-left:auto;">#${idx + 1}</span>
        </div>
        <div style="font-size:11px;color:#888;margin-bottom:16px;padding:8px;background:#141420;border-radius:6px;word-break:break-all;">
            🎬 ${_escHtml(cvName)}
        </div>

        <div style="display:flex;gap:12px;margin-bottom:16px;">
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">入点 (秒)</label>
                <input type="number" id="rbt-trim-start" value="${trimStart}" min="0" step="0.1"
                    placeholder="留空=从头"
                    style="width:100%;padding:8px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px;font-family:monospace;">
            </div>
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">出点 (秒)</label>
                <input type="number" id="rbt-trim-end" value="${trimEnd}" min="0" step="0.1"
                    placeholder="留空=到结尾"
                    style="width:100%;padding:8px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px;font-family:monospace;">
            </div>
        </div>

        <div style="font-size:11px;color:#666;margin-bottom:16px;line-height:1.5;">
            💡 支持秒数 (如 5.2) 或时码格式 (01:30.5)。留空表示不裁切该端点。
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="rbt-trim-clear" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#f87171;cursor:pointer;font-size:12px;">
                🗑 清除裁切
            </button>
            <button id="rbt-trim-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:12px;">
                取消
            </button>
            <button id="rbt-trim-save" style="padding:8px 20px;border-radius:6px;border:none;background:#4c9eff;color:#000;cursor:pointer;font-size:12px;font-weight:600;">
                ✅ 保存
            </button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    // Parse time string (supports seconds and MM:SS.s format)
    const parseTime = (str) => {
        if (!str || str.trim() === '') return null;
        str = str.trim();
        // MM:SS.sss
        const parts = str.split(':');
        if (parts.length === 2) {
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        // HH:MM:SS
        if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        }
        return parseFloat(str);
    };

    overlay.querySelector('#rbt-trim-save').addEventListener('click', () => {
        const s = parseTime(overlay.querySelector('#rbt-trim-start').value);
        const e = parseTime(overlay.querySelector('#rbt-trim-end').value);
        task.contentVideoTrimStart = (s != null && !isNaN(s)) ? s : null;
        task.contentVideoTrimEnd = (e != null && !isNaN(e)) ? e : null;
        overlay.remove();
        _renderBatchTable();
    });

    overlay.querySelector('#rbt-trim-clear').addEventListener('click', () => {
        task.contentVideoTrimStart = null;
        task.contentVideoTrimEnd = null;
        overlay.remove();
        _renderBatchTable();
    });

    overlay.querySelector('#rbt-trim-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Auto focus
    setTimeout(() => overlay.querySelector('#rbt-trim-start')?.focus(), 100);
}

// ═══════════════════════════════════════════════════════
// ✂️ Clip A/B Paste Modal — 剪辑文案双版本粘贴
// ═══════════════════════════════════════════════════════

function _showClipAbPasteModal() {
    const existing = document.getElementById('rbt-clip-ab-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'rbt-clip-ab-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);';

    const presetBgA = localStorage.getItem('rbt_clip_bg_preset_a') || '';
    const presetBgB = localStorage.getItem('rbt_clip_bg_preset_b') || '';
    const presetCvMode = localStorage.getItem('rbt_clip_cv_mode') || 'single';
    const presetCvPath = localStorage.getItem('rbt_clip_cv_preset') || '';

    overlay.innerHTML = `
    <div style="background:#1a1a2e;border:1px solid #333;border-radius:14px;padding:28px;width:950px;max-height:85vh;box-shadow:0 20px 60px rgba(0,0,0,0.8);display:flex;flex-direction:column;">
        <div style="font-size:16px;font-weight:700;color:#eee;margin-bottom:4px;">✂️ 批量 A/B 混剪模式：智能任务提取</div>
        <div style="font-size:11px;color:#888;margin-bottom:12px;line-height:1.6;">
            直接从谷歌表格复制粘贴，列顺序：<code style="background:#222;padding:2px 6px;border-radius:3px;color:#b8a0ff;">视频名称  片段名称  时间段  A标题  A正文  B标题  B正文</code><br>
            • 每行自动衍生 <strong style="color:#4c9eff">A版 + B版</strong> 两个任务。粘贴后即时预览。
        </div>

        <!-- 全局设定区 -->
        <div style="display:flex;gap:12px;margin-bottom:12px;background:#13131c;padding:12px;border-radius:8px;border:1px solid #2a2a3a;">
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">🎨 A版固定背景 (<span style="color:#a78bfa;cursor:pointer;" title="双击打开文件选择器">双击</span> 或拖拽 选文件)</label>
                <input type="text" id="rbt-clip-bg-a" value="${presetBgA}" placeholder="A版统一背景图片/视频 (可留空)"
                    style="width:100%;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
            </div>
            <div style="flex:1;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">🎨 B版固定背景 (<span style="color:#4c9eff;cursor:pointer;" title="双击打开文件选择器">双击</span> 或拖拽 选文件)</label>
                <input type="text" id="rbt-clip-bg-b" value="${presetBgB}" placeholder="B版统一背景图片/视频 (可留空)"
                    style="width:100%;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
            </div>
        </div>

        <div style="background:#13131c;padding:12px;border-radius:8px;border:1px dashed #444;margin-bottom:16px;">
            <div style="display:flex;align-items:center;margin-bottom:6px;gap:16px;">
                 <label style="font-size:11px;color:#ccc;font-weight:600;">📹 视频覆层素材 (内容素材) 及 裁切/缩放设置：</label>
                 <label style="font-size:11px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:4px;">
                     <input type="radio" name="clip_cv_mode" value="single" ${presetCvMode==='single'?'checked':''} style="accent-color:var(--accent);">
                     单视频使用同一素材 (名称列若填入 '00:10-00:20' 则自动应用为裁切入出点)
                 </label>
                 <label style="font-size:11px;color:#aaa;cursor:pointer;display:flex;align-items:center;gap:4px;">
                     <input type="radio" name="clip_cv_mode" value="multi" ${presetCvMode==='multi'?'checked':''} style="accent-color:var(--accent);">
                     多视频素材夹 (每行按顺序指派)
                 </label>
            </div>
            <div style="display:flex;gap:12px;align-items:center;">
                <input type="text" id="rbt-clip-cv-path" value="${presetCvPath}" placeholder="请选择单视频文件 或 包含多个视频的文件夹..."
                    style="flex:1;padding:6px 10px;background:#141420;border:1px solid #333;border-radius:6px;color:#eee;font-size:12px;">
                <button id="rbt-clip-cv-btn" style="padding:4px 12px;border-radius:6px;border:1px solid #555;background:transparent;color:#bbb;cursor:pointer;font-size:11px;white-space:nowrap;">📁 浏览</button>
                <div style="width:1px;height:14px;background:#444;margin:0 4px;"></div>
                <label style="font-size:11px;color:#bbb;white-space:nowrap;">缩放比例</label>
                <input type="number" id="rbt-clip-cv-scale" value="100" min="10" max="500"
                    style="width:50px;padding:4px;background:#141420;border:1px solid #333;border-radius:4px;color:#eee;font-size:11px;text-align:center;">
                <label style="font-size:11px;color:#bbb;">%</label>
            </div>
        </div>

        <div style="display:flex;gap:16px;flex:1;min-height:300px;margin-bottom:16px;">
            <div style="flex:1.2;display:flex;flex-direction:column;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                    <label style="font-size:11px;color:#888;">📋 1. 从谷歌表格直接粘贴到下方表格</label>
                    <button id="rbt-clip-ab-clear" style="padding:2px 8px;border-radius:4px;border:1px solid #555;background:transparent;color:#888;cursor:pointer;font-size:10px;">清空</button>
                </div>
                <div style="flex:1;overflow-y:auto;background:#0d0d16;border:1px solid #333;border-radius:8px;">
                    <table id="rbt-clip-ab-table" style="width:100%;border-collapse:collapse;font-size:11px;table-layout:fixed;">
                        <thead><tr style="background:#1a1a2e;position:sticky;top:0;z-index:2;">
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:80px;">视频名称</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:70px;">片段名称</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#a78bfa;width:70px;">时间段</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#e879a8;">A标题</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#e879a8;">A正文</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#4c9eff;">B标题</th>
                            <th style="padding:5px 4px;border-bottom:1px solid #444;color:#4c9eff;">B正文</th>
                        </tr></thead>
                        <tbody id="rbt-clip-ab-tbody"></tbody>
                    </table>
                </div>
                <textarea id="rbt-clip-ab-area" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;"></textarea>
            </div>
            <div style="flex:0.8;display:flex;flex-direction:column;">
                <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">👁️ 2. 预览最终生成的A/B任务</label>
                <div id="rbt-clip-ab-preview" style="flex:1;background:#0d0d16;border:1px dashed #444;border-radius:8px;padding:8px;overflow-y:auto;font-size:11px;line-height:1.5;">
                    <div style="color:#666;text-align:center;padding:20px;">等待粘贴数据...</div>
                </div>
            </div>
        </div>

        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
            <button id="rbt-clip-ab-cancel" style="padding:8px 16px;border-radius:6px;border:1px solid #555;background:transparent;color:#aaa;cursor:pointer;font-size:12px;">取消</button>
            <button id="rbt-clip-ab-import" style="padding:8px 30px;border-radius:6px;border:none;background:#7c5cff;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">📥 预览无误，立即生成到任务区</button>
        </div>
    </div>`;

    document.body.appendChild(overlay);

    // ── 表格数据模型 ──
    let _tableData = []; // [{videoName, clipName, timeRange, aTitle, aBody, bTitle, bBody}]
    const COL_KEYS = ['videoName','clipName','timeRange','aTitle','aBody','bTitle','bBody'];

    function _ensureMinRows(n) {
        while (_tableData.length < n) _tableData.push({videoName:'',clipName:'',timeRange:'',aTitle:'',aBody:'',bTitle:'',bBody:''});
    }
    _ensureMinRows(5);

    function _renderTable() {
        const tbody = overlay.querySelector('#rbt-clip-ab-tbody');
        if (!tbody) return;
        _ensureMinRows(Math.max(5, _tableData.length + 2));
        const cellStyle = 'padding:4px 5px;border-bottom:1px solid #222;color:#ddd;outline:none;background:transparent;';
        let html = '';
        for (let r = 0; r < _tableData.length; r++) {
            const row = _tableData[r];
            const hasData = COL_KEYS.some(k => row[k]);
            const rowBg = hasData ? '#141420' : '#0d0d16';
            html += `<tr style="background:${rowBg};">`;
            for (let c = 0; c < COL_KEYS.length; c++) {
                html += `<td contenteditable="true" data-r="${r}" data-c="${c}" style="${cellStyle}">${_escHtml(row[COL_KEYS[c]] || '')}</td>`;
            }
            html += '</tr>';
        }
        tbody.innerHTML = html;
        // 绑定单元格编辑事件
        tbody.querySelectorAll('td[contenteditable]').forEach(td => {
            td.addEventListener('input', () => {
                const r = parseInt(td.dataset.r), c = parseInt(td.dataset.c);
                _tableData[r][COL_KEYS[c]] = td.textContent;
                _syncToHiddenArea();
                _renderAbPreview();
            });
        });
    }

    // 同步表格数据到隐藏 textarea（供导入用）
    function _syncToHiddenArea() {
        const area = overlay.querySelector('#rbt-clip-ab-area');
        if (!area) return;
        area.value = _tableData
            .filter(row => COL_KEYS.some(k => row[k]))
            .map(row => COL_KEYS.map(k => row[k] || '').join('\t'))
            .join('\n');
    }

    // ── 粘贴拦截（支持 Google Sheets 格式，含引号内换行）──
    function _parseTSV(text) {
        // Google Sheets 粘贴：引号内的换行不算行分隔符
        const rows = [];
        let row = [];
        let cell = '';
        let inQuote = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQuote) {
                if (ch === '"' && text[i + 1] === '"') {
                    cell += '"'; i++; // 转义引号
                } else if (ch === '"') {
                    inQuote = false;
                } else {
                    cell += ch;
                }
            } else {
                if (ch === '"') {
                    inQuote = true;
                } else if (ch === '\t') {
                    row.push(cell.trim()); cell = '';
                } else if (ch === '\n' || ch === '\r') {
                    if (ch === '\r' && text[i + 1] === '\n') i++;
                    row.push(cell.trim()); cell = '';
                    if (row.some(c => c)) rows.push(row);
                    row = [];
                } else {
                    cell += ch;
                }
            }
        }
        row.push(cell.trim());
        if (row.some(c => c)) rows.push(row);
        return rows;
    }

    function _handlePaste(e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (!text) return;
        const lines = _parseTSV(text);
        // 检测是否含有表头行（跳过）
        let startIdx = 0;
        if (lines.length > 1) {
            const firstLine = lines[0].join(' ').toLowerCase();
            if (firstLine.includes('标题') || firstLine.includes('名称') || firstLine.includes('title') || firstLine.includes('name')) {
                startIdx = 1;
            }
        }
        // 确定是追加还是替换
        const target = e.target;
        let insertRow = 0;
        if (target && target.dataset && target.dataset.r !== undefined) {
            insertRow = parseInt(target.dataset.r);
        }
        // 如果从第0行粘贴且表格是空的，直接替换
        const isTableEmpty = !_tableData.some(row => COL_KEYS.some(k => row[k]));
        if (isTableEmpty) insertRow = 0;

        for (let i = startIdx; i < lines.length; i++) {
            const cols = lines[i]; // 已经是数组
            const rowIdx = insertRow + (i - startIdx);
            _ensureMinRows(rowIdx + 1);
            for (let c = 0; c < Math.min(cols.length, COL_KEYS.length); c++) {
                // 保留单元格内换行，替换为空格显示
                _tableData[rowIdx][COL_KEYS[c]] = (cols[c] || '').replace(/[\r\n]+/g, ' ').trim();
            }
        }
        _ensureMinRows(_tableData.length + 2);
        _renderTable();
        _syncToHiddenArea();
        _renderAbPreview();
    }

    function _renderAbPreview() {
        const previewEl = overlay.querySelector('#rbt-clip-ab-preview');
        const dataRows = _tableData.filter(row => COL_KEYS.some(k => row[k]));
        
        if (dataRows.length === 0) {
            previewEl.innerHTML = '<div style="color:#666;text-align:center;padding:20px;">等待粘贴数据...</div>';
            return;
        }

        let html = '<table style="width:100%;border-collapse:collapse;color:#ccc;table-layout:fixed;border-radius:4px;overflow:hidden;box-shadow:0 0 0 1px #333;">';
        html += '<tr style="background:#222;position:sticky;top:0;"><th style="padding:4px 6px;border-bottom:1px solid #444;width:35px;">版</th><th style="padding:4px 6px;border-bottom:1px solid #444;width:80px;">名称</th><th style="padding:4px 6px;border-bottom:1px solid #444;width:60px;">时间</th><th style="padding:4px 6px;border-bottom:1px solid #444;text-align:left;">文案内容</th></tr>';
        
        for (let i = 0; i < Math.min(dataRows.length, 30); i++) {
            const row = dataRows[i];
            const clipName = row.clipName || row.videoName || `clip_${i+1}`;
            const timeStr = row.timeRange ? `<span style="color:#888;">${_escHtml(row.timeRange)}</span>` : '';
            
            let aTitle = row.aTitle ? `<strong style="color:#ccc;">${_escHtml(row.aTitle)}</strong>` : '';
            let aBody = row.aBody ? `<span style="color:#aaa;">${_escHtml(row.aBody)}</span>` : '';
            let bTitle = row.bTitle ? `<strong style="color:#ccc;">${_escHtml(row.bTitle)}</strong>` : '';
            let bBody = row.bBody ? `<span style="color:#aaa;">${_escHtml(row.bBody)}</span>` : '';
            
            if (aTitle || aBody) {
                html += `<tr style="background:#1a1a24;"><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;color:#a78bfa;font-weight:bold;text-align:center;">A</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-all;color:#ccc;">${_escHtml(clipName)}_A</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;">${timeStr}</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-word;">${[aTitle, aBody].filter(Boolean).join(' <span style="color:#555">|</span> ')}</td></tr>`;
            }
            if (bTitle || bBody) {
                html += `<tr style="background:#141a24;"><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;color:#4c9eff;font-weight:bold;text-align:center;">B</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-all;color:#ccc;">${_escHtml(clipName)}_B</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;">${timeStr}</td><td style="padding:4px 6px;border-bottom:1px solid #2a2a3a;word-break:break-word;">${[bTitle, bBody].filter(Boolean).join(' <span style="color:#555">|</span> ')}</td></tr>`;
            }
        }
        html += '</table>';
        if (dataRows.length > 30) {
            html += `<div style="text-align:center;padding:8px;color:#888;font-size:11px;">(共 ${dataRows.length} 行，仅展示前 30 行)</div>`;
        }
        previewEl.innerHTML = html;
    }

    // 初始化表格
    _renderTable();
    // 在整个表格容器上拦截粘贴
    const tableContainer = overlay.querySelector('#rbt-clip-ab-table');
    if (tableContainer) tableContainer.addEventListener('paste', _handlePaste);
    // 清空按钮
    overlay.querySelector('#rbt-clip-ab-clear').addEventListener('click', () => {
        _tableData = [];
        _ensureMinRows(5);
        _renderTable();
        _syncToHiddenArea();
        _renderAbPreview();
    });

    function setupFileSelectPath(id) {
        const input = overlay.querySelector('#' + id);
        
        const triggerNativeDialog = async () => {
            if (window.require) {
                try {
                    const { dialog, getCurrentWindow } = window.require('@electron/remote');
                    const result = await dialog.showOpenDialog(getCurrentWindow(), {
                        title: '选择背景素材 (图片/视频 或 图片序列文件夹)',
                        properties: ['openFile', 'openDirectory']
                    });
                    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                        input.value = result.filePaths[0];
                        return true;
                    }
                    return result.canceled;
                } catch (e) {
                    console.warn('Native dialog failed, falling back', e);
                }
            }
            return false;
        };

        const triggerFallback = () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.mp4,.mov,.mkv,.png,.jpg,.jpeg';
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const file = e.target.files[0];
                    let localPath = file.path;
                    if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                        try { localPath = window.electronAPI.getFilePath(file); } catch (_) {}
                    }
                    input.value = localPath || file.name;
                }
            });
            fileInput.click();
        };

        input.addEventListener('dblclick', async () => {
            const handled = await triggerNativeDialog();
            if (handled === false) {
                triggerFallback();
            }
        });

        input.addEventListener('dragover', e => e.preventDefault());
        input.addEventListener('drop', e => {
            e.preventDefault();
            if (e.dataTransfer.files.length) {
                const file = e.dataTransfer.files[0];
                let localPath = file.path;
                if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                    try { localPath = window.electronAPI.getFilePath(file); } catch (_) {}
                }
                input.value = localPath || file.name;
            }
        });
    }
    setupFileSelectPath('rbt-clip-bg-a');
    setupFileSelectPath('rbt-clip-bg-b');
    
    const cvInput = overlay.querySelector('#rbt-clip-cv-path');
    const cvModeRadios = overlay.querySelectorAll('input[name="clip_cv_mode"]');
    
    function updateCvBtnLabel() {
        const isMulti = document.querySelector('input[name="clip_cv_mode"]:checked').value === 'multi';
        overlay.querySelector('#rbt-clip-cv-btn').textContent = isMulti ? '📁 选择文件夹' : '🎬 选择视频文件';
    }
    cvModeRadios.forEach(r => r.addEventListener('change', updateCvBtnLabel));
    updateCvBtnLabel();

    overlay.querySelector('#rbt-clip-cv-btn').addEventListener('click', async () => {
        const isMulti = document.querySelector('input[name="clip_cv_mode"]:checked').value === 'multi';
        
        let handled = false;
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: isMulti ? '选择需要批量映射的视频所在的文件夹' : '选择包含在每一个视频内容表层的唯一主文件(或图片序列文件夹)',
                    properties: isMulti ? ['openDirectory'] : ['openFile', 'openDirectory']
                });
                if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                    cvInput.value = result.filePaths[0];
                    handled = true;
                } else if (result.canceled) {
                    handled = true;
                }
            } catch (e) {
                console.warn('Native dialog failed for cv btn, falling back', e);
            }
        }

        if (!handled) {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            // standard <input type="file"> fallback requires webkitdirectory to pick a folder.
            // Since we want both in Single mode, we can't do both cleanly in raw HTML. We let desktop app handle it naturally via showOpenDialog.
            if (isMulti) {
                fileInput.webkitdirectory = true;
                fileInput.directory = true;
            } else {
                fileInput.accept = '.mp4,.mov,.mkv,.avi,.webm,.png,.jpg,.jpeg';
            }
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length) {
                    const file = e.target.files[0];
                    let localPath = file.path;
                    if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                        localPath = window.electronAPI.getFilePath(file);
                    }
                    if (isMulti && localPath) {
                        const path = window.require ? window.require('path') : null;
                        cvInput.value = path ? path.dirname(localPath) : localPath;
                    } else {
                        cvInput.value = localPath || file.name;
                    }
                }
            });
            fileInput.click();
        }
    });

    cvInput.addEventListener('dblclick', () => {
        overlay.querySelector('#rbt-clip-cv-btn').click();
    });
    cvInput.addEventListener('dragover', e => e.preventDefault());
    cvInput.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer.files.length) {
            const file = e.dataTransfer.files[0];
            let localPath = file.path;
            if (!localPath && window.electronAPI && window.electronAPI.getFilePath) {
                localPath = window.electronAPI.getFilePath(file);
            }
            cvInput.value = localPath || file.name;
        }
    });

    overlay.querySelector('#rbt-clip-ab-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#rbt-clip-ab-import').addEventListener('click', () => {
        const raw = overlay.querySelector('#rbt-clip-ab-area').value.trim();
        if (!raw) {
            if (typeof showToast === 'function') showToast('请粘贴文案数据', 'error');
            return;
        }

        const bgA = overlay.querySelector('#rbt-clip-bg-a').value.trim();
        const bgB = overlay.querySelector('#rbt-clip-bg-b').value.trim();
        const cvMode = document.querySelector('input[name="clip_cv_mode"]:checked').value;
        const cvPath = overlay.querySelector('#rbt-clip-cv-path').value.trim();
        const cvScale = parseInt(overlay.querySelector('#rbt-clip-cv-scale').value, 10) || 100;
        
        localStorage.setItem('rbt_clip_bg_preset_a', bgA);
        localStorage.setItem('rbt_clip_bg_preset_b', bgB);
        localStorage.setItem('rbt_clip_cv_mode', cvMode);
        localStorage.setItem('rbt_clip_cv_preset', cvPath);

        const state = window._reelsState;
        
        // 解析多视频文件夹逻辑
        let cvFiles = [];
        if (cvMode === 'multi' && cvPath && window.require) {
            try {
                const fs = window.require('fs');
                const path = window.require('path');
                if (fs.existsSync(cvPath) && fs.statSync(cvPath).isDirectory()) {
                    cvFiles = fs.readdirSync(cvPath).filter(f => !f.startsWith('.') && /\.(mp4|mov|mkv|wmv|avi|webm)$/i.test(f)).sort();
                    cvFiles = cvFiles.map(f => path.join(cvPath, f));
                }
            } catch (e) {
                console.warn('Failed to read folder for multi-video mode', e);
            }
        }

        const lines = raw.split('\n').filter(l => l.trim());
        let created = 0;

        // Clear trailing totally empty tasks so they are overwritten implicitly
        while (state.tasks.length > 0) {
            const last = state.tasks[state.tasks.length - 1];
            if (!last.videoPath && !last.audioPath && (!last.overlays || last.overlays.length === 0)) {
                state.tasks.pop();
            } else {
                break;
            }
        }
        
        // 时间解析 Helper
        function _parseTimeStr(str) {
            if (typeof window.parseBatchCutTime === 'function') return window.parseBatchCutTime(str);
            // 简单的回退解析 hh:mm:ss.ff
            const p = String(str).split(':');
            if (p.length === 3) return parseFloat(p[0])*3600 + parseFloat(p[1])*60 + parseFloat(p[2]);
            if (p.length === 2) return parseFloat(p[0])*60 + parseFloat(p[1]);
            return parseFloat(p[0]) || null;
        }

        let validRowIndex = 0;
        for (const line of lines) {
            const cols = line.split('\t');
            if (cols.length < 3) continue;

            const rawName = (cols[0] || '').trim();
            let trimStart = null, trimEnd = null;
            let displayBaseName = rawName;

            // 7列: 视频名称(0) 片段名称(1) 时间段(2) A标题(3) A正文(4) B标题(5) B正文(6)
            const videoName = (cols[0] || '').trim();
            const clipName = (cols[1] || '').trim();
            const timeRange = (cols[2] || '').trim();
            const aTitle = (cols[3] || '').trim();
            const aBody = (cols[4] || '').trim();
            const bTitle = (cols[5] || '').trim();
            const bBody = (cols[6] || '').trim();
            const aFooter = '';
            const bFooter = '';

            // 从时间段列提取裁切入出点
            if (timeRange) {
                const tMatch = timeRange.match(/^(.+?)\s*[-—~～]+\s*(.+)$/);
                if (tMatch) {
                    const ps1 = _parseTimeStr(tMatch[1].trim());
                    const ps2 = _parseTimeStr(tMatch[2].trim());
                    if (ps1 !== null && ps2 !== null) {
                        trimStart = ps1;
                        trimEnd = ps2;
                    }
                }
            }
            // 使用片段名称作为任务名，回退到视频名称
            displayBaseName = clipName || videoName || rawName;

            // 获取相应的 Content Video 路径
            let assignCvPath = '';
            if (cvMode === 'single') {
                assignCvPath = cvPath;
            } else if (cvMode === 'multi' && cvFiles.length > 0) {
                assignCvPath = cvFiles[validRowIndex % cvFiles.length];
            }

            // ── A ──
            const taskA = typeof _createEmptyTask === 'function' ? _createEmptyTask() : {};
            taskA.baseName = displayBaseName ? `${displayBaseName}_A` : `clip_${created + 1}_A`;
            taskA.fileName = taskA.baseName + '.mp4';
            taskA._version = 'A';
            if (bgA) { taskA.bgPath = bgA; taskA.videoPath = bgA; }
            if (assignCvPath) {
                taskA.contentVideoPath = assignCvPath;
                taskA.contentVideoScale = cvScale;
                if (trimStart !== null) taskA.contentVideoTrimStart = trimStart;
                if (trimEnd !== null) taskA.contentVideoTrimEnd = trimEnd;
            }
            
            if (aTitle || aBody || aFooter) {
                if (window.ReelsOverlay && window.ReelsOverlay.createTextCardOverlay) {
                    taskA.overlays = [ window.ReelsOverlay.createTextCardOverlay({title_text: aTitle, body_text: aBody, footer_text: aFooter, start: 0, end: 9999}) ];
                } else {
                    taskA.overlays = [{ type: 'textcard', id: 'tc_' + Date.now() + '_a', title_text: aTitle, body_text: aBody, footer_text: aFooter, x: 85, y: 310, w: 910, h: 1300, start: 0, end: 9999 }];
                }
            }
            state.tasks.push(taskA);
            created++;

            // ── B ──
            if (bTitle || bBody || bFooter) {
                const taskB = typeof _createEmptyTask === 'function' ? _createEmptyTask() : {};
                taskB.baseName = displayBaseName ? `${displayBaseName}_B` : `clip_${created + 1}_B`;
                taskB.fileName = taskB.baseName + '.mp4';
                taskB._version = 'B';
                if (bgB) { taskB.bgPath = bgB; taskB.videoPath = bgB; }
                if (assignCvPath) {
                    taskB.contentVideoPath = assignCvPath;
                    taskB.contentVideoScale = cvScale;
                    if (trimStart !== null) taskB.contentVideoTrimStart = trimStart;
                    if (trimEnd !== null) taskB.contentVideoTrimEnd = trimEnd;
                }
                
                if (window.ReelsOverlay && window.ReelsOverlay.createTextCardOverlay) {
                    taskB.overlays = [ window.ReelsOverlay.createTextCardOverlay({title_text: bTitle, body_text: bBody, footer_text: bFooter, start: 0, end: 9999}) ];
                } else {
                    taskB.overlays = [{ type: 'textcard', id: 'tc_' + Date.now() + '_b', title_text: bTitle, body_text: bBody, footer_text: bFooter, x: 85, y: 310, w: 910, h: 1300, start: 0, end: 9999 }];
                }
                state.tasks.push(taskB);
                created++;
            }
            
            validRowIndex++;
        }

        overlay.remove();
        _renderBatchTable();
        
        setTimeout(() => {
            const scroller = document.querySelector('#rbt-tbody-wrapper') || document.querySelector('.rbt-table-container');
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
        }, 100);

        if (typeof showToast === 'function') showToast(`✂️ 已生成 ${created} 行任务 (${validRowIndex} 个场景 × A/B 版本)`, 'success');
    });

    // Auto focus
    setTimeout(() => overlay.querySelector('#rbt-clip-ab-area')?.focus(), 100);
}

// Expose
window.reelsToggleBatchTable = reelsToggleBatchTable;

// ═══════════════════════════════════════════════════════
// Media Pool Sidebar — Event Binding (inline sidebar)
// ═══════════════════════════════════════════════════════

window._mediaPool = window._mediaPool || { items: [] };

function _bindMediaSidebarEvents(container) {
    const sidebar = container.querySelector('#rbt-media-sidebar');
    if (!sidebar) return; // sidebar not open

    // ── Active filter state ──
    let _activeFilter = 'all';

    // Hidden file inputs — NOT used anymore in Electron, kept as web fallback
    const hiddenFileInput = document.createElement('input');
    hiddenFileInput.type = 'file';
    hiddenFileInput.multiple = true;
    hiddenFileInput.style.display = 'none';

    const hiddenFolderInput = document.createElement('input');
    hiddenFolderInput.type = 'file';
    hiddenFolderInput.webkitdirectory = true;
    hiddenFolderInput.multiple = true;
    hiddenFolderInput.style.display = 'none';

    sidebar.appendChild(hiddenFileInput);
    sidebar.appendChild(hiddenFolderInput);

    const _renderPoolItems = () => {
        const poolEl = sidebar.querySelector('#rbt-ms-pool');
        if (!poolEl) return;
        const allItems = window._mediaPool.items || [];
        const items = _activeFilter === 'all' ? allItems : allItems.filter(it => {
            switch (_activeFilter) {
                case 'bg': return it.isVideo || it.isImage;
                case 'overlay': return it.isVideo || it.isImage || it.type === 'seq';
                case 'hook': return it.isVideo;
                case 'universal': return it.isVideo || it.isImage;
                case 'voice': return it.isAudio;
                case 'bgm': return it.isAudio;
                case 'text': return it.ext === 'srt' || it.ext === 'txt';
                default: return true;
            }
        });
        if (allItems.length === 0) {
            poolEl.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:20px 8px;">📥 拖拽文件到此处<br>或点击上方按钮导入</div>';
        } else if (items.length === 0) {
            poolEl.innerHTML = '<div style="color:#555; font-size:12px; text-align:center; padding:20px 8px;">当前分类下无素材</div>';
        } else {
            poolEl.innerHTML = items.map((it) => {
                const realIdx = allItems.indexOf(it);
                const urlObj = window.electronAPI && window.electronAPI.toFileUrl ? window.electronAPI.toFileUrl(it.path) : `file://${it.path}`;
                const thumbHtml = it.isImage 
                    ? `<img class="rbt-thumb-previewable" src="${_escHtml(urlObj)}" style="width:20px;height:20px;object-fit:cover;border-radius:2px;">` 
                    : it.isVideo 
                        ? `<video class="rbt-thumb-previewable" src="${_escHtml(urlObj)}#t=1" style="width:20px;height:20px;object-fit:cover;border-radius:2px;background:#000;"></video>` 
                        : (it.type === 'seq' ? '🎞️' : it.isAudio ? '🎙' : '📄');
                        
                return `
                <div class="rbt-ms-item" data-idx="${realIdx}" draggable="true" style="display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; background:#1a1a2e; margin-bottom:3px; font-size:11px; color:#ccc; cursor:grab; transition: background 0.2s;" title="${_escHtml(it.path || it.name)}">
                    <span style="flex-shrink:0;">${thumbHtml}</span>
                    <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; pointer-events:none;">${_escHtml(it.name)}</span>
                    <span style="flex-shrink:0; font-size:9px; color:#666; pointer-events:none;">${it.role || ''}</span>
                    <button class="rbt-ms-remove" data-idx="${realIdx}" style="background:none; border:none; color:#666; cursor:pointer; font-size:10px; padding:0 2px;">✕</button>
                </div>`;
            }).join('');
        }
        const countEl = sidebar.querySelector('.rbt-ms-count');
        if (countEl) countEl.textContent = `(${allItems.length})`;
    };

    const _classifyFile = (name) => {
        const ext = (name || '').split('.').pop().toLowerCase();
        const videoExts = new Set(['mp4','mov','mkv','avi','wmv','flv','webm']);
        const imageExts = new Set(['jpg','jpeg','png','webp','bmp','tiff']);
        const audioExts = new Set(['mp3','wav','m4a','aac','flac','ogg','wma']);
        return {
            isVideo: videoExts.has(ext),
            isImage: imageExts.has(ext),
            isAudio: audioExts.has(ext),
            ext
        };
    };

    const _addFilesByPath = (filePaths) => {
        if (!filePaths || filePaths.length === 0) return;
        const pathMod = window.require ? window.require('path') : null;
        for (const fp of filePaths) {
            const name = pathMod ? pathMod.basename(fp) : fp.split(/[\\/]/).pop();
            const cls = _classifyFile(name);
            window._mediaPool.items.push({ name, path: fp, size: 0, file: null, type: 'file', role: '', ...cls });
        }
        _renderPoolItems();
        if (typeof showToast === 'function') showToast(`📥 已导入 ${filePaths.length} 个文件到素材池`, 'success');
        console.log(`[MediaPool] Ingested ${filePaths.length} files (abs path), pool size: ${window._mediaPool.items.length}`);
    };

    const handleFiles = (files) => {
        if (!files || files.length === 0) return;
        _addFilesByPath(Array.from(files).map(f => {
            const p = (typeof getFileNativePath === 'function') ? getFileNativePath(f) : (f.path || f.name);
            return p;
        }).filter(p => Boolean(p)));
    };

    hiddenFileInput.onchange = (e) => { handleFiles(Array.from(e.target.files)); e.target.value = ''; };
    hiddenFolderInput.onchange = (e) => { handleFiles(Array.from(e.target.files)); e.target.value = ''; };

    // ━━━ Import Files — native Electron dialog ━━━
    sidebar.querySelector('#rbt-ms-import-files')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择素材文件',
                    properties: ['openFile', 'multiSelections'],
                    filters: [{ name: '媒体文件', extensions: ['mp4','mov','mkv','avi','wmv','flv','webm','jpg','jpeg','png','webp','bmp','tiff','mp3','wav','m4a','aac','flac','ogg','wma','srt','txt'] }]
                });
                if (!result.canceled && result.filePaths?.length > 0) _addFilesByPath(result.filePaths);
                return;
            } catch (e) { console.warn('[MediaPool] native dialog failed', e); }
        }
        hiddenFileInput.click();
    });

    // ━━━ Import Folder — native Electron dialog, flatten contents ━━━
    sidebar.querySelector('#rbt-ms-import-folder')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择素材文件夹（拆散其中所有文件）',
                    properties: ['openDirectory']
                });
                if (!result.canceled && result.filePaths?.length > 0) {
                    const dirPath = result.filePaths[0];
                    const fs = window.require('fs');
                    const pathMod = window.require('path');
                    const allPaths = fs.readdirSync(dirPath)
                        .filter(f => !f.startsWith('.'))
                        .map(f => pathMod.join(dirPath, f))
                        .filter(fp => { try { return fs.statSync(fp).isFile(); } catch { return false; } });
                    if (allPaths.length > 0) _addFilesByPath(allPaths);
                    else if (typeof showToast === 'function') showToast('该文件夹中没有找到文件', 'warning');
                }
                return;
            } catch (e) { console.warn('[MediaPool] native folder dialog failed', e); }
        }
        hiddenFolderInput.click();
    });

    // ━━━ Sequence frame directory ━━━
    sidebar.querySelector('#rbt-ms-import-seq')?.addEventListener('click', async () => {
        if (window.require) {
            try {
                const { dialog, getCurrentWindow } = window.require('@electron/remote');
                const result = await dialog.showOpenDialog(getCurrentWindow(), {
                    title: '选择图片序列帧文件夹',
                    properties: ['openDirectory']
                });
                if (!result.canceled && result.filePaths?.length > 0) {
                    const dirPath = result.filePaths[0];
                    const dirName = dirPath.split(/[\\/]/).pop() || dirPath;
                    window._mediaPool.items.push({
                        name: dirName, path: dirPath, size: 0, file: null,
                        type: 'seq', role: '', isVideo: false, isImage: false, isAudio: false, ext: 'seq'
                    });
                    _renderPoolItems();
                    if (typeof showToast === 'function') showToast(`🎞️ 序列帧目录已入池: ${dirName}`, 'success');
                }
                return;
            } catch (e) { console.warn('[MediaPool] native seq dialog failed', e); }
        }
        if (typeof showToast === 'function') showToast('需在桌面应用中使用序列帧导入', 'warning');
    });

    // ━━━ Clear pool ━━━
    sidebar.querySelector('#rbt-ms-clear')?.addEventListener('click', () => {
        if (confirm('确定清空素材池？')) {
            window._mediaPool.items = [];
            _renderPoolItems();
        }
    });

    // ━━━ Apply Role button ━━━
    sidebar.querySelector('#rbt-ms-apply-bulk')?.addEventListener('click', () => {
        const roleSelect = sidebar.querySelector('#rbt-ms-bulk-role');
        const role = roleSelect ? roleSelect.value : '';
        if (!role) { if (typeof showToast === 'function') showToast('请先选择一个角色', 'warning'); return; }
        const allItems = window._mediaPool.items || [];
        const items = _activeFilter === 'all' ? allItems : allItems.filter(it => {
            switch (_activeFilter) {
                case 'bg': return it.isVideo || it.isImage;
                case 'overlay': return it.isVideo || it.isImage || it.type === 'seq';
                case 'hook': return it.isVideo;
                case 'voice': return it.isAudio;
                case 'bgm': return it.isAudio;
                case 'text': return it.ext === 'srt' || it.ext === 'txt';
                default: return true;
            }
        });
        if (items.length === 0) { if (typeof showToast === 'function') showToast('素材池为空（或当前分类下无素材）', 'warning'); return; }
        const tasks = window._reelsState?.tasks || [];
        if (tasks.length === 0) { if (typeof showToast === 'function') showToast('请先创建任务（行）', 'warning'); return; }
        let applied = 0;
        for (let i = 0; i < Math.min(items.length, tasks.length); i++) {
            const item = items[i], task = tasks[i];
            switch (role) {
                case 'bg': task.bgPath = item.path; task.videoPath = item.path; task.bgSrcUrl = ''; applied++; break;
                case 'overlay': task.contentVideoPath = item.path; applied++; break;
                case 'hook':
                    if (!task.hook) task.hook = {};
                    task.hook.enabled = true;
                    task.hook.path = item.path;
                    task.hookFile = item.path;
                    applied++;
                    break;
                case 'universal': task.bgPath = item.path; task.videoPath = item.path; applied++; break;
                case 'voice': task.audioPath = item.path; applied++; break;
                case 'bgm': task.bgmPath = item.path; applied++; break;
            }
            item.role = role;
        }
        if (applied > 0) {
            _renderBatchTable();
            const roleLabels = { bg: '背景', overlay: '视频覆层', hook: '钩子', universal: '通用', voice: '人声', bgm: '配乐' };
            if (typeof showToast === 'function') showToast(`✅ 已将 ${applied} 个素材按「${roleLabels[role] || role}」角色依次分配到前 ${applied} 行`, 'success');
        }
    });

    // Drag & Drop on the pool area
    const poolArea = sidebar.querySelector('#rbt-ms-pool');
    if (poolArea) {
        // Event delegation for drag events and remove clicks
        poolArea.addEventListener('click', (e) => {
            const btn = e.target.closest('.rbt-ms-remove');
            if (btn) {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx);
                window._mediaPool.items.splice(idx, 1);
                _renderPoolItems();
            }
        });
        poolArea.addEventListener('dragstart', (e) => {
            const item = e.target.closest('.rbt-ms-item');
            if (item) {
                e.dataTransfer.setData('application/x-media-pool-idx', item.dataset.idx);
                e.dataTransfer.effectAllowed = 'copy';
                item.style.opacity = '0.5';
            }
        });
        poolArea.addEventListener('dragend', (e) => {
            const item = e.target.closest('.rbt-ms-item');
            if (item) item.style.opacity = '1';
        });

        // Drop handling for pool area
        poolArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
            poolArea.style.background = 'rgba(124,92,255,0.1)';
            poolArea.style.boxShadow = 'inset 0 0 0 2px rgba(124,92,255,0.4)';
        });
        poolArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            poolArea.style.background = '';
            poolArea.style.boxShadow = '';
        });
        poolArea.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            poolArea.style.background = '';
            poolArea.style.boxShadow = '';
            const files = Array.from(e.dataTransfer.files || []);
            if (files.length > 0) {
                handleFiles(files);
            }
        });
    }

    // Filter clicks
    sidebar.querySelectorAll('.rbt-ms-filter').forEach(el => {
        el.addEventListener('click', () => {
            sidebar.querySelectorAll('.rbt-ms-filter').forEach(f => f.classList.remove('active'));
            el.classList.add('active');
            _activeFilter = el.dataset.filter || 'all';
            _renderPoolItems();
        });
    });
    // Resize handle
    const resizeHandle = sidebar.querySelector('#rbt-ms-resize');
    if (resizeHandle) {
        let startX = 0, startW = 0;
        const onMouseMove = (e) => {
            const newW = Math.min(500, Math.max(180, startW + (e.clientX - startX)));
            sidebar.style.width = newW + 'px';
        };
        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            resizeHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        resizeHandle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            resizeHandle.classList.add('active');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // Render existing items on open
    _renderPoolItems();
}
