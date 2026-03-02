/**
 * reels-timeline.js — NLE Gen-2 时间线数据模型
 * 
 * 完整移植自 AutoSub_v8:
 *   - timeline.py    → Timeline 类
 *   - timeline_model.py → Track, Clip, MediaSource 类
 * 
 * 运行时 task.timeline 始终是 Timeline 对象。
 * 序列化为 JSON 仅在 collectProjectData 时发生。
 * 
 * tracks 列表规则：
 *   - 索引 0 = 最底层（先画）
 *   - 索引 -1 = 最顶层（后画）
 *   - visual 域在前，audio 域在后
 *   - pinned 的 Track 位于其域内最顶部
 */

// ═══════════════════════════════════════════════════════
// 1. Domain Classification
// ═══════════════════════════════════════════════════════

const AUDIO_TYPES = new Set(['audio', 'bgm', 'sfx']);

function domainOf(trackType) {
    return AUDIO_TYPES.has(trackType) ? 'audio' : 'visual';
}

// ═══════════════════════════════════════════════════════
// 2. MediaSource — 媒体源
// ═══════════════════════════════════════════════════════

class MediaSource {
    constructor(path) {
        this.id = _uuid();
        this.path = path;
        this.hasVideo = true;
        this.hasAudio = true;
        this.duration = 0;
    }

    toJSON() {
        return {
            id: this.id,
            path: this.path,
            has_video: this.hasVideo,
            has_audio: this.hasAudio,
            duration: this.duration,
        };
    }

    static fromJSON(data) {
        const s = new MediaSource(data.path || '');
        s.id = data.id || _uuid();
        s.hasVideo = data.has_video !== false;
        s.hasAudio = data.has_audio !== false;
        s.duration = data.duration || 0;
        return s;
    }
}

// ═══════════════════════════════════════════════════════
// 3. Clip — 片段
// ═══════════════════════════════════════════════════════

class Clip {
    constructor(sourceId, inT = 0, outT = 0, startT = 0) {
        this.sourceId = sourceId;
        this.inT = inT;
        this.outT = outT;
        this.startT = startT;

        // 视频属性
        this.fitMode = 'fill';
        this.blendMode = 'normal';
        this.x = 0;
        this.y = 0;
        this.scale = 1.0;
        this.rotation = 0;
        this.flipX = false;
        this.flipY = false;
        this.speed = 1.0;
        this.loop = false;
        this.matchDuration = false;
        this._matchTargetDur = 0;
        this.transitionPreset = 'none';
        this.transitionDuration = 0.35;

        // 音频属性
        this.gainDb = 0;
        this.pitchSemitones = 0;
        this.fadeInDur = 0;
        this.fadeOutDur = 0;
        this.spatialEnabled = false;
        this.spatialAmount = 0;
        this.isMain = false;
    }

    get duration() {
        return Math.max(0, this.outT - this.inT);
    }

    get effectiveDuration() {
        const baseDur = Math.max(0, (this.outT - this.inT) / Math.max(0.01, this.speed));
        if (this.matchDuration && this._matchTargetDur > 0) {
            return Math.max(baseDur, this._matchTargetDur);
        }
        return baseDur;
    }

    clone() {
        return Clip.fromJSON(this.toJSON());
    }

    splitAt(timelineTime) {
        const clipEnd = this.startT + this.effectiveDuration;
        if (timelineTime <= this.startT || timelineTime >= clipEnd) return null;

        const offsetInSource = (timelineTime - this.startT) * this.speed + this.inT;
        const right = this.clone();
        right.inT = offsetInSource;
        right.startT = timelineTime;
        this.outT = offsetInSource;
        return right;
    }

    toJSON() {
        return {
            source_id: this.sourceId,
            in_t: this.inT,
            out_t: this.outT,
            start_t: this.startT,
            fit_mode: this.fitMode,
            blend_mode: this.blendMode,
            x: this.x, y: this.y,
            scale: this.scale,
            rotation: this.rotation,
            flip_x: this.flipX,
            flip_y: this.flipY,
            speed: this.speed,
            loop: this.loop,
            match_duration: this.matchDuration,
            transition_preset: this.transitionPreset,
            transition_duration: this.transitionDuration,
            gain_db: this.gainDb,
            pitch_semitones: this.pitchSemitones,
            fade_in_dur: this.fadeInDur,
            fade_out_dur: this.fadeOutDur,
            spatial_enabled: this.spatialEnabled,
            spatial_amount: this.spatialAmount,
            is_main: this.isMain,
        };
    }

