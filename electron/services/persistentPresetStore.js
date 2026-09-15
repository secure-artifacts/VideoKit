/**
 * Durable user-preset storage.
 *
 * Renderer localStorage is convenient for the UI, but it is tied to Chromium's
 * page origin.  This copy lives alongside the template library so a rebuilt or
 * moved desktop app can restore the user's presets before the UI starts.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_NAME = 'local-storage-presets.json';
const MAX_BYTES = 48 * 1024 * 1024;

function getPresetLibraryDir() {
    const dir = path.join(app.getPath('userData'), 'videokit-presets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getPresetFilePath() {
    return path.join(getPresetLibraryDir(), FILE_NAME);
}

function readSnapshot() {
    try {
        const raw = fs.readFileSync(getPresetFilePath(), 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.values === 'object' ? parsed.values : {};
    } catch (_) {
        return {};
    }
}

function sanitize(values) {
    const result = {};
    if (!values || typeof values !== 'object') return result;
    for (const [key, value] of Object.entries(values)) {
        if (typeof key === 'string' && key.length <= 200 && typeof value === 'string') result[key] = value;
    }
    return result;
}

// Most UI storage values are JSON maps, for example
// { "我的样式": {...}, "另一个样式": {...} }. Merge those maps recursively so
// a development build and a packaged build can contribute separate presets.
// For a genuinely identical name with different content, the currently opened
// app wins: that is the only side the user can see and deliberately edit.
function mergeValue(storedValue, currentValue) {
    if (storedValue === currentValue) return storedValue;
    let stored;
    let current;
    try { stored = JSON.parse(storedValue); current = JSON.parse(currentValue); } catch (_) { return currentValue; }
    if (!stored || !current || Array.isArray(stored) || Array.isArray(current)
        || typeof stored !== 'object' || typeof current !== 'object') return currentValue;
    const mergeObject = (older, newer) => {
        const result = { ...older };
        for (const [key, value] of Object.entries(newer)) {
            const oldValue = result[key];
            if (oldValue && value && !Array.isArray(oldValue) && !Array.isArray(value)
                && typeof oldValue === 'object' && typeof value === 'object') {
                result[key] = mergeObject(oldValue, value);
            } else {
                result[key] = value;
            }
        }
        return result;
    };
    return JSON.stringify(mergeObject(stored, current));
}

function mergeSnapshots(storedValues, currentValues) {
    const result = { ...sanitize(storedValues) };
    for (const [key, value] of Object.entries(sanitize(currentValues))) {
        result[key] = Object.prototype.hasOwnProperty.call(result, key)
            ? mergeValue(result[key], value)
            : value;
    }
    return result;
}

function writeSnapshot(values) {
    const safeValues = sanitize(values);
    const filePath = getPresetFilePath();
    const body = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), values: safeValues }, null, 2);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw new Error('预设库文件过大，未保存');
    const backupPath = `${filePath}.bak`;
    const tempPath = `${filePath}.${process.pid}.tmp`;
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(tempPath, body, 'utf8');
    fs.renameSync(tempPath, filePath);
    return { count: Object.keys(safeValues).length, path: filePath };
}

// Keep existing durable data on conflict. It is the cross-package source of
// truth; browser storage merely seeds it on the first upgraded launch.
function hydrate(currentValues) {
    const current = sanitize(currentValues);
    const stored = readSnapshot();
    const merged = mergeSnapshots(stored, current);
    if (Object.keys(merged).length && JSON.stringify(merged) !== JSON.stringify(stored)) writeSnapshot(merged);
    return merged;
}

module.exports = { getPresetFilePath, hydrate, writeSnapshot, mergeSnapshots };
