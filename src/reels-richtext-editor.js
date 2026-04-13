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
        const { title, text, styled_ranges, baseStyle, rect, trackIdx, clipIdx } = options;

        this.initialText = text || '';
        this.ranges = (styled_ranges || []).map(r => ({...r}));
        if (baseStyle) this.baseStyle = { ...this.baseStyle, ...baseStyle };

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
            this.onSave(result.text, result.styled_ranges);
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
        
        if (this.onChange) {
            const res = this._extractData();
            this.onChange(res.text, res.styled_ranges);
        }
    }

    removeStyleFromSelection(keys) {
        const selInfo = { start: this._savedStart, end: this._savedEnd };
        if (selInfo.start >= selInfo.end) return;

        this.ranges = ReelsRichText.removeStyle(this.ranges, selInfo.start, selInfo.end, keys);

        this._renderContent();
        this._restoreSelection(selInfo.start, selInfo.end);

        if (this.onChange) {
            const res = this._extractData();
            this.onChange(res.text, res.styled_ranges);
        }
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
                font-family: system-ui, -apple-system, sans-serif;
                animation: rteSlideIn 0.15s ease-out;
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
                color: #ddd;
                border-radius: 5px;
                font-size: 12px;
                padding: 0 6px;
                cursor: pointer;
            }
            .rt-select:focus { border-color: #7b8bef; outline: none; }

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
            <div class="rte-se-toolbar">
                <button class="rt-btn rt-btn-bold" data-cmd="bold" title="粗体"><b>B</b></button>
                <div class="rt-divider"></div>
                <select class="rt-select rt-sel-size" title="字号">
                    <option value="">字号</option>
                    <option value="40">超小(40)</option>
                    <option value="60">较小(60)</option>
                    <option value="80">正常(80)</option>
                    <option value="100">较大(100)</option>
                    <option value="120">超大(120)</option>
                    <option value="150">巨大(150)</option>
                    <option value="200">极巨(200)</option>
                </select>
                <input type="color" class="rt-color-picker" title="颜色" value="#ff0000">
                <div class="rt-divider"></div>
                <button class="rt-btn rt-btn-clear" data-cmd="clear" title="清除样式">✕</button>
            </div>
            <div class="rte-se-contenteditable" contenteditable="true" spellcheck="false"
                 style="font-family: system-ui, sans-serif; font-size: 24px; color: ${this.baseStyle.color || '#fff'};">
            </div>
            <div class="rte-se-footer">
                <span class="rte-se-hint">Ctrl+Enter 保存 · Esc 取消</span>
                <button class="rte-se-save">✓ 保存</button>
            </div>
        `;

        // 布局定位
        const popupW = Math.max(360, Math.min(550, (rect?.w || 300) + 80));
        let popupX = (rect?.x || 200) + (rect?.w || 100) / 2 - popupW / 2;
        let popupY = (rect?.y || 300) - 260;
        
        if (popupX < 4) popupX = 4;
        if (popupX + popupW > window.innerWidth - 4) popupX = window.innerWidth - popupW - 4;
        if (popupY < 4) popupY = (rect?.y || 300) + (rect?.h || 30) + 8;

        this.popup.style.left = `${popupX}px`;
        this.popup.style.top = `${popupY}px`;
        this.popup.style.width = `${popupW}px`;

        document.body.appendChild(this.popup);
        this.editorEl = this.popup.querySelector('.rte-se-contenteditable');
    }

    _renderContent() {
        if (!this.editorEl) return;
        
        // 渲染时将 text 和 ranges 结合成 html
        const segments = ReelsRichText.splitByRanges(this.initialText, this.ranges, this.baseStyle);
        
        let html = '';
        for (const seg of segments) {
            if (!seg.text) continue;
            let css = '';
            if (seg.style.bold) css += 'font-weight:bold;';
            if (seg.style.color) css += `color:${seg.style.color};`;
            if (seg.style.fontsize) {
                const baseFs = this.baseStyle.fontsize || 80;
                const ratio = seg.style.fontsize / baseFs;
                css += `font-size:${Math.max(12, 24 * ratio)}px;`;
            }
            if (seg.style.bg_color) css += `background-color:${seg.style.bg_color};`;
            
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
            styled_ranges: ReelsRichText.compactRanges(this.ranges, this.baseStyle)
        };
    }

    _bindEvents() {
        const toolbar = this.popup.querySelector('.rte-se-toolbar');

        // ═══ 关键修复：工具栏按钮用 mousedown 阻止失焦 ═══
        toolbar.addEventListener('mousedown', (e) => {
            // 阻止点击工具栏导致 contenteditable 失去焦点（选区丢失）
            e.preventDefault();
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
            } else if (cmd === 'clear') {
                this.removeStyleFromSelection(ReelsRichText.STYLE_KEYS);
            }
        });

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

        // 颜色选择
        const cp = this.popup.querySelector('.rt-color-picker');
        cp.addEventListener('input', (e) => {
            this.applyStyleToSelection({ color: e.target.value });
        });

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
    }

    _syncText() {
        let currentText = this.editorEl.innerText || '';
        if (currentText.endsWith('\n\n')) currentText = currentText.slice(0, -1);
        if (currentText.endsWith('\n')) currentText = currentText.slice(0, -1);
        if (currentText !== this.initialText) {
            this.initialText = currentText;
            this.ranges = []; // 破坏性修改，重置样式
            this._renderContent();
            
            // 将光标放到末尾
            const range = document.createRange();
            range.selectNodeContents(this.editorEl);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            this._saveSelectionRange();
            
            if (this.onChange) {
                this.onChange(this.initialText, this.ranges);
            }
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
        let mainColor = '';
        
        for (let i = selInfo.start; i < selInfo.end; i++) {
            const r = this.ranges.find(rg => rg.start <= i && rg.end > i);
            if (!r || !r.bold) isBold = false;
            if (r && r.color && !mainColor) mainColor = r.color;
        }

        const btnBold = this.popup.querySelector('.rt-btn-bold');
        if (btnBold) {
            btnBold.classList.toggle('active', isBold);
        }

        if (mainColor) {
            const cp = this.popup.querySelector('.rt-color-picker');
            if (cp) cp.value = mainColor;
        }
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

if (typeof window !== 'undefined') window.ReelsRichTextEditor = ReelsRichTextEditor;
