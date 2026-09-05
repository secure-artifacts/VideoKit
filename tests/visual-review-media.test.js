const test = require('node:test');
const assert = require('node:assert/strict');

function visualReviewIsImage(item) {
    return !item?.isDirectory && /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(item?.name || '');
}
function visualReviewIsVideo(item) {
    return !item?.isDirectory && /\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(item?.name || '');
}
function visualReviewIsSupportedMedia(item) {
    return visualReviewIsVideo(item) || visualReviewIsImage(item);
}

function visualReviewGroupKey(fileName) {
    const stem = String(fileName || '').replace(/\.[^.]+$/, '');
    const withoutCopySuffix = stem.replace(/(?:\s*\(\d+\))+$/u, '').trim();
    const mediaOrFrameSegment = withoutCopySuffix.match(/^.+?[_-](\d+)(?=[_-](?:素材|帧)(?:[_-].*)?$)/u);
    if (mediaOrFrameSegment) return `片段 ${Number(mediaOrFrameSegment[1])}`;
    const namedSegment = withoutCopySuffix.match(/^.+?[_-](\d+)$/u);
    if (namedSegment) return `片段 ${Number(namedSegment[1])}`;
    const numbered = withoutCopySuffix.match(/(?:^|[_\-\s])(\d+)[_\-\s](\d+)$/u);
    if (numbered) return `片段 ${Number(numbered[1])}`;
    const singleNumbered = withoutCopySuffix.match(/(?:^|[_\-\s])(\d+)$/u);
    if (singleNumbered) return `片段 ${Number(singleNumbered[1])}`;
    const strict = /(?:\s*[(_-]\s*(?:v(?:ersion)?\s*)?\d+\s*[)]?|\s*[-_]v\d+|\s*[-_]?副本\s*\d*)$/iu;
    return stem.replace(strict, '').trim() || stem;
}

function visualReviewSuiteKey(item) {
    const parts = String(item?.relativePath || item?.name || '').split(/[/\\]/).filter(Boolean);
    return parts.length > 1 ? parts[0] : '未分套';
}

