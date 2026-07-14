const test = require('node:test');
const assert = require('node:assert/strict');
const rawVideo = require('../electron/services/ffmpeg-rawvideo');

test('Windows H.264 encoding disables the crashing x264 frame threads', () => {
    const args = rawVideo._test.cpuH264EncoderArgs('faster', 23, 'win32');
    assert.deepEqual(args.slice(0, 4), ['-c:v', 'libx264', '-threads', '1']);
});

test('Windows JPEG extraction uses a stable pixel format and one encoder thread', () => {
    const args = rawVideo._test.stableJpegEncoderArgs('win32');
    assert.ok(args.includes('mjpeg'));
    assert.ok(args.includes('yuvj420p'));
    assert.deepEqual(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 2), ['-threads', '1']);
});

test('non-Windows encoders retain normal FFmpeg threading', () => {
    assert.equal(rawVideo._test.cpuH264EncoderArgs('faster', 23, 'darwin').includes('-threads'), false);
    assert.equal(rawVideo._test.stableJpegEncoderArgs('linux').includes('-threads'), false);
});
