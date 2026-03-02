/**
 * reels-overlay-panel.js — 覆层属性面板
 *
 * 移植自 AutoSub_v8 属性面板 (PyQt6 prop_panel → HTML DOM)
 *
 * 功能:
 *   - 覆层列表 (添加/删除/选中)
 *   - 文本覆层属性: 内容、字体、大小、颜色、描边、阴影、背景、动画
 *   - 图片覆层属性: 源路径、缩放、翻转、混合模式
 *   - 时间范围: 起止时间编辑
 *   - 变换: X/Y/宽/高/旋转/不透明度
 */

class ReelsOverlayPanel {
    constructor(containerEl, videoCanvas) {
        this.container = containerEl;
        this.videoCanvas = videoCanvas;
        this._selectedOv = null;
        this._init();
    }

    _init() {
        this.container.innerHTML = `
        <div class="rop-panel">
            <!-- 覆层列表 -->
            <div class="rop-section">
                <div class="rop-header">
                    <span>📐 覆层列表</span>
                    <div class="rop-header-actions">
                        <button class="btn btn-secondary rop-btn" id="rop-add-text" title="添加文本覆层">T+</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-textcard" title="添加文案卡片" style="background:#FFD700;color:#000;">📋+</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-image" title="添加图片覆层">🖼+</button>
                        <button class="btn btn-secondary rop-btn" id="rop-batch-import" title="从表格批量导入文案" style="background:#00D4FF;color:#000;">📋批量</button>
                    </div>
                </div>
                <div id="rop-overlay-list" class="rop-list"></div>
            </div>

            <!-- 属性编辑 -->
            <div id="rop-props" class="rop-section" style="display:none;">
                <div class="rop-header"><span>⚙️ 属性</span></div>

                <!-- 变换 -->
                <div class="rop-group">
                    <div class="rop-group-title">变换</div>
                    <div class="rop-grid">
                        <label>X</label><input type="number" id="rop-x" class="rop-input" step="1">
                        <label>Y</label><input type="number" id="rop-y" class="rop-input" step="1">
                        <label>宽</label><input type="number" id="rop-w" class="rop-input" step="1">
                        <label>高</label><input type="number" id="rop-h" class="rop-input" step="1">
                        <label>旋转</label><input type="number" id="rop-rotation" class="rop-input" min="-360" max="360" value="0">
                        <label>不透明</label><input type="range" id="rop-opacity" class="rop-range" min="0" max="100" value="100">
                    </div>
                </div>

                <!-- 时间 -->
                <div class="rop-group">
                    <div class="rop-group-title">时间</div>
                    <div class="rop-grid">
                        <label>开始(s)</label><input type="number" id="rop-start" class="rop-input" step="0.1" min="0">
                        <label>结束(s)</label><input type="number" id="rop-end" class="rop-input" step="0.1" min="0">
                    </div>
                </div>

                <!-- 文本属性 (文本覆层独有) -->
                <div id="rop-text-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">文本</div>
                    <textarea id="rop-content" class="rop-textarea" rows="3" placeholder="覆层文本内容"></textarea>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-font" class="rop-select">
                            <option>Arial</option><option>Helvetica</option><option>Impact</option>
                            <option>Roboto</option><option>Open Sans</option>
                        </select>
                        <label>字号</label><input type="number" id="rop-fontsize" class="rop-input" min="8" max="300" value="40">
                        <label>颜色</label><input type="color" id="rop-color" class="rop-color" value="#ffffff">
                        <label>粗体</label><input type="checkbox" id="rop-bold">
                        <label>字重</label>
                        <select id="rop-font-weight" class="rop-select">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400">Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700" selected>Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>描边色</label><input type="color" id="rop-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽</label><input type="number" id="rop-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>阴影色</label><input type="color" id="rop-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-shadow-blur" class="rop-input" min="0" max="50" value="0">
                    </div>
                </div>

                <!-- 图片属性 (图片覆层独有) -->
                <div id="rop-image-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">图片</div>
                    <div class="rop-grid">
                        <label>缩放</label><input type="range" id="rop-scale" class="rop-range" min="10" max="300" value="100">
                        <label>水平翻转</label><input type="checkbox" id="rop-flip-h">
                        <label>垂直翻转</label><input type="checkbox" id="rop-flip-v">
                        <label>混合模式</label>
                        <select id="rop-blend" class="rop-select">
                            <option value="source-over">正常</option>
                            <option value="multiply">正片叠底</option>
                            <option value="screen">滤色</option>
                            <option value="overlay">叠加</option>
                        </select>
                    </div>
                </div>

                <!-- 动画 -->
                <div class="rop-group">
                    <div class="rop-group-title">动画</div>
                    <div class="rop-grid">
                        <label>入场</label>
                        <select id="rop-anim-in" class="rop-select">
                            <option value="none">无</option><option value="fade">淡入</option>
                            <option value="pop">弹出</option><option value="slide_up">上滑</option>
                            <option value="slide_down">下滑</option><option value="slide_left">左滑</option>
                            <option value="slide_right">右滑</option>
                        </select>
                        <label>出场</label>
                        <select id="rop-anim-out" class="rop-select">
                            <option value="none">无</option><option value="fade">淡出</option>
                            <option value="pop">弹出</option><option value="slide_up">上滑</option>
                            <option value="slide_down">下滑</option>
                        </select>
                        <label>入场时长</label><input type="number" id="rop-anim-in-dur" class="rop-input" min="0" max="5" step="0.05" value="0.3">
                        <label>出场时长</label><input type="number" id="rop-anim-out-dur" class="rop-input" min="0" max="5" step="0.05" value="0.3">
                    </div>
                </div>

                <!-- 文案卡片属性 (textcard覆层独有) -->
                <div id="rop-textcard-props" class="rop-group" style="display:none;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="rop-group-title" style="margin:0;">📋 卡片背景</div>
                        <button class="rop-reset-all" id="rop-card-reset-all" title="全部恢复默认">↺ 默认</button>
                    </div>
                    <div class="rop-grid" style="margin-top:6px;">
                        <label>颜色</label><input type="color" id="rop-card-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>透明度 %</label>
                        <div class="rop-slider-combo">
                            <input type="range" id="rop-card-opacity" class="rop-range rop-defaultable" data-default="80" min="0" max="100" value="80">
                            <input type="number" class="rop-num-readout" data-link="rop-card-opacity" min="0" max="100" value="80">
                            <button class="rop-reset-btn" data-target="rop-card-opacity" title="恢复默认">↺</button>
                        </div>
                        <label>全屏蒙版</label><input type="checkbox" id="rop-fullscreen-mask" class="rop-defaultable" data-default="false">
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">⬰ 圆角 (四边独立)</div>
                    <div class="rop-grid">
                        <label>左上</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-tl" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-tl" min="0" max="200" value="16"><button class="rop-reset-btn" data-target="rop-radius-tl" title="恢复默认">↺</button></div>
                        <label>右上</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-tr" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-tr" min="0" max="200" value="16"><button class="rop-reset-btn" data-target="rop-radius-tr" title="恢复默认">↺</button></div>
                        <label>左下</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-bl" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-bl" min="0" max="200" value="16"><button class="rop-reset-btn" data-target="rop-radius-bl" title="恢复默认">↺</button></div>
                        <label>右下</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-br" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-br" min="0" max="200" value="16"><button class="rop-reset-btn" data-target="rop-radius-br" title="恢复默认">↺</button></div>
                        <label>全部</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-all" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-all" min="0" max="200" value="16"><button class="rop-reset-btn" data-target="rop-radius-all" title="恢复默认">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">🔤 标题</div>
                    <textarea id="rop-title-text" class="rop-textarea" rows="2" placeholder="标题文字"></textarea>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-title-font" class="rop-select rop-defaultable" data-default="Crimson Pro">
                        </select>
                        <label>字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-fontsize" class="rop-range rop-defaultable" data-default="60" min="12" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-title-fontsize" min="12" max="200" value="60"><button class="rop-reset-btn" data-target="rop-title-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-title-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>粗体</label><input type="checkbox" id="rop-title-bold" class="rop-defaultable" data-default="true" checked>
                        <label>字重</label>
                        <select id="rop-title-weight" class="rop-select rop-defaultable" data-default="900">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400">Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900" selected>Black</option>
                        </select>
                        <label>大写</label><input type="checkbox" id="rop-title-uppercase" class="rop-defaultable" data-default="true" checked>
                        <label>对齐</label>
                        <select id="rop-title-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">📝 内容</div>
                    <textarea id="rop-body-text" class="rop-textarea" rows="4" placeholder="内容文字"></textarea>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-body-font" class="rop-select rop-defaultable" data-default="Arial">
                        </select>
                        <label>字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-fontsize" class="rop-range rop-defaultable" data-default="40" min="8" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-body-fontsize" min="8" max="200" value="40"><button class="rop-reset-btn" data-target="rop-body-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-body-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>粗体</label><input type="checkbox" id="rop-body-bold" class="rop-defaultable" data-default="false">
                        <label>字重</label>
                        <select id="rop-body-weight" class="rop-select rop-defaultable" data-default="400">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-linespacing" class="rop-range rop-defaultable" data-default="6" min="0" max="50" value="6"><input type="number" class="rop-num-readout" data-link="rop-body-linespacing" min="0" max="50" value="6"><button class="rop-reset-btn" data-target="rop-body-linespacing" title="恢复默认">↺</button></div>
                        <label>对齐</label>
                        <select id="rop-body-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">📐 布局</div>
                    <div class="rop-grid">
                        <label>蒙版宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-width" class="rop-range rop-defaultable" data-default="910" min="100" max="1080" value="910"><input type="number" class="rop-num-readout" data-link="rop-card-width" min="100" max="1080" value="910"><button class="rop-reset-btn" data-target="rop-card-width" title="恢复默认">↺</button></div>
                        <label>自动适配</label><input type="checkbox" id="rop-auto-fit" class="rop-defaultable" data-default="true" checked>
                        <label>垂直居中</label><input type="checkbox" id="rop-auto-center" class="rop-defaultable" data-default="true" checked>
                        <label>标题间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-body-gap" class="rop-range rop-defaultable" data-default="42" min="0" max="100" value="42"><input type="number" class="rop-num-readout" data-link="rop-title-body-gap" min="0" max="100" value="42"><button class="rop-reset-btn" data-target="rop-title-body-gap" title="恢复默认">↺</button></div>
                        <label>上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-top" class="rop-range rop-defaultable" data-default="20" min="0" max="200" value="20"><input type="number" class="rop-num-readout" data-link="rop-pad-top" min="0" max="200" value="20"><button class="rop-reset-btn" data-target="rop-pad-top" title="恢复默认">↺</button></div>
                        <label>下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-bottom" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-bottom" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-bottom" title="恢复默认">↺</button></div>
                        <label>左边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-left" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-left" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-left" title="恢复默认">↺</button></div>
                        <label>右边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-right" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-right" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-right" title="恢复默认">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">📏 自动缩放</div>
                    <div class="rop-grid">
                        <label>启用缩放</label><input type="checkbox" id="rop-auto-shrink" class="rop-defaultable" data-default="true" checked>
                        <label>最大高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-max-height" class="rop-range rop-defaultable" data-default="1400" min="200" max="1920" value="1400"><input type="number" class="rop-num-readout" data-link="rop-max-height" min="200" max="1920" value="1600"><button class="rop-reset-btn" data-target="rop-max-height" title="恢复默认">↺</button></div>
                        <label>标题缩放行</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-max-lines" class="rop-range rop-defaultable" data-default="3" min="1" max="10" value="3"><input type="number" class="rop-num-readout" data-link="rop-title-max-lines" min="1" max="10" value="3"><button class="rop-reset-btn" data-target="rop-title-max-lines" title="恢复默认">↺</button></div>
                        <label>最小字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-min-fontsize" class="rop-range rop-defaultable" data-default="16" min="8" max="40" value="16"><input type="number" class="rop-num-readout" data-link="rop-min-fontsize" min="8" max="40" value="16"><button class="rop-reset-btn" data-target="rop-min-fontsize" title="恢复默认">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">💾 卡片模板</div>
                    <div style="display:flex;gap:4px;margin-top:4px;">
                        <select id="rop-card-tpl-select" class="rop-select" style="flex:1;">
                            <option value="">-- 选择模板 --</option>
                        </select>
                        <button class="btn btn-secondary rop-btn" id="rop-card-load-tpl" style="padding:2px 8px;">加载</button>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:4px;">
                        <button class="btn btn-secondary rop-btn" id="rop-card-save-tpl" style="flex:1;">保存</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-del-tpl" style="flex:1;">删除</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-import-tpl" style="flex:1;">导入</button>
                        <button class="btn btn-secondary rop-btn" id="rop-card-export-tpl" style="flex:1;">导出</button>
                    </div>
                </div>

                <!-- 操作 -->
                <div class="rop-actions">
                    <button class="btn btn-secondary rop-btn-full" id="rop-duplicate">📋 复制覆层</button>
                    <button class="btn btn-secondary rop-btn-full rop-btn-danger" id="rop-delete">🗑️ 删除覆层</button>
                </div>
            </div>
        </div>
        `;

        this._bindEvents();
    }

