/**
 * ffmpeg-rawvideo.js — WYSIWYG 混合导出 FFmpeg 后端
 *
 * 混合架构：
 *   1. prepare-bg: FFmpeg 预处理背景（循环+淡入淡出+缩放）→ 提取帧序列
 *   2. start: 启动 FFmpeg image2pipe 编码器
 *   3. frame: 接收 JPEG 帧写入 stdin
 *   4. finish: 关闭编码 + 混合音频
 *   5. cleanup-bg: 清理临时帧文件
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const sessions = new Map();

function generateId() {
    return Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function findFFmpeg() {
    // 优先使用 main.js setupFFmpegPath() 设置的环境变量
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    // 尝试从 ffmpeg.js 获取 resolveCommand
    try {
        const resolved = require('./ffmpeg').resolveCommand('ffmpeg');
        if (resolved !== 'ffmpeg' && fs.existsSync(resolved)) return resolved;
    } catch (_) { }
    // macOS 常见路径
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffmpeg';
}

function findFFprobe() {
    // 优先使用 main.js setupFFmpegPath() 设置的环境变量
    if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
    // 尝试从 ffmpeg.js 获取 resolveCommand
    try {
        const resolved = require('./ffmpeg').resolveCommand('ffprobe');
        if (resolved !== 'ffprobe' && fs.existsSync(resolved)) return resolved;
    } catch (_) { }
    // macOS 常见路径
    for (const p of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffprobe';
}

function isImageMedia(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext);
}

async function getMediaDuration(filePath) {
    try {
        const result = execFileSync(findFFprobe(), [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
        ], { timeout: 15000 }).toString().trim();
        return parseFloat(result) || 0;
    } catch (e) {
        return 0;
    }
}

/** 用 ffprobe 检测文件是否真有音频轨道 */
function hasAudioTrack(filePath) {
    try {
        const result = execFileSync(findFFprobe(), [
            '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath
        ], { timeout: 10000 }).toString().trim();
        return result.length > 0;
    } catch (e) {
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// 辅助: 递归搜索文件（限深度，跳过隐藏目录）
// ═══════════════════════════════════════════════════════

function _findFileRecursive(dir, fileName, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // 先检查当前目录
        for (const entry of entries) {
            if (entry.isFile() && entry.name === fileName) {
                return path.join(dir, entry.name);
            }
        }
        // 再递归子目录
        for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                const found = _findFileRecursive(path.join(dir, entry.name), fileName, maxDepth - 1);
                if (found) return found;
            }
        }
    } catch (e) {
        // 权限等问题，跳过
    }
    return null;
}

// ═══════════════════════════════════════════════════════
// 阶段 1: 预处理背景视频 → 提取帧序列
// ═══════════════════════════════════════════════════════

async function prepareBg(opts) {
    let {
        backgroundPath,
        bgMode = 'single',
        bgClipPool = [],
        bgTransition = 'crossfade',
        bgTransDur = 0.5,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        duration,
        loopFade = true,
        loopFadeDur = 1.0,
        bgScale = 100,
        bgDurScale = 100,
    } = opts;
    
    const ptsFactor = (bgDurScale || 100) / 100;
    const ptsFilter = Math.abs(ptsFactor - 1.0) < 0.01 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)*${ptsFactor.toFixed(3)}`;

    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const framesDir = path.join(settings.getSecureTmpDir(), `reels_bg_${generateId()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    // 构建缩放+裁切滤镜
    const scaleFactor = (bgScale || 100) / 100;
    let scaleCropFilter;
    if (Math.abs(scaleFactor - 1.0) < 0.01) {
        scaleCropFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;
    } else {
        const scaledW = Math.round(targetWidth * scaleFactor);
        const scaledH = Math.round(targetHeight * scaleFactor);
        if (scaleFactor >= 1.0) {
            scaleCropFilter = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;
        } else {
            scaleCropFilter = `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`;
        }
        console.log(`[WYSIWYG-BG] 背景缩放: ${bgScale}%, filter: ${scaleCropFilter}`);
    }

    // ═══ 多素材拼接模式 ═══
    if (bgMode === 'multi' && Array.isArray(bgClipPool) && bgClipPool.length > 0) {
        console.log(`[WYSIWYG-BG] 多素材拼接: ${bgClipPool.length} 个素材, 目标时长: ${duration}s, 转场: ${bgTransition} ${bgTransDur}s`);

        // 过滤出实际存在的文件
        const validClips = bgClipPool.filter(p => p && fs.existsSync(p));
        if (validClips.length === 0) {
            throw new Error('素材池中没有有效的文件');
        }

        // 获取每个素材的时长
        const clipDurations = [];
        for (const clip of validClips) {
            const dur = isImageMedia(clip) ? 5.0 : await getMediaDuration(clip);
            clipDurations.push({ path: clip, duration: Math.max(dur, 0.5) * ptsFactor, isImage: isImageMedia(clip) });
        }

        // 随机选择素材直到总时长 >= 目标时长
        const selectedClips = [];
        let totalDur = 0;
        const transOverlap = bgTransition !== 'none' ? bgTransDur : 0;
        let attempts = 0;
        while (totalDur < duration && attempts < 200) {
            const pick = clipDurations[Math.floor(Math.random() * clipDurations.length)];
            selectedClips.push(pick);
            totalDur += pick.duration - (selectedClips.length > 1 ? transOverlap : 0);
            attempts++;
        }

        console.log(`[WYSIWYG-BG] 选中 ${selectedClips.length} 个片段, 预计总时长: ${totalDur.toFixed(2)}s`);

        if (selectedClips.length === 1) {
            // 仅一个片段，直接处理
            const clip = selectedClips[0];
            if (clip.isImage) {
                const args = ['-y', '-i', clip.path, '-vf', scaleCropFilter, '-frames:v', '1', `${framesDir}/frame_000001.png`];
                await runFFmpegSync(ffmpeg, args);
                return { framesDir, frameCount: 1 };
            } else {
                await extractSimpleLoop(ffmpeg, clip.path, framesDir, scaleCropFilter, fps, duration);
            }
        } else {
            // 多片段拼接
            const args = ['-y'];
            for (const clip of selectedClips) {
                if (clip.isImage) {
                    args.push('-loop', '1', '-t', '5', '-i', clip.path);
                } else {
                    args.push('-i', clip.path);
                }
            }

            // 构建 filter_complex
            const filterParts = [];
            
            if (bgTransition !== 'none' && bgTransDur > 0) {
                // 带转场的 xfade 拼接
                const xfadeTransMap = {
                    crossfade: 'fade',
                    fade_black: 'fadeblack',
                    fade_white: 'fadewhite',
                    slide_left: 'slideleft',
                    slide_right: 'slideright',
                    wipe: 'wipeleft',
                };
                const xfadeTrans = xfadeTransMap[bgTransition] || 'fade';
                const tDur = Math.max(0.1, bgTransDur);

                // 预处理每个输入
                for (let i = 0; i < selectedClips.length; i++) {
                    filterParts.push(`[${i}:v]${scaleCropFilter},${ptsFilter}[v${i}]`);
                }

                // 链式 xfade
                let prevLabel = 'v0';
                let cumulativeOffset = 0;
                for (let i = 1; i < selectedClips.length; i++) {
                    cumulativeOffset += selectedClips[i - 1].duration - tDur;
                    const outLabel = i === selectedClips.length - 1 ? 'vout' : `vx${i}`;
                    const offset = Math.max(0, cumulativeOffset).toFixed(3);
                    filterParts.push(
                        `[${prevLabel}][v${i}]xfade=transition=${xfadeTrans}:duration=${tDur.toFixed(3)}:offset=${offset}[${outLabel}]`
                    );
                    prevLabel = outLabel;
                }

                args.push(
                    '-filter_complex', filterParts.join(';'),
                    '-map', `[${prevLabel}]`,
                    '-t', String(duration),
                    '-r', String(fps),
                    '-an',
                    '-qscale:v', '2',
                    `${framesDir}/frame_%06d.jpg`,
                );
            } else {
                // 无转场: concat 硬切
                for (let i = 0; i < selectedClips.length; i++) {
                    filterParts.push(`[${i}:v]${scaleCropFilter},${ptsFilter}[v${i}]`);
                }
                const concatLabels = selectedClips.map((_, i) => `[v${i}]`).join('');
                filterParts.push(`${concatLabels}concat=n=${selectedClips.length}:v=1:a=0[vout]`);

                args.push(
                    '-filter_complex', filterParts.join(';'),
                    '-map', '[vout]',
                    '-t', String(duration),
                    '-r', String(fps),
                    '-an',
                    '-qscale:v', '2',
                    `${framesDir}/frame_%06d.jpg`,
                );
            }

            console.log(`[WYSIWYG-BG] FFmpeg 多素材命令 (${selectedClips.length} clips)...`);
            await runFFmpegSync(ffmpeg, args);
        }

        // 统计帧数
        const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
        console.log(`[WYSIWYG-BG] 多素材帧提取完成: ${files.length} 帧`);
        return { framesDir, frameCount: files.length };
    }

    // ═══ 单素材模式（原有逻辑）═══

    // 路径验证 + 自动搜索修复
    if (!backgroundPath) {
        throw new Error('背景素材路径为空');
    }
    if (!path.isAbsolute(backgroundPath) || !fs.existsSync(backgroundPath)) {
        const bareFileName = path.basename(backgroundPath);
        console.log(`[WYSIWYG-BG] 背景路径无效，尝试搜索文件: "${bareFileName}"`);
        
        const searchDirs = [
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
        ];
        
        let found = null;
        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            found = _findFileRecursive(searchDir, bareFileName, 4);
            if (found) break;
        }
        
        if (found) {
            console.log(`[WYSIWYG-BG] 自动找到文件: "${bareFileName}" → "${found}"`);
            backgroundPath = found;
        } else {
            throw new Error(`背景素材路径无效且自动搜索未找到文件: "${backgroundPath}"。请重新添加素材。`);
        }
    }

    const isImage = isImageMedia(backgroundPath);

    if (isImage) {
        const args = [
            '-y', '-i', backgroundPath,
            '-vf', scaleCropFilter,
            '-frames:v', '1',
            '-qscale:v', '2',
            `${framesDir}/frame_000001.jpg`,
        ];
        await runFFmpegSync(ffmpeg, args);
        return { framesDir, frameCount: 1 };
    }

    // 视频背景
    const rawBgDuration = await getMediaDuration(backgroundPath);
    const bgDuration = rawBgDuration * ptsFactor;
    const fadeEnabled = loopFade && bgDuration > 0;
    const fadeDur = Math.min(loopFadeDur || 1.0, bgDuration * 0.4);

    if (fadeEnabled && bgDuration > 0 && duration > bgDuration) {
        const step = bgDuration - fadeDur;
        const segCount = Math.min(Math.ceil(duration / step) + 1, 20);

        if (segCount >= 2) {
            const args = ['-y'];
            for (let i = 0; i < segCount; i++) {
                args.push('-i', backgroundPath);
            }

            const filterParts = [`[0:v]${scaleCropFilter},${ptsFilter}[v0]`];
            let prevLabel = 'v0';

            for (let i = 1; i < segCount; i++) {
                const inLabel = `v${i}`;
                const outLabel = i === segCount - 1 ? 'vout' : `vx${i}`;
                const offset = Math.max(0, i * step - 0.01).toFixed(3);
                filterParts.push(`[${i}:v]${scaleCropFilter},${ptsFilter}[${inLabel}]`);
                filterParts.push(
                    `[${prevLabel}][${inLabel}]xfade=transition=fade:duration=${fadeDur.toFixed(3)}:offset=${offset}[${outLabel}]`
                );
                prevLabel = outLabel;
            }

            args.push(
                '-filter_complex', filterParts.join(';'),
                '-map', `[${prevLabel}]`,
                '-t', String(duration),
                '-r', String(fps),
                '-an',
                '-qscale:v', '2',
                `${framesDir}/frame_%06d.jpg`,
            );

            console.log(`[WYSIWYG-BG] xfade 循环: ${segCount}段, fadeDur=${fadeDur}s`);
            await runFFmpegSync(ffmpeg, args);
        } else {
            await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor);
        }
    } else {
        await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor);
    }

    // 统计实际帧数
    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    console.log(`[WYSIWYG-BG] 帧提取完成: ${files.length} 帧`);
    return { framesDir, frameCount: files.length };
}

