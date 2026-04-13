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
        this._selectedClip = null;    // {trackIdx, clipIdx}
        this._hoveredClip = null;

        // 拖拽状态
        this._drag = null;            // {type: 'move'|'trim_start'|'trim_end'|'playhead', ...}

        // 回调
        this.onSeek = null;           // (timeSec) => {}
        this.onClipSelect = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipChange = null;     // (trackIdx, clipIdx, clip) => {}
        this.onClipDblClick = null;   // (trackIdx, clipIdx, clip, rect) => {}

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

        // 事件
        this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        
        // 绑定到 window 以防止鼠标移出画布后拖拽断开/卡住
        window.addEventListener('mousemove', (e) => this._onMouseMove(e));
        window.addEventListener('mouseup', (e) => this._onMouseUp(e));
        
        this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

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
    }

    // ═══════════════════════════════════════════════
    // Public API
    // ═══════════════════════════════════════════════

    setDuration(dur) {
        this._duration = Math.max(1, dur);
    }

    setPlayhead(timeSec) {
        if (this._drag && this._drag.type === 'playhead') return;
        this._playheadPos = Math.max(0, Math.min(timeSec, this._duration));
    }

    setTracks(tracks) {
        this._tracks = tracks;
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
            const fullText = seg.text || seg.content || '';
            return {
                start: seg.start || 0,
                end: seg.end || 0,
                name: fullText.slice(0, 20) + (fullText.length > 20 ? '…' : ''),
                _fullText: fullText,
                color: TL_COLORS.trackTypes.subs,
                _segIdx: i,
                styled_ranges: seg.styled_ranges || null,
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

        // 播放头
        this._drawPlayhead(ctx, W, H);
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
        const endTime = (this._scrollX + W - TL_HEADER_W) / this._pxPerSec + startTime;

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

            // 片段
            for (let ci = 0; ci < track.clips.length; ci++) {
                this._drawClip(ctx, track, ti, ci, y);
            }

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

        // 可见范围检查
        if (x + w < TL_HEADER_W || x > this._canvasW) return;

        const isSelected = this._selectedClip?.trackIdx === trackIdx && this._selectedClip?.clipIdx === clipIdx;
        const isHovered = this._hoveredClip?.trackIdx === trackIdx && this._hoveredClip?.clipIdx === clipIdx;

        // 片段背景
        const color = clip.color || TL_COLORS.trackTypes[track.type] || '#888';
        ctx.fillStyle = isSelected ? color : isHovered ? this._lighten(color, 0.15) : this._darken(color, 0.3);
        ctx.globalAlpha = isSelected ? 0.9 : 0.7;

        // 圆角
        const r = 4;
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
        ctx.fill();

        ctx.globalAlpha = 1;

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
            ctx.rect(x + 2, y, w - 4, h);
            ctx.clip();

            ctx.font = '10px system-ui, sans-serif';
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'left';
            ctx.fillText(clip.name || '', x + 6, y + h / 2 + 3);
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
        if (x < TL_HEADER_W || x > W) return;

        // 顶部三角
        ctx.fillStyle = TL_COLORS.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, TL_RULER_H - 4);
        ctx.closePath();
        ctx.fill();

        // 竖线
        ctx.strokeStyle = TL_COLORS.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, TL_RULER_H);
        ctx.lineTo(x, H);
        ctx.stroke();
    }

    // ═══════════════════════════════════════════════
    // 鼠标交互
    // ═══════════════════════════════════════════════

    _onMouseDown(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // 1. 点击刻度尺 → seek
        if (my < TL_RULER_H) {
            this._drag = { type: 'playhead' };
            this._seekToX(mx);
            return;
        }

        // 2. 点击轨道头部 → 忽略
        if (mx < TL_HEADER_W) return;

        // 3. 检测是否点击了 Trim 手柄
        const hitInfo = this._hitTestClip(mx, my);
        if (hitInfo) {
            this._selectedClip = { trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx };
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

            if (hitInfo.zone === 'start') {
                this._drag = { type: 'trim_start', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, mx0: mx };
            } else if (hitInfo.zone === 'end') {
                this._drag = { type: 'trim_end', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origEnd: clip.end, mx0: mx };
            } else {
                this._drag = { type: 'move', trackIdx: hitInfo.trackIdx, clipIdx: hitInfo.clipIdx, origStart: clip.start, origEnd: clip.end, mx0: mx };
            }

            if (this.onClipSelect) this.onClipSelect(hitInfo.trackIdx, hitInfo.clipIdx, clip);
        } else {
            this._selectedClip = null;
        }
    }

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Drag
        if (this._drag) {
            const dxPx = mx - this._drag.mx0;
            const dt = dxPx / this._pxPerSec;

            if (this._drag.type === 'playhead') {
                this._seekToX(mx);
                return;
            }

            const clip = this._tracks[this._drag.trackIdx]?.clips[this._drag.clipIdx];
            if (!clip) return;

            if (this._drag.type === 'trim_start') {
                clip.start = Math.max(0, this._drag.origStart + dt);
                clip.start = Math.min(clip.start, clip.end - 0.05);
            } else if (this._drag.type === 'trim_end') {
                clip.end = Math.max(clip.start + 0.05, this._drag.origEnd + dt);
            } else if (this._drag.type === 'move') {
                const dur = this._drag.origEnd - this._drag.origStart;
                clip.start = Math.max(0, this._drag.origStart + dt);
                clip.end = clip.start + dur;
            }

            if (this.onClipChange) this.onClipChange(this._drag.trackIdx, this._drag.clipIdx, clip);
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
        } else if (my < TL_RULER_H && mx >= TL_HEADER_W) {
            this.canvas.style.cursor = 'pointer';
        } else {
            this.canvas.style.cursor = 'default';
        }
    }

    _onMouseUp(e) {
        this._drag = null;
    }

    _onWheel(e) {
        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            // 缩放
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

    // ═══════════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════════

    _seekToX(mx) {
        const t = (mx - TL_HEADER_W + this._scrollX) / this._pxPerSec;
        this._playheadPos = Math.max(0, Math.min(this._duration, t));
        if (this.onSeek) this.onSeek(this._playheadPos);
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

        rtEditor.onSave = (newText, newRanges) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                const oldText = track.clips[clipIdx]._fullText || track.clips[clipIdx].name;
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].name = newText.slice(0, 20) + (newText.length > 20 ? '…' : '');
                track.clips[clipIdx].styled_ranges = newRanges || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, oldText, newRanges);
                }
            }
            this._rtEditor = null;
        };

        // 实时预览：编辑中实时同步到 segment 并刷新画布
        rtEditor.onChange = (newText, newRanges) => {
            const track = this._tracks[trackIdx];
            if (track && track.clips[clipIdx]) {
                track.clips[clipIdx]._fullText = newText;
                track.clips[clipIdx].styled_ranges = newRanges || null;
                if (this.onSubtitleEdit) {
                    this.onSubtitleEdit(trackIdx, clipIdx, newText, 
                        track.clips[clipIdx]._fullText, newRanges);
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
