/**
 * reels-bulk-create.js — 大量制作模块 v2
 * 工程模版 × 数据表格 = 批量任务
 * - 模板来源: 当前工程 tasks（含背景/覆层/音频）
 * - 每个模板独立绑定列
 * - 素材自动循环，填写则覆盖
 */

const _bulkState = {
    columns: [
        { name: '原始完整文案', type: 'text' },
        { name: '标题', type: 'text' },
        { name: '正文', type: 'text' },
    ],
    rows: [],
    // templates: [{ task: {...}, label: '', bindings: { title_text: colIdx, ... } }]
    templates: [],
};

const BC_DRAFT_KEY = 'reels_bulk_create_last_state';
let _bcDraftLoaded = false;
let _bcDraftSaveTimer = null;

let _bcSelection = null;
let _bcIsSelecting = false;
let _bcModalAbort = null;

function _bcNormalizeStateShape() {
    if (!Array.isArray(_bulkState.columns) || _bulkState.columns.length === 0) {
        _bulkState.columns = [
            { name: '原始完整文案', type: 'text' },
            { name: '标题', type: 'text' },
            { name: '正文', type: 'text' },
        ];
    }
    if (!Array.isArray(_bulkState.rows)) _bulkState.rows = [];
    if (!Array.isArray(_bulkState.templates)) _bulkState.templates = [];

    _bulkState.rows = _bulkState.rows.map(row => Array.isArray(row) ? row : []);
    _bulkState.rows.forEach(row => {
        while (row.length < _bulkState.columns.length) row.push('');
        if (row.length > _bulkState.columns.length) row.length = _bulkState.columns.length;
    });
}