async function extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration, ptsFactor = 1.0) {
    let vf = scaleCropFilter;
    if (Math.abs(ptsFactor - 1.0) > 0.01) {
        vf = `${scaleCropFilter},setpts=PTS*${ptsFactor.toFixed(3)}`;
    }
    const args = [
        '-y',
        '-stream_loop', '-1',
        '-i', backgroundPath,
        '-t', String(duration),
        '-vf', vf,
        '-r', String(fps),
        '-an',
        '-qscale:v', '2',
        `${framesDir}/frame_%06d.jpg`,
    ];
    await runFFmpegSync(ffmpeg, args);
}

function runFFmpegSync(ffmpeg, args) {
    return new Promise((resolve, reject) => {
        console.log(`[WYSIWYG-BG] ${ffmpeg} ${args.slice(0, 15).join(' ')} ...`);
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-3000); });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg 背景处理失败 (code=${code}): ${err.slice(-500)}`));
        });
        proc.on('error', reject);
    });
}

// ═══════════════════════════════════════════════════════
// 阶段 1.5: 预处理视频/GIF覆层 → 提取原分辨率PNG帧序列 (保留Alpha透明度)
// ═══════════════════════════════════════════════════════

async function prepareOverlay(opts) {
    let {
        overlayPath,
        fps = 30,
        duration = 10,  // 需要提取的总时长（跟随背景或者设定视频时长）
        trimStart = null,
        trimEnd = null,
    } = opts;

    if (!overlayPath || !fs.existsSync(overlayPath)) {
        throw new Error(`覆层视频不存在: ${overlayPath}`);
    }

    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const crypto = require('crypto');
    
    // 生成基于文件内容元特征和提取参数的唯一哈希值
    let cacheHash = `overlay_${generateId()}`;
    try {
        const stat = fs.statSync(overlayPath);
        cacheHash = crypto.createHash('md5').update(`${overlayPath}_${stat.size}_${stat.mtimeMs}_${fps}_${duration}_${trimStart}_${trimEnd}`).digest('hex');
    } catch(e) { /* fallback generates unique id */ }

    const cacheBase = path.join(settings.getSecureTmpDir(), 'videokit_overlay_cache');
    if (!fs.existsSync(cacheBase)) fs.mkdirSync(cacheBase, { recursive: true });
    
    const framesDir = path.join(cacheBase, cacheHash);

    // [缓存击中逻辑]
    if (fs.existsSync(framesDir)) {
        const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
        if (files.length > 0) {
            console.log(`[WYSIWYG-OVERLAY] 覆层缓存命中: ${files.length} 帧 (${framesDir})`);
            return { framesDir, frameCount: files.length };
        }
    } else {
        fs.mkdirSync(framesDir, { recursive: true });
    }

    // 动图/视频原分辨率提取，带流循环，输出为 PNG 保留 Alpha 透明度
    // 只有动图和视频需要提取。对于单张图片不需要走到这一步。
    const args = ['-y'];

    // 如果指定了起止点，则不使用无限循环，而是精确截取
    if (trimStart != null && trimStart !== '') {
        args.push('-ss', String(trimStart));
        let actualTrimDur = parseFloat(duration);
        if (trimEnd != null && trimEnd !== '') {
            actualTrimDur = Math.max(0, parseFloat(trimEnd) - parseFloat(trimStart));
            duration = Math.min(parseFloat(duration), actualTrimDur); // 此时 duration 依然决定了最多提取多少秒
        }
    } else {
        args.push('-stream_loop', '-1');  // 无 trim 时无线循环 
    }

    args.push(
        '-i', overlayPath,
        '-t', String(duration),
        '-r', String(fps),
        '-an',
        `${framesDir}/frame_%06d.png`
    );

    await runFFmpegSync(ffmpeg, args);

    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
    console.log(`[WYSIWYG-OVERLAY] 覆层提取完成: ${files.length} 帧 (${framesDir})`);
    return { framesDir, frameCount: files.length };
}

// ═══════════════════════════════════════════════════════
// 阶段 2: FFmpeg 编码器会话管理
// ═══════════════════════════════════════════════════════

let _cachedGPUProbeResults = {};

/**
 * 探测 GPU 编码器是否可用：试编码 3 帧纯色测试帧
 * 如果 GPU 编码器初始化失败（驱动/硬件不支持），快速返回 false
 */
function _probeGPUEncoder(ffmpegPath, vcodec, encoderArgs, width, height, fps) {
    if (_cachedGPUProbeResults[vcodec] !== undefined) {
        return _cachedGPUProbeResults[vcodec];
    }
    try {
        const settings = require('./settings');
        const testOut = settings.secureTmpFile('gpu_probe', '.mp4');
        const testArgs = [
            '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-i', 'pipe:0',
            '-an',
            ...encoderArgs,
            '-pix_fmt', 'yuv420p',
            '-frames:v', '3',
            testOut,
        ];
        console.log(`[WYSIWYG] 探测 GPU 编码器 (${vcodec})...`);
        const testProc = require('child_process').spawnSync(ffmpegPath, testArgs, {
            input: Buffer.alloc(width * height * 4 * 3), // 3 帧纯黑 RGBA
            timeout: 15000,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        // 清理测试文件
        try { fs.unlinkSync(testOut); } catch (_) { }

        if (testProc.status === 0) {
            console.log(`[WYSIWYG] GPU 编码器 ${vcodec} 可用 ✓`);
            _cachedGPUProbeResults[vcodec] = true;
            return true;
        } else {
            const stderr = (testProc.stderr || '').toString().slice(-500);
            console.warn(`[WYSIWYG] GPU 编码器 ${vcodec} 不可用 (code=${testProc.status}): ${stderr}`);
            _cachedGPUProbeResults[vcodec] = false;
            return false;
        }
    } catch (e) {
        console.warn(`[WYSIWYG] GPU 编码器探测异常: ${e.message}`);
        return false;
    }
}

async function startSession(opts) {
    let {
        width = 1080, height = 1920, fps = 30,
        outputPath, voicePath, voiceVolume = 1.0,
        bgVolume = 0.1, backgroundPath, bgHasAudio = false,
        bgmPath = '', bgmVolume = 0,
        contentVideoPath = '', contentVideoVolume = 1.0,
        audioDurScale = 100,
        reverbEnabled = false, reverbPreset = 'hall', reverbMix = 30, stereoWidth = 100, audioFxTarget = 'all',
        renderedAudioPath = null,
        useGPU = false,
    } = opts;

    // 路径自动修复（与 prepareBg 相同逻辑）
    if (backgroundPath && (!path.isAbsolute(backgroundPath) || !fs.existsSync(backgroundPath))) {
        const bareFileName = path.basename(backgroundPath);
        console.log(`[WYSIWYG-START] 背景路径无效，尝试搜索: "${bareFileName}"`);
        const searchDirs = [
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop'),
            path.join(os.homedir(), 'Documents'),
        ];
        for (const searchDir of searchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            const found = _findFileRecursive(searchDir, bareFileName, 4);
            if (found) {
                console.log(`[WYSIWYG-START] 自动找到: "${found}"`);
                backgroundPath = found;
                break;
            }
        }
    }

    const sessionId = generateId();
    const ffmpeg = findFFmpeg();
    const settings = require('./settings');
    const tempVideo = path.join(settings.getSecureTmpDir(), `reels_wysiwyg_${sessionId}.mp4`);

    // 编码器选择：GPU 硬件加速 vs CPU（带自动回退）
    let encoderArgs;
    const platform = process.platform;
    const qualityPreset = opts.qualityPreset || 'faster';
    const crf = opts.crf || 23;
    const cpuFallbackArgs = ['-c:v', 'libx264', '-preset', qualityPreset, '-crf', String(crf)];
    let gpuFailed = false;

    if (useGPU) {
        if (platform === 'darwin') {
            const gpuArgs = ['-c:v', 'h264_videotoolbox', '-b:v', '12M'];
            if (_probeGPUEncoder(ffmpeg, 'h264_videotoolbox', gpuArgs, width, height, fps)) {
                encoderArgs = gpuArgs;
                console.log(`[WYSIWYG] 使用 GPU 编码 (VideoToolbox, 12Mbps)`);
            } else {
                gpuFailed = true;
            }
        } else if (platform === 'win32') {
            const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-cq', '15', '-b:v', '0'];
            const amfArgs = ['-c:v', 'h264_amf'];
            const qsvArgs = ['-c:v', 'h264_qsv'];
            if (_probeGPUEncoder(ffmpeg, 'h264_nvenc', nvencArgs, width, height, fps)) {
                encoderArgs = nvencArgs;
                console.log(`[WYSIWYG] 使用 GPU 编码 (NVENC, NVIDIA)`);
            } else if (_probeGPUEncoder(ffmpeg, 'h264_amf', amfArgs, width, height, fps)) {
                encoderArgs = amfArgs;
                console.log(`[WYSIWYG] 使用 GPU 编码 (AMF, AMD)`);
            } else if (_probeGPUEncoder(ffmpeg, 'h264_qsv', qsvArgs, width, height, fps)) {
                encoderArgs = qsvArgs;
                console.log(`[WYSIWYG] 使用 GPU 编码 (QSV, Intel)`);
            } else {
                gpuFailed = true;
            }
        }

        if (gpuFailed || !encoderArgs) {
            console.log(`[WYSIWYG] ⚠️ GPU 编码器不可用，自动回退到 CPU (libx264) 编码`);
            encoderArgs = cpuFallbackArgs;
        }
    } else {
        encoderArgs = cpuFallbackArgs;
    }

    let args = ['-y'];

    if (opts.alphaOverlayBgPath) {
        // Fast Alpha Overlay 模式：直接由 FFmpeg 解码背景图像/视频
        const bgExt = require('path').extname(opts.alphaOverlayBgPath).toLowerCase();
        const isAlphaBgImage = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(bgExt);
        if (isAlphaBgImage) {
            args.push('-loop', '1', '-i', opts.alphaOverlayBgPath);
        } else {
            args.push('-stream_loop', '-1', '-i', opts.alphaOverlayBgPath);
        }
        
        args.push(
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-color_range', 'pc',
            '-i', 'pipe:0',
            '-an'
        );

        const filterComplex = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bg];[1:v]scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709,format=yuva420p[fg];[bg][fg]overlay=0:0:format=auto:shortest=1[outv]`;
        args.push('-filter_complex', filterComplex, '-map', '[outv]');

    } else {
        // 传统模式：从管道读取已合成好的全尺寸帧
        args.push(
            '-f', 'rawvideo',
            '-pix_fmt', 'rgba',
            '-s', `${width}x${height}`,
            '-framerate', String(fps),
            '-color_range', 'pc',
            '-i', 'pipe:0',
            '-an',
            '-vf', 'scale=in_range=full:in_color_matrix=bt709:out_range=limited:out_color_matrix=bt709'
        );
    }

    args.push(
        ...encoderArgs,
        '-pix_fmt', 'yuv420p',
        '-color_range', 'tv',
        '-colorspace', 'bt709',
        '-color_primaries', 'bt709',
        '-color_trc', 'bt709',
        '-movflags', '+faststart',
        tempVideo
    );

    console.log(`[WYSIWYG] 启动编码: ${ffmpeg} ${args.join(' ')}`);
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    const session = {
        id: sessionId, proc, tempVideo, outputPath,
        voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio,
        bgmPath, bgmVolume,
        contentVideoPath, contentVideoVolume,
        audioDurScale,
        reverbEnabled, reverbPreset, reverbMix, stereoWidth, audioFxTarget,
        renderedAudioPath,
        width, height, fps,
        stderr: '', frameCount: 0, bytesWritten: 0,
        closed: false, encoderExited: false, encoderExitCode: null,
        gpuFallback: gpuFailed,  // 记录是否发生了 GPU 回退
    };

    if (renderedAudioPath) {
        console.log(`[WYSIWYG] 使用预渲染音频 (Web Audio WYSIWYG): ${renderedAudioPath}`);
    }

    // 防止 FFmpeg 意外退出时 stdin.write 触发 EPIPE 崩溃
    proc.stdin.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
            console.warn(`[WYSIWYG] stdin 管道断开 (${err.code})，FFmpeg 可能已退出`);
        } else {
            console.error(`[WYSIWYG] stdin 错误: ${err.message}`);
        }
    });

    proc.stderr.on('data', (chunk) => {
        session.stderr = (session.stderr + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err) => {
        console.error(`[WYSIWYG] FFmpeg 错误: ${err.message}`);
        session.encoderExited = true;
        session.encoderExitCode = -1;
    });
    proc.on('close', (code) => {
        session.encoderExited = true;
        session.encoderExitCode = code;
        console.log(`[WYSIWYG] FFmpeg 编码退出 (code=${code}), 帧: ${session.frameCount}`);
        if (code !== 0) {
            console.error(`[WYSIWYG] FFmpeg stderr: ${session.stderr.slice(-800)}`);
        }
    });

    sessions.set(sessionId, session);

    // 等待 FFmpeg 进程启动就绪（rawvideo 模式下管道初始化需要时间）
    await new Promise(r => setTimeout(r, 300));
    if (session.encoderExited) {
        console.error(`[WYSIWYG] FFmpeg 启动失败! stderr: ${session.stderr}`);
        sessions.delete(sessionId);
        return null;
    }

    return sessionId;
}

