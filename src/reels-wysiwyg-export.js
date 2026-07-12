/**
 * reels-wysiwyg-export.js — WYSIWYG 混合导出引擎
 *
 * 混合架构：
 *   1. FFmpeg 处理背景视频（循环+淡入淡出+缩放+音频混合）→ 临时背景视频
 *   2. FFmpeg 提取背景帧序列 → JPEG 文件
 *   3. Canvas 逐帧渲染：背景帧 + 全局蒙版 + 字幕（与预览完全相同的 renderer）
 *   4. 合成帧 → JPEG pipe → FFmpeg 编码 → 临时纯视频
 *   5. Web Audio OfflineAudioContext 离线渲染音频（含混响+立体声）→ WAV
 *   6. FFmpeg 简单合并视频 + 预渲染音频 → 最终输出
 *
 * 音频效果完全使用 Web Audio API 渲染，确保导出与预览 100% 一致。
 */

/**
 * Canvas → Raw RGBA Uint8Array（零压缩，专业级画质）
 * 注意：必须用 slice() 创建独立副本，避免 IPC 传输时 SharedArrayBuffer 问题
 */
function _canvasToRawRGBA(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return imageData.data.buffer.slice(0);
}

/**
 * 加载图片为 Image 对象 (返回 Promise)
 */
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        let normSrc = src;
        if (normSrc && typeof normSrc === 'string' && normSrc.startsWith('file://')) {
            if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
                normSrc = window.electronAPI.toFileUrl(normSrc);
            }
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`图片加载失败: ${normSrc}`));
        img.src = normSrc;
    });
}

function _normalizeOverlayLocalPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    let s = filePath;
    if (/^local-media:\/\//i.test(s)) {
        s = s.replace(/^local-media:\/\//i, '');
    } else if (/^file:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            s = u.pathname || s.replace(/^file:\/\//i, '');
        } catch (_) {
            s = s.replace(/^file:\/\//i, '');
        }
    }
    try { s = decodeURIComponent(s); } catch (_) { }
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    return s;
}

function _overlayPathBaseName(filePath) {
    const s = _normalizeOverlayLocalPath(filePath || '');
    return (s.replace(/\\/g, '/').split('/').pop() || '').trim();
}

function _overlayPathDirName(filePath) {
    const s = _normalizeOverlayLocalPath(filePath || '').replace(/\\/g, '/');
    const idx = s.lastIndexOf('/');
    return idx > 0 ? s.slice(0, idx) : '';
}

async function _overlayLocalPathExists(filePath) {
    const p = _normalizeOverlayLocalPath(filePath);
    if (!p || /^blob:/i.test(p)) return false;
    if (window.electronAPI && typeof window.electronAPI.checkFilesExist === 'function') {
        try {
            const map = await window.electronAPI.checkFilesExist([p]);
            return !!map[p];
        } catch (_) { }
    }
    return false;
}

function _collectOverlaySearchDirs(taskOverlays) {
    const dirs = [];
    const add = (dir) => {
        if (!dir || typeof dir !== 'string') return;
        const d = _normalizeOverlayLocalPath(dir).replace(/[\\/]+$/, '');
        if (d && !/^blob:/i.test(d) && !dirs.includes(d)) dirs.push(d);
    };

    try { add(localStorage.getItem('videokit_overlay_lib_path') || ''); } catch (_) { }

    try {
        const tabs = (typeof _batchTableState !== 'undefined' && _batchTableState?.tabs) ? _batchTableState.tabs : [];
        for (const tab of tabs) add(tab?.materialDir || '');
    } catch (_) { }

    try {
        const activeTab = (typeof _getActiveTab === 'function') ? _getActiveTab() : null;
        add(activeTab?.materialDir || '');
    } catch (_) { }

    const tasks = window._reelsState?.tasks || [];
    for (const task of tasks) {
        add(_overlayPathDirName(task?.bgPath || task?.videoPath || ''));
        add(_overlayPathDirName(task?.audioPath || ''));
        add(_overlayPathDirName(task?.bgmPath || ''));
        add(_overlayPathDirName(task?.contentVideoPath || ''));
        for (const ov of (task?.overlays || [])) add(_overlayPathDirName(ov?.content || ''));
    }

    for (const ov of (taskOverlays || [])) add(_overlayPathDirName(ov?.content || ''));
    return dirs;
}

function _cloneOverlaysForWysiwygExport(overlays) {
    if (!Array.isArray(overlays)) return overlays;
    const runtimeKeys = new Set([
        '_allOverlays',
        '_cachedUrl',
        '_currentFrameImage',
        '_dirty',
        '_exportDuration',
        '_exporting',
        '_fcpxml_generating',
        '_flipper_drawing',
        '_frameCount',
        '_framesDir',
        '_imageEl',
        '_img',
        '_imgLoaded',
        '_original_body_text',
        '_original_footer_text',
        '_original_title_text',
        '_previewAtEnd',
        '_renderedH',
        '_renderedW',
        '_renderedX',
        '_renderedY',
        '_scrollBodyCurX',
        '_scrollBodyFirstLineY',
        '_scrollBodyLineHeight',
        '_selected',
        '_sideBySideCacheOwner',
        '_videoEl',
    ]);
    try {
        return JSON.parse(JSON.stringify(overlays, (key, value) => {
            if (runtimeKeys.has(key)) return undefined;
            if (key && key.startsWith('_') && key !== '_templateName') return undefined;
            if (typeof Element !== 'undefined' && value instanceof Element) return undefined;
            if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return undefined;
            if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return undefined;
            if (typeof HTMLVideoElement !== 'undefined' && value instanceof HTMLVideoElement) return undefined;
            return value;
        }));
    } catch (e) {
        console.warn('[WYSIWYG] clone overlays failed, falling back to shallow copies:', e);
        return overlays.map(ov => ov && typeof ov === 'object' ? { ...ov } : ov);
    }
}

async function _resolveMissingOverlayPath(ov, taskOverlays, log) {
    const opath = _normalizeOverlayLocalPath(ov?.content || '');
    if (await _overlayLocalPathExists(opath)) return opath;

    const fileName = _overlayPathBaseName(ov?.content || '');
    if (!fileName || !window.electronAPI || typeof window.electronAPI.searchFilesRecursive !== 'function') {
        return opath;
    }

    const dirs = _collectOverlaySearchDirs(taskOverlays);
    const key = fileName.toLowerCase();
    for (const dir of dirs) {
        try {
            const foundMap = await window.electronAPI.searchFilesRecursive(dir, [fileName], 5);
            const foundPath = foundMap && foundMap[key];
            if (foundPath) {
                if (log) log(`已自动找回覆层素材: ${fileName} → ${foundPath}`);
                if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
                    ov.content = window.electronAPI.toFileUrl(foundPath) || foundPath;
                } else {
                    ov.content = foundPath;
                }
                return foundPath;
            }
        } catch (_) { }
    }
    return opath;
}

