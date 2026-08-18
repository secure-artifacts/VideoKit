const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { Timeline, Track, Clip, MediaSource } = require('../src/reels-timeline.js');

function addSource(timeline, id, duration = 30) {
    const source = new MediaSource(path.join(os.tmpdir(), `${id}.mp4`));
    source.id = id;
    source.duration = duration;
    timeline.sources[id] = source;
}

test('default timeline binds the primary video and its original audio', () => {
    const timeline = Timeline.createDefault(path.join(os.tmpdir(), 'main.mp4'), 20);
    const [video] = timeline.findTrackByType('video').clips;
    const [audio] = timeline.findTrackByType('audio').clips;
    assert.ok(video.linkGroupId);
    assert.equal(audio.linkGroupId, video.linkGroupId);
    assert.deepEqual(timeline.linkedClips(video).map(clip => clip.id).sort(), [audio.id, video.id].sort());
});

test('ripple moves following clips but leaves independent BGM in place', () => {
    const timeline = new Timeline();
    addSource(timeline, 'main');
    const video = new Track('video');
    const first = new Clip('main', 0, 5, 0);
    const second = new Clip('main', 5, 10, 5);
    video.clips.push(first, second);
    timeline.addTrack(video);

    const bgm = new Track('bgm');
    const music = new Clip('main', 0, 20, 0);
    music.followRipple = false;
    bgm.clips.push(music);
    timeline.addTrack(bgm);

    timeline.rippleFrom(5, 2);
    assert.equal(second.startT, 7);
    assert.equal(music.startT, 0);
});

test('linked trim ripples following content and serializes binding metadata', () => {
    const timeline = Timeline.createDefault(path.join(os.tmpdir(), 'main.mp4'), 20);
    const video = timeline.findTrackByType('video').clips[0];
    const audio = timeline.findTrackByType('audio').clips[0];
    const subs = timeline.findTrackByType('subs');
    const next = new Clip(video.sourceId, 0, 5, 20);
    subs.clips.push(next);

    const result = timeline.trimLinked(video.id, 'end', 15);
    assert.equal(video.effectiveDuration, 15);
    assert.equal(audio.effectiveDuration, 15);
    assert.equal(next.startT, 15);
    const restored = Timeline.fromJSON(timeline.toJSON());
    const restoredVideo = restored.findClip(video.id).clip;
    assert.equal(restoredVideo.linkGroupId, video.linkGroupId);
    assert.equal(restoredVideo.followRipple, true);
});

test('unlinking a companion stops group movement', () => {
    const timeline = Timeline.createDefault(path.join(os.tmpdir(), 'main.mp4'), 20);
    const video = timeline.findTrackByType('video').clips[0];
    const audio = timeline.findTrackByType('audio').clips[0];
    timeline.unlinkClips([audio.id]);
    timeline.moveLinked(video.id, 4);
    assert.equal(video.startT, 4);
    assert.equal(audio.startT, 0);
});