    _bindEvents() {
        // 添加覆层
        this.container.querySelector('#rop-add-text').addEventListener('click', () => this._addTextOverlay());
        this.container.querySelector('#rop-add-textcard').addEventListener('click', () => this._addTextCardOverlay());
        this.container.querySelector('#rop-add-image').addEventListener('click', () => this._addImageOverlay());
        this.container.querySelector('#rop-batch-import').addEventListener('click', () => this._batchImportTextCards());
        this.container.querySelector('#rop-duplicate').addEventListener('click', () => this._duplicateOverlay());
        this.container.querySelector('#rop-delete').addEventListener('click', () => this._deleteOverlay());

        // 使用 FontManager 填充字体下拉框（和字幕面板一致）
        if (window.getFontManager) {
            const fm = getFontManager();
            fm.refreshFontSelect('rop-font', 'Arial');
            fm.refreshFontSelect('rop-title-font', 'Crimson Pro');
            fm.refreshFontSelect('rop-body-font', 'Arial');
            if (fm && typeof fm.loadGoogleFont === 'function') {
                fm.loadGoogleFont('Crimson Pro').catch(() => { });
            }
        }

        // 属性变更
        const fields = [
            'rop-x', 'rop-y', 'rop-w', 'rop-h', 'rop-rotation', 'rop-opacity',
            'rop-start', 'rop-end', 'rop-content', 'rop-font', 'rop-fontsize',
            'rop-color', 'rop-bold', 'rop-font-weight', 'rop-stroke-color', 'rop-stroke-width',
            'rop-shadow-color', 'rop-shadow-blur', 'rop-scale', 'rop-flip-h',
            'rop-flip-v', 'rop-blend', 'rop-anim-in', 'rop-anim-out',
            'rop-anim-in-dur', 'rop-anim-out-dur',
            // Text card fields
            'rop-card-color', 'rop-card-opacity',
            'rop-radius-tl', 'rop-radius-tr', 'rop-radius-bl', 'rop-radius-br',
            'rop-title-text', 'rop-title-font', 'rop-title-fontsize',
            'rop-title-color', 'rop-title-bold', 'rop-title-weight', 'rop-title-uppercase', 'rop-title-align',
            'rop-body-text', 'rop-body-font', 'rop-body-fontsize',
            'rop-body-color', 'rop-body-bold', 'rop-body-weight', 'rop-body-linespacing', 'rop-body-align',
            'rop-auto-fit', 'rop-auto-center', 'rop-fullscreen-mask', 'rop-title-body-gap',
            'rop-pad-top', 'rop-pad-bottom', 'rop-pad-left', 'rop-pad-right',
            'rop-card-width',
            'rop-auto-shrink', 'rop-max-height', 'rop-title-max-lines', 'rop-min-fontsize',
        ];
        for (const fid of fields) {
            const el = this.container.querySelector('#' + fid);
            if (!el) continue;
            el.addEventListener('input', () => this._syncToOverlay());
            el.addEventListener('change', () => this._syncToOverlay());
        }

        const syncBoldToWeight = (boldId, weightId, boldValue = '700', normalValue = '400') => {
            const boldEl = this.container.querySelector('#' + boldId);
            const weightEl = this.container.querySelector('#' + weightId);
            if (!boldEl || !weightEl) return;
            boldEl.addEventListener('change', () => {
                const target = boldEl.checked ? boldValue : normalValue;
                if (Array.from(weightEl.options).some(o => o.value === target)) {
                    weightEl.value = target;
                }
                this._syncToOverlay();
            });
            weightEl.addEventListener('change', () => {
                const w = parseInt(weightEl.value || normalValue, 10);
                boldEl.checked = Number.isFinite(w) ? w >= 600 : false;
                this._syncToOverlay();
            });
        };
        syncBoldToWeight('rop-bold', 'rop-font-weight', '700', '400');
        syncBoldToWeight('rop-title-bold', 'rop-title-weight', '900', '400');
        syncBoldToWeight('rop-body-bold', 'rop-body-weight', '700', '400');

        const fontWeightPairs = [
            ['rop-font', 'rop-font-weight'],
            ['rop-title-font', 'rop-title-weight'],
            ['rop-body-font', 'rop-body-weight'],
        ];
        for (const [fontId, weightId] of fontWeightPairs) {
            const fontEl = this.container.querySelector('#' + fontId);
            if (!fontEl) continue;
            fontEl.addEventListener('change', async () => {
                if (window.getFontManager) {
                    const fm = getFontManager();
                    if (fm && typeof fm.loadGoogleFont === 'function') {
                        try { await fm.loadGoogleFont(fontEl.value); } catch (_) { }
                    }
                }
                this._refreshWeightOptions(weightId, fontEl.value);
            });
        }

        // Slider ↔ Number readout bidirectional linking
        this.container.querySelectorAll('.rop-num-readout').forEach(numEl => {
            const linkId = numEl.dataset.link;
            if (!linkId) return;
            const rangeEl = this.container.querySelector('#' + linkId);
            if (!rangeEl) return;
            // Range → Number
            rangeEl.addEventListener('input', () => { numEl.value = rangeEl.value; });
            // Number → Range
            numEl.addEventListener('input', () => { rangeEl.value = numEl.value; this._syncToOverlay(); });
            numEl.addEventListener('change', () => { rangeEl.value = numEl.value; this._syncToOverlay(); });
        });

        // "Set all radii" shortcut
        const radiusAll = this.container.querySelector('#rop-radius-all');
        if (radiusAll) {
            radiusAll.addEventListener('input', () => {
                const v = parseFloat(radiusAll.value) || 0;
                ['rop-radius-tl', 'rop-radius-tr', 'rop-radius-bl', 'rop-radius-br'].forEach(id => {
                    const el = this.container.querySelector('#' + id);
                    if (el) el.value = v;
                    // Also update linked number readout
                    const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
                    if (numReadout) numReadout.value = v;
                });
                this._syncToOverlay();
            });
        }

        // Per-parameter ↺ reset buttons
        this.container.querySelectorAll('.rop-reset-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const targetId = btn.dataset.target;
                const el = this.container.querySelector('#' + targetId);
                if (!el) return;
                const def = el.dataset.default;
                if (def == null) return;
                el.value = def;
                // Sync linked number readout
                const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${targetId}"]`);
                if (numReadout) numReadout.value = def;
                this._syncToOverlay();
            });
        });

        // "Reset all" button — resets all rop-defaultable controls
        const resetAllBtn = this.container.querySelector('#rop-card-reset-all');
        if (resetAllBtn) {
            resetAllBtn.addEventListener('click', () => {
                this.container.querySelectorAll('.rop-defaultable').forEach(el => {
                    const def = el.dataset.default;
                    if (def == null) return;
                    if (el.type === 'checkbox') {
                        el.checked = def === 'true';
                    } else {
                        el.value = def;
                    }
                    // Sync linked number readout
                    if (el.id) {
                        const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${el.id}"]`);
                        if (numReadout) numReadout.value = def;
                    }
                });
                this._syncToOverlay();
            });
        }

        // Card template buttons
        const saveTpl = this.container.querySelector('#rop-card-save-tpl');
        const loadTpl = this.container.querySelector('#rop-card-load-tpl');
        const delTpl = this.container.querySelector('#rop-card-del-tpl');
        const importTpl = this.container.querySelector('#rop-card-import-tpl');
        const exportTpl = this.container.querySelector('#rop-card-export-tpl');

        if (saveTpl) saveTpl.addEventListener('click', () => this._saveCardTemplate());
        if (loadTpl) loadTpl.addEventListener('click', () => this._loadCardTemplate());
        if (delTpl) delTpl.addEventListener('click', () => this._deleteCardTemplate());
        if (importTpl) importTpl.addEventListener('click', () => this._importCardTemplates());
        if (exportTpl) exportTpl.addEventListener('click', () => this._exportCardTemplates());

        this._refreshCardTemplateSelect();

        // VideoCanvas 回调
        if (this.videoCanvas) {
            this.videoCanvas.onSelect = (ov) => this.selectOverlay(ov);
            this.videoCanvas.onDeselect = () => this.deselectOverlay();
            this.videoCanvas.onOverlayChange = (ov) => this._syncFromOverlay(ov);
        }
    }

    // ═══════════════════════════════════════════════
    // 覆层 CRUD
    // ═══════════════════════════════════════════════

    _addTextCardOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createTextCardOverlay({
            title_text: 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY',
            body_text: 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.\nI declare: the precious blood of Jesus covers my spouse, my children, and everyone I love. Angels guard every door and window—the enemy cannot come near, not even one step! Darkness cannot enter.\nLord, bring breakthrough to everyone who writes "Amen" and render every curse powerless!',
            x: 40, y: 200, w: 910,
            start: 0, end: 9999,
        });
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    /**
     * 批量导入文案卡片 — 从 Google Sheets 粘贴 TSV
     * 格式: 第一列=标题, 第二列=内容 (支持单元格内换行)
     * 每行自动创建一个任务 + 文案卡片覆层
     */
    async _batchImportTextCards() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;

        // 弹窗让用户粘贴表格数据
        const raw = await this._showBatchImportDialog();
        if (!raw || !raw.trim()) return;

        // 解析 TSV (支持引号内换行)
        const rows = this._parseTSV(raw);
        if (!rows.length) {
            alert('未检测到有效数据，请确保每行至少有一列内容。');
            return;
        }

        // 读取当前卡片模板样式（用当前选中的 textcard 做模板，如果有的话）
        const templateProps = this._getCurrentCardTemplate();

        // 获取 _reelsState 来创建任务
        const state = window._reelsState;
        if (!state) {
            alert('批量Reels模块未初始化');
            return;
        }

        let created = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let rawName = '', title = '', body = '';
            // 支持 3 列或 2 列
            if (row.length >= 3) {
                rawName = row[0] || '';
                title = row[1] || '';
                body = row[2] || '';
            } else {
                title = row[0] || '';
                body = row[1] || '';
            }
            if (!title && !body && !rawName) continue; // 跳过空行

            // 命名。和外面添加的逻辑一样，如果没有命名则按顺序生成
            const baseNameInput = rawName.trim() || `batch_card_${String(i + 1).padStart(3, '0')}`;

            let task = null;
            // 尝试使用 batch-reels 中的通用方法以保证一致的合并与命名规则
            if (typeof _getOrCreateTaskByBase === 'function' && typeof _normalizeBaseName === 'function') {
                const normBase = _normalizeBaseName(baseNameInput);
                task = _getOrCreateTaskByBase(normBase, baseNameInput);
            } else {
                // 回退：简单的查找或创建
                const taskName = baseNameInput;
                task = state.tasks.find(t => t.baseName === taskName);
                if (!task) {
                    task = {
                        baseName: taskName,
                        fileName: `${taskName}.mp4`,
                        bgPath: null, bgSrcUrl: null, audioPath: null, srtPath: null,
                        segments: [], videoPath: null, srcUrl: null,
                        overlays: [],
                    };
                    state.tasks.push(task);
                }
            }

            if (!task.overlays) task.overlays = [];

            // 创建覆层
            const ovOpts = Object.assign({}, templateProps, {
                title_text: title,
                body_text: body,
                start: 0,
                end: 9999,
            });
            const ov = ReelsOverlay.createTextCardOverlay(ovOpts);
            task.overlays.push(ov);

            created++;
        }

        // 刷新任务列表
        if (typeof _renderTaskList === 'function') _renderTaskList();

        // 自动匹配素材
        if (typeof reelsAutoMatchFiles === 'function') reelsAutoMatchFiles();

        alert(`✅ 成功导入 ${created} 条文案！\n\n请添加背景素材、音频等，系统将自动配对。`);
    }

    /**
     * 解析 TSV 数据 (支持引号内换行的 Google Sheets 格式)
     * 返回 [[title, body], ...]
     */
    _parseTSV(raw) {
        const rows = [];
        let i = 0;
        const len = raw.length;

        while (i < len) {
            const cells = [];
            // 解析一行的所有单元格
            while (i < len) {
                let cell = '';
                if (raw[i] === '"') {
                    // 引号字段 — 可能包含换行和tab
                    i++; // 跳过开头引号
                    while (i < len) {
                        if (raw[i] === '"') {
                            if (i + 1 < len && raw[i + 1] === '"') {
                                cell += '"'; // 转义引号
                                i += 2;
                            } else {
                                i++; // 跳过结尾引号
                                break;
                            }
                        } else {
                            cell += raw[i++];
                        }
                    }
                } else {
                    // 非引号字段
                    while (i < len && raw[i] !== '\t' && raw[i] !== '\n' && raw[i] !== '\r') {
                        cell += raw[i++];
                    }
                }
                cells.push(cell);
                // Tab = 下一列
                if (i < len && raw[i] === '\t') { i++; continue; }
                // 换行 = 下一行
                if (i < len && (raw[i] === '\n' || raw[i] === '\r')) {
                    if (raw[i] === '\r' && i + 1 < len && raw[i + 1] === '\n') i++;
                    i++;
                    break;
                }
            }
            if (cells.length > 0 && cells.some(c => c.trim())) {
                rows.push(cells); // 返回所有列，以支持 3 列解析
            }
        }
        return rows;
    }

    /**
     * 获取当前卡片模板的属性 (不含文本内容)
     */
    _getCurrentCardTemplate() {
        const props = {};
        if (this._selectedOv && this._selectedOv.type === 'textcard') {
            const ov = this._selectedOv;
            const keys = [
                'card_color', 'card_opacity',
                'radius_tl', 'radius_tr', 'radius_bl', 'radius_br',
                'title_font_family', 'title_fontsize', 'title_font_weight', 'title_bold', 'title_italic',
                'title_color', 'title_align', 'title_uppercase', 'title_letter_spacing',
                'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
                'body_color', 'body_align', 'body_line_spacing',
                'auto_fit', 'auto_center_v',
                'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
                'title_body_gap', 'w',
            ];
            for (const k of keys) {
                if (ov[k] !== undefined) props[k] = ov[k];
            }
        }
        return props;
    }

    /**
     * 批量导入弹窗
     */
    _showBatchImportDialog() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';
            overlay.innerHTML = `
                <div style="background:#1a1a3e;border:1px solid #2a2a5a;border-radius:12px;padding:24px;width:600px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                    <h3 style="margin:0 0 8px 0;color:#00D4FF;font-size:16px;">📋 批量导入文案</h3>
                    <p style="margin:0 0 12px 0;color:#999;font-size:12px;line-height:1.5;">
                        从 Google 表格复制粘贴到下方。<br>
                        <b>格式选项</b>：<br>
                        • 3列格式：第一列 = <b>命名</b>，第二列 = 标题，第三列 = 内容<br>
                        • 2列格式：第一列 = 标题，第二列 = 内容（没有命名）<br>
                        如果您提供了命名，系统将按照外面导入素材的同名逻辑<b>自动合并</b>到对应行。
                    </p>
                    <textarea id="rop-batch-data" style="flex:1;min-height:300px;padding:12px;background:#12122a;border:1px solid #2a2a4a;border-radius:8px;color:#ddd;font-size:13px;font-family:monospace;resize:vertical;" placeholder="从 Google 表格复制粘贴到这里&#10;&#10;命名1&#9;标题1&#9;内容1&#10;命名2&#9;标题2&#9;内容2&#10;这是标题3(没命名)&#9;这是内容3"></textarea>
                    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
                        <button id="rop-batch-cancel" style="padding:8px 20px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消</button>
                        <button id="rop-batch-ok" style="padding:8px 20px;background:#00D4FF;border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">导入</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const close = (val) => {
                document.body.removeChild(overlay);
                resolve(val);
            };
            overlay.querySelector('#rop-batch-cancel').onclick = () => close(null);
            overlay.querySelector('#rop-batch-ok').onclick = () => {
                close(overlay.querySelector('#rop-batch-data').value);
            };
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) close(null);
            });
            // 自动聚焦
            setTimeout(() => overlay.querySelector('#rop-batch-data').focus(), 100);
        });
    }

    _addTextOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createTextOverlay({
            content: '新文本',
            x: 200, y: 800, w: 680, h: 120,
            fontsize: 74, color: '#ffffff',
            start: 0, end: 5,
        });
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    _addImageOverlay() {
        // 弹出文件选择器
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const url = URL.createObjectURL(file);
            const ReelsOverlay = window.ReelsOverlay;
            if (!ReelsOverlay) return;
            const ov = ReelsOverlay.createImageOverlay({
                src: url, x: 200, y: 400, w: 300, h: 300,
                start: 0, end: 5,
            });
            if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
            this._refreshList();
            this.selectOverlay(ov);
        };
        input.click();
    }

    _duplicateOverlay() {
        if (!this._selectedOv) return;
        const clone = JSON.parse(JSON.stringify(this._selectedOv));
        clone.id = 'ov_' + Date.now();
        clone.x += 30;
        clone.y += 30;
        if (this.videoCanvas) this.videoCanvas.addOverlay(clone);
        this._refreshList();
        this.selectOverlay(clone);
    }

    _deleteOverlay() {
        if (!this._selectedOv) return;
        if (this.videoCanvas) this.videoCanvas.removeOverlay(this._selectedOv.id);
        this._selectedOv = null;
        this._refreshList();
        this.container.querySelector('#rop-props').style.display = 'none';
    }

    // ═══════════════════════════════════════════════
    // 列表
    // ═══════════════════════════════════════════════

    _refreshList() {
        const list = this.container.querySelector('#rop-overlay-list');
        if (!list || !this.videoCanvas) return;

        const overlays = this.videoCanvas.overlayMgr.overlays || [];
        if (overlays.length === 0) {
            list.innerHTML = '<div class="rop-empty">暂无覆层，点击上方按钮添加</div>';
            return;
        }

        list.innerHTML = overlays.map(ov => {
            const isSelected = this._selectedOv?.id === ov.id;
            const icon = ov.type === 'text' ? '📝' : (ov.type === 'textcard' ? '📋' : '🖼️');
            const label = ov.type === 'textcard'
                ? (ov.title_text || '').slice(0, 15) || '文案卡片'
                : (ov.type === 'text' ? (ov.content || '').slice(0, 15) : (ov.name || '图片'));
            return `<div class="rop-list-item ${isSelected ? 'selected' : ''}" data-id="${ov.id}">
                ${icon} <span>${label}</span>
                <span class="rop-list-time">${ov.start?.toFixed(1) || 0}s–${ov.end?.toFixed(1) || 0}s</span>
            </div>`;
        }).join('');

        list.querySelectorAll('.rop-list-item').forEach(el => {
            el.addEventListener('click', () => {
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === el.dataset.id);
                if (ov) this.selectOverlay(ov);
            });
        });
    }

    // ═══════════════════════════════════════════════
    // 选中 / 属性同步
    // ═══════════════════════════════════════════════

    selectOverlay(ov) {
        // 清除之前选中的标记
        if (this._selectedOv) this._selectedOv._selected = false;
        this._selectedOv = ov;
        ov._selected = true;
        this.container.querySelector('#rop-props').style.display = 'block';
        this.container.querySelector('#rop-text-props').style.display = ov.type === 'text' ? 'block' : 'none';
        this.container.querySelector('#rop-image-props').style.display = ov.type === 'image' ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-props').style.display = ov.type === 'textcard' ? 'block' : 'none';
        this._syncFromOverlay(ov);
        this._refreshList();
    }

    deselectOverlay() {
        if (this._selectedOv) this._selectedOv._selected = false;
        this._selectedOv = null;
        this.container.querySelector('#rop-props').style.display = 'none';
        this._refreshList();
    }

    _val(id, v) {
        const el = this.container.querySelector('#' + id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v ?? '';
        // Sync linked number readout
        const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
        if (numReadout) numReadout.value = v ?? '';
    }

    _get(id) {
        const el = this.container.querySelector('#' + id);
        if (!el) return undefined;
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number' || el.type === 'range') return parseFloat(el.value) || 0;
        return el.value;
    }

    _refreshWeightOptions(weightSelectId, fontFamily) {
        const select = this.container.querySelector('#' + weightSelectId);
        if (!select) return;
        const current = String(select.value || '700');
        let entries = [
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
        if (window.getFontManager) {
            const fm = getFontManager();
            if (fm && typeof fm.getFontWeightEntries === 'function') {
                const list = fm.getFontWeightEntries(fontFamily, 'normal');
                if (Array.isArray(list) && list.length > 0) {
                    entries = list.map(item => {
                        const value = String(item.value || '400');
                        const label = String(item.label || value);
                        return { value, label };
                    });
                }
            } else if (fm && typeof fm.getFontWeightOptions === 'function') {
                const list = fm.getFontWeightOptions(fontFamily);
                if (Array.isArray(list) && list.length > 0) {
                    entries = list.map(v => ({ value: String(v), label: String(v) }));
                }
            }
        }
        const weights = entries.map(x => x.value);
        select.innerHTML = entries.map(x => `<option value="${x.value}">${x.label}</option>`).join('');
        if (weights.includes(current)) select.value = current;
        else if (weights.includes('700')) select.value = '700';
        else select.value = weights[weights.length - 1] || '700';
    }

    _syncFromOverlay(ov) {
        if (!ov) return;
        this._val('rop-x', Math.round(ov.x));
        this._val('rop-y', Math.round(ov.y));
        this._val('rop-w', Math.round(ov.w));
        this._val('rop-h', Math.round(ov.h));
        this._val('rop-rotation', ov.rotation || 0);
        this._val('rop-opacity', Math.round((ov.opacity ?? 1) * 100));
        this._val('rop-start', ov.start || 0);
        this._val('rop-end', ov.end || 0);

        if (ov.type === 'text') {
            this._val('rop-content', ov.content || '');
            this._val('rop-font', ov.font_family || 'Arial');
            this._refreshWeightOptions('rop-font-weight', ov.font_family || 'Arial');
            this._val('rop-fontsize', ov.fontsize || 40);
            this._val('rop-color', ov.color || '#ffffff');
            const fw = Math.max(100, Math.min(900, parseInt(ov.font_weight || (ov.bold ? 700 : 400), 10) || 400));
            this._val('rop-font-weight', fw);
            this._val('rop-bold', fw >= 600);
            this._val('rop-stroke-color', ov.stroke_color || '#000000');
            this._val('rop-stroke-width', ov.stroke_width || 0);
            this._val('rop-shadow-color', ov.shadow_color || '#000000');
            this._val('rop-shadow-blur', ov.shadow_blur || 0);
        }

        if (ov.type === 'image') {
            this._val('rop-scale', (ov.scale || 1) * 100);
            this._val('rop-flip-h', ov.flip_h || false);
            this._val('rop-flip-v', ov.flip_v || false);
            this._val('rop-blend', ov.blend_mode || 'source-over');
        }

        if (ov.type === 'textcard') {
            this._val('rop-card-color', ov.card_color || '#ffffff');
            this._val('rop-card-opacity', ov.card_opacity ?? 80);
            this._val('rop-radius-tl', ov.radius_tl ?? 33);
            this._val('rop-radius-tr', ov.radius_tr ?? 33);
            this._val('rop-radius-bl', ov.radius_bl ?? 33);
            this._val('rop-radius-br', ov.radius_br ?? 33);
            this._val('rop-title-text', ov.title_text || '');
            this._val('rop-title-font', ov.title_font_family || 'Crimson Pro');
            this._refreshWeightOptions('rop-title-weight', ov.title_font_family || 'Crimson Pro');
            this._val('rop-title-fontsize', ov.title_fontsize ?? 60);
            this._val('rop-title-color', ov.title_color || '#000000');
            const tw = Math.max(100, Math.min(900, parseInt(ov.title_font_weight || ((ov.title_bold !== false) ? 900 : 400), 10) || 900));
            this._val('rop-title-weight', tw);
            this._val('rop-title-bold', tw >= 600);
            this._val('rop-title-uppercase', ov.title_uppercase !== false);
            this._val('rop-title-align', ov.title_align || 'center');
            this._val('rop-body-text', ov.body_text || '');
            this._val('rop-body-font', ov.body_font_family || 'Arial');
            this._refreshWeightOptions('rop-body-weight', ov.body_font_family || 'Arial');
            this._val('rop-body-fontsize', ov.body_fontsize ?? 40);
            this._val('rop-body-color', ov.body_color || '#000000');
            const bw = Math.max(100, Math.min(900, parseInt(ov.body_font_weight || (ov.body_bold ? 700 : 400), 10) || 400));
            this._val('rop-body-weight', bw);
            this._val('rop-body-bold', bw >= 600);
            this._val('rop-body-linespacing', ov.body_line_spacing ?? 6);
            this._val('rop-body-align', ov.body_align || 'center');
            this._val('rop-auto-fit', ov.auto_fit !== false);
            this._val('rop-auto-center', ov.auto_center_v !== false);
            this._val('rop-fullscreen-mask', ov.fullscreen_mask || false);
            this._val('rop-title-body-gap', ov.title_body_gap ?? 42);
            this._val('rop-pad-top', ov.padding_top ?? 20);
            this._val('rop-pad-bottom', ov.padding_bottom ?? 40);
            this._val('rop-pad-left', ov.padding_left ?? 40);
            this._val('rop-pad-right', ov.padding_right ?? 40);
            this._val('rop-card-width', ov.w || 910);
            this._val('rop-auto-shrink', ov.auto_shrink !== false);
            this._val('rop-max-height', ov.max_height ?? 1400);
            this._val('rop-title-max-lines', ov.title_max_lines ?? 3);
            this._val('rop-min-fontsize', ov.min_fontsize ?? 16);
        }

        this._val('rop-anim-in', ov.anim_in || 'none');
        this._val('rop-anim-out', ov.anim_out || 'none');
        this._val('rop-anim-in-dur', ov.anim_in_dur || 0.3);
        this._val('rop-anim-out-dur', ov.anim_out_dur || 0.3);
    }

    _syncToOverlay() {
        const ov = this._selectedOv;
        if (!ov) return;

        ov.x = this._get('rop-x');
        ov.y = this._get('rop-y');
        ov.w = this._get('rop-w');
        ov.h = this._get('rop-h');
        ov.rotation = this._get('rop-rotation');
        ov.opacity = this._get('rop-opacity') / 100;
        ov.start = this._get('rop-start');
        ov.end = this._get('rop-end');

        if (ov.type === 'text') {
            ov.content = this._get('rop-content');
            ov.font_family = this._get('rop-font');
            ov.fontsize = this._get('rop-fontsize');
            ov.color = this._get('rop-color');
            const fw = Math.max(100, Math.min(900, parseInt(this._get('rop-font-weight') || (this._get('rop-bold') ? 700 : 400), 10) || 400));
            ov.font_weight = fw;
            ov.bold = fw >= 600;
            ov.stroke_color = this._get('rop-stroke-color');
            ov.stroke_width = this._get('rop-stroke-width');
            ov.shadow_color = this._get('rop-shadow-color');
            ov.shadow_blur = this._get('rop-shadow-blur');
        }

        if (ov.type === 'image') {
            ov.scale = this._get('rop-scale') / 100;
            ov.flip_h = this._get('rop-flip-h');
            ov.flip_v = this._get('rop-flip-v');
            ov.blend_mode = this._get('rop-blend');
        }

        if (ov.type === 'textcard') {
            ov.card_color = this._get('rop-card-color');
            ov.card_opacity = this._get('rop-card-opacity');
            ov.radius_tl = this._get('rop-radius-tl');
            ov.radius_tr = this._get('rop-radius-tr');
            ov.radius_bl = this._get('rop-radius-bl');
            ov.radius_br = this._get('rop-radius-br');
            ov.title_text = this._get('rop-title-text');
            ov.title_font_family = this._get('rop-title-font');
            ov.title_fontsize = this._get('rop-title-fontsize');
            ov.title_color = this._get('rop-title-color');
            const tw = Math.max(100, Math.min(900, parseInt(this._get('rop-title-weight') || (this._get('rop-title-bold') ? 900 : 400), 10) || 900));
            ov.title_font_weight = tw;
            ov.title_bold = tw >= 600;
            ov.title_uppercase = this._get('rop-title-uppercase');
            ov.title_align = this._get('rop-title-align');
            ov.body_text = this._get('rop-body-text');
            ov.body_font_family = this._get('rop-body-font');
            ov.body_fontsize = this._get('rop-body-fontsize');
            ov.body_color = this._get('rop-body-color');
            const bw = Math.max(100, Math.min(900, parseInt(this._get('rop-body-weight') || (this._get('rop-body-bold') ? 700 : 400), 10) || 400));
            ov.body_font_weight = bw;
            ov.body_bold = bw >= 600;
            ov.body_line_spacing = this._get('rop-body-linespacing');
            ov.body_align = this._get('rop-body-align');
            ov.auto_fit = this._get('rop-auto-fit');
            ov.auto_center_v = this._get('rop-auto-center');
            ov.fullscreen_mask = this._get('rop-fullscreen-mask');
            ov.title_body_gap = this._get('rop-title-body-gap');
            ov.padding_top = this._get('rop-pad-top');
            ov.padding_bottom = this._get('rop-pad-bottom');
            ov.padding_left = this._get('rop-pad-left');
            ov.padding_right = this._get('rop-pad-right');
            const cardW = this._get('rop-card-width');
            if (cardW > 0) ov.w = cardW;
            ov.auto_shrink = this._get('rop-auto-shrink');
            ov.max_height = this._get('rop-max-height');
            ov.title_max_lines = this._get('rop-title-max-lines');
            ov.min_fontsize = this._get('rop-min-fontsize');
        }

        ov.anim_in = this._get('rop-anim-in');
        ov.anim_out = this._get('rop-anim-out');
        ov.anim_in_dur = this._get('rop-anim-in-dur');
        ov.anim_out_dur = this._get('rop-anim-out-dur');
    }

    // ═══════════════════════════════════════════════
    // 卡片模板管理
    // ═══════════════════════════════════════════════

    _getCardTemplates() {
        try {
            return JSON.parse(localStorage.getItem('reels_card_templates') || '{}');
        } catch (e) { return {}; }
    }

    _setCardTemplates(data) {
        localStorage.setItem('reels_card_templates', JSON.stringify(data));
    }

    _refreshCardTemplateSelect() {
        if (!this.container) return;
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select) return;
        const current = select.value;
        const templates = this._getCardTemplates();
        select.innerHTML = '<option value="">-- 选择模板 --</option>';
        for (const name of Object.keys(templates)) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
        }
        if (current && templates[current]) select.value = current;
    }

    _extractCardStyle(ov) {
        // Extract only card-related style from overlay (not position/text content)
        const keys = [
            'w',
            'card_color', 'card_opacity',
            'radius_tl', 'radius_tr', 'radius_bl', 'radius_br',
            'title_font_family', 'title_fontsize', 'title_font_weight', 'title_bold', 'title_italic',
            'title_color', 'title_align', 'title_uppercase', 'title_letter_spacing',
            'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
            'body_color', 'body_align', 'body_line_spacing',
            'auto_fit', 'auto_center_v',
            'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
            'title_body_gap',
            'max_height', 'auto_shrink', 'title_max_lines', 'min_fontsize', 'fullscreen_mask',
        ];
        const result = {};
        for (const k of keys) {
            if (ov[k] !== undefined) result[k] = ov[k];
        }
        return result;
    }

    _showCardTemplateNameDialog(defaultName = '') {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:99999',
                'background:rgba(0,0,0,0.6)',
                'display:flex', 'align-items:center', 'justify-content:center',
            ].join(';');

            const box = document.createElement('div');
            box.style.cssText = [
                'background:var(--bg-primary,#1e1e2e)',
                'border:1px solid var(--border-color,#444)',
                'border-radius:12px',
                'padding:20px',
                'min-width:320px',
                'box-shadow:0 8px 32px rgba(0,0,0,0.5)',
            ].join(';');

            box.innerHTML = `
                <div style="font-size:15px;font-weight:600;margin-bottom:12px;color:var(--text-primary,#fff);">保存卡片模板</div>
                <input type="text" class="rop-tpl-name-input" placeholder="请输入模板名称"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:14px;outline:none;">
                <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px;">
                    <button class="rop-tpl-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                    <button class="rop-tpl-ok" style="padding:6px 16px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;">保存</button>
                </div>
            `;

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const input = box.querySelector('.rop-tpl-name-input');
            const okBtn = box.querySelector('.rop-tpl-ok');
            const cancelBtn = box.querySelector('.rop-tpl-cancel');
            input.value = defaultName || '';

            const close = (val) => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                resolve(val);
            };

            okBtn.onclick = () => close((input.value || '').trim() || null);
            cancelBtn.onclick = () => close(null);
            overlay.onclick = (e) => { if (e.target === overlay) close(null); };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close((input.value || '').trim() || null);
                if (e.key === 'Escape') close(null);
            });
            setTimeout(() => input.focus(), 30);
        });
    }

    async _saveCardTemplate() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先选择一个文案卡片覆层');
            return;
        }
        const select = this.container.querySelector('#rop-card-tpl-select');
        const defaultName = select ? select.value : '';
        const name = await this._showCardTemplateNameDialog(defaultName);
        if (!name) return;
        const templates = this._getCardTemplates();
        templates[name] = this._extractCardStyle(this._selectedOv);
        this._setCardTemplates(templates);
        this._refreshCardTemplateSelect();
        if (select) select.value = name;
        alert(`✅ 卡片模板 "${name}" 已保存`);
    }

    async _loadCardTemplate() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先选择一个文案卡片覆层');
            return;
        }
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择一个模板');
            return;
        }
        const name = select.value;
        const templates = this._getCardTemplates();
        if (!templates[name]) return;

        Object.assign(this._selectedOv, templates[name]);
        this._syncFromOverlay(this._selectedOv);
        if (this.videoCanvas) this.videoCanvas.render();
    }

    async _deleteCardTemplate() {
        const select = this.container.querySelector('#rop-card-tpl-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要删除的模板');
            return;
        }
        const name = select.value;
        if (!confirm(`确定要删除模板 "${name}" 吗？`)) return;

        const templates = this._getCardTemplates();
        delete templates[name];
        this._setCardTemplates(templates);
        this._refreshCardTemplateSelect();
    }

    _exportCardTemplates() {
        const templates = this._getCardTemplates();
        if (Object.keys(templates).length === 0) {
            alert('您还没有保存任何自定义模板！');
            return;
        }
        const str = JSON.stringify(templates, null, 2);
        const blob = new Blob([str], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `textcard_templates_${new Date().getTime()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _importCardTemplates() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = JSON.parse(e.target.result);
                    const templates = this._getCardTemplates();
                    const count = Object.keys(data).length;
                    Object.assign(templates, data); // 合并模板
                    this._setCardTemplates(templates);
                    this._refreshCardTemplateSelect();
                    alert(`✅ 成功导入了 ${count} 个模板`);
                } catch (err) {
                    console.error('导入模板出错:', err);
                    alert('导入失败，不是有效的模板 JSON 文件。');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }
}