/**
 * AudioBuffer → WAV (PCM 16-bit) ArrayBuffer
 */
function _audioBufferToWav(buffer, maxSamples) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const numSamples = maxSamples ? Math.min(maxSamples, buffer.length) : buffer.length;
    const dataSize = numSamples * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const wav = new ArrayBuffer(totalSize);
    const view = new DataView(wav);

    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, totalSize - 8, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        channels.push(buffer.getChannelData(ch));
    }

    let offset = headerSize;
    for (let i = 0; i < numSamples; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            let sample = channels[ch][i];
            sample = Math.max(-1, Math.min(1, sample));
            const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(offset, int16, true);
            offset += bytesPerSample;
        }
    }

    return wav;
}

function _parseCropString(cropStr) {
    let cropX = 0, cropY = 0, cropW = 1, cropH = 1;
    if (cropStr && typeof cropStr === 'string' && cropStr.trim() !== '') {
        const parts = cropStr.split(',').map(p => parseFloat(p.trim()));
        if (parts.length === 4 && parts.every(p => !isNaN(p))) {
            cropX = Math.max(0, Math.min(100, parts[0])) / 100;
            cropY = Math.max(0, Math.min(100, parts[1])) / 100;
            cropW = Math.max(1, Math.min(100, parts[2])) / 100;
            cropH = Math.max(1, Math.min(100, parts[3])) / 100;
        }
    }
    return { cropX, cropY, cropW, cropH };
}

function _drawImageFlipped(ctx, img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, flipH, flipV) {
    if (!flipH && !flipV) {
        if (arg5 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8);
        } else if (arg3 !== undefined) {
            ctx.drawImage(img, arg1, arg2, arg3, arg4);
        } else {
            ctx.drawImage(img, arg1, arg2);
        }
        return;
    }
    
    ctx.save();
    let dx, dy, dw, dh;
    if (arg5 !== undefined) {
        // 9 arguments: img, sx, sy, sw, sh, dx, dy, dw, dh
        dx = arg5; dy = arg6; dw = arg7; dh = arg8;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, arg1, arg2, arg3, arg4, -dw / 2, -dh / 2, dw, dh);
    } else if (arg3 !== undefined) {
        // 5 arguments: img, dx, dy, dw, dh
        dx = arg1; dy = arg2; dw = arg3; dh = arg4;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    } else {
        // 3 arguments: img, dx, dy
        dx = arg1; dy = arg2; dw = img.naturalWidth || img.width || 0; dh = img.naturalHeight || img.height || 0;
        ctx.translate(dx + dw / 2, dy + dh / 2);
        ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    }
    ctx.restore();
}

function _drawCroppedVideoCover(ctx, videoEl, cropX, cropY, cropW, cropH, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const srcW = videoEl.videoWidth || videoEl.naturalWidth || targetW;
    const srcH = videoEl.videoHeight || videoEl.naturalHeight || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, videoEl, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV);
        return;
    }
    const sx = srcW * cropX;
    const sy = srcH * cropY;
    const sWidth = srcW * cropW;
    const sHeight = srcH * cropH;

    const userScale = (scalePct || 100) / 100;
    const scale = Math.max(targetW / sWidth, targetH / sHeight) * userScale;
    const drawW = sWidth * scale;
    const drawH = sHeight * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + maxShiftX * (offsetX / 100);
    const drawY = (targetH - drawH) / 2 + maxShiftY * (offsetY / 100);
    _drawImageFlipped(ctx, videoEl, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, flipH, flipV);
}


/**
 * WYSIWYG 导出一个 Reel 任务
 */