function _bcLoadDraftOnce() {
    if (_bcDraftLoaded) return;
    _bcDraftLoaded = true;

    try {
        const raw = localStorage.getItem(BC_DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (!draft || draft.type !== 'bulk_create_draft') return;
        if (!Array.isArray(draft.columns)) return;

        _bulkState.columns = JSON.parse(JSON.stringify(draft.columns));
        _bulkState.rows = Array.isArray(draft.rows) ? JSON.parse(JSON.stringify(draft.rows)) : [];
        _bulkState.templates = Array.isArray(draft.templates)
            ? draft.templates.map(t => ({
                task: t.task || {},
                label: t.label || '模板',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
            }))
            : [];

        // ★ 修复旧草稿：检测并清除错误的跨模板共享 bgCycle
        // 如果多个模板有完全相同的 bgCycle，说明是旧 bug 造成的，需要清除
        if (_bulkState.templates.length > 1) {
            const bgCycleStrs = _bulkState.templates
                .filter(t => t.bgCycle && t.bgCycle.length > 0)
                .map(t => JSON.stringify(t.bgCycle));
            const uniqueCycles = new Set(bgCycleStrs);
            if (bgCycleStrs.length > 1 && uniqueCycles.size === 1) {
                // 所有模板共享同一个 bgCycle → 是旧 bug，清除
                console.warn('[BulkCreate] 检测到旧草稿的错误 bgCycle（跨模板共享），已自动清除');
                _bulkState.templates.forEach(t => t.bgCycle = null);
            }
        }

        _bcNormalizeStateShape();
    } catch (e) {
        console.warn('[BulkCreate] 恢复上次草稿失败:', e);
    }
}

function _bcSaveDraftNow() {
    try {
        _bcNormalizeStateShape();
        const draft = {
            type: 'bulk_create_draft',
            version: 5,
            columns: JSON.parse(JSON.stringify(_bulkState.columns)),
            rows: JSON.parse(JSON.stringify(_bulkState.rows)),
            templates: _bulkState.templates.map(t => ({
                task: t.task || {},
                label: t.label || '',
                bindings: { ...(t.bindings || {}) },
                bgCycle: t.bgCycle || null,
                source: t.source || null,
            })),
            savedAt: new Date().toISOString(),
        };
        localStorage.setItem(BC_DRAFT_KEY, JSON.stringify(draft));
    } catch (e) {
        console.warn('[BulkCreate] 保存上次草稿失败:', e);
    }
}

function _bcScheduleDraftSave() {
    if (_bcDraftSaveTimer) clearTimeout(_bcDraftSaveTimer);
    _bcDraftSaveTimer = setTimeout(() => {
        _bcDraftSaveTimer = null;
        _bcSaveDraftNow();
    }, 250);
}

// ★ bgCycle 只在「统一模式」或手动设置时生效，不跨模板自动合并
function _bcAutoPopulateBgCycle() {
    // 不再自动跨模板合并背景 — 每个模板保留自己的 bgPath
    // bgCycle 仅通过「统一模式导入」或「手动设置背景循环」按钮设置
}

function _bcNormalizeMediaPathForCycle(path) {
    let p = String(path || '').trim();
    if (!p) return '';
    if (/^local-media:\/\//i.test(p)) p = p.replace(/^local-media:\/\//i, '');
    if (/^file:\/\//i.test(p)) {
        try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { p = p.replace(/^file:\/\//i, ''); }
    }
    return p;
}

function _bcAddUniqueCyclePath(list, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (p && !list.includes(p)) list.push(p);
}

function _bcCollectTaskBackgroundCycle(task) {
    const out = [];
    if (!task) return out;
    if (Array.isArray(task.bgClipPool)) {
        task.bgClipPool.forEach(p => _bcAddUniqueCyclePath(out, p));
    }
    _bcAddUniqueCyclePath(out, task.bgPath);
    _bcAddUniqueCyclePath(out, task.videoPath);
    _bcAddUniqueCyclePath(out, task.backgroundPath);
    _bcAddUniqueCyclePath(out, task.cover?.bgPath);
    return out;
}

function _bcTemplateBgCycle(task) {
    const cycle = _bcCollectTaskBackgroundCycle(task);
    return cycle.length > 1 ? cycle : null;
}

function _bcCollectProjectBackgroundCycle(projectData) {
    const out = [];
    const library = Array.isArray(projectData?.backgroundLibrary) ? projectData.backgroundLibrary : [];
    library.forEach(item => {
        if (typeof item === 'string') _bcAddUniqueCyclePath(out, item);
        else _bcAddUniqueCyclePath(out, item?.path || item?.filePath || item?.videoPath || item?.bgPath);
    });
    return out;
}

function _bcResolveTemplateBgCycle(task, projectCycle = null) {
    const scoped = _bcTemplateBgCycle(task);
    if (scoped && scoped.length > 1) return scoped;
    return projectCycle && projectCycle.length > 1 ? projectCycle : null;
}

function _bcDeserializeProjectTasks(projectData) {
    let safeTasks = projectData?.tasks || [];
    if (typeof ReelsProject !== 'undefined' && ReelsProject.applyProjectData) {
        try {
            const restored = ReelsProject.applyProjectData(projectData || { version: '2.0.0', tasks: safeTasks });
            if (restored && Array.isArray(restored.tasks)) safeTasks = restored.tasks;
        } catch(e) {
            console.error('[BulkCreate] Error safely deserializing tasks:', e);
        }
    }
    return safeTasks;
}

function _bcCloneTemplateTask(task) {
    const clone = JSON.parse(JSON.stringify(task || {}));
    delete clone._video; delete clone._bgThumb;
    if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
    if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
    return clone;
}

function _bcApplySingleBackground(task, path) {
    const p = _bcNormalizeMediaPathForCycle(path);
    if (!task || !p) return;
    task.bgPath = p;
    task.videoPath = p;
    task.bgSrcUrl = null;
    task.srcUrl = null;
    task.bgMode = 'single';
    task.bgClipPool = [];
}

// 选择背景循环文件
function _bcPickBgCycleFiles(tpl, ti) {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        window.electronAPI.showOpenDialog({
            title: '选择背景素材文件（可多选）',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '视频/图片', extensions: ['mp4','mov','avi','mkv','webm','jpg','jpeg','png','webp','gif'] }
            ]
        }).then(result => {
            if (result && result.filePaths && result.filePaths.length > 0) {
                if (!tpl.bgCycle) tpl.bgCycle = [];
                result.filePaths.forEach(p => { if (!tpl.bgCycle.includes(p)) tpl.bgCycle.push(p); });
                console.log(`[BulkCreate] 模板「${tpl.label}」设置背景循环: ${tpl.bgCycle.length} 个素材`);
                _bcRenderBindings();
            }
        });
    } else {
        alert('请在桌面版中使用此功能');
    }
}

// 显示背景循环详情弹窗
function _bcShowBgCycleDetail(tpl, ti) {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000001;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;';

    const renderList = () => {
        const list = tpl.bgCycle || [];
        return list.map((p, i) => {
            const name = p.split(/[/\\]/).pop();
            const ext = (name.split('.').pop() || '').toLowerCase();
            const isVideo = ['mp4','mov','avi','mkv','webm','m4v'].includes(ext);
            const isImage = ['jpg','jpeg','png','webp','gif','bmp'].includes(ext);
            const mediaUrl = _bcFileUrl(p);
            let thumbHtml;
            if (isVideo) {
                thumbHtml = `<video class="bgc-vid-thumb" src="${_bcEsc(mediaUrl)}#t=1" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#111;" muted preload="metadata" playsinline></video>`;
            } else if (isImage) {
                thumbHtml = `<img src="${_bcEsc(mediaUrl)}" style="width:48px;height:48px;object-fit:cover;border-radius:4px;background:#000;" loading="lazy" />`;
            } else {
                thumbHtml = `<div style="width:48px;height:48px;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;font-size:18px;">📄</div>`;
            }
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:5px;" data-idx="${i}">
                <span style="color:#666;font-size:10px;font-weight:bold;min-width:20px;">#${i + 1}</span>
                <div style="flex-shrink:0;">${thumbHtml}</div>
                <span style="flex:1;font-size:11px;color:#ccc;word-break:break-all;min-width:0;" title="${_bcEsc(p)}">${_bcEsc(name)}</span>
                <span class="bgc-del-item" data-idx="${i}" style="cursor:pointer;color:#f66;font-size:10px;padding:2px 6px;border-radius:3px;background:rgba(255,68,68,0.08);border:1px solid rgba(255,68,68,0.15);flex-shrink:0;" title="移除此素材">✕</span>
            </div>`;
        }).join('');
    };

    const rebuild = () => {
        const listEl = ov.querySelector('#bgc-list');
        const countEl = ov.querySelector('#bgc-count');
        if (listEl) listEl.innerHTML = renderList();
        if (countEl) countEl.textContent = `${(tpl.bgCycle || []).length} 个素材`;
        _bgcSeekAllThumbs();
    };

    // 主动对所有视频缩略图 seek 到视频 25% 位置抓帧（避免黑场开头）
    const _bgcSeekAllThumbs = () => {
        setTimeout(() => {
            ov.querySelectorAll('.bgc-vid-thumb').forEach(v => {
                if (v._seeked) return;
                const doSeek = () => {
                    const t = v.duration && isFinite(v.duration) ? v.duration * 0.25 : 3;
                    v.currentTime = Math.max(0.5, t);
                    v._seeked = true;
                };
                v.addEventListener('error', () => {
                    const box = v.parentElement;
                    if (box) box.innerHTML = '<div style="width:48px;height:48px;border-radius:4px;background:#111;color:#f66;display:flex;align-items:center;justify-content:center;font-size:10px;">加载失败</div>';
                }, { once: true });
                if (v.readyState >= 1 && v.duration) doSeek();
                else v.addEventListener('loadedmetadata', doSeek, { once: true });
            });
        }, 100);
    };

    ov.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:20px;width:560px;max-height:75vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.6);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                <h3 style="margin:0;font-size:14px;color:#10b981;">🔄 背景循环素材 — ${_bcEsc(tpl.label)}</h3>
                <button id="bgc-close" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;">✕</button>
            </div>
            <div style="display:flex;gap:6px;margin-bottom:10px;align-items:center;">
                <span id="bgc-count" style="font-size:11px;color:#888;">${(tpl.bgCycle || []).length} 个素材</span>
                <span style="flex:1;"></span>
                <button id="bgc-add" style="padding:4px 10px;font-size:10px;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#10b981;border-radius:4px;cursor:pointer;">📂 添加素材</button>
                <button id="bgc-clear" style="padding:4px 10px;font-size:10px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171;border-radius:4px;cursor:pointer;">🗑 清空全部</button>
            </div>
            <div id="bgc-list" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:60px;max-height:50vh;">
                ${renderList()}
            </div>
            <div style="margin-top:12px;text-align:right;">
                <button id="bgc-done" style="padding:6px 20px;font-size:12px;background:rgba(16,185,129,0.25);border:1px solid rgba(16,185,129,0.4);color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;">确定</button>
            </div>
        </div>
    `;

    document.body.appendChild(ov);
    _bgcSeekAllThumbs();

    const close = () => { ov.remove(); _bcRenderBindings(); };
    ov.querySelector('#bgc-close').onclick = close;
    ov.querySelector('#bgc-done').onclick = close;
    ov.addEventListener('click', e => { if (e.target === ov) close(); });

    // 删除单个
    ov.querySelector('#bgc-list').addEventListener('click', e => {
        const del = e.target.closest('.bgc-del-item');
        if (!del) return;
        const idx = parseInt(del.dataset.idx);
        if (tpl.bgCycle && idx >= 0 && idx < tpl.bgCycle.length) {
            tpl.bgCycle.splice(idx, 1);
            if (tpl.bgCycle.length === 0) tpl.bgCycle = null;
            rebuild();
        }
    });

    // 添加
    ov.querySelector('#bgc-add').onclick = () => {
        _bcPickBgCycleFiles(tpl, ti);
        // 文件选择是异步的，选完后刷新列表
        setTimeout(rebuild, 500);
    };

    // 清空
    ov.querySelector('#bgc-clear').onclick = () => {
        if (confirm('清空全部背景循环素材？')) {
            tpl.bgCycle = null;
            close();
        }
    };
}

function _bcSelectionBounds() {
    if (!_bcSelection) return null;
    return {
        minR: Math.min(_bcSelection.r1, _bcSelection.r2),
        maxR: Math.max(_bcSelection.r1, _bcSelection.r2),
        minC: Math.min(_bcSelection.c1, _bcSelection.c2),
        maxC: Math.max(_bcSelection.c1, _bcSelection.c2),
    };
}

function _bcUpdateSelectionUI() {
    document.querySelectorAll('.bc-grid-td, .bc-cell').forEach(el => el.classList.remove('bc-selected-cell', 'bc-anchor-cell'));
    if (!_bcSelection) return;
    const { minR, maxR, minC, maxC } = _bcSelectionBounds();

    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const cell = document.querySelector(`.bc-cell[data-ri="${r}"][data-ci="${c}"]`);
            const td = document.querySelector(`.bc-grid-td[data-ri="${r}"][data-ci="${c}"]`);
            if (cell) cell.classList.add('bc-selected-cell');
            if (td) td.classList.add('bc-selected-cell');
        }
    }
    const anchor = document.querySelector(`.bc-grid-td[data-ri="${_bcSelection.r1}"][data-ci="${_bcSelection.c1}"]`);
    if (anchor) anchor.classList.add('bc-anchor-cell');
}

function _bcCellPreview(value) {
    const text = String(value || '').replace(/\r?\n/g, ' ↵ ');
    return _bcEsc(text);
}

function _bcFileName(filePath) {
    return String(filePath || '').split(/[\\/]/).pop() || String(filePath || '');
}

function _bcFileExt(filePath) {
    const name = _bcFileName(filePath);
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function _bcFileUrl(filePath) {
    if (!filePath) return '';
    if (/^(blob:|data:|https?:|file:)/i.test(filePath)) return filePath;
    if (window.electronAPI?.toFileUrl) {
        const url = window.electronAPI.toFileUrl(filePath);
        if (url) return url;
    }
    return filePath;
}

function _bcMediaKind(filePath) {
    const ext = _bcFileExt(filePath);
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(ext)) return 'audio';
    if (['srt', 'vtt', 'ass'].includes(ext)) return 'subtitle';
    return 'file';
}

function _bcMediaIconForKind(kind) {
    return { image: '🖼', video: '🎬', audio: '🎵', subtitle: '💬', file: '📄' }[kind] || '📄';
}

function _bcGuessColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    const name = String(col.name || '').toLowerCase();
    if (/srt|vtt|ass|字幕|subtitle|caption/.test(name)) return 'subtitle';
    if (/音频|audio|voice|tts|配音|人声|旁白|bgm|music/.test(name)) return 'audio';
    if (/图片|图像|image|photo|pic|封面|cover|png|jpg|jpeg|webp/.test(name)) return 'image';
    if (/视频|video|movie|clip|背景|bg|素材|media/.test(name)) return 'video';
    return 'video';
}

function _bcColumnKind(col) {
    if (!col || col.type !== 'media') return 'text';
    return col.kind || _bcGuessColumnKind(col);
}

function _bcSetColumnKind(col, kind) {
    if (!col) return;
    if (kind === 'text') {
        col.type = 'text';
        delete col.kind;
    } else {
        col.type = 'media';
        col.kind = kind || 'video';
    }
}

function _bcMediaCellHtml(value) {
    if (!value) return '<span class="bc-cell-placeholder"> </span>';
    const kind = _bcMediaKind(value);
    const url = _bcFileUrl(value);
    const name = _bcFileName(value);
    let thumb = `<span class="bc-media-icon">${_bcMediaIconForKind(kind)}</span>`;
    if (kind === 'image') {
        thumb = `<img class="bc-media-thumb" src="${_bcEsc(url)}" loading="lazy" alt="">`;
    } else if (kind === 'video') {
        thumb = `<video class="bc-media-thumb" src="${_bcEsc(url)}#t=0.1" muted preload="metadata" playsinline></video>`;
    }
    return `${thumb}<span class="bc-media-name">${_bcEsc(name)}</span>`;
}

function _bcIsMediaColumn(ci) {
    return _bulkState.columns[ci]?.type === 'media';
}

function _bcPathMatchesColumnKind(path, ci) {
    const kind = _bcColumnKind(_bulkState.columns[ci]);
    if (!kind || kind === 'video') return ['video', 'file'].includes(_bcMediaKind(path));
    return _bcMediaKind(path) === kind || _bcMediaKind(path) === 'file';
}

function _bcColumnKindOptions(col) {
    const selected = _bcColumnKind(col);
    const opts = [
        ['text', '📝 文字'],
        ['image', '🖼 图片'],
        ['video', '🎬 视频'],
        ['audio', '🎵 音频'],
        ['subtitle', '💬 SRT'],
    ];
    return opts.map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
}

function _bcColumnKindOptionsLabel(col) {
    return {
        text: '📝',
        image: '🖼',
        video: '🎬',
        audio: '🎵',
        subtitle: '💬',
    }[_bcColumnKind(col)] || '📎';
}

function _bcRenderTemplateThumb(overlays, timeoutMs = 2000) {
    if (!Array.isArray(overlays) || overlays.length === 0) return Promise.resolve('');
    if (typeof PresetThumbRenderer === 'undefined') return Promise.resolve('');

    const renderer = new PresetThumbRenderer();
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    return Promise.race([renderer.renderThumbAsync(overlays), timeoutPromise]);
}

function _bcColumnFromName(name) {
    const col = { name, type: 'text' };
    const lowerName = String(name || '').toLowerCase();
    if (/文案|文本|正文|内容|标题|结尾|尾标|断行|ai源|ai原|tts/.test(lowerName)) return col;
    const media = /背景|素材|bg|media|图片|图像|视频|video|image|path|音频|audio|srt|vtt|ass|字幕|subtitle|caption/i.test(name);
    if (media) _bcSetColumnKind(col, _bcGuessColumnKind({ ...col, type: 'media' }));
    return col;
}

function _bcNativeFilePath(file) {
    if (!file) return '';
    if (typeof getFileNativePath === 'function') return getFileNativePath(file);
    if (window.electronAPI?.getFilePath) {
        try {
            const p = window.electronAPI.getFilePath(file);
            if (p) return p;
        } catch (_) {}
    }
    return file.path || file.name || '';
}

function _bcEnsureRows(count) {
    while (_bulkState.rows.length < count) {
        _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
}

function _bcFillMediaColumn(paths, startRi, ci) {
    const cleanPaths = (paths || []).filter(Boolean).filter(p => _bcPathMatchesColumnKind(p, ci));
    if (!cleanPaths.length || !_bcIsMediaColumn(ci)) return 0;
    const safeStart = Math.max(0, startRi || 0);
    _bcEnsureRows(safeStart + cleanPaths.length);
    cleanPaths.forEach((p, offset) => {
        const row = _bulkState.rows[safeStart + offset];
        while (row.length < _bulkState.columns.length) row.push('');
        row[ci] = p;
    });
    _bcSelection = {
        r1: safeStart,
        c1: ci,
        r2: safeStart + cleanPaths.length - 1,
        c2: ci,
    };
    _bcRenderTable();
    return cleanPaths.length;
}

function _bcEsc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Electron-safe prompt replacement
function _bcPrompt(title, placeholder) {
    return new Promise(resolve => {
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:400px;padding:20px;">
            <div style="color:#fff;font-size:13px;font-weight:600;margin-bottom:10px;">${_bcEsc(title)}</div>
            <textarea id="bc-prompt-input" rows="3" placeholder="${_bcEsc(placeholder||'')}" style="width:100%;background:#0a0a14;border:1px solid #333;border-radius:6px;color:#ccc;font-size:12px;padding:8px;resize:vertical;box-sizing:border-box;"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px;">
                <button id="bc-prompt-cancel" style="padding:4px 14px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                <button id="bc-prompt-ok" style="padding:4px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
            </div>
        </div>`;
        document.body.appendChild(m);
        const inp = m.querySelector('#bc-prompt-input');
        setTimeout(() => inp.focus(), 50);
        m.querySelector('#bc-prompt-cancel').onclick = () => { m.remove(); resolve(null); };
        m.querySelector('#bc-prompt-ok').onclick = () => { const v = inp.value; m.remove(); resolve(v); };
        inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = inp.value; m.remove(); resolve(v); } });
    });
}

// ── Bindable fields from a task's overlays ──
function _bcFieldsFromTask(task) {
    const fields = [];
    if (task.bgPath || task.videoPath) {
        fields.push({ key: '__bg__', label: '🎨 背景素材', type: 'media', kinds: ['image', 'video'] });
    }
    if (task.audioPath) {
        fields.push({ key: '__audio__', label: '🎵 人声-音频文件', type: 'media', kinds: ['audio'] });
    }
    if (task.srtPath) {
        fields.push({ key: '__srt__', label: '💬 人声-SRT字幕', type: 'media', kinds: ['subtitle'] });
    }
    if (task.contentVideoPath) {
        fields.push({ key: '__cv__', label: '📹 内容视频', type: 'media', kinds: ['video'] });
    }
    if (_bcTextColumnCandidatesForCategory('ai_source').length > 0 || task.aiScript) {
        fields.push({ key: '__ai__', label: '🧠 人声-原文案（手动绑定）', type: 'text', category: 'ai_source' });
    }
    if (_bcTextColumnCandidatesForCategory('dynamic_subtitle').length > 0 || task.txtContent) {
        fields.push({ key: '__txt__', label: '💬 人声-断行文案（手动绑定）', type: 'text', category: 'dynamic_subtitle' });
    }
    if (_bcTextColumnCandidatesForCategory('tts_text').length > 0 || task.ttsText) {
        fields.push({ key: '__tts__', label: '🎙️ 人声-配音文案（手动绑定）', type: 'text', category: 'tts_text' });
    }
    const overlays = task.overlays || [];
    overlays.forEach((ov, li) => {
        if (ov.fixed_text) return;
        if (ov.type === 'textcard' || !ov.type) {
            fields.push({ key: `L${li}_title_text`, label: `📝 层${li+1} 覆层标题`, type: 'text', category: 'card_title' });
            fields.push({ key: `L${li}_body_text`, label: `📝 层${li+1} 覆层内容`, type: 'text', category: 'card_body' });
            fields.push({ key: `L${li}_footer_text`, label: `📝 层${li+1} 覆层结尾`, type: 'text', category: 'card_footer' });
        } else if (ov.type === 'scroll') {
            fields.push({ key: `L${li}_scroll_title`, label: `📜 层${li+1} 滚动字幕标题`, type: 'text', category: 'scroll_title' });
            fields.push({ key: `L${li}_content`, label: `📜 层${li+1} 滚动字幕正文`, type: 'text', category: 'scroll_body' });
        } else if (ov.type === 'text') {
            fields.push({ key: `L${li}_content`, label: `📝 层${li+1} 普通文本`, type: 'text', category: 'plain_text' });
        }
    });
    fields.push({ key: '__export_name__', label: '📝 导出命名', type: 'text', category: 'export_name' });
    return fields;
}

function _bcFieldAcceptsColumn(field, col) {
    if (!field || !col || col.type !== field.type) return false;
    if (field.type !== 'media' || !field.kinds) return true;
    return field.kinds.includes(_bcColumnKind(col));
}

function _bcClearInvalidBindingsForColumn(ci) {
    const col = _bulkState.columns[ci];
    _bulkState.templates.forEach(tpl => {
        const fields = _bcFieldsFromTask(tpl.task);
        fields.forEach(f => {
            if (tpl.bindings[f.key] === ci && !_bcFieldAcceptsColumn(f, col)) {
                delete tpl.bindings[f.key];
            }
        });
    });
}

function _bcUniqueIndices(indices) {
    const out = [];
    const seen = new Set();
    indices.forEach(i => {
        if (i >= 0 && !seen.has(i)) {
            seen.add(i);
            out.push(i);
        }
    });
    return out;
}

function _bcTextColumnCandidates(names) {
    const hits = [];
    for (const name of names) {
        _bulkState.columns.forEach((c, ci) => {
            if (!c || c.type !== 'text') return;
            if (String(c.name || '').toLowerCase().includes(name)) hits.push(ci);
        });
    }
    return _bcUniqueIndices(hits);
}

function _bcPickCandidateForTemplate(candidates, templateIndex = 0) {
    if (!candidates || candidates.length === 0) return -1;
    return candidates[Math.min(Math.max(templateIndex, 0), candidates.length - 1)];
}

const BC_FIELD_CATEGORY_COLUMN_NAMES = {
    ai_source: ['人声-原文案', 'ai源文案', 'ai源', 'ai原文', '原文案', '源文案', 'ai_script', 'aiscript'],
    dynamic_subtitle: ['人声-断行文案', '断行文案', '动态字幕断行后', '断行后', '字幕断行', '字幕文本', '字幕文案', 'txtcontent', 'txt_content'],
    tts_text: ['人声-配音文案', '配音文案', 'tts文案', 'tts_text', 'ttstext', 'voice text'],
    card_title: ['文字卡片标题', '卡片标题', '覆层标题', '标题', 'title', 'headline'],
    card_body: ['文字卡片正文', '卡片正文', '覆层内容', '覆层正文', '正文', 'body'],
    card_footer: ['文字卡片结尾', '卡片结尾', '覆层结尾', '结尾', '尾标', 'footer', 'ending'],
    scroll_title: ['滚动字幕标题', '滚动标题', 'scroll_title', 'scroll title'],
    scroll_body: ['滚动字幕正文', '滚动字幕内容', '滚动正文', '滚动内容', 'scroll_body', 'scroll body'],
    plain_text: ['普通文本', '文本', 'text'],
    export_name: ['导出命名', '视频命名', '命名', '文件名', 'exportname', 'export_name', 'filename'],
};

function _bcTextColumnCandidatesForCategory(category) {
    return _bcTextColumnCandidates(BC_FIELD_CATEGORY_COLUMN_NAMES[category] || []);
}

function _bcCandidatesForField(field) {
    return _bcTextColumnCandidatesForCategory(field.category);
}

// ── Auto-bind columns by name matching ──
function _bcAutoBind(task, templateIndex = 0) {
    const bindings = {};
    const fields = _bcFieldsFromTask(task);
    const cols = _bulkState.columns;
    let plainTextOrder = 0;

    fields.forEach(f => {
        if (f.type === 'text') {
            if (['ai_source', 'dynamic_subtitle', 'tts_text'].includes(f.category)) return;
            let fallback = _bcPickCandidateForTemplate(_bcCandidatesForField(f), templateIndex);
            if (fallback < 0 && f.category === 'plain_text') {
                fallback = _bcPickCandidateForTemplate(
                    plainTextOrder++ === 0
                        ? _bcTextColumnCandidates(['标题', 'title', 'headline'])
                        : _bcTextColumnCandidates(['正文', 'body']),
                    templateIndex
                );
            }
            if (fallback >= 0 && _bcFieldAcceptsColumn(f, cols[fallback])) bindings[f.key] = fallback;
        } else {
            const ci = cols.findIndex(c => {
                if (!_bcFieldAcceptsColumn(f, c)) return false;
                const n = c.name.toLowerCase();
                const fk = f.key.replace(/^L\d+_/, '');
                return n.includes(fk) || f.label.toLowerCase().includes(n);
            });
            if (ci >= 0) bindings[f.key] = ci;
        }
    });
    return bindings;
}

function _bcEnsureTemplateBindings(tpl) {
    if (!tpl) return;
    if (!tpl.bindings || typeof tpl.bindings !== 'object') tpl.bindings = {};
    const auto = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
    for (const [key, value] of Object.entries(auto)) {
        if (tpl.bindings[key] == null) tpl.bindings[key] = value;
    }
}

function _bcFindTextColumnByNames(names) {
    for (const name of names) {
        const ci = _bulkState.columns.findIndex(c => {
            if (!c || c.type !== 'text') return false;
            return String(c.name || '').toLowerCase().includes(name);
        });
        if (ci >= 0) return ci;
    }
    return -1;
}

function _bcAutoRebindTemplate(tpl) {
    if (!tpl) return;
    tpl.bindings = _bcAutoBind(tpl.task || {}, Math.max(0, _bulkState.templates.indexOf(tpl)));
}

function _bcAutoRebindAllTemplates() {
    _bulkState.templates.forEach(_bcAutoRebindTemplate);
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcClearAllTemplateBindings() {
    _bulkState.templates.forEach(tpl => { tpl.bindings = {}; });
    _bcRenderBindings();
    _bcScheduleDraftSave();
}

function _bcTemplateProjectIdsInUse() {
    return new Set(_bulkState.templates
        .map(tpl => tpl?.source?.templateId)
        .filter(Boolean));
}

function _bcIsTemplateProjectInUse(templateId) {
    return !!templateId && _bcTemplateProjectIdsInUse().has(templateId);
}

async function _bcFetchTemplateProject(templateId) {
    if (!templateId) throw new Error('缺少模板来源 ID');
    const resp = await apiFetch(`${API_BASE}/templates/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: templateId }),
    });
    const result = await resp.json();
    const tplData = result.data || result;
    if (!tplData?.projectData?.tasks?.length) throw new Error('最新模板工程没有任务');
    return tplData;
}

