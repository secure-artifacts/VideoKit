/**
 * reels-export-engine.js — 导出引擎
 * 
 * 完整移植自 AutoSub_v8 RenderWorker:
 *   - ASS 字幕烧录 (快速模式)
 *   - 全局进度回报
 *   - GPU 加速选项 (VideoToolbox/NVENC)
 *   - 多音轨混合
 *   - 前置片段拼接
 * 
 * 所有导出通过 Electron IPC 调用 FFmpeg。
 * 前端负责生成 ASS/SRT 和构建命令参数。
 */

// ═══════════════════════════════════════════════════════
// 1. Export Modes
// ═══════════════════════════════════════════════════════

const EXPORT_MODES = {
    FAST: 'fast',         // ASS 字幕烧录 (FFmpeg subtitles filter)
    QUALITY: 'quality',   // 高质量 ASS 烧录 (带 force_style)
};

const QUALITY_PRESETS = {
    high: { crf: 15, preset: 'slow', label: '高质量', bitrate: null },
    medium: { crf: 18, preset: 'medium', label: '中等质量', bitrate: null },
    low: { crf: 23, preset: 'fast', label: '快速导出', bitrate: null },
    custom: { crf: 18, preset: 'medium', label: '自定义', bitrate: '8M' },
};

// ═══════════════════════════════════════════════════════
// 2. FFmpeg Command Builder (移植自 RenderWorker)
// ═══════════════════════════════════════════════════════

/**
 * 构建 FFmpeg 字幕烧录命令参数。
 * @param {object} params
 * @param {string} params.videoPath - 输入视频路径
 * @param {string} params.assPath   - ASS 字幕文件路径 (临时文件)
 * @param {string} params.outputPath- 输出文件路径
 * @param {string} params.quality   - 质量预设 key
 * @param {boolean} params.useGPU   - 是否使用 GPU 加速
 * @param {string} params.platform  - 'darwin' | 'win32' | 'linux'
 * @returns {string[]} FFmpeg 命令参数数组
 */
