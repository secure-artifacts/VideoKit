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

const { spawn, execSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const sessions = new Map();

function generateId() {
    return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function findFFmpeg() {
    for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        if (fs.existsSync(p)) return p;
    }
    return 'ffmpeg';
}

function findFFprobe() {
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
        const result = execSync(
            `"${findFFprobe()}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
            { timeout: 15000 }
        ).toString().trim();
        return parseFloat(result) || 0;
    } catch (e) {
        return 0;
    }
}

/** 用 ffprobe 检测文件是否真有音频轨道 */
function hasAudioTrack(filePath) {
    try {
        const result = execSync(
            `"${findFFprobe()}" -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "${filePath}"`,
            { timeout: 10000 }
        ).toString().trim();
        return result.length > 0;
    } catch (e) {
        return false;
    }
}

// ═══════════════════════════════════════════════════════
// 阶段 1: 预处理背景视频 → 提取帧序列
// ═══════════════════════════════════════════════════════

async function prepareBg(opts) {
    const {
        backgroundPath,
        voicePath,
        targetWidth = 1080,
        targetHeight = 1920,
        fps = 30,
        duration,
        loopFade = true,
        loopFadeDur = 1.0,
    } = opts;

    const ffmpeg = findFFmpeg();
    const framesDir = path.join(os.tmpdir(), `reels_bg_${generateId()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    const isImage = isImageMedia(backgroundPath);
    const totalFrames = Math.ceil(duration * fps);
    const scaleCropFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;

    if (isImage) {
        // 图片背景：直接缩放 + 输出一帧（后续代码会重复使用）
        const args = [
            '-y', '-i', backgroundPath,
            '-vf', scaleCropFilter,
            '-frames:v', '1',
            `${framesDir}/frame_000001.jpg`,
        ];
        await runFFmpegSync(ffmpeg, args);
        return { framesDir, frameCount: 1 };
    }

    // 视频背景
    const bgDuration = await getMediaDuration(backgroundPath);
    const fadeEnabled = loopFade && bgDuration > 0;
    const fadeDur = Math.min(loopFadeDur || 1.0, bgDuration * 0.4); // 不超过背景时长40%

    if (fadeEnabled && bgDuration > 0 && duration > bgDuration) {
        // 需要循环 + 淡入淡出（使用 xfade）
        const step = bgDuration - fadeDur;
        const segCount = Math.min(Math.ceil(duration / step) + 1, 20); // 最多20段

        if (segCount >= 2) {
            // 多路输入 + xfade
            const args = ['-y'];
            for (let i = 0; i < segCount; i++) {
                args.push('-i', backgroundPath);
            }

            const filterParts = [`[0:v]${scaleCropFilter},setpts=PTS-STARTPTS[v0]`];
            let prevLabel = 'v0';

            for (let i = 1; i < segCount; i++) {
                const inLabel = `v${i}`;
                const outLabel = i === segCount - 1 ? 'vout' : `vx${i}`;
                const offset = Math.max(0, i * step - 0.01).toFixed(3);
                filterParts.push(`[${i}:v]${scaleCropFilter},setpts=PTS-STARTPTS[${inLabel}]`);
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
                `${framesDir}/frame_%06d.jpg`,
            );

            console.log(`[WYSIWYG-BG] xfade 循环: ${segCount}段, fadeDur=${fadeDur}s`);
            await runFFmpegSync(ffmpeg, args);
        } else {
            // 段数不足，简单循环
            await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration);
        }
    } else {
        // 简单循环（无淡入淡出，或不需要循环）
        await extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration);
    }

    // 统计实际帧数
    const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg'));
    console.log(`[WYSIWYG-BG] 帧提取完成: ${files.length} 帧`);
    return { framesDir, frameCount: files.length };
}

async function extractSimpleLoop(ffmpeg, backgroundPath, framesDir, scaleCropFilter, fps, duration) {
    const args = [
        '-y',
        '-stream_loop', '-1',
        '-i', backgroundPath,
        '-t', String(duration),
        '-vf', scaleCropFilter,
        '-r', String(fps),
        '-an',
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
// 阶段 2: FFmpeg 编码器会话管理
// ═══════════════════════════════════════════════════════

function startSession(opts) {
    const {
        width = 1080, height = 1920, fps = 30,
        outputPath, voicePath, voiceVolume = 1.0,
        bgVolume = 0.1, backgroundPath, bgHasAudio = false,
    } = opts;

    const sessionId = generateId();
    const ffmpeg = findFFmpeg();
    const tempVideo = path.join(os.tmpdir(), `reels_wysiwyg_${sessionId}.mp4`);

    const args = [
        '-y',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-framerate', String(fps),
        '-i', 'pipe:0',
        '-an',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        tempVideo,
    ];

    console.log(`[WYSIWYG] 启动编码: ${ffmpeg} ${args.join(' ')}`);
    const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });

    const session = {
        id: sessionId, proc, tempVideo, outputPath,
        voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio,
        width, height, fps,
        stderr: '', frameCount: 0, bytesWritten: 0,
        closed: false, encoderExited: false, encoderExitCode: null,
    };

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
    });

    sessions.set(sessionId, session);
    return sessionId;
}

