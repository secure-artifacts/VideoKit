const test = require('node:test');
const assert = require('node:assert/strict');

const {
    subtitleStyleFingerprint,
    prepareSubtitlePresetBatchImport,
} = require('../src/reels-style-engine.js');

test('preset fingerprint treats compact and expanded equivalent styles as duplicates', () => {
    assert.equal(
        subtitleStyleFingerprint({ fontsize: 56, color_text: '#fff' }),
        subtitleStyleFingerprint({ color_text: '#fff', fontsize: 56 })
    );
    assert.notEqual(
        subtitleStyleFingerprint({ fontsize: 56 }),
        subtitleStyleFingerprint({ fontsize: 57 })
    );
});

test('batch preset import deduplicates across files and existing presets', () => {
    const prepared = prepareSubtitlePresetBatchImport([
        {
            source: 'a.json',
            data: {
                default: { fontsize: 44 },
                presets: {
                    NewBlue: { fontsize: 60, color_text: '#00f' },
                    ExistingSame: { fontsize: 50, color_text: '#fff' },
                    ExistingChanged: { fontsize: 70, color_text: '#f00' },
                },
            },
        },
        {
            source: 'b.json',
            data: {
                presets: {
                    SameContentDifferentName: { color_text: '#00f', fontsize: 60 },
                    NewBlue: { fontsize: 61, color_text: '#00f' },
                    Unique: { fontsize: 48, color_text: '#0f0' },
                },
            },
        },
    ], {
        ExistingSame: { color_text: '#fff', fontsize: 50 },
        ExistingChanged: { fontsize: 40, color_text: '#f00' },
    });

    assert.deepEqual(Object.keys(prepared.payload.presets), ['NewBlue', 'ExistingChanged', 'Unique']);
    assert.equal(prepared.payload.default.fontsize, 44);
    assert.deepEqual(prepared.conflicts, ['ExistingChanged']);
    assert.deepEqual(prepared.batchConflicts, ['NewBlue']);
    assert.deepEqual(prepared.duplicates.sort(), ['ExistingSame', 'SameContentDifferentName'].sort());
    assert.deepEqual(prepared.invalid, []);
});

test('batch preset import reports invalid bundles without blocking valid ones', () => {
    const prepared = prepareSubtitlePresetBatchImport([
        { source: 'broken.json', data: { nope: true } },
        { source: 'valid.json', data: { presets: { Good: { fontsize: 42 } } } },
    ]);

    assert.deepEqual(Object.keys(prepared.payload.presets), ['Good']);
    assert.deepEqual(prepared.invalid, ['broken.json']);
});

test('same-name change is deduplicated when its content already exists under another name', () => {
    const prepared = prepareSubtitlePresetBatchImport([
        {
            source: 'presets.json',
            data: { presets: { RenameMe: { fontsize: 72 } } },
        },
    ], {
        RenameMe: { fontsize: 40 },
        AlreadyHere: { fontsize: 72 },
    });

    assert.deepEqual(prepared.payload.presets, {});
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.duplicates, ['RenameMe']);
});
