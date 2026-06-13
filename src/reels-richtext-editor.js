/**
 * reels-richtext-editor.js — 浮动富文本编辑器 UI 组件
 *
 * 依赖: ReelsRichText (reels-rich-text.js)
 * 依赖: document
 */

class ReelsRichTextEditor {
    constructor() {
        this.popup = null;
        this.editorEl = null;

        // 当前编辑的数据
        this.initialText = '';
        this.ranges = [];
        this.baseStyle = {
            fontsize: 80,
            color: '#FFFFFF'
        };
        this.styleOverride = {};

        // 回调
        this.onSave = null;
        this.onCancel = null;
        this.onChange = null;

        // DOM state
        this._isClosing = false;
        this._selectionRange = null; // 原生 Range
        this._savedStart = 0;
        this._savedEnd = 0;
    }

    /**
     * 在指定位置打开编辑器
     */
    open(options) {
        const { title, text, styled_ranges, style_override, baseStyle, rect, trackIdx, clipIdx } = options;

        this.initialText = text || '';
        this.ranges = (styled_ranges || []).map(r => ({...r}));
        if (baseStyle) this.baseStyle = { ...this.baseStyle, ...baseStyle };
        this.styleOverride = style_override ? { ...style_override } : {};

        this._injectStyles();
        this._createUI(title, rect);
        this._renderContent();

        // 绑定事件
        this._bindEvents();

        // 默认全选
        requestAnimationFrame(() => {
            if (!this.editorEl) return;
            this.editorEl.focus();
            const documentRange = document.createRange();
            documentRange.selectNodeContents(this.editorEl);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(documentRange);
            this._saveSelectionRange();
            this._updateToolbarState();
        });
    }

    close(save = false) {
        if (!this.popup || this._isClosing) return;
        this._isClosing = true;

        if (save && this.onSave) {
            const result = this._extractData();
            this.onSave(result.text, result.styled_ranges, result.style_override);
        } else if (!save && this.onCancel) {
            this.onCancel();
        }

        // 清理选区监听
        document.removeEventListener('selectionchange', this._onSelectionChangeWrapper);

        this.popup.classList.add('rte-se-closing');
        setTimeout(() => {
            if (this.popup && this.popup.parentNode) {
                this.popup.parentNode.removeChild(this.popup);
            }
            this.popup = null;
            this.editorEl = null;
            this._isClosing = false;
        }, 150);
    }

    applyStyleToSelection(styleObj) {
        const selInfo = { start: this._savedStart, end: this._savedEnd };
        if (selInfo.start >= selInfo.end) return;

        // 调用业务逻辑
        this.ranges = ReelsRichText.applyStyle(this.ranges, selInfo.start, selInfo.end, styleObj);

        // 重新渲染，并恢复选区
        this._renderContent();
        this._restoreSelection(selInfo.start, selInfo.end);
        
        this._emitChange();
    }

    removeStyleFromSelection(keys) {
        const selInfo = { start: this._savedStart, end: this._savedEnd };
        if (selInfo.start >= selInfo.end) return;

        this.ranges = ReelsRichText.removeStyle(this.ranges, selInfo.start, selInfo.end, keys);

        this._renderContent();
        this._restoreSelection(selInfo.start, selInfo.end);

        this._emitChange();
    }

    // ═══════════════════════════════════════════════
    // 注入 CSS 样式（仅注入一次）
    // ═══════════════════════════════════════════════

    _injectStyles() {
        if (document.getElementById('rte-richtext-styles')) return;
        const style = document.createElement('style');
        style.id = 'rte-richtext-styles';
        style.textContent = `
            .rte-subtitle-editor {
                position: fixed;
                z-index: 99990;
                background: #1a1a2e;
                border: 1px solid #444;
                border-radius: 12px;
                box-shadow: 0 12px 48px rgba(0,0,0,0.65);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                overflow-y: auto;
                font-family: system-ui, -apple-system, sans-serif;
                animation: rteSlideIn 0.15s ease-out;
                transition: opacity 0.15s ease-in-out;
            }

            .rte-subtitle-editor input[type="number"] {
                -moz-appearance: textfield;
                appearance: textfield;
                text-align: center;
                padding: 0 !important;
                box-sizing: border-box;
            }
            .rte-subtitle-editor input[type="number"]::-webkit-outer-spin-button,
            .rte-subtitle-editor input[type="number"]::-webkit-inner-spin-button {
                -webkit-appearance: none;
                display: none;
                margin: 0;
            }
            .rte-subtitle-editor.rte-se-closing {
                animation: rteSlideOut 0.15s ease-in forwards;
            }
            @keyframes rteSlideIn {
                from { opacity:0; transform: translateY(8px) scale(0.96); }
                to   { opacity:1; transform: translateY(0) scale(1); }
            }
            @keyframes rteSlideOut {
                from { opacity:1; transform: scale(1); }
                to   { opacity:0; transform: scale(0.95); }
            }
            .rte-se-header {
                display: flex;
                align-items: center;
                padding: 8px 12px;
                background: #16162b;
                border-bottom: 1px solid #333;
                cursor: move;
            }
            .rte-se-title {
                flex: 1;
                font-size: 13px;
                font-weight: 600;
                color: #ccc;
            }
            .rte-se-time {
                font-size: 11px;
                color: #888;
                margin-right: 8px;
            }
            .rte-se-close {
                width: 24px; height: 24px;
                border: none;
                background: transparent;
                color: #888;
                font-size: 14px;
                cursor: pointer;
                border-radius: 4px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .rte-se-close:hover { background: #ff4444; color: #fff; }

            .rte-se-toolbar {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 6px 10px;
                background: #1e1e36;
                border-bottom: 1px solid #333;
                flex-wrap: wrap;
            }
            .rt-btn {
                min-width: 30px;
                height: 28px;
                border: 1px solid #555;
                background: #2a2a44;
                color: #ddd;
                border-radius: 5px;
                cursor: pointer;
                font-size: 13px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.12s;
            }
            .rt-btn:hover { background: #3a3a5a; border-color: #777; }
            .rt-btn.active { background: #5b6abf; border-color: #7b8bef; color: #fff; }

            .rt-divider {
                width: 1px;
                height: 20px;
                background: #444;
                margin: 0 2px;
            }
            .rt-select {
                height: 28px;
                border: 1px solid #555;
                background: #2a2a44;
                color: #eee;
                border-radius: 5px;
                font-size: 12px;
                padding: 0 6px;
                cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
            }
            .rt-select:hover { background: #323254; border-color: #777; }
            .rt-select:focus { border-color: #7b8bef; outline: none; background: #25253c; color: #fff; }

            .rt-color-picker {
                width: 32px;
                height: 28px;
                border: 1px solid #555;
                background: #2a2a44;
                border-radius: 5px;
                cursor: pointer;
                padding: 1px;
            }
            .rt-color-picker::-webkit-color-swatch-wrapper { padding: 2px; }
            .rt-color-picker::-webkit-color-swatch { border-radius: 3px; border: none; }

            .rte-se-contenteditable {
                min-height: 80px;
                max-height: 200px;
                overflow-y: auto;
                padding: 12px 14px;
                outline: none;
                line-height: 1.6;
                word-break: break-word;
                white-space: pre-wrap;
            }
            .rte-se-contenteditable:focus {
                background: rgba(255,255,255,0.03);
            }
            .rte-se-contenteditable::selection {
                background: rgba(91,106,191,0.4);
            }

            .rte-se-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: #16162b;
                border-top: 1px solid #333;
            }
            .rte-se-hint {
                font-size: 11px;
                color: #666;
            }
            .rte-se-save {
                padding: 5px 16px;
                border: none;
                background: #5b6abf;
                color: #fff;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                transition: background 0.15s;
            }
            .rte-se-save:hover { background: #6b7acf; }
            .rte-se-label {
                font-size: 11px;
                color: #a8a8c0;
                white-space: nowrap;
            }
            .rte-se-stylebar {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 10px;
                background: #19192f;
                border-bottom: 1px solid #333;
                flex-wrap: wrap;
            }
            .rte-tool-group {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                flex: 0 0 auto;
                white-space: nowrap;
            }
            .rte-tool-group .rte-se-label { margin-right: 2px; }
        `;
        document.head.appendChild(style);
    }

