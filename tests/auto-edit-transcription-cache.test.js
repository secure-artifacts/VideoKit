const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gladia = require('../electron/services/gladia');
const autoEdit = require('../electron/services/autoEdit');

test('auto edit retries an empty Gladia result immediately', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-autoedit-'));
    const clip = path.join(dir, 'voice.mp4');
    fs.writeFileSync(clip, 'fake-media');
    const original = gladia.transcribeAudioFull;
    let calls = 0;
    gladia.transcribeAudioFull = async () => {
        calls += 1;
        if (calls === 1) return { wordTimeInfo: [], fullText: '' };
        return {
            wordTimeInfo: [{ text: 'hello', words: [{ word: 'hello', start: 0, end: 1 }] }],
            fullText: 'hello',
        };
    };
    try {
        const result = await autoEdit._test.transcribeClip(clip, 'auto', ['key'], dir, false);
        assert.equal(calls, 2);
        assert.equal(result.fullText, 'hello');
        assert.equal(result.source, 'gladia');
    } finally {
        gladia.transcribeAudioFull = original;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('auto edit treats repeated empty API results as a service failure and never caches them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-autoedit-'));
    const clip = path.join(dir, 'voice.mp4');
    fs.writeFileSync(clip, 'fake-media');
    const original = gladia.transcribeAudioFull;
    let calls = 0;
    gladia.transcribeAudioFull = async (_clip, _keys, _lang, jsonPath, txtPath) => {
        calls += 1;
        fs.writeFileSync(jsonPath, '[]');
        fs.writeFileSync(txtPath, '');
        return { wordTimeInfo: [], fullText: '' };
    };
    try {
        await assert.rejects(
            autoEdit._test.transcribeClip(clip, 'auto', ['key'], dir, false),
            /识别服务连续两次返回空响应/
        );
        assert.equal(calls, 2);
        assert.equal(fs.readdirSync(dir).filter(name => /_autoedit\.(json|txt)$/.test(name)).length, 0);
    } finally {
        gladia.transcribeAudioFull = original;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