async function writeFrame(sessionId, rawData) {
    const session = sessions.get(sessionId);
    if (!session || session.closed) {
        console.error(`[WYSIWYG] writeFrame: 会话无效 (id=${sessionId})`);
        return { ok: false, error: '编码会话无效或已关闭' };
    }
    if (session.encoderExited) {
        const detail = session.stderr.slice(-500);
        console.error(`[WYSIWYG] writeFrame: FFmpeg 已退出 (code=${session.encoderExitCode}), stderr: ${detail}`);
        return { ok: false, error: `FFmpeg 编码器已退出 (code=${session.encoderExitCode})`, detail };
    }

    try {
        // IPC 传来的数据可能是 ArrayBuffer、Buffer、Uint8Array 或序列化对象
        let buf;
        if (Buffer.isBuffer(rawData)) {
            buf = rawData;
        } else if (rawData instanceof ArrayBuffer || ArrayBuffer.isView(rawData)) {
            buf = Buffer.from(rawData);
        } else if (rawData && rawData.type === 'Buffer' && Array.isArray(rawData.data)) {
            buf = Buffer.from(rawData.data);
        } else if (rawData && typeof rawData === 'object') {
            // Electron IPC 有时将 ArrayBuffer 序列化为普通 object
            buf = Buffer.from(new Uint8Array(Object.values(rawData)));
        } else {
            console.error(`[WYSIWYG] writeFrame: 无法识别的数据类型: ${typeof rawData}`);
            return { ok: false, error: `帧数据格式无法识别 (${typeof rawData})` };
        }

        // 验证帧数据大小（RGBA 数据应 = width * height * 4）
        const expectedSize = session.width * session.height * 4;
        if (buf.length < 100) {
            console.warn(`[WYSIWYG] writeFrame: 帧数据太小 (${buf.length} bytes)，跳过`);
            return { ok: true };
        }
        if (buf.length !== expectedSize && session.frameCount === 0) {
            console.warn(`[WYSIWYG] ⚠️ 首帧数据大小不匹配: 实际 ${buf.length} bytes, 期望 ${expectedSize} bytes (${session.width}x${session.height}x4)`);
        }

        if (session.frameCount === 0) {
            console.log(`[WYSIWYG] 首帧大小: ${(buf.length / 1024 / 1024).toFixed(2)} MB (期望 ${(expectedSize / 1024 / 1024).toFixed(2)} MB)`);
        }

        // 检查 FFmpeg 是否在写入前已退出
        if (session.encoderExited) {
            const detail = session.stderr.slice(-500);
            console.error(`[WYSIWYG] FFmpeg 在写帧前退出! stderr: ${detail}`);
            return { ok: false, error: `FFmpeg 编码器意外退出`, detail };
        }

        const written = session.proc.stdin.write(buf);
        session.frameCount++;
        session.bytesWritten += buf.length;
        if (!written) {
            await new Promise((r) => {
                session.proc.stdin.once('drain', r);
                setTimeout(r, 5000);
            });
        }

        // 写入后检查 FFmpeg 是否还活着（尤其是前几帧，编码器可能延迟初始化失败）
        if (session.frameCount <= 5) {
            await new Promise(r => setTimeout(r, 50)); // 给 FFmpeg 一点处理时间
            if (session.encoderExited && session.encoderExitCode !== 0) {
                const detail = session.stderr.slice(-500);
                console.error(`[WYSIWYG] FFmpeg 在第 ${session.frameCount} 帧后退出! stderr: ${detail}`);
                return { ok: false, error: `FFmpeg 在第 ${session.frameCount} 帧后崩溃退出`, detail };
            }
        }

        return { ok: true };
    } catch (e) {
        console.error(`[WYSIWYG] 写帧失败 (#${session.frameCount}): ${e.message}`);
        if (session.stderr) {
            console.error(`[WYSIWYG] FFmpeg stderr: ${session.stderr.slice(-500)}`);
        }
        return { ok: false, error: `写帧异常: ${e.message}`, detail: session.stderr.slice(-500) };
    }
}

