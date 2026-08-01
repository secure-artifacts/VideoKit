const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../electron/services/autoEditMatcherV2');

test('unknown and old projects stay on the legacy engine', () => {
    assert.equal(matcher.normalizeEngine(), 'legacy');
    assert.equal(matcher.normalizeEngine('legacy'), 'legacy');
    assert.equal(matcher.normalizeEngine('future_version'), 'legacy');
    assert.equal(matcher.normalizeEngine('multilingual_v2'), 'multilingual_v2');
    assert.equal(matcher.normalizeEngine('compare_v2'), 'compare_v2');
});

test('language-aware segmentation keeps European words and normalizes apostrophes', () => {
    assert.deepEqual(matcher.segmentWords("L’homme n’est pas ici.", 'fr'), ['lhomme', 'nest', 'pas', 'ici']);
    assert.deepEqual(matcher.segmentWords('Übermäßig große Häuser', 'de'), ['übermäßig', 'große', 'häuser']);
});

test('V2 tolerates apostrophe, hyphen, and split compound formatting differences', () => {
    assert.ok(matcher.tolerantSimilarity("l’homme arrive", 'l homme arrive', 'fr') > 0.8);
    assert.equal(matcher.tolerantSimilarity('data-driven tools', 'data driven tools', 'en'), 1);
    assert.equal(matcher.tolerantSimilarity('Krankenversicherung', 'Kranken Versicherung', 'de'), 1);
});

test('V2 keeps the complete multilingual boundary when ASR splits punctuation', () => {
    const words = ['noise', 'data', 'driven', 'tools', 'extra'].map((raw, index) => ({
        raw,
        start: index,
        end: index + 0.5,
    }));
    const match = matcher.findBestCutWindow(words, 'data-driven tools', 'en');
    assert.equal(match.startIdx, 1);
    assert.equal(match.endIdx, 3);
    assert.equal(match.matchedText, 'data driven tools');
});

test('V2 treats a textual difference as review instead of a confirmed omission', () => {
    const result = matcher.assessSegment({
        language: 'en',
        plan: {
            scriptStartLine: 0,
            scriptText: 'we absolutely cannot accept this proposal today',
            matchedText: 'we can accept it',
            transcription: { source: 'gladia', fullText: 'we can accept it' },
            words: [
                { score: 0.91 },
                { score: 0.88 },
                { score: 0.9 },
                { score: 0.86 },
            ],
        },
        info: { similarity: 40 },
    });
    assert.equal(result.status, 'warning');
    assert.equal(result.verificationLevel, 'review');
    assert.match(result.issueReason, /请试听确认/);
});

test('V2 never promotes an unassigned script block to confirmed missing', () => {
    const block = matcher.assessMissingBlock({ text: 'do not', startLine: 2, endLine: 2 });
    assert.equal(block.status, 'warning');
    assert.equal(block.verification_level, 'review');
    assert.match(block.issue_reason, /不能据此认定|可能/);
});

test('V2 reports synthetic or absent word confidence as unavailable', () => {
    assert.deepEqual(matcher.confidenceSummary([{ score: 0 }, {}]), {
        available: false,
        average: 0,
        reliableRatio: 0,
    });
});

test('V2 independently calculates entry and exit points from its own multilingual word window', () => {
    const plan = {
        scriptText: 'bonjour tout le monde',
        start: 0,
        end: 5,
        duration: 5,
        words: [
            { raw: 'bruit', start: 0.1, end: 0.4, score: 0.8 },
            { raw: 'bonjour', start: 0.8, end: 1.25, score: 0.95 },
            { raw: 'tout', start: 1.3, end: 1.55, score: 0.94 },
            { raw: 'le', start: 1.6, end: 1.72, score: 0.93 },
            { raw: 'monde', start: 1.76, end: 2.2, score: 0.96 },
            { raw: 'merci', start: 3.1, end: 3.5, score: 0.9 },
        ],
    };
    const cut = matcher.calculateCut(plan, { language: 'fr', leadPad: 0.05, tailPad: 0.1 });
    assert.equal(cut.applied, true);
    assert.equal(cut.engine, 'multilingual_v2');
    assert.ok(Math.abs(cut.start - 0.75) < 0.0001);
    assert.ok(Math.abs(cut.end - 2.3) < 0.0001);
    assert.equal(cut.wordStartIdx, 1);
    assert.equal(cut.wordEndIdx, 4);
});

test('V2 cut matching accepts a German compound split by ASR', () => {
    const cut = matcher.calculateCut({
        scriptText: 'Krankenversicherung',
        start: 0,
        end: 4,
        duration: 4,
        words: [
            { raw: 'Kranken', start: 1, end: 1.4 },
            { raw: 'Versicherung', start: 1.45, end: 2.1 },
        ],
    }, { language: 'de', leadPad: 0.04, tailPad: 0.08 });
    assert.equal(cut.applied, true);
    assert.ok(Math.abs(cut.start - 0.96) < 0.0001);
    assert.ok(Math.abs(cut.end - 2.18) < 0.0001);
});

test('V2 cut indices still point to the original timeline when invalid words are skipped', () => {
    const cut = matcher.calculateCut({
        scriptText: 'hola mundo',
        start: 0,
        end: 4,
        duration: 4,
        words: [
            { raw: '', start: 0, end: 0.1 },
            { raw: 'hola', start: 1, end: 1.4 },
            { raw: 'mundo', start: 1.5, end: 2 },
        ],
    }, { language: 'es', leadPad: 0.05, tailPad: 0.1 });
    assert.equal(cut.applied, true);
    assert.equal(cut.wordStartIdx, 1);
    assert.equal(cut.wordEndIdx, 2);
    assert.ok(Math.abs(cut.start - 0.95) < 0.0001);
    assert.ok(Math.abs(cut.end - 2.1) < 0.0001);
});

test('V2 falls back per clip when it cannot locate a reliable cut', () => {
    const cut = matcher.calculateCut({
        scriptText: 'completely unrelated target sentence',
        start: 0.4,
        end: 2.6,
        duration: 3,
        words: [{ raw: 'bonjour', start: 1, end: 1.4 }],
    }, { language: 'en', leadPad: 0.04, tailPad: 0.08 });
    assert.equal(cut.applied, false);
    assert.equal(cut.engine, 'legacy_fallback');
    assert.equal(cut.start, 0.4);
    assert.equal(cut.end, 2.6);
});
