/**
 * reels-overlay.js — 覆层系统（图片/文本 Overlay）
 * 
 * 完整移植自 AutoSub_v8 FrameRenderer:
 *   - draw_single_overlay()    → 渲染单个覆层
 *   - draw_image_elements()    → 渲染图片元素组
 *   - 文本覆层: 多样式、描边、阴影、背景框
 *   - 图片覆层: 缩放、翻转、混合模式
 *   - 覆层管理: CRUD、z-order、时间范围
 * 
 * 使用 Canvas 2D API 替代 Qt QPainter。
 */

// ═══════════════════════════════════════════════════════
// 1. Overlay Data Model
// ═══════════════════════════════════════════════════════

/**
 * 创建文本覆层对象。
 * @param {object} opts
 * @returns {object} overlay
 */
function createTextOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'text',
        content: opts.content || '标题文字',
        x: opts.x ?? 100,
        y: opts.y ?? 100,
        w: opts.w ?? 400,
        h: opts.h ?? 120,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 5,
        // 字体
        font_family: opts.font_family || 'Arial',
        font_weight: opts.font_weight ?? (opts.bold ? 700 : 400),
        fontsize: opts.fontsize || 40,
        bold: opts.bold || false,
        italic: opts.italic || false,
        color: opts.color || '#FFFFFF',
        // 描边
        use_stroke: opts.use_stroke || false,
        stroke_color: opts.stroke_color || '#000000',
        stroke_width: opts.stroke_width || 2,
        // 阴影
        shadow_enabled: opts.shadow_enabled || false,
        shadow_color: opts.shadow_color || '#000000',
        shadow_opacity: opts.shadow_opacity || 120,
        shadow_blur: opts.shadow_blur || 4,
        shadow_offset_x: opts.shadow_offset_x || 4,
        shadow_offset_y: opts.shadow_offset_y || 4,
        // 背景
        bg_enabled: opts.bg_enabled || false,
        bg_color: opts.bg_color || '#000000',
        bg_opacity: opts.bg_opacity || 191,
        bg_radius: opts.bg_radius || 12,
        bg_padding: opts.bg_padding || 12,
        // 动画
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
        // 文本布局
        text_layout: opts.text_layout || { align: 'center', left_pad: 10, right_pad: 10, top_pad: 10, bottom_pad: 10, line_spacing: 0 },
    };
}

/**
 * 创建图片覆层对象。
 */
function createImageOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'image',
        content: opts.content || '',   // 图片路径
        x: opts.x ?? 100,
        y: opts.y ?? 100,
        w: opts.w ?? 200,
        h: opts.h ?? 200,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        scale: opts.scale ?? 1.0,
        start: opts.start ?? 0,
        end: opts.end ?? 5,
        flip_x: opts.flip_x || false,
        flip_y: opts.flip_y || false,
        keep_aspect: opts.keep_aspect !== false,
        blend_mode: opts.blend_mode || 'source-over',
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
    };
}

/**
 * 创建文字卡片覆层对象。
 * 包含：纯色半透明背景 + 四角独立圆角 + 标题 + 内容（不同字体样式）
 */
function createTextCardOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'textcard',
        // ── 卡片位置/尺寸 ──
        // Top-left defaults corresponding to center position (0,0) for 1080x1920 with 910x1300 card
        x: opts.x ?? 85,
        y: opts.y ?? 310,
        w: opts.w ?? 910,
        h: opts.h ?? 1300,        // 默认1300；手动设为0时表示自动计算高度
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 9999,
        // ── 卡片背景 ──
        card_color: opts.card_color || '#FFFFFF',
        card_opacity: opts.card_opacity ?? 80,    // 0-100 (百分比)
        // ── 四角独立圆角 ──
        radius_tl: opts.radius_tl ?? 33,  // 左上
        radius_tr: opts.radius_tr ?? 33,  // 右上
        radius_bl: opts.radius_bl ?? 33,  // 左下
        radius_br: opts.radius_br ?? 33,  // 右下
        // ── 标题 ──
        title_text: opts.title_text ?? '标题文字',
        title_font_family: opts.title_font_family || 'Crimson Pro',
        title_font_weight: opts.title_font_weight ?? (opts.title_bold !== false ? 900 : 400),
        title_fontsize: opts.title_fontsize ?? 60,
        title_bold: opts.title_bold !== false,
        title_italic: opts.title_italic || false,
        title_color: opts.title_color || '#000000',
        title_align: opts.title_align || 'center',
        title_valign: opts.title_valign || 'top',
        title_uppercase: opts.title_uppercase ?? true,
        title_letter_spacing: opts.title_letter_spacing ?? 0,
        title_line_spacing: opts.title_line_spacing ?? 0,
        // ── 内容 ──
        body_text: opts.body_text ?? '内容文字',
        body_font_family: opts.body_font_family || 'Arial',
        body_font_weight: opts.body_font_weight ?? (opts.body_bold ? 700 : 400),
        body_fontsize: opts.body_fontsize ?? 40,
        body_bold: opts.body_bold || false,
        body_italic: opts.body_italic || false,
        body_color: opts.body_color || '#000000',
        body_align: opts.body_align || 'center',
        body_valign: opts.body_valign || 'top',
        body_letter_spacing: opts.body_letter_spacing ?? 0,
        body_line_spacing: opts.body_line_spacing ?? 6,
        // ── 结尾 ──
        footer_text: opts.footer_text ?? '',
        footer_font_family: opts.footer_font_family || 'Arial',
        footer_font_weight: opts.footer_font_weight ?? (opts.footer_bold ? 700 : 400),
        footer_fontsize: opts.footer_fontsize ?? 32,
        footer_bold: opts.footer_bold || false,
        footer_italic: opts.footer_italic || false,
        footer_color: opts.footer_color || '#666666',
        footer_align: opts.footer_align || 'center',
        footer_valign: opts.footer_valign || 'top',
        footer_letter_spacing: opts.footer_letter_spacing ?? 0,
        footer_line_spacing: opts.footer_line_spacing ?? 0,
        // ── 文字效果（共享模式）──
        text_stroke_color: opts.text_stroke_color || '#000000',
        text_stroke_width: opts.text_stroke_width ?? 0,
        text_shadow_color: opts.text_shadow_color || '#000000',
        text_shadow_blur: opts.text_shadow_blur ?? 0,
        text_shadow_x: opts.text_shadow_x ?? 0,
        text_shadow_y: opts.text_shadow_y ?? 0,
        // ── 独立效果模式 ──
        independent_effects: opts.independent_effects ?? false,
        // 标题独立效果
        title_stroke_color: opts.title_stroke_color || '#000000',
        title_stroke_width: opts.title_stroke_width ?? 0,
        title_shadow_color: opts.title_shadow_color || '#000000',
        title_shadow_blur: opts.title_shadow_blur ?? 0,
        title_shadow_x: opts.title_shadow_x ?? 0,
        title_shadow_y: opts.title_shadow_y ?? 0,
        // 内容独立效果
        body_stroke_color: opts.body_stroke_color || '#000000',
        body_stroke_width: opts.body_stroke_width ?? 0,
        body_shadow_color: opts.body_shadow_color || '#000000',
        body_shadow_blur: opts.body_shadow_blur ?? 0,
        body_shadow_x: opts.body_shadow_x ?? 0,
        body_shadow_y: opts.body_shadow_y ?? 0,
        // 结尾独立效果
        footer_stroke_color: opts.footer_stroke_color || '#000000',
        footer_stroke_width: opts.footer_stroke_width ?? 0,
        footer_shadow_color: opts.footer_shadow_color || '#000000',
        footer_shadow_blur: opts.footer_shadow_blur ?? 0,
        footer_shadow_x: opts.footer_shadow_x ?? 0,
        footer_shadow_y: opts.footer_shadow_y ?? 0,
        // 独立背景（每部分单独背景色/透明度/圆角）
        title_bg_enabled: opts.title_bg_enabled ?? false,
        title_bg_mode: opts.title_bg_mode || 'block',
        title_bg_color: opts.title_bg_color || '#000000',
        title_bg_opacity: opts.title_bg_opacity ?? 60,
        title_bg_radius: opts.title_bg_radius ?? 12,
        title_bg_pad_h: opts.title_bg_pad_h ?? 0,
        title_bg_pad_top: opts.title_bg_pad_top ?? 0,
        title_bg_pad_bottom: opts.title_bg_pad_bottom ?? 0,

        body_bg_enabled: opts.body_bg_enabled ?? false,
        body_bg_mode: opts.body_bg_mode || 'block',
        body_bg_color: opts.body_bg_color || '#000000',
        body_bg_opacity: opts.body_bg_opacity ?? 60,
        body_bg_radius: opts.body_bg_radius ?? 12,
        body_bg_pad_h: opts.body_bg_pad_h ?? 0,
        body_bg_pad_top: opts.body_bg_pad_top ?? 0,
        body_bg_pad_bottom: opts.body_bg_pad_bottom ?? 0,

        footer_bg_enabled: opts.footer_bg_enabled ?? false,
        footer_bg_mode: opts.footer_bg_mode || 'block',
        footer_bg_color: opts.footer_bg_color || '#000000',
        footer_bg_opacity: opts.footer_bg_opacity ?? 60,
        footer_bg_radius: opts.footer_bg_radius ?? 12,
        footer_bg_pad_h: opts.footer_bg_pad_h ?? 0,
        footer_bg_pad_top: opts.footer_bg_pad_top ?? 0,
        footer_bg_pad_bottom: opts.footer_bg_pad_bottom ?? 0,
        // ── 自动适配 ──
        auto_fit: opts.auto_fit === true,         // 默认关闭；仅显式开启时生效
        auto_center_v: opts.auto_center_v === true, // 默认关闭；仅显式开启时生效
        // ── 内边距 ──
        padding_top: opts.padding_top ?? 60,
        padding_bottom: opts.padding_bottom ?? 60,
        padding_left: opts.padding_left ?? 40,
        padding_right: opts.padding_right ?? 40,
        title_body_gap: opts.title_body_gap ?? 42,  // 标题与正文间距
        body_footer_gap: opts.body_footer_gap ?? 42, // 正文与结尾间距
        // ── 自适应限制 ──
        max_height: opts.max_height ?? 1400,
        auto_shrink: opts.auto_shrink === true,
        title_max_lines: opts.title_max_lines ?? 3,
        min_fontsize: opts.min_fontsize ?? 16,
        fullscreen_mask: opts.fullscreen_mask ?? false,
        // ── 获取位置偏移 ──
        offset_x: opts.offset_x ?? 0,
        offset_y: opts.offset_y ?? 0,
        // ── 动画 ──
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
    };
}

/**
 * 创建滚动字幕覆层对象。
 * x/y/w/h 用作裁切区域（可见窗口），文本在其中滚动。
 */
function createScrollOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'scroll',
        content: opts.content || '滚动文字内容\n第二行文字\n第三行文字\n第四行文字\n第五行文字',
        // x/y/w/h = 裁切区域
        x: opts.x ?? 40,
        y: opts.y ?? 400,
        w: opts.w ?? 1000,
        h: opts.h ?? 1120,
        rotation: opts.rotation ?? 0,
        opacity: opts.opacity ?? 255,
        start: opts.start ?? 0,
        end: opts.end ?? 10,
        // ── 标题 ──
        scroll_title: opts.scroll_title ?? '',
        scroll_title_fontsize: opts.scroll_title_fontsize ?? 56,
        scroll_title_font_family: opts.scroll_title_font_family || '',  // 空 = 跟随正文字体
        scroll_title_font_weight: opts.scroll_title_font_weight ?? 700,
        scroll_title_bold: opts.scroll_title_bold !== false,
        scroll_title_color: opts.scroll_title_color || '',  // 空 = 跟随正文颜色
        scroll_title_align: opts.scroll_title_align || '',  // 空 = 跟随正文对齐
        scroll_title_gap: opts.scroll_title_gap ?? 20,      // 标题与正文间距
        scroll_title_fixed: opts.scroll_title_fixed !== false, // 默认固定不滚动
        // ── 正文字体 ──
        font_family: opts.font_family || 'Arial',
        font_weight: opts.font_weight ?? (opts.bold ? 700 : 400),
        fontsize: opts.fontsize || 40,
        bold: opts.bold || false,
        italic: opts.italic || false,
        color: opts.color || '#FFFFFF',
        text_align: opts.text_align || 'center',
        line_spacing: opts.line_spacing ?? 6,
        text_width: opts.text_width ?? 900,
        // 描边
        use_stroke: opts.use_stroke || false,
        stroke_color: opts.stroke_color || '#000000',
        stroke_width: opts.stroke_width || 2,
        // 阴影
        shadow_enabled: opts.shadow_enabled || false,
        shadow_color: opts.shadow_color || '#000000',
        shadow_opacity: opts.shadow_opacity || 120,
        shadow_blur: opts.shadow_blur || 4,
        shadow_offset_x: opts.shadow_offset_x || 2,
        shadow_offset_y: opts.shadow_offset_y || 2,
        // 滚动参数
        scroll_from_x: opts.scroll_from_x ?? 90,
        scroll_from_y: opts.scroll_from_y ?? 960,   // 裁切区域内部开始，直接可见
        scroll_to_x: opts.scroll_to_x ?? 90,
        scroll_to_y: opts.scroll_to_y ?? -200,      // 向上滚出
        scroll_speed: opts.scroll_speed ?? 0.8,
        scroll_auto_stop: opts.scroll_auto_stop === true, // 默认关闭
        scroll_auto_fit: opts.scroll_auto_fit === true,   // 默认关闭
        scroll_min_fontsize: opts.scroll_min_fontsize ?? 16,
        // 卡片背景
        bg_enabled: opts.bg_enabled || false,
        bg_color: opts.bg_color || '#000000',
        bg_opacity: opts.bg_opacity || 191,
        bg_radius: opts.bg_radius || 12,
        bg_padding_top: opts.bg_padding_top ?? 55,
        bg_padding_bottom: opts.bg_padding_bottom ?? 55,
        bg_padding_left: opts.bg_padding_left ?? 16,
        bg_padding_right: opts.bg_padding_right ?? 16,
        bg_fullscreen: opts.bg_fullscreen ?? false,
        // 羽化
        feather_top: opts.feather_top ?? 80,
        feather_bottom: opts.feather_bottom ?? 80,
        // 动画
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
    };
}

// ═══════════════════════════════════════════════════════
// 2. Overlay Renderer
// ═══════════════════════════════════════════════════════

const _imageCache = {};
const _IMAGE_LOADING = { _loading: true }; // sentinel (truthy, prevents re-creation)

/**
 * 加载并缓存图片。
 */
function _getCachedImage(path) {
    if (!path) return null;
    const cached = _imageCache[path];
    if (cached === _IMAGE_LOADING) return null;   // still loading
    if (cached) return cached;                     // loaded Image

    const img = new Image();
    // Only set crossOrigin for http(s) — blob: and file: don't need it
    // and setting it on blob URLs causes CORS failures in Electron
    if (/^https?:\/\//.test(path)) img.crossOrigin = 'anonymous';
    const isGif = path.toLowerCase().endsWith('.gif');
    img.onload = () => {
        _imageCache[path] = img;
        // GIF 需要挂到可见 DOM 中才能让 Chromium 推进动画帧
        if (isGif) _attachGifToDom(img);
    };
    img.onerror = () => { _imageCache[path] = null; }; // allow retry on error
    _imageCache[path] = _IMAGE_LOADING;
    img.src = path.startsWith('/') ? `file://${path}` : path;
    return null;
}

// 隐藏容器：让 GIF <img> 挂在 DOM 中以驱动动画帧
// 必须在视口内（不能 left:-9999px），否则 Chromium 可能不推进动画
let _gifDomContainer = null;
function _attachGifToDom(img) {
    if (!_gifDomContainer) {
        _gifDomContainer = document.createElement('div');
        _gifDomContainer.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0.001;z-index:-9999;';
        document.body.appendChild(_gifDomContainer);
    }
    // 强制 img 尺寸极小，避免影响性能
    img.style.cssText = 'width:1px;height:1px;';
    if (!img.parentNode) _gifDomContainer.appendChild(img);
}

const _videoCache = {};
function _getCachedVideo(path) {
    if (!path) return null;
    if (_videoCache[path]) return _videoCache[path];
    const vid = document.createElement('video');
    // 本地路径需要加 file:// 前缀
    vid.src = path.startsWith('/') ? `file://${path}` : path;
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.preload = 'auto';
    vid.load();
    // 自动播放让 Canvas 能拿到帧
    vid.play().catch(() => {});
    _videoCache[path] = vid;
    return vid;
}

// ═══ GIF 逐帧解码器 (WebCodecs ImageDecoder API) ═══
const _gifDecoderCache = {};

function _getGifDecoder(path) {
    if (!path) return null;
    if (_gifDecoderCache[path]) return _gifDecoderCache[path];

    // 创建解码器对象
    const gifData = {
        ready: false,
        frameCount: 0,
        frameDurations: [],    // 每帧持续时间(ms)
        totalDuration: 0,      // 总时长(秒)
        frames: {},            // frameIndex → ImageBitmap
        decoder: null,
        _decoding: new Set(),  // 正在解码的帧索引
    };
    _gifDecoderCache[path] = gifData;

    // 异步初始化解码器
    (async () => {
        try {
            const url = path.startsWith('/') ? `file://${path}` : path;
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();

            // 使用 ImageDecoder（Chromium 94+, Electron 支持）
            if (typeof ImageDecoder !== 'undefined') {
                const decoder = new ImageDecoder({ data: arrayBuffer, type: 'image/gif' });
                gifData.decoder = decoder;
                await decoder.tracks.ready;
                const track = decoder.tracks.selectedTrack;
                gifData.frameCount = track.frameCount;

                // 预解码全部帧
                const preloadCount = gifData.frameCount;
                for (let i = 0; i < preloadCount; i++) {
                    try {
                        const result = await decoder.decode({ frameIndex: i });
                        // duration 单位: 微秒 → 毫秒，最小 10ms 防止除零
                        const durMs = Math.max(10, result.image.duration ? result.image.duration / 1000 : 100);
                        gifData.frameDurations[i] = durMs;
                        // 转为 ImageBitmap 用于 Canvas 绘制
                        const bitmap = await createImageBitmap(result.image);
                        gifData.frames[i] = bitmap;
                        result.image.close();
                    } catch (e) {
                        gifData.frameDurations[i] = 100; // 默认 100ms
                    }
                }

                // 补齐未预解码的帧时长（用平均值）
                const avgDur = gifData.frameDurations.length > 0
                    ? gifData.frameDurations.reduce((a, b) => a + b, 0) / gifData.frameDurations.length
                    : 100;
                for (let i = preloadCount; i < gifData.frameCount; i++) {
                    gifData.frameDurations[i] = avgDur;
                }
                gifData.totalDuration = gifData.frameDurations.reduce((a, b) => a + b, 0) / 1000;
                gifData.nativeFps = gifData.frameCount / Math.max(0.01, gifData.totalDuration);
                gifData.ready = true;
                console.log(`[GIF] 解码完成: ${gifData.frameCount} 帧, 总时长 ${gifData.totalDuration.toFixed(2)}s, 原始帧率 ${gifData.nativeFps.toFixed(1)}fps`);
            } else {
                // ImageDecoder 不可用，回退到静态图
                console.warn('[GIF] ImageDecoder API 不可用, GIF 将显示为静态图');
                const img = new Image();
                img.src = path.startsWith('/') ? `file://${path}` : path;
                img.onload = () => {
                    gifData.frames[0] = img;
                    gifData.frameCount = 1;
                    gifData.frameDurations = [100];
                    gifData.totalDuration = 0.1;
                    gifData.ready = true;
                };
            }
        } catch (err) {
            console.error('[GIF] 解码初始化失败:', err);
        }
    })();

    return gifData;
}

// 异步按需解码指定帧（不阻塞渲染循环）
function _ensureGifFrameDecoded(gifData, frameIdx) {
    if (!gifData || !gifData.decoder) return;
    // 预解码当前帧和下一帧
    const toLoad = [frameIdx, (frameIdx + 1) % gifData.frameCount];
    for (const fi of toLoad) {
        if (gifData.frames[fi] || gifData._decoding.has(fi)) continue;
        gifData._decoding.add(fi);
        (async () => {
            try {
                const result = await gifData.decoder.decode({ frameIndex: fi });
                const bitmap = await createImageBitmap(result.image);
                gifData.frames[fi] = bitmap;
                result.image.close();
            } catch (e) { /* ignore */ }
            gifData._decoding.delete(fi);
        })();
    }
}

/**
 * 渲染单个覆层到 Canvas。
 * 移植自 FrameRenderer.draw_single_overlay
 * 
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} ov - overlay 对象
 * @param {number} currentTime - 当前播放时间
 * @param {number} canvasW - 画布宽度
 * @param {number} canvasH - 画布高度
 */
function drawOverlay(ctx, ov, currentTime = 0, canvasW = 1920, canvasH = 1080) {
    if (ov.disabled) return;
    
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    // 时间范围检查 (允许边界值)
    // end >= 9999 = 全程，永不超时
    // scroll 覆层: 动画完成后保持在最终位置
    if (currentTime < start) return;
    if (end < 9999 && ov.type !== 'scroll' && currentTime > end + 0.001) {
        // 对于 video/image 覆层，如果 end 恰好等于视频时长（被 9999 覆盖的遗留问题），也视为全程
        if ((ov.type === 'video' || ov.type === 'image') && end > 0) {
            // 允许继续绘制（循环播放）
        } else {
            return;
        }
    }

    let x = parseFloat(ov.x || 0);
    let y = parseFloat(ov.y || 0);
    let destScaleOffset = 1.0;

    if (ov.anim_dest_enabled && end > start) {
        const p = Math.max(0, Math.min(1, (currentTime - start) / (end - start)));
        const easedP = window.ReelsAnimEngine ? window.ReelsAnimEngine.EASING_MAP['ease_in_out_quad'](p) : p;
        
        const endX = parseFloat(ov.anim_end_x ?? x);
        const endY = parseFloat(ov.anim_end_y ?? y);
        const endScale = parseFloat(ov.anim_end_scale ?? 100) / 100.0;
        // The scale starts at 1.0 (relative to static scale), and goes to endScale
        
        x = x + (endX - x) * easedP;
        y = y + (endY - y) * easedP;
        destScaleOffset = 1.0 + (endScale - 1.0) * easedP;
    }

    const w = parseFloat(ov.w || 100);
    const h = parseFloat(ov.h || 100);
    const rotation = parseFloat(ov.rotation || 0);
    const opacity = parseFloat(ov.opacity ?? 255) / 255;

    ctx.save();

    // 旋转
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);

    // 转场动画
    let transOp = 1, transScale = 1, transDx = 0, transDy = 0;
    if (window.ReelsAnimEngine) {
        const preset = ov.transition_preset || 'none';
        const dur = parseFloat(ov.transition_duration || 0.35);
        const result = ReelsAnimEngine.computeTransitionParams(currentTime, start, end, preset, dur);
        // result is an array: [opacityFactor, scale, dx, dy]
        transOp = result[0];
        transScale = result[1];
        transDx = result[2];
        transDy = result[3];
    }
    
    transScale *= destScaleOffset;

    ctx.translate(transDx, transDy);
    if (Math.abs(transScale - 1) > 0.0001) {
        ctx.scale(transScale, transScale);
    }
    ctx.translate(-cx, -cy);

    ctx.globalAlpha = opacity * transOp;

    if (ov.type === 'image') {
        _drawImageOverlay(ctx, ov, x, y, w, h);
    } else if (ov.type === 'text') {
        _drawTextOverlay(ctx, ov, x, y, w, h, currentTime);
    } else if (ov.type === 'textcard') {
        _drawTextCardOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime);
    } else if (ov.type === 'scroll') {
        _drawScrollOverlay(ctx, ov, x, y, w, h, currentTime, canvasW, canvasH);
    } else if (ov.type === 'video') {
        _drawVideoOverlay(ctx, ov, x, y, w, h, currentTime);
    }

    ctx.restore();
}

