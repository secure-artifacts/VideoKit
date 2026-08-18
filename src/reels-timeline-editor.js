/**
 * reels-timeline-editor.js — NLE 时间线编辑器 UI
 * 
 * 移植自 AutoSub_v8 TimelineWidget (PyQt6 QWidget → HTML Canvas)
 * 
 * 功能:
 *   - 多轨道显示 (视频/字幕/音频/图片/文本)
 *   - 时间刻度尺 + 播放头
 *   - 片段 (Clip) 拖拽、缩放、分割
 *   - 缩放/平移 (Ctrl+滚轮 / 水平滚动)
 *   - 轨道操作 (锁定/可见/批量开关)
 *   - 域分离线 (Visual ↕ Audio)
 */

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

const TL_TRACK_HEIGHT = 48;
const TL_HEADER_W = 140;
const TL_RULER_H = 28;
const TL_HANDLE_W = 6;
const TL_MIN_CLIP_W = 4;
const TL_COLORS = {
    bg: '#181818',
    ruler: '#0f0f1e',
    rulerText: '#8899aa',
    playhead: '#FF4444',
    gridMajor: 'rgba(255,255,255,0.08)',
    gridMinor: 'rgba(255,255,255,0.03)',
    headerBg: '#141414',
    headerBorder: 'rgba(255,255,255,0.08)',
    domainSep: '#FF6B6B',
    trackTypes: {
        video: '#3366FF',
        subs: '#FFD700',
        text: '#FF66CC',
        image: '#44CC88',
        audio: '#66BBFF',
    },
    selected: '#4c9eff',
    clipBg: 'rgba(255,255,255,0.1)',
};

class ReelsTimelineEditor {
    constructor(containerEl) {
        this.container = containerEl;

        // Canvas
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rte-canvas';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        // 数据
        this._duration = 10;          // 总时长 (秒)
        this._tracks = [];             // [{type, name, clips:[], locked, visible, ...}]
        this._playheadPos = 0;        // 播放头位置 (秒)

        // 视图状态
        this._scrollX = 0;
        this._scrollY = 0;
        this._pxPerSec = 80;          // 缩放
        this._autoFitDuration = true; // 任务加载时默认显示完整时长
        this._hasManualTimelineView = false; // 拖动片段后固定当前时间尺比例
        this._timelineTaskKey = null;
        this._selectedClip = null;    // {trackIdx, clipIdx}
        this._selectedClips = new Set(); // 多选键: "trackIdx:clipIdx"
        this._selectionAnchor = null; // Shift 连选起点
        this._hoveredClip = null;

        // 拖拽状态
        this._drag = null;            // {type: 'move'|'trim_start'|'trim_end'|'playhead', ...}

        // 回调
        this.onSeek = null;           // (timeSec) => {}
        this.onClipSelect = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipChange = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipDblClick = null;   // (trackIdx, clipIdx, clip, rect) => {}
        // 一个鼠标拖动是一笔编辑事务，而不是数百条 mousemove 历史。
        this.onEditStart = null;      // ({ type, trackIdx, clipIdx, clip }) => {}
        this.onEditEnd = null;        // ({ type, trackIdx, clipIdx, clip }) => {}

        // 浮动编辑器
        this._editingPopup = null;
        this._lastClickTime = 0;
        this._lastClickClip = null;

        this._init();
    }

