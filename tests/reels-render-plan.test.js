const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const RenderPlan = require('../src/reels-render-plan.js');

test('preview and export receive the same timeline-synchronised task fields', () => {
    const task = {
        bgPath: path.join(os.tmpdir(), 'original.mp4'),
        audioPath: path.join(os.tmpdir(), 'voice.mp3'),
        bgmPath: path.join(os.tmpdir(), 'music.mp3'),
        customDuration: 12,
        segments: [{ start: 0, end: 2, text: 'hello' }],
    };
    const timeline = RenderPlan.ensureTimeline(task, { duration: 12 });
    const background = timeline.tracks.flatMap((track) => track.clips)
        .find((clip) => clip._extra.role === 'background');
    const source = timeline.sources[background.sourceId];
    source.path = path.join(os.tmpdir(), 'replacement.mp4');
    background.inT = 2;
    background.outT = 10;
    background.startT = 1;

    // Both callers deliberately use the same public boundary.
    const previewInput = RenderPlan.syncLegacyFields(task);
    const exportInput = RenderPlan.syncLegacyFields(task);
    assert.equal(previewInput, exportInput);
    assert.equal(previewInput.bgPath, path.join(os.tmpdir(), 'replacement.mp4'));
    assert.equal(exportInput.videoPath, path.join(os.tmpdir(), 'replacement.mp4'));
    assert.deepEqual(exportInput.timelineBackgroundTrim, { in_t: 2, out_t: 10, start_t: 1 });
});

test('editor clip changes write to task.timeline before render synchronisation', () => {
    const task = { bgPath: path.join(os.tmpdir(), 'clip.mp4'), customDuration: 10, segments: [] };
    const tracks = RenderPlan.getEditorTracks(task, { duration: 10 });
    const clip = tracks.find((track) => track.type === 'video').clips[0];
    clip.start = 3;
    clip.end = 9;
    assert.equal(RenderPlan.applyEditorClip(task, clip), true);
    const saved = task.timeline.findClip(clip._timelineClipId).clip;
    assert.equal(saved.startT, 3);
    assert.equal(saved.effectiveDuration, 6);
    assert.equal(task.timelineBackgroundTrim.start_t, 3);
});

test('legacy tasks with only subtitles still receive visible main video and linked original audio clips', () => {
    const task = {
        bgPath: path.join(os.tmpdir(), 'background.mp4'),
        audioPath: path.join(os.tmpdir(), 'voice.mp3'),
        segments: [{ start: 0, end: 18, text: 'review subtitle' }],
        // Simulates a project saved before the Reels timeline became authoritative.
        timeline: { width: 1080, height: 1920, fps: 30, sources: {}, tracks: [] },
    };
    const tracks = RenderPlan.getEditorTracks(task, { duration: 18 });
    const allClips = tracks.flatMap(track => track.clips);
    assert.equal(allClips.find(clip => clip._timelineRole === 'background').end, 18);
    assert.ok(allClips.some(clip => clip._timelineRole === 'source_audio'));
    assert.ok(allClips.some(clip => clip._timelineRole === 'voice'));
    assert.ok(tracks.filter(track => track.type === 'audio').length >= 2);
});

test('multi-background tasks render each preview segment as a separate timeline clip', () => {
    const task = { bgMode: 'multi', bgClipPool: ['one.mp4', 'two.mp4'], segments: [] };
    const tracks = RenderPlan.getEditorTracks(task, {
        duration: 12,
        backgroundSegments: [
            { path: 'one.mp4', start: 0, end: 5, duration: 5, trimStart: 0, speedFactor: 1 },
            { path: 'two.mp4', start: 5, end: 12, duration: 7, trimStart: 1, speedFactor: 1 },
        ],
    });
    const allClips = tracks.flatMap(track => track.clips);
    assert.deepEqual(allClips.filter(clip => clip._timelineRole === 'background').map(clip => [clip.start, clip.end]), [[0, 5], [5, 12]]);
});

