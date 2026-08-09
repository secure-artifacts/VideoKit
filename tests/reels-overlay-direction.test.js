const test = require('node:test');
const assert = require('node:assert/strict');
const overlay = require('../src/reels-overlay.js');

test('text and scroll overlays default to automatic text direction', () => {
    assert.equal(overlay.createTextOverlay().text_direction, 'auto');
    assert.equal(overlay.createTextCardOverlay().text_direction, 'auto');
    assert.equal(overlay.createScrollOverlay().text_direction, 'auto');
});

test('overlays preserve an explicitly selected text direction', () => {
    assert.equal(overlay.createTextOverlay({ text_direction: 'rtl' }).text_direction, 'rtl');
    assert.equal(overlay.createTextCardOverlay({ text_direction: 'rtl' }).text_direction, 'rtl');
    assert.equal(overlay.createScrollOverlay({ text_direction: 'rtl' }).text_direction, 'rtl');
});
