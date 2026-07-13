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