async function finishSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { error: '会话不存在' };
    if (session.closed) return { error: '会话已关闭' };
    session.closed = true;

    const mb = (session.bytesWritten / 1024 / 1024).toFixed(1);
    console.log(`[WYSIWYG] 完成编码... 帧: ${session.frameCount}, 数据: ${mb}MB`);

    // 等待编码器完成
    if (!session.encoderExited) {
        await new Promise((resolve) => {
            try { session.proc.stdin.end(); } catch (_) { }
            const check = () => {
                if (session.encoderExited) { resolve(); return; }
                setTimeout(check, 200);
            };
            check();
            setTimeout(resolve, 120000);
        });
    }

    if (session.encoderExitCode !== 0) {
        cleanup(session);
        return { error: `编码失败 (code=${session.encoderExitCode}): ${session.stderr.slice(-300)}` };
    }

    if (!fs.existsSync(session.tempVideo) || fs.statSync(session.tempVideo).size < 1024) {
        cleanup(session);
        return { error: '临时视频无效' };
    }

    try {
        await mixAudio(session);
        cleanup(session);
        return { output_path: session.outputPath };
    } catch (e) {
        cleanup(session);
        return { error: `音频混合失败: ${e.message}` };
    }
}

// ═══ 脉冲响应预设 — 与预览 batch-reels.js 中 _REVERB_PRESETS 完全相同 ═══
const _IMPULSE_PRESETS = {
    room:   { decay: 0.8, duration: 0.6 },
    hall:   { decay: 2.0, duration: 1.5 },
    church: { decay: 4.0, duration: 3.0 },
    plate:  { decay: 1.2, duration: 1.0 },
    echo:   { decay: 1.5, duration: 0.8 },
};

