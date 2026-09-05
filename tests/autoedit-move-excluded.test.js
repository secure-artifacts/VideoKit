const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { routeAPI } = require('../electron/apiRouter');

test('media/move-clip-to-excluded moves clip to 已排除素材 and restore moves it back', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-move-test-'));
    try {
        const testFile = path.join(tmpDir, 'clip_01.mp4');
        fs.writeFileSync(testFile, 'test video content');

        // 1. Move to excluded
        const moveRes = await routeAPI('media/move-clip-to-excluded', { filePath: testFile, folderName: '已排除素材' });
        assert.equal(moveRes.success, true);
        assert.equal(fs.existsSync(testFile), false, 'Original file should no longer exist in parent dir');
        assert.equal(fs.existsSync(moveRes.newPath), true, 'File should exist in 已排除素材');
        assert.match(moveRes.newPath, /已排除素材[/\\]clip_01\.mp4$/);

        // 2. Move another file with same name to test collision avoidance
        const testFileDuplicate = path.join(tmpDir, 'clip_01.mp4');
        fs.writeFileSync(testFileDuplicate, 'another video with same name');
        const moveRes2 = await routeAPI('media/move-clip-to-excluded', { filePath: testFileDuplicate, folderName: '已排除素材' });
        assert.equal(moveRes2.success, true);
        assert.notEqual(moveRes2.newPath, moveRes.newPath, 'Should generate distinct filename on collision');
        assert.equal(fs.existsSync(moveRes2.newPath), true);

        // 3. Restore first file
        const restoreRes = await routeAPI('media/restore-clip-from-excluded', { filePath: moveRes.newPath });
        assert.equal(restoreRes.success, true);
        assert.equal(fs.existsSync(moveRes.newPath), false, 'Excluded file should be moved out');
        assert.equal(fs.existsSync(restoreRes.newPath), true, 'Restored file should exist in parent dir');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
