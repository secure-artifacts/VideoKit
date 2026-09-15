/**
 * ReelsGradientPicker - 多色自定义文字渐变拾色组件
 * 支持 2 个、3 个、4 个甚至任意多个颜色节点的自由增删、改色、方向控制与流行预设
 */

const ReelsGradientPresets = [
    { name: '红橙暖阳', colors: ['#FF2A85', '#FF9F21'] },
    { name: '赛博霓虹', colors: ['#FF0080', '#7928CA', '#00DFD8'] },
    { name: '黑金炫彩', colors: ['#FFE259', '#FFA751', '#FF6B35'] },
    { name: '极光薄荷', colors: ['#00F260', '#0575E6'] },
    { name: '暮色魅紫', colors: ['#8E2DE2', '#4A00E0', '#F000FF'] },
    { name: '日出金光', colors: ['#F12711', '#F5AF19'] },
    { name: '冰晶蓝白', colors: ['#FFFFFF', '#70A1FF', '#1E90FF'] },
    { name: '幻彩极光', colors: ['#FF0055', '#FFAA00', '#00FFAA', '#00AAFF'] }
];

class ReelsGradientPicker {
    /**
     * @param {Object} options
     * @param {string} options.value 当前颜色值（单色或逗号多色，例如 "#FF0080,#7928CA,#00DFD8"）
     * @param {string} options.direction 'vertical' | 'horizontal' | 'diagonal'
     * @param {Function} options.onChange 回调函数 ({ value, direction, isGradient, colors }) => void
     * @param {string} options.title 弹窗或面板标题
     */
    constructor(options = {}) {
        this.options = Object.assign({
            value: '#FFFFFF',
            direction: 'horizontal',
            title: '文字渐变色配置',
            onChange: () => {}
        }, options);

        this.colors = this._parseColors(this.options.value);
        this.direction = this.options.direction || 'horizontal';
        this.isGradient = this.colors.length > 1;
        if (this.colors.length === 0) this.colors = ['#FFFFFF', '#FFD700'];

        this.container = null;
        this.overlayEl = null;
    }