    _createUI(title, rect) {
        this.popup = document.createElement('div');
        this.popup.className = 'rte-subtitle-editor reels-rich-editor';

        this.popup.innerHTML = `
            <div class="rte-se-header">
                <span class="rte-se-title">${title}</span>
                <span class="rte-se-time"></span>
                <button class="rte-se-close" title="关闭">✕</button>
            </div>
            <div class="rte-se-stylebar">
                <div class="rte-tool-group">
                    <span class="rte-se-label">整句/标题</span>
                    <select class="rt-select rt-sel-preset" title="给当前字幕块套用一个独立字幕预设" style="width:120px;">
                        <option value="">独立预设</option>
                    </select>
                </div>
                <div class="rte-tool-group">
                    <button class="rt-btn rt-se-bold" title="整句加粗"><b>B</b></button>
                    <button class="rt-btn rt-se-italic" title="整句斜体"><i>I</i></button>
                </div>
                <div class="rte-tool-group">
                    <select id="rt-se-font" class="rt-select rt-se-font" title="整句字体" style="width:120px;">
                        <option value="">字体</option>
                    </select>
                    <select class="rt-select rt-se-weight" title="整句字重" style="width:78px;">
                        <option value="">字重</option>
                    </select>
                    <select class="rt-select rt-se-size" title="整句字号" style="width:76px;">
                        <option value="">字号</option>
                        <option value="24">24</option>
                        <option value="32">32</option>
                        <option value="40">40</option>
                        <option value="50">50</option>
                        <option value="60">60</option>
                        <option value="72">72</option>
                        <option value="80">80</option>
                        <option value="96">96</option>
                        <option value="100">100</option>
                        <option value="120">120</option>
                        <option value="150">150</option>
                        <option value="200">200</option>
                    </select>
                </div>
                <div class="rte-tool-group">
                    <input type="color" class="rt-color-picker rt-se-text-color" title="整段文字颜色" value="#ffffff">
                    <input type="color" class="rt-color-picker rt-se-box-color" title="整段背景颜色" value="#000000">
                    <span class="rte-se-label">透明度</span>
                    <input type="number" class="rt-select rt-se-box-opacity" title="背景透明度 0-255，0=无背景，255=完全不透明" min="0" max="255" step="1" style="width:54px;" placeholder="0" value="0">
                </div>
                <div class="rte-tool-group">
                    <input type="color" class="rt-color-picker rt-se-outline-color" title="整段描边颜色" value="#000000">
                    <select class="rt-select rt-se-outline-width" title="整段描边宽度" style="width:62px;">
                        <option value="0">无边</option>
                        <option value="2">2px</option>
                        <option value="4">4px</option>
                        <option value="6">6px</option>
                        <option value="8">8px</option>
                        <option value="10">10px</option>
                    </select>
                </div>
                <div class="rte-tool-group">
                    <span class="rte-se-label">位置</span>
                    <input type="number" class="rt-select rt-se-pos-x" title="当前字幕块水平位置，百分比 0-100" min="0" max="100" step="1" style="width:62px;" placeholder="X%">
                    <input type="number" class="rt-select rt-se-pos-y" title="当前字幕块垂直位置，百分比 0-100" min="0" max="100" step="1" style="width:62px;" placeholder="Y%">
                    <button class="rt-btn rt-se-clear-style" title="清除这个字幕块的独立样式">↺</button>
                </div>
                <div class="rte-tool-group">
                    <span class="rte-se-label">字符间距</span>
                    <input type="number" class="rt-select rt-se-letter-spacing" title="字符间距，支持鼠标左右拖拽" min="-20" max="100" step="1" style="width:54px;" placeholder="0">
                    <span class="rte-se-label">词间距</span>
                    <input type="number" class="rt-select rt-se-word-spacing" title="单词间距，支持鼠标左右拖拽" min="-20" max="200" step="1" style="width:54px;" placeholder="0">
                </div>
                <div class="rte-tool-group">
                    <span class="rte-se-label">底色边距</span>
                    <input type="number" class="rt-select rt-se-pad-top" title="上边距，支持鼠标左右拖拽" min="0" max="200" step="1" style="width:48px;" placeholder="上">
                    <input type="number" class="rt-select rt-se-pad-bottom" title="下边距，支持鼠标左右拖拽" min="0" max="200" step="1" style="width:48px;" placeholder="下">
                    <input type="number" class="rt-select rt-se-pad-left" title="左边距，支持鼠标左右拖拽" min="0" max="200" step="1" style="width:48px;" placeholder="左">
                    <input type="number" class="rt-select rt-se-pad-right" title="右边距，支持鼠标左右拖拽" min="0" max="200" step="1" style="width:48px;" placeholder="右">
                    <span class="rte-se-label">圆角</span>
                    <input type="number" class="rt-select rt-se-box-radius" title="背景圆角弧度，支持鼠标左右拖拽" min="0" max="200" step="1" style="width:48px;" placeholder="8">
                </div>
            </div>
            <div class="rte-se-toolbar">
                <div class="rte-tool-group">
                    <span class="rte-se-label">选中文字</span>
                    <button class="rt-btn rt-btn-bold" data-cmd="bold" title="粗体"><b>B</b></button>
                    <button class="rt-btn rt-btn-italic" data-cmd="italic" title="斜体"><i>I</i></button>
                </div>
                <div class="rte-tool-group">
                    <select id="rt-sel-font" class="rt-select rt-sel-font" title="字体" style="width:120px;">
                        <option value="">字体</option>
                    </select>
                    <select class="rt-select rt-sel-weight" title="字重" style="width:78px;">
                        <option value="">字重</option>
                    </select>
                    <select class="rt-select rt-sel-size" title="字号">
                        <option value="">字号</option>
                        <option value="24">极小(24)</option>
                        <option value="32">微小(32)</option>
                        <option value="40">超小(40)</option>
                        <option value="50">小(50)</option>
                        <option value="60">较小(60)</option>
                        <option value="72">中(72)</option>
                        <option value="80">正常(80)</option>
                        <option value="96">较大(96)</option>
                        <option value="100">大(100)</option>
                        <option value="120">超大(120)</option>
                        <option value="150">巨大(150)</option>
                        <option value="200">极巨(200)</option>
                    </select>
                </div>
                <div class="rte-tool-group">
                    <input type="color" class="rt-color-picker rt-sel-color" title="文字颜色" value="#ff0000">
                    <input type="color" class="rt-color-picker rt-stroke-color" title="描边颜色" value="#000000">
                    <select class="rt-select rt-sel-stroke" title="描边宽度" style="width:56px;">
                        <option value="">描边</option>
                        <option value="0">无</option>
                        <option value="1">1px</option>
                        <option value="2">2px</option>
                        <option value="3">3px</option>
                        <option value="4">4px</option>
                        <option value="6">6px</option>
                        <option value="8">8px</option>
                    </select>
                </div>
                <div class="rte-tool-group">
                    <button class="rt-btn rt-btn-clear" data-cmd="clear" title="清除样式">✕</button>
                </div>
            </div>
            <div class="rte-se-contenteditable" contenteditable="true" spellcheck="false"
                 style="font-family: system-ui, sans-serif; font-size: 24px; color: ${this.baseStyle.color || '#fff'};">
            </div>
            <div class="rte-se-footer">
                <span class="rte-se-hint">Ctrl+Enter 保存 · Esc 取消</span>
                <button class="rte-se-save">✓ 保存</button>
            </div>
        `;

        // 布局定位 — 停靠在视口底部，不遮挡预览画面
        const popupW = Math.max(480, Math.min(680, (rect?.w || 300) + 220));

        // 尝试获取预览区域右边界，让编辑器定位到预览右侧
        const previewViewport = document.getElementById('reels-preview-viewport');
        const previewRect = previewViewport ? previewViewport.getBoundingClientRect() : null;

        let popupX, popupY;

        if (previewRect && previewRect.right + popupW + 8 < window.innerWidth) {
            // 有足够空间放在预览右侧
            popupX = previewRect.right + 8;
            popupY = previewRect.top;
        } else {
            // 退而求其次：放在窗口底部居中，不挡住预览
            popupX = Math.max(4, (window.innerWidth - popupW) / 2);
            popupY = window.innerHeight - 4; // 先设一个临时值，append 后再算
        }

        if (popupX + popupW > window.innerWidth - 4) popupX = window.innerWidth - popupW - 4;
        if (popupX < 4) popupX = 4;

        this.popup.style.left = `${popupX}px`;
        this.popup.style.width = `${popupW}px`;

        // 使用 bottom 定位：贴在视口底部，不覆盖上方的预览
        if (previewRect && previewRect.right + popupW + 8 < window.innerWidth) {
            this.popup.style.top = `${popupY}px`;
            this.popup.style.bottom = 'auto';
            this.popup.style.maxHeight = `${window.innerHeight - popupY - 8}px`;
        } else {
            this.popup.style.top = 'auto';
            this.popup.style.bottom = '4px';
            this.popup.style.maxHeight = '50vh';
        }

        document.body.appendChild(this.popup);
        this.editorEl = this.popup.querySelector('.rte-se-contenteditable');
        this._populatePresetSelect();
        this._initFontSelects();
        this._syncStyleControlsFromOverride();
        this._applyEditorPreviewStyle();
    }

