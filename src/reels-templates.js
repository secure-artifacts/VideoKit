/**
 * reels-templates.js — 视频模板库 UI + 逻辑
 * 
 * 功能：
 *   - 模板库面板（网格缩略图列表）
 *   - 保存当前工程为模板
 *   - 打开模板 → 独立编辑器窗口
 *   - 删除/重命名模板
 *   - 启动时检测 URL hash 自动加载模板
 */

// ═══════════════════════════════════════════════════════
// 1. 模板库 Modal UI
// ═══════════════════════════════════════════════════════

function _tplEscapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

let _currentTemplateContext = {
    id: '',
    name: '',
};

function _setCurrentTemplateContext(id, name) {
    _currentTemplateContext = {
        id: id || '',
        name: name || '',
    };
    _updateCurrentTemplateButton();
}

function _updateCurrentTemplateButton() {
    const btn = document.getElementById('tpl-update-current-btn');
    const label = document.getElementById('tpl-current-template-label');
    if (btn) {
        btn.disabled = !_currentTemplateContext.id;
        btn.style.opacity = _currentTemplateContext.id ? '1' : '0.45';
        btn.style.cursor = _currentTemplateContext.id ? 'pointer' : 'not-allowed';
        btn.title = _currentTemplateContext.id
            ? `用当前工程覆盖模板「${_currentTemplateContext.name || _currentTemplateContext.id}」`
            : '请先载入一个模板';
    }
    if (label) {
        label.textContent = _currentTemplateContext.id
            ? `当前: ${_currentTemplateContext.name || _currentTemplateContext.id}`
            : '当前: 未载入模板';
        label.title = _currentTemplateContext.name || _currentTemplateContext.id || '';
    }
}

function openTemplateLibrary() {
    // 如果已存在就显示
    let modal = document.getElementById('template-library-modal');
    if (modal) {
        modal.style.display = 'flex';
        _updateCurrentTemplateButton();
        _refreshTemplateList();
        return;
    }

    modal = document.createElement('div');
    modal.id = 'template-library-modal';
    modal.style.cssText = 'display:flex;align-items:center;justify-content:center;z-index:10000;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
    modal.innerHTML = `
        <div class="modal-content" style="width:90vw;max-width:1100px;height:80vh;display:flex;flex-direction:column;background:var(--bg-secondary,#1a1a2e);border-radius:16px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:22px;">📂</span>
                    <h2 style="margin:0;font-size:18px;font-weight:700;color:#fff;">视频模板库</h2>
                    <span id="tpl-count-badge" style="font-size:11px;padding:2px 8px;background:rgba(110,231,183,0.15);color:#6ee7b7;border-radius:10px;"></span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                    <button onclick="saveCurrentAsTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;cursor:pointer;">💾 保存当前工程</button>
                    <button id="tpl-update-current-btn" onclick="updateCurrentTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(245,158,11,0.16);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:8px;cursor:pointer;">♻️ 更新当前模板</button>
                    <button onclick="_importTemplate()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);border-radius:8px;cursor:pointer;">📥 导入</button>
                    <button onclick="_exportAllTemplates()" style="padding:5px 12px;font-size:11px;font-weight:600;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.3);border-radius:8px;cursor:pointer;">📤 导出全部</button>
                    <span id="tpl-current-template-label" style="max-width:170px;font-size:10px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
                    <button onclick="document.getElementById('template-library-modal').style.display='none'" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:4px 8px;">✕</button>
                </div>
            </div>
            <div id="tpl-grid-container" style="flex:1;overflow-y:auto;padding:20px 24px;">
                <div style="color:#666;text-align:center;padding:60px 0;">加载中...</div>
            </div>
        </div>
    `;

    // 点击遮罩关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });

    document.body.appendChild(modal);
    _updateCurrentTemplateButton();
    _refreshTemplateList();
}