// 确定性伪随机数（mulberry32）— 与预览 batch-reels.js 完全相同
function _mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function _presetSeed(preset) {
    let h = 0x811c9dc5;
    for (let i = 0; i < preset.length; i++) {
        h ^= preset.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/**
 * 在 Node.js 中生成脉冲响应 WAV 文件
 * 使用与预览完全相同的 seeded PRNG + 算法，保证 IR 一致
 */
function _generateImpulseWav(preset, sampleRate = 44100) {
    const p = _IMPULSE_PRESETS[preset] || _IMPULSE_PRESETS.hall;
    const presetKey = preset || 'hall';
    const length = Math.ceil(sampleRate * p.duration);
    const numChannels = 2;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = length * blockAlign;
    const headerSize = 44;
    const totalSize = headerSize + dataSize;

    const buffer = Buffer.alloc(totalSize);

    // WAV header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(totalSize - 8, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * blockAlign, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    // 逐声道生成 — 与预览完全相同的种子和算法
    // 注意：预览的 Web Audio createBuffer 按声道填充
    // 所以这里也按声道交替写入 WAV 的交错格式
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        const rng = _mulberry32(_presetSeed(presetKey) + ch * 0xDEAD);
        const chData = new Float64Array(length);
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-t / (p.decay * 0.3));
            chData[i] = (rng() * 2 - 1) * envelope;
        }
        channels.push(chData);
    }

    // 写入交错 PCM 数据
    let offset = headerSize;
    for (let i = 0; i < length; i++) {
        for (let ch = 0; ch < numChannels; ch++) {
            const int16 = Math.max(-32768, Math.min(32767, Math.round(channels[ch][i] * 32767)));
            buffer.writeInt16LE(int16, offset);
            offset += bytesPerSample;
        }
    }

    const settings = require('./settings');
    const irPath = settings.secureTmpFile('ir_reverb', '.wav');
    fs.writeFileSync(irPath, buffer);
    return irPath;
}

/**
 * 构建 FFmpeg afir 卷积混响 filter（等价于 Web Audio ConvolverNode）
 * 使用干/湿声混合，与预览的 dryGain/wetGain 逻辑一致
 */
function _buildReverbFilter(session, inputLabel, outputLabel) {
    if (!session.reverbEnabled) return null;
    const mix = Math.max(0, Math.min(100, session.reverbMix || 30)) / 100;
    const dryLevel = (1 - mix * 0.5).toFixed(3);
    const wetLevel = mix.toFixed(3);

    // 生成脉冲响应 WAV
    const irPath = _generateImpulseWav(session.reverbPreset);
    session._irCleanup = irPath;

    // afir 滤镜：干/湿混合
    // 关键：normalize=0 防止 amix 除以输入数（Web Audio 是直接相加）
    const filter = `${inputLabel}asplit=2[dry___][wet___];` +
        `[dry___]volume=${dryLevel}[dryo___];` +
        `[wet___][ir___]afir=dry=0:wet=1[weto___];` +
        `[weto___]volume=${wetLevel}[wetv___];` +
        `[dryo___][wetv___]amix=inputs=2:duration=first:dropout_transition=0:normalize=0${outputLabel}`;

    return { filter, irPath };
}

/**
 * 构建立体声增强 filter（等价于预览的 ChannelSplitter + DelayNode）
 */
function _buildStereoFilter(session, inputLabel, outputLabel) {
    const stereoW = (session.stereoWidth || 100) / 100;
    if (stereoW <= 1.05) return null;

    const widthFactor = Math.max(0, (stereoW - 1)) * 0.015;
    const delayL = Math.round(widthFactor * 0.3 * 1000); // ms
    const delayR = Math.round(widthFactor * 0.7 * 1000); // ms

    return `${inputLabel}channelsplit[l___][r___];` +
        `[l___]adelay=${delayL}|0[ld___];` +
        `[r___]adelay=0|${delayR}[rd___];` +
        `[ld___][rd___]amerge=inputs=2${outputLabel}`;
}

