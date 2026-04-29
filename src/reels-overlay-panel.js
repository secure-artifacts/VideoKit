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

/** 四舍五入到1位小数，避免浮点精度问题 (如 19.700000000000003) */
function _ropRound(v) {
    return Math.round((parseFloat(v) || 0) * 10) / 10;
}

const ROP_TEXTCARD_DEFAULT_TRANSFORM = {
    // Center-coordinate defaults (0,0 in UI) converted to top-left for 1080x1920 canvas.
    x: 85,
    y: 310,
    w: 910,
    h: 1300,
    rotation: 0,
    opacity: 255,
};

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
            <!-- 覆层组预设 (多层) -->
            <div class="rop-section">
                <div class="rop-group">
                    <div class="rop-group-title">覆层组预设</div>
                    <div style="display:flex;gap:4px;align-items:center;">
                        <select id="rop-group-preset-select" class="rop-select" style="flex:1;"></select>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-load" style="padding:2px 8px;">加载</button>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:4px;">
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-save" style="flex:1;">保存</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-del" style="flex:1;">删除</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-import" style="flex:1;">导入</button>
                        <button class="btn btn-secondary rop-btn" id="rop-group-preset-export" style="flex:1;">导出</button>
                    </div>
                </div>
            </div>

            <!-- 覆层列表 -->
            <div class="rop-section">
                <div class="rop-header">
                    <span>覆层列表</span>
                    <div class="rop-header-actions">
                        <button class="btn btn-secondary rop-btn" id="rop-add-text" title="添加文本覆层">+ 文本</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-textcard" title="添加文字卡片" style="background:#FFD700;color:#000;">+ 文字卡片</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-image" title="添加图片/视频/动图覆层">+ 媒体</button>
                        <button class="btn btn-secondary rop-btn" id="rop-media-library" title="打开固定覆层素材库" style="padding:2px 6px;">📂</button>
                        <button class="btn btn-secondary rop-btn" id="rop-add-scroll" title="添加滚动字幕" style="background:#FF6B35;color:#fff;">+ 滚动字幕</button>
                    </div>
                </div>
                <div id="rop-overlay-list" class="rop-list"></div>
            </div>

            <!-- 属性编辑 -->
            <div id="rop-props" class="rop-section" style="display:none;">
                <div class="rop-header"><span>属性</span></div>

                <!-- 固定文案标记 -->
                <div id="rop-fixed-text-group" class="rop-group" style="display:none;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <input type="checkbox" id="rop-fixed-text" style="width:16px;height:16px;cursor:pointer;">
                        <label for="rop-fixed-text" style="font-size:12px;color:var(--text-secondary);cursor:pointer;">固定文案 <span style="color:var(--text-muted);font-size:11px;">— 勾选后文案随预设保存/加载</span></label>
                    </div>
                </div>

                <!-- 文字卡片专属：卡片模板与重置 (在全局最上面) -->
                <div id="rop-textcard-template-props" class="rop-group" style="display:none; padding-bottom: 12px; margin-bottom: 8px; border-bottom: 1px solid var(--border-color);">
                    <div class="rop-group-title" style="margin:0;">卡片模板</div>
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
                    <div style="margin-top:6px;">
                        <button class="btn btn-secondary rop-btn rop-reset-all" id="rop-card-reset-all" style="width:100%; border-color:#d75c5c; color:#d75c5c;" title="将整张卡片的排版、样式和特效彻底恢复为新建时的干净状态，保留文字内容与时间。">↺ 恢复卡片初始设置 (Factory Reset)</button>
                    </div>
                </div>

                <!-- 变换 -->
                <div id="rop-transform-group" class="rop-group">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
                        <div class="rop-group-title" style="margin:0;">变换</div>
                        <div style="display:flex;gap:4px;" id="rop-transform-btns">
                            <button class="rop-reset-all rop-reset-transform-btn" title="恢复默认位置和大小">↺ 默认</button>
                            <button class="rop-reset-all rop-fill-screen-btn" title="一键铺满画布">📐 全屏填充</button>
                        </div>
                    </div>
                    <div class="rop-grid" style="margin-top:6px;">
                        <label id="rop-xy-label-x">位置X</label><input type="number" id="rop-x" class="rop-input" step="1">
                        <label id="rop-xy-label-y">位置Y</label><input type="number" id="rop-y" class="rop-input" step="1">
                        <label id="rop-wh-label-w">宽度</label><input type="number" id="rop-w" class="rop-input" step="1">
                        <label id="rop-wh-label-h">高度</label><input type="number" id="rop-h" class="rop-input" step="1">
                        <label id="rop-rotation-label">旋转</label><input type="number" id="rop-rotation" class="rop-input" min="-360" max="360" value="0">
                        <label id="rop-opacity-label">不透明</label>
                        <div id="rop-opacity-wrap" style="display:flex;align-items:center;gap:6px;">
                            <input type="range" id="rop-opacity" class="rop-range" min="0" max="100" value="100" style="flex:1;">
                            <span id="rop-opacity-val" style="min-width:36px;text-align:right;font-size:12px;color:var(--text-muted);">100%</span>
                        </div>
                        <label id="rop-scale-label" style="display:none;">缩放%</label>
                        <div id="rop-scale-wrap" style="display:none;align-items:center;gap:6px;">
                            <input type="range" id="rop-scale" class="rop-range" min="10" max="1000" value="100" style="flex:1;">
                            <span id="rop-scale-val" style="min-width:44px;text-align:right;font-size:12px;color:var(--text-muted);">100%</span>
                        </div>
                        <div id="rop-time-in-transform" style="display:contents;">
                        <label>开始(s)</label><input type="number" id="rop-start" class="rop-input" step="0.1" min="0">
                        <label>结束(s)</label><input type="number" id="rop-end" class="rop-input" step="0.1" min="0">
                        </div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px; display:flex; justify-content:space-between; align-items:center;">
                            全程(A→B)平滑过渡
                            <label style="display:flex;align-items:center;gap:4px;font-weight:normal;color:var(--text-primary);cursor:pointer;">
                                <input type="checkbox" id="rop-anim-dest-enabled"> 启用
                            </label>
                        </div>
                        <label>终点位置X</label><input type="number" id="rop-anim-end-x" class="rop-input" step="1">
                        <label>终点位置Y</label><input type="number" id="rop-anim-end-y" class="rop-input" step="1">
                        <label>终点缩放%</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="range" id="rop-anim-end-scale" class="rop-range" min="10" max="1000" value="100" style="flex:1;">
                            <span id="rop-anim-end-scale-val" style="min-width:36px;text-align:right;font-size:12px;color:var(--text-muted);">100%</span>
                        </div>
                    </div>
                </div>

                <!-- 文字卡片布局/自动缩放（textcard覆层独有，靠近变换/动画） -->
                <div id="rop-textcard-layout-props" class="rop-group" style="display:none;">
                    <div class="rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">蒙版与布局</div>
                    <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px;">
                        <span>蒙版设置</span>
                        <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text-secondary); font-weight:normal; text-transform:none; letter-spacing:0; cursor:pointer; margin-left:auto;">
                            <input type="checkbox" id="rop-card-enabled" class="rop-defaultable" data-default="true">
                            启用
                        </label>
                    </div>
                    <div id="rop-card-mask-grid" class="rop-grid" style="margin-top:6px;">
                        <label>蒙版颜色</label><input type="color" id="rop-card-color" class="rop-color rop-defaultable" data-default="#ffffff" value="#ffffff">
                        <label>蒙版透明%</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-opacity" class="rop-range rop-defaultable" data-default="80" min="0" max="100" value="80"><input type="number" class="rop-num-readout" data-link="rop-card-opacity" min="0" max="100" value="80"><button class="rop-reset-btn" data-target="rop-card-opacity" title="恢复默认">↺</button></div>
                        <label>蒙版圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-radius-all" class="rop-range rop-defaultable" data-default="33" min="0" max="200" value="33"><input type="number" class="rop-num-readout" data-link="rop-radius-all" min="0" max="200" value="33"><button class="rop-reset-btn" data-target="rop-radius-all" title="恢复默认">↺</button></div>
                        <label>蒙版+文字位置X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-x" class="rop-range rop-defaultable" data-default="0" min="-540" max="540" value="0"><input type="number" class="rop-num-readout" data-link="rop-card-x" min="-540" max="540" value="0"><button class="rop-reset-btn" data-target="rop-card-x" title="恢复默认">↺</button></div>
                        <label>蒙版+文字位置Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-y" class="rop-range rop-defaultable" data-default="0" min="-960" max="960" value="0"><input type="number" class="rop-num-readout" data-link="rop-card-y" min="-960" max="960" value="0"><button class="rop-reset-btn" data-target="rop-card-y" title="恢复默认">↺</button></div>
                        <label>蒙版宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-width" class="rop-range rop-defaultable" data-default="910" min="100" max="1080" value="910"><input type="number" class="rop-num-readout" data-link="rop-card-width" min="100" max="1080" value="910"><button class="rop-reset-btn" data-target="rop-card-width" title="恢复默认">↺</button></div>
                        <label>蒙版高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-card-height" class="rop-range rop-defaultable" data-default="1300" min="0" max="1920" value="1300"><input type="number" class="rop-num-readout" data-link="rop-card-height" min="0" max="1920" value="1300"><button class="rop-reset-btn" data-target="rop-card-height" title="恢复默认">↺</button></div>
                        <label>全屏蒙版</label><input type="checkbox" id="rop-fullscreen-mask" class="rop-defaultable" data-default="false">
                    </div>

                    <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px; padding-bottom:4px;">
                        <span>蒙版与文字设置</span>
                    </div>
                    <div class="rop-grid">
                        <label>自动适配</label><input type="checkbox" id="rop-auto-fit" class="rop-defaultable" data-default="false">
                        <label>垂直居中</label><input type="checkbox" id="rop-auto-center" class="rop-defaultable" data-default="false">
                        <label>文字位置X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-offset-x" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-offset-x" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-offset-x" title="恢复默认">↺</button></div>
                        <label>文字位置Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-offset-y" class="rop-range rop-defaultable" data-default="0" min="-500" max="500" value="0"><input type="number" class="rop-num-readout" data-link="rop-offset-y" min="-500" max="500" value="0"><button class="rop-reset-btn" data-target="rop-offset-y" title="恢复默认">↺</button></div>
                        <label>标题与正文间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-body-gap" class="rop-range rop-defaultable" data-default="42" min="0" max="500" value="42"><input type="number" class="rop-num-readout" data-link="rop-title-body-gap" min="0" max="500" value="42"><button class="rop-reset-btn" data-target="rop-title-body-gap" title="恢复默认">↺</button></div>
                        <label>正文与结尾间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-footer-gap" class="rop-range rop-defaultable" data-default="42" min="0" max="500" value="42"><input type="number" class="rop-num-readout" data-link="rop-body-footer-gap" min="0" max="500" value="42"><button class="rop-reset-btn" data-target="rop-body-footer-gap" title="恢复默认">↺</button></div>
                        <label>文字上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-top" class="rop-range rop-defaultable" data-default="60" min="0" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-pad-top" min="0" max="200" value="60"><button class="rop-reset-btn" data-target="rop-pad-top" title="恢复默认">↺</button></div>
                        <label>文字下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-bottom" class="rop-range rop-defaultable" data-default="60" min="0" max="200" value="60"><input type="number" class="rop-num-readout" data-link="rop-pad-bottom" min="0" max="200" value="60"><button class="rop-reset-btn" data-target="rop-pad-bottom" title="恢复默认">↺</button></div>
                        <label>左边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-left" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-left" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-left" title="恢复默认">↺</button></div>
                        <label>右边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-pad-right" class="rop-range rop-defaultable" data-default="40" min="0" max="200" value="40"><input type="number" class="rop-num-readout" data-link="rop-pad-right" min="0" max="200" value="40"><button class="rop-reset-btn" data-target="rop-pad-right" title="恢复默认">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="display:flex; align-items:center; gap:6px; margin-top:8px; margin-bottom:4px;">
                        <span>自动缩放设置</span>
                        <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--text-secondary); font-weight:normal; text-transform:none; letter-spacing:0; cursor:pointer; margin-left:auto;">
                            <input type="checkbox" id="rop-auto-shrink" class="rop-defaultable" data-default="false">
                            启用
                        </label>
                    </div>
                    <div style="font-size:11px;color:var(--text-secondary);margin:2px 0 6px 0;line-height:1.5;">
                        规则：开启“自动适配”后，按“最大高度/最小字号”自动缩字；关闭后，蒙版高度按手动值生效。
                    </div>
                    <div class="rop-grid">
                        <label>最大高度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-max-height" class="rop-range rop-defaultable" data-default="1400" min="200" max="1920" value="1400"><input type="number" class="rop-num-readout" data-link="rop-max-height" min="200" max="1920" value="1600"><button class="rop-reset-btn" data-target="rop-max-height" title="恢复默认">↺</button></div>
                        <label>标题缩放行</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-max-lines" class="rop-range rop-defaultable" data-default="3" min="1" max="10" value="3"><input type="number" class="rop-num-readout" data-link="rop-title-max-lines" min="1" max="10" value="3"><button class="rop-reset-btn" data-target="rop-title-max-lines" title="恢复默认">↺</button></div>
                        <label>最小字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-min-fontsize" class="rop-range rop-defaultable" data-default="16" min="8" max="40" value="16"><input type="number" class="rop-num-readout" data-link="rop-min-fontsize" min="8" max="40" value="16"><button class="rop-reset-btn" data-target="rop-min-fontsize" title="恢复默认">↺</button></div>
                    </div>
                </div>

                <div id="rop-textcard-debug-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">排版模式与辅助线</div>
                    <div class="rop-grid">
                        <label>排版模式</label>
                        <select id="rop-layout-mode" class="rop-select rop-defaultable" data-default="flow">
                            <option value="flow">流式(自动向下贴叠)</option>
                            <option value="absolute">独立(完全解绑坐标)</option>
                        </select>
                        <label>显示全局卡片框</label><input type="checkbox" id="rop-debug-layout" class="rop-defaultable" data-default="false">
                        <label>显示标题边界框</label><input type="checkbox" id="rop-debug-title" class="rop-defaultable" data-default="false">
                        <label>显示正文边界框</label><input type="checkbox" id="rop-debug-body" class="rop-defaultable" data-default="false">
                        <label>显示结尾边界框</label><input type="checkbox" id="rop-debug-footer" class="rop-defaultable" data-default="false">
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

                <!-- 图片属性 (图片/视频覆层) -->
                <div id="rop-image-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">媒体(图/视/动图)</div>
                    <div class="rop-grid">
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



                <!-- 滚动字幕属性 (scroll覆层独有) -->
                <div id="rop-scroll-props" class="rop-group" style="display:none;">
                    <div class="rop-group-title">滚动字幕</div>

                    <!-- ① 内容：标题在前，正文在后 -->
                    <div class="rop-group-title" style="margin-top:4px;">标题</div>
                    <div class="rop-grid">
                        <label>标题文字</label>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <input type="text" id="rop-scroll-title" class="rop-input" placeholder="留空=无标题" style="flex:1;">
                            <button class="rop-richtext-btn" data-section="scroll_title" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                        </div>
                        <label>固定标题</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-title-fixed" checked>
                            <span style="font-size:11px;color:var(--text-muted);">标题不参与滚动</span>
                        </div>
                        <label>标题字号</label><input type="number" id="rop-scroll-title-fontsize" class="rop-input" min="8" max="300" value="56">
                        <label>标题颜色</label><input type="color" id="rop-scroll-title-color" class="rop-color" value="#ffffff">
                        <label>标题字重</label>
                        <select id="rop-scroll-title-weight" class="rop-select">
                            <option value="400">Regular</option><option value="500">Medium</option>
                            <option value="600">SemiBold</option><option value="700" selected>Bold</option>
                            <option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>标题大写</label><input type="checkbox" id="rop-scroll-title-uppercase" checked>
                        <label>字间距</label><input type="number" id="rop-scroll-title-letterspacing" class="rop-input" min="-20" max="100" value="0">
                        <label>标题间距</label><input type="number" id="rop-scroll-title-gap" class="rop-input" min="0" max="200" step="5" value="20">
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">标题特效</div>
                        <label>描边颜色</label><input type="color" id="rop-scroll-title-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽度</label><input type="number" id="rop-scroll-title-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>开启阴影</label><input type="checkbox" id="rop-scroll-title-shadow">
                        <label>阴影颜色</label><input type="color" id="rop-scroll-title-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-scroll-title-shadow-blur" class="rop-input" min="0" max="50" value="4">
                        <label>阴影偏移X</label><input type="number" id="rop-scroll-title-shadow-x" class="rop-input" min="-20" max="20" value="2">
                        <label>阴影偏移Y</label><input type="number" id="rop-scroll-title-shadow-y" class="rop-input" min="-20" max="20" value="2">
                    </div>

                    <div class="rop-group-title" style="margin-top:6px;">正文</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-scroll-content" class="rop-textarea" rows="4" placeholder="滚动文字内容（正文）" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="scroll_body" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-scroll-font" class="rop-select"></select>
                        <label>字号</label><input type="number" id="rop-scroll-fontsize" class="rop-input" min="8" max="300" value="40">
                        <label>颜色</label><input type="color" id="rop-scroll-color" class="rop-color" value="#ffffff">
                        <label>粗体</label><input type="checkbox" id="rop-scroll-bold">
                        <label>字重</label>
                        <select id="rop-scroll-weight" class="rop-select">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>正文大写</label><input type="checkbox" id="rop-scroll-uppercase">
                        <label>字间距</label><input type="number" id="rop-scroll-letterspacing" class="rop-input" min="-20" max="100" value="0">
                        <label>对齐</label>
                        <select id="rop-scroll-align" class="rop-select">
                            <option value="center">居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>行距</label><input type="number" id="rop-scroll-linespacing" class="rop-input" min="0" max="50" step="1" value="6">
                        <label>文本宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-scroll-textw" class="rop-range" min="100" max="1920" step="10" value="900"><input type="number" class="rop-num-readout" data-link="rop-scroll-textw" min="100" max="1920" step="10" value="900"></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">正文特效</div>
                        <label>描边颜色</label><input type="color" id="rop-scroll-stroke-color" class="rop-color" value="#000000">
                        <label>描边宽度</label><input type="number" id="rop-scroll-stroke-width" class="rop-input" min="0" max="20" step="0.5" value="0">
                        <label>开启阴影</label><input type="checkbox" id="rop-scroll-shadow">
                        <label>阴影颜色</label><input type="color" id="rop-scroll-shadow-color" class="rop-color" value="#000000">
                        <label>阴影模糊</label><input type="number" id="rop-scroll-shadow-blur" class="rop-input" min="0" max="50" value="4">
                        <label>阴影偏移X</label><input type="number" id="rop-scroll-shadow-x" class="rop-input" min="-20" max="20" value="2">
                        <label>阴影偏移Y</label><input type="number" id="rop-scroll-shadow-y" class="rop-input" min="-20" max="20" value="2">
                    </div>

                    <!-- ③ 滚动运动：位置参数 -->
                    <div class="rop-group-title" style="margin-top:8px;">滚动运动
                        <button id="rop-scroll-show-end" class="btn btn-secondary" style="float:right;padding:1px 8px;font-size:11px;border-radius:4px;">👁 显示终点</button>
                    </div>
                    <div class="rop-grid">
                        <label>开始(s)</label><input type="number" id="rop-scroll-start-time" class="rop-input" step="0.1" min="0">
                        <label>结束(s)</label><input type="number" id="rop-scroll-end-time" class="rop-input" step="0.1" min="0">
                        <label title="文字开始向上滚动时的初始Y坐标">起始Y</label><input type="number" id="rop-scroll-from-y" class="rop-input" step="10" value="960">
                        <label title="文字向上滚动最终消失或停留的结束Y坐标">结束Y</label><input type="number" id="rop-scroll-to-y" class="rop-input" step="10" value="-200">
                        <label>X位置</label><input type="number" id="rop-scroll-from-x" class="rop-input" step="10">
                        <!-- 速度参数已移除：速度由 距离÷时间 自动决定 -->
                        <input type="hidden" id="rop-scroll-speed" value="1">
                        <input type="hidden" id="rop-scroll-speed-num" value="1">
                    </div>

                    <!-- ④ 智能适配 -->
                    <div class="rop-group-title" style="margin-top:8px;">智能适配</div>
                    <div class="rop-grid">
                        <label>自动停止</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-auto-stop">
                            <span style="font-size:11px;color:var(--text-muted);">文字全显示后停止滚动</span>
                        </div>
                        <label>字号自适应</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-auto-fit">
                            <span style="font-size:11px;color:var(--text-muted);">自动缩小确保全部显示</span>
                        </div>
                        <label>最小字号</label><input type="number" id="rop-scroll-min-fontsize" class="rop-input" min="8" max="200" value="16">
                    </div>

                    <!-- ⑤ 羽化 -->
                    <div class="rop-group-title" style="margin-top:8px;">羽化</div>
                    <div class="rop-grid">
                        <label>上羽化</label><input type="number" id="rop-scroll-feather-top" class="rop-input" min="0" max="500" step="10" value="80">
                        <label>下羽化</label><input type="number" id="rop-scroll-feather-bottom" class="rop-input" min="0" max="500" step="10" value="80">
                    </div>

                    <!-- ⑥ 卡片背景 -->
                    <div class="rop-group-title" style="margin-top:8px;">卡片背景</div>
                    <div class="rop-grid">
                        <label>启用</label><input type="checkbox" id="rop-scroll-bg-enabled">
                        <label>颜色</label><input type="color" id="rop-scroll-bg-color" class="rop-color" value="#000000">
                        <label>透明度%</label><input type="number" id="rop-scroll-bg-opacity" class="rop-input" min="0" max="100" value="75">
                        <label>圆角</label><input type="number" id="rop-scroll-bg-radius" class="rop-input" min="0" max="200" value="12">
                        <label>上边距</label><input type="number" id="rop-scroll-bg-pad-top" class="rop-input" min="0" max="500" value="55">
                        <label>下边距</label><input type="number" id="rop-scroll-bg-pad-bottom" class="rop-input" min="0" max="500" value="55">
                        <label>左边距</label><input type="number" id="rop-scroll-bg-pad-left" class="rop-input" min="0" max="500" value="16">
                        <label>右边距</label><input type="number" id="rop-scroll-bg-pad-right" class="rop-input" min="0" max="500" value="16">
                        <label>全屏蒙版</label>
                        <div style="display:flex;align-items:center;gap:6px;">
                            <input type="checkbox" id="rop-scroll-bg-fullscreen">
                            <span style="font-size:11px;color:var(--text-muted);">背景铺满整个画面</span>
                        </div>
                    </div>
                </div>

                <!-- 文字卡片属性 (textcard覆层独有) -->
                <div id="rop-textcard-props" class="rop-group" style="display:none;">
                    <div class="rop-section-title" style="margin:0; font-size:13px; font-weight:bold; color:var(--text-color); margin-bottom:8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">文字设置</div>
                    <div class="rop-group-title" style="margin-top:8px;">标题</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-title-text" class="rop-textarea" rows="2" placeholder="标题文字" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="title" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
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
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-title-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label>字间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-title-letterspacing" title="恢复默认(0)">↺</button></div>
                        <label>独立边界宽</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-override-w" class="rop-range rop-defaultable" data-default="0" min="0" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-override-w" min="0" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-title-override-w" title="0=随全局">↺</button></div>
                        <label>独立边界高</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-title-override-h" title="0=无限制">↺</button></div>
                        <label>独立自动缩放</label><input type="checkbox" id="rop-title-auto-shrink" class="rop-defaultable" data-default="false">
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-linespacing" class="rop-range rop-defaultable" data-default="0" min="-50" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-linespacing" min="-50" max="100" value="0"><button class="rop-reset-btn" data-target="rop-title-linespacing" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-title-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-title-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-title-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-title-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-title-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-title-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-title-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-title-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-title-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-title-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-title-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-title-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-title-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label>背景颜色</label><input type="color" id="rop-title-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-title-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-title-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-title-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-title-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-title-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-title-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-title-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">正文</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-body-text" class="rop-textarea" rows="4" placeholder="正文文字" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="body" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
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
                        <label>字间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-body-letterspacing" title="恢复默认(0)">↺</button></div>
                        <label>独立边界宽</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-override-w" class="rop-range rop-defaultable" data-default="0" min="0" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-override-w" min="0" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-body-override-w" title="0=随全局">↺</button></div>
                        <label>独立边界高</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-body-override-h" title="0=无限制">↺</button></div>
                        <label>独立自动缩放</label><input type="checkbox" id="rop-body-auto-shrink" class="rop-defaultable" data-default="false">
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-linespacing" class="rop-range rop-defaultable" data-default="6" min="-50" max="100" value="6"><input type="number" class="rop-num-readout" data-link="rop-body-linespacing" min="-50" max="100" value="6"><button class="rop-reset-btn" data-target="rop-body-linespacing" title="恢复默认(6)">↺</button></div>
                        <label>对齐</label>
                        <select id="rop-body-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-body-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label class="rop-offset-label">位置X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-body-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-body-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-body-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-body-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-body-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-body-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-body-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-body-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-body-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-body-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-body-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-body-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-body-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label>背景颜色</label><input type="color" id="rop-body-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-body-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-body-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-body-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-body-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-body-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-body-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-body-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                    <div class="rop-group-title" style="margin-top:8px;">结尾</div>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <textarea id="rop-footer-text" class="rop-textarea" rows="2" placeholder="结尾文字（可选）" style="flex:1;"></textarea>
                        <button class="rop-richtext-btn" data-section="footer" title="逐字样式编辑" style="padding:4px 8px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--accent-primary,#7b8bef);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">✎ 富文本</button>
                    </div>
                    <div class="rop-grid">
                        <label>字体</label>
                        <select id="rop-footer-font" class="rop-select rop-defaultable" data-default="Arial">
                        </select>
                        <label>字号</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-fontsize" class="rop-range rop-defaultable" data-default="32" min="8" max="200" value="32"><input type="number" class="rop-num-readout" data-link="rop-footer-fontsize" min="8" max="200" value="32"><button class="rop-reset-btn" data-target="rop-footer-fontsize" title="恢复默认">↺</button></div>
                        <label>颜色</label><input type="color" id="rop-footer-color" class="rop-color rop-defaultable" data-default="#666666" value="#666666">
                        <label>粗体</label><input type="checkbox" id="rop-footer-bold" class="rop-defaultable" data-default="false">
                        <label>字重</label>
                        <select id="rop-footer-weight" class="rop-select rop-defaultable" data-default="400">
                            <option value="100">Thin</option><option value="200">ExtraLight</option><option value="300">Light</option>
                            <option value="400" selected>Regular</option><option value="500">Medium</option><option value="600">SemiBold</option>
                            <option value="700">Bold</option><option value="800">ExtraBold</option><option value="900">Black</option>
                        </select>
                        <label>对齐</label>
                        <select id="rop-footer-align" class="rop-select rop-defaultable" data-default="center">
                            <option value="center">水平居中</option><option value="left">左对齐</option><option value="right">右对齐</option>
                        </select>
                        <label>垂直对齐</label>
                        <select id="rop-footer-valign" class="rop-select rop-defaultable" data-default="top">
                            <option value="center">垂直居中</option><option value="top">顶部对齐</option><option value="bottom">底部对齐</option>
                        </select>
                        <label>字间距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-letterspacing" class="rop-range rop-defaultable" data-default="0" min="-20" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-letterspacing" min="-20" max="100" value="0"><button class="rop-reset-btn" data-target="rop-footer-letterspacing" title="恢复默认(0)">↺</button></div>
                        <label>独立边界宽</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-override-w" class="rop-range rop-defaultable" data-default="0" min="0" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-override-w" min="0" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-footer-override-w" title="0=随全局">↺</button></div>
                        <label>独立边界高</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-override-h" class="rop-range rop-defaultable" data-default="0" min="0" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-override-h" min="0" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-footer-override-h" title="0=无限制">↺</button></div>
                        <label>独立自动缩放</label><input type="checkbox" id="rop-footer-auto-shrink" class="rop-defaultable" data-default="false">
                        <label>行距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-linespacing" class="rop-range rop-defaultable" data-default="0" min="-50" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-linespacing" min="-50" max="100" value="0"><button class="rop-reset-btn" data-target="rop-footer-linespacing" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置X</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-footer-offset-x" class="rop-range rop-defaultable" data-default="0" min="-1080" max="1080" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-offset-x" min="-1080" max="1080" value="0"><button class="rop-reset-btn" data-target="rop-footer-offset-x" title="恢复默认(0)">↺</button></div>
                        <label class="rop-offset-label">位置Y</label>
                        <div class="rop-slider-combo rop-offset-input"><input type="range" id="rop-footer-offset-y" class="rop-range rop-defaultable" data-default="0" min="-1920" max="1920" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-offset-y" min="-1920" max="1920" value="0"><button class="rop-reset-btn" data-target="rop-footer-offset-y" title="恢复默认(0)">↺</button></div>
                        <div style="grid-column: span 2; font-size:11px; color:var(--accent); margin-top:6px; margin-bottom:2px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">独立特效 & 背景</div>
                        <label>描边颜色</label><input type="color" id="rop-footer-stroke-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>描边宽度</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-stroke-width" class="rop-range rop-defaultable" data-default="0" min="0" max="20" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-stroke-width" min="0" max="20" value="0"><button class="rop-reset-btn" data-target="rop-footer-stroke-width" title="恢复默认">↺</button></div>
                        <label>阴影颜色</label><input type="color" id="rop-footer-shadow-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>阴影模糊</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-blur" class="rop-range rop-defaultable" data-default="0" min="0" max="30" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-blur" min="0" max="30" value="0"><button class="rop-reset-btn" data-target="rop-footer-shadow-blur" title="恢复默认">↺</button></div>
                        <label>阴影偏移X</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-x" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-x" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-footer-shadow-x" title="恢复默认">↺</button></div>
                        <label>阴影偏移Y</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-shadow-y" class="rop-range rop-defaultable" data-default="2" min="-20" max="20" value="2"><input type="number" class="rop-num-readout" data-link="rop-footer-shadow-y" min="-20" max="20" value="2"><button class="rop-reset-btn" data-target="rop-footer-shadow-y" title="恢复默认">↺</button></div>
                        <label>开启背景</label><input type="checkbox" id="rop-footer-bg-enabled" class="rop-defaultable" data-default="false">
                        <label>背景模式</label>
                        <select id="rop-footer-bg-mode" class="rop-select rop-defaultable" data-default="block">
                            <option value="block">整块</option><option value="inline">每行独立包裹</option><option value="inline-joined">连体包裹</option>
                        </select>
                        <label>背景颜色</label><input type="color" id="rop-footer-bg-color" class="rop-color rop-defaultable" data-default="#000000" value="#000000">
                        <label>背景透明</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-opacity" class="rop-range rop-defaultable" data-default="60" min="0" max="100" value="60"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-opacity" min="0" max="100" value="60"><button class="rop-reset-btn" data-target="rop-footer-bg-opacity" title="恢复默认">↺</button></div>
                        <label>背景圆角</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-radius" class="rop-range rop-defaultable" data-default="12" min="0" max="100" value="12"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-radius" min="0" max="100" value="12"><button class="rop-reset-btn" data-target="rop-footer-bg-radius" title="恢复默认">↺</button></div>
                        <label>背景水平内边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-h" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-h" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-h" title="恢复默认(自动)">↺</button></div>
                        <label>背景上边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-top" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-top" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-top" title="恢复默认(自动)">↺</button></div>
                        <label>背景下边距</label>
                        <div class="rop-slider-combo"><input type="range" id="rop-footer-bg-pad-bottom" class="rop-range rop-defaultable" data-default="0" min="0" max="100" value="0"><input type="number" class="rop-num-readout" data-link="rop-footer-bg-pad-bottom" min="0" max="200" value="0"><button class="rop-reset-btn" data-target="rop-footer-bg-pad-bottom" title="恢复默认(自动)">↺</button></div>
                    </div>
                </div>

                <!-- 动画 -->
                <div class="rop-group" id="rop-animation-props">
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

                <!-- 自动着色 -->
                <div class="rop-group" id="rop-autocolor-props">
                    <div class="rop-group-title">🎨 自动着色</div>
                    <div style="padding:4px 0;">
                        <div id="rop-autocolor-rules" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;"></div>
                        <div style="display:flex;gap:4px;flex-wrap:wrap;">
                            <button id="rop-autocolor-add" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;">+ 添加关键词规则</button>
                            <button id="rop-autocolor-clear" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;opacity:0.7;">清空全部</button>
                        </div>
                        <div style="margin-top:6px;font-size:10px;color:var(--text-secondary,#888);">
                            快捷预设:
                            <span class="rop-autocolor-preset" data-preset="gold_numbers" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="数字→金色加粗">🌟金色数字</span>
                            <span class="rop-autocolor-preset" data-preset="brand" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="英文→青色, 数字→金色">🎯品牌高亮</span>
                            <span class="rop-autocolor-preset" data-preset="red_emphasis" style="cursor:pointer;color:var(--accent-primary,#7b8bef);margin-left:4px;" title="数字+标点→红色加粗">🔥红色重点</span>
                        </div>
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

        this._setupCollapsibleGroups();
        this._bindEvents();
    }

    _setupCollapsibleGroups() {
        const groups = this.container.querySelectorAll('#rop-props .rop-group');
        groups.forEach((group) => {
            if (group.dataset.collapsibleReady === '1') return;
            let header = group.querySelector(':scope > .rop-group-title');
            let headerWrap = null;
            if (!header) {
                const first = group.firstElementChild;
                if (first && first.querySelector && first.querySelector('.rop-group-title')) {
                    header = first.querySelector('.rop-group-title');
                    headerWrap = first;
                    first.classList.add('rop-collapsible-head');
                }
            }
            if (!header) return;
            group.dataset.collapsibleReady = '1';
            const childTitles = Array.from(group.children || []).filter((el) => el.classList && el.classList.contains('rop-group-title'));
            const multiSection = childTitles.length >= 2;

            // 多小节面板改为“小节单独折叠”，避免整块一起收起造成混乱
            if (!multiSection) {
                group.classList.add('rop-collapsible-group');

                const icon = document.createElement('span');
                icon.className = 'rop-collapse-icon';
                icon.textContent = '▸'; // Default to collapsed
                icon.setAttribute('aria-hidden', 'true');
                header.prepend(icon);
                header.classList.add('rop-clickable');
                header.title = '点击折叠/展开';
                
                // Add initial collapsed class
                group.classList.add('rop-collapsed');
                header.addEventListener('click', (e) => {
                    if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const next = !group.classList.contains('rop-collapsed');
                    group.classList.toggle('rop-collapsed', next);
                    icon.textContent = next ? '▸' : '▾';
                });

                if (!headerWrap) {
                    header.classList.add('rop-collapsible-head');
                }
            }

            if (multiSection) {
                this._setupSubsectionCollapsibles(group);
            }
        });
    }

    _setupSubsectionCollapsibles(group) {
        const titles = Array.from(group.children || []).filter((el) => el.classList && el.classList.contains('rop-group-title'));
        if (titles.length < 2) return;
        titles.forEach((title, idx) => {
            if (title.dataset.subsectionReady === '1') return;

            let cursor = title.nextElementSibling;
            const body = document.createElement('div');
            body.className = 'rop-subsection-body';
            while (cursor && !(cursor.classList && cursor.classList.contains('rop-group-title'))) {
                const next = cursor.nextElementSibling;
                body.appendChild(cursor);
                cursor = next;
            }

            if (!body.children.length) return;
            title.dataset.subsectionReady = '1';
            title.classList.add('rop-collapsible-head', 'rop-subsection-head');
            title.dataset.sectionTone = String((idx % 6) + 1);

            const icon = document.createElement('span');
            icon.className = 'rop-collapse-icon';
            icon.textContent = '▸'; // Default to collapsed
            icon.setAttribute('aria-hidden', 'true');
            title.prepend(icon);
            title.classList.add('rop-clickable');
            title.title = '点击折叠/展开小节';
            
            // Default to collapsed body
            body.classList.add('rop-collapsed');
            title.addEventListener('click', (e) => {
                if (e.target && e.target.closest && e.target.closest('button,input,select,textarea,a')) return;
                e.preventDefault();
                e.stopPropagation();
                const collapsed = !body.classList.contains('rop-collapsed');
                body.classList.toggle('rop-collapsed', collapsed);
                icon.textContent = collapsed ? '▸' : '▾';
            });

            title.insertAdjacentElement('afterend', body);
        });
    }

    _bindEvents() {
        // 添加覆层
        this.container.querySelector('#rop-add-text').addEventListener('click', () => this._addTextOverlay());
        this.container.querySelector('#rop-add-textcard').addEventListener('click', () => this._addTextCardOverlay());
        this.container.querySelector('#rop-add-image').addEventListener('click', () => this._addImageOverlay());
        this.container.querySelector('#rop-media-library').addEventListener('click', () => this._openMediaLibrary());
        this.container.querySelector('#rop-add-scroll').addEventListener('click', () => this._addScrollOverlay());
        this.container.querySelector('#rop-duplicate').addEventListener('click', () => this._duplicateOverlay());
        this.container.querySelector('#rop-delete').addEventListener('click', () => this._deleteOverlay());

        // "显示终点" toggle
        const showEndBtn = this.container.querySelector('#rop-scroll-show-end');
        if (showEndBtn) {
            showEndBtn.addEventListener('click', () => {
                const active = showEndBtn.classList.toggle('active');
                showEndBtn.style.background = active ? '#FF6B35' : '';
                showEndBtn.style.color = active ? '#fff' : '';
                showEndBtn.textContent = active ? '👁 终点预览中' : '👁 显示终点';
                // Set global flag for render loop
                if (window._reelsState) window._reelsState._scrollPreviewEnd = active;
            });
        }

        // Overlay group presets
        this.container.querySelector('#rop-group-preset-save')?.addEventListener('click', () => this._saveOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-load')?.addEventListener('click', () => this._loadOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-del')?.addEventListener('click', () => this._deleteOverlayGroupPreset());
        this.container.querySelector('#rop-group-preset-import')?.addEventListener('click', () => this._importOverlayGroupPresets());
        this.container.querySelector('#rop-group-preset-export')?.addEventListener('click', () => this._exportOverlayGroupPresets());
        this._refreshOverlayGroupPresetSelect();

        // ── 富文本编辑按钮 (覆层 textcard) ──
        this.container.querySelectorAll('.rop-richtext-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const section = btn.getAttribute('data-section'); // title | body | footer
                if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
                this._openOverlayRichTextEditor(section);
            });
        });

        // Reset to default buttons
        this.container.querySelectorAll('.rop-reset-transform-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const ov = this._selectedOv;
                if (ov.type === 'textcard') {
                    ov.x = ROP_TEXTCARD_DEFAULT_TRANSFORM.x;
                    ov.y = ROP_TEXTCARD_DEFAULT_TRANSFORM.y;
                    ov.w = ROP_TEXTCARD_DEFAULT_TRANSFORM.w;
                    ov.h = ROP_TEXTCARD_DEFAULT_TRANSFORM.h;
                    ov.rotation = ROP_TEXTCARD_DEFAULT_TRANSFORM.rotation;
                    ov.opacity = ROP_TEXTCARD_DEFAULT_TRANSFORM.opacity;
                } else {
                    ov.w = 300;
                    ov.h = 300;
                    ov.x = (1080 - ov.w) / 2;  // 居中
                    ov.y = (1920 - ov.h) / 2;
                    ov.rotation = 0;
                    ov.opacity = 255;
                }
                if (ov.type === 'image') ov.scale = 1;
                this._syncFromOverlay(ov);
                if (this.videoCanvas) this.videoCanvas.render();
            });
        });

        // Fill screen buttons
        this.container.querySelectorAll('.rop-fill-screen-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const ov = this._selectedOv;
                ov.x = 0;
                ov.y = 0;
                ov.w = 1080;
                ov.h = 1920;
                if (ov.type === 'image') ov.scale = 1;
                this._syncFromOverlay(ov);
                if (this.videoCanvas) this.videoCanvas.render();
            });
        });

        // ── Auto-Colorize UI Events ──
        this.container.querySelector('#rop-autocolor-add')?.addEventListener('click', () => {
            if (!this._selectedOv) return;
            const ov = this._selectedOv;
            ov.auto_color_rules = ov.auto_color_rules || [];
            ov.auto_color_rules.push({
                type: 'keyword',
                keywords: [''],
                color: '#FFD700',
                bold: true,
                fontsize: null
            });
            this._renderAutoColorRules();
            this._triggerOverlayChange();
        });

        this.container.querySelector('#rop-autocolor-clear')?.addEventListener('click', () => {
            if (!this._selectedOv) return;
            this._selectedOv.auto_color_rules = [];
            this._renderAutoColorRules();
            this._triggerOverlayChange();
        });

        this.container.querySelectorAll('.rop-autocolor-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!this._selectedOv) return;
                const preset = btn.getAttribute('data-preset');
                const ov = this._selectedOv;
                ov.auto_color_rules = ov.auto_color_rules || [];
                
                if (preset === 'gold_numbers') {
                    // 数字 -> 金色
                    ov.auto_color_rules.push({ type: 'number', keywords: ['\\d+(\\.\\d+)?'], color: '#FFD700', bold: true });
                } else if (preset === 'brand') {
                    ov.auto_color_rules.push({ type: 'english', keywords: ['[a-zA-Z]+'], color: '#00D4FF', bold: true });
                    ov.auto_color_rules.push({ type: 'number', keywords: ['\\d+(\\.\\d+)?'], color: '#FFD700', bold: true });
                } else if (preset === 'red_emphasis') {
                    ov.auto_color_rules.push({ type: 'number', keywords: ['\\d+(\\.\\d+)?'], color: '#FF4444', bold: true });
                    ov.auto_color_rules.push({ type: 'punctuation', keywords: ['[!?！？❤️⭐✨🔥💪…]+'], color: '#FF4444', bold: true });
                }
                
                this._renderAutoColorRules();
                this._triggerOverlayChange();
            });
        });

        // 使用 FontManager 填充字体下拉框（和字幕面板一致）
        if (window.getFontManager) {
            const fm = getFontManager();
            fm.refreshFontSelect('rop-font', 'Arial');
            fm.refreshFontSelect('rop-title-font', 'Crimson Pro');
            fm.refreshFontSelect('rop-body-font', 'Arial');
            fm.refreshFontSelect('rop-footer-font', 'Arial');
            fm.refreshFontSelect('rop-scroll-font', 'Arial');
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
            'rop-anim-dest-enabled', 'rop-anim-end-x', 'rop-anim-end-y', 'rop-anim-end-scale',
            // Text card fields
            'rop-card-enabled',
            'rop-card-color', 'rop-card-opacity', 'rop-radius-all',
            'rop-title-text', 'rop-title-font', 'rop-title-fontsize',
            'rop-title-color', 'rop-title-bold', 'rop-title-weight', 'rop-title-uppercase', 'rop-title-align', 'rop-title-valign',
            'rop-title-offset-x', 'rop-title-offset-y', 'rop-title-linespacing', 'rop-title-letterspacing',
            'rop-title-override-w', 'rop-title-override-h', 'rop-title-auto-shrink',
            'rop-body-text', 'rop-body-font', 'rop-body-fontsize',
            'rop-body-color', 'rop-body-bold', 'rop-body-weight', 'rop-body-linespacing', 'rop-body-letterspacing', 'rop-body-align', 'rop-body-valign',
            'rop-body-offset-x', 'rop-body-offset-y',
            'rop-body-override-w', 'rop-body-override-h', 'rop-body-auto-shrink',
            'rop-footer-text', 'rop-footer-font', 'rop-footer-fontsize',
            'rop-footer-color', 'rop-footer-bold', 'rop-footer-weight', 'rop-footer-align', 'rop-footer-valign',
            'rop-footer-offset-x', 'rop-footer-offset-y', 'rop-footer-linespacing', 'rop-footer-letterspacing',
            'rop-footer-override-w', 'rop-footer-override-h', 'rop-footer-auto-shrink',
            'rop-title-stroke-color', 'rop-title-stroke-width',
            'rop-title-shadow-color', 'rop-title-shadow-blur', 'rop-title-shadow-x', 'rop-title-shadow-y',
            'rop-title-bg-enabled', 'rop-title-bg-mode', 'rop-title-bg-color', 'rop-title-bg-opacity', 'rop-title-bg-radius',
            'rop-title-bg-pad-h', 'rop-title-bg-pad-top', 'rop-title-bg-pad-bottom',
            'rop-body-stroke-color', 'rop-body-stroke-width',
            'rop-body-shadow-color', 'rop-body-shadow-blur', 'rop-body-shadow-x', 'rop-body-shadow-y',
            'rop-body-bg-enabled', 'rop-body-bg-mode', 'rop-body-bg-color', 'rop-body-bg-opacity', 'rop-body-bg-radius',
            'rop-body-bg-pad-h', 'rop-body-bg-pad-top', 'rop-body-bg-pad-bottom',
            'rop-footer-stroke-color', 'rop-footer-stroke-width',
            'rop-footer-shadow-color', 'rop-footer-shadow-blur', 'rop-footer-shadow-x', 'rop-footer-shadow-y',
            'rop-footer-bg-enabled', 'rop-footer-bg-mode', 'rop-footer-bg-color', 'rop-footer-bg-opacity', 'rop-footer-bg-radius',
            'rop-footer-bg-pad-h', 'rop-footer-bg-pad-top', 'rop-footer-bg-pad-bottom',
            'rop-auto-fit', 'rop-auto-center', 'rop-fullscreen-mask', 'rop-title-body-gap', 'rop-body-footer-gap', 'rop-offset-x', 'rop-offset-y', 'rop-debug-layout', 'rop-debug-title', 'rop-debug-body', 'rop-debug-footer', 'rop-layout-mode',
            'rop-pad-top', 'rop-pad-bottom', 'rop-pad-left', 'rop-pad-right',
            'rop-card-width', 'rop-card-height', 'rop-card-x', 'rop-card-y',
            'rop-auto-shrink', 'rop-max-height', 'rop-title-max-lines', 'rop-min-fontsize',
            // Scroll fields
            'rop-scroll-content',
            'rop-scroll-title', 'rop-scroll-title-fontsize', 'rop-scroll-title-color',
            'rop-scroll-title-weight', 'rop-scroll-title-gap', 'rop-scroll-title-fixed',
            'rop-scroll-title-uppercase', 'rop-scroll-title-letterspacing',
            'rop-scroll-title-stroke-color', 'rop-scroll-title-stroke-width',
            'rop-scroll-title-shadow', 'rop-scroll-title-shadow-color',
            'rop-scroll-title-shadow-blur', 'rop-scroll-title-shadow-x', 'rop-scroll-title-shadow-y',
            'rop-scroll-font', 'rop-scroll-fontsize',
            'rop-scroll-color', 'rop-scroll-bold', 'rop-scroll-weight',
            'rop-scroll-align', 'rop-scroll-linespacing', 'rop-scroll-textw',
            'rop-scroll-stroke-color', 'rop-scroll-stroke-width',
            'rop-scroll-shadow', 'rop-scroll-shadow-color', 'rop-scroll-shadow-blur',
            'rop-scroll-from-y', 'rop-scroll-to-y', 'rop-scroll-from-x', 'rop-scroll-to-x',
            'rop-scroll-final-y', 'rop-scroll-start-offset',
            'rop-scroll-start-time', 'rop-scroll-end-time',
            'rop-scroll-speed',
            'rop-scroll-auto-stop',
            'rop-scroll-auto-fit', 'rop-scroll-min-fontsize',
            'rop-scroll-feather-top', 'rop-scroll-feather-bottom',
            'rop-scroll-bg-enabled', 'rop-scroll-bg-color', 'rop-scroll-bg-opacity',
            'rop-scroll-bg-radius', 'rop-scroll-bg-pad-top', 'rop-scroll-bg-pad-bottom',
            'rop-scroll-bg-pad-left', 'rop-scroll-bg-pad-right', 'rop-scroll-bg-fullscreen',
        ];
        for (const fid of fields) {
            const el = this.container.querySelector('#' + fid);
            if (!el) continue;
            el.addEventListener('input', () => this._syncToOverlay());
            el.addEventListener('change', () => this._syncToOverlay());
        }

        // 自动适配模式下：文字位置Y 与 上下边距互斥
        const autoFitEl = this.container.querySelector('#rop-auto-fit');
        if (autoFitEl) {
            autoFitEl.addEventListener('input', () => this._syncTextcardAutoFitModeUI());
            autoFitEl.addEventListener('change', () => this._syncTextcardAutoFitModeUI());
        }
        const autoCenterEl = this.container.querySelector('#rop-auto-center');
        if (autoCenterEl) {
            autoCenterEl.addEventListener('input', () => this._syncTextcardAutoFitModeUI());
            autoCenterEl.addEventListener('change', () => this._syncTextcardAutoFitModeUI());
        }
        const cardEnabledEl = this.container.querySelector('#rop-card-enabled');
        if (cardEnabledEl) {
            cardEnabledEl.addEventListener('input', () => this._syncTextcardMaskEnabledUI());
            cardEnabledEl.addEventListener('change', () => this._syncTextcardMaskEnabledUI());
        }

        // 文字卡片位置/尺寸已独立使用 rop-card-*，不再与变换区做镜像，避免输入时序冲突

        // 滚动字幕时间字段 ↔ 主时间字段 双向同步
        const scrollStartTime = this.container.querySelector('#rop-scroll-start-time');
        const scrollEndTime = this.container.querySelector('#rop-scroll-end-time');
        const mainStart = this.container.querySelector('#rop-start');
        const mainEnd = this.container.querySelector('#rop-end');
        if (scrollStartTime && mainStart) {
            scrollStartTime.addEventListener('input', () => { mainStart.value = scrollStartTime.value; });
            scrollStartTime.addEventListener('change', () => { mainStart.value = scrollStartTime.value; });
        }
        if (scrollEndTime && mainEnd) {
            scrollEndTime.addEventListener('input', () => { mainEnd.value = scrollEndTime.value; });
            scrollEndTime.addEventListener('change', () => { mainEnd.value = scrollEndTime.value; });
        }

        // 移除导致死循环的自动修正 "起始偏移" 逻辑（允许独立调节保证顺畅）
        // Live value display for sliders
        const opSlider = this.container.querySelector('#rop-opacity');
        const opVal = this.container.querySelector('#rop-opacity-val');
        if (opSlider && opVal) {
            opSlider.addEventListener('input', () => { opVal.textContent = opSlider.value + '%'; });
        }
        const scSlider = this.container.querySelector('#rop-scale');
        const scVal = this.container.querySelector('#rop-scale-val');
        if (scSlider && scVal) {
            scSlider.addEventListener('input', () => { scVal.textContent = scSlider.value + '%'; });
        }
        const animEndScaleSlider = this.container.querySelector('#rop-anim-end-scale');
        const animEndScaleVal = this.container.querySelector('#rop-anim-end-scale-val');
        if (animEndScaleSlider && animEndScaleVal) {
            animEndScaleSlider.addEventListener('input', () => { animEndScaleVal.textContent = animEndScaleSlider.value + '%'; });
        }

        // Scroll speed slider removed — speed is auto-calculated from distance ÷ time

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
        syncBoldToWeight('rop-footer-bold', 'rop-footer-weight', '700', '400');
        syncBoldToWeight('rop-scroll-bold', 'rop-scroll-weight', '700', '400');


        const fontWeightPairs = [
            ['rop-font', 'rop-font-weight'],
            ['rop-title-font', 'rop-title-weight'],
            ['rop-body-font', 'rop-body-weight'],
            ['rop-footer-font', 'rop-footer-weight'],
            ['rop-scroll-font', 'rop-scroll-weight'],
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

        // Drag-to-scrub on number inputs (click+drag horizontally to adjust value)
        this.container.querySelectorAll('input.rop-input[type="number"]').forEach(el => {
            el.style.cursor = 'ew-resize';
            let dragging = false, startX = 0, startVal = 0;
            el.addEventListener('mousedown', (e) => {
                // Allow clicking into input to type when already focused
                if (document.activeElement === el) return;
                dragging = true;
                startX = e.clientX;
                startVal = parseFloat(el.value) || 0;
                e.preventDefault();
                const onMove = (me) => {
                    if (!dragging) return;
                    const dx = me.clientX - startX;
                    const speed = me.shiftKey ? 0.1 : 1;
                    const step = parseFloat(el.step) || 1;
                    el.value = Math.round((startVal + dx * speed * step) / step) * step;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                };
                const onUp = () => {
                    dragging = false;
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
            // Double-click to focus for manual typing
            el.addEventListener('dblclick', (e) => {
                e.preventDefault();
                el.focus();
                el.select();
                el.style.cursor = 'text';
            });
            el.addEventListener('blur', () => {
                el.style.cursor = 'ew-resize';
            });
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { el.blur(); }
            });
        });


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
                if (!confirm('是否彻底恢复为新建卡片时的初始设置？')) return;
                
                // 1. Reset everything except weight
                this.container.querySelectorAll('.rop-defaultable').forEach(el => {
                    if (el.id && el.id.endsWith('-weight')) return; // skip weight for now
                    const def = el.dataset.default;
                    if (def == null) return;
                    if (el.type === 'checkbox') {
                        el.checked = def === 'true';
                    } else {
                        el.value = def;
                    }
                    if (el.id) {
                        const numReadout = this.container.querySelector(`.rop-num-readout[data-link="${el.id}"]`);
                        if (numReadout) numReadout.value = def;
                    }
                });

                // 2. Refresh weight options specifically so that 900/400 exist before selecting
                if (this._get('rop-title-font')) this._refreshWeightOptions('rop-title-weight', this._get('rop-title-font'));
                if (this._get('rop-body-font')) this._refreshWeightOptions('rop-body-weight', this._get('rop-body-font'));
                if (this._get('rop-footer-font')) this._refreshWeightOptions('rop-footer-weight', this._get('rop-footer-font'));
                if (this._get('rop-scroll-font')) this._refreshWeightOptions('rop-scroll-weight', this._get('rop-scroll-font'));

                // 3. Now apply weights safely
                this.container.querySelectorAll('.rop-defaultable').forEach(el => {
                    if (el.id && el.id.endsWith('-weight')) {
                        const def = el.dataset.default;
                        if (def != null) el.value = def;
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
            body_text: 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.',
            footer_text: 'I declare: the precious blood of Jesus covers my spouse, my children, and everyone I love. Angels guard every door and window—the enemy cannot come near, not even one step! Darkness cannot enter.\nLord, bring breakthrough to everyone who writes "Amen" and render every curse powerless!',
            x: ROP_TEXTCARD_DEFAULT_TRANSFORM.x,
            y: ROP_TEXTCARD_DEFAULT_TRANSFORM.y,
            w: ROP_TEXTCARD_DEFAULT_TRANSFORM.w,
            h: ROP_TEXTCARD_DEFAULT_TRANSFORM.h,
            rotation: ROP_TEXTCARD_DEFAULT_TRANSFORM.rotation,
            opacity: ROP_TEXTCARD_DEFAULT_TRANSFORM.opacity,
            start: 0, end: 9999,
        });
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    /**
     * 批量导入文字卡片 — 从 Google Sheets 粘贴 TSV
     * 格式: 第一列=标题, 第二列=内容 (支持单元格内换行)
     * 每行自动创建一个任务 + 文字卡片覆层
     */
    async _batchImportTextCards() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;

        // 弹窗让用户粘贴表格数据
        const result = await this._showBatchImportDialog();
        if (!result || !result.data || !result.data.trim()) return;

        const importType = result.type || 'textcard';

        // 解析 TSV (支持引号内换行)
        const rows = this._parseTSV(result.data);
        if (!rows.length) {
            alert('未检测到有效数据，请确保每行至少有一列内容。');
            return;
        }

        // 读取当前覆层模板样式
        const templateProps = importType === 'scroll'
            ? this._getCurrentScrollTemplate()
            : this._getCurrentCardTemplate();

        // 获取 _reelsState 来创建任务
        const state = window._reelsState;
        if (!state) {
            alert('批量Reels模块未初始化');
            return;
        }

        let created = 0;
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let rawName = '', title = '', body = '', refContent = '';
            const map = result.mapping;

            if (map && (map.name >= 0 || map.title >= 0 || map.body >= 0)) {
                if (map.name >= 0) rawName = row[map.name] || '';
                if (map.title >= 0) title = row[map.title] || '';
                if (map.body >= 0) body = row[map.body] || '';
                if (map.ref >= 0) refContent = row[map.ref] || '';
            } else {
                // 回退到旧版的简单猜测模式
                if (importType === 'scroll') {
                    if (row.length >= 3) {
                        rawName = row[0] || '';
                        title = row[1] || '';
                        body = row[2] || '';
                    } else if (row.length === 2) {
                        title = row[0] || '';
                        body = row[1] || '';
                    } else {
                        body = row[0] || '';
                    }
                } else {
                    if (row.length >= 3) {
                        rawName = row[0] || '';
                        title = row[1] || '';
                        body = row[2] || '';
                    } else {
                        title = row[0] || '';
                        body = row[1] || '';
                    }
                }
            }

            if (!title && !body && !rawName) continue; // 跳过空行

            // 命名
            const baseNameInput = rawName.trim() || `batch_${importType}_${String(i + 1).padStart(3, '0')}`;

            let task = null;
            if (typeof _getOrCreateTaskByBase === 'function' && typeof _normalizeBaseName === 'function') {
                const normBase = _normalizeBaseName(baseNameInput);
                task = _getOrCreateTaskByBase(normBase, baseNameInput);
            } else {
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
            
            // 记录专属的对齐文本内容到任务 (供字幕对齐使用)
            if (refContent) {
                task.txtContent = refContent;
            } else if (!task.txtContent && (title || body)) {
                task.txtContent = [title, body].filter(x => x).join('\\n'); // Fallback purely if ref missing
            }

            // 创建覆层
            if (importType === 'scroll') {
                const ovOpts = Object.assign({}, templateProps, {
                    scroll_title: title,
                    content: body,
                    start: 0,
                    end: 9999,
                });
                const ov = ReelsOverlay.createScrollOverlay(ovOpts);
                task.overlays.push(ov);
            } else {
                const ovOpts = Object.assign({}, templateProps, {
                    title_text: title,
                    body_text: body,
                    start: 0,
                    end: 9999,
                });
                const ov = ReelsOverlay.createTextCardOverlay(ovOpts);
                task.overlays.push(ov);
            }

            created++;
        }

        // 刷新任务列表
        if (typeof _renderTaskList === 'function') _renderTaskList();

        // 自动匹配素材
        if (typeof reelsAutoMatchFiles === 'function') reelsAutoMatchFiles();

        const typeLabel = importType === 'scroll' ? '滚动字幕' : '文字卡片';
        alert(`✅ 成功导入 ${created} 条${typeLabel}！\n\n请添加背景素材、音频等，系统将自动配对。`);
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
                'title_color', 'title_align', 'title_uppercase', 'title_line_spacing', 'title_letter_spacing',
                'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
                'body_color', 'body_align', 'body_line_spacing', 'body_letter_spacing',
                'footer_font_family', 'footer_fontsize', 'footer_font_weight', 'footer_bold', 'footer_italic',
                'footer_color', 'footer_align', 'footer_line_spacing', 'footer_letter_spacing',
                'auto_fit', 'auto_center_v', 'debug_layout', 'debug_title', 'debug_body', 'debug_footer', 'layout_mode',
                'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
                'title_body_gap', 'w',
            ];
            for (const k of keys) {
                if (ov[k] !== undefined) props[k] = ov[k];
            }
        }
        return props;
    }

    _getCurrentScrollTemplate() {
        const props = {};
        if (this._selectedOv && this._selectedOv.type === 'scroll') {
            const ov = this._selectedOv;
            const keys = [
                'font_family', 'fontsize', 'font_weight', 'bold', 'italic',
                'color', 'text_align', 'text_width',
                'use_stroke', 'stroke_color', 'stroke_width',
                'shadow_enabled', 'shadow_color', 'shadow_blur', 'shadow_opacity',
                'shadow_offset_x', 'shadow_offset_y',
                'scroll_from_x', 'scroll_from_y', 'scroll_to_x', 'scroll_to_y',
                'scroll_speed', 'scroll_auto_stop', 'scroll_auto_fit', 'scroll_min_fontsize',
                'scroll_title_fontsize', 'scroll_title_font_family', 'scroll_title_font_weight',
                'scroll_title_bold', 'scroll_title_color', 'scroll_title_align', 'scroll_title_gap', 'scroll_title_fixed',
                'feather_top', 'feather_bottom',
                'bg_enabled', 'bg_color', 'bg_opacity', 'bg_radius',
                'bg_padding_top', 'bg_padding_bottom', 'bg_padding_left', 'bg_padding_right', 'bg_fullscreen',
                'x', 'y', 'w', 'h',
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
                <div style="background:#1e1e1e;border:1px solid var(--border-color);border-radius:12px;padding:24px;width:680px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                    <h3 style="margin:0 0 8px 0;color:var(--accent);font-size:16px;">批量导入文案 (高级映射)</h3>
                    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center;">
                        <label style="font-size:12px;color:#aaa;">覆层类型：</label>
                        <select id="rop-batch-type" style="padding:4px 8px;background:#141414;border:1px solid var(--border-color);border-radius:4px;color:#ddd;font-size:12px;">
                            <option value="textcard">📝 文字卡片</option>
                            <option value="scroll">🔄 滚动字幕</option>
                        </select>
                    </div>
                    <p id="rop-batch-help" style="margin:0 0 8px 0;color:#999;font-size:12px;line-height:1.5;">
                        请将任意多列的 Excel/Google 表格内容粘贴在下方。<br>
                        系统会自动检测列数，您可以在粘贴后自由分配 **哪一列** 对应 **哪个数据**（支持分离对齐专用的参考文案）。
                    </p>
                    <textarea id="rop-batch-data" style="flex:1;min-height:220px;padding:12px;background:#141414;border:1px solid var(--border-color);border-radius:8px;color:#ddd;font-size:13px;font-family:monospace;resize:vertical;" placeholder="从表格复制粘贴到此处..."></textarea>
                    
                    <div id="rop-batch-mapper" style="display:none;background:#2a2a3e;border:1px solid #444;border-radius:8px;padding:12px;margin-top:12px;">
                        <div style="font-size:12px;color:#ccc;margin-bottom:8px;border-bottom:1px solid #444;padding-bottom:4px;">识别到 <b id="rop-batch-col-count" style="color:var(--accent);">0</b> 列数据，请分配对应关系：</div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12px;">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#aaa;">任务命名列</span>
                                <select id="rop-map-name" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#a3e86c;">标题列</span>
                                <select id="rop-map-title" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#6ec6ff;">正文列</span>
                                <select id="rop-map-body" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="color:#e8b839;" title="用于点击对齐生成字幕时的底层纯文本">对齐参考文案列</span>
                                <select id="rop-map-ref" class="rop-select" style="width:100px;font-size:11px;"></select>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
                        <button id="rop-batch-cancel" style="padding:8px 20px;background:#333;border:1px solid #555;border-radius:6px;color:#ccc;cursor:pointer;">取消</button>
                        <button id="rop-batch-ok" style="padding:8px 20px;background:var(--accent);border:none;border-radius:6px;color:#000;font-weight:bold;cursor:pointer;">导入并映射</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);

            const typeSelect = overlay.querySelector('#rop-batch-type');
            const textareaEl = overlay.querySelector('#rop-batch-data');
            const mapperEl = overlay.querySelector('#rop-batch-mapper');
            const mapName = overlay.querySelector('#rop-map-name');
            const mapTitle = overlay.querySelector('#rop-map-title');
            const mapBody = overlay.querySelector('#rop-map-body');
            const mapRef = overlay.querySelector('#rop-map-ref');
            const updateMappers = () => {
                const text = textareaEl.value;
                if (!text.trim()) { mapperEl.style.display = 'none'; return; }
                const rows = this._parseTSV(text);
                const cols = rows.length > 0 ? rows[0].length : 0;
                if (cols > 0) {
                    mapperEl.style.display = 'block';
                    overlay.querySelector('#rop-batch-col-count').innerText = cols;
                    let opts = `<option value="-1">-- 无 --</option>`;
                    for (let i = 0; i < cols; i++) opts += `<option value="${i}">第 ${i + 1} 列</option>`;
                    const refreshOptions = (selectEl, targetValue) => {
                        const cur = selectEl.value;
                        selectEl.innerHTML = opts;
                        if (targetValue !== undefined && parseInt(cur) === -1) selectEl.value = targetValue;
                        else if (cur && cur !== '-1') selectEl.value = cur;
                        else selectEl.value = targetValue !== undefined ? targetValue : "-1";
                    };
                    
                    // Defaults: (Name: Col 0), (Title: Col 1), (Body: Col 2), (Ref: None)
                    const nDefault = cols >= 3 ? 0 : -1;
                    const tDefault = cols >= 3 ? 1 : 0;
                    const bDefault = cols >= 3 ? 2 : (cols >= 2 ? 1 : 0);
                    refreshOptions(mapName, nDefault);
                    refreshOptions(mapTitle, tDefault);
                    refreshOptions(mapBody, bDefault);
                    refreshOptions(mapRef, -1);
                } else {
                    mapperEl.style.display = 'none';
                }
            };

            textareaEl.addEventListener('input', updateMappers);

            const close = (val) => {
                document.body.removeChild(overlay);
                resolve(val);
            };
            overlay.querySelector('#rop-batch-cancel').onclick = () => close(null);
            overlay.querySelector('#rop-batch-ok').onclick = () => {
                const data = textareaEl.value;
                const type = typeSelect.value;
                const mapping = {
                    name: parseInt(mapName.value),
                    title: parseInt(mapTitle.value),
                    body: parseInt(mapBody.value),
                    ref: parseInt(mapRef.value)
                };
                close({ data, type, mapping });
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

    _addScrollOverlay() {
        const ReelsOverlay = window.ReelsOverlay;
        if (!ReelsOverlay) return;
        const ov = ReelsOverlay.createScrollOverlay({
            content: '滚动字幕示例\n第二行\n第三行\n第四行\n第五行',
            start: 0, end: 10,
        });
        if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
        this._refreshList();
        this.selectOverlay(ov);
    }

    async _openMediaLibrary() {
        let folderPath = localStorage.getItem('videokit_overlay_lib_path');
        let needsReselect = false;
        if (!folderPath) {
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                folderPath = await window.electronAPI.selectDirectory();
                if (!folderPath) return;
                localStorage.setItem('videokit_overlay_lib_path', folderPath);
            } else {
                alert('环境不支持选择目录'); return;
            }
        }
        
        const loadItems = async () => {
            if (!window.electronAPI || !window.electronAPI.scanDirectory) return [];
            return await window.electronAPI.scanDirectory(folderPath);
        };
        
        let items = await loadItems();
        if (!items || items.length === 0) {
            if (confirm(`目录未找到或为空: ${folderPath}\n是否重新选择目录？`)) {
                if (window.electronAPI && window.electronAPI.selectDirectory) {
                    const newFolder = await window.electronAPI.selectDirectory();
                    if (newFolder) {
                        folderPath = newFolder;
                        localStorage.setItem('videokit_overlay_lib_path', newFolder);
                        items = await loadItems();
                    }
                }
            }
        }
        
        this._showMediaLibraryModal(folderPath, items);
    }
    
    _showMediaLibraryModal(folderPath, items) {
        let modal = document.getElementById('rop-library-modal');
        if (modal) modal.remove();
        
        modal = document.createElement('div');
        modal.id = 'rop-library-modal';
        modal.style.cssText = `
            position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 10000;
            display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px);
        `;
        
        const isMedia = (f) => /\\.(png|jpg|jpeg|gif|mp4|webm|mov)$/i.test(f);
        const folders = items.filter(i => i.isDirectory);
        const mediaFiles = items.filter(i => !i.isDirectory && isMedia(i.name));
        
        const rList = [];
        folders.forEach(f => rList.push({...f, icon: '📁', typeLabel: '序列帧'}));
        mediaFiles.forEach(m => rList.push({...m, icon: '🖼️', typeLabel: '媒体文件'}));
        
        const gridHtml = rList.map((item, idx) => `
            <div data-idx="${idx}" class="rop-lib-item" style="
                background: var(--bg-secondary); padding: 12px; border-radius: 8px; cursor: pointer;
                border: 1px solid var(--border-color); display: flex; flex-direction: column; align-items: center; gap: 8px;
                transition: all 0.2s;
            " onmouseover="this.style.borderColor='var(--accent-primary)';this.style.background='var(--hover-bg)'" 
               onmouseout="this.style.borderColor='var(--border-color)';this.style.background='var(--bg-secondary)'">
                <div style="font-size: 32px;">${item.icon}</div>
                <div style="font-size: 12px; color: #fff; text-align: center; word-break: break-all; width: 100%; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${item.name}</div>
                <div style="font-size: 10px; color: #888;">${item.typeLabel}</div>
            </div>
        `).join('');
        
        modal.innerHTML = `
            <div style="background: var(--bg-primary); width: 80%; max-width: 900px; height: 80vh; border-radius: 12px; display: flex; flex-direction: column; border: 1px solid var(--border-color); box-shadow: 0 10px 40px rgba(0,0,0,0.8);">
                <div style="padding: 16px 24px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 16px; font-weight: bold; color: #fff;">固定覆层素材库</div>
                        <div style="font-size: 12px; color: #888; margin-top: 4px; display: flex; gap: 8px; align-items:center;">
                            ${folderPath}
                            <button id="rop-lib-reselect" style="background:none; border:none; color: var(--accent-primary); cursor: pointer; font-size:11px; text-decoration:underline;">更改目录</button>
                        </div>
                    </div>
                    <button id="rop-lib-close" style="background:none; border:none; color: #fff; font-size: 24px; cursor: pointer;">&times;</button>
                </div>
                <div style="flex: 1; padding: 24px; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 16px; align-content: start;">
                    ${gridHtml || '<div style="grid-column: 1/-1; text-align: center; color: #666; padding: 40px;">目录中没有找到图片、视频或文件夹</div>'}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        document.getElementById('rop-lib-close').onclick = () => modal.remove();
        document.getElementById('rop-lib-reselect').onclick = async () => {
            if (window.electronAPI && window.electronAPI.selectDirectory) {
                const newFolder = await window.electronAPI.selectDirectory();
                if (newFolder) {
                    localStorage.setItem('videokit_overlay_lib_path', newFolder);
                    modal.remove();
                    this._openMediaLibrary();
                }
            }
        };
        
        const itemsDom = modal.querySelectorAll('.rop-lib-item');
        itemsDom.forEach(dom => {
            dom.onclick = async () => {
                const item = rList[parseInt(dom.dataset.idx)];
                modal.remove();
                
                const ReelsOverlay = window.ReelsOverlay;
                if (!ReelsOverlay) return;
                
                const toUrl = (p) => (window.electronAPI && window.electronAPI.toFileUrl) ? window.electronAPI.toFileUrl(p) : p;
                
                if (item.isDirectory) {
                    // It's a sequence folder. Retrieve all images inside.
                    const subItems = await window.electronAPI.scanDirectory(item.path);
                    const seqFiles = subItems.filter(i => !i.isDirectory && /\\.(png|jpg|jpeg)$/i.test(i.name));
                    if (seqFiles.length === 0) {
                        alert('该文件夹中没有找到任何 png/jpg 序列帧图片。');
                        return;
                    }
                    seqFiles.sort((a, b) => a.name.localeCompare(b.name));
                    
                    const seqPaths = seqFiles.map(f => toUrl(f.path));
                    const ov = ReelsOverlay.createImageOverlay({
                        content: seqPaths[0],
                        x: 390, y: 810, w: 300, h: 300,
                        start: 0, end: Math.max(1, seqPaths.length / 30)
                    });
                    ov.type = 'video';
                    ov.name = '序列帧: ' + item.name;
                    ov.is_img_sequence = true;
                    ov.sequence_frames = seqPaths;
                    ov.fps = 30;
                    
                    if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
                } else {
                    // Single file
                    const isVideo = /\\.(mp4|webm|mov|gif)$/i.test(item.name);
                    const url = toUrl(item.path);
                    const ov = ReelsOverlay.createImageOverlay({
                        content: url,
                        x: 390, y: 810, w: 300, h: 300,
                        start: 0, end: 5
                    });
                    if (isVideo) ov.type = 'video';
                    ov.name = item.name;
                    
                    if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
                }
                this._refreshList();
                this.selectOverlay(this.videoCanvas.overlayMgr.overlays[this.videoCanvas.overlayMgr.overlays.length - 1]);
            };
        });
    }

    _addImageOverlay() {
        // 弹出文件选择器
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*,video/mp4,video/webm,video/quicktime';
        input.onchange = (e) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            const ReelsOverlay = window.ReelsOverlay;
            if (!ReelsOverlay) return;

            // 多个文件则认为是本地序列帧
            if (files.length > 1) {
                // 强制按文件名排序，保证序列正确
                files.sort((a, b) => a.name.localeCompare(b.name));
                const seqPaths = files.map(file => {
                    const np = getFileNativePath(file);
                    if (np && np !== file.name && window.electronAPI && window.electronAPI.toFileUrl) {
                        return window.electronAPI.toFileUrl(np);
                    }
                    return URL.createObjectURL(file);
                });

                const ov = ReelsOverlay.createImageOverlay({
                    content: seqPaths[0], x: 390, y: 810, w: 300, h: 300,
                    start: 0, end: Math.max(1, files.length / 30),
                });
                ov.type = 'video';
                ov.name = '序列帧: ' + files[0].name;
                ov.is_img_sequence = true;
                ov.sequence_frames = seqPaths;
                ov.fps = 30; // 默认读取为 30fps

                if (this.videoCanvas) this.videoCanvas.addOverlay(ov);
                this._refreshList();
                this.selectOverlay(ov);
                return;
            }

            // 单个文件流程
            const file = files[0];
            let url;
            const nativePath = getFileNativePath(file);
            if (nativePath && nativePath !== file.name && window.electronAPI && window.electronAPI.toFileUrl) {
                url = window.electronAPI.toFileUrl(nativePath);
            }
            if (!url) {
                url = URL.createObjectURL(file);
            }
            const isVideo = file.type.startsWith('video/') || file.name.toLowerCase().endsWith('.gif');
            
            const ov = ReelsOverlay.createImageOverlay({
                content: url, x: 390, y: 810, w: 300, h: 300,
                start: 0, end: 9999,  // 9999 = 全程（跟随最终输出长度）
            });
            if (isVideo) ov.type = 'video';
            if (file.name) ov.name = file.name;
            
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
            const icon = ov.type === 'text' ? '📝' : (ov.type === 'textcard' ? '📋' : (ov.type === 'scroll' ? '🔄' : '🖼️'));
            const lockIcon = ov.fixed_text ? '🔒' : '';
            const label = ov.type === 'textcard'
                ? (ov.title_text || '').slice(0, 15) || '文字卡片'
                : (ov.type === 'scroll' ? '滚动: ' + (ov.content || '').split('\n')[0].slice(0, 12)
                : (ov.type === 'text' ? (ov.content || '').slice(0, 15) : (ov.name || (ov.type==='video' ? '视频/动图' : '图片'))));
            const opacityStyle = ov.disabled ? 'opacity: 0.5; filter: grayscale(1);' : '';
            const eyeIcon = ov.disabled ? '🙈' : '👁️'; 
            return `<div class="rop-list-item ${isSelected ? 'selected' : ''}" data-id="${ov.id}" style="${opacityStyle}">
                <span class="rop-list-arrow">${isSelected ? '▼' : '▶'}</span>
                ${icon} <span class="rop-list-label">${lockIcon}${label}</span>
                <span class="rop-list-time">${ov.start?.toFixed(1) || 0}s–${(ov.end >= 9999 ? '全程' : (ov.end?.toFixed(1) || 0) + 's')}</span>
                <button class="rop-list-toggle-eye" data-id="${ov.id}" title="${ov.disabled ? '启用 (取消隐藏)' : '临时禁用 (隐藏)'}">${eyeIcon}</button>
                <button class="rop-list-del" data-id="${ov.id}" title="删除此覆层">✕</button>
            </div>`;
        }).join('');

        list.querySelectorAll('.rop-list-item').forEach(el => {
            // Click label to select/toggle
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('rop-list-del')) return; // don't select when clicking delete
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === el.dataset.id);
                if (!ov) return;
                if (this._selectedOv?.id === ov.id) {
                    // Click again to collapse
                    this.deselectOverlay();
                } else {
                    this.selectOverlay(ov);
                }
                this._refreshList();
            });
        });

        // Disable/Enable toggles
        list.querySelectorAll('.rop-list-toggle-eye').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === id);
                if (ov) {
                    ov.disabled = !ov.disabled;
                    this._refreshList();
                    if (this.videoCanvas) this.videoCanvas.render();
                }
            });
        });

        // Delete buttons
        list.querySelectorAll('.rop-list-del').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const ov = (this.videoCanvas?.overlayMgr?.overlays || []).find(o => o.id === id);
                const label = ov ? (ov.name || ov.title_text || ov.content || '').slice(0, 20) || ov.type : id;
                if (!confirm(`确定删除覆层「${label}」吗？`)) return;
                this.videoCanvas.overlayMgr.removeOverlay(id);
                if (this._selectedOv?.id === id) {
                    this._selectedOv = null;
                    this.container.querySelector('#rop-props').style.display = 'none';
                }
                this._refreshList();
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
        this.container.querySelector('#rop-image-props').style.display = (ov.type === 'image' || ov.type === 'video') ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-props').style.display = ov.type === 'textcard' ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-layout-props').style.display = ov.type === 'textcard' ? 'block' : 'none';
        this.container.querySelector('#rop-scroll-props').style.display = ov.type === 'scroll' ? 'block' : 'none';
        this.container.querySelector('#rop-textcard-debug-props').style.display = ov.type === 'textcard' ? 'block' : 'none';
        // Show fixed_text toggle for text, textcard, and scroll overlays
        const hasText = ov.type === 'text' || ov.type === 'textcard' || ov.type === 'scroll';
        this.container.querySelector('#rop-fixed-text-group').style.display = hasText ? 'block' : 'none';

        // Image overlays: show scale, hide W/H. Others: show W/H, hide scale.
        const isImg = ov.type === 'image' || ov.type === 'video';
        const isTextCard = ov.type === 'textcard';
        // Only show template group if TextCard
        const templateGroup = this.container.querySelector('#rop-textcard-template-props');
        if (templateGroup) templateGroup.style.display = isTextCard ? 'block' : 'none';

        // Only show Transform buttons (Default, Fill Screen) for Image overlays in the generic Transform panel
        const transformBtns = this.container.querySelector('#rop-transform-btns');
        if (transformBtns) transformBtns.style.display = isImg ? 'flex' : 'none';

        // Hide entire Transform block for TextCard
        const transformGroup = this.container.querySelector('#rop-transform-group');
        if (transformGroup) transformGroup.style.display = isTextCard ? 'none' : 'block';

        // Hide Rotation and Opacity for all text-related overlays since they don't commonly use them
        const isTextBased = ov.type === 'text' || ov.type === 'scroll' || ov.type === 'textcard';
        this.container.querySelector('#rop-rotation-label').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-rotation').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-opacity-label').style.display = isTextBased ? 'none' : '';
        this.container.querySelector('#rop-opacity-wrap').style.display = isTextBased ? 'none' : 'flex';

        this.container.querySelector('#rop-xy-label-x').style.display = isTextCard ? 'none' : '';
        this.container.querySelector('#rop-x').style.display = isTextCard ? 'none' : '';
        this.container.querySelector('#rop-xy-label-y').style.display = isTextCard ? 'none' : '';
        this.container.querySelector('#rop-y').style.display = isTextCard ? 'none' : '';
        this.container.querySelector('#rop-wh-label-w').style.display = (isImg || isTextCard) ? 'none' : '';
        this.container.querySelector('#rop-w').style.display = (isImg || isTextCard) ? 'none' : '';
        this.container.querySelector('#rop-wh-label-h').style.display = (isImg || isTextCard) ? 'none' : '';
        this.container.querySelector('#rop-h').style.display = (isImg || isTextCard) ? 'none' : '';
        this.container.querySelector('#rop-scale-label').style.display = (ov.type === 'image' || ov.type === 'video') ? '' : 'none';
        this.container.querySelector('#rop-scale-wrap').style.display = (ov.type === 'image' || ov.type === 'video') ? '' : 'none';

        // Dynamic labels for scroll overlay (x/y/w/h = clip region)
        const isScroll = ov.type === 'scroll';
        this.container.querySelector('#rop-xy-label-x').textContent = isScroll ? '裁切X' : '位置X(中心)';
        this.container.querySelector('#rop-xy-label-y').textContent = isScroll ? '裁切Y' : '位置Y(中心)';
        this.container.querySelector('#rop-wh-label-w').textContent = isScroll ? '裁切宽' : '宽度';
        this.container.querySelector('#rop-wh-label-h').textContent = isScroll ? '裁切高' : '高度';

        // 滚动覆层和文字卡片: 隐藏变换区的时间字段
        // (滚动有自己的时间字段, 文字卡片通常全程显示)
        const timeInTransform = this.container.querySelector('#rop-time-in-transform');
        const hideTime = isScroll || ov.type === 'textcard';
        if (timeInTransform) timeInTransform.style.display = hideTime ? 'none' : 'contents';

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

    _getCanvasSize() {
        const c = document.getElementById('reels-preview-canvas');
        const w = (c && c.width) ? c.width : 1080;
        const h = (c && c.height) ? c.height : 1920;
        return { w, h, cx: w / 2, cy: h / 2 };
    }

    _toCenterPos(topLeftX, topLeftY, width, height) {
        const { cx, cy } = this._getCanvasSize();
        return {
            x: Math.round((topLeftX + (width / 2)) - cx),
            y: Math.round((topLeftY + (height / 2)) - cy),
        };
    }

    _toTopLeftFromCenter(centerX, centerY, width, height) {
        const { cx, cy } = this._getCanvasSize();
        return {
            x: Math.round(centerX + cx - (width / 2)),
            y: Math.round(centerY + cy - (height / 2)),
        };
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
        if (ov.type === 'scroll') {
            this._val('rop-x', Math.round(ov.x));
            this._val('rop-y', Math.round(ov.y));
        } else if (ov.type === 'textcard') {
            // Textcard position controls should reflect stored transform (x/y/w/h),
            // not rendered mask size, otherwise center 0 can appear as 85 etc.
            const pos = this._toCenterPos(
                Math.round(ov.x || 0),
                Math.round(ov.y || 0),
                Math.max(0, Math.round(ov.w ?? 0)),
                Math.max(0, Math.round(ov.h ?? 0))
            );
            this._val('rop-x', pos.x);
            this._val('rop-y', pos.y);
        } else {
            const displayW = Math.max(0, Math.round(ov._renderedW ?? ov.w ?? 0));
            const displayH = Math.max(0, Math.round(ov._renderedH ?? ov.h ?? 0));
            const displayYTop = Math.round(ov._renderedY ?? ov.y ?? 0);
            const pos = this._toCenterPos(Math.round(ov.x || 0), displayYTop, displayW, displayH);
            this._val('rop-x', pos.x);
            this._val('rop-y', pos.y);
        }
        this._val('rop-w', Math.round(ov.w));
        this._val('rop-h', Math.round(ov.h));
        this._val('rop-rotation', ov.rotation || 0);
        const opacityPct = Math.round((ov.opacity ?? 255) / 255 * 100);
        this._val('rop-opacity', opacityPct);
        const opValEl = this.container.querySelector('#rop-opacity-val');
        if (opValEl) opValEl.textContent = opacityPct + '%';
        // 清理源数据浮点精度 + 显示
        ov.start = _ropRound(ov.start || 0);
        this._val('rop-start', ov.start);
        // 9999 = 全程，面板显示实际时长但不修改数据
        let displayEnd = ov.end || 0;
        if (displayEnd >= 9999) {
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            if (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) {
                displayEnd = _ropRound(mediaEl.duration);
            } else {
                displayEnd = 9999; // 保持原值
            }
        } else {
            ov.end = _ropRound(displayEnd);
            displayEnd = ov.end;
        }
        this._val('rop-end', displayEnd);
        // 同步到滚动字幕专用的时间字段
        this._val('rop-scroll-start-time', ov.start);
        this._val('rop-scroll-end-time', displayEnd);

        // Animation
        this._val('rop-anim-dest-enabled', !!ov.anim_dest_enabled);
        this._val('rop-anim-end-x', ov.anim_end_x ?? 0);
        this._val('rop-anim-end-y', ov.anim_end_y ?? 0);
        const animEndScalePct = Math.round((ov.anim_end_scale ?? 1) * 100);
        this._val('rop-anim-end-scale', animEndScalePct);
        const animEndScaleValEl = this.container.querySelector('#rop-anim-end-scale-val');
        if (animEndScaleValEl) animEndScaleValEl.textContent = animEndScalePct + '%';

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

        if (ov.type === 'image' || ov.type === 'video') {
            const scalePct = Math.round((ov.scale || 1) * 100);
            this._val('rop-scale', scalePct);
            const scValEl = this.container.querySelector('#rop-scale-val');
            if (scValEl) scValEl.textContent = scalePct + '%';
            this._val('rop-flip-h', ov.flip_x || false);
            this._val('rop-flip-v', ov.flip_y || false);
            this._val('rop-blend', ov.blend_mode || 'source-over');
        }

        if (ov.type === 'textcard') {
            this._val('rop-card-enabled', ov.card_enabled ?? true);
            this._val('rop-card-color', ov.card_color || '#ffffff');
            this._val('rop-card-opacity', ov.card_opacity ?? 80);
            this._val('rop-radius-all', ov.radius_tl ?? 33);
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
            this._val('rop-title-valign', ov.title_valign || 'top');
            this._val('rop-title-letterspacing', ov.title_letter_spacing ?? 0);
            this._val('rop-title-override-w', ov.title_override_w ?? 0);
            this._val('rop-title-override-h', ov.title_override_h ?? 0);
            this._val('rop-title-auto-shrink', ov.title_auto_shrink === true);
            this._val('rop-title-linespacing', ov.title_line_spacing ?? 0);
            this._val('rop-title-offset-x', ov.title_offset_x ?? 0);
            this._val('rop-title-offset-y', ov.title_offset_y ?? 0);
            this._val('rop-body-text', ov.body_text || '');
            this._val('rop-body-font', ov.body_font_family || 'Arial');
            this._refreshWeightOptions('rop-body-weight', ov.body_font_family || 'Arial');
            this._val('rop-body-fontsize', ov.body_fontsize ?? 40);
            this._val('rop-body-color', ov.body_color || '#000000');
            const bw = Math.max(100, Math.min(900, parseInt(ov.body_font_weight || (ov.body_bold ? 700 : 400), 10) || 400));
            this._val('rop-body-weight', bw);
            this._val('rop-body-bold', bw >= 600);
            this._val('rop-body-letterspacing', ov.body_letter_spacing ?? 0);
            this._val('rop-body-override-w', ov.body_override_w ?? 0);
            this._val('rop-body-override-h', ov.body_override_h ?? 0);
            this._val('rop-body-auto-shrink', ov.body_auto_shrink === true);
            this._val('rop-body-linespacing', ov.body_line_spacing ?? 6);
            this._val('rop-body-align', ov.body_align || 'center');
            this._val('rop-body-valign', ov.body_valign || 'top');
            this._val('rop-body-offset-x', ov.body_offset_x ?? 0);
            this._val('rop-body-offset-y', ov.body_offset_y ?? 0);
            // Footer
            this._val('rop-footer-text', ov.footer_text || '');
            this._val('rop-footer-font', ov.footer_font_family || 'Arial');
            this._refreshWeightOptions('rop-footer-weight', ov.footer_font_family || 'Arial');
            this._val('rop-footer-fontsize', ov.footer_fontsize ?? 32);
            this._val('rop-footer-color', ov.footer_color || '#666666');
            const ftw = Math.max(100, Math.min(900, parseInt(ov.footer_font_weight || (ov.footer_bold ? 700 : 400), 10) || 400));
            this._val('rop-footer-weight', ftw);
            this._val('rop-footer-bold', ftw >= 600);
            this._val('rop-footer-letterspacing', ov.footer_letter_spacing ?? 0);
            this._val('rop-footer-override-w', ov.footer_override_w ?? 0);
            this._val('rop-footer-override-h', ov.footer_override_h ?? 0);
            this._val('rop-footer-auto-shrink', ov.footer_auto_shrink === true);
            this._val('rop-footer-linespacing', ov.footer_line_spacing ?? 0);
            this._val('rop-footer-align', ov.footer_align || 'center');
            this._val('rop-footer-valign', ov.footer_valign || 'top');
            this._val('rop-footer-offset-x', ov.footer_offset_x ?? 0);
            this._val('rop-footer-offset-y', ov.footer_offset_y ?? 0);
            // Text effects (unified fallback logic)
            const isIndep = ov.independent_effects === true;
            this._val('rop-title-stroke-color', (isIndep ? ov.title_stroke_color : ov.text_stroke_color) || '#000000');
            this._val('rop-title-stroke-width', (isIndep ? ov.title_stroke_width : ov.text_stroke_width) ?? 0);
            this._val('rop-title-shadow-color', (isIndep ? ov.title_shadow_color : ov.text_shadow_color) || '#000000');
            this._val('rop-title-shadow-blur', (isIndep ? ov.title_shadow_blur : ov.text_shadow_blur) ?? 0);
            this._val('rop-title-shadow-x', (isIndep ? ov.title_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
            this._val('rop-title-shadow-y', (isIndep ? ov.title_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
            // Backgrounds
            this._val('rop-title-bg-enabled', ov.title_bg_enabled ?? false);
            this._val('rop-title-bg-mode', ov.title_bg_mode || 'block');
            this._val('rop-title-bg-color', ov.title_bg_color || '#000000');
            this._val('rop-title-bg-opacity', ov.title_bg_opacity ?? 60);
            this._val('rop-title-bg-radius', ov.title_bg_radius ?? 12);
            this._val('rop-title-bg-pad-h', ov.title_bg_pad_h ?? 0);
            this._val('rop-title-bg-pad-top', ov.title_bg_pad_top ?? 0);
            this._val('rop-title-bg-pad-bottom', ov.title_bg_pad_bottom ?? 0);
            
            this._val('rop-body-stroke-color', (isIndep ? ov.body_stroke_color : ov.text_stroke_color) || '#000000');
            this._val('rop-body-stroke-width', (isIndep ? ov.body_stroke_width : ov.text_stroke_width) ?? 0);
            this._val('rop-body-shadow-color', (isIndep ? ov.body_shadow_color : ov.text_shadow_color) || '#000000');
            this._val('rop-body-shadow-blur', (isIndep ? ov.body_shadow_blur : ov.text_shadow_blur) ?? 0);
            this._val('rop-body-shadow-x', (isIndep ? ov.body_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
            this._val('rop-body-shadow-y', (isIndep ? ov.body_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
            this._val('rop-body-bg-enabled', ov.body_bg_enabled ?? false);
            this._val('rop-body-bg-mode', ov.body_bg_mode || 'block');
            this._val('rop-body-bg-color', ov.body_bg_color || '#000000');
            this._val('rop-body-bg-opacity', ov.body_bg_opacity ?? 60);
            this._val('rop-body-bg-radius', ov.body_bg_radius ?? 12);
            this._val('rop-body-bg-pad-h', ov.body_bg_pad_h ?? 0);
            this._val('rop-body-bg-pad-top', ov.body_bg_pad_top ?? 0);
            this._val('rop-body-bg-pad-bottom', ov.body_bg_pad_bottom ?? 0);
            
            this._val('rop-footer-stroke-color', (isIndep ? ov.footer_stroke_color : ov.text_stroke_color) || '#000000');
            this._val('rop-footer-stroke-width', (isIndep ? ov.footer_stroke_width : ov.text_stroke_width) ?? 0);
            this._val('rop-footer-shadow-color', (isIndep ? ov.footer_shadow_color : ov.text_shadow_color) || '#000000');
            this._val('rop-footer-shadow-blur', (isIndep ? ov.footer_shadow_blur : ov.text_shadow_blur) ?? 0);
            this._val('rop-footer-shadow-x', (isIndep ? ov.footer_shadow_x : ov.text_shadow_x) ?? (isIndep ? 0 : 2));
            this._val('rop-footer-shadow-y', (isIndep ? ov.footer_shadow_y : ov.text_shadow_y) ?? (isIndep ? 0 : 2));
            this._val('rop-footer-bg-enabled', ov.footer_bg_enabled ?? false);
            this._val('rop-footer-bg-mode', ov.footer_bg_mode || 'block');
            this._val('rop-footer-bg-color', ov.footer_bg_color || '#000000');
            this._val('rop-footer-bg-opacity', ov.footer_bg_opacity ?? 60);
            this._val('rop-footer-bg-radius', ov.footer_bg_radius ?? 12);
            this._val('rop-footer-bg-pad-h', ov.footer_bg_pad_h ?? 0);
            this._val('rop-footer-bg-pad-top', ov.footer_bg_pad_top ?? 0);
            this._val('rop-footer-bg-pad-bottom', ov.footer_bg_pad_bottom ?? 0);
            this._val('rop-auto-fit', ov.auto_fit === true);
            this._val('rop-auto-center', ov.auto_center_v === true);
            this._val('rop-offset-x', ov.offset_x ?? 0);
            this._val('rop-offset-y', ov.offset_y ?? 0);
            const fullMask = (ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1');
            this._val('rop-fullscreen-mask', fullMask);
            this._val('rop-title-body-gap', ov.title_body_gap ?? 42);
            this._val('rop-layout-mode', ov.layout_mode || 'flow');
            this._val('rop-debug-layout', ov.debug_layout === true);
            this._val('rop-debug-title', ov.debug_title === true);
            this._val('rop-debug-body', ov.debug_body === true);
            this._val('rop-debug-footer', ov.debug_footer === true);
            this._val('rop-body-footer-gap', ov.body_footer_gap ?? 42);
            this._val('rop-pad-top', ov.padding_top ?? 60);
            this._val('rop-pad-bottom', ov.padding_bottom ?? 60);
            this._val('rop-pad-left', ov.padding_left ?? 40);
            this._val('rop-pad-right', ov.padding_right ?? 40);
            this._val('rop-card-width', ov.w || 910);
            this._val('rop-card-height', ov.h ?? 1300);
            this._val('rop-card-x', this._get('rop-x'));
            this._val('rop-card-y', this._get('rop-y'));
            this._val('rop-auto-shrink', ov.auto_shrink === true);
            this._val('rop-max-height', ov.max_height ?? 1400);
            this._val('rop-title-max-lines', ov.title_max_lines ?? 3);
            this._val('rop-min-fontsize', ov.min_fontsize ?? 16);
            this._syncTextcardMaskEnabledUI();
            this._syncTextcardAutoFitModeUI();
        }

        if (ov.type === 'scroll') {
            this._val('rop-scroll-content', ov.content || '');
            // 标题
            this._val('rop-scroll-title', ov.scroll_title || '');
            this._val('rop-scroll-title-fontsize', ov.scroll_title_fontsize ?? 56);
            this._val('rop-scroll-title-color', ov.scroll_title_color || ov.color || '#ffffff');
            this._val('rop-scroll-title-weight', ov.scroll_title_font_weight ?? 700);
            this._val('rop-scroll-title-uppercase', ov.scroll_title_uppercase !== false);
            this._val('rop-scroll-title-letterspacing', ov.scroll_title_letter_spacing || 0);
            this._val('rop-scroll-title-gap', ov.scroll_title_gap ?? 20);
            this._val('rop-scroll-title-fixed', ov.scroll_title_fixed !== false);
            this._val('rop-scroll-title-stroke-color', ov.scroll_title_stroke_color || '#000000');
            this._val('rop-scroll-title-stroke-width', ov.scroll_title_stroke_width || 0);
            this._val('rop-scroll-title-shadow', ov.scroll_title_shadow_enabled || false);
            this._val('rop-scroll-title-shadow-color', ov.scroll_title_shadow_color || '#000000');
            this._val('rop-scroll-title-shadow-blur', ov.scroll_title_shadow_blur || 4);
            this._val('rop-scroll-title-shadow-x', ov.scroll_title_shadow_x || 2);
            this._val('rop-scroll-title-shadow-y', ov.scroll_title_shadow_y || 2);
            // 正文
            this._val('rop-scroll-font', ov.font_family || 'Arial');
            this._refreshWeightOptions('rop-scroll-weight', ov.font_family || 'Arial');
            this._val('rop-scroll-fontsize', ov.fontsize || 40);
            this._val('rop-scroll-color', ov.color || '#ffffff');
            const sw = Math.max(100, Math.min(900, parseInt(ov.font_weight || (ov.bold ? 700 : 400), 10) || 400));
            this._val('rop-scroll-weight', sw);
            this._val('rop-scroll-bold', sw >= 600);
            this._val('rop-scroll-uppercase', ov.scroll_uppercase !== false);
            this._val('rop-scroll-letterspacing', ov.scroll_letter_spacing || 0);
            this._val('rop-scroll-align', ov.text_align || 'center');
            this._val('rop-scroll-linespacing', ov.line_spacing ?? 6);
            this._val('rop-scroll-textw', ov.text_width ?? 900);
            this._val('rop-scroll-stroke-color', ov.stroke_color || '#000000');
            this._val('rop-scroll-stroke-width', ov.stroke_width || 0);
            this._val('rop-scroll-shadow', ov.shadow_enabled || false);
            this._val('rop-scroll-shadow-color', ov.shadow_color || '#000000');
            this._val('rop-scroll-shadow-blur', ov.shadow_blur || 4);
            this._val('rop-scroll-shadow-x', ov.scroll_shadow_x || 2);
            this._val('rop-scroll-shadow-y', ov.scroll_shadow_y || 2);
            // 独立同步 起始Y 和 结束Y
            this._val('rop-scroll-from-y', ov.scroll_from_y ?? 960);
            this._val('rop-scroll-to-y', ov.scroll_to_y ?? -200);
            this._val('rop-scroll-from-x', ov.scroll_from_x ?? 90);
            // scroll_speed 已移除，速度由 距离÷时间 自动决定
            this._val('rop-scroll-feather-top', ov.feather_top ?? 80);
            this._val('rop-scroll-feather-bottom', ov.feather_bottom ?? 80);
            this._val('rop-scroll-auto-stop', ov.scroll_auto_stop === true);
            this._val('rop-scroll-auto-fit', ov.scroll_auto_fit === true);
            this._val('rop-scroll-min-fontsize', ov.scroll_min_fontsize ?? 16);
            // 卡片背景
            this._val('rop-scroll-bg-enabled', ov.bg_enabled || false);
            this._val('rop-scroll-bg-color', ov.bg_color || '#000000');
            this._val('rop-scroll-bg-opacity', Math.round((ov.bg_opacity ?? 191) / 255 * 100));
            this._val('rop-scroll-bg-radius', ov.bg_radius ?? 12);
            this._val('rop-scroll-bg-pad-top', ov.bg_padding_top ?? 55);
            this._val('rop-scroll-bg-pad-bottom', ov.bg_padding_bottom ?? 55);
            this._val('rop-scroll-bg-pad-left', ov.bg_padding_left ?? 16);
            this._val('rop-scroll-bg-pad-right', ov.bg_padding_right ?? 16);
            this._val('rop-scroll-bg-fullscreen', ov.bg_fullscreen || false);
        }

        this._val('rop-anim-in', ov.anim_in_type || 'none');
        this._val('rop-anim-out', ov.anim_out_type || 'none');
        this._val('rop-anim-in-dur', ov.anim_in_duration || 0.3);
        this._val('rop-anim-out-dur', ov.anim_out_duration || 0.3);

        // Fixed text flag
        this._val('rop-fixed-text', ov.fixed_text || false);
    }

    _syncToOverlay() {
        const ov = this._selectedOv;
        if (!ov) return;

        if (ov.type === 'textcard') {
            ov.w = this._get('rop-card-width');
            ov.h = this._get('rop-card-height');
        } else {
            ov.w = this._get('rop-w');
            ov.h = this._get('rop-h');
        }
        if (ov.type === 'scroll') {
            ov.x = this._get('rop-x');
            ov.y = this._get('rop-y');
        } else {
            const centerX = ov.type === 'textcard' ? this._get('rop-card-x') : this._get('rop-x');
            const centerY = ov.type === 'textcard' ? this._get('rop-card-y') : this._get('rop-y');
            const mapW = Math.max(0, ov.w || 0);
            let mapH = Math.max(0, ov.h || 0);
            if (ov.type === 'textcard' && mapH <= 0) {
                mapH = Math.max(0, ov._renderedH || 0);
            }
            const topLeft = this._toTopLeftFromCenter(centerX, centerY, mapW, mapH);
            ov.x = topLeft.x;
            ov.y = topLeft.y;
        }
        ov.rotation = this._get('rop-rotation');
        ov.opacity = Math.round(this._get('rop-opacity') / 100 * 255);
        ov.start = _ropRound(this._get('rop-start'));
        // 保留 9999（全程）：如果面板显示的值等于视频时长，说明用户没改，保持 9999
        const panelEnd = _ropRound(this._get('rop-end'));
        if (ov.end >= 9999) {
            // 检查用户是否手动修改了结束时间
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            const videoDur = (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) ? _ropRound(mediaEl.duration) : 9999;
            if (panelEnd === videoDur || panelEnd >= 9999) {
                // 用户没改，保持 9999（全程）
            } else {
                ov.end = panelEnd;  // 用户手动改了
            }
        } else {
            ov.end = panelEnd;
        }
        
        ov.anim_dest_enabled = !!this._get('rop-anim-dest-enabled');
        ov.anim_end_x = parseFloat(this._get('rop-anim-end-x'));
        ov.anim_end_y = parseFloat(this._get('rop-anim-end-y'));
        ov.anim_end_scale = parseFloat(this._get('rop-anim-end-scale'));

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

        if (ov.type === 'image' || ov.type === 'video') {
            ov.scale = this._get('rop-scale') / 100;
            ov.flip_x = this._get('rop-flip-h');
            ov.flip_y = this._get('rop-flip-v');
            ov.blend_mode = this._get('rop-blend');
        }

        if (ov.type === 'textcard') {
            ov.card_enabled = this._get('rop-card-enabled');
            ov.card_color = this._get('rop-card-color');
            ov.card_opacity = this._get('rop-card-opacity');
            this._syncTextcardMaskEnabledUI();
            const radius = this._get('rop-radius-all');
            ov.radius_tl = radius;
            ov.radius_tr = radius;
            ov.radius_bl = radius;
            ov.radius_br = radius;
            const newTitleText = this._get('rop-title-text');
            if (newTitleText !== ov.title_text) ov.title_styled_ranges = null; // 文本改变→失效旧样式范围
            ov.title_text = newTitleText;
            ov.title_offset_x = this._get('rop-title-offset-x');
            ov.title_offset_y = this._get('rop-title-offset-y');
            ov.title_font_family = this._get('rop-title-font');
            ov.title_fontsize = this._get('rop-title-fontsize');
            ov.title_color = this._get('rop-title-color');
            const tw = Math.max(100, Math.min(900, parseInt(this._get('rop-title-weight') || (this._get('rop-title-bold') ? 900 : 400), 10) || 900));
            ov.title_font_weight = tw;
            ov.title_bold = tw >= 600;
            ov.title_uppercase = this._get('rop-title-uppercase');
            ov.title_align = this._get('rop-title-align');
            ov.title_valign = this._get('rop-title-valign');
            ov.title_letter_spacing = this._get('rop-title-letterspacing');
            ov.title_override_w = this._get('rop-title-override-w');
            ov.title_override_h = this._get('rop-title-override-h');
            ov.title_auto_shrink = this._get('rop-title-auto-shrink');
            ov.title_line_spacing = this._get('rop-title-linespacing');
            const newBodyText = this._get('rop-body-text');
            if (newBodyText !== ov.body_text) ov.body_styled_ranges = null;
            ov.body_text = newBodyText;
            ov.body_offset_x = this._get('rop-body-offset-x');
            ov.body_offset_y = this._get('rop-body-offset-y');
            ov.body_font_family = this._get('rop-body-font');
            ov.body_fontsize = this._get('rop-body-fontsize');
            ov.body_color = this._get('rop-body-color');
            const bw = Math.max(100, Math.min(900, parseInt(this._get('rop-body-weight') || (this._get('rop-body-bold') ? 700 : 400), 10) || 400));
            ov.body_font_weight = bw;
            ov.body_bold = bw >= 600;
            ov.body_letter_spacing = this._get('rop-body-letterspacing');
            ov.body_override_w = this._get('rop-body-override-w');
            ov.body_override_h = this._get('rop-body-override-h');
            ov.body_auto_shrink = this._get('rop-body-auto-shrink');
            ov.body_line_spacing = this._get('rop-body-linespacing');
            ov.body_align = this._get('rop-body-align');
            ov.body_valign = this._get('rop-body-valign');
            // Footer
            const newFooterText = this._get('rop-footer-text');
            if (newFooterText !== ov.footer_text) ov.footer_styled_ranges = null;
            ov.footer_text = newFooterText;
            ov.footer_offset_x = this._get('rop-footer-offset-x');
            ov.footer_offset_y = this._get('rop-footer-offset-y');
            ov.footer_font_family = this._get('rop-footer-font');
            ov.footer_fontsize = this._get('rop-footer-fontsize');
            ov.footer_color = this._get('rop-footer-color');
            const ftw = Math.max(100, Math.min(900, parseInt(this._get('rop-footer-weight') || (this._get('rop-footer-bold') ? 700 : 400), 10) || 400));
            ov.footer_font_weight = ftw;
            ov.footer_bold = ftw >= 600;
            ov.footer_letter_spacing = this._get('rop-footer-letterspacing');
            ov.footer_override_w = this._get('rop-footer-override-w');
            ov.footer_override_h = this._get('rop-footer-override-h');
            ov.footer_auto_shrink = this._get('rop-footer-auto-shrink');
            ov.footer_line_spacing = this._get('rop-footer-linespacing');
            ov.footer_align = this._get('rop-footer-align');
            ov.footer_valign = this._get('rop-footer-valign');
            // We now permanently use independent effects format internally.
            ov.independent_effects = true;
            // Title effects
            ov.title_stroke_color = this._get('rop-title-stroke-color');
            ov.title_stroke_width = this._get('rop-title-stroke-width');
            ov.title_shadow_color = this._get('rop-title-shadow-color');
            ov.title_shadow_blur = this._get('rop-title-shadow-blur');
            ov.title_shadow_x = this._get('rop-title-shadow-x');
            ov.title_shadow_y = this._get('rop-title-shadow-y');
            ov.title_bg_enabled = this._get('rop-title-bg-enabled');
            ov.title_bg_mode = this._get('rop-title-bg-mode');
            ov.title_bg_color = this._get('rop-title-bg-color');
            ov.title_bg_opacity = this._get('rop-title-bg-opacity');
            ov.title_bg_radius = this._get('rop-title-bg-radius');
            const tPadH = this._get('rop-title-bg-pad-h');
            const tPadTop = this._get('rop-title-bg-pad-top');
            const tPadBot = this._get('rop-title-bg-pad-bottom');
            ov.title_bg_pad_h = typeof tPadH === 'number' && !isNaN(tPadH) ? tPadH : undefined;
            ov.title_bg_pad_top = typeof tPadTop === 'number' && !isNaN(tPadTop) ? tPadTop : undefined;
            ov.title_bg_pad_bottom = typeof tPadBot === 'number' && !isNaN(tPadBot) ? tPadBot : undefined;
            // Body effects
            ov.body_stroke_color = this._get('rop-body-stroke-color');
            ov.body_stroke_width = this._get('rop-body-stroke-width');
            ov.body_shadow_color = this._get('rop-body-shadow-color');
            ov.body_shadow_blur = this._get('rop-body-shadow-blur');
            ov.body_shadow_x = this._get('rop-body-shadow-x');
            ov.body_shadow_y = this._get('rop-body-shadow-y');
            ov.body_bg_enabled = this._get('rop-body-bg-enabled');
            ov.body_bg_mode = this._get('rop-body-bg-mode');
            ov.body_bg_color = this._get('rop-body-bg-color');
            ov.body_bg_opacity = this._get('rop-body-bg-opacity');
            ov.body_bg_radius = this._get('rop-body-bg-radius');
            const bPadH = this._get('rop-body-bg-pad-h');
            const bPadTop = this._get('rop-body-bg-pad-top');
            const bPadBot = this._get('rop-body-bg-pad-bottom');
            ov.body_bg_pad_h = typeof bPadH === 'number' && !isNaN(bPadH) ? bPadH : undefined;
            ov.body_bg_pad_top = typeof bPadTop === 'number' && !isNaN(bPadTop) ? bPadTop : undefined;
            ov.body_bg_pad_bottom = typeof bPadBot === 'number' && !isNaN(bPadBot) ? bPadBot : undefined;
            // Footer effects
            ov.footer_stroke_color = this._get('rop-footer-stroke-color');
            ov.footer_stroke_width = this._get('rop-footer-stroke-width');
            ov.footer_shadow_color = this._get('rop-footer-shadow-color');
            ov.footer_shadow_blur = this._get('rop-footer-shadow-blur');
            ov.footer_shadow_x = this._get('rop-footer-shadow-x');
            ov.footer_shadow_y = this._get('rop-footer-shadow-y');
            ov.footer_bg_enabled = this._get('rop-footer-bg-enabled');
            ov.footer_bg_mode = this._get('rop-footer-bg-mode');
            ov.footer_bg_color = this._get('rop-footer-bg-color');
            ov.footer_bg_opacity = this._get('rop-footer-bg-opacity');
            ov.footer_bg_radius = this._get('rop-footer-bg-radius');
            const fPadH = this._get('rop-footer-bg-pad-h');
            const fPadTop = this._get('rop-footer-bg-pad-top');
            const fPadBot = this._get('rop-footer-bg-pad-bottom');
            ov.footer_bg_pad_h = typeof fPadH === 'number' && !isNaN(fPadH) ? fPadH : undefined;
            ov.footer_bg_pad_top = typeof fPadTop === 'number' && !isNaN(fPadTop) ? fPadTop : undefined;
            ov.footer_bg_pad_bottom = typeof fPadBot === 'number' && !isNaN(fPadBot) ? fPadBot : undefined;
            ov.auto_fit = this._get('rop-auto-fit');
            ov.auto_center_v = this._get('rop-auto-center');
            ov.layout_mode = this._get('rop-layout-mode');
            ov.debug_layout = this._get('rop-debug-layout');
            ov.debug_title = this._get('rop-debug-title');
            ov.debug_body = this._get('rop-debug-body');
            ov.debug_footer = this._get('rop-debug-footer');
            ov.offset_x = this._get('rop-offset-x');
            ov.offset_y = this._get('rop-offset-y');
            ov.fullscreen_mask = this._get('rop-fullscreen-mask');
            ov.title_body_gap = this._get('rop-title-body-gap');
            ov.body_footer_gap = this._get('rop-body-footer-gap');
            const padTop = this._get('rop-pad-top');
            const padBottom = this._get('rop-pad-bottom');
            if (padTop !== undefined) ov.padding_top = padTop;
            if (padBottom !== undefined) ov.padding_bottom = padBottom;
            ov.padding_left = this._get('rop-pad-left');
            ov.padding_right = this._get('rop-pad-right');
            ov.auto_shrink = this._get('rop-auto-shrink');
            ov.max_height = this._get('rop-max-height');
            ov.title_max_lines = this._get('rop-title-max-lines');
            ov.min_fontsize = this._get('rop-min-fontsize');
            this._syncTextcardAutoFitModeUI();
        }

        if (ov.type === 'scroll') {
            const newScrollContent = this._get('rop-scroll-content');
            if (newScrollContent !== ov.content) ov.scroll_styled_ranges = null;
            ov.content = newScrollContent;
            // 标题
            const newScrollTitle = this._get('rop-scroll-title') || '';
            if (newScrollTitle !== ov.scroll_title) ov.scroll_title_styled_ranges = null;
            ov.scroll_title = newScrollTitle;
            ov.scroll_title_fontsize = this._get('rop-scroll-title-fontsize') || 56;
            ov.scroll_title_font_weight = this._get('rop-scroll-title-weight') || 700;
            ov.scroll_title_bold = (ov.scroll_title_font_weight >= 600);
            ov.scroll_title_color = this._get('rop-scroll-title-color') || '';
            ov.scroll_title_uppercase = this._get('rop-scroll-title-uppercase');
            ov.scroll_title_letter_spacing = this._get('rop-scroll-title-letterspacing');
            ov.scroll_title_gap = this._get('rop-scroll-title-gap') ?? 20;
            ov.scroll_title_fixed = this._get('rop-scroll-title-fixed');
            ov.scroll_title_stroke_color = this._get('rop-scroll-title-stroke-color');
            ov.scroll_title_stroke_width = this._get('rop-scroll-title-stroke-width');
            ov.scroll_title_shadow_enabled = this._get('rop-scroll-title-shadow');
            ov.scroll_title_shadow_color = this._get('rop-scroll-title-shadow-color');
            ov.scroll_title_shadow_blur = this._get('rop-scroll-title-shadow-blur');
            ov.scroll_title_shadow_x = this._get('rop-scroll-title-shadow-x');
            ov.scroll_title_shadow_y = this._get('rop-scroll-title-shadow-y');
            // 正文
            ov.font_family = this._get('rop-scroll-font');
            ov.fontsize = this._get('rop-scroll-fontsize');
            ov.color = this._get('rop-scroll-color');
            const sw = Math.max(100, Math.min(900, parseInt(this._get('rop-scroll-weight') || (this._get('rop-scroll-bold') ? 700 : 400), 10) || 400));
            ov.font_weight = sw;
            ov.bold = sw >= 600;
            ov.scroll_uppercase = this._get('rop-scroll-uppercase');
            ov.scroll_letter_spacing = this._get('rop-scroll-letterspacing');
            ov.text_align = this._get('rop-scroll-align');
            ov.line_spacing = this._get('rop-scroll-linespacing');
            ov.text_width = this._get('rop-scroll-textw');
            ov.stroke_color = this._get('rop-scroll-stroke-color');
            ov.stroke_width = this._get('rop-scroll-stroke-width');
            ov.use_stroke = (ov.stroke_width || 0) > 0;
            ov.shadow_enabled = this._get('rop-scroll-shadow');
            ov.shadow_color = this._get('rop-scroll-shadow-color');
            ov.shadow_blur = this._get('rop-scroll-shadow-blur');
            ov.scroll_shadow_x = this._get('rop-scroll-shadow-x');
            ov.scroll_shadow_y = this._get('rop-scroll-shadow-y');
            // 独立获取设置，解耦拖动逻辑防止双重偏移修改死循环
            ov.scroll_from_y = this._get('rop-scroll-from-y') ?? 960;
            ov.scroll_to_y = this._get('rop-scroll-to-y') ?? -200;
            ov.scroll_from_x = this._get('rop-scroll-from-x');
            ov.scroll_to_x = ov.scroll_from_x;  // X stays the same
            ov.scroll_speed = 1;  // 固定为1，速度由 距离÷时间 自动决定
            ov.feather_top = this._get('rop-scroll-feather-top');
            ov.feather_bottom = this._get('rop-scroll-feather-bottom');
            ov.scroll_auto_stop = this._get('rop-scroll-auto-stop');
            ov.scroll_auto_fit = this._get('rop-scroll-auto-fit');
            ov.scroll_min_fontsize = this._get('rop-scroll-min-fontsize');
            // 卡片背景
            ov.bg_enabled = this._get('rop-scroll-bg-enabled');
            ov.bg_color = this._get('rop-scroll-bg-color');
            ov.bg_opacity = Math.round(this._get('rop-scroll-bg-opacity') / 100 * 255);
            ov.bg_radius = this._get('rop-scroll-bg-radius');
            ov.bg_padding_top = this._get('rop-scroll-bg-pad-top');
            ov.bg_padding_bottom = this._get('rop-scroll-bg-pad-bottom');
            ov.bg_padding_left = this._get('rop-scroll-bg-pad-left');
            ov.bg_padding_right = this._get('rop-scroll-bg-pad-right');
            ov.bg_fullscreen = this._get('rop-scroll-bg-fullscreen');
        }

        ov.anim_in_type = this._get('rop-anim-in');
        ov.anim_out_type = this._get('rop-anim-out');
        ov.anim_in_duration = this._get('rop-anim-in-dur');
        ov.anim_out_duration = this._get('rop-anim-out-dur');

        // Fixed text flag
        ov.fixed_text = this._get('rop-fixed-text');

        // Auto-Colorize panel visibility & sync
        const autoColorProps = this.container.querySelector('#rop-autocolor-props');
        if (autoColorProps) {
            if (ov.type === 'textcard' || ov.type === 'scroll') {
                autoColorProps.style.display = '';
                this._renderAutoColorRules();
            } else {
                autoColorProps.style.display = 'none';
            }
        }

        // Re-render canvas to reflect changes
        if (this.videoCanvas) this.videoCanvas.render();
    }

    _syncTextcardMaskEnabledUI() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
        const enabled = this._get('rop-card-enabled') === true;
        const grid = this.container.querySelector('#rop-card-mask-grid');
        if (!grid) return;
        grid.style.opacity = enabled ? '' : '0.45';
        grid.querySelectorAll('input, select, textarea, button').forEach((el) => {
            el.disabled = !enabled;
        });
    }

    _syncTextcardAutoFitModeUI() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') return;
        const autoFit = this._get('rop-auto-fit') === true;
        const autoCenter = this._get('rop-auto-center') === true;
        const disableOffsets = autoFit || autoCenter;
        
        const toggleControl = (id, disabled) => {
            const el = this.container.querySelector('#' + id);
            if (!el) return;
            el.disabled = !!disabled;
            const row = el.closest('.rop-slider-combo') || el.closest('div');
            if (row) row.style.opacity = disabled ? '0.5' : '';
            const label = row?.previousElementSibling;
            if (label && label.tagName === 'LABEL') label.style.opacity = disabled ? '0.55' : '';
            const num = this.container.querySelector(`.rop-num-readout[data-link="${id}"]`);
            if (num) num.disabled = !!disabled;
            const resetBtn = this.container.querySelector(`.rop-reset-btn[data-target="${id}"]`);
            if (resetBtn) resetBtn.disabled = !!disabled;
        };
        // 自动适配或居中开：禁用单独X/Y
        toggleControl('rop-offset-x', disableOffsets);
        toggleControl('rop-offset-y', disableOffsets);
        toggleControl('rop-title-offset-x', disableOffsets);
        toggleControl('rop-title-offset-y', disableOffsets);
        toggleControl('rop-body-offset-x', disableOffsets);
        toggleControl('rop-body-offset-y', disableOffsets);
        toggleControl('rop-footer-offset-x', disableOffsets);
        toggleControl('rop-footer-offset-y', disableOffsets);
        // 边距在自动适配下也生效（由于 autoH 依赖 padT 且 contentW 依赖 padL）
        toggleControl('rop-pad-top', false);
        toggleControl('rop-pad-bottom', false);
        toggleControl('rop-pad-left', false);
        toggleControl('rop-pad-right', false);
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

    /**
     * 渲染自动着色规则列表 UI
     */
    _renderAutoColorRules() {
        if (!this.container) return;
        const container = this.container.querySelector('#rop-autocolor-rules');
        if (!container) return;
        container.innerHTML = '';
        
        const ov = this._selectedOv;
        if (!ov || !ov.auto_color_rules || ov.auto_color_rules.length === 0) {
            container.innerHTML = '<div style="color:var(--text-secondary,#888);font-size:12px;text-align:center;padding:4px;">(暂无规则)</div>';
            return;
        }

        ov.auto_color_rules.forEach((rule, idx) => {
            const ruleDiv = document.createElement('div');
            ruleDiv.style.cssText = 'border:1px solid var(--border-color,#444);border-radius:4px;padding:4px 6px;background:var(--bg-tertiary,#1e1e2d);display:flex;flex-direction:column;gap:4px;';
            
            // Header: Type + Delete
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;';
            
            const select = document.createElement('select');
            select.className = 'rop-select';
            select.style.cssText = 'padding:2px 4px;font-size:11px;height:auto;flex:1;';
            const types = {
                'keyword': '🏷️ 自定义关键词',
                'number': '🔢 数字',
                'english': '🔤 英文',
                'punctuation': '❗ 标点符号',
                'quoted': '「」 引号内容',
                'emoji': '😀 Emoji'
            };
            for (const [v, n] of Object.entries(types)) {
                const opt = document.createElement('option');
                opt.value = v; opt.textContent = n;
                select.appendChild(opt);
            }
            select.value = rule.type;
            select.addEventListener('change', () => {
                rule.type = select.value;
                if (rule.type === 'number') rule.keywords = ['\\d+(\\.\\d+)?'];
                else if (rule.type === 'english') rule.keywords = ['[a-zA-Z]+'];
                else if (rule.type === 'punctuation') rule.keywords = ['[!?！？❤️⭐✨🔥💪…]+'];
                else if (rule.type === 'quoted') rule.keywords = ['[「」"\'\'][^「」"\'\']*[「」"\'\']'];
                else if (rule.type === 'emoji') rule.keywords = ['\\p{Emoji_Presentation}|\\p{Extended_Pictographic}'];
                else rule.keywords = []; // keyword type
                this._renderAutoColorRules();
                this._triggerOverlayChange();
            });
            header.appendChild(select);
            
            const delBtn = document.createElement('button');
            delBtn.innerHTML = '✕';
            delBtn.style.cssText = 'background:none;border:none;color:var(--danger,#ff4444);cursor:pointer;margin-left:8px;font-size:12px;';
            delBtn.addEventListener('click', () => {
                ov.auto_color_rules.splice(idx, 1);
                this._renderAutoColorRules();
                this._triggerOverlayChange();
            });
            header.appendChild(delBtn);
            ruleDiv.appendChild(header);

            // Keywords Input (only for 'keyword' type)
            if (rule.type === 'keyword') {
                const kwInput = document.createElement('textarea');
                kwInput.className = 'rop-textarea';
                kwInput.rows = 2;
                kwInput.style.cssText = 'padding:4px;font-size:11px;min-height:40px;max-height:150px;resize:vertical;background:var(--bg-primary,#111116);border:1px solid var(--border-color,#333);color:var(--text-primary,#eee);border-radius:4px;width:100%;box-sizing:border-box;';
                kwInput.placeholder = '输入或粘贴词语块\n支持换行和逗号分隔 (区分大小写)';
                // Display keywords joined by newlines for better visibility
                kwInput.value = (rule.keywords || []).join('\n');
                kwInput.addEventListener('input', () => {
                    // Split by newlines, English commas, or Chinese commas
                    rule.keywords = kwInput.value.split(/[\n,，]+/).map(s => s.trim()).filter(s => s);
                    this._triggerOverlayChange();
                });
                ruleDiv.appendChild(kwInput);
            }

            // Styles
            const stylesRow = document.createElement('div');
            stylesRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;';
            
            const colorPicker = document.createElement('input');
            colorPicker.type = 'color';
            colorPicker.className = 'rop-color';
            colorPicker.style.cssText = 'width:20px;height:20px;padding:0;';
            colorPicker.value = rule.color || '#ffffff';
            colorPicker.addEventListener('input', () => {
                rule.color = colorPicker.value;
                this._triggerOverlayChange();
            });
            stylesRow.appendChild(document.createTextNode('颜色'));
            stylesRow.appendChild(colorPicker);
            
            const boldCheck = document.createElement('input');
            boldCheck.type = 'checkbox';
            boldCheck.checked = !!rule.bold;
            boldCheck.addEventListener('change', () => {
                rule.bold = boldCheck.checked;
                this._triggerOverlayChange();
            });
            stylesRow.appendChild(document.createTextNode('粗体'));
            stylesRow.appendChild(boldCheck);

            ruleDiv.appendChild(stylesRow);
            container.appendChild(ruleDiv);
        });
    }

    /**
     * 打开覆层 textcard/scroll 区段的富文本编辑器
     * @param {'title'|'body'|'footer'|'scroll_title'|'scroll_body'} section
     */
    _openOverlayRichTextEditor(section) {
        const ov = this._selectedOv;
        if (!ov || (ov.type !== 'textcard' && ov.type !== 'scroll')) return;
        if (typeof ReelsRichTextEditor === 'undefined') {
            console.warn('[OverlayPanel] ReelsRichTextEditor not loaded');
            return;
        }

        // 关闭已有编辑器
        if (this._ovRtEditor) {
            this._ovRtEditor.close(false);
            this._ovRtEditor = null;
        }

        let textKey, rangesKey, baseStyle, titleStr;
        if (section === 'scroll_title') {
            textKey = 'scroll_title';
            rangesKey = 'scroll_title_styled_ranges';
            baseStyle = {
                fontsize: ov.scroll_title_fontsize || 56,
                color: ov.scroll_title_color || '#ffffff',
                bold: ov.scroll_title_bold || false,
            };
            titleStr = '滚动标题';
        } else if (section === 'scroll_body') {
            textKey = 'content';
            rangesKey = 'scroll_styled_ranges';
            baseStyle = {
                fontsize: ov.fontsize || 40,
                color: ov.color || '#ffffff',
                bold: ov.bold || false,
            };
            titleStr = '滚动正文';
        } else {
            textKey = `${section}_text`;
            rangesKey = `${section}_styled_ranges`;
            baseStyle = {
                fontsize: ov[`${section}_fontsize`] || 60,
                color: ov[`${section}_color`] || '#000000',
                bold: ov[`${section}_bold`] || false,
            };
            const sectionLabels = { title: '标题', body: '正文', footer: '结尾' };
            titleStr = sectionLabels[section] || section;
        }

        const text = ov[textKey] || '';
        const ranges = ov[rangesKey] || [];

        // 弹出位置：在按钮旁边
        const btn = this.container.querySelector(`.rop-richtext-btn[data-section="${section}"]`);
        const btnRect = btn ? btn.getBoundingClientRect() : { x: 300, y: 300, w: 80, h: 28 };

        const rtEditor = new ReelsRichTextEditor();
        this._ovRtEditor = rtEditor;

        rtEditor.onSave = (newText, newRanges) => {
            ov[textKey] = newText;
            ov[rangesKey] = (newRanges && newRanges.length > 0) ? newRanges : null;
            // 同步面板文本框
            let inputId = `rop-${section}-text`;
            if (section === 'scroll_title') inputId = 'rop-scroll-title';
            if (section === 'scroll_body') inputId = 'rop-scroll-content';
            this._val(inputId, newText);
            // 刷新预览
            if (this.videoCanvas) this.videoCanvas.render();
            this._ovRtEditor = null;
        };

        rtEditor.onChange = (newText, newRanges) => {
            ov[textKey] = newText;
            ov[rangesKey] = (newRanges && newRanges.length > 0) ? newRanges : null;
            if (this.videoCanvas) this.videoCanvas.render();
        };

        rtEditor.onCancel = () => {
            this._ovRtEditor = null;
        };

        rtEditor.open({
            title: `✎ 编辑${titleStr}富文本`,
            text,
            styled_ranges: ranges,
            baseStyle,
            rect: { x: btnRect.x, y: btnRect.y, w: btnRect.width || 80, h: btnRect.height || 28 },
        });
    }

    _extractCardStyle(ov) {
        // Extract only card-related style from overlay (not position/text content)
        const keys = [
            'w', 'h',
            'card_enabled', 'card_color', 'card_opacity',
            'radius_tl', 'radius_tr', 'radius_bl', 'radius_br',
            // 标题样式
            'title_font_family', 'title_fontsize', 'title_font_weight', 'title_bold', 'title_italic',
            'title_color', 'title_align', 'title_valign', 'title_uppercase',
            'title_line_spacing', 'title_letter_spacing',
            'title_offset_x', 'title_offset_y',
            'title_override_w', 'title_override_h', 'title_auto_shrink',
            // 正文样式
            'body_font_family', 'body_fontsize', 'body_font_weight', 'body_bold', 'body_italic',
            'body_color', 'body_align', 'body_valign',
            'body_line_spacing', 'body_letter_spacing',
            'body_offset_x', 'body_offset_y',
            'body_override_w', 'body_override_h', 'body_auto_shrink',
            // 结尾样式
            'footer_font_family', 'footer_fontsize', 'footer_font_weight', 'footer_bold', 'footer_italic',
            'footer_color', 'footer_align', 'footer_valign',
            'footer_line_spacing', 'footer_letter_spacing',
            'footer_offset_x', 'footer_offset_y',
            'footer_override_w', 'footer_override_h', 'footer_auto_shrink',
            // 布局
            'auto_fit', 'auto_center_v', 'layout_mode',
            'padding_top', 'padding_bottom', 'padding_left', 'padding_right',
            'title_body_gap', 'body_footer_gap',
            'offset_x', 'offset_y',
            'max_height', 'auto_shrink', 'title_max_lines', 'min_fontsize', 'fullscreen_mask',
            // 独立区段背景
            'title_bg_enabled', 'title_bg_mode', 'title_bg_color', 'title_bg_opacity', 'title_bg_radius', 'title_bg_pad_h', 'title_bg_pad_top', 'title_bg_pad_bottom',
            'body_bg_enabled', 'body_bg_mode', 'body_bg_color', 'body_bg_opacity', 'body_bg_radius', 'body_bg_pad_h', 'body_bg_pad_top', 'body_bg_pad_bottom',
            'footer_bg_enabled', 'footer_bg_mode', 'footer_bg_color', 'footer_bg_opacity', 'footer_bg_radius', 'footer_bg_pad_h', 'footer_bg_pad_top', 'footer_bg_pad_bottom',
            // 独立效果
            'independent_effects',
            'title_stroke_color', 'title_stroke_width', 'title_shadow_color', 'title_shadow_blur', 'title_shadow_x', 'title_shadow_y',
            'body_stroke_color', 'body_stroke_width', 'body_shadow_color', 'body_shadow_blur', 'body_shadow_x', 'body_shadow_y',
            'footer_stroke_color', 'footer_stroke_width', 'footer_shadow_color', 'footer_shadow_blur', 'footer_shadow_x', 'footer_shadow_y',
            // 动画
            'anim_in_type', 'anim_out_type', 'anim_in_duration', 'anim_out_duration',
            // 富文本样式范围
            'title_styled_ranges', 'body_styled_ranges', 'footer_styled_ranges',
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
                'position:fixed', 'inset:0', 'z-index:999999',
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

            // 防止外层事件监听器抢焦点
            input.addEventListener('mousedown', (e) => e.stopPropagation());
            input.addEventListener('click', (e) => e.stopPropagation());
            box.addEventListener('mousedown', (e) => e.stopPropagation());

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
            // 多次尝试 focus 确保 Electron 渲染完成后能获得焦点
            setTimeout(() => input.focus(), 50);
            setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 150);
        });
    }

    async _saveCardTemplate() {
        if (!this._selectedOv || this._selectedOv.type !== 'textcard') {
            alert('请先选择一个文字卡片覆层');
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
            alert('请先选择一个文字卡片覆层');
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

    // ═══════════════════════════════════════════════
    // 覆层组预设管理 (多层)
    // ═══════════════════════════════════════════════

    _getOverlayGroupPresets() {
        try {
            return JSON.parse(localStorage.getItem('reels_overlay_group_presets') || '{}');
        } catch (e) { return {}; }
    }

    _setOverlayGroupPresets(data) {
        localStorage.setItem('reels_overlay_group_presets', JSON.stringify(data));
    }

    _refreshOverlayGroupPresetSelect() {
        if (!this.container) return;
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select) return;
        const current = select.value;
        const presets = this._getOverlayGroupPresets();
        
        // 尝试合并代码内置的预设 (防止 localStorage 未初始化)
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            for (const [k, v] of Object.entries(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS)) {
                if (!presets[k]) presets[k] = v;
            }
        }

        let customHtml = '';
        let builtInHtml = '';
        const builtInKeys = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];

        for (const name of Object.keys(presets)) {
            const layers = presets[name];
            const count = Array.isArray(layers) ? layers.length : 0;
            const isBuiltin = builtInKeys.includes(name);
            const optHtml = `<option value="${name}">${name} (${count}层)</option>`;
            if (isBuiltin) builtInHtml += optHtml;
            else customHtml += optHtml;
        }

        let finalHtml = '<option value="">-- 选择预设 --</option>';
        if (customHtml) finalHtml += `<optgroup label="我的预设">${customHtml}</optgroup>`;
        if (builtInHtml) finalHtml += `<optgroup label="内置预设">${builtInHtml}</optgroup>`;
        
        select.innerHTML = finalHtml;
        if (current && presets[current]) select.value = current;
    }

    async _saveOverlayGroupPreset() {
        if (!this.videoCanvas) {
            alert('没有可用的覆层管理器');
            return;
        }
        const overlays = this.videoCanvas.overlayMgr?.overlays || [];
        if (overlays.length === 0) {
            alert('当前没有覆层，请先添加覆层再保存');
            return;
        }
        const name = await this._showCardTemplateNameDialog('');
        if (!name) return;

        // Deep clone overlays, strip runtime-only keys and text content
        const serialized = overlays.map(ov => {
            const clone = JSON.parse(JSON.stringify(ov));
            delete clone._img;
            delete clone._imgLoaded;
            delete clone._templateName;
            // Only keep text content for layers marked as fixed
            if (!clone.fixed_text) {
                delete clone.title_text;
                delete clone.body_text;
                delete clone.footer_text;
                if (clone.type === 'text' || clone.type === 'scroll') delete clone.content;
            }
            // 预设始终存储全程标志，不保留固定时长
            clone.start = 0;
            clone.end = 9999;
            return clone;
        });

        const presets = this._getOverlayGroupPresets();
        presets[name] = serialized;
        this._setOverlayGroupPresets(presets);
        this._refreshOverlayGroupPresetSelect();
        const select = this.container.querySelector('#rop-group-preset-select');
        if (select) select.value = name;
        alert(`✅ 覆层组预设 "${name}" 已保存 (${serialized.length} 层)`);
    }

    _loadOverlayGroupPreset() {
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择一个预设');
            return;
        }
        const name = select.value;
        const presets = this._getOverlayGroupPresets();
        const layers = presets[name];
        if (!Array.isArray(layers) || layers.length === 0) {
            alert('该预设为空或格式不正确');
            return;
        }
        if (!this.videoCanvas) return;

        const mgr = this.videoCanvas.overlayMgr;
        if (!mgr) return;

        // Confirm if there are existing overlays
        if (mgr.overlays.length > 0) {
            if (!confirm(`当前有 ${mgr.overlays.length} 个覆层，加载预设将替换全部。继续？`)) return;
        }

        // Save existing overlays' text before clearing
        const oldOverlays = [...mgr.overlays];

        // Clear existing
        mgr.overlays = [];

        // Deep-clone and add each layer with new IDs, preserving existing text
        for (let i = 0; i < layers.length; i++) {
            const layerData = layers[i];
            const clone = JSON.parse(JSON.stringify(layerData));
            clone.id = 'ov_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            // 强制全程：兼容旧预设中存储的固定时长
            clone.start = 0;
            clone.end = 9999;
            // For non-fixed layers, preserve text from corresponding old overlay
            if (!clone.fixed_text) {
                const old = oldOverlays[i];
                if (old) {
                    if (old.title_text) clone.title_text = old.title_text;
                    if (old.body_text) clone.body_text = old.body_text;
                    if (old.footer_text) clone.footer_text = old.footer_text;
                    if (old.content && (clone.type === 'text' || clone.type === 'scroll')) clone.content = old.content;
                }
            }
            // Fixed layers already have text from preset — use as-is
            mgr.overlays.push(clone);
        }

        // Refresh UI
        this._selectedOv = mgr.overlays[0] || null;
        this._refreshList();
        if (this._selectedOv) this._syncFromOverlay(this._selectedOv);
        if (this.videoCanvas) this.videoCanvas.render();
    }

    _deleteOverlayGroupPreset() {
        const select = this.container.querySelector('#rop-group-preset-select');
        if (!select || !select.value) {
            alert('请先在下拉列表中选择要删除的预设');
            return;
        }
        const name = select.value;
        if (!confirm(`确定要删除预设 "${name}" 吗？`)) return;
        const presets = this._getOverlayGroupPresets();
        delete presets[name];
        this._setOverlayGroupPresets(presets);
        this._refreshOverlayGroupPresetSelect();
    }

    _importOverlayGroupPresets() {
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
                    const presets = this._getOverlayGroupPresets();
                    const count = Object.keys(data).length;
                    Object.assign(presets, data);
                    this._setOverlayGroupPresets(presets);
                    this._refreshOverlayGroupPresetSelect();
                    alert(`✅ 成功导入了 ${count} 个覆层组预设`);
                } catch (err) {
                    console.error('导入预设出错:', err);
                    alert('导入失败，不是有效的预设 JSON 文件。');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    _exportOverlayGroupPresets() {
        const presets = this._getOverlayGroupPresets();
        const keys = Object.keys(presets);
        if (keys.length === 0) {
            alert('暂无覆层组预设可导出');
            return;
        }
        const json = JSON.stringify(presets, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `overlay_group_presets_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
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
        .rop-btn-danger { color:var(--error) !important; }
        .rop-list { background:var(--bg-tertiary, #0f0f2e); border-radius:0 0 6px 6px; max-height:150px; overflow-y:auto; }
        .rop-list-item { display:flex; align-items:center; gap:6px; padding:6px 10px; cursor:pointer;
                         border-bottom: 1px solid rgba(255,255,255,0.05); transition: background 0.15s; }
        .rop-list-item:hover { background:rgba(255,255,255,0.06); }
        .rop-list-item.selected { background:rgba(0,212,255,0.12); border-left:3px solid var(--accent); }
        .rop-list-arrow { font-size:9px; color:#666; width:10px; flex-shrink:0; }
        .rop-list-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .rop-list-time { font-size:10px; color:#888; font-family:monospace; white-space:nowrap; }
        .rop-list-toggle-eye { background:none; border:none; color:#888; cursor:pointer; font-size:12px; padding:0 2px;
                               line-height:1; flex-shrink:0; transition:color 0.15s; margin-left:4px; margin-right:2px; }
        .rop-list-toggle-eye:hover { filter: brightness(1.2); }
        .rop-list-del { background:none; border:none; color:#666; cursor:pointer; font-size:13px; padding:0 4px;
                        line-height:1; flex-shrink:0; transition:color 0.15s; }
        .rop-list-del:hover { color:var(--error); }
        .rop-empty { padding:16px; text-align:center; color:#555; font-style:italic; }
        .rop-group { padding:8px 10px; background:var(--bg-tertiary, #0f0f2e); border-radius:6px; margin-top:8px; }
        .rop-group-title { font-weight:bold; font-size:11px; color:#8899bb; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
        .rop-collapsible-head { display:flex; align-items:center; justify-content:flex-start; gap:6px; }
        .rop-clickable { cursor:pointer; user-select:none; }
        .rop-collapse-icon { display:inline-flex; align-items:center; justify-content:center; width:12px; color:#c7d3eb; font-size:11px; margin-right:0; flex-shrink:0; }
        .rop-title-inline-control { margin-left:auto; display:inline-flex; align-items:center; }
        .rop-collapse-btn { flex-shrink:0; min-width:20px; height:20px; padding:0 6px; border:1px solid rgba(255,255,255,0.14);
                            border-radius:4px; background:rgba(255,255,255,0.05); color:#a7b3cc; font-size:11px; cursor:pointer; }
        .rop-collapse-btn:hover { background:rgba(255,255,255,0.1); color:#d4def0; border-color:rgba(255,255,255,0.26); }
        .rop-collapsible-group.rop-collapsed > *:not(.rop-collapsible-head) { display:none !important; }
        .rop-subsection-head { margin-bottom:4px; padding:6px 8px; border-radius:6px; border:1px solid rgba(255,255,255,0.12); }
        .rop-subsection-head[data-section-tone="1"] { background:rgba(66, 145, 255, 0.16); color:#b8d8ff; border-color:rgba(66,145,255,0.35); }
        .rop-subsection-head[data-section-tone="2"] { background:rgba(42, 201, 160, 0.14); color:#aef2dc; border-color:rgba(42,201,160,0.34); }
        .rop-subsection-head[data-section-tone="3"] { background:rgba(246, 168, 56, 0.14); color:#ffdca8; border-color:rgba(246,168,56,0.34); }
        .rop-subsection-head[data-section-tone="4"] { background:rgba(188, 118, 255, 0.16); color:#e2c9ff; border-color:rgba(188,118,255,0.34); }
        .rop-subsection-head[data-section-tone="5"] { background:rgba(255, 111, 145, 0.14); color:#ffc0d0; border-color:rgba(255,111,145,0.34); }
        .rop-subsection-head[data-section-tone="6"] { background:rgba(120, 220, 110, 0.14); color:#c9f7c3; border-color:rgba(120,220,110,0.34); }
        .rop-subsection-body { margin-bottom:6px; }
        .rop-subsection-body.rop-collapsed { display:none !important; }
        .rop-grid { display:grid; grid-template-columns: auto 1fr; gap:4px 8px; align-items:center; }
        .rop-grid label { font-size:11px; color:#999; text-align:right; }
        .rop-input { width:100%; padding:3px 6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                     border-radius:4px; color:#ddd; font-size:11px; font-family:monospace; }
        .rop-input:focus { border-color:var(--accent); outline:none; }
        .rop-range { width:100%; }
        .rop-select { width:100%; padding:3px 6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                      border-radius:4px; color:#ddd; font-size:11px; }
        .rop-color { width:100%; height:24px; padding:0; border:1px solid var(--border-color, var(--border-color)); border-radius:4px; cursor:pointer; }
        .rop-textarea { width:100%; padding:6px; background:var(--bg-primary, #141414); border:1px solid var(--border-color, var(--border-color));
                        border-radius:4px; color:#ddd; font-size:11px; resize:vertical; margin-bottom:6px; font-family:system-ui; }
        .rop-actions { padding:8px 10px; }
        .rop-slider-combo { display:flex; align-items:center; gap:6px; width:100%; }
        .rop-slider-combo .rop-range { flex:1; min-width:0; }
        .rop-num-readout { width:52px!important; flex-shrink:0; padding:2px 4px; background:var(--bg-primary, #141414);
                           border:1px solid var(--border-color, var(--border-color)); border-radius:4px; color:#ddd;
                           font-size:11px; font-family:monospace; text-align:center; }
        .rop-num-readout:focus { border-color:var(--accent); outline:none; }
        .rop-reset-btn { flex-shrink:0; width:22px; height:22px; padding:0; border:1px solid rgba(255,255,255,0.1);
                         background:rgba(255,255,255,0.05); border-radius:4px; color:#888; font-size:12px;
                         cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.15s; }
        .rop-reset-btn:hover { background:rgba(0,212,255,0.15); color:var(--accent); border-color:rgba(0,212,255,0.3); }
        .rop-reset-all { padding:2px 8px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.05);
                         border-radius:4px; color:#888; font-size:10px; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
        .rop-reset-all:hover { background:rgba(0,212,255,0.15); color:var(--accent); border-color:rgba(0,212,255,0.3); }
    `;
    document.head.appendChild(s);
})();

// Export
if (typeof window !== 'undefined') window.ReelsOverlayPanel = ReelsOverlayPanel;
