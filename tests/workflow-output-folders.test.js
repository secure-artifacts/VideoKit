const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveWorkflowOutputGroups,
    appendWorkflowGroupToTaskPrefix,
} = require('../electron/services/workflow');

test('workflow account folders are nested below each content-type folder', () => {
    const root = path.join(path.sep, 'exports', 'batch');
    const groups = resolveWorkflowOutputGroups(root, '01-task', '账号 A');

    assert.equal(groups.videoGroup, path.join(root, '_视频文案', '账号 A'));
    assert.equal(groups.audioGroup, path.join(root, '_音频字幕', '账号 A'));
    assert.equal(groups.metadataGroup, path.join(root, '_metadata', '账号 A', '01-task'));
});

test('workflow without an account keeps the shared content-type folders', () => {
    const root = path.join(path.sep, 'exports', 'batch');
    const groups = resolveWorkflowOutputGroups(root, '01-task');

    assert.equal(groups.videoGroup, path.join(root, '_视频文案'));
    assert.equal(groups.audioGroup, path.join(root, '_音频字幕'));
    assert.equal(groups.metadataGroup, path.join(root, '_metadata', '01-task'));
});

test('workflow account names are sanitized before creating folders', () => {
    const root = path.join(path.sep, 'exports', 'batch');
    const groups = resolveWorkflowOutputGroups(root, '01-task', ' account/A:* ');

    assert.equal(groups.safeGroupName, 'account_A__');
    assert.equal(groups.audioGroup, path.join(root, '_音频字幕', 'account_A__'));
});

test('workflow filenames include the account folder name', () => {
    assert.equal(
        appendWorkflowGroupToTaskPrefix('01-Your_son_needs_this_prayer_0801', '账号 A'),
        '01-账号 A_Your_son_needs_this_prayer_0801'
    );
    assert.equal(
        appendWorkflowGroupToTaskPrefix('01-Your_son_needs_this_prayer_0801', ''),
        '01-Your_son_needs_this_prayer_0801'
    );
});
