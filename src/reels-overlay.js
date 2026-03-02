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
 * 创建文案卡片覆层对象。
 * 包含：纯色半透明背景 + 四角独立圆角 + 标题 + 内容（不同字体样式）
 */
function createTextCardOverlay(opts = {}) {
    return {
        id: _overlayId(),
        type: 'textcard',
        // ── 卡片位置/尺寸 ──
        x: opts.x ?? 40,
        y: opts.y ?? 200,
        w: opts.w ?? 910,
        h: opts.h ?? 0,           // 0 = 自动计算高度
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
        title_uppercase: opts.title_uppercase ?? true,
        title_letter_spacing: opts.title_letter_spacing ?? 1,
        // ── 内容 ──
        body_text: opts.body_text ?? '内容文字',
        body_font_family: opts.body_font_family || 'Arial',
        body_font_weight: opts.body_font_weight ?? (opts.body_bold ? 700 : 400),
        body_fontsize: opts.body_fontsize ?? 40,
        body_bold: opts.body_bold || false,
        body_italic: opts.body_italic || false,
        body_color: opts.body_color || '#000000',
        body_align: opts.body_align || 'center',
        body_line_spacing: opts.body_line_spacing ?? 6,
        // ── 自动适配 ──
        auto_fit: opts.auto_fit !== false,        // 根据文案长短自动调整蒙版大小
        auto_center_v: opts.auto_center_v ?? true, // 自动垂直居中
        // ── 内边距 ──
        padding_top: opts.padding_top ?? 20,
        padding_bottom: opts.padding_bottom ?? 40,
        padding_left: opts.padding_left ?? 40,
        padding_right: opts.padding_right ?? 40,
        title_body_gap: opts.title_body_gap ?? 42,  // 标题与内容间距
        // ── 自适应限制 ──
        max_height: opts.max_height ?? 1400,
        auto_shrink: opts.auto_shrink !== false,
        title_max_lines: opts.title_max_lines ?? 3,
        min_fontsize: opts.min_fontsize ?? 16,
        fullscreen_mask: opts.fullscreen_mask ?? false,
        // ── 动画 ──
        transition_preset: opts.transition_preset || 'none',
        transition_duration: opts.transition_duration || 0.35,
        anim_in_type: opts.anim_in_type || 'none',
        anim_out_type: opts.anim_out_type || 'none',
        anim_in_duration: opts.anim_in_duration || 0.3,
        anim_out_duration: opts.anim_out_duration || 0.3,
    };
}

// ═══════════════════════════════════════════════════════
// 2. Overlay Renderer
// ═══════════════════════════════════════════════════════

const _imageCache = {};

/**
 * 加载并缓存图片。
 */
function _getCachedImage(path) {
    if (!path) return null;
    if (_imageCache[path]) return _imageCache[path];

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = path.startsWith('/') ? `file://${path}` : path;
    img.onload = () => { _imageCache[path] = img; };
    _imageCache[path] = null; // placeholder
    return null;
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
    const start = parseFloat(ov.start || 0);
    const end = parseFloat(ov.end || 0);

    // 时间范围检查
    if (currentTime < start || currentTime > end) return;

    const x = parseFloat(ov.x || 0);
    const y = parseFloat(ov.y || 0);
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
        transOp = result.opacity;
        transScale = result.scale;
        transDx = result.dx;
        transDy = result.dy;
    }

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
 * 渲染文案卡片覆层。
 * 功能：半透明纯色背景 + 四角独立圆角 + 标题（粗体大字）+ 内容（正常字体）
 * 自动适配：根据文案长短调整蒙版大小和位置
 */