    _init() {
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        Object.assign(this.canvas.style, {
            width: '100%', height: '100%', display: 'block', cursor: 'default'
        });
        this.canvas.tabIndex = 0;

        // 事件
        this.canvas.addEventListener('mousedown', (e) => {
            this.canvas.focus({ preventScroll: true });
            this._onMouseDown(e);
        });
        this.canvas.addEventListener('keydown', (e) => this._onKeyDown(e));
        
        // 绑定到 window 以防止鼠标移出画布后拖拽断开/卡住
        window.addEventListener('mousemove', (e) => this._onMouseMove(e));
        window.addEventListener('mouseup', (e) => this._onMouseUp(e));
        
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._onContextMenu(e);
        });

        // 点击画布其他区域时关闭编辑器
        document.addEventListener('mousedown', (e) => {
            if (this._rtEditor && this._rtEditor.popup && !this._rtEditor.popup.contains(e.target) && e.target !== this.canvas) {
                this._rtEditor.close(true);
            }
        });

        // 尺寸
        this._resize();
        const ro = new ResizeObserver(() => this._resize());
        ro.observe(this.container);

        this._renderLoop();
    }

    _resize() {
        const rect = this.container.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.floor(rect.width) * dpr;
        this.canvas.height = Math.floor(rect.height) * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._canvasW = Math.floor(rect.width);
        this._canvasH = Math.floor(rect.height);
        if (this._autoFitDuration) this._fitDurationToViewport();
    }

    // ═══════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════

    setDuration(dur, options = {}) {
        const fit = options.fit === true;
        this._duration = Math.max(1, dur);
        // 只有切换任务或用户主动要求时才重新适应窗口。
        // 字幕拖动会让预览重新上报时长，不能因此反复改变刻度尺缩放。
        if (fit) {
            this._autoFitDuration = true;
            this._hasManualTimelineView = false;
            this._scrollX = 0;
            this._fitDurationToViewport();
        } else if (this._autoFitDuration && !this._hasManualTimelineView) {
            this._fitDurationToViewport();
        }
    }

    _fitDurationToViewport() {
        if (!this._canvasW || !this._duration) return;
        // 右侧留出少量余量，避免最后一个刻度文字和播放头被裁切。
        const availableWidth = Math.max(1, this._canvasW - TL_HEADER_W - 24);
        this._pxPerSec = Math.max(0.1, Math.min(1000, availableWidth / this._duration));
    }

    setPlayhead(timeSec) {
        if (this._drag && this._drag.type === 'playhead') return;
        this._playheadPos = Math.max(0, Math.min(timeSec, this._duration));
    }

    setTracks(tracks) {
        this._tracks = tracks;
        this._clearClipSelection();
        this._autoAdjustContainerHeight();
    }

    _autoAdjustContainerHeight() {
        if (!this.container) return;
        const bodyEl = this.container.closest('.reels-timeline-body');
        if (!bodyEl || bodyEl.classList.contains('collapsed')) return;
        const trackCount = Array.isArray(this._tracks) ? this._tracks.length : 0;
        if (trackCount <= 0) return;
        const needed = TL_RULER_H + trackCount * (TL_TRACK_HEIGHT + 1) + 12;
        const targetHeight = Math.max(160, Math.min(500, needed));
        bodyEl.style.height = `${targetHeight}px`;
    }

    /**
     * 从 Timeline 数据模型设置轨道数据。
     */
    loadFromTimeline(timeline) {
        if (!timeline) return;
        const tracks = [];
        const allTracks = timeline.tracks || [];
        for (const t of allTracks) {
            const clips = (t.clips || []).map(c => ({
                start: c.start || 0,
                end: (c.start || 0) + (c.duration || c.effectiveDuration || 2),
                name: c.sourceId || c.label || '',
                color: TL_COLORS.trackTypes[t.type] || '#888',
            }));
            tracks.push({
                type: t.type || 'video',
                name: t.label || t.type || 'Track',
                clips,
                locked: t.locked || false,
                visible: t.visible !== false,
                domain: t.domain || 'visual',
            });
        }
        this._tracks = tracks;
        this._duration = Math.max(1, ...tracks.flatMap(t => t.clips.map(c => c.end)));
    }

    /**
     * 从 SRT segments 设置字幕轨道。
     */
    loadSubtitleTrack(segments) {
        if (!segments || !segments.length) {
            const existIdx = this._tracks.findIndex(t => t.type === 'subs');
            const track = { type: 'subs', name: '字幕', clips: [], locked: false, visible: true, domain: 'visual' };
            if (existIdx >= 0) this._tracks[existIdx] = track;
            else this._tracks.push(track);
            return;
        }
        const clips = segments.map((seg, i) => {
            const fullText = seg.edited_text || seg.text || seg.content || '';
            return {
                start: seg.start || 0,
                end: seg.end || 0,
                name: fullText.slice(0, 20) + (fullText.length > 20 ? '…' : ''),
                _fullText: fullText,
                color: TL_COLORS.trackTypes.subs,
                _segIdx: i,
                styled_ranges: seg.styled_ranges || null,
                style_override: seg.style_override || null,
            };
        });
        // 检查是否已有字幕轨
        const existIdx = this._tracks.findIndex(t => t.type === 'subs');
        const track = { type: 'subs', name: '字幕', clips, locked: false, visible: true, domain: 'visual' };
        if (existIdx >= 0) {
            this._tracks[existIdx] = track;
        } else {
            this._tracks.push(track);
        }
        this._duration = Math.max(this._duration, ...clips.map(c => c.end));
    }

    /**
     * 设置/更新背景轨道片段（用于预览时长与可视化）。
     */
    loadBackgroundTrack(durationSec, name = '背景') {
        const dur = Math.max(0, Number(durationSec) || 0);
        const clips = dur > 0 ? [{
            start: 0,
            end: dur,
            name,
            color: TL_COLORS.trackTypes.video,
        }] : [];
        const existIdx = this._tracks.findIndex(t => t.type === 'video');
        const track = { type: 'video', name: '视频', clips, locked: false, visible: true, domain: 'visual' };
        if (existIdx >= 0) this._tracks[existIdx] = track;
        else this._tracks.unshift(track);
        if (dur > 0) this._duration = Math.max(this._duration, dur);
    }

    /**
     * 设置/更新配音轨道片段。
     */
    loadAudioTrack(durationSec, name = '配音') {
        const dur = Math.max(0, Number(durationSec) || 0);
        const clips = dur > 0 ? [{
            start: 0,
            end: dur,
            name,
            color: TL_COLORS.trackTypes.audio,
        }] : [];
        const existIdx = this._tracks.findIndex(t => t.type === 'audio');
        const track = { type: 'audio', name: '音频', clips, locked: false, visible: true, domain: 'audio' };
        if (existIdx >= 0) this._tracks[existIdx] = track;
        else this._tracks.push(track);
        if (dur > 0) this._duration = Math.max(this._duration, dur);
    }

    // ═══════════════════════════════════════════════
    // 渲染
    // ═══════════════════════════════════════════════

    _renderLoop() {
        this._render();
        requestAnimationFrame(() => this._renderLoop());
    }

    _render() {
        const ctx = this.ctx;
        const W = this._canvasW;
        const H = this._canvasH;
        if (!W || !H) return;

        ctx.clearRect(0, 0, W, H);

        // 背景
        ctx.fillStyle = TL_COLORS.bg;
        ctx.fillRect(0, 0, W, H);

        // 时间刻度尺
        this._drawRuler(ctx, W);

        // 轨道区域
        this._drawTracks(ctx, W, H);

        // 序列终点是一个独立的编辑边界，不等同于红色播放头。它让用户一眼
        // 看出最后一个片段/循环背景真正在哪结束。
        this._drawEndMarker(ctx, W, H);

        // 播放头
        this._drawPlayhead(ctx, W, H);

        // 框选区域
        this._drawMarquee(ctx);
    }

    _drawRuler(ctx, W) {
        ctx.fillStyle = TL_COLORS.ruler;
        ctx.fillRect(0, 0, W, TL_RULER_H);

        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, TL_RULER_H);
        ctx.lineTo(W, TL_RULER_H);
        ctx.stroke();

        // 刻度
        const step = this._calcRulerStep();
        const startTime = Math.floor(this._scrollX / this._pxPerSec / step) * step;
        const endTime = (this._scrollX + W - TL_HEADER_W) / this._pxPerSec;

        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = TL_COLORS.rulerText;

        for (let t = startTime; t <= endTime + step; t += step) {
            const x = TL_HEADER_W + (t * this._pxPerSec) - this._scrollX;
            if (x < TL_HEADER_W || x > W) continue;

            // 主刻度
            ctx.strokeStyle = TL_COLORS.gridMajor;
            ctx.beginPath();
            ctx.moveTo(x, TL_RULER_H - 10);
            ctx.lineTo(x, TL_RULER_H);
            ctx.stroke();

            ctx.fillText(this._formatTime(t), x, TL_RULER_H - 13);

            // 次刻度
            const subStep = step / 4;
            for (let s = 1; s < 4; s++) {
                const sx = TL_HEADER_W + ((t + s * subStep) * this._pxPerSec) - this._scrollX;
                if (sx < TL_HEADER_W || sx > W) continue;
                ctx.strokeStyle = TL_COLORS.gridMinor;
                ctx.beginPath();
                ctx.moveTo(sx, TL_RULER_H - 5);
                ctx.lineTo(sx, TL_RULER_H);
                ctx.stroke();
            }
        }
    }

    _drawTracks(ctx, W, H) {
        let y = TL_RULER_H - this._scrollY;
        let lastDomain = null;

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];

            // 域分离线
            if (lastDomain === 'visual' && track.domain === 'audio') {
                ctx.strokeStyle = TL_COLORS.domainSep;
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 3]);
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(W, y);
                ctx.stroke();
                ctx.setLineDash([]);
                y += 4;
            }
            lastDomain = track.domain;

            // 轨道可见范围检查
            if (y + TL_TRACK_HEIGHT < 0 || y > H) { y += TL_TRACK_HEIGHT + 1; continue; }

            // 轨道头部
            this._drawTrackHeader(ctx, track, y, ti);

            // 轨道内容背景
            ctx.fillStyle = ti % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.1)';
            ctx.fillRect(TL_HEADER_W, y, W - TL_HEADER_W, TL_TRACK_HEIGHT);

            // 网格线 (对齐刻度)
            const step = this._calcRulerStep();
            for (let t = 0; t <= this._duration; t += step) {
                const gx = TL_HEADER_W + t * this._pxPerSec - this._scrollX;
                if (gx < TL_HEADER_W || gx > W) continue;
                ctx.strokeStyle = TL_COLORS.gridMinor;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(gx, y);
                ctx.lineTo(gx, y + TL_TRACK_HEIGHT);
                ctx.stroke();
            }

            // 片段只能画在右侧时间区域内。没有这个裁切时，横向滚动的片段
            // 会越过 0 秒边界盖住左侧轨道名称，看上去像“滚动穿帮”。
            ctx.save();
            ctx.beginPath();
            ctx.rect(TL_HEADER_W, y, Math.max(0, W - TL_HEADER_W), TL_TRACK_HEIGHT);
            ctx.clip();
            for (let ci = 0; ci < track.clips.length; ci++) {
                this._drawClip(ctx, track, ti, ci, y);
            }

            // 检查背景画面覆盖范围，若末尾存在空白缺口（黑屏风险），绘制醒目的红色警示区域
            const isBackgroundTrack = track.type === 'video' || (track.name && track.name.includes('背景'));
            if (isBackgroundTrack && track.clips.length > 0) {
                const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
                if (this._duration > maxEnd + 0.1) {
                    const gapStartPx = TL_HEADER_W + maxEnd * this._pxPerSec - this._scrollX;
                    const gapEndPx = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
                    const drawX0 = Math.max(TL_HEADER_W, gapStartPx);
                    const drawX1 = Math.min(W, gapEndPx);
                    if (drawX1 > drawX0) {
                        // 红色半透明背景
                        ctx.fillStyle = 'rgba(239, 68, 68, 0.18)';
                        ctx.fillRect(drawX0, y + 2, drawX1 - drawX0, TL_TRACK_HEIGHT - 4);

                        // 红色对角斜条纹
                        ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
                        ctx.lineWidth = 2;
                        const stripeGap = 14;
                        for (let sx = drawX0 - TL_TRACK_HEIGHT; sx < drawX1 + TL_TRACK_HEIGHT; sx += stripeGap) {
                            ctx.beginPath();
                            ctx.moveTo(sx, y + TL_TRACK_HEIGHT - 2);
                            ctx.lineTo(sx + TL_TRACK_HEIGHT, y + 2);
                            ctx.stroke();
                        }

                        // 红色虚线边框
                        ctx.strokeStyle = '#ef4444';
                        ctx.lineWidth = 1.5;
                        ctx.setLineDash([5, 3]);
                        ctx.strokeRect(drawX0 + 0.5, y + 2.5, drawX1 - drawX0 - 1, TL_TRACK_HEIGHT - 5);
                        ctx.setLineDash([]);

                        // 警示文字与补充提示
                        const missingSec = (this._duration - maxEnd).toFixed(1);
                        const label = `⚠️ 画面不足 (缺 ${missingSec}s · 右键补充循环)`;
                        ctx.font = 'bold 10px system-ui, sans-serif';
                        ctx.fillStyle = '#fca5a5';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const textX = (drawX0 + drawX1) / 2;
                        const textY = y + TL_TRACK_HEIGHT / 2;
                        if (drawX1 - drawX0 > 60) {
                            ctx.fillText(label, textX, textY);
                        }
                    }
                }
            }
            ctx.restore();

            y += TL_TRACK_HEIGHT + 1;
        }
    }

    _drawTrackHeader(ctx, track, y, idx) {
        ctx.fillStyle = TL_COLORS.headerBg;
        ctx.fillRect(0, y, TL_HEADER_W, TL_TRACK_HEIGHT);

        // 边框
        ctx.strokeStyle = TL_COLORS.headerBorder;
        ctx.lineWidth = 1;
        ctx.strokeRect(0, y, TL_HEADER_W, TL_TRACK_HEIGHT);

        // 类型色条
        const typeColor = TL_COLORS.trackTypes[track.type] || '#888';
        ctx.fillStyle = typeColor;
        ctx.fillRect(0, y, 4, TL_TRACK_HEIGHT);

        // 名称
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillStyle = '#ccc';
        ctx.textAlign = 'left';
        ctx.fillText(track.name, 10, y + TL_TRACK_HEIGHT / 2 + 4);

        // 头部警示徽章
        const isBg = track.type === 'video' || (track.name && track.name.includes('背景'));
        if (isBg && track.clips && track.clips.length > 0) {
            const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
            if (this._duration > maxEnd + 0.1) {
                const missingSec = (this._duration - maxEnd).toFixed(1);
                ctx.fillStyle = '#ef4444';
                ctx.font = 'bold 9px system-ui, sans-serif';
                ctx.textAlign = 'right';
                ctx.fillText(`⚠️缺${missingSec}s`, TL_HEADER_W - 6, y + TL_TRACK_HEIGHT / 2 + 4);
            }
        }

        // 状态图标
        const icons = [];
        if (track.locked) icons.push('🔒');
        if (!track.visible) icons.push('👁️‍🗨️');

        if (icons.length) {
            ctx.font = '10px system-ui';
            ctx.fillStyle = '#888';
            ctx.textAlign = 'right';
            ctx.fillText(icons.join(' '), TL_HEADER_W - 6, y + TL_TRACK_HEIGHT / 2 + 4);
        }
    }

    _drawClip(ctx, track, trackIdx, clipIdx, trackY) {
        const clip = track.clips[clipIdx];
        const x = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
        const w = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);
        const y = trackY + 3;
        const h = TL_TRACK_HEIGHT - 6;
        // 循环素材不是一个长块：保留少量视觉间隙，让每一轮都能一眼看见。
        // 命中/拖拽仍使用原始时间范围，不会在时间线上制造真实空白。
        const isLoopInstance = clip._isLoopInstance === true;
        const seam = isLoopInstance && w > 12 ? 2 : 0;
        const drawX = x + seam;
        const drawW = Math.max(1, w - seam * 2);

        // 可见范围检查
        if (x + w < TL_HEADER_W || x > this._canvasW) return;

        const isSelected = this._selectedClips.has(this._clipKey(trackIdx, clipIdx));
        const isHovered = this._hoveredClip?.trackIdx === trackIdx && this._hoveredClip?.clipIdx === clipIdx;

        // 片段背景
        const color = clip.color || TL_COLORS.trackTypes[track.type] || '#888';
        ctx.fillStyle = isSelected ? color : isHovered ? this._lighten(color, 0.15) : this._darken(color, 0.3);
        ctx.globalAlpha = isSelected ? 0.9 : 0.7;

        // 圆角
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(drawX + r, y);
        ctx.lineTo(drawX + drawW - r, y);
        ctx.quadraticCurveTo(drawX + drawW, y, drawX + drawW, y + r);
        ctx.lineTo(drawX + drawW, y + h - r);
        ctx.quadraticCurveTo(drawX + drawW, y + h, drawX + drawW - r, y + h);
        ctx.lineTo(drawX + r, y + h);
        ctx.quadraticCurveTo(drawX, y + h, drawX, y + h - r);
        ctx.lineTo(drawX, y + r);
        ctx.quadraticCurveTo(drawX, y, drawX + r, y);
        ctx.closePath();
        ctx.fill();

        ctx.globalAlpha = 1;

        if (isLoopInstance) {
            // 明亮描边 + 接缝竖线，缩放很远时也能辨认出循环次数。
            ctx.strokeStyle = 'rgba(137, 184, 255, 0.9)';
            ctx.lineWidth = 1;
            ctx.stroke();
            if (x > TL_HEADER_W && x < this._canvasW) {
                ctx.strokeStyle = '#9dc5ff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, y + 2);
                ctx.lineTo(x, y + h - 2);
                ctx.stroke();
            }
        }

        // 选中边框
        if (isSelected) {
            ctx.strokeStyle = TL_COLORS.selected;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // 片段文本
        if (w > 30) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(drawX + 2, y, drawW - 4, h);
            ctx.clip();

            ctx.font = '10px system-ui, sans-serif';
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.fillText(clip.name || '', drawX + 6, y + h / 2 + 3);
            ctx.restore();
        }

        // Trim 手柄 (仅选中/悬停时)
        if (isSelected || isHovered) {
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fillRect(x, y, TL_HANDLE_W, h);
            ctx.fillRect(x + w - TL_HANDLE_W, y, TL_HANDLE_W, h);
        }
    }

    _drawPlayhead(ctx, W, H) {
        const x = TL_HEADER_W + this._playheadPos * this._pxPerSec - this._scrollX;
        if (x < TL_HEADER_W - 20 || x > W + 20) return;

        ctx.save();

        // 1. 发光外晕竖线 (Glow Aura)
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();

        // 2. 鲜红核心竖线 (Red Core Line)
        ctx.strokeStyle = '#ff3344';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();

        // 3. 顶部红宝石播放头游标 (Header Pin Badge)
        ctx.shadowColor = 'rgba(255, 42, 68, 0.6)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 1;

        const headW = 7;
        const headH = TL_RULER_H - 2;
        ctx.fillStyle = '#ff2a44';
        ctx.beginPath();
        ctx.moveTo(x - headW, 0);
        ctx.lineTo(x + headW, 0);
        ctx.lineTo(x + headW, headH - 7);
        ctx.lineTo(x, headH);
        ctx.lineTo(x - headW, headH - 7);
        ctx.closePath();
        ctx.fill();

        // 边框与内部白色高光点
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#ffaab4';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, 7, 1.8, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    _drawEndMarker(ctx, W, H) {
        const x = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
        if (x < TL_HEADER_W || x > W) return;
        ctx.save();
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = 'bold 9px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('结束', x - 4, TL_RULER_H + 12);
        ctx.restore();
    }

    // ═══════════════════════════════════════════════
    // 鼠标交互
    // ═══════════════════════════════════════════════

    _findLinkedClipRefs(linkGroupId) {
        if (!linkGroupId) return [];
        const result = [];
        this._tracks.forEach((track, trackIdx) => {
            (track.clips || []).forEach((clip, clipIdx) => {
                if (clip && clip._linkGroupId === linkGroupId) {
                    result.push({
                        trackIdx, clipIdx, clip,
                        origStart: clip.start,
                        origEnd: clip.end,
                    });
                }
            });
        });
        return result;
    }

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // 1. 点击刻度尺 → seek
        if (my < TL_RULER_H) {
            this._drag = { type: 'playhead' };
            this._seekToX(mx, 'mousedown');
            return;
        }

        // 2. 点击轨道头部 → 忽略
        if (mx < TL_HEADER_W) return;

        // 3. 检测是否点击了 Trim 手柄
        const hitInfo = this._hitTestClip(mx, my);
        if (hitInfo) {
            const key = this._clipKey(hitInfo.trackIdx, hitInfo.clipIdx);
            const toggleSelection = e.ctrlKey || e.metaKey;
            const rangeSelection = e.shiftKey;

            if (rangeSelection && this._selectionAnchor?.trackIdx === hitInfo.trackIdx) {
                if (!toggleSelection) this._selectedClips.clear();
                const from = Math.min(this._selectionAnchor.clipIdx, hitInfo.clipIdx);
                const to = Math.max(this._selectionAnchor.clipIdx, hitInfo.clipIdx);
                for (let ci = from; ci <= to; ci++) {
                    this._selectedClips.add(this._clipKey(hitInfo.trackIdx, ci));
                }
            } else if (toggleSelection) {
                if (this._selectedClips.has(key)) this._selectedClips.delete(key);
                else this._selectedClips.add(key);
                this._selectionAnchor = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            } else if (!this._selectedClips.has(key)) {
                this._selectedClips.clear();
                this._selectedClips.add(key);
                this._selectionAnchor = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            }

            this._selectedClip = this._selectedClips.has(key)
                ? { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx }
                : this._firstSelectedClip();
            const clip = this._tracks[hitInfo.trackIdx].clips[hitInfo.clipIdx];
            const track = this._tracks[hitInfo.trackIdx];

            // ── 双击检测 ──
            const now = Date.now();
            const clipKey = `${hitInfo.trackIdx}_${hitInfo.clipIdx}`;
            if (now - this._lastClickTime < 400 && this._lastClickClip === clipKey) {
                // 双击 → 打开字幕编辑
                this._lastClickTime = 0;
                this._lastClickClip = null;
                if (track.type === 'subs') {
                    const clipRect = this._getClipScreenRect(hitInfo.trackIdx, hitInfo.clipIdx);
                    if (this.onClipDblClick) {
                        this.onClipDblClick(hitInfo.trackIdx, hitInfo.clipIdx, clip, clipRect);
                    } else {
                        this._openSubtitleEditor(hitInfo.trackIdx, hitInfo.clipIdx, clip, clipRect);
                    }
                }
                return;
            }
            this._lastClickTime = now;
            this._lastClickClip = clipKey;

            if (!this._selectedClips.has(key)) {
                this._drag = null;
            } else if (hitInfo.zone === 'start') {
                const linked = clip._linkGroupId ? this._findLinkedClipRefs(clip._linkGroupId) : [{ trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, clip, origStart: clip.start, origEnd: clip.end }];
                const followingClips = [];
                const origEnd = clip.end;
                const isSequenced = clip._isLoopInstance || clip._timelineRole === 'background' || clip._timelineRole === 'source_audio';
                if (isSequenced) {
                    this._tracks.forEach((track, ti) => {
                        if (track.type === 'video' || track.type === 'audio') {
                            (track.clips || []).forEach((c, ci) => {
                                if (c && c.start >= origEnd - 0.05 && !linked.some(l => l.trackIdx === ti && l.clipIdx === ci)) {
                                    followingClips.push({ trackIdx: ti, clipIdx: ci, clip: c, origStart: c.start, origEnd: c.end });
                                }
                            });
                        }
                    });
                }
                this._drag = { type: 'trim_start', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, origEnd: clip.end, isSequenced, mx0: mx, linked, followingClips };
            } else if (hitInfo.zone === 'end') {
                const linked = clip._linkGroupId ? this._findLinkedClipRefs(clip._linkGroupId) : [{ trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, clip, origStart: clip.start, origEnd: clip.end }];
                const followingClips = [];
                const origEnd = clip.end;
                const isSequenced = clip._isLoopInstance || clip._timelineRole === 'background' || clip._timelineRole === 'source_audio';
                if (isSequenced) {
                    this._tracks.forEach((track, ti) => {
                        if (track.type === 'video' || track.type === 'audio') {
                            (track.clips || []).forEach((c, ci) => {
                                if (c && c.start >= origEnd - 0.05 && !linked.some(l => l.trackIdx === ti && l.clipIdx === ci)) {
                                    followingClips.push({ trackIdx: ti, clipIdx: ci, clip: c, origStart: c.start, origEnd: c.end });
                                }
                            });
                        }
                    });
                }
                this._drag = { type: 'trim_end', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, origEnd: clip.end, isSequenced, mx0: mx, linked, followingClips };
            } else {
                const groupMap = new Map();
                this._selectedClipRefs().forEach(item => {
                    groupMap.set(`${item.trackIdx}_${item.clipIdx}`, { ...item, origStart: item.clip.start, origEnd: item.clip.end });
                });
                if (clip._linkGroupId) {
                    this._findLinkedClipRefs(clip._linkGroupId).forEach(item => {
                        groupMap.set(`${item.trackIdx}_${item.clipIdx}`, item);
                    });
                }
                const group = Array.from(groupMap.values());
                this._drag = {
                    type: 'move', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx,
                    origStart: clip.start, origEnd: clip.end, mx0: mx, group,
                };
            }

            // 编辑片段后保持当前尺子比例；预览时长的后续刷新不能把视图拉伸/压缩。
            if (this._drag && this._drag.type !== 'playhead') {
                this._autoFitDuration = false;
                this._hasManualTimelineView = true;
                if (this.onEditStart) {
                    this.onEditStart({
                        type: this._drag.type,
                        trackIdx: hitInfo.trackIdx,
                        clipIdx: hitInfo.clipIdx,
                        clip,
                    });
                }
            }

            if (this.onClipSelect) this.onClipSelect(hitInfo.trackIdx, hitInfo.clipIdx, clip);
        } else {
            const keepExisting = e.ctrlKey || e.metaKey || e.shiftKey;
            const baseSelection = keepExisting ? new Set(this._selectedClips) : new Set();
            if (!keepExisting) this._clearClipSelection();
            // 空白拖动执行框选；未发生拖动时 mouseup 仍按普通点击执行 seek。
            this._drag = {
                type: 'marquee', mx0: mx, my0: my, mx1: mx, my1: my,
                moved: false, baseSelection,
            };
        }
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Drag
        if (this._drag) {
            const dxPx = mx - this._drag.mx0;
            const dyPx = my - (this._drag.my0 || 0);
            if (Math.abs(dxPx) >= 2 || Math.abs(dyPx) >= 2) {
                this._drag.moved = true;
            }
            const dt = dxPx / this._pxPerSec;

            if (this._drag.type === 'playhead') {
                this._seekToX(mx, 'mousemove');
                return;
            }

            if (this._drag.type === 'marquee') {
                this._drag.mx1 = mx;
                this._drag.my1 = my;
                if (this._drag.moved) this._updateMarqueeSelection(this._drag);
                return;
            }

            const clip = this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx];
            if (!clip) return;

            const snapThresholdSec = Math.max(0.02, 6 / this._pxPerSec);

            if (this._drag.type === 'trim_start') {
                const maxTrim = (this._drag.origEnd - this._drag.origStart) - 0.05;
                const dtTrim = Math.max(0, Math.min(dt, maxTrim));
                this._drag.lastTrimOffset = dtTrim;
                
                if (this._drag.isSequenced) {
                    const newEnd = Math.max(this._drag.origStart + 0.05, this._drag.origEnd - dtTrim);
                    clip.start = this._drag.origStart;
                    clip.end = newEnd;
                    if (Array.isArray(this._drag.linked)) {
                        for (const item of this._drag.linked) {
                            item.clip.start = this._drag.origStart;
                            item.clip.end = newEnd;
                        }
                    }
                    if (Array.isArray(this._drag.followingClips)) {
                        for (const item of this._drag.followingClips) {
                            item.clip.start = Math.max(newEnd, item.origStart - dtTrim);
                            item.clip.end = Math.max(item.clip.start + 0.05, item.origEnd - dtTrim);
                        }
                    }
                    return;
                } else {
                    const newStart = this._drag.origStart + dtTrim;
                    clip.start = newStart;
                    clip.end = this._drag.origEnd;
                    if (Array.isArray(this._drag.linked)) {
                        for (const item of this._drag.linked) {
                            item.clip.start = newStart;
                            item.clip.end = this._drag.origEnd;
                        }
                    }
                    return;
                }
            } else if (this._drag.type === 'trim_end') {
                let newEnd = Math.max(this._drag.origStart + 0.05, this._drag.origEnd + dt);
                const delta = newEnd - this._drag.origEnd;
                clip.end = newEnd;
                if (Array.isArray(this._drag.linked)) {
                    for (const item of this._drag.linked) {
                        item.clip.end = newEnd;
                    }
                }
                if (Array.isArray(this._drag.followingClips)) {
                    for (const item of this._drag.followingClips) {
                        item.clip.start = Math.max(newEnd, item.origStart + delta);
                        item.clip.end = Math.max(item.clip.start + 0.05, item.origEnd + delta);
                    }
                }
                return;
            } else if (this._drag.type === 'move') {
                const group = this._drag.group || [];
                const minStart = group.length > 0
                    ? Math.min(...group.map(item => item.origStart))
                    : this._drag.origStart;
                let safeDt = dt;
                // 磁吸到 0.0s 边界
                if (minStart + dt < snapThresholdSec && minStart + dt > -snapThresholdSec) {
                    safeDt = -minStart;
                } else {
                    safeDt = Math.max(dt, -minStart);
                }
                for (const item of group) {
                    item.clip.start = item.origStart + safeDt;
                    item.clip.end = item.origEnd + safeDt;
                }
                return;
            }
            return;
        }

        // Hover
        if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) {
            this._hoveredClip = null;
            return;
        }

        const hitInfo = this._hitTestClip(mx, my);
        this._hoveredClip = hitInfo ? { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx } : null;

        if (hitInfo) {
            if (hitInfo.zone === 'start' || hitInfo.zone === 'end') {
                this.canvas.style.cursor = 'col-resize';
            } else {
                this.canvas.style.cursor = 'pointer';
            }
            this.canvas.title = '';
        } else if (this._hitTestGap(mx, my)) {
            this.canvas.style.cursor = 'default';
            this.canvas.title = '右键菜单可补充背景循环至结尾';
        } else if (my < TL_RULER_H && mx >= TL_HEADER_W) {
            this.canvas.style.cursor = 'pointer';
            this.canvas.title = '';
        } else {
            this.canvas.style.cursor = 'default';
            this.canvas.title = '';
        }
    }

    _onMouseUp(e) {
        const wasPlayheadDrag = this._drag && this._drag.type === 'playhead';
        const marquee = this._drag && this._drag.type === 'marquee' ? this._drag : null;
        const wasRealMove = this._drag && this._drag.moved;
        const edit = this._drag && wasRealMove && !['playhead', 'marquee'].includes(this._drag.type)
            ? {
                type: this._drag.type,
                trackIdx: this._drag.trackIdx,
                clipIdx: this._drag.clipIdx,
                clip: this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx],
                trimOffset: this._drag.lastTrimOffset || 0,
                origStart: this._drag.origStart,
                origEnd: this._drag.origEnd,
                origInT: this._drag.origInT,
            }
            : null;
        this._drag = null;
        if (edit && edit.clip && this.onClipChange) {
            this.onClipChange(edit.trackIdx, edit.clipIdx, edit.clip, {
                editMode: edit.type,
                trimOffset: edit.trimOffset,
                origStart: edit.origStart,
                origEnd: edit.origEnd,
                origInT: edit.origInT,
            });
        }
        if (edit && edit.clip && this.onEditEnd) this.onEditEnd(edit);
        if (wasPlayheadDrag && this.onSeek) this.onSeek(this._playheadPos, 'mouseup');
        if (marquee && !marquee.moved) {
            this._seekToX(marquee.mx0, 'mousedown');
            if (this.onSeek) this.onSeek(this._playheadPos, 'mouseup');
        }
    }

    _onWheel(e) {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // 缩放
            this._autoFitDuration = false;
            const factor = e.deltaY > 0 ? 0.85 : 1.18;
            this._pxPerSec = Math.max(10, Math.min(1000, this._pxPerSec * factor));
        } else if (e.shiftKey) {
            // 垂直滚动
            this._scrollY = Math.max(0, this._scrollY + e.deltaY);
        } else {
            // 水平滚动
            this._scrollX = Math.max(0, this._scrollX + e.deltaY);
        }
    }

    _onKeyDown(e) {
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a') {
            e.preventDefault();
            const preferredTrack = this._selectedClip?.trackIdx
                ?? this._hoveredClip?.trackIdx
                ?? this._tracks.findIndex(track => track.type === 'subs');
            const trackIdx = preferredTrack >= 0 ? preferredTrack : 0;
            const track = this._tracks[trackIdx];
            this._selectedClips.clear();
            if (track && !track.locked) {
                for (let ci = 0; ci < track.clips.length; ci++) {
                    this._selectedClips.add(this._clipKey(trackIdx, ci));
                }
            }
            this._selectedClip = this._firstSelectedClip();
            if (this._selectedClip) this._selectionAnchor = { ...this._selectedClip };
        } else if (e.key === 'Escape') {
            this._clearClipSelection();
        }
    }

    // ═══════════════════════════════════════════════
    // Hit Testing
    // ═══════════════════════════════════════════════

    _hitTestClip(mx, my) {
        let y = TL_RULER_H - this._scrollY;

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];

            if (my >= y && my < y + TL_TRACK_HEIGHT) {
                for (let ci = 0; ci < track.clips.length; ci++) {
                    const clip = track.clips[ci];
                    const cx = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
                    const cw = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);

                    if (mx >= cx && mx <= cx + cw) {
                        let zone = 'body';
                        if (mx - cx < TL_HANDLE_W) zone = 'start';
                        if (cx + cw - mx < TL_HANDLE_W) zone = 'end';
                        return { trackIdx: ti, clipIdx: ci, zone };
                    }
                }
            }
            y += TL_TRACK_HEIGHT + 1;
            // 域分离间隔
            if (ti < this._tracks.length - 1 &&
                track.domain === 'visual' && this._tracks[ti + 1]?.domain === 'audio') {
                y += 4;
            }
        }
        return null;
    }

    _hitTestGap(mx, my) {
        let y = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];
            const isBackgroundTrack = track.type === 'video' || (track.name && track.name.includes('背景'));
            if (isBackgroundTrack && track.clips && track.clips.length > 0) {
                if (my >= y && my < y + TL_TRACK_HEIGHT) {
                    const maxEnd = Math.max(0, ...track.clips.map(c => c.end || 0));
                    if (this._duration > maxEnd + 0.1) {
                        const gx0 = TL_HEADER_W + maxEnd * this._pxPerSec - this._scrollX;
                        const gx1 = TL_HEADER_W + this._duration * this._pxPerSec - this._scrollX;
                        if (mx >= Math.max(TL_HEADER_W, gx0) && mx <= gx1) {
                            return { trackIdx: ti, gapStart: maxEnd, gapEnd: this._duration };
                        }
                    }
                }
            }
            y += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 && track.domain === 'visual' && this._tracks[ti + 1]?.domain === 'audio') {
                y += 4;
            }
        }
        return null;
    }

    _onContextMenu(e) {
        const oldMenu = document.getElementById('reels-timeline-ctx-menu');
        if (oldMenu) oldMenu.remove();

        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hitInfo = this._hitTestClip(mx, my);
        if (hitInfo) {
            const key = this._clipKey(hitInfo.trackIdx, hitInfo.clipIdx);
            if (!this._selectedClips.has(key)) {
                this._selectedClips.clear();
                this._selectedClips.add(key);
                this._selectedClip = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
            }
        }

        const menu = document.createElement('div');
        menu.id = 'reels-timeline-ctx-menu';
        Object.assign(menu.style, {
            position: 'fixed',
            left: `${Math.min(window.innerWidth - 200, e.clientX)}px`,
            top: `${Math.min(window.innerHeight - 180, e.clientY)}px`,
            zIndex: '999999',
            background: 'rgba(23, 23, 28, 0.96)',
            backdropFilter: 'blur(12px)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            borderRadius: '8px',
            padding: '6px',
            boxShadow: '0 10px 28px rgba(0, 0, 0, 0.6)',
            color: '#eee',
            fontSize: '12px',
            minWidth: '190px',
            userSelect: 'none',
        });

        const items = [
            {
                icon: '🔄',
                text: '补充背景循环至结尾',
                shortcut: 'Auto-Fill',
                action: () => { if (this.onFillGap) this.onFillGap(); },
            },
            {
                icon: '⏮️',
                text: '磁吸对齐到 0.0s 开头',
                action: () => {
                    const selected = this._selectedClipRefs();
                    if (selected.length > 0) {
                        const minStart = Math.min(...selected.map(s => s.clip.start));
                        selected.forEach(s => {
                            const dur = s.clip.end - s.clip.start;
                            s.clip.start -= minStart;
                            s.clip.end = s.clip.start + dur;
                            if (this.onClipChange) this.onClipChange(s.trackIdx, s.clipIdx, s.clip, { editMode: 'move' });
                        });
                        if (this.onEditEnd) this.onEditEnd();
                    }
                },
            },
            {
                icon: '✂️',
                text: '在播放头处切分 (Split)',
                shortcut: 'S',
                action: () => {
                    this._splitClipAtPlayhead();
                },
            },
            {
                icon: '🗑️',
                text: '删除选中片段 (Delete)',
                shortcut: 'Del',
                danger: true,
                action: () => {
                    this._deleteSelectedClips();
                },
            },
        ];

        items.forEach(item => {
            const btn = document.createElement('div');
            Object.assign(btn.style, {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 10px',
                borderRadius: '5px',
                cursor: 'pointer',
                transition: 'background 0.1s ease',
                color: item.danger ? '#f87171' : '#ddd',
            });
            btn.innerHTML = `
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="font-size:13px;">${item.icon}</span>
                    <span>${item.text}</span>
                </div>
                ${item.shortcut ? `<span style="font-size:10px;color:rgba(255,255,255,0.4);">${item.shortcut}</span>` : ''}
            `;
            btn.onmouseenter = () => { btn.style.background = item.danger ? 'rgba(239, 68, 68, 0.25)' : 'rgba(255, 255, 255, 0.08)'; };
            btn.onmouseleave = () => { btn.style.background = 'transparent'; };
            btn.onclick = (ev) => {
                ev.stopPropagation();
                menu.remove();
                item.action();
            };
            menu.appendChild(btn);
        });

        document.body.appendChild(menu);

        const closeMenu = (ev) => {
            if (!menu.contains(ev.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('keydown', handleEsc, true);
            }
        };
        const handleEsc = (ev) => {
            if (ev.key === 'Escape') {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu, true);
                document.removeEventListener('keydown', handleEsc, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeMenu, true);
            document.addEventListener('keydown', handleEsc, true);
        }, 10);
    }

    _splitClipAtPlayhead() {
        const t = this._currentTime;
        const selected = this._selectedClipRefs();
        if (!selected.length) return;
        const first = selected[0];
        const clip = first.clip;
        if (t > clip.start + 0.05 && t < clip.end - 0.05) {
            const oldEnd = clip.end;
            clip.end = t;
            const newClip = {
                ...clip,
                start: t,
                end: oldEnd,
                _timelineClipId: undefined,
            };
            const track = this._tracks[first.trackIdx];
            if (track) {
                track.clips.splice(first.clipIdx + 1, 0, newClip);
                if (this.onClipChange) this.onClipChange(first.trackIdx, first.clipIdx, clip, { editMode: 'trim_end' });
                if (this.onEditEnd) this.onEditEnd();
            }
        }
    }

    _deleteSelectedClips() {
        const selected = this._selectedClipRefs();
        if (!selected.length) return;
        selected.sort((a, b) => b.clipIdx - a.clipIdx);
        for (const item of selected) {
            const track = this._tracks[item.trackIdx];
            if (track && !track.locked) {
                track.clips.splice(item.clipIdx, 1);
            }
        }
        this._clearClipSelection();
        if (this.onEditEnd) this.onEditEnd();
    }

    // ═══════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════

    _clipKey(trackIdx, clipIdx) {
        return `${trackIdx}:${clipIdx}`;
    }

    _clearClipSelection() {
        this._selectedClips.clear();
        this._selectedClip = null;
        this._selectionAnchor = null;
    }

    _firstSelectedClip() {
        const first = this._selectedClips.values().next().value;
        if (!first) return null;
        const [trackIdx, clipIdx] = first.split(':').map(Number);
        return { trackIdx, clipIdx };
    }

    _selectedClipRefs() {
        const refs = [];
        for (const key of this._selectedClips) {
            const [trackIdx, clipIdx] = key.split(':').map(Number);
            const clip = this._tracks[trackIdx]?.clips[clipIdx];
            if (clip) refs.push({ trackIdx, clipIdx, clip });
        }
        return refs;
    }

    _updateMarqueeSelection(drag) {
        const left = Math.min(drag.mx0, drag.mx1);
        const right = Math.max(drag.mx0, drag.mx1);
        const top = Math.min(drag.my0, drag.my1);
        const bottom = Math.max(drag.my0, drag.my1);
        const selected = new Set(drag.baseSelection || []);

        for (let ti = 0; ti < this._tracks.length; ti++) {
            const track = this._tracks[ti];
            for (let ci = 0; ci < track.clips.length; ci++) {
                const rect = this._getClipCanvasRect(ti, ci);
                if (rect.x < right && rect.x + rect.w > left && rect.y < bottom && rect.y + rect.h > top) {
                    selected.add(this._clipKey(ti, ci));
                }
            }
        }
        this._selectedClips = selected;
        this._selectedClip = this._firstSelectedClip();
    }

    _drawMarquee(ctx) {
        if (!this._drag || this._drag.type !== 'marquee' || !this._drag.moved) return;
        const x = Math.min(this._drag.mx0, this._drag.mx1);
        const y = Math.min(this._drag.my0, this._drag.my1);
        const w = Math.abs(this._drag.mx1 - this._drag.mx0);
        const h = Math.abs(this._drag.my1 - this._drag.my0);
        ctx.save();
        ctx.fillStyle = 'rgba(76,158,255,0.16)';
        ctx.strokeStyle = TL_COLORS.selected;
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
    }

    _getClipCanvasRect(trackIdx, clipIdx) {
        const clip = this._tracks[trackIdx]?.clips[clipIdx];
        if (!clip) return { x: 0, y: 0, w: 0, h: 0 };
        let trackY = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < trackIdx; ti++) {
            trackY += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 &&
                (this._tracks[ti].domain || 'visual') === 'visual' &&
                (this._tracks[ti + 1]?.domain || 'visual') === 'audio') trackY += 4;
        }
        return {
            x: TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX,
            y: trackY + 3,
            w: Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec),
            h: TL_TRACK_HEIGHT - 6,
        };
    }

    _seekToX(mx, type) {
        const t = (mx - TL_HEADER_W + this._scrollX) / this._pxPerSec;
        this._playheadPos = Math.max(0, Math.min(this._duration, t));
        if (this.onSeek) this.onSeek(this._playheadPos, type);
    }

    /** 获取片段在屏幕上的绝对像素矩形 */
    _getClipScreenRect(trackIdx, clipIdx) {
        const canvasRect = this.canvas.getBoundingClientRect();
        const clip = this._tracks[trackIdx]?.clips[clipIdx];
        if (!clip) return { x: 0, y: 0, w: 100, h: TL_TRACK_HEIGHT };

        let trackY = TL_RULER_H - this._scrollY;
        for (let ti = 0; ti < trackIdx; ti++) {
            trackY += TL_TRACK_HEIGHT + 1;
            if (ti < this._tracks.length - 1 &&
                (this._tracks[ti].domain || 'visual') === 'visual' &&
                (this._tracks[ti + 1]?.domain || 'visual') === 'audio') {
                trackY += 4;
            }
        }
        const clipX = TL_HEADER_W + clip.start * this._pxPerSec - this._scrollX;
        const clipW = Math.max(TL_MIN_CLIP_W, (clip.end - clip.start) * this._pxPerSec);
        return {
            x: canvasRect.left + clipX,
            y: canvasRect.top + trackY,
            w: clipW,
            h: TL_TRACK_HEIGHT,
        };
    }

    // ═══════════════════════════════════════════════
    // 浮动字幕编辑器
    // ═══════════════════════════════════════════════

    _openSubtitleEditor(trackIdx, clipIdx, clip, rect) {
        if (this._rtEditor) {
            this._rtEditor.close(false);
        }

        const rtEditor = new ReelsRichTextEditor();
        this._rtEditor = rtEditor;

        rtEditor.onSave = (newText, newRanges, styleOverride) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                const oldText = track.clips[clipIdx]._fullText || track.clips[clipIdx].name;
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].name = newText.slice(0, 20) + (newText.length > 20 ? '…' : '');
                track.clips[clipIdx].styled_ranges = newRanges || null;
                track.clips[clipIdx].style_override = styleOverride || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, oldText, newRanges, styleOverride);
                }
            }
            this._rtEditor = null;
        };

        // 实时预览：编辑中实时同步到 segment 并刷新画布
        rtEditor.onChange = (newText, newRanges, styleOverride) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].styled_ranges = newRanges || null;
                track.clips[clipIdx].style_override = styleOverride || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, 
                        track.clips[clipIdx]._fullText, newRanges, styleOverride);
                }
            }
        };

        rtEditor.onCancel = () => {
            this._rtEditor = null;
        };

        rtEditor.open({
            title: `✎ 编辑字幕 #${clipIdx + 1}`,
            text: clip._fullText || clip.name || '',
            styled_ranges: clip.styled_ranges || [],
            style_override: clip.style_override || {},
            baseStyle: this.subtitleBaseStyle || {},
            rect: rect,
            trackIdx,
            clipIdx
        });
    }

    _closeSubtitleEditor(save) {
        if (this._rtEditor) {
            this._rtEditor.close(save);
        }
    }



    _calcRulerStep() {
        const minStepPx = 60;
        const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
        for (const s of steps) {
            if (s * this._pxPerSec >= minStepPx) return s;
        }
        return 300;
    }

    _formatTime(seconds) {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        if (seconds < 60) return `${s}.${ms}s`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    _lighten(hex, amount) {
        return this._adjustColor(hex, amount);
    }
    _darken(hex, amount) {
        return this._adjustColor(hex, -amount);
    }
    _adjustColor(hex, amount) {
        hex = hex.replace('#', '');
        let r = parseInt(hex.slice(0, 2), 16);
        let g = parseInt(hex.slice(2, 4), 16);
        let b = parseInt(hex.slice(4, 6), 16);
        r = Math.max(0, Math.min(255, r + Math.round(255 * amount)));
        g = Math.max(0, Math.min(255, g + Math.round(255 * amount)));
        b = Math.max(0, Math.min(255, b + Math.round(255 * amount)));
        return `rgb(${r},${g},${b})`;
    }
}