function _bcRefreshTemplateFromProject(tpl, tplData) {
    const source = tpl.source || {};
    const projectData = tplData.projectData || {};
    const safeTasks = _bcDeserializeProjectTasks(projectData);
    if (!safeTasks.length) throw new Error('最新模板工程没有可用任务');

    const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
    let nextTask = null;
    let nextCycle = null;
    if (source.mode === 'unified') {
        nextTask = safeTasks[0];
        const cycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(cycle, p));
        if (cycle.length === 0) {
            safeTasks.forEach(t => _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(cycle, p)));
        }
        nextCycle = cycle.length > 1 ? cycle : null;
    } else {
        const idx = Number.isInteger(source.taskIndex) ? source.taskIndex : 0;
        nextTask = safeTasks[idx];
        if (!nextTask) throw new Error(`最新模板工程没有第 ${idx + 1} 个任务`);
        nextCycle = _bcResolveTemplateBgCycle(nextTask, projectCycle);
    }

    tpl.task = _bcCloneTemplateTask(nextTask);
    tpl.bgCycle = nextCycle;
    tpl.label = source.mode === 'unified'
        ? `${tplData.name || source.templateName || tpl.label}_统一模式`
        : (tpl.task.baseName || tpl.task.fileName || tpl.label);
    tpl.source = {
        ...source,
        templateName: tplData.name || source.templateName || '',
        refreshedAt: new Date().toISOString(),
    };
}

async function _bcReloadLoadedTemplates() {
    const sourced = _bulkState.templates
        .map((tpl, index) => ({ tpl, index }))
        .filter(x => x.tpl?.source?.type === 'template_project' && x.tpl.source.templateId);
    if (sourced.length === 0) {
        alert('当前没有可刷新的模板工程来源。请从「模版工程库」添加模板后再刷新。');
        return;
    }
    if (!confirm(`从模板库重新加载 ${sourced.length} 个已添加模板？\n\n会更新模板工程内容和自动循环素材，保留当前列绑定。`)) return;

    const cache = new Map();
    let ok = 0;
    const errors = [];
    for (const { tpl, index } of sourced) {
        const id = tpl.source.templateId;
        try {
            if (!cache.has(id)) cache.set(id, await _bcFetchTemplateProject(id));
            _bcRefreshTemplateFromProject(tpl, cache.get(id));
            ok++;
        } catch (e) {
            errors.push(`模板${index + 1}「${tpl.label || id}」: ${e.message}`);
        }
    }
    _bcRenderBindings();
    _bcScheduleDraftSave();
    const msg = `已刷新 ${ok} 个模板${errors.length ? `\n\n失败：\n${errors.join('\n')}` : ''}`;
    alert(msg);
}

function _bcBindingDebugLabel(tpl, field) {
    const ci = tpl?.bindings?.[field.key];
    if (ci == null || ci < 0) return '未绑定';
    const col = _bulkState.columns[ci];
    const sampleRow = _bulkState.rows.find(r => r && String(r[ci] || '').trim());
    const sample = sampleRow ? String(sampleRow[ci] || '').trim().slice(0, 24) : '';
    return `列${ci + 1}: ${col?.name || ''}${sample ? ` | ${sample}` : ''}`;
}

function _bcWarnDuplicateTextBindings(tpl) {
    const fields = _bcFieldsFromTask(tpl.task || {}).filter(f => f.type === 'text');
    const seen = new Map();
    const duplicates = [];
    fields.forEach(f => {
        const ci = tpl.bindings?.[f.key];
        if (ci == null || ci < 0) return;
        if (seen.has(ci)) duplicates.push([seen.get(ci), f, ci]);
        else seen.set(ci, f);
    });
    if (duplicates.length > 0) {
        console.warn('[BulkCreate] 文本字段绑定到同一列，请确认是否有意:', tpl.label, duplicates.map(([a, b, ci]) => ({
            column: `${ci + 1}:${_bulkState.columns[ci]?.name || ''}`,
            fields: [a.label, b.label],
        })));
    }
}

function _bcEnsureAllTemplateBindings() {
    _bulkState.templates.forEach(tpl => {
        _bcEnsureTemplateBindings(tpl);
        _bcWarnDuplicateTextBindings(tpl);
    });
}

function _bcWarnAllDuplicateTextBindings() {
    _bulkState.templates.forEach(_bcWarnDuplicateTextBindings);
}

// ── Render data table ──
function _bcRenderTable() {
    const el = document.getElementById('bc-table-body');
    if (!el) return;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    let hdr = '<tr><th style="width:28px;text-align:center;color:#555;">#</th>';
    cols.forEach((c, ci) => {
        hdr += `<th class="bc-col-header ${c.type === 'media' ? 'bc-media-col-header' : ''}" data-ci="${ci}" style="min-width:110px;padding:3px 5px;position:relative;">
            <div style="display:flex;align-items:center;gap:4px;">
                <select class="bc-col-kind" data-ci="${ci}" title="选择列类型" style="width:74px;background:#0a0a14;border:1px solid #333;border-radius:3px;color:#ddd;font-size:10px;padding:1px;">${_bcColumnKindOptions(c)}</select>
                <input class="bc-col-name" data-ci="${ci}" value="${_bcEsc(c.name)}" style="flex:1;background:transparent;border:none;border-bottom:1px solid #333;color:#ddd;font-size:11px;padding:1px;min-width:0;" title="右键呼出表格菜单">
            </div>
        </th>`;
    });
    hdr += '<th style="width:28px;"><button id="bc-add-col" style="background:none;border:none;color:#7c5cff;cursor:pointer;font-size:13px;" title="末尾添加列">+</button></th></tr>';
    let body = '';
    _bulkState.rows.forEach((row, ri) => {
        body += `<tr><td style="text-align:center;color:#555;font-size:10px;">${ri+1}</td>`;
        cols.forEach((c, ci) => {
            const v = row[ci] || '';
            const cls = c.type === 'media' ? 'bc-cell bc-cell-media' : 'bc-cell bc-cell-text';
            body += `<td class="bc-grid-td" data-ri="${ri}" data-ci="${ci}">
                <div class="${cls}" data-ri="${ri}" data-ci="${ci}" title="${_bcEsc(v)}">${c.type === 'media' ? _bcMediaCellHtml(v) : (v ? _bcCellPreview(v) : '<span class="bc-cell-placeholder"> </span>')}</div>
            </td>`;
        });
        body += `<td><span class="bc-row-del" data-ri="${ri}" style="cursor:pointer;color:#f44;font-size:9px;">✕</span></td></tr>`;
    });
    el.innerHTML = '<table class="bc-data-table"><thead>'+hdr+'</thead><tbody>'+body+'</tbody></table>';
    _bcUpdateSelectionUI();
    _bcScheduleDraftSave();
}

// ── Render template binding panel ──
function _bcRenderBindings() {
    const el = document.getElementById('bc-bind-panel');
    if (!el) return;
    _bcNormalizeStateShape();
    const cols = _bulkState.columns;
    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:600;color:#b8a0ff;">模板 & 列绑定</span>';
    html += '<div style="display:flex;gap:4px;"><button id="bc-clear-bindings" style="padding:3px 8px;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);border-radius:5px;color:#f88;cursor:pointer;font-size:10px;" title="清空全部模板的列绑定，避免旧草稿绑定继续生效">清空绑定</button><button id="bc-rebind-tpl" style="padding:3px 8px;background:rgba(255,200,50,0.08);border:1px solid rgba(255,200,50,0.2);border-radius:5px;color:#ffc832;cursor:pointer;font-size:10px;" title="按当前列名重新自动绑定全部模板字段">重绑</button><button id="bc-add-tpl" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">+ 添加模板</button></div></div>';
    const globalUsedFieldByCol = new Map();
    _bulkState.templates.forEach((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task || {});
        fields.forEach(f => {
            const ci = tpl.bindings?.[f.key];
            if (ci == null || ci < 0) return;
            if (!globalUsedFieldByCol.has(ci)) {
                globalUsedFieldByCol.set(ci, {
                    ti,
                    fk: f.key,
                    fieldLabel: f.label,
                    templateLabel: tpl.label || `模板${ti + 1}`,
                });
            }
        });
    });

    _bulkState.templates.forEach((tpl, ti) => {
        const task = tpl.task;
        const bgName = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop() || '无背景';
        const cycleBadge = tpl.bgCycle && tpl.bgCycle.length > 0
            ? `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(16,185,129,0.2);color:#10b981;border:1px solid rgba(16,185,129,0.3);padding:1px 4px;border-radius:4px;" title="已自动读取当前预设的 ${tpl.bgCycle.length} 个循环素材，点击查看">🔄 自动循环(${tpl.bgCycle.length})</span>`
            : `<span class="bc-tpl-bgcycle" data-ti="${ti}" style="cursor:pointer;font-size:9px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);color:#777;padding:1px 4px;border-radius:4px;" title="没有从该模板工程读取到多个背景素材，点击可手动补充">单背景</span>`;
        const fields = _bcFieldsFromTask(task);
        html += `<div style="background:rgba(255,255,255,0.03);border:1px solid #2a2a3a;border-radius:8px;padding:8px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;">
                <div style="width:36px;height:48px;border-radius:4px;background:#000;border:1px solid #333;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
                    <div id="bc-bind-thumb-loader-${ti}" style="font-size:10px;color:#666;text-align:center;">...</div>
                    <img id="bc-bind-thumb-${ti}" src="" style="width:100%;height:100%;object-fit:cover;display:none;position:absolute;top:0;left:0;" />
                </div>
                <div style="flex:1;overflow:hidden;min-width:0;">
                    <div style="color:#eee;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${_bcEsc(tpl.label)}
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
                        <span style="color:#666;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:120px;" title="${_bcEsc(task.bgPath || task.videoPath || '')}">bg: ${_bcEsc(bgName)}</span>
                        ${cycleBadge}
                    </div>
                </div>
                <span class="bc-tpl-del" data-ti="${ti}" style="cursor:pointer;color:#f44;font-size:11px;margin-left:6px;flex-shrink:0;" title="移除此模板">✕</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr;gap:3px;">`;
        fields.forEach(f => {
            const bound = tpl.bindings[f.key];
            // 计算"不绑定"时的默认值提示
            let unboundLabel = '(不绑定)';
            if (f.key === '__bg__') {
                const bg = (task.bgPath || task.videoPath || '').split(/[/\\]/).pop();
                unboundLabel = bg ? `✅ 模板原始: ${bg.slice(0, 20)}` : '(不绑定 · 无背景)';
            } else if (f.key === '__audio__') {
                const au = (task.audioPath || '').split(/[/\\]/).pop();
                unboundLabel = au ? `✅ 模板原始: ${au.slice(0, 20)}` : '(不绑定)';
            } else if (f.key.startsWith('L') || ['title_text','body_text','footer_text'].includes(f.key)) {
                unboundLabel = '(不绑定 · 用模板默认)';
            }
            html += `<div style="display:flex;align-items:center;gap:3px;font-size:10px;color:#aaa;">
                <span style="white-space:nowrap;">${f.label}</span>
                <select class="bc-bind-sel" data-ti="${ti}" data-fk="${f.key}" title="${_bcEsc(_bcBindingDebugLabel(tpl, f))}" style="flex:1;background:#0a0a14;border:1px solid #222;border-radius:3px;color:#ccc;font-size:10px;padding:1px;">
                    <option value="-1">${_bcEsc(unboundLabel)}</option>
                    ${cols.map((c,ci)=>{
                        if (!_bcFieldAcceptsColumn(f,c)) return '';
                        const usedBy = globalUsedFieldByCol.get(ci);
                        const usedByOther = usedBy && !(usedBy.ti === ti && usedBy.fk === f.key) && bound !== ci;
                        const usedLabel = usedByOther ? ` · 已绑定：${usedBy.templateLabel} / ${usedBy.fieldLabel}` : '';
                        return `<option value="${ci}" ${bound===ci?'selected':''} ${usedByOther?'disabled':''}>${_bcEsc(_bcColumnKindOptionsLabel(c))} ${_bcEsc(c.name)}${_bcEsc(usedLabel)}</option>`;
                    }).join('')}
                </select></div>`;
        });
        html += '</div></div>';
    });

    // Stats
    const rc = _bulkState.rows.filter(r=>r.some(c=>(c||'').trim())).length;
    const tc = _bulkState.templates.length || 1;
    html += `<div style="margin-top:8px;padding:6px;background:rgba(124,92,255,0.1);border-radius:6px;font-size:11px;color:#b8a0ff;text-align:center;">
        ${rc} 行 × ${_bulkState.templates.length} 模板 = <strong>${rc*tc} 个任务</strong></div>`;
    el.innerHTML = html;

    // Asynchronously render thumbnails
    _bulkState.templates.forEach((tpl, ti) => {
        const task = tpl.task;
        if (typeof PresetThumbRenderer !== 'undefined' && task.overlays && task.overlays.length > 0) {
            _bcRenderTemplateThumb(task.overlays).then(dataUrl => {
                const img = document.getElementById(`bc-bind-thumb-${ti}`);
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (img && loader && dataUrl) {
                    img.src = dataUrl;
                    img.style.display = 'block';
                    loader.style.display = 'none';
                } else if (loader) {
                    loader.innerText = '暂无';
                }
            }).catch(e => {
                const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
                if (loader) loader.innerText = '错误';
            });
        } else {
            const loader = document.getElementById(`bc-bind-thumb-loader-${ti}`);
            if (loader) loader.innerText = '无覆层';
        }
    });
    _bcScheduleDraftSave();
}