    _effectiveBaseStyle() {
        const o = this.styleOverride || {};
        return {
            ...this.baseStyle,
            ...o,
            color: o.color || o.color_text || this.baseStyle.color || this.baseStyle.color_text || '#FFFFFF',
        };
    }

    _populatePresetSelect() {
        const sel = this.popup && this.popup.querySelector('.rt-sel-preset');
        if (!sel || !window.ReelsStyleEngine || typeof ReelsStyleEngine.loadSubtitlePresets !== 'function') return;
        try {
            const data = ReelsStyleEngine.loadSubtitlePresets();
            Object.keys(data.presets || {}).forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                sel.appendChild(opt);
            });
            if (this.styleOverride && this.styleOverride._subtitle_preset) {
                sel.value = this.styleOverride._subtitle_preset;
            }
        } catch (e) {
            console.warn('[RichTextEditor] load presets failed:', e);
        }
    }

    _initFontSelects() {
        const fillBasic = (sel, currentValue = '') => {
            if (!sel || sel.dataset.rteFontsReady === '1') return;
            const fonts = (typeof getFontManager === 'function' && getFontManager().getAllFonts)
                ? getFontManager().getAllFonts()
                : ['Arial', 'Helvetica', 'Impact', 'Georgia', 'Times New Roman', 'Noto Sans SC', 'Microsoft YaHei'];
            const seen = new Set(Array.from(sel.options || []).map(o => o.value).filter(Boolean));
            for (const f of fonts) {
                const family = f.family || f.name || f;
                if (!family || seen.has(family)) continue;
                seen.add(family);
                const opt = document.createElement('option');
                opt.value = family;
                opt.textContent = family;
                sel.appendChild(opt);
            }
            sel.dataset.rteFontsReady = '1';
            if (currentValue) sel.value = currentValue;
        };

        const segmentFont = this.popup.querySelector('.rt-se-font');
        const selectionFont = this.popup.querySelector('.rt-sel-font');
        const segmentCurrent = this.styleOverride?.font_family || this.baseStyle.font_family || 'Arial';

        if (typeof getFontManager === 'function' && getFontManager().refreshFontSelect) {
            try {
                getFontManager().refreshFontSelect('rt-se-font', segmentCurrent);
                getFontManager().refreshFontSelect('rt-sel-font', segmentCurrent);
            } catch (e) {
                console.warn('[RichTextEditor] refreshFontSelect failed:', e);
                fillBasic(segmentFont, segmentCurrent);
                fillBasic(selectionFont);
            }
        } else {
            fillBasic(segmentFont, segmentCurrent);
            fillBasic(selectionFont);
        }

        this._refreshWeightSelect(this.popup.querySelector('.rt-se-weight'), segmentCurrent, this.styleOverride?.font_weight || this.baseStyle.font_weight || (this.styleOverride?.bold ? 700 : 400), !!(this.styleOverride?.italic || this.baseStyle.italic));
        this._refreshWeightSelect(this.popup.querySelector('.rt-sel-weight'), segmentCurrent, 700, false);
    }

    _refreshWeightSelect(select, fontFamily, currentValue = '700', preferItalic = false) {
        if (!select) return;
        const fallback = [
            { value: '100', label: 'Thin' },
            { value: '200', label: 'ExtraLight' },
            { value: '300', label: 'Light' },
            { value: '400', label: 'Regular' },
            { value: '500', label: 'Medium' },
            { value: '600', label: 'SemiBold' },
            { value: '700', label: 'Bold' },
            { value: '800', label: 'ExtraBold' },
            { value: '900', label: 'Black' },
        ];
        let entries = fallback;
        if (typeof getFontManager === 'function') {
            const fm = getFontManager();
            if (fm && typeof fm.getFontWeightEntries === 'function') {
                const list = fm.getFontWeightEntries(fontFamily || 'Arial', preferItalic ? 'italic' : 'normal');
                if (Array.isArray(list) && list.length > 0) {
                    entries = list.map(item => ({ value: String(item.value || '400'), label: String(item.label || item.value || '400') }));
                }
            } else if (fm && typeof fm.getFontWeightOptions === 'function') {
                const list = fm.getFontWeightOptions(fontFamily || 'Arial');
                if (Array.isArray(list) && list.length > 0) entries = list.map(v => ({ value: String(v), label: String(v) }));
            }
        }
        const current = String(currentValue || select.value || '700');
        const values = entries.map(x => x.value);
        select.innerHTML = `<option value="">字重</option>` + entries.map(x => `<option value="${x.value}">${x.label}</option>`).join('');
        if (values.includes(current)) select.value = current;
        else if (values.includes('700')) select.value = '700';
        else select.value = values[values.length - 1] || '';
    }

    _syncStyleControlsFromOverride() {
        if (!this.popup) return;
        const o = this.styleOverride || {};
        const textColor = this.popup.querySelector('.rt-se-text-color');
        const boxColor = this.popup.querySelector('.rt-se-box-color');
        const boxOpacity = this.popup.querySelector('.rt-se-box-opacity');
        const outlineColor = this.popup.querySelector('.rt-se-outline-color');
        const outlineWidth = this.popup.querySelector('.rt-se-outline-width');
        const segFont = this.popup.querySelector('.rt-se-font');
        const segWeight = this.popup.querySelector('.rt-se-weight');
        const segSize = this.popup.querySelector('.rt-se-size');
        const segBold = this.popup.querySelector('.rt-se-bold');
        const segItalic = this.popup.querySelector('.rt-se-italic');
        const posX = this.popup.querySelector('.rt-se-pos-x');
        const posY = this.popup.querySelector('.rt-se-pos-y');
        if (textColor) textColor.value = o.color_text || o.color || this.baseStyle.color_text || this.baseStyle.color || '#ffffff';
        if (boxColor) boxColor.value = o.color_bg || o.bg_color || '#000000';
        if (boxOpacity) boxOpacity.value = String(o.box_opacity ?? o.opacity_bg ?? 0);
        const seBoxRadius = this.popup.querySelector('.rt-se-box-radius');
        if (seBoxRadius) seBoxRadius.value = o.box_radius !== undefined ? String(o.box_radius) : '';
        if (outlineColor) outlineColor.value = o.color_outline || '#000000';
        if (outlineWidth) outlineWidth.value = String(o.border_width ?? 0);
        if (segFont) {
            const fontVal = o.font_family || this.baseStyle.font_family || segFont.value || '';
            segFont.value = fontVal;
            if (typeof getFontManager === 'function') {
                const fm = getFontManager();
                if (fm && typeof fm.refreshFontSelect === 'function') {
                    fm.refreshFontSelect('rt-se-font', fontVal);
                }
            }
        }
        if (segSize) segSize.value = String(o.fontsize || this.baseStyle.fontsize || '');
        const weight = Math.max(100, Math.min(900, parseInt(o.font_weight || (o.bold ? 700 : (this.baseStyle.font_weight || (this.baseStyle.bold ? 700 : 400))), 10) || 400));
        if (segWeight) {
            this._refreshWeightSelect(segWeight, segFont?.value || o.font_family || this.baseStyle.font_family || 'Arial', weight, !!(o.italic ?? this.baseStyle.italic));
        }
        if (segBold) segBold.classList.toggle('active', weight >= 600 || !!o.bold);
        if (segItalic) segItalic.classList.toggle('active', !!(o.italic ?? this.baseStyle.italic));
        if (posX) posX.value = this._stylePosToPercent(o.pos_x ?? this.baseStyle.pos_x ?? 0.5);
        if (posY) posY.value = this._stylePosToPercent(o.pos_y ?? this.baseStyle.pos_y ?? 0.85);

        const seLetterSpacing = this.popup.querySelector('.rt-se-letter-spacing');
        const sePadTop = this.popup.querySelector('.rt-se-pad-top');
        const sePadBottom = this.popup.querySelector('.rt-se-pad-bottom');
        const sePadLeft = this.popup.querySelector('.rt-se-pad-left');
        const sePadRight = this.popup.querySelector('.rt-se-pad-right');

        if (seLetterSpacing) seLetterSpacing.value = o.letter_spacing !== undefined ? String(o.letter_spacing) : '';
        const seWordSpacing = this.popup.querySelector('.rt-se-word-spacing');
        if (seWordSpacing) seWordSpacing.value = o.word_spacing !== undefined ? String(o.word_spacing) : '';
        if (sePadTop) sePadTop.value = o.box_padding_top !== undefined ? String(o.box_padding_top) : '';
        if (sePadBottom) sePadBottom.value = o.box_padding_bottom !== undefined ? String(o.box_padding_bottom) : '';
        if (sePadLeft) sePadLeft.value = o.box_padding_left !== undefined ? String(o.box_padding_left) : '';
        if (sePadRight) sePadRight.value = o.box_padding_right !== undefined ? String(o.box_padding_right) : '';
    }

    _applyEditorPreviewStyle() {
        if (!this.editorEl) return;
        const s = this._effectiveBaseStyle();
        this.editorEl.style.color = s.color_text || s.color || '#FFFFFF';
        this.editorEl.style.fontFamily = `"${s.font_family || 'system-ui'}", sans-serif`;
        const fs = Math.max(16, Math.min(42, ((parseFloat(s.fontsize) || 80) / 80) * 24));
        this.editorEl.style.fontSize = `${fs}px`;
        this.editorEl.style.fontWeight = String(s.font_weight || (s.bold ? 700 : 600));
        this.editorEl.style.fontStyle = s.italic ? 'italic' : '';
        const bgOpacity = parseInt(s.box_opacity ?? s.opacity_bg ?? 0, 10) || 0;
        this.editorEl.style.backgroundColor = bgOpacity > 0 ? this._hexToRgba(s.color_bg || s.bg_color || '#000000', Math.min(1, bgOpacity / 255)) : '';
        this.editorEl.style.borderRadius = bgOpacity > 0 ? `${s.box_radius || 4}px` : '';
        this.editorEl.style.webkitTextStroke = (s.use_stroke !== false && (parseFloat(s.border_width) || 0) > 0)
            ? `${Math.max(1, (parseFloat(s.border_width) || 0) / 2)}px ${s.color_outline || '#000000'}`
            : '';

        if (bgOpacity > 0) {
            const padLeft = s.box_padding_left !== undefined ? s.box_padding_left : (s.box_padding_x !== undefined ? s.box_padding_x : 12);
            const padRight = s.box_padding_right !== undefined ? s.box_padding_right : (s.box_padding_x !== undefined ? s.box_padding_x : 12);
            const padTop = s.box_padding_top !== undefined ? s.box_padding_top : (s.box_padding_y !== undefined ? s.box_padding_y : 8);
            const padBottom = s.box_padding_bottom !== undefined ? s.box_padding_bottom : (s.box_padding_y !== undefined ? s.box_padding_y : 8);
            
            const scale = fs / (parseFloat(s.fontsize) || 80);
            this.editorEl.style.paddingLeft = `${padLeft * scale}px`;
            this.editorEl.style.paddingRight = `${padRight * scale}px`;
            this.editorEl.style.paddingTop = `${padTop * scale}px`;
            this.editorEl.style.paddingBottom = `${padBottom * scale}px`;
        } else {
            this.editorEl.style.paddingLeft = '';
            this.editorEl.style.paddingRight = '';
            this.editorEl.style.paddingTop = '';
            this.editorEl.style.paddingBottom = '';
        }

        const lsVal = parseFloat(s.letter_spacing);
        if (Number.isFinite(lsVal)) {
            const scale = fs / (parseFloat(s.fontsize) || 80);
            this.editorEl.style.letterSpacing = `${lsVal * scale}px`;
        } else {
            this.editorEl.style.letterSpacing = '';
        }

        const wsVal = parseFloat(s.word_spacing);
        if (Number.isFinite(wsVal)) {
            const scale = fs / (parseFloat(s.fontsize) || 80);
            this.editorEl.style.wordSpacing = `${wsVal * scale}px`;
        } else {
            this.editorEl.style.wordSpacing = '';
        }
    }

    _renderContent() {
        if (!this.editorEl) return;
        
        // 渲染时将 text 和 ranges 结合成 html
        const effectiveBase = this._effectiveBaseStyle();
        const segments = ReelsRichText.splitByRanges(this.initialText, this.ranges, effectiveBase);
        
        let html = '';
        for (const seg of segments) {
            if (!seg.text) continue;
            let css = '';
            if (seg.style.bold) css += 'font-weight:bold;';
            if (seg.style.font_weight) css += `font-weight:${seg.style.font_weight};`;
            if (seg.style.italic) css += 'font-style:italic;';
            if (seg.style.color) css += `color:${seg.style.color};`;
            if (seg.style.font_family) css += `font-family:"${seg.style.font_family}",sans-serif;`;
            if (seg.style.fontsize) {
                const baseFs = effectiveBase.fontsize || 80;
                const ratio = seg.style.fontsize / baseFs;
                css += `font-size:${Math.max(12, 24 * ratio)}px;`;
            }
            if (seg.style.bg_color) css += `background-color:${seg.style.bg_color};`;
            if (seg.style.color_outline && seg.style.border_width > 0) {
                css += `-webkit-text-stroke:${seg.style.border_width}px ${seg.style.color_outline};`;
            }
            
            const textHTML = this._escapeHtml(seg.text);
            
            if (css) {
                html += `<span style="${css}">${textHTML}</span>`;
            } else {
                html += textHTML;
            }
        }
        
        this.editorEl.innerHTML = html || '<br>';
    }

    _extractData() {
        let currentText = this.editorEl.innerText || '';
        if (currentText.endsWith('\n\n')) currentText = currentText.slice(0, -1);
        if (currentText.endsWith('\n')) currentText = currentText.slice(0, -1);

        if (currentText !== this.initialText) {
            this.initialText = currentText;
            this.ranges = [];
        }

        return {
            text: this.initialText,
            styled_ranges: ReelsRichText.compactRanges(this.ranges, this._effectiveBaseStyle()),
            style_override: this._compactStyleOverride()
        };
    }

    _compactStyleOverride() {
        const o = { ...(this.styleOverride || {}) };
        for (const key of Object.keys(o)) {
            if (o[key] === undefined || o[key] === null || o[key] === '') delete o[key];
        }
        if ((parseInt(o.box_opacity ?? o.opacity_bg ?? 0, 10) || 0) <= 0) {
            delete o.box_opacity;
            delete o.opacity_bg;
            delete o.color_bg;
            delete o.use_box;
        }
        if ((parseFloat(o.border_width) || 0) <= 0) {
            delete o.border_width;
            delete o.color_outline;
            delete o.use_stroke;
        }
        if (o.pos_x !== undefined) o.pos_x = Math.max(0, Math.min(1, parseFloat(o.pos_x) || 0));
        if (o.pos_y !== undefined) o.pos_y = Math.max(0, Math.min(1, parseFloat(o.pos_y) || 0));
        return Object.keys(o).length ? o : null;
    }

    _emitChange() {
        if (this.onChange) {
            const res = this._extractData();
            this.onChange(res.text, res.styled_ranges, res.style_override);
        }
    }

    _setStyleOverride(patch) {
        this.styleOverride = { ...(this.styleOverride || {}), ...(patch || {}) };
        this._syncStyleControlsFromOverride();
        this._applyEditorPreviewStyle();
        this._renderContent();
        this._emitChange();
    }

    _bindEvents() {
        const toolbar = this.popup.querySelector('.rte-se-toolbar');
        const stylebar = this.popup.querySelector('.rte-se-stylebar');

        // ═══ 关键修复：工具栏按钮用 mousedown 阻止失焦 ═══
        // 注意：<select> 需要获得焦点才能打开下拉，所以排除
        toolbar.addEventListener('mousedown', (e) => {
            if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') {
                e.preventDefault();
            }
        });
        if (stylebar) {
            stylebar.addEventListener('mousedown', (e) => {
                if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION' && e.target.type !== 'color') {
                    e.preventDefault();
                }
            });
        }

        const presetSel = this.popup.querySelector('.rt-sel-preset');
        if (presetSel) {
            presetSel.addEventListener('change', (e) => {
                const name = e.target.value;
                if (!name) return;
                const preset = window.ReelsStyleEngine && ReelsStyleEngine.applySubtitlePreset
                    ? ReelsStyleEngine.applySubtitlePreset(name)
                    : null;
                if (preset) {
                    this.styleOverride = { ...preset, _subtitle_preset: name };
                    this._syncStyleControlsFromOverride();
                    this._applyEditorPreviewStyle();
                    this._renderContent();
                    this._emitChange();
                }
            });
        }
        const seTextColor = this.popup.querySelector('.rt-se-text-color');
        if (seTextColor) seTextColor.addEventListener('input', (e) => this._setStyleOverride({ color: e.target.value, color_text: e.target.value }));
        const seBoxColor = this.popup.querySelector('.rt-se-box-color');
        if (seBoxColor) seBoxColor.addEventListener('input', (e) => this._setStyleOverride({ use_box: true, color_bg: e.target.value, box_opacity: parseInt(this.popup.querySelector('.rt-se-box-opacity')?.value || '150', 10) || 150 }));
        const seBoxOpacity = this.popup.querySelector('.rt-se-box-opacity');
        if (seBoxOpacity) seBoxOpacity.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10) || 0;
            this._setStyleOverride({ use_box: val > 0, box_opacity: val, opacity_bg: val, color_bg: this.popup.querySelector('.rt-se-box-color')?.value || '#000000' });
        });
        this._bindNumberDrag(seBoxOpacity);
        const seBoxRadius = this.popup.querySelector('.rt-se-box-radius');
        if (seBoxRadius) {
            seBoxRadius.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ box_radius: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(seBoxRadius);
        }
        const seOutlineColor = this.popup.querySelector('.rt-se-outline-color');
        if (seOutlineColor) seOutlineColor.addEventListener('input', (e) => this._setStyleOverride({ use_stroke: true, color_outline: e.target.value, border_width: parseInt(this.popup.querySelector('.rt-se-outline-width')?.value || '4', 10) || 4 }));
        const seOutlineWidth = this.popup.querySelector('.rt-se-outline-width');
        if (seOutlineWidth) seOutlineWidth.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10) || 0;
            this._setStyleOverride({ use_stroke: val > 0, border_width: val, color_outline: this.popup.querySelector('.rt-se-outline-color')?.value || '#000000' });
        });
        const seBold = this.popup.querySelector('.rt-se-bold');
        if (seBold) seBold.addEventListener('click', () => {
            const next = !seBold.classList.contains('active');
            const weight = next ? 700 : 400;
            this._setStyleOverride({ bold: next, font_weight: weight });
        });
        const seItalic = this.popup.querySelector('.rt-se-italic');
        if (seItalic) seItalic.addEventListener('click', () => {
            const next = !seItalic.classList.contains('active');
            this._setStyleOverride({ italic: next });
        });
        const seFont = this.popup.querySelector('.rt-se-font');
        if (seFont) seFont.addEventListener('change', async (e) => {
            const val = e.target.value;
            if (val && typeof getFontManager === 'function') {
                try { await getFontManager().loadGoogleFont(val); } catch (_) {}
            }
            this._refreshWeightSelect(this.popup.querySelector('.rt-se-weight'), val || 'Arial', this.popup.querySelector('.rt-se-weight')?.value || this.styleOverride?.font_weight || this.baseStyle.font_weight || 700, !!this.styleOverride?.italic);
            this._setStyleOverride(val ? { font_family: val } : { font_family: undefined });
        });
        const seWeight = this.popup.querySelector('.rt-se-weight');
        if (seWeight) seWeight.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isFinite(val)) this._setStyleOverride({ font_weight: val, bold: val >= 600 });
        });
        const seSize = this.popup.querySelector('.rt-se-size');
        if (seSize) seSize.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isFinite(val)) this._setStyleOverride({ fontsize: val });
        });
        const sePosX = this.popup.querySelector('.rt-se-pos-x');
        const sePosY = this.popup.querySelector('.rt-se-pos-y');
        const applyPosition = () => {
            const x = this._percentInputToStylePos(sePosX?.value, this.baseStyle.pos_x ?? 0.5);
            const y = this._percentInputToStylePos(sePosY?.value, this.baseStyle.pos_y ?? 0.85);
            this._setStyleOverride({ pos_x: x, pos_y: y });
        };
        if (sePosX) sePosX.addEventListener('input', applyPosition);
        if (sePosY) sePosY.addEventListener('input', applyPosition);
        this._bindNumberDrag(sePosX);
        this._bindNumberDrag(sePosY);

        const seLetterSpacing = this.popup.querySelector('.rt-se-letter-spacing');
        const sePadTop = this.popup.querySelector('.rt-se-pad-top');
        const sePadBottom = this.popup.querySelector('.rt-se-pad-bottom');
        const sePadLeft = this.popup.querySelector('.rt-se-pad-left');
        const sePadRight = this.popup.querySelector('.rt-se-pad-right');

        if (seLetterSpacing) {
            seLetterSpacing.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ letter_spacing: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(seLetterSpacing);
        }
        const seWordSpacing = this.popup.querySelector('.rt-se-word-spacing');
        if (seWordSpacing) {
            seWordSpacing.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ word_spacing: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(seWordSpacing);
        }
        if (sePadTop) {
            sePadTop.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ box_padding_top: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(sePadTop);
        }
        if (sePadBottom) {
            sePadBottom.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ box_padding_bottom: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(sePadBottom);
        }
        if (sePadLeft) {
            sePadLeft.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ box_padding_left: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(sePadLeft);
        }
        if (sePadRight) {
            sePadRight.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                this._setStyleOverride({ box_padding_right: Number.isFinite(val) ? val : undefined });
            });
            this._bindNumberDrag(sePadRight);
        }
        const clearStyleBtn = this.popup.querySelector('.rt-se-clear-style');
        if (clearStyleBtn) clearStyleBtn.addEventListener('click', () => {
            this.styleOverride = {};
            const ps = this.popup.querySelector('.rt-sel-preset');
            if (ps) ps.value = '';
            this._syncStyleControlsFromOverride();
            this._applyEditorPreviewStyle();
            this._renderContent();
            this._emitChange();
        });

        // Toolbar 按钮
        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.rt-btn');
            if (!btn) return;
            const cmd = btn.getAttribute('data-cmd');
            if (cmd === 'bold') {
                const isBold = btn.classList.contains('active');
                if (isBold) {
                    this.removeStyleFromSelection(['bold']);
                } else {
                    this.applyStyleToSelection({ bold: true });
                }
            } else if (cmd === 'italic') {
                const isItalic = btn.classList.contains('active');
                if (isItalic) {
                    this.removeStyleFromSelection(['italic']);
                } else {
                    this.applyStyleToSelection({ italic: true });
                }
            } else if (cmd === 'clear') {
                this.removeStyleFromSelection(ReelsRichText.STYLE_KEYS);
            }
        });

        // 字体选择
        const selFont = this.popup.querySelector('.rt-sel-font');
        if (selFont) {
            selFont.addEventListener('change', async (e) => {
                const val = e.target.value;
                if (val && typeof getFontManager === 'function') {
                    try { await getFontManager().loadGoogleFont(val); } catch (_) {}
                }
                if (val) {
                    this.applyStyleToSelection({ font_family: val });
                } else {
                    this.removeStyleFromSelection(['font_family']);
                }
                this._refreshWeightSelect(this.popup.querySelector('.rt-sel-weight'), val || this._effectiveBaseStyle().font_family || 'Arial', this.popup.querySelector('.rt-sel-weight')?.value || 700, false);
                e.target.value = '';
                this.editorEl.focus();
                this._restoreSelection(this._savedStart, this._savedEnd);
            });
        }

        const selWeight = this.popup.querySelector('.rt-sel-weight');
        if (selWeight) {
            selWeight.addEventListener('change', (e) => {
                const val = parseInt(e.target.value, 10);
                if (Number.isFinite(val)) {
                    this.applyStyleToSelection({ font_weight: val, bold: val >= 600 });
                } else {
                    this.removeStyleFromSelection(['font_weight', 'bold']);
                }
                e.target.value = '';
                this.editorEl.focus();
                this._restoreSelection(this._savedStart, this._savedEnd);
            });
        }

        // 字号选择
        const selSize = this.popup.querySelector('.rt-sel-size');
        selSize.addEventListener('change', (e) => {
            const val = e.target.value;
            if (val) {
                this.applyStyleToSelection({ fontsize: parseInt(val, 10) });
            } else {
                this.removeStyleFromSelection(['fontsize']);
            }
            e.target.value = '';
            // 恢复焦点到编辑器
            this.editorEl.focus();
            this._restoreSelection(this._savedStart, this._savedEnd);
        });

        // 文字颜色选择
        const cp = this.popup.querySelector('.rt-sel-color');
        cp.addEventListener('input', (e) => {
            this.applyStyleToSelection({ color: e.target.value });
        });

        // 描边颜色选择
        const strokeCp = this.popup.querySelector('.rt-stroke-color');
        if (strokeCp) {
            strokeCp.addEventListener('input', (e) => {
                this.applyStyleToSelection({ color_outline: e.target.value });
            });
        }

        // 描边宽度选择
        const selStroke = this.popup.querySelector('.rt-sel-stroke');
        if (selStroke) {
            selStroke.addEventListener('change', (e) => {
                const val = e.target.value;
                if (val !== '') {
                    this.applyStyleToSelection({ border_width: parseInt(val, 10) });
                } else {
                    this.removeStyleFromSelection(['border_width']);
                }
                e.target.value = '';
                this.editorEl.focus();
                this._restoreSelection(this._savedStart, this._savedEnd);
            });
        }

        // 选区变化监测 (更新工具栏状态)
        this._onSelectionChangeWrapper = () => {
            if (!this.editorEl) return;
            const sel = window.getSelection();
            if (sel.rangeCount > 0 && this.editorEl.contains(sel.anchorNode)) {
                this._saveSelectionRange();
                this._updateToolbarState();
            }
        };
        document.addEventListener('selectionchange', this._onSelectionChangeWrapper);

        // 热键 & 控制
        this.editorEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.close(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close(false);
            }
        });

        this.editorEl.addEventListener('input', () => {
             this._syncText();
        });

        // 保存 & 关闭
        this.popup.querySelector('.rte-se-close').addEventListener('click', () => this.close(false));
        this.popup.querySelector('.rte-se-save').addEventListener('click', () => this.close(true));

        // 允许拖拽移动小窗口
        const header = this.popup.querySelector('.rte-se-header');
        if (header) {
            header.addEventListener('mousedown', (e) => {
                // 排除关闭按钮及其他交互元素
                if (e.target.closest('.rte-se-close') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
                    return;
                }
                e.preventDefault(); // 阻止选中文本

                const rect = this.popup.getBoundingClientRect();
                const startX = e.clientX;
                const startY = e.clientY;
                const startLeft = rect.left;
                const startTop = rect.top;



                const onMouseMove = (moveEvent) => {
                    const dx = moveEvent.clientX - startX;
                    const dy = moveEvent.clientY - startY;

                    let newLeft = startLeft + dx;
                    let newTop = startTop + dy;

                    // 限制在视口边界内，留一些余量
                    const viewportW = window.innerWidth;
                    const viewportH = window.innerHeight;
                    const popupW = rect.width;
                    const popupH = rect.height;

                    if (newLeft < 4) newLeft = 4;
                    if (newLeft + popupW > viewportW - 4) newLeft = viewportW - popupW - 4;
                    if (newTop < 4) newTop = 4;
                    if (newTop + popupH > viewportH - 4) newTop = viewportH - popupH - 4;

                    this.popup.style.left = `${newLeft}px`;
                    this.popup.style.top = `${newTop}px`;
                    this.popup.style.bottom = 'auto';
                };

                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);

                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }
    }

    _syncText() {
        let currentText = this.editorEl.innerText || '';
        if (currentText.endsWith('\n\n')) currentText = currentText.slice(0, -1);
        if (currentText.endsWith('\n')) currentText = currentText.slice(0, -1);
        if (currentText !== this.initialText) {
            // 保存当前的选区光标位置
            this._saveSelectionRange();
            const start = this._savedStart;
            const end = this._savedEnd;

            this.initialText = currentText;
            this.ranges = []; // 破坏性修改，重置样式
            this._renderContent();
            
            // 恢复光标到之前的位置，而不是每次都硬塞到末尾
            this._restoreSelection(start, end);
            
            this._emitChange();
        }
    }

    _saveSelectionRange() {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            this._selectionRange = sel.getRangeAt(0).cloneRange();
            // 同时保存字符偏移（这样即使失焦也不丢失）
            const indices = this._getSelectionIndices();
            this._savedStart = indices.start;
            this._savedEnd = indices.end;
        }
    }

    _getSelectionIndices() {
        if (!this._selectionRange || !this.editorEl) return { start: 0, end: 0 };
        const range = this._selectionRange;
        return {
            start: this._getOffsetFromNode(this.editorEl, range.startContainer, range.startOffset),
            end: this._getOffsetFromNode(this.editorEl, range.endContainer, range.endOffset)
        };
    }

    _getOffsetFromNode(root, node, offset) {
        let currentOffset = 0;
        let found = false;

        function traverse(curr) {
            if (found) return;
            if (curr === node) {
                if (curr.nodeType === Node.TEXT_NODE) {
                    currentOffset += offset;
                } else {
                    // 如果目标是 element（例如 editorEl），offset 是子节点索引
                    for (let i = 0; i < Math.min(offset, curr.childNodes.length); i++) {
                        const child = curr.childNodes[i];
                        if (child.nodeType === Node.TEXT_NODE) {
                            currentOffset += child.textContent.length;
                        } else if (child.nodeName === 'BR') {
                            currentOffset += 1;
                        } else {
                            currentOffset += child.textContent.length;
                        }
                    }
                }
                found = true;
                return;
            }
            if (curr.nodeType === Node.TEXT_NODE) {
                currentOffset += curr.textContent.length;
            } else if (curr.nodeType === Node.ELEMENT_NODE && curr.nodeName === 'BR') {
              currentOffset += 1;
            } else {
                for (let i = 0; i < curr.childNodes.length; i++) {
                    traverse(curr.childNodes[i]);
                }
            }
        }

        traverse(root);
        return currentOffset;
    }

    _restoreSelection(startIdx, endIdx) {
        if (!this.editorEl) return;
        const range = document.createRange();
        let currentIdx = 0;
        let startSet = false;
        let endSet = false;

        function traverse(curr) {
            if (endSet) return;
            if (curr.nodeType === Node.TEXT_NODE) {
                const len = curr.textContent.length;
                if (!startSet && currentIdx + len >= startIdx) {
                    range.setStart(curr, Math.min(startIdx - currentIdx, len));
                    startSet = true;
                }
                if (!endSet && currentIdx + len >= endIdx) {
                    range.setEnd(curr, Math.min(endIdx - currentIdx, len));
                    endSet = true;
                }
                currentIdx += len;
            } else if (curr.nodeType === Node.ELEMENT_NODE && curr.nodeName === 'BR') {
              currentIdx += 1;
              if (!startSet && currentIdx === startIdx) { range.setStartAfter(curr); startSet = true;}
              if (!endSet && currentIdx === endIdx) { range.setEndAfter(curr); endSet = true; }
            } else {
                for (let i = 0; i < curr.childNodes.length; i++) {
                    traverse(curr.childNodes[i]);
                }
            }
        }

        traverse(this.editorEl);

        if (!startSet) range.setStart(this.editorEl, this.editorEl.childNodes.length);
        if (!endSet) range.setEnd(this.editorEl, this.editorEl.childNodes.length);

        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this._selectionRange = range.cloneRange();
        this._savedStart = startIdx;
        this._savedEnd = endIdx;
    }

    _updateToolbarState() {
        if (!this.popup) return;
        const selInfo = { start: this._savedStart, end: this._savedEnd };
        if (selInfo.start >= selInfo.end) return;

        let isBold = true;
        let isItalic = true;
        let mainColor = '';
        let mainStrokeColor = '';
        
        for (let i = selInfo.start; i < selInfo.end; i++) {
            const r = this.ranges.find(rg => rg.start <= i && rg.end > i);
            if (!r || !(r.bold || parseInt(r.font_weight, 10) >= 600)) isBold = false;
            if (!r || !r.italic) isItalic = false;
            if (r && r.color && !mainColor) mainColor = r.color;
            if (r && r.color_outline && !mainStrokeColor) mainStrokeColor = r.color_outline;
        }

        const btnBold = this.popup.querySelector('.rt-btn-bold');
        if (btnBold) btnBold.classList.toggle('active', isBold);

        const btnItalic = this.popup.querySelector('.rt-btn-italic');
        if (btnItalic) btnItalic.classList.toggle('active', isItalic);

        if (mainColor) {
            const cp = this.popup.querySelector('.rt-sel-color');
            if (cp) cp.value = mainColor;
        }
        if (mainStrokeColor) {
            const scp = this.popup.querySelector('.rt-stroke-color');
            if (scp) scp.value = mainStrokeColor;
        }
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    _hexToRgba(hex, alpha = 1) {
        let h = String(hex || '#000000').replace('#', '');
        if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
        const r = parseInt(h.slice(0, 2), 16) || 0;
        const g = parseInt(h.slice(2, 4), 16) || 0;
        const b = parseInt(h.slice(4, 6), 16) || 0;
        return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
    }

    _stylePosToPercent(value) {
        const n = parseFloat(value);
        if (!Number.isFinite(n)) return '';
        const pct = n <= 1 ? n * 100 : n;
        return String(Math.round(Math.max(0, Math.min(100, pct))));
    }

    _percentInputToStylePos(value, fallback = 0.5) {
        const raw = parseFloat(value);
        if (!Number.isFinite(raw)) return fallback;
        return Math.max(0, Math.min(100, raw)) / 100;
    }

    _bindNumberDrag(input) {
        if (!input) return;
        input.style.cursor = 'ew-resize';
        input.style.touchAction = 'none'; // 防止触摸设备上的默认滚动
        let dragging = false;
        let startX = 0;
        let startVal = 0;
        let moved = false;

        const onMove = (me) => {
            if (!dragging) return;
            const dx = me.clientX - startX;
            if (Math.abs(dx) >= 2) moved = true;
            const step = parseFloat(input.getAttribute('step')) || 1;
            const speed = me.shiftKey ? 0.2 : 1;
            let next = startVal + dx * step * speed;
            const min = parseFloat(input.getAttribute('min'));
            const max = parseFloat(input.getAttribute('max'));
            if (Number.isFinite(min)) next = Math.max(min, next);
            if (Number.isFinite(max)) next = Math.min(max, next);
            input.value = String(Math.round(next / step) * step);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };

        const onUp = (ue) => {
            if (!dragging) return;
            dragging = false;
            try { input.releasePointerCapture(ue.pointerId); } catch (_) {}
            input.removeEventListener('pointermove', onMove);
            input.removeEventListener('pointerup', onUp);
            input.removeEventListener('pointercancel', onUp);

            if (!moved) {
                input.focus();
                input.select();
            }
        };

        input.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (document.activeElement === input && input.selectionStart !== input.selectionEnd) return;
            dragging = true;
            moved = false;
            startX = e.clientX;
            startVal = parseFloat(input.value);
            if (!Number.isFinite(startVal)) {
                if (input.classList.contains('rt-se-pos-y')) {
                    const fallback = this.baseStyle.pos_y ?? 0.85;
                    startVal = parseFloat(this._stylePosToPercent(fallback)) || 0;
                } else if (input.classList.contains('rt-se-pos-x')) {
                    const fallback = this.baseStyle.pos_x ?? 0.5;
                    startVal = parseFloat(this._stylePosToPercent(fallback)) || 0;
                } else if (input.classList.contains('rt-se-letter-spacing')) {
                    startVal = this.baseStyle.letter_spacing ?? 0;
                } else if (input.classList.contains('rt-se-word-spacing')) {
                    startVal = this.baseStyle.word_spacing ?? 0;
                } else if (input.classList.contains('rt-se-pad-top')) {
                    startVal = this.baseStyle.box_padding_top ?? this.baseStyle.box_padding_y ?? 8;
                } else if (input.classList.contains('rt-se-pad-bottom')) {
                    startVal = this.baseStyle.box_padding_bottom ?? this.baseStyle.box_padding_y ?? 8;
                } else if (input.classList.contains('rt-se-pad-left')) {
                    startVal = this.baseStyle.box_padding_left ?? this.baseStyle.box_padding_x ?? 12;
                } else if (input.classList.contains('rt-se-pad-right')) {
                    startVal = this.baseStyle.box_padding_right ?? this.baseStyle.box_padding_x ?? 12;
                } else if (input.classList.contains('rt-se-box-opacity')) {
                    startVal = this.baseStyle.box_opacity ?? this.baseStyle.opacity_bg ?? 0;
                } else if (input.classList.contains('rt-se-box-radius')) {
                    startVal = this.baseStyle.box_radius ?? 8;
                } else {
                    startVal = 0;
                }
            }
            e.preventDefault();
            e.stopPropagation();
            try { input.setPointerCapture(e.pointerId); } catch (_) {}

            input.addEventListener('pointermove', onMove);
            input.addEventListener('pointerup', onUp);
            input.addEventListener('pointercancel', onUp);
        });
    }
}

if (typeof window !== 'undefined') window.ReelsRichTextEditor = ReelsRichTextEditor;