// ═══════════════════════════════════════════════════════
// CSS 注入
// ═══════════════════════════════════════════════════════

(function injectTimelineStyles() {
    if (document.getElementById('rte-styles')) return;
    const style = document.createElement('style');
    style.id = 'rte-styles';
    style.textContent = `
        .rte-canvas {
            display: block;
            width: 100%;
            height: 100%;
            background: ${TL_COLORS.bg};
            border-radius: 8px;
        }

        /* ── 浮动字幕编辑器 ── */
        .rte-subtitle-editor {
            position: fixed;
            z-index: 99999;
            background: linear-gradient(135deg, #1e2233, #232740);
            border: 1px solid rgba(100, 140, 255, 0.35);
            border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.05) inset;
            overflow: hidden;
            animation: rte-se-appear 0.15s ease-out;
            backdrop-filter: blur(12px);
        }
        @keyframes rte-se-appear {
            from { opacity: 0; transform: translateY(6px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        .rte-subtitle-editor.rte-se-closing {
            animation: rte-se-disappear 0.15s ease-in forwards;
        }
        @keyframes rte-se-disappear {
            from { opacity: 1; transform: scale(1); }
            to   { opacity: 0; transform: scale(0.95); }
        }
        .rte-se-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 10px;
            background: rgba(255,255,255,0.04);
            border-bottom: 1px solid rgba(255,255,255,0.07);
            cursor: default;
        }
        .rte-se-title {
            font-size: 12px;
            font-weight: 600;
            color: #c8d0e0;
        }
        .rte-se-time {
            font-size: 10px;
            color: #7a8ba8;
            font-family: monospace;
            margin-left: auto;
        }
        .rte-se-close {
            width: 20px; height: 20px;
            border: none; background: transparent;
            color: #8899aa; font-size: 12px;
            cursor: pointer; border-radius: 4px;
            display: flex; align-items: center; justify-content: center;
            transition: all 0.15s;
        }
        .rte-se-close:hover {
            background: rgba(255,80,80,0.2); color: #ff6b6b;
        }
        .rte-se-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            background: rgba(0,0,0,0.2);
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .rt-btn {
            background: transparent; border: 1px solid rgba(255,255,255,0.1);
            color: #ddd; padding: 2px 6px; border-radius: 4px; font-size: 12px;
            cursor: pointer; transition: 0.1s;
            display: flex; align-items: center; justify-content: center; min-width: 24px;
        }
        .rt-btn:hover { background: rgba(255,255,255,0.1); }
        .rt-btn.active { background: rgba(76,158,255,0.4); border-color: #4c9eff; color: #fff; }
        .rt-divider { width: 1px; height: 14px; background: rgba(255,255,255,0.15); margin: 0 2px; }
        .rt-select {
            background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #ddd;
            padding: 2px 4px; border-radius: 4px; font-size: 11px; outline: none;
        }
        .rt-color-picker {
            width: 24px; height: 24px; border: none; background: transparent; padding: 0; cursor: pointer;
        }
        /* 取代原来的 textarea，使用 contenteditable */
        .rte-se-contenteditable {
            display: block;
            width: 100%; box-sizing: border-box;
            padding: 10px 12px;
            border: none; outline: none;
            min-height: 52px; max-height: 240px;
            overflow-y: auto;
            line-height: 1.5;
            background: rgba(0,0,0,0.25);
            caret-color: #4c9eff;
        }
        .rte-se-contenteditable::selection, .rte-se-contenteditable *::selection {
            background: rgba(76,158,255,0.4);
        }
        .rte-se-contenteditable:focus {
            background: rgba(0,0,0,0.35);
        }
        .rte-se-footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 5px 10px;
            background: rgba(255,255,255,0.02);
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .rte-se-hint {
            font-size: 10px;
            color: #5a6a80;
        }
        .rte-se-save {
            padding: 3px 12px;
            border: none; border-radius: 5px;
            background: linear-gradient(135deg, #3a6ef0, #4c9eff);
            color: #fff; font-size: 11px; font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        .rte-se-save:hover {
            background: linear-gradient(135deg, #4a7eff, #5cafff);
            box-shadow: 0 2px 10px rgba(76,158,255,0.4);
        }
    `;
    document.head.appendChild(style);
})();

// Export
if (typeof window !== 'undefined') window.ReelsTimelineEditor = ReelsTimelineEditor;