/**
 * 渲染图片覆层 (内部)。
 */
function _drawImageOverlay(ctx, ov, x, y, w, h) {
    const imgPath = ov.content || '';
    if (!imgPath) return;

    const img = _getCachedImage(imgPath);
    if (!img) return;

    const scale = parseFloat(ov.scale || 1);
    const flipX = ov.flip_x || false;
    const flipY = ov.flip_y || false;
    const keepAspect = ov.keep_aspect !== false;

    // 混合模式
    const blendMode = ov.blend_mode || 'source-over';
    ctx.globalCompositeOperation = blendMode;

    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(flipX ? -scale : scale, flipY ? -scale : scale);

    let drawW = w, drawH = h;
    if (keepAspect) {
        const imgRatio = img.naturalWidth / img.naturalHeight;
        const boxRatio = w / h;
        if (imgRatio > boxRatio) {
            drawH = w / imgRatio;
        } else {
            drawW = h * imgRatio;
        }
    }

    ctx.drawImage(img, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
}

/**
 * 渲染视频覆层 (内部)。
 * 支持导出模式 (PNG序列) 和 预览模式(<video> / <img>)
 */
function _drawVideoOverlay(ctx, ov, x, y, w, h, currentTime) {
    const videoPath = ov.content || '';
    if (!videoPath) return;

    const scale = parseFloat(ov.scale || 1);
    const flipX = ov.flip_x || false;
    const flipY = ov.flip_y || false;
    const keepAspect = ov.keep_aspect !== false;
    const blendMode = ov.blend_mode || 'source-over';
    
    // 相对本覆层的播放时间
    const start = parseFloat(ov.start || 0);
    let relTime = Math.max(0, currentTime - start);

    let drawable = null;
    const isGif = videoPath ? videoPath.toLowerCase().endsWith('.gif') : false;

    if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
        // ═══ 图像序列处理 (预览与导出通用) ═══
        const fps = ov.fps || 30;
        let frameIdx = Math.floor(relTime * fps);
        if (frameIdx >= ov.sequence_frames.length) {
            frameIdx = frameIdx % ov.sequence_frames.length; // loop
        }
        if (ov._exporting && ov._currentFrameImage) {
            drawable = ov._currentFrameImage;
        } else {
            drawable = _getCachedImage(ov.sequence_frames[frameIdx]);
        }
    } else if (ov._exporting && ov._framesDir) {
        // ═══ 导出模式：读取预处理的 PNG 序列 ═══
        const fps = 30; // 假设提取是30fps
        let frameIdx = Math.floor(relTime * fps);
        if (frameIdx >= ov._frameCount) {
            frameIdx = frameIdx % Math.max(1, ov._frameCount); // loop
        }
        const frameName = `frame_${String(frameIdx + 1).padStart(6, '0')}.png`;
        const fPath = `${ov._framesDir}/${frameName}`;
        if (ov._currentFrameImage) {
            drawable = ov._currentFrameImage;
        } else {
            drawable = _getCachedImage(`file://${fPath}`); 
        }
    } else {
        // ═══ 预览模式：使用 <video> 或 GIF 解码器 ═══
        if (isGif) {
            // GIF: 使用 ImageDecoder 逐帧解码，按原始帧时长播放
            const gifData = _getGifDecoder(videoPath);
            if (gifData && gifData.ready && gifData.frameCount > 0) {
                // 计算速度倍率：ov.fps / 原始帧率，默认 1x 原速
                const nativeFps = gifData.nativeFps || 10;
                const speedMul = (ov.fps && ov.fps !== 30) ? (ov.fps / nativeFps) : 1;
                const adjustedTime = relTime * speedMul;
                const totalGifDur = gifData.totalDuration || 1;
                const loopedTime = adjustedTime % totalGifDur;
                // 按累计帧时长查找当前帧
                let accumulated = 0;
                let targetFrame = 0;
                for (let fi = 0; fi < gifData.frameCount; fi++) {
                    accumulated += (gifData.frameDurations[fi] || 100) / 1000;
                    if (loopedTime < accumulated) { targetFrame = fi; break; }
                    targetFrame = fi;
                }
                drawable = gifData.frames[targetFrame] || gifData.frames[0] || null;
                _ensureGifFrameDecoded(gifData, targetFrame);
            }
        } else {
            const vid = _getCachedVideo(videoPath);
            if (vid && vid.readyState >= 2) {
                drawable = vid;
                let targetTime = relTime;
                const d = vid.duration || 1;
                if (targetTime >= d) targetTime = targetTime % d;
                if (Math.abs(vid.currentTime - targetTime) > 0.2) {
                    vid.currentTime = targetTime;
                }
                if (vid.paused && document.visibilityState === 'visible') {
                    vid.play().catch(e => {}); 
                }
            }
        }
    }

    if (!drawable) return; // 还没加载好

    ctx.globalCompositeOperation = blendMode;
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(flipX ? -scale : scale, flipY ? -scale : scale);

    let drawW = w, drawH = h;
    if (keepAspect) {
        const srcW = drawable.naturalWidth || drawable.videoWidth || w;
        const srcH = drawable.naturalHeight || drawable.videoHeight || h;
        const imgRatio = srcW / srcH;
        const boxRatio = w / h;
        if (imgRatio > boxRatio) {
            drawH = w / imgRatio;
        } else {
            drawW = h * imgRatio;
        }
    }

    ctx.drawImage(drawable, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
}


/**
 * 渲染文本覆层 (内部)。
 * 完整移植自 FrameRenderer.draw_single_overlay (text 分支)
 */
function _drawTextOverlay(ctx, ov, x, y, w, h, currentTime) {
    const content = ov.content || '';
    if (!content) return;

    const layout = ov.text_layout || {};
    const padL = layout.left_pad || 10;
    const padR = layout.right_pad || 10;
    const padT = layout.top_pad || 10;
    const padB = layout.bottom_pad || 10;
    const lineSpacing = layout.line_spacing || 0;
    const align = layout.align || 'center';

    const boxX = x + padL;
    const boxY = y + padT;
    const boxW = Math.max(1, w - padL - padR);
    const boxH = Math.max(1, h - padT - padB);

    const fontSize = ov.fontsize || 40;
    const fontFamily = ov.font_family || 'Arial';
    const fontWeight = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400);
    const italic = ov.italic ? 'italic' : 'normal';
    const fallbackFamily = _resolveOverlayFallback(fontFamily);
    const fontStr = `${italic} ${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
    ctx.font = fontStr;

    // 自动换行
    const lines = _wrapText(ctx, content, boxW);
    const lineHeight = fontSize * 1.3 + lineSpacing;

    // 入/出场动画
    let animOpFactor = 1;
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    if (window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const inDur = inType !== 'none' ? parseFloat(ov.anim_in_duration || 0.3) : 0;
        const outDur = outType !== 'none' ? parseFloat(ov.anim_out_duration || 0.3) : 0;
        const { inProgress, outProgress } = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );

        // Fade
        if (inType === 'fade') animOpFactor *= inProgress;
        if (outType === 'fade') animOpFactor *= outProgress;

        // Pop
        if (inType === 'pop' || outType === 'pop') {
            let popScale = 1;
            if (inType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(inProgress));
            if (outType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(outProgress));
            if (popScale < 0.999) {
                ctx.translate(x + w / 2, y + h / 2);
                ctx.scale(popScale, popScale);
                ctx.translate(-(x + w / 2), -(y + h / 2));
            }
        }
    }

    ctx.globalAlpha *= animOpFactor;

    // ── 背景框 ──
    if (ov.bg_enabled) {
        const bgAlpha = (ov.bg_opacity || 191) / 255;
        const totalH = lines.length * lineHeight;
        const pad = ov.bg_padding || 12;
        const rad = ov.bg_radius || 12;

        ctx.save();
        ctx.globalAlpha = bgAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.bg_color || '#000000';
        _roundRect(ctx, boxX - pad, boxY - pad, boxW + pad * 2, totalH + pad * 2, rad);
        ctx.fill();
        ctx.restore();
    }

    // ── 阴影 ──
    if (ov.shadow_enabled) {
        ctx.save();
        const sx = parseFloat(ov.shadow_offset_x || 4);
        const sy = parseFloat(ov.shadow_offset_y || 4);
        const blur = parseFloat(ov.shadow_blur || 4);
        const shadowAlpha = (ov.shadow_opacity || 120) / 255;

        ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', shadowAlpha);
        ctx.shadowBlur = blur;
        ctx.shadowOffsetX = sx;
        ctx.shadowOffsetY = sy;

        _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, ov.color || '#FFFFFF');
        ctx.restore();
    }

    // ── 描边 ──
    if (ov.use_stroke) {
        ctx.save();
        ctx.strokeStyle = ov.stroke_color || '#000000';
        ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;

        let yc = boxY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, boxX, boxW, align);
            ctx.strokeText(line, lx, yc);
            yc += lineHeight;
        }
        ctx.restore();
    }

    // ── 文字填充 ──
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, ov.color || '#FFFFFF');
}

// ═══════════════════════════════════════════════════════
// 2b. Text Card Overlay Renderer
// ═══════════════════════════════════════════════════════

/**
 * 渲染文字卡片覆层。
 * 功能：半透明纯色背景 + 四角独立圆角 + 标题（粗体大字）+ 内容（正常字体）
 * 自动适配：根据文案长短调整蒙版大小和位置
 */
function _drawTextCardOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime) {
    // 注意：auto_center_v 仅控制垂直居中，不应改动 X（避免手动 X 被每帧覆盖）
    
    // 关键修正：必须明确指定为 alphabetic，否则由于上层可能污染 ctx.textBaseline='top'
    // 会导致 actualBoundingBoxAscent 计算为负数，触发 fallback（0.8 * fontSize）
    // 进而使 ty = topY + 0.8*fontSize 形成视觉上的“多出一个空行”。
    ctx.textBaseline = 'alphabetic';

    const useAutoFit = (ov.auto_fit === true || ov.auto_fit === 1 || ov.auto_fit === '1');
    const useAutoCenterV = (ov.auto_center_v === true || ov.auto_center_v === 1 || ov.auto_center_v === '1');
    const useAutoShrink = useAutoFit && (ov.auto_shrink === true);

    // 自动适配开：使用边距；自动适配关：边距一律归0（全充实）
    const padL = useAutoFit ? (ov.padding_left ?? 40) : 0;
    const padR = useAutoFit ? (ov.padding_right ?? 40) : 0;
    const padT = useAutoFit ? (ov.padding_top ?? 60) : 0;
    const padB = useAutoFit ? (ov.padding_bottom ?? 60) : 0;
    
    const minFont = ov.min_fontsize ?? 16;
    const maxH = ov.max_height ?? 1400;
    const titleMaxLines = ov.title_max_lines ?? 3;
    const doShrink = useAutoShrink && maxH > 0;
    const gap = ov.title_body_gap ?? 42;
    const gapFooter = ov.body_footer_gap ?? 42;
    const offsetX = parseFloat(ov.offset_x || 0);

    const contentW = Math.max(1, w - padL - padR);

    // ── 原始字号 ──
    const titleText = ov.title_uppercase ? (ov.title_text || '').toUpperCase() : (ov.title_text || '');
    let titleFontSize = ov.title_fontsize ?? 60;
    const titleWeight = _resolveOverlayFontWeight(ov.title_font_weight, ov.title_bold ? 900 : 400);
    const titleItalic = ov.title_italic ? 'italic' : 'normal';
    const titleFamily = ov.title_font_family || 'Crimson Pro';
    const titleFallback = _resolveOverlayFallback(titleFamily);

    const bodyText = ov.body_text || '';
    let bodyFontSize = ov.body_fontsize ?? 40;
    const bodyWeight = _resolveOverlayFontWeight(ov.body_font_weight, ov.body_bold ? 700 : 400);
    const bodyItalic = ov.body_italic ? 'italic' : 'normal';
    const bodyFamily = ov.body_font_family || 'Arial';
    const bodyFallback = _resolveOverlayFallback(bodyFamily);

    const footerText = ov.footer_text || '';
    let footerFontSize = ov.footer_fontsize ?? 32;
    const footerWeight = _resolveOverlayFontWeight(ov.footer_font_weight, ov.footer_bold ? 700 : 400);
    const footerItalic = ov.footer_italic ? 'italic' : 'normal';
    const footerFamily = ov.footer_font_family || 'Arial';
    const footerFallback = _resolveOverlayFallback(footerFamily);

    // Text effects — resolve per-section when independent mode
    const indep = ov.independent_effects;

    // Shared (fallback) values
    const _shStrokeW = ov.text_stroke_width ?? 0;
    const _shStrokeC = ov.text_stroke_color || '#000000';
    const _shShadowBlur = ov.text_shadow_blur ?? 0;
    const _shShadowColor = ov.text_shadow_color || '#000000';
    const _shShadowX = ov.text_shadow_x ?? 0;
    const _shShadowY = ov.text_shadow_y ?? 0;

    function _resolveEffects(prefix) {
        if (!indep) return {
            strokeW: _shStrokeW, strokeC: _shStrokeC,
            shadowBlur: _shShadowBlur, shadowColor: _shShadowColor,
            shadowX: _shShadowX, shadowY: _shShadowY,
        };
        return {
            strokeW: ov[prefix + '_stroke_width'] ?? _shStrokeW,
            strokeC: ov[prefix + '_stroke_color'] || _shStrokeC,
            shadowBlur: ov[prefix + '_shadow_blur'] ?? _shShadowBlur,
            shadowColor: ov[prefix + '_shadow_color'] || _shShadowColor,
            shadowX: ov[prefix + '_shadow_x'] ?? _shShadowX,
            shadowY: ov[prefix + '_shadow_y'] ?? _shShadowY,
        };
    }



    function _fontMetrics(font, testStr = 'H国T', fontSize = 40, descentText = null) {
        ctx.font = font;
        const sample = ctx.measureText(testStr);
        let asc = Number(sample.actualBoundingBoxAscent);
        if (!Number.isFinite(asc) || asc <= 0) asc = Math.round(fontSize * 0.8);
        
        // 视觉光学平衡：即使文本没有下沉字母（如 p,y,j），排版上如果下底线紧贴英文基线，
        // 人眼会因为缺少“行高预留的安全区”而感觉整个文字块“偏上”。
        // 所以我们需要保证至少有一个标准的下沉空间（约字号的 20% - 25%）。
        let stdDesc = Number(ctx.measureText('pjyqg,').actualBoundingBoxDescent);
        if (!Number.isFinite(stdDesc) || stdDesc <= 0) stdDesc = Math.round(fontSize * 0.22);
        
        let desc = stdDesc; 
        if (descentText) {
            const mLine = ctx.measureText(descentText);
            const rawDesc = Number(mLine.actualBoundingBoxDescent);
            if (Number.isFinite(rawDesc) && rawDesc > 0) {
                desc = Math.max(stdDesc, rawDesc);
            }
        }
        return { ascent: asc, descent: desc };
    }

    function _getSectionExtents(prefix, fontSize) {
        if (!indep || !ov[prefix + '_bg_enabled']) return { padT: 0, padB: 0, extTop: 0, extBot: 0 };
        const fx = _resolveEffects(prefix);
        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const pT = ov[prefix + '_bg_pad_top'] !== undefined ? ov[prefix + '_bg_pad_top'] : autoPad;
        const pB = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const strokeExt = Math.max(0, (fx.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx.shadowBlur || 0);
        const shY = fx.shadowY || 0;
        return { padT: pT, padB: pB, extTop: Math.max(strokeExt, shBlur + Math.max(0, -shY)), extBot: Math.max(strokeExt, shBlur + Math.max(0, shY)) };
    }

    const tW = (ov.title_override_w > 0) ? Number(ov.title_override_w) : contentW;
    const bW = (ov.body_override_w > 0) ? Number(ov.body_override_w) : contentW;
    const fW = (ov.footer_override_w > 0) ? Number(ov.footer_override_w) : contentW;

    // ── 内部测量函数 ──
    function _measure(tfs, bfs, ffs) {
        const tf = `${titleItalic} ${titleWeight} ${tfs}px "${titleFamily}", ${titleFallback}`;
        ctx.font = tf;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        const tLines = titleText ? _wrapText(ctx, titleText, tW) : [];
        ctx.letterSpacing = '0px';
        const tLineH = tfs * 1.3 + parseFloat(ov.title_line_spacing || 0);
        const tExt = _getSectionExtents('title', tfs);
        const tFirstFM = tLines.length > 0 ? _fontMetrics(tf, tLines[0], tfs) : null;
        const tFM = tFirstFM || { ascent: tfs * 0.8, descent: 0 };
        const tDesc = tLines.length > 0 ? _fontMetrics(tf, tLines[0], tfs, tLines[tLines.length - 1]).descent : 0;
        const tTextH = tLines.length > 0 ? (tFM.ascent + tDesc + (tLines.length - 1) * tLineH) : 0;
        const tBlockH = tLines.length > 0 ? (tTextH + tExt.padT + tExt.padB + tExt.extTop + tExt.extBot) : 0;

        const bf = `${bodyItalic} ${bodyWeight} ${bfs}px "${bodyFamily}", ${bodyFallback}`;
        ctx.font = bf;
        ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
        const bLines = bodyText ? _wrapText(ctx, bodyText, bW) : [];
        ctx.letterSpacing = '0px';
        const bLineH = bfs * 1.3 + parseFloat(ov.body_line_spacing || 0);
        const bExt = _getSectionExtents('body', bfs);
        const bFirstFM = bLines.length > 0 ? _fontMetrics(bf, bLines[0], bfs) : null;
        const bFM = bFirstFM || { ascent: bfs * 0.8, descent: 0 };
        const bDesc = bLines.length > 0 ? _fontMetrics(bf, bLines[0], bfs, bLines[bLines.length - 1]).descent : 0;
        const bTextH = bLines.length > 0 ? (bFM.ascent + bDesc + (bLines.length - 1) * bLineH) : 0;
        const bBlockH = bLines.length > 0 ? (bTextH + bExt.padT + bExt.padB + bExt.extTop + bExt.extBot) : 0;

        const ff = `${footerItalic} ${footerWeight} ${ffs}px "${footerFamily}", ${footerFallback}`;
        ctx.font = ff;
        ctx.letterSpacing = `${ov.footer_letter_spacing || 0}px`;
        const fLines = footerText ? _wrapText(ctx, footerText, fW) : [];
        ctx.letterSpacing = '0px';
        const fLineH = ffs * 1.3 + parseFloat(ov.footer_line_spacing || 0);
        const fExt = _getSectionExtents('footer', ffs);
        const fFirstFM = fLines.length > 0 ? _fontMetrics(ff, fLines[0], ffs) : null;
        const fFM = fFirstFM || { ascent: ffs * 0.8, descent: 0 };
        const fDesc = fLines.length > 0 ? _fontMetrics(ff, fLines[0], ffs, fLines[fLines.length - 1]).descent : 0;
        const fTextH = fLines.length > 0 ? (fFM.ascent + fDesc + (fLines.length - 1) * fLineH) : 0;
        const fBlockH = fLines.length > 0 ? (fTextH + fExt.padT + fExt.padB + fExt.extTop + fExt.extBot) : 0;

        const hasT = tLines.length > 0;
        const hasB = bLines.length > 0;
        const hasF = fLines.length > 0;
        
        const tSpace = (ov.title_override_h > 0) ? Number(ov.title_override_h) : tBlockH;
        const bSpace = (ov.body_override_h > 0) ? Number(ov.body_override_h) : bBlockH;
        const fSpace = (ov.footer_override_h > 0) ? Number(ov.footer_override_h) : fBlockH;

        let total = padT + padB;
        if (ov.layout_mode === 'absolute') {
            const tBot = hasT ? (ov.title_offset_y || 0) + tSpace : 0;
            const bBot = hasB ? (ov.body_offset_y || 0) + bSpace : 0;
            const fBot = hasF ? (ov.footer_offset_y || 0) + fSpace : 0;
            total += Math.max(0, tBot, bBot, fBot);
        } else {
            if (hasT) total += tSpace;
            if (hasB) {
                if (hasT) total += gap;
                total += bSpace;
            }
            if (hasF) {
                if (hasT || hasB) total += gapFooter;
                total += fSpace;
            }
        }

        return {
            tLines, tLineH, tTextH, tBlockH, tFM, tExt, tSpace,
            bLines, bLineH, bTextH, bBlockH, bFM, bExt, bSpace,
            fLines, fLineH, fTextH, fBlockH, fFM, fExt, fSpace,
            total, tf, bf, ff, hasT, hasB, hasF
        };
    }

    // ── 自动缩放循环 ──
    let m = _measure(titleFontSize, bodyFontSize, footerFontSize);

    // 独立缩放阶段
    if (ov.title_override_h > 0 && ov.title_auto_shrink) {
        while (m.tBlockH > Number(ov.title_override_h) && titleFontSize > minFont) {
            titleFontSize = Math.max(minFont, titleFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }
    if (ov.body_override_h > 0 && ov.body_auto_shrink) {
        while (m.bBlockH > Number(ov.body_override_h) && bodyFontSize > minFont) {
            bodyFontSize = Math.max(minFont, bodyFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }
    if (ov.footer_override_h > 0 && ov.footer_auto_shrink) {
        while (m.fBlockH > Number(ov.footer_override_h) && footerFontSize > minFont) {
            footerFontSize = Math.max(minFont, footerFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }

    // 阶段 0: 仅在自动缩放模式下执行标题行数限制
    while (m.tLines.length > titleMaxLines && titleFontSize > minFont) {
        if (!doShrink) break;
        titleFontSize = Math.max(minFont, titleFontSize - 2);
        m = _measure(titleFontSize, bodyFontSize, footerFontSize);
    }

    if (doShrink && m.total > maxH) {
        // 第一阶段: 只缩内容字号
        while (m.total > maxH && bodyFontSize > minFont) {
            bodyFontSize = Math.max(minFont, bodyFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
        // 缩小结尾字号
        while (m.total > maxH && footerFontSize > minFont) {
            footerFontSize = Math.max(minFont, footerFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
        // 第二阶段: 都缩
        while (m.total > maxH && (titleFontSize > minFont || bodyFontSize > minFont)) {
            if (bodyFontSize > minFont) bodyFontSize = Math.max(minFont, bodyFontSize - 1);
            if (titleFontSize > minFont) titleFontSize = Math.max(minFont, titleFontSize - 1);
            if (footerFontSize > minFont) footerFontSize = Math.max(minFont, footerFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize, footerFontSize);
        }
    }

    const { tLines: titleLines, tLineH: titleLineH, tTextH: titleTextH, tBlockH: titleBlockH, tFM: titleFM, tExt: titleExt, tSpace,
        bLines: bodyLines, bLineH: bodyLineH, bTextH: bodyTextH, bBlockH: bodyBlockH, bFM: bodyFM, bExt: bodyExt, bSpace,
        fLines: footerLines, fLineH: footerLineH, fTextH: footerTextH, fBlockH: footerBlockH, fFM: footerFM, fExt: footerExt, fSpace,
        total: autoH, tf: titleFont, bf: bodyFont, ff: footerFont,
        hasT: hasTitle, hasB: hasBody, hasF: hasFooter } = m;

    // ── 计算总高度与锚点 ──
    // 自动适配开：高度跟随内容；无适配：手动设定的 h 或回退到内容。
    let cardH = useAutoFit ? autoH : (h > 0 ? h : autoH);
    if (doShrink && cardH > maxH) cardH = maxH;

    // flow 布局保持中心锚定，避免内容缩放时视觉“漂移”。
    // absolute 布局（完全解绑）固定顶部锚点，避免调整 footer 时 title 跟着移动。
    const isAbsoluteLayout = ov.layout_mode === 'absolute';
    let cardY = y;
    if (!isAbsoluteLayout) {
        const originalCenterY = y + (h > 0 ? h : cardH) / 2;
        cardY = useAutoFit ? (originalCenterY - cardH / 2) : y;
    }

    // 全局物理垂直居中 (如果开启，覆盖原居中系)
    if (useAutoCenterV) {
        cardY = (canvasH - cardH) / 2;
    }

    // 全屏蒙版模式
    const isFullMask = (ov.fullscreen_mask === true || ov.fullscreen_mask === 1 || ov.fullscreen_mask === '1');
    let maskX = x, maskY = cardY, maskW = w, maskH = cardH;
    if (isFullMask) {
        maskX = 0; maskY = 0; maskW = canvasW; maskH = canvasH;
    }

    // 入/出场动画
    let animOpFactor = 1;
    const inType = ov.anim_in_type || 'none';
    const outType = ov.anim_out_type || 'none';
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    if (window.ReelsAnimEngine && (inType !== 'none' || outType !== 'none')) {
        const inDur = inType !== 'none' ? parseFloat(ov.anim_in_duration || 0.3) : 0;
        const outDur = outType !== 'none' ? parseFloat(ov.anim_out_duration || 0.3) : 0;
        const { inProgress, outProgress } = ReelsAnimEngine.computeAnimProgress(
            currentTime, start, end, inDur, outDur
        );
        if (inType === 'fade') animOpFactor *= inProgress;
        if (outType === 'fade') animOpFactor *= outProgress;

        if (inType === 'pop' || outType === 'pop') {
            let popScale = 1;
            if (inType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(inProgress));
            if (outType === 'pop') popScale = Math.min(popScale, ReelsAnimEngine.computePopScale(outProgress));
            if (popScale < 0.999) {
                const pcx = x + w / 2, pcy = cardY + cardH / 2;
                ctx.translate(pcx, pcy);
                ctx.scale(popScale, popScale);
                ctx.translate(-pcx, -pcy);
            }
        }

        const slideTypes = ['slide_up', 'slide_down', 'slide_left', 'slide_right'];
        if (slideTypes.includes(inType) || slideTypes.includes(outType)) {
            let sdx = 0, sdy = 0;
            if (slideTypes.includes(inType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(inProgress, inType, 120);
                sdx += dx; sdy += dy;
            }
            if (slideTypes.includes(outType)) {
                const [dx, dy] = ReelsAnimEngine.computeSlideOffset(outProgress, outType, 120);
                sdx += dx; sdy += dy;
            }
            ctx.translate(sdx, sdy);
        }
    }
    ctx.globalAlpha *= animOpFactor;

    // ── 绘制背景 ──
    if (ov.card_enabled !== false) {
        const cardAlpha = (ov.card_opacity ?? 80) / 100;
        ctx.save();
        ctx.globalAlpha = cardAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.card_color || '#FFFFFF';
        if (isFullMask) {
            ctx.fillRect(maskX, maskY, maskW, maskH);
        } else {
            _roundRectIndividual(ctx, x, cardY, w, cardH,
                ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
            ctx.fill();
        }
        ctx.restore();
    }

    // ── 文字内部锚点 ──
    // absolute 布局必须固定锚点，避免 footer 调整反向影响 title/body。
    // flow 布局保留原有“内容居中”行为。
    const textY = isAbsoluteLayout
        ? (cardY + (ov.offset_y || 0))
        : (useAutoFit ? cardY : cardY + (h - autoH) / 2 + (ov.offset_y || 0));

    // Helper: draw per-section background (when independent mode enabled)
    // 使用文字实际视觉高度来居中、支持独立上/下/水平 padding
    function _drawSectionBg(prefix, secY, secH, secW, fontSize, fx, customX = 0, origBaseY = undefined) {
        if (!indep) return;
        if (!ov[prefix + '_bg_enabled']) return;
        if (ov[prefix + '_bg_mode'] && ov[prefix + '_bg_mode'] !== 'block') return;
        const bgColor = ov[prefix + '_bg_color'] || '#000000';
        const bgOp = (ov[prefix + '_bg_opacity'] ?? 60) / 100;
        const bgR = ov[prefix + '_bg_radius'] ?? 12;

        // secH 已经是按真实字形上下界估算后的视觉高度
        const textVisualH = secH;

        // ── padding：设值 >= 0 时用自定义值，无值时按字号比例自动计算 ──
        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const autoPadH = Math.max(14, Math.round(fontSize * 0.25));
        
        const bgPadTop    = ov[prefix + '_bg_pad_top']    !== undefined ? ov[prefix + '_bg_pad_top']    : autoPad;
        const bgPadBottom = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const bgPadH      = ov[prefix + '_bg_pad_h']      !== undefined ? ov[prefix + '_bg_pad_h']      : autoPadH;

        // Include stroke/shadow extents to avoid text visually spilling outside background
        const strokeExt = Math.max(0, (fx?.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx?.shadowBlur || 0);
        const shX = fx?.shadowX || 0;
        const shY = fx?.shadowY || 0;
        const extTop = Math.max(strokeExt, shBlur + Math.max(0, -shY));
        const extBottom = Math.max(strokeExt, shBlur + Math.max(0, shY));
        const extLeft = Math.max(strokeExt, shBlur + Math.max(0, -shX));
        const extRight = Math.max(strokeExt, shBlur + Math.max(0, shX));

        // ── 绘制背景矩形（基于文字视觉高度，上下等 padding = 居中）──
        let bgH = bgPadTop + textVisualH + bgPadBottom + extTop + extBottom;
        let finalY = secY - bgPadTop - extTop;

        const overrideH = Number(ov[prefix + '_override_h']) || 0;
        if (overrideH > 0 && ov[prefix + '_bg_mode'] !== 'inline' && ov[prefix + '_bg_mode'] !== 'inline-joined') {
            bgH = overrideH;
            if (origBaseY !== undefined) {
                finalY = origBaseY;
            }
        }

        ctx.save();
        ctx.globalAlpha = bgOp * ctx.globalAlpha;
        ctx.fillStyle = bgColor;
        _roundRect(ctx,
            x + padL - bgPadH - extLeft + offsetX + customX,
            finalY,
            secW + bgPadH * 2 + extLeft + extRight,
            bgH,
            bgR
        );
        ctx.fill();
        ctx.restore();
    }

    function _roundRectPath(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
    }

    function _drawInlineBgGroup(ctx, prefix, boxes, fontAscent, fontDescent, fontSize, fx) {
        if (!indep || !ov[prefix + '_bg_enabled'] || ov[prefix + '_bg_mode'] === 'block') return;
        const mode = ov[prefix + '_bg_mode'];
        const bgColor = ov[prefix + '_bg_color'] || '#000000';
        const bgOp = (ov[prefix + '_bg_opacity'] ?? 60) / 100;
        const bgR = ov[prefix + '_bg_radius'] ?? 12;

        const autoPad = Math.max(12, Math.round(fontSize * 0.2));
        const autoPadH = Math.max(14, Math.round(fontSize * 0.25));
        
        const bgPadTop    = ov[prefix + '_bg_pad_top']    !== undefined ? ov[prefix + '_bg_pad_top']    : autoPad;
        const bgPadBottom = ov[prefix + '_bg_pad_bottom'] !== undefined ? ov[prefix + '_bg_pad_bottom'] : autoPad;
        const bgPadH      = ov[prefix + '_bg_pad_h']      !== undefined ? ov[prefix + '_bg_pad_h']      : autoPadH;

        const strokeExt = Math.max(0, (fx?.strokeW || 0) / 2);
        const shBlur = Math.max(0, fx?.shadowBlur || 0);
        const shX = Math.abs(fx?.shadowX || 0);
        const shY = Math.abs(fx?.shadowY || 0);
        const extTop = Math.max(strokeExt, shBlur + shY);
        const extBottom = Math.max(strokeExt, shBlur + shY);
        const extLeft = Math.max(strokeExt, shBlur + shX);
        const extRight = Math.max(strokeExt, shBlur + shX);

        const lh = fontAscent + fontDescent;
        const bgH = bgPadTop + lh + bgPadBottom + extTop + extBottom;

        ctx.save();
        ctx.globalAlpha = bgOp * ctx.globalAlpha;
        ctx.fillStyle = bgColor;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        ctx.beginPath();
        
        const rects = [];
        for (const b of boxes) {
            const rx = b.lx - bgPadH - extLeft;
            const ry = b.y - fontAscent - bgPadTop - extTop;
            const rw = b.lw + bgPadH * 2 + extLeft + extRight;
            const rh = bgH;
            
            _roundRectPath(ctx, rx, ry, rw, rh, bgR);
            rects.push({ L: rx, R: rx + rw, T: ry, B: ry + rh });
        }

        if (mode === 'inline-joined' && rects.length > 1) {
            for (let i = 0; i < rects.length - 1; i++) {
                const r1 = rects[i];
                const r2 = rects[i + 1];
                const iL = Math.max(r1.L, r2.L);
                const iR = Math.min(r1.R, r2.R);
                if (iL < iR) {
                    const jointTop = Math.min(r1.B - bgR, r2.T);
                    const jointBot = Math.max(r2.T + bgR, r1.B);
                    if (jointTop < jointBot) {
                        ctx.rect(iL, jointTop, iR - iL, jointBot - jointTop);
                    }
                }
            }
        }

        ctx.fill();
        ctx.restore();
    }

    // ── 绘制文字与其独立背景 ──
    let currentY = textY + padT;

    // ── 绘制标题文字 ──
    if (hasTitle) {
        const disableOffsets = useAutoFit || useAutoCenterV;
        const customX = disableOffsets ? 0 : (ov.title_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.title_offset_y || 0);

        const secBaseY = (ov.layout_mode === 'absolute') ? (textY + padT + customY) : (currentY + customY);
        let availSpace = tSpace;
        if (ov.title_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
        let tDeltaY = 0;
        if (availSpace > titleBlockH) {
            const vAlign = ov.title_valign || 'top';
            if (vAlign === 'center') tDeltaY = (availSpace - titleBlockH) / 2;
            else if (vAlign === 'bottom') tDeltaY = availSpace - titleBlockH;
        }
        const titleTextTopY = secBaseY + tDeltaY + titleExt.padT + titleExt.extTop;
        const fx = _resolveEffects('title');
        _drawSectionBg('title', titleTextTopY, titleTextH, tW, titleFontSize, fx, customX, secBaseY);
        ctx.save();
        ctx.font = titleFont;
        ctx.letterSpacing = `${ov.title_letter_spacing || 0}px`;
        if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
            ctx.shadowColor = fx.shadowColor;
            ctx.shadowBlur = fx.shadowBlur;
            ctx.shadowOffsetX = fx.shadowX;
            ctx.shadowOffsetY = fx.shadowY;
        }
        let ty = titleTextTopY + titleFM.ascent;
        if (indep && ov.title_bg_enabled && ov.title_bg_mode !== 'block') {
            const boxes = [];
            let bY = ty;
            for (const line of titleLines) {
                const lx = _alignX(ctx, line, x + padL + offsetX + customX, tW, ov.title_align || 'center');
                const lw = ctx.measureText(line).width;
                boxes.push({ lx, y: bY, lw });
                bY += titleLineH;
            }
            _drawInlineBgGroup(ctx, 'title', boxes, titleFM.ascent, titleFM.descent, titleFontSize, fx);
        }
        for (const line of titleLines) {
            const lx = _alignX(ctx, line, x + padL + offsetX + customX, tW, ov.title_align || 'center');
            if (fx.strokeW > 0) {
                ctx.strokeStyle = fx.strokeC;
                ctx.lineWidth = fx.strokeW;
                ctx.lineJoin = 'round';
                ctx.strokeText(line, lx, ty);
            }
            if (!indep && ov.title_color_from_style) {
                ctx.fillStyle = _resolveTitleColor(ov.title_color_from_style);
            } else {
                ctx.fillStyle = ov.title_color || '#1A1A1A';
            }
            ctx.fillText(line, lx, ty);
            ty += titleLineH;
        }
        ctx.restore();
        
        if (!ov._exporting && (ov.debug_title || (ov.debug_title === undefined && ov.debug_layout))) {
            ctx.save(); ctx.strokeStyle='#ff5555'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
            ctx.strokeRect(x + padL + offsetX + customX, secBaseY, tW, tSpace);
            ctx.restore();
        }

        if (ov.layout_mode !== 'absolute') currentY += tSpace;
    }

    // ── 绘制内容文字 ──
    if (hasBody) {
        const disableOffsets = useAutoFit || useAutoCenterV;
        const customX = disableOffsets ? 0 : (ov.body_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.body_offset_y || 0);

        let secBaseY;
        if (ov.layout_mode === 'absolute') {
            secBaseY = textY + padT + customY;
        } else {
            if (hasTitle) currentY += gap;
            secBaseY = currentY + customY;
        }

        let availSpace = bSpace;
        if (ov.body_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
        let bDeltaY = 0;
        if (availSpace > bodyBlockH) {
            const vAlign = ov.body_valign || 'top';
            if (vAlign === 'center') bDeltaY = (availSpace - bodyBlockH) / 2;
            else if (vAlign === 'bottom') bDeltaY = availSpace - bodyBlockH;
        }
        const bodyTextTopY = secBaseY + bDeltaY + bodyExt.padT + bodyExt.extTop;
        const fx = _resolveEffects('body');
        _drawSectionBg('body', bodyTextTopY, bodyTextH, bW, bodyFontSize, fx, customX, secBaseY);
        ctx.save();
        ctx.font = bodyFont;
        ctx.letterSpacing = `${ov.body_letter_spacing || 0}px`;
        if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
            ctx.shadowColor = fx.shadowColor;
            ctx.shadowBlur = fx.shadowBlur;
            ctx.shadowOffsetX = fx.shadowX;
            ctx.shadowOffsetY = fx.shadowY;
        }
        let by = bodyTextTopY + bodyFM.ascent;
        if (indep && ov.body_bg_enabled && ov.body_bg_mode !== 'block') {
            const boxes = [];
            let bY2 = by;
            for (const line of bodyLines) {
                const lx = _alignX(ctx, line, x + padL + offsetX + customX, bW, ov.body_align || 'center');
                const lw = ctx.measureText(line).width;
                boxes.push({ lx, y: bY2, lw });
                bY2 += bodyLineH;
            }
            _drawInlineBgGroup(ctx, 'body', boxes, bodyFM.ascent, bodyFM.descent, bodyFontSize, fx);
        }
        for (const line of bodyLines) {
            const lx = _alignX(ctx, line, x + padL + offsetX + customX, bW, ov.body_align || 'center');
            if (fx.strokeW > 0) {
                ctx.strokeStyle = fx.strokeC;
                ctx.lineWidth = fx.strokeW;
                ctx.lineJoin = 'round';
                ctx.strokeText(line, lx, by);
            }
            ctx.fillStyle = ov.body_color || '#333333';
            ctx.fillText(line, lx, by);
            by += bodyLineH;
        }
        ctx.restore();
        
        if (!ov._exporting && (ov.debug_body || (ov.debug_body === undefined && ov.debug_layout))) {
            ctx.save(); ctx.strokeStyle='#55ff55'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
            ctx.strokeRect(x + padL + offsetX + customX, secBaseY, bW, bSpace);
            ctx.restore();
        }

        if (ov.layout_mode !== 'absolute') currentY += bSpace;
    }

    // ── 绘制结尾文字 ──
    if (hasFooter) {
        const disableOffsets = useAutoFit || useAutoCenterV;
        const customX = disableOffsets ? 0 : (ov.footer_offset_x || 0);
        const customY = disableOffsets ? 0 : (ov.footer_offset_y || 0);

        let secBaseY;
        if (ov.layout_mode === 'absolute') {
            secBaseY = textY + padT + customY;
        } else {
            if (hasTitle || hasBody) currentY += gapFooter;
            secBaseY = currentY + customY;
        }

        let availSpace = fSpace;
        if (ov.footer_override_h == 0 && ov.layout_mode === 'absolute') availSpace = cardH - padT - padB;
        let fDeltaY = 0;
        if (availSpace > footerBlockH) {
            const vAlign = ov.footer_valign || 'top';
            if (vAlign === 'center') fDeltaY = (availSpace - footerBlockH) / 2;
            else if (vAlign === 'bottom') fDeltaY = availSpace - footerBlockH;
        }
        const footerTextTopY = secBaseY + fDeltaY + footerExt.padT + footerExt.extTop;
        const fx = _resolveEffects('footer');
        _drawSectionBg('footer', footerTextTopY, footerTextH, fW, footerFontSize, fx, customX, secBaseY);
        ctx.save();
        ctx.font = footerFont;
        ctx.letterSpacing = `${ov.footer_letter_spacing || 0}px`;
        if (fx.shadowBlur > 0 || fx.shadowX !== 0 || fx.shadowY !== 0) {
            ctx.shadowColor = fx.shadowColor;
            ctx.shadowBlur = fx.shadowBlur;
            ctx.shadowOffsetX = fx.shadowX;
            ctx.shadowOffsetY = fx.shadowY;
        }
        let fy = footerTextTopY + footerFM.ascent;
        if (indep && ov.footer_bg_enabled && ov.footer_bg_mode !== 'block') {
            const boxes = [];
            let bY3 = fy;
            for (const line of footerLines) {
                const lx = _alignX(ctx, line, x + padL + offsetX + customX, fW, ov.footer_align || 'center');
                const lw = ctx.measureText(line).width;
                boxes.push({ lx, y: bY3, lw });
                bY3 += footerLineH;
            }
            _drawInlineBgGroup(ctx, 'footer', boxes, footerFM.ascent, footerFM.descent, footerFontSize, fx);
        }
        for (const line of footerLines) {
            const lx = _alignX(ctx, line, x + padL + offsetX + customX, fW, ov.footer_align || 'center');
            if (fx.strokeW > 0) {
                ctx.strokeStyle = fx.strokeC;
                ctx.lineWidth = fx.strokeW;
                ctx.lineJoin = 'round';
                ctx.strokeText(line, lx, fy);
            }
            ctx.fillStyle = ov.footer_color || '#666666';
            ctx.fillText(line, lx, fy);
            fy += footerLineH;
        }
        ctx.restore();
        
        if (!ov._exporting && (ov.debug_footer || (ov.debug_footer === undefined && ov.debug_layout))) {
            ctx.save(); ctx.strokeStyle='#5555ff'; ctx.lineWidth=1; ctx.setLineDash([4,4]);
            ctx.strokeRect(x + padL + offsetX + customX, secBaseY, fW, fSpace);
            ctx.restore();
        }

        if (ov.layout_mode !== 'absolute') currentY += fSpace;
    }

    // 将实际绘制的尺寸存回 ov，供 hit-test 和属性面板使用
    ov._renderedX = x;
    ov._renderedW = w;
    ov._renderedH = cardH;
    ov._renderedY = cardY;

    // ── 排版辅助线（基准线与边距）──
    if (ov.debug_layout && !ov._exporting) {
        ctx.save();
        ctx.globalAlpha = 0.9;
        
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        
        // 上边距线
        const topEdge = cardY + padT;
        ctx.beginPath();
        ctx.moveTo(x, topEdge);
        ctx.lineTo(x + w, topEdge);
        ctx.stroke();

        // 下边距线
        const botEdge = cardY + autoH - padB;
        ctx.beginPath();
        ctx.moveTo(x, botEdge);
        ctx.lineTo(x + w, botEdge);
        ctx.stroke();

        ctx.fillStyle = '#00ff00';
        ctx.font = '14px sans-serif';
        if (padT > 0) ctx.fillText(`上边距: ${padT}px`, x + 5, cardY + padT / 2 + 5);
        if (padB > 0) ctx.fillText(`下边距: ${padB}px`, x + 5, botEdge + padB / 2 + 5);
        
        // 框选边界
        ctx.strokeStyle = '#ff00ff';
        ctx.setLineDash([2, 5]);
        ctx.strokeRect(x, cardY, w, cardH);
        
        ctx.restore();
    }

    // ── 最大高度辅助线（仅预览时显示，导出时跳过）──
    if (doShrink && !ov._exporting) {
        const guideY_top = useAutoCenterV ? (canvasH - maxH) / 2 : cardY;
        const guideY_bot = guideY_top + maxH;
        ctx.save();
        ctx.setLineDash([10, 6]);
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        // 上边界
        ctx.beginPath();
        ctx.moveTo(x - 20, guideY_top);
        ctx.lineTo(x + w + 20, guideY_top);
        ctx.stroke();
        // 下边界
        ctx.beginPath();
        ctx.moveTo(x - 20, guideY_bot);
        ctx.lineTo(x + w + 20, guideY_bot);
        ctx.stroke();
        // 标签
        ctx.setLineDash([]);
        ctx.font = '22px sans-serif';
        ctx.fillStyle = '#4c9eff';
        ctx.globalAlpha = 0.85;
        ctx.fillText(`最大高度: ${maxH}px`, x + w + 28, guideY_top + 26);
        // 高度标尺线
        ctx.beginPath();
        ctx.moveTo(x + w + 16, guideY_top);
        ctx.lineTo(x + w + 16, guideY_bot);
        ctx.strokeStyle = '#4c9eff';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }
}

// ═══════════════════════════════════════════════════════
// 2c. Scroll Overlay Renderer
// ═══════════════════════════════════════════════════════

/**
 * 渲染滚动字幕覆层。
 * x/y/w/h = 裁切区域; 文本从 scroll_from → scroll_to 移动。
 */
function _drawScrollOverlay(ctx, ov, clipX, clipY, clipW, clipH, currentTime, canvasW, canvasH) {
    const content = ov.content || '';
    if (!content) return;

    const start = parseFloat(ov.start || 0);
    let end = parseFloat(ov.end || 0);
    // 当 end 是占位值(9999)，用实际媒体时长来计算滚动速度
    if (end >= 9999) {
        if (ov._exportDuration && ov._exportDuration > 0) {
            end = ov._exportDuration; // 导出时由导出引擎设置
        } else {
            const mediaEl = document.getElementById('reels-preview-video') || document.querySelector('#reels-preview video');
            const audioEl = document.getElementById('reels-preview-audio');
            if (audioEl && audioEl.duration && isFinite(audioEl.duration) && audioEl.duration > 0) {
                end = audioEl.duration;
            } else if (mediaEl && mediaEl.duration && isFinite(mediaEl.duration)) {
                end = mediaEl.duration;
            } else {
                end = 30;
            }
        }
    }
    const duration = end - start;
    if (duration <= 0) return;

    // 进度 = (当前时间 - 开始) / 时长，clamp 到 [0, 1]
    // 速度由 距离 ÷ 时间 自动决定，不再有 speed 乘数
    let progress = (currentTime - start) / duration;
    progress = Math.max(0, Math.min(1, progress));

    // 插值当前位置
    const fromX = parseFloat(ov.scroll_from_x ?? clipX);
    const fromY = parseFloat(ov.scroll_from_y ?? (clipY + clipH));
    const toX   = parseFloat(ov.scroll_to_x ?? clipX);
    const toY   = parseFloat(ov.scroll_to_y ?? (clipY - 500));

    // 字体设置
    // 字体设置 (可能被 auto_fit 缩小)
    let fontSize     = ov.fontsize || 40;
    const fontFamily  = ov.font_family || 'Arial';
    const fontWeight  = _resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400);
    const italicStr   = ov.italic ? 'italic' : 'normal';
    const fallback    = _resolveOverlayFallback(fontFamily);
    const lineSpacing = parseFloat(ov.line_spacing ?? 6);
    const align       = ov.text_align || 'center';
    const textW       = parseFloat(ov.text_width || (clipW - 40));

    // ── 计算标题占用高度 ──
    let titleOccupiedH = 0;
    const scrollTitleText = (ov.scroll_title || '').trim();
    if (scrollTitleText) {
        const tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
        const tFamily = ov.scroll_title_font_family || fontFamily;
        const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
        const tFallback = _resolveOverlayFallback(tFamily);
        const tFont = `${italicStr} ${tWeight} ${tSize}px "${tFamily}", ${tFallback}`;
        const tLineH = tSize * 1.3 + lineSpacing;
        const tGap = parseFloat(ov.scroll_title_gap ?? 20);
        ctx.font = tFont;
        const titleLines = _wrapText(ctx, scrollTitleText, textW);
        titleOccupiedH = titleLines.length * tLineH + tGap;
    }

    // ── 自动缩放字号：确保文字在裁切区内全部可见 ──
    const featherT_pre = parseFloat(ov.feather_top ?? 0);
    const featherB_pre = parseFloat(ov.feather_bottom ?? 0);
    const visibleH = clipH - featherT_pre - featherB_pre;
    const bodyVisibleH = visibleH - titleOccupiedH;  // 可用于正文的高度
    const minFontSize = parseFloat(ov.scroll_min_fontsize ?? 16);

    let fontStr, lineHeight, lines;
    if (ov.scroll_auto_fit && bodyVisibleH > 0) {
        // 循环缩小字号直到正文高度 <= 可用高度
        for (let trySize = fontSize; trySize >= minFontSize; trySize -= 2) {
            lineHeight = trySize * 1.3 + lineSpacing;
            fontStr = `${italicStr} ${fontWeight} ${trySize}px "${fontFamily}", ${fallback}`;
            ctx.font = fontStr;
            lines = _wrapText(ctx, content, textW);
            const totalH = lines.length * lineHeight;
            if (totalH <= bodyVisibleH) {
                fontSize = trySize;
                break;
            }
            fontSize = trySize; // 即使到了 minFontSize 也要用
        }
    } else {
        lineHeight = fontSize * 1.3 + lineSpacing;
        fontStr = `${italicStr} ${fontWeight} ${fontSize}px "${fontFamily}", ${fallback}`;
        ctx.font = fontStr;
        lines = _wrapText(ctx, content, textW);
    }

    // ── 自动停止：到达最终位置后冻结 ──
    let effectiveToY = toY;
    if (ov.scroll_auto_stop) {
        const totalTextH = lines.length * lineHeight;
        const featherT = parseFloat(ov.feather_top ?? 0);
        const featherB = parseFloat(ov.feather_bottom ?? 0);

        // 固定标题模式下正文 clip 区会缩小
        const titleFixed = ov.scroll_title_fixed !== false && (ov.scroll_title || '').trim();
        const bodyClipTop = titleFixed ? (clipY + titleOccupiedH) : clipY;
        const bodyClipBot = clipY + clipH;
        const bodyClipH = bodyClipBot - bodyClipTop;

        // 向上滚 (fromY > toY)
        if (fromY > toY) {
            const visibleBodyH = bodyClipH - featherT - featherB;
            if (totalTextH <= visibleBodyH) {
                // 文字短于可见区：停在文字顶部刚好在 bodyClipTop + featherT 处（全部可见）
                const stopY = bodyClipTop + featherT;
                effectiveToY = Math.max(toY, stopY);
            } else {
                // 文字长于可见区：停在文字底部刚好到达 bodyClipBot - featherB 处
                const stopY = bodyClipBot - featherB - totalTextH;
                effectiveToY = Math.max(toY, stopY);
            }
        }
        // 向下滚 (fromY < toY)
        else if (fromY < toY) {
            const visibleBodyH = bodyClipH - featherT - featherB;
            if (totalTextH <= visibleBodyH) {
                // 文字短于可见区：停在文字底部刚好在 bodyClipBot - featherB 处（全部可见）
                const stopY = bodyClipBot - featherB - totalTextH;
                effectiveToY = Math.min(toY, stopY);
            } else {
                // 文字长于可见区：停在文字顶部刚好到达 bodyClipTop + featherT 处
                const stopY = bodyClipTop + featherT;
                effectiveToY = Math.min(toY, stopY);
            }
        }
    }

    const curX  = fromX + (toX - fromX) * progress;
    const curY  = fromY + (effectiveToY - fromY) * progress;

    // ── 卡片背景 ──
    if (ov.bg_enabled) {
        const bgAlpha = (ov.bg_opacity || 191) / 255;
        const padT = parseFloat(ov.bg_padding_top ?? 16);
        const padB = parseFloat(ov.bg_padding_bottom ?? 16);
        const padL = parseFloat(ov.bg_padding_left ?? 16);
        const padR = parseFloat(ov.bg_padding_right ?? 16);
        const rad = parseFloat(ov.bg_radius || 12);
        ctx.save();
        ctx.globalAlpha = bgAlpha * ctx.globalAlpha;
        ctx.fillStyle = ov.bg_color || '#000000';
        if (ov.bg_fullscreen) {
            // 全屏蒙版
            _roundRect(ctx, 0, 0, canvasW, canvasH, 0);
        } else {
            _roundRect(ctx, clipX - padL, clipY - padT, clipW + padL + padR, clipH + padT + padB, rad);
        }
        ctx.fill();
        ctx.restore();
    }

    const featherTop    = parseFloat(ov.feather_top ?? 0);
    const featherBottom = parseFloat(ov.feather_bottom ?? 0);

    // ── 固定标题模式 ──
    const titleText = (ov.scroll_title || '').trim();
    const titleFixed = ov.scroll_title_fixed !== false && titleText;

    if (titleFixed) {
        // 计算标题尺寸
        const tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
        const tFamily = ov.scroll_title_font_family || fontFamily;
        const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
        const tFallback = _resolveOverlayFallback(tFamily);
        const tFont = `${italicStr} ${tWeight} ${tSize}px "${tFamily}", ${tFallback}`;
        const tColor = ov.scroll_title_color || ov.color || '#FFFFFF';
        const tAlign = ov.scroll_title_align || align;
        const tLineH = tSize * 1.3 + lineSpacing;
        const tGap = parseFloat(ov.scroll_title_gap ?? 20);

        ctx.save();
        ctx.font = tFont;
        const titleLines = _wrapText(ctx, titleText, textW);
        const titleBlockH = titleLines.length * tLineH;

        // ── 1. 绘制固定标题 (在覆层顶部，不受裁切) ──
        const titleDrawY = clipY;
        const titleDrawX = parseFloat(ov.scroll_from_x ?? 90);

        // 阴影
        if (ov.shadow_enabled) {
            ctx.save();
            ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
            ctx.shadowBlur = parseFloat(ov.shadow_blur || 4);
            ctx.shadowOffsetX = parseFloat(ov.shadow_offset_x || 2);
            ctx.shadowOffsetY = parseFloat(ov.shadow_offset_y || 2);
            ctx.fillStyle = tColor;
            let ty = titleDrawY + tSize;
            for (const line of titleLines) {
                ctx.fillText(line, _alignX(ctx, line, titleDrawX, textW, tAlign), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 描边
        if (ov.use_stroke && (ov.stroke_width || 0) > 0) {
            ctx.save();
            ctx.strokeStyle = ov.stroke_color || '#000000';
            ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
            ctx.lineJoin = 'round'; ctx.miterLimit = 2;
            let ty = titleDrawY + tSize;
            for (const line of titleLines) {
                ctx.strokeText(line, _alignX(ctx, line, titleDrawX, textW, tAlign), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 填充
        ctx.fillStyle = tColor;
        let ty = titleDrawY + tSize;
        for (const line of titleLines) {
            ctx.fillText(line, _alignX(ctx, line, titleDrawX, textW, tAlign), ty);
            ty += tLineH;
        }
        ctx.restore();

        // ── 2. 正文在标题下方的剩余空间内滚动 ──
        const bodyClipY = clipY + titleBlockH + tGap;
        const bodyClipH = clipH - titleBlockH - tGap;
        if (bodyClipH > 0) {
            const ovProxy = Object.assign({}, ov, { _skipTitle: true });
            if (featherTop > 0 || featherBottom > 0) {
                const cW = Math.ceil(clipW), cH = Math.ceil(bodyClipH);
                const tmp = document.createElement('canvas');
                tmp.width = cW; tmp.height = cH;
                const tc = tmp.getContext('2d');
                tc.font = fontStr;
                const offX = curX - clipX;
                const offY = curY - bodyClipY;
                _drawScrollTextBlock(tc, ovProxy, lines, offX, offY, textW, lineHeight, fontSize, align);

                // 渐变遮罩 (只下羽化，顶部紧贴标题)
                tc.globalCompositeOperation = 'destination-in';
                const grad = tc.createLinearGradient(0, 0, 0, cH);
                grad.addColorStop(0, 'rgba(0,0,0,1)');
                if (featherBottom > 0) {
                    grad.addColorStop(Math.max(1 - featherBottom / cH, 0.51), 'rgba(0,0,0,1)');
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                } else {
                    grad.addColorStop(1, 'rgba(0,0,0,1)');
                }
                tc.fillStyle = grad;
                tc.fillRect(0, 0, cW, cH);
                ctx.drawImage(tmp, clipX, bodyClipY);
            } else {
                ctx.save();
                ctx.beginPath();
                ctx.rect(clipX, bodyClipY, clipW, bodyClipH);
                ctx.clip();
                _drawScrollTextBlock(ctx, ovProxy, lines, curX, curY, textW, lineHeight, fontSize, align);
                ctx.restore();
            }
        }
    } else {
        // ── 标题跟随滚动 (原有逻辑) ──
        if (featherTop > 0 || featherBottom > 0) {
            const cW = Math.ceil(clipW), cH = Math.ceil(clipH);
            const tmp = document.createElement('canvas');
            tmp.width = cW; tmp.height = cH;
            const tc = tmp.getContext('2d');
            tc.font = fontStr;

            const offX = curX - clipX;
            const offY = curY - clipY;
            _drawScrollTextBlock(tc, ov, lines, offX, offY, textW, lineHeight, fontSize, align);

            tc.globalCompositeOperation = 'destination-in';
            const grad = tc.createLinearGradient(0, 0, 0, cH);
            if (featherTop > 0) {
                grad.addColorStop(0, 'rgba(0,0,0,0)');
                grad.addColorStop(Math.min(featherTop / cH, 0.49), 'rgba(0,0,0,1)');
            } else {
                grad.addColorStop(0, 'rgba(0,0,0,1)');
            }
            if (featherBottom > 0) {
                grad.addColorStop(Math.max(1 - featherBottom / cH, 0.51), 'rgba(0,0,0,1)');
                grad.addColorStop(1, 'rgba(0,0,0,0)');
            } else {
                grad.addColorStop(1, 'rgba(0,0,0,1)');
            }
            tc.fillStyle = grad;
            tc.fillRect(0, 0, cW, cH);
            ctx.drawImage(tmp, clipX, clipY);
        } else {
            ctx.save();
            ctx.beginPath();
            ctx.rect(clipX, clipY, clipW, clipH);
            ctx.clip();
            _drawScrollTextBlock(ctx, ov, lines, curX, curY, textW, lineHeight, fontSize, align);
            ctx.restore();
        }
    }

    // ── 预览辅助线 ──
    if (!ov._exporting) {
        ctx.save();
        ctx.setLineDash([8, 4]);
        ctx.strokeStyle = '#FF6B35';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(clipX, clipY, clipW, clipH);
        if (featherTop > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX, clipY + featherTop);
            ctx.lineTo(clipX + clipW, clipY + featherTop); ctx.stroke();
        }
        if (featherBottom > 0) {
            ctx.strokeStyle = '#FFD700'; ctx.setLineDash([4, 4]);
            ctx.beginPath(); ctx.moveTo(clipX, clipY + clipH - featherBottom);
            ctx.lineTo(clipX + clipW, clipY + clipH - featherBottom); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = '20px sans-serif';
        ctx.fillStyle = '#FF6B35';
        ctx.globalAlpha = 0.8;
        ctx.fillText(`裁切区 ${Math.round(clipW)}×${Math.round(clipH)}`, clipX + 8, clipY - 8);
        ctx.restore();
    }
}

/**
 * 绘制滚动字幕文本块 (内部)。
 */
function _drawScrollTextBlock(ctx, ov, lines, textX, textY, textW, lineHeight, fontSize, align) {
    let drawY = textY;

    // ── 标题 (如果 _skipTitle 则跳过，由外部固定绘制) ──
    const titleText = (ov.scroll_title || '').trim();
    if (titleText && !ov._skipTitle) {
        const tSize = parseFloat(ov.scroll_title_fontsize ?? 56);
        const tFamily = ov.scroll_title_font_family || ov.font_family || 'Arial';
        const tWeight = _resolveOverlayFontWeight(ov.scroll_title_font_weight, ov.scroll_title_bold ? 700 : 400);
        const tItalic = ov.italic ? 'italic' : 'normal';
        const tFallback = _resolveOverlayFallback(tFamily);
        const tFont = `${tItalic} ${tWeight} ${tSize}px "${tFamily}", ${tFallback}`;
        const tColor = ov.scroll_title_color || ov.color || '#FFFFFF';
        const tAlign = ov.scroll_title_align || align;
        const tLineH = tSize * 1.3 + parseFloat(ov.line_spacing ?? 6);
        const tGap = parseFloat(ov.scroll_title_gap ?? 20);

        ctx.save();
        ctx.font = tFont;
        const titleLines = _wrapText(ctx, titleText, textW);

        // 阴影
        if (ov.shadow_enabled) {
            ctx.save();
            ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
            ctx.shadowBlur = parseFloat(ov.shadow_blur || 4);
            ctx.shadowOffsetX = parseFloat(ov.shadow_offset_x || 2);
            ctx.shadowOffsetY = parseFloat(ov.shadow_offset_y || 2);
            ctx.fillStyle = tColor;
            let ty = drawY + tSize;
            for (const line of titleLines) {
                ctx.fillText(line, _alignX(ctx, line, textX, textW, tAlign), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 描边
        if (ov.use_stroke && (ov.stroke_width || 0) > 0) {
            ctx.save();
            ctx.strokeStyle = ov.stroke_color || '#000000';
            ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
            ctx.lineJoin = 'round'; ctx.miterLimit = 2;
            let ty = drawY + tSize;
            for (const line of titleLines) {
                ctx.strokeText(line, _alignX(ctx, line, textX, textW, tAlign), ty);
                ty += tLineH;
            }
            ctx.restore();
        }
        // 填充
        ctx.fillStyle = tColor;
        let ty = drawY + tSize;
        for (const line of titleLines) {
            ctx.fillText(line, _alignX(ctx, line, textX, textW, tAlign), ty);
            ty += tLineH;
        }
        drawY += titleLines.length * tLineH + tGap;
        ctx.restore();
        ctx.font = `${ov.italic ? 'italic' : 'normal'} ${_resolveOverlayFontWeight(ov.font_weight, ov.bold ? 700 : 400)} ${fontSize}px "${ov.font_family || 'Arial'}", ${_resolveOverlayFallback(ov.font_family || 'Arial')}`;
    }

    // ── 正文 ──
    // 阴影
    if (ov.shadow_enabled) {
        ctx.save();
        ctx.shadowColor = _withAlpha(ov.shadow_color || '#000000', (ov.shadow_opacity || 120) / 255);
        ctx.shadowBlur = parseFloat(ov.shadow_blur || 4);
        ctx.shadowOffsetX = parseFloat(ov.shadow_offset_x || 2);
        ctx.shadowOffsetY = parseFloat(ov.shadow_offset_y || 2);
        ctx.fillStyle = ov.color || '#FFFFFF';
        let sy = drawY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, textX, textW, align);
            ctx.fillText(line, lx, sy);
            sy += lineHeight;
        }
        ctx.restore();
    }
    // 描边
    if (ov.use_stroke && (ov.stroke_width || 0) > 0) {
        ctx.save();
        ctx.strokeStyle = ov.stroke_color || '#000000';
        ctx.lineWidth = parseFloat(ov.stroke_width || 2) * 2;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        let sy = drawY + fontSize;
        for (const line of lines) {
            const lx = _alignX(ctx, line, textX, textW, align);
            ctx.strokeText(line, lx, sy);
            sy += lineHeight;
        }
        ctx.restore();
    }
    // 填充
    ctx.fillStyle = ov.color || '#FFFFFF';
    let yc = drawY + fontSize;
    for (const line of lines) {
        const lx = _alignX(ctx, line, textX, textW, align);
        ctx.fillText(line, lx, yc);
        yc += lineHeight;
    }
}

/**
 * 绘制四角独立圆角矩形。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {number} tl - 左上 @param {number} tr - 右上
 * @param {number} br - 右下 @param {number} bl - 左下
 */
function _roundRectIndividual(ctx, x, y, w, h, tl, tr, br, bl) {
    tl = Math.min(tl, w / 2, h / 2);
    tr = Math.min(tr, w / 2, h / 2);
    br = Math.min(br, w / 2, h / 2);
    bl = Math.min(bl, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
}

function _resolveOverlayFontWeight(weight, fallback = 400) {
    const n = parseInt(weight, 10);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(100, Math.min(900, base));
}

function _resolveOverlayFallback(fontFamily) {
    const f = String(fontFamily || '').toLowerCase();
    const serifHints = [
        'serif', 'times', 'georgia', 'playfair', 'crimson', 'lora', 'gelasio',
        'caslon', 'vidaloka', 'yeseva', 'dm serif', 'young serif', 'rye',
        'song', 'ming', 'mincho',
    ];
    return serifHints.some(k => f.includes(k)) ? 'serif' : 'sans-serif';
}

// ═══════════════════════════════════════════════════════
// 3. Overlay Manager
// ═══════════════════════════════════════════════════════

class OverlayManager {
    constructor() {
        this.overlays = [];
    }

    addOverlay(ov) {
        this.overlays.push(ov);
        this._sortByZ();
        return ov;
    }

    removeOverlay(id) {
        this.overlays = this.overlays.filter(o => o.id !== id);
    }

    getOverlay(id) {
        return this.overlays.find(o => o.id === id) || null;
    }

    updateOverlay(id, updates) {
        const ov = this.getOverlay(id);
        if (ov) Object.assign(ov, updates);
        return ov;
    }

    /**
     * 获取在指定时间可见的覆层列表。
     */
    getVisibleOverlays(currentTime) {
        return this.overlays.filter(ov => {
            if (ov.disabled) return false;
            const start = parseFloat(ov.start || 0);
            const end = parseFloat(ov.end || 0);
            return currentTime >= start && currentTime <= end;
        });
    }

    /**
     * 渲染所有可见覆层。
     */
    renderAll(ctx, currentTime, canvasW = 1920, canvasH = 1080) {
        const visible = this.getVisibleOverlays(currentTime);
        for (const ov of visible) {
            drawOverlay(ctx, ov, currentTime, canvasW, canvasH);
        }
    }

    /**
     * Hit testing — 检测点击是否命中某个覆层。
     */
    hitTest(mx, my, currentTime) {
        const visible = this.getVisibleOverlays(currentTime);
        // 从上到下（后绘制的在上面）
        for (let i = visible.length - 1; i >= 0; i--) {
            const ov = visible[i];
            const x = parseFloat(ov.x || 0);
            // For textcard: use rendered Y/H (auto-fit) if available
            const y = ov.type === 'textcard' && ov._renderedY != null
                ? ov._renderedY : parseFloat(ov.y || 0);
            const w = parseFloat(ov.w || 100);
            const h = ov.type === 'textcard' && ov._renderedH != null
                ? ov._renderedH : parseFloat(ov.h || 100);
            if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                return ov;
            }
        }
        return null;
    }

    _sortByZ() {
        this.overlays.sort((a, b) => (a.z || 0) - (b.z || 0));
    }

    toJSON() {
        return this.overlays.map(o => ({ ...o }));
    }

    static fromJSON(data) {
        const mgr = new OverlayManager();
        if (Array.isArray(data)) {
            mgr.overlays = data.map(d => ({ ...d }));
        }
        return mgr;
    }
}

// ═══════════════════════════════════════════════════════
// 4. Drawing Helpers
// ═══════════════════════════════════════════════════════

function _wrapText(ctx, text, maxWidth) {
    if (maxWidth <= 0) return [text];
    const paragraphs = text.split('\n');
    const lines = [];
    for (const para of paragraphs) {
        if (!para) { lines.push(''); continue; }
        // Split into segments: CJK chars are each their own segment, whitespace-separated words stay together
        const segments = [];
        let buf = '';
        for (let i = 0; i < para.length; i++) {
            const ch = para[i];
            const isCJK = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef\u2e80-\u2eff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(ch);
            if (isCJK) {
                if (buf) { segments.push(buf); buf = ''; }
                segments.push(ch);
            } else {
                buf += ch;
                // Flush at whitespace boundaries
                if (/\s/.test(ch)) {
                    segments.push(buf); buf = '';
                }
            }
        }
        if (buf) segments.push(buf);

        let line = '';
        for (const seg of segments) {
            const test = line + seg;
            if (ctx.measureText(test).width > maxWidth && line) {
                lines.push(line.trim());
                line = seg;
            } else {
                line = test;
            }
        }
        if (line) lines.push(line.trim());
    }
    return lines;
}

function _drawTextLines(ctx, lines, boxX, boxY, boxW, lineHeight, align, color) {
    ctx.fillStyle = color;
    let yc = boxY + lineHeight * 0.77; // approx baseline
    for (const line of lines) {
        const lx = _alignX(ctx, line, boxX, boxW, align);
        ctx.fillText(line, lx, yc);
        yc += lineHeight;
    }
}

function _alignX(ctx, text, boxX, boxW, align) {
    if (align === 'center') {
        const tw = ctx.measureText(text).width;
        return boxX + (boxW - tw) / 2;
    } else if (align === 'right') {
        const tw = ctx.measureText(text).width;
        return boxX + boxW - tw;
    }
    return boxX;
}

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _withAlpha(hexColor, alpha) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

function _overlayId() {
    return 'ov_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsOverlay = {
    createTextOverlay,
    createImageOverlay,
    createTextCardOverlay,
    createScrollOverlay,
    drawOverlay,
    OverlayManager,
};

if (typeof window !== 'undefined') window.ReelsOverlay = ReelsOverlay;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsOverlay;
