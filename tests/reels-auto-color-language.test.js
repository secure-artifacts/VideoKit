const test = require('node:test');
const assert = require('node:assert/strict');
const richText = require('../src/reels-rich-text.js');

test('multilingual word auto-color keeps Polish and French words intact', () => {
    const text = "Żółć i l’homme sont déjà là";
    const ranges = richText.autoColorize(text, [{ type: 'english', keywords: ['[a-zA-Z]+'], color: '#ffd700' }]);
    assert.deepEqual(ranges.map(({ start, end }) => text.slice(start, end)), ['Żółć', 'i', 'l’homme', 'sont', 'déjà', 'là']);
});

test('keyword auto-color is Unicode case-insensitive by default', () => {
    const text = 'Miłość jest piękna';
    const ranges = richText.autoColorize(text, [{ type: 'keyword', keywords: ['MIŁOŚĆ'], color: '#ffd700' }]);
    assert.deepEqual(ranges.map(({ start, end }) => text.slice(start, end)), ['Miłość']);
});
