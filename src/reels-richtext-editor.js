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
    }

    /**
     * 在指定位置打开编辑器
     */
    open(options) {
        const { title, text, styled_ranges, baseStyle, rect, trackIdx, clipIdx } = options;

        this.initialText = text || '';
        this.ranges = (styled_ranges || []).map(r => ({...r}));
        if (baseStyle) this.baseStyle = { ...this.baseStyle, ...baseStyle };

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
        if (!this._selectionRange) return;

        const selInfo = this._getSelectionIndices();
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
        if (!this._selectionRange) return;
        const selInfo = this._getSelectionIndices();
        if (selInfo.start >= selInfo.end) return;

        this.ranges = ReelsRichText.removeStyle(this.ranges, selInfo.start, selInfo.end, keys);

        this._renderContent();
        this._restoreSelection(selInfo.start, selInfo.end);

        if (this.onChange) {
            const res = this._extractData();
            this.onChange(res.text, res.styled_ranges);
        }
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
                    <option value="">默认</option>
                    <option value="40">超小(40)</option>
                    <option value="60">较小(60)</option>
                    <option value="80">正常(80)</option>
                    <option value="100">较大(100)</option>
                    <option value="120">超大(120)</option>
                    <option value="150">巨大(150)</option>
                    <option value="200">极巨(200)</option>
                </select>
                <input type="color" class="rt-color-picker" title="颜色" value="#ff0000">
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
        const popupW = Math.max(320, Math.min(500, rect.w + 60));
        let popupX = rect.x + rect.w / 2 - popupW / 2;
        let popupY = rect.y - 180; // 在字幕块上方
        
        if (popupX < 4) popupX = 4;
        if (popupX + popupW > window.innerWidth - 4) popupX = window.innerWidth - popupW - 4;
        if (popupY < 4) popupY = rect.y + rect.h + 8; // 放下方

        this.popup.style.left = `${popupX}px`;
        this.popup.style.top = `${popupY}px`;
        this.popup.style.width = `${popupW}px`;

        document.body.appendChild(this.popup);
        this.editorEl = this.popup.querySelector('.rte-se-contenteditable');
    }

    _renderContent() {
        if (!this.editorEl) return;
        
        // 渲染时将 text 和 ranges 结合成 html
        // 这里只是为了视觉上的富文本呈现，不含换行混版逻辑
        const segments = ReelsRichText.splitByRanges(this.initialText, this.ranges, this.baseStyle);
        
        let html = '';
        for (const seg of segments) {
            if (!seg.text) continue;
            let css = '';
            if (seg.style.bold) css += 'font-weight:bold;';
            if (seg.style.color) css += `color:${seg.style.color};`;
            if (seg.style.fontsize) {
                // 仅换算展示比例: 真实字号 / 基础字号 * 编辑器基础字号(24)
                const baseFs = this.baseStyle.fontsize || 80;
                const ratio = seg.style.fontsize / baseFs;
                css += `font-size:${Math.max(12, 24 * ratio)}px;`;
            }
            if (seg.style.bg_color) css += `background-color:${seg.style.bg_color};`;
            
            // 为了安全，escape HTML
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
        // 从 editorEl 中提炼文本 (如果用户修改了文本)
        // 复杂点：contenteditable 文本修改会破坏原有的 offset 映射
        // 简化实现 Phase 3: 仅支持纯文本的提取 (失去内部嵌套格式)，通过 _extractTextNode 提取
        
        // 获取纯文本
        let currentText = this.editorEl.innerText || '';
        // 修正 contenteditable 结尾的多余换行
        if (currentText.endsWith('\n\n')) currentText = currentText.slice(0, -1);
        if (currentText.endsWith('\n')) currentText = currentText.slice(0, -1);

        // 如果文本变了，我们假设样式被破坏（暂时不支持复杂的增删文字保持样式）
        // 若要完美，需要 mutation observer 实时捕捉 offset 变化 (很复杂)
        // 这里采用保守策略：如果总文本长度变了，直接废弃 range。后续再优化为逐字符同步。
        if (currentText !== this.initialText) {
            // 文本改了，清空富文本属性
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

        // Toolbar 按钮
        toolbar.addEventListener('click', (e) => {
            const btn = e.target.closest('.rt-btn');
            if (!btn) return;
            const cmd = btn.getAttribute('data-cmd');
            if (cmd === 'bold') {
                // 检查选区是否已经是粗体
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
            // 归位
            e.target.value = '';
        });

        // 颜色选择
        const cp = this.popup.querySelector('.rt-color-picker');
        cp.addEventListener('input', (e) => {
            this.applyStyleToSelection({ color: e.target.value });
        });

        // 选区变化监测 (更新工具栏状态)
        document.addEventListener('selectionchange', this._onSelectionChangeWrapper);

        // 热键 & 控制
        this.editorEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.close(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close(false);
            } else {
                // 文本输入拦截：如果是修改文本，提醒失去富文本格式
                // 我们通过 keydown+keyup 检测文字变化，如果文字变化了，强行将所有字变为单色纯文本
                setTimeout(() => {
                    this._syncText();
                }, 10);
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
            
            if (this.onChange) {
                this.onChange(this.initialText, this.ranges);
            }
        }
    }

    _onSelectionChangeWrapper = () => {
        if (!this.editorEl) return;
        const sel = window.getSelection();
        if (sel.rangeCount > 0 && this.editorEl.contains(sel.anchorNode)) {
            this._saveSelectionRange();
            this._updateToolbarState();
        }
    };

    _saveSelectionRange() {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            this._selectionRange = sel.getRangeAt(0).cloneRange();
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

        // 如果超出，绑在最后
        if (!startSet) range.setStart(this.editorEl, this.editorEl.childNodes.length);
        if (!endSet) range.setEnd(this.editorEl, this.editorEl.childNodes.length);

        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        this._selectionRange = range.cloneRange();
    }

    _updateToolbarState() {
        if (!this.popup) return;
        const selInfo = this._getSelectionIndices();
        if (selInfo.start >= selInfo.end) return;

        // 判断选中区间的综合样式
        let isBold = true;
        let mainColor = '';
        
        // 我们只检查当前 styled_ranges 在此区间的覆盖情况
        for (let i = selInfo.start; i < selInfo.end; i++) {
            // 找覆盖字符i的range
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