async function reelsWysiwygExport(params) {
    let {
        canvas,
        style,
        segments,
        originalScript = '',
        overlays: taskOverlays,
        backgroundPath,
        bgMode = 'single',       // 'single' | 'multi'
        bgClipPool = [],         // 多素材池路径列表
        bgClipSettings = {},     // 多素材剪辑设置
        bgMinClipDur = 5,        // 最小卡点时长
        bgMaxClipDur = 7,        // 最大卡点时长
        bgClipOrder = 'random',  // 'random' | 'sequence'
        bgClipSeed = '',         // 随机顺序种子，与预览保持一致
        bgTransition = 'crossfade', // 多素材转场类型
        bgTransDur = 0.5,        // 多素材转场时长(秒)
        showSubtitle = true,
        voicePath,
        outputPath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        voiceVolume = 1.0,
        bgVolume = 0.1,
        loopFade = true,
        loopFadeDur = 1.0,
        customDuration = 0,  // 自定义输出时长（秒），0 = 自动
        bgmPath = '',        // 配乐文件路径
        bgmVolume = 0.3,     // 配乐音量 (0~1)
        contentVideoPath = null,
        contentVideoTrimStart = null,
        contentVideoTrimEnd = null,
        contentVideoScale = 100,
        contentVideoX = 'center',
        contentVideoY = 'center',
        contentVideoVolume = 1.0,
        contentVideoCrop = '',
        contentVideoBlurBg = false,
        contentVideoDirectBg = false,
        contentVideoBlur = 40,
        contentVideoBrightness = 60,
        bgScale = 100,       // 背景图片缩放 (50~300%)
        bgX = 0,
        bgY = 0,
        bgFlipH = false,
        bgFlipV = false,
        contentVideoFlipH = false,
        contentVideoFlipV = false,
        bgDurScale = 100,    // 背景素材时长缩放 (10~500%)
        audioDurScale = 100,  // 音频素材时长缩放 (10~500%)
        reverbEnabled = false,
        reverbPreset = 'hall',
        reverbMix = 30,
        stereoWidth = 100,
        audioFxTarget = 'all',
        useGPU = false,
        onProgress,
        onLog,
        isCancelled,
    } = params;

    const isMultiClip = bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0;
    taskOverlays = _cloneOverlaysForWysiwygExport(taskOverlays);

    // ── 多素材诊断日志 ──
    console.log(`[WYSIWYG-EXPORT] bgMode=${bgMode}, bgClipPool=${Array.isArray(bgClipPool) ? bgClipPool.length : 'N/A'}, isMultiClip=${isMultiClip}, backgroundPath=${backgroundPath || '(empty)'}`);
    if (isMultiClip) {
        console.log(`[WYSIWYG-EXPORT] 多素材池:`, bgClipPool);
    }

    if (!canvas) throw new Error('需要提供 canvas');
    if (!backgroundPath && !isMultiClip && !contentVideoBlurBg && !contentVideoDirectBg) throw new Error('缺少背景素材');
    if (!outputPath) throw new Error('缺少输出路径');
    if (!window.electronAPI || !window.electronAPI.reelsComposeWysiwyg) {
        throw new Error('需要 reelsComposeWysiwyg IPC 接口');
    }

    // 允许无字幕（纯覆层模式）
    if (!segments) segments = [];

    const log = (msg) => { if (onLog) onLog(msg); console.log(`[WYSIWYG] ${msg}`); };
    const progress = (v) => { if (onProgress) onProgress(v); };

    // ── 确保所有覆层与字幕使用的字体全部预加载完成 ──
    const fontsToLoad = new Set();
    if (style && style.font_family) {
        fontsToLoad.add(style.font_family);
    }
    if (Array.isArray(taskOverlays)) {
        for (const ov of taskOverlays) {
            if (ov.disabled) continue;
            if (ov.type === 'textcard' || !ov.type || ov.type === '') {
                if (ov.title_text && ov.title_font_family) fontsToLoad.add(ov.title_font_family);
                if (ov.body_text && ov.body_font_family) fontsToLoad.add(ov.body_font_family);
                if (ov.footer_text && ov.footer_font_family) fontsToLoad.add(ov.footer_font_family);
            } else if (ov.type === 'text' || ov.type === 'scroll') {
                if (ov.font_family) fontsToLoad.add(ov.font_family);
            }
        }
    }
    if (window.getFontManager && fontsToLoad.size > 0) {
        log(`正在预加载字体: ${Array.from(fontsToLoad).join(', ')}`);
        const fm = window.getFontManager();
        for (const font of fontsToLoad) {
            try {
                await fm.loadGoogleFont(font);
            } catch (e) {
                console.warn(`[Export Font Load] Failed to load font "${font}":`, e);
            }
        }
        try {
            await document.fonts.ready;
            log('字体全部加载完成');
        } catch (e) {
            console.warn(`[Export Font Load] document.fonts.ready error:`, e);
        }
    }

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    // willReadFrequently: 跳过每帧 GPU→CPU readback 同步（~1.5x 提速）
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const renderer = new ReelsCanvasRenderer(canvas);

    // 获取时长：优先文字翻转器，其次自定义时长，否则音频时长，否则覆层视频时长，否则背景视频时长
    let duration = 0;
    const _audioDurFactor = (audioDurScale || 100) / 100;
    const _bgDurFactor = (bgDurScale || 100) / 100;
    const rawSubDuration = Array.isArray(segments) && segments.length > 0
        ? (parseFloat(segments[segments.length - 1].end) || 0)
        : 0;
    const effectiveSubDuration = voicePath ? rawSubDuration * _audioDurFactor : rawSubDuration;

    let maxFlipperDuration = 0;
    if (Array.isArray(taskOverlays)) {
        for (const ov of taskOverlays) {
            if (ov && !ov.disabled && ov.flipper_enabled) {
                const text = (ov.type === 'textcard') ? (ov.body_text || '') : (ov.content || '');
                const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                const flipper_lines = parseInt(ov.flipper_lines) || 2;
                const flipper_duration = parseFloat(ov.flipper_duration) || 2.0;
                const totalChunks = Math.ceil(lines.length / flipper_lines);
                const flipperDur = (parseFloat(ov.start) || 0) + (totalChunks * flipper_duration);
                if (flipperDur > maxFlipperDuration) {
                    maxFlipperDuration = flipperDur;
                }
            }
        }
    }

    if (maxFlipperDuration > 0) {
        duration = maxFlipperDuration;
        log(`使用文字翻转器计算所得时长: ${duration}s`);
    } else if (customDuration > 0) {
        duration = customDuration;
        log(`使用自定义时长: ${duration}s`);
    } else {
        if (voicePath) {
            log('正在获取音频时长...');
            let rawAudioDur = await window.electronAPI.getMediaDuration(voicePath);
            if (rawAudioDur > 0 && _audioDurFactor !== 1.0) {
                duration = rawAudioDur * _audioDurFactor;
                log(`音频原始时长: ${rawAudioDur.toFixed(2)}s × ${audioDurScale}% = ${duration.toFixed(2)}s`);
            } else {
                duration = rawAudioDur;
            }
        }
        // ── 覆层视频 (Content Video) 时长优先于背景 ──
        if ((!duration || duration <= 0) && contentVideoPath) {
            let cvDur = 0;
            // 情况1: 图片序列文件夹 → duration = imageCount / fps
            if (window.require) {
                try {
                    const fs = window.require('fs');
                    if (fs.existsSync(contentVideoPath) && fs.statSync(contentVideoPath).isDirectory()) {
                        const seqFiles = fs.readdirSync(contentVideoPath)
                            .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f));
                        if (seqFiles.length > 0) {
                            cvDur = seqFiles.length / fps;
                            log(`覆层序列帧时长: ${seqFiles.length} 帧 / ${fps} fps = ${cvDur.toFixed(2)}s`);
                        }
                    }
                } catch (e) { /* not a directory or no fs */ }
            }
            // 情况2: 普通视频文件 → probe duration
            if (cvDur <= 0) {
                log('正在获取覆层视频时长...');
                let rawCvDur = await window.electronAPI.getMediaDuration(contentVideoPath);
                if (rawCvDur > 0) {
                    const trimStart = parseFloat(contentVideoTrimStart) || 0;
                    const trimEnd   = parseFloat(contentVideoTrimEnd) || 0;
                    if (trimEnd > trimStart && trimStart >= 0) {
                        cvDur = trimEnd - trimStart;
                    } else {
                        cvDur = rawCvDur - trimStart;
                    }
                    log(`覆层视频时长: ${cvDur.toFixed(2)}s (原始 ${rawCvDur.toFixed(2)}s, trim ${trimStart}-${trimEnd || 'end'})`);
                }
            }
            if (cvDur > 0) {
                duration = Math.max(cvDur, effectiveSubDuration);
            }
        }
        if (!duration || duration <= 0) {
            if (isMultiClip) {
                // 多素材模式：按实际拼接后的有效时长计算。
                // 带转场时相邻素材会重叠 bgTransDur 秒，不能用素材时长简单相加，
                // 否则导出端会为了补足目标时长再次从素材池开头取片段。
                log(`正在获取多素材池时长 (${bgClipPool.length} 个)...`);
                let poolTotalDur = 0;
                let poolClipCount = 0;
                for (const clipPath of bgClipPool) {
                    if (_isImageFile(clipPath)) {
                        poolTotalDur += 5.0; // 图片默认 5 秒
                        poolClipCount++;
                    } else {
                        const clipDur = await window.electronAPI.getMediaDuration(clipPath);
                        if (clipDur > 0) {
                            poolTotalDur += clipDur;
                            poolClipCount++;
                        }
                    }
                }
                const scaledPoolDur = poolTotalDur * _bgDurFactor;
                const transOverlap = bgTransition !== 'none' ? Math.max(0, bgTransDur || 0) : 0;
                const overlapTotal = transOverlap > 0 ? transOverlap * Math.max(0, poolClipCount - 1) : 0;
                duration = Math.max(0.5, scaledPoolDur - overlapTotal, effectiveSubDuration);
                log(`多素材池有效时长: ${scaledPoolDur.toFixed(2)}s - 转场重叠 ${overlapTotal.toFixed(2)}s = ${duration.toFixed(2)}s`);
            } else if (backgroundPath) {
                log('正在获取背景视频时长...');
                let rawBgDur = await window.electronAPI.getMediaDuration(backgroundPath);
                if (rawBgDur > 0 && _bgDurFactor !== 1.0) {
                    duration = Math.max(rawBgDur * _bgDurFactor, effectiveSubDuration);
                    log(`背景原始时长: ${rawBgDur.toFixed(2)}s × ${bgDurScale}% = ${duration.toFixed(2)}s`);
                } else {
                    duration = Math.max(rawBgDur, effectiveSubDuration);
                }
            }
        }
        if (!duration || duration <= 0) {
            // 图片背景无音频时默认 5 秒
            duration = 5;
            log(`无法获取时长，使用默认 ${duration}s`);
        }
    }
    const totalFrames = Math.max(1, Math.round(duration * fps));
    const outputDuration = totalFrames / fps;
    log(`时长: ${duration.toFixed(2)}s, 帧数: ${totalFrames}, FPS: ${fps}`);
    if (bgScale !== 100) log(`背景缩放: ${bgScale}%`);
    if (bgX !== 0 || bgY !== 0) log(`背景偏移: X=${bgX}%, Y=${bgY}%`);
    if (bgDurScale !== 100) log(`背景时长缩放: ${bgDurScale}%`);
    if (audioDurScale !== 100) log(`音频时长缩放: ${audioDurScale}%`);

    // ── 按 audioDurScale 缩放字幕时间戳（让字幕跟随音频拉长/缩短）──
    if (_audioDurFactor !== 1.0 && segments && segments.length > 0) {
        log(`字幕时间戳同步缩放 ×${_audioDurFactor.toFixed(2)}`);
        segments = segments.map(seg => ({
            ...seg,
            start: (seg.start || 0) * _audioDurFactor,
            end:   (seg.end   || 0) * _audioDurFactor,
            words: seg.words ? seg.words.map(w => ({
                ...w,
                start: (w.start || 0) * _audioDurFactor,
                end:   (w.end   || 0) * _audioDurFactor,
            })) : undefined
        }));
    }

    // ── 检测覆层是否使用了非默认混合模式（screen/multiply 等需要背景像素才能生效）──
    const _hasBlendOverlay = (taskOverlays || []).some(ov =>
        !ov.disabled && ov.blend_mode && ov.blend_mode !== 'source-over'
    );

    // ── 智能补偿：如果处于单视频且开启了循环渐变，但实际合成短于视频本身，抢回极速模式！ ──
    if (loopFade && backgroundPath && !_isImageFile(backgroundPath) && !isMultiClip) {
        let _probedBg = await window.electronAPI.getMediaDuration(backgroundPath);
        _probedBg = _probedBg * (_bgDurFactor || 1.0);
        if (_probedBg > 0 && duration <= _probedBg) {
            log(`🎯 [智能提速] 合成时长(${duration.toFixed(2)}s)无需底板(${_probedBg.toFixed(2)}s)循环！强制关闭渐变，唤醒极速贴合 ⚡️！`);
            loopFade = false; 
            // 只要不是多视频，就可以霸王硬上弓恢复极速直通路径！
            // ⚠️ 但如果有覆层使用了 blend mode，则不能走 alpha overlay（FFmpeg overlay 不支持 CSS 混合模式）
            if (params.alphaOverlayBgPath === null && !_hasBlendOverlay) {
                const uiFastAlpha = (document.getElementById('reels-fast-alpha-mode') || {}).checked !== false;
                if (uiFastAlpha) params.alphaOverlayBgPath = backgroundPath; 
            }
        }
    }

    // ── 即使外部已设置 alphaOverlayBgPath，如果有 blend mode 覆层也必须降级 ──
    if (_hasBlendOverlay && params.alphaOverlayBgPath) {
        log('⚠️ 检测到覆层使用混合模式，禁用 Alpha Overlay 快速通道（需逐帧 Canvas 合成以支持 blend mode）');
        params.alphaOverlayBgPath = null;
    }

    // 注意：OfflineAudioContext 在 Electron contextIsolation:true 下会崩溃
    // 所有音频效果由 FFmpeg afir 卷积滤镜处理（使用相同 seeded PRNG 的 IR）

    // ═══ 阶段 1: 让主进程用 FFmpeg 预处理背景 + 提取帧序列 ═══
    let framesDir = null;
    let totalBgFrames = 0;
    let bgAudioPath = null;
    
    if (params.alphaOverlayBgPath) {
        log('⚡ Alpha Overlay 模式激活：全面跳过底图解压与多层内存搬运！');
        progress(18);
    } else if (contentVideoBlurBg || contentVideoDirectBg) {
        log('使用内容视频直接作为背景或模糊背景，跳过背景预处理');
        progress(18);
    } else {
        if (isMultiClip) {
            log(`阶段1: FFmpeg 多素材拼接（${bgClipPool.length}个片段，转场: ${bgTransition} ${bgTransDur}s）...`);
        } else {
            log('阶段1: FFmpeg 预处理背景视频（循环+淡入淡出+提取帧）...');
        }
        progress(2);

        const prepResult = await window.electronAPI.reelsComposeWysiwyg('prepare-bg', {
            backgroundPath: isMultiClip ? null : backgroundPath,
            bgMode: isMultiClip ? 'multi' : 'single',
            bgClipPool: isMultiClip ? bgClipPool : [],
            bgClipSettings: isMultiClip ? bgClipSettings : {},
            bgMinClipDur: isMultiClip ? bgMinClipDur : 0,
            bgMaxClipDur: isMultiClip ? bgMaxClipDur : 0,
            segments: isMultiClip ? (segments || []) : [],
            originalScript: isMultiClip ? (originalScript || '') : '',
            bgClipOrder: isMultiClip ? bgClipOrder : 'random',
            bgClipSeed: isMultiClip ? bgClipSeed : '',
            bgTransition: isMultiClip ? bgTransition : 'none',
            bgTransDur: isMultiClip ? bgTransDur : 0,
            voicePath,
            targetWidth,
            targetHeight,
            fps,
            duration: duration,
            loopFade: isMultiClip ? false : loopFade,
            loopFadeDur,
            bgScale: bgScale || 100,
            bgX: bgX || 0,
            bgY: bgY || 0,
            bgFlipH: bgFlipH || false,
            bgFlipV: bgFlipV || false,
            bgDurScale: bgDurScale || 100,
        });

        if (!prepResult || prepResult.error) {
            throw new Error(prepResult?.error || '背景预处理失败');
        }
        framesDir = prepResult.framesDir;
        totalBgFrames = prepResult.frameCount;
        bgAudioPath = prepResult.bgAudioPath || null;
        log(`背景帧提取完成: ${totalBgFrames} 帧 → ${framesDir}`);
        // ── 安全检查：如果是多素材模式但提取了 0 帧，说明 FFmpeg 拼接出了问题 ──
        if (totalBgFrames === 0 && isMultiClip) {
            throw new Error(`多素材拼接失败：FFmpeg 提取了 0 帧。素材池: ${bgClipPool.length} 个文件`);
        }
        if (totalBgFrames === 0 && !contentVideoBlurBg && !contentVideoDirectBg) {
            log('⚠️ 警告: 背景帧数为 0，导出可能产生黑屏');
        }
        progress(18);
    }

    const videoOverlays = (taskOverlays || []).filter(ov => ov.type === 'video' && !ov.disabled);
    if (videoOverlays.length > 0) {
        log(`阶段1.5: 预处理 ${videoOverlays.length} 个视频/动图覆层...`);
        for (const ov of videoOverlays) {
            if (!ov.content) continue;
            const opath = await _resolveMissingOverlayPath(ov, taskOverlays, log);
            if (!opath || /^blob:/i.test(opath)) {
                throw new Error(`覆层素材不是可导出的本地文件路径: ${ov.name || ov.content}`);
            }
            const oPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                overlayPath: opath,
                fps,
                duration: Math.min(duration, parseFloat(ov.end || duration)),
            });
            if (oPrep && oPrep.framesDir) {
                ov._framesDir = oPrep.framesDir;
                ov._frameCount = oPrep.frameCount;
            }
        }
    }

    let cvFramesDir = null;
    let cvFrameCount = 0;
    let cvIsImageSequence = false;
    if (contentVideoPath) {
        log(`阶段1.5: 预处理内容视频源 (${contentVideoPath})...`);
        const cvPathRaw = contentVideoPath.startsWith('file://') ? decodeURIComponent(contentVideoPath.substring(7)) : contentVideoPath;

        // 检测是否为图片序列文件夹
        let isDir = false;
        if (window.require) {
            try {
                const fs = window.require('fs');
                if (fs.existsSync(cvPathRaw) && fs.statSync(cvPathRaw).isDirectory()) {
                    isDir = true;
                    const seqFiles = fs.readdirSync(cvPathRaw)
                        .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
                    if (seqFiles.length > 0) {
                        cvFramesDir = cvPathRaw;
                        cvFrameCount = seqFiles.length;
                        cvIsImageSequence = true;
                        // 缓存文件名列表供逐帧渲染使用
                        window._cvSeqFileList = seqFiles;
                        log(`覆层图片序列: ${seqFiles.length} 帧 (直接使用源目录)`);
                    }
                }
            } catch (e) { /* not a directory */ }
        }

        if (!isDir) {
            const cvPrep = await window.electronAPI.reelsComposeWysiwyg('prepare-overlay', {
                overlayPath: cvPathRaw,
                fps,
                duration,
                trimStart: contentVideoTrimStart,
                trimEnd: contentVideoTrimEnd,
            });
            if (cvPrep && cvPrep.framesDir) {
                cvFramesDir = cvPrep.framesDir;
                cvFrameCount = cvPrep.frameCount;
            }
        }
    }

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
        backgroundPath: isMultiClip ? bgAudioPath : backgroundPath,
        alphaOverlayBgPath: params.alphaOverlayBgPath || null,
        // Multi-clip mode: use bgAudioPath if present. Single mode: check if bg has audio.
        bgHasAudio: isMultiClip ? (!!bgAudioPath) : ((voicePath && backgroundPath && voicePath === backgroundPath) ? false : !_isImageFile(backgroundPath)),
        bgmPath: bgmPath || '',
        bgmVolume: bgmVolume || 0,
        bgScale: bgScale || 100,
        bgX: bgX || 0,
        bgY: bgY || 0,
        bgDurScale: bgDurScale || 100,
        audioDurScale: audioDurScale || 100,
        targetDuration: outputDuration,
        totalFrames,
        reverbEnabled,
        reverbPreset,
        reverbMix,
        stereoWidth,
        audioFxTarget,
        useGPU,
        contentVideoPath: contentVideoPath || '',
        contentVideoVolume: contentVideoVolume,
        contentVideoCrop: contentVideoCrop || '',
        contentVideoBlurBg: contentVideoBlurBg || false,
    });
    if (!sessionId) throw new Error('FFmpeg 启动失败');

    // 全局蒙版
    const hasMask = !!style.global_mask_enabled;
    const maskColor = style.global_mask_color || '#000000';
    const maskOpacity = style.global_mask_opacity ?? 0.5;


    // ═══ 阶段 2.5: 背景帧内存预缓存（消除逐帧磁盘 I/O）═══
    let _bgFrameCache = null;
    if (framesDir && totalBgFrames > 0) {
        log(`阶段2.5: 预加载 ${totalBgFrames} 帧到内存...`);
        progress(19);
        try {
            _bgFrameCache = new Array(totalBgFrames);
            let loadedCount = 0;
            const BATCH = 30;
            for (let batchStart = 0; batchStart < totalBgFrames; batchStart += BATCH) {
                const batchEnd = Math.min(batchStart + BATCH, totalBgFrames);
                const batchPromises = [];
                for (let fi = batchStart; fi < batchEnd; fi++) {
                    const padRef = String(fi + 1).padStart(6, '0');
                    const p = _loadImage(`file://${framesDir}/frame_${padRef}.jpg`)
                        .catch(() => _loadImage(`file://${framesDir}/frame_${padRef}.png`))
                        .then(img => { _bgFrameCache[fi] = img; loadedCount++; })
                        .catch(() => { _bgFrameCache[fi] = null; });
                    batchPromises.push(p);
                }
                await Promise.all(batchPromises);
                if (isCancelled && isCancelled()) throw new Error('__CANCELLED__');
            }
            log(`✅ 预缓存完成: ${loadedCount}/${totalBgFrames} 帧已载入内存`);
        } catch (e) {
            if (e.message === '__CANCELLED__') throw e;
            log(`⚠️ 预缓存失败（${e.message}），回退到逐帧磁盘加载`);
            _bgFrameCache = null;
        }
    }

    // ═══ 阶段 3: 逐帧渲染 ═══
    log('阶段3: 逐帧 Canvas 渲染...');
    const t0 = Date.now();

    // 预加载第一帧
    let currentBgImg = null;
    let currentBgIdx = -1;
    let currentCvImg = null;
    let currentCvIdx = -1;

    try {
        for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
            // ── 取消检查 ──
            if (isCancelled && isCancelled()) {
                log('用户取消导出');
                throw new Error('__CANCELLED__');
            }
            const t = frameIdx / fps;

            // ── 预加载内容视频帧 ──
            if (contentVideoPath && cvFramesDir) {
                // Clamped to the last frame to prevent 1-frame wrap-around glitch at the end
                let frameIdxCv = frameIdx;
                if (cvFrameCount > 0) {
                    frameIdxCv = Math.min(frameIdxCv, cvFrameCount - 1);
                }
                if (frameIdxCv !== currentCvIdx) {
                    let framePath;
                    if (cvIsImageSequence && window._cvSeqFileList && window._cvSeqFileList.length > 0) {
                        // 图片序列: 使用原始文件名
                        const seqFile = window._cvSeqFileList[frameIdxCv];
                        framePath = `file://${cvFramesDir}/${seqFile}`;
                    } else {
                        // FFmpeg 提取的帧: frame_000001.png 格式
                        const frameName = `frame_${String(frameIdxCv + 1).padStart(6, '0')}.png`;
                        framePath = `file://${cvFramesDir}/${frameName}`;
                    }
                    try {
                        currentCvImg = await _loadImage(framePath);
                        currentCvIdx = frameIdxCv;
                    } catch (e) {
                        currentCvImg = null;
                    }
                }
            }

            // 加载背景帧（兼容 jpg/png，优先使用内存预缓存）
            if (!contentVideoBlurBg && !contentVideoDirectBg && totalBgFrames > 0) {
                const bgFrameIdx = Math.min(frameIdx, totalBgFrames - 1);
                if (bgFrameIdx >= 0 && bgFrameIdx !== currentBgIdx) {
                    if (_bgFrameCache && _bgFrameCache[bgFrameIdx]) {
                        // 🚀 内存命中
                        currentBgImg = _bgFrameCache[bgFrameIdx];
                        currentBgIdx = bgFrameIdx;
                    } else {
                        const padRef = String(bgFrameIdx + 1).padStart(6, '0');
                        try {
                            currentBgImg = await _loadImage(`file://${framesDir}/frame_${padRef}.jpg`);
                            currentBgIdx = bgFrameIdx;
                        } catch (e) {
                            try {
                                currentBgImg = await _loadImage(`file://${framesDir}/frame_${padRef}.png`);
                                currentBgIdx = bgFrameIdx;
                            } catch (e2) {
                                if (!currentBgImg) {
                                    ctx.fillStyle = '#000000';
                                    ctx.fillRect(0, 0, targetWidth, targetHeight);
                                }
                            }
                        }
                    }
                }
            }

            // ── 预加载视频覆层帧 ──
            if (taskOverlays && taskOverlays.length > 0) {
                for (const ov of taskOverlays) {
                    if (ov.type === 'video' && !ov.disabled) {
                        const ovStart = parseFloat(ov.start || 0);
                        let relTime = Math.max(0, t - ovStart);
                        let frameIdxOv = Math.floor(relTime * fps);
                        
                        let fPath = null;
                        if (ov.is_img_sequence && ov.sequence_frames && ov.sequence_frames.length > 0) {
                            if (frameIdxOv >= ov.sequence_frames.length) {
                                frameIdxOv = frameIdxOv % Math.max(1, ov.sequence_frames.length);
                            }
                            // sequence_frames 已经是合法的 url，若为原生路径等由外部处理（通常已处理好）
                            fPath = ov.sequence_frames[frameIdxOv];
                        } else if (ov._framesDir) {
                            if (frameIdxOv >= ov._frameCount) {
                                frameIdxOv = frameIdxOv % Math.max(1, ov._frameCount);
                            }
                            const frameName = `frame_${String(frameIdxOv + 1).padStart(6, '0')}.png`;
                            fPath = `file://${ov._framesDir}/${frameName}`;
                        }

                        if (fPath) {
                            try {
                                ov._currentFrameImage = await _loadImage(fPath);
                            } catch (e) {
                                ov._currentFrameImage = null;
                            }
                        }
                    }
                }
            }

            // ── 绘制背景帧 ──
            if (params.alphaOverlayBgPath) {
                ctx.clearRect(0, 0, targetWidth, targetHeight);
            } else {
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                if (contentVideoBlurBg && currentCvImg) {
                    const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                    const blurVal = contentVideoBlur != null ? contentVideoBlur : 40;
                    const brightnessVal = (contentVideoBrightness != null ? contentVideoBrightness : 60) / 100;
                    ctx.save();
                    ctx.filter = `blur(${blurVal}px) brightness(${brightnessVal})`;
                    _drawCroppedVideoCover(ctx, currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV);
                    ctx.restore();
                } else if (contentVideoDirectBg && currentCvImg) {
                    const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                    _drawCroppedVideoCover(ctx, currentCvImg, cropX, cropY, cropW, cropH, targetWidth, targetHeight, bgScale, bgX, bgY, bgFlipH, bgFlipV);
                } else if (currentBgImg) {
                    // 直接绘制（FFmpeg 预处理时已完成缩放与裁切）
                    ctx.drawImage(currentBgImg, 0, 0, targetWidth, targetHeight);
                }
            }

            // ── 全局蒙版：与原始预览/V2 一致，只压暗背景层 ──
            if (hasMask) {
                ctx.save();
                ctx.globalAlpha = maskOpacity;
                ctx.fillStyle = maskColor;
                ctx.fillRect(0, 0, targetWidth, targetHeight);
                ctx.restore();
            }

            // ── 绘制合并内容视频 ──
            if (contentVideoPath && currentCvImg && !contentVideoDirectBg) {
                const imgW = currentCvImg.naturalWidth || targetWidth;
                const imgH = currentCvImg.naturalHeight || targetHeight;
                const { cropX, cropY, cropW, cropH } = _parseCropString(contentVideoCrop);
                const sx = imgW * cropX;
                const sy = imgH * cropY;
                const sWidth = imgW * cropW;
                const sHeight = imgH * cropH;

                const cScale = (contentVideoScale || 100) / 100;
                
                // Default width-fit
                const baseScale = targetWidth / sWidth;
                const finalScale = baseScale * cScale;
                const drawW = sWidth * finalScale;
                const drawH = sHeight * finalScale;
                
                let drawX = (targetWidth - drawW) / 2;
                let drawY = (targetHeight - drawH) / 2;
                
                if (contentVideoX && contentVideoX !== 'center') {
                    const relX = parseFloat(contentVideoX);
                    if (!isNaN(relX)) Math.abs(relX) <= 1 ? drawX += targetWidth * relX : drawX += relX;
                }
                if (contentVideoY && contentVideoY !== 'center') {
                    const relY = parseFloat(contentVideoY);
                    if (!isNaN(relY)) Math.abs(relY) <= 1 ? drawY += targetHeight * relY : drawY += relY;
                }
                
                _drawImageFlipped(ctx, currentCvImg, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, contentVideoFlipH, contentVideoFlipV);
            }

            // ── 字幕：与 V2/旧预览一致，先画字幕，再画文字卡片/覆层 ──
            if (showSubtitle) {
                let activeSeg = segments.find(seg => t >= (seg.start || 0) && t <= (seg.end || 0));
                // Scrolling/typewriter mode: find nearest segment during gaps (same as preview logic)
                if (!activeSeg && (style.scrolling_mode || style.fullpage_typewriter) && segments.length > 0) {
                    let best = segments[0];
                    for (const seg of segments) {
                        if ((seg.start || 0) <= t) best = seg;
                    }
                    activeSeg = best;
                }
                if (activeSeg) {
                    renderer.setContextSegments(segments);
                    renderer.renderSubtitle(style, activeSeg, t, targetWidth, targetHeight);
                }
            }

            // ── 覆盖层（文字卡片等）──
            if (taskOverlays && taskOverlays.length > 0 && window.ReelsOverlay) {
                // 注入覆层列表引用（供跟随绑定），按面板图层顺序渲染。
                for (const ov of taskOverlays.filter(ov => !ov.disabled)) {
                    ov._allOverlays = taskOverlays;
                    const ovStart = parseFloat(ov.start || 0);
                    const ovEnd = parseFloat(ov.end || 9999);
                    // scroll 覆层不受 end 限制（动画完成后保持最终位置）
                    if (t >= ovStart && (ov.type === 'scroll' || t <= ovEnd)) {
                        // 导出时不画辅助线和选中框
                        const origSelected = ov._selected;
                        try {
                            ov._selected = false;
                            ov._exporting = true;
                            ov._exportDuration = duration; // 让 scroll 覆层知道实际导出时长
                            ReelsOverlay.drawOverlay(ctx, ov, t, targetWidth, targetHeight);
                        } finally {
                            ov._selected = origSelected;
                            delete ov._exporting;
                        }
                    }
                }
            }

            // ── AI 水印 ──
            if (typeof _drawWatermarks === 'function') {
                _drawWatermarks(ctx, targetWidth, targetHeight);
            }

            // ── Canvas → Raw RGBA → IPC（零压缩）──
            const rawBuf = _canvasToRawRGBA(canvas);
            const frameResult = await window.electronAPI.reelsComposeWysiwyg('frame', {
                sessionId,
                raw: rawBuf,
            });
            // 兼容旧版 boolean 和新版 { ok, error, detail } 格式
            const frameOk = frameResult === true || (frameResult && frameResult.ok);
            if (!frameOk) {
                const errMsg = (frameResult && frameResult.error) || '未知编码错误';
                const errDetail = (frameResult && frameResult.detail) || '';
                throw new Error(`FFmpeg 写入帧失败 (frame ${frameIdx}): ${errMsg}${errDetail ? '\n' + errDetail.slice(-200) : ''}`);
            }

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

        // 释放预缓存内存
        if (_bgFrameCache) { _bgFrameCache = null; }

        // 清理背景帧（磁盘临时文件）
        if (framesDir) {
            await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir });
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
        }
        if (cvFramesDir && !cvIsImageSequence) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }

        progress(100);
        const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
        log(`导出完成 (${totalTime}s): ${outputPath}`);
        return { output_path: result.output_path || outputPath };

    } catch (e) {
        try { await window.electronAPI.reelsComposeWysiwyg('abort', { sessionId }); } catch (_) { }
        if (framesDir) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir }); } catch (_) { }
        }
        for (const ov of videoOverlays) {
            if (ov._framesDir) {
                try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: ov._framesDir }); } catch (_) { }
            }
        }
        if (cvFramesDir && !cvIsImageSequence) {
            try { await window.electronAPI.reelsComposeWysiwyg('cleanup-bg', { framesDir: cvFramesDir }); } catch (_) { }
        }
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
