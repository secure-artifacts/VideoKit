/**
 * reels-canvas-renderer.js — Canvas2D subtitle renderer
 * 
 * ✅ 完整移植自 AutoSub_v8 FrameRenderer.draw_subtitle()
 * QPainter → CanvasRenderingContext2D
 * 
 * 核心功能：
 * - 文字绘制 (带描边、阴影、背景框)
 * - 多行自动换行 (按像素宽度)
 * - 当前词高亮 (弹力色块)
 * - 多层扩展描边 (stroke_expand)
 * - 高级文本框 (advanced_textbox)
 * - 文本对齐 (left/center/right)
 * - 字母间距 (letter_spacing)
 * - 背景框模糊羽化 (box_blur)
 * - 渐变背景 (bg_gradient)
 * - 下划线效果
 * - Holy Glow 光晕
 * - Blur→Sharp 模糊到清晰
 * - 音频频谱可视化
 * - 16+种动画效果 (通过 reels-anim-engine.js)
 * - 打字机、逐字弹跳、节奏逐词等特效
 */

class ReelsCanvasRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._seCache = { key: null, img: null }; // stroke expand cache
    }

    setContextSegments(segments) {
        this._contextSegments = segments || [];
    }

    /**
     * 主渲染入口
     */
    renderSubtitle(style, segment, currentTime, videoW, videoH, _isSubCall = false) {
        if (!segment) return;
        const ctx = this.ctx;
        const s = {
            ...(style || {}),
            ...(segment.style_override || segment.subtitle_style || {})
        };

        if (!_isSubCall && s.fullpage_typewriter) {
            this._renderFullpageTypewriter(s, currentTime, videoW, videoH);
            return;
        }

        if (!_isSubCall && s.anim_in_type === 'scatter_pop') {
            this._renderScatterPop(s, segment, currentTime, videoW, videoH);
            return;
        }

        const text = segment.edited_text || segment.text || '';
        if (!text.trim()) return;

        const segStart = segment.start || 0;
        const segEnd = segment.end || 0;
        
        // Context interception for Scrolling Mode (teleprompter-style)
        if (!_isSubCall && s.scrolling_mode && this._contextSegments && this._contextSegments.length > 1) {
            // Find which segment is active
            let activeIdx = -1;
            for (let si = 0; si < this._contextSegments.length; si++) {
                const seg = this._contextSegments[si];
                if (currentTime >= seg.start && currentTime <= seg.end) {
                    activeIdx = si;
                    break;
                }
            }
            if (activeIdx === -1) {
                for (let si = 0; si < this._contextSegments.length; si++) {
                    if (this._contextSegments[si].start > currentTime) {
                        activeIdx = Math.max(0, si - 1);
                        break;
                    }
                }
                if (activeIdx === -1) activeIdx = this._contextSegments.length - 1;
            }

            const activeSeg = this._contextSegments[activeIdx];
            const fontSize = s.fontsize || 60;
            // Gap between lines: generous spacing for readability
            const gap = fontSize * 1.8;

            // Smooth transition when switching lines
            const transDur = 0.30;
            let scrollAnim = 0;
            if (currentTime >= activeSeg.start && currentTime < activeSeg.start + transDur && activeIdx > 0) {
                const t = (currentTime - activeSeg.start) / transDur;
                const ease = 1 - Math.pow(1 - t, 3);
                scrollAnim = (1 - ease);
            }
            const centerIdx = activeIdx - scrollAnim;

            const visibleLines = s.scrolling_visible_lines || 5;
            const halfVisible = visibleLines / 2;
            const contextOpacity = s.scrolling_opacity_context ?? 0.25;

            for (let si = 0; si < this._contextSegments.length; si++) {
                const distFromCenter = si - centerIdx;
                if (Math.abs(distFromCenter) > halfVisible + 1) continue;

                const yOffset = distFromCenter * gap;
                const absDist = Math.abs(distFromCenter);

                // Opacity
                let lineAlpha = 1.0;
                if (absDist > 0.5) {
                    lineAlpha = contextOpacity;
                    if (absDist > halfVisible - 0.5) {
                        lineAlpha *= Math.max(0, 1.0 - (absDist - (halfVisible - 0.5)));
                    }
                }
                if (lineAlpha <= 0.01) continue;

                const targetSeg = this._contextSegments[si];
                const targetStyle = { ...s };
                targetStyle.scrolling_mode = false;

                // Determine render time and highlight state
                const isPast = currentTime > targetSeg.end;
                const isFuture = currentTime < targetSeg.start;
                const isPlaying = !isPast && !isFuture;
                let renderTime;
                if (isPlaying) {
                    renderTime = currentTime;
                } else if (isPast) {
                    // Already read: plain text, no highlight
                    renderTime = targetSeg.start;
                    targetStyle.karaoke_highlight = false;
                    targetStyle.color_high = targetStyle.color_text || '#FFFFFF';
                } else {
                    // Future: show static, no highlight
                    renderTime = targetSeg.start;
                    targetStyle.karaoke_highlight = false;
                    targetStyle.color_high = targetStyle.color_text || '#FFFFFF';
                }

                // Scrolling mode: disable ALL animations — scroll handles transitions
                targetStyle.anim_in_type = 'none';
                targetStyle.anim_out_type = 'none';
                targetStyle.dynamic_box = false;

                // Apply opacity through style so renderSubtitle respects it
                targetStyle.opacity_text_global = lineAlpha;

                ctx.save();
                ctx.translate(0, yOffset);

                this.renderSubtitle(targetStyle, targetSeg, renderTime, videoW, videoH, true);
                ctx.restore();
            }
            return;
        }


        // For non-scrolling lines, we only render if active
        if (!_isSubCall && (currentTime < segStart || currentTime > segEnd)) return;

        // 【拦截】如果包含富文本样式范围，或启用了自动着色规则，则进入独立的富文本渲染循环，以此保证旧版 0 损耗
        let finalStyledRanges = segment.styled_ranges || [];
        if (s.auto_color_rules && s.auto_color_rules.length > 0 && typeof ReelsRichText !== 'undefined') {
            const autoRanges = ReelsRichText.getCachedAutoColor(segment.text, s.auto_color_rules);
            finalStyledRanges = ReelsRichText.mergeAutoAndManual(autoRanges, finalStyledRanges);
        }

        if (finalStyledRanges && finalStyledRanges.length > 0) {
            const origRanges = segment.styled_ranges;
            segment.styled_ranges = finalStyledRanges;
            this._renderRichTextSubtitle(style, segment, currentTime, videoW, videoH);
            segment.styled_ranges = origRanges; // 恢复原始引用
            return;
        }

        const anim = typeof ReelsAnimEngine !== 'undefined' ? ReelsAnimEngine : null;

        // ── 字体设置 ──
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const fontSize = s.fontsize || 74;
        const italic = s.italic || false;
        const letterSpacing = s.letter_spacing || 0;
        const wordSpacing = s.word_spacing || 0;
        const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        // ── 高级文本框 ──
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);

        // ── 文字换行计算 ──
        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 90));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        const wordsInfo = segment.words || [];
        const flatWords = wordsInfo.length > 0
            ? wordsInfo.map(w => w.word || '').filter(Boolean)
            : text.split(/\s+/).filter(Boolean);
        const words = flatWords;
        const joiner = ' ';

        const paragraphs = text.split('\n');
        const lines = [];
        
        // 建立单词到段落的映射
        const wordParaIndices = [];
        let currentParaIdx = 0;
        let paraCharIdx = 0;

        for (let w = 0; w < flatWords.length; w++) {
            const wordStr = flatWords[w];
            const wordNonSpaces = wordStr.replace(/\s/g, '').length;
            
            while (currentParaIdx < paragraphs.length) {
                const para = paragraphs[currentParaIdx];
                // 跳过段落前面的空白字符
                while (paraCharIdx < para.length && /\s/.test(para[paraCharIdx])) {
                    paraCharIdx++;
                }
                if (paraCharIdx < para.length) {
                    const remaining = para.slice(paraCharIdx);
                    const paraRemainingNonSpaces = remaining.replace(/\s/g, '').length;
                    // 如果当前段落剩下的字符全是空白，且不是最后一个段落，则移到下一个段落
                    if (paraRemainingNonSpaces === 0 && currentParaIdx < paragraphs.length - 1) {
                        currentParaIdx++;
                        paraCharIdx = 0;
                        continue;
                    }
                    
                    wordParaIndices.push(currentParaIdx);
                    
                    // 在当前段落中消耗掉当前单词的所有非空白字符
                    let matchedNonSpaces = 0;
                    while (paraCharIdx < para.length && matchedNonSpaces < wordNonSpaces) {
                        if (!/\s/.test(para[paraCharIdx])) {
                            matchedNonSpaces++;
                        }
                        paraCharIdx++;
                    }
                    break;
                } else {
                    if (currentParaIdx < paragraphs.length - 1) {
                        currentParaIdx++;
                        paraCharIdx = 0;
                    } else {
                        wordParaIndices.push(currentParaIdx);
                        break;
                    }
                }
            }
        }

        // 按段落对单词分组
        const paraWordsGroups = Array.from({ length: paragraphs.length }, () => []);
        for (let w = 0; w < flatWords.length; w++) {
            const pIdx = wordParaIndices[w] !== undefined ? wordParaIndices[w] : (paragraphs.length - 1);
            paraWordsGroups[pIdx].push(flatWords[w]);
        }

        for (let i = 0; i < paragraphs.length; i++) {
            const paraWords = paraWordsGroups[i];
            if (paraWords.length > 0) {
                const paraLines = this._wrapTokensByPixelWidth(paraWords, maxWidth, joiner, letterSpacing, wordSpacing);
                lines.push(...paraLines);
            } else {
                const isLast = (i === paragraphs.length - 1);
                if (!isLast || paragraphs[i].trim() !== '') {
                    lines.push('');
                }
            }
        }
        if (lines.length === 0) return;

        // ── 行高与布局 ──
        const lineSpacing = s.line_spacing || 0;
        const lineH = fontSize * 1.2;
        const lineStep = lineH + lineSpacing;
        const blockTypography = (s.block_typography_enabled === true)
            || (s.block_typography_enabled == null && (s.anim_in_type || 'none') === 'word_pop_random');
        const blockScaleMin = Number.isFinite(Number(s.block_scale_min)) ? Number(s.block_scale_min) : 0.78;
        const blockScaleMax = Number.isFinite(Number(s.block_scale_max)) ? Number(s.block_scale_max) : 1.6;
        const blockTargetWidth = maxWidth;

        // If advanced textbox, limit visible lines
        let visibleLines = lines;
        if (advEnabled) {
            const maxVisLines = Math.max(1, Math.floor(advH / Math.max(1, lineStep)));
            visibleLines = lines.slice(0, maxVisLines);
        }

        let maxLineW = 0;
        const lineWidths = visibleLines.map(line => {
            const w = this._measureLineWithSpacing(ctx, line, letterSpacing, wordSpacing);
            maxLineW = Math.max(maxLineW, w);
            return w;
        });
        const lineScales = lineWidths.map((w) => {
            if (!blockTypography) return 1.0;
            const safeW = Math.max(1, w);
            const fit = blockTargetWidth / safeW;
            return Math.max(blockScaleMin, Math.min(blockScaleMax, fit));
        });
        const lineHeights = lineScales.map(sc => lineH * sc);
        const lineTopOffsets = [];
        let accumY = 0;
        for (let i = 0; i < visibleLines.length; i++) {
            lineTopOffsets.push(accumY);
            accumY += lineHeights[i];
            if (i < visibleLines.length - 1) accumY += lineSpacing;
        }
        const totalH = accumY;

        // ── 精确计算每行实际渲染宽度（模拟渲染循环的 currX 推进） ──
        const animInType_ = s.anim_in_type || 'none';
        const _isWPR_ = animInType_ === 'word_pop_random';
        const _isWPRP_ = animInType_ === 'word_pop_random_pulse';
        const _isLJ_ = animInType_ === 'letter_jump';
        const segDur_ = Math.max(0.001, segEnd - segStart);
        const spaceW_ = ctx.measureText(' ').width + wordSpacing;

        let actualMaxLineW = 0;
        let finalMaxLineW = 0; // 所有词完全展开后的最终宽度（用于稳定居中锚点）
        const actualLineWidths = []; // 每行动画后实际渲染宽度
        const finalLineWidths = [];  // 每行最终宽度（不随时间变化）
        let simWordIdx = 0;
        for (let li = 0; li < visibleLines.length; li++) {
            const lineTokens = visibleLines[li].split(/\s+/).filter(Boolean);
            const lScale = lineScales[li] || 1.0;
            let lineRenderedW = 0;
            let lineFinalW = 0;

            for (let ti = 0; ti < lineTokens.length; ti++) {
                const ww = this._measureTextWithSpacing(ctx, lineTokens[ti], letterSpacing);
                // 与渲染循环完全一致的 advanceScale 计算
                let advScale = lScale;
                let finalAdvScale = lScale; // 最终 scale（始终包含随机缩放）

                if (_isWPR_) {
                    let ws = segStart;
                    if (wordsInfo.length > 0 && simWordIdx < wordsInfo.length) {
                        ws = wordsInfo[simWordIdx].start || segStart;
                    } else {
                        ws = segStart + segDur_ * (simWordIdx / Math.max(1, words.length));
                    }
                    const randScale = this._computeWordRandomFinalScale(
                        simWordIdx, segStart, ws,
                        Number(s.word_pop_random_min_scale ?? 0.86),
                        Number(s.word_pop_random_max_scale ?? 1.34)
                    );
                    finalAdvScale *= randScale;
                    if (currentTime >= ws) {
                        advScale *= randScale;
                    }
                }

                if (_isWPRP_) {
                    const pMax = Number(s.word_pop_random_pulse_max_scale ?? 1.40);
                    const pFactor = Math.max(1.0, pMax * 0.85);
                    advScale *= pFactor;
                    finalAdvScale *= pFactor;
                }

                // letter_jump: 高亮词会有瞬时放大
                if (_isLJ_) {
                    const ljScale = Number(s.letter_jump_scale ?? 1.5);
                    if (ljScale > 1.0) {
                        advScale *= ljScale;
                        finalAdvScale *= ljScale;
                    }
                }

                // 视觉宽度 = wordW * scale (文字实际绘制宽度)
                const visualWordW = ww * advScale;
                const finalVisualWordW = ww * finalAdvScale;
                // 累加：词宽 + 词间距（最后一个词不加间距）
                if (ti < lineTokens.length - 1) {
                    lineRenderedW += visualWordW + spaceW_ * advScale;
                    lineFinalW += finalVisualWordW + spaceW_ * finalAdvScale;
                } else {
                    lineRenderedW += visualWordW;
                    lineFinalW += finalVisualWordW;
                }
                simWordIdx++;
            }
            actualLineWidths.push(lineRenderedW);
            actualMaxLineW = Math.max(actualMaxLineW, lineRenderedW);
            finalLineWidths.push(lineFinalW);
            finalMaxLineW = Math.max(finalMaxLineW, lineFinalW);
        }

        // 使用最终宽度（所有词完成动画后）来锚定居中位置，避免逐词弹出时文字整体偏移
        let renderMaxLineW = blockTypography ? blockTargetWidth : maxLineW;
        renderMaxLineW = Math.max(renderMaxLineW, finalMaxLineW);

        // ── 位置计算 ──
        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1
                ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1
                ? s.pos_y * videoH : (s.pos_y || videoH * 0.85);
        }

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 12));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 12));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 8));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 8));

        // 描边/扩展描边超出文字边界的额外量
        let strokeExtra = 0;
        if (s.use_stroke !== false && (s.border_width || 3) > 0) {
            strokeExtra = Math.max(strokeExtra, (s.border_width || 3));
        }
        if (s.stroke_expand_enabled) {
            const seLayers = parseInt(s.stroke_expand_layers) || 3;
            const seStep = parseFloat(s.stroke_expand_step) || 4;
            const seFeather = parseFloat(s.stroke_expand_feather) || 8;
            strokeExtra = Math.max(strokeExtra, seLayers * seStep + seFeather);
        }
        const effectivePadLeft = padLeft + strokeExtra;
        const effectivePadRight = padRight + strokeExtra;
        const effectivePadTop = padTop + strokeExtra;
        const effectivePadBottom = padBottom + strokeExtra;
        let rectX, rectY, rectW, rectH;
        if (advEnabled) {
            rectX = advX; rectY = advY; rectW = advW; rectH = advH;
        } else {
            rectX = cx - renderMaxLineW / 2 - effectivePadLeft;
            rectY = cy - totalH / 2 - effectivePadTop;
            rectW = renderMaxLineW + effectivePadLeft + effectivePadRight;
            rectH = totalH + effectivePadTop + effectivePadBottom;
        }

        ctx.save();

        // ── 旋转 ──
        const rotation = s.rotation || 0;
        if (rotation !== 0) {
            ctx.translate(cx, cy);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }

        // ── 动画进度 ──
        const animInType = s.anim_in_type || 'none';
        const animOutType = s.anim_out_type || 'none';
        let inProg = 1.0, outProg = 1.0;
        let animOpacity = 1.0;

        if (anim && (animInType !== 'none' || animOutType !== 'none')) {
            const inDur = animInType !== 'none' ? (s.anim_in_duration || 0.3) : 0;
            const outDur = animOutType !== 'none' ? (s.anim_out_duration || 0.25) : 0;
            [inProg, outProg] = anim.computeAnimProgress(
                currentTime, segStart, segEnd, inDur, outDur,
                s.anim_in_easing || 'ease_out', s.anim_out_easing || 'ease_in_out'
            );
        }

        // Fade
        if (animInType === 'fade') animOpacity = Math.min(animOpacity, inProg);
        if (animOutType === 'fade') animOpacity = Math.min(animOpacity, outProg);

        // Slide
        if (anim) {
            for (const [atype, prog] of [[animInType, inProg], [animOutType, outProg]]) {
                if (['slide_up', 'slide_down', 'slide_left', 'slide_right'].includes(atype)) {
                    const [dx, dy] = anim.computeSlideOffset(prog, atype, 60);
                    ctx.translate(dx, dy);
                }
            }
        }

        // Pop
        if (anim && (animInType === 'pop' || animOutType === 'pop')) {
            let popP = 1.0;
            if (animInType === 'pop') popP = Math.min(popP, anim.computePopScale(inProg));
            if (animOutType === 'pop') popP = Math.min(popP, anim.computePopScale(outProg));
            if (popP < 0.999) {
                ctx.translate(cx, cy);
                ctx.scale(popP, popP);
                ctx.translate(-cx, -cy);
            }
        }

        // Floating
        if (anim && animInType === 'floating') {
            const dyFloat = anim.computeFloatingOffset(
                currentTime, segStart,
                s.floating_amplitude || 8, s.floating_period || 2.0
            );
            ctx.translate(0, dyFloat);
        }

        // Holy glow
        let holyGlowAlpha = 1.0, holyGlowRadius = 0;
        if (anim && animInType === 'holy_glow' && typeof anim.computeHolyGlow === 'function') {
            [holyGlowAlpha, holyGlowRadius] = anim.computeHolyGlow(
                currentTime, segStart, segEnd,
                parseInt(s.holy_glow_radius) || 6,
                parseFloat(s.holy_glow_period) || 3.0
            );
        }

        // Blur→Sharp
        let blurRadius = 0;
        if (anim && animInType === 'blur_sharp' && typeof anim.computeBlurSharpRadius === 'function') {
            blurRadius = anim.computeBlurSharpRadius(
                currentTime, segStart, segEnd,
                parseInt(s.blur_sharp_max) || 20,
                parseFloat(s.blur_sharp_clear_frac) || 0.4
            );
        }

        // Global opacity
        const rawOp = s.opacity_text_global !== undefined ? s.opacity_text_global : 255;
        const normOp = rawOp <= 1.0 && rawOp > 0 ? rawOp : rawOp / 255;
        const globalAlpha = normOp * animOpacity;
        ctx.globalAlpha = globalAlpha;

        // ── Typewriter ──
        const isTypewriter = animInType === 'typewriter';
        let twRevealedCount = -1;
        if (isTypewriter && anim) {
            let totalChars = 0;
            for (const w of words) totalChars += w.length;
            totalChars += Math.max(0, words.length - 1);
            twRevealedCount = anim.computeTypewriterProgress(
                currentTime, segStart, segEnd, totalChars
            );
        }

        // ── Character bounce ──
        const isCharBounce = animInType === 'char_bounce';
        const cbHeight = s.char_bounce_height || 20;
        const cbStagger = s.char_bounce_stagger || 0.05;

        // ── Metronome / Bullet / Letter Jump flags ──
        const isMetronome = animInType === 'metronome';
        const isWordPopRandom = animInType === 'word_pop_random';
        const isWordPopRandomPulse = animInType === 'word_pop_random_pulse';
        const isBullet = animInType === 'bullet_reveal';
        const isLetterJump = animInType === 'letter_jump';
        const isFlash = animInType === 'flash_highlight';
        const isHolyGlow = animInType === 'holy_glow';
        const wordPopGroups = (isWordPopRandom && words.length > 0)
            ? this._buildWordPopGroups(words.length, segStart, segEnd, wordsInfo)
            : null;

        // ── Advanced textbox background ──
        if (advEnabled && s.adv_bg_enabled) {
            this._drawAdvTextboxBg(ctx, s, advX, advY, advW, advH);
        }

        // ── 背景框绘制 ──
        if (s.use_box) {
            ctx.save();
            const bgColor = s.color_bg || '#000000';
            const bgAlpha = (s.opacity_bg || 150) / 255;
            ctx.globalAlpha = globalAlpha * bgAlpha;

            // Box blur (feathered edge)
            const boxBlur = s.box_blur || 0;
            const rad = s.box_radius || 8;
            
            const isAdaptive = s.box_adaptive_width && !advEnabled;
            let tempStartY;
            if (isAdaptive) {
                tempStartY = cy - totalH / 2;
            }

            const buildBoxPath = (expand) => {
                ctx.beginPath();
                if (isAdaptive) {
                    for (let i = 0; i < visibleLines.length; i++) {
                        const lineW = lineWidths[i];
                        const effectiveLineW = (actualLineWidths[i] != null && actualLineWidths[i] > lineW) ? actualLineWidths[i] : lineW;
                        let xStart = cx - effectiveLineW / 2; // Usually center
                        const y = tempStartY + (blockTypography ? lineTopOffsets[i] : (i * lineStep));
                        const lRectX = xStart - effectivePadLeft - expand;
                        const lRectY = y - effectivePadTop - expand;
                        const lRectW = effectiveLineW + effectivePadLeft + effectivePadRight + expand * 2;
                        const lRectH = lineH + effectivePadTop + effectivePadBottom + expand * 2;
                        
                        let r = rad + expand * 0.3;
                        r = Math.min(r, lRectW / 2, lRectH / 2);
                        ctx.moveTo(lRectX + r, lRectY);
                        ctx.lineTo(lRectX + lRectW - r, lRectY);
                        ctx.quadraticCurveTo(lRectX + lRectW, lRectY, lRectX + lRectW, lRectY + r);
                        ctx.lineTo(lRectX + lRectW, lRectY + lRectH - r);
                        ctx.quadraticCurveTo(lRectX + lRectW, lRectY + lRectH, lRectX + lRectW - r, lRectY + lRectH);
                        ctx.lineTo(lRectX + r, lRectY + lRectH);
                        ctx.quadraticCurveTo(lRectX, lRectY + lRectH, lRectX, lRectY + lRectH - r);
                        ctx.lineTo(lRectX, lRectY + r);
                        ctx.quadraticCurveTo(lRectX, lRectY, lRectX + r, lRectY);
                        ctx.closePath();
                    }
                } else {
                    let r = rad + expand * 0.3;
                    const lRectX = rectX - expand;
                    const lRectY = rectY - expand;
                    const lRectW = rectW + expand * 2;
                    const lRectH = rectH + expand * 2;
                    r = Math.min(r, lRectW / 2, lRectH / 2);
                    ctx.moveTo(lRectX + r, lRectY);
                    ctx.lineTo(lRectX + lRectW - r, lRectY);
                    ctx.quadraticCurveTo(lRectX + lRectW, lRectY, lRectX + lRectW, lRectY + r);
                    ctx.lineTo(lRectX + lRectW, lRectY + lRectH - r);
                    ctx.quadraticCurveTo(lRectX + lRectW, lRectY + lRectH, lRectX + lRectW - r, lRectY + lRectH);
                    ctx.lineTo(lRectX + r, lRectY + lRectH);
                    ctx.quadraticCurveTo(lRectX, lRectY + lRectH, lRectX, lRectY + lRectH - r);
                    ctx.lineTo(lRectX, lRectY + r);
                    ctx.quadraticCurveTo(lRectX, lRectY, lRectX + r, lRectY);
                    ctx.closePath();
                }
            };

            if (boxBlur > 0) {
                const steps = Math.min(20, Math.max(6, Math.floor(boxBlur * 0.5)));
                for (let si = steps; si >= 0; si--) {
                    const t = si / Math.max(1, steps);
                    const expand = t * boxBlur;
                    const alphaFactor = Math.exp(-((t * 2.8) ** 2));
                    const layerAlpha = bgAlpha * alphaFactor / steps * 3.5;
                    if (layerAlpha < 0.004) continue;
                    ctx.save();
                    ctx.globalAlpha = globalAlpha * Math.min(1, layerAlpha);
                    ctx.fillStyle = bgColor;
                    buildBoxPath(expand);
                    ctx.fill();
                    ctx.restore();
                }
            }

            ctx.fillStyle = bgColor;

            // Box color transition
            if (s.box_transition_enabled && anim) {
                const fromColor = this._parseColor(bgColor);
                const toColor = this._parseColor(s.box_transition_color_to || '#FF6600');
                const transColor = anim.computeBoxColorTransition(
                    currentTime, segStart, segEnd, wordsInfo,
                    [...fromColor, Math.round(bgAlpha * 255)],
                    [...toColor, Math.round(bgAlpha * 255)]
                );
                ctx.fillStyle = `rgba(${transColor[0]},${transColor[1]},${transColor[2]},${transColor[3] / 255})`;
            }

            // Gradient background
            if (s.bg_gradient_enabled) {
                const colors = typeof s.bg_gradient_colors === 'string'
                    ? s.bg_gradient_colors.split(',').map(c => c.trim())
                    : (Array.isArray(s.bg_gradient_colors) ? s.bg_gradient_colors : [bgColor, '#333333']);
                if (colors.length >= 2) {
                    let grad;
                    const gradType = s.bg_gradient_type || 'linear_h';
                    if (gradType === 'linear_v') {
                        grad = ctx.createLinearGradient(rectX, rectY, rectX, rectY + rectH);
                    } else if (gradType === 'center') {
                        grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rectW, rectH) / 2);
                    } else if (gradType === 'fresnel') {
                        grad = ctx.createLinearGradient(rectX, rectY, rectX + rectW, rectY);
                        const edgeC = colors[0]; const midC = colors[colors.length - 1];
                        grad.addColorStop(0, edgeC);
                        grad.addColorStop(0.15, midC + '1E'); // alpha ~30
                        grad.addColorStop(0.85, midC + '1E');
                        grad.addColorStop(1.0, edgeC);
                        ctx.fillStyle = grad;
                    } else {
                        grad = ctx.createLinearGradient(rectX, rectY, rectX + rectW, rectY);
                    }
                    if (gradType !== 'fresnel') {
                        colors.forEach((c, i) => {
                            grad.addColorStop(i / Math.max(1, colors.length - 1), c);
                        });
                        ctx.fillStyle = grad;
                    }
                }
            }

            buildBoxPath(0);
            ctx.fill();

            // Highlight overlay
            if (s.bg_gradient_highlight) {
                const hlGrad = ctx.createLinearGradient(rectX, rectY, rectX, rectY + rectH * 0.3);
                hlGrad.addColorStop(0, 'rgba(255,255,255,0.24)');
                hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = hlGrad;
                buildBoxPath(0);
                ctx.fill();
            }
            ctx.restore();
        }

        // ── Flash highlight ──
        if (isFlash && anim) {
            const flashI = anim.computeFlashHighlight(currentTime, segStart, s.flash_duration || 0.1);
            if (flashI > 0.01) {
                ctx.save();
                ctx.globalAlpha = globalAlpha * flashI * 0.8;
                ctx.fillStyle = s.flash_color || '#FFFF00';
                const rad = s.box_radius || 8;
                this._roundRect(ctx, rectX - 4, rectY - 4, rectW + 8, rectH + 8, rad);
                ctx.fill();
                ctx.restore();
            }
        }

        // ── Clip for advanced textbox ──
        if (advEnabled) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(rectX, rectY, rectW, rectH);
            ctx.clip();
        }

        // ── Multi-layer stroke expand (pre-pass) ──
        if (s.stroke_expand_enabled) {
            this._renderStrokeExpand(ctx, s, visibleLines, lineWidths, cx, advEnabled, advAlign, advX, advW,
                cy, totalH, lineStep, fontStr, fontSize, letterSpacing, advY, advH);
        }

        // ── 文字绘制 ──
        const textColor = s.color_text || '#FFFFFF';
        const highColor = s.color_high || '#FFD700';
        const outlineColor = s.color_outline || '#000000';
        const outlineAlpha = (s.opacity_outline || 255) / 255;
        const borderW = s.border_width || 3;
        const useStroke = s.use_stroke !== false;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x || 0;
        const shadowOffY = s.shadow_offset_y || 0;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;
        const useUnderline = s.use_underline || false;
        const underlineColor = s.color_underline || '#FFD700';

        let startY;
        if (advEnabled) {
            const advValign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (advValign === 'top') {
                startY = advY;
            } else if (advValign === 'bottom') {
                startY = advY + advH - totalH;
            } else { // center
                startY = cy - totalH / 2;
            }
        } else {
            startY = cy - totalH / 2;
        }

        let wordCounter = 0;
        let twCharCounter = 0;

        for (let i = 0; i < visibleLines.length; i++) {
            const line = visibleLines[i];
            const lineW = lineWidths[i];
            const lineScale = lineScales[i] || 1.0;
            const lineHScaled = lineH * lineScale;

            // Text alignment — 使用最终行宽（所有词展开后）来锚定居中位置，避免逐词弹出时偏移
            const anchorLineW = (finalLineWidths[i] != null && finalLineWidths[i] > lineW)
                ? finalLineWidths[i] : lineW;
            const effectiveLineW = (actualLineWidths[i] != null && actualLineWidths[i] > lineW)
                ? actualLineWidths[i] : lineW;
            let xStart;
            if (blockTypography && advEnabled && advAlign === 'left') {
                xStart = advX;
            } else if (blockTypography && advEnabled && advAlign === 'right') {
                xStart = advX + advW - renderMaxLineW;
            } else if (blockTypography) {
                xStart = cx - renderMaxLineW / 2;
            } else if (advEnabled && advAlign === 'left') {
                xStart = advX;
            } else if (advEnabled && advAlign === 'right') {
                xStart = advX + advW - effectiveLineW;
            } else {
                // 居中对齐：使用最终宽度锚定位置，防止逐词弹出时文字整体左移
                xStart = cx - anchorLineW / 2;
            }

            const y = startY + (blockTypography ? lineTopOffsets[i] : (i * lineStep));

            // Bullet reveal: per-line alpha
            let lineAlpha = 1.0;
            if (anim && isBullet) {
                lineAlpha = anim.computeBulletRevealLineAlpha(
                    currentTime, segStart, segEnd, i, visibleLines.length,
                    s.bullet_stagger || 0.15
                );
                if (lineAlpha < 0.01) {
                    const lineWords = line.split(/\s+/);
                    wordCounter += lineWords.length;
                    continue;
                }
            }

            const lineWords = line.split(/\s+/).filter(Boolean);
            let currX = xStart;

            for (const wordStr of lineWords) {
                const wordW = this._measureTextWithSpacing(ctx, wordStr, letterSpacing);
                const spaceW = ctx.measureText(' ').width + wordSpacing;

                // Current word highlight
                let isHighlight = false;
                let wInfo = null;
                if (currentTime != null && wordCounter < wordsInfo.length) {
                    wInfo = wordsInfo[wordCounter];
                    wordCounter++;
                    if (wInfo.start <= currentTime && currentTime <= wInfo.end) isHighlight = true;
                } else {
                    wordCounter++;
                }
                const wordIdx = wordCounter - 1;
                const totalWordCount = Math.max(1, words.length);
                const segDur = Math.max(0.001, segEnd - segStart);
                const fallbackStart = segStart + segDur * (wordIdx / totalWordCount);
                const fallbackEnd = segStart + segDur * ((wordIdx + 1) / totalWordCount);
                let wordStart = (wInfo && Number.isFinite(wInfo.start)) ? wInfo.start : fallbackStart;
                let wordEnd = (wInfo && Number.isFinite(wInfo.end)) ? wInfo.end : fallbackEnd;
                if (wordPopGroups && wordIdx < wordPopGroups.starts.length) {
                    wordStart = wordPopGroups.starts[wordIdx];
                    wordEnd = wordPopGroups.ends[wordIdx];
                }

                // Metronome visibility
                let metroVisible = true;
                if (anim && isMetronome && wInfo) {
                    metroVisible = anim.computeMetronomeWordVisible(
                        currentTime, segStart, segEnd,
                        wordCounter - 1, wordsInfo.length,
                        s.metronome_bpm || 120
                    );
                }

                // ── Dynamic highlight box ──
                if (isHighlight && s.dynamic_box) {
                    const dynPad = s.high_padding || 4;
                    const dynOffY = s.high_offset_y || 0;
                    let boxX = currX - dynPad;
                    let boxY = y - dynPad + dynOffY;
                    let boxW = wordW * lineScale + dynPad * 2;
                    let boxH = lineHScaled + dynPad * 2;

                    if (s.dyn_box_anim && anim && wInfo) {
                        const dscale = anim.computeDynBoxScale(
                            currentTime, wInfo.start, wInfo.end,
                            s.dyn_box_anim_overshoot || 1.3, s.dyn_box_anim_duration || 0.15
                        );
                        if (Math.abs(dscale - 1.0) > 0.01) {
                            const dbCx = boxX + boxW / 2;
                            const dbCy = boxY + boxH / 2;
                            boxX = dbCx - (boxW * dscale) / 2;
                            boxY = dbCy - (boxH * dscale) / 2;
                            boxW *= dscale;
                            boxH *= dscale;
                        }
                    }

                    ctx.save();
                    const dynColor = s.color_high_bg || '#FFD700';
                    const dynAlpha = (s.opacity_high_bg || 200) / 255;
                    ctx.globalAlpha = globalAlpha * dynAlpha * lineAlpha;
                    ctx.fillStyle = dynColor;
                    const dynRad = s.dynamic_radius || 6;
                    this._roundRect(ctx, boxX, boxY, boxW, boxH, dynRad);
                    ctx.fill();
                    ctx.restore();
                }

                // ── Letter jump scale ──
                let letterJumpScale = 1.0;
                if (anim && isLetterJump && isHighlight && wInfo) {
                    letterJumpScale = anim.computeLetterJumpScale(
                        currentTime, wInfo.start, wInfo.end,
                        s.letter_jump_scale || 1.5, s.letter_jump_duration || 0.2
                    );
                }

                // ── Determine colors ──
                let wordOpacity = lineAlpha;
                let wordColor = isHighlight ? highColor : textColor;
                let wordStrokeColor = outlineColor;

                if (isTypewriter) {
                    const wordLen = wordStr.length;
                    const charEnd = twCharCounter + wordLen;
                    if (twRevealedCount >= 0) {
                        if (twCharCounter >= twRevealedCount) {
                            wordColor = s.tw_unrevealed_color || '#808080';
                            wordStrokeColor = s.tw_unrevealed_stroke_color || '#404040';
                            wordOpacity *= (s.tw_unrevealed_opacity || 100) / 255;
                        } else {
                            wordColor = s.tw_revealed_color || textColor;
                            wordStrokeColor = s.tw_revealed_stroke_color || outlineColor;
                        }
                    }
                    twCharCounter = charEnd + 1;
                }

                if (isMetronome) {
                    if (metroVisible) {
                        wordColor = s.metro_read_color || textColor;
                        wordStrokeColor = s.metro_read_stroke_color || outlineColor;
                    } else {
                        wordColor = s.metro_unread_color || '#808080';
                        wordStrokeColor = s.metro_unread_stroke_color || '#404040';
                        wordOpacity *= (s.metro_unread_opacity || 100) / 255;
                    }
                }

                // ── Word pop random (逐词弹出+随机大小) ──
                let randomPopScale = 1.0;
                if (anim && (isWordPopRandom || isWordPopRandomPulse)) {
                    const unreadOpacity = Math.max(0, Math.min(1, Number(s.word_pop_random_unread_opacity ?? 0.0)));
                    const readOpacity = Math.max(0, Math.min(1, Number(s.word_pop_random_read_opacity ?? 1.0)));
                    if (currentTime < wordStart) {
                        wordOpacity *= unreadOpacity;
                    } else {
                        wordOpacity *= readOpacity;
                    }

                    if (currentTime >= wordStart) {
                        if (isWordPopRandomPulse && typeof anim.computeWordRandomPulseScale === 'function') {
                            randomPopScale = anim.computeWordRandomPulseScale(
                                currentTime, wordStart, wordEnd, wordIdx, segStart,
                                Number(s.word_pop_random_pulse_min_scale ?? 1.08),
                                Number(s.word_pop_random_pulse_max_scale ?? 1.38),
                                Number(s.word_pop_random_pulse_duration ?? 0.22)
                            );
                        } else {
                            randomPopScale = anim.computeWordRandomPopScale(
                                currentTime, wordStart, wordEnd, wordIdx, segStart,
                                Number(s.word_pop_random_min_scale ?? 0.86),
                                Number(s.word_pop_random_max_scale ?? 1.34),
                                Number(s.word_pop_random_duration ?? 0.22)
                            );
                        }
                    }
                }

                // ── Vertical offset for char bounce ──
                let wordY = y;
                if (anim && isCharBounce && wInfo) {
                    const segDur = Math.max(0.001, segEnd - segStart);
                    const bounceOff = anim.computeCharBounceOffset(
                        currentTime, wordCounter - 1,
                        segStart, segDur, wordsInfo.length,
                        cbHeight, cbStagger
                    );
                    wordY = y + bounceOff;
                }

                // ── Bullet reveal alpha ──
                if (isBullet && lineAlpha < 0.999) {
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * lineAlpha;
                }

                // ── Holy glow around text ──
                if (isHolyGlow && holyGlowRadius > 0) {
                    ctx.save();
                    const glowColor = s.holy_glow_color || '#FFFFCC';
                    for (let gr = holyGlowRadius; gr > 0; gr--) {
                        const ga = (80 * holyGlowAlpha * (gr / holyGlowRadius) * 0.5) / 255;
                        ctx.globalAlpha = globalAlpha * ga;
                        ctx.strokeStyle = glowColor;
                        ctx.lineWidth = gr * 2;
                        ctx.lineJoin = 'round';
                        ctx.strokeText(wordStr, currX, wordY);
                    }
                    ctx.restore();
                }

                // ── Render word ──
                ctx.save();
                ctx.globalAlpha = globalAlpha * wordOpacity;

                const wordScale = letterJumpScale * randomPopScale;
                if (wordScale !== 1.0) {
                    ctx.translate(currX, wordY);
                    ctx.scale(wordScale, wordScale);
                    ctx.translate(-currX, -wordY);
                }
                if (lineScale !== 1.0) {
                    ctx.translate(currX, wordY);
                    ctx.scale(lineScale, lineScale);
                    ctx.translate(-currX, -wordY);
                }

                this._drawWord(ctx, wordStr, currX, wordY, wordColor,
                    useStroke && !s.stroke_expand_enabled, wordStrokeColor, borderW, outlineAlpha,
                    shadowBlur, shadowOffX, shadowOffY, shadowColor, shadowAlpha, letterSpacing);
                ctx.restore();

                // Bullet restore
                if (isBullet && lineAlpha < 0.999) ctx.restore();

                // Underline
                if ((isHighlight && useUnderline) || (useUnderline && s.underline_all)) {
                    ctx.save();
                    ctx.globalAlpha = globalAlpha * lineAlpha;
                    ctx.strokeStyle = underlineColor;
                    ctx.lineWidth = Math.max(2, fontSize * 0.04) * lineScale;
                    ctx.beginPath();
                    const underlineY = wordY + lineHScaled + 2;
                    ctx.moveTo(currX, underlineY);
                    ctx.lineTo(currX + wordW * lineScale, underlineY);
                    ctx.stroke();
                    ctx.restore();
                }

                let advanceScale = lineScale;
                if (isWordPopRandom && currentTime >= wordStart) {
                    const finalRandScale = this._computeWordRandomFinalScale(
                        wordIdx, segStart, wordStart,
                        Number(s.word_pop_random_min_scale ?? 0.86),
                        Number(s.word_pop_random_max_scale ?? 1.34)
                    );
                    advanceScale *= finalRandScale;
                }
                currX += (wordW + spaceW) * advanceScale;
            }
        }

        // ── Blur → Sharp post-process ──
        if (blurRadius > 0) {
            // Canvas filter-based blur simulation
            ctx.save();
            ctx.globalAlpha = globalAlpha * 0.6;
            ctx.filter = `blur(${blurRadius}px)`;
            // Re-draw text with blur (simplified)
            for (let i = 0; i < visibleLines.length; i++) {
                const line = visibleLines[i];
                const lineW = lineWidths[i];
                const xS = cx - lineW / 2;
                const yS = startY + i * lineStep;
                ctx.fillStyle = textColor;
                ctx.fillText(line, xS, yS);
            }
            ctx.filter = 'none';
            ctx.restore();
        }

        // Restore advanced textbox clip
        if (advEnabled) ctx.restore();

        ctx.restore();
    }

    // ─── Advanced textbox background ───
    _drawAdvTextboxBg(ctx, s, x, y, w, h) {
        ctx.save();
        const bgColor = s.adv_bg_color || '#000000';
        const bgAlpha = (s.adv_bg_opacity || 150) / 255;
        ctx.globalAlpha = ctx.globalAlpha * bgAlpha;
        const rad = s.adv_bg_radius || 8;
        const ox = s.adv_bg_offset_x || 0;
        const oy = s.adv_bg_offset_y || 0;
        const bw = s.adv_bg_w || w;
        const bh = s.adv_bg_h || h;

        if (s.adv_bg_gradient_enabled) {
            const colors = typeof s.adv_bg_gradient_colors === 'string'
                ? s.adv_bg_gradient_colors.split(',').map(c => c.trim())
                : (Array.isArray(s.adv_bg_gradient_colors) ? s.adv_bg_gradient_colors : [bgColor, '#333']);
            if (colors.length >= 2) {
                const gradType = s.adv_bg_gradient_type || 'linear_h';
                let grad;
                if (gradType === 'linear_v') {
                    grad = ctx.createLinearGradient(x + ox, y + oy, x + ox, y + oy + bh);
                } else if (gradType === 'center') {
                    grad = ctx.createRadialGradient(x + ox + bw / 2, y + oy + bh / 2, 0,
                        x + ox + bw / 2, y + oy + bh / 2, Math.max(bw, bh) / 2);
                } else {
                    grad = ctx.createLinearGradient(x + ox, y + oy, x + ox + bw, y + oy);
                }
                colors.forEach((c, i) => grad.addColorStop(i / Math.max(1, colors.length - 1), c));
                ctx.fillStyle = grad;
            } else {
                ctx.fillStyle = bgColor;
            }
        } else {
            ctx.fillStyle = bgColor;
        }

        this._roundRect(ctx, x + ox, y + oy, bw, bh, rad);
        ctx.fill();

        if (s.adv_bg_gradient_highlight) {
            const hlGrad = ctx.createLinearGradient(x + ox, y + oy, x + ox, y + oy + bh * 0.3);
            hlGrad.addColorStop(0, 'rgba(255,255,255,0.24)');
            hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = hlGrad;
            this._roundRect(ctx, x + ox, y + oy, bw, bh, rad);
            ctx.fill();
        }
        ctx.restore();
    }

    // ─── Multi-layer stroke expand ───
    _renderStrokeExpand(ctx, s, lines, lineWidths, cx, advEnabled, advAlign, advX, advW,
        cy, totalH, lineStep, fontStr, fontSize, letterSpacing, advY, advH) {
        const seLayers = parseInt(s.stroke_expand_layers) || 3;
        const seStep = parseFloat(s.stroke_expand_step) || 4;
        const seFeather = parseFloat(s.stroke_expand_feather) || 8;
        const seColorsStr = typeof s.stroke_expand_colors === 'string'
            ? s.stroke_expand_colors : (Array.isArray(s.stroke_expand_colors) ? s.stroke_expand_colors.join(',') : '#FF0000,#00FF00,#0000FF');
        const seColors = seColorsStr.split(',').map(c => c.trim()).filter(Boolean);
        const seLayerWidths = s.stroke_expand_layer_widths || [];
        const seLayerFeathers = s.stroke_expand_layer_feathers || [];

        let startY;
        if (advEnabled) {
            const advValign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (advValign === 'top') {
                startY = advY;
            } else if (advValign === 'bottom') {
                startY = advY + advH - totalH;
            } else {
                startY = cy - totalH / 2;
            }
        } else {
            startY = cy - totalH / 2;
        }

        ctx.save();
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        // Draw layers from outermost to innermost
        for (let li = seLayers - 1; li >= 0; li--) {
            const lw = li < seLayerWidths.length ? parseFloat(seLayerWidths[li]) : seStep * (li + 1);
            const lf = li < seLayerFeathers.length ? parseFloat(seLayerFeathers[li]) : seFeather;
            const color = li < seColors.length ? seColors[li] : seColors[seColors.length - 1] || '#000000';

            if (lf > 0) {
                // Feathered stroke: multiple passes with decreasing alpha
                const featherSteps = Math.min(8, Math.max(3, Math.floor(lf)));
                for (let fi = featherSteps; fi >= 0; fi--) {
                    const t = fi / featherSteps;
                    const expandW = lw + lf * t;
                    const alpha = Math.exp(-((t * 2.5) ** 2));
                    ctx.save();
                    ctx.globalAlpha = ctx.globalAlpha * alpha * 0.4;
                    ctx.strokeStyle = color;
                    ctx.lineWidth = expandW * 2;
                    ctx.lineJoin = 'round';
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const lineW = lineWidths[i];
                        let xS;
                        if (advEnabled && advAlign === 'left') xS = advX;
                        else if (advEnabled && advAlign === 'right') xS = advX + advW - lineW;
                        else xS = cx - lineW / 2;
                        const yS = startY + i * lineStep;
                        ctx.strokeText(line, xS, yS);
                    }
                    ctx.restore();
                }
            } else {
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = lw * 2;
                ctx.lineJoin = 'round';
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const lineW = lineWidths[i];
                    let xS;
                    if (advEnabled && advAlign === 'left') xS = advX;
                    else if (advEnabled && advAlign === 'right') xS = advX + advW - lineW;
                    else xS = cx - lineW / 2;
                    const yS = startY + i * lineStep;
                    ctx.strokeText(line, xS, yS);
                }
                ctx.restore();
            }
        }
        ctx.restore();
    }

    // ─── Helper: draw word with optional letter spacing ───
    _drawWord(ctx, text, x, y, fillColor,
        useStroke, strokeColor, strokeWidth, strokeAlpha,
        shadowBlur, shadowOffX, shadowOffY, shadowColor, shadowAlpha, letterSpacing = 0) {

        // Shadow
        if (shadowBlur > 0 || shadowOffX !== 0 || shadowOffY !== 0) {
            ctx.save();
            ctx.globalAlpha *= shadowAlpha;
            ctx.fillStyle = shadowColor;
            // 使用 Canvas 原生阴影 API, 产生真正的高斯模糊
            if (shadowBlur > 0) {
                ctx.shadowColor = shadowColor;
                ctx.shadowBlur = shadowBlur;
                ctx.shadowOffsetX = shadowOffX;
                ctx.shadowOffsetY = shadowOffY;
            }
            if (letterSpacing > 0) {
                this._fillTextSpaced(ctx, text, x + (shadowBlur > 0 ? 0 : shadowOffX), y + (shadowBlur > 0 ? 0 : shadowOffY), letterSpacing);
            } else {
                ctx.fillText(text, x + (shadowBlur > 0 ? 0 : shadowOffX), y + (shadowBlur > 0 ? 0 : shadowOffY));
            }
            ctx.restore();
        }

        // Stroke
        if (useStroke && strokeWidth > 0) {
            ctx.save();
            ctx.globalAlpha *= strokeAlpha;
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = strokeWidth * 2;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            if (letterSpacing > 0) {
                this._strokeTextSpaced(ctx, text, x, y, letterSpacing);
            } else {
                ctx.strokeText(text, x, y);
            }
            ctx.restore();
        }

        // Fill
        ctx.fillStyle = fillColor;
        if (letterSpacing > 0) {
            this._fillTextSpaced(ctx, text, x, y, letterSpacing);
        } else {
            ctx.fillText(text, x, y);
        }
    }

    // ─── Letter-spaced text rendering ───
    _fillTextSpaced(ctx, text, x, y, spacing) {
        let cx = x;
        for (const ch of text) {
            ctx.fillText(ch, cx, y);
            cx += ctx.measureText(ch).width + spacing;
        }
    }

    _strokeTextSpaced(ctx, text, x, y, spacing) {
        let cx = x;
        for (const ch of text) {
            ctx.strokeText(ch, cx, y);
            cx += ctx.measureText(ch).width + spacing;
        }
    }

    _measureTextWithSpacing(ctx, text, spacing = 0) {
        if (!spacing || spacing === 0) return ctx.measureText(text).width;
        let w = 0;
        for (const ch of text) {
            w += ctx.measureText(ch).width + spacing;
        }
        return Math.max(0, w - spacing); // remove last spacing
    }

    /**
     * 测量整行宽度：每个单词内部使用 letterSpacing，单词之间使用 wordSpacing
     * 区别于 _measureTextWithSpacing 对所有字符统一加 spacing
     */
    _measureLineWithSpacing(ctx, line, letterSpacing = 0, wordSpacing = 0) {
        if (!letterSpacing && !wordSpacing) return ctx.measureText(line).width;
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length === 0) return 0;
        let total = 0;
        for (let i = 0; i < words.length; i++) {
            total += this._measureTextWithSpacing(ctx, words[i], letterSpacing);
            if (i < words.length - 1) {
                total += ctx.measureText(' ').width + wordSpacing;
            }
        }
        return total;
    }

    _seededRand(seed) {
        const raw = (Math.sin(seed) * 43758.5453) % 1;
        return raw < 0 ? raw + 1 : raw;
    }

    _computeWordRandomFinalScale(wordIdx, segStart, wordStart, minScale = 0.86, maxScale = 1.34) {
        const key = (Number(wordIdx) + 1.0) * 12.9898 + Number(segStart) * 78.233 + Number(wordStart) * 37.719;
        const rand = this._seededRand(key);
        const minS = Number(minScale) || 0.86;
        const maxS = Math.max(minS, Number(maxScale) || 1.34);
        return minS + (maxS - minS) * rand;
    }

    _buildWordPopGroups(totalWords, segStart, segEnd, wordsInfo = []) {
        const count = Math.max(0, parseInt(totalWords, 10) || 0);
        const starts = new Array(count);
        const ends = new Array(count);
        if (count <= 0) return { starts, ends };

        const segDur = Math.max(0.001, segEnd - segStart);
        const hasWordTimes = Array.isArray(wordsInfo) && wordsInfo.length >= count;

        let i = 0;
        while (i < count) {
            const seed = (i + 1) * 17.17 + segStart * 31.13 + segEnd * 7.19;
            const r = this._seededRand(seed);
            let groupSize = 1;
            if (r > 0.82) groupSize = 3;
            else if (r > 0.48) groupSize = 2;
            const startIdx = i;
            const endIdx = Math.min(count - 1, i + groupSize - 1);

            let gStart = segStart + segDur * (startIdx / count);
            let gEnd = segStart + segDur * ((endIdx + 1) / count);
            if (hasWordTimes) {
                const ws = wordsInfo[startIdx];
                const we = wordsInfo[endIdx];
                const tStart = ws && Number.isFinite(ws.start) ? ws.start : gStart;
                const tEnd = we && Number.isFinite(we.end) ? we.end : gEnd;
                gStart = tStart;
                gEnd = Math.max(gStart + 0.04, tEnd);
            }

            for (let j = startIdx; j <= endIdx; j++) {
                starts[j] = gStart;
                ends[j] = gEnd;
            }
            i = endIdx + 1;
        }
        return { starts, ends };
    }

    // ─── Wrap tokens by pixel width ───
    _wrapTokensByPixelWidth(words, maxWidth, joiner = ' ', letterSpacing = 0, wordSpacing = 0) {
        const ctx = this.ctx;
        const lines = [];
        let currentLine = '';
        let currentLineW = 0;
        const joinerW = ctx.measureText(joiner).width + wordSpacing;
        for (const word of words) {
            const wordW = this._measureTextWithSpacing(ctx, word, letterSpacing);
            const testW = currentLine ? currentLineW + joinerW + wordW : wordW;
            if (testW > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
                currentLineW = wordW;
            } else {
                currentLine = currentLine ? currentLine + joiner + word : word;
                currentLineW = testW;
            }
        }
        if (currentLine) lines.push(currentLine);
        return lines;
    }

    // ─── Round rect ───
    _roundRect(ctx, x, y, w, h, r) {
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

    // ─── Parse color ───
    _parseColor(colorStr) {
        if (!colorStr) return [0, 0, 0];
        if (colorStr.startsWith('#')) {
            const hex = colorStr.slice(1);
            if (hex.length === 3) {
                return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)];
            }
            return [parseInt(hex.substr(0, 2), 16), parseInt(hex.substr(2, 2), 16), parseInt(hex.substr(4, 2), 16)];
        }
        return [0, 0, 0];
    }

    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    renderFrameWithSubtitle(videoEl, style, segment) {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.drawImage(videoEl, 0, 0, w, h);
        this.renderSubtitle(style, segment, videoEl.currentTime, w, h);
    }

    // ═══════════════════════════════════════════════
    // 富文本渲染循环 (Phase 4)
    // ═══════════════════════════════════════════════

    _renderRichTextSubtitle(style, segment, currentTime, videoW, videoH) {
        if (!segment) return;
        const ctx = this.ctx;
        const s = {
            ...(style || {}),
            ...(segment.style_override || segment.subtitle_style || {})
        };
        const text = segment.edited_text || segment.text || '';
        
        // 1. 基础配置提取
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = (typeof _resolveGenericFallback === 'function') ? _resolveGenericFallback(fontFamily) : 'sans-serif';
        const fw = (typeof _resolveFontWeight === 'function') ? _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400) : 700;
        
        const baseStyleConfig = {
            fontsize: s.fontsize || 74,
            color: s.color || s.color_text || '#FFFFFF',
            bold: (fw >= 600),
            font_weight: fw,
            italic: !!s.italic
        };
        const letterSpacing = s.letter_spacing || 0;
        const wordSpacing = s.word_spacing || 0;

        // 高级文本框/布局
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);

        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 90));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        // 2. 将纯文本切割为样式片段
        const rawChunks = ReelsRichText.splitByRanges(text, segment.styled_ranges, baseStyleConfig);
        
        // 词级细化：为了支持换行，我们将每个 rawChunk 中的文字按空格拆成细粒度的 token (兼顾样式)
        const tokens = [];
        for (const chunk of rawChunks) {
            const regex = /([^ \n]+|[ \n])/g;
            let match;
            while ((match = regex.exec(chunk.text)) !== null) {
                // 如果是换行，我们专门标记
                tokens.push({ text: match[0], style: chunk.style, isNewline: match[0] === '\n' });
            }
        }

        // 辅助：获取段落的完整 ctx.font
        const _getFontStr = (st) => {
            const b = Math.max(100, Math.min(900, parseInt(st.font_weight || (st.bold ? 700 : 400), 10) || 400));
            const sz = st.fontsize || baseStyleConfig.fontsize;
            return `${st.italic ? 'italic ' : ''}${b} ${sz}px "${fontFamily}", ${fallbackFamily}`;
        };

        // 3. 换行计算 & 尺寸测量
        const lines = []; // 当前由 { tokens, metrics } 组成
        let currentLine = { tokens: [], w: 0, maxAscent: 0, maxDescent: 0, maxFs: 0 };
        
        for (const tok of tokens) {
            if (tok.isNewline) {
                lines.push(currentLine);
                currentLine = { tokens: [], w: 0, maxAscent: 0, maxDescent: 0, maxFs: 0 };
                continue;
            }

            ctx.font = _getFontStr(tok.style);
            const isSpace = tok.text === ' ';
            const mw = isSpace
                ? ctx.measureText(' ').width + wordSpacing
                : this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
            // 近似高度获取，canvas 原生 TextMetrics 可给准确高度， fallback用fontSize
            let asc = tok.style.fontsize * 0.8; 
            let desc = tok.style.fontsize * 0.2;
            const metrics = ctx.measureText(tok.text);
            if (metrics.actualBoundingBoxAscent !== undefined) {
                asc = metrics.actualBoundingBoxAscent;
                desc = metrics.actualBoundingBoxDescent;
            }

            // 检查宽度是否超过 maxWidth
            if (currentLine.w + mw > maxWidth && currentLine.tokens.length > 0 && tok.text !== ' ') {
                // 折行前，剔除行尾空格
                if (currentLine.tokens.length > 0 && currentLine.tokens[currentLine.tokens.length-1].text === ' ') {
                   const popSpace = currentLine.tokens.pop();
                   ctx.font = _getFontStr(popSpace.style);
                   currentLine.w -= ctx.measureText(' ').width + wordSpacing;
                }

                lines.push(currentLine);
                currentLine = { tokens: [tok], w: mw, maxAscent: asc, maxDescent: desc, maxFs: tok.style.fontsize };
            } else {
                currentLine.tokens.push(tok);
                currentLine.w += mw;
                currentLine.maxAscent = Math.max(currentLine.maxAscent, asc);
                currentLine.maxDescent = Math.max(currentLine.maxDescent, desc);
                currentLine.maxFs = Math.max(currentLine.maxFs, tok.style.fontsize);
            }
        }
        if (currentLine.tokens.length > 0 || tokens.length === 0) {
            lines.push(currentLine);
        }

        // 4. 定位与边距计算
        const maxLineW = Math.max(...lines.map(l => l.w));
        const lineSpacing = s.line_spacing || 0;
        let totalH = 0;
        lines.forEach(l => {
            // fallback 高度
            if (l.maxAscent === 0) { l.maxFs = baseStyleConfig.fontsize; l.maxAscent = l.maxFs * 0.8; l.maxDescent = l.maxFs * 0.2; }
            l.lineH = l.maxAscent + l.maxDescent;
            totalH += l.lineH + lineSpacing;
        });
        totalH -= lineSpacing > 0 ? lineSpacing : 0; 
        if (totalH < 0) totalH = 0;

        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1 ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1 ? s.pos_y * videoH : (s.pos_y || videoH * 0.85);
        }

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 12));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 12));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 8));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 8));

        const borderW = s.border_width || 3;
        const effectivePadLeft = padLeft + borderW;
        const effectivePadRight = padRight + borderW;
        const effectivePadTop = padTop + borderW;
        const effectivePadBottom = padBottom + borderW;

        ctx.save();
        const rotation = s.rotation || 0;
        if (rotation !== 0) {
            ctx.translate(cx, cy);
            ctx.rotate(rotation * Math.PI / 180);
            ctx.translate(-cx, -cy);
        }

        // 5. 绘制基础背景框
        const richBoxOpacity = s.box_opacity ?? s.opacity_bg ?? (s.use_box ? 150 : 0);
        if (richBoxOpacity > 0) {
            let bX, bY, bW, bH;
            if (advEnabled) {
                bX = advX; bY = advY; bW = advW; bH = advH;
            } else {
                bX = cx - maxLineW / 2 - effectivePadLeft;
                bY = cy - totalH / 2 - effectivePadTop;
                bW = maxLineW + effectivePadLeft + effectivePadRight;
                bH = totalH + effectivePadTop + effectivePadBottom;
            }

            ctx.save();
            ctx.globalAlpha = Math.min(1, richBoxOpacity / 255);
            ctx.fillStyle = s.bg_color || s.color_bg || '#000000';

            const r = s.box_radius || 0;
            if (r > 0) {
                this._roundRect(ctx, bX, bY, bW, bH, r);
                ctx.fill();
            } else {
                ctx.fillRect(bX, bY, bW, bH);
            }
            ctx.restore();
        }

        // 6. 全局属性（透明度、描边、阴影）
        const textAlpha = Math.min(1, Math.max(0, s.opacity !== undefined ? s.opacity / 255 : 1));
        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#000000';
        const outlineAlpha = s.opacity_outline !== undefined ? s.opacity_outline / 255 : 1;
        // borderW already declared above (line ~1521)
        
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_off_x || 0;
        const shadowOffY = s.shadow_off_y || 0;
        const shadowColor = s.shadow_color || '#000000';
        const shadowAlpha = s.shadow_opacity !== undefined ? s.shadow_opacity / 255 : 0;

        ctx.globalAlpha = ctx.globalAlpha * textAlpha;

        // 7. 处理多行逐行绘制
        let startY;
        if (advEnabled) {
            const valign = (s.advanced_textbox_valign || 'center').toLowerCase();
            if (valign === 'top') startY = advY;
            else if (valign === 'bottom') startY = advY + advH - totalH;
            else startY = cy - totalH / 2;
        } else {
            startY = cy - totalH / 2;
        }

        let currY = startY;
        for (const line of lines) {
            // align
            let renderX = 0;
            if (advEnabled && advAlign === 'left') renderX = advX;
            else if (advEnabled && advAlign === 'right') renderX = advX + advW - line.w;
            else renderX = cx - line.w / 2;

            // 保持 baseline 统一，以这一行最大 ascent 为基线起点
            const baselineY = currY + line.maxAscent;

            for (const tok of line.tokens) {
                if (tok.text === ' ') {
                    ctx.font = _getFontStr(tok.style);
                    renderX += ctx.measureText(' ').width + wordSpacing;
                    continue;
                }

                ctx.font = _getFontStr(tok.style);
                
                // --- 背景高亮（独立的单个文本块高亮处理，如果有设定的独立背景色） ---
                if (tok.style.bg_color) {
                    ctx.save();
                    ctx.fillStyle = tok.style.bg_color;
                    ctx.globalAlpha = textAlpha * (tok.style.bg_opacity !== undefined ? tok.style.bg_opacity : 0.8);
                    const bw = this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
                    const fs = tok.style.fontsize || baseStyleConfig.fontsize;
                    ctx.fillRect(renderX - 2, baselineY - fs * 0.8 - 2, bw + 4, fs + 4);
                    ctx.restore();
                }

                // --- 绘制阴影 ---
                if (shadowAlpha > 0 && (shadowBlur > 0 || shadowOffX !== 0 || shadowOffY !== 0)) {
                    ctx.save();
                    ctx.globalAlpha = textAlpha * shadowAlpha;
                    ctx.fillStyle = shadowColor;
                    if (shadowBlur > 0) {
                        ctx.shadowColor = shadowColor;
                        ctx.shadowBlur = shadowBlur;
                        ctx.shadowOffsetX = shadowOffX;
                        ctx.shadowOffsetY = shadowOffY;
                    }
                    ctx.textBaseline = 'alphabetic';
                    if (letterSpacing > 0) {
                        this._fillTextSpaced(ctx, tok.text, renderX + (shadowBlur > 0 ? 0 : shadowOffX), baselineY + (shadowBlur > 0 ? 0 : shadowOffY), letterSpacing);
                    } else {
                        ctx.fillText(tok.text, renderX + (shadowBlur > 0 ? 0 : shadowOffX), baselineY + (shadowBlur > 0 ? 0 : shadowOffY));
                    }
                    ctx.restore();
                }

                // --- 绘制描边 ---
                const tokStrokeC = tok.style.color_outline || outlineColor;
                const tokStrokeW = tok.style.border_width !== undefined ? tok.style.border_width : borderW;
                if (useStroke && tokStrokeW > 0) {
                    ctx.save();
                    ctx.globalAlpha = textAlpha * outlineAlpha;
                    ctx.strokeStyle = tokStrokeC;
                    ctx.lineWidth = tokStrokeW * 2;
                    ctx.lineJoin = 'round';
                    ctx.miterLimit = 2;
                    ctx.textBaseline = 'alphabetic';
                    
                    if (letterSpacing > 0) {
                        this._strokeTextSpaced(ctx, tok.text, renderX, baselineY, letterSpacing);
                    } else {
                        ctx.strokeText(tok.text, renderX, baselineY);
                    }
                    ctx.restore();
                }

                // --- 绘制实体文字 ---
                ctx.save();
                ctx.fillStyle = tok.style.color || baseStyleConfig.color;
                ctx.textBaseline = 'alphabetic';
                if (letterSpacing > 0) {
                    this._fillTextSpaced(ctx, tok.text, renderX, baselineY, letterSpacing);
                } else {
                    ctx.fillText(tok.text, renderX, baselineY);
                }
                
                renderX += this._measureTextWithSpacing(ctx, tok.text, letterSpacing);
                ctx.restore();
            }

            currY += line.lineH + lineSpacing;
        }

        ctx.restore();
    }

    _renderFullpageTypewriter(s, currentTime, videoW, videoH) {
        const ctx = this.ctx;
        const segments = this._contextSegments || [];
        if (segments.length === 0) return;
        const firstSegStyle = segments[0] ? { ...(segments[0].style_override || segments[0].subtitle_style || {}) } : {};

        // 1. Gather all tokens with their target times
        const allTokens = [];
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            const text = seg.edited_text || seg.text || '';
            if (!text.trim()) continue;

            const segStart = seg.start || 0;
            const segEnd = seg.end || 0;
            const segDur = Math.max(0.001, segEnd - segStart);

            const segTokens = [];
            if (s.fullpage_typewriter_reveal_type === 'char') {
                // Character-by-character
                for (let j = 0; j < text.length; j++) {
                    segTokens.push({
                        text: text[j],
                        start: segStart + segDur * (j / text.length),
                        end: segStart + segDur * ((j + 1) / text.length)
                    });
                }
            } else {
                // Word-by-word
                if (seg.words && seg.words.length > 0) {
                    for (const w of seg.words) {
                        segTokens.push({
                            text: w.word,
                            start: w.start,
                            end: w.end
                        });
                    }
                } else {
                    const rawWords = text.split(/(\s+)/).filter(Boolean);
                    let charCount = 0;
                    const totalChars = text.length || 1;
                    for (const w of rawWords) {
                        const wLen = w.length;
                        segTokens.push({
                            text: w,
                            start: segStart + segDur * (charCount / totalChars),
                            end: segStart + segDur * ((charCount + wLen) / totalChars)
                        });
                        charCount += wLen;
                    }
                }
            }

            // Insert spacing between segments if needed
            if (i > 0 && allTokens.length > 0 && segTokens.length > 0) {
                const lastTok = allTokens[allTokens.length - 1];
                const firstTok = segTokens[0];
                if (!/\s/.test(lastTok.text[lastTok.text.length - 1]) && !/\s/.test(firstTok.text[0])) {
                    allTokens.push({
                        text: ' ',
                        start: lastTok.end,
                        end: firstTok.start
                    });
                }
            }
            allTokens.push(...segTokens);
        }

        if (allTokens.length === 0) return;

        // 2. Set font properties
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const fontSize = s.fontsize || 58;
        const italic = s.italic || false;
        const letterSpacing = s.letter_spacing || 0;
        const wordSpacing = s.word_spacing || 0;
        const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${fontSize}px "${fontFamily}", ${fallbackFamily}`;
        ctx.font = fontStr;
        ctx.textBaseline = 'top';

        const getLineFontStr = (li) => {
            let fSize = fontSize;
            let fWeight = fontWeight;
            let fFamily = fontFamily;
            let fItalic = italic;
            
            if (li === 0) {
                if (s.fullpage_typewriter_first_line_scale) {
                    fSize = fontSize * parseFloat(s.fullpage_typewriter_first_line_scale);
                } else if (firstSegStyle.fontsize) {
                    fSize = firstSegStyle.fontsize;
                }
                
                if (s.fullpage_typewriter_first_line_bold !== undefined) {
                    fWeight = s.fullpage_typewriter_first_line_bold ? 900 : fontWeight;
                } else if (firstSegStyle.bold !== undefined) {
                    fWeight = _resolveFontWeight(firstSegStyle.font_weight, firstSegStyle.bold !== false ? 700 : 400);
                }
                
                if (firstSegStyle.font_family) {
                    fFamily = firstSegStyle.font_family;
                }
                if (firstSegStyle.italic !== undefined) {
                    fItalic = firstSegStyle.italic;
                }
            }
            
            const fallbackFam = _resolveGenericFallback(fFamily);
            return `${fItalic ? 'italic ' : ''}${fWeight} ${fSize}px "${fFamily}", ${fallbackFam}`;
        };

        const getLineHeight = (li) => {
            let fSize = fontSize;
            if (li === 0) {
                if (s.fullpage_typewriter_first_line_scale) {
                    fSize = fontSize * parseFloat(s.fullpage_typewriter_first_line_scale);
                } else if (firstSegStyle.fontsize) {
                    fSize = firstSegStyle.fontsize;
                }
            }
            return fSize * 1.2;
        };

        // 3. Line wrapping
        const advEnabled = !!s.advanced_textbox_enabled;
        const advAlign = (s.advanced_textbox_align || s.adv_text_align || 'center').toLowerCase();
        const advX = parseFloat(s.advanced_textbox_x) || 0;
        const advY = parseFloat(s.advanced_textbox_y) || 0;
        const advW = Math.max(80, parseFloat(s.advanced_textbox_w) || videoW * 0.8);
        const advH = Math.max(40, parseFloat(s.advanced_textbox_h) || 200);

        let maxWidth;
        if (advEnabled) {
            maxWidth = Math.max(1, advW);
        } else {
            const wrapPercent = Math.max(20, Math.min(120, s.wrap_width_percent || 85));
            maxWidth = Math.max(200, Math.floor(videoW * (wrapPercent / 100)));
        }

        // Group tokens into wrapping units: English words, spaces, or individual CJK characters
        const wrappingTokens = [];
        let currentWrapTok = null;
        const isCjk = (char) => /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(char);

        for (const tok of allTokens) {
            const hasNewline = tok.text.includes('\n');
            const isSpace = /^\s+$/.test(tok.text);
            const isCjkChar = isCjk(tok.text);
            const isEnglishWordChar = !isSpace && !isCjkChar && !hasNewline;

            if (isEnglishWordChar) {
                if (currentWrapTok && currentWrapTok.isWord) {
                    currentWrapTok.text += tok.text;
                    currentWrapTok.tokens.push(tok);
                } else {
                    if (currentWrapTok) {
                        wrappingTokens.push(currentWrapTok);
                    }
                    currentWrapTok = {
                        text: tok.text,
                        isWord: true,
                        tokens: [tok]
                    };
                }
            } else {
                if (currentWrapTok) {
                    wrappingTokens.push(currentWrapTok);
                }
                currentWrapTok = {
                    text: tok.text,
                    isWord: false,
                    tokens: [tok]
                };
            }
        }
        if (currentWrapTok) {
            wrappingTokens.push(currentWrapTok);
        }

        const wrapLines = [];
        let currentWrapLine = [];
        let currentWrapLineW = 0;

        for (const wrapTok of wrappingTokens) {
            if (wrapTok.text.includes('\n')) {
                const parts = wrapTok.text.split('\n');
                for (let p = 0; p < parts.length; p++) {
                    if (p > 0) {
                        wrapLines.push(currentWrapLine);
                        currentWrapLine = [];
                        currentWrapLineW = 0;
                    }
                    const partText = parts[p];
                    if (partText) {
                        const partTokens = wrapTok.tokens.map(tok => ({ ...tok, text: partText }));
                        const partW = this._measureTextWithSpacing(ctx, partText, letterSpacing);
                        currentWrapLine.push({
                            text: partText,
                            isWord: wrapTok.isWord,
                            tokens: partTokens
                        });
                        currentWrapLineW += partW;
                    }
                }
                continue;
            }

            const wrapTokW = this._measureTextWithSpacing(ctx, wrapTok.text, letterSpacing);
            const isWhitespace = /^\s+$/.test(wrapTok.text);

            if (currentWrapLineW + wrapTokW > maxWidth && currentWrapLine.length > 0 && !isWhitespace) {
                wrapLines.push(currentWrapLine);
                currentWrapLine = [wrapTok];
                currentWrapLineW = wrapTokW;
            } else {
                currentWrapLine.push(wrapTok);
                currentWrapLineW += wrapTokW;
            }
        }
        if (currentWrapLine.length > 0) {
            wrapLines.push(currentWrapLine);
        }

        const lines = [];
        for (const wrapLine of wrapLines) {
            const lineTokens = [];
            for (const wrapTok of wrapLine) {
                lineTokens.push(...wrapTok.tokens);
            }
            lines.push(lineTokens);
        }

        if (lines.length === 0) return;

        // Limit lines if advanced textbox
        let visibleLines = lines;
        if (advEnabled) {
            const firstLineH = getLineHeight(0);
            const lineSpacing = s.line_spacing || 8;
            let currentAccumH = firstLineH;
            let maxVisLines = 1;
            for (let li = 1; li < lines.length; li++) {
                const h = getLineHeight(li) + lineSpacing;
                if (currentAccumH + h <= advH) {
                    currentAccumH += h;
                    maxVisLines++;
                } else {
                    break;
                }
            }
            visibleLines = lines.slice(0, maxVisLines);
        }

        // Measure actual widths of all lines using their specific font size/weight
        const measureTokens = (tokens, li) => {
            ctx.font = getLineFontStr(li);
            let total = 0;
            for (let i = 0; i < tokens.length; i++) {
                total += this._measureTextWithSpacing(ctx, tokens[i].text, letterSpacing);
            }
            return total;
        };

        const lineWidths = visibleLines.map((line, li) => measureTokens(line, li));
        let maxLineW = 0;
        for (const w of lineWidths) maxLineW = Math.max(maxLineW, w);

        const lineSpacing = s.line_spacing || 8;
        let totalH = 0;
        for (let li = 0; li < visibleLines.length; li++) {
            totalH += getLineHeight(li);
        }
        totalH += (visibleLines.length - 1) * lineSpacing;

        // Position calculation
        let cx, cy;
        if (advEnabled) {
            cx = advX + advW / 2;
            cy = advY + advH / 2;
        } else {
            cx = typeof s.pos_x === 'number' && s.pos_x <= 1 ? s.pos_x * videoW : (s.pos_x || videoW / 2);
            cy = typeof s.pos_y === 'number' && s.pos_y <= 1 ? s.pos_y * videoH : (s.pos_y || videoH * 0.5);
        }

        const parsePadding = (val, fallback) => {
            if (val === undefined || val === null || val === '') return fallback;
            const parsed = parseFloat(val);
            return Number.isFinite(parsed) ? parsed : fallback;
        };

        const padLeft = parsePadding(s.box_padding_left, parsePadding(s.box_padding_x, 24));
        const padRight = parsePadding(s.box_padding_right, parsePadding(s.box_padding_x, 24));
        const padTop = parsePadding(s.box_padding_top, parsePadding(s.box_padding_y, 20));
        const padBottom = parsePadding(s.box_padding_bottom, parsePadding(s.box_padding_y, 20));

        let rectX, rectY, rectW, rectH;
        if (advEnabled) {
            rectX = advX; rectY = advY; rectW = advW; rectH = advH;
        } else {
            rectX = cx - maxLineW / 2 - padLeft;
            rectY = cy - totalH / 2 - padTop;
            rectW = maxLineW + padLeft + padRight;
            rectH = totalH + padTop + padBottom;
        }

        ctx.save();

        // 4. Background box rendering
        if (s.use_box) {
            ctx.save();
            const bgColor = s.color_bg || '#000000';
            const bgAlpha = (s.opacity_bg || 180) / 255;
            ctx.globalAlpha = bgAlpha;
            const rad = s.box_radius || 12;

            ctx.beginPath();
            let r = Math.min(rad, rectW / 2, rectH / 2);
            ctx.moveTo(rectX + r, rectY);
            ctx.lineTo(rectX + rectW - r, rectY);
            ctx.quadraticCurveTo(rectX + rectW, rectY, rectX + rectW, rectY + r);
            ctx.lineTo(rectX + rectW, rectY + rectH - r);
            ctx.quadraticCurveTo(rectX + rectW, rectY + rectH, rectX + rectW - r, rectY + rectH);
            ctx.lineTo(rectX + r, rectY + rectH);
            ctx.quadraticCurveTo(rectX, rectY + rectH, rectX, rectY + rectH - r);
            ctx.lineTo(rectX, rectY + r);
            ctx.quadraticCurveTo(rectX, rectY, rectX + r, rectY);
            ctx.closePath();

            ctx.fillStyle = bgColor;
            ctx.fill();
            ctx.restore();
        }

        // 5. Draw text character/word by character
        let cursorX = null;
        let cursorY = null;
        const twAlign = (s.fullpage_typewriter_align || 'center').toLowerCase();

        // Initialize cursor position to the start of the first line
        if (visibleLines[0] && visibleLines[0].length > 0) {
            const firstLineW = lineWidths[0];
            if (advEnabled) {
                if (advAlign === 'left') cursorX = advX + padLeft;
                else if (advAlign === 'right') cursorX = advX + advW - padRight - firstLineW;
                else cursorX = advX + advW / 2 - firstLineW / 2;
            } else {
                if (twAlign === 'left') cursorX = cx - maxLineW / 2;
                else if (twAlign === 'right') cursorX = cx + maxLineW / 2 - firstLineW;
                else cursorX = cx - firstLineW / 2;
            }
            cursorY = cy - totalH / 2;
        }

        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#000000';
        const borderW = s.border_width || 3;
        const outlineAlpha = 1.0;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x ?? 0;
        const shadowOffY = s.shadow_offset_y ?? 2;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;

        for (let li = 0; li < visibleLines.length; li++) {
            const lineTokens = visibleLines[li];
            const lineW = lineWidths[li];
            let startX;
            if (advEnabled) {
                if (advAlign === 'left') startX = advX + padLeft;
                else if (advAlign === 'right') startX = advX + advW - padRight - lineW;
                else startX = advX + advW / 2 - lineW / 2;
            } else {
                if (twAlign === 'left') startX = cx - maxLineW / 2;
                else if (twAlign === 'right') startX = cx + maxLineW / 2 - lineW;
                else startX = cx - lineW / 2;
            }

            let currX = startX;
            let y = advEnabled ? advY + padTop : cy - totalH / 2;
            for (let prevLi = 0; prevLi < li; prevLi++) {
                y += getLineHeight(prevLi) + lineSpacing;
            }

            ctx.font = getLineFontStr(li);

            for (const tok of lineTokens) {
                const tokW = this._measureTextWithSpacing(ctx, tok.text, letterSpacing);

                let color, opacity;
                if (currentTime >= tok.end) {
                    color = (li === 0) ? (s.fullpage_typewriter_first_line_color || firstSegStyle.color_text || s.color_text || '#FFFFFF') : (s.color_text || '#FFFFFF');
                    opacity = 1.0;
                } else if (currentTime >= tok.start && currentTime < tok.end) {
                    color = s.color_high || '#FFD700';
                    opacity = 1.0;
                } else {
                    color = (li === 0) ? (s.fullpage_typewriter_first_line_color || firstSegStyle.color_text || s.color_text || '#FFFFFF') : (s.color_text || '#FFFFFF');
                    opacity = s.tw_unrevealed_opacity ?? 0.0;
                }

                if (currentTime >= tok.start) {
                    // Cursor is at the end of the last revealed/typing token
                    cursorX = currX + tokW;
                    cursorY = y;
                }

                if (opacity > 0.001) {
                    ctx.save();
                    ctx.globalAlpha = opacity;
                    this._drawWord(ctx, tok.text, currX, y, color,
                        useStroke && !s.stroke_expand_enabled, outlineColor, borderW, outlineAlpha,
                        shadowBlur, shadowOffX, shadowOffY, shadowColor, shadowAlpha, letterSpacing);
                    ctx.restore();
                }

                currX += tokW;
            }
        }

        // 6. Draw blinking cursor
        if (s.fullpage_typewriter_cursor && cursorX !== null && cursorY !== null) {
            const blink = Math.floor(currentTime * 2) % 2 === 0;
            if (blink) {
                ctx.save();
                ctx.fillStyle = s.fullpage_typewriter_cursor_color || '#FFD700';

                // Find which line the cursor is currently on
                let activeLineIdx = 0;
                for (let li = 0; li < visibleLines.length; li++) {
                    const tokens = visibleLines[li];
                    if (tokens.some(tok => currentTime >= tok.start)) {
                        activeLineIdx = li;
                    }
                }
                ctx.font = getLineFontStr(activeLineIdx);

                const cursorChar = s.fullpage_typewriter_cursor_char || '|';
                ctx.fillText(cursorChar, cursorX, cursorY);
                ctx.restore();
            }
        }

        ctx.restore();
    }

    _getScatterGroups(s, segment, videoW, videoH) {
        const seedVal = parseInt(s.scatter_seed) || 1;
        const minScale = s.scatter_min_scale ?? 0.8;
        const maxScale = s.scatter_max_scale ?? 1.5;
        const minRotate = s.scatter_min_rotate ?? -10;
        const maxRotate = s.scatter_max_rotate ?? 10;
        const key = s.scatter_max_words + '_' + s.scatter_accum_prob + '_' +
                    s.scatter_area_left + '_' + s.scatter_area_right + '_' +
                    s.scatter_area_top + '_' + s.scatter_area_bottom + '_' +
                    seedVal + '_' + minScale + '_' + maxScale + '_' +
                    minRotate + '_' + maxRotate + '_' + videoW + '_' + videoH;

        // Cache groups on the segment object to avoid recalculating every frame (highly optimized!)
        if (segment._scatterGroups && segment._scatterGroupsKey === key) {
            return segment._scatterGroups;
        }

        let words = segment.words;
        if (!words || words.length === 0) {
            const text = segment.edited_text || segment.text || '';
            const rawWords = text.split(/\s+/).filter(Boolean);
            const segStart = segment.start || 0;
            const segEnd = segment.end || 0;
            const dur = Math.max(0.001, segEnd - segStart);
            words = rawWords.map((w, i) => ({
                word: w,
                start: segStart + dur * (i / rawWords.length),
                end: segStart + dur * ((i + 1) / rawWords.length)
            }));
        }

        const maxWords = Math.max(1, parseInt(s.scatter_max_words) || 3);
        const groups = [];
        let i = 0;
        let groupIdx = 0;

        while (i < words.length) {
            const seed = (groupIdx + 1) * 17.31 + (segment.start || 0) * 42.13 + seedVal * 12.37;
            const randVal = this._seededRand(seed);
            const groupSize = Math.floor(randVal * maxWords) + 1;
            const groupWords = words.slice(i, i + groupSize);

            if (groupWords.length === 0) break;

            const gStart = groupWords[0].start;
            const gEnd = groupWords[groupWords.length - 1].end;

            const accumSeed = (groupIdx + 1) * 93.71 + (segment.start || 0) * 153.29 + seedVal * 23.41;
            const rAccum = this._seededRand(accumSeed);
            const accumProb = s.scatter_accum_prob ?? 0.5;
            const shouldAccumulate = rAccum < accumProb;

            const xSeed = (groupIdx + 1) * 29.57 + (segment.start || 0) * 101.37 + seedVal * 34.57;
            const ySeed = (groupIdx + 1) * 43.19 + (segment.start || 0) * 89.23 + seedVal * 45.69;
            const rX = this._seededRand(xSeed);
            const rY = this._seededRand(ySeed);

            const leftLimit = (s.scatter_area_left ?? 15) / 100 * videoW;
            const rightLimit = (s.scatter_area_right ?? 85) / 100 * videoW;
            const topLimit = (s.scatter_area_top ?? 25) / 100 * videoH;
            const bottomLimit = (s.scatter_area_bottom ?? 75) / 100 * videoH;

            const posX = leftLimit + rX * (rightLimit - leftLimit);
            const posY = topLimit + rY * (bottomLimit - topLimit);

            const scaleSeed = (groupIdx + 1) * 13.91 + (segment.start || 0) * 64.81 + seedVal * 56.73;
            const rScale = this._seededRand(scaleSeed);
            const scale = minScale + rScale * (maxScale - minScale);

            const rotateSeed = (groupIdx + 1) * 57.23 + (segment.start || 0) * 111.43 + seedVal * 67.89;
            const rRotate = this._seededRand(rotateSeed);
            const angle = minRotate + rRotate * (maxRotate - minRotate);

            groups.push({
                words: groupWords,
                gStart: gStart,
                gEnd: gEnd,
                shouldAccumulate: shouldAccumulate,
                posX: posX,
                posY: posY,
                scale: scale,
                angle: angle,
                clearTime: gEnd // temporary
            });

            i += groupSize;
            groupIdx++;
        }

        // Post-process to calculate clearTime
        for (let g = 0; g < groups.length; g++) {
            let clearTime = groups[g].gEnd;
            for (let next = g; next < groups.length; next++) {
                clearTime = groups[next].gEnd;
                if (!groups[next].shouldAccumulate) {
                    break;
                }
            }
            groups[g].clearTime = clearTime;
        }

        segment._scatterGroups = groups;
        segment._scatterGroupsKey = key;

        return groups;
    }

    _renderScatterPop(s, segment, currentTime, videoW, videoH) {
        const ctx = this.ctx;
        const groups = this._getScatterGroups(s, segment, videoW, videoH);

        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const italic = s.italic || false;
        const letterSpacing = s.letter_spacing || 0;
        const wordSpacing = s.word_spacing || 0;

        const useStroke = s.use_stroke !== false;
        const outlineColor = s.color_outline || '#000000';
        const borderW = s.border_width || 3;
        const outlineAlpha = 1.0;
        const shadowBlur = s.shadow_blur || 0;
        const shadowOffX = s.shadow_offset_x ?? 0;
        const shadowOffY = s.shadow_offset_y ?? 2;
        const shadowColor = s.color_shadow || '#000000';
        const shadowAlpha = (s.opacity_shadow || 150) / 255;

        for (const group of groups) {
            if (currentTime < group.gStart || currentTime > group.clearTime) {
                continue;
            }

            ctx.save();
            ctx.translate(group.posX, group.posY);
            ctx.rotate(group.angle * Math.PI / 180);

            const scaledFontSize = s.fontsize * group.scale;
            const fontStr = `${italic ? 'italic ' : ''}${fontWeight} ${scaledFontSize}px "${fontFamily}", ${fallbackFamily}`;
            ctx.font = fontStr;
            ctx.textBaseline = 'top';

            const spaceW = ctx.measureText(' ').width + wordSpacing;
            const wordWidths = group.words.map(w => this._measureTextWithSpacing(ctx, w.word, letterSpacing));
            let groupW = 0;
            for (let i = 0; i < wordWidths.length; i++) {
                groupW += wordWidths[i];
                if (i < wordWidths.length - 1) {
                    groupW += spaceW;
                }
            }

            const padLeft = (s.box_padding_left ?? s.box_padding_x ?? 16) * group.scale;
            const padRight = (s.box_padding_right ?? s.box_padding_x ?? 16) * group.scale;
            const padTop = (s.box_padding_top ?? s.box_padding_y ?? 12) * group.scale;
            const padBottom = (s.box_padding_bottom ?? s.box_padding_y ?? 12) * group.scale;

            const bx = -groupW / 2 - padLeft;
            const by = -(scaledFontSize * 1.2) / 2 - padTop;
            const bw = groupW + padLeft + padRight;
            const bh = (scaledFontSize * 1.2) + padTop + padBottom;

            if (s.use_box) {
                ctx.save();
                ctx.fillStyle = s.color_bg || '#6A0DAD';
                ctx.globalAlpha = (s.opacity_bg || 220) / 255;
                const rad = (s.box_radius || 12) * group.scale;
                this._roundRect(ctx, bx, by, bw, bh, rad);
                ctx.fill();
                ctx.restore();
            }

            let currX = -groupW / 2;
            const wordY = -(scaledFontSize * 1.2) / 2;

            for (let wi = 0; wi < group.words.length; wi++) {
                const w = group.words[wi];
                const wordStr = w.word;
                const wordW = wordWidths[wi];

                let wordColor = s.color_text || '#FFFFFF';
                if (currentTime >= w.start && currentTime <= w.end) {
                    wordColor = s.color_high || '#FFD700';
                }

                this._drawWord(ctx, wordStr, currX, wordY, wordColor,
                    useStroke && !s.stroke_expand_enabled, outlineColor, borderW * group.scale, outlineAlpha,
                    shadowBlur * group.scale, shadowOffX * group.scale, shadowOffY * group.scale, shadowColor, shadowAlpha, letterSpacing * group.scale);

                currX += wordW + spaceW;
            }

            ctx.restore();
        }
    }
}

function _resolveFontWeight(weight, fallback = 700) {
    const n = parseInt(weight, 10);
    const base = Number.isFinite(n) ? n : fallback;
    return Math.max(100, Math.min(900, base));
}

function _resolveGenericFallback(fontFamily) {
    const f = String(fontFamily || '').toLowerCase();
    const serifHints = [
        'serif', 'times', 'georgia', 'playfair', 'crimson', 'lora', 'gelasio',
        'caslon', 'vidaloka', 'yeseva', 'dm serif', 'young serif', 'rye',
        'song', 'ming', 'mincho',
    ];
    return serifHints.some(k => f.includes(k)) ? 'serif' : 'sans-serif';
}

// ═══════════════════════════════════════════════════════
// SRT Parser
// ═══════════════════════════════════════════════════════

function parseSRT(srtContent) {
    const segments = [];
    const blocks = srtContent.trim().split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.trim().split('\n');
        if (lines.length < 3) continue;
        const index = parseInt(lines[0]);
        const timeMatch = lines[1].match(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
        );
        if (!timeMatch) continue;
        const start = +timeMatch[1] * 3600 + +timeMatch[2] * 60 + +timeMatch[3] + +timeMatch[4] / 1000;
        const end = +timeMatch[5] * 3600 + +timeMatch[6] * 60 + +timeMatch[7] + +timeMatch[8] / 1000;
        const text = lines.slice(2).join('\n');
        segments.push({ index, start, end, text, words: [] });
    }
    return segments;
}

function formatSRTTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════════
// ASS Generator (enhanced from AutoSub)
// ═══════════════════════════════════════════════════════

function generateASS(segments, style) {
    const s = style || {};
    const fontFamily = s.font_family || 'Arial';
    const fontSize = s.fontsize || 74;
    const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
    const bold = fontWeight >= 600 ? -1 : 0;
    const italic = s.italic ? -1 : 0;

    function toASSColor(hex, alpha = 0) {
        if (!hex) hex = '#FFFFFF';
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        const r = hex.substr(0, 2);
        const g = hex.substr(2, 2);
        const b = hex.substr(4, 2);
        const a = String(alpha.toString(16)).padStart(2, '0').toUpperCase();
        return `&H${a}${b}${g}${r}`;
    }

    const primaryColor = toASSColor(s.color_text || '#FFFFFF');
    const outlineColor = toASSColor(s.color_outline || '#000000');
    const shadowColor = toASSColor(s.color_shadow || '#000000', Math.round(255 - (s.opacity_shadow || 150)));
    const borderW = s.use_stroke !== false ? (s.border_width || 3) : 0;
    const shadowDist = Math.max(
        Math.abs(s.shadow_offset_x || 0),
        Math.abs(s.shadow_offset_y || 0),
        s.shadow_blur ? Math.min(s.shadow_blur, 4) : 0
    );
    const spacing = s.letter_spacing || 0;

    let alignment = 2;
    const posY = s.pos_y || 0.85;
    if (posY < 0.3) alignment = 8;
    else if (posY < 0.6) alignment = 5;

    const marginV = Math.max(0, Math.round((1 - (typeof posY === 'number' && posY <= 1 ? posY : 0.85)) * 100));

    const header = `[Script Info]
