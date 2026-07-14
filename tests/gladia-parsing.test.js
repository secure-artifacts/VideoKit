const test = require('node:test');
const assert = require('node:assert/strict');
const gladia = require('../electron/services/gladia');

test('Gladia sentence-only responses receive synthetic word timestamps', () => {
    const results = [];
    const fullText = [];
    const ok = gladia.getJsonResult({
        result: {
            transcription: {
                utterances: [{ start: 1, end: 3, text: 'stay for seven seconds', words: [] }],
            },
        },
    }, results, fullText, 0);

    assert.equal(ok, true);
    assert.equal(fullText.join(' '), 'stay for seven seconds');
    assert.equal(results[0].words.length, 4);
    assert.equal(results[0].words[0].start, 1);
    assert.equal(results[0].words.at(-1).end, 3);
});

test('Gladia full transcript fallback is not treated as silence', () => {
    const results = [];
    const fullText = [];
    const ok = gladia.getJsonResult({
        result: { transcription: { utterances: [], full_transcript: 'do not close this video' } },
        metadata: { audio_duration: 2.5 },
    }, results, fullText, 5);

    assert.equal(ok, true);
    assert.equal(fullText.join(' '), 'do not close this video');
    assert.equal(results[0].audio_start, 5);
    assert.equal(results[0].words.at(-1).end, 7.5);
});
