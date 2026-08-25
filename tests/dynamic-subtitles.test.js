const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createFusionPackage } = require('../electron/services/davinciFusionExport.js');
const {
    ReelsCanvasRenderer,
    getSubtitleLayoutMaxScale,
    getTopBaselineGlyphBounds,
    getAmbientGlowCompositeOperation,
} = require('../src/reels-canvas-renderer.js');
const ReelsAnimEngine = require('../src/reels-anim-engine.js');
global.ReelsAnimEngine = ReelsAnimEngine;
const ReelsExportEngine = require('../src/reels-export-engine.js');

test('inactive animation settings do not inflate subtitle wrapping or box height', () => {
    const styleWithAllAnimationDefaults = {
        anim_in_type: 'fade',
        word_pop_random_max_scale: 1.34,
        word_pop_random_pulse_max_scale: 1.38,
        letter_jump_scale: 1.5,
    };
    assert.equal(getSubtitleLayoutMaxScale(styleWithAllAnimationDefaults), 1);
});

test('selected scale animation still reserves its configured layout scale', () => {
    assert.equal(getSubtitleLayoutMaxScale({ anim_in_type: 'letter_jump', letter_jump_scale: 1.5 }), 1.5);
    assert.equal(getSubtitleLayoutMaxScale({ anim_in_type: 'word_pop_random', word_pop_random_max_scale: 1.34 }), 1.34);
    assert.equal(getSubtitleLayoutMaxScale({ anim_in_type: 'word_pop_random_pulse', word_pop_random_pulse_max_scale: 1.38 }), 1.38);
});

test('zero vertical padding can fit the box to actual glyph bounds', () => {
    const bounds = getTopBaselineGlyphBounds({
        actualBoundingBoxAscent: -6,
        actualBoundingBoxDescent: 90,
    }, 80, 96);
    assert.deepEqual(bounds, { top: 6, bottom: 90, height: 84 });
    assert.ok(bounds.height < 96, 'unused font line-height must not remain inside a zero-padding box');
});

test('glyph-bound fallback preserves legacy line height on unsupported canvases', () => {
    assert.deepEqual(getTopBaselineGlyphBounds({}, 80, 96), { top: 0, bottom: 96, height: 96 });
});

test('ambient-glow blend selection maps to a Canvas operation for preview and MP4 export', () => {
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'lighter' }), 'lighter');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'screen' }), 'screen');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'soft-light' }), 'soft-light');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'overlay' }), 'overlay');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'source-over' }), 'source-over');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'linear-dodge' }), 'lighter');
    assert.equal(getAmbientGlowCompositeOperation({ ambient_glow_blend_mode: 'unsupported-mode' }), 'lighter');
});

