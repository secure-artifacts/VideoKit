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

test('Reels quality levels use stable capped bitrate targets', () => {
    assert.deepEqual(rawVideo._test.h264RateControlArgs(15), [
        '-b:v', '12M', '-maxrate', '16M', '-bufsize', '24M',
    ]);
    assert.deepEqual(rawVideo._test.h264RateControlArgs(18), [
        '-b:v', '8M', '-maxrate', '11M', '-bufsize', '16M',
    ]);
    assert.deepEqual(rawVideo._test.h264RateControlArgs(23), [
        '-b:v', '1.5M', '-maxrate', '2.5M', '-bufsize', '3M',
    ]);
    assert.deepEqual(rawVideo._test.h264RateControlArgs(26), [
        '-b:v', '2500k', '-maxrate', '3500k', '-bufsize', '5M',
    ]);
});

test('custom Reels bitrate overrides presets and clamps invalid ranges', () => {
    assert.deepEqual(rawVideo._test.h264RateControlArgs(23, 6.5, 9), [
        '-b:v', '6.5M', '-maxrate', '9M', '-bufsize', '13M',
    ]);
    assert.deepEqual(rawVideo._test.h264RateControlArgs(23, 40, 2), [
        '-b:v', '30M', '-maxrate', '30M', '-bufsize', '60M',
    ]);
});

test('Windows GPU encoders share the ordinary quality bitrate cap', () => {
    const candidates = rawVideo._test.gpuH264EncoderCandidates('win32', 23);
    assert.deepEqual(candidates.map(candidate => candidate.codec), [
        'h264_nvenc', 'h264_amf', 'h264_qsv',
    ]);
    for (const candidate of candidates) {
        assert.deepEqual(
            candidate.args.slice(candidate.args.indexOf('-b:v')),
            ['-b:v', '1.5M', '-maxrate', '2.5M', '-bufsize', '3M']
        );
    }
});

test('macOS GPU and CPU fallback use the same ordinary quality bitrate cap', () => {
    const [videoToolbox] = rawVideo._test.gpuH264EncoderCandidates('darwin', 23);
    const cpu = rawVideo._test.cpuH264EncoderArgs('faster', 23, 'darwin');
    assert.deepEqual(
        videoToolbox.args.slice(videoToolbox.args.indexOf('-b:v')),
        ['-b:v', '1.5M', '-maxrate', '2.5M', '-bufsize', '3M']
    );
    assert.deepEqual(
        cpu.slice(cpu.indexOf('-b:v')),
        ['-b:v', '1.5M', '-maxrate', '2.5M', '-bufsize', '3M']
    );
});

test('overlay frame validation allows only normal encoder rounding', () => {
    assert.equal(rawVideo._test.expectedFrameCount(8, 30), 238);
    assert.equal(rawVideo._test.expectedFrameCount(0, 30), 0);
    assert.equal(rawVideo._test.expectedFrameCount(8, 0), 0);
});

test('missing FFmpeg audio inputs are reported as a clear file error', () => {
    const stderr = [
        '[in#1] Error opening input: No such file or directory',
        'Error opening input file /Users/test/voice.mp3.',
        'Error opening input files: No such file or directory',
    ].join('\n');
    assert.equal(
        rawVideo._test.formatMixFailure(stderr, 254),
        '音频文件不存在或已被移动，请重新选择：/Users/test/voice.mp3'
    );
});

test('FFmpeg failures are translated without exposing raw stderr', () => {
    assert.equal(
        rawVideo._test.formatMediaError('Error while opening encoder for output stream #0:0', {
            action: '视频编码',
            code: 1,
        }),
        '视频编码失败：视频编码器不可用，请切换为 CPU 编码后重试'
    );
    assert.equal(
        rawVideo._test.formatMediaError('av_interleaved_write_frame(): No space left on device', {
            action: '视频导出',
            code: 1,
        }),
        '视频导出失败：磁盘空间不足，请清理空间或更换输出目录'
    );
    assert.equal(
        rawVideo._test.formatMediaError('some internal ffmpeg diagnostic', {
            action: '背景处理',
            code: 234,
        }),
        '背景处理失败（错误码 234）。请检查素材格式和导出设置；详细日志已写入控制台'
    );
});