async function _refreshTemplateList() {
    const container = document.getElementById('tpl-grid-container');
    const badge = document.getElementById('tpl-count-badge');
    if (!container) return;

    try {
        const resp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const parsed = await resp.json();
        const templates = parsed.data || parsed || [];

        badge.textContent = `${templates.length} 个模板`;

        if (templates.length === 0) {
            container.innerHTML = `
                <div style="text-align:center;padding:80px 0;color:#555;">
                    <div style="font-size:48px;margin-bottom:16px;opacity:0.4;">📂</div>
                    <p style="font-size:14px;margin:0;">还没有保存任何模板</p>
                    <p style="font-size:12px;color:#444;margin-top:6px;">点击上方「保存当前工程为模板」开始</p>
                </div>
            `;
            return;
        }

        let html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">';
        for (const tpl of templates) {
            const thumbSrc = tpl.thumbnail || '';
            const dateStr = tpl.updatedAt ? new Date(tpl.updatedAt).toLocaleDateString('zh-CN') : '';
            const taskInfo = tpl.taskCount ? `${tpl.taskCount} 个任务` : '';
            const safeId = _tplEscapeHtml(tpl.id);
            const safeName = _tplEscapeHtml(tpl.name || '');
            const safeThumb = _tplEscapeHtml(thumbSrc);
            const safeDate = _tplEscapeHtml(dateStr);
            const safeTaskInfo = _tplEscapeHtml(taskInfo);
            const thumbHtml = thumbSrc
                ? `<img src="${safeThumb}" style="width:100%;height:100%;object-fit:cover;" />`
                : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:36px;">🎬</div>`;

            html += `
                <div class="tpl-card" data-id="${safeId}" data-name="${safeName}" style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:12px;overflow:hidden;cursor:pointer;transition:all 0.2s;position:relative;"
                     onmouseenter="this.style.borderColor='rgba(99,102,241,0.4)';this.style.transform='translateY(-2px)'"
                     onmouseleave="this.style.borderColor='rgba(255,255,255,0.06)';this.style.transform='none'">
                    <div style="aspect-ratio:9/16;max-height:280px;background:#0a0a1a;overflow:hidden;">
                        ${thumbHtml}
                    </div>
                    <div style="padding:10px 12px;">
                        <div class="tpl-name" style="font-size:13px;font-weight:600;color:#e0e0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${safeName}">${safeName}</div>
                        <div style="font-size:10px;color:#666;margin-top:4px;display:flex;justify-content:space-between;">
                            <span>${safeDate}</span>
                            <span>${safeTaskInfo}</span>
                        </div>
                    </div>
                    <div class="tpl-actions" style="position:absolute;top:8px;right:8px;display:flex;gap:4px;opacity:1;transition:opacity 0.2s;background:rgba(0,0,0,0.5);padding:4px;border-radius:8px;">
                        <button data-action="load" style="padding:4px 6px;font-size:11px;background:rgba(59,130,246,0.9);color:#fff;border:none;border-radius:6px;cursor:pointer;" title="覆盖当前工程直接载入">🔽 载入</button>
                        <button data-action="window" style="padding:4px 6px;font-size:11px;background:rgba(99,102,241,0.9);color:#fff;border:none;border-radius:6px;cursor:pointer;" title="独立新窗口打开">🪟 新窗</button>
                        <button data-action="export" style="padding:4px 6px;font-size:11px;background:rgba(16,185,129,0.2);color:#10b981;border:none;border-radius:6px;cursor:pointer;" title="导出为文件">📤</button>
                        <button data-action="rename" style="padding:4px 6px;font-size:11px;background:rgba(255,255,255,0.1);color:#ccc;border:none;border-radius:6px;cursor:pointer;" title="重命名">✏️</button>
                        <button data-action="delete" style="padding:4px 6px;font-size:11px;background:rgba(239,68,68,0.2);color:#f87171;border:none;border-radius:6px;cursor:pointer;" title="删除">🗑</button>
                    </div>
                </div>
            `;
        }
        html += '</div>';
        container.innerHTML = html;

        // 显示操作按钮的 hover 效果
        container.querySelectorAll('.tpl-card').forEach(card => {
            card.addEventListener('mouseenter', () => card.querySelector('.tpl-actions').style.opacity = '1');
            card.addEventListener('mouseleave', () => card.querySelector('.tpl-actions').style.opacity = '0');
            card.querySelector('.tpl-actions')?.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                e.stopPropagation();
                const id = card.dataset.id || '';
                const name = card.dataset.name || '';
                const action = btn.dataset.action;
                if (action === 'load') _loadTemplateInCurrentWindow(id);
                else if (action === 'window') _openTemplateInWindow(id, name);
                else if (action === 'export') _exportTemplate(id, name);
                else if (action === 'rename') _renameTemplate(id);
                else if (action === 'delete') _deleteTemplate(id, name);
            });
            // 双击打开
            card.addEventListener('dblclick', () => {
                const id = card.dataset.id;
                const name = card.dataset.name || '';
                _openTemplateInWindow(id, name);
            });
        });

    } catch (e) {
        container.innerHTML = `<div style="color:#f87171;text-align:center;padding:40px;">加载失败: ${e.message}</div>`;
    }
}