    static fromJSON(data) {
        const c = new Clip(data.source_id, data.in_t || 0, data.out_t || 0, data.start_t || 0);
        const map = {
            fit_mode: 'fitMode', blend_mode: 'blendMode',
            x: 'x', y: 'y', scale: 'scale', rotation: 'rotation',
            flip_x: 'flipX', flip_y: 'flipY',
            speed: 'speed', loop: 'loop', match_duration: 'matchDuration',
            transition_preset: 'transitionPreset', transition_duration: 'transitionDuration',
            gain_db: 'gainDb', pitch_semitones: 'pitchSemitones',
            fade_in_dur: 'fadeInDur', fade_out_dur: 'fadeOutDur',
            spatial_enabled: 'spatialEnabled', spatial_amount: 'spatialAmount',
            is_main: 'isMain',
        };
        for (const [jsonKey, propKey] of Object.entries(map)) {
            if (jsonKey in data) c[propKey] = data[jsonKey];
        }
        return c;
    }
}

// ═══════════════════════════════════════════════════════
// 4. Track — 轨道
// ═══════════════════════════════════════════════════════

class Track {
    constructor(trackType) {
        this.id = _uuid();
        this.type = trackType;
        this.clips = [];
        this.enableBatch = false;
        this.isMainVideo = false;
        this.domain = domainOf(trackType);
        this.visible = true;
        this.locked = false;
        this.order = 0;
        this.pinned = false;
        this.blendMode = 'normal';
        this._extra = {};
    }

    toJSON() {
        const d = {
            id: this.id,
            type: this.type,
            enable_batch: this.enableBatch,
            is_main_video: this.isMainVideo,
            domain: this.domain,
            visible: this.visible,
            locked: this.locked,
            order: this.order,
            pinned: this.pinned,
            blend_mode: this.blendMode,
            clips: this.clips.map(c => c instanceof Clip ? c.toJSON() : c),
        };
        if (this._extra && Object.keys(this._extra).length > 0) {
            Object.assign(d, this._extra);
        }
        return d;
    }

    static fromJSON(data) {
        const t = new Track(data.type || 'video');
        if (data.id) t.id = data.id;
        t.enableBatch = !!data.enable_batch;
        t.isMainVideo = !!data.is_main_video;
        t.domain = data.domain || t.domain;
        t.visible = data.visible !== false;
        t.locked = !!data.locked;
        t.order = data.order || 0;
        t.pinned = !!data.pinned;
        t.blendMode = data.blend_mode || 'normal';

        const knownKeys = new Set([
            'id', 'type', 'domain', 'visible', 'locked', 'enable_batch',
            'is_main_video', 'order', 'pinned', 'blend_mode', 'clips',
        ]);
        t._extra = {};
        for (const [k, v] of Object.entries(data)) {
            if (!knownKeys.has(k)) t._extra[k] = v;
        }

        for (const c of (data.clips || [])) {
            t.clips.push(c instanceof Clip ? c : Clip.fromJSON(c));
        }
        return t;
    }
}

// ═══════════════════════════════════════════════════════
// 5. Timeline — 时间线
// ═══════════════════════════════════════════════════════

class Timeline {
    constructor(width = 1920, height = 1080, fps = 30) {
        this.width = width;
        this.height = height;
        this.fps = fps;
        this.tracks = [];
        this.sources = {};
    }

    // ── 逻辑分组视图 ──
    get videoTracks() {
        return this.tracks.filter(t => (t.domain || 'visual') === 'visual');
    }

    get audioTracks() {
        return this.tracks.filter(t => (t.domain || 'visual') === 'audio');
    }

    getSortedVideoTracks() {
        return this.tracks.filter(t =>
            (t.domain || 'visual') === 'visual' && t.visible !== false
        );
    }

    // ── 轨道管理 ──
    addTrack(track) {
        if (!(track instanceof Track)) return;
        const correctDomain = domainOf(track.type);
        if (track.domain !== correctDomain) track.domain = correctDomain;

        if (track.domain === 'audio') {
            this.tracks.push(track);
        } else {
            let insertIdx = this.tracks.length;
            for (let i = 0; i < this.tracks.length; i++) {
                if ((this.tracks[i].domain || 'visual') === 'audio') {
                    insertIdx = i;
                    break;
                }
            }
            this.tracks.splice(insertIdx, 0, track);
        }
    }

    removeTrack(track) {
        const idx = this.tracks.indexOf(track);
        if (idx !== -1) this.tracks.splice(idx, 1);
    }

    _domainIndices(domain) {
        return this.tracks
            .map((t, i) => [(t.domain || 'visual') === domain ? i : -1])
            .flat()
            .filter(i => i !== -1);
    }

