const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const archiver = require('archiver');
const extract = require('extract-zip');

function sourcePath(value) {
    if (typeof value !== 'string' || value.startsWith('data:')) return '';
    try { return value.startsWith('file:') ? fileURLToPath(value) : (path.isAbsolute(value) ? value : ''); } catch (_) { return ''; }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

async function exportPackage({ presets, outputPath }) {
    const copied = new Map(), missing = [], packaged = clone(presets || {});
    for (const preset of Object.values(packaged)) for (const layer of (preset?.layers || [])) {
        const source = sourcePath(layer?.content);
        if (!source) continue;
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) { missing.push(source); continue; }
        let asset = copied.get(source);
        if (!asset) {
            const ext = path.extname(source);
            const name = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
            asset = `assets/${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}_${name}${ext}`;
            copied.set(source, asset);
        }
        layer.content = asset;
    }
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(outputPath);
        const zip = archiver('zip', { zlib: { level: 6 } });
        out.on('close', resolve); out.on('error', reject); zip.on('error', reject);
        zip.pipe(out);
        zip.append(JSON.stringify({ format: 'videokit-overlay-preset-package', version: 1, presets: packaged, missingMedia: missing }, null, 2), { name: 'manifest.json' });
        for (const [source, asset] of copied) zip.file(source, { name: asset });
        zip.finalize();
    });
    return { copied: copied.size, missing };
}

async function importPackage({ packagePath, destinationDir }) {
    const target = path.join(destinationDir, `overlay-package-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    await extract(packagePath, { dir: target });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(target, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 'videokit-overlay-preset-package' || !manifest.presets || typeof manifest.presets !== 'object') throw new Error('不是有效的 VideoKit 覆层预设包');
    const assetsRoot = path.resolve(target, 'assets') + path.sep;
    for (const preset of Object.values(manifest.presets)) for (const layer of (preset?.layers || [])) {
        if (typeof layer?.content !== 'string' || !layer.content.startsWith('assets/')) continue;
        const assetPath = path.resolve(target, layer.content);
        if (!assetPath.startsWith(assetsRoot) || !fs.existsSync(assetPath)) throw new Error(`预设包中的媒体文件缺失：${layer.content}`);
        layer.content = pathToFileURL(assetPath).href;
    }
    return { presets: manifest.presets, assetDir: target, missing: manifest.missingMedia || [] };
}

async function savePresetAssets({ preset, destinationDir }) {
    const saved = clone(preset);
    const assetDir = path.join(destinationDir, `saved-overlay-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`, 'assets');
    let copied = 0;
    const missing = [];
    for (const [index, layer] of (saved.layers || []).entries()) {
        if (!['image', 'video', 'audio'].includes(layer?.type)) continue;
        const source = sourcePath(layer?.content);
        // data: URL 已直接存入预设，不需要额外复制。其余媒体必须能被解析为
        // 本机文件；过去这里静默跳过，UI 却仍提示“已复制”，导致跨任务加载失效。
        if (typeof layer?.content === 'string' && layer.content.startsWith('data:')) continue;
        if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
            missing.push(`第 ${index + 1} 层${layer?.name ? `（${layer.name}）` : ''}：${String(layer?.content || '未指定文件')}`);
            continue;
        }
        await fs.promises.mkdir(assetDir, { recursive: true });
        const ext = path.extname(source), stem = path.basename(source, ext).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'media';
        const target = path.join(assetDir, `${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}_${stem}${ext}`);
        await fs.promises.copyFile(source, target);
        layer.content = pathToFileURL(target).href;
        copied++;
    }
    if (missing.length) {
        throw new Error(`以下媒体无法复制到预设库，请确认原文件仍存在：\n${missing.join('\n')}`);
    }
    saved.meta = { ...(saved.meta || {}), mediaStorage: copied ? 'packaged' : 'linked', packagedMediaCount: copied };
    return { preset: saved, copied };
}

module.exports = { exportPackage, importPackage, savePresetAssets };