// ── Pick templates: show source chooser ──
function _bcPickTemplates() {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:380px;padding:24px;text-align:center;">
        <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:16px;">选择模板来源</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button id="bc-src-project" style="padding:12px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">📦 模版工程库<br><span style="font-size:10px;font-weight:normal;opacity:0.8;">从已保存的 .json 工程文件读取完整任务</span></button>
            <button id="bc-src-preset" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #444;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">🎨 覆层预设库<br><span style="font-size:10px;opacity:0.6;">从覆层样式预设中选取（仅覆层）</span></button>
            <button id="bc-src-tasks" style="padding:12px;background:rgba(255,255,255,0.08);border:1px solid #333;border-radius:8px;color:#ccc;cursor:pointer;font-size:13px;">📋 当前任务<br><span style="font-size:10px;opacity:0.6;">使用当前标签页的任务作为模板</span></button>
            <button id="bc-src-cancel" style="padding:8px;background:transparent;border:1px solid #333;border-radius:8px;color:#888;cursor:pointer;font-size:11px;">取消</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-src-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-src-project').onclick = () => { modal.remove(); _bcPickFromProjectLib(); };
    modal.querySelector('#bc-src-preset').onclick = () => { modal.remove(); _bcPickFromOverlayPresets(); };
    modal.querySelector('#bc-src-tasks').onclick = () => { modal.remove(); _bcPickFromCurrentTasks(); };
}

// ══════════ 1. 模版工程库 — 从磁盘 .json 工程文件读取 ══════════
// ══════════ 1. 模版工程库 — 直接调用完整的视频模板库 ══════════
async function _bcPickFromProjectLib() {
    if (typeof openTemplateLibrary === 'function') {
        const disabledIds = Array.from(_bcTemplateProjectIdsInUse());
        openTemplateLibrary((tplData) => {
            const tplId = tplData.id || tplData.templateId || '';
            if (_bcIsTemplateProjectInUse(tplId)) {
                alert(`模板工程「${tplData.name || tplId}」已经添加过，不能重复添加。`);
                return;
            }
            const projectData = tplData.projectData;
            if (!projectData || !projectData.tasks || projectData.tasks.length === 0) {
                alert('该模板不包含任何任务，无法导入为批量模板。');
                return;
            }
            
            // 不关闭模态框，允许用户继续选择其他模板
            // const modal = document.getElementById('template-library-modal');
            // if (modal) modal.style.display = 'none';

            // 把这个模板里的任务交给 _bcShowProjectTaskPicker 去选择
            // 或者，如果只有一个任务，直接添加？
            // 默认让用户选择哪个任务作为模版，保持和之前一样的灵活度
            const projName = tplData.name || '已选模板';
            const projectCycle = _bcCollectProjectBackgroundCycle(projectData);
            const projectSource = {
                type: 'template_project',
                templateId: tplId,
                templateName: projName,
            };
            
            if (projectData.tasks.length === 1) {
                // 如果只有一个任务，直接添加，跳过选择界面
                _bcAppendTemplates(projectData.tasks, projName, projectCycle, projectSource);
            } else {
                _bcShowProjectTaskPicker(projName, projectData.tasks, projectCycle, projectSource);
            }
        }, { disabledIds });
    } else {
        alert('未加载模板库模块 (openTemplateLibrary 未定义)');
    }
}

// Helper to append templates
function _bcAppendTemplates(tasksList, projName, projectCycle = null, projectSource = null) {
    if (!tasksList || tasksList.length === 0) return;
    
    // Safely deserialize tasks first if applyProjectData is available
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks: tasksList });

    safeTasks.forEach((t, idx) => {
        const clone = _bcCloneTemplateTask(t);
        const templateIndex = _bulkState.templates.length;
        const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
        _bulkState.templates.push({
            task: clone,
            label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle,
            source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex: idx } : null,
        });
    });
    
    if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
    if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
}

function _bcShowProjectTaskPicker(projName, tasks, projectCycle = null, projectSource = null) {
    // Safely deserialize tasks first if applyProjectData is available (so thumbnails work and we save real objects)
    let safeTasks = _bcDeserializeProjectTasks({ version: '2.0.0', tasks });

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:1000000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';

    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:12px;width:85%;max-width:900px;height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);overflow:hidden;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
            <span style="color:#fff;font-weight:600;font-size:14px;">📦 ${_bcEsc(projName)} — 选择任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-proj-unified" style="padding:4px 12px;background:rgba(16,185,129,0.2);border:1px solid rgba(16,185,129,0.3);border-radius:5px;color:#10b981;cursor:pointer;font-size:11px;" title="仅使用该工程的第一个任务作为统一模版导入，忽略多任务拆分">✨ 作为统一模板导入</button>
                <div style="width:1px;background:#333;margin:0 4px;"></div>
                <button id="bc-proj-all" style="padding:4px 12px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-proj-none" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
                <button id="bc-proj-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">✓ 确定所选</button>
                <button id="bc-proj-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div id="bc-proj-grid" style="overflow:auto;flex:1;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start;"></div>
    </div>`;
    document.body.appendChild(modal);

    const grid = modal.querySelector('#bc-proj-grid');

    // Unified mode
    modal.querySelector('#bc-proj-unified').onclick = () => {
        modal.remove();
        
        // 统一模板代表整个工程，因此使用该工程素材库；没有素材库时再从工程任务中收集。
        const bgCycle = [];
        (projectCycle || []).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
        if (bgCycle.length === 0) {
            safeTasks.forEach(t => {
                _bcCollectTaskBackgroundCycle(t).forEach(p => _bcAddUniqueCyclePath(bgCycle, p));
            });
        }

        const t0 = safeTasks[0];
        if (!t0) return;
        const clone = _bcCloneTemplateTask(t0);
        const templateIndex = _bulkState.templates.length;
        
        _bulkState.templates.push({
            task: clone,
            label: `${projName}_统一模式`,
            bindings: typeof _bcAutoBind === 'function' ? _bcAutoBind(clone, templateIndex) : {},
            bgCycle: bgCycle.length > 1 ? bgCycle : null,
            source: projectSource?.templateId ? { ...projectSource, mode: 'unified' } : null,
        });
        
        if (typeof _bcRenderBindings === 'function') _bcRenderBindings();
        if (typeof _bcUpdateStats === 'function') _bcUpdateStats();
    };

    // Build cards
    safeTasks.forEach((t, i) => {
        const bg = (t.bgPath || t.videoPath || '').split(/[/\\]/).pop() || '';
        const ovCount = (t.overlays || []).length;
        const name = t.baseName || t.fileName || `task_${i + 1}`;

        const card = document.createElement('div');
        card.style.cssText = 'background:#0d0d1a;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s;';
        card.dataset.idx = i;
        card.dataset.selected = 'true';
        card.classList.add('bc-proj-card');

        card.innerHTML = `
            <div class="bc-proj-thumb" style="width:100%;aspect-ratio:9/16;background:#141424;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
                <div style="color:#555;font-size:10px;">加载中...</div>
                <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>
            </div>
            <div style="padding:8px;">
                <div style="color:#eee;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${_bcEsc(name)}">${_bcEsc(name)}</div>
                <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                    <span style="font-size:9px;padding:1px 5px;background:rgba(124,92,255,0.15);border-radius:3px;color:#b8a0ff;">${ovCount} 层</span>
                    ${bg ? `<span style="font-size:9px;padding:1px 5px;background:rgba(0,212,255,0.1);border-radius:3px;color:#7dd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100px;" title="${_bcEsc(bg)}">${_bcEsc(bg)}</span>` : ''}
                </div>
            </div>`;

        // Toggle selection
        card.onclick = () => {
            const sel = card.dataset.selected === 'true';
            card.dataset.selected = sel ? 'false' : 'true';
            card.style.borderColor = sel ? '#333' : '#7c5cff';
            card.style.boxShadow = sel ? 'none' : '0 0 0 1px rgba(124,92,255,0.4)';
            const check = card.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = sel ? 'none' : 'flex';
        };
        // Init as selected
        card.style.borderColor = '#7c5cff';
        card.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';

        grid.appendChild(card);

        // Render thumbnail async
        if (ovCount > 0 && typeof PresetThumbRenderer !== 'undefined') {
            try {
                _bcRenderTemplateThumb(t.overlays).then(url => {
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (url && thumbEl) {
                        thumbEl.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;">
                            <div style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:4px;background:rgba(124,92,255,0.9);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;">✓</div>`;
                    } else if (thumbEl) {
                        thumbEl.querySelector('div').textContent = '预览生成失败';
                    }
                }).catch(e => {
                    console.error('[BulkCreate] Thumbnail render error:', e);
                    const thumbEl = card.querySelector('.bc-proj-thumb');
                    if (thumbEl) thumbEl.querySelector('div').textContent = '渲染错误';
                });
            } catch(e) {
                console.error('[BulkCreate] Thumbnail init error:', e);
                const thumbEl = card.querySelector('.bc-proj-thumb');
                if (thumbEl) thumbEl.querySelector('div').textContent = '组件错误';
            }
        } else {
            const thumbEl = card.querySelector('.bc-proj-thumb');
            if (thumbEl) thumbEl.querySelector('div').textContent = bg ? `🎬 ${bg}` : '无覆层';
        }
    });

    // Buttons
    modal.querySelector('#bc-proj-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-proj-all').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'true';
            c.style.borderColor = '#7c5cff';
            c.style.boxShadow = '0 0 0 1px rgba(124,92,255,0.4)';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'flex';
        });
    };
    modal.querySelector('#bc-proj-none').onclick = () => {
        modal.querySelectorAll('.bc-proj-card').forEach(c => {
            c.dataset.selected = 'false';
            c.style.borderColor = '#333';
            c.style.boxShadow = 'none';
            const check = c.querySelector('div[style*="position:absolute"]');
            if (check) check.style.display = 'none';
        });
    };
    modal.querySelector('#bc-proj-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-proj-card[data-selected="true"]'));
        if (selected.length === 0) { alert('请至少选择一个任务'); return; }

        selected.forEach(card => {
            const t = safeTasks[parseInt(card.dataset.idx)];
            if (!t) return;
            const taskIndex = parseInt(card.dataset.idx);
            const clone = _bcCloneTemplateTask(t);
            const templateIndex = _bulkState.templates.length;
            const bgCycle = _bcResolveTemplateBgCycle(clone, projectCycle);
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `${projName}_模板${_bulkState.templates.length + 1}`,
                bindings: _bcAutoBind(clone, templateIndex),
                bgCycle,
                source: projectSource?.templateId ? { ...projectSource, mode: 'task', taskIndex } : null,
            });
        });
        modal.remove();
        _bcRenderBindings();
    };
}


// ══════════ 2. 覆层预设库 ══════════
function _bcPickFromOverlayPresets() {
    const state = window._reelsState;
    const panel = state?.overlayPanel;
    if (panel && typeof panel._showPresetGallery === 'function') {
        panel._showPresetGallery((name, data, mode) => {
            _bcAddPresetAsTemplate(name, data);
        }, true);
    } else {
        _bcPickFromPresetsDirectly();
    }
}