async function writeFrame(sessionId, jpegArrayBuffer) {
    const session = sessions.get(sessionId);
    if (!session || session.closed) return false;
    if (session.encoderExited) return false;

    try {
        const buf = Buffer.from(jpegArrayBuffer);
        if (buf.length < 100) return true; // skip tiny frames
        const written = session.proc.stdin.write(buf);
        session.frameCount++;
        session.bytesWritten += buf.length;
        if (!written) {
            await new Promise((r) => {
                session.proc.stdin.once('drain', r);
                setTimeout(r, 3000);
            });
        }
        return true;
    } catch (e) {
        console.error(`[WYSIWYG] 写帧失败 (#${session.frameCount}): ${e.message}`);
        return false;
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

async function mixAudio(session) {
    const ffmpeg = findFFmpeg();
    const { tempVideo, outputPath, voicePath, voiceVolume, bgVolume, backgroundPath, bgHasAudio } = session;

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let args;

    if (!voicePath) {
        // 无配音：用 ffprobe 检测背景是否真有音频轨道
        const bgReallyHasAudio = backgroundPath && fs.existsSync(backgroundPath) && hasAudioTrack(backgroundPath);
        if (bgReallyHasAudio) {
            console.log('[WYSIWYG] 无配音，提取背景音频');
            args = ['-y', '-i', tempVideo, '-stream_loop', '-1', '-i', backgroundPath,
                '-filter_complex', `[1:a]volume=${(bgVolume || 0.1).toFixed(3)}[aout]`,
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputPath];
        } else {
            // 纯视频，无音轨 → 直接拷贝
            console.log('[WYSIWYG] 无配音且背景无音频，直接拷贝视频');
            args = ['-y', '-i', tempVideo, '-c:v', 'copy', '-an', '-movflags', '+faststart', outputPath];
        }
    } else {
        args = ['-y', '-i', tempVideo, '-i', voicePath];

        if (bgHasAudio && backgroundPath && fs.existsSync(backgroundPath)) {
            args.push('-stream_loop', '-1', '-i', backgroundPath);
            args.push(
                '-filter_complex',
                `[1:a]volume=${voiceVolume.toFixed(3)}[voice];[2:a]volume=${bgVolume.toFixed(3)}[bg];[voice][bg]amix=inputs=2:duration=shortest:dropout_transition=0[aout]`,
                '-map', '0:v', '-map', '[aout]',
            );
        } else {
            if (Math.abs(voiceVolume - 1.0) > 0.001) {
                args.push('-filter_complex', `[1:a]volume=${voiceVolume.toFixed(3)}[aout]`,
                    '-map', '0:v', '-map', '[aout]');
            } else {
                args.push('-map', '0:v', '-map', '1:a');
            }
        }

        args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputPath);
    }

    console.log(`[WYSIWYG] 混合音频...`);
    return new Promise((resolve, reject) => {
        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err = (err + d.toString()).slice(-3000); });
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`[WYSIWYG] 输出: ${outputPath} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)}MB)`);
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
// IPC 入口
// ═══════════════════════════════════════════════════════

async function handleWysiwygIPC(action, data) {
    switch (action) {
        case 'prepare-bg':
            return prepareBg(data);
        case 'start':
            return startSession(data);
        case 'frame':
            return writeFrame(data.sessionId, data.jpeg);
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

module.exports = { handleWysiwygIPC };