async function mixAudio(session) {
    const ffmpeg = findFFmpeg();

    const outDir = path.dirname(session.outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let { tempVideo, outputPath, voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio, bgmPath, bgmVolume } = session;

    // ═══ Chromium Web Audio 离线渲染（隐藏窗口 — 与预览 100% 同引擎）═══
    let targetPathToRender = null;
    let targetKey = null; // 'voice', 'bg', 'bgm'

    if (session.reverbEnabled || (session.stereoWidth && session.stereoWidth !== 100)) {
       const fxT = session.audioFxTarget || 'all';
       if ((fxT === 'voice' || fxT === 'all') && voicePath) {
           targetPathToRender = voicePath; targetKey = 'voice';
       } else if ((fxT === 'bg' || fxT === 'all') && backgroundPath) {
           targetPathToRender = backgroundPath; targetKey = 'bg';
       } else if ((fxT === 'bgm' || fxT === 'all') && bgmPath) {
           targetPathToRender = bgmPath; targetKey = 'bgm';
       }
    }

    if (targetPathToRender) {
        try {
            const wavResult = await renderChromiumAudioWav({
                filePath: targetPathToRender,
                reverbEnabled: session.reverbEnabled,
                reverbPreset: session.reverbPreset,
                reverbMix: session.reverbMix,
                stereoWidth: session.stereoWidth
            });

            if (wavResult) {
                if (targetKey === 'voice') {
                    voicePath = wavResult;
                    voiceVolume = 1.0;
                    session._renderedVoiceCleanup = wavResult;
                } else if (targetKey === 'bg') {
                    // 重要: backgroundPath 同时是视频源，不能替换为 WAV！
                    // 将渲染后的背景音频存到独立变量，后面作为额外输入混入
                    session._renderedBgAudioPath = wavResult;
                    session._renderedBgCleanup = wavResult;
                    // 标记原始背景音频不再需要（已经被渲染过了）
                    bgHasAudio = false;
                    console.log(`[WYSIWYG] bg 音频已渲染为 WAV: ${wavResult}`);
                } else if (targetKey === 'bgm') {
                    bgmPath = wavResult;
                    session._renderedBgmCleanup = wavResult;
                }

                session.reverbEnabled = false;
                session.stereoWidth = 100;
            } else {
                throw new Error('Chromium render returned null/false');
            }
        } catch (e) {
            console.error(`[WYSIWYG] Chromium Web Audio 渲染失败，回退到 FFmpeg afir:`, e.message);
        }
    }

    // 检测 BGM 是否有效
    const hasBgm = bgmPath && fs.existsSync(bgmPath) && bgmVolume > 0.001;
    // 检测覆层视频音频是否有效
    const cvPath = session.contentVideoPath;
    const cvVol = session.contentVideoVolume ?? 1.0;
    const hasContentVideoAudio = cvPath && fs.existsSync(cvPath) && !isImageMedia(cvPath) && hasAudioTrack(cvPath);
    if (hasContentVideoAudio) console.log(`[WYSIWYG] 覆层视频含音频轨: ${cvPath}`);
    // 检测是否有渲染后的背景音频（bg 层特效渲染产物）
    const renderedBgAudio = session._renderedBgAudioPath && fs.existsSync(session._renderedBgAudioPath)
        ? session._renderedBgAudioPath : null;

    let args;

    if (!voicePath) {
        // 无配音
        const bgVolumeVal = typeof bgVolume === 'number' ? bgVolume : 0.1;
        const wantBgAudio = bgVolumeVal > 0.001;
        const bgReallyHasAudio = wantBgAudio && backgroundPath && fs.existsSync(backgroundPath) && hasAudioTrack(backgroundPath);

        // 收集所有音频源
        let audioInputs = []; // [{path, volume, loop}]
        if (renderedBgAudio) {
            // 渲染后的背景音频（已含特效），不需要 loop
            audioInputs.push({ path: renderedBgAudio, volume: bgVolumeVal, loop: false });
        } else if (bgReallyHasAudio) {
            audioInputs.push({ path: backgroundPath, volume: bgVolumeVal, loop: true });
        }
        if (hasBgm) {
            audioInputs.push({ path: bgmPath, volume: bgmVolume, loop: true });
        }
        if (hasContentVideoAudio) {
            audioInputs.push({ path: cvPath, volume: cvVol, loop: true });
        }

        if (audioInputs.length === 0) {
            console.log('[WYSIWYG] 无配音且无音频源，直接拷贝视频');
            args = ['-y', '-i', tempVideo, '-c:v', 'copy', '-an', '-movflags', '+faststart', outputPath];
        } else {
            console.log(`[WYSIWYG] 无配音，混合 ${audioInputs.length} 个音频源`);
            args = ['-y', '-i', tempVideo];
            let nextIdx = 1;
            for (const ai of audioInputs) {
                if (ai.loop) args.push('-stream_loop', '-1');
                args.push('-i', ai.path);
                nextIdx++;
            }
            let filterParts = [];
            let labels = [];
            audioInputs.forEach((ai, i) => {
                const idx = i + 1;
                const label = `[a${i}]`;
                filterParts.push(`[${idx}:a]volume=${ai.volume.toFixed(3)}${label}`);
                labels.push(label);
            });
            if (labels.length > 1) {
                filterParts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0[aout]`);
            } else {
                filterParts.push(`${labels[0]}acopy[aout]`);
            }
            args.push('-filter_complex', filterParts.join(';'),
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputPath);
        }
    } else {
        args = ['-y', '-i', tempVideo, '-i', voicePath];

        let nextInputIdx = 2;
        const bgVolumeVal2 = typeof bgVolume === 'number' ? bgVolume : 0.1;

        // 渲染后的背景音频（优先于原始背景音轨）
        let renderedBgInputIdx = -1;
        if (renderedBgAudio) {
            args.push('-i', renderedBgAudio);
            renderedBgInputIdx = nextInputIdx;
            nextInputIdx++;
        }

        // 二次验证：即使前端标记 bgHasAudio=true，也用 ffprobe 实际检测是否真有音频轨
        const bgWanted = !renderedBgAudio && bgHasAudio && bgVolumeVal2 > 0.001 && backgroundPath && fs.existsSync(backgroundPath);
        const bgReallyHasAudio = bgWanted ? hasAudioTrack(backgroundPath) : false;
        if (bgWanted && !bgReallyHasAudio) {
            console.log(`[WYSIWYG] 背景视频无音频轨道，跳过背景音频混合: ${backgroundPath}`);
        }
        const bgInputIdx = bgReallyHasAudio ? nextInputIdx : -1;
        if (bgInputIdx >= 0) {
            args.push('-stream_loop', '-1', '-i', backgroundPath);
            nextInputIdx++;
        }
        const bgmInputIdx = hasBgm ? nextInputIdx : -1;
        if (bgmInputIdx >= 0) {
            args.push('-stream_loop', '-1', '-i', bgmPath);
            nextInputIdx++;
        }
        const cvInputIdx = hasContentVideoAudio ? nextInputIdx : -1;
        if (cvInputIdx >= 0) {
            args.push('-stream_loop', '-1', '-i', cvPath);
            nextInputIdx++;
        }

        // 混响需要额外的 IR 文件输入
        let irInputIdx = -1;
        let reverbResult = null;
        if (session.reverbEnabled) {
            reverbResult = _buildReverbFilter(session, '[vpre]', '[vfx]');
            if (reverbResult) {
                args.push('-i', reverbResult.irPath);
                irInputIdx = nextInputIdx;
                nextInputIdx++;
            }
        }

        // 构建音频 filter chain
        let filterParts = [];
        let voiceOutLabel;

        // 人声音量
        filterParts.push(`[1:a]volume=${voiceVolume.toFixed(3)}[vpre]`);

        // 音频变速（atempo）：audioDurScale=150% → 减速为 0.667x（拉长1.5倍）
        const aDurScale = session.audioDurScale || 100;
        if (aDurScale !== 100) {
            let targetTempo = 100 / aDurScale;
            const tempoFilters = [];
            while (targetTempo < 0.5) {
                tempoFilters.push('atempo=0.5');
                targetTempo /= 0.5;
            }
            while (targetTempo > 100.0) {
                tempoFilters.push('atempo=100.0');
                targetTempo /= 100.0;
            }
            tempoFilters.push(`atempo=${targetTempo.toFixed(6)}`);
            filterParts.push(`[vpre]${tempoFilters.join(',')}[vpre]`);
            console.log(`[WYSIWYG] 音频变速: audioDurScale=${aDurScale}%, atempo chain: ${tempoFilters.join(',')}`);
        }

        // 混响
        if (reverbResult) {
            filterParts.push(`[${irInputIdx}:a]aformat=sample_fmts=flt:channel_layouts=stereo[ir___]`);
            filterParts.push(reverbResult.filter);
            voiceOutLabel = '[vfx]';
        } else {
            filterParts.push('[vpre]acopy[vfx]');
            voiceOutLabel = '[vfx]';
        }

        // 立体声增强
        const stereoFilter = _buildStereoFilter(session, voiceOutLabel, '[vstereo]');
        if (stereoFilter) {
            filterParts.push(stereoFilter);
            voiceOutLabel = '[vstereo]';
        }

        // 重命名为 [voice]
        if (voiceOutLabel !== '[voice]') {
            filterParts.push(`${voiceOutLabel}acopy[voice]`);
        }

        let mixLabels = ['[voice]'];

        // 渲染后的背景音频（已含特效）
        if (renderedBgInputIdx >= 0) {
            filterParts.push(`[${renderedBgInputIdx}:a]volume=${bgVolume.toFixed(3)}[rbg]`);
            mixLabels.push('[rbg]');
        }

        // 背景音频（原始，无特效）
        if (bgInputIdx >= 0) {
            filterParts.push(`[${bgInputIdx}:a]volume=${bgVolume.toFixed(3)}[bg]`);
            mixLabels.push('[bg]');
        }

        // BGM
        if (bgmInputIdx >= 0) {
            filterParts.push(`[${bgmInputIdx}:a]volume=${bgmVolume.toFixed(3)}[bgm]`);
            mixLabels.push('[bgm]');
        }

        // 覆层视频音频
        if (cvInputIdx >= 0) {
            filterParts.push(`[${cvInputIdx}:a]volume=${cvVol.toFixed(3)}[cva]`);
            mixLabels.push('[cva]');
        }

        // 最终混合
        if (mixLabels.length > 1) {
            filterParts.push(
                `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=shortest:dropout_transition=0:normalize=0[aout]`
            );
        } else {
            filterParts.push('[voice]acopy[aout]');
        }

        args.push(
            '-filter_complex', filterParts.join(';'),
            '-map', '0:v', '-map', '[aout]',
        );

        args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputPath);
    }

    if (session.reverbEnabled) {
        console.log(`[WYSIWYG] afir 卷积混响: ${session.reverbPreset}, mix=${session.reverbMix}%`);
    }
    if (session.stereoWidth > 100) {
        console.log(`[WYSIWYG] 立体声增强: ${session.stereoWidth}%`);
    }

    console.log(`[WYSIWYG] 混合音频... ${hasBgm ? '(含 BGM)' : ''}`);
    return _runMixFFmpeg(ffmpeg, args, session);
}

function _runMixFFmpeg(ffmpeg, args, session) {
    return new Promise((resolve, reject) => {
        // 打印完整 filter_complex
        const fcIdx = args.indexOf('-filter_complex');
        if (fcIdx >= 0 && args[fcIdx + 1]) {
            console.log(`[WYSIWYG] filter_complex: ${args[fcIdx + 1]}`);
        }
        console.log(`[WYSIWYG] FFmpeg 混音命令: ${args.join(' ').substring(0, 800)}`);
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-3000); });
        proc.on('close', (code) => {
            // 打印 FFmpeg stderr 用于调试
            console.log(`[WYSIWYG] FFmpeg mix stderr (last 500): ${err.slice(-500)}`);
            // 清理临时 IR 文件
            if (session._irCleanup) {
                try { fs.unlinkSync(session._irCleanup); } catch (_) { }
            }
            // 清理临时渲染人声 WAV
            if (session._renderedVoiceCleanup) {
                try { fs.unlinkSync(session._renderedVoiceCleanup); } catch (_) { }
            }
            // 清理临时渲染背景层音频 WAV
            if (session._renderedBgCleanup) {
                try { fs.unlinkSync(session._renderedBgCleanup); } catch (_) { }
            }
            // 清理临时渲染配乐层 WAV
            if (session._renderedBgmCleanup) {
                try { fs.unlinkSync(session._renderedBgmCleanup); } catch (_) { }
            }
            if (code === 0 && fs.existsSync(session.outputPath)) {
                console.log(`[WYSIWYG] 输出: ${session.outputPath} (${(fs.statSync(session.outputPath).size / 1024 / 1024).toFixed(1)}MB)`);
                resolve();
            } else {
                reject(new Error(`混合失败 (code=${code}): ${err.slice(-500)}`));
            }
        });
        proc.on('error', reject);
    });
}

function abortSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    try { session.proc.stdin.destroy(); } catch (_) { }
    try { session.proc.kill('SIGKILL'); } catch (_) { }
    cleanup(session);
}

function cleanup(session) {
    sessions.delete(session.id);
    try {
        if (session.tempVideo && fs.existsSync(session.tempVideo)) fs.unlinkSync(session.tempVideo);
    } catch (_) { }
}

function cleanupBg(framesDir) {
    if (!framesDir || !fs.existsSync(framesDir)) return;
    
    // 覆层的 PNG 序列作为长期重复使用的资源，不在这里直接随临时目录清理（依赖外部应用清理或用户手动清理临时区）
    if (framesDir.includes('videokit_overlay_cache')) {
        return;
    }

    try {
        const files = fs.readdirSync(framesDir);
        for (const f of files) {
            try { fs.unlinkSync(path.join(framesDir, f)); } catch (_) { }
        }
        fs.rmdirSync(framesDir);
        console.log(`[WYSIWYG] 清理帧目录: ${framesDir}`);
    } catch (e) {
        console.warn(`[WYSIWYG] 清理帧目录失败: ${e.message}`);
    }
}

// ═══════════════════════════════════════════════════════
// 阶段 finish-video-only: 仅关闭编码器，不混音（并行切片用）
// ═══════════════════════════════════════════════════════

async function finishVideoOnly(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { error: '会话不存在' };
    if (session.closed) return { error: '会话已关闭' };
    session.closed = true;

    const mb = (session.bytesWritten / 1024 / 1024).toFixed(1);
    console.log(`[WYSIWYG-VO] 完成纯视频编码... 帧: ${session.frameCount}, 数据: ${mb}MB`);

    // 等待编码器完成
    if (!session.encoderExited) {
        await new Promise((resolve) => {
            try { session.proc.stdin.end(); } catch (_) { }
            const check = () => {
                if (session.encoderExited) { resolve(); return; }
                setTimeout(check, 200);
            };
            check();
            setTimeout(resolve, 120000);
        });
    }

    if (session.encoderExitCode !== 0) {
        const err = session.stderr.slice(-300);
        sessions.delete(sessionId);
        return { error: `编码失败 (code=${session.encoderExitCode}): ${err}` };
    }

    if (!fs.existsSync(session.tempVideo) || fs.statSync(session.tempVideo).size < 1024) {
        sessions.delete(sessionId);
        return { error: '临时视频无效' };
    }

    // 不删除 tempVideo! 返回路径供拼接使用
    const videoPath = session.tempVideo;
    sessions.delete(sessionId);
    console.log(`[WYSIWYG-VO] 纯视频输出: ${videoPath} (${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(1)}MB)`);
    return { videoPath };
}

// ═══════════════════════════════════════════════════════
// 并行影子窗口编排器
// ═══════════════════════════════════════════════════════

async function parallelExport(opts, mainWindow) {
    const {
        params,        // 原始导出参数
        outputPath,    // 最终输出路径
        concurrency,   // 并行度
        totalFrames,   // 总帧数
        duration,      // 总时长
    } = opts;

    const { BrowserWindow, ipcMain } = require('electron');
    const settings = require('./settings');
    const ffmpeg = findFFmpeg();

    const fps = params.fps || 30;
    const targetWidth = params.targetWidth || 1080;
    const targetHeight = params.targetHeight || 1920;

    // 计算脚本路径
    const { app } = require('electron');
    let scriptBase;
    if (app.isPackaged) {
        scriptBase = path.join(process.resourcesPath, 'app.asar', 'dist');
        // 如果 asar 里没有，尝试 dist 外部
        if (!fs.existsSync(path.join(scriptBase, 'reels-canvas-renderer.js'))) {
            scriptBase = path.join(path.dirname(process.resourcesPath), 'dist');
        }
    } else {
        scriptBase = path.join(__dirname, '..', '..', 'src');
    }

    // Apply audioDurScale to subtitle segments to keep sync
    const _audioDurFactor = (params.audioDurScale || 100) / 100;
    let _segments = params.segments || [];
    if (_audioDurFactor !== 1.0 && _segments.length > 0) {
        console.log(`[Parallel] 字幕时间戳同步缩放 ×${_audioDurFactor.toFixed(2)}`);
        _segments = _segments.map(seg => ({
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

    const scriptPaths = {
        canvasRenderer: path.join(scriptBase, 'reels-canvas-renderer.js'),
        overlay: path.join(scriptBase, 'reels-overlay.js'),
        animEngine: path.join(scriptBase, 'reels-anim-engine.js'),
    };
    console.log(`[Parallel] 脚本基础路径: ${scriptBase}`);
    console.log(`[Parallel] canvas-renderer 存在: ${fs.existsSync(scriptPaths.canvasRenderer)}`);

    // 切分帧范围
    const framesPerChunk = Math.ceil(totalFrames / concurrency);
    const chunks = [];
    for (let i = 0; i < concurrency; i++) {
        const start = i * framesPerChunk;
        const end = Math.min(start + framesPerChunk, totalFrames);
        if (start >= totalFrames) break;
        chunks.push({ chunkId: i, startFrame: start, endFrame: end });
    }
    console.log(`[Parallel] 切片方案: ${chunks.length} 个切片, ${framesPerChunk} 帧/切片`);

    // 为每个 chunk 创建 FFmpeg 启动参数（纯视频，不含音频）
    const qualityPreset = params.qualityPreset || 'faster';
    const crf = params.crf || 23;

    const chunkResults = new Array(chunks.length).fill(null);
    const progressMap = new Array(chunks.length).fill(0);

    // 创建影子窗口并发渲染
    const htmlPath = path.join(__dirname, '..', 'shadow-renderer.html');

    const shadowPromises = chunks.map((chunk) => {
        return new Promise(async (resolve, reject) => {
            const chunkOutputPath = settings.secureTmpFile(`parallel_chunk_${chunk.chunkId}`, '.mp4');

            // 影子窗口 FFmpeg session params
            const sessionParams = {
                width: targetWidth,
                height: targetHeight,
                fps,
                outputPath: chunkOutputPath,
                // 并行切片模式：强制 CPU 编码，避免 GPU 并发限制
                useGPU: false,
                qualityPreset,
                crf,
            };

            const win = new BrowserWindow({
                show: false, width: 200, height: 200,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                    backgroundThrottling: false,
                    webSecurity: false,
                },
            });

            const timeout = setTimeout(() => {
                console.error(`[Parallel] Chunk ${chunk.chunkId} 超时 (5min)`);
                try { win.close(); } catch(_) {}
                reject(new Error(`Chunk ${chunk.chunkId} 渲染超时`));
            }, 5 * 60 * 1000);

            const onResult = (event, result) => {
                if (result.chunkId !== chunk.chunkId) return;
                clearTimeout(timeout);
                ipcMain.removeListener('chunk-result', onResult);
                ipcMain.removeListener('chunk-progress', onProgress);
                try { win.close(); } catch(_) {}

                if (result.success) {
                    chunkResults[chunk.chunkId] = result.videoPath;
                    resolve(result.videoPath);
                } else {
                    reject(new Error(`Chunk ${chunk.chunkId}: ${result.error}`));
                }
            };

            const onProgress = (event, data) => {
                if (data.chunkId !== chunk.chunkId) return;
                progressMap[chunk.chunkId] = data.pct || 0;
                // 聚合进度发回主窗口
                const avgPct = Math.round(progressMap.reduce((a, b) => a + b, 0) / chunks.length);
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('parallel-export-progress', {
                        pct: 20 + Math.round(avgPct * 0.65),
                        chunkId: data.chunkId,
                        chunkPct: data.pct,
                        fpsActual: data.fpsActual,
                    });
                }
            };

            const onReady = () => {
                ipcMain.removeListener('shadow-renderer-ready', onReady);
                win.webContents.send('render-chunk', {
                    chunkId: chunk.chunkId,
                    scriptPaths,
                    startFrame: chunk.startFrame,
                    endFrame: chunk.endFrame,
                    fps,
                    targetWidth,
                    targetHeight,
                    backgroundPath: params.backgroundPath,
                    bgScale: params.bgScale || 100,
                    loopFade: params.loopFade,
                    loopFadeDur: params.loopFadeDur,
                    style: params.style,
                    segments: _segments,
                    overlays: params.overlays || [],
                    contentVideoPath: params.contentVideoPath,
                    contentVideoTrimStart: params.contentVideoTrimStart,
                    contentVideoTrimEnd: params.contentVideoTrimEnd,
                    contentVideoScale: params.contentVideoScale,
                    contentVideoX: params.contentVideoX,
                    contentVideoY: params.contentVideoY,
                    sessionParams,
                });
            };

            ipcMain.on('chunk-result', onResult);
            ipcMain.on('chunk-progress', onProgress);
            ipcMain.once('shadow-renderer-ready', onReady);

            win.loadFile(htmlPath).catch(reject);
        });
    });

    // 等待所有切片完成
    console.log(`[Parallel] 启动 ${chunks.length} 个影子窗口...`);
    let chunkVideos;
    try {
        chunkVideos = await Promise.all(shadowPromises);
    } catch (e) {
        // 清理已完成的临时文件
        for (const vp of chunkResults) {
            if (vp) try { fs.unlinkSync(vp); } catch(_) {}
        }
        throw e;
    }
    console.log(`[Parallel] 所有切片完成: ${chunkVideos.join(', ')}`);

    // 通知进度
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('parallel-export-progress', { pct: 88, phase: 'concat' });
    }

    // 无损拼接所有切片
    const concatListPath = settings.secureTmpFile('parallel_concat', '.txt');
    const concatContent = chunkVideos.map(v => `file '${v.replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(concatListPath, concatContent, 'utf-8');

    const concatTempVideo = settings.secureTmpFile('parallel_merged', '.mp4');
    const concatArgs = [
        '-y', '-f', 'concat', '-safe', '0',
        '-i', concatListPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        concatTempVideo,
    ];
    console.log(`[Parallel] 拼接: ${ffmpeg} ${concatArgs.join(' ')}`);
    await runFFmpegSync(ffmpeg, concatArgs);

    // 清理切片文件
    for (const vp of chunkVideos) {
        try { fs.unlinkSync(vp); } catch(_) {}
    }
    try { fs.unlinkSync(concatListPath); } catch(_) {}

    // 混合音频
    console.log(`[Parallel] 混合音频到最终输出: ${outputPath}`);
    const pseudoSession = {
        id: 'parallel_final',
        tempVideo: concatTempVideo,
        outputPath,
        voicePath: params.voicePath,
        voiceVolume: params.voiceVolume ?? 1.0,
        bgVolume: params.bgVolume ?? 0.1,
        backgroundPath: params.backgroundPath,
        bgHasAudio: params.bgHasAudio !== false && !_isImageFile_node(params.backgroundPath),
        bgmPath: params.bgmPath || '',
        bgmVolume: params.bgmVolume ?? 0,
        audioDurScale: params.audioDurScale || 100,
        reverbEnabled: params.reverbEnabled || false,
        reverbPreset: params.reverbPreset || 'hall',
        reverbMix: params.reverbMix || 30,
        stereoWidth: params.stereoWidth || 100,
        audioFxTarget: params.audioFxTarget || 'all',
        contentVideoPath: params.contentVideoPath || '',
        contentVideoVolume: params.contentVideoVolume ?? 1.0,
        width: targetWidth,
        height: targetHeight,
        fps,
        stderr: '',
    };

    await mixAudio(pseudoSession);

    // 清理拼接临时文件
    try { fs.unlinkSync(concatTempVideo); } catch(_) {}

    console.log(`[Parallel] ✅ 导出完成: ${outputPath}`);
    return { output_path: outputPath };
}

function _isImageFile_node(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext);
}

// ═══════════════════════════════════════════════════════
// IPC 入口
// ═══════════════════════════════════════════════════════

async function handleWysiwygIPC(action, data) {
    switch (action) {
        case 'probe-gpu': {
            const ffmpeg = findFFmpeg();
            const platform = process.platform;
            if (platform === 'darwin') {
                const ok = _probeGPUEncoder(ffmpeg, 'h264_videotoolbox', ['-c:v', 'h264_videotoolbox', '-b:v', '1M'], 256, 256, 30);
                let chipName = 'Apple VT';
                try {
                    const cpuModel = require('os').cpus()[0].model;
                    if (cpuModel.toLowerCase().includes('apple')) {
                        chipName = cpuModel + ' (VT)';
                    }
                } catch(e) {}
                return { available: ok, name: ok ? chipName : 'CPU' };
            } else if (platform === 'win32') {
                if (_probeGPUEncoder(ffmpeg, 'h264_nvenc', ['-c:v', 'h264_nvenc', '-b:v', '1M'], 256, 256, 30)) return { available: true, name: 'Nvidia NVENC' };
                if (_probeGPUEncoder(ffmpeg, 'h264_amf', ['-c:v', 'h264_amf'], 256, 256, 30)) return { available: true, name: 'AMD AMF' };
                if (_probeGPUEncoder(ffmpeg, 'h264_qsv', ['-c:v', 'h264_qsv'], 256, 256, 30)) return { available: true, name: 'Intel QSV' };
                return { available: false, name: 'CPU' };
            }
            return { available: false, name: 'CPU' };
        }
        case 'prepare-overlay':
            return prepareOverlay(data);
        case 'prepare-bg':
            return prepareBg(data);
        case 'start':
            return startSession(data);
        case 'frame':
            return writeFrame(data.sessionId, data.raw);
        case 'frames': {
            let ok = true;
            for (const f of (data.frames || [])) {
                ok = await writeFrame(data.sessionId, f);
                if (!ok) break;
            }
            return ok;
        }
        case 'finish':
            return finishSession(data.sessionId);
        case 'finish-video-only':
            return finishVideoOnly(data.sessionId);
        case 'abort':
            abortSession(data.sessionId);
            return true;
        case 'cleanup-bg':
            cleanupBg(data.framesDir);
            return true;
        default:
            return { error: `未知动作: ${action}` };
    }
}

async function renderChromiumAudioWav(opts) {
    const { filePath, reverbEnabled, reverbPreset, reverbMix, stereoWidth } = opts;
    const settings = require('./settings');
    const { BrowserWindow, ipcMain } = require('electron');

    console.log('[WYSIWYG] 启动 Chromium Web Audio 隐藏窗口渲染...');
    const renderedWavPath = settings.secureTmpFile('voice_rendered', '.wav');

    const renderWin = new BrowserWindow({
        show: false, width: 100, height: 100,
        webPreferences: {
            nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
        },
    });

    const wavResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Audio render timeout (60s)')), 60000);

        const onResult = (event, result) => {
            clearTimeout(timeout);
            ipcMain.removeListener('render-audio-result', onResult);
            ipcMain.removeListener('audio-renderer-ready', onReady);
            renderWin.close();
            resolve(result);
        };

        const onReady = () => {
            renderWin.webContents.send('render-audio', {
                filePath, reverbEnabled,
                reverbPreset: reverbPreset || 'hall',
                reverbMix: reverbMix || 30,
                stereoWidth: stereoWidth || 100,
            });
        };

        ipcMain.on('render-audio-result', onResult);
        ipcMain.on('audio-renderer-ready', onReady);

        const htmlPath = path.join(__dirname, '..', 'audio-renderer.html');
        renderWin.loadFile(htmlPath).catch(reject);
    });

    if (wavResult.success && wavResult.wavBuffer) {
        fs.writeFileSync(renderedWavPath, wavResult.wavBuffer);
        console.log(`[WYSIWYG] Chromium Web Audio 渲染完成: ${renderedWavPath} (${(wavResult.wavBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
        return renderedWavPath;
    } else {
        throw new Error(wavResult.error || 'Unknown render error');
    }
}

module.exports = { handleWysiwygIPC, renderChromiumAudioWav, parallelExport };