// ═══════════════════════════════════════════════════════
// 2. 保存当前工程为模板
// ═══════════════════════════════════════════════════════

function _captureCurrentTemplatePayload(name) {
    // 截取当前 Canvas 预览作为缩略图
    let thumbnail = '';
    try {
        const canvas = document.getElementById('reels-preview-canvas') || document.querySelector('canvas');
        if (canvas) {
            // 创建缩略图 canvas（270×480，9:16）
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = 270;
            thumbCanvas.height = 480;
            const ctx = thumbCanvas.getContext('2d');
            ctx.drawImage(canvas, 0, 0, 270, 480);
            thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.65);
        }
    } catch (e) {
        console.warn('[Template] 截图失败:', e);
    }

    // 用 ReelsProject.collectProjectData 序列化工程
    let projectData = {};
    try {
        if (typeof collectCurrentProjectState === 'function') {
            const state = collectCurrentProjectState();
            projectData = ReelsProject.collectProjectData(state);
        } else if (typeof ReelsProject !== 'undefined') {
            // 尝试直接收集
            projectData = ReelsProject.collectProjectData({
                tasks: window.reelsTasks || [],
                style: window.reelsGlobalStyle || {},
                exportOpts: window.reelsExportOpts || {},
                selectedIdx: window.reelsSelectedIdx || 0,
            });
        }
    } catch (e) {
        console.error('[Template] 工程序列化失败:', e);
        throw new Error('序列化工程失败: ' + e.message);
    }

    return {
        name,
        thumbnail,
        projectData,
    };
}