function _bcPickFromPresetsDirectly() {
    let presets = {};
    try { presets = JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}'); } catch(e) {}
    if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
        for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
            if (!presets[k]) presets[k] = v;
        }
    }
    const names = Object.keys(presets);
    if (names.length === 0) { alert('覆层预设库为空'); return; }

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = names.map(n => {
        const d = presets[n];
        const layers = Array.isArray(d) ? d : (d.layers || []);
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;"><div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
            <div style="color:#666;font-size:10px;">${layers.length} 层</div></div>
            <button class="bc-gallery-pick" data-name="${_bcEsc(n)}" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:4px;color:#b8a0ff;cursor:pointer;font-size:10px;">选用</button>
        </div>`;
    }).join('');
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">🎨 覆层预设库</span>
            <button class="bc-gallery-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-gallery-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
        if (e.target.classList.contains('bc-gallery-pick')) {
            const name = e.target.dataset.name;
            _bcAddPresetAsTemplate(name, presets[name]);
            modal.remove();
        }
    });
}

function _bcAddPresetAsTemplate(name, data) {
    const layers = Array.isArray(data) ? data : (data.layers || []);
    const task = {
        baseName: name,
        fileName: `${name}.mp4`,
        bgPath: null, bgSrcUrl: null,
        audioPath: null, srtPath: null,
        segments: [],
        videoPath: null, srcUrl: null,
        overlays: JSON.parse(JSON.stringify(layers)),
        ttsText: '', ttsVoiceId: '', pipPath: '', status: '',
    };
    _bulkState.templates.push({
        task,
        label: name,
        bindings: _bcAutoBind(task, _bulkState.templates.length),
    });
    _bcRenderBindings();
}

// ── Pick from current tasks ──
function _bcPickFromCurrentTasks() {
    const state = window._reelsState;
    if (!state || !state.tasks || state.tasks.length === 0) { alert('当前没有任务可作为模板'); return; }
    const tasks = state.tasks;
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    tasks.forEach((t,i) => {
        const bg = (t.bgPath||t.videoPath||'').split(/[/\\]/).pop()||'无';
        const ovCount = (t.overlays||[]).length;
        list += `<label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-pick-cb" data-idx="${i}">
            <span style="color:#ccc;font-size:12px;">${i+1}. ${_bcEsc(t.baseName||t.fileName||'task')}</span>
            <span style="color:#666;font-size:10px;">bg:${_bcEsc(bg)} | ${ovCount}层</span>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:500px;max-height:70vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">选择工程任务作为模板</span>
            <div style="display:flex;gap:6px;">
                <button id="bc-pick-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button id="bc-pick-ok" style="padding:3px 14px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">确定</button>
                <button id="bc-pick-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#bc-pick-cancel').onclick = () => modal.remove();
    modal.querySelector('#bc-pick-all').onclick = () => modal.querySelectorAll('.bc-pick-cb').forEach(cb => cb.checked = true);
    modal.querySelector('#bc-pick-ok').onclick = () => {
        const checked = Array.from(modal.querySelectorAll('.bc-pick-cb:checked'));
        checked.forEach(cb => {
            const idx = parseInt(cb.dataset.idx);
            const t = tasks[idx];
            if (!t) return;
            const clone = JSON.parse(JSON.stringify(t));
            delete clone._video; delete clone._bgThumb;
            if (clone.bgSrcUrl && String(clone.bgSrcUrl).startsWith('blob:')) clone.bgSrcUrl = null;
            if (clone.srcUrl && String(clone.srcUrl).startsWith('blob:')) clone.srcUrl = null;
            const templateIndex = _bulkState.templates.length;
            _bulkState.templates.push({
                task: clone,
                label: clone.baseName || clone.fileName || `模板${_bulkState.templates.length+1}`,
                bindings: _bcAutoBind(clone, templateIndex),
            });
        });
        modal.remove();
        _bcRenderBindings();
    };
}

function _bcRowHasBoundData(tpl, row) {
    let hasData = false;
    let hasBindings = false;
    for (const key of Object.keys(tpl.bindings || {})) {
        const ci = tpl.bindings[key];
        if (ci != null && ci >= 0) {
            hasBindings = true;
            if ((row[ci] || '').trim() !== '') {
                hasData = true;
                break;
            }
        }
    }
    return !hasBindings || hasData;
}

function _bcBuildTasksForTemplate(tpl, rows, cols, startTaskNum) {
    const tasks = [];
    rows.forEach((row, ri) => {
        if (!_bcRowHasBoundData(tpl, row)) return;
        const task = _bcBuildTask(tpl, row, ri, startTaskNum + tasks.length, cols);
        tasks.push(task);
    });
    return tasks;
}

// ── Generate tasks ──
function _bcGenerateTasks() {
    const state = window._reelsState;
    if (!state) { alert('系统未初始化'); return 0; }
    const cols = _bulkState.columns;
    const rows = _bulkState.rows.filter(r => r.some(c => (c||'').trim()));
    if (rows.length === 0) { alert('数据表格为空'); return 0; }
    if (_bulkState.templates.length === 0) { alert('请先添加模板'); return 0; }

    const total = rows.length * _bulkState.templates.length;

    // Ask grouping mode only if multiple templates
    let separateTabs = false;
    if (_bulkState.templates.length > 1) {
        separateTabs = confirm(
            `将生成 ${total} 个任务（${rows.length}行 × ${_bulkState.templates.length}模板）\n\n` +
            `选择生成方式：\n\n` +
            `确定 = 每个模板单独一个标签页（导出时自动分文件夹）\n` +
            `取消 = 全部放入当前标签页`
        );
    }

    _bcWarnAllDuplicateTextBindings();

    // ═══ 生成前绑定摘要 ═══
    console.log('═══ [BulkCreate] 生成前绑定摘要 ═══');
    const bindingSummaries = _bulkState.templates.map((tpl, ti) => {
        const fields = _bcFieldsFromTask(tpl.task);
        const summary = {};
        fields.forEach(f => {
            const ci = tpl.bindings[f.key];
            if (ci != null && ci >= 0 && ci < cols.length) {
                summary[f.label] = `col[${ci}]「${cols[ci]?.name}」`;
            }
        });
        console.log(`  模板[${ti}]「${tpl.label}」:`, JSON.stringify(summary, null, 2));
        return JSON.stringify(tpl.bindings);
    });
    // 检测是否有模板共享相同绑定
    const uniqueBindings = new Set(bindingSummaries);
    if (uniqueBindings.size < _bulkState.templates.length) {
        console.warn('[BulkCreate] ⚠️ 有多个模板使用了完全相同的列绑定！这将导致各标签页文案一致。');
    }

    // ═══ 统一生成循环：row × template ═══
    // 不管分不分标签页，生成逻辑完全一致
    // 按模板分组收集任务
    const tasksByTemplate = _bulkState.templates.map(() => []);
    let globalTaskNum = 0;

    rows.forEach((row, ri) => {
        _bulkState.templates.forEach((tpl, ti) => {
            if (!_bcRowHasBoundData(tpl, row)) return;
            globalTaskNum++;
            const presetRowIdx = tasksByTemplate[ti].length;
            const task = _bcBuildTask(tpl, row, presetRowIdx, globalTaskNum, cols);
            tasksByTemplate[ti].push(task);
        });
    });

    const created = tasksByTemplate.reduce((s, arr) => s + arr.length, 0);
    if (created === 0) return 0;

    // ═══ 输出：根据模式放到不同容器 ═══
    if (separateTabs && typeof _batchTableState !== 'undefined') {
        // 分标签页模式：每个模板的任务放到独立标签
        if (typeof _syncTasksToActiveTab === 'function') _syncTasksToActiveTab();

        const newTabs = [];
        _bulkState.templates.forEach((tpl, ti) => {
            const tasks = tasksByTemplate[ti];
            if (tasks.length === 0) return;
            const tabId = 'tab_' + _batchTableState.nextTabId++;
            const tabName = `批量-${tpl.label}`;
            const clonedTasks = typeof _cloneBatchTasks === 'function'
                ? _cloneBatchTasks(tasks)
                : JSON.parse(JSON.stringify(tasks));
            const newTab = {
                id: tabId,
                name: tabName,
                materialDir: '',
                lastRefreshTime: null,
                tasks: clonedTasks,
            };
            _batchTableState.tabs.push(newTab);
            newTabs.push(newTab);
        });

        // Switch to the first generated tab
        const firstNewTab = newTabs[0];
        if (firstNewTab) {
            if (typeof _switchToTab === 'function') {
                _switchToTab(firstNewTab.id, { skipSave: true, skipNextApply: true, skipNextAutoSave: true });
            } else {
                _batchTableState.activeTabId = firstNewTab.id;
                state.tasks = typeof _cloneBatchTasks === 'function'
                    ? _cloneBatchTasks(firstNewTab.tasks || [])
                    : JSON.parse(JSON.stringify(firstNewTab.tasks || []));
                state.selectedIdx = -1;
            }
        }

        // ═══ 验证：检查每个标签页存储的数据是否独立 ═══
        console.log('═══ [BulkCreate] 分标签页验证 ═══');
        newTabs.forEach((tab, i) => {
            const t0 = tab.tasks[0];
            const ov = t0 && t0.overlays && t0.overlays[0];
            console.log(`  标签[${i}]「${tab.name}」(${tab.tasks.length}条): title="${(ov?.title_text||'').slice(0,30)}", body="${(ov?.body_text||'').slice(0,30)}"`);
        });
        console.log(`  当前 state.tasks[0]: title="${(state.tasks[0]?.overlays?.[0]?.title_text||'').slice(0,30)}"`);
        console.log('═══ 验证结束 ═══');
    } else {
        // 单标签模式：全部放入当前标签
        state.tasks.length = 0;
        const allTasks = tasksByTemplate.flat();
        allTasks.forEach(task => state.tasks.push(task));
    }

    return created;
}

function _bcBuildTask(tpl, row, rowIdx, taskNum, cols) {
    const task = JSON.parse(JSON.stringify(tpl.task));
    const prefix = _bulkState.templates.length > 1 ? `${tpl.label}_` : 'bulk_';
    task.baseName = `${prefix}${String(taskNum).padStart(3, '0')}`;
    task.fileName = task.baseName + '.mp4';
    task.status = ''; task.bgSrcUrl = null; task.srcUrl = null;
    task.ttsText = '';
    task.txtContent = '';
    task.aiScript = '';

    // Automatic Background Cycling (Unified Mode)
    // If we have a bgCycle array and the user hasn't explicitly mapped a background column
    let hasBgColumnBound = false;
    if (tpl.bindings['__bg__'] != null && tpl.bindings['__bg__'] >= 0 && row[tpl.bindings['__bg__']]) {
        hasBgColumnBound = true;
    }
    
    if (!hasBgColumnBound && tpl.bgCycle && tpl.bgCycle.length > 0) {
        const cycleBg = tpl.bgCycle[rowIdx % tpl.bgCycle.length];
        _bcApplySingleBackground(task, cycleBg);
    }

    // 诊断：确认背景路径
    if (rowIdx === 0) {
        console.log(`[BulkCreate] 模板「${tpl.label}」背景诊断: bgPath="${(task.bgPath||'').split(/[/\\]/).pop()}", videoPath="${(task.videoPath||'').split(/[/\\]/).pop()}", bgCycle=${tpl.bgCycle ? tpl.bgCycle.length + '个' : '无'}, bgBound=${hasBgColumnBound}`);
    }

    const fields = _bcFieldsFromTask(tpl.task);
    console.log(`[BulkCreate] 模板「${tpl.label}」row#${rowIdx} bindings:`, JSON.stringify(tpl.bindings));
    const setOverlayText = (ov, key, value) => {
        if (!ov) return;
        ov[key] = value;
        if (key === 'title_text') ov.title_styled_ranges = null;
        else if (key === 'body_text') ov.body_styled_ranges = null;
        else if (key === 'footer_text') ov.footer_styled_ranges = null;
        else if (key === 'scroll_title') ov.scroll_title_styled_ranges = null;
        else if (key === 'content') {
            ov.scroll_styled_ranges = null;
            ov.styled_ranges = null;
        }
    };

    for (const f of fields) {
        const ci = tpl.bindings[f.key];
        if (ci == null || ci < 0 || ci >= cols.length) continue;
        if (!_bcFieldAcceptsColumn(f, cols[ci])) continue;
        const val = (row[ci] || '').trim();
        console.log(`  [${f.key}] → col[${ci}]「${cols[ci]?.name}」= "${val.slice(0, 30)}"`);
        if (!val) continue;

        if (f.key === '__bg__') { _bcApplySingleBackground(task, val); }
        else if (f.key === '__audio__') { task.audioPath = val; }
        else if (f.key === '__srt__') { task.srtPath = val; }
        else if (f.key === '__cv__') { task.contentVideoPath = val; }
        else if (f.key === '__ai__') { task.aiScript = val; }
        else if (f.key === '__txt__') { task.txtContent = val; }
        else if (f.key === '__tts__') { task.ttsText = val; }
        else if (f.key === '__export_name__') { task.exportName = val; }
        else if (f.key.startsWith('L')) {
            const m = f.key.match(/^L(\d+)_(.+)$/);
            if (m && task.overlays && task.overlays[parseInt(m[1])]) {
                setOverlayText(task.overlays[parseInt(m[1])], m[2], val);
            }
        } else if (['title_text', 'body_text', 'footer_text'].includes(f.key)) {
            if (task.overlays && task.overlays[0]) setOverlayText(task.overlays[0], f.key, val);
        }
    }
    return task;
}

// ── Preset save/load ──
const BC_PRESETS_KEY = 'reels_bulk_create_presets';

function _bcGetSavedPresets() {
    try { return JSON.parse(localStorage.getItem(BC_PRESETS_KEY) || '{}'); } catch(e) { return {}; }
}

async function _bcSavePreset() {
    const name = await _bcPrompt('输入大量制作模版名称', '例如：FB批量配置');
    if (!name || !name.trim()) return;
    const presets = _bcGetSavedPresets();
    presets[name.trim()] = {
        columns: JSON.parse(JSON.stringify(_bulkState.columns)),
        templates: _bulkState.templates.map(t => ({
            task: t.task,
            label: t.label,
            bindings: { ...t.bindings },
            bgCycle: t.bgCycle || null,
            source: t.source || null,
        })),
        savedAt: new Date().toISOString(),
    };
    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
    alert(`✅ 大量制作模版「${name.trim()}」已保存`);
}

function _bcLoadPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版'); return; }
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const colCount = (p.columns||[]).length;
        const tplCount = (p.templates||[]).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        list += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #222;">
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${colCount}列 · ${tplCount}模板 · ${date}</div>
            </div>
            <div style="display:flex;gap:4px;">
                <button class="bc-preset-load" data-name="${_bcEsc(n)}" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:4px;color:#b8a0ff;cursor:pointer;font-size:10px;">加载</button>
                <button class="bc-preset-del" data-name="${_bcEsc(n)}" style="padding:3px 8px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);border-radius:4px;color:#f88;cursor:pointer;font-size:10px;">删除</button>
            </div>
        </div>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:420px;max-height:60vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">📂 大量制作模版库</span>
            <button class="bc-preset-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.bc-preset-close').onclick = () => modal.remove();
    modal.addEventListener('click', e => {
        const t = e.target;
        if (t.classList.contains('bc-preset-load')) {
            const name = t.dataset.name;
            const p = presets[name];
            if (!p) return;
            _bulkState.columns = JSON.parse(JSON.stringify(p.columns || []));
            _bulkState.templates = (p.templates || []).map(t => ({ task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null }));
            // Keep existing rows but pad/trim to match new column count
            _bulkState.rows.forEach(r => {
                while (r.length < _bulkState.columns.length) r.push('');
                if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
            });
            if (_bulkState.rows.length === 0) {
                for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            }
            modal.remove();
            _bcRenderTable(); _bcRenderBindings();
            return;
        }
        if (t.classList.contains('bc-preset-del')) {
            const name = t.dataset.name;
            if (!confirm(`删除模版「${name}」？`)) return;
            delete presets[name];
            localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(presets));
            t.closest('div[style*="border-bottom"]').remove();
            return;
        }
    });
}

