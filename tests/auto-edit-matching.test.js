const test = require('node:test');
const assert = require('node:assert/strict');
const autoEdit = require('../electron/services/autoEdit');

test('normalization ignores punctuation and case', () => {
    assert.equal(autoEdit.normalizeText('Hello，World!'), 'helloworld');
});

test('word score tolerates a missing filler word', () => {
    const score = autoEdit._test.scoreWordCandidate(
        ['today', 'share', 'three', 'simple', 'methods'],
        ['today', 'share', 'three', 'very', 'simple', 'methods']
    );
    assert.ok(score > 0.75, `expected a useful match, got ${score}`);
});

test('distinctive keywords separate the correct candidate', () => {
    const correct = autoEdit._test.scoreWordCandidate(['videokit', '2026', 'berlin'], ['videokit', '2026', 'berlin']);
    const wrong = autoEdit._test.scoreWordCandidate(['another', 'generic', 'sentence'], ['videokit', '2026', 'berlin']);
    assert.ok(correct > wrong);
});

test('a repeated short line inside a unique block is not reported as an ambiguous match', () => {
    const lines = [
        "Aujourd'hui.",
        'Texte sans rapport.',
        'Quelques mots.',
        "Aujourd'hui.",
        'tu seras avec moi dans le paradis.',
        "Aujourd'hui.",
    ];
    const block = "Quelques mots.\nAujourd'hui.\ntu seras avec moi dans le paradis.";
    assert.deepEqual(autoEdit._test.findRepeatedScriptBlockStarts(lines, block), []);
});

test('only a complete repeated block is reported with each starting line', () => {
    const lines = ['alpha', 'beta', 'milieu', 'alpha', 'beta'];
    assert.deepEqual(autoEdit._test.findRepeatedScriptBlockStarts(lines, 'alpha\nbeta'), [1, 4]);
});

test('missing-block boundary recognizes a lightly inflected phrase already read by the previous clip', () => {
    const words = ["d’étude", 'biblique', 'Clique', 'sur', 'le', 'lien'].map(raw => ({ raw }));
    assert.equal(
        autoEdit._test.findFuzzyBoundaryOverlap(words, "notre groupe d'études bibliques.", 'start'),
        2
    );
});

test('missing-block boundary does not consume unrelated following text', () => {
    const words = ['Clique', 'sur', 'le', 'lien'].map(raw => ({ raw }));
    assert.equal(autoEdit._test.findFuzzyBoundaryOverlap(words, 'notre groupe biblique', 'start'), 0);
});

test('boundary overlap keeps original indices when punctuation is a separate multilingual token', () => {
    const words = ['你', '，', '好', '后面'].map(raw => ({ raw }));
    assert.equal(autoEdit._test.findFuzzyBoundaryOverlap(words, '你好', 'start'), 3);
});

test('sentence ending punctuation is detected without treating a comma as an ending', () => {
    assert.equal(autoEdit._test.hasSentenceEndingPunctuation('finished.'), true);
    assert.equal(autoEdit._test.hasSentenceEndingPunctuation('完成了！'), true);
    assert.equal(autoEdit._test.hasSentenceEndingPunctuation('keep going,'), false);
});

test('a one-word boundary gap is conservatively recovered into the previous clip', () => {
    const scriptWords = ['this', 'is', 'important.', 'next'].map((raw, wordIndex) => ({
        raw,
        norm: autoEdit.normalizeText(raw),
        wordIndex,
        lineIndex: 0,
    }));
    const previous = {
        sourceIndex: 0,
        scriptWordStart: 0,
        scriptWordEnd: 1,
        wordStartIdx: 0,
        wordEndIdx: 1,
        duration: 3,
        end: 1.2,
        matchedWordsArray: [],
        words: [
            { raw: 'this', norm: 'this', start: 0.1, end: 0.4 },
            { raw: 'is', norm: 'is', start: 0.45, end: 0.7 },
            { raw: 'important', norm: 'important', start: 0.72, end: 1.2 },
        ],
    };
    const next = {
        sourceIndex: 1,
        scriptWordStart: 3,
        scriptWordEnd: 3,
        wordStartIdx: 0,
        wordEndIdx: 0,
        duration: 2,
        start: 0.1,
        matchedWordsArray: [],
        words: [{ raw: 'next', norm: 'next', start: 0.1, end: 0.5 }],
    };
    const recovered = autoEdit._test.recoverSmallBoundaryGaps([previous, next], scriptWords, 0.04, 0.08);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].side, 'previous');
    assert.equal(previous.scriptWordEnd, 2);
    assert.equal(previous.wordEndIdx, 2);
    assert.equal(previous.end, 1.28);
});

test('boundary recovery does not absorb a gap that is not present beside the cut', () => {
    const scriptWords = ['one', 'missing', 'two'].map((raw, wordIndex) => ({ raw, norm: raw, wordIndex, lineIndex: 0 }));
    const plans = [
        { sourceIndex: 0, scriptWordStart: 0, scriptWordEnd: 0, wordStartIdx: 0, wordEndIdx: 0, duration: 2, matchedWordsArray: [], words: [{ raw: 'one', norm: 'one', start: 0, end: .4 }, { raw: 'other', norm: 'other', start: .5, end: .8 }] },
        { sourceIndex: 1, scriptWordStart: 2, scriptWordEnd: 2, wordStartIdx: 0, wordEndIdx: 0, duration: 2, matchedWordsArray: [], words: [{ raw: 'two', norm: 'two', start: 0, end: .4 }] },
    ];
    assert.equal(autoEdit._test.recoverSmallBoundaryGaps(plans, scriptWords, .04, .08).length, 0);
});