    _parseColors(val) {
        if (!val || typeof val !== 'string') return ['#FFFFFF'];
        const parts = val.split(',').map(c => c.trim()).filter(Boolean);
        const valid = parts.filter(c => /^#[0-9a-fA-F]{3,8}$/.test(c) || /^rgba?/i.test(c));
        return valid.length > 0 ? valid : ['#FFFFFF'];
    }

    _formatValue() {
        return this.isGradient ? this.colors.join(',') : (this.colors[0] || '#FFFFFF');
    }

    _getLinearGradientCss() {
        const angle = this.direction === 'horizontal' ? 'to right' : (this.direction === 'diagonal' ? '135deg' : 'to bottom');
        if (!this.isGradient || this.colors.length < 2) {
            return this.colors[0] || '#FFFFFF';
        }
        return `linear-gradient(${angle}, ${this.colors.join(', ')})`;
    }

    /**
     * 便捷静态调用方法：实例化并立即打开浮窗
     * @param {Object} options
     * @returns {ReelsGradientPicker}
     */
    static open(options = {}) {
        if (ReelsGradientPicker._activeInstance) {
            try { ReelsGradientPicker._activeInstance.close(); } catch (e) {}
        }
        const picker = new ReelsGradientPicker(options);
        ReelsGradientPicker._activeInstance = picker;
        picker.open(options.anchorEl);
        return picker;
    }

    /**
     * 打开模态弹窗式编辑器
     * @param {HTMLElement} anchorEl 触发按钮元素（用于定位或居中）
     */
    open(anchorEl = null) {
        this.close();

        const overlay = document.createElement('div');
        overlay.className = 'rgp-modal-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.55); z-index: 999999;
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(2px);
        `;

        const modal = document.createElement('div');
        modal.className = 'rgp-modal-card';
        modal.style.cssText = `
            background: #1e1e2d; color: #f1f5f9; width: 340px; max-width: 90vw;
            border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            border: 1px solid #334155; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px; box-sizing: border-box;
        `;

        this.modalEl = modal;
        this.overlayEl = overlay;

        this._renderUI();

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        // 绑定 Esc 关闭
        this._escListener = (e) => {
            if (e.key === 'Escape') this.close();
        };
        window.addEventListener('keydown', this._escListener);
    }

    close() {
        if (ReelsGradientPicker._activeInstance === this) {
            ReelsGradientPicker._activeInstance = null;
        }
        if (this._escListener) {
            window.removeEventListener('keydown', this._escListener);
            this._escListener = null;
        }
        if (this.overlayEl && this.overlayEl.parentNode) {
            this.overlayEl.parentNode.removeChild(this.overlayEl);
        }
        this.overlayEl = null;
        this.modalEl = null;
    }

    _renderUI() {
        if (!this.modalEl) return;
        const gradCss = this._getLinearGradientCss();

        this.modalEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                <div style="font-weight:700; font-size:14px; display:flex; align-items:center; gap:6px;">
                    <span>🌈</span> <span>${this.options.title || '自定义文字渐变'}</span>
                </div>
                <button type="button" class="rgp-close-btn" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer; padding:2px 6px;">✕</button>
            </div>

            <!-- 模式切换 -->
            <div style="display:flex; gap:8px; margin-bottom:14px; background:#0f172a; padding:3px; border-radius:6px; border:1px solid #334155;">
                <button type="button" class="rgp-mode-btn ${!this.isGradient ? 'active' : ''}" data-mode="solid" style="flex:1; padding:5px 0; border:none; border-radius:4px; font-size:12px; cursor:pointer; background:${!this.isGradient ? '#3b82f6' : 'transparent'}; color:#fff; font-weight:${!this.isGradient ? '700' : 'normal'};">纯色模式</button>
                <button type="button" class="rgp-mode-btn ${this.isGradient ? 'active' : ''}" data-mode="gradient" style="flex:1; padding:5px 0; border:none; border-radius:4px; font-size:12px; cursor:pointer; background:${this.isGradient ? 'linear-gradient(135deg, #ec4899, #8b5cf6)' : 'transparent'}; color:#fff; font-weight:${this.isGradient ? '700' : 'normal'};">多色渐变</button>
            </div>

            <!-- 渐变效果实时预览（真正呈现于文字本身） -->
            <div style="margin-bottom:14px;">
                <div style="font-size:11px; color:#94a3b8; margin-bottom:5px; display:flex; justify-content:space-between; align-items:center;">
                    <span>文字效果预览：</span>
                    <span class="rgp-preview-code" style="font-family:monospace; font-size:11px; color:#cbd5e1; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this._formatValue()}</span>
                </div>
                <div class="rgp-preview-box" style="height:48px; border-radius:8px; background:#0b0f19; border:1px solid #334155; display:flex; align-items:center; justify-content:center; box-shadow:inset 0 2px 6px rgba(0,0,0,0.5); overflow:hidden; padding:0 10px;">
                    <span class="rgp-preview-text" style="font-weight:900; font-size:22px; letter-spacing:1px; display:inline-block; font-family:system-ui, -apple-system, BlinkMacSystemFont, sans-serif; white-space:nowrap;">
                        文字渐变效果 TEXT
                    </span>
                </div>
                <div class="rgp-preview-strip" style="height:4px; border-radius:2px; margin-top:5px; box-shadow:0 1px 2px rgba(0,0,0,0.3);"></div>
            </div>

            <!-- 渐变颜色节点管理（仅在渐变模式下展开） -->
            ${this.isGradient ? `
            <div style="margin-bottom:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <span style="font-size:12px; font-weight:600; color:#cbd5e1;">颜色节点 (${this.colors.length}色)：</span>
                    <button type="button" class="rgp-add-stop-btn" style="padding:2px 8px; font-size:11px; background:#2563eb; border:none; border-radius:4px; color:#fff; cursor:pointer; font-weight:600;">+ 添加节点</button>
                </div>
                <div class="rgp-stops-list" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:#0f172a; padding:8px; border-radius:6px; border:1px solid #334155;">
                    ${this.colors.map((c, i) => `
                        <div class="rgp-stop-item" style="display:inline-flex; align-items:center; gap:3px; background:#1e293b; padding:2px 4px; border-radius:6px; border:1px solid #475569;">
                            <span style="font-size:10px; color:#94a3b8; font-weight:bold;">#${i + 1}</span>
                            <input type="color" class="rgp-stop-color" data-index="${i}" value="${c.length === 7 ? c : (c.length === 4 ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : '#ffffff')}" style="width:26px; height:24px; border:none; cursor:pointer; background:none; padding:0;">
                            ${this.colors.length > 2 ? `<button type="button" class="rgp-del-stop-btn" data-index="${i}" title="删除该颜色点" style="background:none; border:none; color:#f87171; cursor:pointer; font-size:12px; padding:0 3px; font-weight:bold;">×</button>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- 方向控制 -->
            <div style="margin-bottom:14px; display:flex; align-items:center; gap:8px;">
                <label style="font-size:12px; color:#cbd5e1; white-space:nowrap;">渐变方向：</label>
                <select class="rgp-direction-select" style="flex:1; background:#0f172a; color:#f1f5f9; border:1px solid #334155; padding:4px 8px; border-radius:4px; font-size:12px;">
                    <option value="horizontal" ${this.direction === 'horizontal' ? 'selected' : ''}>↔ 水平渐变（左右流光，默认推荐）</option>
                    <option value="vertical" ${this.direction === 'vertical' ? 'selected' : ''}>↕ 垂直渐变（字顶至字底，立体感强）</option>
                    <option value="diagonal" ${this.direction === 'diagonal' ? 'selected' : ''}>⤡ 对角渐变（45° 光泽感）</option>
                </select>
            </div>

            <!-- 爆款渐变预设 -->
            <div style="margin-bottom:14px;">
                <div style="font-size:11px; color:#94a3b8; margin-bottom:6px;">经典爆款预设（点击即套用）：</div>
                <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:6px;">
                    ${ReelsGradientPresets.map(preset => `
                        <button type="button" class="rgp-preset-chip" data-colors="${preset.colors.join(',')}" style="padding:4px 2px; font-size:11px; border:1px solid #475569; border-radius:4px; background:#0f172a; color:#f8fafc; cursor:pointer; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${preset.name}: ${preset.colors.join(', ')}">
                            <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:linear-gradient(to bottom, ${preset.colors.join(', ')}); margin-right:3px; vertical-align:middle;"></span>${preset.name}
                        </button>
                    `).join('')}
                </div>
            </div>
            ` : `
            <!-- 纯色拾色器 -->
            <div style="margin-bottom:16px; display:flex; align-items:center; gap:12px; background:#0f172a; padding:10px; border-radius:6px; border:1px solid #334155;">
                <label style="font-size:12px; color:#cbd5e1;">当前纯色：</label>
                <input type="color" class="rgp-solid-color" value="${this.colors[0] || '#ffffff'}" style="width:36px; height:30px; border:none; cursor:pointer; background:none;">
                <input type="text" class="rgp-solid-text" value="${this.colors[0] || '#ffffff'}" style="width:85px; background:#1e293b; border:1px solid #475569; color:#fff; padding:4px 6px; border-radius:4px; font-family:monospace; font-size:12px;">
            </div>
            `}

            <!-- 底部确认按钮 -->
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                <button type="button" class="rgp-confirm-btn" style="background:linear-gradient(135deg, #3b82f6, #2563eb); border:none; color:#fff; padding:6px 18px; border-radius:6px; cursor:pointer; font-weight:700; font-size:12px;">完成</button>
            </div>
        `;

        this._updatePreviewBar();
        this._bindEvents();
    }

    _bindEvents() {
        if (!this.modalEl) return;

        // 关闭
        this.modalEl.querySelector('.rgp-close-btn')?.addEventListener('click', () => this.close());
        this.modalEl.querySelector('.rgp-confirm-btn')?.addEventListener('click', () => this.close());

        // 模式切换
        this.modalEl.querySelectorAll('.rgp-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                this.isGradient = (mode === 'gradient');
                if (this.isGradient && this.colors.length < 2) {
                    this.colors = ['#FF2A85', '#FF9F21'];
                }
                this._renderUI();
                this._emitChange();
            });
        });

        // 纯色修改
        const solidColor = this.modalEl.querySelector('.rgp-solid-color');
        const solidText = this.modalEl.querySelector('.rgp-solid-text');
        if (solidColor) {
            solidColor.addEventListener('input', (e) => {
                this.colors = [e.target.value];
                if (solidText) solidText.value = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        }
        if (solidText) {
            solidText.addEventListener('change', (e) => {
                let v = e.target.value.trim();
                if (!v.startsWith('#')) v = '#' + v;
                if (/^#[0-9a-fA-F]{6}$/.test(v)) {
                    this.colors = [v];
                    if (solidColor) solidColor.value = v;
                    this._updatePreviewBar();
                    this._emitChange();
                }
            });
        }

        // 添加颜色节点
        this.modalEl.querySelector('.rgp-add-stop-btn')?.addEventListener('click', () => {
            if (this.colors.length >= 8) return alert('最多支持 8 个颜色节点');
            const last = this.colors[this.colors.length - 1] || '#FFD700';
            this.colors.push(last);
            this._renderUI();
            this._emitChange();
        });

        // 删除颜色节点
        this.modalEl.querySelectorAll('.rgp-del-stop-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                if (this.colors.length > 2) {
                    this.colors.splice(idx, 1);
                    this._renderUI();
                    this._emitChange();
                }
            });
        });

        // 修改节点颜色
        this.modalEl.querySelectorAll('.rgp-stop-color').forEach(input => {
            input.addEventListener('input', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                this.colors[idx] = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        });

        // 方向改变
        const dirSelect = this.modalEl.querySelector('.rgp-direction-select');
        if (dirSelect) {
            dirSelect.addEventListener('change', (e) => {
                this.direction = e.target.value;
                this._updatePreviewBar();
                this._emitChange();
            });
        }

        // 点击预设
        this.modalEl.querySelectorAll('.rgp-preset-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const raw = btn.dataset.colors;
                if (raw) {
                    this.colors = raw.split(',').map(c => c.trim());
                    this.isGradient = true;
                    this._renderUI();
                    this._emitChange();
                }
            });
        });
    }

    _applyPreviewStyle(textEl, stripEl) {
        if (!textEl) return;
        const gradCss = this._getLinearGradientCss();
        if (this.isGradient && this.colors.length >= 2) {
            textEl.style.backgroundImage = gradCss;
            textEl.style.webkitBackgroundClip = 'text';
            textEl.style.backgroundClip = 'text';
            textEl.style.webkitTextFillColor = 'transparent';
            textEl.style.color = 'transparent';
        } else {
            const solidColor = this.colors[0] || '#FFFFFF';
            textEl.style.backgroundImage = 'none';
            textEl.style.webkitBackgroundClip = '';
            textEl.style.backgroundClip = '';
            textEl.style.webkitTextFillColor = solidColor;
            textEl.style.color = solidColor;
        }
        if (stripEl) {
            stripEl.style.background = gradCss;
        }
    }

    _updatePreviewBar() {
        const textEl = this.modalEl?.querySelector('.rgp-preview-text');
        const stripEl = this.modalEl?.querySelector('.rgp-preview-strip');
        const codeEl = this.modalEl?.querySelector('.rgp-preview-code');
        if (codeEl) {
            codeEl.textContent = this._formatValue();
        }
        this._applyPreviewStyle(textEl, stripEl);
    }

    _emitChange() {
        if (typeof this.options.onChange === 'function') {
            this.options.onChange({
                value: this._formatValue(),
                direction: this.direction,
                isGradient: this.isGradient,
                colors: [...this.colors]
            });
        }
    }
}

// 导出全局组件供浏览器各模块直接调用
if (typeof window !== 'undefined') {
    window.ReelsGradientPicker = ReelsGradientPicker;
    window.ReelsGradientPresets = ReelsGradientPresets;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReelsGradientPicker, ReelsGradientPresets };
}