function _bcExportPreset() {
    const presets = _bcGetSavedPresets();
    const names = Object.keys(presets);
    if (names.length === 0) { alert('暂无保存的大量制作模版可导出'); return; }

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
    let list = '';
    names.forEach(n => {
        const p = presets[n];
        const tplCount = (p.templates || []).length;
        const colCount = (p.columns || []).length;
        const date = p.savedAt ? new Date(p.savedAt).toLocaleDateString() : '';
        list += `<label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #222;cursor:pointer;">
            <input type="checkbox" class="bc-export-cb" data-name="${_bcEsc(n)}" checked>
            <div style="flex:1;">
                <div style="color:#eee;font-size:12px;font-weight:600;">${_bcEsc(n)}</div>
                <div style="color:#666;font-size:10px;">${colCount}列 · ${tplCount}模板 · ${date}</div>
            </div>
        </label>`;
    });
    modal.innerHTML = `<div style="background:#1a1a2e;border:1px solid #333;border-radius:10px;width:440px;max-height:65vh;display:flex;flex-direction:column;">
        <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span style="color:#fff;font-weight:600;">⬆ 选择要导出的模版</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-all" style="padding:3px 10px;background:rgba(124,92,255,0.2);border:1px solid rgba(124,92,255,0.3);border-radius:5px;color:#b8a0ff;cursor:pointer;font-size:11px;">全选</button>
                <button class="bc-export-none" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">全不选</button>
            </div>
        </div>
        <div style="overflow:auto;flex:1;">${list}</div>
        <div style="padding:10px 16px;border-top:1px solid #333;display:flex;justify-content:space-between;align-items:center;">
            <span class="bc-export-count" style="color:#888;font-size:11px;">已选 ${names.length}/${names.length}</span>
            <div style="display:flex;gap:6px;">
                <button class="bc-export-ok" style="padding:5px 18px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">导出</button>
                <button class="bc-export-cancel" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
            </div>
        </div>
    </div>`;
    document.body.appendChild(modal);

    const updateCount = () => {
        const checked = modal.querySelectorAll('.bc-export-cb:checked').length;
        const total = modal.querySelectorAll('.bc-export-cb').length;
        const countEl = modal.querySelector('.bc-export-count');
        if (countEl) countEl.textContent = `已选 ${checked}/${total}`;
    };
    modal.addEventListener('change', updateCount);
    modal.querySelector('.bc-export-all').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = true); updateCount(); };
    modal.querySelector('.bc-export-none').onclick = () => { modal.querySelectorAll('.bc-export-cb').forEach(cb => cb.checked = false); updateCount(); };
    modal.querySelector('.bc-export-cancel').onclick = () => modal.remove();
    modal.querySelector('.bc-export-ok').onclick = () => {
        const selected = Array.from(modal.querySelectorAll('.bc-export-cb:checked')).map(cb => cb.dataset.name);
        if (selected.length === 0) { alert('请至少选择一个模版'); return; }
        const exportData = {};
        selected.forEach(name => { if (presets[name]) exportData[name] = presets[name]; });
        const data = {
            type: 'bulk_create_preset',
            version: 1,
            presets: exportData,
            exportedAt: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `bulk_presets_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        modal.remove();
    };
}

function _bcImportPreset() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.type !== 'bulk_create_preset') { alert('不是有效的大量制作模版文件'); return; }

                // New multi-preset format: merge into preset library
                if (data.presets && typeof data.presets === 'object') {
                    const existing = _bcGetSavedPresets();
                    const importNames = Object.keys(data.presets);
                    let added = 0, updated = 0;
                    for (const [name, preset] of Object.entries(data.presets)) {
                        if (existing[name]) updated++;
                        else added++;
                        existing[name] = preset;
                    }
                    localStorage.setItem(BC_PRESETS_KEY, JSON.stringify(existing));
                    alert(`✅ 已导入 ${importNames.length} 个模版到库中（新增 ${added}，覆盖 ${updated}）`);
                    return;
                }

                // Legacy single-preset format: load directly into current state
                if (!data.columns) { alert('不是有效的大量制作模版文件'); return; }
                _bulkState.columns = data.columns;
                _bulkState.templates = (data.templates || []).map(t => ({ task: t.task, label: t.label, bindings: { ...t.bindings }, bgCycle: t.bgCycle || null, source: t.source || null }));
                _bulkState.rows.forEach(r => {
                    while (r.length < _bulkState.columns.length) r.push('');
                    if (r.length > _bulkState.columns.length) r.length = _bulkState.columns.length;
                });
                if (_bulkState.rows.length === 0) {
                    for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                }
                _bcRenderTable(); _bcRenderBindings();
                alert(`✅ 已导入：${_bulkState.columns.length}列 · ${_bulkState.templates.length}模板`);
            } catch(err) { alert('导入失败：' + err.message); }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── Main Modal ──
function _showBulkCreateModal() {
    const existing = document.getElementById('bc-modal');
    if (_bcModalAbort) {
        _bcModalAbort.abort();
        _bcModalAbort = null;
    }
    if (existing) existing.remove();
    _bcLoadDraftOnce();
    if (_bulkState.rows.length === 0) {
        for (let i = 0; i < 20; i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
    }
    _bcNormalizeStateShape();
    _bcModalAbort = new AbortController();
    const bcModalSignal = _bcModalAbort.signal;
    const ov = document.createElement('div');
    ov.id = 'bc-modal';
    ov.style.cssText = 'position:fixed;top:32px;left:0;right:0;bottom:0;z-index:200000;background:rgba(0,0,0,0.95);display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;isolation:isolate;border-top:1px solid #333;';
    
    let style = document.getElementById('bc-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'bc-styles';
        document.head.appendChild(style);
    }
    style.innerHTML = `
            .bc-data-table {
                width: max-content;
                min-width: 100%;
                border-collapse: separate;
                border-spacing: 0;
                table-layout: fixed;
                background: #0a0a14;
            }
            .bc-data-table th {
                position: sticky;
                top: 0;
                z-index: 2;
                background: #121222;
                border: 1px solid #252535;
                border-left: 0;
                height: 26px;
            }
            .bc-data-table td {
                border: 1px solid #222235;
                border-left: 0;
                border-top: 0;
                height: 34px;
                padding: 0;
                background: #0a0a14;
            }
            .bc-grid-td {
                min-width: 140px;
                max-width: 240px;
                position: relative;
                cursor: cell;
                user-select: none;
            }
            .bc-cell {
                height: 34px;
                line-height: 34px;
                padding: 0 6px;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
                color: #cfd0dc;
                font-size: 11px;
                box-sizing: border-box;
            }
            .bc-cell-media {
                color: #aab2c4;
                font-size: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
                line-height: 1.2;
            }
            .bc-media-thumb {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                object-fit: cover;
                border-radius: 3px;
                background: #05050a;
                border: 1px solid #333348;
                display: block;
            }
            .bc-media-icon {
                width: 26px;
                height: 26px;
                flex: 0 0 26px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                border-radius: 3px;
                background: #151526;
                border: 1px solid #333348;
                font-size: 13px;
            }
            .bc-media-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .bc-cell-placeholder {
                display: inline-block;
                width: 1px;
            }
            .bc-grid-td.bc-selected-cell {
                background-color: rgba(124,92,255,0.2) !important;
                box-shadow: inset 0 0 0 1px rgba(124,92,255,0.95) !important;
                outline: none !important;
            }
            .bc-grid-td.bc-selected-cell .bc-cell {
                background-color: rgba(124,92,255,0.18) !important;
                color: #fff !important;
            }
            .bc-grid-td.bc-anchor-cell {
                box-shadow: inset 0 0 0 2px #7c5cff !important;
                background-color: rgba(124,92,255,0.28) !important;
                z-index: 1;
            }
            .bc-grid-td.bc-anchor-cell .bc-cell {
                background-color: rgba(124,92,255,0.24) !important;
            }
            .bc-grid-td.bc-media-drop-target,
            .bc-media-col-header.bc-media-drop-target {
                background: rgba(46,213,115,0.18) !important;
                box-shadow: inset 0 0 0 2px #2ed573 !important;
            }
            .bc-grid-td.bc-media-drop-target .bc-cell {
                background: rgba(46,213,115,0.16) !important;
                color: #eafff2 !important;
            }
            .bc-media-col-header {
                cursor: copy;
            }
        `;
    ov.innerHTML = `
        <div style="padding:10px 18px;border-bottom:1px solid #2a2a3a;flex-shrink:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:18px;">🧩</span>
                    <span style="font-size:15px;font-weight:700;color:#fff;">大量制作</span>
                    <span style="font-size:11px;color:#666;">工程模板 × 数据表格 = 批量任务</span>
                </div>
                <div style="display:flex;gap:6px;">
                    <button id="bc-generate" style="padding:5px 18px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:12px;font-weight:600;">🚀 生成任务</button>
                    <button id="bc-close" style="padding:3px 10px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">关闭</button>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <span style="color:#888;font-size:10px;margin-right:2px;">数据:</span>
                <button id="bc-paste-tsv" style="padding:2px 8px;background:rgba(255,255,255,0.08);border:1px solid #333;border-radius:4px;color:#ccc;cursor:pointer;font-size:10px;">📋 粘贴TSV</button>
                <button id="bc-add-row" style="padding:2px 8px;background:rgba(255,255,255,0.08);border:1px solid #333;border-radius:4px;color:#ccc;cursor:pointer;font-size:10px;">+ 添加行</button>
                <button id="bc-clear" style="padding:2px 8px;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);border-radius:4px;color:#f88;cursor:pointer;font-size:10px;">清空</button>
                <span style="color:rgba(255,255,255,0.1);margin:0 4px;">|</span>
                <span style="color:#888;font-size:10px;margin-right:2px;">模版:</span>
                <button id="bc-save-preset" style="padding:2px 8px;background:rgba(46,213,115,0.08);border:1px solid rgba(46,213,115,0.2);border-radius:4px;color:#6fcf97;cursor:pointer;font-size:10px;">💾 保存</button>
                <button id="bc-load-preset" style="padding:2px 8px;background:rgba(255,200,50,0.08);border:1px solid rgba(255,200,50,0.2);border-radius:4px;color:#ffc832;cursor:pointer;font-size:10px;">📂 加载</button>
                <button id="bc-reload-source" style="padding:2px 8px;background:rgba(76,158,255,0.1);border:1px solid rgba(76,158,255,0.25);border-radius:4px;color:#8fc7ff;cursor:pointer;font-size:10px;" title="重新读取已添加模板对应的最新模板工程，保留当前列绑定">🔄 刷新工程</button>
                <button id="bc-export-preset" style="padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:4px;color:#aaa;cursor:pointer;font-size:10px;">⬆ 导出</button>
                <button id="bc-import-preset" style="padding:2px 8px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:4px;color:#aaa;cursor:pointer;font-size:10px;">⬇ 导入</button>
            </div>
        </div>
        <div style="display:flex;flex:1;overflow:hidden;">
            <div style="flex:2;overflow:auto;padding:10px;border-right:1px solid #2a2a3a;outline:none;" id="bc-table-body" tabindex="0"></div>
            <div style="flex:1;overflow:auto;padding:10px;min-width:300px;" id="bc-bind-panel"></div>
        </div>`;
    document.body.appendChild(ov);
    _bcRenderTable();
    _bcRenderBindings();
    const _bcCloseModal = () => {
        _bcSaveDraftNow();
        if (_bcModalAbort) {
            _bcModalAbort.abort();
            _bcModalAbort = null;
        }
        _bcIsSelecting = false;
        ov.remove();
    };

    // Block events from leaking to app-level handlers after modal controls handle them.
    ov.addEventListener('mousedown', e => e.stopPropagation());
    ov.addEventListener('pointerdown', e => e.stopPropagation());

    // ── Click events ──
    ov.addEventListener('click', e => {
        const t = e.target;
        if (t.id === 'bc-close') { _bcCloseModal(); return; }
        if (t.id === 'bc-add-row') { _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); return; }
        if (t.id === 'bc-add-col') {
            _bcPrompt('输入列名（多列用逗号分隔）', 'FB标题, FB正文, FB尾标, TK标题, TK正文').then(input => {
                if (!input || !input.trim()) return;
                const names = input.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
                names.forEach(name => {
                    _bulkState.columns.push(_bcColumnFromName(name));
                    _bulkState.rows.forEach(r => r.push(''));
                });
                _bcRenderTable(); _bcRenderBindings();
                _bcScheduleDraftSave();
            });
            return;
        }
        if (t.id === 'bc-clear') { if(confirm('清空所有数据？')){ _bulkState.rows=[]; for(let i=0;i<20;i++) _bulkState.rows.push(new Array(_bulkState.columns.length).fill('')); _bcRenderTable(); } return; }
        if (t.id === 'bc-add-tpl') { _bcPickTemplates(); return; }
        if (t.id === 'bc-clear-bindings') { if (confirm('清空所有模板的列绑定？')) _bcClearAllTemplateBindings(); return; }
        if (t.id === 'bc-rebind-tpl') { if (confirm('按当前列名重新自动绑定所有模板字段？')) _bcAutoRebindAllTemplates(); return; }
        if (t.id === 'bc-save-preset') { _bcSavePreset(); return; }
        if (t.id === 'bc-load-preset') { _bcLoadPreset(); return; }
        if (t.id === 'bc-reload-source') { _bcReloadLoadedTemplates(); return; }
        if (t.id === 'bc-export-preset') { _bcExportPreset(); return; }
        if (t.id === 'bc-import-preset') { _bcImportPreset(); return; }
        if (t.id === 'bc-generate') {
            const count = _bcGenerateTasks();
            if (count > 0) { alert(`✅ 已生成 ${count} 个任务`); _bcCloseModal(); if(typeof _renderBatchTable==='function') _renderBatchTable(); if(typeof _renderTaskList==='function') _renderTaskList(); }
            return;
        }
        if (t.classList.contains('bc-col-del')) { const ci=parseInt(t.dataset.ci); if(_bulkState.columns.length<=1)return; _bulkState.columns.splice(ci,1); _bulkState.rows.forEach(r=>r.splice(ci,1)); _bcRenderTable(); _bcRenderBindings(); return; }
        if (t.classList.contains('bc-row-del')) { _bulkState.rows.splice(parseInt(t.dataset.ri),1); _bcRenderTable(); return; }
        if (t.classList.contains('bc-tpl-bgcycle')) {
            const ti = parseInt(t.dataset.ti);
            const tpl = _bulkState.templates[ti];
            if (!tpl) return;
            if (tpl.bgCycle && tpl.bgCycle.length > 0) {
                // 显示背景循环详情
                _bcShowBgCycleDetail(tpl, ti);
            } else {
                // 选择文件
                _bcPickBgCycleFiles(tpl, ti);
            }
            return;
        }
        if (t.classList.contains('bc-tpl-del')) { _bulkState.templates.splice(parseInt(t.dataset.ti),1); _bcRenderBindings(); return; }
        if (t.classList.contains('bc-col-insert')) {
            const ci = parseInt(t.dataset.ci);
            _bulkState.columns.splice(ci + 1, 0, { name: `列${_bulkState.columns.length+1}`, type: 'text' });
            _bulkState.rows.forEach(r => r.splice(ci + 1, 0, ''));
            // Update bindings: shift column indices >= ci+1
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) { if (v > ci) tpl.bindings[k] = v + 1; }
            });
            _bcRenderTable(); _bcRenderBindings(); return;
        }
        if (t.classList.contains('bc-col-left')) {
            const ci = parseInt(t.dataset.ci); if (ci <= 0) return;
            [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
            _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
            // Swap binding references
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci - 1;
                    else if (v === ci - 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); return;
        }
        if (t.classList.contains('bc-col-right')) {
            const ci = parseInt(t.dataset.ci); if (ci >= _bulkState.columns.length - 1) return;
            [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
            _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
            _bulkState.templates.forEach(tpl => {
                for (const [k, v] of Object.entries(tpl.bindings)) {
                    if (v === ci) tpl.bindings[k] = ci + 1;
                    else if (v === ci + 1) tpl.bindings[k] = ci;
                }
            });
            _bcRenderTable(); _bcRenderBindings(); return;
        }
    });

    // ── Change events ──
    ov.addEventListener('change', e => {
        const t = e.target;
        if (t.classList.contains('bc-col-name')) { _bulkState.columns[parseInt(t.dataset.ci)].name=t.value; _bcRenderBindings(); _bcScheduleDraftSave(); return; }
        if (t.classList.contains('bc-col-kind')) {
            const ci = parseInt(t.dataset.ci);
            _bcSetColumnKind(_bulkState.columns[ci], t.value);
            _bcClearInvalidBindingsForColumn(ci);
            _bcRenderTable();
            _bcRenderBindings();
            _bcScheduleDraftSave();
            return;
        }
        if (t.classList.contains('bc-bind-sel')) {
            const ti = parseInt(t.dataset.ti);
            const fk = t.dataset.fk;
            const newVal = parseInt(t.value);
            const colName = newVal >= 0 ? (_bulkState.columns[newVal]?.name || '') : '不绑定';
            console.log(`[BulkCreate] ✅ 绑定变更: 模板[${ti}]「${_bulkState.templates[ti]?.label}」字段[${fk}] → col[${newVal}]「${colName}」`);
            _bulkState.templates[ti].bindings[fk] = newVal;
            // 视觉反馈：闪烁
            t.style.border = '1px solid #4ade80';
            t.style.background = 'rgba(74,222,128,0.15)';
            setTimeout(() => { t.style.border = ''; t.style.background = ''; }, 600);
            _bcScheduleDraftSave();
            return;
        }
    });

    // ── Input events (live cell editing) ──
    const tableBody = ov.querySelector('#bc-table-body');
    tableBody.addEventListener('input', e => {
        const t = e.target;
        if (t.classList.contains('bc-cell')) {
            const ri=parseInt(t.dataset.ri), ci=parseInt(t.dataset.ci);
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = t.value;
            _bcScheduleDraftSave();
        }
    });

    // ── Text Processing Utilities ──
    function _bcCleanBreaks(text) {
        return (text || '').replace(/\r?\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
    }
    function _bcCleanBlankLines(text) {
        const lines = text.split(/\r?\n/);
        const newLines = [];
        let blank = false;
        for (const line of lines) {
            if (line.trim() === '') {
                if (!blank) { newLines.push(''); blank = true; }
            } else { newLines.push(line); blank = false; }
        }
        return newLines.join('\n');
    }
    function _bcAutoWrapText(text, width = 18) {
        const paragraphs = (text || '').trim().split(/\n\s*\n/);
        const wrappedResult = [];
        for (const para of paragraphs) {
            const words = para.trim().split(/\s+/);
            if (!words || (words.length === 1 && words[0] === '')) continue;
            let line = '';
            for (const word of words) {
                if (!line) { line = word; }
                else if (line.length + 1 + word.length <= width) { line += ' ' + word; }
                else { wrappedResult.push(line); line = word; }
                const lastChar = line.slice(-1);
                if (line && [':', '.', '?', '!', '：', '。', '？', '！'].includes(lastChar)) {
                    wrappedResult.push(line);
                    line = '';
                }
            }
            if (line) wrappedResult.push(line);
            wrappedResult.push('');
        }
        while (wrappedResult.length > 0 && wrappedResult[wrappedResult.length - 1] === '') wrappedResult.pop();
        return _bcCleanBlankLines(wrappedResult.join('\n'));
    }
    function _bcSplitTwoParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1).join('').trim() };
            } else {
                return { title: text.trim(), content: '' };
            }
        }
    }
    function _bcSplitThreeParts(text) {
        text = (text || '').toString().trim();
        if (!text) return { title: '', content: '', ending: '' };
        let lines = text.split(/\r?\n/);
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        if (lines.length > 1) {
            const contentLines = lines.slice(1, -1);
            while (contentLines.length > 0 && contentLines[0].trim() === '') contentLines.shift();
            return { title: lines[0].trim(), content: contentLines.join('\n').trim(), ending: lines[lines.length - 1].trim() };
        } else {
            const sentences = text.match(/[^。！？?!]+[。！？?!]?/g);
            if (sentences && sentences.length > 1) {
                return { title: sentences[0].trim(), content: sentences.slice(1, -1).join('').trim(), ending: sentences[sentences.length - 1].trim() };
            } else {
                return { title: text.trim(), content: '', ending: '' };
            }
        }
    }

    // ── Context menu for text processing ──
    tableBody.addEventListener('contextmenu', e => {
        const t = e.target;
        const cellEl = t.closest('.bc-cell, .bc-grid-td');
        let isCell = !!cellEl;
        let isColHeader = t.closest('th') && !t.classList.contains('bc-col-insert') && !t.classList.contains('bc-col-del') && !t.classList.contains('bc-col-kind');
        
        if (!isCell && !isColHeader) return;
        e.preventDefault();
        
        document.querySelectorAll('.bc-context-menu').forEach(el => el.remove());
        const menu = document.createElement('div');
        menu.className = 'bc-context-menu';
        menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:500000;display:flex;flex-direction:column;min-width:160px;`;
        
        let targetCi = -1, targetRi = -1;
        if (isCell) {
            targetCi = parseInt(cellEl.dataset.ci);
            targetRi = parseInt(cellEl.dataset.ri);
        } else {
            const input = t.closest('th').querySelector('.bc-col-name');
            if (input) targetCi = parseInt(input.dataset.ci);
        }
        if (targetCi < 0) return;

        const createItem = (label, icon, onClick) => {
            const btn = document.createElement('button');
            btn.style.cssText = 'padding:8px 12px;background:transparent;border:none;color:#ddd;font-size:12px;text-align:left;cursor:pointer;border-radius:4px;display:flex;align-items:center;gap:8px;';
            btn.innerHTML = `<span>${icon}</span> <span>${label} ${isCell ? '(单格)' : '(整列)'}</span>`;
            btn.onmouseenter = () => btn.style.background = 'rgba(255,255,255,0.1)';
            btn.onmouseleave = () => btn.style.background = 'transparent';
            btn.onclick = () => { 
                onClick(); 
                menu.remove(); 
                _bcRenderTable(); 
                if (isCell) _bcUpdateSelectionUI(); // Keep selection after process
            };
            return btn;
        };

        const processItems = (processor, needsExtraCols) => {
            let selectedRows = [targetRi];
            let processTargetCi = targetCi;

            if (isCell && _bcSelection) {
                const minR = Math.min(_bcSelection.r1, _bcSelection.r2);
                const maxR = Math.max(_bcSelection.r1, _bcSelection.r2);
                const minC = Math.min(_bcSelection.c1, _bcSelection.c2);
                const maxC = Math.max(_bcSelection.c1, _bcSelection.c2);
                // Check if the clicked cell is within the selection grid
                if (targetRi >= minR && targetRi <= maxR && targetCi >= minC && targetCi <= maxC) {
                    selectedRows = [];
                    for (let r = minR; r <= maxR; r++) selectedRows.push(r);
                    processTargetCi = minC; // Default to leftmost column of selection for processing outputs
                }
            } else if (!isCell) {
                selectedRows = _bulkState.rows.map((_, i) => i);
            }

            if (needsExtraCols > 0) {
                // Safely insert new columns immediately to the right instead of overwriting
                for (let i = 0; i < needsExtraCols; i++) {
                    _bulkState.columns.splice(processTargetCi + 1 + i, 0, { name: '拆分列', type: 'text' });
                    _bulkState.rows.forEach(r => r.splice(processTargetCi + 1 + i, 0, ''));
                }
                // Shift bindings for any columns that moved
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v > processTargetCi) tpl.bindings[k] = v + needsExtraCols;
                    }
                });
            }
            selectedRows.forEach(ri => {
                if (!_bulkState.rows[ri]) return;
                const val = _bulkState.rows[ri][processTargetCi] || '';
                if (!val.trim()) return;
                const res = processor(val);
                if (typeof res === 'string') {
                    _bulkState.rows[ri][processTargetCi] = res;
                } else if (res.title !== undefined) {
                    _bulkState.rows[ri][processTargetCi] = res.title;
                    if (res.content !== undefined) _bulkState.rows[ri][processTargetCi + 1] = res.content;
                    if (res.ending !== undefined) _bulkState.rows[ri][processTargetCi + 2] = res.ending;
                }
            });
        };

        if (isColHeader) {
            menu.appendChild(createItem('向左插入一列', '⬅️', () => {
                _bulkState.columns.splice(targetCi, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v >= targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('向右插入一列', '➡️', () => {
                _bulkState.columns.splice(targetCi + 1, 0, { name: `新列`, type: 'text' });
                _bulkState.rows.forEach(r => r.splice(targetCi + 1, 0, ''));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) { if (v > targetCi) tpl.bindings[k] = v + 1; }
                });
            }));
            menu.appendChild(createItem('清空整列内容', '🧽', () => {
                _bulkState.rows.forEach(r => { if (r) r[targetCi] = ''; });
            }));
            menu.appendChild(createItem('删除该列', '🗑️', () => {
                if (_bulkState.columns.length <= 1) return;
                _bulkState.columns.splice(targetCi, 1);
                _bulkState.rows.forEach(r => r.splice(targetCi, 1));
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === targetCi) delete tpl.bindings[k];
                        else if (v > targetCi) tpl.bindings[k] = v - 1;
                    }
                });
                _bcRenderBindings();
            }));
            const div2 = document.createElement('div'); div2.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div2);
            menu.appendChild(createItem('向左移动列', '⏪', () => {
                if (targetCi <= 0) return;
                const ci = targetCi;
                [_bulkState.columns[ci-1], _bulkState.columns[ci]] = [_bulkState.columns[ci], _bulkState.columns[ci-1]];
                _bulkState.rows.forEach(r => { [r[ci-1], r[ci]] = [r[ci], r[ci-1]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci - 1;
                        else if (v === ci - 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            menu.appendChild(createItem('向右移动列', '⏩', () => {
                if (targetCi >= _bulkState.columns.length - 1) return;
                const ci = targetCi;
                [_bulkState.columns[ci], _bulkState.columns[ci+1]] = [_bulkState.columns[ci+1], _bulkState.columns[ci]];
                _bulkState.rows.forEach(r => { [r[ci], r[ci+1]] = [r[ci+1], r[ci]]; });
                _bulkState.templates.forEach(tpl => {
                    for (const [k, v] of Object.entries(tpl.bindings)) {
                        if (v === ci) tpl.bindings[k] = ci + 1;
                        else if (v === ci + 1) tpl.bindings[k] = ci;
                    }
                });
                _bcRenderBindings();
            }));
            const div3 = document.createElement('div'); div3.style.cssText = 'height:1px;background:#333;margin:4px 0;';
            menu.appendChild(div3);
        }

        menu.appendChild(createItem('清理换行', '🧹', () => processItems(v => _bcCleanBreaks(v), 0)));
        const savedWrapWidth = parseInt(localStorage.getItem('bc_auto_wrap_width') || '18', 10) || 18;
        menu.appendChild(createItem(`自动断行 (${savedWrapWidth}字)`, '↩️', () => processItems(v => _bcAutoWrapText(v, savedWrapWidth), 0)));
        menu.appendChild(createItem('设置断行字数...', '⚙️', async () => {
            const input = await _bcPrompt('设置自动断行字数', '当前字数: ' + savedWrapWidth);
            if (input !== null) {
                const newWidth = parseInt(input.trim(), 10);
                if (!isNaN(newWidth) && newWidth > 0) {
                    localStorage.setItem('bc_auto_wrap_width', newWidth);
                    if (typeof showToast === 'function') showToast(`自动断行字数已设置为 ${newWidth}，再次右键生效`, 'success');
                } else {
                    if (typeof showToast === 'function') showToast('请输入有效的正整数', 'error');
                }
            }
        }));
        const div = document.createElement('div'); div.style.cssText = 'height:1px;background:#333;margin:4px 0;';
        menu.appendChild(div);
        menu.appendChild(createItem('拆分两段 (标/内)', '✂️', () => processItems(v => _bcSplitTwoParts(v), 1)));
        menu.appendChild(createItem('拆分三段 (标/内/尾)', '📑', () => processItems(v => _bcSplitThreeParts(v), 2)));
        
        document.body.appendChild(menu);
        
        // Auto-close on click outside. Use capture because the modal stops bubbling events.
        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('contextmenu', closeMenu, true);
                document.removeEventListener('scroll', closeMenu, true);
                document.removeEventListener('keydown', closeMenuKey, true);
            }
        };
        const closeMenuKey = (ev) => {
            if (ev.key === 'Escape') closeMenu(ev);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu, true);
            document.addEventListener('contextmenu', closeMenu, true);
            document.addEventListener('scroll', closeMenu, true);
            document.addEventListener('keydown', closeMenuKey, true);
        }, 10);
    });

    function _bcOpenExpandedEditor(ri, ci, initialValue) {
        if (ri < 0 || ci < 0 || !_bulkState.rows[ri]) return;
        const colName = _bulkState.columns[ci]?.name || `列${ci + 1}`;
        const val = initialValue !== undefined ? initialValue : (_bulkState.rows[ri]?.[ci] || '');

        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:400000;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;';
        m.innerHTML = `<div style="background:#1a1a2e;border:1px solid #444;border-radius:12px;width:600px;max-width:90vw;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.8);">
            <div style="padding:10px 16px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
                <span style="color:#fff;font-size:13px;font-weight:600;">✏️ ${_bcEsc(colName)} — 第 ${ri + 1} 行</span>
                <div style="display:flex;gap:6px;">
                    <button id="bc-exp-ok" style="padding:4px 16px;background:linear-gradient(135deg,#7c5cff,#a855f7);border:none;border-radius:5px;color:#fff;cursor:pointer;font-size:11px;font-weight:600;">保存</button>
                    <button id="bc-exp-cancel" style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;border-radius:5px;color:#888;cursor:pointer;font-size:11px;">取消</button>
                </div>
            </div>
            <div style="padding:12px;flex:1;overflow:auto;">
                <textarea id="bc-exp-textarea" style="width:100%;min-height:300px;max-height:60vh;background:#0a0a14;border:1px solid #333;border-radius:8px;color:#ddd;font-size:13px;line-height:1.6;padding:12px;resize:vertical;box-sizing:border-box;font-family:inherit;">${_bcEsc(val)}</textarea>
                <div style="margin-top:6px;font-size:10px;color:#555;text-align:right;">Ctrl+Enter 保存 · Esc 取消</div>
            </div>
        </div>`;
        document.body.appendChild(m);

        const ta = m.querySelector('#bc-exp-textarea');
        setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);

        const save = () => {
            if (_bulkState.rows[ri]) _bulkState.rows[ri][ci] = ta.value;
            m.remove();
            _bcRenderTable();
        };
        m.querySelector('#bc-exp-ok').onclick = save;
        m.querySelector('#bc-exp-cancel').onclick = () => m.remove();
        ta.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') { ev.preventDefault(); m.remove(); }
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); save(); }
        });
        m.addEventListener('click', ev => { if (ev.target === m) m.remove(); });
    }

    async function _bcPickMediaFiles(ri, ci) {
        if (!_bcIsMediaColumn(ci)) return;
        let paths = null;
        const kind = _bcColumnKind(_bulkState.columns[ci]);
        const filterByKind = {
            image: { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
            video: { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm'] },
            audio: { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'] },
            subtitle: { name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] },
        };
        if (window.electronAPI?.selectFiles) {
            paths = await window.electronAPI.selectFiles({
                title: `选择${_bulkState.columns[ci]?.name || '素材'}文件`,
                multiple: true,
                filters: [
                    filterByKind[kind] || { name: '媒体与字幕文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'srt', 'vtt', 'ass'] },
                    { name: '所有文件', extensions: ['*'] },
                ],
            });
        } else {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = 'video/*,image/*,audio/*';
            paths = await new Promise(resolve => {
                input.onchange = () => resolve(Array.from(input.files || []).map(_bcNativeFilePath));
                input.click();
            });
        }
        const count = _bcFillMediaColumn(paths || [], ri, ci);
        if (count && typeof showToast === 'function') showToast(`已添加 ${count} 个素材到「${_bulkState.columns[ci]?.name || '素材'}」列`, 'success');
    }

    // ── Double-click to expand cell editor ──
    tableBody.addEventListener('dblclick', e => {
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) return;
        e.preventDefault(); e.stopPropagation();
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (_bcIsMediaColumn(ci)) {
            _bcPickMediaFiles(ri, ci);
            return;
        }
        _bcOpenExpandedEditor(ri, ci);
    });

    // ── Mouse Selection Events ──
    const bcCellFromPoint = (clientX, clientY) => {
        const el = document.elementFromPoint(clientX, clientY);
        return el ? el.closest('.bc-cell, .bc-grid-td') : null;
    };
    const bcExtendSelectionTo = (cell) => {
        if (!cell || !_bcSelection) return;
        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        if (Number.isNaN(ri) || Number.isNaN(ci)) return;
        if (_bcSelection.r2 === ri && _bcSelection.c2 === ci) return;
        _bcSelection.r2 = ri;
        _bcSelection.c2 = ci;
        _bcUpdateSelectionUI();
    };

    tableBody.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        const cell = e.target.closest('.bc-cell, .bc-grid-td');
        if (!cell) {
            _bcSelection = null;
            _bcUpdateSelectionUI();
            return;
        }
        e.preventDefault();
        tableBody.focus();

        const ri = parseInt(cell.dataset.ri);
        const ci = parseInt(cell.dataset.ci);
        _bcIsSelecting = true;
        if (e.shiftKey && _bcSelection) {
            _bcSelection.r2 = ri;
            _bcSelection.c2 = ci;
        } else {
            _bcSelection = { r1: ri, c1: ci, r2: ri, c2: ci };
        }
        _bcUpdateSelectionUI();
    });

    document.addEventListener('mousemove', e => {
        if (!_bcIsSelecting) return;
        e.preventDefault();
        bcExtendSelectionTo(bcCellFromPoint(e.clientX, e.clientY));
    }, { signal: bcModalSignal });

    document.addEventListener('mouseup', () => {
        if (_bcIsSelecting) {
            _bcIsSelecting = false;
            _bcUpdateSelectionUI();
        }
    }, { signal: bcModalSignal });

    const _bcClearMediaDropTargets = () => {
        tableBody.querySelectorAll('.bc-media-drop-target').forEach(el => el.classList.remove('bc-media-drop-target'));
    };
    const _bcMediaDropTarget = (target) => {
        const cell = target.closest?.('.bc-grid-td, .bc-cell');
        if (cell) {
            const ci = parseInt(cell.dataset.ci);
            if (_bcIsMediaColumn(ci)) {
                return {
                    ci,
                    ri: parseInt(cell.dataset.ri),
                    el: cell.classList.contains('bc-grid-td') ? cell : cell.closest('.bc-grid-td'),
                };
            }
        }
        const th = target.closest?.('.bc-col-header');
        if (th) {
            const ci = parseInt(th.dataset.ci);
            if (_bcIsMediaColumn(ci)) return { ci, ri: 0, el: th };
        }
        return null;
    };

    tableBody.addEventListener('dragover', e => {
        const target = _bcMediaDropTarget(e.target);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        _bcClearMediaDropTargets();
        if (target.el) target.el.classList.add('bc-media-drop-target');
    });

    tableBody.addEventListener('dragleave', e => {
        if (!tableBody.contains(e.relatedTarget)) _bcClearMediaDropTargets();
    });

    tableBody.addEventListener('drop', e => {
        const target = _bcMediaDropTarget(e.target);
        _bcClearMediaDropTargets();
        if (!target) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = files.map(_bcNativeFilePath).filter(Boolean);
        const count = _bcFillMediaColumn(paths, target.ri, target.ci);
        if (count && typeof showToast === 'function') showToast(`已拖入 ${count} 个素材到「${_bulkState.columns[target.ci]?.name || '素材'}」列`, 'success');
    });

    // ── Keyboard Navigation & Bulk Operations ──
    tableBody.addEventListener('keydown', e => {
        const t = e.target;
        const isTable = t === tableBody;
        if (!isTable) return;
        if (!_bcSelection && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Backspace', 'Delete'].includes(e.key)) {
            _bcSelection = { r1: 0, c1: 0, r2: 0, c2: 0 };
            _bcUpdateSelectionUI();
        }
        if (!_bcSelection) return;

        const bounds = _bcSelectionBounds();
        const isMulti = bounds && (bounds.minR !== bounds.maxR || bounds.minC !== bounds.maxC);

        // Copy (Ctrl+C / Cmd+C)
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            e.preventDefault();
            let clip = '';
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                let rowClip = [];
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    let val = _bulkState.rows[r]?.[c] || '';
                    if (val.includes('\n') || val.includes('\t') || val.includes('"')) {
                        val = '"' + val.replace(/"/g, '""') + '"';
                    }
                    rowClip.push(val);
                }
                clip += rowClip.join('\t') + '\n';
            }
            navigator.clipboard.writeText(clip);
            return;
        }

        // Delete Bulk Content
        if ((e.key === 'Backspace' || e.key === 'Delete') && _bcSelection) {
            e.preventDefault();
            for (let r = bounds.minR; r <= bounds.maxR; r++) {
                for (let c = bounds.minC; c <= bounds.maxC; c++) {
                    if (_bulkState.rows[r]) _bulkState.rows[r][c] = '';
                }
            }
            _bcRenderTable();
            return;
        }

        let ri = _bcSelection.r1;
        let ci = _bcSelection.c1;
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci, e.key);
            return;
        }
        if ((e.key === 'Enter' && (e.ctrlKey || e.metaKey)) || e.key === 'F2') {
            e.preventDefault();
            _bcOpenExpandedEditor(ri, ci);
            return;
        }

        let nextRi = ri, nextCi = ci;
        if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) { nextCi = ci - 1; if (nextCi < 0) { nextCi = _bulkState.columns.length - 1; nextRi = ri - 1; } }
            else { nextCi = ci + 1; if (nextCi >= _bulkState.columns.length) { nextCi = 0; nextRi = ri + 1; } }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (isMulti) {
                _bcOpenExpandedEditor(ri, ci);
                return;
            }
            nextRi = ri + 1;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); nextRi = ri - 1;
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); nextRi = ri + 1;
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault(); nextCi = ci - 1;
        } else if (e.key === 'ArrowRight') {
            e.preventDefault(); nextCi = ci + 1;
        } else { return; }
        // Auto-add row if needed
        if (nextRi >= _bulkState.rows.length) {
            _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
            _bcRenderTable();
        }
        if (nextRi < 0) return;
        if (nextCi < 0 || nextCi >= _bulkState.columns.length) return;
        if (e.shiftKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            _bcSelection.r2 = nextRi;
            _bcSelection.c2 = nextCi;
        } else {
            _bcSelection = { r1: nextRi, c1: nextCi, r2: nextRi, c2: nextCi };
        }
        _bcUpdateSelectionUI();
    });

    // ── RFC 4180 TSV parser: correctly handles cells with embedded newlines ──
    // Google Sheets wraps cells containing \n in double quotes: "line1\nline2"
    // Internal quotes are doubled: "He said ""hello"""
    function _bcParseTSV(text) {
        const rows = [];
        let row = [];
        let cell = '';
        let inQuote = false;
        let i = 0;
        const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        while (i < src.length) {
            const ch = src[i];

            if (inQuote) {
                if (ch === '"') {
                    // Peek next char
                    if (i + 1 < src.length && src[i + 1] === '"') {
                        // Escaped quote "" → literal "
                        cell += '"';
                        i += 2;
                    } else {
                        // End of quoted field
                        inQuote = false;
                        i++;
                    }
                } else {
                    cell += ch;
                    i++;
                }
            } else {
                if (ch === '"' && cell === '') {
                    // Start of quoted field (only at beginning of cell)
                    inQuote = true;
                    i++;
                } else if (ch === '\t') {
                    row.push(cell);
                    cell = '';
                    i++;
                } else if (ch === '\n') {
                    row.push(cell);
                    cell = '';
                    // Skip trailing empty rows
                    if (row.some(c => c.trim())) rows.push(row);
                    row = [];
                    i++;
                } else {
                    cell += ch;
                    i++;
                }
            }
        }
        // Flush last cell/row
        row.push(cell);
        if (row.some(c => c.trim())) rows.push(row);
        return rows;
    }

    // ── Smart paste: handles both TSV button and direct Ctrl+V ──
    function _bcHandlePaste(text, anchorRi, anchorCi) {
        if (!text || !text.trim()) return;
        const lines = _bcParseTSV(text);
        if (lines.length === 0) return;

        // If pasting into a specific cell (not full-table mode)
        if (anchorRi >= 0 && anchorCi >= 0) {
            // Auto-add columns if pasted data exceeds current table width
            const maxPastedCols = Math.max(...lines.map(l => l.length));
            const neededCols = anchorCi + maxPastedCols;
            while (_bulkState.columns.length < neededCols) {
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
                // Pad all existing rows to match new column count
                _bulkState.rows.forEach(r => r.push(''));
            }
            // Paste starting from anchor cell, expand grid as needed
            lines.forEach((cols, li) => {
                const targetRi = anchorRi + li;
                while (targetRi >= _bulkState.rows.length)
                    _bulkState.rows.push(new Array(_bulkState.columns.length).fill(''));
                cols.forEach((val, colOff) => {
                    const targetCi = anchorCi + colOff;
                    if (targetCi < _bulkState.columns.length && _bulkState.rows[targetRi])
                        _bulkState.rows[targetRi][targetCi] = val;
                });
            });
            _bcSelection = {
                r1: anchorRi,
                c1: anchorCi,
                r2: anchorRi + lines.length - 1,
                c2: anchorCi + maxPastedCols - 1,
            };
            _bcRenderTable();
            _bcRenderBindings();
            return;
        }

        // Full-table paste mode (button or empty table)
        const first = lines[0];
        const colCount = Math.max(...lines.map(l => l.length));

        // Ask user about header row
        let hasHdr = false;
        if (lines.length > 1) {
            hasHdr = confirm(`粘贴了 ${lines.length} 行 × ${colCount} 列数据\n\n第一行是否为标题行？\n\n"${first.slice(0, 4).join(' | ')}${first.length > 4 ? ' ...' : ''}"\n\n确定 = 第一行作为列标题\n取消 = 全部作为数据`);
        }

        if (hasHdr) {
            _bulkState.columns = first.map(h => _bcColumnFromName(h.trim() || '列'));
            _bulkState.rows = lines.slice(1).map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
        } else {
            // Expand columns if needed
            while (_bulkState.columns.length < colCount)
                _bulkState.columns.push({ name: `列${_bulkState.columns.length + 1}`, type: 'text' });
            _bulkState.rows = lines.map(l => {
                const r = new Array(_bulkState.columns.length).fill('');
                l.forEach((v, i) => { if (i < r.length) r[i] = v; });
                return r;
            });
        }
        _bcRenderTable(); _bcRenderBindings();
    }

    function _bcPasteIntoSelection(e) {
        const active = document.activeElement;
        if (active && active !== tableBody && /^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName)) return false;
        if (active && active.isContentEditable) return false;

        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return false;

        e.preventDefault();
        e.stopPropagation();
        const cell = e.target.closest?.('.bc-cell, .bc-grid-td');
        if (_bcSelection || cell) {
            const startRi = _bcSelection ? Math.min(_bcSelection.r1, _bcSelection.r2) : parseInt(cell.dataset.ri);
            const startCi = _bcSelection ? Math.min(_bcSelection.c1, _bcSelection.c2) : parseInt(cell.dataset.ci);
            _bcHandlePaste(text, startRi, startCi);
        } else {
            _bcHandlePaste(text, -1, -1);
        }
        return true;
    }

    // Direct Ctrl+V anywhere in the modal as long as a grid cell is selected.
    document.addEventListener('paste', e => {
        const modal = document.getElementById('bc-modal');
        if (!modal) return;
        const active = document.activeElement;
        const eventInsideModal = modal.contains(e.target);
        const focusInsideModal = active && modal.contains(active);
        if (!eventInsideModal && !focusInsideModal) return;
        _bcPasteIntoSelection(e);
    }, { capture: true, signal: bcModalSignal });

    // Paste TSV button (full-table replace mode)
    ov.querySelector('#bc-paste-tsv').addEventListener('click', async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch(e) { text = await _bcPrompt('粘贴 TSV 数据', '从 Google Sheets 复制的内容'); }
        _bcHandlePaste(text, -1, -1);
    });
}

window._showBulkCreateModal = _showBulkCreateModal;