async function saveCurrentAsTemplate() {
    const name = await (typeof _showInputDialog === 'function' ? _showInputDialog('请输入模板名称', `模板_${new Date().toLocaleDateString('zh-CN')}`) : prompt('请输入模板名称：', `模板_${new Date().toLocaleDateString('zh-CN')}`));
    if (!name || !name.trim()) return;

    try {
        const payload = _captureCurrentTemplatePayload(name.trim());
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await resp.json();
        if (result.success || result.data?.success) {
            const savedId = result.id || result.data?.id || '';
            if (savedId) _setCurrentTemplateContext(savedId, name.trim());
            if (typeof showToast === 'function') showToast(`模板「${name}」已保存 ✅`, 'success');
            _refreshTemplateList();
        } else {
            throw new Error(result.error || '保存失败');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('保存模板失败: ' + e.message, 'error');
    }
}

async function updateCurrentTemplate() {
    if (!_currentTemplateContext.id) {
        if (typeof showToast === 'function') showToast('请先从模板库载入一个模板，再更新当前模板', 'warning');
        else alert('请先从模板库载入一个模板，再更新当前模板');
        return;
    }

    const name = _currentTemplateContext.name || _currentTemplateContext.id;
    if (!confirm(`确定用当前工程覆盖模板「${name}」？`)) return;

    try {
        const payload = _captureCurrentTemplatePayload(name);
        const resp = await apiFetch(`${API_BASE}/templates/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...payload,
                id: _currentTemplateContext.id,
            }),
        });
        const result = await resp.json();
        if (result.success || result.data?.success) {
            if (typeof showToast === 'function') showToast(`模板「${name}」已更新 ✅`, 'success');
            _refreshTemplateList();
        } else {
            throw new Error(result.error || '更新失败');
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('更新模板失败: ' + e.message, 'error');
        else alert('更新模板失败: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 3. 打开模板（新窗口 / 当前窗口）
// ═══════════════════════════════════════════════════════

async function _openTemplateInWindow(templateId, templateName) {
    if (window.electronAPI?.openTemplateWindow) {
        try {
            const result = await window.electronAPI.openTemplateWindow(templateId, templateName);
            if (result?.reused) {
                if (typeof showToast === 'function') showToast(`模板「${templateName}」窗口已聚焦`, 'info');
            }
        } catch (e) {
            console.error('[Template] 打开窗口失败:', e);
            // Fallback: 当前窗口加载
            _loadTemplateInCurrentWindow(templateId);
        }
    } else {
        // 浏览器模式：当前窗口加载
        _loadTemplateInCurrentWindow(templateId);
    }
}

async function _loadTemplateInCurrentWindow(templateId) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: templateId }),
        });
        const result = await resp.json();
        const tplData = result.data || result;

        if (tplData.projectData && typeof ReelsProject !== 'undefined') {
            // ── 诊断日志：模板加载数据追踪 ──
            const rawTasks = tplData.projectData.tasks || [];
            console.log(`[Template] 📦 原始模板数据: ${rawTasks.length} 个任务`);
            rawTasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}, txtContent=${(t.txtContent || '').slice(0, 30)}`);
            });

            const restored = ReelsProject.applyProjectData(tplData.projectData);

            console.log(`[Template] 🔄 反序列化后: ${restored.tasks.length} 个任务`);
            restored.tasks.forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });

            if (typeof applyRestoredProject === 'function') {
                applyRestoredProject(restored);
            }

            console.log(`[Template] ✅ applyRestoredProject 完成后:`);
            (_reelsState?.tasks || []).forEach((t, i) => {
                const ovCount = (t.overlays || []).length;
                const segCount = (t.segments || []).length;
                const coverOvCount = (t.cover?.overlays || []).length;
                console.log(`  [${i}] overlays=${ovCount}, segments=${segCount}, cover.overlays=${coverOvCount}`);
            });
            _setCurrentTemplateContext(tplData.id || templateId, tplData.name || '');
            if (typeof showToast === 'function') showToast(`模板「${tplData.name}」已加载`, 'success');

            // 关闭模板库面板
            const modal = document.getElementById('template-library-modal');
            if (modal) modal.style.display = 'none';

            // 自动切换到批量 Reels 标签页
            if (typeof openPanelByName === 'function') {
                openPanelByName('batch-reels');
            }
        }
    } catch (e) {
        if (typeof showToast === 'function') showToast('加载模板失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4. 删除 / 重命名
// ═══════════════════════════════════════════════════════

async function _deleteTemplate(id, name) {
    if (!confirm(`确定删除模板「${name}」？此操作不可恢复。`)) return;

    try {
        await apiFetch(`${API_BASE}/templates/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext('', '');
        }
        if (typeof showToast === 'function') showToast(`模板「${name}」已删除`, 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('删除失败: ' + e.message, 'error');
    }
}

async function _renameTemplate(id) {
    const newName = await (typeof _showInputDialog === 'function' ? _showInputDialog('请输入新名称', '') : prompt('请输入新名称：'));
    if (!newName || !newName.trim()) return;

    try {
        await apiFetch(`${API_BASE}/templates/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, name: newName.trim() }),
        });
        if (_currentTemplateContext.id === id) {
            _setCurrentTemplateContext(id, newName.trim());
        }
        if (typeof showToast === 'function') showToast('已重命名', 'success');
        _refreshTemplateList();
    } catch (e) {
        if (typeof showToast === 'function') showToast('重命名失败: ' + e.message, 'error');
    }
}

// ═══════════════════════════════════════════════════════
// 4b. 导入 / 导出模板文件
// ═══════════════════════════════════════════════════════

/**
 * 导出模板为 .vktpl 文件
 */
