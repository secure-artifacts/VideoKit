const test = require('node:test');
const assert = require('node:assert/strict');

const Derivation = require('../src/reels-task-derivation.js');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('derived tasks clear every template subtitle and text source and receive unique task IDs', () => {
    const template = {
        id: 'template-task',
        srtPath: '/old/template.srt',
        txtPath: '/old/template.txt',
        segments: [{ start: 0, end: 1, text: 'OLD TEMPLATE SUBTITLE' }],
        txtContent: 'old txt',
        ttsText: 'old tts',
        aiScript: 'old ai',
        manualText: 'old manual',
        aligned: true,
        alignSource: 'template',
        alignedAt: 123,
        overlays: [],
    };

    const first = Derivation.prepareDerivedTask(clone(template));
    const second = Derivation.prepareDerivedTask(clone(template));

    assert.notEqual(first.id, template.id);
    assert.notEqual(second.id, template.id);
    assert.notEqual(first.id, second.id);
    assert.equal(first.srtPath, null);
    assert.equal(first.txtPath, null);
    assert.deepEqual(first.segments, []);
    assert.equal(first.txtContent, '');
    assert.equal(first.ttsText, '');
    assert.equal(first.aiScript, '');
    assert.equal(first.manualText, '');
    assert.equal(first.aligned, false);
    assert.equal(first.alignSource, '');
});

test('derived overlay IDs are unique while internal bindings and visual order are remapped', () => {
    const template = {
        id: 'template-task',
        overlays: [
            { id: 'scroll-template', type: 'scroll', content: 'scroll text' },
            { id: 'image-template', type: 'image', bind_scroll_overlay_id: 'scroll-template' },
        ],
        visualOverlayOrder: ['overlay:scroll-template', 'overlay:image-template'],
        cover: {
            overlays: [{ id: 'cover-template', type: 'textcard', title_text: 'cover' }],
        },
    };

    const first = Derivation.prepareDerivedTask(clone(template), { clearContent: false });
    const second = Derivation.prepareDerivedTask(clone(template), { clearContent: false });
    const [firstScroll, firstImage] = first.overlays;
    const [secondScroll, secondImage] = second.overlays;

    assert.notEqual(firstScroll.id, secondScroll.id);
    assert.notEqual(firstImage.id, secondImage.id);
    assert.equal(firstScroll._templateOverlayId, 'scroll-template');
    assert.equal(firstImage._templateOverlayId, 'image-template');
    assert.equal(firstImage.bind_scroll_overlay_id, firstScroll.id);
    assert.equal(secondImage.bind_scroll_overlay_id, secondScroll.id);
    assert.deepEqual(first.visualOverlayOrder, [
        `overlay:${firstScroll.id}`,
        `overlay:${firstImage.id}`,
    ]);
    assert.notEqual(first.cover.overlays[0].id, second.cover.overlays[0].id);
});

test('a bound SRT replaces template segments immediately instead of keeping stale captions', () => {
    const task = {
        srtPath: '/old/template.srt',
        segments: [{ start: 0, end: 1, text: 'OLD TEMPLATE SUBTITLE' }],
        aligned: true,
    };
    const result = Derivation.bindSrt(task, '/new/row-2.srt', {
        readFileText: path => {
            assert.equal(path, '/new/row-2.srt');
            return '1\n00:00:00,000 --> 00:00:01,000\nROW TWO SUBTITLE\n';
        },
        parseSrt: content => {
            assert.match(content, /ROW TWO SUBTITLE/);
            return [{ start: 0, end: 1, text: 'ROW TWO SUBTITLE' }];
        },
        toWordSegments: segments => segments.map(segment => ({ ...segment, words: [] })),
    });

    assert.equal(result.ok, true);
    assert.equal(task.srtPath, '/new/row-2.srt');
    assert.equal(task.aligned, true);
    assert.deepEqual(task.segments, [{
        start: 0,
        end: 1,
        text: 'ROW TWO SUBTITLE',
        _timeUnit: 'sec',
        words: [],
    }]);
});

test('an unreadable bound SRT cannot silently export with template captions', () => {
    const task = {
        segments: [{ start: 0, end: 1, text: 'OLD TEMPLATE SUBTITLE' }],
        aligned: true,
        _exportSelected: true,
    };
    const result = Derivation.bindSrt(task, '/missing.srt', {
        readFileText: () => '',
        parseSrt: () => [],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(task.segments, []);
    assert.equal(task.aligned, false);
    assert.equal(task._exportSelected, false);
    assert.match(task._bulkCreateSrtError, /missing\.srt/);
});

test('a later overlay instance reconnects bindings through its stable template slot', () => {
    const image = {
        id: Derivation.createId('ov'),
        type: 'image',
        _templateOverlayId: 'image-template',
        _bindScrollTemplateOverlayId: 'scroll-template',
        bind_scroll_overlay_id: null,
    };
    const scroll = Derivation.cloneOverlay({ id: 'scroll-template', type: 'scroll' });
    const task = { overlays: [image, scroll] };

    Derivation.resolveOverlayBindings(task);

    assert.equal(scroll._templateOverlayId, 'scroll-template');
    assert.equal(image.bind_scroll_overlay_id, scroll.id);
});

test('a task derived from another derived task still matches the original template layer slot', () => {
    const original = { id: 'template-card', type: 'textcard' };
    const firstGeneration = Derivation.cloneOverlay(original);
    const secondGeneration = Derivation.cloneOverlay(firstGeneration);

    assert.notEqual(firstGeneration.id, secondGeneration.id);
    assert.equal(firstGeneration._templateOverlayId, 'template-card');
    assert.equal(secondGeneration._templateOverlayId, 'template-card');
    assert.equal(
        Derivation.overlayMatchesTemplateSlot(secondGeneration, firstGeneration.id, [firstGeneration]),
        true
    );
});