// ═══════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════

(function injectOverlayPanelStyles() {
    if (document.getElementById('rop-styles')) return;
    const s = document.createElement('style');
    s.id = 'rop-styles';
    s.textContent = `
        .rop-panel { font-size: 12px; color: #ccc; }
        .rop-section { margin-bottom: 12px; }
        .rop-header { display:flex; justify-content:space-between; align-items:center;
                      padding: 8px 10px; background: var(--bg-secondary, #1e1e3a);
                      border-radius: 6px 6px 0 0; font-weight: bold; font-size: 13px; }
        .rop-header-actions { display:flex; gap:4px; }
        .rop-btn { padding:3px 8px !important; font-size:11px !important; min-width:unset !important; }
        .rop-btn-full { width:100%; margin-top:4px; }
        .rop-btn-danger { color:#ff6b6b !important; }
        .rop-list { background:var(--bg-tertiary, #0f0f2e); border-radius:0 0 6px 6px; max-height:150px; overflow-y:auto; }
        .rop-list-item { display:flex; align-items:center; gap:6px; padding:6px 10px; cursor:pointer;
                         border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s; }
        .rop-list-item:hover { background:rgba(255,255,255,0.06); }
        .rop-list-item.selected { background:rgba(0,212,255,0.12); border-left:3px solid #00D4FF; }
        .rop-list-time { margin-left:auto; font-size:10px; color:#888; font-family:monospace; }
        .rop-empty { padding:16px; text-align:center; color:#555; font-style:italic; }
        .rop-group { padding:8px 10px; background:var(--bg-tertiary, #0f0f2e); border-radius:6px; margin-top:8px; }
        .rop-group-title { font-weight:bold; font-size:11px; color:#8899bb; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
        .rop-grid { display:grid; grid-template-columns: auto 1fr; gap:4px 8px; align-items:center; }
        .rop-grid label { font-size:11px; color:#999; text-align:right; }
        .rop-input { width:100%; padding:3px 6px; background:var(--bg-primary, #12122a); border:1px solid var(--border-color, #2a2a4a);
                     border-radius:4px; color:#ddd; font-size:11px; font-family:monospace; }
        .rop-input:focus { border-color:#00D4FF; outline:none; }
        .rop-range { width:100%; }
        .rop-select { width:100%; padding:3px 6px; background:var(--bg-primary, #12122a); border:1px solid var(--border-color, #2a2a4a);
                      border-radius:4px; color:#ddd; font-size:11px; }
        .rop-color { width:100%; height:24px; padding:0; border:1px solid var(--border-color, #2a2a4a); border-radius:4px; cursor:pointer; }
        .rop-textarea { width:100%; padding:6px; background:var(--bg-primary, #12122a); border:1px solid var(--border-color, #2a2a4a);
                        border-radius:4px; color:#ddd; font-size:11px; resize:vertical; margin-bottom:6px; font-family:system-ui; }
        .rop-actions { padding:8px 10px; }
        .rop-slider-combo { display:flex; align-items:center; gap:6px; width:100%; }
        .rop-slider-combo .rop-range { flex:1; min-width:0; }
        .rop-num-readout { width:52px!important; flex-shrink:0; padding:2px 4px; background:var(--bg-primary, #12122a);
                           border:1px solid var(--border-color, #2a2a4a); border-radius:4px; color:#ddd;
                           font-size:11px; font-family:monospace; text-align:center; }
        .rop-num-readout:focus { border-color:#00D4FF; outline:none; }
        .rop-reset-btn { flex-shrink:0; width:22px; height:22px; padding:0; border:1px solid rgba(255,255,255,0.1);
                         background:rgba(255,255,255,0.05); border-radius:4px; color:#888; font-size:12px;
                         cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }
        .rop-reset-btn:hover { background:rgba(0,212,255,0.15); color:#00D4FF; border-color:rgba(0,212,255,0.3); }
        .rop-reset-all { padding:2px 8px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05);
                         border-radius:4px; color:#888; font-size:10px; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
        .rop-reset-all:hover { background:rgba(0,212,255,0.15); color:#00D4FF; border-color:rgba(0,212,255,0.3); }
    `;
    document.head.appendChild(s);
})();

// Export
if (typeof window !== 'undefined') window.ReelsOverlayPanel = ReelsOverlayPanel;
