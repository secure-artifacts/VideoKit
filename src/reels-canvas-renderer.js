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

    /**
     * 主渲染入口
     */
    renderSubtitle(style, segment, currentTime, videoW, videoH) {
        const ctx = this.ctx;
        const s = style || {};
        const text = segment.edited_text || segment.text || '';
        if (!text.trim()) return;

        const segStart = segment.start || 0;
        const segEnd = segment.end || 0;
        if (currentTime < segStart || currentTime > segEnd) return;

        const anim = typeof ReelsAnimEngine !== 'undefined' ? ReelsAnimEngine : null;

        // ── 字体设置 ──
        const fontFamily = s.font_family || 'Arial';
        const fallbackFamily = _resolveGenericFallback(fontFamily);
        const fontWeight = _resolveFontWeight(s.font_weight, s.bold !== false ? 700 : 400);
        const fontSize = s.fontsize || 74;
        const italic = s.italic || false;
        const letterSpacing = s.letter_spacing || 0;
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
        const words = wordsInfo.length > 0
            ? wordsInfo.map(w => w.word || '').filter(Boolean)
            : text.split(/\s+/).filter(Boolean);
        const joiner = ' ';

        const lines = this._wrapTokensByPixelWidth(words, maxWidth, joiner);
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
            const w = this._measureTextWithSpacing(ctx, line, letterSpacing);
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
        const renderMaxLineW = blockTypography ? blockTargetWidth : maxLineW;

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

        const padX = s.box_padding_x || 12;
        const padY = s.box_padding_y || 8;
        let rectX, rectY, rectW, rectH;
        if (advEnabled) {
            rectX = advX; rectY = advY; rectW = advW; rectH = advH;
        } else {
            rectX = cx - renderMaxLineW / 2 - padX;
            rectY = cy - totalH / 2 - padY;
            rectW = renderMaxLineW + padX * 2;
            rectH = totalH + padY * 2;
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
        const globalAlpha = ((s.opacity_text_global || 255) / 255) * animOpacity;
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
                    this._roundRect(ctx, rectX - expand, rectY - expand,
                        rectW + expand * 2, rectH + expand * 2,
                        rad + expand * 0.3);
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

            this._roundRect(ctx, rectX, rectY, rectW, rectH, rad);
            ctx.fill();

            // Highlight overlay
            if (s.bg_gradient_highlight) {
                const hlGrad = ctx.createLinearGradient(rectX, rectY, rectX, rectY + rectH * 0.3);
                hlGrad.addColorStop(0, 'rgba(255,255,255,0.24)');
                hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = hlGrad;
                this._roundRect(ctx, rectX, rectY, rectW, rectH, rad);
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

            // Text alignment
            let xStart;
            if (blockTypography && advEnabled && advAlign === 'left') {
                xStart = advX;
            } else if (blockTypography && advEnabled && advAlign === 'right') {
                xStart = advX + advW - blockTargetWidth;
            } else if (blockTypography) {
                xStart = cx - blockTargetWidth / 2;
            } else if (advEnabled && advAlign === 'left') {
                xStart = advX;
            } else if (advEnabled && advAlign === 'right') {
                xStart = advX + advW - lineW;
            } else {
                xStart = cx - lineW / 2;
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
                const spaceW = ctx.measureText(' ').width;

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
            if (shadowBlur > 0) {
                // Blur + offset: draw multiple copies with blur spread around the offset position
                const offStep = shadowBlur * 0.3;
                for (const bx of [-offStep, 0, offStep]) {
                    for (const by of [-offStep, 0, offStep]) {
                        if (bx === 0 && by === 0 && shadowBlur > 0) continue;
                        if (letterSpacing > 0) {
                            this._fillTextSpaced(ctx, text, x + shadowOffX + bx, y + shadowOffY + by, letterSpacing);
                        } else {
                            ctx.fillText(text, x + shadowOffX + bx, y + shadowOffY + by);
                        }
                    }
                }
            } else {
                // Pure offset, no blur
                if (letterSpacing > 0) {
                    this._fillTextSpaced(ctx, text, x + shadowOffX, y + shadowOffY, letterSpacing);
                } else {
                    ctx.fillText(text, x + shadowOffX, y + shadowOffY);
                }
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
    _wrapTokensByPixelWidth(words, maxWidth, joiner = ' ') {
        const ctx = this.ctx;
        const lines = [];
        let currentLine = '';
        for (const word of words) {
            const testLine = currentLine ? currentLine + joiner + word : word;
            const testW = ctx.measureText(testLine).width;
            if (testW > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
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

    const events = segments.map(seg => {
        const text = (seg.text || '').replace(/\n/g, '\\N');
        return `Dialogue: 0,${toASSTime(seg.start)},${toASSTime(seg.end)},Default,,0,0,0,,${text}`;
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