test('DaVinci Fusion cues preserve per-segment style overrides', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-fusion-test-'));
    const dummyFcpxml = path.join(tmpDir, 'test.fcpxml');
    fs.writeFileSync(dummyFcpxml, '<fcpxml></fcpxml>', 'utf8');

    const tasks = [
        {
            task: {
                subtitleStyle: {
                    color_text: '#FFFFFF',
                    fontsize: 74,
                }
            },
            segments: [
                {
                    start: 0,
                    end: 2,
                    text: 'Title Segment',
                    style_override: {
                        color_text: '#FFD700',
                        fontsize: 90,
                    }
                },
                {
                    start: 2,
                    end: 4,
                    text: 'Body Segment',
                }
            ]
        }
    ];

    const pkg = createFusionPackage({
        outputDir: tmpDir,
        taskName: 'test_task',
        fcpxmlPath: dummyFcpxml,
        tasks,
        fps: 30,
        rebuildMediaTimeline: false,
    });

    const manifest = JSON.parse(fs.readFileSync(pkg.manifest_path, 'utf8'));
    assert.equal(manifest.fusion_cues.length, 2);
    // Segment 1 has style_override
    assert.equal(manifest.fusion_cues[0].style.color_text, '#FFD700');
    assert.equal(manifest.fusion_cues[0].style.fontsize, 90);
    // Segment 2 uses default task subtitleStyle
    assert.equal(manifest.fusion_cues[1].style.color_text, '#FFFFFF');
    assert.equal(manifest.fusion_cues[1].style.fontsize, 74);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('ReelsExportEngine escapes brackets and parentheses in ASS filter paths', () => {
    const args = ReelsExportEngine.buildSubtitleBurnCommand({
        videoPath: '/path/to/video.mp4',
        assPath: '/path/to/[Special] (Folder) Subtitle.ass',
        outputPath: '/path/to/output.mp4',
    });

    const vfArg = args[args.indexOf('-vf') + 1];
    assert.ok(vfArg.includes('\\[Special\\]'));
    assert.ok(vfArg.includes('\\(Folder\\)'));
});

test('ReelsCanvasRenderer _renderScatterPop handles missing fontsize without NaN', () => {
    let recordedFont = '';
    const fakeCtx = {
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        fillText() {},
        strokeText() {},
        stroke() {},
        fill() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        rect() {},
        measureText(text) { return { width: (text || '').length * 10 }; },
        set font(val) { recordedFont = val; },
        get font() { return recordedFont; },
        set textBaseline(val) {},
        set direction(val) {},
        set textAlign(val) {},
        set fillStyle(val) {},
        set strokeStyle(val) {},
        set lineWidth(val) {},
        set globalAlpha(val) {},
        set shadowBlur(val) {},
        set shadowColor(val) {},
        set shadowOffsetX(val) {},
        set shadowOffsetY(val) {},
    };

    const renderer = new ReelsCanvasRenderer({ getContext: () => fakeCtx });
    const segment = {
        start: 0,
        end: 2,
        text: 'hello world',
        words: [
            { word: 'hello', start: 0, end: 1 },
            { word: 'world', start: 1, end: 2 }
        ]
    };

    // Style without fontsize
    const style = {
        font_family: 'Arial',
        use_box: false,
    };

    // Should not throw and font should not contain NaN
    renderer._renderScatterPop(style, segment, 0.5, 1080, 1920);
    assert.ok(recordedFont.length > 0);
    assert.ok(!recordedFont.includes('NaN'));
});

test('ReelsAnimEngine computeSlideOffset moves in correct directions for entry and exit', () => {
    // Entrance: starts at distance and settles to 0
    const [inUpX, inUpY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_up', 60, false);
    assert.equal(inUpY, 60); // Starts below (+60), slides up to 0

    const [inDownX, inDownY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_down', 60, false);
    assert.equal(inDownY, -60); // Starts above (-60), slides down to 0

    const [inLeftX, inLeftY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_left', 60, false);
    assert.equal(inLeftX, 60); // Starts right (+60), slides left to 0

    const [inRightX, inRightY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_right', 60, false);
    assert.equal(inRightX, -60); // Starts left (-60), slides right to 0

    // Exit: starts at 0 and moves off-screen towards specified direction
    const [outUpX, outUpY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_up', 60, true);
    assert.equal(outUpY, -60); // Slides UP off-screen (-60)

    const [outDownX, outDownY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_down', 60, true);
    assert.equal(outDownY, 60); // Slides DOWN off-screen (+60)

    const [outLeftX, outLeftY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_left', 60, true);
    assert.equal(outLeftX, -60); // Slides LEFT off-screen (-60)

    const [outRightX, outRightY] = ReelsAnimEngine.computeSlideOffset(0.0, 'slide_right', 60, true);
    assert.equal(outRightX, 60); // Slides RIGHT off-screen (+60)
});

test('ReelsCanvasRenderer executes animations even when segment has no pre-computed word timestamps', () => {
    const translates = [];
    const scales = [];
    const strokes = [];
    const fakeCtx = {
        save() {},
        restore() {},
        translate(x, y) { translates.push([x, y]); },
        rotate() {},
        scale(x, y) { scales.push([x, y]); },
        fillText() {},
        strokeText(text, x, y) { strokes.push({ text, x, y }); },
        stroke() {},
        fill() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        quadraticCurveTo() {},
        bezierCurveTo() {},
        arc() {},
        rect() {},
        measureText(text) { return { width: (text || '').length * 20 }; },
        font: '700 74px Arial',
        set textBaseline(val) {},
        set direction(val) {},
        set textAlign(val) {},
        set fillStyle(val) {},
        set strokeStyle(val) {},
        set lineWidth(val) {},
        set globalAlpha(val) {},
        set shadowBlur(val) {},
        set shadowColor(val) {},
        set shadowOffsetX(val) {},
        set shadowOffsetY(val) {},
    };

    const renderer = new ReelsCanvasRenderer({ getContext: () => fakeCtx });

    // Segment without words property (plain SRT / manual text)
    const segment = {
        start: 0,
        end: 2,
        text: 'HELLO WORLD',
    };

    // char_bounce should produce vertical offsets
    renderer.renderSubtitle({
        anim_in_type: 'char_bounce',
        char_bounce_height: 20,
        fontsize: 74,
    }, segment, 0.1, 1080, 1920);

    // Letter jump should scale the active word
    renderer.renderSubtitle({
        anim_in_type: 'letter_jump',
        letter_jump_scale: 1.5,
        fontsize: 74,
    }, segment, 0.05, 1080, 1920);

    assert.ok(scales.some(([sx, sy]) => sx > 1.0));
});

test('ReelsFontManager collectFonts extracts all fonts across subtitles, segments, overlays, and watermarks', () => {
    const { ReelsFontManager } = require('../src/reels-font-manager.js');
    const fm = new ReelsFontManager();

    const style = { font_family: 'Outfit' };
    const segments = [
        {
            text: 'Sentence 1',
            style_override: { font_family: 'Montserrat' },
        },
        {
            text: 'Sentence 2',
            styled_ranges: [
                { start: 0, end: 4, font_family: 'Anton' }
            ]
        }
    ];
    const overlays = [
        { type: 'text', font_family: 'Bebas Neue' },
        { type: 'textcard', title_font_family: 'Cinzel', body_font_family: 'Lato', footer_font_family: 'Roboto' }
    ];
    const watermarks = [
        { type: 'text', font_family: 'Open Sans' }
    ];
    const cover = {
        enabled: true,
        overlays: [
            { type: 'text', font_family: 'Pacifico' }
        ]
    };

    const fonts = fm.collectFonts({ style, segments, overlays, watermarks, cover });
    assert.ok(fonts.includes('Outfit'));
    assert.ok(fonts.includes('Montserrat'));
    assert.ok(fonts.includes('Anton'));
    assert.ok(fonts.includes('Bebas Neue'));
    assert.ok(fonts.includes('Cinzel'));
    assert.ok(fonts.includes('Lato'));
    assert.ok(fonts.includes('Roboto'));
    assert.ok(fonts.includes('Open Sans'));
    assert.ok(fonts.includes('Pacifico'));
    assert.equal(fonts.length, 9);
});
