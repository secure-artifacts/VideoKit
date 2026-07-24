const test = require('node:test');
const assert = require('node:assert/strict');

const direction = require('../src/reels-text-direction.js');

test('auto direction follows the first strong character', () => {
    assert.equal(direction.resolve('auto', 'مرحبا بالعالم'), 'rtl');
    assert.equal(direction.resolve('auto', '123 — العربية'), 'rtl');
    assert.equal(direction.resolve('auto', 'Hello العربية'), 'ltr');
    assert.equal(direction.resolve('auto', '中文测试'), 'ltr');
});

test('explicit text direction overrides automatic detection', () => {
    assert.equal(direction.resolve('rtl', 'Hello world'), 'rtl');
    assert.equal(direction.resolve('ltr', 'مرحبا بالعالم'), 'ltr');
});

test('enhanced ASS adds an RTL mark and disables character spacing', () => {
    const previousDocument = global.document;
    global.document = {
        createElement: () => ({
            getContext: () => ({
                font: '',
                measureText: text => ({ width: String(text).length * 10 }),
            }),
        }),
    };

    try {
        const processor = require('../src/reels-subtitle-processor.js');
        const ass = processor.generateEnhancedASS(
            [{ start: 0, end: 2, text: 'مرحبا بالعالم', words: [] }],
            { text_direction: 'auto', font_family: 'Arial', fontsize: 48, letter_spacing: 6 },
            1080,
            1920
        );
        assert.match(ass, /\u200Fمرحبا بالعالم/);
        assert.match(ass, /\\fsp0/);
    } finally {
        if (previousDocument === undefined) delete global.document;
        else global.document = previousDocument;
    }
});