function visualReviewBuildSuites(mediaList) {
    const suiteMap = new Map();
    mediaList.forEach(item => {
        const suiteKey = visualReviewSuiteKey(item);
        if (!suiteMap.has(suiteKey)) suiteMap.set(suiteKey, new Map());
        const groupMap = suiteMap.get(suiteKey);
        const key = visualReviewGroupKey(item.name);
        if (!groupMap.has(key)) groupMap.set(key, []);
        const isImg = visualReviewIsImage(item);
        groupMap.get(key).push({
            path: item.path,
            name: item.name,
            relativePath: item.relativePath || item.name,
            type: isImg ? 'image' : 'video'
        });
    });
    return [...suiteMap.entries()].map(([key, groupMap]) => ({
        key,
        groups: [...groupMap.entries()].map(([groupKey, files]) => ({
            key: groupKey,
            files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
        })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
    })).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

test('visualReview recognizes supported image and video formats', () => {
    const images = ['test.jpg', 'PHOTO.JPEG', 'card.png', 'banner.webp', 'anim.gif', 'pic.bmp', 'hero.avif', 'vector.svg'];
    const videos = ['clip.mp4', 'movie.mov', 'record.mkv', 'source.avi', 'web.webm', 'ios.m4v'];
    const nonMedia = ['subtitles.srt', 'notes.txt', 'config.json', 'script.js'];

    for (const name of images) {
        assert.equal(visualReviewIsImage({ name }), true, `${name} should be recognized as image`);
        assert.equal(visualReviewIsVideo({ name }), false, `${name} should not be recognized as video`);
        assert.equal(visualReviewIsSupportedMedia({ name }), true, `${name} should be supported media`);
    }

    for (const name of videos) {
        assert.equal(visualReviewIsImage({ name }), false, `${name} should not be recognized as image`);
        assert.equal(visualReviewIsVideo({ name }), true, `${name} should be recognized as video`);
        assert.equal(visualReviewIsSupportedMedia({ name }), true, `${name} should be supported media`);
    }

    for (const name of nonMedia) {
        assert.equal(visualReviewIsSupportedMedia({ name }), false, `${name} should not be supported media`);
    }

    assert.equal(visualReviewIsSupportedMedia({ name: 'folder.png', isDirectory: true }), false, 'Directories should be ignored');
});

test('visualReviewBuildSuites correctly groups images and sets media type', () => {
    const rawItems = [
        { path: '/suite1/1-1.png', name: '1-1.png', relativePath: '套1/1-1.png' },
        { path: '/suite1/1-2.jpg', name: '1-2.jpg', relativePath: '套1/1-2.jpg' },
        { path: '/suite1/2-1.webp', name: '2-1.webp', relativePath: '套1/2-1.webp' },
        { path: '/suite1/2-2.mp4', name: '2-2.mp4', relativePath: '套1/2-2.mp4' },
    ];

    const suites = visualReviewBuildSuites(rawItems);
    assert.equal(suites.length, 1);
    assert.equal(suites[0].key, '套1');
    assert.equal(suites[0].groups.length, 2);

    const group1 = suites[0].groups.find(g => g.key === '片段 1');
    assert.ok(group1);
    assert.equal(group1.files.length, 2);
    assert.equal(group1.files[0].type, 'image');
    assert.equal(group1.files[1].type, 'image');

    const group2 = suites[0].groups.find(g => g.key === '片段 2');
    assert.ok(group2);
    assert.equal(group2.files.length, 2);
    assert.equal(group2.files[0].type, 'image');
    assert.equal(group2.files[1].type, 'video');
});

function visualReviewFormatGroupBadge(passCount, usableCount) {
    const total = passCount + usableCount;
    if (total === 0) {
        return {
            text: '已选 0 个',
            style: 'display:inline-flex;align-items:center;padding:1px 8px;border-radius:12px;font-size:12px;color:#94a3b8;background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.25);'
        };
    }
    let detail = '';
    if (passCount > 0 && usableCount > 0) {
        detail = ` (${passCount}合格 · ${usableCount}勉强)`;
    } else if (passCount > 0) {
        detail = passCount > 1 ? ` (${passCount}合格)` : ' (合格)';
    } else {
        detail = usableCount > 1 ? ` (${usableCount}勉强)` : ' (勉强)';
    }
    const isPass = passCount > 0;
    const color = isPass ? '#4ade80' : '#facc15';
    const bg = isPass ? 'rgba(74,222,128,0.16)' : 'rgba(250,204,21,0.16)';
    const border = isPass ? 'rgba(74,222,128,0.35)' : 'rgba(250,204,21,0.35)';
    return {
        text: `已选 ${total} 个${detail}`,
        style: `display:inline-flex;align-items:center;padding:1px 8px;border-radius:12px;font-size:12px;font-weight:700;background:${bg};color:${color};border:1px solid ${border};`
    };
}

test('visualReviewFormatGroupBadge formats selection counts and labels accurately', () => {
    const badge0 = visualReviewFormatGroupBadge(0, 0);
    assert.equal(badge0.text, '已选 0 个');
    assert.match(badge0.style, /color:#94a3b8/);

    const badge1Pass = visualReviewFormatGroupBadge(1, 0);
    assert.equal(badge1Pass.text, '已选 1 个 (合格)');
    assert.match(badge1Pass.style, /color:#4ade80/);

    const badge1Usable = visualReviewFormatGroupBadge(0, 1);
    assert.equal(badge1Usable.text, '已选 1 个 (勉强)');
    assert.match(badge1Usable.style, /color:#facc15/);

    const badge2Pass = visualReviewFormatGroupBadge(2, 0);
    assert.equal(badge2Pass.text, '已选 2 个 (2合格)');
    assert.match(badge2Pass.style, /color:#4ade80/);

    const badgeMixed = visualReviewFormatGroupBadge(2, 1);
    assert.equal(badgeMixed.text, '已选 3 个 (2合格 · 1勉强)');
    assert.match(badgeMixed.style, /color:#4ade80/);
});

function generateBatchRenameFileName({
    file,
    globalIndex,
    folderIndex,
    folderName,
    components,
    separator = '_',
    findText = '',
    replaceText = '',
    isRegex = false,
    caseSensitive = true,
    caseMode = 'none'
}) {
    const ext = (file.name.match(/\.[^.]+$/) || [''])[0];
    let base = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

    let processedBase = base;
    if (findText) {
        if (isRegex) {
            try {
                const flags = (caseSensitive ? '' : 'i') + 'g';
                processedBase = processedBase.replace(new RegExp(findText, flags), replaceText);
            } catch (_) {}
        } else {
            if (caseSensitive) {
                processedBase = processedBase.split(findText).join(replaceText);
            } else {
                const escaped = findText.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                processedBase = processedBase.replace(new RegExp(escaped, 'gi'), replaceText);
            }
        }
    }

    const parts = [];
    for (const comp of components) {
        if (!comp.enabled) continue;
        let segment = '';
        if (comp.id === 'globalSeq') {
            const start = Number(comp.start ?? 1);
            const width = Math.max(1, Number(comp.width ?? 2));
            segment = String(start + globalIndex).padStart(width, '0');
        } else if (comp.id === 'folderName') {
            segment = folderName || '';
        } else if (comp.id === 'folderSeq') {
            const start = Number(comp.start ?? 1);
            const width = Math.max(1, Number(comp.width ?? 2));
            segment = String(start + folderIndex).padStart(width, '0');
        } else if (comp.id === 'origName') {
            segment = processedBase;
        } else if (comp.id === 'customText') {
            segment = comp.text || '';
        }
        if (segment !== '') {
            parts.push(segment);
        }
    }

    let finalBase = parts.join(separator);
    if (caseMode === 'lower') finalBase = finalBase.toLowerCase();
    else if (caseMode === 'upper') finalBase = finalBase.toUpperCase();

    return finalBase + ext;
}

test('generateBatchRenameFileName correctly handles dual sequences and reorderable components', () => {
    // 默认顺序: 序号 + 文件夹名字 + 序号规则2 + 原始名字 + 自定义内容
    const defaultComponents = [
        { id: 'globalSeq', name: '整体序号', enabled: true, start: 1, width: 3 },
        { id: 'folderName', name: '文件夹名字', enabled: true },
        { id: 'folderSeq', name: '文件夹内序号', enabled: true, start: 1, width: 2 },
        { id: 'origName', name: '原始名字', enabled: true },
        { id: 'customText', name: '自定义内容', enabled: true, text: '精选' }
    ];

    // 套1 的第 1 个文件
    const f1 = generateBatchRenameFileName({
        file: { name: 'photoA.jpg' },
        globalIndex: 0,
        folderIndex: 0,
        folderName: '套1',
        components: defaultComponents
    });
    assert.equal(f1, '001_套1_01_photoA_精选.jpg');

    // 套1 的第 2 个文件
    const f2 = generateBatchRenameFileName({
        file: { name: 'photoB.png' },
        globalIndex: 1,
        folderIndex: 1,
        folderName: '套1',
        components: defaultComponents
    });
    assert.equal(f2, '002_套1_02_photoB_精选.png');

    // 套2 的第 1 个文件：整体序号递增到 003，而本文件夹内序号重置回 01！
    const f3 = generateBatchRenameFileName({
        file: { name: 'photoC.webp' },
        globalIndex: 2,
        folderIndex: 0,
        folderName: '套2',
        components: defaultComponents
    });
    assert.equal(f3, '003_套2_01_photoC_精选.webp');

    // 测试顺序自由调换：文件夹名字 + 序号规则2 + 自定义内容 + 原始名字 (关闭整体序号)
    const reorderedComponents = [
        { id: 'folderName', name: '文件夹名字', enabled: true },
        { id: 'folderSeq', name: '文件夹内序号', enabled: true, start: 1, width: 2 },
        { id: 'customText', name: '自定义内容', enabled: true, text: '主图' },
        { id: 'origName', name: '原始名字', enabled: true },
        { id: 'globalSeq', name: '整体序号', enabled: false, start: 1, width: 3 }
    ];

    const fReordered = generateBatchRenameFileName({
        file: { name: 'camera1.mp4' },
        globalIndex: 5,
        folderIndex: 2,
        folderName: '第二套',
        components: reorderedComponents,
        separator: '-'
    });
    assert.equal(fReordered, '第二套-03-主图-camera1.mp4');

    // 测试字符串替换和大小写转换
    const fReplace = generateBatchRenameFileName({
        file: { name: 'OldPrefix_Test_V1.jpg' },
        globalIndex: 0,
        folderIndex: 0,
        folderName: 'Suite',
        components: [
            { id: 'origName', name: '原始名字', enabled: true },
            { id: 'customText', name: '自定义内容', enabled: true, text: 'Final' }
        ],
        separator: '_',
        findText: 'OldPrefix_',
        replaceText: 'New_',
        caseMode: 'lower'
    });
    assert.equal(fReplace, 'new_test_v1_final.jpg');
});

function getBaseItemStem(file) {
    if (file?.copyFromStem) return String(file.copyFromStem).trim();
    const raw = String(file?.name || '').replace(/\.[^.]+$/, '');
    return raw.replace(/(?:[_-]copy\d*|[_-]副本\d*|\s*[\(（](?:副本|copy)\d*[\)）]|\s*-\s*(?:副本|copy)\d*)+$/iu, '').trim() || raw;
}

function findOptimalNonAdjacentIndex(files, originalFile) {
    if (!files || files.length <= 1) return files ? files.length : 0;

    const baseStem = getBaseItemStem(originalFile);
    const matchIndices = [];
    files.forEach((f, idx) => {
        if (f.path === originalFile.path || getBaseItemStem(f) === baseStem) {
            matchIndices.push(idx);
        }
    });

    if (matchIndices.length === 0) {
        return Math.floor(files.length / 2);
    }

    let bestCandidates = [];
    let maxMinDistance = -1;

    for (let c = 0; c <= files.length; c++) {
        let minDist = Infinity;
        for (const origIdx of matchIndices) {
            const effectiveIdx = (c <= origIdx) ? origIdx + 1 : origIdx;
            const dist = Math.abs(c - effectiveIdx);
            if (dist < minDist) minDist = dist;
        }

        if (minDist > maxMinDistance) {
            maxMinDistance = minDist;
            bestCandidates = [c];
        } else if (minDist === maxMinDistance) {
            bestCandidates.push(c);
        }
    }

    const center = files.length / 2;
    bestCandidates.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    return bestCandidates[0];
}

function disperseItemsWithoutAdjacentDuplicates(items) {
    if (!items || items.length <= 2) return [...items];

    const result = [...items];
    for (let i = 1; i < result.length; i++) {
        const prevStem = getBaseItemStem(result[i - 1].file || result[i - 1]);
        const currStem = getBaseItemStem(result[i].file || result[i]);

        if (prevStem === currStem) {
            let swapped = false;
            for (let j = i + 1; j < result.length; j++) {
                const candidateStem = getBaseItemStem(result[j].file || result[j]);
                const nextStem = (i + 1 < result.length && i + 1 !== j) ? getBaseItemStem(result[i + 1].file || result[i + 1]) : null;
                const jPrevStem = getBaseItemStem(result[j - 1].file || result[j - 1]);
                const jNextStem = (j + 1 < result.length) ? getBaseItemStem(result[j + 1].file || result[j + 1]) : null;

                if (candidateStem !== prevStem && (nextStem === null || candidateStem !== nextStem) &&
                    currStem !== jPrevStem && (jNextStem === null || currStem !== jNextStem)) {
                    const tmp = result[i];
                    result[i] = result[j];
                    result[j] = tmp;
                    swapped = true;
                    break;
                }
            }
            if (!swapped) {
                for (let k = 0; k < i - 1; k++) {
                    const kStem = getBaseItemStem(result[k].file || result[k]);
                    const kNextStem = getBaseItemStem(result[k + 1].file || result[k + 1]);
                    if (currStem !== kStem && currStem !== kNextStem) {
                        const [itemToMove] = result.splice(i, 1);
                        result.splice(k + 1, 0, itemToMove);
                        break;
                    }
                }
            }
        }
    }
    return result;
}

test('findOptimalNonAdjacentIndex never inserts duplicate adjacent to original or existing copies', () => {
    // 初始列表: [A, B, C, D, E]
    const files = [
        { name: 'photoA.jpg', path: '/suite/photoA.jpg' },
        { name: 'photoB.jpg', path: '/suite/photoB.jpg' },
        { name: 'photoC.jpg', path: '/suite/photoC.jpg' },
        { name: 'photoD.jpg', path: '/suite/photoD.jpg' },
        { name: 'photoE.jpg', path: '/suite/photoE.jpg' }
    ];

    // 复制 photoA
    const insertIdx1 = findOptimalNonAdjacentIndex(files, files[0]);
    // 应该远离 photoA (index 0)，插入到索引 5 或 3/4
    assert.ok(insertIdx1 > 1, `Copy 1 should not be adjacent to index 0, got ${insertIdx1}`);

    const copy1 = { name: 'photoA (副本1).jpg', path: '/suite/photoA (副本1).jpg', copyFromStem: 'photoA' };
    files.splice(insertIdx1, 0, copy1);

    // 再次复制 photoA
    const insertIdx2 = findOptimalNonAdjacentIndex(files, files[0]);
    // 确认 insertIdx2 与 photoA 以及 photoA (副本1) 都不相邻
    const posA = files.findIndex(f => f.name === 'photoA.jpg');
    const posCopy1 = files.findIndex(f => f.name === 'photoA (副本1).jpg');

    const effectiveA = insertIdx2 <= posA ? posA + 1 : posA;
    const effectiveCopy1 = insertIdx2 <= posCopy1 ? posCopy1 + 1 : posCopy1;

    assert.ok(Math.abs(insertIdx2 - effectiveA) > 1, 'Copy 2 must not be adjacent to photoA');
    assert.ok(Math.abs(insertIdx2 - effectiveCopy1) > 1, 'Copy 2 must not be adjacent to Copy 1');
});

test('disperseItemsWithoutAdjacentDuplicates eliminates any adjacent duplicates', () => {
    // 构造相邻重复队列: [A, A_copy, B, C, D]
    const badQueue = [
        { name: 'A.jpg' },
        { name: 'A (副本).jpg' },
        { name: 'B.jpg' },
        { name: 'C.jpg' },
        { name: 'D.jpg' }
    ];

    const fixed = disperseItemsWithoutAdjacentDuplicates(badQueue);
    for (let i = 1; i < fixed.length; i++) {
        const prev = getBaseItemStem(fixed[i - 1]);
        const curr = getBaseItemStem(fixed[i]);
        assert.notEqual(prev, curr, `Items at ${i-1} and ${i} must not have same stem: ${prev} vs ${curr}`);
    }
});

test('visualReview status is preserved when renaming files', () => {
    const mockState = {
        statuses: {
            '/root/suite1/photo1.jpg': 'pass',
            '/root/suite1/photo2.jpg': 'usable',
            '/root/suite1/photo3.jpg': 'reject'
        },
        suites: [
            {
                key: 'suite1',
                groups: [
                    {
                        key: 'group1',
                        files: [
                            { path: '/root/suite1/photo1.jpg', name: 'photo1.jpg', relativePath: 'suite1/photo1.jpg' },
                            { path: '/root/suite1/photo2.jpg', name: 'photo2.jpg', relativePath: 'suite1/photo2.jpg' },
                            { path: '/root/suite1/photo3.jpg', name: 'photo3.jpg', relativePath: 'suite1/photo3.jpg' }
                        ]
                    }
                ]
            }
        ],
        activePath: '/root/suite1/photo1.jpg'
    };

    function replaceRenamedPath(state, oldPath, newPath, newName) {
        if (!oldPath || !newPath || oldPath === newPath) return;
        const status = state.statuses[oldPath];
        if (status) {
            state.statuses[newPath] = status;
            delete state.statuses[oldPath];
        }
        if (state.activePath === oldPath) state.activePath = newPath;
        state.suites.forEach(suite => {
            suite.groups.forEach(group => {
                group.files.forEach(file => {
                    if (file.path === oldPath) {
                        file.path = newPath;
                        file.name = newName;
                        file.relativePath = (file.relativePath || oldPath).replace(/[^/\\]+$/, newName);
                    }
                });
            });
        });
    }

    // 重命名 photo1 为 001_suite1_01_photo1.jpg
    replaceRenamedPath(mockState, '/root/suite1/photo1.jpg', '/root/suite1/001_suite1_01_photo1.jpg', '001_suite1_01_photo1.jpg');

    // 状态从旧路径转移到新路径，合格标记绝不丢失
    assert.equal(mockState.statuses['/root/suite1/photo1.jpg'], undefined);
    assert.equal(mockState.statuses['/root/suite1/001_suite1_01_photo1.jpg'], 'pass');
    assert.equal(mockState.activePath, '/root/suite1/001_suite1_01_photo1.jpg');
    assert.equal(mockState.suites[0].groups[0].files[0].path, '/root/suite1/001_suite1_01_photo1.jpg');
    assert.equal(mockState.suites[0].groups[0].files[0].name, '001_suite1_01_photo1.jpg');
});

test('moving file from group 2 to group 1 reassigns it and respects non-adjacent spacing', () => {
    const group1Files = [
        { name: 'G1_01.jpg', path: '/root/suite1/G1_01.jpg' },
        { name: 'TargetStem.jpg', path: '/root/suite1/TargetStem.jpg' },
        { name: 'G1_03.jpg', path: '/root/suite1/G1_03.jpg' },
        { name: 'G1_04.jpg', path: '/root/suite1/G1_04.jpg' }
    ];
    const group2Files = [
        { name: 'G2_01.jpg', path: '/root/suite1/G2_01.jpg' },
        { name: 'TargetStem (副本).jpg', path: '/root/suite1/TargetStem_copy.jpg' }
    ];

    const suites = [
        {
            key: 'suite1',
            groups: [
                { key: '片段 1', files: [...group1Files] },
                { key: '片段 2', files: [...group2Files] }
            ]
        }
    ];

    function moveFileToGroup(filePath, targetSuiteIdx, targetGroupIdx) {
        let sourceGroup = null;
        let sourceIdx = -1;
        let fileObj = null;

        suites.forEach(s => s.groups.forEach(g => {
            const idx = g.files.findIndex(f => f.path === filePath);
            if (idx !== -1) {
                sourceGroup = g;
                sourceIdx = idx;
                fileObj = g.files[idx];
            }
        }));

        assert.ok(fileObj, 'File must exist');
        sourceGroup.files.splice(sourceIdx, 1);

        const targetGroup = suites[targetSuiteIdx].groups[targetGroupIdx];
        const insertIdx = findOptimalNonAdjacentIndex(targetGroup.files, fileObj);
        targetGroup.files.splice(insertIdx, 0, fileObj);
        return insertIdx;
    }

    // 将 group 2 的 TargetStem (副本).jpg 移入 group 1
    const targetFilePath = '/root/suite1/TargetStem_copy.jpg';
    const insertIdx = moveFileToGroup(targetFilePath, 0, 0);

    // 验证原组已移走
    assert.equal(suites[0].groups[1].files.length, 1);
    assert.equal(suites[0].groups[1].files[0].name, 'G2_01.jpg');

    // 验证目标组增加了该素材
    assert.equal(suites[0].groups[0].files.length, 5);
    assert.ok(suites[0].groups[0].files.some(f => f.path === targetFilePath));

    // 验证插入位置绝不与原 TargetStem 相邻 (TargetStem 在原索引 1)
    const targetStemIdx = suites[0].groups[0].files.findIndex(f => f.name === 'TargetStem.jpg');
    const copyIdx = suites[0].groups[0].files.findIndex(f => f.path === targetFilePath);
    assert.ok(Math.abs(targetStemIdx - copyIdx) > 1, `Moved copy must not be adjacent to original stem! Got diff: ${Math.abs(targetStemIdx - copyIdx)}`);
});

test('visualReview image preview correctly normalizes encoded paths and clamps zoom scales', () => {
    function normalizePreviewPath(rawOrEncodedPath) {
        let filePath = String(rawOrEncodedPath || '');
        try {
            if (filePath.includes('%')) filePath = decodeURIComponent(filePath);
        } catch (_) { }
        return filePath;
    }

    function computeZoom(scale, factor) {
        return Math.max(0.5, Math.min(10, scale * factor));
    }

    const encoded = encodeURIComponent('/Volumes/jw/照片库/人物 A/01.jpg');
    const decoded = normalizePreviewPath(encoded);
    assert.equal(decoded, '/Volumes/jw/照片库/人物 A/01.jpg');

    // 缩放计算验证
    let zoom = 1.0;
    zoom = computeZoom(zoom, 1.2);
    assert.equal(Math.round(zoom * 100), 120);

    // 最大放大倍数钳制
    zoom = computeZoom(8, 2);
    assert.equal(zoom, 10);

    // 最小缩小倍数钳制
    zoom = computeZoom(0.6, 0.5);
    assert.equal(zoom, 0.5);
});

test('getBaseItemStem does not falsely treat normal numbered files as duplicate stems', () => {
    const f1 = { name: '非女10 (4).jpg' };
    const f2 = { name: '非女10 (6).jpg' };
    const f3 = { name: '非女10 (7).jpg' };
    const f1Copy = { name: '非女10 (4) (副本).jpg' };
    const f1Copy2 = { name: '非女10 (4) (副本2).jpg' };

    assert.equal(getBaseItemStem(f1), '非女10 (4)');
    assert.equal(getBaseItemStem(f2), '非女10 (6)');
    assert.equal(getBaseItemStem(f3), '非女10 (7)');
    assert.notEqual(getBaseItemStem(f1), getBaseItemStem(f2));

    // 真正的副本必须匹配原图 stem
    assert.equal(getBaseItemStem(f1Copy), '非女10 (4)');
    assert.equal(getBaseItemStem(f1Copy2), '非女10 (4)');
    assert.equal(getBaseItemStem(f1), getBaseItemStem(f1Copy));
});

test('visualReviewApplyQuotaSelection extracts quota N and alerts on shortage', () => {
    function applyQuota(allFiles, state, quotaCount, quotaStrategy, scope = 'all', suiteIndex = 0) {
        const quota = Math.max(1, Number(quotaCount) || 3);
        const folderMap = new Map();
        const shortageList = [];
        const resultFiles = [];
        const statuses = state?.statuses || {};

        allFiles.forEach(item => {
            const key = item.suiteKey || '未分套';
            if (!folderMap.has(key)) folderMap.set(key, []);
            folderMap.get(key).push(item);
        });

        const expectedSuites = (scope === 'all'
            ? (state?.suites || []).map(s => s.key)
            : (scope === 'suite'
                ? [state?.suites?.[suiteIndex]?.key].filter(Boolean)
                : []));

        expectedSuites.forEach(key => {
            if (!folderMap.has(key)) folderMap.set(key, []);
        });

        folderMap.forEach((list, folderKey) => {
            const displayName = folderKey === '未分套' ? (state?.root ? state.root.replace(/.*[/\\]/, '') : '素材') : folderKey;
            let sorted = list.slice();

            if (quotaStrategy === 'pass_first' || quotaStrategy === 'prefer_pass') {
                sorted.sort((a, b) => {
                    const sa = statuses[a.file.path] || '';
                    const sb = statuses[b.file.path] || '';
                    const score = s => s === 'pass' ? 2 : (s === 'usable' ? 1 : 0);
                    return score(sb) - score(sa);
                });
            }

            const selected = sorted.slice(0, quota);
            resultFiles.push(...selected);

            if (selected.length < quota) {
                shortageList.push({
                    folderKey,
                    folderName: displayName,
                    available: selected.length,
                    actualCount: selected.length,
                    required: quota,
                    neededCount: quota,
                    missing: quota - selected.length,
                    missingCount: quota - selected.length
                });
            }
        });

        return { selectedFiles: resultFiles, shortageList };
    }

    const files = [
        // 套1: 有 5 张 (配额 3，充足)
        { file: { path: '/root/套1/1.jpg', name: '1.jpg' }, suiteKey: '套1' },
        { file: { path: '/root/套1/2.jpg', name: '2.jpg' }, suiteKey: '套1' },
        { file: { path: '/root/套1/3.jpg', name: '3.jpg' }, suiteKey: '套1' },
        { file: { path: '/root/套1/4.jpg', name: '4.jpg' }, suiteKey: '套1' },
        { file: { path: '/root/套1/5.jpg', name: '5.jpg' }, suiteKey: '套1' },

        // 套2: 仅 2 张 (配额 3，不足！需全部提取并准确提醒不足)
        { file: { path: '/root/套2/a.jpg', name: 'a.jpg' }, suiteKey: '套2' },
        { file: { path: '/root/套2/b.jpg', name: 'b.jpg' }, suiteKey: '套2' },

        // 套3: 刚好 3 张 (配额 3，充足)
        { file: { path: '/root/套3/x.jpg', name: 'x.jpg' }, suiteKey: '套3' },
        { file: { path: '/root/套3/y.jpg', name: 'y.jpg' }, suiteKey: '套3' },
        { file: { path: '/root/套3/z.jpg', name: 'z.jpg' }, suiteKey: '套3' }
    ];

    const state = {
        root: '/root',
        suites: [{ key: '套1' }, { key: '套2' }, { key: '套3' }],
        statuses: {
            '/root/套1/4.jpg': 'pass',
            '/root/套1/5.jpg': 'usable'
        }
    };

    // 执行每文件夹提取 3 张，优先合格/勉强
    const res = applyQuota(files, state, 3, 'prefer_pass', 'all');

    // 验证提取文件总数：套1(3张) + 套2(全部2张) + 套3(3张) = 8 张
    assert.equal(res.selectedFiles.length, 8);

    // 验证套1抽取了3张，且优先提取了 pass 和 usable
    const s1Files = res.selectedFiles.filter(f => f.suiteKey === '套1');
    assert.equal(s1Files.length, 3);
    assert.equal(s1Files[0].file.path, '/root/套1/4.jpg'); // pass 优先
    assert.equal(s1Files[1].file.path, '/root/套1/5.jpg'); // usable 次优

    // 验证套2因为不足3张，全部提取了原有的2张可用素材
    const s2Files = res.selectedFiles.filter(f => f.suiteKey === '套2');
    assert.equal(s2Files.length, 2);
    assert.equal(s2Files[0].file.name, 'a.jpg');
    assert.equal(s2Files[1].file.name, 'b.jpg');

    // 验证准确记录了不足提醒列表，包含文件夹名与缺少数
    assert.equal(res.shortageList.length, 1);
    assert.equal(res.shortageList[0].folderName, '套2');
    assert.equal(res.shortageList[0].available, 2);
    assert.equal(res.shortageList[0].required, 3);
    assert.equal(res.shortageList[0].missing, 1);
});

test('batch rename preserves relative folder hierarchy when exporting to destination', () => {
    const destRoot = '/Volumes/TargetExport';
    const inputRoot = '/Volumes/SourceRoot';

    const testFiles = [
        { file: { path: '/Volumes/SourceRoot/套1/subA/01.jpg', name: '01.jpg', relativePath: '套1/subA/01.jpg' }, suiteKey: '套1' },
        { file: { path: '/Volumes/SourceRoot/套1/subA/02.jpg', name: '02.jpg', relativePath: '套1/subA/02.jpg' }, suiteKey: '套1' },
        { file: { path: '/Volumes/SourceRoot/套2/01.jpg', name: '01.jpg', relativePath: '套2/01.jpg' }, suiteKey: '套2' }
    ];

    const folderIndexMap = new Map();
    const items = testFiles.map((item) => {
        const folderName = item.suiteKey;
        const currentFolderIndex = (folderIndexMap.get(folderName) || 0) + 1;
        folderIndexMap.set(folderName, currentFolderIndex);

        const padSeq = String(currentFolderIndex).padStart(2, '0');
        const newName = `${folderName}_${padSeq}.jpg`;

        let rel = item.file.relativePath || '';
        if (!rel && item.file.path.startsWith(inputRoot)) {
            rel = item.file.path.slice(inputRoot.length).replace(/^[/\\]+/, '');
        }
        const relSubDir = rel.includes('/') || rel.includes('\\') ? rel.replace(/[^/\\]+$/, '') : '';
        const targetSubDir = relSubDir ? `${destRoot}/${relSubDir.replace(/^[/\\]+|[/\\]+$/g, '')}` : destRoot;
        const targetPath = `${targetSubDir}/${newName}`;

        return {
            origName: item.file.name,
            folderName,
            folderIndex: currentFolderIndex,
            newName,
            targetPath,
            targetSubDir
        };
    });

    // 验证套1内的各级子文件夹层级 subA 被完整保留
    assert.equal(items[0].targetPath, '/Volumes/TargetExport/套1/subA/套1_01.jpg');
    assert.equal(items[1].targetPath, '/Volumes/TargetExport/套1/subA/套1_02.jpg');
    assert.equal(items[0].folderIndex, 1);
    assert.equal(items[1].folderIndex, 2);

    // 验证进入套2时，组内编号从 01 重新编排，且层级依然保留
    assert.equal(items[2].targetPath, '/Volumes/TargetExport/套2/套2_01.jpg');
    assert.equal(items[2].folderIndex, 1);
});

test('apiRouter file/rename automatically creates missing target directories and handles copy/rename', async () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videokit-rename-test-'));
    try {
        const srcFile = path.join(tempDir, 'source.jpg');
        fs.writeFileSync(srcFile, 'dummy content');

        // 深层目标路径，目录尚不存在
        const destFile = path.join(tempDir, 'nested', 'level1', 'level2', 'exported.jpg');

        const { routeAPI } = require('../electron/apiRouter.js');

        // 测试 copy 模式与自动递归建目录
        const copyRes = await routeAPI('file/rename', {
            source: srcFile,
            target: destFile,
            copy: true
        });

        assert.equal(copyRes.success, true);
        assert.ok(fs.existsSync(destFile), 'Target file must exist in created directory');
        assert.ok(fs.existsSync(srcFile), 'Source file must remain intact in copy mode');
        assert.equal(fs.readFileSync(destFile, 'utf8'), 'dummy content');

        // 测试 move 模式
        const moveDest = path.join(tempDir, 'moved', 'sub', 'moved.jpg');
        const moveRes = await routeAPI('file/rename', {
            source: srcFile,
            target: moveDest,
            copy: false
        });

        assert.equal(moveRes.success, true);
        assert.ok(fs.existsSync(moveDest), 'Moved file must exist');
        assert.ok(!fs.existsSync(srcFile), 'Original source file must be unlinked/moved');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});