    moveTrackUp(track) {
        const pos = this.tracks.indexOf(track);
        if (pos === -1) return;
        const domain = track.domain || 'visual';
        const indices = this._domainIndices(domain);
        const idxInDomain = indices.indexOf(pos);
        if (idxInDomain >= indices.length - 1) return;
        const nextPos = indices[idxInDomain + 1];
        [this.tracks[pos], this.tracks[nextPos]] = [this.tracks[nextPos], this.tracks[pos]];
    }

    moveTrackDown(track) {
        const pos = this.tracks.indexOf(track);
        if (pos === -1) return;
        const domain = track.domain || 'visual';
        const indices = this._domainIndices(domain);
        const idxInDomain = indices.indexOf(pos);
        if (idxInDomain <= 0) return;
        const prevPos = indices[idxInDomain - 1];
        [this.tracks[pos], this.tracks[prevPos]] = [this.tracks[prevPos], this.tracks[pos]];
    }

    togglePin(track) {
        track.pinned = !track.pinned;
        if (track.pinned) this._moveToDomainTop(track);
    }

    _moveToDomainTop(track) {
        const pos = this.tracks.indexOf(track);
        if (pos === -1) return;
        const domain = track.domain || 'visual';
        this.tracks.splice(pos, 1);
        const indices = this._domainIndices(domain);
        const insertAt = indices.length > 0 ? indices[indices.length - 1] + 1 : this.tracks.length;
        this.tracks.splice(insertAt, 0, track);
    }

    toggleVisibility(track) { track.visible = !track.visible; }
    toggleBatchEnable(track) { track.enableBatch = !track.enableBatch; }

    normalizeOrders() {
        this.tracks.forEach((t, i) => { t.order = i; });
    }

    validateDomainInvariant() {
        const vis = this.tracks.filter(t => (t.domain || 'visual') === 'visual');
        const aud = this.tracks.filter(t => (t.domain || 'visual') === 'audio');
        const expected = [...vis, ...aud];
        const needFix = this.tracks.some((t, i) => t !== expected[i]);
        if (needFix) {
            this.tracks.length = 0;
            this.tracks.push(...expected);
        }
        return needFix;
    }

    findTracksByType(trackType) {
        return this.tracks.filter(t => t.type === trackType);
    }

    findTrackByType(trackType) {
        return this.tracks.find(t => t.type === trackType) || null;
    }

    // ── 序列化 ──
    toJSON() {
        const sourcesData = {};
        for (const [sid, s] of Object.entries(this.sources)) {
            sourcesData[sid] = s instanceof MediaSource ? s.toJSON() : s;
        }
        return {
            width: this.width,
            height: this.height,
            fps: this.fps,
            sources: sourcesData,
            tracks: this.tracks.map(t => t instanceof Track ? t.toJSON() : t),
        };
    }

    static fromJSON(data) {
        if (!data || typeof data !== 'object') return new Timeline();
        const tl = new Timeline(
            data.width || 1920,
            data.height || 1080,
            data.fps || 30,
        );
        // Sources
        for (const [sid, s] of Object.entries(data.sources || {})) {
            tl.sources[sid] = s instanceof MediaSource ? s : MediaSource.fromJSON(s);
        }
        // Tracks
        for (const tr of (data.tracks || [])) {
            tl.tracks.push(tr instanceof Track ? tr : Track.fromJSON(tr));
        }
        return tl;
    }

    // ── 从视频初始化默认时间线 ──
    static createDefault(videoPath, duration = 0, width = 1920, height = 1080) {
        const tl = new Timeline(width, height, 30);
        const sourceId = _uuid();
        const source = new MediaSource(videoPath);
        source.id = sourceId;
        source.duration = duration;
        tl.sources[sourceId] = source;

        // 主视频轨
        const vTrack = new Track('video');
        vTrack.isMainVideo = true;
        const vClip = new Clip(sourceId, 0, duration, 0);
        vClip.fitMode = 'fill';
        vTrack.clips.push(vClip);
        tl.addTrack(vTrack);

        // 主音频轨
        const aTrack = new Track('audio');
        const aClip = new Clip(sourceId, 0, duration, 0);
        aClip.isMain = true;
        aTrack.clips.push(aClip);
        tl.addTrack(aTrack);

        // 字幕轨
        tl.addTrack(new Track('subs'));

        return tl;
    }
}

// ═══════════════════════════════════════════════════════
// 6. Utility
// ═══════════════════════════════════════════════════════

function _uuid() {
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsTimeline = {
    AUDIO_TYPES,
    domainOf,
    MediaSource,
    Clip,
    Track,
    Timeline,
};

if (typeof window !== 'undefined') window.ReelsTimeline = ReelsTimeline;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsTimeline;
