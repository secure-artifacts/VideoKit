const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end);
}
test('reanalysis preserves assignment by source and remaps replacement', () => {
    const context = { normalizeAutoEditReviewText: text => String(text).trim() };
    vm.createContext(context);
    vm.runInContext(extract('restoreAutoEditMissingBlockAssignments'), context);
    const previous = { segments: [{ source: '/a.mp4', source_index: 1 }], missing_blocks: [{ startLine: 2, endLine: 2, text: 'hello', review_assignment: { targets: [{ source_index: 1, script_before: 'before' }] } }] };
    const data = { segments: [{ source: '/b.mp4', source_index: 3 }], missing_blocks: [{ startLine: 2, endLine: 2, text: 'hello' }] };
    context.restoreAutoEditMissingBlockAssignments(data, previous, ['/a.mp4', '/b.mp4']);
    assert.equal(data.missing_blocks[0].review_assignment.targets[0].source_index, 3);
    assert.equal(data.missing_blocks[0].review_assignment.targets[0].script_before, 'before');
    const changed = { segments: data.segments, missing_blocks: [{ startLine: 2, endLine: 2, text: 'different' }] };
    context.restoreAutoEditMissingBlockAssignments(changed, previous, ['/a.mp4', '/b.mp4']);
    assert.equal(changed.missing_blocks[0].review_assignment, undefined);
});
test('leaving hovered video keeps group muted at four times speed', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(extract('visualReviewStop'), context);
    const video = { closest: () => ({}), playbackRate: 2, muted: false, pause() { throw Error('group must keep playing'); } };
    context.visualReviewStop(video);
    assert.equal(video.playbackRate, 4);
    assert.equal(video.muted, true);
});
test('hover restarts only the pointed video and uses its separate audio rate', () => {
    const other = { currentTime: 12, muted: false, playbackRate: 2 };
    const video = { currentTime: 8, closest: () => ({ querySelectorAll: () => [other, video] }) };
    const context = { visualReviewState: { hoverRate: 2, hoverAudio: true }, visualReviewEnsureVideo() {},
        visualReviewPlay(item, rate, audio) { item.playbackRate = rate; item.muted = !audio; } };
    vm.createContext(context); vm.runInContext(extract('visualReviewHoverPlay'), context);
    context.visualReviewHoverPlay(video);
    assert.equal(video.currentTime, 0); assert.equal(video.playbackRate, 2); assert.equal(video.muted, false);
    assert.equal(other.currentTime, 12); assert.equal(other.playbackRate, 4); assert.equal(other.muted, true);
});
test('acknowledged and excluded reviews survive reanalysis without modified flag', () => {
    const context = {}; vm.createContext(context);
    vm.runInContext(extract('hasAutoEditHumanReview'), context);
    for (const segment of [{ review_acknowledged: true }, { enabled: false }, { is_hook: true },
        { needs_replacement: true }, { missing_confirmed_for: 'confirmed script' }]) {
        assert.equal(context.hasAutoEditHumanReview(segment), true);
    }
    assert.equal(context.hasAutoEditHumanReview({}), false);
    assert.equal(context.hasAutoEditHumanReview({ needs_replacement: false, missing_confirmed_for: '' }), false);
    assert.equal(context.hasAutoEditHumanReview(null), false);
});
test('hook audio changes invalidate batch export reuse', () => {
    const context = {}; vm.createContext(context);
    vm.runInContext(extract('autoEditBatchExportSignature'), context);
    const task = { reviewSegments: [{ source: '/a.mp4', is_hook: true, hook_keep_audio: true }] };
    const before = context.autoEditBatchExportSignature(task);
    task.reviewSegments[0].hook_keep_audio = false;
    assert.notEqual(context.autoEditBatchExportSignature(task), before);
});
test('silent preview setting survives snapshots and saved sessions', () => {
    const context = { visualReviewState: { groupHoverPreview: false } }; vm.createContext(context);
    vm.runInContext(extract('visualReviewStateSnapshot') + '\n' + extract('visualReviewSessionData'), context);
    assert.equal(context.visualReviewStateSnapshot().groupHoverPreview, false);
    assert.equal(context.visualReviewSessionData().groupHoverPreview, false);
});
test('report keeps assigned text between its original clips, including exported tasks', () => {
    const context = { escapeHtml: text => String(text), getAutoEditBatchMatchSummary: () => ({ total: 2, ready: 2, warning: 0, error: 0, missingBlocks: 0 }) };
    vm.createContext(context); vm.runInContext(extract('renderAutoEditBatchMatchResult'), context);
    const html = context.renderAutoEditBatchMatchResult({ result: { analysis_only: false, segments: [
        { source: '/first.mp4', source_index: 1, status: 'ready' },
        { source: '/second.mp4', source_index: 2, status: 'warning', review_acknowledged: true }
    ], missing_blocks: [{ text: 'assigned text', startLine: 2, endLine: 2, previous_source_index: 1, next_source_index: 2, review_assignment: { targets: [] } }] } });
    assert.match(html, /已归属（审核页可撤销）/);
    assert.match(html, /已处理（审核页可撤销）/);
    assert.ok(html.indexOf('first.mp4') < html.indexOf('assigned text'));
    assert.ok(html.indexOf('assigned text') < html.indexOf('second.mp4'));
});
test('workspace save failure leaves persistent warning and successful retry clears it', () => {
    let warning; let fail = true;
    const context = { autoEditWorkspaces: [{}], autoEditWorkspaceIndex: 0, captureAutoEditWorkspace: () => ({ files: [] }),
        localStorage: { setItem() { if (fail) throw Error('quota'); } }, console: { warn() {} }, showToast() {},
        document: { getElementById(id) { return id === 'autoedit-workspace-tabs' ? { after(node) { warning = node; } } : warning; },
            createElement() { return { style: {}, setAttribute() {}, remove() { warning = undefined; } }; } } };
    vm.createContext(context); vm.runInContext(extract('saveAutoEditWorkspaceState'), context);
    assert.equal(context.saveAutoEditWorkspaceState(), false);
    assert.match(warning.textContent, /保存失败/);
    fail = false; assert.equal(context.saveAutoEditWorkspaceState(), true); assert.equal(warning, undefined);
});
test('post-render batch sync cannot restore old replacement cuts a second time', () => {
    const start = source.indexOf('            task.reviewSegments = (data.review_segments || data.segments || [])');
    assert.ok(start > 0);
    assert.doesNotMatch(source.slice(start, source.indexOf('            task.result = data;', start)), /savedBySource|saved\.start/);
});
test('visual report groups suites and preserves missing group order', () => {
    const context = { visualReviewState: { statuses: { '/a': 'pass' }, suites: [
        { key: '套 A', groups: [{ key: '片段 1', files: [{ path: '/a', name: 'a.mp4' }] }, { key: '片段 2', files: [] }] },
        { key: '套 B', groups: [{ key: '片段 1', files: [] }] }
    ] } };
    vm.createContext(context); vm.runInContext(extract('visualReviewCurrentReportText'), context);
    const report = context.visualReviewCurrentReportText();
    assert.equal(report.suites.length, 2); assert.equal(report.suites[0].missing, 1);
    assert.ok(report.text.indexOf('【套 A】') < report.text.indexOf('【套 B】'));
    assert.ok(report.text.indexOf('片段 2') < report.text.indexOf('【套 B】'));
});
test('original preview stops card playback and requests an independent 1x player', () => {
    let args; const card = { muted: false, pause() { this.paused = true; } };
    const group = { dataset: { groupPlaying: 'true' } };
    const context = { document: { querySelectorAll(selector) { return selector.includes('group-playing') ? [group] : [card]; } },
        window: { playVideoClip(...values) { args = values; } } };
    vm.createContext(context); vm.runInContext(extract('visualReviewOpenOriginalPreview'), context);
    context.visualReviewOpenOriginalPreview({ dataset: { src: 'file:///a.mp4' } });
    assert.equal(args[0], 'file:///a.mp4'); assert.equal(args[5], 1);
    assert.equal(card.paused, true); assert.equal(card.muted, true); assert.equal(group.dataset.groupPlaying, '');
});
test('group highlight stylesheet loads during ordinary review rendering', () => {
    const render = extract('visualReviewRender');
    assert.match(render, /visualReviewEnsureStyles\(\)/);
    assert.ok(render.indexOf('visualReviewEnsureStyles()') < render.indexOf('const tabBar'));
    assert.match(extract('visualReviewEnsureStyles'), /\.vr-group-has-pass/);
});