async function _exportTemplate(id, name) {
    try {
        const resp = await apiFetch(`${API_BASE}/templates/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        const result = await resp.json();
        const tplData = result.data || result;

        // 导出完整数据（含缩略图）
        const exportObj = {
            _format: 'videokit-template',
            _version: 1,
            name: tplData.name,
            description: tplData.description || '',
            thumbnail: tplData.thumbnail || '',
            tags: tplData.tags || [],
            createdAt: tplData.createdAt,
            projectData: tplData.projectData,
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name || 'template'}.vktpl`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast(`模板「${name}」已导出`, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('导出失败: ' + e.message, 'error');
        else alert('导出失败: ' + e.message);
    }
}

/**
 * 导入 .vktpl 模板文件
 */
async function _importTemplate() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.vktpl,.json';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        let imported = 0;
        for (const file of files) {
            try {
                const text = await file.text();
                const data = JSON.parse(text);

                // 校验是否为合集
                const templatesToImport = [];
                if (data._format === 'videokit-template-collection' && Array.isArray(data.templates)) {
                    templatesToImport.push(...data.templates);
                } else if (data.projectData) {
                    templatesToImport.push(data);
                } else {
                    if (typeof showToast === 'function') showToast(`跳过 ${file.name}: 不是有效的模板文件`, 'warning');
                    else alert(`跳过 ${file.name}: 不是有效的模板文件`);
                    continue;
                }

                for (const tpl of templatesToImport) {
                    const resp = await apiFetch(`${API_BASE}/templates/save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: tpl.name || file.name.replace(/\.(vktpl|json)$/i, ''),
                            description: tpl.description || '',
                            thumbnail: tpl.thumbnail || '',
                            tags: tpl.tags || [],
                            projectData: tpl.projectData,
                        }),
                    });
                    const result = await resp.json();
                    if (result.success || result.data?.success) {
                        imported++;
                    }
                }
            } catch (err) {
                console.error(`[Template] 导入 ${file.name} 失败:`, err);
                if (typeof showToast === 'function') showToast(`导入 ${file.name} 失败: ${err.message}`, 'error');
                else alert(`导入 ${file.name} 失败: ${err.message}`);
            }
        }

        if (imported > 0) {
            if (typeof showToast === 'function') showToast(`成功导入 ${imported} 个模板 ✅`, 'success');
            else alert(`成功导入 ${imported} 个模板 ✅`);
            _refreshTemplateList();
        }
    };
    input.click();
}

/**
 * 一键导出所有模板
 */
async function _exportAllTemplates() {
    try {
        if (typeof showToast === 'function') showToast('正在准备导出，请稍候...', 'info');
        
        // 1. 获取列表
        const listResp = await apiFetch(`${API_BASE}/templates/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const listParsed = await listResp.json();
        const templatesList = listParsed.data || listParsed || [];
        
        if (templatesList.length === 0) {
            if (typeof showToast === 'function') showToast('没有可导出的模板', 'warning');
            return;
        }

        const fullTemplates = [];
        // 2. 循环获取详情
        for (const tpl of templatesList) {
            const resp = await apiFetch(`${API_BASE}/templates/get`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: tpl.id }),
            });
            const result = await resp.json();
            const tplData = result.data || result;
            
            fullTemplates.push({
                name: tplData.name,
                description: tplData.description || '',
                thumbnail: tplData.thumbnail || '',
                tags: tplData.tags || [],
                createdAt: tplData.createdAt,
                projectData: tplData.projectData,
            });
        }

        // 3. 构建合集并导出
        const exportObj = {
            _format: 'videokit-template-collection',
            _version: 1,
            exportedAt: Date.now(),
            count: fullTemplates.length,
            templates: fullTemplates
        };

        const jsonStr = JSON.stringify(exportObj, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        a.download = `所有模板_${dateStr}_(${fullTemplates.length}个).vktpl`;
        a.click();
        URL.revokeObjectURL(url);

        if (typeof showToast === 'function') showToast(`成功导出 ${fullTemplates.length} 个模板`, 'success');
    } catch (e) {
        if (typeof showToast === 'function') showToast('全部导出失败: ' + e.message, 'error');
        else alert('全部导出失败: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════
// 5. 启动时自动检测 hash 参数加载模板
// ═══════════════════════════════════════════════════════

function _checkHashForTemplate() {
    const hash = window.location.hash; // e.g. #template=tpl_xxxxx
    const match = hash.match(/template=([^&]+)/);
    if (!match) return;

    const templateId = match[1];
    console.log('[Template] 检测到 URL hash 模板参数:', templateId);

    // 等 DOM 和 app 初始化完成后加载
    const tryLoad = () => {
        if (typeof ReelsProject === 'undefined' || typeof apiFetch === 'undefined') {
            setTimeout(tryLoad, 200);
            return;
        }
        _loadTemplateInCurrentWindow(templateId);
    };

    // 延迟执行，确保 app.js 已经初始化
    setTimeout(tryLoad, 500);
}

// DOM 加载后检测
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _checkHashForTemplate);
} else {
    _checkHashForTemplate();
}
