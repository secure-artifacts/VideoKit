const test = require('node:test');
const assert = require('node:assert/strict');
const rawVideo = require('../electron/services/ffmpeg-rawvideo');

test('overlay frame extraction normalizes sample aspect ratio before PNG output', () => {
    assert.equal(
        rawVideo._test.normalizeDisplayAspectFilter(),
        'scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1'
    );
});