test('repeated instances of the same background remain separate timeline clips', () => {
    const task = { bgPath: 'loop.mp4', segments: [] };
    const tracks = RenderPlan.getEditorTracks(task, {
        duration: 12,
        backgroundSegments: [
            { path: 'loop.mp4', start: 0, end: 5, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 0 },
            { path: 'loop.mp4', start: 5, end: 10, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 1 },
            { path: 'loop.mp4', start: 10, end: 12, duration: 2, trimStart: 0, speedFactor: 1, loopIndex: 2 },
        ],
    });
    const backgroundNames = tracks.flatMap(track => track.clips)
        .filter(clip => clip._timelineRole === 'background').map(clip => clip.name);
    assert.deepEqual(backgroundNames, ['loop.mp4 #1', 'loop.mp4 #2', 'loop.mp4 #3']);
});

test('moving a loop instance ripples later loops and its linked original audio without overlap', () => {
    const task = { bgPath: 'loop.mp4', segments: [] };
    const options = {
        duration: 15,
        backgroundSegments: [
            { path: 'loop.mp4', start: 0, end: 5, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 0 },
            { path: 'loop.mp4', start: 5, end: 10, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 1 },
            { path: 'loop.mp4', start: 10, end: 15, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 2 },
        ],
    };
    const tracks = RenderPlan.getEditorTracks(task, options);
    const secondBackground = tracks.flatMap(track => track.clips)
        .find(clip => clip._timelineRole === 'background' && clip._loopIndex === 1);
    secondBackground.start = 7;
    secondBackground.end = 12;
    assert.equal(RenderPlan.applyEditorClip(task, secondBackground, { editMode: 'move' }), true);
    const saved = task.timeline.tracks.flatMap(track => track.clips);
    const backgrounds = saved.filter(clip => clip._extra.role === 'background').sort((a, b) => a.startT - b.startT);
    const originalAudio = saved.filter(clip => clip._extra.role === 'source_audio').sort((a, b) => a.startT - b.startT);
    assert.deepEqual(backgrounds.map(clip => clip.startT), [0, 7, 12]);
    assert.deepEqual(originalAudio.map(clip => clip.startT), [0, 7, 12]);
    assert.ok(backgrounds.every((clip, index) => index === 0 || clip.startT >= backgrounds[index - 1].startT + backgrounds[index - 1].effectiveDuration));
});

test('trimming start or end of video clip trims linked original audio companion synchronously', () => {
    const task = { bgPath: 'loop.mp4', segments: [] };
    const options = {
        duration: 10,
        backgroundSegments: [
            { path: 'loop.mp4', start: 0, end: 5, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 0 },
            { path: 'loop.mp4', start: 5, end: 10, duration: 5, trimStart: 0, speedFactor: 1, loopIndex: 1 },
        ],
    };
    const tracks = RenderPlan.getEditorTracks(task, options);
    const firstVideo = tracks.flatMap(track => track.clips)
        .find(clip => clip._timelineRole === 'background' && clip._loopIndex === 0);
    
    // Trim end from 5s to 3s
    firstVideo.end = 3;
    assert.equal(RenderPlan.applyEditorClip(task, firstVideo, { editMode: 'trim_end' }), true);
    
    let saved = task.timeline.tracks.flatMap(track => track.clips);
    let firstBg = saved.find(clip => clip._extra.role === 'background' && clip._extra.loopIndex === 0);
    let firstAudio = saved.find(clip => clip._extra.role === 'source_audio' && clip._extra.loopIndex === 0);
    assert.equal(firstBg.effectiveDuration, 3);
    assert.equal(firstAudio.effectiveDuration, 3);
    assert.equal(firstAudio.outT, 3);

    // Trim start from 0s to 1s
    firstVideo.start = 1;
    assert.equal(RenderPlan.applyEditorClip(task, firstVideo, { editMode: 'trim_start' }), true);
    
    saved = task.timeline.tracks.flatMap(track => track.clips);
    firstBg = saved.find(clip => clip._extra.role === 'background' && clip._extra.loopIndex === 0);
    firstAudio = saved.find(clip => clip._extra.role === 'source_audio' && clip._extra.loopIndex === 0);
    assert.equal(firstBg.startT, 1);
    assert.equal(firstAudio.startT, 1);
    assert.equal(firstAudio.inT, 1);
    assert.equal(firstAudio.effectiveDuration, 2);
});
