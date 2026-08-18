/**
 * reels-render-plan.js — Reels 时间线与渲染器之间的唯一适配层。
 *
 * 编辑器不直接拥有一份“仅供显示”的轨道数据。task.timeline 是编辑事实，
 * 本模块将其同步为现有预览/导出器需要的兼容字段。这样两条渲染路径在开始
 * 前读取的是同一份任务状态，旧项目也仍可打开。
 */
(function (root) {
    const TimelineLib = typeof require === 'function' && typeof window === 'undefined'
        ? require('./reels-timeline.js')
        : root.ReelsTimeline;

    function finite(value, fallback = 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function sourceFor(timeline, path, duration = 0, kind = '') {
        if (!path) return '';
        const found = Object.values(timeline.sources).find((source) => source.path === path);
        if (found) {
            found.duration = Math.max(finite(found.duration), finite(duration));
            return found.id;
        }
        const source = new TimelineLib.MediaSource(path);
        source.duration = Math.max(0, finite(duration));
        source.hasVideo = !['voice', 'bgm', 'sfx'].includes(kind);
        source.hasAudio = kind !== 'overlay';
        timeline.sources[source.id] = source;
        return source.id;
    }

    function trackFor(timeline, type, label, trackRole = '') {
        // 同为 audio/video 的素材不能自动合到一条轨道：背景原声、人声 MP3、
        // 配乐必须各自可见、可静音和可编辑。trackRole 是显示轨道的稳定身份。
        let track = trackRole
            ? timeline.tracks.find((item) => item.type === type && item._extra?.trackRole === trackRole)
            : timeline.findTrackByType(type);
        if (!track) {
            track = new TimelineLib.Track(type);
            timeline.addTrack(track);
        }
        track._extra.label = label || track._extra.label || type;
        if (trackRole) track._extra.trackRole = trackRole;
        return track;
    }

    function addLegacyClip(timeline, type, role, path, duration, options = {}) {
        if (!path) return null;
        const track = trackFor(timeline, type, options.label, options.trackRole || role);
        const sourceId = sourceFor(timeline, path, duration, role);
        const clip = new TimelineLib.Clip(sourceId, finite(options.inT), Math.max(finite(options.outT, duration), 0), finite(options.startT));
        clip.followRipple = options.followRipple !== false;
        clip.linkGroupId = options.linkGroupId || '';
        clip._extra.role = role;
        track.clips.push(clip);
        return clip;
    }

    function taskDuration(task, options = {}) {
        const lastSubtitleEnd = Array.isArray(task?.segments) && task.segments.length
            ? Math.max(...task.segments.map(segment => finite(segment.end)))
            : 0;
        return Math.max(
            finite(options.duration), finite(task?.customDuration), finite(task?.duration), lastSubtitleEnd, 1
        );
    }

    // 老项目可能已经保存了一份空的/早期的 timeline。不能因为它“存在”就
    // 停止同步；要补齐当前任务真实拥有的视频、原声、人声和配乐轨道。
    function ensureLegacyTracks(timeline, task, options = {}) {
        const duration = taskDuration(task, options);
        const backgroundSegments = Array.isArray(options.backgroundSegments) ? options.backgroundSegments.filter(segment => segment?.path) : [];
        const paths = {
            background: task.bgPath || task.videoPath || (Array.isArray(task.bgClipPool) ? task.bgClipPool.find(Boolean) : '') || (task.contentVideoDirectBg ? task.contentVideoPath : ''),
            voice: task.audioPath || task.voicePath || task.voice_path || task.audio_path || task.audio?.path || (typeof task.audio === 'string' ? task.audio : '') || '',
            bgm: task.bgmPath || task.bgm_path || (typeof task.bgm === 'string' ? task.bgm : (task.bgm?.path || '')) || '',
            content_video: task.contentVideoPath || task.content_video_path || '',
        };
        const ensureRole = (type, role, path, config = {}) => {
            if (!path || clipsByRole(timeline, role).length) return clipsByRole(timeline, role)[0] || null;
            const track = trackFor(timeline, type, config.label, config.trackRole || role);
            const candidate = track.clips.find(clip => timeline.sources[clip.sourceId]?.path === path);
            if (candidate) {
                candidate._extra = candidate._extra || {};
                candidate._extra.role = role;
                if (candidate.outT <= candidate.inT) candidate.outT = candidate.inT + duration;
                candidate.followRipple = config.followRipple !== false;
                return candidate;
            }
            return addLegacyClip(timeline, type, role, path, duration, config);
        };
        let background = null;
        if (backgroundSegments.length) {
            const videoTrack = trackFor(timeline, 'video', '背景视频（循环）', 'background');
            const audioTrack = trackFor(timeline, 'audio', '原声（绑定背景）', 'source_audio');
            // 已保存项目中可能仍是旧标签“背景拼接”；这里统一成用户能看懂的名称。
            videoTrack._extra.label = '背景视频（循环）';
            // 多背景不是一条“循环覆盖”大块。这里按与预览完全相同的分段结果
            // 生成独立 clips，让用户看见素材切换、裁剪长度和整片结束位置。
            const segmentKey = backgroundSegments.map((segment) => [
                segment.path, finite(segment.start), finite(segment.end), finite(segment.trimStart), finite(segment.duration), finite(segment.speedFactor, 1), segment.loopIndex ?? '',
            ].join('|')).join(';');
            // 切换任务、读取到真实媒体时长时才重建初始循环；用户拖过以后不能
            // 又被下一次 UI 刷新覆盖回去，否则就会产生截图中的重叠/空洞。
            const needsHydration = timeline._extra.backgroundSegmentKey !== segmentKey;
            if (needsHydration) {
                videoTrack.clips = videoTrack.clips.filter(clip => clip?._extra?.role !== 'background');
                audioTrack.clips = audioTrack.clips.filter(clip => clip?._extra?.role !== 'source_audio');
            }
            if (needsHydration) backgroundSegments.forEach((segment, index) => {
                const sourceId = sourceFor(timeline, segment.path, finite(segment.duration), 'background');
                const sourceIn = finite(segment.trimStart);
                const sourceOut = sourceIn + Math.max(.05, finite(segment.duration, 5)) * Math.max(.01, finite(segment.speedFactor, 1));
                const group = `bg_link_${index}_${Math.round(finite(segment.start) * 1000)}`;
                const video = new TimelineLib.Clip(sourceId, sourceIn, sourceOut, finite(segment.start));
                video.speed = Math.max(.01, finite(segment.speedFactor, 1));
                video.linkGroupId = group;
                video._extra.role = 'background';
                video._extra.sequenceIndex = index;
                video._extra.loopIndex = segment.loopIndex ?? null;
                video._extra.transition = task.bgTransition || 'none';
                videoTrack.clips.push(video);
                const originalAudio = new TimelineLib.Clip(sourceId, sourceIn, sourceOut, finite(segment.start));
                originalAudio.speed = video.speed;
                originalAudio.linkGroupId = group;
                originalAudio.isMain = true;
                originalAudio._extra.role = 'source_audio';
                originalAudio._extra.sequenceIndex = index;
                originalAudio._extra.loopIndex = segment.loopIndex ?? null;
                audioTrack.clips.push(originalAudio);
            });
            timeline._extra.backgroundSegmentKey = segmentKey;
            background = videoTrack.clips[0] || null;
        } else {
            background = ensureRole('video', 'background', paths.background, { label: '主视频' });
        }
        if (background && !backgroundSegments.length && !clipsByRole(timeline, 'source_audio').length) {
            const group = background.linkGroupId || (background.linkGroupId = `link_${background.id}`);
            ensureRole('audio', 'source_audio', paths.background, { label: '原声（绑定背景）', linkGroupId: group });
            const originalAudio = clipsByRole(timeline, 'source_audio')[0];
            if (originalAudio) originalAudio.linkGroupId = group;
        }
        ensureRole('audio', 'voice', paths.voice, { label: '人声 MP3' });
        ensureRole('bgm', 'bgm', paths.bgm, { label: '配乐', followRipple: false, startT: finite(task.bgmStart) });
        if (paths.content_video && paths.content_video !== paths.background) {
            ensureRole('video', 'content_video', paths.content_video, {
                label: '内容视频', inT: finite(task.contentVideoTrimStart), outT: finite(task.contentVideoTrimEnd, duration),
            });
        }
        // 1. 规范化片段角色，识别未打标的遗留片段
        timeline.tracks.forEach((track) => {
            (track.clips || []).forEach((clip) => {
                if (!clip) return;
                clip._extra = clip._extra || {};
                if (!clip._extra.role) {
                    const srcPath = timeline.sources[clip.sourceId]?.path || '';
                    if (paths.voice && srcPath === paths.voice) clip._extra.role = 'voice';
                    else if (paths.bgm && srcPath === paths.bgm) clip._extra.role = 'bgm';
                    else if (paths.content_video && srcPath === paths.content_video) clip._extra.role = 'content_video';
                    else if (paths.background && srcPath === paths.background) {
                        clip._extra.role = track.domain === 'audio' ? 'source_audio' : 'background';
                    }
                }
            });
        });

        // 兼容早期项目：将 source_audio 与 voice 归入独立轨道
        ['source_audio', 'voice'].forEach((role) => {
            const label = role === 'voice' ? '人声 MP3' : '原声（绑定背景）';
            const target = trackFor(timeline, 'audio', label, role);
            timeline.tracks.forEach((track) => {
                if (track === target) return;
                const moving = (track.clips || []).filter((clip) => clip?._extra?.role === role);
                if (!moving.length) return;
                track.clips = track.clips.filter((clip) => clip?._extra?.role !== role);
                target.clips.push(...moving);
            });
        });
        trackFor(timeline, 'subs', '字幕', 'subs');

        // 清理空轨道与重复字幕轨，保留所有有内容的轨道
        let hasSubsTrack = false;
        timeline.tracks = timeline.tracks.filter((track) => {
            if (track.type === 'subs') {
                if (hasSubsTrack) return false;
                hasSubsTrack = true;
                track._extra.label = '字幕';
                return true;
            }
            return Array.isArray(track.clips) && track.clips.length > 0;
        });

        // 对背景视频与绑定原声进行防重叠校验，若发生重叠自动向后推移，彻底杜绝画面重叠
        const bgClips = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
        let prevEnd = 0;
        for (let i = 0; i < bgClips.length; i++) {
            const clip = bgClips[i];
            const linked = timeline.linkedClips(clip);
            const dur = Math.max(0.05, clip.effectiveDuration);
            if (clip.startT < prevEnd - 0.001) {
                linked.forEach((item) => {
                    item.startT = prevEnd;
                });
            }
            prevEnd = clip.startT + dur;
            linked.forEach((item) => {
                item._extra = item._extra || {};
                item._extra.sequenceIndex = i;
                item._extra.loopIndex = i;
            });
        }

        return timeline;
    }

    function ensureTimeline(task, options = {}) {
        if (!task || !TimelineLib) return null;
        if (task.timeline && typeof task.timeline.findTrackByType === 'function') {
            return ensureLegacyTracks(task.timeline, task, options);
        }
        if (task.timeline && typeof task.timeline === 'object') {
            task.timeline = TimelineLib.Timeline.fromJSON(task.timeline);
            return ensureLegacyTracks(task.timeline, task, options);
        }
        const tl = new TimelineLib.Timeline(options.width || 1080, options.height || 1920, 30);
        task.timeline = tl;
        return ensureLegacyTracks(tl, task, options);
    }

    function clipsByRole(timeline, role) {
        return timeline.tracks.flatMap((track) => track.clips || [])
            .filter((clip) => clip && clip._extra && clip._extra.role === role);
    }

    // 将时间线中“当前已被渲染器支持”的轨道投影到旧字段。
    // 多片段编排暂存为 renderPlan，不能悄悄降级成单片段导出。
    function syncLegacyFields(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return task;
        const read = (role) => clipsByRole(timeline, role).sort((a, b) => a.startT - b.startT);
        const firstPath = (role) => {
            const clip = read(role)[0];
            return clip ? timeline.sources[clip.sourceId]?.path || '' : '';
        };
        const background = read('background');
        const voice = read('voice');
        const bgm = read('bgm');
        const content = read('content_video');
        if (background.length === 1) {
            const clip = background[0];
            const path = timeline.sources[clip.sourceId]?.path || '';
            task.bgPath = path || task.bgPath;
            task.videoPath = path || task.videoPath;
            task.timelineBackgroundTrim = { in_t: clip.inT, out_t: clip.outT, start_t: clip.startT };
        }
        if (voice.length === 1) task.audioPath = timeline.sources[voice[0].sourceId]?.path || task.audioPath;
        if (bgm.length === 1) {
            const clip = bgm[0];
            task.bgmPath = timeline.sources[clip.sourceId]?.path || task.bgmPath;
            task.bgmStart = clip.startT;
        }
        if (content.length === 1) {
            const clip = content[0];
            task.contentVideoPath = timeline.sources[clip.sourceId]?.path || task.contentVideoPath;
            task.contentVideoTrimStart = clip.inT;
            task.contentVideoTrimEnd = clip.outT;
        }
        task.renderPlan = {
            version: 1,
            timeline: timeline.toJSON(),
            unsupportedMultiClipRoles: ['background', 'voice', 'bgm', 'content_video'].filter((role) => read(role).length > 1),
        };
        return task;
    }

    function getEditorTracks(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return [];
        // 只保留真正有片段的轨道以及单个标准字幕轨
        let hasSubsTrack = false;
        const tracks = timeline.tracks.filter((track) => {
            if (track.type === 'subs') {
                if (hasSubsTrack) return false;
                hasSubsTrack = true;
                return true;
            }
            return Array.isArray(track.clips) && track.clips.length > 0;
        }).map((track) => ({
            type: track.type,
            name: track._extra.label || track.type,
            locked: track.locked,
            visible: track.visible,
            domain: track.domain,
            clips: track.clips.map((clip) => ({
                start: clip.startT,
                end: clip.startT + clip.effectiveDuration,
                name: `${timeline.sources[clip.sourceId]?.path?.split(/[\\/]/).pop() || track._extra.label || track.type}${clip._extra?.loopIndex != null ? ` #${clip._extra.loopIndex + 1}` : ''}`,
                color: undefined,
                _timelineClipId: clip.id,
                _timelineRole: clip._extra.role || '',
                _linkGroupId: clip.linkGroupId || '',
                _loopIndex: clip._extra?.loopIndex,
                _isLoopInstance: clip._extra?.loopIndex != null,
            })),
        }));
        const subtitles = Array.isArray(task.segments) ? task.segments : [];
        const subtitleTrack = tracks.find((track) => track.type === 'subs');
        if (subtitleTrack) {
            subtitleTrack.clips = subtitles.map((segment, index) => {
                const text = segment.edited_text || segment.text || segment.content || '';
                return {
                    start: finite(segment.start), end: finite(segment.end),
                    name: text.slice(0, 20) + (text.length > 20 ? '…' : ''),
                    _fullText: text, _segIdx: index,
                    styled_ranges: segment.styled_ranges || null,
                    style_override: segment.style_override || null,
                };
            });
        }
        return tracks;
    }

    function applyEditorClip(task, editorClip, options = {}) {
        const timeline = ensureTimeline(task);
        const found = timeline && timeline.findClip(editorClip && editorClip._timelineClipId);
        if (!found) return false;
        const clip = found.clip;
        const newStart = Math.max(0, finite(editorClip.start));
        const newDuration = Math.max(0.05, finite(editorClip.end) - newStart);
        const role = clip._extra?.role || '';
        const isSequencedBackground = role === 'background' || role === 'source_audio';
        const linked = timeline.linkedClips(clip);

        if (options.editMode === 'move') {
            if (isSequencedBackground) {
                // 循环背景移动/重排：
                // 如果用户拖放位置越过了相邻片段的中心（重排/插入），按顺序重新无缝平铺
                const peers = clipsByRole(timeline, role).sort((a, b) => a.startT - b.startT);
                const index = peers.indexOf(clip);
                const previousEnd = index > 0 ? peers[index - 1].startT + peers[index - 1].effectiveDuration : 0;
                const targetCenter = newStart + newDuration / 2;
                let shouldReorder = false;
                if (index > 0 && targetCenter < peers[index - 1].startT + peers[index - 1].effectiveDuration / 2) {
                    shouldReorder = true;
                } else if (index < peers.length - 1 && targetCenter > peers[index + 1].startT + peers[index + 1].effectiveDuration / 2) {
                    shouldReorder = true;
                }

                if (shouldReorder) {
                    peers.sort((a, b) => {
                        const cA = (a.id === clip.id ? targetCenter : (a.startT + a.effectiveDuration / 2));
                        const cB = (b.id === clip.id ? targetCenter : (b.startT + b.effectiveDuration / 2));
                        return cA - cB;
                    });
                    let currentT = 0;
                    for (const peer of peers) {
                        const peerLinked = timeline.linkedClips(peer);
                        const dur = peer.effectiveDuration;
                        peerLinked.forEach((item) => { item.startT = currentT; });
                        currentT += dur;
                    }
                } else {
                    const allowedStart = Math.max(previousEnd, newStart);
                    const delta = allowedStart - clip.startT;
                    if (delta) {
                        const excluded = linked.map((item) => item.id);
                        linked.forEach((item) => { item.startT = Math.max(0, item.startT + delta); });
                        // 只波纹移动当前轮之后的内容，不能把前一轮再次挪走。
                        timeline.rippleFrom(clip.startT + 0.0001, delta, { excludeClipIds: excluded, includeAtBoundary: false });
                    }
                }
            } else {
                const delta = newStart - clip.startT;
                linked.forEach((item) => {
                    item.startT = Math.max(0, item.startT + delta);
                });
            }
        } else if (options.editMode === 'trim_start') {
            const localOffset = options.trimOffset != null
                ? options.trimOffset
                : (newStart - clip.startT);
            if (localOffset > 0) {
                const oldDuration = clip.effectiveDuration;
                const oldEnd = clip.startT + oldDuration;
                for (const item of linked) {
                    const baseIn = (options.origInT != null ? options.origInT : item.inT);
                    item.inT = Math.min(item.outT - 0.05, baseIn + localOffset * item.speed);
                    item.startT = newStart;
                }
                const newDurationAfter = clip.effectiveDuration;
                const delta = newDurationAfter - oldDuration;
                if (isSequencedBackground && delta) {
                    const excluded = linked.map((item) => item.id);
                    timeline.rippleFrom(oldEnd - 0.001, delta, { excludeClipIds: excluded, includeAtBoundary: true });
                }
            }
        } else if (options.editMode === 'trim_end') {
            const oldDuration = clip.effectiveDuration;
            const oldEnd = clip.startT + oldDuration;
            for (const item of linked) {
                const desiredDuration = Math.max(0.05, (newStart + newDuration) - item.startT);
                item.outT = Math.max(item.inT + 0.05, item.inT + desiredDuration * item.speed);
            }
            const delta = newDuration - oldDuration;
            if (delta && isSequencedBackground) {
                const excluded = linked.map((item) => item.id);
                timeline.rippleFrom(oldEnd - 0.001, delta, { excludeClipIds: excluded, includeAtBoundary: true });
            }
        } else {
            const delta = newStart - clip.startT;
            for (const item of linked) {
                item.startT = Math.max(0, item.startT + delta);
                item.outT = item.inT + newDuration * item.speed;
            }
        }

        if (isSequencedBackground) {
            const peers = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
            let prevEnd = 0;
            for (let i = 0; i < peers.length; i++) {
                const peer = peers[i];
                const peerLinked = timeline.linkedClips(peer);
                const dur = peer.effectiveDuration;
                if (peer.startT < prevEnd - 0.001) {
                    peerLinked.forEach((item) => {
                        item.startT = prevEnd;
                    });
                }
                prevEnd = peer.startT + dur;
                peerLinked.forEach((item) => {
                    item._extra = item._extra || {};
                    item._extra.sequenceIndex = i;
                    item._extra.loopIndex = i;
                });
            }
        }

        syncLegacyFields(task);
        return true;
    }

    function fillBackgroundLoops(task, options = {}) {
        const timeline = ensureTimeline(task, options);
        if (!timeline) return false;
        const totalDuration = taskDuration(task, options);
        const videoTrack = trackFor(timeline, 'video', '背景视频（循环）', 'background');
        const audioTrack = trackFor(timeline, 'audio', '原声（绑定背景）', 'source_audio');
        const bgClips = clipsByRole(timeline, 'background').sort((a, b) => a.startT - b.startT);
        if (!bgClips.length) return false;

        const lastClip = bgClips[bgClips.length - 1];
        const lastEnd = lastClip.startT + lastClip.effectiveDuration;
        if (lastEnd >= totalDuration - 0.05) return false;

        const sourcePath = timeline.sources[lastClip.sourceId]?.path || task.bgPath || task.videoPath || '';
        const sourceDuration = timeline.sources[lastClip.sourceId]?.duration || (lastClip.outT - lastClip.inT) || 5;
        const baseLoopDur = Math.max(0.5, sourceDuration * (lastClip.speed || 1));

        let currentT = lastEnd;
        let loopIdx = (lastClip._extra?.loopIndex != null ? lastClip._extra.loopIndex : bgClips.length - 1) + 1;
        let addedCount = 0;

        while (currentT < totalDuration - 0.01) {
            const thisDur = Math.min(baseLoopDur, totalDuration - currentT);
            const sourceId = sourceFor(timeline, sourcePath, finite(sourceDuration, 5), 'background');
            const group = `bg_link_fill_${loopIdx}_${Math.round(currentT * 1000)}`;
            const video = new TimelineLib.Clip(sourceId, 0, thisDur * (lastClip.speed || 1), currentT);
            video.speed = lastClip.speed || 1;
            video.linkGroupId = group;
            video._extra.role = 'background';
            video._extra.sequenceIndex = loopIdx;
            video._extra.loopIndex = loopIdx;
            video._extra.transition = task.bgTransition || 'none';
            videoTrack.clips.push(video);

            const originalAudio = new TimelineLib.Clip(sourceId, 0, thisDur * (lastClip.speed || 1), currentT);
            originalAudio.speed = video.speed;
            originalAudio.linkGroupId = group;
            originalAudio.isMain = true;
            originalAudio._extra.role = 'source_audio';
            originalAudio._extra.sequenceIndex = loopIdx;
            originalAudio._extra.loopIndex = loopIdx;
            audioTrack.clips.push(originalAudio);

            currentT += thisDur;
            loopIdx++;
            addedCount++;
        }

        syncLegacyFields(task);
        return addedCount > 0;
    }

    const api = { ensureTimeline, syncLegacyFields, getEditorTracks, applyEditorClip, fillBackgroundLoops };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ReelsRenderPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
