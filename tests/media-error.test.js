const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpegService = require('../electron/services/ffmpeg');
const {
    formatMediaError,
    formatProcessStartError,
    extractMissingPath,
} = require('../electron/services/media-error');

test('extracts a missing input path from FFmpeg stderr', () => {
    const stderr = [
        '[in#1] Error opening input: No such file or directory',
        'Error opening input file C:\\Users\\test\\voice.mp3.',
        'Error opening input files: No such file or directory',
    ].join('\n');
    assert.equal(extractMissingPath(stderr), 'C:\\Users\\test\\voice.mp3');
});

test('translates common FFmpeg file and system failures', () => {
    assert.equal(
        formatMediaError('output.mp4: Permission denied', { action: '视频导出' }),
        '视频导出失败：没有文件读取或写入权限，请检查文件和输出目录权限'
    );
    assert.equal(
        formatMediaError('Invalid data found when processing input', { action: '读取素材' }),
        '读取素材失败：素材文件可能已损坏，或格式不受支持'
    );
    assert.equal(
        formatMediaError('No space left on device', { action: '视频导出' }),
        '视频导出失败：磁盘空间不足，请清理空间或更换输出目录'
    );
    assert.equal(
        formatMediaError('Output file does not contain any stream', { action: '提取音频' }),
        '提取音频失败：素材中没有可用的音轨'
    );
});

test('does not expose unknown raw stderr to users', () => {
    const raw = 'private ffmpeg diagnostic details';
    const message = formatMediaError(raw, { action: '媒体处理', code: 17 });
    assert.equal(message, '媒体处理失败（错误码 17）。请检查素材格式和导出设置；详细日志已写入控制台');
    assert.equal(message.includes(raw), false);
});

test('translates FFmpeg process startup failures', () => {
    assert.equal(
        formatProcessStartError('FFmpeg', '/missing/ffmpeg', new Error('spawn ENOENT')),
        'FFmpeg 未安装或程序文件不存在，无法启动媒体处理'
    );
});

test('duration diagnostics distinguish missing and empty media files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-duration-'));
    try {
        const missing = await ffmpegService.getDurationDetailed(path.join(dir, 'missing.mp4'));
        assert.equal(missing.code, 'NOT_FOUND');

        const emptyPath = path.join(dir, 'empty.mp4');
        fs.writeFileSync(emptyPath, '');
        const empty = await ffmpegService.getDurationDetailed(emptyPath);
        assert.equal(empty.code, 'EMPTY_FILE');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
