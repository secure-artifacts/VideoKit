/**
 * reels-wysiwyg-export.js — WYSIWYG 混合导出引擎
 *
 * 混合架构：
 *   1. FFmpeg 处理背景视频（循环+淡入淡出+缩放+音频混合）→ 临时背景视频
 *   2. FFmpeg 提取背景帧序列 → JPEG 文件
 *   3. Canvas 逐帧渲染：背景帧 + 全局蒙版 + 字幕（与预览完全相同的 renderer）
 *   4. 合成帧 → JPEG pipe → FFmpeg 编码 → 临时纯视频
 *   5. FFmpeg 混合音频 → 最终输出
 *
 * 这样既保证字幕效果 100% 一致，又保证背景视频流畅 + 循环淡入淡出正常。
 */

/**
 * Canvas → JPEG ArrayBuffer
 */
function _canvasToJpegBuffer(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) { reject(new Error('toBlob 失败')); return; }
            blob.arrayBuffer().then(resolve).catch(reject);
        }, 'image/jpeg', quality);
    });
}

/**
 * 加载图片为 Image 对象 (返回 Promise)
 */
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`图片加载失败: ${src}`));
        img.src = src;
    });
}

/**
 * WYSIWYG 导出一个 Reel 任务
 */
async function reelsWysiwygExport(params) {
    const {
        canvas,
        style,
        segments,
        overlays: taskOverlays,
        backgroundPath,
        voicePath,
        outputPath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        voiceVolume = 1.0,
        bgVolume = 0.1,
        loopFade = true,
        loopFadeDur = 1.0,
        onProgress,
        onLog,
        isCancelled,
    } = params;

    if (!canvas) throw new Error('需要提供 canvas');
    if (!backgroundPath) throw new Error('缺少背景素材');
    if (!outputPath) throw new Error('缺少输出路径');
    if (!window.electronAPI || !window.electronAPI.reelsComposeWysiwyg) {
        throw new Error('需要 reelsComposeWysiwyg IPC 接口');
    }

    // 允许无字幕（纯覆层模式）
    if (!segments) segments = [];

    const log = (msg) => { if (onLog) onLog(msg); console.log(`[WYSIWYG] ${msg}`); };
    const progress = (v) => { if (onProgress) onProgress(v); };

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    const renderer = new ReelsCanvasRenderer(canvas);

    // 获取时长：优先音频，否则视频背景
    let duration = 0;
    if (voicePath) {
        log('正在获取音频时长...');
        duration = await window.electronAPI.getMediaDuration(voicePath);
    }
    if (!duration || duration <= 0) {
        log('正在获取背景视频时长...');
        duration = await window.electronAPI.getMediaDuration(backgroundPath);
    }
    if (!duration || duration <= 0) {
        // 图片背景无音频时默认 5 秒
        duration = 5;
        log(`无法获取时长，使用默认 ${duration}s`);
    }
    const totalFrames = Math.ceil(duration * fps);
    log(`时长: ${duration.toFixed(2)}s, 帧数: ${totalFrames}, FPS: ${fps}`);

    // ═══ 阶段 1: 让主进程用 FFmpeg 预处理背景 + 提取帧序列 ═══
    log('阶段1: FFmpeg 预处理背景视频（循环+淡入淡出+提取帧）...');
    progress(2);

    const prepResult = await window.electronAPI.reelsComposeWysiwyg('prepare-bg', {
        backgroundPath,
        voicePath,
        targetWidth,
        targetHeight,
        fps,
        duration: duration,
        loopFade,
        loopFadeDur,
    });

    if (!prepResult || prepResult.error) {
        throw new Error(prepResult?.error || '背景预处理失败');
    }
    const framesDir = prepResult.framesDir;
    const totalBgFrames = prepResult.frameCount;
    log(`背景帧提取完成: ${totalBgFrames} 帧 → ${framesDir}`);
    progress(20);

    // ═══ 阶段 2: 启动 FFmpeg 编码器 ═══
    log('阶段2: 启动 FFmpeg 编码器...');
    const sessionId = await window.electronAPI.reelsComposeWysiwyg('start', {
        width: targetWidth,
        height: targetHeight,
        fps,
        outputPath,
        voicePath,
        voiceVolume,
        bgVolume,
        backgroundPath,
        bgHasAudio: !_isImageFile(backgroundPath),
    });
    if (!sessionId) throw new Error('FFmpeg 启动失败');

    // 全局蒙版
    const hasMask = !!style.global_mask_enabled;
    const maskColor = style.global_mask_color || '#000000';
    const maskOpacity = style.global_mask_opacity ?? 0.5;
    const jpegQuality = 0.92;

    // ═══ 阶段 3: 逐帧渲染 ═══
    log('阶段3: 逐帧 Canvas 渲染...');
    const t0 = Date.now();

    // 预加载第一帧
    let currentBgImg = null;
    let currentBgIdx = -1;

    try {
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            // ── 取消检查 ──
            if (isCancelled && isCancelled()) {
                log('用户取消导出');
                throw new Error('__CANCELLED__');
            }
            const t = frameIdx / fps;

            // 加载背景帧（从 FFmpeg 提取的 JPEG 序列）
            const bgFrameIdx = Math.min(frameIdx, totalBgFrames - 1);
            if (bgFrameIdx !== currentBgIdx) {
                const framePath = `${framesDir}/frame_${String(bgFrameIdx + 1).padStart(6, '0')}.jpg`;
                try {
                    currentBgImg = await _loadImage(`file://${framePath}`);
                    currentBgIdx = bgFrameIdx;
                } catch (e) {
                    // 帧文件可能不存在（超出范围），保持最后一帧
                    if (!currentBgImg) {
                        // 没有任何帧，画黑色
                        ctx.fillStyle = '#000000';
                        ctx.fillRect(0, 0, targetWidth, targetHeight);
                    }
                }
            }

            // ── 绘制背景帧 ──
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, targetWidth, targetHeight);
            if (currentBgImg) {
                // 背景帧已经是正确尺寸（FFmpeg 提取时已缩放＋裁切）
                ctx.drawImage(currentBgImg, 0, 0, targetWidth, targetHeight);
            }

            // ── 全局蒙版 ──
            if (hasMask) {
                ctx.save();
                ctx.globalAlpha = maskOpacity;
                ctx.fillStyle = maskColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.restore();
            }

            // ── 覆盖层（文案卡片等）──
            if (taskOverlays && taskOverlays.length > 0 && window.ReelsOverlay) {
                for (const ov of taskOverlays) {
                    const ovStart = parseFloat(ov.start || 0);
                    const ovEnd = parseFloat(ov.end || 9999);
                    if (t >= ovStart && t <= ovEnd) {
                        // 导出时不画辅助线和选中框
                        const origSelected = ov._selected;
                        ov._selected = false;
                        ov._exporting = true;
                        ReelsOverlay.drawOverlay(ctx, ov, t, targetWidth, targetHeight);
                        ov._selected = origSelected;
                        ov._exporting = false;
                    }
                }
            }

            // ── 字幕（与预览完全相同的渲染器）──
            const activeSeg = segments.find(seg => t >= (seg.start || 0) && t <= (seg.end || 0));
            if (activeSeg) {
                renderer.renderSubtitle(style, activeSeg, t, targetWidth, targetHeight);
            }

            // ── AI 水印 ──
            if (typeof _drawWatermarks === 'function') {
                _drawWatermarks(ctx, targetWidth, targetHeight);
            }

            // ── Canvas → JPEG → IPC ──
            const jpegBuf = await _canvasToJpegBuffer(canvas, jpegQuality);
            const ok = await window.electronAPI.reelsComposeWysiwyg('frame', {
                sessionId,
                jpeg: jpegBuf,
            });
            if (!ok) throw new Error(`FFmpeg 写入帧失败 (frame ${frameIdx})`);

            // ── 进度 + UI yield ──
            if (frameIdx % Math.max(1, Math.floor(fps / 2)) === 0) {
                const pct = 20 + Math.round((frameIdx / totalFrames) * 65);
                progress(pct);
                const elapsed = (Date.now() - t0) / 1000;
                const fpsActual = (frameIdx + 1) / Math.max(0.1, elapsed);
                const eta = (totalFrames - frameIdx) / Math.max(0.1, fpsActual);
                log(`帧 ${frameIdx + 1}/${totalFrames} (${pct}%) | ${fpsActual.toFixed(1)} fps | 剩余 ~${Math.ceil(eta)}s`);
                await new Promise(r => setTimeout(r, 0)); // yield
            }
        }

        // ═══ 阶段 4: 完成编码 + 混合音频 ═══
        log('阶段4: 完成编码与音频混合...');
        progress(88);
        const result = await window.electronAPI.reelsComposeWysiwyg('finish', { sessionId });
        if (!result || result.error) throw new Error(result?.error || 'FFmpeg 编码完成失败');

        // 清理背景帧
        await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir });

        progress(100);
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        log(`导出完成 (${totalTime}s): ${outputPath}`);
        return { output_path: result.output_path || outputPath };

    } catch (e) {
        try { await window.electronAPI.reelsComposeWysiwyg('abort', { sessionId }); } catch (_) { }
        try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir }); } catch (_) { }
        if (e && e.message === '__CANCELLED__') {
            log('导出已取消，资源已清理');
            return { cancelled: true };
        }
        throw e;
    }
}

function _isImageFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext);
}

if (typeof window !== 'undefined') {
    window.reelsWysiwygExport = reelsWysiwygExport;
}
