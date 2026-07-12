/**
 * batch-reels.js — 批量Reels模块主逻辑
 * 
 * 完整移植自 AutoSub_v8 SubtitleStylePanel + FrameRenderer
 * 
 * 功能：
 * - 任务管理 (添加视频+SRT、自动配对、拖拽)
 * - 实时 Canvas 字幕预览 (含动画)
 * - 样式参数双向绑定 (所有 AutoSub 参数)
 * - 预设管理 (保存/加载/删除/导入/导出)
 * - 批量导出 (通过 IPC 调用 FFmpeg)
 */

// ═══════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════

const _reelsState = {
    tasks: [],
    selectedIdx: -1,
    targetWidth: 1080,
    targetHeight: 1920,
    renderer: null,

    previewRAF: null,
    previewFadeVideo: null,
    previewFadeVideoSrc: '',
    isExporting: false,
    lastExportOutputPath: '',
    pendingFiles: { backgrounds: [], audios: [], srts: [], txts: [] },
    backgroundLibrary: [],
    // Overlay interaction state
    overlaySelectedId: null,
    overlayDrag: null,        // { ovId, startX, startY, origX, origY, handle: null|'tl'|'tr'|'bl'|'br'|... }
    // Mock play state for items without media
    mockPlaying: false,
    mockPausedTime: 0,
    mockStartTime: 0,
    previewSeekLock: null,
    // AI watermarks
    watermarks: [],
    // Global subtitle style (when apply-all is enabled)
    globalSubtitleStyle: null,
    // Hook preview state
    hookVideoReady: false,
    hookDuration: 0,
    hookPhase: false, // true = currently in hook phase during playback
    // Content Video Image Sequence Cache
    cvSequence: { path: '', files: [], loadedImages: {} },
    previewMultiBg: { taskId: '', clipIndex: -1, path: '', image: null },
};
window._reelsState = _reelsState;

const REELS_DEFAULT_PRESET_KEY = 'reels_default_preset_name';
const REELS_WATERMARK_STORAGE_KEY = 'reels_watermarks';
const REELS_BACKGROUND_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'webm', 'jpg', 'jpeg', 'png', 'webp']);
const REELS_AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']);
const REELS_TXT_EXTS = new Set(['txt']);
const REELS_MATCH_STOPWORDS = new Set([
    'srt', 'sub', 'subtitle', 'source', 'src', 'audio', 'voice', 'vo',
    'en', 'cn', 'zh', 'ja', 'jp', 'ko', 'kr', 'es', 'de', 'fr', 'pt', 'it', 'ru', 'ar',
    '720p', '1080p', '4k', 'hd', 'fhd', 'mp4', 'mp3', 'wav', 'aac', 'h264', 'h265', 'hevc', 'x264', 'x265',
    'trim', 'cut', 'clip', 'final', 'v1', 'v2', 'v3', 'edit', 'edited', 'render', 'copy', 'out', 'output'
]);

const REELS_FONT_PRESETS = {
    bebashook: {
        label: 'Bebas Neue 标题粗体',
        font_family: 'Bebas Neue',
        font_weight: 800,
        fontsize: 86,
        bold: true,
        italic: false,
        letter_spacing: 1,
    },
    oswald_clean: {
        label: 'Oswald 干净信息流',
        font_family: 'Oswald',
        font_weight: 700,
        fontsize: 74,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    montserrat_modern: {
        label: 'Montserrat 现代通用',
        font_family: 'Montserrat',
        font_weight: 700,
        fontsize: 72,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    playfair_story: {
        label: 'Playfair Display 叙事感',
        font_family: 'Playfair Display',
        font_weight: 700,
        fontsize: 70,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    noto_sans_cn: {
        label: 'Noto Sans SC 中文清晰',
        font_family: 'Noto Sans SC',
        font_weight: 700,
        fontsize: 70,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
    noto_serif_cn: {
        label: 'Noto Serif SC 中文衬线',
        font_family: 'Noto Serif SC',
        font_weight: 700,
        fontsize: 68,
        bold: true,
        italic: false,
        letter_spacing: 0,
    },
};

const REELS_ANIMATION_PRESETS = {
    classic_fade: {
        label: 'Classic Clean · 淡入淡出',
        anim_in_type: 'fade',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.22,
    },
    bold_pop: {
        label: 'Bold Punch · 弹出强调',
        anim_in_type: 'pop',
        anim_in_duration: 0.2,
        anim_out_type: 'fade',
        anim_out_duration: 0.18,
        letter_jump_scale: 1.35,
    },
    karaoke_sweep: {
        label: 'Karaoke Sweep · 卡拉OK',
        anim_in_type: 'fade',
        anim_in_duration: 0.18,
        anim_out_type: 'fade',
        anim_out_duration: 0.16,
        karaoke_highlight: true,
    },
    pop_word: {
        label: 'Pop Word · 逐字放大',
        anim_in_type: 'letter_jump',
        anim_in_duration: 0.26,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        letter_jump_scale: 1.6,
    },
    word_pop_random: {
        label: 'Word Pop Random · 逐词弹出(随机)',
        anim_in_type: 'word_pop_random',
        anim_in_duration: 0.24,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        word_pop_random_min_scale: 0.7,
        word_pop_random_max_scale: 1.34,
        word_pop_random_duration: 0.24,
        word_pop_random_unread_opacity: 0.0,
        word_pop_random_read_opacity: 1.0,
    },
    word_pop_random_pulse: {
        label: 'Word Pop Pulse · 逐词弹出(回弹)',
        anim_in_type: 'word_pop_random_pulse',
        anim_in_duration: 0.24,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        word_pop_random_pulse_min_scale: 1.08,
        word_pop_random_pulse_max_scale: 1.40,
        word_pop_random_pulse_duration: 0.24,
        word_pop_random_unread_opacity: 0.0,
        word_pop_random_read_opacity: 1.0,
    },
    typewriter_story: {
        label: 'Typewriter · 打字机',
        anim_in_type: 'typewriter',
        anim_in_duration: 0.42,
        anim_out_type: 'fade',
        anim_out_duration: 0.26,
    },
    bounce_fun: {
        label: 'Bounce · 逐字弹跳',
        anim_in_type: 'char_bounce',
        anim_in_duration: 0.3,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        char_bounce_height: 24,
    },
    metro_beat: {
        label: 'Rhythm Beat · 节奏逐词',
        anim_in_type: 'metronome',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.2,
        metronome_bpm: 128,
    },
    slide_up_clean: {
        label: 'Slide Up · 上滑入场',
        anim_in_type: 'slide_up',
        anim_in_duration: 0.24,
        anim_out_type: 'slide_down',
        anim_out_duration: 0.2,
    },
    slide_lr: {
        label: 'Slide Left/Right · 横向切入',
        anim_in_type: 'slide_left',
        anim_in_duration: 0.25,
        anim_out_type: 'slide_right',
        anim_out_duration: 0.22,
    },
    floating_soft: {
        label: 'Floating · 轻漂浮',
        anim_in_type: 'floating',
        anim_in_duration: 0.32,
        anim_out_type: 'fade',
        anim_out_duration: 0.24,
        floating_amplitude: 10,
        floating_period: 2.4,
    },
    flash_hook: {
        label: 'Flash Highlight · 闪光开场',
        anim_in_type: 'flash_highlight',
        anim_in_duration: 0.2,
        anim_out_type: 'fade',
        anim_out_duration: 0.18,
        flash_color: '#FFFFFF',
    },
    glow_cinematic: {
        label: 'Holy Glow · 圣光字幕',
        anim_in_type: 'holy_glow',
        anim_in_duration: 0.42,
        anim_out_type: 'fade',
        anim_out_duration: 0.28,
        holy_glow_color: '#FFFFAA',
        holy_glow_radius: 8,
    },
    blur_focus: {
        label: 'Blur To Sharp · 聚焦清晰',
        anim_in_type: 'blur_sharp',
        anim_in_duration: 0.35,
        anim_out_type: 'fade',
        anim_out_duration: 0.24,
        blur_sharp_max: 22,
    },
    bullet_reveal: {
        label: 'Bullet Reveal · 逐行出现',
        anim_in_type: 'bullet_reveal',
        anim_in_duration: 0.28,
        anim_out_type: 'fade',
        anim_out_duration: 0.22,
    },
};

let _reelsHotkeyBound = false;

// ═══════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    _initReelsModule();
});

// Update dataset.rawValue whenever any subtitle-related input element changes
document.addEventListener('input', (e) => {
    if (e.target && e.target.id && e.target.id.startsWith('reels-')) {
        e.target.dataset.rawValue = e.target.value;
    }
});

function _initReelsModule() {
    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = _reelsState.targetWidth || 1080;
        canvas.height = _reelsState.targetHeight || 1920;
        _reelsState.renderer = new ReelsCanvasRenderer(canvas);
    }

    
    // Probe GPU
    setTimeout(async () => {
        try {
            const gpuNameEl = document.getElementById('reels-gpu-name');
            const gpuCheckbox = document.getElementById('reels-use-gpu');
            if (gpuNameEl && window.electronAPI && window.electronAPI.reelsComposeWysiwyg) {
                gpuNameEl.textContent = '(探测中...)';
                const gpuInfo = await window.electronAPI.reelsComposeWysiwyg('probe-gpu');
                if (gpuInfo && !gpuInfo.error) {
                    if (gpuInfo.available) {
                        gpuNameEl.textContent = `(${gpuInfo.name || 'API加载中'})`;
                        gpuNameEl.style.color = '#38bdf8';
                        if (gpuCheckbox && !gpuCheckbox.disabled) gpuCheckbox.checked = true;
                    } else {
                        gpuNameEl.textContent = `(${gpuInfo.name || 'CPU'})`;
                        gpuNameEl.style.color = '#f87171';
                        if (gpuCheckbox) {
                            gpuCheckbox.checked = false;
                        }
                    }
                } else {
                    gpuNameEl.textContent = '(需重启客户端生效)';
                    gpuNameEl.style.color = '#f87171';
                }
            }
        } catch (e) {
            console.warn('Probe GPU failed', e);
        }
    }, 1500);

    const videoInput = document.getElementById('reels-video-input');
    const audioInput = document.getElementById('reels-audio-input');
    const srtInput = document.getElementById('reels-srt-input');
    const txtInput = document.getElementById('reels-txt-input');
    const folderInput = document.getElementById('reels-folder-input');
    if (videoInput) videoInput.addEventListener('change', _onVideoFilesSelected);
    if (audioInput) audioInput.addEventListener('change', _onAudioFilesSelected);
    if (srtInput) srtInput.addEventListener('change', _onSrtFilesSelected);
    if (txtInput) txtInput.addEventListener('change', _onTxtFilesSelected);
    if (folderInput) folderInput.addEventListener('change', _onFolderFilesSelected);

    const taskList = document.getElementById('reels-task-list');
    if (taskList) {
        taskList.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            taskList.style.borderColor = 'var(--accent-color)';
            taskList.style.backgroundColor = 'rgba(233, 69, 96, 0.10)';
            taskList.style.boxShadow = '0 0 0 2px rgba(233, 69, 96, 0.22) inset';
        });
        taskList.addEventListener('dragleave', () => {
            taskList.style.borderColor = '';
            taskList.style.backgroundColor = '';
            taskList.style.boxShadow = '';
        });
        taskList.addEventListener('drop', _onTaskListDrop);
    }

    const seekBar = document.getElementById('reels-preview-seek');
    if (seekBar) {
        seekBar.addEventListener('input', _onSeek);
        seekBar.addEventListener('change', _onSeek);
    }
    const previewLoopEl = document.getElementById('reels-preview-loop');
    if (previewLoopEl) previewLoopEl.addEventListener('change', reelsOnPreviewLoopModeChange);
    const voiceVolumeEl = document.getElementById('reels-voice-volume');
    const bgVolumeEl = document.getElementById('reels-bg-volume');
    const bindMix = (el) => {
        if (!el) return;
        el.addEventListener('input', _applyPreviewAudioMix);
        el.addEventListener('change', _applyPreviewAudioMix);
    };
    bindMix(voiceVolumeEl);
    bindMix(bgVolumeEl);
    _initExportSettingSliders();
    if (bgVolumeEl) {
        const bgVolumeRangeGlobalEl = document.getElementById('reels-bg-volume-range-global');
        const syncInheritedBgVolumeUI = () => {
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const hasCustomBgVol = task && task.bgVideoVolume != null && parseFloat(task.bgVideoVolume) !== 100;
            if (hasCustomBgVol) return;
            const value = _getGlobalBgVolumePercent();
            const range = document.getElementById('reels-bg-volume-range');
            const num = document.getElementById('reels-bg-volume-num');
            if (range) {
                range.value = value;
                range.dataset.isCustom = 'false';
            }
            if (num) {
                num.value = value;
                num.dataset.isCustom = 'false';
            }
        };
        bgVolumeEl.addEventListener('input', syncInheritedBgVolumeUI);
        bgVolumeEl.addEventListener('change', syncInheritedBgVolumeUI);
        if (bgVolumeRangeGlobalEl) {
            bgVolumeRangeGlobalEl.addEventListener('input', syncInheritedBgVolumeUI);
            bgVolumeRangeGlobalEl.addEventListener('change', syncInheritedBgVolumeUI);
        }
    }

    // ── 任务级背景音量控制自定义标记 ──
    const bgVolRange = document.getElementById('reels-bg-volume-range');
    const bgVolNum = document.getElementById('reels-bg-volume-num');
    if (bgVolRange && bgVolNum) {
        const markCustom = () => {
            bgVolRange.dataset.isCustom = 'true';
            bgVolNum.dataset.isCustom = 'true';
            _applyPreviewAudioMix();
        };
        bgVolRange.addEventListener('input', markCustom);
        bgVolNum.addEventListener('input', markCustom);
    }

    // ── 配乐层全局音量与侧边栏联动 ──
    const bgmVolumeEl = document.getElementById('reels-bgm-volume');
    if (bgmVolumeEl) {
        const bgmVolumeRangeGlobalEl = document.getElementById('reels-bgm-volume-range');
        const syncInheritedBgmVolumeUI = () => {
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const hasCustomBgmVol = task && task.bgmVolume != null;
            const value = _getGlobalBgmVolumePercent();
            const range = document.getElementById('reels-bgm-task-volume-range');
            const num = document.getElementById('reels-bgm-task-volume-num');
            if (!hasCustomBgmVol) {
                if (range) {
                    range.value = value;
                    range.dataset.isCustom = 'false';
                }
                if (num) {
                    num.value = value;
                    num.dataset.isCustom = 'false';
                }
            }
            if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
        };
        bgmVolumeEl.addEventListener('input', syncInheritedBgmVolumeUI);
        bgmVolumeEl.addEventListener('change', syncInheritedBgmVolumeUI);
        if (bgmVolumeRangeGlobalEl) {
            bgmVolumeRangeGlobalEl.addEventListener('input', syncInheritedBgmVolumeUI);
            bgmVolumeRangeGlobalEl.addEventListener('change', syncInheritedBgmVolumeUI);
        }
    }

    // ── 任务级配乐音量控制自定义标记 ──
    const bgmVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmVolNum = document.getElementById('reels-bgm-task-volume-num');
    if (bgmVolRange && bgmVolNum) {
        const markBgmCustom = () => {
            bgmVolRange.dataset.isCustom = 'true';
            bgmVolNum.dataset.isCustom = 'true';
            const task = (typeof _getSelectedTask === 'function') ? _getSelectedTask() : null;
            const value = parseFloat(bgmVolNum.value);
            if (task && Number.isFinite(value)) task.bgmVolume = value;
            _applyPreviewAudioMix();
        };
        bgmVolRange.addEventListener('input', markBgmCustom);
        bgmVolNum.addEventListener('input', markBgmCustom);
    }

    // ── 混响 / 立体声控件 ──
    const reverbIds = ['reels-reverb-enabled', 'reels-reverb-preset', 'reels-reverb-mix', 'reels-stereo-width', 'reels-audio-fx-target'];
    for (const rid of reverbIds) {
        const el = document.getElementById(rid);
        if (el) {
            el.addEventListener('change', _applyPreviewAudioMix);
            el.addEventListener('input', _applyPreviewAudioMix);
        }
    }

    const video = document.getElementById('reels-preview-video');
    if (video) {
        video.addEventListener('timeupdate', _onVideoTimeUpdate);
        video.addEventListener('loadedmetadata', _onVideoLoaded);
    }
    const audio = document.getElementById('reels-preview-audio');
    if (audio) {
        audio.addEventListener('timeupdate', _onAudioTimeUpdate);
        audio.addEventListener('loadedmetadata', _onAudioLoaded);
        audio.addEventListener('ended', () => {
            if (_isPreviewLoopEnabled()) return;
            const video = document.getElementById('reels-preview-video');
            if (video) video.pause();
            const fadeVideo = _reelsState.previewFadeVideo;
            if (fadeVideo) fadeVideo.pause();
            // 同步暂停 BGM
            const bgmAudio = _reelsState._bgmAudioEl;
            if (bgmAudio) bgmAudio.pause();
            const btn = document.getElementById('reels-preview-play');
            if (btn) btn.textContent = '▶️';
        });
    }
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (cvVideo) {
        cvVideo.addEventListener('timeupdate', _onCvVideoTimeUpdate);
        cvVideo.addEventListener('loadedmetadata', _onCvVideoLoaded);
        cvVideo.addEventListener('ended', () => {
            if (_isPreviewLoopEnabled()) return;
            const video = document.getElementById('reels-preview-video');
            if (video) video.pause();
            const fadeVideo = _reelsState.previewFadeVideo;
            if (fadeVideo) fadeVideo.pause();
            const audio = document.getElementById('reels-preview-audio');
            if (audio) audio.pause();
            const bgmAudio = _reelsState._bgmAudioEl;
            if (bgmAudio) bgmAudio.pause();
            const btn = document.getElementById('reels-preview-play');
            if (btn) btn.textContent = '▶️';
        });
    }

    // ═══ 创建 BGM 音频元素（隐藏） ═══
    if (!_reelsState._bgmAudioEl) {
        const bgmEl = document.createElement('audio');
        bgmEl.id = 'reels-preview-bgm';
        bgmEl.style.display = 'none';
        bgmEl.loop = _isPreviewLoopEnabled();
        document.body.appendChild(bgmEl);
        _reelsState._bgmAudioEl = bgmEl;
    }
    _applyPreviewLoopMode();

    _reelsRefreshPresetList();
    _reelsApplyDefaultPreset();
    _reelsState.globalSubtitleStyle = _cloneSubtitleStyle(_readStyleFromUI());
    _initReelsFontPresetUI();
    _initReelsAnimationPresetUI();

    // ═══ 字体管理器初始化 ═══
    _initFontManager();

    // ═══ NLE UI 组件初始化 ═══

    // 时间线编辑器
    const tlContainer = document.getElementById('reels-timeline-container');
    if (tlContainer && typeof ReelsTimelineEditor !== 'undefined') {
        _reelsState.timelineEditor = new ReelsTimelineEditor(tlContainer);
        _reelsState.timelineEditor.onSeek = (t, type) => {
            if (window.ReelsPreviewV2?.isOpen?.()) {
                window.ReelsPreviewV2.seek(window.ReelsPreviewV2.timelineToAbsolute(t));
            } else {
                const task = _getSelectedTask();
                const hookDur = _reelsState.hookDuration || 0;
                const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
                const offsetDur = hookDur + coverDur;
                const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
                const absoluteTarget = (t * aDurScale) + offsetDur;
                _onSeek({ absoluteTarget, type });
            }
        };
        _reelsState.timelineEditor.onClipSelect = (ti, ci, clip) => {
            console.log('[Timeline] Selected clip', ti, ci, clip);
            // 选中字幕块时跳转到该字幕的开始时间
            if (clip && clip.start != null) {
                const midTime = (clip.start + (clip.end || clip.start)) / 2;
                if (window.ReelsPreviewV2?.isOpen?.()) {
                    window.ReelsPreviewV2.seek(window.ReelsPreviewV2.timelineToAbsolute(midTime));
                } else {
                    const task = _getSelectedTask();
                    const hookDur = _reelsState.hookDuration || 0;
                    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
                    const offsetDur = hookDur + coverDur;
                    const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
                    const absoluteTarget = (midTime * aDurScale) + offsetDur;
                    _onSeek({ absoluteTarget });
                }
            }
        };
        const syncEditedSubtitleSegment = (seg, newText) => {
            const text = String(newText || '');
            seg.text = text;
            seg.edited_text = text;

            const newWords = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
            if (!Array.isArray(seg.words) || seg.words.length === 0) return;

            if (newWords.length === seg.words.length) {
                seg.words = seg.words.map((w, i) => ({ ...w, word: newWords[i] }));
                return;
            }

            const start = Number(seg.start) || 0;
            const end = Number(seg.end) || start;
            const dur = Math.max(0.001, end - start);
            seg.words = newWords.map((word, i) => ({
                word,
                start: start + dur * (i / Math.max(1, newWords.length)),
                end: start + dur * ((i + 1) / Math.max(1, newWords.length)),
            }));
        };

        // 绑定片段拖拽调整事件 (onClipChange)
        let _clipDragTimer = null;
        _reelsState.timelineEditor.onClipChange = (trackIdx, clipIdx, clip) => {
            const task = _getSelectedTask();
            if (!task || !task.segments) return;
            const track = _reelsState.timelineEditor._tracks[trackIdx];
            if (track && track.type === 'subs') {
                const segIdx = clip._segIdx != null ? clip._segIdx : clipIdx;
                if (segIdx >= 0 && segIdx < task.segments.length) {
                    const seg = task.segments[segIdx];
                    // 更新段落时间
                    seg.start = clip.start;
                    seg.end = clip.end;
                    
                    // 比例缩放内部每个字的时间，确保逐字高亮动画能对齐
                    if (seg.words && seg.words.length > 0) {
                        const dur = Math.max(0.001, seg.end - seg.start);
                        seg.words.forEach((w, i) => {
                            w.start = seg.start + dur * (i / seg.words.length);
                            w.end = seg.start + dur * ((i + 1) / seg.words.length);
                        });
                    }
                    
                    // 节流更新预览画布，避免拖拽卡顿
                    if (!_clipDragTimer && typeof reelsUpdatePreview === 'function') {
                        _clipDragTimer = setTimeout(() => {
                            reelsUpdatePreview();
                            _clipDragTimer = null;
                        }, 50);
                    }
                }
            }
        };

        // 双击字幕编辑后的回写
        _reelsState.timelineEditor.onSubtitleEdit = (trackIdx, clipIdx, newText, oldText, newRanges, styleOverride) => {
            const task = _getSelectedTask();
            if (!task || !task.segments) return;
            // 通过 _segIdx（如有）或 clipIdx 定位到 segment
            const track = _reelsState.timelineEditor._tracks[trackIdx];
            const clip = track && track.clips[clipIdx];
            const segIdx = (clip && clip._segIdx != null) ? clip._segIdx : clipIdx;
            if (segIdx >= 0 && segIdx < task.segments.length) {
                const seg = task.segments[segIdx];
                syncEditedSubtitleSegment(seg, newText);
                // 保存富文本样式范围
                if (newRanges && newRanges.length > 0) {
                    seg.styled_ranges = newRanges;
                    if (clip) clip.styled_ranges = newRanges;
                } else {
                    delete seg.styled_ranges;
                    if (clip) delete clip.styled_ranges;
                }
                if (styleOverride && Object.keys(styleOverride).length > 0) {
                    seg.style_override = styleOverride;
                    if (clip) clip.style_override = styleOverride;
                } else {
                    delete seg.style_override;
                    if (clip) delete clip.style_override;
                }
                
                console.log(`[Timeline] Segment #${segIdx} text/style updated: "${oldText}" → "${newText}"`, newRanges, styleOverride);
                // 刷新预览
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            }
        };
        // 加载默认空轨道
        _reelsState.timelineEditor.setTracks([
            { type: 'video', name: '视频', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'subs', name: '字幕', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'text', name: '文本覆层', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'image', name: '图片覆层', clips: [], locked: false, visible: true, domain: 'visual' },
            { type: 'audio', name: '音频', clips: [], locked: false, visible: true, domain: 'audio' },
        ]);
    }

    // 覆层面板
    const ovPanelRoot = document.getElementById('reels-overlay-panel-root');
    if (ovPanelRoot && typeof ReelsOverlayPanel !== 'undefined') {
        // 创建轻量画布代理，让覆层面板可以管理覆层
        if (!_reelsState.overlayProxy) {
            const ReelsOverlayMod = window.ReelsOverlay;
            const mgr = ReelsOverlayMod ? new ReelsOverlayMod.OverlayManager() : { overlays: [], addOverlay(o) { this.overlays.push(o); return o; }, removeOverlay(id) { this.overlays = this.overlays.filter(o => o.id !== id); }, getOverlay(id) { return this.overlays.find(o => o.id === id) || null; } };
            _reelsState.overlayProxy = {
                overlayMgr: mgr,
                addOverlay(ov) { mgr.addOverlay(ov); },
                removeOverlay(id) { mgr.removeOverlay(id); },
                getSelected() { return null; },
                render() { /* rAF loop handles rendering */ },
                // 回调占位
                onSelect: null,
                onDeselect: null,
                onOverlayChange: null,
            };
        }
        _reelsState.overlayPanel = new ReelsOverlayPanel(ovPanelRoot, _reelsState.overlayProxy);
    }

    reelsUpdatePreview();
    _bindReelsHotkeys();

    // ═══ 覆层预览交互 ═══
    _initOverlayCanvasInteraction();

    // ═══ 预览窗口缩放/平移初始化 ═══
    _initPreviewZoomPan();
    _initReelsExportDefaults();
    _reelsUpdateLastOutputUI('');
    _reelsUpdateExportProgressUI(0, 0);
    _reelsUpdateLastErrorUI('');

    // ═══ 面板拖拽调整宽度 ═══
    _initReelsColumnResize();

    // ═══ Windows Electron: 阻止 Inspector 面板的 mousedown 冒泡到视口 ═══
    // 防止预览视口的平移 handler 在 Windows 上抢夺输入焦点
    const inspectorCol = document.getElementById('reels-col-subtitle');
    if (inspectorCol) {
        inspectorCol.addEventListener('mousedown', (e) => {
            // 仅对面板内的可交互元素阻止冒泡（不拦截标题栏等非输入区域）
            const tag = e.target.tagName;
            if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' ||
                e.target.isContentEditable || e.target.closest('.rop-textarea, .rop-input, .rop-select, .rop-range, .rop-color')) {
                e.stopPropagation();
            }
        });
    }

    // ═══ 内容视频位置控制器 ═══
    _initCvPosControl();
}

// ── 内容视频位置可视化控制器 ──
function _initCvPosControl() {
    const panel = document.getElementById('reels-cv-pos-control');
    if (!panel) return;

    const xVal = document.getElementById('reels-cv-pos-x-val');
    const yVal = document.getElementById('reels-cv-pos-y-val');
    const scaleVal = document.getElementById('reels-cv-pos-scale-val');
    const stepSel = document.getElementById('reels-cv-pos-step');

    // 阻止面板内所有鼠标事件冒泡到预览视口（防止触发画布平移）
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('wheel', (e) => e.stopPropagation());

    // 获取当前选中任务
    function _getTask() {
        return _getSelectedTask ? _getSelectedTask() : (_selectedTask || null);
    }

    // 更新显示值
    function _updateDisplay() {
        const task = _getTask();
        if (!task) return;
        if (xVal) xVal.value = task.contentVideoX || 'center';
        if (yVal) yVal.value = task.contentVideoY || 'center';
        if (scaleVal) scaleVal.value = task.contentVideoScale || 100;
    }

    // X/Y 输入框直接编辑 (回车确认)
    function _onPosInput(axis, el) {
        const task = _getTask();
        if (!task) return;
        const val = el.value.trim() || 'center';
        if (axis === 'x') task.contentVideoX = val;
        else task.contentVideoY = val;
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }
    if (xVal) xVal.addEventListener('change', () => _onPosInput('x', xVal));
    if (yVal) yVal.addEventListener('change', () => _onPosInput('y', yVal));

    // 缩放输入框直接编辑
    if (scaleVal) scaleVal.addEventListener('change', () => {
        const task = _getTask();
        if (!task) return;
        let v = parseInt(scaleVal.value) || 100;
        if (v < 1) v = 1;
        if (v > 1000) v = 1000;
        task.contentVideoScale = v;
        scaleVal.value = v;
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    });

    // ── 拖拽调整数值 (Scrub Drag) ──
    // 鼠标按住输入框后左右拖动 → 增减数值，类似 AE / Blender
    function _initScrubDrag(el, axis) {
        let _dragging = false;
        let _startX = 0;
        let _startVal = 0;
        let _moved = false;

        el.addEventListener('mousedown', (e) => {
            // 阻止冒泡到预览视口的拖拽/平移处理器
            e.stopPropagation();
            // 如果输入框正在编辑模式（有选中文本），不启动拖拽
            if (document.activeElement === el && el.selectionStart !== el.selectionEnd) return;

            _dragging = true;
            _moved = false;
            _startX = e.clientX;
            const task = _getTask();
            if (!task) return;
            const raw = axis === 'x' ? task.contentVideoX : task.contentVideoY;
            _startVal = (raw && raw !== 'center') ? (parseFloat(raw) || 0) : 0;

            // 防止拖拽时选中文本
            e.preventDefault();
            el.blur();
            document.body.style.cursor = 'ew-resize';
            el.style.borderColor = 'rgba(100,160,255,0.6)';
            el.style.background = 'rgba(100,160,255,0.15)';

            const onMove = (me) => {
                if (!_dragging) return;
                const dx = me.clientX - _startX;
                if (Math.abs(dx) > 2) _moved = true;
                if (!_moved) return;

                // 灵敏度：每像素移动 = step 值的比例
                const step = parseInt(stepSel?.value || '50');
                const sensitivity = step / 20; // 移动20px = 1个step
                const newVal = Math.round(_startVal + dx * sensitivity);

                const task = _getTask();
                if (!task) return;
                if (axis === 'x') task.contentVideoX = newVal === 0 ? 'center' : String(newVal);
                else task.contentVideoY = newVal === 0 ? 'center' : String(newVal);

                _updateDisplay();
                _syncToTableInputs(task);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            };

            const onUp = () => {
                _dragging = false;
                document.body.style.cursor = '';
                el.style.borderColor = '#333';
                el.style.background = '#1a1a2e';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);

                // 如果没有拖拽（纯点击），聚焦让用户直接输入
                if (!_moved) {
                    el.style.cursor = 'text';
                    el.focus();
                    el.select();
                    // 失焦后恢复拖拽游标
                    el.addEventListener('blur', () => { el.style.cursor = 'ew-resize'; }, { once: true });
                }
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    if (xVal) _initScrubDrag(xVal, 'x');
    if (yVal) _initScrubDrag(yVal, 'y');

    // ── 缩放拖拽调整 (Scrub Drag for Scale) ──
    if (scaleVal) {
        let _sDragging = false, _sStartX = 0, _sStartVal = 100, _sMoved = false;
        scaleVal.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === scaleVal && scaleVal.selectionStart !== scaleVal.selectionEnd) return;
            _sDragging = true; _sMoved = false; _sStartX = e.clientX;
            const task = _getTask();
            _sStartVal = task ? (task.contentVideoScale || 100) : 100;
            e.preventDefault(); scaleVal.blur();
            document.body.style.cursor = 'ew-resize';
            scaleVal.style.borderColor = 'rgba(100,160,255,0.6)';
            scaleVal.style.background = 'rgba(100,160,255,0.15)';

            const onMove = (me) => {
                if (!_sDragging) return;
                const dx = me.clientX - _sStartX;
                if (Math.abs(dx) > 2) _sMoved = true;
                if (!_sMoved) return;
                // 灵敏度: 拖拽20px = 变化10%
                const newVal = Math.max(1, Math.min(1000, Math.round(_sStartVal + dx * 0.5)));
                const task = _getTask();
                if (!task) return;
                task.contentVideoScale = newVal;
                scaleVal.value = newVal;
                _syncToTableInputs(task);
                if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
            };
            const onUp = () => {
                _sDragging = false;
                document.body.style.cursor = '';
                scaleVal.style.borderColor = '#333'; scaleVal.style.background = '#1a1a2e';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (!_sMoved) {
                    scaleVal.style.cursor = 'text'; scaleVal.focus(); scaleVal.select();
                    scaleVal.addEventListener('blur', () => { scaleVal.style.cursor = 'ew-resize'; }, { once: true });
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    // 缩放重置按钮
    const scaleResetBtn = document.getElementById('reels-cv-scale-reset');
    if (scaleResetBtn) scaleResetBtn.addEventListener('click', () => {
        const task = _getTask();
        if (!task) return;
        task.contentVideoScale = 100;
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    });

    // 将修改同步回批量表格的输入框和侧边栏
    function _syncToTableInputs(task) {
        if (!task || !window._reelsState) return;
        const idx = window._reelsState.tasks ? window._reelsState.tasks.indexOf(task) : -1;
        if (idx < 0) return;
        const xInput = document.querySelector(`.rbt-cvpos-x[data-idx="${idx}"]`);
        const yInput = document.querySelector(`.rbt-cvpos-y[data-idx="${idx}"]`);
        if (xInput) xInput.value = task.contentVideoX || 'center';
        if (yInput) yInput.value = task.contentVideoY || 'center';

        const scaleVal = task.contentVideoScale || 100;
        const scaleSlider = document.querySelector(`.rbt-cvscale-slider[data-idx="${idx}"]`);
        const scaleInput = document.querySelector(`.rbt-cvscale-input[data-idx="${idx}"]`);
        const scaleDisplay = document.querySelector(`.rbt-col-cvscale[data-idx="${idx}"] .rbt-scale-display`) || (document.querySelectorAll(`.rbt-col-cvscale`)[idx] ? document.querySelectorAll(`.rbt-col-cvscale`)[idx].querySelector('.rbt-scale-display') : null);
        if (scaleSlider) scaleSlider.value = scaleVal;
        if (scaleInput) scaleInput.value = scaleVal;
        if (scaleDisplay) scaleDisplay.textContent = scaleVal + '%';

        if (window.reelsSyncBackgroundTabUI) {
            window.reelsSyncBackgroundTabUI(task);
        }
    }

    // 移动位置
    function _nudge(dir) {
        const task = _getTask();
        if (!task || !task.contentVideoPath) return;
        const step = parseInt(stepSel?.value || '50');

        // 解析当前像素值 (center 视为 0)
        let cx = 0, cy = 0;
        if (task.contentVideoX && task.contentVideoX !== 'center') {
            cx = parseFloat(task.contentVideoX) || 0;
        }
        if (task.contentVideoY && task.contentVideoY !== 'center') {
            cy = parseFloat(task.contentVideoY) || 0;
        }

        switch (dir) {
            case 'up':    cy -= step; break;
            case 'down':  cy += step; break;
            case 'left':  cx -= step; break;
            case 'right': cx += step; break;
        }

        task.contentVideoX = cx === 0 ? 'center' : String(cx);
        task.contentVideoY = cy === 0 ? 'center' : String(cy);
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    // 重置为居中
    function _resetPos() {
        const task = _getTask();
        if (!task) return;
        task.contentVideoX = 'center';
        task.contentVideoY = 'center';
        _updateDisplay();
        _syncToTableInputs(task);
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }

    // 绑定方向按钮
    panel.querySelectorAll('.reels-cv-dir-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            _nudge(btn.dataset.dir);
        });
        // 长按连续移动
        let _holdTimer = null;
        btn.addEventListener('mousedown', () => {
            _holdTimer = setInterval(() => _nudge(btn.dataset.dir), 120);
        });
        btn.addEventListener('mouseup', () => { clearInterval(_holdTimer); _holdTimer = null; });
        btn.addEventListener('mouseleave', () => { clearInterval(_holdTimer); _holdTimer = null; });
    });

    // 居中按钮
    const centerBtn = document.getElementById('reels-cv-pos-center-btn');
    if (centerBtn) centerBtn.addEventListener('click', _resetPos);

    // 重置按钮
    const resetBtn = document.getElementById('reels-cv-pos-reset');
    if (resetBtn) resetBtn.addEventListener('click', _resetPos);

    // 键盘方向键支持 (当控制器面板有焦点时)
    panel.addEventListener('keydown', (e) => {
        const keyMap = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
        if (keyMap[e.key]) {
            e.preventDefault();
            e.stopPropagation();
            _nudge(keyMap[e.key]);
        }
    });
    panel.tabIndex = 0; // 使其可聚焦以接收键盘事件

    // 控制器显示/隐藏: 按钮仅在有内容视频时显示，面板由用户手动开关
    const toggleBtn = document.getElementById('reels-cv-pos-toggle');
    setInterval(() => {
        const task = _getTask();
        const hasCV = task && task.contentVideoPath;
        // 仅控制 toggle 按钮的可见性
        if (toggleBtn) toggleBtn.style.display = hasCV ? '' : 'none';
        // 没有内容视频时自动隐藏面板
        if (!hasCV && panel.style.display !== 'none') {
            panel.style.display = 'none';
            if (toggleBtn) { toggleBtn.style.background = 'rgba(100,160,255,0.1)'; toggleBtn.style.color = '#8af'; }
        }
        // 面板打开时更新值
        if (hasCV && panel.style.display !== 'none') _updateDisplay();
    }, 500);
}

function _initReelsColumnResize() {
    const handles = document.querySelectorAll('.reels-resize-handle');
    if (!handles.length) return;

    // Restore saved widths
    const saved = localStorage.getItem('reels-col-widths');
    if (saved) {
        try {
            const widths = JSON.parse(saved);
            for (const [id, w] of Object.entries(widths)) {
                const el = document.getElementById(id);
                if (el && el.id !== 'reels-col-preview') {
                    el.style.width = w + 'px';
                    el.style.flex = 'none';
                }
            }
        } catch (e) { }
    }

    handles.forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
            // 仅响鼠标左键/主键
            if (e.button !== 0) return;
            e.preventDefault();

            // 使用 Pointer Capture 锁定事件
            try {
                handle.setPointerCapture(e.pointerId);
            } catch (err) {
                console.warn('[Resize] Failed to setPointerCapture:', err);
            }

            const leftId = handle.dataset.left;
            const rightId = handle.dataset.right;
            const leftEl = document.getElementById(leftId);
            const rightEl = document.getElementById(rightId);
            if (!leftEl || !rightEl) return;

            handle.classList.add('active');
            const startX = e.clientX;
            const leftW0 = leftEl.getBoundingClientRect().width;
            const rightW0 = rightEl.getBoundingClientRect().width;
            const leftMin = parseInt(getComputedStyle(leftEl).minWidth) || 100;
            const rightMin = parseInt(getComputedStyle(rightEl).minWidth) || 100;

            let _cleanedUp = false;

            const onMove = (ev) => {
                // 兜底：如果检测到没有按键被按下，说明早已松手，主动清理状态
                if (ev.buttons === 0) {
                    onUp();
                    return;
                }

                const dx = ev.clientX - startX;
                const newLeft = Math.max(leftMin, leftW0 + dx);
                const newRight = Math.max(rightMin, rightW0 - dx);
                // Only apply if both panels stay above minimum
                if (newLeft >= leftMin && newRight >= rightMin) {
                    leftEl.style.width = newLeft + 'px';
                    leftEl.style.flex = 'none';
                    // For the preview (flex:1) column, set flex instead
                    if (rightId === 'reels-col-preview') {
                        rightEl.style.flex = '1';
                    } else {
                        rightEl.style.width = newRight + 'px';
                        rightEl.style.flex = 'none';
                    }
                    if (leftId === 'reels-col-preview') {
                        leftEl.style.flex = '1';
                    }
                }
            };

            const onUp = () => {
                if (_cleanedUp) return;
                _cleanedUp = true;
                handle.classList.remove('active');

                // 释放 Pointer Capture
                try {
                    if (handle.hasPointerCapture(e.pointerId)) {
                        handle.releasePointerCapture(e.pointerId);
                    }
                } catch (err) {}

                // 注销 Pointer 事件监听
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup', onUp);
                handle.removeEventListener('pointercancel', onUp);
                handle.removeEventListener('lostpointercapture', onUp);
                window.removeEventListener('blur', onUp);
                document.removeEventListener('visibilitychange', onUp);

                // Save column widths
                const cols = {};
                ['reels-col-tasks', 'reels-col-subtitle'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) cols[id] = Math.round(el.getBoundingClientRect().width);
                });
                localStorage.setItem('reels-col-widths', JSON.stringify(cols));
            };

            // 全套 Pointer 监听注册到 handle 自身
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
            handle.addEventListener('lostpointercapture', onUp);
            
            // 安全网：失焦/隐藏时强制清理
            window.addEventListener('blur', onUp);
            document.addEventListener('visibilitychange', onUp);
        });
    });
}

async function _getSystemDownloadsPath() {
    // 优先使用设置页面自定义的默认输出目录
    const custom = localStorage.getItem('vk_default_output_dir');
    if (custom) return custom;
    try {
        if (window.electronAPI && typeof window.electronAPI.getDownloadsPath === 'function') {
            const p = await window.electronAPI.getDownloadsPath();
            if (p) return p;
        }
    } catch (e) { }
    return '~/Downloads';
}

async function _initReelsExportDefaults() {
    const outputEl = document.getElementById('reels-output-dir');
    if (outputEl && !outputEl.value) {
        outputEl.value = await _getSystemDownloadsPath();
    }
    
    // Initialize export naming mode dropdown (outer)
    const namingModeOuter = document.getElementById('reels-export-naming-mode-outer');
    const namingConfigBtnOuter = document.getElementById('reels-export-naming-config-btn');
    const updateGearVisibility = (val) => {
        if (namingConfigBtnOuter) {
            namingConfigBtnOuter.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
        const namingConfigBtnInner = document.getElementById('reels-naming-config-btn');
        if (namingConfigBtnInner) {
            namingConfigBtnInner.style.display = (val === 'index' || val === 'date-auto') ? 'inline-block' : 'none';
        }
    };

    if (namingModeOuter) {
        const storedVal = localStorage.getItem('reels_naming_mode') || 'text';
        namingModeOuter.value = storedVal;
        updateGearVisibility(storedVal);
        
        // Add change event listener for synchronization
        namingModeOuter.addEventListener('change', async (e) => {
            const val = e.target.value || 'text';
            localStorage.setItem('reels_naming_mode', val);
            const innerSelect = document.getElementById('reels-naming-mode');
            if (innerSelect) {
                innerSelect.value = val;
            }
            updateGearVisibility(val);
            if (val === 'index' || val === 'date-auto') {
                const ok = await showNamingSettingsDialog(val);
                if (!ok) {
                    localStorage.setItem('reels_naming_mode', 'text');
                    namingModeOuter.value = 'text';
                    if (innerSelect) innerSelect.value = 'text';
                    updateGearVisibility('text');
                }
            }
        });
    }

    if (namingConfigBtnOuter) {
        namingConfigBtnOuter.addEventListener('click', () => {
            const mode = localStorage.getItem('reels_naming_mode') || 'text';
            if (mode === 'index' || mode === 'date-auto') {
                showNamingSettingsDialog(mode);
            }
        });
    }
}

function _bindReelsHotkeys() {
    if (_reelsHotkeyBound) return;
    _reelsHotkeyBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Space') return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
        const panel = document.getElementById('batch-reels-panel');
        if (!panel || !panel.classList.contains('active')) return;
        // V2 有自己的播放器和空格键处理，避免一次按键同时切换两套预览。
        if (window.ReelsPreviewV2?.isOpen?.()) return;
        e.preventDefault();
        reelsTogglePlay();
    });

    // Delete key removes selected overlay
    document.addEventListener('keydown', (e) => {
        if (e.code !== 'Delete' && e.code !== 'Backspace') return;
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
        if (!_isReelsPanelActive()) return;
        if (!_reelsState.overlaySelectedId) return;
        e.preventDefault();
        const proxy = _reelsState.overlayProxy;
        if (proxy) {
            proxy.removeOverlay(_reelsState.overlaySelectedId);
            _reelsState.overlaySelectedId = null;
            if (_reelsState.overlayPanel) {
                _reelsState.overlayPanel.deselectOverlay();
                _reelsState.overlayPanel._refreshList();
            }
        }
    });
}

// ═══════════════════════════════════════════════════════
// Overlay canvas interaction (drag, select, resize)
// ═══════════════════════════════════════════════════════

const _OV_HANDLE_SIZE = 12; // px in canvas coordinates

function _initOverlayCanvasInteraction() {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas) return;

    canvas.addEventListener('mousedown', _ovOnMouseDown);
    canvas.addEventListener('mousemove', _ovOnMouseMove);
    canvas.addEventListener('mouseup', _ovOnMouseUp);
    canvas.addEventListener('mouseleave', _ovOnMouseUp);
}

/** Convert client (screen) coordinates → canvas logical coordinates */
function _clientToCanvas(clientX, clientY) {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    // The canvas is 1080x1920 logical, but displayed at rect.width x rect.height
    // Plus there's zoom/pan on the container
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY,
    };
}

/** Get the bounding box of an overlay in canvas coords */
function _ovGetBounds(ov) {
    const w = parseFloat(ov.w || 100);
    let x = parseFloat(ov.x || 0);
    let y, h;
    if (ov.type === 'textcard' && ov._renderedY != null) {
        y = ov._renderedY;
        h = ov._renderedH || 100;
    } else {
        y = parseFloat(ov.y || 0);
        h = parseFloat(ov.h || 100);
    }
    if (ov.anim_dest_enabled && ov.type !== 'scroll') {
        const start = parseFloat(ov.start || 0);
        const end = parseFloat(ov.end || 0);
        if (end > start) {
            const canvas = document.getElementById('reels-preview-canvas');
            const canvasW = (canvas && canvas.width) ? canvas.width : (_reelsState.targetWidth || 1080);
            const canvasH = (canvas && canvas.height) ? canvas.height : (_reelsState.targetHeight || 1920);

            const readAnimNumber = (value, fallback) => {
                const n = parseFloat(value);
                return Number.isFinite(n) ? n : fallback;
            };
            const fallbackStartX = (x + w / 2) - canvasW / 2;
            const fallbackStartY = (y + h / 2) - canvasH / 2;
            const startPointX = readAnimNumber(ov.anim_start_x, fallbackStartX);
            const startPointY = readAnimNumber(ov.anim_start_y, fallbackStartY);
            const endPointX = readAnimNumber(ov.anim_end_x, startPointX);
            const endPointY = readAnimNumber(ov.anim_end_y, startPointY);
            const fallbackDuration = (end >= 9999) ? 5.0 : (end - start);
            const explicitDuration = parseFloat(ov.anim_duration || 0);
            const speed = parseFloat(ov.anim_speed || 0);
            const distance = Math.hypot(endPointX - startPointX, endPointY - startPointY);
            const animDuration = (ov.anim_timing_mode === 'speed' && speed > 0)
                ? Math.max(0.001, distance / speed)
                : (explicitDuration > 0 ? explicitDuration : fallbackDuration);
            const now = (typeof _getPreviewCurrentTime === 'function') ? _getPreviewCurrentTime() : start;
            let p = Math.max(0, Math.min(1, (now - start) / Math.max(0.001, animDuration)));
            if (ov._previewAtEnd) p = 1;
            const easingName = ov.anim_easing || 'ease_in_out_quad';
            const easingFn = window.ReelsAnimEngine
                ? (window.ReelsAnimEngine.EASING_MAP[easingName] || window.ReelsAnimEngine.EASING_MAP.ease_in_out_quad)
                : null;
            const easedP = easingFn ? easingFn(p) : p;
            const pointX = startPointX + (endPointX - startPointX) * easedP;
            const pointY = startPointY + (endPointY - startPointY) * easedP;
            x = canvasW / 2 + pointX - w / 2;
            y = canvasH / 2 + pointY - h / 2;
        }
    }
    return { x, y, w, h };
}

/** Check if point hits one of the 8 resize handles. Returns handle name or null */
function _ovHitHandle(mx, my, bounds) {
    const hs = _OV_HANDLE_SIZE;
    const { x, y, w, h } = bounds;
    const handles = {
        'tl': { cx: x, cy: y },
        'tc': { cx: x + w / 2, cy: y },
        'tr': { cx: x + w, cy: y },
        'ml': { cx: x, cy: y + h / 2 },
        'mr': { cx: x + w, cy: y + h / 2 },
        'bl': { cx: x, cy: y + h },
        'bc': { cx: x + w / 2, cy: y + h },
        'br': { cx: x + w, cy: y + h },
    };
    for (const [name, pos] of Object.entries(handles)) {
        if (Math.abs(mx - pos.cx) <= hs && Math.abs(my - pos.cy) <= hs) {
            return name;
        }
    }
    return null;
}

function _ovOnMouseDown(e) {
    if (e.button !== 0) return; // left click only
    const proxy = _reelsState.overlayProxy;
    if (!proxy || !proxy.overlayMgr) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const overlays = proxy.overlayMgr.overlays || [];

    // 1. If already selected, check if clicking a resize handle
    if (_reelsState.overlaySelectedId) {
        const selOv = overlays.find(o => o.id === _reelsState.overlaySelectedId);
        if (selOv) {
            const bounds = _ovGetBounds(selOv);
            const handle = _ovHitHandle(mx, my, bounds);
            if (handle) {
                _reelsState.overlayDrag = {
                    ovId: selOv.id,
                    startX: mx, startY: my,
                    origX: selOv.x, origY: selOv.y, origW: selOv.w, origH: selOv.h || selOv._renderedH || 100,
                    handle,
                };
                e.stopPropagation();
                return;
            }
        }
    }

    // 2. Hit test all overlays (reverse z-order: topmost first)
    let hit = null;
    for (let i = overlays.length - 1; i >= 0; i--) {
        const ov = overlays[i];
        const bounds = _ovGetBounds(ov);
        if (mx >= bounds.x && mx <= bounds.x + bounds.w && my >= bounds.y && my <= bounds.y + bounds.h) {
            hit = ov;
            break;
        }
    }

    if (hit) {
        _reelsState.overlaySelectedId = hit.id;
        _reelsState.overlayDrag = {
            ovId: hit.id,
            startX: mx, startY: my,
            origX: hit.x, origY: hit.y, origW: hit.w, origH: hit.h || hit._renderedH || 100,
            handle: null, // move mode
        };
        // Sync with overlay panel
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.selectOverlay(hit);
        }
        e.stopPropagation();
    } else {
        // Deselect
        _reelsState.overlaySelectedId = null;
        _reelsState.overlayDrag = null;
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.deselectOverlay();
        }
    }
}

function _ovOnMouseMove(e) {
    const drag = _reelsState.overlayDrag;
    if (!drag) {
        // Update cursor based on hover
        _ovUpdateCursor(e);
        return;
    }
    if (e.buttons === 0) { // mouse released outside
        _reelsState.overlayDrag = null;
        return;
    }

    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === drag.ovId);
    if (!ov) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const dx = mx - drag.startX;
    const dy = my - drag.startY;

    if (!drag.handle) {
        // Move
        ov.x = drag.origX + dx;
        ov.y = drag.origY + dy;
        if (ov.auto_center_v) ov.auto_center_v = false; // disable auto-center when manually moved
    } else {
        // Resize via handle
        _ovApplyResize(ov, drag, dx, dy);
    }

    // Sync panel
    if (_reelsState.overlayPanel && _reelsState.overlayPanel._selectedOv?.id === ov.id) {
        _reelsState.overlayPanel._syncFromOverlay(ov);
    }
}

function _ovOnMouseUp(e) {
    _reelsState.overlayDrag = null;
}

function _ovApplyResize(ov, drag, dx, dy) {
    const h = drag.handle;
    let x = drag.origX, y = drag.origY, w = drag.origW, ht = drag.origH;

    // Horizontal
    if (h.includes('l')) { x += dx; w -= dx; }
    if (h.includes('r')) { w += dx; }
    // Vertical
    if (h.includes('t')) { y += dy; ht -= dy; }
    if (h.includes('b')) { ht += dy; }

    // Enforce minimums
    if (w < 50) { w = 50; if (h.includes('l')) x = drag.origX + drag.origW - 50; }
    if (ht < 30) { ht = 30; if (h.includes('t')) y = drag.origY + drag.origH - 30; }

    ov.x = x;
    ov.y = y;
    ov.w = w;
    if (ov.type !== 'textcard' || !ov.auto_fit) {
        ov.h = ht;
    }
    if (ov.auto_center_v) ov.auto_center_v = false;
}

function _ovUpdateCursor(e) {
    const canvas = document.getElementById('reels-preview-canvas');
    if (!canvas || !_reelsState.overlaySelectedId) return;

    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === _reelsState.overlaySelectedId);
    if (!ov) return;

    const { x: mx, y: my } = _clientToCanvas(e.clientX, e.clientY);
    const bounds = _ovGetBounds(ov);
    const handle = _ovHitHandle(mx, my, bounds);

    const cursors = {
        'tl': 'nw-resize', 'tr': 'ne-resize', 'bl': 'sw-resize', 'br': 'se-resize',
        'tc': 'n-resize', 'bc': 's-resize', 'ml': 'w-resize', 'mr': 'e-resize',
    };

    if (handle && cursors[handle]) {
        canvas.style.cursor = cursors[handle];
    } else if (mx >= bounds.x && mx <= bounds.x + bounds.w && my >= bounds.y && my <= bounds.y + bounds.h) {
        canvas.style.cursor = 'move';
    } else {
        canvas.style.cursor = '';
    }
}

/** Draw selection frame + 8 resize handles around the selected overlay */
function _drawOverlaySelectionUI(ctx, canvasW, canvasH) {
    if (!_reelsState.overlaySelectedId) return;
    const proxy = _reelsState.overlayProxy;
    if (!proxy) return;
    const ov = (proxy.overlayMgr.overlays || []).find(o => o.id === _reelsState.overlaySelectedId);
    if (!ov || ov.disabled) return;

    const bounds = _ovGetBounds(ov);
    const { x, y, w, h } = bounds;
    const hs = _OV_HANDLE_SIZE;

    ctx.save();
    // Dashed selection border
    ctx.strokeStyle = '#4c9eff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);

    // 8 resize handles
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#4c9eff';
    ctx.lineWidth = 2;
    const handles = [
        [x, y], [x + w / 2, y], [x + w, y],
        [x, y + h / 2], [x + w, y + h / 2],
        [x, y + h], [x + w / 2, y + h], [x + w, y + h],
    ];
    for (const [hx, hy] of handles) {
        ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
    }
    ctx.restore();
}

// ═══════════════════════════════════════════════════════
// Preview viewport zoom / pan
// ═══════════════════════════════════════════════════════

const _previewView = { scale: 1, panX: 0, panY: 0, dragging: false, lastX: 0, lastY: 0 };
let _reelsFitTimer = null;

function _isReelsPanelActive() {
    const panel = document.getElementById('batch-reels-panel');
    return !!(panel && panel.classList.contains('active'));
}

function _fitPreviewWhenReady(retry = 0) {
    const viewport = document.getElementById('reels-preview-viewport');
    const container = document.getElementById('reels-preview-container');
    if (!viewport || !container) return;
    const vpRect = viewport.getBoundingClientRect();
    if (vpRect.width > 20 && vpRect.height > 20 && container.offsetWidth > 20 && container.offsetHeight > 20) {
        reelsPreviewZoom('fit');
        return;
    }
    if (retry >= 12) return;
    if (_reelsFitTimer) clearTimeout(_reelsFitTimer);
    _reelsFitTimer = setTimeout(() => _fitPreviewWhenReady(retry + 1), 80);
}

function _initPreviewZoomPan() {
    const viewport = document.getElementById('reels-preview-viewport');
    if (!viewport) return;

    // 滚轮缩放
    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.max(0.1, Math.min(5, _previewView.scale * factor));

        // 以鼠标位置为中心缩放
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const ratio = newScale / _previewView.scale;
        _previewView.panX = mx - ratio * (mx - _previewView.panX);
        _previewView.panY = my - ratio * (my - _previewView.panY);
        _previewView.scale = newScale;

        _applyPreviewTransform();
    }, { passive: false });

    // 拖拽平移 — 只在没有命中覆层时启用，或按住空格键强制平移
    viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;

        // Check if the mouse is over the canvas and hits an overlay
        const canvas = document.getElementById('reels-preview-canvas');
        if (canvas && _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
            const rect = canvas.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom) {
                // Convert to canvas coords and check for overlay hit
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const mx = (e.clientX - rect.left) * scaleX;
                const my = (e.clientY - rect.top) * scaleY;
                const overlays = _reelsState.overlayProxy.overlayMgr.overlays || [];
                for (let i = overlays.length - 1; i >= 0; i--) {
                    const ov = overlays[i];
                    const bounds = _ovGetBounds(ov);
                    if (mx >= bounds.x && mx <= bounds.x + bounds.w &&
                        my >= bounds.y && my <= bounds.y + bounds.h) {
                        // Hit an overlay — let the overlay interaction handle this
                        return;
                    }
                    // Also check if hitting a resize handle of selected overlay
                    if (_reelsState.overlaySelectedId && ov.id === _reelsState.overlaySelectedId) {
                        const handle = _ovHitHandle(mx, my, bounds);
                        if (handle) return; // Let resize handle work
                    }
                }
            }
        }

        _previewView.dragging = true;
        _previewView.lastX = e.clientX;
        _previewView.lastY = e.clientY;
        viewport.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (e) => {
        if (!_previewView.dragging) return;
        _previewView.panX += e.clientX - _previewView.lastX;
        _previewView.panY += e.clientY - _previewView.lastY;
        _previewView.lastX = e.clientX;
        _previewView.lastY = e.clientY;
        _applyPreviewTransform();
    });
    window.addEventListener('mouseup', () => {
        if (_previewView.dragging) {
            _previewView.dragging = false;
            const vp = document.getElementById('reels-preview-viewport');
            if (vp) vp.style.cursor = 'grab';
        }
    });

    // 初始适应（面板可能初始隐藏，需等待真实尺寸）
    setTimeout(() => _fitPreviewWhenReady(), 100);
}

function _applyPreviewTransform() {
    const el = document.getElementById('reels-preview-transform');
    if (!el) return;
    el.style.transform = `translate(${_previewView.panX}px, ${_previewView.panY}px) scale(${_previewView.scale})`;

    const label = document.getElementById('reels-preview-zoom-label');
    if (label) label.textContent = `${Math.round(_previewView.scale * 100)}%`;
}

function reelsPreviewZoom(action) {
    const viewport = document.getElementById('reels-preview-viewport');
    const container = document.getElementById('reels-preview-container');
    if (!viewport || !container) return;

    const vpRect = viewport.getBoundingClientRect();

    if (action === 'fit') {
        // 适应窗口：使 9:16 内容完整填入视口
        const containerW = container.offsetWidth;
        const containerH = container.offsetHeight;
        if (vpRect.width <= 0 || vpRect.height <= 0 || containerW <= 0 || containerH <= 0) return;
        const scaleW = vpRect.width / containerW;
        const scaleH = vpRect.height / containerH;
        _previewView.scale = Math.min(scaleW, scaleH) * 0.95; // 留 5% 边距
        // 居中
        _previewView.panX = (vpRect.width - containerW * _previewView.scale) / 2;
        _previewView.panY = (vpRect.height - containerH * _previewView.scale) / 2;
    } else if (action === 'reset') {
        _previewView.scale = 1;
        const containerW = container.offsetWidth;
        const containerH = container.offsetHeight;
        _previewView.panX = (vpRect.width - containerW) / 2;
        _previewView.panY = (vpRect.height - containerH) / 2;
    } else if (action === 'in') {
        const newScale = Math.min(5, _previewView.scale * 1.25);
        const cx = vpRect.width / 2;
        const cy = vpRect.height / 2;
        const ratio = newScale / _previewView.scale;
        _previewView.panX = cx - ratio * (cx - _previewView.panX);
        _previewView.panY = cy - ratio * (cy - _previewView.panY);
        _previewView.scale = newScale;
    } else if (action === 'out') {
        const newScale = Math.max(0.1, _previewView.scale * 0.8);
        const cx = vpRect.width / 2;
        const cy = vpRect.height / 2;
        const ratio = newScale / _previewView.scale;
        _previewView.panX = cx - ratio * (cx - _previewView.panX);
        _previewView.panY = cy - ratio * (cy - _previewView.panY);
        _previewView.scale = newScale;
    }

    _applyPreviewTransform();
}

async function _initFontManager() {
    if (typeof getFontManager !== 'function') {
        console.warn('[Reels] FontManager not loaded');
        return;
    }
    const fm = getFontManager();
    await fm.register();
    _refreshReelsFontSelects(fm, {
        'reels-font-family': _reelsState.renderer ? 'Arial' : undefined,
        'rop-font': 'Arial',
        'rop-title-font': 'Crimson Pro',
        'rop-body-font': 'Arial',
        'rop-footer-font': 'Arial',
        'rop-scroll-font': 'Arial',
    });
    try { await fm.loadGoogleFont('Crimson Pro'); } catch (_) { }
    reelsRefreshSubtitleWeightOptions();
    console.log(`[Reels] FontManager ready — ${fm.getAllFonts().length} fonts available`);
}

function _refreshReelsFontSelects(fm, values = {}) {
    if (!fm || typeof fm.refreshFontSelect !== 'function') return;
    const defaults = {
        'reels-font-family': 'Arial',
        'rop-font': 'Arial',
        'rop-title-font': 'Crimson Pro',
        'rop-body-font': 'Arial',
        'rop-footer-font': 'Arial',
        'rop-scroll-font': 'Arial',
        'rop-scroll-title-font': 'Arial',
    };
    for (const [id, fallback] of Object.entries(defaults)) {
        fm.refreshFontSelect(id, Object.prototype.hasOwnProperty.call(values, id) ? values[id] : fallback);
    }
}

function _initReelsFontPresetUI() {
    const select = document.getElementById('reels-font-preset');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- 字体预设 --</option>';
    for (const [key, preset] of Object.entries(REELS_FONT_PRESETS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
    }
    if (current && REELS_FONT_PRESETS[current]) select.value = current;
}

function _initReelsAnimationPresetUI() {
    const select = document.getElementById('reels-animation-preset');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">-- 动画预设 --</option>';
    for (const [key, preset] of Object.entries(REELS_ANIMATION_PRESETS)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = preset.label;
        select.appendChild(opt);
    }
    if (current && REELS_ANIMATION_PRESETS[current]) select.value = current;
}

function reelsApplyAnimationPreset(silent = false) {
    const select = document.getElementById('reels-animation-preset');
    if (!select || !select.value) {
        if (!silent) alert('请先选择一个动画预设');
        return;
    }
    const preset = REELS_ANIMATION_PRESETS[select.value];
    if (!preset) return;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        el.value = String(val);
    };
    const setChk = (id, val) => {
        const el = document.getElementById(id);
        if (!el || val === undefined || val === null) return;
        el.checked = !!val;
    };

    set('reels-anim-in', preset.anim_in_type);
    set('reels-anim-in-dur', preset.anim_in_duration);
    set('reels-anim-out', preset.anim_out_type);
    set('reels-anim-out-dur', preset.anim_out_duration);
    set('reels-float-amp', preset.floating_amplitude);
    set('reels-float-period', preset.floating_period);
    set('reels-bounce-height', preset.char_bounce_height);
    set('reels-metro-bpm', preset.metronome_bpm);
    set('reels-jump-scale', preset.letter_jump_scale);
    set('reels-flash-color', preset.flash_color);
    set('reels-glow-color', preset.holy_glow_color);
    set('reels-glow-radius', preset.holy_glow_radius);
    set('reels-blur-max', preset.blur_sharp_max);
    setChk('reels-karaoke-hl', preset.karaoke_highlight);

    reelsUpdatePreview();
}

function reelsApplyAnimationPresetQuick() {
    reelsApplyAnimationPreset(true);
}

function reelsRefreshSubtitleWeightOptions() {
    const familyEl = document.getElementById('reels-font-family');
    const weightEl = document.getElementById('reels-font-weight');
    if (!familyEl || !weightEl) return;

    const currentWeight = String(weightEl.value || '700');
    const fallback = [
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
    let entries = fallback;

    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        if (fm && typeof fm.getFontWeightEntries === 'function') {
            const preferStyle = document.getElementById('reels-italic')?.checked ? 'italic' : 'normal';
            const list = fm.getFontWeightEntries(familyEl.value, preferStyle);
            if (Array.isArray(list) && list.length > 0) {
                entries = list.map(item => {
                    const value = String(item.value || '400');
                    const label = String(item.label || value);
                    return { value, label };
                });
            }
        } else if (fm && typeof fm.getFontWeightOptions === 'function') {
            const list = fm.getFontWeightOptions(familyEl.value);
            if (Array.isArray(list) && list.length > 0) {
                entries = list.map(v => ({ value: String(v), label: String(v) }));
            }
        }
    }

    const weights = entries.map(e => e.value);
    weightEl.innerHTML = entries.map(e => `<option value="${e.value}">${e.label}</option>`).join('');
    if (weights.includes(currentWeight)) {
        weightEl.value = currentWeight;
    } else if (weights.includes('700')) {
        weightEl.value = '700';
    } else {
        weightEl.value = weights[weights.length - 1] || '700';
    }
    reelsSyncWeightToBold();
}

async function reelsOnSubtitleFontFamilyChange() {
    const familyEl = document.getElementById('reels-font-family');
    if (!familyEl) return;
    if (typeof getFontManager === 'function') {
        try {
            const fm = getFontManager();
            await fm.loadGoogleFont(familyEl.value);
        } catch (_) { }
    }
    reelsRefreshSubtitleWeightOptions();
    reelsUpdatePreview();
}

function reelsSyncBoldToWeight() {
    const boldEl = document.getElementById('reels-bold');
    const weightEl = document.getElementById('reels-font-weight');
    if (!boldEl || !weightEl) return;
    const next = boldEl.checked ? '700' : '400';
    const opts = Array.from(weightEl.options || []).map(o => o.value);
    if (opts.includes(next)) {
        weightEl.value = next;
    } else if (boldEl.checked) {
        const high = opts.filter(v => parseInt(v, 10) >= 600);
        if (high.length > 0) weightEl.value = high[Math.min(1, high.length - 1)];
    } else {
        const low = opts.filter(v => parseInt(v, 10) < 600);
        if (low.length > 0) weightEl.value = low[Math.max(0, low.length - 2)];
    }
}

function reelsSyncWeightToBold() {
    const boldEl = document.getElementById('reels-bold');
    const weightEl = document.getElementById('reels-font-weight');
    if (!boldEl || !weightEl) return;
    const w = parseInt(weightEl.value || '700', 10);
    boldEl.checked = Number.isFinite(w) ? w >= 600 : true;
}

function reelsUploadFont() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf,.woff,.woff2';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fm = getFontManager();
        const familyName = await fm.uploadFont(file);
        if (familyName) {
            _refreshReelsFontSelects(fm, {
                'reels-font-family': familyName,
                'rop-font': familyName,
                'rop-title-font': familyName,
                'rop-body-font': familyName,
                'rop-footer-font': familyName,
                'rop-scroll-font': familyName,
                'rop-scroll-title-font': familyName,
            });
            const select = document.getElementById('reels-font-family');
            if (select) select.value = familyName;
            reelsRefreshSubtitleWeightOptions();
            reelsUpdatePreview();
            console.log(`[Reels] Custom font uploaded: ${familyName}`);
        } else {
            alert('字体加载失败，请确认文件格式正确');
        }
    };
    input.click();
}

async function reelsApplyFontPreset(silent = false) {
    const select = document.getElementById('reels-font-preset');
    if (!select || !select.value) {
        if (!silent) alert('请先选择一个字体预设');
        return;
    }
    const preset = REELS_FONT_PRESETS[select.value];
    if (!preset) return;

    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = String(val);
    };
    const setChk = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!val;
    };

    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        await fm.loadGoogleFont(preset.font_family);
        fm.refreshFontSelect('reels-font-family', preset.font_family);
    }

    set('reels-font-family', preset.font_family);
    set('reels-font-weight', preset.font_weight || (preset.bold ? 700 : 400));
    set('reels-fontsize', preset.fontsize);
    set('reels-fontsize-range', preset.fontsize);
    setChk('reels-bold', preset.bold);
    setChk('reels-italic', preset.italic);
    set('reels-letter-spacing', preset.letter_spacing);
    reelsRefreshSubtitleWeightOptions();
    reelsSyncWeightToBold();

    reelsUpdatePreview();
}

function reelsApplyFontPresetQuick() {
    return reelsApplyFontPreset(true);
}

function _cloneSubtitleStyle(style) {
    if (!style || typeof style !== 'object') return null;
    try {
        return JSON.parse(JSON.stringify(style));
    } catch (_) {
        return { ...style };
    }
}

function _isStyleApplyAllEnabled() {
    const el = document.getElementById('reels-style-apply-all');
    return el ? el.checked !== false : true;
}

function _getNamedSubtitlePresetStyle(name) {
    if (!name || !window.ReelsStyleEngine) return null;
    const data = ReelsStyleEngine.loadSubtitlePresets();
    if (!data.presets || !(name in data.presets)) return null;
    return ReelsStyleEngine.applySubtitlePreset(name);
}

function _resolveSubtitleStyleForTask(task) {
    const globalStyle = _reelsState.globalSubtitleStyle;
    // ── 最高优先级：批量表格中设置的字幕模板预设 ──
    // 即使 applyAll 开启，任务级别的显式预设也应该生效
    if (task && task._subtitlePreset && window.ReelsStyleEngine) {
        const presetStyle = _getNamedSubtitlePresetStyle(task._subtitlePreset);
        if (presetStyle) return presetStyle;
        task._subtitlePreset = '';
    }
    if (_isStyleApplyAllEnabled()) {
        return _cloneSubtitleStyle(globalStyle) || _readStyleFromUI();
    }
    if (task && task.subtitleStyle && typeof task.subtitleStyle === 'object') {
        return _cloneSubtitleStyle(task.subtitleStyle);
    }
    return _cloneSubtitleStyle(globalStyle) || _readStyleFromUI();
}

function _persistSubtitleStyleByScope(style) {
    const safeStyle = _cloneSubtitleStyle(style || _readStyleFromUI());
    if (!safeStyle) return;
    if (_isStyleApplyAllEnabled()) {
        _reelsState.globalSubtitleStyle = safeStyle;
        return;
    }
    const task = _getSelectedTask();
    if (task) task.subtitleStyle = safeStyle;
}

function reelsOnStyleApplyScopeChange() {
    const task = _getSelectedTask();
    const applyAll = _isStyleApplyAllEnabled();
    if (applyAll) {
        _persistSubtitleStyleByScope(_readStyleFromUI());
    } else {
        const style = _resolveSubtitleStyleForTask(task);
        if (style) {
            _writeStyleToUI(style);
            _persistSubtitleStyleByScope(style);
        }
    }
    reelsUpdatePreview();
}

// ═══════════════════════════════════════════════════════
// Style: read all params from UI → style object
// ═══════════════════════════════════════════════════════

function _readStyleFromUI() {
    const get = (id) => document.getElementById(id);
    const val = (id) => {
        const el = get(id);
        if (!el) return '';
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            return el.value;
        }
        return el.dataset.rawValue !== undefined ? el.dataset.rawValue : el.value;
    };
    const num = (id, def) => { const v = parseFloat(val(id)); return isNaN(v) ? def : v; };
    const chk = (id) => get(id) ? get(id).checked : false;

    // Update labels
    const swLabel = get('reels-stroke-width-label');
    if (swLabel) swLabel.textContent = val('reels-stroke-width');
    const sbLabel = get('reels-shadow-blur-label');
    if (sbLabel) sbLabel.textContent = val('reels-shadow-blur');
    const soxLabel = get('reels-shadow-offset-x-label');
    if (soxLabel) soxLabel.textContent = val('reels-shadow-offset-x');
    const soyLabel = get('reels-shadow-offset-y-label');
    if (soyLabel) soyLabel.textContent = val('reels-shadow-offset-y');
    const pxLabel = get('reels-pos-x-label');
    if (pxLabel) pxLabel.textContent = val('reels-pos-x') + '%';
    const pyLabel = get('reels-pos-y-label');
    if (pyLabel) pyLabel.textContent = val('reels-pos-y') + '%';
    const wwLabel = get('reels-wrap-width-label');
    if (wwLabel) wwLabel.textContent = val('reels-wrap-width') + '%';

    const baseStyle = {
        // Font
        font_family: val('reels-font-family') || 'Arial',
        font_weight: num('reels-font-weight', chk('reels-bold') ? 700 : 400),
        fontsize: num('reels-fontsize', 74),
        bold: num('reels-font-weight', chk('reels-bold') ? 700 : 400) >= 600,
        italic: chk('reels-italic'),
        letter_spacing: num('reels-letter-spacing', 0),

        // Colors
        color_text: val('reels-color-text') || '#FFFFFF',
        color_high: val('reels-color-high') || '#FFD700',

        // Stroke
        use_stroke: chk('reels-use-stroke'),
        color_outline: val('reels-stroke-color') || '#3E2723',
        border_width: num('reels-stroke-width', 3),
        opacity_outline: 255,

        // Multi-layer stroke expand
        stroke_expand_enabled: chk('reels-stroke-expand'),
        stroke_expand_layers: num('reels-se-layers', 3),
        stroke_expand_step: num('reels-se-step', 4),
        stroke_expand_feather: num('reels-se-feather', 8),
        stroke_expand_colors: val('reels-se-colors') || '#FF0000,#00FF00,#0000FF',

        // Shadow
        shadow_blur: chk('reels-shadow') ? num('reels-shadow-blur', 4) : 0,
        shadow_offset_x: chk('reels-shadow') ? num('reels-shadow-offset-x', 0) : 0,
        shadow_offset_y: chk('reels-shadow') ? num('reels-shadow-offset-y', 2) : 0,
        color_shadow: val('reels-shadow-color') || '#000000',
        opacity_shadow: chk('reels-shadow') ? 150 : 0,

        // Box
        use_box: chk('reels-use-box'),
        box_adaptive_width: chk('reels-box-adaptive-width'),
        color_bg: val('reels-box-color') || '#000000',
        opacity_bg: num('reels-box-opacity', 150),
        box_radius: num('reels-box-radius', 8),
        box_blur: num('reels-box-blur', 0),
        box_padding_x: num('reels-box-pad-x', 12),
        box_padding_y: num('reels-box-pad-y', 8),

        // Box gradient
        bg_gradient_enabled: chk('reels-bg-gradient'),
        bg_gradient_type: val('reels-bg-gradient-type') || 'linear_h',
        bg_gradient_colors: val('reels-bg-gradient-colors') || '#e0c3fc,#8ec5fc',
        bg_gradient_highlight: chk('reels-bg-gradient-hl'),

        // Box color transition
        box_transition_enabled: chk('reels-box-transition'),
        box_transition_color_to: val('reels-box-transition-color') || '#FF6600',

        // Dynamic box
        dynamic_box: chk('reels-dynamic-box'),
        dynamic_box_stroke: chk('reels-dynamic-box-stroke'),
        dynamic_box_stroke_width: num('reels-dynamic-box-stroke-width', 2),
        color_high_bg: val('reels-high-bg-color') || '#FFD700',
        opacity_high_bg: num('reels-high-bg-opacity', 200),
        dyn_box_anim: chk('reels-dyn-anim'),
        dyn_box_anim_overshoot: 1.3,
        dyn_box_anim_duration: 0.15,
        dynamic_radius: num('reels-dyn-radius', 6),
        high_padding: num('reels-high-padding', 4),
        high_offset_y: 0,

        karaoke_highlight: chk('reels-karaoke'),

        // Position & Layout
        pos_x: num('reels-pos-x', 50) / 100,
        pos_y: num('reels-pos-y', 85) / 100,
        wrap_width_percent: num('reels-wrap-width', 90),
        wrap_lines: 2,
        wrap_left: 0,
        wrap_right: 0,
        random_position_use_layout_range: val('reels-anim-in') === 'word_random_position',
        random_position_height_percent: num('reels-random-position-height', 35),
        line_spacing: num('reels-line-spacing', 1.2),
        rotation: num('reels-rotation', 0),

        // Advanced Textbox
        advanced_textbox_enabled: chk('reels-adv-textbox'),
        advanced_textbox_align: val('reels-adv-textbox-align') || 'center',
        advanced_textbox_valign: val('reels-adv-textbox-valign') || 'center',
        advanced_textbox_x: num('reels-adv-x', 200),
        advanced_textbox_y: num('reels-adv-y', 1400),
        advanced_textbox_w: num('reels-adv-w', 680),
        advanced_textbox_h: num('reels-adv-h', 280),
        adv_text_align: val('reels-adv-textbox-align') || 'center',
        
        // Background Mask
        global_mask_enabled: chk('reels-global-mask'),
        global_mask_color: val('reels-global-mask-color') || '#000000',
        global_mask_opacity: num('reels-global-mask-opacity', 128) / 255,

        // Background box
        adv_bg_enabled: chk('reels-adv-bg'),
        adv_bg_color: val('reels-adv-bg-color') || '#000000',
        adv_bg_opacity: num('reels-adv-bg-opacity', 150),
        adv_bg_radius: num('reels-adv-bg-radius', 8),

        // Animation
        anim_in_type: val('reels-anim-in') || 'none',
        anim_in_duration: num('reels-anim-in-dur', 0.3),
        anim_in_easing: 'ease_out',
        anim_out_type: val('reels-anim-out') || 'none',
        anim_out_duration: num('reels-anim-out-dur', 0.25),
        anim_out_easing: 'ease_in_out',

        // Animation params
        floating_amplitude: num('reels-float-amp', 8),
        floating_period: num('reels-float-period', 2.0),
        char_bounce_height: num('reels-bounce-height', 20),
        char_bounce_stagger: 0.05,
        metronome_bpm: num('reels-metro-bpm', 120),
        letter_jump_scale: num('reels-jump-scale', 1.5),
        letter_jump_duration: 0.2,
        word_pop_random_min_scale: num('reels-word-pop-min', 0.7),
        word_pop_random_max_scale: num('reels-word-pop-max', 1.34),
        word_pop_random_duration: num('reels-word-pop-dur', 0.22),
        word_pop_random_pulse_min_scale: num('reels-word-pop-pulse-min', 1.08),
        word_pop_random_pulse_max_scale: num('reels-word-pop-pulse-max', 1.38),
        word_pop_random_pulse_duration: num('reels-word-pop-pulse-dur', 0.22),
        word_pop_random_unread_opacity: num('reels-word-pop-unread-opacity', 0.0),
        word_pop_random_read_opacity: num('reels-word-pop-read-opacity', 1.0),
        random_word_spacing: num('reels-random-word-spacing', 0),
        random_line_spacing: num('reels-random-line-spacing', 0),
        random_spacing_seed: num('reels-random-spacing-seed', 1),
        only_show_active_word: chk('reels-only-show-active-word'),
        flash_color: val('reels-flash-color') || '#FFFFFF',
        flash_duration: 0.1,
        bullet_stagger: 0.15,
        holy_glow_color: val('reels-glow-color') || '#FFFFAA',
        holy_glow_radius: num('reels-glow-radius', 6),
        holy_glow_period: 3.0,
        blur_sharp_max: num('reels-blur-max', 20),
        blur_sharp_clear_frac: 0.4,

        // Typewriter
        tw_revealed_color: '#FFFFFF',
        tw_revealed_stroke_color: '#000000',
        tw_unrevealed_color: '#808080',
        tw_unrevealed_stroke_color: '#404040',
        tw_unrevealed_opacity: 100,

        // Metronome
        metro_read_color: '#FFFFFF',
        metro_read_stroke_color: '#000000',
        metro_unread_color: '#808080',
        metro_unread_stroke_color: '#404040',
        metro_unread_opacity: 100,

        // Scrolling lyrics mode
        scrolling_mode: chk('reels-scrolling-mode'),
        scrolling_visible_lines: num('reels-scrolling-lines', 3),
        scrolling_opacity_context: num('reels-scrolling-opacity', 0.3),
        // Fullpage Typewriter
        fullpage_typewriter: chk('reels-fullpage-typewriter'),
        fullpage_typewriter_reveal_type: val('reels-fullpage-typewriter-reveal-type') || 'char',
        fullpage_typewriter_align: val('reels-fullpage-typewriter-align') || 'center',
        fullpage_typewriter_cursor: chk('reels-fullpage-typewriter-cursor'),
        fullpage_typewriter_cursor_char: val('reels-fullpage-typewriter-cursor-char') || '|',
        fullpage_typewriter_cursor_color: val('reels-fullpage-typewriter-cursor-color') || '#FFD700',
        tw_unrevealed_opacity: num('reels-tw-unrevealed-opacity', 0) / 255,
        fullpage_typewriter_first_line_bold: chk('reels-fullpage-typewriter-first-line-bold'),
        fullpage_typewriter_first_line_scale: num('reels-fullpage-typewriter-first-line-scale', 1.2),
        fullpage_typewriter_first_line_color: chk('reels-fullpage-typewriter-first-line-color-enable') ? val('reels-fullpage-typewriter-first-line-color') : '',
        // Scatter Pop
        scatter_max_words: num('reels-scatter-max-words', 3),
        scatter_accum_prob: num('reels-scatter-accum-prob', 0.5),
        scatter_area_left: num('reels-scatter-area-left', 15),
        scatter_area_right: num('reels-scatter-area-right', 85),
        scatter_area_top: num('reels-scatter-area-top', 25),
        scatter_area_bottom: num('reels-scatter-area-bottom', 75),
        scatter_seed: num('reels-scatter-seed', 1),
        scatter_min_scale: num('reels-scatter-min-scale', 0.8),
        scatter_max_scale: num('reels-scatter-max-scale', 1.5),
        scatter_min_rotate: num('reels-scatter-min-rotate', 0),
        scatter_max_rotate: num('reels-scatter-max-rotate', 0),
    };

    // === Merge with existing hidden state (auto_color_rules etc.) ===
    const existingStyle = _reelsState.style || {};
    const merged = Object.assign({}, existingStyle, baseStyle);
    _reelsState.style = merged;
    return merged;
}

// ═══════════════════════════════════════════════════════
// Subtitle Auto-Color UI
// ═══════════════════════════════════════════════════════

function reelsAddAutoColorRule(type) {
    if (!_reelsState.style) _reelsState.style = _readStyleFromUI();
    if (!_reelsState.style.auto_color_rules) _reelsState.style.auto_color_rules = [];
    
    let defaultKw = [];
    if (type === 'number') defaultKw = ['\d+(\.\d+)?'];
    else if (type === 'english') defaultKw = ['[a-zA-Z]+'];
    
    _reelsState.style.auto_color_rules.push({
        type: type,
        keywords: defaultKw,
        color: '#FFD700',
        bold: false,
        italic: false,
        fontsize: 0
    });
    
    _persistSubtitleStyleByScope(_reelsState.style);
    _renderSubtitleAutoColorRules();
    reelsUpdatePreview();
}

function _renderSubtitleAutoColorRules() {
    const container = document.getElementById('reels-autocolor-rules');
    if (!container) return;
    container.innerHTML = '';
    
    const style = _reelsState.style;
    if (!style || !style.auto_color_rules || style.auto_color_rules.length === 0) {
        container.innerHTML = '<div style="color:var(--text-secondary,#888);font-size:12px;text-align:center;padding:4px;">(暂无规则)</div>';
        return;
    }

    style.auto_color_rules.forEach((rule, idx) => {
        const ruleDiv = document.createElement('div');
        ruleDiv.style.cssText = 'border:1px solid var(--border-color,#444);border-radius:4px;padding:4px 6px;background:var(--bg-tertiary,#1e1e2d);display:flex;flex-direction:column;gap:4px;';
        
        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;';
        
        const select = document.createElement('select');
        select.className = 'input input-small';
        select.style.cssText = 'padding:2px 4px;font-size:11px;height:auto;flex:1;';
        const types = { 'keyword': '🏷️ 关键词', 'number': '🔢 数字', 'english': '🔤 英文', 'punctuation': '❗ 标点', 'quoted': '「」 引号', 'emoji': '😀 Emoji' };
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
            else rule.keywords = [];
            _persistSubtitleStyleByScope(style);
            _renderSubtitleAutoColorRules();
            reelsUpdatePreview();
        });
        header.appendChild(select);
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '✕';
        delBtn.style.cssText = 'background:none;border:none;color:var(--danger,#ff4444);cursor:pointer;margin-left:8px;font-size:12px;';
        delBtn.addEventListener('click', () => {
            style.auto_color_rules.splice(idx, 1);
            _persistSubtitleStyleByScope(style);
            _renderSubtitleAutoColorRules();
            reelsUpdatePreview();
        });
        header.appendChild(delBtn);
        ruleDiv.appendChild(header);

        // Keywords Input
        if (rule.type === 'keyword') {
            const kwInput = document.createElement('textarea');
            kwInput.className = 'input';
            kwInput.rows = 2;
            kwInput.style.cssText = 'padding:4px;font-size:11px;min-height:40px;max-height:150px;resize:vertical;width:100%;box-sizing:border-box;';
            kwInput.placeholder = '输入或粘贴词语块\n换行或逗号分隔';
            kwInput.value = (rule.keywords || []).join('\n');
            kwInput.addEventListener('input', () => {
                rule.keywords = kwInput.value.split(/[\n,，]+/).map(s => s.trim()).filter(s => s);
                _persistSubtitleStyleByScope(style);
                reelsUpdatePreview();
            });
            ruleDiv.appendChild(kwInput);
        }

        // Style Row
        const styleRow = document.createElement('div');
        styleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';
        
        // Color
        const cPicker = document.createElement('input');
        cPicker.type = 'color';
        cPicker.value = rule.color || '#FFD700';
        cPicker.style.cssText = 'width:24px;height:24px;padding:0;border:none;border-radius:4px;cursor:pointer;';
        cPicker.addEventListener('input', () => {
            rule.color = cPicker.value;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        styleRow.appendChild(cPicker);

        // Bold
        const boldLbl = document.createElement('label');
        boldLbl.style.cssText = 'font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer;';
        const boldChk = document.createElement('input');
        boldChk.type = 'checkbox';
        boldChk.checked = rule.bold;
        boldChk.addEventListener('change', () => {
            rule.bold = boldChk.checked;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        boldLbl.appendChild(boldChk);
        boldLbl.appendChild(document.createTextNode('B'));
        styleRow.appendChild(boldLbl);

        // Italic
        const itLbl = document.createElement('label');
        itLbl.style.cssText = 'font-size:11px;display:flex;align-items:center;gap:2px;cursor:pointer;';
        const itChk = document.createElement('input');
        itChk.type = 'checkbox';
        itChk.checked = rule.italic;
        itChk.addEventListener('change', () => {
            rule.italic = itChk.checked;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        itLbl.appendChild(itChk);
        itLbl.appendChild(document.createTextNode('I'));
        styleRow.appendChild(itLbl);

        // Font Size
        const fsInput = document.createElement('input');
        fsInput.type = 'number';
        fsInput.className = 'input input-small';
        fsInput.style.cssText = 'width:40px;';
        fsInput.placeholder = '字号';
        if (rule.fontsize) fsInput.value = rule.fontsize;
        fsInput.addEventListener('input', () => {
            const v = parseInt(fsInput.value);
            rule.fontsize = isNaN(v) ? 0 : v;
            _persistSubtitleStyleByScope(style);
            reelsUpdatePreview();
        });
        styleRow.appendChild(fsInput);

        ruleDiv.appendChild(styleRow);
        container.appendChild(ruleDiv);
    });
}

function _writeStyleToUI(style) {
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
            el.value = val;
            el.dataset.rawValue = val;
        }
        const rangeEl = document.getElementById(id + '-range');
        if (rangeEl) rangeEl.value = val;
        const labelEl = document.getElementById(id + '-label');
        if (labelEl) {
            if (id === 'reels-pos-x' || id === 'reels-pos-y' || id === 'reels-wrap-width') {
                labelEl.textContent = val + '%';
            } else {
                labelEl.textContent = val;
            }
        }
        if (id === 'reels-font-family' && typeof getFontManager === 'function') {
            const fm = getFontManager();
            if (fm && typeof fm.refreshFontSelect === 'function') {
                fm.refreshFontSelect(id, val);
            }
        }
    };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

    set('reels-font-family', style.font_family || 'Arial');
    // 如果字体是 Google Font，按需加载
    if (typeof getFontManager === 'function') {
        const fm = getFontManager();
        fm.loadGoogleFont(style.font_family || 'Arial');
    }
    set('reels-fontsize', style.fontsize || 74);
    set('reels-fontsize-range', style.fontsize || 74);
    const weight = Math.max(100, Math.min(900, parseInt(style.font_weight || ((style.bold !== false) ? 700 : 400), 10) || 700));
    set('reels-font-weight', String(weight));
    setChk('reels-bold', weight >= 600);
    setChk('reels-italic', style.italic);
    set('reels-letter-spacing', style.letter_spacing || 0);
    reelsRefreshSubtitleWeightOptions();
    set('reels-color-text', style.color_text || '#FFFFFF');
    set('reels-color-high', style.color_high || '#FFD700');
    setChk('reels-use-stroke', style.use_stroke !== false);
    set('reels-stroke-color', style.color_outline || '#3E2723');
    set('reels-stroke-width', style.border_width || 3);
    setChk('reels-stroke-expand', style.stroke_expand_enabled);
    set('reels-se-layers', style.stroke_expand_layers || 3);
    set('reels-se-step', style.stroke_expand_step || 4);
    set('reels-se-feather', style.stroke_expand_feather || 8);
    set('reels-se-colors', typeof style.stroke_expand_colors === 'string' ? style.stroke_expand_colors : '#FF0000,#00FF00,#0000FF');
    if (typeof window.reelsSyncSEColorsUI === 'function') window.reelsSyncSEColorsUI();
    setChk('reels-shadow', (style.shadow_blur || 0) > 0);
    set('reels-shadow-color', style.color_shadow || '#000000');
    set('reels-shadow-blur', style.shadow_blur || 4);
    set('reels-shadow-offset-x', style.shadow_offset_x ?? 0);
    set('reels-shadow-offset-y', style.shadow_offset_y ?? 2);
    setChk('reels-use-box', style.use_box);
    setChk('reels-box-adaptive-width', style.box_adaptive_width);
    set('reels-box-color', style.color_bg || '#000000');
    set('reels-box-opacity', style.opacity_bg ?? 150);
    set('reels-box-radius', style.box_radius ?? 8);
    set('reels-box-pad-x', style.box_padding_x ?? 12);
    set('reels-box-pad-y', style.box_padding_y ?? 8);
    { const el = document.getElementById('reels-box-pad-x-range'); if (el) el.value = style.box_padding_x ?? 12; }
    { const el = document.getElementById('reels-box-pad-y-range'); if (el) el.value = style.box_padding_y ?? 8; }
    set('reels-box-blur', style.box_blur || 0);
    setChk('reels-bg-gradient', style.bg_gradient_enabled);
    set('reels-bg-gradient-type', style.bg_gradient_type || 'linear_h');
    set('reels-bg-gradient-colors', typeof style.bg_gradient_colors === 'string' ? style.bg_gradient_colors : '#e0c3fc,#8ec5fc');
    setChk('reels-bg-gradient-hl', style.bg_gradient_highlight);
    if (typeof window.reelsSyncBgGradientColorsUI === 'function') window.reelsSyncBgGradientColorsUI();
    setChk('reels-box-transition', style.box_transition_enabled);
    set('reels-box-transition-color', style.box_transition_color_to || '#FF6600');
    setChk('reels-dynamic-box', style.dynamic_box);
    setChk('reels-dynamic-box-stroke', style.dynamic_box_stroke);
    set('reels-dynamic-box-stroke-width', style.dynamic_box_stroke_width ?? 2);
    set('reels-high-bg-color', style.color_high_bg || '#FFD700');
    set('reels-high-bg-opacity', style.opacity_high_bg ?? 200);
    { const el = document.getElementById('reels-high-bg-opacity-range'); if (el) el.value = style.opacity_high_bg ?? 200; }
    setChk('reels-dyn-anim', style.dyn_box_anim);
    set('reels-high-padding', style.high_padding ?? 4);
    set('reels-dyn-radius', style.dynamic_radius ?? 6);
    setChk('reels-use-underline', style.use_underline);
    set('reels-underline-color', style.color_underline || '#FFD700');
    set('reels-pos-x', Math.round((style.pos_x || 0.5) * 100));
    set('reels-pos-y', Math.round((style.pos_y || 0.5) * 100));
    set('reels-wrap-width', style.wrap_width_percent || 90);
    set('reels-random-position-height', style.random_position_height_percent || 35);
    set('reels-random-position-height-range', style.random_position_height_percent || 35);
    set('reels-line-spacing', style.line_spacing ?? 4);
    set('reels-rotation', style.rotation || 0);
    setChk('reels-adv-textbox', style.advanced_textbox_enabled);
    set('reels-adv-textbox-align', style.advanced_textbox_align || 'center');
    set('reels-adv-textbox-valign', style.advanced_textbox_valign || 'center');

    // Global mask
    setChk('reels-global-mask', style.global_mask_enabled);
    set('reels-global-mask-color', style.global_mask_color || '#000000');
    set('reels-global-mask-opacity', Math.round((style.global_mask_opacity ?? 0.5) * 255));

    set('reels-adv-x', style.advanced_textbox_x || 200);
    set('reels-adv-y', style.advanced_textbox_y || 1400);
    set('reels-adv-w', style.advanced_textbox_w || 680);
    set('reels-adv-h', style.advanced_textbox_h || 280);
    setChk('reels-adv-bg', style.adv_bg_enabled);
    set('reels-adv-bg-color', style.adv_bg_color || '#000000');
    set('reels-adv-bg-opacity', style.adv_bg_opacity || 150);
    set('reels-adv-bg-radius', style.adv_bg_radius || 8);
    set('reels-anim-in', style.anim_in_type || 'fade');
    set('reels-anim-in-dur', style.anim_in_duration || 0.3);
    set('reels-anim-out', style.anim_out_type || 'fade');
    set('reels-anim-out-dur', style.anim_out_duration || 0.25);
    set('reels-float-amp', style.floating_amplitude || 8);
    set('reels-float-period', style.floating_period || 2);
    set('reels-bounce-height', style.char_bounce_height || 20);
    set('reels-metro-bpm', style.metronome_bpm || 120);
    set('reels-jump-scale', style.letter_jump_scale || 1.5);
    set('reels-flash-color', style.flash_color || '#FFFFFF');
    set('reels-glow-color', style.holy_glow_color || '#FFFFAA');
    set('reels-glow-radius', style.holy_glow_radius || 6);
    set('reels-blur-max', style.blur_sharp_max || 20);
    set('reels-random-word-spacing', style.random_word_spacing || 0);
    set('reels-random-word-spacing-range', style.random_word_spacing || 0);
    set('reels-random-line-spacing', style.random_line_spacing || 0);
    set('reels-random-line-spacing-range', style.random_line_spacing || 0);
    set('reels-random-spacing-seed', style.random_spacing_seed || 1);
    setChk('reels-only-show-active-word', style.only_show_active_word);

    // Scrolling lyrics mode
    setChk('reels-scrolling-mode', style.scrolling_mode);
    set('reels-scrolling-lines', style.scrolling_visible_lines || 3);
    set('reels-scrolling-opacity', style.scrolling_opacity_context || 0.3);
    // Toggle visibility of scrolling sub-options
    const scrollOpts = document.getElementById('reels-scrolling-options');
    if (scrollOpts) scrollOpts.style.display = style.scrolling_mode ? '' : 'none';

    // Fullpage Typewriter
    setChk('reels-fullpage-typewriter', style.fullpage_typewriter);
    set('reels-fullpage-typewriter-reveal-type', style.fullpage_typewriter_reveal_type || 'char');
    set('reels-fullpage-typewriter-align', style.fullpage_typewriter_align || 'center');
    setChk('reels-fullpage-typewriter-cursor', style.fullpage_typewriter_cursor !== false);
    set('reels-fullpage-typewriter-cursor-char', style.fullpage_typewriter_cursor_char || '|');
    set('reels-fullpage-typewriter-cursor-color', style.fullpage_typewriter_cursor_color || '#FFD700');
    set('reels-tw-unrevealed-opacity', Math.round((style.tw_unrevealed_opacity ?? 0) * 255));
    setChk('reels-fullpage-typewriter-first-line-bold', style.fullpage_typewriter_first_line_bold !== false);
    set('reels-fullpage-typewriter-first-line-scale', style.fullpage_typewriter_first_line_scale ?? 1.2);
    set('reels-fullpage-typewriter-first-line-color', style.fullpage_typewriter_first_line_color || '#FFFFFF');
    setChk('reels-fullpage-typewriter-first-line-color-enable', !!style.fullpage_typewriter_first_line_color);
    const twOpts = document.getElementById('reels-fullpage-typewriter-options');
    if (twOpts) twOpts.style.display = style.fullpage_typewriter ? '' : 'none';

    // Scatter Pop
    set('reels-scatter-max-words', style.scatter_max_words ?? 3);
    set('reels-scatter-accum-prob', style.scatter_accum_prob ?? 0.5);
    set('reels-scatter-area-left', style.scatter_area_left ?? 15);
    set('reels-scatter-area-left-range', style.scatter_area_left ?? 15);
    set('reels-scatter-area-right', style.scatter_area_right ?? 85);
    set('reels-scatter-area-right-range', style.scatter_area_right ?? 85);
    set('reels-scatter-area-top', style.scatter_area_top ?? 25);
    set('reels-scatter-area-top-range', style.scatter_area_top ?? 25);
    set('reels-scatter-area-bottom', style.scatter_area_bottom ?? 75);
    set('reels-scatter-area-bottom-range', style.scatter_area_bottom ?? 75);
    set('reels-scatter-seed', style.scatter_seed ?? 1);
    set('reels-scatter-min-scale', style.scatter_min_scale ?? 0.8);
    set('reels-scatter-max-scale', style.scatter_max_scale ?? 1.5);
    set('reels-scatter-min-rotate', style.scatter_min_rotate ?? 0);
    set('reels-scatter-max-rotate', style.scatter_max_rotate ?? 0);

    // Sync _reelsState.style so hidden props survive
    _reelsState.style = Object.assign({}, _reelsState.style || {}, style);

    _renderSubtitleAutoColorRules();
}

// ═══════════════════════════════════════════════════════
// Preview rendering loop
// ═══════════════════════════════════════════════════════

function reelsUpdatePreview() {
    const renderer = _reelsState.renderer;
    if (!renderer) return;

    const style = _readStyleFromUI();
    _persistSubtitleStyleByScope(style);
    const previewText = (document.getElementById('reels-preview-text') || {}).value || 'Hello World 这是一个测试字幕';
    const canvas = renderer.canvas;
    const ctx = renderer.ctx;
    const w = canvas.width;
    const h = canvas.height;

    const placeholder = document.getElementById('reels-preview-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    renderer.clear();
    _syncBackgroundVideoToMaster();

    const video = document.getElementById('reels-preview-video');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    // Check for image background
    let bgImg = _reelsState._previewBgImage;
    let hasBgImg = bgImg && bgImg.complete && bgImg.naturalWidth > 0;

    // Removed noisy debug logs

    const _selectedTask = _getSelectedTask();
    const _bgScalePct = _selectedTask ? (_selectedTask.bgScale || 100) : 100;
    const _bgXPct = _selectedTask ? (_selectedTask.bgX || 0) : 0;
    const _bgYPct = _selectedTask ? (_selectedTask.bgY || 0) : 0;

    // ── 检查并更新极速贴合提示 ──
    const fastAlphaCb = document.getElementById('reels-fast-alpha-mode');
    const fastAlphaStatusEl = document.getElementById('fast-alpha-status-text');
    if (fastAlphaCb && fastAlphaStatusEl && _selectedTask) {
        if (!fastAlphaCb.checked) {
            fastAlphaStatusEl.style.display = 'none';
        } else {
            const effectivePool = _getEffectiveBgClipPool(_selectedTask);
            const bgPath = _reelsState.bgPath || effectivePool[0] || '';
            const isBgVideo = bgPath && !_isImageFile(bgPath);
            const loopFade = (document.getElementById('reels-loop-fade') || {}).checked !== false;
            
            const isMultiClip = effectivePool.length > 0;
            const isCrossfadeVideo = isBgVideo && loopFade;
            
            if (isMultiClip) {
                fastAlphaStatusEl.style.display = 'inline-block';
                fastAlphaStatusEl.style.color = '#faad14';
                fastAlphaStatusEl.style.background = '#fffbe6';
                fastAlphaStatusEl.style.border = '1px solid #ffe58f';
                fastAlphaStatusEl.textContent = '当前自动回退常规模式 (多片段转场)';
            } else if (isCrossfadeVideo) {
                fastAlphaStatusEl.style.display = 'inline-block';
                fastAlphaStatusEl.style.color = '#faad14';
                fastAlphaStatusEl.style.background = '#fffbe6';
                fastAlphaStatusEl.style.border = '1px solid #ffe58f';
                fastAlphaStatusEl.textContent = '当前自动回退常规模式 (循环首尾过滤)';
            } else if (bgPath) {
                fastAlphaStatusEl.style.display = 'inline-block';
                fastAlphaStatusEl.style.color = '#52c41a';
                fastAlphaStatusEl.style.background = '#f6ffed';
                fastAlphaStatusEl.style.border = '1px solid #b7eb8f';
                fastAlphaStatusEl.textContent = '✓ 支持提速';
            } else {
                fastAlphaStatusEl.style.display = 'none';
            }
        }
    }

    // ── Phase calculations ──
    const inCoverEditMode = !!_reelsState._coverEditMode;
    const coverDur = (_selectedTask && _selectedTask.cover && _selectedTask.cover.enabled) ? (parseFloat(_selectedTask.cover.duration) || 0.01) : 0;
    const hookDur = _reelsState.hookDuration || 0;
    const totalTime = _getPreviewCurrentTime();
    

    // 如果在【封面编辑模式】，强制进入 CoverPhase
    const inCoverPhase = inCoverEditMode || (coverDur > 0 && totalTime < coverDur);
    _reelsState.coverPhase = inCoverPhase;

    // Hook 阶段偏移
    const inHookPhase = !inCoverEditMode && (hookDur > 0 && totalTime >= coverDur && totalTime < (coverDur + hookDur));
    _reelsState.hookPhase = inHookPhase;

    const contentTime = Math.max(0, totalTime - coverDur - hookDur);
    let multiClips = null;
    if (_selectedTask && _selectedTask.bgMode === 'multi' && !inCoverPhase && !inHookPhase) {
        multiClips = _syncPreviewMultiBackground(_selectedTask, contentTime);
        bgImg = null;
        hasBgImg = false;
    }

    // ── 准备内容视频源 (以防作为毛玻璃背景或前景使用) ──
    let cvDrawSource = null;
    let cvW = 0, cvH = 0;
    if (_selectedTask && _selectedTask.contentVideoPath) {
        const contentVideoEl = document.getElementById('reels-preview-contentvideo');
        const contentImg = _reelsState.previewContentImage;
        let seqImg = null;
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === _selectedTask.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            const fps = 30;
            let frameIdx = Math.floor(_getPreviewCurrentTime() * fps);
            frameIdx = frameIdx % _reelsState.cvSequence.files.length;
            const frameFile = _reelsState.cvSequence.files[frameIdx];
            seqImg = _reelsState.cvSequence.loadedImages[frameFile];
        }

        if (seqImg && seqImg.complete && seqImg.naturalWidth > 0) {
            cvDrawSource = seqImg;
            cvW = seqImg.naturalWidth;
            cvH = seqImg.naturalHeight;
        } else if (contentImg && contentImg.complete && contentImg.naturalWidth > 0) {
            cvDrawSource = contentImg;
            cvW = contentImg.naturalWidth;
            cvH = contentImg.naturalHeight;
        } else if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1 && contentVideoEl.videoWidth > 0) {
            cvDrawSource = contentVideoEl;
            cvW = contentVideoEl.videoWidth;
            cvH = contentVideoEl.videoHeight;
        }
    }

    // ── Cover 阶段渲染 ──
    if (inCoverPhase) {
        let coverBgScale = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgScale) || _bgScalePct;
        let coverBgX = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgX) || _bgXPct;
        let coverBgY = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgY) || _bgYPct;
        let coverBgFlipH = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgFlipH) || (_selectedTask && _selectedTask.bgFlipH) || false;
        let coverBgFlipV = (_selectedTask && _selectedTask.cover && _selectedTask.cover.bgFlipV) || (_selectedTask && _selectedTask.bgFlipV) || false;
        if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.readyState >= 1) {
            const coverVideo = _reelsState._previewCoverVideo;
            const coverTarget = coverVideo.duration > 0 ? Math.min(totalTime, Math.max(0, coverVideo.duration - 0.03)) : totalTime;
            if (!coverVideo.seeking && Math.abs((coverVideo.currentTime || 0) - coverTarget) > 0.08) {
                try { coverVideo.currentTime = coverTarget; } catch (e) { }
            }
        }
        if (_reelsState._previewCoverImage && _reelsState._previewCoverImage.complete && _reelsState._previewCoverImage.naturalWidth > 0) {
            _drawVideoCover(ctx, _reelsState._previewCoverImage, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV);
        } else if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.readyState >= 1) {
            _drawVideoCover(ctx, _reelsState._previewCoverVideo, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV);
        } else if (hasBgImg) {
            _drawVideoCover(ctx, bgImg, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV);            
        } else if (video && video.readyState >= 1) {
            _drawVideoCover(ctx, video, w, h, coverBgScale, coverBgX, coverBgY, coverBgFlipH, coverBgFlipV); 
        } else {
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,w,h);
        }
    } 
    // ── Hook 阶段渲染 (在 Hook 阶段绘制 Hook 视频代替背景) ──
    else if (inHookPhase && hookVideo && hookVideo.src && hookVideo.readyState >= 1 && hookVideo.videoWidth > 0) {
        // 同步 Hook 视频 currentTime 与 mock 时钟，防止漂移
        if (_selectedTask) {
            const trimStart = (_selectedTask.hookTrimStart != null && _selectedTask.hookTrimStart > 0) ? _selectedTask.hookTrimStart : 0;
            const speed = _selectedTask.hookSpeed || 1.0;
            const expectedHookTime = trimStart + ((totalTime - coverDur) * speed);
            if (hookVideo.readyState >= 2 && !hookVideo.seeking && Math.abs(hookVideo.currentTime - expectedHookTime) > 0.3) {
                try { hookVideo.currentTime = expectedHookTime; } catch (e) { }
            }
        }
        _drawVideoCover(ctx, hookVideo, w, h, 100);

        // Hook → Main 转场 (读取 task 配置 of 转场类型 和 时长，与导出一致)
        const hookTransition = (_selectedTask && _selectedTask.hookTransition) || 'none';
        const transitionDur = hookTransition !== 'none' ? ((_selectedTask && _selectedTask.hookTransDuration) || 0.5) : 0;
        const timeToEnd = (coverDur + hookDur) - totalTime;
        if (transitionDur > 0 && timeToEnd < transitionDur && video && video.src && video.readyState >= 1 && video.videoWidth > 0) {
            const alpha = 1.0 - (timeToEnd / transitionDur);
            ctx.save();
            ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
            _drawVideoCover(ctx, video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.contentVideoBlurBg && cvDrawSource && cvW > 0) {
        // 使用内容视频裁切后的毛玻璃背景
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);

        const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
        ctx.save();
        const blurVal = _selectedTask.contentVideoBlur != null ? _selectedTask.contentVideoBlur : 40;
        const brightnessVal = (_selectedTask.contentVideoBrightness != null ? _selectedTask.contentVideoBrightness : 60) / 100;
        ctx.filter = `blur(${blurVal}px) brightness(${brightnessVal})`;
        _drawCroppedVideoCover(ctx, cvDrawSource, cropX, cropY, cropW, cropH, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);
        ctx.restore();

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.contentVideoDirectBg && cvDrawSource && cvW > 0) {
        // 直接使用内容视频作为背景（不模糊铺满）
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, w, h);

        const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
        _drawCroppedVideoCover(ctx, cvDrawSource, cropX, cropY, cropW, cropH, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (_selectedTask && _selectedTask.bgMode === 'multi' && !inCoverPhase && !inHookPhase) {
        _drawPreviewMultiBackground(ctx, w, h, _bgScalePct, _bgXPct, _bgYPct, multiClips);
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (video && video.src && video.readyState >= 1 && video.videoWidth > 0) {
        _drawVideoCover(ctx, video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);
        const fadeFrame = _calcPreviewLoopFadeFrame();
        if (fadeFrame && fadeFrame.video && fadeFrame.video.readyState >= 2) {
            ctx.save();
            ctx.globalAlpha = fadeFrame.alpha;
            _drawVideoCover(ctx, fadeFrame.video, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);
            ctx.restore();
        }

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else if (hasBgImg) {
        // Draw image background using cover mode
        _drawVideoCover(ctx, bgImg, w, h, _bgScalePct, _bgXPct, _bgYPct, _selectedTask?.bgFlipH || false, _selectedTask?.bgFlipV || false);

        // Draw global mask if enabled
        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    } else {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#181818');
        grad.addColorStop(0.5, '#1e1e1e');
        grad.addColorStop(1, '#2a2a2a');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        if (style.global_mask_enabled) {
            ctx.save();
            ctx.globalAlpha = style.global_mask_opacity ?? 0.5;
            ctx.fillStyle = style.global_mask_color || '#000000';
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }
    }

    // --- Content Video or Image ---
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const contentImg = _reelsState.previewContentImage;
    if (_selectedTask && _selectedTask.contentVideoPath && !_selectedTask.contentVideoDirectBg) {
        let drawSource = null;
        let cvW = 0, cvH = 0;
        
        let seqImg = null;
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === _selectedTask.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            const fps = 30;
            // loop sequence:
            let frameIdx = Math.floor(_getPreviewCurrentTime() * fps);
            frameIdx = frameIdx % _reelsState.cvSequence.files.length;
            const frameFile = _reelsState.cvSequence.files[frameIdx];
            seqImg = _reelsState.cvSequence.loadedImages[frameFile];
        }

        if (seqImg && seqImg.complete && seqImg.naturalWidth > 0) {
            drawSource = seqImg;
            cvW = seqImg.naturalWidth;
            cvH = seqImg.naturalHeight;
        } else if (contentImg && contentImg.complete && contentImg.naturalWidth > 0) {
            drawSource = contentImg;
            cvW = contentImg.naturalWidth;
            cvH = contentImg.naturalHeight;
        } else if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1 && contentVideoEl.videoWidth > 0) {
            drawSource = contentVideoEl;
            cvW = contentVideoEl.videoWidth;
            cvH = contentVideoEl.videoHeight;
        }

        if (drawSource && cvW > 0) {
            const { cropX, cropY, cropW, cropH } = _parseCropString(_selectedTask.contentVideoCrop);
            const sx = cvW * cropX;
            const sy = cvH * cropY;
            const sWidth = cvW * cropW;
            const sHeight = cvH * cropH;

            const cScale = (_selectedTask.contentVideoScale || 100) / 100;
            
            // Auto scale to fit width: width is 1080 -> canvas.width (w)
            const baseScale = w / sWidth;
            const finalScale = baseScale * cScale;
            
            const drawW = sWidth * finalScale;
            const drawH = sHeight * finalScale;
            
            // Default position: centered
            let drawX = (w - drawW) / 2;
            let drawY = (h - drawH) / 2;
            
            if (_selectedTask.contentVideoX && _selectedTask.contentVideoX !== 'center') {
                const relX = parseFloat(_selectedTask.contentVideoX);
                if (!isNaN(relX)) Math.abs(relX) <= 1 ? drawX += w * relX : drawX += (relX / 1080) * w;
            }
            if (_selectedTask.contentVideoY && _selectedTask.contentVideoY !== 'center') {
                const relY = parseFloat(_selectedTask.contentVideoY);
                if (!isNaN(relY)) Math.abs(relY) <= 1 ? drawY += h * relY : drawY += (relY / 1920) * h;
            }
            
            _drawImageFlipped(ctx, drawSource, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, _selectedTask.contentVideoFlipH, _selectedTask.contentVideoFlipV);
        }
    }

    // Calculate max overlay end time for cycle period
    let maxOverlayEnd = 0;
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        const overlays = _reelsState.overlayProxy.overlayMgr.overlays || [];
        for (const ov of overlays) {
            const end = parseFloat(ov.end || 0);
            if (end > maxOverlayEnd) maxOverlayEnd = end;
        }
    }

    let cycleTime = _getPreviewCurrentTime();
    // Subtract hook and cover duration so content time starts at 0 after hook ends
    const _hookDur = _reelsState.hookDuration || 0;
    const _coverDur = (_selectedTask && _selectedTask.cover && _selectedTask.cover.enabled) ? (parseFloat(_selectedTask.cover.duration) || 0.01) : 0;
    const _inHookPhase = _reelsState.hookPhase;
    const _inCoverPhase = _reelsState.coverPhase;
    
    if (!inCoverEditMode && (_hookDur > 0 || _coverDur > 0) && !_inHookPhase && !_inCoverPhase) {
        cycleTime = Math.max(0, cycleTime - _hookDur - _coverDur);
    }
    if (!(cycleTime > 0)) {
        // 检查是否有媒体正在播放
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const isMediaPlaying = _isPreviewMediaPlaying(video) || _isPreviewMediaPlaying(audio);

        if (isMediaPlaying) {
            // 媒体正在播放但 currentTime 尚为0，等下一帧
            cycleTime = 0;
        } else {
            // 没有媒体在播放 → 静止在 time=0 (不再自动循环)
            cycleTime = 0;
        }
    }

    const demoWords = previewText.split(/\s+/).filter(Boolean);
    const wordCount = demoWords.length || 1;
    const totalDur = Math.max(3, wordCount * 0.6);

    const wordsInfo = demoWords.map((w, i) => ({
        word: w,
        start: (totalDur * i / wordCount),
        end: (totalDur * (i + 1) / wordCount),
    }));

    const segment = {
        text: previewText,
        start: 0,
        end: totalDur,
        words: wordsInfo,
    };

    // If an actual task and segment exists, try to sync it.
    // For now, render exactly what the user inputs as a test segment if no timeline clip matches.
    // A more sophisticated system will find the correct segment based on video.currentTime
    let activeSegment = (_inHookPhase || _inCoverPhase) ? null : segment; // Hook 或 Cover 阶段不显示字母
    const taskForAudio = _getSelectedTask();
    const aDurScale = taskForAudio && taskForAudio.audioDurScale ? taskForAudio.audioDurScale / 100 : 1;
    const audioCycleTime = cycleTime / aDurScale;

    if (_reelsState.selectedIdx !== -1 && taskForAudio) {
        const segs = taskForAudio.segments || [];
        // Find segment
        const s = segs.find(s => audioCycleTime >= s.start && audioCycleTime <= s.end);
        if (s) {
            activeSegment = s;
        } else if ((style.scrolling_mode || style.fullpage_typewriter) && segs.length > 0) {
            // Scrolling/typewriter mode: find nearest segment so lines stay visible between gaps
            let best = segs[0];
            for (let i = 1; i < segs.length; i++) {
                if (segs[i].start <= audioCycleTime) best = segs[i];
                else break;
            }
            activeSegment = best;
        } else {
            // Not speaking, don't show test text
            activeSegment = null;
        }
    }

    const subtitleToggle = document.getElementById('reels-subtitle-toggle');
    const showSubtitle = !subtitleToggle || subtitleToggle.checked;
    const rangeToggle = document.getElementById('reels-show-subtitle-range');
    const showSubtitleRange = !rangeToggle || rangeToggle.checked;

    if (showSubtitleRange) {
        _drawSubtitlePreviewRange(ctx, style, w, h);
    }

    if (activeSegment && showSubtitle) {
        if (typeof _selectedTask !== 'undefined' && _selectedTask && _selectedTask.segments) {
            renderer.setContextSegments(_selectedTask.segments);
        } else {
            renderer.setContextSegments([activeSegment]);
        }
        renderer.renderSubtitle(style, activeSegment, audioCycleTime, w, h);
    }

    // ── 渲染覆层 (文字卡片等) ──
    if (!inCoverEditMode && _inCoverPhase) {
        // Normal mode > Cover phase -> ONLY render Cover overlays
        const coverOverlays = (_selectedTask && _selectedTask.cover && _selectedTask.cover.overlays) ? _selectedTask.cover.overlays : [];
        if (coverOverlays.length > 0 && window.ReelsOverlay) {
            for (const ov of coverOverlays) {
                if (ov.disabled) continue;
                ReelsOverlay.drawOverlay(ctx, ov, 0, w, h);
            }
        }
    } else if (!inCoverEditMode && _inHookPhase) {
        // Normal mode > Hook phase -> Do NOT render any overlays
    } else if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        // Cover edit mode OR Normal mode > Main Phase -> Render whatever overlayMgr holds
        const ovMgr = _reelsState.overlayProxy.overlayMgr;
        const overlays = ovMgr.overlays || [];
        if (overlays.length > 0 && window.ReelsOverlay) {
            // 注入覆层列表引用（供跟随绑定），确保 scroll 先渲染
            const sorted = overlays.filter(o => !o.disabled).slice().sort((a, b) => {
                return (a.type === 'scroll' ? 0 : 1) - (b.type === 'scroll' ? 0 : 1);
            });
            for (const ov of sorted) {
                ov._allOverlays = overlays;
                // "显示终点" 模式：滚动字幕用终点时间渲染
                let ovTime = cycleTime;
                if (_reelsState._scrollPreviewEnd && ov.type === 'scroll') {
                    ovTime = parseFloat(ov.end || 10); // 用 end 时间，确保在时间范围内
                }
                
                ov._subtitleTimeMode = _selectedTask ? _selectedTask.subtitleTimeMode : null;
                ov._subtitleTimeSlices = _selectedTask ? _selectedTask.subtitleTimeSlices : null;

                ReelsOverlay.drawOverlay(ctx, ov, ovTime, w, h);
            }
        }
        // ── 选中框 + 拖拽手柄 ──
        _drawOverlaySelectionUI(ctx, w, h);
    }

    // ── AI 水印 ──
    _drawWatermarks(ctx, w, h);

    // ── 更新时间显示 (覆层预览时间) ──
    const dDur = _getPreviewDuration();
    const cTime = _getPreviewCurrentTime();

    // 如果没有真实的媒体元素 或 mock时钟正在驱动(Cover/Hook阶段)，渲染循环必须主动驱动时间轴和 UI 的更新
    // 即使存在 master 元素，也需要在暂停/拖拽状态下更新时间显示（_updatePreviewTimeUI 内部有 scrubbing 保护）
    if (!_getPreviewMasterElement() || _reelsState.mockPlaying || _isPreviewSeekLocked() || !cTime) {
        _updatePreviewTimeUI(cTime, dDur);
    }

    // ── Hook → Main 自动切换 ──
    _syncHookPhaseTransition();

    // 检查是否到达终点以自动停止
    if (!_isPreviewLoopEnabled() && dDur > 0 && cTime >= dDur) {
        // Reached the end
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const fadeVideo = _reelsState.previewFadeVideo;
        const hookVideoStop = document.getElementById('reels-preview-hook-video');
        const btn = document.getElementById('reels-preview-play');
        
        // Only force pause if it wasn't already manually paused to avoid spamming
        const isPlaying = _isPreviewMediaPlaying(audio) || _isPreviewMediaPlaying(video) || _reelsState.mockPlaying || _isPreviewMediaPlaying(hookVideoStop);
        if (isPlaying) {
            if (audio) audio.pause();
            if (video) video.pause();
            if (fadeVideo) fadeVideo.pause();
            if (hookVideoStop) hookVideoStop.pause();
            if (_reelsState._bgmAudioEl) _reelsState._bgmAudioEl.pause();
            
            _reelsState.mockPlaying = false;
            _reelsState.mockPausedTime = dDur; // Ensure UI stays at the end
            if (btn) btn.textContent = '▶️';
            // 确保进度条刚好停在满格位置
            _updatePreviewTimeUI(dDur, dDur);
        }
    }

    if (_reelsState.previewRAF) cancelAnimationFrame(_reelsState.previewRAF);
    const panel = document.getElementById('batch-reels-panel');
    if (panel && (panel.classList.contains('active') || panel.style.display !== 'none')) {
        _reelsState.previewRAF = requestAnimationFrame(() => reelsUpdatePreview());
    }
}

function _drawSubtitlePreviewRange(ctx, style, canvasW, canvasH) {
    if (!ctx || !style) return;
    ctx.save();
    ctx.setLineDash([10, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 224, 255, 0.9)';
    ctx.fillStyle = 'rgba(0, 224, 255, 0.08)';

    if (style.anim_in_type === 'word_random_position' && style.random_position_use_layout_range !== false) {
        const cx = (typeof style.pos_x === 'number' && style.pos_x <= 1) ? style.pos_x * canvasW : (style.pos_x || canvasW / 2);
        const cy = (typeof style.pos_y === 'number' && style.pos_y <= 1) ? style.pos_y * canvasH : (style.pos_y || canvasH * 0.5);
        const rangeW = Math.max(20, Math.min(120, parseFloat(style.wrap_width_percent) || 70)) / 100 * canvasW;
        const rangeH = Math.max(10, Math.min(100, parseFloat(style.random_position_height_percent) || 35)) / 100 * canvasH;
        const x = cx - rangeW / 2;
        const y = cy - rangeH / 2;

        ctx.strokeStyle = 'rgba(255, 196, 64, 0.95)';
        ctx.fillStyle = 'rgba(255, 196, 64, 0.10)';
        ctx.strokeRect(x, y, rangeW, rangeH);
        ctx.fillRect(x, y, rangeW, rangeH);

        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 196, 64, 0.55)';
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx, y + rangeH);
        ctx.moveTo(x, cy);
        ctx.lineTo(x + rangeW, cy);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 196, 64, 0.95)';
        ctx.font = '14px sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(`随机区域 ${Math.round(style.wrap_width_percent || 70)}% x ${Math.round(style.random_position_height_percent || 35)}%`, x + 8, y + 8);
        ctx.restore();
        return;
    }

    if (style.advanced_textbox_enabled) {
        const x = parseFloat(style.advanced_textbox_x) || 0;
        const y = parseFloat(style.advanced_textbox_y) || 0;
        const w = Math.max(80, parseFloat(style.advanced_textbox_w) || canvasW * 0.8);
        const h = Math.max(40, parseFloat(style.advanced_textbox_h) || 200);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
        return;
    }

    const cx = (typeof style.pos_x === 'number' && style.pos_x <= 1) ? style.pos_x * canvasW : (style.pos_x || canvasW / 2);
    const cy = (typeof style.pos_y === 'number' && style.pos_y <= 1) ? style.pos_y * canvasH : (style.pos_y || canvasH * 0.5);
    const wrapPercent = Math.max(20, Math.min(120, parseFloat(style.wrap_width_percent) || 90));
    const textW = Math.max(200, Math.floor(canvasW * (wrapPercent / 100)));
    const fontSize = parseFloat(style.fontsize) || 74;
    const lineSpacing = parseFloat(style.line_spacing) || 0;
    const lines = Math.max(1, parseInt(style.wrap_lines, 10) || 2);
    const lineH = fontSize * 1.2;
    const textH = lineH * lines + lineSpacing * Math.max(0, lines - 1);
    const padX = parseFloat(style.box_padding_x) || 12;
    const padY = parseFloat(style.box_padding_y) || 8;

    const x = cx - textW / 2 - padX;
    const y = cy - textH / 2 - padY;
    const w = textW + padX * 2;
    const h = textH + padY * 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);

    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0, 224, 255, 0.45)';
    ctx.beginPath();
    ctx.moveTo(cx, y);
    ctx.lineTo(cx, y + h);
    ctx.stroke();
    ctx.restore();
}const watermarkImageCache = new Map();

function _normalizeWatermarkPath(pathValue) {
    if (!pathValue) return '';
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        try {
            const u = window.electronAPI.toFileUrl(pathValue);
            if (u) return u;
        } catch (e) {
            console.error('Failed to normalize watermark path with toFileUrl:', e);
        }
    }
    if (/^file:\/\//i.test(pathValue)) {
        return pathValue;
    }
    if (/^[a-zA-Z]:[/\\]/.test(pathValue)) {
        const replaced = pathValue.replace(/\\/g, '/');
        const parts = replaced.split('/');
        const drive = parts[0];
        const rest = parts.slice(1).map(encodeURIComponent).join('/');
        return `file:///${drive}/${rest}`;
    }
    if (pathValue.startsWith('/')) {
        return `file://${pathValue.split('/').map(p => p === '' ? '' : encodeURIComponent(p)).join('/')}`;
    }
    return pathValue;
}

function _getWatermarkImage(pathValue, onLoadedCallback) {
    if (!pathValue) return null;
    const normalized = _normalizeWatermarkPath(pathValue);
    let entry = watermarkImageCache.get(normalized);
    if (!entry) {
        const img = new Image();
        entry = { img, status: 'loading', path: normalized };
        img.onload = () => {
            entry.status = 'loaded';
            if (onLoadedCallback) onLoadedCallback();
        };
        img.onerror = () => {
            entry.status = 'error';
            if (onLoadedCallback) onLoadedCallback();
        };
        img.src = normalized;
        watermarkImageCache.set(normalized, entry);
    }
    return entry;
}

/**
 * 绘制 AI 水印 (预览 + 导出共用)
 */
function _drawWatermarks(ctx, canvasW, canvasH) {
    const watermarks = _reelsState.watermarks || [];
    for (const wm of watermarks) {
        if (!wm.enabled) continue;

        if (wm.type === 'image') {
            if (!wm.imagePath) continue;
            const imgEntry = _getWatermarkImage(wm.imagePath, () => {
                if (typeof reelsUpdatePreview === 'function') {
                    reelsUpdatePreview();
                }
            });
            if (!imgEntry || imgEntry.status !== 'loaded' || !imgEntry.img) continue;

            const img = imgEntry.img;
            const imgW = img.naturalWidth || img.width;
            const imgH = img.naturalHeight || img.height;
            if (imgW <= 0 || imgH <= 0) continue;

            const scalePct = wm.imageScale || 100;
            const scaledW = imgW * (scalePct / 100);
            const scaledH = imgH * (scalePct / 100);

            // 计算位置参考点 px, py
            const margin = 16;
            let px, py;
            switch (wm.position || 'top-right') {
                case 'top-left': px = margin; py = margin; break;
                case 'top-center': px = canvasW / 2; py = margin; break;
                case 'top-right': px = canvasW - margin; py = margin; break;
                case 'center-left': px = margin; py = canvasH / 2; break;
                case 'center': px = canvasW / 2; py = canvasH / 2; break;
                case 'center-right': px = canvasW - margin; py = canvasH / 2; break;
                case 'bottom-left': px = margin; py = canvasH - margin; break;
                case 'bottom-center': px = canvasW / 2; py = canvasH - margin; break;
                case 'bottom-right': px = canvasW - margin; py = canvasH - margin; break;
                case 'custom': px = 0; py = 0; break;
                default: px = canvasW - margin; py = margin; break;
            }
            px += (wm.x || 0);
            py += (wm.y || 0);

            // 根据缩放中心（anchor）计算实际 drawX, drawY
            let drawX, drawY;
            const anchor = wm.imageAnchor || 'center';
            switch (anchor) {
                case 'top-left':
                    drawX = px; drawY = py;
                    break;
                case 'top-right':
                    drawX = px - scaledW; drawY = py;
                    break;
                case 'bottom-left':
                    drawX = px; drawY = py - scaledH;
                    break;
                case 'bottom-right':
                    drawX = px - scaledW; drawY = py - scaledH;
                    break;
                case 'center':
                default:
                    drawX = px - scaledW / 2; drawY = py - scaledH / 2;
                    break;
            }

            ctx.save();
            ctx.globalAlpha = wm.opacity ?? 1.0;
            _drawImageFlipped(ctx, img, drawX, drawY, scaledW, scaledH, undefined, undefined, undefined, undefined, wm.flipH, wm.flipV);
            ctx.restore();
        } else {
            if (!wm.text) continue;
            const fontSize = wm.fontSize || 20;
            const padH = Math.round(fontSize * 0.5);
            const padV = Math.round(fontSize * 0.35);

            ctx.save();
            ctx.font = `${fontSize}px Arial, sans-serif`;
            const lines = wm.text.split('\n');
            let maxTextW = 0;
            for (const line of lines) {
                maxTextW = Math.max(maxTextW, ctx.measureText(line).width);
            }
            const boxW = maxTextW + padH * 2;
            const lineSpacing = 4;
            const boxH = lines.length * fontSize + (lines.length - 1) * lineSpacing + padV * 2;

            // 计算位置
            const margin = 16;
            let bx, by;
            switch (wm.position || 'top-right') {
                case 'top-left': bx = margin; by = margin; break;
                case 'top-center': bx = (canvasW - boxW) / 2; by = margin; break;
                case 'top-right': bx = canvasW - boxW - margin; by = margin; break;
                case 'center-left': bx = margin; by = (canvasH - boxH) / 2; break;
                case 'center': bx = (canvasW - boxW) / 2; by = (canvasH - boxH) / 2; break;
                case 'center-right': bx = canvasW - boxW - margin; by = (canvasH - boxH) / 2; break;
                case 'bottom-left': bx = margin; by = canvasH - boxH - margin; break;
                case 'bottom-center': bx = (canvasW - boxW) / 2; by = canvasH - boxH - margin; break;
                case 'bottom-right': bx = canvasW - boxW - margin; by = canvasH - boxH - margin; break;
                case 'custom': bx = 0; by = 0; break;
                default: bx = canvasW - boxW - margin; by = margin; break;
            }
            bx += (wm.x || 0);
            by += (wm.y || 0);

            // 半透明背景
            ctx.globalAlpha = wm.bgOpacity ?? 0.5;
            ctx.fillStyle = wm.bgColor || '#000000';
            const r = Math.round(fontSize * 0.2);
            ctx.beginPath();
            ctx.roundRect(bx, by, boxW, boxH, r);
            ctx.fill();

            // 文字
            ctx.globalAlpha = wm.textOpacity ?? 1.0;
            ctx.fillStyle = wm.color || '#FFFFFF';
            ctx.textBaseline = 'middle';
            let currentY = by + padV + fontSize / 2;
            for (const line of lines) {
                ctx.fillText(line, bx + padH, currentY);
                currentY += fontSize + lineSpacing;
            }
            ctx.restore();
        }
    }
}

const REELS_DEFAULT_WATERMARK = [
    {
        type: 'text',
        text: 'AI Generated', fontSize: 25, color: '#FFFFFF', textOpacity: 0.8,
        bgColor: '#000000', bgOpacity: 0.5, position: 'top-right', enabled: true
    },
    {
        type: 'text',
        text: 'Attribution to11.ai', fontSize: 20, color: '#FFFFFF', textOpacity: 1.0,
        bgColor: '#000000', bgOpacity: 0.5, position: 'bottom-left', enabled: true
    },
    {
        type: 'image',
        imagePath: (window.electronAPI && window.electronAPI.resolveAssetUrl)
            ? window.electronAPI.resolveAssetUrl('colossyan.png')
            : 'assets/colossyan.png',
        imageScale: 100,
        imageAnchor: 'center',
        opacity: 1.0,
        position: 'center',
        enabled: false
    }
];

function _reelsSaveWatermarks() {
    try {
        localStorage.setItem(REELS_WATERMARK_STORAGE_KEY, JSON.stringify(_reelsState.watermarks));
    } catch (e) { /* quota exceeded etc */ }
}

function _reelsLoadWatermarks() {
    try {
        const saved = localStorage.getItem(REELS_WATERMARK_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                _reelsState.watermarks = parsed;
                // 确保用户已保存的列表中也包含新的 colossyan 默认预设
                const hasColossyan = parsed.some(wm => wm.type === 'image' && wm.imagePath && wm.imagePath.includes('colossyan.png'));
                if (!hasColossyan) {
                    _reelsState.watermarks.push({
                        type: 'image',
                        imagePath: (window.electronAPI && window.electronAPI.resolveAssetUrl)
                            ? window.electronAPI.resolveAssetUrl('colossyan.png')
                            : 'assets/colossyan.png',
                        imageScale: 100,
                        imageAnchor: 'center',
                        opacity: 1.0,
                        position: 'center',
                        enabled: false
                    });
                    _reelsSaveWatermarks();
                }
                return;
            }
        }
    } catch (e) { /* parse error */ }
    // No saved data — use default
    _reelsState.watermarks = JSON.parse(JSON.stringify(REELS_DEFAULT_WATERMARK));
}

function reelsAddWatermark() {
    _reelsState.watermarks.push({
        type: 'text',
        text: 'Attribution to11.ai', fontSize: 20, color: '#FFFFFF', textOpacity: 1.0,
        bgColor: '#000000', bgOpacity: 0.5, position: 'bottom-left', enabled: true,
    });
    _reelsRefreshWatermarkUI();
    _reelsSaveWatermarks();
}

function reelsRemoveWatermark(idx) {
    _reelsState.watermarks.splice(idx, 1);
    _reelsRefreshWatermarkUI();
    _reelsSaveWatermarks();
}

const REELS_WATERMARK_PRESETS_KEY = 'reels_watermark_presets';

function _getWatermarkPresets() {
    try {
        return JSON.parse(localStorage.getItem(REELS_WATERMARK_PRESETS_KEY)) || {};
    } catch {
        return {};
    }
}

function _saveWatermarkPresets(presets) {
    localStorage.setItem(REELS_WATERMARK_PRESETS_KEY, JSON.stringify(presets));
}

function _refreshWatermarkPresetList() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const presets = _getWatermarkPresets();
    const currVal = select.value;
    select.innerHTML = '<option value="">-- 选择预设 --</option>';
    for (const name in presets) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
    }
    if (presets[currVal]) {
        select.value = currVal;
    }
}

async function reelsSaveWatermarkPreset() {
    if (!_reelsState.watermarks || _reelsState.watermarks.length === 0) {
        alert('当前没有水印，无法保存预设');
        return;
    }
    try {
        const name = await _showInputDialog('保存水印组合预设', '请输入预设名称（包含所有启用的水印）');
        if (!name) return;
        const presets = _getWatermarkPresets();
        if (presets[name]) {
            const ok = confirm(`水印预设 "${name}" 已存在，是否覆盖？`);
            if (!ok) return;
        }
        presets[name] = JSON.parse(JSON.stringify(_reelsState.watermarks));
        _saveWatermarkPresets(presets);
        _refreshWatermarkPresetList();
        const select = document.getElementById('reels-watermark-preset-select');
        if (select) select.value = name;
    } catch (e) {
        console.error('Save watermark preset error:', e);
    }
}

function reelsLoadWatermarkPreset() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) return;
    const presets = _getWatermarkPresets();
    if (presets[name]) {
        _reelsState.watermarks = JSON.parse(JSON.stringify(presets[name]));
        localStorage.setItem(REELS_WATERMARK_STORAGE_KEY, JSON.stringify(_reelsState.watermarks));
        _reelsRefreshWatermarkUI();
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    }
}

function reelsDeleteWatermarkPreset() {
    const select = document.getElementById('reels-watermark-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) {
        alert('请先选择要删除的预设');
        return;
    }
    if (confirm(`确定要删除水印预设 "${name}" 吗？`)) {
        const presets = _getWatermarkPresets();
        delete presets[name];
        _saveWatermarkPresets(presets);
        _refreshWatermarkPresetList();
        select.value = '';
    }
}

function reelsExportWatermarkPresets() {
    const presets = _getWatermarkPresets();
    if (Object.keys(presets).length === 0) {
        alert('没有可以导出的水印预设！');
        return;
    }
    const jsonStr = JSON.stringify(presets, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `watermark_presets_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function reelsImportWatermarkPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const imported = JSON.parse(ev.target.result);
                if (typeof imported !== 'object' || imported === null) throw new Error('Invalid JSON');
                const presets = _getWatermarkPresets();
                let addedCount = 0;
                let overwrittenCount = 0;
                const conflicts = [];
                for (const k in imported) {
                    if (Array.isArray(imported[k]) && presets[k]) {
                        conflicts.push(k);
                    }
                }

                if (conflicts.length > 0) {
                    const ok = confirm(`导入的水印预设中包含以下已存在的预设：\n${conflicts.join(', ')}\n\n是否覆盖它们？(点击「取消」将跳过这些冲突的预设)`);
                    for (const k in imported) {
                        if (Array.isArray(imported[k])) {
                            if (presets[k]) {
                                if (ok) {
                                    presets[k] = imported[k];
                                    overwrittenCount++;
                                }
                            } else {
                                presets[k] = imported[k];
                                addedCount++;
                            }
                        }
                    }
                } else {
                    for (const k in imported) {
                        if (Array.isArray(imported[k])) {
                            presets[k] = imported[k];
                            addedCount++;
                        }
                    }
                }

                _saveWatermarkPresets(presets);
                _refreshWatermarkPresetList();
                alert(`✅ 导入完成：新增了 ${addedCount} 个水印预设，覆盖了 ${overwrittenCount} 个水印预设。`);
            } catch (err) {
                alert('导入失败，请检查是否是有效的水印预设 JSON 文件！');
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

async function reelsChooseWatermarkImage(idx) {
    const path = await _pickSingleFile('选择水印图片', ['png', 'jpg', 'jpeg', 'webp', 'gif']);
    if (path) {
        if (_reelsState.watermarks && _reelsState.watermarks[idx]) {
            _reelsState.watermarks[idx].imagePath = path;
            _reelsRefreshWatermarkUI();
            _reelsSyncWatermarkFromUI();
        }
    }
}

function _reelsSyncWatermarkFromUI() {
    const list = document.getElementById('reels-watermark-list');
    if (!list) return;
    const rows = list.querySelectorAll('.wm-row');
    rows.forEach((row, i) => {
        const wm = _reelsState.watermarks[i];
        if (!wm) return;
        wm.enabled = row.querySelector('.wm-enabled')?.checked ?? true;
        wm.type = row.querySelector('.wm-type')?.value || 'text';
        wm.position = row.querySelector('.wm-position')?.value || 'top-right';
        wm.x = parseInt(row.querySelector('.wm-x')?.value) || 0;
        wm.y = parseInt(row.querySelector('.wm-y')?.value) || 0;

        if (wm.type === 'image') {
            wm.imagePath = row.querySelector('.wm-imagepath')?.value || '';
            wm.imageScale = parseInt(row.querySelector('.wm-imagescale')?.value) || 100;
            wm.imageAnchor = row.querySelector('.wm-imageanchor')?.value || 'center';
            const rawOp = parseFloat(row.querySelector('.wm-opacity')?.value);
            wm.opacity = Number.isFinite(rawOp) ? rawOp / 100 : 1.0;
            wm.flipH = row.querySelector('.wm-fliph')?.checked ?? false;
            wm.flipV = row.querySelector('.wm-flipv')?.checked ?? false;
        } else {
            wm.text = row.querySelector('.wm-text')?.value || '';
            wm.fontSize = parseInt(row.querySelector('.wm-fontsize')?.value) || 20;
            wm.color = row.querySelector('.wm-color')?.value || '#FFFFFF';
            wm.bgColor = row.querySelector('.wm-bgcolor')?.value || '#000000';
            const rawBgOp = parseFloat(row.querySelector('.wm-bgopacity')?.value);
            wm.bgOpacity = Number.isFinite(rawBgOp) ? rawBgOp / 100 : 0.5;
            const rawTextOp = parseFloat(row.querySelector('.wm-textopacity')?.value);
            wm.textOpacity = Number.isFinite(rawTextOp) ? rawTextOp / 100 : 1.0;
        }
    });
    _reelsSaveWatermarks();
    if (typeof reelsUpdatePreview === 'function') {
        reelsUpdatePreview();
    }
}

function _reelsRefreshWatermarkUI() {
    const list = document.getElementById('reels-watermark-list');
    const countEl = document.getElementById('reels-wm-count');
    if (!list) return;
    const wms = _reelsState.watermarks;
    if (countEl) countEl.textContent = `${wms.length} 个`;
    const posOptions = [
        ['top-left', '左上'], ['top-center', '上中'], ['top-right', '右上'],
        ['center-left', '左中'], ['center', '居中'], ['center-right', '右中'],
        ['bottom-left', '左下'], ['bottom-center', '下中'], ['bottom-right', '右下'],
        ['custom', '自定义坐标']
    ].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

    list.innerHTML = wms.map((wm, i) => {
        const isImage = wm.type === 'image';
        const typeSelectHtml = `
            <select class="wm-type select" style="width:65px;font-size:11px;padding:2px;" onchange="_reelsSyncWatermarkFromUI(); _reelsRefreshWatermarkUI();">
                <option value="text" ${!isImage ? 'selected' : ''}>文字</option>
                <option value="image" ${isImage ? 'selected' : ''}>图片</option>
            </select>
        `;

        let contentHtml = '';
        let optionsHtml = '';

        if (isImage) {
            contentHtml = `
                <div style="display:flex;align-items:center;gap:4px;flex:1;">
                    <input type="text" class="wm-imagepath input" readonly value="${wm.imagePath || ''}" style="flex:1;font-size:11px;padding:4px 6px;" placeholder="未选择图片">
                    <button class="btn btn-secondary" style="font-size:11px;padding:2px 6px;" onclick="reelsChooseWatermarkImage(${i})">选择</button>
                </div>
            `;
            optionsHtml = `
                 <label style="display:flex;align-items:center;gap:2px;">缩放中心:
                    <select class="wm-imageanchor select" style="width:75px;font-size:11px;padding:3px;" onchange="_reelsSyncWatermarkFromUI()">
                        <option value="top-left" ${wm.imageAnchor === 'top-left' ? 'selected' : ''}>左上</option>
                        <option value="top-right" ${wm.imageAnchor === 'top-right' ? 'selected' : ''}>右上</option>
                        <option value="bottom-left" ${wm.imageAnchor === 'bottom-left' ? 'selected' : ''}>左下</option>
                        <option value="bottom-right" ${wm.imageAnchor === 'bottom-right' ? 'selected' : ''}>右下</option>
                        <option value="center" ${wm.imageAnchor === 'center' || !wm.imageAnchor ? 'selected' : ''}>居中</option>
                    </select>
                </label>
                <label style="display:flex;align-items:center;gap:2px;">缩放:<input type="range" class="wm-imagescale-slider" min="10" max="500" value="${wm.imageScale || 100}" style="width:50px;height:14px;accent-color:#4fc3f7;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-imagescale').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-imagescale input input-small" type="number" value="${wm.imageScale || 100}" min="10" max="500" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-imagescale-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:2px;">透明:<input type="range" class="wm-opacity-slider" min="0" max="100" value="${Math.round((wm.opacity ?? 1.0) * 100)}" style="width:50px;height:14px;accent-color:#9b59b6;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-opacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-opacity input input-small" type="number" value="${Math.round((wm.opacity ?? 1.0) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-opacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" class="wm-fliph" ${wm.flipH ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 左右翻转</label>
                <label style="display:flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" class="wm-flipv" ${wm.flipV ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 上下翻转</label>
            `;
        } else {
            contentHtml = `
                <textarea class="wm-text input" style="flex:1;font-size:11px;padding:4px 6px;resize:vertical;min-height:28px;" rows="1" oninput="_reelsSyncWatermarkFromUI()">${(wm.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
            `;
            optionsHtml = `
                <label style="display:flex;align-items:center;gap:2px;">字号:<input class="wm-fontsize input input-small" type="number" value="${wm.fontSize || 20}" min="8" max="80" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">字色:<input class="wm-color" type="color" value="${wm.color || '#FFFFFF'}" style="width:24px;height:20px;border:none;cursor:pointer;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">字透明:<input type="range" class="wm-textopacity-slider" min="0" max="100" value="${Math.round((wm.textOpacity ?? 1.0) * 100)}" style="width:50px;height:14px;accent-color:#4fc3f7;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-textopacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-textopacity input input-small" type="number" value="${Math.round((wm.textOpacity ?? 1.0) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-textopacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
                <label style="display:flex;align-items:center;gap:2px;">底色:<input class="wm-bgcolor" type="color" value="${wm.bgColor || '#000000'}" style="width:24px;height:20px;border:none;cursor:pointer;" oninput="_reelsSyncWatermarkFromUI()"></label>
                <label style="display:flex;align-items:center;gap:2px;">底透明:<input type="range" class="wm-bgopacity-slider" min="0" max="100" value="${Math.round((wm.bgOpacity ?? 0.5) * 100)}" style="width:50px;height:14px;accent-color:#9b59b6;vertical-align:middle;" oninput="this.parentElement.querySelector('.wm-bgopacity').value=this.value;_reelsSyncWatermarkFromUI()"><input class="wm-bgopacity input input-small" type="number" value="${Math.round((wm.bgOpacity ?? 0.5) * 100)}" min="0" max="100" style="width:38px;font-size:10px;padding:2px;text-align:center;" oninput="this.parentElement.querySelector('.wm-bgopacity-slider').value=this.value;_reelsSyncWatermarkFromUI()">%</label>
            `;
        }

        return `
            <div class="wm-row" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px;padding:6px;background:var(--bg-tertiary);border-radius:6px;">
                <div style="display:flex;gap:6px;width:100%;align-items:flex-start;">
                    <label style="display:flex;align-items:center;gap:3px;margin-top:4px;"><input type="checkbox" class="wm-enabled" ${wm.enabled ? 'checked' : ''} onchange="_reelsSyncWatermarkFromUI()"> 启用</label>
                    <label style="display:flex;align-items:center;gap:3px;margin-top:4px;">类型: ${typeSelectHtml}</label>
                    ${contentHtml}
                    <button class="btn btn-secondary" style="font-size:10px;padding:2px 6px;color:#f87171;margin-top:4px;" onclick="reelsRemoveWatermark(${i})">✕</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;">
                    ${optionsHtml}
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;">
                    <label style="display:flex;align-items:center;gap:4px;">位置: <select class="wm-position select" style="width:85px;font-size:11px;padding:3px;" onchange="_reelsSyncWatermarkFromUI()">${posOptions.replace(`value="${wm.position || 'top-right'}"`, `value="${wm.position || 'top-right'}" selected`)}</select></label>
                    <label style="display:flex;align-items:center;gap:2px;margin-left:4px;" title="偏移值（可填负数）">偏移X:<input class="wm-x input input-small" type="number" value="${wm.x || 0}" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                    <label style="display:flex;align-items:center;gap:2px;">Y:<input class="wm-y input input-small" type="number" value="${wm.y || 0}" style="width:48px;font-size:11px;padding:3px;" oninput="_reelsSyncWatermarkFromUI()"></label>
                </div>
            </div>
        `;
    }).join('');

    // 添加鼠标左右拖拽调整数值功能
    list.querySelectorAll('input[type="number"]').forEach(el => {
        el.style.cursor = 'ew-resize';
        let dragging = false, startX = 0, startVal = 0;
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === el) return;
            dragging = true;
            startX = e.clientX;
            startVal = parseFloat(el.value) || 0;
            e.preventDefault();
            const onMove = (me) => {
                if (!dragging) return;
                const dx = me.clientX - startX;
                const speed = me.shiftKey ? 0.1 : 1;
                const step = parseFloat(el.getAttribute('step')) || 1;
                let newVal = Math.round((startVal + dx * speed * step) / step) * step;
                
                // 处理极值
                const min = parseFloat(el.getAttribute('min'));
                const max = parseFloat(el.getAttribute('max'));
                if (!isNaN(min) && newVal < min) newVal = min;
                if (!isNaN(max) && newVal > max) newVal = max;

                el.value = newVal;
                // 触发同步和预览刷新（通过 dispatchEvent 触发 inline oninput）
                el.dispatchEvent(new Event('input'));
            };
            const onUp = () => {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            el.focus();
            el.select();
        });
    });
}

// 初始化水印 — 从 localStorage 恢复
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        _reelsLoadWatermarks();
        _reelsRefreshWatermarkUI();
        _refreshWatermarkPresetList();
        _initAllSubtitleNumberInputsDrag();
    }, 500);
});

function _initAllSubtitleNumberInputsDrag() {
    const container = document.getElementById('inspector-tab-subtitle');
    if (!container) return;
    
    container.querySelectorAll('input[type="number"]').forEach(el => {
        if (el.dataset.dragBound === '1') return;
        el.dataset.dragBound = '1';
        
        el.style.cursor = 'ew-resize';
        let dragging = false, startX = 0, startVal = 0;
        
        el.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            if (document.activeElement === el) return;
            
            dragging = true;
            startX = e.clientX;
            startVal = parseFloat(el.value) || 0;
            e.preventDefault();
            
            const onMove = (me) => {
                if (!dragging) return;
                const dx = me.clientX - startX;
                const speed = me.shiftKey ? 0.1 : 1;
                const step = parseFloat(el.getAttribute('step')) || 1;
                let newVal = Math.round((startVal + dx * speed * step) / step) * step;
                
                const min = parseFloat(el.getAttribute('min'));
                const max = parseFloat(el.getAttribute('max'));
                if (!isNaN(min) && newVal < min) newVal = min;
                if (!isNaN(max) && newVal > max) newVal = max;
                
                el.value = newVal;
                
                const rangeEl = document.getElementById(el.id + '-range');
                if (rangeEl) rangeEl.value = newVal;
                
                el.dispatchEvent(new Event('input'));
            };
            
            const onUp = () => {
                dragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            el.focus();
            el.select();
        });
    });
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

function _ensurePreviewVideoDecodable(videoEl) {
    if (!videoEl || !_isPreviewVideoElement(videoEl) || !videoEl.style) return videoEl;
    const host = document.getElementById('reels-preview-container') || document.body;
    if (!videoEl.parentNode && host) {
        host.insertBefore(videoEl, host.firstChild || null);
    }
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.preload = 'auto';
    const style = videoEl.style;
    style.display = 'block';
    style.position = 'absolute';
    style.inset = '0';
    style.width = '100%';
    style.height = '100%';
    style.objectFit = style.objectFit || 'cover';
    style.opacity = '0.002'; // Use non-zero opacity to prevent Chromium from suspending paused video decoders
    style.visibility = 'visible';
    style.pointerEvents = 'none';
    style.zIndex = '0';
    return videoEl;
}

function _capturePreviewMediaFrame(media, token, target = null) {
    if (!media || !_isPreviewVideoElement(media) || !media.src) return false;
    _ensurePreviewVideoDecodable(media);
    const w = media.videoWidth || 0;
    const h = media.videoHeight || 0;
    if (!(w > 0) || !(h > 0)) return false;
    try {
        const frame = document.createElement('canvas');
        frame.width = w;
        frame.height = h;
        const fctx = frame.getContext('2d');
        fctx.drawImage(media, 0, 0, w, h);
        media._reelsSeekFrameCanvas = frame;
        media._reelsSeekFrameSrc = media.currentSrc || media.src;
        media._reelsSeekFrameToken = token;
        media._reelsSeekFrameTarget = Number.isFinite(target) ? target : (media.currentTime || 0);
        return true;
    } catch (e) {
        return false;
    }
}

function _getPreviewDrawableSource(media) {
    return media;
}

function _drawVideoCover(ctx, videoEl, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const drawSource = _getPreviewDrawableSource(videoEl);
    const srcW = drawSource.videoWidth || drawSource.naturalWidth || drawSource.width || targetW;
    const srcH = drawSource.videoHeight || drawSource.naturalHeight || drawSource.height || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, drawSource, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV);
        return;
    }
    const userScale = (scalePct || 100) / 100;
    const scale = Math.max(targetW / srcW, targetH / srcH) * userScale;
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const maxShiftX = Math.abs(targetW - drawW) / 2;
    const maxShiftY = Math.abs(targetH - drawH) / 2;
    const drawX = (targetW - drawW) / 2 + maxShiftX * (offsetX / 100);
    const drawY = (targetH - drawH) / 2 + maxShiftY * (offsetY / 100);
    _drawImageFlipped(ctx, drawSource, drawX, drawY, drawW, drawH, undefined, undefined, undefined, undefined, flipH, flipV);
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

function _drawCroppedVideoCover(ctx, videoEl, cropX, cropY, cropW, cropH, targetW, targetH, scalePct, offsetX = 0, offsetY = 0, flipH = false, flipV = false) {
    if (!ctx || !videoEl || !(targetW > 0) || !(targetH > 0)) return;
    const drawSource = _getPreviewDrawableSource(videoEl);
    const srcW = drawSource.videoWidth || drawSource.naturalWidth || drawSource.width || targetW;
    const srcH = drawSource.videoHeight || drawSource.naturalHeight || drawSource.height || targetH;
    if (!(srcW > 0) || !(srcH > 0)) {
        _drawImageFlipped(ctx, drawSource, 0, 0, targetW, targetH, undefined, undefined, undefined, undefined, flipH, flipV);
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
    _drawImageFlipped(ctx, drawSource, sx, sy, sWidth, sHeight, drawX, drawY, drawW, drawH, flipH, flipV);
}

// ═══════════════════════════════════════════════════════
// File / Task management
// ═══════════════════════════════════════════════════════

function _normalizeBaseName(name) {
    return String(name || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
}

function _fileExt(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
}

function _isImagePath(filePath) {
    const ext = _fileExt(filePath || '');
    return ext === 'jpg' || ext === 'jpeg' || ext === 'png' || ext === 'webp';
}

function _getSelectedTask() {
    if (_reelsState.selectedIdx < 0) return null;
    return _reelsState.tasks[_reelsState.selectedIdx] || null;
}

function _syncCurrentOverlayEditorToSelectedTask() {
    const task = _getSelectedTask();
    const mgr = _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr;
    if (!task || !mgr) return;
    if (_reelsState._coverEditMode && task.cover) {
        task.cover.overlays = [...(mgr.overlays || [])];
    } else {
        task.overlays = [...(mgr.overlays || [])];
    }
}

function _reelsFileExists(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    if (/^(blob:|data:|https?:)/i.test(filePath)) return true;
    if (window.electronAPI && typeof window.electronAPI.fileExists === 'function') {
        return window.electronAPI.fileExists(filePath);
    }
    return true;
}

function _toPlayablePath(filePath, srcUrl = null) {
    if (srcUrl && _reelsFileExists(srcUrl)) return srcUrl;
    if (!filePath) return '';
    if (!_reelsFileExists(filePath)) return '';
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function') {
        const u = window.electronAPI.toFileUrl(filePath);
        if (u) return u;
    }
    return filePath.startsWith('/') ? `file://${filePath}` : filePath;
}

/**
 * 将 file:// URL 或编码路径还原为本地文件系统路径。
 * 与 _toPlayablePath 互为逆操作。
 */
function _normalizeLocalMediaPath(p) {
    if (!p) return '';
    let s = String(p);
    // 去掉 local-media:// 或 file:// 前缀
    if (s.startsWith('local-media:///')) {
        s = s.slice(14);
    } else if (s.startsWith('local-media://')) {
        s = s.slice(14);
    } else if (s.startsWith('file:///')) {
        s = s.slice(7);
    } else if (s.startsWith('file://')) {
        s = s.slice(7);
    }
    
    // 统一将反斜杠替换为正斜杠，便于跨平台路径比较
    s = s.replace(/\\/g, '/');
    
    // 如果是 Windows 路径（比如 /C:/Users/...），去掉最开头的斜杠变为 C:/Users/...
    if (s.startsWith('/') && /^[a-zA-Z]:/.test(s.substring(1))) {
        s = s.substring(1);
    }
    
    // URI decode（处理中文路径等）
    try { s = decodeURIComponent(s); } catch (_) {}
    return s;
}

/**
 * 判断文件路径是否为图片（通过扩展名）。
 */
function _isImageFile(filePath) {
    const ext = (filePath || '').split('.').pop().toLowerCase();
    return ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext);
}

function _resolvePreviewBackgroundPath(task) {
    if (!task) return { path: '', isMulti: false };
    const activePool = _getEffectiveBgClipPool(task);
    const isMulti = task.bgMode === 'multi' && activePool.length > 0;
    if (isMulti) {
        const previewPath = activePool.find(p => p && _reelsFileExists(p)) || activePool[0] || '';
        return { path: previewPath, isMulti: true };
    }
    return { path: task.bgPath || task.videoPath || '', isMulti: false };
}

function _getEffectiveBgClipPool(task) {
    if (!task || !Array.isArray(task.bgClipPool)) return [];
    const pool = task.bgClipPool.filter(Boolean);
    const active = Array.isArray(task.bgClipActivePool)
        ? task.bgClipActivePool.filter(p => p && pool.includes(p))
        : [];
    return active.length > 0 ? active : pool;
}

function _getEffectiveBgmClipPool(task) {
    if (!task || !Array.isArray(task.bgmClipPool)) return [];
    const pool = task.bgmClipPool.filter(Boolean);
    const active = Array.isArray(task.bgmClipActivePool)
        ? task.bgmClipActivePool.filter(p => p && pool.includes(p))
        : [];
    return active.length > 0 ? active : pool;
}

function _getEffectiveBgmPath(task, taskIdx) {
    if (!task) return '';
    if (task.bgmMode === 'multi') {
        const pool = _getEffectiveBgmClipPool(task).filter(p => p && _reelsFileExists(p));
        if (pool.length > 0) {
            if (task.bgmClipOrder === 'sequence') {
                return pool[taskIdx % pool.length];
            } else {
                const seedText = `${task.id || task.fileName || ''}|${taskIdx}|bgm-seed`;
                let seed = 2166136261;
                for (let i = 0; i < seedText.length; i++) {
                    seed ^= seedText.charCodeAt(i);
                    seed += (seed << 1) + (seed << 4) + (seed << 7) + (seed << 8) + (seed << 24);
                }
                const randIdx = Math.abs(seed) % pool.length;
                return pool[randIdx];
            }
        }
        return '';
    }
    return task.bgmPath || '';
}

window._getEffectiveBgmClipPool = _getEffectiveBgmClipPool;
window._getEffectiveBgmPath = _getEffectiveBgmPath;


function _getPreviewMultiClipPool(task) {
    if (!task || task.bgMode !== 'multi') return [];
    const pool = _getEffectiveBgClipPool(task).filter(p => p && _reelsFileExists(p));
    const isRandom = task.bgClipOrder === 'random' || task.bgClipOrder === 'random_align';
    if (!isRandom || pool.length <= 1) return pool;

    const seedText = `${task.id || task.fileName || ''}|${pool.join('|')}`;
    let seed = 2166136261;
    for (let i = 0; i < seedText.length; i++) {
        seed ^= seedText.charCodeAt(i);
        seed = Math.imul(seed, 16777619);
    }
    const rng = _mulberry32(seed >>> 0);
    const shuffled = pool.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function _calculatePreviewSegments(task) {
    const pool = _getPreviewMultiClipPool(task);
    if (pool.length === 0) return [];

    const bgDurFactor = (task && task.bgDurScale ? task.bgDurScale : 100) / 100;
    const videoEl = document.getElementById('reels-preview-video');

    const poolClips = pool.map(path => {
        let start = 0;
        let end = null;
        if (task.bgClipSettings && task.bgClipSettings[path]) {
            if (task.bgClipSettings[path].trimStart != null) start = parseFloat(task.bgClipSettings[path].trimStart) || 0;
            if (task.bgClipSettings[path].trimEnd != null) end = parseFloat(task.bgClipSettings[path].trimEnd) || null;
        }

        let dur = 5;
        if (!_isImageFile(path)) {
            if (end != null && end > 0) {
                dur = end - start;
            } else {
                if (videoEl && videoEl.dataset && videoEl.dataset.multiPath === path && isFinite(videoEl.duration) && videoEl.duration > 0) {
                    dur = videoEl.duration - start;
                } else {
                    dur = 5;
                }
            }
        }
        return {
            path,
            isImage: _isImageFile(path),
            trimStart: start,
            trimEnd: end,
            baseDuration: Math.max(0.5, dur) * bgDurFactor
        };
    });

    const isCardingMode = task.bgClipOrder === 'random_align' || task.bgClipOrder === 'sequence_align';
    const segments = task.segments || [];

    const audioEl = document.getElementById('reels-preview-audio');
    let totalDur = 15;
    if (audioEl && audioEl.src && isFinite(audioEl.duration) && audioEl.duration > 0) {
        totalDur = audioEl.duration;
    } else {
        totalDur = poolClips.reduce((sum, c) => sum + c.baseDuration, 0);
    }
    const audioDurScale = (task && task.audioDurScale ? task.audioDurScale : 100) / 100;
    if (audioEl && audioEl.src && audioDurScale !== 1.0) {
        totalDur = totalDur * audioDurScale;
    }

    const result = [];
    if (isCardingMode && segments.length > 0) {
        const cutPoints = [0];
        const candidates = [];
        const preSwitchOffset = 0.2;
        const bgMinClipDur = task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5;
        const bgMaxClipDur = task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7;

        for (const seg of segments) {
            const endVal = parseFloat(seg.end);
            if (!isNaN(endVal) && endVal > 0) {
                const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                if (shiftedPt < totalDur) {
                    candidates.push(shiftedPt);
                }
            }
        }
        const getSentenceBoundaries = (segs, originalText) => {
            const strongBoundaries = new Set();
            const weakBoundaries = new Set();
            if (!segs || segs.length === 0) return { strongBoundaries, weakBoundaries };
            
            const lastIdx = segs.length - 1;
            strongBoundaries.add(lastIdx);

            const sentencePunct = new Set([
                '。', '！', '？', '，', '、', '；', '：', 
                '.', '!', '?', ',', ';', ':', '\n', '\r', 
                '…', '—', '“', '”', '‘', '’', '（', '）', 
                '(', ')', '[', ']', '【', '】'
            ]);
            const strongPunct = new Set(['。', '！', '？', '.', '!', '?', '\n', '\r', '…', '—']);

            segs.forEach((seg, i) => {
                const txt = String(seg.edited_text || seg.text || '').trim();
                if (txt && sentencePunct.has(txt[txt.length - 1])) {
                    const char = txt[txt.length - 1];
                    if (strongPunct.has(char)) {
                        strongBoundaries.add(i);
                    } else {
                        weakBoundaries.add(i);
                    }
                }
            });

            if (!originalText) return { strongBoundaries, weakBoundaries };

            const rawChars = Array.from(originalText);
            const cleanOriginalText = [];
            const cleanToRawMap = [];
            for (let i = 0; i < rawChars.length; i++) {
                const char = rawChars[i];
                if (!/\s/.test(char) && !sentencePunct.has(char)) {
                    cleanToRawMap.push(i);
                    cleanOriginalText.push(char);
                }
            }
            const cleanOrigStr = cleanOriginalText.join('');

            let accumulatedCleanText = "";
            for (let idx = 0; idx < segs.length; idx++) {
                const segVal = segs[idx].edited_text || segs[idx].text || "";
                const cleanSegText = String(segVal)
                    .replace(/\s+/g, '')
                    .split('')
                    .filter(c => !sentencePunct.has(c))
                    .join('');

                accumulatedCleanText += cleanSegText;
                if (accumulatedCleanText.length === 0) continue;

                const matchIdx = cleanOrigStr.toLowerCase().indexOf(accumulatedCleanText.toLowerCase());
                if (matchIdx !== -1) {
                    const endCleanIdx = matchIdx + accumulatedCleanText.length - 1;
                    const endRawIdx = cleanToRawMap[endCleanIdx];
                    if (endRawIdx !== undefined) {
                        let isBoundary = false;
                        let matchedChar = '';
                        let k = endRawIdx + 1;
                        for (; k < rawChars.length; k++) {
                            const nextChar = rawChars[k];
                            if (sentencePunct.has(nextChar)) {
                                isBoundary = true;
                                matchedChar = nextChar;
                                break;
                            }
                            if (!/\s/.test(nextChar)) {
                                break;
                            }
                        }
                        if (k === rawChars.length) {
                            isBoundary = true;
                        }
                        if (isBoundary) {
                            if (k === rawChars.length || strongPunct.has(matchedChar)) {
                                strongBoundaries.add(idx);
                            } else {
                                weakBoundaries.add(idx);
                            }
                        }
                    }
                }
            }
            return { strongBoundaries, weakBoundaries };
        };

        const originalScript = task.ttsText || task.aiScript || task.txtContent || "";
        const { strongBoundaries, weakBoundaries } = getSentenceBoundaries(segments, originalScript);

        const strongCandidates = [];
        const weakCandidates = [];
        const allCandidates = [];

        segments.forEach((seg, idx) => {
            const endVal = parseFloat(seg.end);
            if (!isNaN(endVal) && endVal > 0) {
                const shiftedPt = Math.max(0.1, endVal - preSwitchOffset);
                if (shiftedPt < totalDur) {
                    allCandidates.push(shiftedPt);
                    if (strongBoundaries.has(idx)) {
                        strongCandidates.push(shiftedPt);
                    } else if (weakBoundaries.has(idx)) {
                        weakCandidates.push(shiftedPt);
                    }
                }
            }
        });

        const sortedStrongCands = Array.from(new Set(strongCandidates)).sort((a, b) => a - b);
        const sortedWeakCands = Array.from(new Set(weakCandidates)).sort((a, b) => a - b);
        const sortedAllCands = Array.from(new Set(allCandidates)).sort((a, b) => a - b);

        const preferredSplit = Math.max(1.0, bgMinClipDur > 0 ? Math.min(bgMaxClipDur, bgMinClipDur + 1) : 5);
        const minOk = Math.max(1.0, bgMinClipDur - 1.0);
        const maxOk = bgMaxClipDur + 1.0;
        let lastCut = 0;
        let candIdx = 0;

        while (candIdx < sortedAllCands.length) {
            const remainingAll = sortedAllCands.filter(pt => pt > lastCut + 0.01);
            if (remainingAll.length === 0) break;

            const remainingStrong = sortedStrongCands.filter(pt => pt > lastCut + 0.01);
            const remainingWeak = sortedWeakCands.filter(pt => pt > lastCut + 0.01);

            let bestPt = null;
            // 1. 优先寻找区间内的强标点
            for (let i = 0; i < remainingStrong.length; i++) {
                const pt = remainingStrong[i];
                const dist = pt - lastCut;
                if (dist >= minOk && dist <= maxOk) {
                    if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                        bestPt = pt;
                    }
                }
            }

            // 2. 如果没有强标点，寻找弱标点
            if (bestPt === null) {
                for (let i = 0; i < remainingWeak.length; i++) {
                    const pt = remainingWeak[i];
                    const dist = pt - lastCut;
                    if (dist >= minOk && dist <= maxOk) {
                        if (bestPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestPt - lastCut - preferredSplit)) {
                            bestPt = pt;
                        }
                    }
                }
            }

            if (bestPt !== null) {
                cutPoints.push(bestPt);
                lastCut = bestPt;
                const idx = sortedAllCands.indexOf(bestPt);
                candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
            } else {
                const hasExceedingStrong = remainingStrong.some(pt => pt - lastCut > maxOk);
                const hasExceedingWeak = remainingWeak.some(pt => pt - lastCut > maxOk);
                
                if (hasExceedingStrong || hasExceedingWeak) {
                    const smallerStrong = remainingStrong.filter(pt => pt - lastCut < minOk);
                    const smallerWeak = remainingWeak.filter(pt => pt - lastCut < minOk);
                    
                    if (smallerStrong.length > 0) {
                        const latestSmaller = smallerStrong[smallerStrong.length - 1];
                        cutPoints.push(latestSmaller);
                        lastCut = latestSmaller;
                        const idx = sortedAllCands.indexOf(latestSmaller);
                        candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                    } else if (smallerWeak.length > 0) {
                        const latestSmaller = smallerWeak[smallerWeak.length - 1];
                        cutPoints.push(latestSmaller);
                        lastCut = latestSmaller;
                        const idx = sortedAllCands.indexOf(latestSmaller);
                        candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                    } else {
                        let bestWordPt = null;
                        for (let i = 0; i < remainingAll.length; i++) {
                            const pt = remainingAll[i];
                            const dist = pt - lastCut;
                            if (dist >= minOk && dist <= maxOk) {
                                if (bestWordPt === null || Math.abs(dist - preferredSplit) < Math.abs(bestWordPt - lastCut - preferredSplit)) {
                                    bestWordPt = pt;
                                }
                            }
                        }
                        
                        if (bestWordPt !== null) {
                            cutPoints.push(bestWordPt);
                            lastCut = bestWordPt;
                            const idx = sortedAllCands.indexOf(bestWordPt);
                            candIdx = idx !== -1 ? idx + 1 : candIdx + 1;
                        } else {
                            const nextForcedCut = lastCut + preferredSplit;
                            cutPoints.push(nextForcedCut);
                            lastCut = nextForcedCut;
                        }
                    }
                } else {
                    break;
                }
            }
        }

        if (bgMaxClipDur > 0) {
            while ((totalDur - lastCut) > bgMaxClipDur) {
                const nextForcedCut = lastCut + preferredSplit;
                cutPoints.push(nextForcedCut);
                lastCut = nextForcedCut;
            }
        }
        if (cutPoints.length > 1 && totalDur - cutPoints[cutPoints.length - 1] < 1.5) {
            cutPoints[cutPoints.length - 1] = totalDur;
        } else if (cutPoints[cutPoints.length - 1] < totalDur - 0.01) {
            cutPoints.push(totalDur);
        } else {
            cutPoints[cutPoints.length - 1] = totalDur;
        }

        for (let idx = 0; idx < cutPoints.length - 1; idx++) {
            const start = cutPoints[idx];
            const end = cutPoints[idx + 1];
            const dur = end - start;

            const clip = poolClips[idx % poolClips.length];
            result.push({
                path: clip.path,
                isImage: clip.isImage,
                start,
                end,
                duration: dur,
                trimStart: clip.trimStart,
                speedFactor: bgDurFactor
            });
        }
    } else {
        let cursor = 0;
        for (let i = 0; i < poolClips.length * 10; i++) {
            const clip = poolClips[i % poolClips.length];
            const start = cursor;
            const end = cursor + clip.baseDuration;
            result.push({
                path: clip.path,
                isImage: clip.isImage,
                start,
                end,
                duration: clip.baseDuration,
                trimStart: clip.trimStart,
                speedFactor: bgDurFactor
            });
            cursor = end;
            if (cursor >= totalDur) break;
        }
        if (result.length > 0) {
            const last = result[result.length - 1];
            if (last.end > totalDur) {
                last.end = totalDur;
                last.duration = last.end - last.start;
            }
        }
    }
    return result;
}

async function _preFetchMultiBgDurations(task) {
    if (!task || task.bgMode !== 'multi' || !Array.isArray(task.bgClipPool)) return;
    if (!_reelsState._multiBgDurations) _reelsState._multiBgDurations = {};
    const pool = _getPreviewMultiClipPool(task);
    for (const path of pool) {
        if (_isImageFile(path)) continue;
        if (_reelsState._multiBgDurations[path] > 0) continue;
        if (window.electronAPI && typeof window.electronAPI.getMediaDuration === 'function') {
            try {
                const dur = await window.electronAPI.getMediaDuration(path);
                if (dur > 0) {
                    _reelsState._multiBgDurations[path] = dur;
                    console.log(`[Preview] Loaded duration for ${path}: ${dur}s`);
                }
            } catch (e) {
                console.error('[Preview] Failed to get duration for', path, e);
            }
        }
    }
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
}

function _getPreviewMultiClipDuration(path, videoEl, task) {
    let start = 0;
    let end = null;
    if (task && task.bgClipSettings && task.bgClipSettings[path]) {
        if (task.bgClipSettings[path].trimStart != null) start = parseFloat(task.bgClipSettings[path].trimStart) || 0;
        if (task.bgClipSettings[path].trimEnd != null) end = parseFloat(task.bgClipSettings[path].trimEnd) || null;
    }

    let dur = 5;
    if (!_isImageFile(path)) {
        if (end != null && end > 0) {
            dur = end - start;
        } else {
            if (_reelsState._multiBgDurations && _reelsState._multiBgDurations[path] > 0) {
                dur = _reelsState._multiBgDurations[path] - start;
            } else if (videoEl && videoEl.dataset && videoEl.dataset.multiPath === path && isFinite(videoEl.duration) && videoEl.duration > 0) {
                dur = videoEl.duration - start;
            } else {
                dur = 5;
            }
        }
    }
    const bgDurFactor = (task && task.bgDurScale ? task.bgDurScale : 100) / 100;
    return Math.max(0.5, dur) * bgDurFactor;
}

function _resolvePreviewMultiClipsAtTime(task, timeSec) {
    const segments = _calculatePreviewSegments(task);
    if (segments.length === 0) return null;

    const total = segments[segments.length - 1].end;
    const loopTime = _isPreviewLoopEnabled() && total > 0
        ? (((timeSec || 0) % total) + total) % total
        : Math.min(timeSec || 0, Math.max(0, total - 0.001));

    const seg = segments.find(s => loopTime >= s.start && loopTime < s.end) || segments[segments.length - 1];
    const index = segments.indexOf(seg);

    const bgTransition = task.bgTransition || 'crossfade';
    const bgTransDur = task.bgTransDur || 0.5;
    const tDur = bgTransition !== 'none' ? bgTransDur : 0;

    let inTransition = false;
    let transitionProgress = 0;
    let prevSeg = null;

    if (tDur > 0 && index > 0 && loopTime >= seg.start && loopTime < seg.start + tDur) {
        inTransition = true;
        transitionProgress = (loopTime - seg.start) / tDur;
        prevSeg = segments[index - 1];
    }

    const getLocalTime = (s, time) => {
        const timeInSeg = time - s.start;
        return s.trimStart + timeInSeg / s.speedFactor;
    };

    return {
        current: {
            index,
            path: seg.path,
            isImage: seg.isImage,
            localTime: getLocalTime(seg, loopTime),
            duration: seg.duration
        },
        transition: inTransition ? {
            index: index - 1,
            path: prevSeg.path,
            isImage: prevSeg.isImage,
            localTime: getLocalTime(prevSeg, loopTime),
            duration: prevSeg.duration,
            progress: transitionProgress,
            type: bgTransition
        } : null,
        totalDuration: total
    };
}

function _syncPreviewMultiPlayers(task, clips) {
    const video = document.getElementById('reels-preview-video');
    const fadeVideo = _ensurePreviewFadeVideo(video);
    if (!video || !fadeVideo) return;

    const bgDurScale = task.bgDurScale || 100;
    const bgDurFactor = bgDurScale / 100;
    const targetPlaybackRate = (bgDurFactor !== 0) ? 1.0 / bgDurFactor : 1.0;

    const audio = document.getElementById('reels-preview-audio');
    const shouldPlay = !!_reelsState.mockPlaying || !!(audio && audio.src && !audio.paused);

    const cfg = _getPreviewAudioMixConfig();
    const effectiveBgGain = _getEffectiveBgVolumePercent(task, cfg.bgGain * 100) / 100;

    const syncPlayer = (player, path, localTime, gainMultiplier = 1) => {
        const url = _toPlayablePath(path, null);
        
        const norm = (s) => {
            if (!s) return '';
            try {
                let dec = decodeURIComponent(s);
                dec = dec.replace(/^file:\/\/\//i, '/').replace(/^file:\/\//i, '/');
                dec = dec.replace(/\\/g, '/');
                dec = dec.replace(/\/+/g, '/');
                return dec;
            } catch (_) {
                return s;
            }
        };

        if (norm(player.src) !== norm(url) || player.dataset.multiPath !== path) {
            player.pause();
            player.src = url;
            player.dataset.multiPath = path;
            player.load();
        }
        player.playbackRate = targetPlaybackRate;
        player.preservesPitch = true;

        const targetTime = player.duration > 0 ? Math.min(localTime, Math.max(0, player.duration - 0.03)) : localTime;
        if (player.readyState >= 1 && Math.abs((player.currentTime || 0) - targetTime) > 0.25) {
            try { player.currentTime = targetTime; } catch (_) { }
        }

        // Apply volume/muted status on every sync, especially after load()
        const ctx = _reelsState._audioCtx;
        const useWebAudio = !!(ctx && _reelsState._gainNodes);
        const vol = Math.max(0, Math.min(1, effectiveBgGain * gainMultiplier));
        if (useWebAudio && _reelsState._gainNodes.has(player)) {
            const gainNode = _reelsState._gainNodes.get(player);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            player.volume = vol > 0 ? 1.0 : 0;
            player.muted = vol <= 0.0001;
        } else {
            player.volume = Math.min(1.0, vol);
            player.muted = vol <= 0.0001;
        }

        if (shouldPlay && player.paused) {
            player.play().catch(() => { });
        } else if (!shouldPlay && !player.paused) {
            player.pause();
        }
    };

    if (clips.transition) {
        const outgoing = clips.transition;
        const incoming = clips.current;
        const transitionProgress = Math.max(0, Math.min(1, outgoing.progress || 0));
        const outgoingGain = 1 - transitionProgress;
        const incomingGain = transitionProgress;

        if (outgoing.isImage && incoming.isImage) {
            video.pause();
            fadeVideo.pause();
        } else if (outgoing.isImage) {
            video.style.display = 'block';
            syncPlayer(video, incoming.path, incoming.localTime, 1);
            fadeVideo.pause();
        } else if (incoming.isImage) {
            video.style.display = 'block';
            syncPlayer(video, outgoing.path, outgoing.localTime, 1);
            fadeVideo.pause();
        } else {
            video.style.display = 'block';
            fadeVideo.style.display = 'block';

            if (video.dataset.multiPath === outgoing.path) {
                syncPlayer(video, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(fadeVideo, incoming.path, incoming.localTime, incomingGain);
            } else if (fadeVideo.dataset.multiPath === outgoing.path) {
                syncPlayer(fadeVideo, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(video, incoming.path, incoming.localTime, incomingGain);
            } else {
                syncPlayer(video, outgoing.path, outgoing.localTime, outgoingGain);
                syncPlayer(fadeVideo, incoming.path, incoming.localTime, incomingGain);
            }
        }
    } else {
        const current = clips.current;

        if (current.isImage) {
            video.pause();
            fadeVideo.pause();
        } else {
            video.style.display = 'block';
            if (fadeVideo.dataset.multiPath === current.path && !video.dataset.multiPath) {
                syncPlayer(fadeVideo, current.path, current.localTime);
                video.pause();
            } else {
                syncPlayer(video, current.path, current.localTime);
                fadeVideo.pause();
            }
        }
    }
}

function _drawPreviewMultiBackground(ctx, w, h, bgScale, bgX, bgY, clips) {
    if (!clips) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        return;
    }
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const fadeVideo = _reelsState.previewFadeVideo;

    const getDrawSource = (clip) => {
        if (clip.isImage) {
            if (!_reelsState._multiBgImages) _reelsState._multiBgImages = {};
            let img = _reelsState._multiBgImages[clip.path];
            if (!img) {
                img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview(); };
                img.src = _toPlayablePath(clip.path, null);
                _reelsState._multiBgImages[clip.path] = img;
            }
            return (img.complete && img.naturalWidth > 0) ? img : null;
        } else {
            if (video && video.dataset.multiPath === clip.path && video.readyState >= 1) {
                return video;
            }
            if (fadeVideo && fadeVideo.dataset.multiPath === clip.path && fadeVideo.readyState >= 1) {
                return fadeVideo;
            }
            return null;
        }
    };

    const drawClip = (clip) => {
        const src = getDrawSource(clip);
        if (src) {
            _drawVideoCover(ctx, src, w, h, bgScale, bgX, bgY, task?.bgFlipH || false, task?.bgFlipV || false);
        } else {
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, w, h);
        }
    };

    if (clips.transition) {
        const outgoing = clips.transition;
        const incoming = clips.current;
        const progress = outgoing.progress;
        const type = outgoing.type;

        drawClip(outgoing);

        ctx.save();
        if (type === 'crossfade' || type === 'fade') {
            ctx.globalAlpha = progress;
            drawClip(incoming);
        } else if (type === 'fade_black' || type === 'fadeblack') {
            if (progress < 0.5) {
                const alpha = progress * 2;
                ctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                const alpha = (progress - 0.5) * 2;
                ctx.globalAlpha = alpha;
                drawClip(incoming);
            }
        } else if (type === 'fade_white' || type === 'fadewhite') {
            if (progress < 0.5) {
                const alpha = progress * 2;
                ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
                ctx.fillRect(0, 0, w, h);
            } else {
                const alpha = (progress - 0.5) * 2;
                ctx.globalAlpha = alpha;
                drawClip(incoming);
            }
        } else if (type === 'slide_left' || type === 'slideleft') {
            ctx.beginPath();
            ctx.rect(w * (1 - progress), 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else if (type === 'slide_right' || type === 'slideright') {
            ctx.beginPath();
            ctx.rect(0, 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else if (type === 'wipe' || type === 'wipeleft') {
            ctx.beginPath();
            ctx.rect(0, 0, w * progress, h);
            ctx.clip();
            drawClip(incoming);
        } else {
            drawClip(incoming);
        }
        ctx.restore();
    } else {
        drawClip(clips.current);
    }
}

function _resolvePreviewMultiClipAtTime(task, timeSec) {
    const segments = _calculatePreviewSegments(task);
    if (segments.length === 0) return null;

    const total = segments[segments.length - 1].end;
    const loopTime = _isPreviewLoopEnabled() && total > 0
        ? (((timeSec || 0) % total) + total) % total
        : Math.min(timeSec || 0, Math.max(0, total - 0.001));

    const seg = segments.find(s => loopTime >= s.start && loopTime < s.end) || segments[segments.length - 1];
    
    const timeInSeg = loopTime - seg.start;
    const localTime = seg.trimStart + timeInSeg / seg.speedFactor;

    return {
        index: segments.indexOf(seg),
        path: seg.path,
        isImage: seg.isImage,
        localTime: localTime,
        duration: seg.duration,
        totalDuration: total
    };
}

function _syncPreviewMultiBackground(task, contentTime) {
    const clips = _resolvePreviewMultiClipsAtTime(task, contentTime);
    if (!clips) return null;
    _syncPreviewMultiPlayers(task, clips);
    return clips;
}

/**
 * 解析任务的 Hook（前置视频）路径。
 * 优先级: task.hookFile → task.hook.path → 全局前置路径。
 * 若 task.hookFile === '__NONE__' 则显式禁用。
 */
function _resolveTaskHookPath(task, globalIntroPath) {
    if (!task) return globalIntroPath || '';
    // 显式禁用 hook
    if (task.hookFile === '__NONE__') return '';
    // 任务级 hook 优先
    if (task.hookFile) return task.hookFile;
    if (task.hook && task.hook.path) return task.hook.path;
    // 回退到全局前置路径
    return globalIntroPath || '';
}

function _getAudioDuration(task) {
    if (!task || !task.audioPath) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[task.audioPath] > 0) {
        return _reelsState._mediaDurations[task.audioPath];
    }
    const audio = document.getElementById('reels-preview-audio');
    if (audio && isFinite(audio.duration) && audio.duration > 0) {
        return audio.duration;
    }
    if (task.segments && task.segments.length > 0) {
        return task.segments[task.segments.length - 1].end || 0;
    }
    return 0;
}

function _getVideoDuration(task) {
    if (!task) return 0;
    const previewBg = _resolvePreviewBackgroundPath(task);
    const bgPath = previewBg.path;
    if (!bgPath || previewBg.isMulti || _isImagePath(bgPath)) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[bgPath] > 0) {
        return _reelsState._mediaDurations[bgPath];
    }
    const video = document.getElementById('reels-preview-video');
    if (video && isFinite(video.duration) && video.duration > 0) {
        return video.duration;
    }
    return 0;
}

function _getContentVideoDuration(task) {
    if (!task || !task.contentVideoPath) return 0;
    if (_reelsState._mediaDurations && _reelsState._mediaDurations[task.contentVideoPath] > 0) {
        const fullDur = _reelsState._mediaDurations[task.contentVideoPath];
        const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
        const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
        if (trimEnd > trimStart && trimStart >= 0) {
            return trimEnd - trimStart;
        }
        return Math.max(0, fullDur - trimStart);
    }
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (cvVideo && cvVideo.src && isFinite(cvVideo.duration) && cvVideo.duration > 0) {
        const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
        const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
        if (trimEnd > trimStart && trimStart >= 0) {
            return trimEnd - trimStart;
        }
        return Math.max(0, cvVideo.duration - trimStart);
    }
    if (_reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
        return _reelsState.cvSequence.files.length / 30;
    }
    return 0;
}




function _getPreviewMasterElement() {
    const task = _getSelectedTask();
    if (!task) return null;
    const audio = document.getElementById('reels-preview-audio');
    if (task.audioPath && audio && audio.src && audio.readyState >= 1) return audio;
    if (!(task.contentVideoDirectBg && task.contentVideoPath)) {
        const previewBg = _resolvePreviewBackgroundPath(task);
        if (!previewBg.isMulti) {
            const video = document.getElementById('reels-preview-video');
            const isVideo = previewBg.path && !_isImagePath(previewBg.path);
            if (isVideo && video && video.src && video.readyState >= 1) return video;
        }
    }
    // 内容视频作为时钟源（当没有单独配音和背景视频时）
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (task.contentVideoPath && cvVideo && cvVideo.src && cvVideo.readyState >= 1) return cvVideo;
    const bgm = _reelsState._bgmAudioEl;
    if (task.bgmPath && bgm && bgm.src && bgm.readyState >= 1) return bgm;
    return null;
}

function _isPreviewLoopEnabled() {
    const el = document.getElementById('reels-preview-loop');
    return el ? !!el.checked : true;
}

function _applyPreviewLoopMode() {
    const enabled = _isPreviewLoopEnabled();
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    const bgm = _reelsState._bgmAudioEl;

    const hasAudio = !!(task && task.audioPath && audio && audio.src);
    const previewBg = _resolvePreviewBackgroundPath(task);
    const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src);
    const hasCvVideo = !!(task && task.contentVideoPath && cvVideo && cvVideo.src);

    if (audio) audio.loop = enabled && hasAudio;
    if (video) video.loop = enabled && hasVideo;
    if (cvVideo) cvVideo.loop = enabled && hasCvVideo;
    if (bgm) bgm.loop = enabled;
    if (_reelsState.previewFadeVideo) _reelsState.previewFadeVideo.loop = enabled;
}

function reelsOnPreviewLoopModeChange() {
    _applyPreviewLoopMode();
}

function _getPreviewCurrentTime() {
    const task = _getSelectedTask();
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (_isPreviewSeekLocked()) {
        return _reelsState.previewSeekLock.target;
    }

    // When mock clock is running (Cover/Hook phases, or no-media mode), use it as primary
    if (_reelsState.mockPlaying) {
        const elapsed = Math.max(0, (performance.now() / 1000) - (_reelsState.mockStartTime || 0));
        if (_isPreviewLoopEnabled()) {
            const dur = _getPreviewDuration();
            if (dur > 0) return elapsed % dur;
        }
        return elapsed;
    }

    // Master media actively playing (main content phase after Cover+Hook)
    const master = _getPreviewMasterElement();
    if (_isPreviewMediaPlaying(master)) {
        let t = master.currentTime || 0;
        if (master.id === 'reels-preview-contentvideo') {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            t = Math.max(0, t - trimStart);
        }
        const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
        return (t * aDurScale) + offsetDur;
    }

    // Paused state (initial, after seek, after user pause): use saved position
    return _reelsState.mockPausedTime || 0;
}

function _getPreviewPlaybackTimeForPause() {
    const task = _getSelectedTask();
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (_reelsState.mockPlaying) {
        const elapsed = Math.max(0, (performance.now() / 1000) - (_reelsState.mockStartTime || 0));
        if (_isPreviewLoopEnabled()) {
            const dur = _getPreviewDuration();
            if (dur > 0) return elapsed % dur;
        }
        return elapsed;
    }

    const hookVideo = document.getElementById('reels-preview-hook-video');
    if (task && hookVideo && hookVideo.src && _isPreviewMediaPlaying(hookVideo)) {
        const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
        const speed = task.hookSpeed || 1.0;
        return coverDur + Math.max(0, (hookVideo.currentTime || 0) - trimStart) / Math.max(speed, 0.0001);
    }

    const master = _getPreviewMasterElement();
    if (_isPreviewMediaPlaying(master)) {
        let t = master.currentTime || 0;
        if (master.id === 'reels-preview-contentvideo') {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            t = Math.max(0, t - trimStart);
        }
        const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
        return (t * aDurScale) + offsetDur;
    }

    return _reelsState.mockPausedTime || 0;
}

function _isPreviewActuallyPlaying(master, hookVideo, bgmAudio) {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const contentVideo = document.getElementById('reels-preview-contentvideo');
    const fadeVideo = _reelsState.previewFadeVideo;
    return !!(
        _reelsState.mockPlaying ||
        _isPreviewMediaPlaying(master) ||
        _isPreviewMediaPlaying(hookVideo) ||
        _isPreviewMediaPlaying(audio) ||
        _isPreviewMediaPlaying(video) ||
        _isPreviewMediaPlaying(fadeVideo) ||
        _isPreviewMediaPlaying(contentVideo) ||
        _isPreviewMediaPlaying(bgmAudio)
    );
}

function _isPreviewMediaPlaying(media) {
    return !!(media && !media.paused && !media._reelsSeekPriming);
}

function _getPreviewDuration() {
    const task = _getSelectedTask();
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    
    // ⏱ 文字翻转器 (Dynamic Flipper) 时长优先
    let maxFlipperDuration = 0;
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        for (const ov of (_reelsState.overlayProxy.overlayMgr.overlays || [])) {
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

    const subDur = task && task.segments && task.segments.length > 0
        ? (task.segments[task.segments.length - 1].end || 0)
        : 0;
    const aDur = _getAudioDuration(task);
    const vDur = _getVideoDuration(task);

    // 音频变速：audioDurScale=150% → 实际播放时长 = 原时长 × 1.5
    const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
    const scaledADur = aDur * aDurScale;

    // 前置阶段总时长
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;

    if (maxFlipperDuration > 0) {
        return maxFlipperDuration + offsetDur;
    }

    // 自定义时长优先
    const globalCustomEl = document.getElementById('reels-custom-duration');
    const globalCustomDuration = parseFloat(globalCustomEl ? globalCustomEl.value : '0') || 0;
    const effectiveCustomDuration = (task && task.customDuration && task.customDuration > 0)
        ? task.customDuration
        : globalCustomDuration;
    if (effectiveCustomDuration > 0) {
        return effectiveCustomDuration + offsetDur;
    }
    // 有音频时以变速后的音频时长为准（背景自动循环）
    if (scaledADur > 0) {
        return scaledADur + offsetDur;
    }

    // ── 内容视频 (Content Video) 时长优先于背景 ──
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    let cvDur = 0;
    if (task && task.contentVideoPath) {
        // 情况1: 图片序列文件夹 → duration = frameCount / 30
        if (_reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath && _reelsState.cvSequence.files.length > 0) {
            cvDur = _reelsState.cvSequence.files.length / 30;
        }
        // 情况2: 普通视频文件 → 用 <video> 元素的 duration
        else if (cvVideo && cvVideo.src && isFinite(cvVideo.duration) && cvVideo.duration > 0) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd   = parseFloat(task.contentVideoTrimEnd) || 0;
            if (trimEnd > trimStart && trimStart >= 0) {
                cvDur = trimEnd - trimStart;
            } else {
                cvDur = cvVideo.duration - trimStart;
            }
        }
    }
    if (cvDur > 0) {
        return Math.max(cvDur, subDur) + offsetDur;
    }

    if (task && task.bgMode === 'multi' && _getEffectiveBgClipPool(task).length > 0) {
        const isCardingMode = task.bgClipOrder === 'random_align' || task.bgClipOrder === 'sequence_align';
        if (isCardingMode && subDur > 0) {
            return subDur + offsetDur;
        }
        const pool = _getPreviewMultiClipPool(task);
        const rawMultiDur = pool.reduce((sum, path) => {
            return sum + _getPreviewMultiClipDuration(path, video, task);
        }, 0);
        const transOverlap = task.bgTransition !== 'none' ? (parseFloat(task.bgTransDur) || 0.5) : 0;
        const multiDur = Math.max(0.5, rawMultiDur - transOverlap * Math.max(0, pool.length - 1));
        if (multiDur > 0) return Math.max(multiDur, subDur) + offsetDur;
    }

    // 无音频、无覆层视频时以背景视频时长为准，若仍无时长则推算虚拟进度
    const bDurScale = (task && task.bgDurScale) ? (task.bgDurScale / 100) : 1;
    const baseDur = Math.max(vDur * bDurScale, subDur, 0);
    if (baseDur <= 0 && !_getPreviewMasterElement()) {
        let maxOverlayEnd = 0;
        if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
            for (const ov of (_reelsState.overlayProxy.overlayMgr.overlays || [])) {
                const ovEnd = parseFloat(ov.end || 0);
                // 跳过 9999（全程标记），它不代表实际时长
                if (ovEnd >= 9999) continue;
                if (ovEnd > maxOverlayEnd) maxOverlayEnd = ovEnd;
            }
        }
        const demoWords = ((document.getElementById('reels-preview-text') || {}).value || '').split(/\s+/).filter(Boolean);
        const totalDur = Math.max(3, (demoWords.length || 1) * 0.6);
        const contentDur = maxOverlayEnd > 0 ? maxOverlayEnd + 0.5 : totalDur;
        return contentDur + offsetDur;
    }
    return baseDur + offsetDur;
}

function _getPreviewLoopFadeConfig() {
    const loopFadeEl = document.getElementById('reels-loop-fade');
    const loopFadeDurEl = document.getElementById('reels-loop-fade-dur');
    const enabled = loopFadeEl ? loopFadeEl.checked : true;
    let duration = parseFloat(loopFadeDurEl ? loopFadeDurEl.value : '1');
    if (!Number.isFinite(duration) || duration <= 0) duration = 1.0;
    duration = Math.max(0.1, Math.min(3, duration));
    return { enabled, duration };
}

function _setExportSettingValue(id, val) {
    const el = document.getElementById(id);
    const rangeEl = document.getElementById(id + '-range') || (id === 'reels-bg-volume' ? document.getElementById('reels-bg-volume-range-global') : null);
    const raw = val == null ? '' : String(val);
    if (el) el.value = raw;
    if (rangeEl) rangeEl.value = (id === 'reels-custom-duration' && raw === '') ? '0' : raw;
}

function _bindExportSliderNumber(id, opts = {}) {
    const num = document.getElementById(id);
    const range = document.getElementById(opts.rangeId || `${id}-range`);
    if (!num || !range || range.dataset.bound === 'true') return;
    range.dataset.bound = 'true';
    const normalizeForRange = (value) => {
        if (opts.blankOnZero && (value === '' || value == null)) return '0';
        return String(value);
    };
    const normalizeForNumber = (value) => {
        if (opts.blankOnZero && parseFloat(value) === 0) return '';
        return String(value);
    };
    const fire = () => {
        if (typeof opts.onChange === 'function') opts.onChange();
    };
    range.addEventListener('input', () => {
        num.value = normalizeForNumber(range.value);
        fire();
    });
    num.addEventListener('input', () => {
        range.value = normalizeForRange(num.value);
        fire();
    });
    range.value = normalizeForRange(num.value);
}

function _initExportSettingSliders() {
    const refreshPreviewAudio = () => {
        if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
    };
    const refreshPreview = () => {
        if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    };
    _bindExportSliderNumber('reels-custom-duration', { blankOnZero: true });
    _bindExportSliderNumber('reels-voice-volume', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-bg-volume', { rangeId: 'reels-bg-volume-range-global', onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-bgm-volume', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-reverb-mix', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-stereo-width', { onChange: refreshPreviewAudio });
    _bindExportSliderNumber('reels-loop-fade-dur', { onChange: refreshPreview });
    _bindExportSliderNumber('reels-export-concurrency');
}

function _getPreviewAudioMixConfig() {
    let voiceVolume = parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100');
    let bgVolume = _getGlobalBgVolumePercent();
    let bgmVolume = _getGlobalBgmVolumePercent();
    if (!Number.isFinite(voiceVolume)) voiceVolume = 100;
    if (!Number.isFinite(bgVolume)) bgVolume = 100;
    if (!Number.isFinite(bgmVolume)) bgmVolume = 30;
    voiceVolume = Math.max(0, voiceVolume);
    bgVolume = Math.max(0, bgVolume);
    bgmVolume = Math.max(0, bgmVolume);
    return { voiceGain: voiceVolume / 100, bgGain: bgVolume / 100, bgmGain: bgmVolume / 100 };
}

function _getGlobalBgVolumePercent() {
    const bgVolumeEl = document.getElementById('reels-bg-volume');
    const bgVolume = parseFloat(bgVolumeEl ? bgVolumeEl.value : '100');
    return Number.isFinite(bgVolume) ? Math.max(0, bgVolume) : 100;
}

function _getGlobalVoiceVolumePercent() {
    const voiceVolumeEl = document.getElementById('reels-voice-volume');
    const voiceVolume = parseFloat(voiceVolumeEl ? voiceVolumeEl.value : '100');
    return Number.isFinite(voiceVolume) ? Math.max(0, voiceVolume) : 100;
}

function _getGlobalBgmVolumePercent() {
    const bgmVolumeEl = document.getElementById('reels-bgm-volume');
    const bgmVolume = parseFloat(bgmVolumeEl ? bgmVolumeEl.value : '30');
    return Number.isFinite(bgmVolume) ? Math.max(0, bgmVolume) : 30;
}

function _getEffectiveBgVolumePercent(task, globalBgVolume = _getGlobalBgVolumePercent()) {
    const raw = task && task.bgVideoVolume != null ? parseFloat(task.bgVideoVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalBgVolume) * Math.max(0, raw) / 100;

    if (task && task === _getSelectedTask()) {
        const range = document.getElementById('reels-bg-volume-range');
        const num = document.getElementById('reels-bg-volume-num');
        const isCustom = range?.dataset?.isCustom === 'true' || num?.dataset?.isCustom === 'true';
        const uiValue = parseFloat((num && num.value !== '') ? num.value : (range || {}).value);
        if (isCustom && Number.isFinite(uiValue)) {
            return Math.max(0, globalBgVolume) * Math.max(0, uiValue) / 100;
        }
    }

    return Math.max(0, globalBgVolume);
}

function _getEffectiveVoiceVolumePercent(task, globalVoiceVolume = _getGlobalVoiceVolumePercent()) {
    const raw = task && task.voiceVolume != null ? parseFloat(task.voiceVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalVoiceVolume) * Math.max(0, raw) / 100;
    return Math.max(0, globalVoiceVolume);
}

function _getEffectiveBgmVolumePercent(task, globalBgmVolume = _getGlobalBgmVolumePercent()) {
    const raw = task && task.bgmVolume != null ? parseFloat(task.bgmVolume) : NaN;
    if (Number.isFinite(raw)) return Math.max(0, globalBgmVolume) * Math.max(0, raw) / 100;

    if (task && task === _getSelectedTask()) {
        const range = document.getElementById('reels-bgm-task-volume-range');
        const num = document.getElementById('reels-bgm-task-volume-num');
        const isCustom = range?.dataset?.isCustom === 'true' || num?.dataset?.isCustom === 'true';
        const uiValue = parseFloat((num && num.value !== '') ? num.value : (range || {}).value);
        if (isCustom && Number.isFinite(uiValue)) {
            return Math.max(0, globalBgmVolume) * Math.max(0, uiValue) / 100;
        }
    }

    return Math.max(0, globalBgmVolume);
}

function _applyPreviewAudioMix() {
    // ── 确保 Web Audio 拓扑建立 ──
    _setupPreviewReverb();

    const ctx = _reelsState._audioCtx;
    if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(e => {});
    }
    const useWebAudio = !!(ctx && _reelsState._gainNodes);

    const task = _getSelectedTask();
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const cfg = _getPreviewAudioMixConfig();
    const hasVoice = !!(task && task.audioPath && audio && audio.src);
    // ── 计算有效音量：全局导出音量作为总控，任务级音量作为单任务微调 ──
    const effectiveVoiceGain = _getEffectiveVoiceVolumePercent(task, cfg.voiceGain * 100) / 100;
    const effectiveBgGain = _getEffectiveBgVolumePercent(task, cfg.bgGain * 100) / 100;

    if (audio) {
        const vol = hasVoice ? effectiveVoiceGain : 1.0;
        const isRouted = useWebAudio && _reelsState._mediaSources.has(audio) && _reelsState._gainNodes.has(audio);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(audio);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            audio.volume = vol > 0 ? 1.0 : 0;
            audio.muted = vol <= 0.001;
        } else {
            audio.volume = Math.min(1.0, vol);
            audio.muted = hasVoice ? (vol <= 0.001) : false;
        }
    }
    const players = [video, _reelsState.previewFadeVideo].filter(Boolean);
    for (const p of players) {
        const vol = effectiveBgGain;
        const isRouted = useWebAudio && _reelsState._mediaSources.has(p) && _reelsState._gainNodes.has(p);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(p);
            gainNode.gain.setValueAtTime(vol, ctx.currentTime);
            p.volume = vol > 0 ? 1.0 : 0;
            p.muted = vol <= 0.001;
        } else {
            p.volume = Math.min(1.0, vol);
            p.muted = vol <= 0.001;
        }
    }

    // ── 覆层视频 (Content Video) 音量 ──
    if (contentVideoEl && task) {
        const cvVolRaw = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
        const cvVol = Math.max(0, cvVolRaw / 100); // 允许无上限
        const isRouted = useWebAudio && _reelsState._mediaSources.has(contentVideoEl) && _reelsState._gainNodes.has(contentVideoEl);
        if (isRouted) {
            const gainNode = _reelsState._gainNodes.get(contentVideoEl);
            gainNode.gain.setValueAtTime(cvVol, ctx.currentTime);
            contentVideoEl.volume = cvVol > 0 ? 1.0 : 0;
            contentVideoEl.muted = cvVol <= 0.001;
        } else {
            contentVideoEl.volume = Math.min(1.0, cvVol);
            contentVideoEl.muted = cvVol <= 0.001;
        }
    }

    // ── BGM 音量 ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio) {
        const finalBgmPath = task ? _getEffectiveBgmPath(task, _reelsState.selectedIdx) : '';
        if (finalBgmPath && bgmAudio.src) {
            const bgmVol = _getEffectiveBgmVolumePercent(task, cfg.bgmGain * 100) / 100;
            const isRouted = useWebAudio && _reelsState._mediaSources.has(bgmAudio) && _reelsState._gainNodes.has(bgmAudio);
            if (isRouted) {
                const gainNode = _reelsState._gainNodes.get(bgmAudio);
                gainNode.gain.setValueAtTime(bgmVol, ctx.currentTime);
                bgmAudio.volume = bgmVol > 0 ? 1.0 : 0;
                bgmAudio.muted = bgmVol <= 0.001;
            } else {
                bgmAudio.volume = Math.max(0, Math.min(1.0, bgmVol));
                bgmAudio.muted = bgmVol <= 0.001;
            }
        } else {
            const isRouted = useWebAudio && _reelsState._mediaSources.has(bgmAudio) && _reelsState._gainNodes.has(bgmAudio);
            if (isRouted) {
                const gainNode = _reelsState._gainNodes.get(bgmAudio);
                gainNode.gain.setValueAtTime(0, ctx.currentTime);
            }
            bgmAudio.volume = 0;
            bgmAudio.muted = true;
        }
    }

    // 外围表格和控件仍统一调用本函数；V2 开启时同步其独立媒体节点。
    window.ReelsPreviewV2?.syncAudio?.();
}

// ═══════════════════════════════════════════════════════
// 预览音频混响 + 立体声增强 (Web Audio API)
// ═══════════════════════════════════════════════════════

const _REVERB_PRESETS = {
    room:   { decay: 0.8, duration: 0.6, density: 3000, lpFreq: 8000 },
    hall:   { decay: 2.0, duration: 1.5, density: 5000, lpFreq: 6000 },
    church: { decay: 4.0, duration: 3.0, density: 8000, lpFreq: 4000 },
    plate:  { decay: 1.2, duration: 1.0, density: 6000, lpFreq: 10000 },
    echo:   { decay: 1.5, duration: 0.8, density: 1500, lpFreq: 5000 },
};

// 确定性伪随机数生成器（mulberry32），保证相同preset的IR在预览和导出中一致
function _mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// 将 preset 名字转为固定种子
function _presetSeed(preset) {
    let h = 0x811c9dc5;
    for (let i = 0; i < preset.length; i++) {
        h ^= preset.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function _generateImpulseResponse(ctx, preset) {
    const p = _REVERB_PRESETS[preset] || _REVERB_PRESETS.hall;
    const presetKey = preset || 'hall';
    const sampleRate = ctx.sampleRate;
    const length = Math.ceil(sampleRate * p.duration);
    const buffer = ctx.createBuffer(2, length, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        // 每个声道用不同的种子，但同一 preset 始终相同
        const rng = _mulberry32(_presetSeed(presetKey) + ch * 0xDEAD);
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const envelope = Math.exp(-t / (p.decay * 0.3));
            data[i] = (rng() * 2 - 1) * envelope;
        }
    }
    return buffer;
}

function _setupPreviewReverb() {
    const audio = document.getElementById('reels-preview-audio');
    const video = document.getElementById('reels-preview-video');
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const bgm = _reelsState._bgmAudioEl;
    if (!audio && !video && !contentVideoEl && !bgm) return;

    const enabled = document.getElementById('reels-reverb-enabled')?.checked || false;
    const targetFx = document.getElementById('reels-audio-fx-target')?.value || 'all';
    const stereoWidth = (parseFloat(document.getElementById('reels-stereo-width')?.value) || 100) / 100;
    const mix = (parseFloat(document.getElementById('reels-reverb-mix')?.value) || 30) / 100;
    const needsFx = enabled || (stereoWidth > 1.05);

    // Initialize AudioContext and mediaSources Map if not present
    if (!_reelsState._audioCtx) {
        try {
            _reelsState._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('[Reverb] Web Audio not supported', e);
            return;
        }
    }
    if (!_reelsState._mediaSources) _reelsState._mediaSources = new Map();
    if (!_reelsState._gainNodes) _reelsState._gainNodes = new Map();
    const ctx = _reelsState._audioCtx;

    // Attach MediaElementSource for any new elements
    const fadeVideo = _reelsState.previewFadeVideo;
    const els = [audio, video, fadeVideo, contentVideoEl, bgm].filter(Boolean);
    for (const el of els) {
        if (!_reelsState._mediaSources.has(el)) {
            try {
                const source = ctx.createMediaElementSource(el);
                _reelsState._mediaSources.set(el, source);
            } catch (e) {
                console.warn('[Reverb] Failed to create source for', el, e);
            }
        }
        if (!_reelsState._gainNodes.has(el)) {
            try {
                const gainNode = ctx.createGain();
                gainNode.gain.setValueAtTime(1.0, ctx.currentTime);
                _reelsState._gainNodes.set(el, gainNode);
            } catch (e) {
                console.warn('[Reverb] Failed to create gain node for', el, e);
            }
        }
    }

    // Disconnect everything fully before rewiring
    for (const source of _reelsState._mediaSources.values()) {
        try { source.disconnect(); } catch (e) { }
    }
    for (const gainNode of _reelsState._gainNodes.values()) {
        try { gainNode.disconnect(); } catch (e) { }
    }
    if (_reelsState._reverbGainWet) { try { _reelsState._reverbGainWet.disconnect(); } catch(e){} }
    if (_reelsState._reverbGainDry) { try { _reelsState._reverbGainDry.disconnect(); } catch(e){} }
    if (_reelsState._convolver) { try { _reelsState._convolver.disconnect(); } catch(e){} }
    if (_reelsState._stereoDelay) {
        try {
            _reelsState._stereoDelay.masterGain.disconnect();
            _reelsState._stereoDelay.splitter.disconnect();
            _reelsState._stereoDelay.delayL.disconnect();
            _reelsState._stereoDelay.delayR.disconnect();
            _reelsState._stereoDelay.merger.disconnect();
        } catch (e) {}
    }

    // Wire each source node to its corresponding Volume GainNode
    for (const [el, source] of _reelsState._mediaSources.entries()) {
        const gainNode = _reelsState._gainNodes.get(el);
        if (gainNode) {
            source.connect(gainNode);
        }
    }

    // Determine target element for FX
    let targetEl = null;
    let targetGainNode = null;
    
    if (needsFx) {
        if ((targetFx === 'voice' || targetFx === 'all') && audio?.src) targetEl = audio;
        else if ((targetFx === 'bg' || targetFx === 'all') && video?.src) targetEl = video;
        else if ((targetFx === 'bgm' || targetFx === 'all') && bgm?.src) targetEl = bgm;
        // Fallback cascade
        if (!targetEl) {
            if (audio?.src) targetEl = audio;
            else if (video?.src) targetEl = video;
            else if (bgm?.src) targetEl = bgm;
        }
        if (targetEl) targetGainNode = _reelsState._gainNodes.get(targetEl);
    }

    // Connect non-target GainNodes directly to destination
    for (const [el, gainNode] of _reelsState._gainNodes.entries()) {
        if (gainNode && el !== targetEl) {
            gainNode.connect(ctx.destination);
        }
    }

    // If no FX or no target gain node, target gain node also connects directly to destination
    if (!needsFx || !targetGainNode) {
        if (targetGainNode) targetGainNode.connect(ctx.destination);
        return;
    }

    // --- Build FX Chain for target ---
    const preset = document.getElementById('reels-reverb-preset')?.value || 'hall';

    // Dry Gain
    const dryGain = ctx.createGain();
    dryGain.gain.value = enabled ? (1 - mix * 0.5) : 1.0; 

    // Wet Gain (Reverb)
    let convolver = null;
    let wetGain = null;
    if (enabled) {
        convolver = ctx.createConvolver();
        convolver.buffer = _generateImpulseResponse(ctx, preset);
        wetGain = ctx.createGain();
        wetGain.gain.value = mix;
    }

    const masterGain = ctx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.channelCount = 2;
    masterGain.channelCountMode = 'explicit';

    targetGainNode.connect(dryGain);
    dryGain.connect(masterGain);

    if (enabled) {
        targetGainNode.connect(convolver);
        convolver.connect(wetGain);
        wetGain.connect(masterGain);
    }

    // Stereo Expansion
    if (stereoWidth > 1.05) {
        const merger = ctx.createChannelMerger(2);
        const splitter = ctx.createChannelSplitter(2);
        const delayL = ctx.createDelay(0.05);
        const delayR = ctx.createDelay(0.05);
        const widthFactor = Math.max(0, (stereoWidth - 1)) * 0.015; 
        delayL.delayTime.value = widthFactor * 0.3;
        delayR.delayTime.value = widthFactor * 0.7;

        masterGain.connect(splitter);
        splitter.connect(delayL, 0);
        splitter.connect(delayR, 1);
        delayL.connect(merger, 0, 0);
        delayR.connect(merger, 0, 1);
        merger.connect(ctx.destination);

        _reelsState._stereoDelay = { delayL, delayR, splitter, merger, masterGain };
    } else {
        masterGain.connect(ctx.destination);
        _reelsState._stereoDelay = null;
    }

    // Save refs
    _reelsState._convolver = convolver;
    _reelsState._reverbGainWet = wetGain;
    _reelsState._reverbGainDry = dryGain;
}

function _getReverbConfig() {
    return {
        enabled: document.getElementById('reels-reverb-enabled')?.checked || false,
        preset: document.getElementById('reels-reverb-preset')?.value || 'hall',
        mix: parseFloat(document.getElementById('reels-reverb-mix')?.value || '30'),
        stereoWidth: parseFloat(document.getElementById('reels-stereo-width')?.value || '100'),
        audioFxTarget: document.getElementById('reels-audio-fx-target')?.value || 'all',
    };
}

function _resetPreviewFadeVideo() {
    const fadeVideo = _reelsState.previewFadeVideo;
    if (!fadeVideo) return;
    fadeVideo.pause();
    fadeVideo.removeAttribute('src');
    _reelsState.previewFadeVideoSrc = '';
}

function _ensurePreviewFadeVideo(mainVideo) {
    if (!mainVideo) return null;
    const task = _getSelectedTask();
    const isMulti = task && task.bgMode === 'multi';
    if (!isMulti && !mainVideo.src) return null;

    if (!_reelsState.previewFadeVideo) {
        const fadeVideo = document.createElement('video');
        fadeVideo.id = 'reels-preview-video-fade';
        fadeVideo.muted = true;
        fadeVideo.loop = true;
        fadeVideo.playsInline = true;
        fadeVideo.preload = 'auto';
        const host = document.getElementById('reels-preview-container') || document.body;
        host.appendChild(fadeVideo);
        _ensurePreviewVideoDecodable(fadeVideo);
        _reelsState.previewFadeVideo = fadeVideo;
        _applyPreviewAudioMix();
    }

    const fadeVideo = _reelsState.previewFadeVideo;
    if (!isMulti && _reelsState.previewFadeVideoSrc !== mainVideo.src) {
        fadeVideo.pause();
        fadeVideo.src = mainVideo.src;
        _reelsState.previewFadeVideoSrc = mainVideo.src;
    }
    return fadeVideo;
}

function _calcPreviewLoopFadeFrame() {
    const task = _getSelectedTask();
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    if (!task || !video || !video.src || video.readyState < 2) return null;
    if (task.bgMode === 'multi') return null;
    if (!task.audioPath || _isImagePath(task.bgPath || task.videoPath)) return null;

    const cfg = _getPreviewLoopFadeConfig();
    const vDur = _getVideoDuration(task);
    if (!cfg.enabled || !(vDur > 0)) return null;

    const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
    if (!(vDur > fadeDur + 0.05)) return null;

    const masterTime = _getPreviewCurrentTime();
    if (!Number.isFinite(masterTime) || masterTime < 0) return null;

    // ── 智能避让：预览接近结尾时压制转场，避免最终帧是半透明重叠 ──
    const totalDur = _getPreviewDuration();
    if (totalDur > 0 && (totalDur - masterTime) < fadeDur) {
        // 接近结束，不绘制交叉淡化
        return null;
    }

    const loopTime = ((masterTime % vDur) + vDur) % vDur;
    const remain = vDur - loopTime;
    if (!(remain < fadeDur)) return null;

    const fadeVideo = _ensurePreviewFadeVideo(video);
    if (!fadeVideo) return null;

    const target = (loopTime + fadeDur) % vDur;
    if (Math.abs((fadeVideo.currentTime || 0) - target) > 0.08) {
        try { fadeVideo.currentTime = target; } catch (e) { }
    }
    if (audio && !audio.paused && fadeVideo.paused) {
        fadeVideo.play().catch(() => { });
    }

    const alpha = Math.max(0, Math.min(1, (fadeDur - remain) / fadeDur));
    if (!(alpha > 0.001)) return null;
    return { video: fadeVideo, alpha };
}

function _syncBackgroundVideoToMaster() {
    const task = _getSelectedTask();
    if (!task) return;

    // Skip sync during hook or cover phase (hook video renders separately, cover is static)
    if (_reelsState.hookPhase || _reelsState.coverPhase) return;

    let masterTime = _getPreviewCurrentTime();
    // Offset by hook + cover duration so content time is relative to main phase start
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;
    if (offsetDur > 0) masterTime = Math.max(0, masterTime - offsetDur);
    if (!isFinite(masterTime) || masterTime < 0) return;

    // --- Sync Content Video ---
    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    const master = _getPreviewMasterElement();
    if (contentVideoEl && contentVideoEl.src && contentVideoEl.readyState >= 1) {
        if (contentVideoEl !== master) {
            if (contentVideoEl.duration > 0) {
                const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
                const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
                let cvDur = contentVideoEl.duration;
                if (trimEnd > trimStart && trimStart >= 0) {
                    cvDur = Math.max(0.1, trimEnd - trimStart);
                } else if (trimStart > 0) {
                    cvDur = Math.max(0.1, contentVideoEl.duration - trimStart);
                }
                const target = (masterTime % cvDur) + trimStart;
                if (!contentVideoEl.seeking && Math.abs((contentVideoEl.currentTime || 0) - target) > 0.25) {
                    try { contentVideoEl.currentTime = target; } catch (e) { }
                }
                const isPlaying = _isPreviewMediaPlaying(master) || !!_reelsState.mockPlaying;
                if (isPlaying && contentVideoEl.paused) {
                    contentVideoEl.play().catch(() => { });
                } else if (!isPlaying && !contentVideoEl.paused) {
                    contentVideoEl.pause();
                }
            }
        }
    }

    // --- Sync Background Video ---
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    if (task.contentVideoDirectBg && task.contentVideoPath) {
        if (video && !video.paused) video.pause();
        if (_reelsState.previewFadeVideo && !_reelsState.previewFadeVideo.paused) _reelsState.previewFadeVideo.pause();
        return;
    }
    if (task.bgMode === 'multi') return;
    if (!video || !video.src || video.readyState < 1 || _isImagePath(task.bgPath || task.videoPath)) return;
    const vDur = _getVideoDuration(task);
    if (vDur > 0) {
        const target = masterTime % vDur;
        if (!video.seeking && Math.abs((video.currentTime || 0) - target) > 0.25) {
            try { video.currentTime = target; } catch (e) { }
        }
        // 某些容器在 ended 后会暂停，手动拉起继续播，保证背景持续循环。
        if (audio && !audio.paused && video.paused) {
            video.play().catch(() => { });
        }

        const cfg = _getPreviewLoopFadeConfig();
        if (task.audioPath && cfg.enabled && vDur > cfg.duration + 0.05) {
            const fadeVideo = _ensurePreviewFadeVideo(video);
            if (fadeVideo) {
                const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
                const fadeTarget = (target + fadeDur) % vDur;
                if (!fadeVideo.seeking && Math.abs((fadeVideo.currentTime || 0) - fadeTarget) > 0.2) {
                    try { fadeVideo.currentTime = fadeTarget; } catch (e) { }
                }
                if (audio && !audio.paused && fadeVideo.paused) {
                    fadeVideo.play().catch(() => { });
                }
            }
        } else if (_reelsState.previewFadeVideo) {
            _reelsState.previewFadeVideo.pause();
        }
    }
}

function _updatePreviewTimeUI(currentTime, duration) {
    const seekBar = document.getElementById('reels-preview-seek');
    if (seekBar && !seekBar._hasBoundSeekbarEvents) {
        seekBar._hasBoundSeekbarEvents = true;
        
        const startScrubbing = () => { window._isScrubbingSeekbar = true; };
        const stopScrubbing = () => { window._isScrubbingSeekbar = false; };
        
        seekBar.addEventListener('pointerdown', startScrubbing);
        seekBar.addEventListener('mousedown', startScrubbing);
        seekBar.addEventListener('touchstart', startScrubbing);
        
        seekBar.addEventListener('pointerup', stopScrubbing);
        seekBar.addEventListener('pointercancel', stopScrubbing);
        seekBar.addEventListener('mouseup', stopScrubbing);
        seekBar.addEventListener('touchend', stopScrubbing);
        seekBar.addEventListener('change', stopScrubbing);
        
        window.addEventListener('pointerup', stopScrubbing);
        window.addEventListener('mouseup', stopScrubbing);
        window.addEventListener('touchend', stopScrubbing);
    }
    const timeLabel = document.getElementById('reels-preview-time');
    if (seekBar && duration > 0 && !window._isScrubbingSeekbar) {
        seekBar.value = Math.max(0, Math.min(100, (currentTime / duration) * 100));
    }
    if (timeLabel) {
        const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        timeLabel.textContent = `${fmt(currentTime || 0)}/${fmt(duration || 0)}`;
    }
}

function _updateTimelineForTask(task) {
    if (!_reelsState.timelineEditor || !task) return;
    const editor = _reelsState.timelineEditor;
    editor.subtitleBaseStyle = _resolveSubtitleStyleForTask(task);
    if (task.segments && task.segments.length > 0) editor.loadSubtitleTrack(task.segments);
    else editor.loadSubtitleTrack([]);

    const aDur = _getAudioDuration(task);
    const vDur = _getVideoDuration(task);
    const cvDur = _getContentVideoDuration(task);
    const subDur = task.segments && task.segments.length > 0
        ? (task.segments[task.segments.length - 1].end || 0)
        : 0;
    let contentDur = Math.max(aDur, vDur, cvDur, subDur, 1);
    if (task.customDuration && task.customDuration > 0) {
        contentDur = Math.max(contentDur, task.customDuration);
    }
    // V2 与时间线使用相同的时长来源：它已包含配音/背景变速、多背景、
    // 自定义时长和动态覆层等规则；时间线仍显示主内容时长（不含封面/Hook 偏移）。
    const totalDur = window.ReelsPreviewV2?.isOpen?.()
        ? window.ReelsPreviewV2.getTimelineDuration()
        : contentDur;
    editor.loadAudioTrack(aDur, task.audioPath ? '人声' : '音频');
    // 背景在预览/输出中会循环覆盖整段内容，轨道也应显示实际覆盖时长，
    // 不能在无配音时退回到单个背景素材的原始时长。
    const bgTrackDur = totalDur;
    const bgTrackName = task.contentVideoDirectBg ? '内容背景' : (totalDur > vDur + 0.01 ? '背景(循环)' : '背景');
    editor.loadBackgroundTrack(bgTrackDur, bgTrackName);
    editor.setDuration(totalDur);
}

function _buildAudioSubtitleMatchKey(name) {
    const normalized = _normalizeBaseName(name).replace(/[\u2013\u2014]/g, '-');
    const tokens = normalized
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .filter(t => !REELS_MATCH_STOPWORDS.has(t));
    return tokens.join('_') || normalized;
}
window._buildAudioSubtitleMatchKey = _buildAudioSubtitleMatchKey;

function _inferTaskBaseName(task) {
    const src = task.baseName || task.fileName || task.audioPath || task.bgPath || task.videoPath || task.srtPath || '';
    const fileName = String(src).split(/[\\/]/).pop();
    return _normalizeBaseName(fileName);
}

function _getOrCreateTaskByBase(baseName, fallbackName = '') {
    const normalized = _normalizeBaseName(baseName || fallbackName);
    let task = _reelsState.tasks.find(t => _inferTaskBaseName(t) === normalized);
    if (task) return task;

    task = {
        id: 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        baseName: normalized,
        fileName: fallbackName || `${normalized || 'reel'}.mp4`,
        bgPath: null,
        bgSrcUrl: null,
        audioPath: null,
        srtPath: null,
        segments: [],
        // 兼容旧字段
        videoPath: null,
        srcUrl: null,
    };
    _reelsState.tasks.push(task);
    return task;
}

async function reelsCreateTaskFromAutoEditResult(autoEditResult = {}, opts = {}) {
    const videoPath = autoEditResult.output_path || autoEditResult.outputPath || '';
    const srtPath = autoEditResult.srt_path || autoEditResult.srtPath || '';
    if (!videoPath) throw new Error('缺少自动剪辑输出视频');
    if (!srtPath) throw new Error('缺少自动剪辑输出字幕');

    const baseName = _normalizeBaseName(
        opts.baseName ||
        String(videoPath).split(/[\\/]/).pop().replace(/\.[^.]+$/, '') ||
        'auto_edit'
    );
    const task = (typeof _createEmptyTask === 'function') ? _createEmptyTask() : {
        id: 'task_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
        bgPath: null,
        bgSrcUrl: null,
        audioPath: null,
        srtPath: null,
        segments: [],
        videoPath: null,
        srcUrl: null,
    };

    task.baseName = baseName || 'auto_edit';
    task.fileName = `${task.baseName}.mp4`;
    task.audioPath = null;
    task.srtPath = srtPath;
    task.aligned = true;
    task.alignSource = 'auto_edit';
    task._autoEditSource = true;

    if (typeof _setTaskSingleBackground === 'function') {
        _setTaskSingleBackground(task, videoPath, { clearBgSrcUrl: true });
    } else {
        task.bgPath = videoPath;
        task.videoPath = videoPath;
        task.bgSrcUrl = null;
        task.srcUrl = null;
    }

    let srtContent = autoEditResult.srt_content || '';
    if (!srtContent && window.electronAPI?.readFileText) {
        srtContent = await window.electronAPI.readFileText(srtPath);
    }
    if (srtContent && typeof parseSRT === 'function') {
        const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
        task.segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
    } else if (Array.isArray(autoEditResult.segments)) {
        task.segments = autoEditResult.segments
            .filter(seg => seg && seg.script && Number.isFinite(Number(seg.duration)))
            .reduce((acc, seg, i) => {
                const start = acc.length ? acc[acc.length - 1].end : 0;
                const end = start + Math.max(0.001, Number(seg.duration));
                acc.push({ index: i + 1, start, end, text: seg.script, words: [] });
                return acc;
            }, []);
    }

    _reelsState.tasks.push(task);
    _reelsState.selectedIdx = _reelsState.tasks.length - 1;

    const workMode = document.getElementById('reels-work-mode');
    if (workMode) {
        workMode.value = 'voiced_bg';
        if (typeof reelsOnWorkModeChange === 'function') reelsOnWorkModeChange();
    }

    if (typeof _renderBatchTable === 'function') _renderBatchTable();
    if (typeof _renderTaskList === 'function') _renderTaskList();
    if (typeof reelsSelectTask === 'function') reelsSelectTask(_reelsState.selectedIdx);
    else if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();

    return task;
}
window.reelsCreateTaskFromAutoEditResult = reelsCreateTaskFromAutoEditResult;

function _buildFileInfo(file) {
    const name = file.name || '';
    let filePath = name;
    
    // 1. 尝试 Electron API（最可靠）
    if (window.electronAPI && window.electronAPI.getFilePath) {
        try {
            const p = window.electronAPI.getFilePath(file);
            if (p) filePath = p;
            console.log(`[_buildFileInfo] electronAPI.getFilePath("${name}") → "${p}"`);
        } catch (e) {
            console.warn(`[_buildFileInfo] electronAPI.getFilePath error:`, e);
        }
    }
    
    // 2. 回退: file.path（旧 Electron / contextIsolation:false）
    if (filePath === name && file.path) {
        filePath = file.path;
        console.log(`[_buildFileInfo] fallback to file.path: "${filePath}"`);
    }
    
    // 3. 最终回退: 仅文件名
    if (filePath === name) {
        console.warn(`[_buildFileInfo] ⚠️ 无法获取完整路径，仅文件名: "${name}"`);
    }
    
    return {
        name,
        path: filePath,
        baseName: _normalizeBaseName(name),
        matchKey: _buildAudioSubtitleMatchKey(name),
    };
}

function _pushPendingUnique(list, item) {
    const key = item.path || item.name;
    const exists = list.some(x => (x.path || x.name) === key);
    if (!exists) list.push(item);
}

function _queueBackgroundFile(file) {
    const info = _buildFileInfo(file);
    let srcUrl = null;
    if (window.electronAPI && typeof window.electronAPI.toFileUrl === 'function' && info.path) {
        srcUrl = window.electronAPI.toFileUrl(info.path);
    } else {
        try { srcUrl = URL.createObjectURL(file); } catch (e) { }
    }
    info.srcUrl = srcUrl;
    _pushPendingUnique(_reelsState.pendingFiles.backgrounds, info);
}

function _upsertBackgroundLibrary(bg) {
    if (!bg || !bg.path) return;
    const idx = _reelsState.backgroundLibrary.findIndex(x => x.path === bg.path);
    if (idx >= 0) {
        _reelsState.backgroundLibrary[idx] = { ..._reelsState.backgroundLibrary[idx], ...bg };
    } else {
        _reelsState.backgroundLibrary.push({ ...bg });
    }
}

function _queueAudioFile(file) {
    const info = _buildFileInfo(file);
    _pushPendingUnique(_reelsState.pendingFiles.audios, info);
}

function _queueSrtFile(file) {
    const info = _buildFileInfo(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
        info.content = ev.target.result;
        _pushPendingUnique(_reelsState.pendingFiles.srts, info);
        reelsAutoMatchFiles();
    };
    reader.readAsText(file);
}

function _queueTxtFile(file) {
    const info = _buildFileInfo(file);
    const reader = new FileReader();
    reader.onload = (ev) => {
        info.content = ev.target.result;
        _pushPendingUnique(_reelsState.pendingFiles.txts, info);
        reelsAutoMatchFiles();
    };
    reader.readAsText(file);
}

function _onTxtFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) _queueTxtFile(f);
    e.target.value = '';
}

// 手动输入字幕弹窗
async function reelsManualSubtitleInput() {
    const result = await _showTextareaDialog(
        '✏️ 手动输入字幕文本',
        '每行 = 一条字幕段落（已断行的文本）\n支持多行，每行将作为独立字幕条目。',
        ''
    );
    if (!result || !result.trim()) return;

    // 视为一条 TXT 输入
    const info = {
        name: '_manual_input.txt',
        path: '_manual_input.txt',
        baseName: '_manual_input',
        matchKey: '',
        content: result,
    };
    _pushPendingUnique(_reelsState.pendingFiles.txts, info);
    reelsAutoMatchFiles();
}

// 通用 textarea 弹窗
function _showTextareaDialog(title, placeholder, defaultVal) {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:24px;width:520px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.5);';
        box.innerHTML = `
            <h3 style="margin:0 0 12px;font-size:16px;">${title}</h3>
            <textarea id="_reels_textarea_dlg" rows="10"
                style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border-color,#444);
                       background:var(--bg-tertiary,#2a2a3e);color:var(--text-primary,#eee);
                       font-size:13px;resize:vertical;font-family:inherit;"
                placeholder="${placeholder}">${defaultVal || ''}</textarea>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
                <button class="btn btn-secondary" id="_reels_textarea_cancel">取消</button>
                <button class="btn btn-primary" id="_reels_textarea_ok">确认</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const ta = box.querySelector('#_reels_textarea_dlg');
        const close = (val) => { document.body.removeChild(overlay); resolve(val); };
        box.querySelector('#_reels_textarea_cancel').onclick = () => close(null);
        box.querySelector('#_reels_textarea_ok').onclick = () => close(ta.value);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        setTimeout(() => ta.focus(), 50);
    });
}

// ═══════════════════════════════════════════════════════
// Subtitle alignment (call existing subtitle/generate API)
// ═══════════════════════════════════════════════════════

function reelsShowMismatchDialog(taskName, mismatchData, sourceText) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;';

        const content = document.createElement('div');
        content.style.cssText = 'background:var(--bg-secondary,#1e1e2e);width:600px;max-width:90%;border-radius:12px;padding:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;font-family:system-ui,-apple-system,sans-serif;color:var(--text-primary,#eee);';

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:24px;">⚠️</span>
                <h3 style="margin:0;color:var(--text-primary,#eee);font-size:18px;">文案匹配度警告 (匹配度: ${mismatchData.similarity}%)</h3>
            </div>
            <div style="font-size:14px;color:var(--text-secondary,#bbb);line-height:1.5;">
                任务 <b style="color:var(--text-primary,#eee);">${escapeHtml(taskName)}</b> 提取到的声音与您提供的参考文案差异极大。<br/>
                强行对齐将导致字幕时间轴严重错乱。
            </div>
            <div style="display:flex;gap:12px;margin-top:8px;">
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);min-width:0;">
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);margin-bottom:8px;font-weight:bold;">📝 您提供的原文案</div>
                    <div style="font-size:13px;color:var(--text-primary,#eee);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${escapeHtml(sourceText || '')}</div>
                </div>
                <div style="flex:1;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);min-width:0;">
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);margin-bottom:8px;font-weight:bold;">🎙️ AI 实际识别到的声音</div>
                    <div style="font-size:13px;color:var(--text-primary,#eee);max-height:150px;overflow-y:auto;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${escapeHtml(mismatchData.recognized_text || '')}</div>
                </div>
            </div>
            <div style="font-size:13px;color:var(--text-secondary,#bbb);margin-top:10px;">请选择如何处理此任务：</div>
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px;">
                <button id="reels-mismatch-btn-force" class="btn btn-secondary" style="flex:1;font-size:12px;padding:8px 12px;cursor:pointer;">⚠️ 强制使用原文案</button>
                <button id="reels-mismatch-btn-skip" class="btn btn-secondary" style="flex:1;font-size:12px;padding:8px 12px;cursor:pointer;">⏭️ 跳过此任务</button>
                <button id="reels-mismatch-btn-use" class="btn btn-primary" style="flex:1.5;background:var(--accent,#7b8bef);color:white;border:none;font-size:12px;padding:8px 12px;cursor:pointer;border-radius:6px;">🚀 使用识别文案 (推荐)</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => document.body.removeChild(modal);

        modal.querySelector('#reels-mismatch-btn-force').addEventListener('click', () => { cleanup(); resolve('FORCE'); });
        modal.querySelector('#reels-mismatch-btn-skip').addEventListener('click', () => { cleanup(); resolve('SKIP'); });
        modal.querySelector('#reels-mismatch-btn-use').addEventListener('click', () => { cleanup(); resolve('USE_RECOGNIZED'); });
    });
}

function reelsShowAlignSummaryModal(results) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;';

        const content = document.createElement('div');
        content.style.cssText = 'background:var(--bg-secondary,#1e1e2e);width:650px;max-width:90%;border-radius:12px;padding:24px;border:1px solid rgba(255,255,255,0.1);box-shadow:0 10px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:16px;font-family:system-ui,-apple-system,sans-serif;color:var(--text-primary,#eee);';

        const total = results.length;
        const okCount = results.filter(r => r.status !== 'SKIPPED' && r.status !== 'FAILED').length;
        const failCount = total - okCount;

        const escapeHtml = (str) => {
            return String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
        };

        let rowsHtml = '';
        results.forEach((r, idx) => {
            let statusBadge = '';
            if (r.status === 'SUCCESS') statusBadge = '<span style="background:rgba(74,222,128,0.15);color:#4ade80;padding:2px 6px;border-radius:4px;font-size:11px;">✅ 对齐成功</span>';
            else if (r.status === 'FORCE') statusBadge = '<span style="background:rgba(251,191,36,0.15);color:#fbbf24;padding:2px 6px;border-radius:4px;font-size:11px;">⚠️ 强行对齐</span>';
            else if (r.status === 'CORRECTED') statusBadge = '<span style="background:rgba(96,165,250,0.15);color:#60a5fa;padding:2px 6px;border-radius:4px;font-size:11px;">🎙️ 自动修正</span>';
            else if (r.status === 'SKIPPED') statusBadge = '<span style="background:rgba(156,163,175,0.15);color:#9ca3af;padding:2px 6px;border-radius:4px;font-size:11px;">⏭️ 已跳过</span>';
            else statusBadge = `<span style="background:rgba(239,68,68,0.15);color:#ef4444;padding:2px 6px;border-radius:4px;font-size:11px;" title="${escapeHtml(r.err || '')}">❌ 失败</span>`;

            rowsHtml += `
                <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:10px 8px;font-size:13px;color:var(--text-secondary,#bbb);">${idx + 1}</td>
                    <td style="padding:10px 8px;font-size:13px;font-weight:bold;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</td>
                    <td style="padding:10px 8px;font-size:13px;">${statusBadge}</td>
                    <td style="padding:10px 8px;font-size:12px;color:var(--text-secondary,#bbb);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(r.text || '')}">${escapeHtml(r.text || '')}</td>
                </tr>
            `;
        });

        content.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:24px;">📊</span>
                <h3 style="margin:0;color:var(--text-primary,#eee);font-size:18px;">批量对齐字幕报告</h3>
            </div>
            <div style="display:flex;gap:16px;background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,0.05);justify-content:space-around;text-align:center;">
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);">总任务数</div>
                    <div style="font-size:20px;font-weight:bold;color:var(--text-primary,#eee);">${total}</div>
                </div>
                <div style="border-left:1px solid rgba(255,255,255,0.1);height:30px;align-self:center;"></div>
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);color:#4ade80;">对齐成功</div>
                    <div style="font-size:20px;font-weight:bold;color:#4ade80;">${okCount}</div>
                </div>
                <div style="border-left:1px solid rgba(255,255,255,0.1);height:30px;align-self:center;"></div>
                <div>
                    <div style="font-size:12px;color:var(--text-secondary,#bbb);color:#ef4444;">失败/跳过</div>
                    <div style="font-size:20px;font-weight:bold;color:#ef4444;">${failCount}</div>
                </div>
            </div>
            <div style="max-height:250px;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:8px;">
                <table style="width:100%;border-collapse:collapse;text-align:left;">
                    <thead>
                        <tr style="background:rgba(255,255,255,0.02);border-bottom:1px solid rgba(255,255,255,0.08);">
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:30px;">#</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:180px;">任务名称</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);width:100px;">对齐状态</th>
                            <th style="padding:8px;font-size:12px;font-weight:bold;color:var(--text-secondary,#bbb);">对齐文案内容</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:8px;">
                <button id="reels-summary-close-btn" class="btn btn-primary" style="background:var(--accent,#7b8bef);color:white;border:none;font-size:13px;padding:8px 24px;cursor:pointer;border-radius:6px;">我知道了</button>
            </div>
        `;

        modal.appendChild(content);
        document.body.appendChild(modal);

        const cleanup = () => {
            document.body.removeChild(modal);
            resolve();
        };

        modal.querySelector('#reels-summary-close-btn').addEventListener('click', cleanup);
    });
}

async function _reelsAlignSubtitles(task, ignoreMismatch = false) {
    const txtContent = task.txtContent || task.manualText || '';
    if (!txtContent.trim()) throw new Error('没有字幕文本');

    // 确定音频源路径
    const workMode = _getWorkMode();
    let audioPath;
    if (workMode === 'voiced_bg') {
        audioPath = task.bgPath || task.videoPath;
    } else {
        audioPath = task.audioPath;
    }
    if (!audioPath) throw new Error('没有音频文件可用于对齐');

    // 调用现有的 subtitle/generate API
    const language = document.getElementById('reels-align-lang')?.value || '英语';
    // 输出目录 = 音频/视频文件所在目录（SRT 保存到文件旁边）
    const audioDir = audioPath.replace(/[\\/][^\\/]+$/, '');
    const response = await apiFetch(`${API_BASE}/subtitle/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            audio_path: audioPath,
            source_text: txtContent,
            language: language,
            audio_cut_length: 5.0,
            output_dir: audioDir,
            ignore_mismatch: ignoreMismatch
        }),
    });

    if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || '字幕对齐失败');
    }

    const data = await response.json();

    // 生成的 SRT 文件路径
    if (data.files && data.files.length > 0) {
        // 找到 source.srt 文件
        const srtFile = data.files.find(f => f.endsWith('_source.srt')) || data.files[0];
        task.srtPath = srtFile;

        // 读取 SRT 文件并解析为 segments
        if (window.electronAPI && window.electronAPI.readFileText) {
            const srtContent = await window.electronAPI.readFileText(srtFile);
            const rawSegs = parseSRT(srtContent).map(seg => ({ ...seg, _timeUnit: 'sec' }));
            task.segments = window.ReelsSubtitleProcessor
                ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
                : rawSegs;
        }
    }

    task.aligned = true;
    return task;
}

// 对齐所有未对齐的 TXT 任务
async function reelsAlignAllTasks() {
    const workMode = _getWorkMode();
    if (workMode === 'srt') return; // SRT 模式不需要对齐

    const tasksToAlign = _reelsState.tasks.filter(t =>
        t.txtContent && !t.aligned && (t.segments || []).length === 0
    );
    if (tasksToAlign.length === 0) {
        alert('没有需要对齐的任务');
        return;
    }

    const statusEl = document.getElementById('reels-export-status');
    let ok = 0, fail = 0;
    const alignResults = [];

    for (let i = 0; i < tasksToAlign.length; i++) {
        const task = tasksToAlign[i];
        if (statusEl) statusEl.textContent = `对齐中 ${i + 1}/${tasksToAlign.length}: ${task.fileName}`;

        let retryAlign = true;
        let ignoreMismatch = false;
        let finalStatus = 'FAILED';
        let errMsg = '';

        while (retryAlign) {
            retryAlign = false;
            try {
                await _reelsAlignSubtitles(task, ignoreMismatch);
                ok++;
                finalStatus = ignoreMismatch ? 'FORCE' : 'SUCCESS';
            } catch (err) {
                const message = err.message;
                if (message.includes('"code":"TEXT_MISMATCH"')) {
                    try {
                        const mismatchData = JSON.parse(message);
                        const choice = await reelsShowMismatchDialog(task.fileName, mismatchData, task.txtContent || task.manualText || '');
                        if (choice === 'USE_RECOGNIZED') {
                            task.txtContent = mismatchData.recognized_text;
                            retryAlign = true;
                            finalStatus = 'CORRECTED';
                            continue;
                        } else if (choice === 'FORCE') {
                            ignoreMismatch = true;
                            retryAlign = true;
                            continue;
                        } else {
                            // SKIP
                            fail++;
                            finalStatus = 'SKIPPED';
                        }
                    } catch (e) {
                        console.error('[Reels] Failed to parse mismatch err:', e);
                        fail++;
                        finalStatus = 'FAILED';
                        errMsg = message;
                    }
                } else {
                    console.error('[Reels] Align failed:', task.fileName, err);
                    fail++;
                    finalStatus = 'FAILED';
                    errMsg = message;
                }
            }
        }

        alignResults.push({
            fileName: task.fileName,
            status: finalStatus,
            text: task.txtContent || task.manualText || '',
            err: errMsg
        });
    }

    _renderTaskList();
    if (statusEl) {
        statusEl.textContent = fail > 0
            ? `⚠️ 对齐完成 ${ok}/${tasksToAlign.length}，失败 ${fail}`
            : `✅ 对齐完成 (${ok}个任务)`;
    }
    
    // Show summary modal
    await reelsShowAlignSummaryModal(alignResults);
}

// ═══════════════════════════════════════════════════════
// Work mode switching
// ═══════════════════════════════════════════════════════

function reelsOnWorkModeChange() {
    const mode = _getWorkMode();
    // 隐藏对应的菜单项 wrap，或直接元素
    const audioBtn = document.getElementById('reels-audio-input')?.nextElementSibling;
    const srtBtn = document.getElementById('reels-srt-input')?.nextElementSibling;
    const txtWrap = document.getElementById('reels-txt-btn-wrap');
    const manualWrap = document.getElementById('reels-manual-btn-wrap');
    const alignWrap = document.getElementById('reels-align-btn-wrap');
    const alignLang = document.getElementById('reels-align-lang');
    
    // 背景的文字
    const bgInput = document.getElementById('reels-video-input');
    const bgLabel = bgInput ? bgInput.nextElementSibling : null;

    if (mode === 'srt') {
        // 人声Reels: 背景 + 配音 + SRT
        if (audioBtn) audioBtn.style.display = '';
        if (srtBtn) srtBtn.style.display = '';
        if (txtWrap) txtWrap.style.display = 'none';
        if (manualWrap) manualWrap.style.display = 'none';
        if (alignWrap) alignWrap.style.display = 'none';
        if (alignLang) alignLang.style.display = 'none';
        if (bgLabel) bgLabel.innerHTML = '📁 导入背景素材';
    } else if (mode === 'dubbed_text') {
        // 配音+文本: 背景 + 配音 + TXT
        if (audioBtn) audioBtn.style.display = '';
        if (srtBtn) srtBtn.style.display = 'none';
        if (txtWrap) txtWrap.style.display = '';
        if (manualWrap) manualWrap.style.display = '';
        if (alignWrap) alignWrap.style.display = '';
        if (alignLang) alignLang.style.display = '';
        if (bgLabel) bgLabel.innerHTML = '📁 导入背景素材';
    } else if (mode === 'voiced_bg') {
        // 带声视频: 带声视频 + TXT
        if (audioBtn) audioBtn.style.display = 'none';
        if (srtBtn) srtBtn.style.display = 'none';
        if (txtWrap) txtWrap.style.display = '';
        if (manualWrap) manualWrap.style.display = '';
        if (alignWrap) alignWrap.style.display = '';
        if (alignLang) alignLang.style.display = '';
        if (bgLabel) bgLabel.innerHTML = '📁 导入带声视频';
    }
}

function _queueMixedFiles(files) {
    const workMode = _getWorkMode();
    for (const file of files) {
        const ext = _fileExt(file.name || '');
        if (ext === 'srt' && workMode === 'srt') {
            _queueSrtFile(file);
        } else if (ext === 'txt' && workMode !== 'srt') {
            _queueTxtFile(file);
        } else if (ext === 'srt') {
            _queueSrtFile(file);
        } else if (REELS_AUDIO_EXTS.has(ext)) {
            _queueAudioFile(file);
        } else if (REELS_BACKGROUND_EXTS.has(ext)) {
            _queueBackgroundFile(file);
        }
    }
}

function _onVideoFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) _queueBackgroundFile(f);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _onAudioFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) _queueAudioFile(f);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _onSrtFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    for (const f of files) _queueSrtFile(f);
    e.target.value = '';
}

function _onFolderFilesSelected(e) {
    const files = Array.from(e.target.files || []);
    _queueMixedFiles(files);
    reelsAutoMatchFiles();
    e.target.value = '';
}

function _onTaskListDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.style.borderColor = '';
    e.currentTarget.style.backgroundColor = '';
    e.currentTarget.style.boxShadow = '';
    const files = Array.from(e.dataTransfer.files || []);
    _queueMixedFiles(files);
    reelsAutoMatchFiles();
}

function _getMatchMode() {
    const el = document.getElementById('reels-match-mode');
    return el ? el.value : 'free';
}

function _getWorkMode() {
    const el = document.getElementById('reels-work-mode');
    return el ? el.value : 'srt';
}

function _getBgAssignMode() {
    const el = document.getElementById('reels-bg-assign-mode');
    return el ? el.value : 'cycle';
}

function _applyFreeBackgroundAssignment() {
    const library = _reelsState.backgroundLibrary || [];
    if (library.length === 0) return;

    const assignMode = _getBgAssignMode();
    // free 模式下，TXT/手动文本任务也需要拿到背景，便于点击预览
    const targetTasks = _reelsState.tasks.filter(t =>
        t.audioPath || t.srtPath || t.txtContent || t.manualText
    );
    if (targetTasks.length === 0) return;

    if (assignMode === 'single') {
        const firstBg = library[0];
        for (const task of targetTasks) {
            task.bgPath = firstBg.path;
            task.bgSrcUrl = firstBg.srcUrl || null;
            task.videoPath = firstBg.path;
            task.srcUrl = firstBg.srcUrl || null;
        }
        return;
    }

    for (let i = 0; i < targetTasks.length; i++) {
        const bg = library[i % library.length];
        targetTasks[i].bgPath = bg.path;
        targetTasks[i].bgSrcUrl = bg.srcUrl || null;
        targetTasks[i].videoPath = bg.path;
        targetTasks[i].srcUrl = bg.srcUrl || null;
    }
}

function _ensurePreviewTaskForBackgroundOnlyInFreeMode() {
    if (_getMatchMode() !== 'free') return;
    if (_reelsState.tasks.length > 0) return;
    const firstBg = (_reelsState.backgroundLibrary || [])[0];
    if (!firstBg || !firstBg.path) return;

    const task = _getOrCreateTaskByBase(firstBg.baseName || firstBg.name, firstBg.name || 'background.mp4');
    task.baseName = firstBg.baseName || _normalizeBaseName(firstBg.name || firstBg.path);
    task.fileName = firstBg.name || String(firstBg.path).split(/[\\/]/).pop() || 'background.mp4';
    task.bgPath = firstBg.path;
    task.bgSrcUrl = firstBg.srcUrl || null;
    task.videoPath = firstBg.path;
    task.srcUrl = firstBg.srcUrl || null;
}

function _ensureBackgroundLibraryFromTasks() {
    for (const task of _reelsState.tasks) {
        const bgPath = task.bgPath || task.videoPath;
        if (!bgPath) continue;
        _upsertBackgroundLibrary({
            path: bgPath,
            name: String(bgPath).split(/[\\/]/).pop(),
            baseName: _normalizeBaseName(bgPath),
            srcUrl: task.bgSrcUrl || task.srcUrl || null,
        });
    }
}

function _getOrCreateFreeTaskForAudio(audio) {
    const base = _normalizeBaseName(audio.baseName || audio.name);
    const key = audio.matchKey || _buildAudioSubtitleMatchKey(base);
    let task = _reelsState.tasks.find(t => !t.audioPath && t.matchKey === key);
    if (!task) task = _getOrCreateTaskByBase(base, audio.name);
    task.matchKey = key;
    return task;
}

function _getOrCreateFreeTaskForSrt(srt) {
    const base = _normalizeBaseName(srt.baseName || srt.name);
    const key = srt.matchKey || _buildAudioSubtitleMatchKey(base);
    let task = _reelsState.tasks.find(t => !t.srtPath && t.matchKey === key);
    if (!task) task = _getOrCreateTaskByBase(base, srt.name);
    task.matchKey = key;
    return task;
}

function _pruneFreeBgOnlyTasks() {
    _reelsState.tasks = _reelsState.tasks.filter(t => {
        const hasBg = !!(t.bgPath || t.videoPath);
        const hasAudio = !!t.audioPath;
        const hasSrt = !!t.srtPath;
        const hasTxt = !!t.txtContent;
        if (hasBg && !hasAudio && !hasSrt && !hasTxt) return false;
        return true;
    });
}

function reelsAutoMatchFiles() {
    const backgrounds = _reelsState.pendingFiles.backgrounds.splice(0);
    const audios = _reelsState.pendingFiles.audios.splice(0);
    const srts = _reelsState.pendingFiles.srts.splice(0);
    const txts = _reelsState.pendingFiles.txts.splice(0);
    const matchMode = _getMatchMode();

    for (const bg of backgrounds) {
        _upsertBackgroundLibrary(bg);
        if (matchMode !== 'strict') continue;
        const task = _getOrCreateTaskByBase(bg.baseName, bg.name);
        task.baseName = bg.baseName;
        task.bgPath = bg.path;
        task.bgSrcUrl = bg.srcUrl || null;
        // 兼容旧导出逻辑字段
        task.videoPath = bg.path;
        task.srcUrl = bg.srcUrl || null;
        if (!task.fileName) task.fileName = bg.name;
    }

    for (const audio of audios) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForAudio(audio)
            : _getOrCreateTaskByBase(audio.baseName, audio.name);
        task.baseName = audio.baseName;
        task.audioPath = audio.path;
        if (matchMode === 'free') {
            task.fileName = audio.name;
        } else if (!task.fileName) {
            task.fileName = audio.name;
        }
    }

    for (const srt of srts) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForSrt(srt)
            : _getOrCreateTaskByBase(srt.baseName, srt.name);
        const rawSegs = parseSRT(srt.content || '').map(seg => ({
            ...seg,
            _timeUnit: 'sec',
        }));
        const segments = window.ReelsSubtitleProcessor
            ? ReelsSubtitleProcessor.srtToSegmentsWithWords(rawSegs)
            : rawSegs;
        task.baseName = srt.baseName;
        task.srtPath = srt.path;
        task.segments = segments;
        if (!task.fileName) task.fileName = srt.name.replace(/\.srt$/i, '.mp4');
    }

    // TXT 文件处理（模式 A/B）
    for (const txt of txts) {
        const task = matchMode === 'free'
            ? _getOrCreateFreeTaskForSrt(txt) // 复用 free 匹配逻辑
            : _getOrCreateTaskByBase(txt.baseName, txt.name);
        task.baseName = txt.baseName;
        task.txtPath = txt.path;
        task.txtContent = txt.content;
        task.aligned = false;
        // 暂不设置 segments，等待对齐后填入
        if (!task.fileName) task.fileName = txt.name.replace(/\.txt$/i, '.mp4');
    }

    if (matchMode === 'free') {
        _pruneFreeBgOnlyTasks();
        _ensureBackgroundLibraryFromTasks();
        _applyFreeBackgroundAssignment();
        _ensurePreviewTaskForBackgroundOnlyInFreeMode();
    }

    for (const task of _reelsState.tasks) {
        if (!task.baseName) task.baseName = _inferTaskBaseName(task);
        if (!task.fileName) {
            const src = task.audioPath || task.bgPath || task.videoPath || task.srtPath || task.txtPath || '';
            const name = src ? src.split(/[\\/]/).pop() : `${task.baseName || 'reel'}.mp4`;
            task.fileName = name;
        }
    }

    if (_reelsState.selectedIdx >= _reelsState.tasks.length) {
        _reelsState.selectedIdx = _reelsState.tasks.length - 1;
    }
    _renderTaskList();
    if (_reelsState.selectedIdx < 0 && _reelsState.tasks.length > 0) {
        reelsSelectTask(0);
    }
}

function reelsClearTasks() {
    _reelsState.tasks = [];
    _reelsState.selectedIdx = -1;
    _reelsState.pendingFiles = { backgrounds: [], audios: [], srts: [], txts: [] };
    _reelsState.backgroundLibrary = [];

    // Clear overlay manager and panel
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        _reelsState.overlayProxy.overlayMgr.overlays = [];
    }
    if (_reelsState.overlayPanel) {
        _reelsState.overlayPanel.deselectOverlay();
        _reelsState.overlayPanel._refreshList();
    }

    // Clear video/audio preview
    _reelsState._previewBgImage = null;
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const placeholder = document.getElementById('reels-preview-placeholder');
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.style.display = 'none';
    }
    if (audio) {
        audio.pause();
        audio.removeAttribute('src');
    }
    if (placeholder) {
        placeholder.style.display = 'flex';
        placeholder.textContent = '选择视频任务后可实时预览字幕效果';
    }
    _resetPreviewFadeVideo();

    _renderTaskList();
}

function _renderTaskList() {
    const container = document.getElementById('reels-task-list');
    const countEl = document.getElementById('reels-task-count');
    const countPanelEl = document.getElementById('reels-task-count-panel');
    if (!container) return;

    const tasks = _reelsState.tasks;
    const workMode = _getWorkMode();
    if (countEl) countEl.textContent = `${tasks.length} 个任务`;
    if (countPanelEl) countPanelEl.textContent = tasks.length > 0 ? `${tasks.length}` : '0';

    // 确保所有任务都有 _exportSelected 属性（默认选中）
    tasks.forEach(t => { if (t._exportSelected === undefined) t._exportSelected = true; });
    _updateExportSelectedCountUI();

    if (tasks.length === 0) {
        const hint = workMode === 'srt'
            ? '添加背景素材 + 配音 + SRT，支持拖拽和文件夹导入；同名自动配对。'
            : workMode === 'dubbed_text'
                ? '添加背景素材 + 配音 + TXT（或手动输入），然后点击「🔗 对齐」生成字幕时间轴。'
                : '添加带声视频 + TXT（或手动输入），然后点击「🔗 对齐」生成字幕时间轴。';
        container.innerHTML = `<p class="hint" style="font-size:11px;">${hint}</p>`;
        return;
    }

    container.innerHTML = tasks.map((task, i) => {
        const selected = i === _reelsState.selectedIdx;
        const hasBg = !!(task.bgPath || task.videoPath);
        const hasAudio = !!task.audioPath;
        const hasSrt = !!task.srtPath && (task.segments || []).length > 0;
        const hasTxt = !!task.txtContent;
        const exportChecked = task._exportSelected !== false;

        let statusParts;
        if (workMode === 'voiced_bg') {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
            ];
            if (hasSrt) {
                statusParts.push(`<span style="color:#4ecdc4;">SRT</span>`);
            } else if (hasTxt) {
                statusParts.push(`<span style="color:#ffa502;">TXT</span>`);
            } else {
                statusParts.push('<span style="color:#f87171;">TXT</span>');
            }
        } else if (workMode === 'dubbed_text') {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
                hasAudio ? '<span style="color:#4ecdc4;">VO</span>' : '<span style="color:#f87171;">VO</span>',
            ];
            if (hasSrt) {
                statusParts.push(`<span style="color:#4ecdc4;">SRT</span>`);
            } else if (hasTxt) {
                statusParts.push(`<span style="color:#ffa502;">TXT</span>`);
            } else {
                statusParts.push('<span style="color:#f87171;">TXT</span>');
            }
        } else {
            statusParts = [
                hasBg ? '<span style="color:#4ecdc4;">BG</span>' : '<span style="color:#f87171;">BG</span>',
                hasAudio ? '<span style="color:#4ecdc4;">VO</span>' : '<span style="color:#f87171;">VO</span>',
                hasSrt ? `<span style="color:#4ecdc4;">SRT</span>` : '<span style="color:#f87171;">SRT</span>',
            ];
        }
        const statusText = statusParts.join(' ');
        // Shorten filename for compact display
        const baseName = task.fileName.replace(/\.[^.]+$/, '');
        const shortName = baseName.length > 18 ? baseName.substring(0, 16) + '…' : baseName;

        // 覆层内容预览
        let ovPreview = '';
        if (task.overlays && task.overlays.length > 0) {
            const ov0 = task.overlays[0];
            let ovTitle = '', ovBody = '';
            if (ov0.type === 'scroll') {
                ovTitle = (ov0.scroll_title || '').trim();
                ovBody = (ov0.content || '').trim().replace(/\n/g, ' ');
            } else if (ov0.type === 'textcard') {
                ovTitle = (ov0.title_text || '').trim();
                ovBody = (ov0.body_text || '').trim().replace(/\n/g, ' ');
            }
            if (ovTitle || ovBody) {
                const icon = ov0.type === 'scroll' ? '🔄' : '📝';
                const tSnip = ovTitle.length > 12 ? ovTitle.substring(0, 10) + '…' : ovTitle;
                const bSnip = ovBody.length > 20 ? ovBody.substring(0, 18) + '…' : ovBody;
                const parts = [];
                if (tSnip) parts.push(`<b>${tSnip}</b>`);
                if (bSnip) parts.push(bSnip);
                ovPreview = `<div style="font-size:10px;color:#8899aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;" title="${ovTitle}\n${ovBody}">${icon} ${parts.join(' | ')}</div>`;
            }
        }

        const effectivePool = _getEffectiveBgClipPool(task);
        const isMultiClip = effectivePool.length > 0;
        const isCrossfadeVideo = (task.bgPath && !_isImageFile(task.bgPath)) && (document.getElementById('reels-loop-fade') || {}).checked !== false;
        const bgValid = task.bgPath || effectivePool[0];
        const canAlpha = bgValid && !isMultiClip && (!task.bgMode || task.bgMode === 'single') && !isCrossfadeVideo;
        const fastAlphaEnabled = (document.getElementById('reels-fast-alpha-mode') || {}).checked !== false;

        let alphaIcon = '';
        if (fastAlphaEnabled) {
            if (bgValid && !isMultiClip && (!task.bgMode || task.bgMode === 'single')) {
                if (!isCrossfadeVideo) {
                    alphaIcon = `<span title="此任务完美兼容极速贴合 (Fast Alpha) ⚡" style="font-size:10px; opacity:0.9;">⚡</span>`;
                } else {
                    alphaIcon = `<span title="已开启首尾渐变。系统将智能判定：若无需循环底图，将自动恢复极速模式 ⚡" style="font-size:10px; opacity:0.8;">🐢/⚡</span>`;
                }
            } else {
                alphaIcon = `<span title="由于多片段拼接或复杂底板转场，强制回退常规渲染 🐢" style="font-size:10px; filter:grayscale(1); opacity:0.4;">🐢</span>`;
            }
        }

        // 未选中导出时降低整行不透明度
        const rowOpacity = exportChecked ? '1' : '0.45';

        return `
            <div class="reels-task-item ${selected ? 'reels-task-selected' : ''}"
                 onclick="reelsSelectTask(${i})"
                 title="${task.fileName}"
                 style="display:flex; align-items:center; gap:4px; padding:5px 6px; margin-bottom:2px;
                        border-radius:5px; cursor:pointer; transition:background .12s, opacity .15s;
                        background: ${selected ? 'rgba(0,212,255,0.15)' : 'transparent'};
                        border-left: 3px solid ${selected ? '#4c9eff' : 'transparent'};
                        opacity: ${rowOpacity};
                        ${selected ? 'box-shadow: inset 0 0 0 1px rgba(0,212,255,0.3);' : ''}">
                <input type="checkbox" class="reels-export-cb" data-task-idx="${i}" ${exportChecked ? 'checked' : ''}
                    style="accent-color:var(--accent-color,#7b8bef);transform:scale(1.25);margin:0 6px 0 4px;flex-shrink:0;cursor:pointer;"
                    onclick="event.stopPropagation(); reelsToggleExportSelect(${i}, this.checked)"
                    title="勾选以包含在批量导出中">
                <span style="font-size:12px; font-weight:${selected ? '600' : '400'}; color:${selected ? '#fff' : 'var(--text-primary)'}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:60px; max-width:120px;">${shortName}</span>
                ${alphaIcon}
                ${ovPreview}
                <span style="font-size:10px; white-space:nowrap; opacity:0.8; margin-left:auto;">${statusText}</span>
                <button class="btn" style="padding:1px 4px; font-size:10px; opacity:0.5; border:none; background:transparent; color:var(--text-secondary);" onclick="event.stopPropagation(); reelsRemoveTask(${i})" title="删除">✕</button>
            </div>
        `;
    }).join('');

    // Auto-scroll selected task into view
    const selectedEl = container.querySelector('.reels-task-selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════
// Cover Edit Mode Toggle
// ═══════════════════════════════════════════════════════
function reelsToggleCoverEditMode(enable) {
    _reelsState._coverEditMode = enable;
    
    let coverBanner = document.getElementById('rbt-cover-edit-banner');
    if (!coverBanner) {
        coverBanner = document.createElement('div');
        coverBanner.id = 'rbt-cover-edit-banner';
        coverBanner.style.cssText = 'position:absolute;top:0;left:0;right:0;background:rgba(255,215,0,0.9);color:#000;font-size:12px;font-weight:bold;text-align:center;padding:6px;z-index:99;cursor:pointer;display:none;';
        coverBanner.innerHTML = '✨ 当前处于【封面卡片专属编辑模式】 点击退出';
        coverBanner.onclick = () => reelsToggleCoverEditMode(false);
        const playerArea = document.querySelector('.player-wrapper') || document.querySelector('.preview-player-wrapper') || document.getElementById('reels-preview-canvas').parentElement;
        if (playerArea) {
            playerArea.style.position = 'relative'; 
            playerArea.appendChild(coverBanner);
        }
    }
    if (coverBanner) coverBanner.style.display = enable ? 'block' : 'none';
    
    if (_reelsState.selectedIdx >= 0) {
        reelsSelectTask(_reelsState.selectedIdx);
    }
}

async function _preFetchTaskMediaDurations(task) {
    if (!task) return;
    if (!_reelsState._mediaDurations) _reelsState._mediaDurations = {};
    const paths = [];
    if (task.audioPath && !_reelsState._mediaDurations[task.audioPath]) {
        paths.push(task.audioPath);
    }
    const previewBg = _resolvePreviewBackgroundPath(task);
    if (previewBg.path && !previewBg.isMulti && !_isImagePath(previewBg.path) && !_reelsState._mediaDurations[previewBg.path]) {
        paths.push(previewBg.path);
    }
    if (task.contentVideoPath && !_reelsState._mediaDurations[task.contentVideoPath]) {
        const isSeq = _reelsState.cvSequence && _reelsState.cvSequence.path === task.contentVideoPath;
        if (!isSeq) {
            paths.push(task.contentVideoPath);
        }
    }
    if (paths.length === 0) return;
    if (window.electronAPI && typeof window.electronAPI.getMediaDuration === 'function') {
        for (const p of paths) {
            try {
                const dur = await window.electronAPI.getMediaDuration(p);
                if (dur > 0) {
                    _reelsState._mediaDurations[p] = dur;
                    console.log(`[Preview] Pre-fetched duration for ${p}: ${dur}s`);
                }
            } catch (e) {
                console.error('[Preview] Pre-fetch duration failed for', p, e);
            }
        }
        _updateTimelineForTask(task);
        _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    }
}

function reelsSelectTask(idx) {
    // ── 保存当前任务的覆层 ──
    const prevTask = _reelsState.tasks[_reelsState.selectedIdx];
    if (prevTask && _reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        if (_reelsState._coverEditMode && prevTask.cover) {
            prevTask.cover.overlays = [...(_reelsState.overlayProxy.overlayMgr.overlays || [])];
        } else {
            prevTask.overlays = [...(_reelsState.overlayProxy.overlayMgr.overlays || [])];
        }
    }

    _reelsState.selectedIdx = idx;
    _renderTaskList();
    const task = _reelsState.tasks[idx];
    if (!task) return;
    _preFetchMultiBgDurations(task);
    _preFetchTaskMediaDurations(task);
    const taskStyle = _resolveSubtitleStyleForTask(task);
    if (taskStyle) _writeStyleToUI(taskStyle);
    if (window.reelsSyncBackgroundTabUI) window.reelsSyncBackgroundTabUI(task);
    _reelsState.previewMultiBg = { taskId: task.id || task.fileName || String(idx), clipIndex: -1, path: '', image: null };
    
    // Sync subtitle preset UI with the selected task. Do not fall back to the
    // default preset here: after manual edits, an empty task preset means the
    // task is using the current custom/global style, not the saved default.
    const presetName = task._subtitlePreset || '';
    const hiddenInput = document.getElementById('reels-preset-select');
    if (hiddenInput) hiddenInput.value = presetName;
    const selectTrigger = document.getElementById('reels-preset-select-trigger');
    if (selectTrigger) {
        const span = selectTrigger.querySelector('span');
        if (span) span.textContent = presetName || '-- 改全部样式 --';
    }

    // ── 加载新任务的覆层 ──
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        const mgr = _reelsState.overlayProxy.overlayMgr;
        if (_reelsState._coverEditMode && task.cover) {
            mgr.overlays = task.cover.overlays ? [...task.cover.overlays] : [];
        } else {
            mgr.overlays = task.overlays ? [...task.overlays] : [];
        }
        // 刷新覆层面板
        if (_reelsState.overlayPanel) {
            _reelsState.overlayPanel.deselectOverlay();
            _reelsState.overlayPanel._refreshList();
        }
    }

    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const playBtn = document.getElementById('reels-preview-play');
    const placeholder = document.getElementById('reels-preview-placeholder');
    const previewBg = _resolvePreviewBackgroundPath(task);
    const bgPath = previewBg.path;
    // Safety: if bgSrcUrl/srcUrl is a file:// URL that doesn't correspond to the
    // current bgPath, it's stale (left over from a previous file assignment). Clear it
    // so _toPlayablePath generates a fresh URL from the new bgPath.
    let bgSrc = task.bgSrcUrl || task.srcUrl;
    if (bgSrc && bgPath && !bgSrc.startsWith('blob:')) {
        // Decode file:// URL and compare with bgPath
        const decoded = _normalizeLocalMediaPath(bgSrc);
        if (decoded && decoded !== bgPath && decoded !== _normalizeLocalMediaPath(bgPath)) {
            console.log('[Preview] Stale bgSrcUrl detected, clearing. old:', decoded, 'new bgPath:', bgPath);
            task.bgSrcUrl = null;
            task.srcUrl = null;
            bgSrc = null;
        }
    }
    const workMode = _getWorkMode();
    // In voiced_bg mode, the background video IS the audio source
    const voicePath = task.audioPath || (workMode === 'voiced_bg' ? bgPath : '') || '';

    if (audio) {
        audio.pause();
        if (voicePath) {
            const audioUrl = _toPlayablePath(voicePath, null);
            if (audioUrl) {
                if (audio.src !== audioUrl) audio.src = audioUrl;
            } else {
                audio.removeAttribute('src');
            }
        } else {
            audio.removeAttribute('src');
        }
        // 应用音频变速预览：audioDurScale=150% → playbackRate=0.667（减速）
        const aDurScale = task.audioDurScale || 100;
        audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
        audio.preservesPitch = true; // 变速不变调
    }

    // ── 加载 BGM ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio) {
        bgmAudio.pause();
        const finalBgmPath = _getEffectiveBgmPath(task, _reelsState.selectedIdx);
        if (finalBgmPath) {
            const bgmUrl = _toPlayablePath(finalBgmPath, null);
            if (bgmUrl) {
                if (bgmAudio.src !== bgmUrl) bgmAudio.src = bgmUrl;
            } else {
                bgmAudio.removeAttribute('src');
            }
        } else {
            bgmAudio.removeAttribute('src');
        }
    }
    _applyPreviewAudioMix();

    if (video && bgPath && !_reelsFileExists(bgPath)) {
        _reelsState._previewBgImage = null;
        video.pause();
        video.removeAttribute('src');
        _resetPreviewFadeVideo();
        video.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = 'flex';
            placeholder.textContent = `背景素材文件不存在：${bgPath.split(/[\\/]/).pop() || bgPath}`;
        }
    } else if (video && bgPath) {
        if (_isImagePath(bgPath)) {
            video.pause();
            video.removeAttribute('src');
            _resetPreviewFadeVideo();
            video.style.display = 'none';
            // Load image background for canvas rendering
            const imgUrl = _toPlayablePath(bgPath, bgSrc);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => { _reelsState._previewBgImage = img; };
            img.src = imgUrl;
            _reelsState._previewBgImage = img;
            if (placeholder) {
                placeholder.style.display = 'none';
            }
            if (previewBg.isMulti) {
                console.log('[Preview] 多素材模式预览使用素材池代表帧:', bgPath);
            }
        } else {
            _reelsState._previewBgImage = null; // Clear image bg
            const filePath = _toPlayablePath(bgPath, bgSrc);
            // 总是重新设置 src（避免 URL 规范化导致比较失误）
            video.pause();
            video.src = filePath;
            video.load();
            // 强制加载第一帧 — seek 到 0.01s 触发帧数据加载
            video.addEventListener('loadeddata', function _onLoaded() {
                video.removeEventListener('loadeddata', _onLoaded);
                console.log('[Preview] Video loadeddata, readyState:', video.readyState);
            }, { once: true });
            try { video.currentTime = 0.01; } catch (e) { }
            const fadeVideo = _ensurePreviewFadeVideo(video);
            if (fadeVideo) {
                fadeVideo.pause();
                try { fadeVideo.currentTime = 0; } catch (e) { }
            }
            _ensurePreviewVideoDecodable(video);
            if (placeholder) {
                placeholder.style.display = 'none';
                placeholder.textContent = '选择视频任务后可实时预览字幕效果';
            }
            if (previewBg.isMulti) {
                console.log('[Preview] 多素材模式预览使用素材池代表视频:', bgPath);
            }
        }
    } else if (video) {
        _reelsState._previewBgImage = null; // Clear image bg
        video.pause();
        video.removeAttribute('src');
        _resetPreviewFadeVideo();
        video.style.display = 'none';
        if (placeholder) {
            placeholder.style.display = (task.contentVideoDirectBg || task.contentVideoBlurBg) && task.contentVideoPath ? 'none' : 'flex';
            placeholder.textContent = '当前任务没有背景素材，预览将显示纯色底。';
        }
    }

    // ── 加载 Hook 视频 ──
    // 与导出一致：task.hookFile 优先，回退到全局前置路径
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const globalIntroPath = (document.getElementById('reels-intro-path') || {}).value || '';
    // Hook 文件解析链：task.hookFile → task.hook.path → 全局前置路径（可显式禁用）
    let effectiveHookFile = _resolveTaskHookPath(task, globalIntroPath);
    // 验证文件存在（防止残留路径导致假 hook 阶段）
    if (effectiveHookFile && window.require) {
        try {
            const fs = window.require('fs');
            if (!fs.existsSync(effectiveHookFile)) {
                console.warn(`[Preview] Hook file not found, clearing: ${effectiveHookFile}`);
                effectiveHookFile = '';
            }
        } catch (e) { /* ignore */ }
    }
    if (hookVideo) {
        hookVideo.pause();
        _reelsState.hookVideoReady = false;
        _reelsState.hookDuration = 0;
        _reelsState.hookPhase = false;

        if (effectiveHookFile) {
            const hookUrl = _toPlayablePath(effectiveHookFile, null);
            hookVideo.src = hookUrl;
            hookVideo.playbackRate = task.hookSpeed || 1.0;
            _ensurePreviewVideoDecodable(hookVideo);
            hookVideo.load();
            hookVideo.onloadedmetadata = () => {
                let dur = hookVideo.duration || 0;
                // Apply trim（与导出 concatVideo 一致）
                const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
                const trimEnd = (task.hookTrimEnd != null && task.hookTrimEnd > 0) ? task.hookTrimEnd : dur;
                dur = Math.max(0, trimEnd - trimStart);
                // Apply speed（与导出 concatVideo 一致）
                const speed = task.hookSpeed || 1.0;
                dur = dur / speed;
                _reelsState.hookDuration = dur;
                _reelsState.hookVideoReady = true;
                hookVideo.currentTime = trimStart || 0.01;
                console.log(`[Preview] Hook video loaded, duration: ${dur.toFixed(2)}s (raw: ${hookVideo.duration}s, trim: ${trimStart}-${trimEnd}, speed: ${speed}x)`);
                _updatePreviewTimeUI(0, _getPreviewDuration());
            };
            // 强制在 trimEnd 处停止（防止播放超出裁剪范围，与导出 FFmpeg 裁剪一致）
            hookVideo.ontimeupdate = () => {
                const trimEnd = (task.hookTrimEnd != null && task.hookTrimEnd > 0) ? task.hookTrimEnd : Infinity;
                if (hookVideo.currentTime >= trimEnd) {
                    hookVideo.pause();
                }
            };
        } else {
            hookVideo.removeAttribute('src');
            hookVideo.ontimeupdate = null;
        }
    }

    const cvVideo = document.getElementById('reels-preview-contentvideo');
    _reelsState.previewContentImage = null; // reset
    if (cvVideo) {
        if (task.contentVideoPath) {
            const cvRawPath = _normalizeLocalMediaPath(task.contentVideoPath);
            let isDir = false;
            if (window.require) {
                const fs = window.require('fs');
                if (fs.existsSync(cvRawPath) && fs.statSync(cvRawPath).isDirectory()) {
                    isDir = true;
                    if (_reelsState.cvSequence.path !== cvRawPath) {
                        _reelsState.cvSequence.path = cvRawPath;
                        _reelsState.cvSequence.files = fs.readdirSync(cvRawPath)
                            .filter(f => !f.startsWith('.') && /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
                        _reelsState.cvSequence.loadedImages = {};

                        const path = window.require('path');
                        for (const f of _reelsState.cvSequence.files) {
                            const img = new Image();
                            img.src = _toPlayablePath(path.join(cvRawPath, f), null);
                            _reelsState.cvSequence.loadedImages[f] = img;
                        }
                    }
                    cvVideo.pause();
                    cvVideo.removeAttribute('src');
                }
            }

            if (!isDir) {
                if (_isImagePath(cvRawPath)) {
                    const img = new Image();
                    img.onload = () => { _reelsState.previewContentImage = img; };
                    img.src = _toPlayablePath(cvRawPath, null);
                    cvVideo.pause();
                    cvVideo.removeAttribute('src');
                } else {
                    const cvPath = _toPlayablePath(cvRawPath || task.contentVideoPath, null);
                    if (cvVideo.src !== cvPath) {
                        cvVideo.pause();
                        cvVideo.src = cvPath;
                        _ensurePreviewVideoDecodable(cvVideo);
                        cvVideo.load();
                    }
                    _ensurePreviewVideoDecodable(cvVideo);
                    const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
                    try {
                        if (Math.abs((cvVideo.currentTime || 0) - trimStart) > 0.2) {
                            cvVideo.currentTime = trimStart;
                        }
                    } catch (e) { }
                }
            }
        } else {
            cvVideo.pause();
            cvVideo.removeAttribute('src');
            try { cvVideo.load(); } catch (e) { }
        }
        // 设置覆层视频音量（预览+导出）
        const cvVol = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
        if (_reelsState._audioCtx && _reelsState._gainNodes?.has(cvVideo)) {
            cvVideo.volume = cvVol > 0 ? 1.0 : 0;
            cvVideo.muted = cvVol <= 0.001;
        } else {
            cvVideo.volume = Math.min(1.0, cvVol / 100);
            cvVideo.muted = cvVol <= 0.001;
        }
    }

    // ── 加载 Cover 素材 ──
    _reelsState._previewCoverImage = null;
    if (_reelsState._previewCoverVideo && _reelsState._previewCoverVideo.parentNode) {
        try { _reelsState._previewCoverVideo.parentNode.removeChild(_reelsState._previewCoverVideo); } catch (e) { }
    }
    _reelsState._previewCoverVideo = null;
    if (task.cover && task.cover.bgPath) {
        const cPath = task.cover.bgPath;
        const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(cPath);
        if (isVideo) {
            const vid = document.createElement('video');
            vid.crossOrigin = 'anonymous';
            vid.muted = true;
            vid.src = _toPlayablePath(cPath, null);
            _ensurePreviewVideoDecodable(vid);
            vid.load();
            vid.onloadeddata = () => { vid.currentTime = 0.05; };
            _reelsState._previewCoverVideo = vid; // Store dynamically created cover video
        } else {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = _toPlayablePath(cPath, null);
            _reelsState._previewCoverImage = img;
        }
    }

    const previewText = document.getElementById('reels-preview-text');
    if (previewText && task.segments.length > 0) {
        previewText.value = task.segments[0].text;
    }

    _updateTimelineForTask(task);
    _applyPreviewLoopMode();
    _reelsState.mockPlaying = false;
    _reelsState.mockPausedTime = 0;
    _updatePreviewTimeUI(0, _getPreviewDuration());
    if (playBtn) playBtn.textContent = '▶️';
}

function reelsRemoveTask(idx) {
    if (idx < 0 || idx >= _reelsState.tasks.length) return;
    const prevSelectedIdx = _reelsState.selectedIdx;
    _reelsState.tasks.splice(idx, 1);

    if (_reelsState.tasks.length === 0) {
        _reelsState.selectedIdx = -1;
        _renderTaskList();

        _reelsState._previewBgImage = null;
        const video = document.getElementById('reels-preview-video');
        const audio = document.getElementById('reels-preview-audio');
        const playBtn = document.getElementById('reels-preview-play');
        const placeholder = document.getElementById('reels-preview-placeholder');
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.style.display = 'none';
        }
        if (audio) {
            audio.pause();
            audio.removeAttribute('src');
        }
        _resetPreviewFadeVideo();
        if (placeholder) {
            placeholder.style.display = 'flex';
            placeholder.textContent = '选择任务以预览';
        }
        if (playBtn) playBtn.textContent = '▶️';
        _updatePreviewTimeUI(0, 0);
        return;
    }

    // 维护删除后的选中索引
    let nextSelectedIdx = prevSelectedIdx;
    if (prevSelectedIdx === idx) {
        nextSelectedIdx = Math.min(idx, _reelsState.tasks.length - 1);
    } else if (prevSelectedIdx > idx) {
        nextSelectedIdx = prevSelectedIdx - 1;
    }
    _reelsState.selectedIdx = Math.max(0, Math.min(nextSelectedIdx, _reelsState.tasks.length - 1));

    // 统一走选择逻辑，确保预览背景/音频/时间线同步
    reelsSelectTask(_reelsState.selectedIdx);
}

// ═══════════════════════════════════════════════════════
// Video preview controls
function reelsTogglePlay() {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const fadeVideo = _reelsState.previewFadeVideo;
    const btn = document.getElementById('reels-preview-play');
    const task = _getSelectedTask();
    _applyPreviewAudioMix();
    _applyPreviewLoopMode();

    const hasAudio = !!(task && task.audioPath && audio && audio.src);
    const previewBg = _resolvePreviewBackgroundPath(task);
    const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src && !(task.contentVideoDirectBg && task.contentVideoPath));
    // 与导出一致：task.hookFile 优先，全局前置回退
    const hasHook = !!(hookVideo && hookVideo.src && _reelsState.hookDuration > 0);
    const master = _getPreviewMasterElement();
    const hasMedia = !!master;
    const hookPlaying = hookVideo && !hookVideo.paused;

    // ── BGM 音频元素 ──
    const bgmAudio = _reelsState._bgmAudioEl;
    const isPlaying = _isPreviewActuallyPlaying(master, hookVideo, bgmAudio);

    if (isPlaying) {
        const savedTime = _getPreviewPlaybackTimeForPause();
        if (master) {
            if (audio) audio.pause();
            if (video) video.pause();
            if (fadeVideo) fadeVideo.pause();
        }
        // 覆层视频也要暂停
        const cvEl = document.getElementById('reels-preview-contentvideo');
        if (cvEl && !cvEl.paused) cvEl.pause();
        _reelsState.mockPlaying = false;
        _reelsState.mockPausedTime = savedTime;
        if (hookVideo) hookVideo.pause();
        if (bgmAudio) bgmAudio.pause();
        if (btn) btn.textContent = '▶️';
        return;
    }

    // 回到开头：如果当前时间已经到了或超过了总时长
    const curT = _getPreviewCurrentTime();
    const durT = _getPreviewDuration();

    if (durT > 0 && curT >= durT - 0.05) {
        if (hasAudio) audio.currentTime = 0;
        if (hasVideo) video.currentTime = 0;
        if (hasHook) {
            const trimStart = (task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
            hookVideo.currentTime = trimStart || 0.01;
        }
        _reelsState.mockPausedTime = 0;
    }

    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    
    const inCoverPhase = coverDur > 0 && curT < coverDur;
    const inHookPhase = hookDur > 0 && curT >= coverDur && curT < (coverDur + hookDur);

    if (inCoverPhase) {
        if (hasHook && hookVideo) hookVideo.pause();
        _reelsState.mockPlaying = true;
        _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || curT);
    } else if (hasHook && inHookPhase) {
        // ── Hook 阶段：先播放 Hook 视频 ──
        hookVideo.playbackRate = task.hookSpeed || 1.0;
        hookVideo.play().catch(() => { });

        // 同时启用 mock 时钟来驱动总时间
        _reelsState.mockPlaying = true;
        _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || curT);

        // 主音视频暂不播放（Hook 结束后由 _syncHookPhaseTransition 启动）
        if (!hasMedia) {
            // 就用 mock 时钟
        }
    } else {
        // ── 正片阶段：正常播放 ──
        if (hasHook && hookVideo) hookVideo.pause();

        if (!hasMedia) {
            _reelsState.mockPlaying = true;
            _reelsState.mockStartTime = (performance.now() / 1000) - (_reelsState.mockPausedTime || 0);
        } else {
            if (hasAudio && audio && task && task.audioPath) {
                // 应用音频变速：audioDurScale=150% → playbackRate=0.667
                const aDurScale = task.audioDurScale || 100;
                audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
                audio.preservesPitch = true;
                audio.play().catch(() => { });
            }
            if (hasVideo && video) {
                // 应用视频变速：bgDurScale=150% → playbackRate=0.667
                const bDurScale = (task && task.bgDurScale) || 100;
                video.playbackRate = (bDurScale !== 100) ? (100 / bDurScale) : 1.0;
                
                const vDur = _getVideoDuration(task);
                if (hasAudio && task && task.audioPath && vDur > 0) {
                    try { video.currentTime = (audio.currentTime || 0) % vDur; } catch (e) { }
                }
                video.play().catch(() => { });
                if (fadeVideo && hasAudio && task && task.audioPath) {
                    fadeVideo.playbackRate = video.playbackRate;
                    fadeVideo.play().catch(() => { });
                }
            }
            // 覆层视频作为 master 时也要启动播放
            const cvEl = document.getElementById('reels-preview-contentvideo');
            if (cvEl && cvEl.src && cvEl.paused) {
                cvEl.play().catch(() => { });
            }
        }
    }

    // ── 同步播放 BGM (仅正片阶段) ──
    if (!inHookPhase && bgmAudio && bgmAudio.src && task && _getEffectiveBgmPath(task, _reelsState.selectedIdx)) {
        bgmAudio.currentTime = _getPreviewCurrentTime() || 0;
        bgmAudio.play().catch(() => { });
    }
    _clearPreviewSeekLock();
    if (btn) btn.textContent = '⏸️';
}

/**
 * Hook → Main 阶段自动切换
 * 在 reelsUpdatePreview 循环中调用，检测 Hook 结束后自动启动主音视频
 * 与导出的 FFmpeg xfade 行为一致：有转场时，正片在 transitionDur 前就开始播放
 */
function _syncHookPhaseTransition() {
    const curT = _getPreviewCurrentTime();
    const task = _getSelectedTask();
    if (!task) return;

    const hookVideo = document.getElementById('reels-preview-hook-video');
    const coverDur = (task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const hookDur = _reelsState.hookDuration || 0;
    
    if (coverDur <= 0 && hookDur <= 0) return;

    const inHookPhase = hookDur > 0 && curT >= coverDur && curT < (coverDur + hookDur);
    const inMainPhase = curT >= (coverDur + hookDur);

    if (_reelsState.mockPlaying) {
        // 进入 Hook 阶段
        if (inHookPhase && hookVideo && hookVideo.paused) {
            hookVideo.playbackRate = task.hookSpeed || 1.0;
            hookVideo.play().catch(() => { });
        }
        
        // 进入 主视频 阶段
        if (inMainPhase) {
            if (hookVideo && !hookVideo.paused) hookVideo.pause();

            _reelsState.mockPlaying = false;
            _reelsState.hookPhase = false;
            _reelsState.coverPhase = false;

            const audio = document.getElementById('reels-preview-audio');
        const video = document.getElementById('reels-preview-video');
        const fadeVideo = _reelsState.previewFadeVideo;
        const hasAudio = !!(task && task.audioPath && audio && audio.src);
        const previewBg = _resolvePreviewBackgroundPath(task);
        const hasVideo = !!(task && !previewBg.isMulti && previewBg.path && !_isImagePath(previewBg.path) && video && video.src && !(task.contentVideoDirectBg && task.contentVideoPath));

        const hookTransition = task.hookTransition || 'none';
        const transDur = hookTransition !== 'none' ? (task.hookTransDuration || 0.5) : 0;

        if (hasAudio && audio) {
            // 有转场时，正片从转场重叠量开始（与 FFmpeg acrossfade 一致）
            audio.currentTime = transDur > 0 ? Math.min(transDur, _getAudioDuration(task) || 0) : 0;
            const aDurScale = task.audioDurScale || 100;
            audio.playbackRate = (aDurScale !== 100) ? (100 / aDurScale) : 1.0;
            audio.preservesPitch = true;
            audio.play().catch(() => { });
        }
        if (hasVideo && video) {
            const bDurScale = task.bgDurScale || 100;
            video.playbackRate = (bDurScale !== 100) ? (100 / bDurScale) : 1.0;
            video.currentTime = 0;
            video.play().catch(() => { });
            if (fadeVideo && hasAudio) {
                fadeVideo.playbackRate = video.playbackRate;
                fadeVideo.play().catch(() => { });
            }
        }

        // 覆层视频作为 master 时也要启动播放
        const cvEl = document.getElementById('reels-preview-contentvideo');
        if (cvEl && cvEl.src && cvEl.paused) {
            cvEl.currentTime = 0;
            cvEl.play().catch(() => { });
        }

        // 没有主媒体时，继续使用 mock 时钟
        const hasCvMaster = !!(cvEl && cvEl.src && !cvEl.muted);
        if (!hasAudio && !hasVideo && !hasCvMaster) {
            _reelsState.mockPlaying = true;
            // mockStartTime 不需要重设，因为总时间是连续的
        }

        // 启动 BGM
        const bgmAudio = _reelsState._bgmAudioEl;
        if (bgmAudio && bgmAudio.src && task && _getEffectiveBgmPath(task, _reelsState.selectedIdx)) {
            bgmAudio.currentTime = 0;
            bgmAudio.play().catch(() => { });
        }

        console.log(`[Preview] Hook phase ended (transition: ${hookTransition}, transDur: ${transDur}s), starting main content`);
        }
    }
}

function _isPreviewSeekLocked() {
    const lock = _reelsState.previewSeekLock;
    return !!(lock && Number.isFinite(lock.target) && performance.now() < lock.until);
}

function _clearPreviewSeekLock(token) {
    if (!_reelsState.previewSeekLock) return;
    if (token != null && _reelsState.previewSeekLock.token !== token) return;
    _reelsState.previewSeekLock = null;
}

function _isPreviewVideoElement(media) {
    return !!(media && media.tagName && String(media.tagName).toLowerCase() === 'video');
}

function _queuePreviewMediaSeek(seekedMedia, media, target) {
    if (!media || !media.src || !Number.isFinite(target)) return false;

    delete media._reelsSeekFrameCanvas;
    delete media._reelsSeekFrameSrc;
    delete media._reelsSeekFrameToken;
    delete media._reelsSeekFrameTarget;
    const item = {
        media,
        target,
        wasPaused: !!media.paused,
        isVideo: _isPreviewVideoElement(media),
    };
    seekedMedia.push(item);
    try {
        if (item.isVideo) _ensurePreviewVideoDecodable(media);
        media.currentTime = target;
        return true;
    } catch (err) {
        seekedMedia.pop();
        return false;
    }
}

function _primePreviewVideoFrame(item, refresh, token, doneCallback = null) {
    const media = item && item.media;
    const done = () => {
        if (typeof doneCallback === 'function') doneCallback();
    };
    if (!media || !item.isVideo || !media.src) {
        done();
        return;
    }

    const isSuperseded = () => token != null && media._reelsSeekPrimeToken !== token;
    media._reelsSeekPrimeToken = token;

    const finish = () => {
        if (isSuperseded()) {
            done();
            return;
        }
        refresh();
        done();
    };

    const primeFrame = () => {
        if (isSuperseded()) {
            done();
            return;
        }
        // Check if preview is playing via the play/pause toggle button text
        const playBtn = document.getElementById('reels-preview-play');
        const isPlayingNow = playBtn && playBtn.textContent === '⏸️';
        if (isPlayingNow || !media.paused) {
            finish();
            return;
        }
        const wasMuted = media.muted;
        media.muted = true;
        media._reelsSeekPriming = true;
        media.play()
            .then(() => {
                const stillPlaying = playBtn && playBtn.textContent === '⏸️';
                if (!stillPlaying) {
                    media.pause();
                }
                media.muted = wasMuted;
                delete media._reelsSeekPriming;
                finish();
            })
            .catch(() => {
                const stillPlaying = playBtn && playBtn.textContent === '⏸️';
                if (!stillPlaying) {
                    media.pause();
                }
                media.muted = wasMuted;
                delete media._reelsSeekPriming;
                finish();
            });
    };

    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        media.removeEventListener('seeked', complete);
        primeFrame();
    };

    if (media.seeking) {
        media.addEventListener('seeked', complete, { once: true });
        // Fallback in case seeked gets lost
        setTimeout(complete, 150);
    } else {
        requestAnimationFrame(complete);
    }
}

function _mapAbsoluteTimeToTimelineTime(absoluteTime) {
    const task = _getSelectedTask();
    if (!task) return absoluteTime;
    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const offsetDur = hookDur + coverDur;
    const aDurScale = task.audioDurScale ? (task.audioDurScale / 100) : 1;
    return Math.max(0, (absoluteTime - offsetDur) / aDurScale);
}

function _refreshPreviewAfterSeek(target, duration, seekTargets = [], token = null, options = {}) {
    _updatePreviewTimeUI(target, duration);
    if (_reelsState.timelineEditor) {
        _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
    }

    const refresh = () => {
        _updatePreviewTimeUI(target, duration);
        if (_reelsState.timelineEditor) {
            _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        }
        reelsUpdatePreview();
    };

    refresh();
    requestAnimationFrame(refresh);
    setTimeout(refresh, 60);
    setTimeout(refresh, 160);

    const validTargets = seekTargets
        .map((item) => item && item.media ? item : { media: item, target: null, wasPaused: item ? !!item.paused : true, isVideo: _isPreviewVideoElement(item) })
        .filter((item) => item && item.media && item.media.src);

    if (options.deferFramePrime) {
        clearTimeout(_reelsState._previewSeekPrimeTimer);
        _reelsState._previewSeekPrimeTimer = setTimeout(() => {
            if (!_reelsState.previewSeekLock || _reelsState.previewSeekLock.token !== token) return;
            _refreshPreviewAfterSeek(target, duration, validTargets, token, { deferFramePrime: false });
        }, 120);
        setTimeout(() => _clearPreviewSeekLock(token), 2200);
        return;
    }

    let pending = validTargets.length;
    let released = false;
    const releaseOne = () => {
        pending -= 1;
        if (!released && pending <= 0) {
            released = true;
            setTimeout(() => _clearPreviewSeekLock(token), 80);
        }
    };

    for (const item of validTargets) {
        const media = item.media;
        const mediaTarget = item.target;
        if (!media || !media.src) continue;
        media.addEventListener('seeked', refresh, { once: true });
        media.addEventListener('loadeddata', refresh, { once: true });
        media.addEventListener('canplay', refresh, { once: true });
        if (typeof media.requestVideoFrameCallback === 'function') {
            try { media.requestVideoFrameCallback(refresh); } catch (e) { }
        }

        let tries = 0;
        const pollSeek = () => {
            tries += 1;
            const wantsTarget = Number.isFinite(mediaTarget);
            const notAtTarget = wantsTarget && Math.abs((media.currentTime || 0) - mediaTarget) > 0.06;
            if ((media.seeking || notAtTarget) && tries < 24) {
                requestAnimationFrame(pollSeek);
                return;
            }
            refresh();
            _primePreviewVideoFrame(item, refresh, token, releaseOne);
        };
        requestAnimationFrame(pollSeek);
    }

    if (validTargets.length === 0) {
        setTimeout(() => _clearPreviewSeekLock(token), 180);
    } else {
        setTimeout(() => _clearPreviewSeekLock(token), 1800);
    }
}

let _onSeekThrottleTimer = null;
let _onSeekPendingEvent = null;
let _onSeekLastTime = 0;

function _onSeek(e) {
    const isDrag = e && (e.type === 'mousemove' || e.type === 'input');
    const isClickOrRelease = !isDrag;
    _onSeekPendingEvent = e;
    
    const now = performance.now();
    const elapsed = now - _onSeekLastTime;
    const throttleMs = 60; // 60ms throttle (approx 16fps)
    
    if (isClickOrRelease || elapsed >= throttleMs) {
        if (_onSeekThrottleTimer) {
            clearTimeout(_onSeekThrottleTimer);
            _onSeekThrottleTimer = null;
        }
        _executeSeekNow();
    } else {
        if (!_onSeekThrottleTimer) {
            _onSeekThrottleTimer = setTimeout(() => {
                _onSeekThrottleTimer = null;
                _executeSeekNow();
            }, throttleMs - elapsed);
        }
    }
}

function _executeSeekNow() {
    const e = _onSeekPendingEvent;
    if (!e) return;
    _onSeekPendingEvent = null;
    _onSeekLastTime = performance.now();
    _actualSeek(e);
}

function _actualSeek(e) {
    const video = document.getElementById('reels-preview-video');
    const audio = document.getElementById('reels-preview-audio');
    const hookVideo = document.getElementById('reels-preview-hook-video');
    const duration = _getPreviewDuration() || (_reelsState.timelineEditor && _reelsState.timelineEditor._duration) || 0;
    
    let target = 0;
    if (e && typeof e.absoluteTarget === 'number') {
        target = e.absoluteTarget;
    } else {
        const rawValue = e && e.target ? parseFloat(e.target.value) : NaN;
        if (!Number.isFinite(rawValue)) return;
        target = (rawValue / 100) * duration;
    }
    const task = _getSelectedTask();
    console.log(`[Seek] target=${target.toFixed(3)}s, duration=${duration.toFixed(3)}s, audioPath=${task?.audioPath ? 'yes' : 'no'}, bgPath=${task?.bgPath ? 'yes' : 'no'}, cvPath=${task?.contentVideoPath ? 'yes' : 'no'}`);

    const hookDur = _reelsState.hookDuration || 0;
    const coverDur = (task && task.cover && task.cover.enabled) ? (parseFloat(task.cover.duration) || 0.01) : 0;
    const seekInCoverPhase = coverDur > 0 && target < coverDur;
    const seekInHookPhase = hookDur > 0 && target >= coverDur && target < (coverDur + hookDur);
    const seekedMedia = [];
    const seekToken = ((_reelsState.previewSeekLock && _reelsState.previewSeekLock.token) || 0) + 1;
    const deferFramePrime = false;

    // 必须始终更新 mock 时间，以保证在暂停状态下拖动时，时钟立即同步更新
    _reelsState.mockPausedTime = target;
    _reelsState.mockStartTime = (performance.now() / 1000) - target;
    _reelsState.coverPhase = seekInCoverPhase;
    _reelsState.hookPhase = seekInHookPhase;
    _reelsState.previewSeekLock = {
        target,
        token: seekToken,
        until: performance.now() + 1800,
    };

    // ── Cover video seek ──
    const coverVideo = _reelsState._previewCoverVideo;
    if (coverVideo && coverVideo.src && seekInCoverPhase) {
        const coverTarget = coverVideo.duration > 0 ? Math.min(target, Math.max(0, coverVideo.duration - 0.03)) : target;
        _queuePreviewMediaSeek(seekedMedia, coverVideo, coverTarget);
    }

    // ── Hook video seek ──
    if (hookVideo && hookVideo.src && hookDur > 0) {
        if (seekInHookPhase) {
            const trimStart = (task && task.hookTrimStart != null && task.hookTrimStart > 0) ? task.hookTrimStart : 0;
            const speed = (task && task.hookSpeed) || 1.0;
            const hookTarget = trimStart + ((target - coverDur) * speed);
            _queuePreviewMediaSeek(seekedMedia, hookVideo, hookTarget);
        } else {
            if (!hookVideo.paused) hookVideo.pause();
        }
    }

    // ── Main content seek (offset by hookDur + coverDur) ──
    const contentTarget = hookDur > 0 || coverDur > 0 ? Math.max(0, target - hookDur - coverDur) : target;

    const aDur = _getAudioDuration(task);
    if (task && task.audioPath && audio && audio.src && aDur > 0) {
        const aDurScale = task.audioDurScale ? (task.audioDurScale / 100) : 1;
        const audioTarget = Math.max(0, Math.min(contentTarget / Math.max(aDurScale, 0.0001), aDur));
        console.log(`[Seek] Seeking Audio to ${audioTarget.toFixed(3)}s`);
        _queuePreviewMediaSeek(seekedMedia, audio, audioTarget);
    }
    const previewBg = _resolvePreviewBackgroundPath(task);
    const vDur = _getVideoDuration(task);
    if (video && vDur > 0 && !previewBg.isMulti) {
        const bgDurScale = task && task.bgDurScale ? (task.bgDurScale / 100) : 1;
        const visualContentTarget = (task && task.audioPath) ? contentTarget : (contentTarget / Math.max(bgDurScale, 0.0001));
        const videoTarget = vDur > 0 ? (visualContentTarget % vDur) : visualContentTarget;
        console.log(`[Seek] Seeking BgVideo to ${videoTarget.toFixed(3)}s (vDur=${vDur.toFixed(3)}s)`);
        _queuePreviewMediaSeek(seekedMedia, video, videoTarget);
        const fadeVideo = _reelsState.previewFadeVideo;
        if (fadeVideo && task && task.audioPath) {
            const cfg = _getPreviewLoopFadeConfig();
            const fadeDur = Math.min(cfg.duration, Math.max(0.1, vDur * 0.45));
            const fadeTarget = (videoTarget + fadeDur) % vDur;
            _queuePreviewMediaSeek(seekedMedia, fadeVideo, fadeTarget);
        }
    } else if (task && previewBg.isMulti) {
        _syncPreviewMultiBackground(task, contentTarget);
        seekedMedia.push(document.getElementById('reels-preview-video'));
        seekedMedia.push(_reelsState.previewFadeVideo);
    }

    const contentVideoEl = document.getElementById('reels-preview-contentvideo');
    if (contentVideoEl && contentVideoEl.src) {
        console.log(`[Seek] ContentVideo src=${contentVideoEl.src ? 'yes' : 'no'}, readyState=${contentVideoEl.readyState}`);
        if (contentVideoEl.readyState >= 1) {
            const trimStart = parseFloat((task || {}).contentVideoTrimStart) || 0;
            const trimEnd = parseFloat((task || {}).contentVideoTrimEnd) || 0;
            const cvDuration = trimEnd > trimStart ? (trimEnd - trimStart) : (contentVideoEl.duration - trimStart);
            if (Number.isFinite(cvDuration) && cvDuration > 0) {
                const cvTarget = trimStart + (contentTarget % cvDuration);
                console.log(`[Seek] Seeking ContentVideo to ${cvTarget.toFixed(3)}s (trimStart=${trimStart.toFixed(3)}s, cvDuration=${cvDuration.toFixed(3)}s)`);
                _queuePreviewMediaSeek(seekedMedia, contentVideoEl, cvTarget);
            }
        }
    }

    // ── 同步 BGM seek ──
    const bgmAudio = _reelsState._bgmAudioEl;
    if (bgmAudio && bgmAudio.src && bgmAudio.duration > 0) {
        const bgmTarget = contentTarget % bgmAudio.duration;
        _queuePreviewMediaSeek(seekedMedia, bgmAudio, bgmTarget);
    }
    _refreshPreviewAfterSeek(target, duration, seekedMedia, seekToken, { deferFramePrime });
}

function _onVideoTimeUpdate() {
    const video = document.getElementById('reels-preview-video');
    if (!video) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const task = _getSelectedTask();
    // 有配音时，以音频为主时钟，不用视频 timeupdate 驱动 UI
    if (task && task.audioPath) {
        _syncBackgroundVideoToMaster();
        return;
    }
    const cur = _getPreviewCurrentTime();
    const dur = _getPreviewDuration();
    _updatePreviewTimeUI(cur, dur);
    if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
}

function _onAudioTimeUpdate() {
    const audio = document.getElementById('reels-preview-audio');
    if (!audio) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const cur = _getPreviewCurrentTime();
    const dur = _getPreviewDuration();
    _syncBackgroundVideoToMaster();
    _updatePreviewTimeUI(cur, dur);
    if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
}

function _onCvVideoTimeUpdate() {
    const cvVideo = document.getElementById('reels-preview-contentvideo');
    if (!cvVideo) return;
    if (_isPreviewSeekLocked()) {
        const dur = _getPreviewDuration();
        const target = _reelsState.previewSeekLock.target;
        _updatePreviewTimeUI(target, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(target));
        return;
    }
    const task = _getSelectedTask();
    const master = _getPreviewMasterElement();
    if (master === cvVideo) {
        if (task) {
            const trimStart = parseFloat(task.contentVideoTrimStart) || 0;
            const trimEnd = parseFloat(task.contentVideoTrimEnd) || 0;
            const curTime = cvVideo.currentTime || 0;
            const loopEnabled = _isPreviewLoopEnabled();

            if (trimEnd > trimStart && curTime >= trimEnd) {
                if (loopEnabled) {
                    cvVideo.currentTime = trimStart;
                } else {
                    cvVideo.pause();
                    const btn = document.getElementById('reels-preview-play');
                    if (btn) btn.textContent = '▶️';
                }
            } else if (trimStart > 0 && curTime < trimStart) {
                cvVideo.currentTime = trimStart;
            }
        }
        _syncBackgroundVideoToMaster();
        const cur = _getPreviewCurrentTime();
        const dur = _getPreviewDuration();
        _updatePreviewTimeUI(cur, dur);
        if (_reelsState.timelineEditor) _reelsState.timelineEditor.setPlayhead(_mapAbsoluteTimeToTimelineTime(cur));
    }
}

function _onCvVideoLoaded() {
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

function _onVideoLoaded() {
    const video = document.getElementById('reels-preview-video');
    if (!video) return;
    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = _reelsState.targetWidth || 1080;
        canvas.height = _reelsState.targetHeight || 1920;
    }

    _ensurePreviewFadeVideo(video);
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

function _onAudioLoaded() {
    _applyPreviewLoopMode();
    _applyPreviewAudioMix();
    _updateTimelineForTask(_getSelectedTask());
    _updatePreviewTimeUI(_getPreviewCurrentTime(), _getPreviewDuration());
    _onSeek({ absoluteTarget: _getPreviewCurrentTime() });
}

// ═══════════════════════════════════════════════════════
// Preset management (fully ported from AutoSub preset_manager.py)
// ═══════════════════════════════════════════════════════

function reelsOpenSubtitlePresetPicker(anchorEl) {
    if (!window._openStyledPresetPicker) return;
    const hiddenInput = document.getElementById('reels-preset-select');
    const currentVal = hiddenInput ? hiddenInput.value : '';
    window._openStyledPresetPicker(anchorEl, currentVal, (selectedVal) => {
        if (hiddenInput) {
            hiddenInput.value = selectedVal || '';
            
            // Sync the selected preset to the task objects
            const applyAll = typeof _isStyleApplyAllEnabled === 'function' ? _isStyleApplyAllEnabled() : true;
            if (applyAll && _reelsState.tasks) {
                _reelsState.tasks.forEach(t => t._subtitlePreset = selectedVal || '');
            } else {
                const t = _getSelectedTask();
                if (t) t._subtitlePreset = selectedVal || '';
            }

            // Trigger the same logic as the old onchange event if necessary
            if (typeof reelsLoadPresetQuick === 'function') {
                reelsLoadPresetQuick();
            } else if (typeof reelsLoadPreset === 'function') {
                reelsLoadPreset();
            }
        }
        const span = anchorEl.querySelector('span');
        if (span) {
            span.textContent = selectedVal || '-- 改全部样式 --';
        }
    });
}
window.reelsOpenSubtitlePresetPicker = reelsOpenSubtitlePresetPicker;

function _reelsRefreshPresetList() {
    const hidden = document.getElementById('reels-preset-select');
    if (!hidden || !window.ReelsStyleEngine) return;
    _reelsRefreshDefaultPresetIndicator();
}

function _reelsRefreshDefaultPresetIndicator() {
    const indicator = document.getElementById('reels-default-preset-indicator');
    if (!indicator) return;
    const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
    indicator.textContent = defaultName ? `默认模板: ${defaultName}` : '默认模板: 未设置';
}

function _reelsApplyDefaultPreset() {
    if (!window.ReelsStyleEngine) return;
    const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
    if (!defaultName) {
        _reelsRefreshDefaultPresetIndicator();
        return;
    }
    const data = ReelsStyleEngine.loadSubtitlePresets();
    if (!data.presets || !data.presets[defaultName]) {
        localStorage.removeItem(REELS_DEFAULT_PRESET_KEY);
        _reelsRefreshPresetList();
        return;
    }

    const style = ReelsStyleEngine.applySubtitlePreset(defaultName);
    _reelsState.style = Object.assign({}, _reelsState.style || {}, style);
    _writeStyleToUI(style);
    const select = document.getElementById('reels-preset-select');
    if (select) select.value = defaultName;
    _reelsRefreshDefaultPresetIndicator();
}

function reelsSetDefaultPreset() {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) {
        alert('请先选择一个预设');
        return;
    }
    localStorage.setItem(REELS_DEFAULT_PRESET_KEY, name);
    _reelsRefreshPresetList();
    alert(`已设为默认模板：${name}`);
}

/**
 * 自定义输入弹窗（替代 Electron 不支持的 prompt()）
 */
function _showInputDialog(title, placeholder) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:12px;padding:24px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
        box.innerHTML = `
            <div style="font-size:15px;font-weight:600;margin-bottom:14px;color:var(--text-primary,#fff);">${title}</div>
            <input type="text" id="_input_dialog_val" placeholder="${placeholder || ''}"
                style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:14px;outline:none;">
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;">
                <button id="_input_dialog_cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                <button id="_input_dialog_ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;">确定</button>
            </div>`;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const input = box.querySelector('#_input_dialog_val');
        const okBtn = box.querySelector('#_input_dialog_ok');
        const cancelBtn = box.querySelector('#_input_dialog_cancel');

        // 防止外层事件监听器抢焦点
        input.addEventListener('mousedown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
        box.addEventListener('mousedown', (e) => e.stopPropagation());

        const close = (val) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(val);
        };

        okBtn.onclick = () => close(input.value.trim() || null);
        cancelBtn.onclick = () => close(null);
        overlay.onclick = (e) => { if (e.target === overlay) close(null); };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') close(input.value.trim() || null);
            if (e.key === 'Escape') close(null);
        });
        // 多次尝试 focus 确保 Electron 渲染完成后能获得焦点
        setTimeout(() => input.focus(), 50);
        setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 150);
    });
}

window.showNamingSettingsDialog = function(mode) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
        
        const isDate = mode === 'date-auto';
        const title = isDate ? '按日期自动排序命名设置' : '纯序号命名设置';
        
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowY = tomorrow.getFullYear();
        const tomorrowM = String(tomorrow.getMonth() + 1).padStart(2, '0');
        const tomorrowD = String(tomorrow.getDate()).padStart(2, '0');
        const defaultDate = localStorage.getItem('reels_naming_start_date') || `${tomorrowY}-${tomorrowM}-${tomorrowD}`;
        const defaultVids = localStorage.getItem('reels_naming_vids_per_day') || '3';
        const defaultPrefix = localStorage.getItem('reels_naming_prefix') || '';
        const defaultSuffix = localStorage.getItem('reels_naming_suffix') || '';
        
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--bg-primary,#1e1e2e);border:1px solid var(--border-color,#444);border-radius:12px;padding:24px;width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.5);color:var(--text-primary,#fff);font-family:system-ui, sans-serif;';
        
        let fieldsHtml = '';
        if (isDate) {
            fieldsHtml += `
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">起始日期:</label>
                    <input type="date" id="_ns_start_date" value="${defaultDate}"
                        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
                </div>
                <div style="margin-bottom:12px;">
                    <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">每天视频数量:</label>
                    <select id="_ns_vids_per_day"
                        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;cursor:pointer;">
                        <option value="1" ${defaultVids === '1' ? 'selected' : ''}>1</option>
                        <option value="2" ${defaultVids === '2' ? 'selected' : ''}>2</option>
                        <option value="3" ${defaultVids === '3' ? 'selected' : ''}>3</option>
                        <option value="4" ${defaultVids === '4' ? 'selected' : ''}>4</option>
                        <option value="5" ${defaultVids === '5' ? 'selected' : ''}>5</option>
                        <option value="6" ${defaultVids === '6' ? 'selected' : ''}>6</option>
                    </select>
                </div>
            `;
        }
        
        fieldsHtml += `
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">文件名自定义前缀 (可选):</label>
                <input type="text" id="_ns_prefix" value="${defaultPrefix}" placeholder="例如: 爆款-"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
            </div>
            <div style="margin-bottom:12px;">
                <label style="display:block;font-size:12px;color:#aaa;margin-bottom:4px;">文件名自定义后缀 (可选):</label>
                <input type="text" id="_ns_suffix" value="${defaultSuffix}" placeholder="例如: -成品"
                    style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid var(--border-color,#555);background:var(--bg-secondary,#2a2a3e);color:var(--text-primary,#fff);font-size:13px;outline:none;">
            </div>
        `;
        
        box.innerHTML = `
            <div style="font-size:15px;font-weight:600;margin-bottom:16px;color:var(--text-primary,#fff);">${title}</div>
            ${fieldsHtml}
            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;">
                <button id="_ns_cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--border-color,#555);background:transparent;color:var(--text-secondary,#aaa);cursor:pointer;font-size:13px;">取消</button>
                <button id="_ns_ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--accent-primary,#5b6abf);color:#fff;cursor:pointer;font-size:13px;font-weight:bold;">确定</button>
            </div>
        `;
        
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        
        box.addEventListener('mousedown', (e) => e.stopPropagation());
        box.addEventListener('click', (e) => e.stopPropagation());
        
        const close = (success) => {
            if (overlay.parentNode) document.body.removeChild(overlay);
            resolve(success);
        };
        
        box.querySelector('#_ns_cancel').onclick = () => close(false);
        box.querySelector('#_ns_ok').onclick = () => {
            if (isDate) {
                const sDate = box.querySelector('#_ns_start_date').value;
                const vDay = box.querySelector('#_ns_vids_per_day').value;
                localStorage.setItem('reels_naming_start_date', sDate);
                localStorage.setItem('reels_naming_vids_per_day', vDay);
            }
            const pfx = box.querySelector('#_ns_prefix').value;
            const sfx = box.querySelector('#_ns_suffix').value;
            localStorage.setItem('reels_naming_prefix', pfx);
            localStorage.setItem('reels_naming_suffix', sfx);
            close(true);
        };
        overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    });
};

async function reelsSavePreset() {
    console.log('[预设] 保存按钮被点击');
    try {
        const name = await _showInputDialog('保存字幕预设', '请输入预设名称');
        console.log('[预设] 用户输入名称:', name);
        if (!name) return;
        const style = _readStyleFromUI();
        if (window.ReelsStyleEngine) {
            const allPresets = ReelsStyleEngine.loadSubtitlePresets().presets || {};
            if (allPresets[name]) {
                const ok = confirm(`预设 "${name}" 已存在，是否覆盖？`);
                if (!ok) return;
            }
            const result = ReelsStyleEngine.saveNamedSubtitlePreset(name, style);
            if (result) {
                _reelsRefreshPresetList();
                const select = document.getElementById('reels-preset-select');
                if (select) select.value = name;
                console.log(`[预设] 保存成功: "${name}", keys: ${Object.keys(style).length}`);
            } else {
                alert(`保存失败！可能预设数量已满（${ReelsStyleEngine.MAX_PRESETS}个）或名称无效。`);
            }
        } else {
            console.error('[预设] ReelsStyleEngine 未加载！');
        }
    } catch (e) {
        console.error('[预设] 保存出错:', e);
    }
}

function reelsLoadPreset(silent = false) {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) { if (!silent) alert('请先选择一个预设'); return; }
    if (window.ReelsStyleEngine) {
        const style = _getNamedSubtitlePresetStyle(name);
        if (!style) {
            select.value = '';
            if (!silent) alert(`预设不存在或已删除：${name}`);
            return;
        }
        _reelsState.style = Object.assign({}, _reelsState.style || {}, style);
        _writeStyleToUI(style);
        reelsUpdatePreview();
    }
}

function reelsLoadPresetQuick() {
    reelsLoadPreset(true);
}

function reelsDeletePreset() {
    const select = document.getElementById('reels-preset-select');
    if (!select) return;
    const name = select.value;
    if (!name) { alert('请先选择一个预设'); return; }
    if (confirm(`确定删除预设 "${name}"？`)) {
        if (window.ReelsStyleEngine) {
            ReelsStyleEngine.deleteSubtitlePreset(name);
            const defaultName = localStorage.getItem(REELS_DEFAULT_PRESET_KEY) || '';
            if (defaultName === name) {
                localStorage.removeItem(REELS_DEFAULT_PRESET_KEY);
            }
            _reelsRefreshPresetList();
        }
    }
}

function reelsExportPresets() {
    if (!window.ReelsStyleEngine) return;
    const json = ReelsStyleEngine.exportSubtitlePresets();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitle_presets.json';
    a.click();
    URL.revokeObjectURL(url);
}

function reelsImportPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            if (window.ReelsStyleEngine) {
                let overwriteConflicts = false;
                try {
                    const incoming = JSON.parse(ev.target.result);
                    if (incoming && typeof incoming === 'object' && incoming.presets) {
                        const data = ReelsStyleEngine.loadSubtitlePresets();
                        const existingPresets = data.presets || {};
                        const conflicts = [];
                        for (const name of Object.keys(incoming.presets)) {
                            if (name in existingPresets) {
                                conflicts.push(name);
                            }
                        }
                        if (conflicts.length > 0) {
                            overwriteConflicts = confirm(`导入的预设中包含以下已存在的字幕预设：\n${conflicts.join(', ')}\n\n是否覆盖它们？(点击「取消」将跳过这些冲突的预设)`);
                        }
                    }
                } catch(err) {
                    console.error('解析导入预设JSON出错:', err);
                }

                const result = ReelsStyleEngine.importSubtitlePresets(ev.target.result, overwriteConflicts);
                _reelsRefreshPresetList();
                alert(`✅ 导入完成：新增 ${result.added.length} 个，覆盖 ${result.conflicts.length} 个，跳过 ${result.skipped.length} 个`);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ═══════════════════════════════════════════════════════
// Export (FFmpeg via IPC)
// ═══════════════════════════════════════════════════════

function _reelsUpdateLastOutputUI(outputPath) {
    const outEl = document.getElementById('reels-export-last-output');
    const openBtn = document.getElementById('reels-open-last-output-btn');
    if (outEl) outEl.value = outputPath || '';
    if (openBtn) openBtn.disabled = !outputPath;
}

function _reelsUpdateLastErrorUI(message) {
    const errEl = document.getElementById('reels-export-last-error');
    if (!errEl) return;
    const text = (message && String(message).trim()) ? String(message).trim() : '无';
    errEl.textContent = text;
    errEl.style.color = text === '无' ? 'var(--text-secondary)' : '#ff8a8a';
}

function _reelsUpdateExportProgressUI(done, total) {
    const progressInner = document.getElementById('reels-export-progress-inner');
    const progressText = document.getElementById('reels-export-progress-text');
    const safeTotal = Math.max(0, total || 0);
    const safeDone = Math.max(0, Math.min(done || 0, safeTotal));
    const pct = safeTotal > 0 ? Math.round((safeDone / safeTotal) * 100) : 0;
    if (progressInner) progressInner.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `${pct}% (${safeDone}/${safeTotal})`;
}

function _reelsParentDir(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    const normalized = filePath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return normalized;
    return normalized.slice(0, idx);
}

function reelsSelectOutputDir() {
    if (window.electronAPI && window.electronAPI.selectDirectory) {
        window.electronAPI.selectDirectory().then(dir => {
            if (dir) document.getElementById('reels-output-dir').value = dir;
        });
    } else {
        alert('输出目录选择需要在 Electron 环境中运行');
    }
}

async function reelsOpenOutputDir() {
    let outputDir = (document.getElementById('reels-output-dir') || {}).value || '';
    if (!outputDir) outputDir = await _getSystemDownloadsPath();
    if (!outputDir) {
        alert('暂无可打开的输出目录');
        return;
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        try {
            await window.electronAPI.apiCall('file/open-folder', { path: outputDir });
        } catch (e) {
            alert(`打开目录失败: ${e.message || e}`);
        }
        return;
    }
    alert('打开目录需要在 Electron 环境中运行');
}

async function reelsOpenLastOutputInFolder() {
    const outputPath = _reelsState.lastExportOutputPath;
    if (!outputPath) {
        alert('暂无导出文件');
        return;
    }
    const folder = _reelsParentDir(outputPath);
    if (!folder) {
        alert('无法识别输出目录');
        return;
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        try {
            await window.electronAPI.apiCall('file/open-folder', { path: folder });
        } catch (e) {
            alert(`打开目录失败: ${e.message || e}`);
        }
        return;
    }
    alert('打开目录需要在 Electron 环境中运行');
}

async function _reelsComposeViaBackend(params) {
    if (window.electronAPI && typeof window.electronAPI.reelsCompose === 'function') {
        try {
            const resp = await window.electronAPI.reelsCompose(params);
            if (!resp || resp.success === false) {
                throw new Error((resp && resp.error) || 'Reels 合成失败');
            }
            return resp;
        } catch (err) {
            const msg = err && err.message ? err.message : String(err || '');
            // 主进程未重启时，可能出现该错误；回退尝试旧通道。
            if (!msg.includes("No handler registered for 'reels-compose'")) {
                throw err;
            }
        }
    }
    if (window.electronAPI && window.electronAPI.apiCall) {
        const resp = await window.electronAPI.apiCall('media/reels-compose', params);
        if (!resp || !resp.success) {
            const errMsg = (resp && resp.error) || 'Reels 合成失败';
            if (String(errMsg).includes('未知接口: media/reels-compose')) {
                throw new Error('当前主进程版本不一致（缺少导出接口）。请先完全退出所有 VideoKit 进程，再只启动一个实例重试');
            }
            throw new Error(errMsg);
        }
        return resp;
    }
    throw new Error('缺少后端导出能力（Electron API 不可用）');
}

function reelsSelectIntro() {
    if (window.electronAPI && window.electronAPI.selectFile) {
        window.electronAPI.selectFile({ filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv'] }] })
            .then(path => {
                if (path) document.getElementById('reels-intro-path').value = path;
            });
    } else {
        alert('文件选择需要在 Electron 环境中运行');
    }
}

function reelsCancelExport() {
    if (_reelsState.isExporting) {
        _reelsState.isExporting = false;
        const statusEl = document.getElementById('reels-export-status');
        if (statusEl) statusEl.textContent = '⚠️ 已取消';
        const exportBtn = document.getElementById('reels-export-btn');
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '🚀 开始导出';
        }
    }
}

// ═══════════════════════════════════════════════════════
// Export Selection (勾选导出)
// ═══════════════════════════════════════════════════════

/** 切换单个任务的导出选中状态 */
function reelsToggleExportSelect(idx, checked) {
    const task = _reelsState.tasks[idx];
    if (task) task._exportSelected = !!checked;
    _updateExportSelectedCountUI();
    // 更新该行的视觉不透明度（无需完整重绘）
    const items = document.querySelectorAll('.reels-task-item');
    if (items[idx]) items[idx].style.opacity = checked ? '1' : '0.45';
}
window.reelsToggleExportSelect = reelsToggleExportSelect;

/** 全选 / 取消全选 */
function reelsToggleExportSelectAll(checked) {
    _reelsState.tasks.forEach(t => t._exportSelected = !!checked);
    // 更新所有 checkbox
    document.querySelectorAll('.reels-export-cb').forEach(cb => {
        cb.checked = !!checked;
    });
    // 更新所有行的不透明度
    document.querySelectorAll('.reels-task-item').forEach(el => {
        el.style.opacity = checked ? '1' : '0.45';
    });
    _updateExportSelectedCountUI();
}
window.reelsToggleExportSelectAll = reelsToggleExportSelectAll;

/** 更新已选计数 UI */
function _updateExportSelectedCountUI() {
    const tasks = _reelsState.tasks;
    const total = tasks.length;
    const selected = tasks.filter(t => t._exportSelected !== false).length;
    const countEl = document.getElementById('reels-export-selected-count');
    if (countEl) {
        if (total === 0) {
            countEl.textContent = '';
        } else if (selected === total) {
            countEl.textContent = `全部 ${total}`;
            countEl.style.color = 'var(--accent,#7b8bef)';
        } else {
            countEl.textContent = `已选 ${selected}/${total}`;
            countEl.style.color = selected === 0 ? '#f87171' : '#ffa502';
        }
    }
    // 同步全选 checkbox 状态
    const selectAllCb = document.getElementById('reels-export-select-all');
    if (selectAllCb) {
        selectAllCb.checked = total > 0 && selected === total;
        selectAllCb.indeterminate = selected > 0 && selected < total;
    }
    // 同步多模板矩阵预计
    if (typeof _updateMultiPresetSummary === 'function') {
        _updateMultiPresetSummary();
    }
}

function _sanitizeReelsFileBaseName(name, fallback = 'reel') {
    let base = String(name || '').trim()
        .replace(/\.[^.\\/]+$/, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[<>:"/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    base = base.replace(/[. ]+$/g, '').trim();
    return base || fallback;
}

function _reelsPathBaseName(filePath) {
    if (!filePath) return '';
    const last = String(filePath).replace(/\\/g, '/').split('/').pop() || '';
    return _sanitizeReelsFileBaseName(last, '');
}

function _reelsTaskTextBaseName(task) {
    let text = String(task?.txtContent || task?.aiScript || task?.ttsText || '')
        .replace(/[\r\n\t]+/g, '')
        .trim();
    // 若主文案字段为空，尝试从覆层文字卡片中提取标题/正文作为命名
    if (!text && Array.isArray(task?.overlays)) {
        for (const ov of task.overlays) {
            if (!ov || ov.fixed_text) continue;
            const t = String(ov.title_text || '').trim();
            const b = String(ov.body_text || '').trim();
            if (t || b) {
                text = (t && b) ? `${t}_${b}` : (t || b);
                text = text.replace(/[\r\n\t]+/g, '').trim();
                break;
            }
        }
    }
    return text ? _sanitizeReelsFileBaseName(text.substring(0, 50), '') : '';
}

function _reelsTaskBackgroundBaseName(task) {
    return _reelsPathBaseName(task?.bgPath || task?.videoPath || '');
}

function _reelsTaskAudioBaseName(task) {
    return _reelsPathBaseName(task?.audioPath || '');
}

function _reelsTaskCardBaseName(task) {
    return _sanitizeReelsFileBaseName(task?.baseName || task?.fileName || '', '');
}

function _resolveReelsExportBaseName(task, namingMode = 'text') {
    const manual = _sanitizeReelsFileBaseName(task?.exportName || '', '');
    if (manual) return manual;

    const mode = namingMode || 'text';
    const byMode = mode === 'background'
        ? _reelsTaskBackgroundBaseName(task)
        : mode === 'audio'
            ? _reelsTaskAudioBaseName(task)
            : mode === 'card'
                ? _reelsTaskCardBaseName(task)
                : mode === 'custom'
                    ? ''
                    : _reelsTaskTextBaseName(task);
    if (byMode) return byMode;

    return _reelsTaskTextBaseName(task)
        || _reelsTaskBackgroundBaseName(task)
        || _reelsTaskAudioBaseName(task)
        || _reelsTaskCardBaseName(task)
        || _sanitizeReelsFileBaseName(task?.fileName || task?.baseName || 'reel');
}

// ═══════════════════════════════════════════════════════
// Cover PNG Export Utility
// ═══════════════════════════════════════════════════════
async function _exportSaveCoverPng(task, outputDirTrimmed, baseName) {
    if (!task.cover || !task.cover.enabled || task.cover.exportSeparate === false) return null;

    try {
        const tw = _reelsState.targetWidth || 1080;
        const th = _reelsState.targetHeight || 1920;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = tw;
        offCanvas.height = th;
        const ctx = offCanvas.getContext('2d');

        // Draw cover background
        let bgImg = null;
        if (task.cover.bgPath) {
            const isVideo = /\.(mp4|mov|mkv|webm)$/i.test(task.cover.bgPath);
            if (isVideo) {
                bgImg = await new Promise((resolve) => {
                    const vid = document.createElement('video');
                    vid.crossOrigin = 'anonymous';
                    vid.muted = true;
                    vid.onloadeddata = () => { vid.currentTime = 0.05; };
                    vid.onseeked = () => resolve(vid);
                    vid.onerror = () => resolve(null);
                    vid.src = _toPlayablePath(task.cover.bgPath, null);
                });
            } else {
                bgImg = await new Promise((resolve) => {
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => resolve(img);
                    img.onerror = () => resolve(null);
                    img.src = _toPlayablePath(task.cover.bgPath, null);
                });
            }
        }
        
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, tw, th);
        if (bgImg) {
            _drawVideoCover(ctx, bgImg, tw, th, task.cover.bgScale || task.bgScale || 100, task.cover.bgX || task.bgX || 0, task.cover.bgY || task.bgY || 0);
        }

        // Draw Cover overlays
        if (task.cover.overlays && task.cover.overlays.length > 0 && window.ReelsOverlay) {
            for (const ov of task.cover.overlays) {
                if (ov.disabled) continue;
                ov._exporting = true;
                ReelsOverlay.drawOverlay(ctx, ov, 0, tw, th);
                ov._exporting = false;
            }
        }

        if (typeof _drawWatermarks === 'function') {
            _drawWatermarks(ctx, tw, th);
        }


        const dataUrl = offCanvas.toDataURL('image/png');
        const outputPath = `${outputDirTrimmed}/${baseName}_封面.png`;

        if (window.electronAPI && window.electronAPI.apiCall) {
            await window.electronAPI.apiCall('file/write-base64', { path: outputPath, content: dataUrl });
        }
        return outputPath;
    } catch (e) {
        console.error('[Export Cover] Error:', e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Cover MP4 Export Utility
// ═══════════════════════════════════════════════════════
async function _exportCoverVideo(task, taskStyle, outputDirTrimmed, baseName) {
    if (!task.cover || !task.cover.enabled || !task.cover.duration || parseFloat(task.cover.duration) <= 0) return null;
    try {
        const tw = _reelsState.targetWidth || 1080;
        const th = _reelsState.targetHeight || 1920;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = tw;
        offCanvas.height = th;
        const outputPath = `${outputDirTrimmed}/temp_${baseName}_cover_piece.mp4`;
        
        await window.reelsWysiwygExport({
            canvas: offCanvas,
            style: taskStyle,
            segments: [],
            overlays: task.cover.overlays || [],
            backgroundPath: task.cover.bgPath || task.bgPath,
            bgMode: 'single',
            outputPath: outputPath,
            customDuration: parseFloat(task.cover.duration),
            fps: 30,
            voiceVolume: 0,
            bgVolume: 0,
            bgScale: task.cover.bgScale || task.bgScale || 100,
            bgX: task.cover.bgX || task.bgX || 0,
            bgY: task.cover.bgY || task.bgY || 0,
            bgFlipH: task.cover.bgFlipH || task.bgFlipH || false,
            bgFlipV: task.cover.bgFlipV || task.bgFlipV || false,
            targetWidth: tw,
            targetHeight: th,
        });
        return outputPath;
    } catch (e) {
        console.error('[Export Cover Video] Error:', e);
        return null;
    }
}

// ═══════════════════════════════════════════════════════
// Multi-Preset Matrix Export
// ═══════════════════════════════════════════════════════

function _initMultiPresetUI() {
    const enabledCb = document.getElementById('reels-multi-preset-enabled');
    const toggleBtn = document.getElementById('reels-multi-preset-toggle');
    const panel = document.getElementById('reels-multi-preset-panel');
    const summary = document.getElementById('reels-multi-preset-summary');
    if (!enabledCb) return;

    const updateVisibility = () => {
        const on = enabledCb.checked;
        if (toggleBtn) toggleBtn.style.display = on ? '' : 'none';
        if (summary) summary.style.display = on ? '' : 'none';
        if (!on && panel) panel.style.display = 'none';
        if (on) _refreshMultiPresetList();
    };

    enabledCb.addEventListener('change', updateVisibility);

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            if (!panel) return;
            const isOpen = panel.style.display !== 'none';
            panel.style.display = isOpen ? 'none' : '';
            toggleBtn.textContent = isOpen ? '展开选择...' : '收起';
            if (!isOpen) _refreshMultiPresetList();
        });
    }

    // Select/Deselect/Invert
    document.getElementById('reels-mp-select-all')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
        _updateMultiPresetSummary();
    });
    document.getElementById('reels-mp-deselect')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
        _updateMultiPresetSummary();
    });
    document.getElementById('reels-mp-invert')?.addEventListener('click', () => {
        panel?.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = !cb.checked);
        _updateMultiPresetSummary();
    });
}

function _refreshMultiPresetList() {
    const listEl = document.getElementById('reels-mp-preset-list');
    if (!listEl) return;

    // Reuse batch-table's helper to get all overlay group presets
    let presetNames = [];
    try {
        const stored = localStorage.getItem('reels_overlay_group_presets');
        let obj = stored ? JSON.parse(stored) : {};
        if (window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) {
            obj = { ...window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS, ...obj };
        }
        presetNames = Object.keys(obj);
    } catch(e) {}

    if (presetNames.length === 0) {
        listEl.innerHTML = '<span style="font-size:11px;color:#888;">暂无覆层预设，请先在覆层面板中保存预设</span>';
        return;
    }

    const builtInKeys = window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS ? Object.keys(window.REELS_BUILTIN_OVERLAY_GROUP_PRESETS) : [];

    listEl.innerHTML = presetNames.map(name => {
        const isBuiltin = builtInKeys.includes(name);
        const tagColor = isBuiltin ? 'rgba(100,200,150,0.15)' : 'rgba(123,139,239,0.1)';
        const tagText = isBuiltin ? '内置' : '自定义';
        const tagFg = isBuiltin ? '#6cc' : '#8b8bfa';
        return `<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#ccc;cursor:pointer;padding:3px 6px;border-radius:4px;background:${tagColor};white-space:nowrap;">
            <input type="checkbox" class="reels-mp-cb" data-preset-name="${name.replace(/"/g, '&quot;')}" style="margin:0;transform:scale(0.85);">
            <span style="font-size:9px;color:${tagFg};font-weight:600;">[${tagText}]</span>
            ${name}
        </label>`;
    }).join('');

    // Bind change events
    listEl.querySelectorAll('.reels-mp-cb').forEach(cb => {
        cb.addEventListener('change', () => _updateMultiPresetSummary());
    });
}

function _updateMultiPresetSummary() {
    const selected = _getSelectedMultiPresets();
    const summary = document.getElementById('reels-multi-preset-summary');
    const estimate = document.getElementById('reels-mp-estimate');
    // 使用已勾选导出的任务数
    const taskCount = (_reelsState.tasks || []).filter(t => t._exportSelected !== false).length;
    
    if (summary) {
        summary.textContent = selected.length > 0 ? `已选 ${selected.length} 个模板` : '未选择模板';
    }
    if (estimate) {
        if (selected.length > 0 && taskCount > 0) {
            estimate.style.display = '';
            estimate.textContent = `📊 预计导出：${taskCount} 任务 × ${selected.length} 模板 = ${taskCount * selected.length} 个视频`;
        } else {
            estimate.style.display = 'none';
        }
    }
}

function _getSelectedMultiPresets() {
    const cbs = document.querySelectorAll('.reels-mp-cb:checked');
    return Array.from(cbs).map(cb => cb.getAttribute('data-preset-name')).filter(Boolean);
}

/**
 * 获取多模板矩阵导出配置
 * @returns {null|{presets: string[], naming: string}} null 表示未启用
 */
function _getMultiPresetConfig() {
    const enabled = document.getElementById('reels-multi-preset-enabled');
    if (!enabled || !enabled.checked) return null;
    const presets = _getSelectedMultiPresets();
    if (presets.length === 0) return null;
    const naming = (document.getElementById('reels-mp-naming') || {}).value || 'flat';
    return { presets, naming };
}

/**
 * 为导出创建一个临时任务副本，应用指定的覆层预设但保留原文案
 * @param {object} task 原始任务
 * @param {string} presetName 覆层预设名称
 * @returns {object} 深克隆后并应用了预设的任务副本
 */
function _cloneTaskWithPreset(task, presetName) {
    // 深克隆整个任务
    const clone = JSON.parse(JSON.stringify(task));
    // 使用 batch-table 中已有的完整逻辑来应用覆层预设
    // 这会保留文案内容，只替换视觉样式
    if (typeof _applyOverlayGroupPresetToTask === 'function') {
        _applyOverlayGroupPresetToTask(clone, presetName);
    }
    return clone;
}

// 初始化（需要在 DOM 就绪后调用）
setTimeout(() => _initMultiPresetUI(), 200);

async function reelsStartExport() {
    const workMode = _getWorkMode();
    
    if (!localStorage.getItem('reelsQualityReminderShown')) {
        const proceed = confirm("【画质选择提醒】\\n\\n现已支持多种输出画质，您可以在底部的「🚀 导出设置」中调整。\\n\\n建议您先导出一个片段对比一下画质是否有明显差别，若无差别强烈建议选择「普通均衡 (Reels推荐)」以获得 3-5 倍的渲染速度提升。\\n（注：实测在绿幕口播视频中，高质量和普通会有一些差别）\\n\\n您要继续当前导出吗？（本提示仅显示一次）");
        if (!proceed) return;
        localStorage.setItem('reelsQualityReminderShown', 'true');
    }

    // ── 导出前同步当前任务的覆层（用户可能删除/修改了覆层但尚未切换任务） ──
    _syncCurrentOverlayEditorToSelectedTask();

    // 导出前自动对齐未对齐的 TXT 任务
    if (workMode !== 'srt') {
        const unaligned = _reelsState.tasks.filter(t =>
            t.txtContent && !t.aligned && (t.segments || []).length === 0
        );
        if (unaligned.length > 0) {
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = `正在对齐 ${unaligned.length} 个任务...`;
            for (let i = 0; i < unaligned.length; i++) {
                const task = unaligned[i];
                if (statusEl) statusEl.textContent = `对齐中 ${i + 1}/${unaligned.length}: ${task.fileName}`;
                try { await _reelsAlignSubtitles(task); } catch (err) {
                    console.error('[Reels] Pre-export align failed:', task.fileName, err);
                }
            }
            _renderTaskList();
        }
    }

    let customDuration = parseFloat((document.getElementById('reels-custom-duration') || {}).value || '0');
    if (!Number.isFinite(customDuration) || customDuration < 0) customDuration = 0;

    // ── 仅导出已勾选的任务 ──
    const selectedForExport = _reelsState.tasks.filter(t => t._exportSelected !== false);
    if (selectedForExport.length === 0) {
        if (typeof showToast === 'function') {
            showToast('没有选中任何任务用于导出。请在任务列表中勾选要导出的任务。', 'warning');
        } else {
            alert('没有选中任何任务用于导出。请在任务列表中勾选要导出的任务。');
        }
        return;
    }

    const invalidTasks = [];
    const tasks = selectedForExport.filter((t, idx) => {
        const hasSub = !!t.srtPath && (t.segments || []).length > 0;
        const bgPath = t.bgPath || t.videoPath;
        const hasMultiClip = t.bgMode === 'multi' && _getEffectiveBgClipPool(t).length > 0;
        const hasBg = !!bgPath || hasMultiClip;
        const hasVoice = !!t.audioPath;
        // 有覆层（文字卡片 或 滚动字幕）则不强制要求字幕
        const hasOverlay = Array.isArray(t.overlays) && t.overlays.some(ov =>
            ov && (
                String(ov.title_text || '').trim() ||
                String(ov.body_text || '').trim() ||
                String(ov.footer_text || '').trim() ||
                String(ov.content || '').trim() ||
                String(ov.scroll_title || '').trim() ||
                String(ov.scroll_body || '').trim()
            )
        );
        // 有任意覆层（包括图片/视频覆层，无需文字内容）
        const hasAnyOverlay = Array.isArray(t.overlays) && t.overlays.some(ov => ov && !ov.disabled);

        if (workMode === 'voiced_bg') {
            // 带声视频模式：需要背景 + (字幕 或 文字卡片)
            // 但如果只有背景视频（无字幕无覆层），也允许导出（直出视频）
            if (!hasBg) {
                invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 带声视频`);
                return false;
            }
            return true;
        }

        // SRT 模式和配音+文本模式
        // 允许导出条件放宽：有背景即可（无字幕时导出纯视频+覆层）
        if (!hasBg) {
            invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 背景`);
            return false;
        }

        // ── 多素材模式：只要能确定输出时长即可直出 ──
        if (t.bgMode === 'multi') {
            const hasDur = hasVoice || hasSub || (t.customDuration && t.customDuration > 0) || (customDuration && customDuration > 0);
            if (hasDur || hasOverlay || hasAnyOverlay) {
                return true;
            }
            invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 无法确定输出时长，请设置输出时长或添加配音/字幕`);
            return false;
        }

        // 有字幕、有文字覆层、有任意覆层 => 直接通过
        if (hasSub || hasOverlay || hasAnyOverlay) {
            if (hasVoice) return true;
            // 有文字卡片但无配音/字幕，也允许导出
            if ((hasOverlay || hasAnyOverlay) && !hasSub && !hasVoice) {
                return true;
            }
            // 无配音时仅兼容视频背景（旧模式）
            const allowNoVoice = !_isImagePath(bgPath);
            if (!allowNoVoice) {
                invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 人声音频（图片背景添加字幕时必须配合音频以确定字幕时间轴与总时长）`);
            }
            return allowNoVoice;
        }
        // 无字幕 + 无覆层：视频背景允许直出，图片背景需配音确定时长
        if (!_isImagePath(bgPath)) {
            return true; // 视频背景直出
        }
        if (hasVoice) {
            return true; // 有配音可以确定时长
        }
        invalidTasks.push(`${idx + 1}. ${(t.fileName || t.baseName || '未命名任务')} 缺少: 字幕、人声音频或覆层卡片（图片背景需要添加字幕+音频、或仅人声音频、或覆层卡片才能确定导出内容与时长）`);
        return false;
    });

    if (tasks.length === 0) {
        const extra = invalidTasks.length > 0 ? `\n\n任务问题:\n${invalidTasks.slice(0, 8).join('\n')}` : '';
        const msg = `没有可导出的任务${extra}`;
        _reelsUpdateLastErrorUI(msg);

        const statusEl = document.getElementById('reels-export-status');
        if (statusEl) statusEl.textContent = `❌ 导出失败: ${msg.replace(/\n/g, ' ')}`;

        const exportBtn = document.getElementById('reels-export-btn');
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '🚀 开始导出';
        }
        _reelsState.isExporting = false;

        if (typeof showToast === 'function') {
            showToast('没有可导出的任务，请在下方“最后错误”查看详情', 'error');
        } else {
            alert(msg);
        }
        return;
    }

    let outputDir = document.getElementById('reels-output-dir').value;
    if (!outputDir) {
        outputDir = await _getSystemDownloadsPath();
        const outputEl = document.getElementById('reels-output-dir');
        if (outputEl) outputEl.value = outputDir || '';
    }
    if (!outputDir) { alert('请先选择输出目录'); return; }

    const quality = document.getElementById('reels-quality').value;
    const suffix = document.getElementById('reels-suffix').value || '_subtitled';
    const namingMode = (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text';
    _persistSubtitleStyleByScope(_readStyleFromUI());
    const crfMap = { high: 15, medium: 18, low: 23, ultrafast: 26 };
    const presetMap = { high: 'medium', medium: 'fast', low: 'faster', ultrafast: 'ultrafast' };
    const crf = crfMap[quality] || 23;
    const qualityPreset = presetMap[quality] || 'faster';
    const useKaraoke = document.getElementById('reels-karaoke-hl');
    const karaokeHL = useKaraoke ? useKaraoke.checked : false;
    let voiceVolume = parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100');
    let bgVolume = _getGlobalBgVolumePercent();
    let bgmVolume = _getGlobalBgmVolumePercent();
    if (!Number.isFinite(voiceVolume)) voiceVolume = 100;
    if (!Number.isFinite(bgVolume)) bgVolume = 100;
    if (!Number.isFinite(bgmVolume)) bgmVolume = 30;
    voiceVolume = Math.max(0, voiceVolume);
    bgVolume = Math.max(0, bgVolume);
    bgmVolume = Math.max(0, bgmVolume);
    const loopFadeEl = document.getElementById('reels-loop-fade');
    const loopFade = loopFadeEl ? loopFadeEl.checked : true;
    const loopFadeDurEl = document.getElementById('reels-loop-fade-dur');
    let loopFadeDur = parseFloat(loopFadeDurEl ? loopFadeDurEl.value : '1');
    if (!Number.isFinite(loopFadeDur) || loopFadeDur <= 0) loopFadeDur = 1.0;
    loopFadeDur = Math.max(0.1, Math.min(3, loopFadeDur));
    customDuration = parseFloat((document.getElementById('reels-custom-duration') || {}).value || '0');
    if (!Number.isFinite(customDuration) || customDuration < 0) customDuration = 0;

    const exportFormat = (document.getElementById('reels-export-format') || {}).value || 'mp4';
    const doFcpxml = exportFormat === 'fcpxml' || exportFormat === 'fcpxml-compound';
    const fcpxmlCompound = exportFormat === 'fcpxml-compound';
    const fcpxmlBatchTasks = [];

    _reelsState.isExporting = true;
    const progressBar = document.getElementById('reels-export-progress');
    const statusEl = document.getElementById('reels-export-status');
    const exportBtn = document.getElementById('reels-export-btn');
    const exportBar = document.querySelector('.nle-export-bar');
    if (exportBar) exportBar.open = true;
    _reelsState.lastExportOutputPath = '';
    _reelsUpdateLastOutputUI('');
    _reelsUpdateLastErrorUI('');
    // Progress UI initialized after multi-preset matrix expansion below

    if (progressBar) progressBar.classList.remove('hidden');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '⏳ 导出中...';
    }
    const useGPU = document.getElementById('reels-use-gpu');
    const gpuEnabled = useGPU ? useGPU.checked : false;
    const useMemoryDecoder = document.getElementById('reels-use-memory-decoder');
    const memoryDecoderEnabled = useMemoryDecoder ? useMemoryDecoder.checked : false;
    const introPath = (document.getElementById('reels-intro-path') || {}).value || '';
    let failCount = 0;
    let okCount = 0;
    let canceled = false;
    const failDetails = [];
    const outputDirRaw = String(outputDir || '');
    const outputDirBase = outputDirRaw.replace(/[\\/]+$/, '') || outputDirRaw;
    const outputJoinSep = outputDirBase.includes('\\') ? '\\' : '/';

    // 自动创建带日期的子文件夹，如 "2026-03-02_批量Reels"
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const subFolderName = `${dateStr}_${timeStr}_批量Reels`;
    const outputDirTrimmed = `${outputDirBase}${outputJoinSep}${subFolderName}`;

    const concurrencyInput = document.getElementById('reels-export-concurrency');
    const concurrency = concurrencyInput ? Math.max(1, parseInt(concurrencyInput.value) || 1) : 1;

    // ═══ 多模板矩阵展开 ═══
    const multiPresetCfg = _getMultiPresetConfig();
    const exportJobs = [];
    if (multiPresetCfg) {
        // 矩阵模式：tasks × presets
        for (const task of tasks) {
            for (const presetName of multiPresetCfg.presets) {
                exportJobs.push({ task, presetName, naming: multiPresetCfg.naming });
            }
        }
        console.log(`[Reels] 多模板矩阵导出: ${tasks.length} 任务 × ${multiPresetCfg.presets.length} 模板 = ${exportJobs.length} 个视频`);
    } else {
        // 常规模式：每任务一个 job
        for (const task of tasks) {
            exportJobs.push({ task, presetName: null, naming: null });
        }
    }
    const totalJobs = exportJobs.length;

    // ── 矩阵模式确认 ──
    if (multiPresetCfg && totalJobs > tasks.length) {
        const ok = confirm(`🎭 多模板矩阵导出\n\n${tasks.length} 个任务 × ${multiPresetCfg.presets.length} 个覆层预设 = ${totalJobs} 个视频\n\n已选模板: ${multiPresetCfg.presets.join(', ')}\n命名方式: ${multiPresetCfg.naming === 'folder' ? '按模板分目录' : '平铺命名'}\n\n确认开始导出？`);
        if (!ok) {
            if (exportBtn) { exportBtn.disabled = false; exportBtn.innerHTML = '🚀 开始导出'; }
            _reelsState.isExporting = false;
            return;
        }
    }

    _reelsUpdateExportProgressUI(0, totalJobs);

    // ═══ 文件名去重：行号 + 冲突检测 ═══
    const _exportResolvedNames = {};
    {
        // 先给每个任务加上行号
        const namedWithRow = exportJobs.map((job, idx) => {
            if (namingMode === 'index') {
                const prefix = localStorage.getItem('reels_naming_prefix') || '';
                const suffixVal = localStorage.getItem('reels_naming_suffix') || '';
                return `${prefix}${idx + 1}${suffixVal}`;
            }
            if (namingMode === 'date-auto') {
                const startDateStr = localStorage.getItem('reels_naming_start_date') || '';
                const vidsPerDay = parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3;
                const prefix = localStorage.getItem('reels_naming_prefix') || '';
                const suffixVal = localStorage.getItem('reels_naming_suffix') || '';

                let startDate = new Date();
                startDate.setDate(startDate.getDate() + 1);
                if (startDateStr) {
                    const cleanDate = startDateStr.replace(/-/g, '');
                    if (cleanDate.length === 8) {
                        const y = parseInt(cleanDate.substring(0, 4));
                        const m = parseInt(cleanDate.substring(4, 6)) - 1;
                        const d = parseInt(cleanDate.substring(6, 8));
                        startDate = new Date(y, m, d);
                    } else {
                        const parsed = Date.parse(startDateStr);
                        if (!isNaN(parsed)) startDate = new Date(parsed);
                    }
                }
                const dayOffset = Math.floor(idx / vidsPerDay);
                const seq = (idx % vidsPerDay) + 1;
                const targetDate = new Date(startDate.getTime());
                targetDate.setDate(startDate.getDate() + dayOffset);

                const yyyy = targetDate.getFullYear();
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
                const dd = String(targetDate.getDate()).padStart(2, '0');
                const dateFormatted = `${yyyy}${mm}${dd}`;

                return `${prefix}${dateFormatted}-${seq}${suffixVal}`;
            }

            const raw = _resolveReelsExportBaseName(job.task, namingMode);
            return `${raw}_行${idx + 1}`;
        });
        // 再检测加完行号后是否仍有重名（极端情况），追加编号
        const freq = {};
        namedWithRow.forEach(n => freq[n] = (freq[n] || 0) + 1);
        const counter = {};
        namedWithRow.forEach((n, idx) => {
            if (freq[n] > 1) {
                counter[n] = (counter[n] || 0) + 1;
                _exportResolvedNames[idx] = `${n}_${counter[n]}`;
            } else {
                _exportResolvedNames[idx] = n;
            }
        });
    }

    let currentIndex = 0;
    const processNext = async () => {
        while (currentIndex < totalJobs) {
            if (!_reelsState.isExporting) {
                canceled = true;
                break;
            }
            const i = currentIndex++;
            const job = exportJobs[i];
            const task = job.task;
            const tw = _reelsState.targetWidth || 1080;
            const th = _reelsState.targetHeight || 1920;

            // ── 多模板模式：临时覆盖 task.overlays ──
            let originalOverlays = null;
            if (job.presetName) {
                originalOverlays = task.overlays ? [...task.overlays] : [];
                const tempTask = _cloneTaskWithPreset(task, job.presetName);
                task.overlays = tempTask.overlays;
            }

        const taskStyle = _resolveSubtitleStyleForTask(task);
        const presetLabel = job.presetName ? ` [${job.presetName}]` : '';

        // ── 确保当前任务的所有覆层与字幕使用的字体全部预加载完成 ──
        if (statusEl) statusEl.textContent = `加载字体中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
        const fontsToLoad = new Set();
        if (taskStyle && taskStyle.font_family) {
            fontsToLoad.add(taskStyle.font_family);
        }
        const collectOverlaysFonts = (ovs) => {
            if (!Array.isArray(ovs)) return;
            for (const ov of ovs) {
                if (ov.disabled) continue;
                if (ov.type === 'textcard' || !ov.type || ov.type === '') {
                    if (ov.title_text && ov.title_font_family) fontsToLoad.add(ov.title_font_family);
                    if (ov.body_text && ov.body_font_family) fontsToLoad.add(ov.body_font_family);
                    if (ov.footer_text && ov.footer_font_family) fontsToLoad.add(ov.footer_font_family);
                } else if (ov.type === 'text' || ov.type === 'scroll') {
                    if (ov.font_family) fontsToLoad.add(ov.font_family);
                }
            }
        };
        collectOverlaysFonts(task.overlays);
        if (task.cover && task.cover.enabled) {
            collectOverlaysFonts(task.cover.overlays);
        }
        if (window.getFontManager && fontsToLoad.size > 0) {
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
                console.log(`[Export Font Load] Fonts loaded successfully:`, Array.from(fontsToLoad));
            } catch (e) {
                console.warn(`[Export Font Load] document.fonts.ready error:`, e);
            }
        }

        if (statusEl) statusEl.textContent = `导出中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;

        try {
            let baseName = _exportResolvedNames[i] || _resolveReelsExportBaseName(task, namingMode);

            // ── 多模板矩阵：调整输出路径 ──
            let jobOutputDir = outputDirTrimmed;
            let jobBaseName = baseName;
            if (job.presetName) {
                const safePresetName = job.presetName.replace(/[<>:"/\\|?*]+/g, '_');
                if (job.naming === 'folder') {
                    // 按模板分目录
                    jobOutputDir = `${outputDirTrimmed}${outputJoinSep}${safePresetName}`;
                } else {
                    // 平铺命名
                    jobBaseName = `${baseName}_${safePresetName}`;
                }
            }
            const outputPath = `${jobOutputDir}${outputJoinSep}${jobBaseName}${suffix}.mp4`;
            if (window.electronAPI && window.electronAPI.ensureDirectory) {
                const dirResult = await window.electronAPI.ensureDirectory(jobOutputDir);
                if (dirResult && dirResult.ok === false) {
                    throw new Error(`创建输出目录失败: ${dirResult.error || jobOutputDir}`);
                }
            }
            let bgPath = task.bgPath || task.videoPath;
            
            // ── 路径修复：如果 bgPath 仅为文件名（非绝对路径），尝试自动补全 ──
            if (bgPath && !bgPath.startsWith('/') && !/^[A-Z]:\\/i.test(bgPath)) {
                const bareFileName = bgPath.replace(/\\/g, '/').split('/').pop();
                let fixedPath = null;
                
                // 策略1: 从背景素材库中找同名文件的完整路径
                const library = _reelsState.backgroundLibrary || [];
                for (const bg of library) {
                    if (bg.path && (bg.path.startsWith('/') || /^[A-Z]:\\/i.test(bg.path))) {
                        const libName = bg.path.replace(/\\/g, '/').split('/').pop();
                        if (libName === bareFileName) { fixedPath = bg.path; break; }
                    }
                }
                
                // 策略2: 从其他任务中找同文件名的绝对路径
                if (!fixedPath) {
                    for (const t of _reelsState.tasks) {
                        const p = t.bgPath || t.videoPath;
                        if (p && (p.startsWith('/') || /^[A-Z]:\\/i.test(p))) {
                            const tName = p.replace(/\\/g, '/').split('/').pop();
                            if (tName === bareFileName) { fixedPath = p; break; }
                        }
                    }
                }
                
                // 策略3: 如果找到了任何绝对路径的任务，取其目录 + 当前文件名
                if (!fixedPath) {
                    for (const t of _reelsState.tasks) {
                        const p = t.bgPath || t.videoPath;
                        if (p && (p.startsWith('/') || /^[A-Z]:\\/i.test(p))) {
                            const dir = p.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
                            fixedPath = `${dir}/${bareFileName}`;
                            break;
                        }
                    }
                }
                
                // 策略4: 从批量表格的素材文件夹 materialDir 中搜索
                if (!fixedPath && typeof _batchTableState !== 'undefined' && _batchTableState.tabs) {
                    const activeTab = (typeof _getActiveTab === 'function')
                        ? _getActiveTab()
                        : (_batchTableState.tabs.find(t => t.id === _batchTableState.activeTabId) || _batchTableState.tabs[0]);
                    const matDir = activeTab?.materialDir;
                    if (matDir) {
                        // 拼接 materialDir + bareFileName
                        const candidate = matDir.replace(/\\/g, '/').replace(/\/$/, '') + '/' + bareFileName;
                        fixedPath = candidate;
                        console.log(`[Reels] 策略4: 尝试素材文件夹路径: "${fixedPath}"`);
                    }
                }
                
                // 策略5: 从输出目录的父级目录搜索
                if (!fixedPath && outputDirTrimmed) {
                    const parentDir = outputDirTrimmed.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
                    if (parentDir) {
                        fixedPath = parentDir + '/' + bareFileName;
                        console.log(`[Reels] 策略5: 尝试输出目录同级路径: "${fixedPath}"`);
                    }
                }
                
                if (fixedPath) {
                    console.warn(`[Reels] 自动修复 bgPath: "${bgPath}" → "${fixedPath}"`);
                    bgPath = fixedPath;
                    task.bgPath = fixedPath;
                    task.videoPath = fixedPath;
                } else {
                    console.error(`[Reels] bgPath 不是绝对路径且无法自动修复: "${bgPath}"`);
                }
            }
            
            const hasVoiceAudio = !!task.audioPath || workMode === 'voiced_bg';
            // For voiced_bg mode, use the background video's audio track as the voice source
            const voiceSource = task.audioPath || (workMode === 'voiced_bg' ? bgPath : null);
            const effectiveAudioDurScale = (workMode === 'voiced_bg' && !task.audioPath)
                ? (task.bgDurScale || task.audioDurScale || 100)
                : (task.audioDurScale || 100);
            let finalOutputPath = outputPath;

            // ── 读取导出格式 ──
            const exportFormat = (document.getElementById('reels-export-format') || {}).value || 'mp4';
            const doPng = exportFormat === 'png-layers' || exportFormat === 'mp4+png';
            const doMp4 = exportFormat === 'mp4' || exportFormat === 'mp4+png';
            const doFcpxml = exportFormat === 'fcpxml' || exportFormat === 'fcpxml-compound';
            
            const subtitleToggle = document.getElementById('reels-subtitle-toggle');
            const showSubtitle = !subtitleToggle || subtitleToggle.checked;

            // ── 封面静帧单独输出 ──
            if (task.cover && task.cover.enabled !== false && task.cover.exportSeparate !== false) {
                 await _exportSaveCoverPng(task, outputDirTrimmed, baseName);
            }

            // ── 封面视频拼接输出 ──
            let coverMp4Path = null;
            if (task.cover && task.cover.enabled !== false && doMp4 && parseFloat(task.cover.duration || 0) > 0) {
                 coverMp4Path = await _exportCoverVideo(task, taskStyle, outputDirTrimmed, baseName);
            }

            // ═══ PNG 分层序列导出 ═══
            if (doPng && typeof window.reelsLayeredExport === 'function') {
                const tw = _reelsState.targetWidth || 1080;
                const th = _reelsState.targetHeight || 1920;
                const offCanvas = document.createElement('canvas');
                offCanvas.width = tw;
                offCanvas.height = th;

                const layeredResult = await window.reelsLayeredExport({
                    canvas: offCanvas,
                    style: taskStyle,
                    segments: task.segments || [],
                    originalScript: task.ttsText || task.aiScript || task.txtContent || "",
                    showSubtitle: showSubtitle,
                    overlays: task.overlays || [],
                    backgroundPath: bgPath,
                    bgMode: task.bgMode || 'single',
                    bgClipPool: _getEffectiveBgClipPool(task),
                    bgClipSettings: task.bgClipSettings || {},
                    bgMinClipDur: task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5,
                    bgMaxClipDur: task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7,
                    bgClipOrder: task.bgClipOrder || 'random',
                    bgClipSeed: task.id || task.fileName || '',
                    bgTransition: task.bgTransition || 'crossfade',
                    bgTransDur: task.bgTransDur || 0.5,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    contentVideoScale: task.contentVideoScale || 100,
                    contentVideoX: task.contentVideoX || 'center',
                    contentVideoY: task.contentVideoY || 'center',
                    contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                    contentVideoCrop: task.contentVideoCrop || '',
                    contentVideoBlurBg: task.contentVideoBlurBg || false,
                    contentVideoDirectBg: task.contentVideoDirectBg || false,
                    contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                    contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                    voicePath: voiceSource || null,
                    outputDir: outputDirTrimmed,
                    taskName: baseName,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30,

                    voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    loopFade,
                    loopFadeDur,
                    customDuration: task.customDuration || customDuration || 0,
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                    bgScale: task.bgScale || 100,
                    bgX: task.bgX || 0,
                    bgY: task.bgY || 0,
                    bgFlipH: task.bgFlipH || false,
                    bgFlipV: task.bgFlipV || false,
                    contentVideoFlipH: task.contentVideoFlipH || false,
                    contentVideoFlipV: task.contentVideoFlipV || false,
                    bgDurScale: task.bgDurScale || 100,
                    audioDurScale: task.audioDurScale || 100,
                    isCancelled: () => !_reelsState.isExporting,
                    onProgress: (pct) => {
                        if (statusEl) statusEl.textContent = `分层导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${pct}%)`;
                        const progressInner = document.getElementById('reels-export-progress-inner');
                        const progressText = document.getElementById('reels-export-progress-text');
                        const blended = ((i + pct / 100) / totalJobs) * 100;
                        const blendedPct = Math.round(blended);
                        if (progressInner) progressInner.style.width = `${blendedPct}%`;
                        if (progressText) progressText.textContent = `${blendedPct}% (${i}/${totalJobs})`;
                    },
                    onLog: (msg) => console.log(`[Layered] ${task.fileName}: ${msg}`),
                });
                if (layeredResult && layeredResult.cancelled) {
                    canceled = true;
                    break;
                }
                finalOutputPath = layeredResult?.layersDir || outputDirTrimmed;
            }

            // ═══ FCPXML 导出收集 ═══
            if (doFcpxml) {
                // ── 渲染覆层为透明 PNG ──
                let overlayPngPath = null;
                let overlayPngSlices = null; // 时间切片多 PNG 模式
                const taskOverlays = task.overlays || [];
                let hasTimeSlice = task.subtitleTimeMode === 'split' && Array.isArray(task.subtitleTimeSlices) && task.subtitleTimeSlices.length > 0;

                // B 版自动拆分：标题 0~10s，正文 10s~ (通过 AB 批量创建时的 _version 标记识别)
                const isBVersion = task._version === 'B';
                // B 版强制覆盖切片: 已有切片可能是旧数据(source 为 'all')，强制替换为 title/body
                const needsBSlice = isBVersion && taskOverlays.some(o => !o.disabled && (o.type === 'textcard' || !o.type));
                if (needsBSlice) {
                    const bOverlaySplit = 10;
                    task.subtitleTimeSlices = [
                        { label: '标题', source: 'title', startSec: 0, endSec: bOverlaySplit },
                        { label: '正文', source: 'body', startSec: bOverlaySplit, endSec: null },
                    ];
                    task.subtitleTimeMode = 'split';
                    hasTimeSlice = true;
                }

                if (taskOverlays.length > 0 && taskOverlays.some(o => !o.disabled)) {
                    const tw = _reelsState.targetWidth || 1080;
                    const th = _reelsState.targetHeight || 1920;
                    if (hasTimeSlice) {
                        // ⏱️ 时间切片模式：为每个切片生成独立的 PNG
                        overlayPngSlices = [];
                        for (let sliceIdx = 0; sliceIdx < task.subtitleTimeSlices.length; sliceIdx++) {
                            const slice = task.subtitleTimeSlices[sliceIdx];
                            const source = slice.source || 'all';
                            try {
                                const offCanvas = document.createElement('canvas');
                                offCanvas.width = tw;
                                offCanvas.height = th;
                                const offCtx = offCanvas.getContext('2d');
                                offCtx.clearRect(0, 0, tw, th);
                                if (window.ReelsOverlay && typeof window.ReelsOverlay.drawOverlay === 'function') {
                                    // ── 时间切片渲染: 整体控制所有覆层的文字字段 ──
                                    // 保存所有覆层的原始文字字段
                                    const savedFields = taskOverlays.map(ov => ({
                                        title_text: ov.title_text,
                                        body_text: ov.body_text,
                                        footer_text: ov.footer_text,
                                        content: ov.content,
                                        disabled: ov.disabled,
                                    }));

                                    try {
                                        for (const ov of taskOverlays) {
                                            const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                            if (isCard) {
                                                ov._original_title_text = ov.title_text;
                                                ov._original_body_text = ov.body_text;
                                                ov._original_footer_text = ov.footer_text;
                                            }
                                            ov._fcpxml_generating = true;
                                        }

                                        if (source === 'title') {
                                            // 标题模式: 只保留第一个有 title_text 的 textcard 的标题，纯色蒙版作为背景保留
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                const isSolidMask = ov.type === 'solid_mask';
                                                if (isCard) {
                                                    ov.body_text = '';
                                                    ov.footer_text = '';
                                                    if (!ov.title_text) ov.disabled = true;
                                                } else if (isSolidMask) {
                                                    // 保持纯色蒙版启用
                                                } else {
                                                    ov.disabled = true; // 标题模式不渲染非卡片覆层
                                                }
                                            }
                                        } else if (source === 'body') {
                                            // 正文模式: 清空所有 textcard 的标题, 保留正文+结尾+其他覆层
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard) {
                                                    ov.title_text = '';
                                                }
                                            }
                                        } else if (source === 'body_part1') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard && ov.body_text) {
                                                    ov.body_text = window.ReelsOverlay?.splitBodyText ? window.ReelsOverlay.splitBodyText(ov.body_text)[0] : ov.body_text;
                                                }
                                            }
                                        } else if (source === 'body_part2') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard && ov.body_text) {
                                                    ov.body_text = window.ReelsOverlay?.splitBodyText ? window.ReelsOverlay.splitBodyText(ov.body_text)[1] : ov.body_text;
                                                }
                                            }
                                        } else if (source === 'footer') {
                                            for (const ov of taskOverlays) {
                                                const isCard = !ov.type || ov.type === '' || ov.type === 'textcard';
                                                if (isCard) { ov.title_text = ''; ov.body_text = ''; }
                                            }
                                        }
                                        // scroll source 类型保持不变

                                        // 统一渲染所有未禁用的覆层
                                        for (const ov of taskOverlays) {
                                            if (ov.disabled) continue;
                                            if (source === 'scroll_title' && ov.type !== 'scroll') continue;
                                            if (source === 'scroll_body' && ov.type !== 'scroll') continue;
                                            ov._exporting = true;
                                            window.ReelsOverlay.drawOverlay(offCtx, ov, 0, tw, th);
                                            delete ov._exporting;
                                        }
                                    } finally {
                                        // 恢复所有覆层的原始字段
                                        taskOverlays.forEach((ov, idx) => {
                                            ov.title_text = savedFields[idx].title_text;
                                            ov.body_text = savedFields[idx].body_text;
                                            ov.footer_text = savedFields[idx].footer_text;
                                            ov.content = savedFields[idx].content;
                                            ov.disabled = savedFields[idx].disabled;
                                            delete ov._original_title_text;
                                            delete ov._original_body_text;
                                            delete ov._original_footer_text;
                                            delete ov._fcpxml_generating;
                                        });
                                    }
                                }
                                const pngDataUrl = offCanvas.toDataURL('image/png');
                                const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
                                const binaryStr = atob(pngBase64);
                                const pngBytes = new Uint8Array(binaryStr.length);
                                for (let b = 0; b < binaryStr.length; b++) pngBytes[b] = binaryStr.charCodeAt(b);

                                const sliceLabel = slice.label || String.fromCharCode(65 + sliceIdx);
                                const pngFileName = `${baseName}_overlay_${sliceLabel}.png`;
                                const pngPath = `${outputDirTrimmed}/${pngFileName}`;
                                if (window.electronAPI && window.electronAPI.ensureDirectory) {
                                    await window.electronAPI.ensureDirectory(outputDirTrimmed);
                                }
                                if (window.electronAPI && window.electronAPI.savePngFrame) {
                                    const saveResult = await window.electronAPI.savePngFrame({
                                        outputPath: pngPath,
                                        rawRGBA: pngBytes.buffer,
                                        width: tw,
                                        height: th,
                                        isPng: true
                                    });
                                    if (saveResult && saveResult.ok) {
                                        overlayPngSlices.push({
                                            path: pngPath,
                                            startSec: slice.startSec || 0,
                                            endSec: slice.endSec,
                                            label: sliceLabel,
                                        });
                                        console.log(`[FCPXML] 切片 ${sliceLabel} PNG 已导出: ${pngPath}`);
                                    }
                                }
                            } catch (e) {
                                console.warn(`[FCPXML] 渲染切片 ${sliceIdx} PNG 失败:`, e);
                            }
                        }
                    } else {
                        // 常规模式：单张 PNG
                    try {
                        const offCanvas = document.createElement('canvas');
                        offCanvas.width = tw;
                        offCanvas.height = th;
                        const offCtx = offCanvas.getContext('2d');
                        offCtx.clearRect(0, 0, tw, th);
                        if (window.ReelsOverlay && typeof window.ReelsOverlay.drawOverlay === 'function') {
                            for (const ov of taskOverlays) {
                                if (ov.disabled) continue;
                                ov._exporting = true;
                                window.ReelsOverlay.drawOverlay(offCtx, ov, 0, tw, th);
                                delete ov._exporting;
                            }
                        }
                        const pngDataUrl = offCanvas.toDataURL('image/png');
                        const pngBase64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
                        const binaryStr = atob(pngBase64);
                        const pngBytes = new Uint8Array(binaryStr.length);
                        for (let b = 0; b < binaryStr.length; b++) pngBytes[b] = binaryStr.charCodeAt(b);

                        const pngFileName = `${baseName}_overlay.png`;
                        const pngPath = `${outputDirTrimmed}/${pngFileName}`;
                        if (window.electronAPI && window.electronAPI.ensureDirectory) {
                            await window.electronAPI.ensureDirectory(outputDirTrimmed);
                        }
                        if (window.electronAPI && window.electronAPI.savePngFrame) {
                            const saveResult = await window.electronAPI.savePngFrame({
                                outputPath: pngPath,
                                rawRGBA: pngBytes.buffer,
                                width: tw,
                                height: th,
                                isPng: true
                            });
                            if (saveResult && saveResult.ok) {
                                overlayPngPath = pngPath;
                                console.log(`[FCPXML] 覆层 PNG 已导出: ${pngPath}`);
                            } else {
                                console.warn('[FCPXML] 覆层 PNG 保存失败:', saveResult?.error);
                            }
                        }
                    } catch (e) {
                        console.warn('[FCPXML] 渲染覆层 PNG 失败:', e);
                    }
                    }
                }

                fcpxmlBatchTasks.push({
                    task,
                    style: taskStyle,
                    segments: showSubtitle ? (task.segments || []) : [],
                    overlays: task.overlays || [],
                    overlayPngPath: overlayPngPath,  // 单张 PNG（常规模式）
                    overlayPngSlices: overlayPngSlices, // 多张 PNG（时间切片模式）
                    videoPath: task.videoPath || null,
                    backgroundPath: bgPath,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    voicePath: voiceSource || null,
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    customDuration: task.customDuration || customDuration || 0,
                    taskName: baseName,
                    subtitleTimeMode: task.subtitleTimeMode || 'full',
                    subtitleTimeSlices: task.subtitleTimeSlices || [],
                });
                okCount += 1;
                // 更新进度并进入下一个
                _reelsUpdateExportProgressUI(okCount + failCount, totalJobs);
                const pct = 100;
                if (statusEl) statusEl.textContent = `FCPXML整理数据 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel}`;
                const progressInner = document.getElementById('reels-export-progress-inner');
                const progressText = document.getElementById('reels-export-progress-text');
                const blended = ((i + pct / 100) / totalJobs) * 100;
                const blendedPct = Math.round(blended);
                if (progressInner) progressInner.style.width = `${blendedPct}%`;
                if (progressText) progressText.textContent = `${blendedPct}% (${i}/${totalJobs})`;
                continue;
            }

            // ═══ MP4 视频导出（WYSIWYG）═══
            if (doMp4 && (typeof window.reelsWysiwygExport === 'function')
                && window.electronAPI && window.electronAPI.reelsComposeWysiwyg) {
                // 创建离屏 canvas
                const tw = _reelsState.targetWidth || 1080;
                const th = _reelsState.targetHeight || 1920;
                const offCanvas = document.createElement('canvas');
                offCanvas.width = tw;
                offCanvas.height = th;

                // ═══ V3 并行影子窗口检测 ═══
                const cpuCores = navigator.hardwareConcurrency || 4;
                const parallelConcurrency = Math.min(3, Math.max(1, Math.floor(cpuCores / 2)));
                let estimatedDuration = 0;
                try {
                    let maxFlipperDuration = 0;
                    if (task && Array.isArray(task.overlays)) {
                        for (const ov of task.overlays) {
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
                        estimatedDuration = maxFlipperDuration;
                    } else if (task.customDuration > 0) {
                        estimatedDuration = task.customDuration;
                    } else if ((task.audioPath || voiceSource) && window.electronAPI.getMediaDuration) {
                        estimatedDuration = await window.electronAPI.getMediaDuration(task.audioPath || voiceSource);
                    }
                    if (!estimatedDuration) {
                        if (task.contentVideoDirectBg && task.contentVideoPath) {
                            let cvDur = await window.electronAPI.getMediaDuration(task.contentVideoPath);
                            if (cvDur > 0) {
                                const trimS = task.contentVideoTrimStart != null ? parseFloat(task.contentVideoTrimStart) : 0;
                                const trimE = task.contentVideoTrimEnd != null ? parseFloat(task.contentVideoTrimEnd) : 0;
                                if (trimE > trimS) {
                                    cvDur = trimE - trimS;
                                } else if (trimS > 0) {
                                    cvDur = Math.max(0, cvDur - trimS);
                                }
                                estimatedDuration = cvDur;
                            }
                        } else if (bgPath) {
                            estimatedDuration = await window.electronAPI.getMediaDuration(bgPath);
                        }
                    }
                } catch(_) {}
                const estimatedFrames = Math.ceil((estimatedDuration || 0) * 30);
                const hasVideoOverlays = Array.isArray(task.overlays) && task.overlays.some(ov => ov && ov.type === 'video' && !ov.disabled);
                const hasContentVideo = !!task.contentVideoPath;
                let contentVideoIsDirSequence = false;
                const cvPathForCheck = _normalizeLocalMediaPath(task.contentVideoPath || '');
                if (cvPathForCheck && window.require) {
                    try {
                        const fs = window.require('fs');
                        contentVideoIsDirSequence = fs.existsSync(cvPathForCheck) && fs.statSync(cvPathForCheck).isDirectory();
                    } catch (_) { }
                }
                // 并行影子窗口在视频逐帧 seek 尚未完成时可能写入上一帧，成片会出现跳帧/抖动。
                // 在有可靠的逐帧解码同步方案前，绝不能将它用于正式导出；保留实现供后续修复验证，
                // 默认始终走已验证的单线程逐帧导出路径，优先保证帧完整和时间连续。
                const parallelExportEnabled = false;
                const shouldParallel = parallelExportEnabled
                    && memoryDecoderEnabled
                    // 任务级并发时已经会并行。影子窗口切片使用全局 IPC 事件，
                    // 为防止两个任务的同编号切片互相串结果，仅在单任务导出时开启切片并行。
                    && concurrency === 1
                    && parallelConcurrency >= 2
                    && estimatedDuration >= 10
                    && _getEffectiveBgClipPool(task).length === 0
                    && !hasVideoOverlays
                    && !hasContentVideo
                    && !contentVideoIsDirSequence
                    && window.electronAPI.parallelWysiwygExport;

                let wysiwygDone = false;
                if (shouldParallel) {
                    console.log(`[V3] 启动并行渲染: ${parallelConcurrency} 路, ${estimatedDuration.toFixed(1)}s, ${estimatedFrames} 帧`);
                    if (statusEl) statusEl.textContent = `🚀并行导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (启动中...)`;
                    const unsubProgress = window.electronAPI.onParallelProgress((data) => {
                        if (statusEl) statusEl.textContent = `🚀并行导出 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${data.pct || 0}%)`;
                    });
                    try {
                        const parallelResult = await window.electronAPI.parallelWysiwygExport({
                            params: {
                                style: taskStyle,
                                segments: showSubtitle ? (task.segments || []) : [],
                                overlays: task.overlays || [],
                                backgroundPath: bgPath,
                                bgMode: task.bgMode || 'single',
                                bgScale: task.bgScale || 100,
                                bgX: task.bgX || 0,
                                bgY: task.bgY || 0,
                                contentVideoPath: task.contentVideoPath || null,
                                contentVideoTrimStart: task.contentVideoTrimStart,
                                contentVideoTrimEnd: task.contentVideoTrimEnd,
                                contentVideoScale: task.contentVideoScale || 100,
                                contentVideoX: task.contentVideoX || 'center',
                                contentVideoY: task.contentVideoY || 'center',
                                contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                                contentVideoCrop: task.contentVideoCrop || '',
                                contentVideoBlurBg: task.contentVideoBlurBg || false,
                                contentVideoDirectBg: task.contentVideoDirectBg || false,
                                contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                                contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                                voicePath: voiceSource || null,
                                targetWidth: tw, targetHeight: th, fps: 30,
                                voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                                bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                                loopFade, loopFadeDur,
                                bgmPath: _getEffectiveBgmPath(task, i) || '',
                                bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                                bgDurScale: task.bgDurScale || 100,
                                audioDurScale: effectiveAudioDurScale,
                                reverbEnabled: _getReverbConfig().enabled,
                                reverbPreset: _getReverbConfig().preset,
                                reverbMix: _getReverbConfig().mix,
                                stereoWidth: _getReverbConfig().stereoWidth,
                                audioFxTarget: _getReverbConfig().audioFxTarget,
                                bgHasAudio: bgPath && !_isImageFile(bgPath) && !(voiceSource && voiceSource === bgPath),
                                qualityPreset, crf,
                            },
                            outputPath,
                            concurrency: parallelConcurrency,
                            totalFrames: estimatedFrames,
                            duration: estimatedDuration,
                        });
                        unsubProgress();
                        if (!parallelResult || parallelResult.error) throw new Error(parallelResult?.error || '并行导出失败');
                        console.log(`[V3] 并行导出成功: ${parallelResult.output_path}`);
                        wysiwygDone = true;
                    } catch (parallelErr) {
                        unsubProgress();
                        console.warn(`[V3] 并行导出失败，回退单线程: ${parallelErr.message}`);
                    }
                } else if (memoryDecoderEnabled) {
                    console.log(`[V3] 跳过切片并行，回退稳定渲染: enabled=${parallelExportEnabled}, taskConcurrency=${concurrency}, duration=${estimatedDuration.toFixed(1)}, overlayVideo=${hasVideoOverlays}, contentVideo=${hasContentVideo}, contentDirSeq=${contentVideoIsDirSequence}`);
                }

                // ═══ Fast Alpha Overlay 检测 ═══
                const fastAlphaCb = document.getElementById('reels-fast-alpha-mode');
                const fastAlphaEnabled = fastAlphaCb ? fastAlphaCb.checked : false;
                const isBgVideo = bgPath && !_isImageFile(bgPath);
                const canUseAlpha = fastAlphaEnabled 
                    && bgPath 
                    && Math.abs((task.bgDurScale || 100) - 100) < 0.01
                    && _getEffectiveBgClipPool(task).length === 0
                    && (!task.bgMode || task.bgMode === 'single')
                    && !(isBgVideo && loopFade); // 如果是视频且开启了首尾过渡转场，回退稳定模式

                // ═══ V2 单线程 WYSIWYG 导出（兜底 / 常规路径）═══
                if (!wysiwygDone) {
                const wysiwygResult = await window.reelsWysiwygExport({
                    canvas: offCanvas,
                    style: taskStyle,
                    segments: task.segments || [],
                    originalScript: task.ttsText || task.aiScript || task.txtContent || "",
                    showSubtitle: showSubtitle,
                    overlays: task.overlays || [],
                    backgroundPath: bgPath,
                    alphaOverlayBgPath: canUseAlpha ? bgPath : null,
                    bgMode: task.bgMode || 'single',
                    bgClipPool: _getEffectiveBgClipPool(task),
                    bgClipSettings: task.bgClipSettings || {},
                    bgMinClipDur: task.bgMinClipDur !== undefined ? task.bgMinClipDur : 5,
                    bgMaxClipDur: task.bgMaxClipDur !== undefined ? task.bgMaxClipDur : 7,
                    bgClipOrder: task.bgClipOrder || 'random',
                    bgClipSeed: task.id || task.fileName || '',
                    bgTransition: task.bgTransition || 'crossfade',
                    bgTransDur: task.bgTransDur || 0.5,
                    contentVideoPath: task.contentVideoPath || null,
                    contentVideoTrimStart: task.contentVideoTrimStart != null ? task.contentVideoTrimStart : null,
                    contentVideoTrimEnd: task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : null,
                    contentVideoScale: task.contentVideoScale || 100,
                    contentVideoX: task.contentVideoX || 'center',
                    contentVideoY: task.contentVideoY || 'center',
                    contentVideoVolume: (task.contentVideoVolume != null ? task.contentVideoVolume : 100) / 100,
                    contentVideoCrop: task.contentVideoCrop || '',
                    contentVideoBlurBg: task.contentVideoBlurBg || false,
                    contentVideoDirectBg: task.contentVideoDirectBg || false,
                    contentVideoBlur: task.contentVideoBlur != null ? task.contentVideoBlur : 40,
                    contentVideoBrightness: task.contentVideoBrightness != null ? task.contentVideoBrightness : 60,
                    voicePath: voiceSource || null,
                    outputPath,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30,
                    // voiced_bg 模式: 背景音频作为主音轨，用 bgVolume 控制
                    voiceVolume: (workMode === 'voiced_bg' && !task.audioPath) ? _getEffectiveBgVolumePercent(task, bgVolume) / 100 : _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bgVolume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    loopFade,
                    loopFadeDur,
                    customDuration: task.customDuration || customDuration || 0,
                    bgmPath: _getEffectiveBgmPath(task, i) || '',
                    bgmVolume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                    bgScale: task.bgScale || 100,
                    bgX: task.bgX || 0,
                    bgY: task.bgY || 0,
                    bgFlipH: task.bgFlipH || false,
                    bgFlipV: task.bgFlipV || false,
                    contentVideoFlipH: task.contentVideoFlipH || false,
                    contentVideoFlipV: task.contentVideoFlipV || false,
                    bgDurScale: task.bgDurScale || 100,
                    audioDurScale: effectiveAudioDurScale,
                    reverbEnabled: (() => { const rc = _getReverbConfig(); console.log('[Export] Reverb config:', JSON.stringify(rc)); return rc.enabled; })(),
                    reverbPreset: _getReverbConfig().preset,
                    reverbMix: _getReverbConfig().mix,
                    stereoWidth: _getReverbConfig().stereoWidth,
                    audioFxTarget: _getReverbConfig().audioFxTarget,
                    useMemoryDecoder: memoryDecoderEnabled,
                    useGPU: gpuEnabled,
                    crf,
                    qualityPreset,
                    isCancelled: () => !_reelsState.isExporting,
                    onProgress: (pct) => {
                        if (statusEl) statusEl.textContent = `导出中 ${i + 1}/${totalJobs}: ${task.fileName}${presetLabel} (${pct}%)`;
                        const progressInner = document.getElementById('reels-export-progress-inner');
                        const progressText = document.getElementById('reels-export-progress-text');
                        const blended = ((i + pct / 100) / totalJobs) * 100;
                        const blendedPct = Math.round(blended);
                        if (progressInner) progressInner.style.width = `${blendedPct}%`;
                        if (progressText) progressText.textContent = `${blendedPct}% (${i}/${totalJobs})`;
                    },
                    onLog: (msg) => console.log(`[WYSIWYG] ${task.fileName}: ${msg}`),
                });
                if (wysiwygResult && wysiwygResult.cancelled) {
                    canceled = true;
                    break;
                }
                } // end if (!wysiwygDone)
            } else if (hasVoiceAudio && voiceSource) {
                // ── 回退: ASS 字幕方式导出（需要配音）──
                const aDurScale = task.audioDurScale || 100;
                const factor = aDurScale / 100;
                const scaledSegments = (factor !== 1.0 && task.segments) 
                    ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
                    : task.segments;

                const assContent = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.generateEnhancedASS(scaledSegments, taskStyle, {
                        karaokeHighlight: karaokeHL,
                        videoW: tw,
                        videoH: th,
                    })
                    : generateASS(task.segments, taskStyle);

                const resp = await _reelsComposeViaBackend({
                    background_path: bgPath,
                    voice_path: voiceSource,
                    ass_content: assContent,
                    output_path: outputPath,
                    crf,
                    use_gpu: gpuEnabled,
                    loop_fade: loopFade,
                    loop_fade_dur: loopFadeDur,
                    voice_volume: _getEffectiveVoiceVolumePercent(task, voiceVolume) / 100,
                    bg_volume: _getEffectiveBgVolumePercent(task, bgVolume) / 100,
                    bgm_path: _getEffectiveBgmPath(task, i) || '',
                    bgm_volume: _getEffectiveBgmVolumePercent(task, bgmVolume) / 100,
                });
            } else if (window.electronAPI && window.electronAPI.burnSubtitles) {
                const aDurScale = task.audioDurScale || 100;
                const factor = aDurScale / 100;
                const scaledSegments = (factor !== 1.0 && task.segments) 
                    ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
                    : task.segments;

                const assContent = window.ReelsSubtitleProcessor
                    ? ReelsSubtitleProcessor.generateEnhancedASS(scaledSegments, taskStyle, {
                        karaokeHighlight: karaokeHL,
                        videoW: tw,
                        videoH: th,
                    })
                    : generateASS(task.segments, taskStyle);
                await window.electronAPI.burnSubtitles({
                    videoPath: bgPath, assContent, outputPath, crf,
                    useGPU: gpuEnabled,
                });
            } else {
                console.warn('[Reels] FFmpeg IPC not available, skipping:', task.fileName);
            }

        // 拼接前置片段 (Hook -> Main) — 仅 MP4 模式
            const finalHookPath = _resolveTaskHookPath(task, introPath);
            let currentOutputToConcat = doMp4 ? outputPath : finalOutputPath;

            if (doMp4 && finalHookPath && window.electronAPI && window.electronAPI.concatVideo) {
                const concatOutput = outputPath.replace('.mp4', '_final_tmp.mp4');
                await window.electronAPI.concatVideo({
                    introPath: finalHookPath,
                    mainPath: currentOutputToConcat,
                    outputPath: concatOutput,
                    speed: task.hookSpeed || 1.0,
                    trimStart: task.hookTrimStart !== undefined ? task.hookTrimStart : null,
                    trimEnd: task.hookTrimEnd !== undefined ? task.hookTrimEnd : null,
                    transition: task.hookTransition || 'none',
                    transDuration: task.hookTransDuration || 0.5,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30
                });
                currentOutputToConcat = concatOutput;
            }

            // 拼接封面片段 (Cover -> [Hook] -> Main)
            if (coverMp4Path && doMp4 && window.electronAPI && window.electronAPI.concatVideo) {
                const coverConcatOutput = outputPath.replace('.mp4', '_final.mp4');
                if (statusEl) statusEl.textContent = `拼接中 ${i + 1}/${totalJobs}: 合并封面视频${presetLabel}...`;
                await window.electronAPI.concatVideo({
                    introPath: coverMp4Path,
                    mainPath: currentOutputToConcat,
                    outputPath: coverConcatOutput,
                    speed: 1.0,
                    transition: 'none',
                    transDuration: 0,
                    targetWidth: tw,
                    targetHeight: th,
                    fps: 30
                });
                currentOutputToConcat = coverConcatOutput;
            } else if (currentOutputToConcat.includes('_final_tmp.mp4')) {
                // 如果只拼接了 Hook 没有 Cover，重命名 _final_tmp 为 _final
                const finalTarget = outputPath.replace('.mp4', '_final.mp4');
                try {
                    await window.electronAPI.apiCall('file/rename', { source: currentOutputToConcat, target: finalTarget, copy: false });
                    currentOutputToConcat = finalTarget;
                } catch (e) { console.error('Rename final_tmp failed', e); }
            }

            finalOutputPath = currentOutputToConcat;

            // ── 清理中间产物：只保留最终拼接视频 ──
            if (finalOutputPath !== outputPath) {
                // outputPath 是拼接前的中间文件（如 _subtitled.mp4），删除它
                try {
                    await window.electronAPI.apiCall('file/delete', { path: outputPath });
                    console.log('[Reels] 清理中间文件:', outputPath);
                } catch (e) { console.warn('[Reels] 清理中间文件失败(可忽略):', e.message); }
                // 也清理可能残留的 _final_tmp.mp4
                const tmpFile = outputPath.replace('.mp4', '_final_tmp.mp4');
                if (tmpFile !== finalOutputPath) {
                    try {
                        await window.electronAPI.apiCall('file/delete', { path: tmpFile });
                    } catch (e) { /* 可能不存在，忽略 */ }
                }
            }

            okCount += 1;
            _reelsState.lastExportOutputPath = finalOutputPath;
            _reelsUpdateLastOutputUI(finalOutputPath);
        } catch (err) {
            console.error('[Reels] Export failed:', task.fileName, err);
            failCount += 1;
            const errMsg = err && err.message ? err.message : String(err || '未知错误');
            failDetails.push(`${task.fileName}${presetLabel}: ${errMsg}`);
            if (statusEl) statusEl.textContent = `❌ 导出失败: ${task.fileName}${presetLabel} - ${errMsg}`;
            _reelsUpdateLastErrorUI(`${task.fileName}${presetLabel}: ${errMsg}`);
        }
        // ── 多模板模式：恢复原始覆层 ──
        if (originalOverlays !== null) {
            task.overlays = originalOverlays;
        }
        _reelsUpdateExportProgressUI(okCount + failCount, totalJobs);
    }
    };

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        workers.push(processNext());
    }
    await Promise.all(workers);

    // ── 统一输出单轴 FCPXML ──
    if (doFcpxml && fcpxmlBatchTasks.length > 0 && !canceled && typeof window.reelsBatchFcpxmlExport === 'function') {
        const batchName = `BatchTimeline_${dateStr}_${timeStr}`;
        try {
            if (statusEl) statusEl.textContent = '🚀 正在合并 FCPXML 时间线...';
            const res = await window.reelsBatchFcpxmlExport({
                tasks: fcpxmlBatchTasks,
                outputDir: outputDirTrimmed,
                taskName: batchName,
                fps: 30,
                compoundMode: fcpxmlCompound,
                onLog: (msg) => console.log(`[FCPXML Bulk] ${msg}`)
            });
            _reelsState.lastExportOutputPath = res.outputPath;
        } catch (err) {
            failCount += fcpxmlBatchTasks.length;
            okCount = 0;
            const errMsg = err && err.message ? err.message : String(err);
            failDetails.push(`FCPXML时间线生成失败: ${errMsg}`);
            console.error('[FCPXML] 批量生成时间线失败:', err);
        }
    }

    const doneCount = okCount + failCount;
    _reelsUpdateExportProgressUI(doneCount, totalJobs);
    if (statusEl) {
        if (canceled) {
            statusEl.textContent = `⚠️ 已取消 (${doneCount}/${totalJobs})`;
        } else {
            const matrixNote = multiPresetCfg ? ` (${tasks.length}任务×${multiPresetCfg.presets.length}模板)` : '';
            statusEl.textContent = failCount > 0
                ? `⚠️ 完成 ${okCount}/${totalJobs}，失败 ${failCount}${matrixNote}`
                : `✅ 全部完成 (${totalJobs}个视频${matrixNote})`;
        }
    }
    if (!canceled && failCount > 0) {
        const shortErr = failDetails.slice(0, 5).join('\n');
        alert(`导出失败 ${failCount} 个\n输出目录: ${outputDirTrimmed}\n\n失败原因:\n${shortErr}`);
    } else if (!canceled && okCount > 0) {
        _reelsUpdateLastErrorUI('');
        const latest = _reelsState.lastExportOutputPath || `${outputDirTrimmed}${outputJoinSep}`;
        alert(`导出完成 ${okCount}/${totalJobs}\n输出目录: ${outputDirTrimmed}\n最新文件: ${latest}`);
        // 自动打开输出文件夹
        if (window.electronAPI && window.electronAPI.apiCall) {
            try { await window.electronAPI.apiCall('file/open-folder', { path: outputDirTrimmed }); } catch (e) { }
        }
    }
    if (exportBtn) {
        exportBtn.disabled = false;
        exportBtn.innerHTML = '🚀 开始导出';
    }
    _reelsState.isExporting = false;
}

// ═══════════════════════════════════════════════════════
// Smart Subtitle Processing (智能字幕处理)
// ═══════════════════════════════════════════════════════

/**
 * 智能重分段：按当前样式参数（字体大小、换行宽度等）重新分段所有任务的字幕。
 * 效果：自动调整每条字幕的文本量，确保不溢出预览区域。
 */
function reelsResegment() {
    if (!window.ReelsSubtitleProcessor) {
        alert('字幕处理器未加载');
        return;
    }
    const videoW = _reelsState.targetWidth || 1080;
    let totalProcessed = 0;


    for (const task of _reelsState.tasks) {
        if (!task.segments || task.segments.length === 0) continue;
        const style = _resolveSubtitleStyleForTask(task);
        const result = ReelsSubtitleProcessor.smartSegmentation(task.segments, style, videoW);
        if (result && result.length > 0) {
            task.segments = result;
            totalProcessed++;
        }
    }
    _renderTaskList();
    if (totalProcessed > 0) {
        alert(`✅ 已智能重分段 ${totalProcessed} 个任务的字幕`);
    } else {
        alert('没有可处理的字幕（请先添加带SRT的任务）');
    }
}

/**
 * 合并短片段：合并时长过短的字幕到相邻字幕。
 */
function reelsMergeShort() {
    if (!window.ReelsSubtitleProcessor) {
        alert('字幕处理器未加载');
        return;
    }
    let totalProcessed = 0;
    for (const task of _reelsState.tasks) {
        if (!task.segments || task.segments.length === 0) continue;
        task.segments = ReelsSubtitleProcessor.mergeShortSegments(task.segments);
        totalProcessed++;
    }
    _renderTaskList();
    if (totalProcessed > 0) {
        alert(`✅ 已合并 ${totalProcessed} 个任务的短片段`);
    }
}

/**
 * 导出当前选中任务的字幕为 SRT 文件。
 */
function reelsExportSRT() {
    const task = _reelsState.tasks[_reelsState.selectedIdx];
    if (!task || !task.segments || task.segments.length === 0) {
        alert('请先选择一个带字幕的任务');
        return;
    }
    if (window.ReelsSubtitleProcessor) {
        const aDurScale = task.audioDurScale || 100;
        const factor = aDurScale / 100;
        const scaledSegments = (factor !== 1.0 && task.segments) 
            ? task.segments.map(s => ({ ...s, start: s.start * factor, end: s.end * factor, words: s.words ? s.words.map(w => ({...w, start: w.start * factor, end: w.end * factor})) : undefined }))
            : task.segments;

        const srtContent = ReelsSubtitleProcessor.segmentsToSRT(scaledSegments);
        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = task.fileName.replace(/\.[^.]+$/, '') + '_processed.srt';
        a.click();
        URL.revokeObjectURL(url);
    }
}

// ═══════════════════════════════════════════════════════
// Project Management
// ═══════════════════════════════════════════════════════

/**
 * 收集当前工程状态（供模板系统调用）
 */
function _cloneProjectDataForSave(value) {
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(value, (key, val) => {
        if (key && key.startsWith('_') && key !== '_subtitlePreset' && key !== '_overlayPresetName') return undefined;
        if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return undefined;
            seen.add(val);
        }
        return val;
    }));
}

function collectCurrentProjectState() {
    _syncCurrentOverlayEditorToSelectedTask();
    const style = _readStyleFromUI();
    _persistSubtitleStyleByScope(style);
    const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
    const exportOpts = {
        outputDir: (document.getElementById('reels-output-dir') || {}).value || '',
        quality: (document.getElementById('reels-quality') || {}).value || 'medium',
        suffix: (document.getElementById('reels-suffix') || {}).value || '_subtitled',
        namingMode: (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text',
        namingStartDate: localStorage.getItem('reels_naming_start_date') || '',
        namingVidsPerDay: parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3,
        namingPrefix: localStorage.getItem('reels_naming_prefix') || '',
        namingSuffix: localStorage.getItem('reels_naming_suffix') || '',
        voiceVolume: parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100') || 100,
        bgVolume: _getGlobalBgVolumePercent(),
        bgmVolume: _getGlobalBgmVolumePercent(),
        useGPU: (document.getElementById('reels-use-gpu') || {}).checked || false,
        useMemoryDecoder: (document.getElementById('reels-use-memory-decoder') || {}).checked || false,
        previewLoop: (document.getElementById('reels-preview-loop') || {}).checked !== false,
        loopFade: (document.getElementById('reels-loop-fade') || {}).checked !== false,
        loopFadeDuration: parseFloat((document.getElementById('reels-loop-fade-dur') || {}).value || '1') || 1,
        introPath: (document.getElementById('reels-intro-path') || {}).value || '',
        karaokeHighlight: (document.getElementById('reels-karaoke-hl') || {}).checked || false,
        reverbEnabled: (document.getElementById('reels-reverb-enabled') || {}).checked || false,
        reverbPreset: (document.getElementById('reels-reverb-preset') || {}).value || 'hall',
        reverbMix: parseFloat((document.getElementById('reels-reverb-mix') || {}).value || '30') || 30,
        stereoWidth: parseFloat((document.getElementById('reels-stereo-width') || {}).value || '100') || 100,
        audioFxTarget: (document.getElementById('reels-audio-fx-target') || {}).value || 'all',
        subtitleStyleApplyAll: _isStyleApplyAllEnabled(),
    };
    return {
        tasks: _cloneProjectDataForSave(_reelsState.tasks),
        backgroundLibrary: _cloneProjectDataForSave(_reelsState.backgroundLibrary || []),
        style: globalStyle,
        exportOpts,
        selectedIdx: _reelsState.selectedIdx,
    };
}

/**
 * 从模板/项目数据恢复工程状态（供模板系统调用）
 */
function applyRestoredProject(result) {
    if (!result) return;

    // ── 先清空覆层编辑器，防止旧覆层被 reelsSelectTask 写入新任务 ──
    if (_reelsState.overlayProxy && _reelsState.overlayProxy.overlayMgr) {
        _reelsState.overlayProxy.overlayMgr.overlays = [];
    }
    if (_reelsState.overlayPanel) {
        _reelsState.overlayPanel.deselectOverlay();
        _reelsState.overlayPanel._refreshList();
    }
    _reelsState._coverEditMode = false;
    _reelsState.selectedIdx = -1; // 标记为无选中，防止 reelsSelectTask 回写

    // 恢复任务并自动清理 100% 的硬编码 bgVideoVolume，使其能够继承全局配置音量
    _reelsState.tasks = Array.isArray(result.tasks) ? result.tasks.map(task => {
        if (task && task.bgVideoVolume === 100) {
            delete task.bgVideoVolume;
        }
        return task;
    }) : [];
    _reelsState.selectedIdx = _reelsState.tasks.length > 0
        ? Math.max(0, Math.min(result.selectedIdx >= 0 ? result.selectedIdx : 0, _reelsState.tasks.length - 1))
        : -1;
    _reelsState.backgroundLibrary = [];
    _ensureBackgroundLibraryFromTasks();

    // Keep the batch-table active tab in sync so loaded template paths appear
    // in the table as well as in the Reels task list.
    if (typeof _batchTableState !== 'undefined' && typeof _getActiveTab === 'function') {
        const tab = _getActiveTab();
        if (tab) {
            try {
                tab.tasks = _cloneProjectDataForSave(_reelsState.tasks);
            } catch (_) {
                tab.tasks = _reelsState.tasks.map(t => ({ ...t }));
            }
        }
    }

    // 恢复样式
    if (result.style && Object.keys(result.style).length > 0) {
        _reelsState.globalSubtitleStyle = _cloneSubtitleStyle(result.style);
    }

    // 恢复导出选项
    if (result.exportOpts) {
        const opts = result.exportOpts;
        const setVal = (id, val) => {
            _setExportSettingValue(id, val);
        };
        const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };
        if (opts.outputDir) setVal('reels-output-dir', opts.outputDir);
        if (opts.quality) setVal('reels-quality', opts.quality);
        if (opts.suffix) setVal('reels-suffix', opts.suffix);
        if (opts.namingMode) {
            setVal('reels-naming-mode', opts.namingMode);
            setVal('reels-export-naming-mode-outer', opts.namingMode);
            localStorage.setItem('reels_naming_mode', opts.namingMode);
            
            // Sync gear button visibility
            const configBtnOuter = document.getElementById('reels-export-naming-config-btn');
            if (configBtnOuter) {
                configBtnOuter.style.display = (opts.namingMode === 'index' || opts.namingMode === 'date-auto') ? 'inline-block' : 'none';
            }
            const configBtnInner = document.getElementById('reels-naming-config-btn');
            if (configBtnInner) {
                configBtnInner.style.display = (opts.namingMode === 'index' || opts.namingMode === 'date-auto') ? 'inline-block' : 'none';
            }
        }
        if (opts.namingStartDate !== undefined) localStorage.setItem('reels_naming_start_date', opts.namingStartDate || '');
        if (opts.namingVidsPerDay !== undefined) localStorage.setItem('reels_naming_vids_per_day', String(opts.namingVidsPerDay));
        if (opts.namingPrefix !== undefined) localStorage.setItem('reels_naming_prefix', opts.namingPrefix || '');
        if (opts.namingSuffix !== undefined) localStorage.setItem('reels_naming_suffix', opts.namingSuffix || '');
        if (opts.voiceVolume !== undefined && opts.voiceVolume !== null) setVal('reels-voice-volume', String(opts.voiceVolume));
        if (opts.bgVolume !== undefined && opts.bgVolume !== null) setVal('reels-bg-volume', String(opts.bgVolume));
        if (opts.bgmVolume !== undefined && opts.bgmVolume !== null) setVal('reels-bgm-volume', String(opts.bgmVolume));
        setCheck('reels-use-gpu', opts.useGPU);
        setCheck('reels-use-memory-decoder', opts.useMemoryDecoder === true);
        setCheck('reels-preview-loop', opts.previewLoop !== false);
        setCheck('reels-loop-fade', opts.loopFade !== false);
        if (opts.loopFadeDuration !== undefined && opts.loopFadeDuration !== null) {
            const dur = parseFloat(opts.loopFadeDuration);
            if (Number.isFinite(dur) && dur > 0) setVal('reels-loop-fade-dur', String(dur));
        }
        if (opts.introPath) setVal('reels-intro-path', opts.introPath);
        setCheck('reels-karaoke-hl', opts.karaokeHighlight);
        setCheck('reels-reverb-enabled', opts.reverbEnabled);
        if (opts.reverbPreset) setVal('reels-reverb-preset', opts.reverbPreset);
        if (opts.reverbMix !== undefined) setVal('reels-reverb-mix', String(opts.reverbMix));
        if (opts.stereoWidth !== undefined) setVal('reels-stereo-width', String(opts.stereoWidth));
        if (opts.audioFxTarget !== undefined) setVal('reels-audio-fx-target', opts.audioFxTarget);
        setCheck('reels-style-apply-all', opts.subtitleStyleApplyAll !== false);


        
        // 恢复分辨率设置
        const tw = opts.targetWidth || 1080;
        const th = opts.targetHeight || 1920;
        _reelsState.targetWidth = tw;
        _reelsState.targetHeight = th;
        
        const resSelect = document.getElementById('reels-resolution-select');
        const customDiv = document.getElementById('reels-custom-res-inputs');
        const wVal = `${tw}x${th}`;
        if (resSelect) {
            let optionExists = false;
            for (let i = 0; i < resSelect.options.length; i++) {
                if (resSelect.options[i].value === wVal) {
                    resSelect.value = wVal;
                    optionExists = true;
                    break;
                }
            }
            if (!optionExists) {
                resSelect.value = 'custom';
                if (customDiv) customDiv.style.display = 'inline-flex';
                const wInput = document.getElementById('reels-custom-width');
                const hInput = document.getElementById('reels-custom-height');
                const wRange = document.getElementById('reels-custom-width-range');
                const hRange = document.getElementById('reels-custom-height-range');
                if (wInput) wInput.value = tw;
                if (hInput) hInput.value = th;
                if (wRange) wRange.value = tw;
                if (hRange) hRange.value = th;
            } else {
                if (customDiv) customDiv.style.display = 'none';
            }
        }
        _reelsUpdateResolutionUI(tw, th);
        const canvas = document.getElementById('reels-preview-canvas');
        if (canvas) {
            canvas.width = tw;
            canvas.height = th;
        }

        _applyPreviewLoopMode();
    }


    const selectedTask = _reelsState.tasks[_reelsState.selectedIdx] || null;
    const styleToShow = _resolveSubtitleStyleForTask(selectedTask);
    if (styleToShow) _writeStyleToUI(styleToShow);

    if (selectedTask) {
        // 必须先重置 selectedIdx=-1，否则 reelsSelectTask 的 "保存上一个任务覆层"
        // 逻辑会把空的 overlayMgr 内容写入刚加载的模板任务
        const targetIdx = _reelsState.selectedIdx;
        _reelsState.selectedIdx = -1;
        reelsSelectTask(targetIdx);
    } else {
        _renderTaskList();
    }
    if (typeof _renderBatchTable === 'function') {
        // Loading a template/project replaces state from JSON. The batch table may
        // still contain stale DOM inputs from the previous project, so skip its
        // automatic DOM -> task sync for this first redraw.
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    _applyPreviewAudioMix();
    reelsUpdatePreview();

    if (result.warnings && result.warnings.length > 0) {
        console.warn('[Project] Warnings:', result.warnings);
    }
    const statusEl = document.getElementById('reels-export-status');
    if (statusEl) statusEl.textContent = `✅ 已加载 ${result.tasks.length} 个任务`;

    if (!_isRestoringHistory && typeof window.reelsSaveHistory === 'function') {
        _reelsHistoryStack = [];
        _reelsHistoryIndex = -1;
        window.reelsSaveHistory();
    }
}

function reelsSaveProject() {
    if (!window.ReelsProject) { alert('项目管理模块未加载'); return; }
    _syncCurrentOverlayEditorToSelectedTask();
    const style = _readStyleFromUI();
    _persistSubtitleStyleByScope(style);
    const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
    const exportOpts = {
        outputDir: (document.getElementById('reels-output-dir') || {}).value || '',
        quality: (document.getElementById('reels-quality') || {}).value || 'medium',
        suffix: (document.getElementById('reels-suffix') || {}).value || '_subtitled',
        namingMode: (document.getElementById('reels-export-naming-mode-outer') || {}).value || (document.getElementById('reels-naming-mode') || {}).value || localStorage.getItem('reels_naming_mode') || 'text',
        namingStartDate: localStorage.getItem('reels_naming_start_date') || '',
        namingVidsPerDay: parseInt(localStorage.getItem('reels_naming_vids_per_day') || '3') || 3,
        namingPrefix: localStorage.getItem('reels_naming_prefix') || '',
        namingSuffix: localStorage.getItem('reels_naming_suffix') || '',
        voiceVolume: parseFloat((document.getElementById('reels-voice-volume') || {}).value || '100') || 100,
        bgVolume: _getGlobalBgVolumePercent(),
        useGPU: (document.getElementById('reels-use-gpu') || {}).checked || false,
        useMemoryDecoder: (document.getElementById('reels-use-memory-decoder') || {}).checked || false,
        previewLoop: (document.getElementById('reels-preview-loop') || {}).checked !== false,
        loopFade: (document.getElementById('reels-loop-fade') || {}).checked !== false,
        loopFadeDuration: parseFloat((document.getElementById('reels-loop-fade-dur') || {}).value || '1') || 1,
        introPath: (document.getElementById('reels-intro-path') || {}).value || '',
        karaokeHighlight: (document.getElementById('reels-karaoke-hl') || {}).checked || false,
        reverbEnabled: (document.getElementById('reels-reverb-enabled') || {}).checked || false,
        reverbPreset: (document.getElementById('reels-reverb-preset') || {}).value || 'hall',
        reverbMix: parseFloat((document.getElementById('reels-reverb-mix') || {}).value || '30') || 30,
        stereoWidth: parseFloat((document.getElementById('reels-stereo-width') || {}).value || '100') || 100,
        audioFxTarget: (document.getElementById('reels-audio-fx-target') || {}).value || 'all',
        subtitleStyleApplyAll: _isStyleApplyAllEnabled(),
        targetWidth: _reelsState.targetWidth || 1080,
        targetHeight: _reelsState.targetHeight || 1920,
    };

    ReelsProject.saveProject({
        tasks: _reelsState.tasks,
        style: globalStyle,
        exportOpts,
        selectedIdx: _reelsState.selectedIdx,
    });
}

async function reelsLoadProject() {
    if (!window.ReelsProject) { alert('项目管理模块未加载'); return; }
    const result = await ReelsProject.loadProject();
    if (!result) return;
    applyRestoredProject(result);
}

// ═══════════════════════════════════════════════════════
// History (Undo / Redo)
// ═══════════════════════════════════════════════════════

let _reelsHistoryStack = [];
let _reelsHistoryIndex = -1;
let _isRestoringHistory = false;

window.reelsSaveHistory = function() {
    if (_isRestoringHistory || !window._reelsState || typeof collectCurrentProjectState !== 'function') return;
    try {
        const stateStr = JSON.stringify(collectCurrentProjectState());
        // 如果与当前处于相同状态则不保存
        if (_reelsHistoryIndex >= 0 && _reelsHistoryStack[_reelsHistoryIndex] === stateStr) {
            return;
        }
        // 如果在撤销中途发生了新的修改，截断之后的重做记录
        if (_reelsHistoryIndex < _reelsHistoryStack.length - 1) {
            _reelsHistoryStack = _reelsHistoryStack.slice(0, _reelsHistoryIndex + 1);
        }
        _reelsHistoryStack.push(stateStr);
        // 限制最多保存30步历史
        if (_reelsHistoryStack.length > 30) {
            _reelsHistoryStack.shift();
        } else {
            _reelsHistoryIndex++;
        }
    } catch (e) {
        console.warn('[History] Failed to save history snapshot', e);
    }
};

window.reelsUndo = function() {
    if (_reelsHistoryIndex > 0) {
        _reelsHistoryIndex--;
        _isRestoringHistory = true;
        try {
            const state = JSON.parse(_reelsHistoryStack[_reelsHistoryIndex]);
            applyRestoredProject(state);
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = '⏪ 撤销成功';
            console.log('[History] Undo completed');
        } catch (e) {
            console.error('[History] Undo error', e);
        } finally {
            _isRestoringHistory = false;
        }
    } else {
        console.log('[History] No more undo steps');
    }
};

window.reelsRedo = function() {
    if (_reelsHistoryIndex < _reelsHistoryStack.length - 1) {
        _reelsHistoryIndex++;
        _isRestoringHistory = true;
        try {
            const state = JSON.parse(_reelsHistoryStack[_reelsHistoryIndex]);
            applyRestoredProject(state);
            const statusEl = document.getElementById('reels-export-status');
            if (statusEl) statusEl.textContent = '⏩ 重做成功';
            console.log('[History] Redo completed');
        } catch (e) {
            console.error('[History] Redo error', e);
        } finally {
            _isRestoringHistory = false;
        }
    } else {
        console.log('[History] No more redo steps');
    }
};

// 监听键盘快捷键
document.addEventListener('keydown', (e) => {
    // 确保是在批量/剪辑工具的焦点上下文中才响应
    const panel = document.getElementById('batch-reels-panel');
    if (!panel || !panel.classList.contains('active')) return;
    
    // 不要拦截输入框内部的标准撤销，除非你想覆盖（这里暂时不拦截在文本输入框内的原生撤销行为）
    const isTextInput = (e.target.tagName === 'INPUT' && ['text', 'number', 'search', 'password', 'url', 'email'].includes(e.target.type)) || 
                        e.target.tagName === 'TEXTAREA' || 
                        e.target.isContentEditable;
    
    // Command/Ctrl + Z (Undo)
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (isTextInput) return; // 允许输入框使用原生撤销
        e.preventDefault();
        window.reelsUndo();
    }
    // Command/Ctrl + Shift + Z 或者 Ctrl + Y (Redo)
    else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') || 
             ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y')) {
        if (isTextInput) return; // 允许输入框使用原生重做
        e.preventDefault();
        window.reelsRedo();
    }
});

// 监听所有的UI变更（利用事件委托）
// `change` 事件适合大部分失去焦点、选项改变、滑块松开的情况
document.addEventListener('change', (e) => {
    if (e.target.closest('#batch-reels-panel') || e.target.closest('.reels-batch-table-container')) {
        window.reelsSaveHistory();
    }
});

// 初始化时保存一个空状态
setTimeout(() => {
    if (typeof window.reelsSaveHistory === 'function') {
        window.reelsSaveHistory();
    }
}, 2000);

// ═══════════════════════════════════════════════════════
// Font Upload
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // 字体上传处理
    const fontInput = document.getElementById('reels-font-upload');
    if (fontInput) {
        fontInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (window.getFontManager) {
                const fm = getFontManager();
                const familyName = await fm.uploadFont(file);
                if (familyName) {
                    _refreshReelsFontSelects(fm, {
                        'reels-font-family': familyName,
                        'rop-font': familyName,
                        'rop-title-font': familyName,
                        'rop-body-font': familyName,
                        'rop-footer-font': familyName,
                        'rop-scroll-font': familyName,
                        'rop-scroll-title-font': familyName,
                    });
                    const familyEl = document.getElementById('reels-font-family');
                    if (familyEl) familyEl.value = familyName;
                    reelsRefreshSubtitleWeightOptions();
                    reelsUpdatePreview();
                    alert(`字体 "${familyName}" 已加载！`);
                }
            } else {
                alert('字体管理器未加载');
            }
            fontInput.value = '';
        });
    }

    // 初始化字体管理器
    if (window.getFontManager) {
        const fm = getFontManager();
        fm.register().then(() => {
            _refreshReelsFontSelects(fm);
            fm.loadGoogleFont('Crimson Pro').catch(() => { });
            reelsRefreshSubtitleWeightOptions();
        });
    }

    // 自动保存 (每 60 秒)
    setInterval(() => {
        if (_reelsState.tasks.length > 0 && window.ReelsProject) {
            const style = _readStyleFromUI();
            _persistSubtitleStyleByScope(style);
            const globalStyle = _cloneSubtitleStyle(_reelsState.globalSubtitleStyle) || style;
            ReelsProject.autoSaveProject({
                tasks: _reelsState.tasks,
                style: globalStyle,
                selectedIdx: _reelsState.selectedIdx,
            });
        }
    }, 60000);
});

// ═══════════════════════════════════════════════════════
// Tab visibility observer
// ═══════════════════════════════════════════════════════

if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
        const panel = document.getElementById('batch-reels-panel');
        if (panel && panel.classList.contains('active')) {
            _fitPreviewWhenReady();
            reelsUpdatePreview();
        } else {
            if (_reelsState.previewRAF) {
                cancelAnimationFrame(_reelsState.previewRAF);
                _reelsState.previewRAF = null;
            }
        }
    });
    setTimeout(() => {
        const panel = document.getElementById('batch-reels-panel');
        if (panel) observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    }, 500);
}

// ═══════════════════════════════════════════════════════
// UI Interaction Hook for Style Overrides
// ═══════════════════════════════════════════════════════
function reelsMarkStyleDirty(e) {
    const el = e.target;
    if (!el || !el.closest) return;
    if (
        !el.closest('#reels-style-panel') &&
        !el.closest('#reels-advanced-style-panel') &&
        !el.closest('#inspector-tab-subtitle')
    ) return;
    
    // Ignore non-style inputs
    if (el.id === 'reels-style-apply-all' || el.id === 'reels-preset-select' || 
        el.id === 'reels-subtitle-toggle' || el.id === 'reels-show-subtitle-range') return;

    // User actively modified a style parameter, breaking the preset link
    const applyAll = typeof _isStyleApplyAllEnabled === 'function' ? _isStyleApplyAllEnabled() : true;
    let modified = false;
    
    if (applyAll && window._reelsState && window._reelsState.tasks) {
        for (const t of window._reelsState.tasks) {
            if (t._subtitlePreset) { t._subtitlePreset = ''; modified = true; }
        }
    } else {
        const task = typeof _getSelectedTask === 'function' ? _getSelectedTask() : null;
        if (task && task._subtitlePreset) { task._subtitlePreset = ''; modified = true; }
    }

    if (modified) {
        const selectTrigger = document.getElementById('reels-preset-select-trigger');
        const hiddenInput = document.getElementById('reels-preset-select');
        if (hiddenInput) hiddenInput.value = '';
        if (selectTrigger) {
            const span = selectTrigger.querySelector('span');
            if (span) span.textContent = '-- 自定义样式 --';
        }
    }
}

// ═══════════════════════════════════════════════════════
// Resolution Customization
// ═══════════════════════════════════════════════════════
window.reelsHandleResolutionChange = function(val) {
    const customDiv = document.getElementById('reels-custom-res-inputs');
    if (val === 'custom') {
        if (customDiv) customDiv.style.display = 'inline-flex';
        reelsHandleCustomResolutionChange();
    } else {
        if (customDiv) customDiv.style.display = 'none';
        const parts = val.split('x');
        const w = parseInt(parts[0], 10);
        const h = parseInt(parts[1], 10);
        _reelsUpdateResolution(w, h);
    }
};

window.reelsHandleCustomResolutionChange = function() {
    const wInput = document.getElementById('reels-custom-width');
    const hInput = document.getElementById('reels-custom-height');
    const wRange = document.getElementById('reels-custom-width-range');
    const hRange = document.getElementById('reels-custom-height-range');
    if (wInput && hInput) {
        const w = parseInt(wInput.value, 10) || 1080;
        const h = parseInt(hInput.value, 10) || 1920;
        if (wRange) wRange.value = w;
        if (hRange) hRange.value = h;
        _reelsUpdateResolution(w, h);
    }
};

function _reelsUpdateResolution(w, h) {
    _reelsState.targetWidth = w;
    _reelsState.targetHeight = h;

    const canvas = document.getElementById('reels-preview-canvas');
    if (canvas) {
        canvas.width = w;
        canvas.height = h;
    }

    _reelsUpdateResolutionUI(w, h);

    if (typeof reelsSaveProject === 'function') {
        reelsSaveProject();
    }

    reelsUpdatePreview();
    _fitPreviewWhenReady();
}

function _reelsUpdateResolutionUI(w, h) {
    const container = document.getElementById('reels-preview-container');
    if (container) {
        container.style.aspectRatio = `${w}/${h}`;
        if (w >= h) {
            container.style.width = '380px';
        } else {
            container.style.width = '270px';
        }
    }
}

document.addEventListener('input', reelsMarkStyleDirty, true);
document.addEventListener('change', reelsMarkStyleDirty, true);

// ─── 统一的文件选择器辅助函数 ───
async function _pickSingleFile(title, extensions) {
    if (window.electronAPI && window.electronAPI.showOpenDialog) {
        try {
            const result = await window.electronAPI.showOpenDialog({
                title: title,
                properties: ['openFile'],
                filters: [{ name: '媒体文件', extensions: extensions }]
            });
            if (result && result.filePaths && result.filePaths.length > 0) {
                return result.filePaths[0];
            }
        } catch (e) {
            console.error('electronAPI showOpenDialog error:', e);
        }
    }
    if (window.require) {
        try {
            const { dialog, getCurrentWindow } = window.require('@electron/remote');
            const result = await dialog.showOpenDialog(getCurrentWindow(), {
                title: title,
                properties: ['openFile'],
                filters: [{ name: '媒体文件', extensions: extensions }]
            });
            if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
                return result.filePaths[0];
            }
        } catch (e) {
            console.warn('remote dialog failed', e);
        }
    }
    // Web Fallback
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = extensions.map(ext => '.' + ext).join(',');
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                resolve(file.path || file.name);
            } else {
                resolve(null);
            }
        };
        input.click();
    });
}

// ─── 背景与内容视频双向同步与保存逻辑 ───
window.reelsSyncBackgroundTabUI = function(task) {
    if (!task) return;

    const bgPathEl = document.getElementById('reels-bg-path-ui');
    if (!bgPathEl) return;

    // 背景模式与面板显示切换
    const bgMode = task.bgMode || 'single';
    document.getElementById('reels-bg-mode-ui').value = bgMode;
    
    const singleContainer = document.getElementById('reels-bg-single-container');
    const multiContainer = document.getElementById('reels-bg-multi-container');
    if (singleContainer) singleContainer.style.display = bgMode === 'single' ? 'flex' : 'none';
    if (multiContainer) multiContainer.style.display = bgMode === 'multi' ? 'flex' : 'none';

    // 背景单素材文件路径
    bgPathEl.value = task.bgPath || '';
    
    // 背景多素材池统计与转场设置
    const poolCount = task.bgClipPool ? task.bgClipPool.length : 0;
    const activePoolCount = Array.isArray(task.bgClipActivePool) && task.bgClipActivePool.length > 0
        ? task.bgClipActivePool.filter(p => (task.bgClipPool || []).includes(p)).length
        : poolCount;
    const poolCountEl = document.getElementById('reels-bg-pool-count');
    if (poolCountEl) poolCountEl.textContent = `已添加 ${poolCount} 个素材 · 启用 ${activePoolCount} 个`;

    const transitionSelect = document.getElementById('reels-bg-transition-ui');
    if (transitionSelect) transitionSelect.value = task.bgTransition || 'crossfade';

    const clipOrderSelect = document.getElementById('reels-bg-cliporder-ui');
    if (clipOrderSelect) clipOrderSelect.value = task.bgClipOrder || 'random';

    const transDur = task.bgTransDur != null ? task.bgTransDur : 0.5;
    const transDurRange = document.getElementById('reels-bg-transdur-range');
    const transDurNum = document.getElementById('reels-bg-transdur-num');
    if (transDurRange) transDurRange.value = transDur;
    if (transDurNum) transDurNum.value = transDur;

    // 背景缩放百分比
    const bgScale = task.bgScale != null ? task.bgScale : 100;
    document.getElementById('reels-bg-scale-num').value = bgScale;
    document.getElementById('reels-bg-scale-range').value = bgScale;

    // 背景X偏移
    const bgX = task.bgX != null ? task.bgX : 0;
    document.getElementById('reels-bg-x-num').value = bgX;
    document.getElementById('reels-bg-x-range').value = bgX;

    // 背景Y偏移
    const bgY = task.bgY != null ? task.bgY : 0;
    document.getElementById('reels-bg-y-num').value = bgY;
    document.getElementById('reels-bg-y-range').value = bgY;

    // 背景音量
    const globalBgVol = _getGlobalBgVolumePercent();
    const hasCustomBgVol = task.bgVideoVolume != null && parseFloat(task.bgVideoVolume) !== 100;
    const bgVol = hasCustomBgVol ? task.bgVideoVolume : globalBgVol;
    const volumeRangeEl = document.getElementById('reels-bg-volume-range');
    const volumeNumEl = document.getElementById('reels-bg-volume-num');
    if (volumeRangeEl) {
        volumeRangeEl.value = bgVol;
        volumeRangeEl.dataset.isCustom = hasCustomBgVol ? 'true' : 'false';
    }
    if (volumeNumEl) {
        volumeNumEl.value = bgVol;
        volumeNumEl.dataset.isCustom = hasCustomBgVol ? 'true' : 'false';
    }

    // 背景变速
    const bgDur = task.bgDurScale != null ? task.bgDurScale : 100;
    document.getElementById('reels-bg-dur-scale-num').value = bgDur;
    document.getElementById('reels-bg-dur-scale-range').value = bgDur;

    // 内容视频文件路径与毛玻璃开关
    document.getElementById('reels-cv-path-ui').value = task.contentVideoPath || '';
    const cvBlurBg = !!task.contentVideoBlurBg;
    document.getElementById('reels-cv-blur-bg-ui').checked = cvBlurBg;
    const directBgEl = document.getElementById('reels-cv-direct-bg-ui');
    if (directBgEl) {
        directBgEl.checked = !!task.contentVideoDirectBg;
    }

    const blurParamsContainer = document.getElementById('reels-cv-blur-params-container');
    if (blurParamsContainer) {
        blurParamsContainer.style.display = cvBlurBg ? 'flex' : 'none';
    }
    const cvBlur = task.contentVideoBlur != null ? task.contentVideoBlur : 40;
    const cvBrightness = task.contentVideoBrightness != null ? task.contentVideoBrightness : 60;
    const blurRange = document.getElementById('reels-cv-blur-range');
    const blurNum = document.getElementById('reels-cv-blur-num');
    const brightRange = document.getElementById('reels-cv-brightness-range');
    const brightNum = document.getElementById('reels-cv-brightness-num');
    if (blurRange) blurRange.value = cvBlur;
    if (blurNum) blurNum.value = cvBlur;
    if (brightRange) brightRange.value = cvBrightness;
    if (brightNum) brightNum.value = cvBrightness;

    // 视频音量
    const cvVol = task.contentVideoVolume != null ? task.contentVideoVolume : 100;
    document.getElementById('reels-cv-volume-num').value = cvVol;
    document.getElementById('reels-cv-volume-range').value = cvVol;

    // 视频缩放
    const cvScale = task.contentVideoScale != null ? task.contentVideoScale : 100;
    document.getElementById('reels-cv-scale-num').value = cvScale;
    document.getElementById('reels-cv-scale-range').value = cvScale;

    // 视频翻转与背景翻转
    document.getElementById('reels-bg-fliph-ui').checked = !!task.bgFlipH;
    document.getElementById('reels-bg-flipv-ui').checked = !!task.bgFlipV;
    document.getElementById('reels-cv-fliph-ui').checked = !!task.contentVideoFlipH;
    document.getElementById('reels-cv-flipv-ui').checked = !!task.contentVideoFlipV;

    // 裁剪时长
    document.getElementById('reels-cv-trim-start').value = task.contentVideoTrimStart != null ? task.contentVideoTrimStart : '';
    document.getElementById('reels-cv-trim-end').value = task.contentVideoTrimEnd != null ? task.contentVideoTrimEnd : '';

    // 空间画面裁切 (Spatial Crop) - 包含文本框与滑杆的双向同步
    let cropVal = task.contentVideoCrop || '0,0,100,100';
    let parts = cropVal.split(',').map(p => parseFloat(p.trim()));
    if (parts.length !== 4 || parts.some(isNaN)) {
        parts = [0, 0, 100, 100];
    }
    const [cLeft, cTop, cWidth, cHeight] = parts;
    document.getElementById('reels-cv-crop-left').value = cLeft;
    document.getElementById('reels-cv-crop-left-range').value = cLeft;
    
    document.getElementById('reels-cv-crop-top').value = cTop;
    document.getElementById('reels-cv-crop-top-range').value = cTop;
    
    document.getElementById('reels-cv-crop-width').value = cWidth;
    document.getElementById('reels-cv-crop-width-range').value = cWidth;
    
    document.getElementById('reels-cv-crop-height').value = cHeight;
    document.getElementById('reels-cv-crop-height-range').value = cHeight;

    // 片段池拼接设置同步
    const clipPoolDir = task.clipPoolDir || '';
    const clipPoolDirEl = document.getElementById('reels-bg-clippool-dir-ui');
    if (clipPoolDirEl) {
        clipPoolDirEl.value = clipPoolDir;
    }
    
    const clipOrderEl = document.getElementById('reels-bg-clippool-order-ui');
    if (clipOrderEl) {
        clipOrderEl.value = task.clipOrder || 'name';
    }
    
    const clipStatusEl = document.getElementById('reels-bg-clippool-status-ui');
    if (clipStatusEl) {
        if (task.concatStatus === 'generating') {
            clipStatusEl.textContent = '⏳ 拼接中...';
        } else if (task.concatVideoPath) {
            const shortName = task.concatVideoPath.split(/[\\/]/).pop();
            clipStatusEl.textContent = `✅ ${shortName}`;
            clipStatusEl.title = task.concatVideoPath;
        } else {
            const clipCount = Array.isArray(task.clipPool) ? task.clipPool.length : 0;
            clipStatusEl.textContent = `${clipCount} 个片段`;
        }
    }

    // ── 配乐设置同步 ──
    const bgmMode = task.bgmMode || 'single';
    const reelsBgmModeUI = document.getElementById('reels-bgm-mode-ui');
    if (reelsBgmModeUI) reelsBgmModeUI.value = bgmMode;
    
    const bgmSingleContainer = document.getElementById('reels-bgm-single-container');
    const bgmMultiContainer = document.getElementById('reels-bgm-multi-container');
    if (bgmSingleContainer) bgmSingleContainer.style.display = bgmMode === 'single' ? 'flex' : 'none';
    if (bgmMultiContainer) bgmMultiContainer.style.display = bgmMode === 'multi' ? 'flex' : 'none';

    const bgmPathUI = document.getElementById('reels-bgm-path-ui');
    if (bgmPathUI) bgmPathUI.value = task.bgmPath || '';
    
    const bgmPool = task.bgmClipPool || [];
    const bgmPoolCount = bgmPool.length;
    const bgmActivePoolCount = Array.isArray(task.bgmClipActivePool) && task.bgmClipActivePool.length > 0
        ? task.bgmClipActivePool.filter(p => bgmPool.includes(p)).length
        : bgmPoolCount;
    const bgmPoolCountEl = document.getElementById('reels-bgm-pool-count');
    if (bgmPoolCountEl) bgmPoolCountEl.textContent = `已添加 ${bgmPoolCount} 个配乐 · 启用 ${bgmActivePoolCount} 个`;

    const bgmClipOrderUI = document.getElementById('reels-bgm-cliporder-ui');
    if (bgmClipOrderUI) bgmClipOrderUI.value = task.bgmClipOrder || 'random';

    const globalBgmVol = _getGlobalBgmVolumePercent();
    const hasCustomBgmVol = task.bgmVolume != null;
    const bgmVol = hasCustomBgmVol ? task.bgmVolume : globalBgmVol;
    const bgmTaskVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmTaskVolNum = document.getElementById('reels-bgm-task-volume-num');
    if (bgmTaskVolRange) {
        bgmTaskVolRange.value = bgmVol;
        bgmTaskVolRange.dataset.isCustom = hasCustomBgmVol ? 'true' : 'false';
    }
    if (bgmTaskVolNum) {
        bgmTaskVolNum.value = bgmVol;
        bgmTaskVolNum.dataset.isCustom = hasCustomBgmVol ? 'true' : 'false';
    }
};

window.reelsOnCvBlurBgChanged = function() {
    const isChecked = document.getElementById('reels-cv-blur-bg-ui').checked;
    if (isChecked) {
        const directEl = document.getElementById('reels-cv-direct-bg-ui');
        if (directEl) directEl.checked = false;
    }
    window.reelsSaveBgConfigUI();
};

window.reelsOnCvDirectBgChanged = function() {
    const isChecked = document.getElementById('reels-cv-direct-bg-ui').checked;
    if (isChecked) {
        const blurEl = document.getElementById('reels-cv-blur-bg-ui');
        if (blurEl) blurEl.checked = false;
    }
    window.reelsSaveBgConfigUI();
};

window.reelsSaveBgConfigUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    // 背景基本配置
    task.bgScale = parseInt(document.getElementById('reels-bg-scale-num').value) || 100;
    task.bgX = parseInt(document.getElementById('reels-bg-x-num').value) || 0;
    task.bgY = parseInt(document.getElementById('reels-bg-y-num').value) || 0;
    task.bgFlipH = document.getElementById('reels-bg-fliph-ui').checked;
    task.bgFlipV = document.getElementById('reels-bg-flipv-ui').checked;
    
    const bgVolRange = document.getElementById('reels-bg-volume-range');
    const bgVolNum = document.getElementById('reels-bg-volume-num');
    const bgVolVal = parseInt((bgVolNum || {}).value);

    // If the user is directly interacting with the right panel volume inputs, force isCustom to 'true'
    if (bgVolRange && bgVolNum && (document.activeElement === bgVolRange || document.activeElement === bgVolNum)) {
        bgVolRange.dataset.isCustom = 'true';
        bgVolNum.dataset.isCustom = 'true';
    }

    if (bgVolRange && bgVolRange.dataset.isCustom === 'true' && !isNaN(bgVolVal) && bgVolVal !== 100) {
        task.bgVideoVolume = bgVolVal;
    } else {
        delete task.bgVideoVolume;
    }

    // 配乐音量配置
    const bgmVolRange = document.getElementById('reels-bgm-task-volume-range');
    const bgmVolNum = document.getElementById('reels-bgm-task-volume-num');
    const bgmVolVal = parseInt((bgmVolNum || {}).value);

    if (bgmVolRange && bgmVolNum && (document.activeElement === bgmVolRange || document.activeElement === bgmVolNum)) {
        bgmVolRange.dataset.isCustom = 'true';
        bgmVolNum.dataset.isCustom = 'true';
    }

    if (bgmVolRange && bgmVolRange.dataset.isCustom === 'true' && !isNaN(bgmVolVal)) {
        task.bgmVolume = bgmVolVal;
    } else {
        delete task.bgmVolume;
    }

    const bgmClipOrderEl = document.getElementById('reels-bgm-cliporder-ui');
    if (bgmClipOrderEl) {
        task.bgmClipOrder = bgmClipOrderEl.value || 'random';
    }

    task.bgDurScale = parseInt(document.getElementById('reels-bg-dur-scale-num').value) || 100;

    // 背景多素材转场配置
    task.bgTransition = document.getElementById('reels-bg-transition-ui').value || 'crossfade';
    task.bgTransDur = parseFloat(document.getElementById('reels-bg-transdur-num').value) || 0.5;
    const clipOrderEl = document.getElementById('reels-bg-cliporder-ui');
    task.bgClipOrder = clipOrderEl ? (clipOrderEl.value || 'random') : (task.bgClipOrder || 'random');

    // 内容视频属性
    task.contentVideoBlurBg = document.getElementById('reels-cv-blur-bg-ui').checked;
    const directBgEl = document.getElementById('reels-cv-direct-bg-ui');
    task.contentVideoDirectBg = directBgEl ? directBgEl.checked : false;
    const blurParamsContainer = document.getElementById('reels-cv-blur-params-container');
    if (blurParamsContainer) {
        blurParamsContainer.style.display = task.contentVideoBlurBg ? 'flex' : 'none';
    }
    const blurNum = document.getElementById('reels-cv-blur-num');
    task.contentVideoBlur = blurNum ? (parseInt(blurNum.value) ?? 40) : 40;
    const brightNum = document.getElementById('reels-cv-brightness-num');
    task.contentVideoBrightness = brightNum ? (parseInt(brightNum.value) ?? 60) : 60;
    
    const cvVolVal = parseInt(document.getElementById('reels-cv-volume-num').value);
    task.contentVideoVolume = isNaN(cvVolVal) ? 100 : cvVolVal;

    task.contentVideoScale = parseInt(document.getElementById('reels-cv-scale-num').value) || 100;
    task.contentVideoFlipH = document.getElementById('reels-cv-fliph-ui').checked;
    task.contentVideoFlipV = document.getElementById('reels-cv-flipv-ui').checked;
    
    const trimStartVal = document.getElementById('reels-cv-trim-start').value.trim();
    task.contentVideoTrimStart = trimStartVal === '' ? null : parseFloat(trimStartVal);
    
    const trimEndVal = document.getElementById('reels-cv-trim-end').value.trim();
    task.contentVideoTrimEnd = trimEndVal === '' ? null : parseFloat(trimEndVal);

    // 空间画面裁切
    const cLeft = parseFloat(document.getElementById('reels-cv-crop-left').value) || 0;
    const cTop = parseFloat(document.getElementById('reels-cv-crop-top').value) || 0;
    const cWidth = parseFloat(document.getElementById('reels-cv-crop-width').value) || 100;
    const cHeight = parseFloat(document.getElementById('reels-cv-crop-height').value) || 100;
    
    if (cLeft !== 0 || cTop !== 0 || cWidth !== 100 || cHeight !== 100) {
        task.contentVideoCrop = `${cLeft},${cTop},${cWidth},${cHeight}`;
    } else {
        task.contentVideoCrop = '';
    }

    console.log('[BgConfigUI] Saved config: bgScale=' + task.bgScale + ' bgVideoVolume=' + task.bgVideoVolume + ' bgDurScale=' + task.bgDurScale + ' bgMode=' + task.bgMode + ' bgTransition=' + task.bgTransition + ' bgTransDur=' + task.bgTransDur + ' contentVideoBlurBg=' + task.contentVideoBlurBg + ' contentVideoVolume=' + task.contentVideoVolume + ' crop=' + task.contentVideoCrop);

    // 重新渲染批量表和预览
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof _applyPreviewAudioMix === 'function') _applyPreviewAudioMix();
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsToggleBgModeUI = function(mode) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgMode = mode;
    if (mode === 'single') {
        task.bgClipPool = [];
        task.bgClipActivePool = [];
        task.bgClipOrder = 'random';
    } else if (mode === 'multi') {
        task.bgPath = '';
        task.videoPath = '';
        task.bgSrcUrl = '';
        task.bgClipPool = Array.isArray(task.bgClipPool) ? task.bgClipPool : [];
        task.bgClipActivePool = Array.isArray(task.bgClipActivePool) ? task.bgClipActivePool : [];
        task.bgClipOrder = task.bgClipOrder || 'random';
    }
    
    // 面板显示切换
    const singleContainer = document.getElementById('reels-bg-single-container');
    const multiContainer = document.getElementById('reels-bg-multi-container');
    if (singleContainer) singleContainer.style.display = mode === 'single' ? 'flex' : 'none';
    if (multiContainer) multiContainer.style.display = mode === 'multi' ? 'flex' : 'none';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsManageBgPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsShowBgPoolDialog) {
        window.reelsShowBgPoolDialog(idx);
    }
};

window.reelsSelectClipPoolUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsPickClipPool) {
        await window.reelsPickClipPool(idx);
        const task = _reelsState.tasks[idx];
        window.reelsSyncBackgroundTabUI(task);
    }
};

window.reelsClearClipPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;
    task.clipPoolDir = '';
    task.clipPool = [];
    task.concatStatus = '';
    task.concatVideoPath = '';
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    window.reelsSyncBackgroundTabUI(task);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsChangeClipOrderUI = function(order) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;
    task.clipOrder = order;
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsConcatClipPoolUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsConcatTaskClipPool) {
        const statusEl = document.getElementById('reels-bg-clippool-status-ui');
        if (statusEl) statusEl.textContent = '⏳ 拼接中...';
        const btn = document.getElementById('reels-bg-clippool-concat-btn');
        if (btn) btn.disabled = true;
        
        try {
            await window.reelsConcatTaskClipPool(idx);
        } finally {
            if (btn) btn.disabled = false;
            const task = _reelsState.tasks[idx];
            window.reelsSyncBackgroundTabUI(task);
        }
    }
};
window.reelsToggleBgmModeUI = function(mode) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgmMode = mode;
    if (mode === 'single') {
        task.bgmClipPool = [];
        task.bgmClipActivePool = [];
        task.bgmClipOrder = 'random';
    }
    
    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    window.reelsSyncBackgroundTabUI(task);
    if (typeof reelsUpdatePreview === 'function') reelsUpdatePreview();
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsSelectBgmPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择配乐素材 (音频)', ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'wma']);
    if (path) {
        task.bgmPath = path;
        document.getElementById('reels-bgm-path-ui').value = path;
        
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearBgmPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgmPath = '';
    document.getElementById('reels-bgm-path-ui').value = '';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsManageBgmPoolUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    if (window.reelsShowBgmPoolDialog) {
        window.reelsShowBgmPoolDialog(idx);
    }
};

window.reelsSelectBgPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择背景素材 (图片/视频)', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'jpg', 'jpeg', 'png', 'webp', 'gif']);
    if (path) {
        task.bgPath = path;
        task.bgSrcUrl = null;
        task.srcUrl = null;
        document.getElementById('reels-bg-path-ui').value = path;
        
        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearBgPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.bgPath = '';
    task.bgSrcUrl = null;
    task.srcUrl = null;
    document.getElementById('reels-bg-path-ui').value = '';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsSelectCvPathUI = async function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    const path = await _pickSingleFile('选择内容视频', ['mp4', 'mov', 'avi', 'mkv', 'webm']);
    if (path) {
        task.contentVideoPath = path;
        document.getElementById('reels-cv-path-ui').value = path;

        if (typeof _renderBatchTable === 'function') {
            if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
            _renderBatchTable();
        }
        if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
        if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
    }
};

window.reelsClearCvPathUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    task.contentVideoPath = '';
    document.getElementById('reels-cv-path-ui').value = '';

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsResetCvCropUI = function() {
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        const elRange = document.getElementById(id + '-range');
        if (el) el.value = val;
        if (elRange) elRange.value = val;
    };
    setVal('reels-cv-crop-left', 0);
    setVal('reels-cv-crop-top', 0);
    setVal('reels-cv-crop-width', 100);
    setVal('reels-cv-crop-height', 100);
    window.reelsSaveBgConfigUI();
};

window.reelsApplyCropPresetUI = function(preset) {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    let left = 0, top = 0, width = 100, height = 100;

    if (preset === 'full') {
        left = 0; top = 0; width = 100; height = 100;
    } else if (preset === 'half_height') {
        left = 0; top = 25; width = 100; height = 50;
    } else {
        let targetRatio = 16/9;
        if (preset === '16_9') targetRatio = 16 / 9;
        else if (preset === '4_5') targetRatio = 4 / 5;
        else if (preset === '1_1') targetRatio = 1 / 1;
        else if (preset === '9_16') targetRatio = 9 / 16;
        else if (preset === '1_2') targetRatio = 1 / 2;

        let srcW = 1080, srcH = 1920;
        const cvVideo = document.getElementById('reels-preview-contentvideo');
        const img = window._reelsState.previewContentImage;
        const seq = window._reelsState.cvSequence;

        if (cvVideo && cvVideo.videoWidth > 0) {
            srcW = cvVideo.videoWidth;
            srcH = cvVideo.videoHeight;
        } else if (img && img.naturalWidth > 0) {
            srcW = img.naturalWidth;
            srcH = img.naturalHeight;
        } else if (seq && seq.files && seq.files.length > 0) {
            const firstFile = seq.files[0];
            const firstImg = seq.loadedImages?.[firstFile];
            if (firstImg && firstImg.naturalWidth > 0) {
                srcW = firstImg.naturalWidth;
                srcH = firstImg.naturalHeight;
            }
        } else {
            const renderer = window._reelsState.renderer;
            if (renderer && renderer.canvas) {
                srcW = renderer.canvas.width;
                srcH = renderer.canvas.height;
            }
        }

        const srcRatio = srcW / srcH;
        if (targetRatio > srcRatio) {
            const newH = srcW / targetRatio;
            const hPct = Math.round((newH / srcH) * 100);
            left = 0;
            width = 100;
            height = Math.max(1, Math.min(100, hPct));
            top = Math.round((100 - height) / 2);
        } else {
            const newW = srcH * targetRatio;
            const wPct = Math.round((newW / srcW) * 100);
            top = 0;
            height = 100;
            width = Math.max(1, Math.min(100, wPct));
            left = Math.round((100 - width) / 2);
        }
    }

    const setVal = (id, val) => {
        const el = document.getElementById(id);
        const elRange = document.getElementById(id + '-range');
        if (el) el.value = val;
        if (elRange) elRange.value = val;
    };

    setVal('reels-cv-crop-left', left);
    setVal('reels-cv-crop-top', top);
    setVal('reels-cv-crop-width', width);
    setVal('reels-cv-crop-height', height);

    window.reelsSaveBgConfigUI();
};

window.reelsCopyCvToBgUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    if (!task.contentVideoPath) {
        alert('当前任务没有设置内容视频');
        return;
    }

    task.bgPath = task.contentVideoPath;
    task.bgSrcUrl = null;
    task.srcUrl = null;
    document.getElementById('reels-bg-path-ui').value = task.bgPath;

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsCopyBgToCvUI = function() {
    const idx = _reelsState.selectedIdx;
    if (idx < 0) return;
    const task = _reelsState.tasks[idx];
    if (!task) return;

    if (!task.bgPath) {
        alert('当前任务没有设置背景文件');
        return;
    }

    task.contentVideoPath = task.bgPath;
    document.getElementById('reels-cv-path-ui').value = task.contentVideoPath;

    if (typeof _renderBatchTable === 'function') {
        if (typeof _skipNextApply !== 'undefined') _skipNextApply = true;
        _renderBatchTable();
    }
    if (typeof reelsSelectTask === 'function') reelsSelectTask(idx);
    if (typeof window.reelsSaveHistory === 'function') window.reelsSaveHistory();
};

window.reelsResetParamUI = function(idPrefix, defaultValue) {
    const el = document.getElementById(idPrefix + '-num');
    const elRange = document.getElementById(idPrefix + '-range');
    if (el) {
        el.value = defaultValue;
        if (idPrefix === 'reels-bg-volume' || idPrefix === 'reels-bgm-task-volume') el.dataset.isCustom = 'false';
    }
    if (elRange) {
        elRange.value = defaultValue;
        if (idPrefix === 'reels-bg-volume' || idPrefix === 'reels-bgm-task-volume') elRange.dataset.isCustom = 'false';
    }
    window.reelsSaveBgConfigUI();
};

window.reelsResetTrimUI = function(id) {
    const el = document.getElementById(id);
    if (el) el.value = '';
    window.reelsSaveBgConfigUI();
};

window.reelsSetBgOffsetUI = function(axis, value) {
    const el = document.getElementById('reels-bg-' + axis + '-num');
    const elRange = document.getElementById('reels-bg-' + axis + '-range');
    if (el) el.value = value;
    if (elRange) elRange.value = value;
    window.reelsSaveBgConfigUI();
};