function _drawTextCardOverlay(ctx, ov, x, y, w, h, canvasW, canvasH, currentTime) {
    // 自动水平居中: 当宽度 < 画布宽度时居中
    if (ov.auto_center_v) {
        x = (canvasW - w) / 2;
        ov.x = x; // 写回供 hit-test
    }

    const padT = ov.padding_top ?? 20;
    const padB = ov.padding_bottom ?? 40;
    const padL = ov.padding_left ?? 40;
    const padR = ov.padding_right ?? 40;
    const gap = ov.title_body_gap ?? 42;

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

    const minFont = ov.min_fontsize ?? 16;
    const maxH = ov.max_height ?? 1400;
    const titleMaxLines = ov.title_max_lines ?? 3;
    const doShrink = ov.auto_shrink && maxH > 0;

    // ── 内部测量函数 ──
    function _measure(tfs, bfs) {
        const tf = `${titleItalic} ${titleWeight} ${tfs}px "${titleFamily}", ${titleFallback}`;
        ctx.font = tf;
        const tLines = titleText ? _wrapText(ctx, titleText, contentW) : [];
        const tLineH = tfs * 1.3 + (ov.title_letter_spacing ?? 0);
        const tH = tLines.length * tLineH;

        const bf = `${bodyItalic} ${bodyWeight} ${bfs}px "${bodyFamily}", ${bodyFallback}`;
        ctx.font = bf;
        const bLines = bodyText ? _wrapText(ctx, bodyText, contentW) : [];
        const bLineH = bfs * 1.3 + (ov.body_line_spacing ?? 0);
        const bH = bLines.length * bLineH;

        const hasT = tLines.length > 0;
        const hasB = bLines.length > 0;
        const total = (hasT ? tH : 0) + (hasT && hasB ? gap : 0) + (hasB ? bH : 0) + padT + padB;
        return { tLines, tLineH, tH, bLines, bLineH, bH, total, tf, bf, hasT, hasB };
    }

    // ── 自动缩放循环 ──
    let m = _measure(titleFontSize, bodyFontSize);

    if (doShrink && m.total > maxH) {
        // 第一阶段: 只缩内容字号
        while (m.total > maxH && bodyFontSize > minFont) {
            bodyFontSize = Math.max(minFont, bodyFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize);
        }
        // 第二阶段: 如果标题超过 titleMaxLines 行，缩标题
        while (m.total > maxH && m.tLines.length > titleMaxLines && titleFontSize > minFont) {
            titleFontSize = Math.max(minFont, titleFontSize - 2);
            m = _measure(titleFontSize, bodyFontSize);
        }
        // 第三阶段: 都缩
        while (m.total > maxH && (titleFontSize > minFont || bodyFontSize > minFont)) {
            if (bodyFontSize > minFont) bodyFontSize = Math.max(minFont, bodyFontSize - 1);
            if (titleFontSize > minFont) titleFontSize = Math.max(minFont, titleFontSize - 1);
            m = _measure(titleFontSize, bodyFontSize);
        }
    }

    const { tLines: titleLines, tLineH: titleLineH, tH: titleH,
        bLines: bodyLines, bLineH: bodyLineH, bH: bodyH,
        total: autoH, tf: titleFont, bf: bodyFont, hasT: hasTitle, hasB: hasBody } = m;

    // ── 计算总高度（自动适配）──
    let cardH = ov.auto_fit ? autoH : (h > 0 ? h : autoH);
    // 如果启用了 maxH 限制，裁剪
    if (doShrink && cardH > maxH) cardH = maxH;
    let cardY = y;

    // 自动垂直居中
    if (ov.auto_fit && ov.auto_center_v) {
        cardY = (canvasH - cardH) / 2;
    }

    // 全屏蒙版模式: 背景铺满画布，但文字区域保持在 cardY/cardH 内
    const isFullMask = ov.fullscreen_mask;
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
    }
    ctx.globalAlpha *= animOpFactor;

    // ── 绘制背景 ──
    const cardAlpha = (ov.card_opacity ?? 80) / 100;
    ctx.save();
    ctx.globalAlpha = cardAlpha * ctx.globalAlpha;
    ctx.fillStyle = ov.card_color || '#FFFFFF';
    if (isFullMask) {
        // 全屏铺满，无圆角
        ctx.fillRect(maskX, maskY, maskW, maskH);
    } else {
        _roundRectIndividual(ctx, x, cardY, w, cardH,
            ov.radius_tl || 0, ov.radius_tr || 0, ov.radius_br || 0, ov.radius_bl || 0);
        ctx.fill();
    }
    ctx.restore();

    // 文字区域始终基于 cardY/cardH（受 maxH 约束）
    const textY = cardY;

    // ── 绘制标题文字 ──
    if (hasTitle) {
        ctx.save();
        ctx.font = titleFont;
        ctx.fillStyle = ov.title_color || '#1A1A1A';
        let ty = textY + padT + titleFontSize * 0.85;
        for (const line of titleLines) {
            const lx = _alignX(ctx, line, x + padL, contentW, ov.title_align || 'center');
            ctx.fillText(line, lx, ty);
            ty += titleLineH;
        }
        ctx.restore();
    }

    // ── 绘制内容文字 ──
    if (hasBody) {
        ctx.save();
        ctx.font = bodyFont;
        ctx.fillStyle = ov.body_color || '#333333';
        let by = textY + padT + (hasTitle ? titleH + gap : 0) + bodyFontSize * 0.85;
        for (const line of bodyLines) {
            const lx = _alignX(ctx, line, x + padL, contentW, ov.body_align || 'center');
            ctx.fillText(line, lx, by);
            by += bodyLineH;
        }
        ctx.restore();
    }

    // 将实际绘制的尺寸存回 ov，供 hit-test 和属性面板使用
    ov._renderedH = cardH;
    ov._renderedY = cardY;

    // ── 最大高度辅助线（仅预览时显示，导出时跳过）──
    if (doShrink && !ov._exporting) {
        const guideY_top = ov.auto_center_v ? (canvasH - maxH) / 2 : cardY;
        const guideY_bot = guideY_top + maxH;
        ctx.save();
        ctx.setLineDash([10, 6]);
        ctx.strokeStyle = '#00D4FF';
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
        ctx.fillStyle = '#00D4FF';
        ctx.globalAlpha = 0.85;
        ctx.fillText(`最大高度: ${maxH}px`, x + w + 28, guideY_top + 26);
        // 高度标尺线
        ctx.beginPath();
        ctx.moveTo(x + w + 16, guideY_top);
        ctx.lineTo(x + w + 16, guideY_bot);
        ctx.strokeStyle = '#00D4FF';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
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
    drawOverlay,
    OverlayManager,
};

if (typeof window !== 'undefined') window.ReelsOverlay = ReelsOverlay;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsOverlay;