Title: Batch Reels Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},${shadowColor},${bold},${italic},0,0,100,100,${spacing},0,1,${borderW},${shadowDist},${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

    function toASSTime(sec) {
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    }

    function buildSegmentOverrideTags(segStyle = {}) {
        if (!segStyle || typeof segStyle !== 'object') return '';
        let tags = '';
        const color = segStyle.color_text || segStyle.color;
        if (color) tags += `\\1c${toASSColor(color)}`;
        if (segStyle.color_outline) tags += `\\3c${toASSColor(segStyle.color_outline)}`;
        if (segStyle.fontsize) tags += `\\fs${Math.round(parseFloat(segStyle.fontsize) || fontSize)}`;
        if (segStyle.font_family) tags += `\\fn${String(segStyle.font_family).replace(/[{}\\]/g, '')}`;
        if (segStyle.font_weight !== undefined) tags += `\\b${Math.max(100, Math.min(900, parseInt(segStyle.font_weight, 10) || 400))}`;
        else if (segStyle.bold !== undefined) tags += `\\b${segStyle.bold ? 1 : 0}`;
        if (segStyle.italic !== undefined) tags += `\\i${segStyle.italic ? 1 : 0}`;
        if (segStyle.border_width !== undefined) tags += `\\bord${Math.max(0, parseFloat(segStyle.border_width) || 0)}`;
        const sx = typeof segStyle.pos_x === 'number' ? segStyle.pos_x : parseFloat(segStyle.pos_x);
        const sy = typeof segStyle.pos_y === 'number' ? segStyle.pos_y : parseFloat(segStyle.pos_y);
        if (Number.isFinite(sx) || Number.isFinite(sy)) {
            const px = Number.isFinite(sx) ? (sx <= 1 ? sx * 1920 : sx) : 960;
            const py = Number.isFinite(sy) ? (sy <= 1 ? sy * 1080 : sy) : 918;
            tags += `\\an5\\pos(${Math.round(px)},${Math.round(py)})`;
        }
        return tags;
    }

    const events = segments.map(seg => {
        const rawText = (seg.text || '').replace(/\n/g, '\\N');
        const segOverrideTags = buildSegmentOverrideTags(seg.style_override || seg.subtitle_style);

        // ── 富文本 ASS 内联样式 ──
        if (seg.styled_ranges && seg.styled_ranges.length > 0 && typeof ReelsRichText !== 'undefined') {
            const chunks = ReelsRichText.splitByRanges(seg.text || '', seg.styled_ranges, {
                fontsize: fontSize,
                color: s.color_text || '#FFFFFF',
                bold: bold !== 0,
                font_weight: s.font_weight || (bold !== 0 ? 700 : 400),
                italic: italic !== 0,
            });
            let assText = '';
            for (const c of chunks) {
                let overrides = '';
                // 颜色覆盖
                if (c.style.color && c.style.color !== (s.color_text || '#FFFFFF')) {
                    overrides += `\\c${toASSColor(c.style.color)}`;
                }
                // 字号覆盖
                if (c.style.fontsize && c.style.fontsize !== fontSize) {
                    overrides += `\\fs${c.style.fontsize}`;
                }
                // 粗体覆盖
                if (c.style.bold !== undefined) {
                    const segBold = c.style.bold ? -1 : 0;
                    if (segBold !== bold) overrides += `\\b${segBold === -1 ? 1 : 0}`;
                }
                if (c.style.font_weight !== undefined) {
                    const segWeight = Math.max(100, Math.min(900, parseInt(c.style.font_weight, 10) || 400));
                    if (segWeight !== (parseInt(s.font_weight, 10) || (bold !== 0 ? 700 : 400))) overrides += `\\b${segWeight}`;
                }
                if (c.style.italic !== undefined) {
                    const segItalic = c.style.italic ? -1 : 0;
                    if (segItalic !== italic) {
                        overrides += `\\i${segItalic === -1 ? 1 : 0}`;
                    }
                }
                const segChunkText = c.text.replace(/\n/g, '\\N');
                if (overrides) {
                    assText += `{${overrides}}${segChunkText}`;
                } else {
                    assText += segChunkText;
                }
            }
            return `Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${segOverrideTags ? `{${segOverrideTags}}` : ''}${assText}`;
        }

        return `Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${segOverrideTags ? `{${segOverrideTags}}` : ''}${rawText}`;
    });

    return header + '\n' + events.join('\n') + '\n';
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.ReelsCanvasRenderer = ReelsCanvasRenderer;
    window.parseSRT = parseSRT;
    window.formatSRTTime = formatSRTTime;
    window.generateASS = generateASS;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReelsCanvasRenderer, parseSRT, formatSRTTime, generateASS };
}