function buildSubtitleBurnCommand(params) {
    const { videoPath, assPath, outputPath, quality = 'medium', useGPU = false, platform = 'darwin' } = params;
    const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;

    // 编码器选择
    let vcodec = 'libx264';
    let preset = q.preset;
    if (useGPU) {
        if (platform === 'darwin') {
            vcodec = 'h264_videotoolbox';
            preset = null; // VideoToolbox 不支持 preset
        } else if (platform === 'win32') {
            // 优先 NVENC(Nvidia)，其次 AMF(AMD)，再次 QSV(Intel)
            // 实际可用性由 ffmpeg-rawvideo 的 _probeGPUEncoder 决定
            // 这里作为 fallback 路径，默认尝试 NVENC
            vcodec = 'h264_nvenc';
            preset = 'p4';
        }
    }

    // Subtitle filter path escaping: normalize backslashes to forward slashes,
    // then escape remaining backslashes, colons, and single-quotes for FFmpeg's libass syntax.
    const escapedAssPath = assPath.split('\\').join('/')
        .replace(/\\/g, '\\\\')
        .replace(/:/g, '\\:')
        .replace(/'/g, "'\\''");
    const subtitleFilter = `subtitles='${escapedAssPath}'`;

    const args = [
        '-y',
        '-i', videoPath,
        '-vf', subtitleFilter,
        '-c:v', vcodec,
    ];

    // 质量参数
    if (vcodec === 'h264_videotoolbox') {
        // VideoToolbox 使用 bitrate 而非 crf
        args.push('-b:v', q.bitrate || '8M');
    } else {
        args.push('-crf', String(q.crf));
        if (preset) args.push('-preset', preset);
    }

    // 通用参数
    args.push(
        '-c:a', 'copy',        // 音频直接拷贝
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-threads', '0',
        outputPath
    );

    return args;
}

/**
 * 构建多音轨混合命令参数。
 * 移植自 AutoSub _mix_audio_tracks
 * 
 * @param {object} params
 * @param {string} params.videoPath - 已烧录字幕的视频路径（或原视频）
 * @param {object[]} params.audioTracks - [{path, start, duration, gainDb, fadeDuration}]
 * @param {string} params.outputPath
 * @param {number} params.sampleRate - 目标采样率
 * @returns {string[]} FFmpeg 命令参数数组
 */
function buildAudioMixCommand(params) {
    const { videoPath, audioTracks = [], outputPath, sampleRate = 48000 } = params;
    if (audioTracks.length === 0) return null;

    const args = ['-y', '-i', videoPath];
    const filterParts = [];

    audioTracks.forEach((track, idx) => {
        args.push('-i', track.path);

        const gainDb = parseFloat(track.gainDb) || 0;
        const trimIn = parseFloat(track.trimIn) || 0;
        const duration = track.duration > 0 ? Math.max(0.01, track.duration) : null;
        const startSec = parseFloat(track.start) || 0;
        const fadeInD = parseFloat(track.fadeInDur) || 0;
        const fadeOutD = parseFloat(track.fadeOutDur) || 0;

        const labelIn = `${idx + 1}:a`;
        const labelOut = `a${idx}`;
        let chain = `[${labelIn}]`;

        // Trim
        if (trimIn > 0 || duration !== null) {
            if (duration !== null) chain += `atrim=start=${trimIn}:duration=${duration},`;
            else chain += `atrim=start=${trimIn},`;
        }

        chain += `asetpts=N/SR/TB,aresample=${sampleRate}`;

        // Gain
        if (gainDb !== 0) chain += `,volume=${gainDb}dB`;

        // Fades
        if (fadeInD > 0) chain += `,afade=t=in:st=0:d=${fadeInD}`;
        if (fadeOutD > 0 && duration !== null) {
            const fadeStart = Math.max(0, duration - fadeOutD);
            chain += `,afade=t=out:st=${fadeStart}:d=${fadeOutD}`;
        }

        // Delay
        if (startSec > 0) {
            const delayMs = Math.round(startSec * 1000);
            chain += `,adelay=${delayMs}|${delayMs}`;
        }

        chain += `[${labelOut}]`;
        filterParts.push(chain);
    });

    let filterComplex;
    if (audioTracks.length === 1) {
        filterComplex = `${filterParts[0]};[a0]anull[aout]`;
    } else {
        const mixInputs = audioTracks.map((_, i) => `[a${i}]`).join('');
        filterComplex = filterParts.join(';') + `;${mixInputs}amix=inputs=${audioTracks.length}:duration=first:dropout_transition=2:normalize=0[aout]`;
    }

    args.push(
        '-filter_complex', filterComplex,
        '-map', '0:v:0',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath
    );

    return args;
}

/**
 * 构建前置片段拼接命令。
 * 移植自 AutoSub _concat_intro_video
 * 
 * @param {object} params
 * @param {string} params.introPath  - 前置视频路径
 * @param {string} params.mainPath   - 主视频路径
 * @param {string} params.outputPath
 * @param {boolean} params.introHasAudio
 * @param {boolean} params.mainHasAudio
 * @returns {string[]} FFmpeg 命令参数数组
 */
function buildConcatCommand(params) {
    const { introPath, mainPath, outputPath, introHasAudio = true, mainHasAudio = true } = params;

    let filterComplex, maps;
    if (introHasAudio && mainHasAudio) {
        filterComplex = '[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]';
        maps = ['-map', '[outv]', '-map', '[outa]'];
    } else {
        filterComplex = '[0:v][1:v]concat=n=2:v=1:a=0[outv]';
        maps = ['-map', '[outv]'];
    }

    const args = [
        '-y',
        '-i', introPath,
        '-i', mainPath,
        '-filter_complex', filterComplex,
        ...maps,
        '-c:v', 'libx264',
        '-crf', '18',
        '-preset', 'medium',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outputPath
    ];

    return args;
}

// ═══════════════════════════════════════════════════════
// 3. Batch Export Controller
// ═══════════════════════════════════════════════════════

/**
 * 批量导出控制器。
 * 管理批量任务队列、进度回报和错误处理。
 */
class ReelsBatchExporter {
    constructor() {
        this.isExporting = false;
        this.currentTask = -1;
        this.totalTasks = 0;
        this.errors = [];
        this.onProgress = null;  // (taskIdx, totalTasks, taskName, percent) => void
        this.onComplete = null;  // (results) => void
        this.onError = null;     // (taskIdx, error) => void
    }

    /**
     * 批量导出。
     * @param {Array} tasks - [{videoPath, segments, fileName}]
     * @param {object} style - 字幕样式
     * @param {object} exportOpts - {outputDir, quality, suffix, useGPU, karaokeHighlight, introPath}
     */
    async exportAll(tasks, style, exportOpts = {}) {
        const {
            outputDir, quality = 'medium', suffix = '_subtitled',
            useGPU = false, karaokeHighlight = false, introPath = null,
        } = exportOpts;

        this.isExporting = true;
        this.currentTask = 0;
        this.totalTasks = tasks.length;
        this.errors = [];

        const results = [];

        for (let i = 0; i < tasks.length; i++) {
            if (!this.isExporting) break; // 取消
            this.currentTask = i;
            const task = tasks[i];
            const baseName = task.fileName.replace(/\.[^.]+$/, '');
            const outputPath = `${outputDir}/${baseName}${suffix}.mp4`;

            if (this.onProgress) {
                this.onProgress(i, tasks.length, task.fileName, 0);
            }

            try {
                // 步骤1：生成 ASS 内容
                let assContent;
                if (window.ReelsSubtitleProcessor) {
                    assContent = ReelsSubtitleProcessor.generateEnhancedASS(
                        task.segments, style, {
                        karaokeHighlight,
                        videoW: 1080,
                        videoH: 1920,
                    }
                    );
                } else {
                    assContent = generateASS(task.segments, style);
                }

                // 步骤2：通过 IPC 写临时 ASS 文件并烧录
                if (window.electronAPI && window.electronAPI.burnSubtitles) {
                    await window.electronAPI.burnSubtitles({
                        videoPath: task.videoPath,
                        assContent,
                        outputPath,
                        crf: (QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium).crf,
                        useGPU,
                    });
                } else {
                    console.warn('[ExportEngine] FFmpeg IPC not available, skipping:', task.fileName);
                }

                // 步骤3：拼接前置片段 (如果有)
                if (introPath && window.electronAPI && window.electronAPI.concatVideo) {
                    const concatOutput = outputPath.replace('.mp4', '_concat.mp4');
                    await window.electronAPI.concatVideo({
                        introPath, mainPath: outputPath, outputPath: concatOutput
                    });
                    // 替换文件
                    if (window.electronAPI.renameFile) {
                        await window.electronAPI.renameFile(concatOutput, outputPath);
                    }
                }

                results.push({ fileName: task.fileName, outputPath, success: true });

                if (this.onProgress) {
                    this.onProgress(i, tasks.length, task.fileName, 100);
                }
            } catch (err) {
                console.error('[ExportEngine] Export failed:', task.fileName, err);
                this.errors.push({ fileName: task.fileName, error: err.message || String(err) });
                results.push({ fileName: task.fileName, success: false, error: err.message });

                if (this.onError) {
                    this.onError(i, err);
                }
            }
        }

        this.isExporting = false;
        if (this.onComplete) {
            this.onComplete(results);
        }

        return results;
    }

    cancel() {
        this.isExporting = false;
    }
}

// ═══════════════════════════════════════════════════════
// 4. Utility: Duration probe via IPC
// ═══════════════════════════════════════════════════════

/**
 * 通过自定义 IPC 或 HTML5 video 获取媒体时长。
 */
async function probeMediaDuration(filePath) {
    // 优先 IPC
    if (window.electronAPI && window.electronAPI.probeDuration) {
        return window.electronAPI.probeDuration(filePath);
    }
    // 降级：HTML5 <video>
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => resolve(video.duration);
        video.onerror = () => resolve(0);
        video.src = filePath.startsWith('/') ? `file://${filePath}` : filePath;
    });
}

/**
 * 检测媒体是否含音频轨。
 */
async function probeHasAudio(filePath) {
    if (window.electronAPI && window.electronAPI.probeHasAudio) {
        return window.electronAPI.probeHasAudio(filePath);
    }
    return true; // 降级：假设有
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsExportEngine = {
    EXPORT_MODES,
    QUALITY_PRESETS,

    // Command builders
    buildSubtitleBurnCommand,
    buildAudioMixCommand,
    buildConcatCommand,

    // Batch controller
    ReelsBatchExporter,

    // Utilities
    probeMediaDuration,
    probeHasAudio,
};

if (typeof window !== 'undefined') window.ReelsExportEngine = ReelsExportEngine;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsExportEngine;
