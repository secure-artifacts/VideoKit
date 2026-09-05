const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveEntry } = require('../electron/services/autoEditBatchProject');
test('batch recovery is durable per completion and upserts without copying assets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-project-test-'));
    const file = path.join(dir, 'test.autoedit-batch.json');
    try {
        saveEntry(file, { id: '/a.mp4', order: 0, name: 'A' });
        assert.equal(JSON.parse(fs.readFileSync(file)).tasks.length, 1);
        saveEntry(file, { id: '/b.mp4', order: 1, name: 'B' });
        saveEntry(file, { id: '/a.mp4', order: 0, name: 'updated' });
        const result = JSON.parse(fs.readFileSync(file));
        assert.equal(result.tasks.length, 2);
        assert.equal(result.tasks[0].name, 'updated');
        assert.deepEqual(fs.readdirSync(dir), ['test.autoedit-batch.json']);
        assert.throws(() => saveEntry(file, {}));
        assert.equal(JSON.parse(fs.readFileSync(file)).tasks.length, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
