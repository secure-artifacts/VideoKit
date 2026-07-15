const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ffmpegService = require('./ffmpeg');
const gladiaService = require('./gladia');
const elevenlabsService = require('./elevenlabs');
const subtitleService = require('./subtitle');
const settingsService = require('./settings');
const subtitleUtils = require('./subtitleUtils');

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function splitScriptLines(scriptText) {
    return String(scriptText || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
}

async function buildManualTranscription(clipPath, fullText) {
    let duration = 60;
    try {
        duration = await ffmpegService.getDuration(clipPath) || 60;
    } catch {}

    let rawWords;
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(fullText)) {
        rawWords = String(fullText || '').split('').map(char => char.trim()).filter(Boolean);
    } else {
        rawWords = String(fullText || '').split(/\s+/).filter(Boolean);
    }

    const count = rawWords.length;
    const words = [];
    for (let j = 0; j < count; j++) {
        const wordStart = (duration / count) * j;
        const wordEnd = (duration / count) * (j + 1);
        words.push({
            word: rawWords[j],
            start: wordStart,
            end: wordEnd,
            score: 0.99,
            confidence: 0.99
        });
    }

    const wordTimeInfo = [{
        text: fullText,
        audio_start: 0,
        audio_end: duration,
        words
    }];
    return {
        wordTimeInfo,
        fullText,
        source: 'manual_transcript'
    };
}

function flattenWords(wordTimeInfo) {
    const words = [];
    for (const seg of wordTimeInfo || []) {
        for (const w of seg.words || []) {
            const raw = String(w.word || '').trim();
            const norm = normalizeText(raw);
            const start = Number(w.start);
            const end = Number(w.end);
            if (!raw || !norm || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
            words.push({ raw, norm, start, end, score: w.score || 0 });
        }
    }
    return words;
}

function lcsLength(a, b) {
    if (!a || !b) return 0;
    const prev = new Array(b.length + 1).fill(0);
    const cur = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function scoreCandidate(candidate, targetNorm) {
    if (!candidate || !targetNorm) return 0;
    if (candidate === targetNorm) return 1;
    const containsBonus = candidate.includes(targetNorm) || targetNorm.includes(candidate) ? 0.08 : 0;
    const lcs = lcsLength(candidate, targetNorm);
    const base = lcs / Math.max(candidate.length, targetNorm.length);
    const lenPenalty = Math.abs(candidate.length - targetNorm.length) / Math.max(candidate.length, targetNorm.length, 1);
    return Math.max(0, Math.min(1, base + containsBonus - lenPenalty * 0.12));
}

function wordLcsLength(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    const prev = new Array(b.length + 1).fill(0);
    const cur = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function scoreWordCandidate(candidateWords, targetWords) {
    const lcs = wordLcsLength(candidateWords, targetWords);
    if (lcs === 0) return 0;
    const precision = lcs / candidateWords.length;
    const recall = lcs / targetWords.length;
    const f1 = (2 * precision * recall) / (precision + recall);
    const candidateSet = new Set(candidateWords);
    const distinctive = targetWords.filter(word => word.length >= 4 || /\d/.test(word));
    const keywordRecall = distinctive.length
        ? distinctive.filter(word => candidateSet.has(word)).length / distinctive.length
        : recall;
    const lengthRatio = Math.min(candidateWords.length, targetWords.length) / Math.max(candidateWords.length, targetWords.length, 1);
    
    let penalty = 0;
    if (candidateWords.length > 0) {
        if (!targetWords.includes(candidateWords[0])) {
            penalty += 0.08;
        }
        if (!targetWords.includes(candidateWords[candidateWords.length - 1])) {
            penalty += 0.08;
        }
    }
    return Math.max(0, Math.min(1, f1 * 0.7 + keywordRecall * 0.2 + lengthRatio * 0.1 - penalty));
}

function findBestWordWindow(words, targetText, minScore = 0.52) {
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(targetText);

    if (!hasCJK) {
        // Spaced languages (English, etc.): Word-based matching
        const targetWords = String(targetText || '').split(/\s+/).map(w => normalizeText(w)).filter(Boolean);
        if (targetWords.length === 0 || words.length === 0) return null;

        const scriptWordsNorm = words.map(w => w.norm);

        // 1. Exact subarray match
        const targetStr = targetWords.join(' ');
        for (let i = 0; i <= scriptWordsNorm.length - targetWords.length; i++) {
            const sub = scriptWordsNorm.slice(i, i + targetWords.length).join(' ');
            if (sub === targetStr) {
                return {
                    startIdx: i,
                    endIdx: i + targetWords.length - 1,
                    score: 1.0,
                    matchedText: words.slice(i, i + targetWords.length).map(w => w.raw).join(' ')
                };
            }
        }

        // 2. LCS based sliding window
        let best = null;
        const targetLen = targetWords.length;
        const minLen = Math.max(1, Math.floor(targetLen * 0.45));
        const maxLen = Math.max(targetLen + 4, Math.ceil(targetLen * 1.5));

        for (let i = 0; i < scriptWordsNorm.length; i++) {
            for (let j = i; j < scriptWordsNorm.length; j++) {
                const len = j - i + 1;
                if (len > maxLen) break;
                if (len < minLen) continue;
                const candidateWords = scriptWordsNorm.slice(i, j + 1);
                const score = scoreWordCandidate(candidateWords, targetWords);
                if (!best || score > best.score) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
        return best && best.score >= minScore ? best : null;
    } else {
        // Original character-based matching for CJK
        const targetNorm = normalizeText(targetText);
        if (!targetNorm || words.length === 0) return null;

        const fullText = words.map(w => w.norm).join('');
        const exactOffset = fullText.indexOf(targetNorm);
        if (exactOffset >= 0) {
            let cursor = 0;
            let startIdx = 0;
            let endIdx = words.length - 1;
            for (let i = 0; i < words.length; i++) {
                const next = cursor + words[i].norm.length;
                if (exactOffset >= cursor && exactOffset < next) startIdx = i;
                if (exactOffset + targetNorm.length > cursor && exactOffset + targetNorm.length <= next) {
                    endIdx = i;
                    break;
                }
                cursor = next;
            }
            return {
                startIdx,
                endIdx,
                score: 1,
                matchedText: words.slice(startIdx, endIdx + 1).map(w => w.raw).join(' '),
            };
        }

        let best = null;
        const minChars = Math.max(1, Math.floor(targetNorm.length * 0.45));
        const maxChars = Math.max(targetNorm.length + 12, Math.ceil(targetNorm.length * 1.9));

        for (let i = 0; i < words.length; i++) {
            let candidate = '';
            for (let j = i; j < words.length; j++) {
                candidate += words[j].norm;
                if (candidate.length > maxChars) break;
                if (candidate.length < minChars) continue;
                const score = scoreCandidate(candidate, targetNorm);
                if (!best || score > best.score) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
        return best && best.score >= minScore ? best : null;
    }
}

function findBestWordWindowAvoidingRanges(words, targetText, minScore = 0.52, blockedRanges = [], globalOffset = 0) {
    const overlapRatio = (startIdx, endIdx) => {
        if (!blockedRanges.length || endIdx < startIdx) return 0;
        let overlap = 0;
        for (const range of blockedRanges) {
            const s = Math.max(globalOffset + startIdx, range.start);
            const e = Math.min(globalOffset + endIdx, range.end);
            if (e >= s) overlap += e - s + 1;
        }
        return overlap / Math.max(1, endIdx - startIdx + 1);
    };

    const scoreWithOverlap = (baseScore, startIdx, endIdx) => {
        const overlap = overlapRatio(startIdx, endIdx);
        return baseScore - Math.min(0.75, overlap * 0.75);
    };

    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(targetText);
    let best = null;

    if (!hasCJK) {
        const targetWords = String(targetText || '').split(/\s+/).map(w => normalizeText(w)).filter(Boolean);
        if (targetWords.length === 0 || words.length === 0) return null;
        const scriptWordsNorm = words.map(w => w.norm);
        const targetLen = targetWords.length;
        const minLen = Math.max(1, Math.floor(targetLen * 0.45));
        const maxLen = Math.max(targetLen + 4, Math.ceil(targetLen * 1.5));

        for (let i = 0; i < scriptWordsNorm.length; i++) {
            for (let j = i; j < scriptWordsNorm.length; j++) {
                const len = j - i + 1;
                if (len > maxLen) break;
                if (len < minLen) continue;
                const candidateWords = scriptWordsNorm.slice(i, j + 1);
                const baseScore = candidateWords.join(' ') === targetWords.join(' ')
                    ? 1
                    : scoreWordCandidate(candidateWords, targetWords);
                if (baseScore < minScore) continue;
                const adjustedScore = scoreWithOverlap(baseScore, i, j);
                if (!best || adjustedScore > best.adjustedScore || (adjustedScore === best.adjustedScore && baseScore > best.score)) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score: baseScore,
                        adjustedScore,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
    } else {
        const targetNorm = normalizeText(targetText);
        if (!targetNorm || words.length === 0) return null;
        const minChars = Math.max(1, Math.floor(targetNorm.length * 0.45));
        const maxChars = Math.max(targetNorm.length + 12, Math.ceil(targetNorm.length * 1.9));

        for (let i = 0; i < words.length; i++) {
            let candidate = '';
            for (let j = i; j < words.length; j++) {
                candidate += words[j].norm;
                if (candidate.length > maxChars) break;
                if (candidate.length < minChars) continue;
                const baseScore = candidate === targetNorm ? 1 : scoreCandidate(candidate, targetNorm);
                if (baseScore < minScore) continue;
                const adjustedScore = scoreWithOverlap(baseScore, i, j);
                if (!best || adjustedScore > best.adjustedScore || (adjustedScore === best.adjustedScore && baseScore > best.score)) {
                    best = {
                        startIdx: i,
                        endIdx: j,
                        score: baseScore,
                        adjustedScore,
                        matchedText: words.slice(i, j + 1).map(w => w.raw).join(' '),
                    };
                }
            }
        }
    }

    return best && best.adjustedScore >= Math.max(0.18, minScore * 0.55) ? best : null;
}

function recognizedNormFromWords(words) {
    return (words || []).map(w => w.norm).join('');
}

function findBestScriptWindowForClip(words, lines, minScore = 0.52) {
    const clipNorm = recognizedNormFromWords(words);
    if (!clipNorm || !Array.isArray(lines) || lines.length === 0) return null;

    let best = null;
    const clipLen = clipNorm.length;
    const maxTargetChars = Math.max(clipLen + 80, Math.ceil(clipLen * 2.2), 20);
    const minTargetChars = Math.max(1, Math.floor(clipLen * 0.25));

    for (let startLine = 0; startLine < lines.length; startLine++) {
        let targetText = '';
        let targetNorm = '';
        for (let endLine = startLine; endLine < lines.length; endLine++) {
            targetText = targetText ? `${targetText}\n${lines[endLine]}` : lines[endLine];
            targetNorm += normalizeText(lines[endLine]);
            if (!targetNorm) continue;
            if (targetNorm.length > maxTargetChars) break;

            const window = findBestWordWindow(words, targetText, minScore);
            if (!window) continue;

            const lengthScore = 1 - Math.min(1, Math.abs(targetNorm.length - clipLen) / Math.max(targetNorm.length, clipLen, 1));
            const rangePenalty = Math.max(0, endLine - startLine) * 0.006;
            const thresholdPenalty = window.score < minScore ? (minScore - window.score) * 0.18 : 0;
            const score = Math.max(0, Math.min(1, window.score * 0.74 + lengthScore * 0.26 - rangePenalty - thresholdPenalty));

            if (targetNorm.length < minTargetChars && score < 0.98) continue;
            if (!best || score > best.score) {
                best = {
                    startLine,
                    endLine,
                    text: targetText,
                    targetNorm,
                    score,
                    wordWindow: window,
                    matchedText: window.matchedText,
                    lengthScore,
                };
            }
        }
    }

    if (best) return best;
    const fallback = findBestWordWindow(words, lines.join('\n'), minScore);
    if (!fallback) return null;
    return {
        startLine: 0,
        endLine: lines.length - 1,
        text: lines.join('\n'),
        targetNorm: normalizeText(lines.join('\n')),
        score: fallback.score,
        wordWindow: fallback,
        matchedText: fallback.matchedText,
        lengthScore: 0,
    };
}

function clampMs(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function buildLineSubtitleItems({ lines, lineStart, lineEnd, words, clipStartSec, cutDurationSec, timelineStartMs, minScore }) {
    const items = [];
    const scopedWords = words.slice(lineStart, lineEnd + 1);
    const totalMs = Math.max(1, Math.round(cutDurationSec * 1000));
    const lineCount = Math.max(1, lines.length);
    let cursor = 0;
    let lastEnd = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const searchWords = scopedWords.slice(cursor);
        const match = searchWords.length
            ? findBestWordWindow(searchWords, line, Math.max(0.1, minScore * 0.45))
            : null;
        let localStart;
        let localEnd;

        if (match && searchWords[match.startIdx] && searchWords[match.endIdx] && match.score >= 0.28) {
            localStart = Math.round((searchWords[match.startIdx].start - clipStartSec) * 1000);
            localEnd = Math.round((searchWords[match.endIdx].end - clipStartSec) * 1000);
            cursor = Math.max(cursor + 1, cursor + match.endIdx + 1);
        } else {
            localStart = Math.round((totalMs / lineCount) * i);
            localEnd = Math.round((totalMs / lineCount) * (i + 1));
        }

        localStart = clampMs(localStart, 0, totalMs - 1);
        localEnd = clampMs(localEnd, localStart + 1, totalMs);
        if (localStart < lastEnd) localStart = Math.min(lastEnd, totalMs - 1);
        if (localEnd <= localStart) localEnd = Math.min(totalMs, localStart + Math.max(1, Math.round(totalMs / lineCount)));
        lastEnd = localEnd;

        items.push({
            start: timelineStartMs + localStart,
            end: timelineStartMs + localEnd,
            text: line,
        });
    }

    return items;
}

function computeAutoEditTransitionSec(prevDuration, currentDuration, transitionType, requestedDuration) {
    if (!transitionType || transitionType === 'none') return 0;
    const req = Math.max(0, Math.min(3, Number(requestedDuration) || 0));
    if (req <= 0.03) return 0;
    const safe = Math.min(req, Number(prevDuration || 0) * 0.45, Number(currentDuration || 0) * 0.45);
    return safe > 0.05 ? safe : 0;
}

function srtAssPath(p) {
    return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function extractUtterances(data) {
    if (Array.isArray(data)) return data;
    if (!data) return [];

    let utterances = null;
    if (data.result?.transcription?.utterances) {
        utterances = data.result.transcription.utterances;
    } else if (Array.isArray(data.results)) {
        utterances = data.results;
    } else if (data.transcription?.utterances) {
        utterances = data.transcription.utterances;
    } else if (Array.isArray(data.result?.transcription)) {
        utterances = data.result.transcription;
    } else if (Array.isArray(data.result?.utterances)) {
        utterances = data.result.utterances;
    }

    if (Array.isArray(utterances)) {
        return utterances.map(item => {
            const words = (item.words || []).map(w => ({
                word: w.word || '',
                start: w.start !== undefined ? w.start : (w.time_begin || 0),
                end: w.end !== undefined ? w.end : (w.time_end || 0),
                score: w.confidence !== undefined ? w.confidence : (w.score || 0)
            }));
            return {
                text: item.text || item.transcription || '',
                audio_start: item.start !== undefined ? item.start : (item.time_begin || 0),
                audio_end: item.end !== undefined ? item.end : (item.time_end || 0),
                words
            };
        });
    }
    return [];
}

async function transcribeClip(clipPath, language, gladiaKeys, cacheDir, force, manualSubtitlePath) {
    // 如果用户手动指定了字幕文件路径
    if (manualSubtitlePath && fs.existsSync(manualSubtitlePath)) {
        const ext = path.parse(manualSubtitlePath).ext.toLowerCase();
        try {
            console.log(`[自动剪辑] 使用用户界面手动指定的字幕文件: ${manualSubtitlePath}`);
            if (ext === '.srt') {
                const srtContent = fs.readFileSync(manualSubtitlePath, 'utf-8');
                const items = subtitleService.parseSRT(srtContent);
                const wordTimeInfo = [];
                const fullTextList = [];
                for (const item of items) {
                    const startSec = item.start / 1000;
                    const endSec = item.end / 1000;
                    fullTextList.push(item.text);

                    let rawWords;
                    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(item.text)) {
                        rawWords = item.text.split('').map(char => char.trim()).filter(Boolean);
                    } else {
                        rawWords = item.text.split(/\s+/).filter(Boolean);
                    }

                    const count = rawWords.length;
                    const duration = endSec - startSec;
                    const words = [];
                    for (let j = 0; j < count; j++) {
                        const wordStart = startSec + (count > 0 ? (duration / count) * j : 0);
                        const wordEnd = startSec + (count > 0 ? (duration / count) * (j + 1) : 0);
                        words.push({
                            word: rawWords[j],
                            start: wordStart,
                            end: wordEnd,
                            score: 0.99,
                            confidence: 0.99
                        });
                    }

                    wordTimeInfo.push({
                        text: item.text,
                        audio_start: startSec,
                        audio_end: endSec,
                        words
                    });
                }

                return {
                    wordTimeInfo,
                    fullText: fullTextList.join(' '),
                    source: 'manual_srt'
                };
            } else if (ext === '.json') {
                const rawData = JSON.parse(fs.readFileSync(manualSubtitlePath, 'utf-8'));
                const wordTimeInfo = extractUtterances(rawData);
                const txtPath = manualSubtitlePath.replace(/\.json$/i, '.txt');
                let fullText = '';
                if (fs.existsSync(txtPath)) {
                    fullText = fs.readFileSync(txtPath, 'utf-8').trim();
                } else {
                    fullText = wordTimeInfo.map(utterance => utterance.text || '').join(' ').trim();
                }
                return {
                    wordTimeInfo,
                    fullText,
                    source: 'manual',
                };
            } else if (ext === '.txt') {
                const fullText = fs.readFileSync(manualSubtitlePath, 'utf-8').trim();
                let duration = 60;
                try {
                    const ffmpegService = require('./ffmpeg');
                    duration = await ffmpegService.getDuration(clipPath) || 60;
                } catch {}

                let rawWords;
                if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(fullText)) {
                    rawWords = fullText.split('').map(char => char.trim()).filter(Boolean);
                } else {
                    rawWords = fullText.split(/\s+/).filter(Boolean);
                }

                const count = rawWords.length;
                const words = [];
                for (let j = 0; j < count; j++) {
                    const wordStart = (duration / count) * j;
                    const wordEnd = (duration / count) * (j + 1);
                    words.push({
                        word: rawWords[j],
                        start: wordStart,
                        end: wordEnd,
                        score: 0.99,
                        confidence: 0.99
                    });
                }

                const wordTimeInfo = [{
                    text: fullText,
                    audio_start: 0,
                    audio_end: duration,
                    words
                }];

                return {
                    wordTimeInfo,
                    fullText,
                    source: 'manual_txt'
                };
            }
        } catch (err) {
            console.error(`[自动剪辑] 解析手动指定的字幕文件 ${manualSubtitlePath} 失败:`, err);
        }
    }

    // 支持手动指定转录结果文件：检查视频同目录下是否存在同名或带有 _transcription 后缀的 .json 和 .txt 文件
    const parsed = path.parse(clipPath);
    const manualJsonPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.json`),
        path.join(parsed.dir, `${parsed.name}.json`)
    ];
    const manualTxtPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.txt`),
        path.join(parsed.dir, `${parsed.name}.txt`)
    ];

    let foundJson = manualJsonPaths.find(p => fs.existsSync(p));
    let foundTxt = manualTxtPaths.find(p => fs.existsSync(p));

    // “重新转录”应跳过自动发现的同名旁车文件；否则之前生成的空
    // _transcription.json/.txt 会永远覆盖新的接口识别结果。
    // 用户在界面中明确选择的 manualSubtitlePath 已在上方处理，不受影响。
    if (!force && foundJson && foundTxt) {
        try {
            console.log(`[自动剪辑] 检测到同名本地手动转录文件，跳过 API 识别: ${foundJson}`);
            const rawData = JSON.parse(fs.readFileSync(foundJson, 'utf-8'));
            const wordTimeInfo = extractUtterances(rawData);
            const fullText = fs.readFileSync(foundTxt, 'utf-8').trim();
            if (fullText && wordTimeInfo.length > 0) {
                return { wordTimeInfo, fullText, source: 'manual' };
            }
            console.warn(`[自动剪辑] 自动发现的同名转录文件为空，将忽略并调用接口: ${foundJson}`);
        } catch (readErr) {
            console.error(`[自动剪辑] 读取手动转录文件失败:`, readErr);
        }
    }

    const manualSrtPaths = [
        path.join(parsed.dir, `${parsed.name}_transcription.srt`),
        path.join(parsed.dir, `${parsed.name}.srt`)
    ];
    let foundSrt = manualSrtPaths.find(p => fs.existsSync(p));

    if (!force && foundSrt) {
        try {
            console.log(`[自动剪辑] 检测到同名本地手动 SRT 文件，跳过 API 识别: ${foundSrt}`);
            const srtContent = fs.readFileSync(foundSrt, 'utf-8');
            const items = subtitleService.parseSRT(srtContent);
            const wordTimeInfo = [];
            const fullTextList = [];

            for (const item of items) {
                const startSec = item.start / 1000;
                const endSec = item.end / 1000;
                fullTextList.push(item.text);

                let rawWords;
                if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(item.text)) {
                    rawWords = item.text.split('').map(char => char.trim()).filter(Boolean);
                } else {
                    rawWords = item.text.split(/\s+/).filter(Boolean);
                }

                const count = rawWords.length;
                const duration = endSec - startSec;
                const words = [];
                for (let j = 0; j < count; j++) {
                    const wordStart = startSec + (count > 0 ? (duration / count) * j : 0);
                    const wordEnd = startSec + (count > 0 ? (duration / count) * (j + 1) : 0);
                    words.push({
                        word: rawWords[j],
                        start: wordStart,
                        end: wordEnd,
                        score: 0.99,
                        confidence: 0.99
                    });
                }

                wordTimeInfo.push({
                    text: item.text,
                    audio_start: startSec,
                    audio_end: endSec,
                    words
                });
            }

            const fullText = fullTextList.join(' ').trim();
            if (fullText && wordTimeInfo.length > 0) {
                return { wordTimeInfo, fullText, source: 'manual_srt' };
            }
            console.warn(`[自动剪辑] 自动发现的同名 SRT 为空，将忽略并调用接口: ${foundSrt}`);
        } catch (readErr) {
            console.error(`[自动剪辑] 读取/解析手动 SRT 文件失败:`, readErr);
        }
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const stat = fs.statSync(clipPath);
    const cacheKey = crypto
        .createHash('sha1')
        .update(`${clipPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
        .digest('hex')
        .slice(0, 12);
    const baseName = path.parse(clipPath).name.replace(/[^\w.-]+/g, '_');
    let langCode = 'auto';
    let langEnName = 'auto';
    if (language && language !== 'auto') {
        langCode = language;
        for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
            if (info.name === language || info.code === language) {
                langCode = code;
                langEnName = info.language;
                break;
            }
        }
        if (langEnName === 'auto') {
            langEnName = subtitleUtils.getLanguage(langCode) || langCode;
        }
    }
    const jsonPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.json`);
    const txtPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.txt`);

    if (!force && fs.existsSync(jsonPath) && fs.existsSync(txtPath)) {
        const cachedText = fs.readFileSync(txtPath, 'utf-8').trim();
        let cachedWords = [];
        try {
            cachedWords = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        } catch (cacheErr) {
            console.warn(`[自动剪辑] 转录缓存损坏，将重新识别: ${txtPath}`, cacheErr.message);
        }
        // 空结果来自接口偶发异常、上传失败或响应解析问题，不能永久复用。
        if (cachedText && Array.isArray(cachedWords) && cachedWords.length > 0) {
            return {
                wordTimeInfo: cachedWords,
                fullText: cachedText,
                source: 'cache',
            };
        }
        console.warn(`[自动剪辑] 检测到空转录缓存，忽略缓存并重新调用识别: ${txtPath}`);
    }
    let result = await gladiaService.transcribeAudioFull(
        clipPath, gladiaKeys, langEnName, jsonPath, txtPath, 5.0
    );
    const hasRecognizedText = value => Boolean(
        value?.fullText?.trim() && Array.isArray(value?.wordTimeInfo) && value.wordTimeInfo.length > 0
    );
    if (!hasRecognizedText(result)) {
        console.warn(`[自动剪辑] Gladia 首次未返回文字，自动重试一次: ${clipPath}`);
        result = await gladiaService.transcribeAudioFull(
            clipPath, gladiaKeys, langEnName, jsonPath, txtPath, 5.0
        );
    }
    if (!hasRecognizedText(result)) {
        // 不保留空结果，避免下一次分析继续误用。
        for (const emptyPath of [jsonPath, txtPath]) {
            try { if (fs.existsSync(emptyPath)) fs.unlinkSync(emptyPath); } catch (_) { }
        }
        throw new Error('GLADIA_EMPTY_RESULT：语音识别服务连续两次返回空响应。Gladia 请求已完成，但没有返回可用文字；这不是“额度不足”的确定证据，可能是音轨无声、语言识别失败、接口空响应或结果格式异常。请试听原片、检查语言设置后再单独重试。');
    }
    return { ...result, source: 'gladia' };
}

function buildSubtitleItemsFromAudioWords(lines, words, audioDurationSec, minScore = 0.52) {
    const items = [];
    const totalMs = Math.max(1, Math.round((Number(audioDurationSec) || 0) * 1000));
    const lineCount = Math.max(1, lines.length);
    let cursor = 0;

    // First pass: match lines
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const scopedWords = words.slice(cursor);
        const match = scopedWords.length
            ? findBestWordWindow(scopedWords, line, Math.max(0.1, minScore * 0.45))
            : null;

        let startMs = null;
        let endMs = null;
        if (match && match.score >= 0.24 && scopedWords[match.startIdx] && scopedWords[match.endIdx]) {
            const globalStart = cursor + match.startIdx;
            const globalEnd = cursor + match.endIdx;
            startMs = Math.round(words[globalStart].start * 1000);
            endMs = Math.round(words[globalEnd].end * 1000);
            cursor = Math.max(cursor + 1, globalEnd + 1);
        }

        items.push({ start: startMs, end: endMs, text: line });
    }

    // Second pass: interpolate unmatched lines
    let idx = 0;
    while (idx < items.length) {
        if (items[idx].start === null) {
            let startNullIdx = idx;
            while (idx < items.length && items[idx].start === null) {
                idx++;
            }
            let endNullIdx = idx - 1;

            let prevTimeMs = 0;
            for (let k = startNullIdx - 1; k >= 0; k--) {
                if (items[k].end !== null) {
                    prevTimeMs = items[k].end;
                    break;
                }
            }

            let nextTimeMs = totalMs;
            for (let k = endNullIdx + 1; k < items.length; k++) {
                if (items[k].start !== null) {
                    nextTimeMs = items[k].start;
                    break;
                }
            }

            const interval = Math.max(0, nextTimeMs - prevTimeMs);
            const count = endNullIdx - startNullIdx + 1;
            const step = interval / (count + 1);

            for (let k = startNullIdx; k <= endNullIdx; k++) {
                const offset = k - startNullIdx;
                items[k].start = Math.round(prevTimeMs + step * (offset + 0.1));
                items[k].end = Math.round(prevTimeMs + step * (offset + 0.9));
            }
        } else {
            idx++;
        }
    }

    // Ensure timings are valid and sorted
    let lastEndMs = 0;
    for (let i = 0; i < items.length; i++) {
        let startMs = items[i].start;
        let endMs = items[i].end;
        startMs = clampMs(startMs, 0, Math.max(0, totalMs - 1));
        endMs = clampMs(endMs, startMs + 1, totalMs);
        if (startMs < lastEndMs) startMs = Math.min(lastEndMs, Math.max(0, totalMs - 1));
        if (endMs <= startMs) endMs = Math.min(totalMs, startMs + Math.max(1, Math.round(totalMs / lineCount)));
        lastEndMs = endMs;
        items[i].start = startMs;
        items[i].end = endMs;
    }

    return items;
}

async function generateSrtForAudioScript(opts = {}) {
    const audioPath = opts.audioPath || opts.audio_path;
    const lines = splitScriptLines(opts.scriptText || opts.script_text || '');
    if (!audioPath || !fs.existsSync(audioPath)) throw new Error('缺少有效音频文件，无法重新生成字幕');
    if (lines.length === 0) throw new Error('缺少文案，无法重新生成字幕');

    const gladiaKeys = Array.isArray(opts.gladiaKeys) ? opts.gladiaKeys.filter(Boolean) : [];
    if (gladiaKeys.length === 0) throw new Error('未配置 Gladia API Key，无法重新转录换声后的音频');

    const language = opts.language || 'auto';
    const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
    const transcription = await transcribeClip(audioPath, language, gladiaKeys, cacheDir, opts.force === true);
    const words = flattenWords(transcription.wordTimeInfo);
    const duration = await ffmpegService.getDuration(audioPath).catch(() => {
        const lastWord = words[words.length - 1];
        return lastWord ? lastWord.end : lines.length * 2;
    });
    const srtItems = buildSubtitleItemsFromAudioWords(
        lines,
        words,
        duration,
        Math.max(0.1, Math.min(1, Number(opts.minScore ?? opts.min_score ?? 0.52)))
    );
    const srtPath = opts.srtPath || opts.srt_path || audioPath.replace(/\.[^.]+$/, '_retimed.srt');
    subtitleService.writeSRT(srtItems, srtPath);
    return {
        srt_path: srtPath,
        items_count: srtItems.length,
        recognized_text: transcription.fullText || '',
        transcription_source: transcription.source,
    };
}

function adjustPlanMatchedRange(plan, newStartLine, newEndLine, lines, minScore, duration, leadPad, tailPad) {
    plan.scriptStartLine = newStartLine;
    plan.scriptEndLine = newEndLine;
    const targetText = lines.slice(newStartLine, newEndLine + 1).join('\n');
    plan.scriptText = targetText;
    const wordWindow = findBestWordWindow(plan.words, targetText, minScore * 0.45);
    if (wordWindow) {
        plan.wordStartIdx = wordWindow.startIdx;
        plan.wordEndIdx = wordWindow.endIdx;
        plan.matchedText = wordWindow.matchedText;
        plan.matchScore = wordWindow.score;
        plan.start = Math.max(0, plan.words[wordWindow.startIdx].start - leadPad);
        plan.end = Math.min(duration || plan.words[wordWindow.endIdx].end + tailPad, plan.words[wordWindow.endIdx].end + tailPad);
    } else {
        plan.start = 0;
        plan.end = duration;
    }
}

function generateVisualDiffMarkdown(scriptText, transcriptionText) {
    const DiffMatchPatch = require('diff-match-patch');
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(scriptText, transcriptionText);
    dmp.diff_cleanupSemantic(diffs);
    
    let markdown = '';
    for (const [op, text] of diffs) {
        if (op === 0) {
            markdown += text;
        } else if (op === -1) {
            markdown += `<del style="background-color: #ffeef0; color: #b30000; text-decoration: line-through; padding: 0 4px; border-radius: 2px; font-weight: bold;">${text}</del>`;
        } else if (op === 1) {
            markdown += `<ins style="background-color: #e6ffec; color: #008000; text-decoration: none; padding: 0 4px; border-radius: 2px; font-weight: bold;">${text}</ins>`;
        }
    }
    return markdown;
}

async function autoEditByScript(opts = {}) {
    const clips = (opts.clips || []).filter(p => p && fs.existsSync(p));
    const lines = splitScriptLines(opts.scriptText || opts.script_text || '');
    if (clips.length === 0) throw new Error('缺少有效视频片段');
    if (lines.length === 0) throw new Error('缺少断行文案');

    const clipPathCounts = {};
    for (const c of clips) {
        clipPathCounts[c] = (clipPathCounts[c] || 0) + 1;
    }

    const manualSubtitleMap = opts.manualSubtitleMap || opts.manual_subtitle_map || {};
    const manualTranscripts = opts.manualTranscripts || opts.manual_transcripts || {};
    const gladiaKeys = Array.isArray(opts.gladiaKeys) ? opts.gladiaKeys.filter(Boolean) : [];
    const everyClipHasLocalText = clips.every(clip => manualTranscripts[clip] || manualSubtitleMap[clip]);
    if (gladiaKeys.length === 0 && !everyClipHasLocalText) {
        throw new Error('部分片段没有本地字幕或手动转录，请配置 Gladia API Key 后再分析');
    }

    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const dateStr = `${y}-${m}-${d}_${hh}${mm}`;
    const firstClipName = path.basename(clips[0], path.extname(clips[0]));

    const outputDir = opts.outputDir || opts.output_dir || path.join(path.dirname(clips[0]), `auto_edit_${dateStr}_${firstClipName}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const ignoreMismatch = opts.ignoreMismatch === true || opts.ignore_mismatch === true;
    const language = opts.language || 'auto';
    const leadPad = Math.max(0, Number(opts.leadPad ?? opts.lead_pad ?? 0.04));
    const tailPad = Math.max(0, Number(opts.tailPad ?? opts.tail_pad ?? 0.08));
    const minScore = Math.max(0.1, Math.min(1, Number(opts.minScore ?? opts.min_score ?? 0.52)));
    const forceTranscribe = opts.forceTranscribe === true || opts.force_transcribe === true;
    const burnSubtitles = opts.burnSubtitles === true || opts.burn_subtitles === true;
    const firstResolution = await ffmpegService.getResolution(clips[0]);
    const [sourceWidth, sourceHeight] = String(firstResolution || '').split('x').map(Number);
    const sourceFps = await ffmpegService.getFrameRate(clips[0]);
    const targetWidth = parseInt(opts.targetWidth || opts.target_width || sourceWidth || 1080, 10);
    const targetHeight = parseInt(opts.targetHeight || opts.target_height || sourceHeight || 1920, 10);
    const fps = Number(opts.fps) > 0 ? Number(opts.fps) : (sourceFps || 30);
    const fitMode = opts.fitMode === 'contain' || opts.fit_mode === 'contain' ? 'contain' : 'cover';
    const videoFitFilter = fitMode === 'contain'
        ? `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black`
        : `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}`;
    const crf = parseInt(opts.crf || 18, 10);
    const preset = opts.preset || 'fast';
    const matchMode = opts.matchMode || opts.match_mode || 'script';
    const useLinePerClip = ['line_per_clip', 'one_line_per_clip', 'legacy'].includes(String(matchMode));
    const transitionType = opts.transitionType || opts.transition_type || opts.transition || 'none';
    const transitionDuration = Math.max(0, Math.min(3, Number(opts.transitionDuration ?? opts.transition_duration ?? 0.35) || 0));
    const exportMp3 = opts.exportMp3 !== false && opts.export_mp3 !== false;
    const voiceChangerEnabled = opts.voiceChangerEnabled === true || opts.voice_changer_enabled === true;
    const voiceChangerVoiceId = String(opts.voiceChangerVoiceId || opts.voice_changer_voice_id || '').trim();
    const voiceChangerReplaceAudio = opts.voiceChangerReplaceAudio !== false && opts.voice_changer_replace_audio !== false;
    const voiceChangerModelId = opts.voiceChangerModelId || opts.voice_changer_model_id || 'eleven_multilingual_sts_v2';
    const voiceChangerOutputFormat = opts.voiceChangerOutputFormat || opts.voice_changer_output_format || 'mp3_44100_128';
    const voiceChangerStability = Number(opts.voiceChangerStability ?? opts.voice_changer_stability ?? 0.5);
    const voiceChangerSimilarity = Number(opts.voiceChangerSimilarity ?? opts.voice_changer_similarity ?? 0.75);
    const voiceChangerRemoveNoise = opts.voiceChangerRemoveNoise === true || opts.voice_changer_remove_noise === true;
    const manualAudioPath = String(opts.manualAudioPath || opts.manual_audio_path || '').trim();
    const manualAudioReplace = opts.manualAudioReplace === true || opts.manual_audio_replace === true || Boolean(manualAudioPath);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const emitProgress = (progress) => {
        if (!onProgress) return;
        try {
            onProgress({
                ...progress,
                percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
            });
        } catch (_) { }
    };

    const sessionId = crypto.randomBytes(4).toString('hex');
    const tmpDir = path.join(os.tmpdir(), `videokit_autoedit_${sessionId}`);
    const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
    fs.mkdirSync(tmpDir, { recursive: true });

    const selected = [];
    const tempClips = [];
    const srtItems = [];
    let timelineCursorMs = 0;

    try {
        const plans = [];
        const workflowMode = opts.workflowMode || 'cut_first';
        let rawConcatPath = '';

        const joinWordsSmart = (wordsList) => {
            let text = '';
            for (let idx = 0; idx < wordsList.length; idx++) {
                const w = wordsList[idx];
                if (idx > 0) {
                    const prev = wordsList[idx - 1];
                    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(prev) || /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(w);
                    if (!hasCJK) {
                        text += ' ';
                    }
                }
                text += w;
            }
            return text;
        };

        // 初始化扁平的文案单词列表，记录每个单词所在的视觉行 index
        const scriptWords = [];
        let wordIdx = 0;
        for (let l = 0; l < lines.length; l++) {
            const lineText = lines[l];
            let lineWords;
            if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(lineText)) {
                lineWords = lineText.split('').map(char => char.trim()).filter(Boolean);
            } else {
                lineWords = lineText.split(/\s+/).filter(Boolean);
            }
            for (const w of lineWords) {
                scriptWords.push({
                    raw: w,
                    norm: normalizeText(w),
                    lineIndex: l,
                    wordIndex: wordIdx++
                });
            }
        }
        let globalTranscriptionText = '';
        const isOneToOne = (workflowMode === 'concat_first' || useLinePerClip);

        if (workflowMode === 'concat_first') {
            rawConcatPath = path.join(tmpDir, `raw_concatenated_${sessionId}.mp4`);
            emitProgress({
                percent: 10,
                stage: 'concat_raw',
                message: '正在合并原始视频片段...',
            });
            await ffmpegService.concatClips({
                clips,
                outputPath: rawConcatPath,
                targetWidth,
                targetHeight,
                fps,
                crf,
                preset,
            });

            emitProgress({
                percent: 25,
                stage: 'transcribe',
                message: '正在进行单次语音转录识别...',
            });
            const transcription = await transcribeClip(rawConcatPath, language, gladiaKeys, cacheDir, forceTranscribe);
            globalTranscriptionText = transcription.fullText;
            const words = flattenWords(transcription.wordTimeInfo);
            const duration = await ffmpegService.getDuration(rawConcatPath);

            const clipBoundaries = [];
            let accumulatedTime = 0;
            for (let i = 0; i < clips.length; i++) {
                const dur = await ffmpegService.getDuration(clips[i]) || 0;
                clipBoundaries.push({
                    index: i,
                    start: accumulatedTime,
                    end: accumulatedTime + dur,
                    path: clips[i]
                });
                accumulatedTime += dur;
            }

            const clipWordsMap = Array.from({ length: clips.length }, () => []);

            let wordCursor = 0;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Determine fallback time window for this line
                const totalDuration = duration || accumulatedTime;
                const fallbackStartSec = (totalDuration / lines.length) * i;
                const fallbackEndSec = (totalDuration / lines.length) * (i + 1);

                const scopedWords = words.slice(wordCursor);
                const match = scopedWords.length
                    ? findBestWordWindow(scopedWords, line, Math.max(0.1, minScore * 0.55))
                    : null;

                let matchedWords = [];
                let s_i = 0;
                let e_i = totalDuration;
                let origStartSec = fallbackStartSec;
                let origEndSec = fallbackEndSec;

                if (match && match.score >= 0.30 && scopedWords[match.startIdx] && scopedWords[match.endIdx]) {
                    const globalStart = wordCursor + match.startIdx;
                    const globalEnd = wordCursor + match.endIdx;
                    matchedWords = words.slice(globalStart, globalEnd + 1);
                    s_i = Math.max(0, words[globalStart].start - leadPad);
                    e_i = Math.min(totalDuration, words[globalEnd].end + tailPad);
                    origStartSec = words[globalStart].start;
                    origEndSec = words[globalEnd].end;
                    wordCursor = Math.max(wordCursor + 1, globalEnd + 1);
                } else {
                    // Fallback to all words in the actual clip range
                    matchedWords = words.filter(w => w.start >= fallbackStartSec - 0.05 && w.end <= fallbackEndSec + 0.05);
                    s_i = Math.max(0, fallbackStartSec - leadPad);
                    e_i = Math.min(totalDuration, fallbackEndSec + tailPad);
                }

                // Find which clip overlaps the midpoint of this matched section
                const midPoint = (origStartSec + origEndSec) / 2;
                const matchingClip = clipBoundaries.find(b => midPoint >= b.start && midPoint <= b.end) || clipBoundaries[0];
                const origClipIndex = matchingClip ? matchingClip.index : 0;
                const origClipPath = matchingClip ? matchingClip.path : rawConcatPath;

                if (origClipIndex >= 0 && origClipIndex < clips.length) {
                    clipWordsMap[origClipIndex].push(...matchedWords);
                }

                const matchedText = matchedWords.map(w => w.raw).join(' ');

                const lineWords = scriptWords.filter(w => w.lineIndex === i);
                let lineWordStart = -1;
                let lineWordEnd = -1;
                if (lineWords.length > 0) {
                    lineWordStart = lineWords[0].wordIndex;
                    lineWordEnd = lineWords[lineWords.length - 1].wordIndex;
                }

                plans.push({
                    sourceIndex: origClipIndex,
                    clipPath: rawConcatPath,
                    realClipPath: origClipPath,
                    transcription: {
                        wordTimeInfo: [],
                        fullText: matchedText,
                        source: 'concat_align'
                    },
                    words: matchedWords,
                    duration: totalDuration,
                    scriptStartLine: i,
                    scriptEndLine: i,
                    scriptText: line,
                    scriptWordStart: lineWordStart,
                    scriptWordEnd: lineWordEnd,
                    matchedText,
                    matchScore: matchedWords.length > 0 ? 1.0 : 0.0,
                    start: s_i,
                    end: e_i,
                    origStartSec,
                    origEndSec
                });
            }

            // Emit progress and save individual split files
            for (let i = 0; i < clips.length; i++) {
                const boundary = clipBoundaries[i];
                const clipWords = clipWordsMap[i];
                const clipStatus = clipWords.length > 0 ? 'transcribed' : 'empty';
                
                emitProgress({
                    stage: 'transcribe',
                    clip_index: i,
                    clip_status: clipStatus,
                    clip_error: clipWords.length > 0 ? null : '未获得可用的逐词识别结果',
                    message: `片段 #${i + 1} 语音识别完成 (${clipWords.length > 0 ? '已转录' : '未获得识别结果'})`,
                });

                try {
                    const clipBaseName = path.parse(boundary.path).name;
                    const outTxtPath = path.join(outputDir, `${clipBaseName}_transcription.txt`);
                    const outJsonPath = path.join(outputDir, `${clipBaseName}_transcription.json`);
                    
                    const clipDur = boundary.end - boundary.start;
                    const adjustedWords = clipWords.map(w => {
                        const localStart = w.start - boundary.start;
                        const localEnd = w.end - boundary.start;
                        return {
                            word: w.raw,
                            start: Math.max(0, Math.min(clipDur, localStart)),
                            end: Math.max(0, Math.min(clipDur, localEnd)),
                            score: w.score || 0.99,
                            confidence: w.score || 0.99
                        };
                    });
                    
                    const clipText = adjustedWords.map(w => w.word).join(' ');
                    const clipWordTimeInfo = [{
                        text: clipText,
                        audio_start: 0,
                        audio_end: clipDur,
                        words: adjustedWords
                    }];

                    fs.writeFileSync(outTxtPath, clipText, 'utf-8');
                    fs.writeFileSync(outJsonPath, JSON.stringify(clipWordTimeInfo, null, 2), 'utf-8');
                } catch (writeErr) {
                    console.error(`[自动剪辑] 保存片段 ${boundary.path} 的分拆转录结果到输出目录失败:`, writeErr);
                }
            }
        } else {
            const clipCount = useLinePerClip ? Math.min(clips.length, lines.length) : clips.length;
            emitProgress({
                percent: 5,
                stage: 'start',
                current: 0,
                total: clipCount,
                message: `准备转录 ${clipCount} 个片段`,
            });

            const filteredScriptWords = scriptWords.filter(w => w.norm);
            let scriptCursor = 0;
            const usedScriptRanges = [];

            const overlapWithUsedRanges = (start, end) => {
                if (start === -1 || end === -1 || end < start) return 0;
                let overlap = 0;
                for (const range of usedScriptRanges) {
                    const s = Math.max(start, range.start);
                    const e = Math.min(end, range.end);
                    if (e >= s) overlap += e - s + 1;
                }
                return overlap;
            };

            for (let i = 0; i < clipCount; i++) {
                const clipPath = clips[i];
                emitProgress({
                    percent: 8 + Math.round((i / Math.max(clipCount, 1)) * 42),
                    stage: 'transcribe',
                    current: i + 1,
                    total: clipCount,
                    clip_index: i,
                    clip_status: 'transcribing',
                    message: `正在转录并匹配第 ${i + 1}/${clipCount} 个片段...`,
                });
                let transcription;
                let isFailed = false;
                let errorMsg = null;
                try {
                    const manualText = manualTranscripts[clipPath];
                    if (manualText) {
                        console.log(`[自动剪辑] 使用用户微调的手动转录文本进行匹配: ${manualText}`);
                        transcription = await buildManualTranscription(clipPath, manualText);
                    } else {
                        transcription = await transcribeClip(clipPath, language, gladiaKeys, cacheDir, forceTranscribe, manualSubtitleMap[clipPath]);
                    }
                } catch (err) {
                    console.error(`[自动剪辑] 片段 ${i + 1}/${clipCount} 转录失败:`, err);
                    isFailed = true;
                    errorMsg = err.message || String(err);
                    transcription = {
                        wordTimeInfo: [],
                        fullText: `(转录失败: ${errorMsg})`,
                        source: 'failed'
                    };
                }
                const isCache = transcription.source === 'cache';
                const isTextEmpty = !transcription.fullText || transcription.fullText.trim() === '' || transcription.fullText.startsWith('(转录失败:');
                const emptyMessage = '识别服务未返回有效文字结果，请重新识别';
                let clipStatus = 'transcribed';
                if (isFailed) {
                    clipStatus = 'failed';
                } else if (isTextEmpty) {
                    clipStatus = 'empty';
                } else if (isCache) {
                    clipStatus = 'cached';
                }

                const isManual = ['manual', 'manual_srt', 'manual_txt'].includes(transcription.source);
                console.log(`[自动剪辑] 片段 ${i + 1}/${clipCount}: ${path.basename(clipPath)} (${isFailed ? '转录失败' : (isTextEmpty ? '转录为空' : (isManual ? '手动指定字幕文件' : (isCache ? '命中缓存' : '调用 Gladia API')))})`);
                emitProgress({
                    percent: 8 + Math.round(((i + 0.8) / Math.max(clipCount, 1)) * 42),
                    stage: 'transcribe',
                    current: i + 1,
                    total: clipCount,
                    clip_index: i,
                    clip_status: clipStatus,
                    clip_error: isFailed ? errorMsg : (isTextEmpty ? emptyMessage : null),
                    message: `已处理第 ${i + 1}/${clipCount} 个片段 (${isFailed ? '转录失败' : (isTextEmpty ? '未获得识别结果' : (isCache ? '使用缓存' : '新调用接口'))})`,
                });
                const words = flattenWords(transcription.wordTimeInfo);

                // 保存每个片段的转录结果（.txt 和 .json）到输出文件夹（当前文件夹）
                try {
                    const clipBaseName = path.parse(clipPath).name;
                    const outTxtPath = path.join(outputDir, `${clipBaseName}_transcription.txt`);
                    const outJsonPath = path.join(outputDir, `${clipBaseName}_transcription.json`);
                    fs.writeFileSync(outTxtPath, transcription.fullText || '', 'utf-8');
                    fs.writeFileSync(outJsonPath, JSON.stringify(transcription.wordTimeInfo || [], null, 2), 'utf-8');

                    // 如果转录为空，将提取出来的音频 wav 文件拷贝到输出目录供用户排查声音
                    if (!transcription.wordTimeInfo || transcription.wordTimeInfo.length === 0) {
                        let langCode = 'auto';
                        if (language && language !== 'auto') {
                            langCode = language;
                            for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
                                if (info.name === language || info.code === language) {
                                    langCode = code;
                                    break;
                                }
                            }
                        }
                        const stat = fs.statSync(clipPath);
                        const cacheKey = crypto
                            .createHash('sha1')
                            .update(`${clipPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
                            .digest('hex')
                            .slice(0, 12);
                        const baseName = path.parse(clipPath).name.replace(/[^\w.-]+/g, '_');
                        const cacheWavPath = path.join(cacheDir, `${langCode}_${baseName}_${cacheKey}_autoedit.wav`);
                        if (fs.existsSync(cacheWavPath)) {
                            const outWavPath = path.join(outputDir, `${clipBaseName}_extracted_audio.wav`);
                            fs.copyFileSync(cacheWavPath, outWavPath);
                            console.log(`[自动剪辑] 片段转录为空，已拷贝提取的音频文件到输出目录: ${outWavPath}`);
                        }
                    }
                } catch (writeErr) {
                    console.error(`[自动剪辑] 保存片段 ${clipPath} 的转录结果到输出目录失败:`, writeErr);
                }
                const duration = await ffmpegService.getDuration(clipPath);

                let scriptWordStart = -1;
                let scriptWordEnd = -1;
                let matchedText = '';
                let matchScore = 0;
                let wordStartIdx = -1;
                let wordEndIdx = -1;
                let duplicateOfSourceIndex = -1;
                const matchedWordsArray = [];

                if (words.length > 0) {
                    if (useLinePerClip) {
                        const lineWindow = findBestWordWindow(words, lines[i], minScore);
                        if (lineWindow) {
                            const lineWords = filteredScriptWords.filter(w => w.lineIndex === i);
                            if (lineWords.length > 0) {
                                scriptWordStart = lineWords[0].wordIndex;
                                scriptWordEnd = lineWords[lineWords.length - 1].wordIndex;
                            }
                            matchedText = lineWindow.matchedText;
                            matchScore = lineWindow.score;
                            wordStartIdx = lineWindow.startIdx;
                            wordEndIdx = lineWindow.endIdx;
                        }
                    } else {
                        const clipText = words.map(w => w.norm).join(' ');
                        const currentTranscriptionNorm = normalizeText(transcription.fullText);
                        const duplicatePlan = currentTranscriptionNorm.length >= 12
                            ? plans.find(previous => {
                                const previousNorm = normalizeText(previous.transcription?.fullText);
                                return previousNorm.length >= 12 && scoreCandidate(currentTranscriptionNorm, previousNorm) >= 0.92;
                            })
                            : null;

                        // 仅在没有可重新评分的文案时才继承旧匹配。正常情况下始终重新做
                        // 全局相似度匹配，避免前一个片段的错误结果被后一个重复片段继承。
                        if (duplicatePlan && duplicatePlan.scriptWordStart !== -1 && filteredScriptWords.length === 0) {
                            scriptWordStart = duplicatePlan.scriptWordStart;
                            scriptWordEnd = duplicatePlan.scriptWordEnd;
                            matchedText = duplicatePlan.matchedText;
                            matchScore = duplicatePlan.matchScore;
                            duplicateOfSourceIndex = duplicatePlan.sourceIndex;
                            const clipWindow = findBestWordWindow(words, duplicatePlan.matchedText, minScore * 0.4);
                            wordStartIdx = clipWindow?.startIdx ?? 0;
                            wordEndIdx = clipWindow?.endIdx ?? (words.length - 1);
                            const scriptSlice = filteredScriptWords.filter(word => word.wordIndex >= scriptWordStart && word.wordIndex <= scriptWordEnd);
                            for (let idx = 0; idx < scriptSlice.length; idx++) {
                                const clipIdx = Math.min(wordEndIdx, wordStartIdx + Math.round(idx * Math.max(0, wordEndIdx - wordStartIdx) / Math.max(1, scriptSlice.length - 1)));
                                matchedWordsArray.push({ scriptWordIdx: scriptSlice[idx].wordIndex, clipWordIdx: clipIdx });
                            }
                            console.log(`[自动剪辑] 片段 #${i + 1} 与片段 #${duplicatePlan.sourceIndex + 1} 转录内容重复，继承同一文案区间`);
                        } else {
                        let match = null;
                        let globalStart = -1;
                        let globalEnd = -1;

                        const candidates = [];
                        const pushCandidate = (candidate, offset, source, minAcceptScore, orderBonus = 0) => {
                            if (!candidate || candidate.score < minAcceptScore) return;
                            const start = offset + candidate.startIdx;
                            const end = offset + candidate.endIdx;
                            const length = Math.max(1, end - start + 1);
                            const overlap = overlapWithUsedRanges(start, end);
                            const overlapPenalty = Math.min(0.22, (overlap / length) * 0.22);
                            const rangeAdjustedScore = Number.isFinite(candidate.adjustedScore)
                                ? candidate.adjustedScore
                                : candidate.score - overlapPenalty;
                            candidates.push({
                                match: candidate,
                                globalStart: start,
                                globalEnd: end,
                                source,
                                adjustedScore: rangeAdjustedScore + orderBonus,
                            });
                        };

                        // “已使用”只能作为轻微的消歧因素，不能从候选中排除。否则一段
                        // 100% 重复朗读会被迫匹配到一条只有 30%～40% 的无关文案。
                        const globalMatch = filteredScriptWords.length
                            ? findBestWordWindow(filteredScriptWords, clipText, minScore * 0.45)
                            : null;
                        pushCandidate(globalMatch, 0, 'global', 0.25, 0);

                        const searchSlice = filteredScriptWords.slice(scriptCursor);
                        const cursorMatch = searchSlice.length
                            ? findBestWordWindow(searchSlice, clipText, minScore * 0.50)
                            : null;
                        pushCandidate(cursorMatch, scriptCursor, 'cursor', 0.28, 0.025);

                        if (candidates.length > 0) {
                            candidates.sort((a, b) => {
                                if (Math.abs(b.adjustedScore - a.adjustedScore) > 0.001) {
                                    return b.adjustedScore - a.adjustedScore;
                                }
                                if (Math.abs((b.match.score || 0) - (a.match.score || 0)) > 0.001) {
                                    return (b.match.score || 0) - (a.match.score || 0);
                                }
                                return a.globalStart - b.globalStart;
                            });
                            const best = candidates[0];
                            match = best.match;
                            globalStart = best.globalStart;
                            globalEnd = best.globalEnd;
                            usedScriptRanges.push({ start: globalStart, end: globalEnd });
                            if (globalEnd >= scriptCursor) {
                                scriptCursor = globalEnd + 1;
                            }
                        }

                        if (globalStart !== -1 && globalEnd !== -1) {
                            scriptWordStart = filteredScriptWords[globalStart].wordIndex;
                            scriptWordEnd = filteredScriptWords[globalEnd].wordIndex;
                            matchedText = match.matchedText;
                            matchScore = match.score;

                            const clipWindow = findBestWordWindow(words, matchedText, minScore * 0.45);
                            if (clipWindow) {
                                wordStartIdx = clipWindow.startIdx;
                                wordEndIdx = clipWindow.endIdx;
                                const scriptSlice = filteredScriptWords.slice(globalStart, globalEnd + 1);
                                const clipSlice = words.slice(wordStartIdx, wordEndIdx + 1);
                                
                                const N = scriptSlice.length;
                                const M = clipSlice.length;
                                const dp = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
                                for (let i = 1; i <= N; i++) {
                                    for (let j = 1; j <= M; j++) {
                                        if (scriptSlice[i - 1].norm === clipSlice[j - 1].norm) {
                                            dp[i][j] = dp[i - 1][j - 1] + 1;
                                        } else {
                                            dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                                        }
                                    }
                                }
                                
                                const matchedPairs = [];
                                let i_align = N, j_align = M;
                                while (i_align > 0 && j_align > 0) {
                                    if (scriptSlice[i_align - 1].norm === clipSlice[j_align - 1].norm) {
                                        matchedPairs.push({ scriptIdx: i_align - 1, clipIdx: j_align - 1 });
                                        i_align--;
                                        j_align--;
                                    } else if (dp[i_align - 1][j_align] >= dp[i_align][j_align - 1]) {
                                        i_align--;
                                    } else {
                                        j_align--;
                                    }
                                }
                                matchedPairs.reverse();
                                
                                if (matchedPairs.length > 0) {
                                    for (const pair of matchedPairs) {
                                        matchedWordsArray.push({
                                            scriptWordIdx: scriptSlice[pair.scriptIdx].wordIndex,
                                            clipWordIdx: wordStartIdx + pair.clipIdx
                                        });
                                    }
                                } else {
                                    // Fallback to proportional mapping
                                    for (let idx = 0; idx < N; idx++) {
                                        const cIdx = Math.min(M - 1, Math.round(idx * (M - 1) / Math.max(1, N - 1)));
                                        matchedWordsArray.push({
                                            scriptWordIdx: scriptSlice[idx].wordIndex,
                                            clipWordIdx: wordStartIdx + cIdx
                                        });
                                    }
                                }
                            }
                        }
                        }
                    }
                }

                let start = 0;
                let end = duration || 0;
                const isUniqueClip = clipPathCounts[clipPath] === 1;

                if (wordStartIdx !== -1 && wordEndIdx !== -1 && words[wordStartIdx] && words[wordEndIdx]) {
                    start = Math.max(0, words[wordStartIdx].start - leadPad);
                    end = Math.min(duration || words[wordEndIdx].end + tailPad, words[wordEndIdx].end + tailPad);
                } else if (isUniqueClip && words.length > 0) {
                    start = Math.max(0, words[0].start - leadPad);
                    end = Math.min(duration || words[words.length - 1].end + tailPad, words[words.length - 1].end + tailPad);
                }
                if (!end || end <= start) {
                    end = duration || start + 0.1;
                }

                plans.push({
                    sourceIndex: i,
                    clipPath,
                    transcription,
                    words,
                    duration,
                    scriptWordStart,
                    scriptWordEnd,
                    origScriptWordStart: scriptWordStart,
                    origScriptWordEnd: scriptWordEnd,
                    matchedWordsArray,
                    wordStartIdx,
                    wordEndIdx,
                    matchedText: matchedText || transcription.fullText || '',
                    matchScore,
                    duplicateOfSourceIndex,
                    start,
                    end,
                });
            }
        }

        // 1. 如果是“先剪后合 (常规)”且非“一行对应一个片段”，则对计划按脚本字位置重新排序，确保文案顺序正确
        if (workflowMode !== 'concat_first' && !useLinePerClip) {
            plans.sort((a, b) => {
                const aStart = (a.scriptWordStart !== undefined && a.scriptWordStart !== -1) ? a.scriptWordStart : 999999;
                const bStart = (b.scriptWordStart !== undefined && b.scriptWordStart !== -1) ? b.scriptWordStart : 999999;
                if (aStart !== bStart) return aStart - bStart;
                if ((b.matchScore || 0) !== (a.matchScore || 0)) return (b.matchScore || 0) - (a.matchScore || 0);
                return a.sourceIndex - b.sourceIndex;
            });
        }

        // 2. 初始化所有计划的 scriptStartLine / scriptEndLine（防空隙填充逻辑报错或清除）
        for (const plan of plans) {
            if (workflowMode !== 'concat_first') {
                plan.scriptStartLine = (plan.scriptWordStart !== undefined && plan.scriptWordStart !== -1)
                    ? scriptWords[plan.scriptWordStart].lineIndex
                    : -1;
                plan.scriptEndLine = (plan.scriptWordEnd !== undefined && plan.scriptWordEnd !== -1)
                    ? scriptWords[plan.scriptWordEnd].lineIndex
                    : -1;
            }
        }

        // 3. [已禁用空隙自动填充] 不再强制将未读/丢失的文案单词分配给邻近的片段，而是保留精确匹配区间，并在报告中独立记录丢失文案。
        /*
        if (!isOneToOne && plans.length > 0) {
            const matchedPlans = plans.filter(p => p.scriptWordStart !== -1);
            if (matchedPlans.length > 0) {
                // 填充头部空隙
                if (matchedPlans[0].scriptWordStart > 0) {
                    console.log(`[自动剪辑] 填充头部文案单词空隙: 单词 [0-${matchedPlans[0].scriptWordStart - 1}] 分配给片段 #${matchedPlans[0].sourceIndex + 1}`);
                    matchedPlans[0].scriptWordStart = 0;
                }

                // 填充片段之间的空隙
                for (let i = 0; i < matchedPlans.length - 1; i++) {
                    const currentEnd = matchedPlans[i].scriptWordEnd;
                    const nextStart = matchedPlans[i+1].scriptWordStart;
                    if (nextStart > currentEnd + 1) {
                        console.log(`[自动剪辑] 填充中间文案单词空隙: 单词 [${currentEnd + 1}-${nextStart - 1}] 分配给片段 #${matchedPlans[i].sourceIndex + 1}`);
                        matchedPlans[i].scriptWordEnd = nextStart - 1;
                    }
                }

                // 填充尾部空隙
                const lastIdx = matchedPlans.length - 1;
                if (matchedPlans[lastIdx].scriptWordEnd < scriptWords.length - 1) {
                    console.log(`[自动剪辑] 填充尾部文案单词空隙: 单词 [${matchedPlans[lastIdx].scriptWordEnd + 1}-${scriptWords.length - 1}] 分配给片段 #${matchedPlans[lastIdx].sourceIndex + 1}`);
                    matchedPlans[lastIdx].scriptWordEnd = scriptWords.length - 1;
                }
            }
        }
        */

        // 4. 同步更新对应的 scriptStartLine / scriptEndLine，并将 scriptText 设为精确词级别的匹配文案
        for (const plan of plans) {
            if (workflowMode !== 'concat_first') {
                plan.scriptStartLine = (plan.scriptWordStart !== undefined && plan.scriptWordStart !== -1)
                    ? scriptWords[plan.scriptWordStart].lineIndex
                    : -1;
                plan.scriptEndLine = (plan.scriptWordEnd !== undefined && plan.scriptWordEnd !== -1)
                    ? scriptWords[plan.scriptWordEnd].lineIndex
                    : -1;
                
                if (plan.scriptWordStart !== -1 && plan.scriptWordEnd !== -1) {
                    const sliced = scriptWords.slice(plan.scriptWordStart, plan.scriptWordEnd + 1);
                    let groupedLines = [];
                    let currentLineIdx = -1;
                    let currentLineWords = [];
                    for (const w of sliced) {
                        if (currentLineIdx !== -1 && w.lineIndex !== currentLineIdx) {
                            groupedLines.push(joinWordsSmart(currentLineWords));
                            currentLineWords = [];
                        }
                        currentLineIdx = w.lineIndex;
                        currentLineWords.push(w.raw);
                    }
                    if (currentLineWords.length > 0) {
                        groupedLines.push(joinWordsSmart(currentLineWords));
                    }
                    plan.scriptText = groupedLines.join('\n');
                } else {
                    plan.scriptText = '';
                }
            }
        }

        const unmatchedPlans = plans.filter(p => {
            if (workflowMode === 'concat_first') {
                const hasAnyWords = plans.some(plan => plan.words && plan.words.length > 0);
                return p.scriptStartLine === -1 || !hasAnyWords;
            }
            return p.scriptStartLine === -1 || !p.words || p.words.length === 0;
        });
        if (unmatchedPlans.length > 0) {
            // 在报错中断前，主动向前端发送未成功匹配或转录为空的片段状态更新，确保 UI 显示识别有问题
            for (const p of plans) {
                const isEmpty = !p.words || p.words.length === 0;
                const isUnmatched = p.scriptStartLine === -1;
                if (isEmpty || isUnmatched) {
                    const transcriptionFailed = p.transcription?.source === 'failed';
                    const failureText = String(p.transcription?.fullText || '').replace(/^\(转录失败:\s*|\)$/g, '');
                    emitProgress({
                        stage: 'transcribe',
                        clip_index: p.sourceIndex,
                        clip_status: transcriptionFailed ? 'failed' : (isEmpty ? 'empty' : 'unmatched'),
                        clip_error: transcriptionFailed ? failureText : (isEmpty ? '识别服务未返回文字，请重试' : '未匹配到任何断行文案'),
                        message: `片段 #${p.sourceIndex + 1} ${transcriptionFailed ? '识别失败' : (isEmpty ? '未获得识别文字' : '未匹配到文案')}`,
                    });
                }
            }

            const emptyPlans = unmatchedPlans.filter(p => !p.words || p.words.length === 0);
            const textUnmatchedPlans = unmatchedPlans.filter(p => p.words && p.words.length > 0 && p.scriptStartLine === -1);
            const hasReviewTimeline = Array.isArray(opts.reviewSegments || opts.review_segments) && (opts.reviewSegments || opts.review_segments).length > 0;
            const allowReview = opts.analysisOnly === true || opts.analysis_only === true || hasReviewTimeline;
            if (allowReview) {
                console.warn(`[自动剪辑] ${emptyPlans.length} 个片段转录为空，${textUnmatchedPlans.length} 个片段未匹配文案；保留为审核警告，不阻断分析流程`);
            } else {
                const details = [];
                if (emptyPlans.length) details.push(`未获得识别结果 ${emptyPlans.length} 个: [ ${emptyPlans.map(p => path.basename(p.realClipPath || p.clipPath)).join(', ')} ]`);
                if (textUnmatchedPlans.length) details.push(`已有识别文字但未匹配文案 ${textUnmatchedPlans.length} 个: [ ${textUnmatchedPlans.map(p => path.basename(p.realClipPath || p.clipPath)).join(', ')} ]`);
                throw new Error(`检测到 ${unmatchedPlans.length} 个片段需要处理：\n${details.join('\n')}\n\n请重新转录或先进入快速分析审核。`);
            }
        }

        // === 文案匹配度检测 ===
        const allClipsMatchInfo = [];
        let hasMismatch = false;
        
        const DiffMatchPatch = require('diff-match-patch');
        const dmp = new DiffMatchPatch();

        // Calculate global script and global transcription text
        const globalScript = lines.join('\n');
        let globalGenText = '';
        if (workflowMode === 'concat_first') {
            globalGenText = globalTranscriptionText || '';
        } else {
            globalGenText = plans.map(p => p.transcription.fullText || p.matchedText || '').join(' ');
        }

        const cleanGenGlobal = normalizeText(globalGenText);
        const cleanSourceGlobal = normalizeText(globalScript);
        
        const globalDiffs = dmp.diff_main(cleanGenGlobal, cleanSourceGlobal);
        dmp.diff_cleanupSemantic(globalDiffs);
        let globalEqualLen = 0;
        for (const [op, text] of globalDiffs) {
            if (op === 0) globalEqualLen += text.length;
        }
        const globalMaxLen = Math.max(cleanGenGlobal.length, cleanSourceGlobal.length);
        const globalSimilarity = globalMaxLen === 0 ? 1 : globalEqualLen / globalMaxLen;
        const globalSimPercent = Math.round(globalSimilarity * 100);

        // Global mismatch is triggered if overall similarity is less than 80%
        if (globalSimPercent < 80) {
            hasMismatch = true;
        }

        let anyClipMismatch = false;
        // Populate individual clip match info for reporting and UI dialog
        if (workflowMode === 'concat_first') {
            for (let i = 0; i < plans.length; i++) {
                const plan = plans[i];
                let similarity = 1.0;
                if (plan.scriptText && plan.words && plan.words.length > 0) {
                    const cleanGen = normalizeText(plan.matchedText);
                    const cleanSource = normalizeText(plan.scriptText);
                    const diffs = dmp.diff_main(cleanGen, cleanSource);
                    dmp.diff_cleanupSemantic(diffs);
                    let equalLen = 0;
                    for (const [op, text] of diffs) {
                        if (op === 0) equalLen += text.length;
                    }
                    const maxLen = Math.max(cleanGen.length, cleanSource.length);
                    similarity = maxLen === 0 ? 1 : equalLen / maxLen;
                } else {
                    similarity = 0.0;
                }

                const simPercent = Math.round(similarity * 100);
                const isMismatch = simPercent < 80;
                if (isMismatch) anyClipMismatch = true;

                allClipsMatchInfo.push({
                    clipIndex: i,
                    sourceIndex: plan.sourceIndex,
                    fileName: path.basename(plan.realClipPath || plan.clipPath),
                    clipPath: plan.realClipPath || plan.clipPath,
                    scriptText: plan.scriptText || '',
                    recognizedText: plan.matchedText || '',
                    similarity: simPercent,
                    isMismatch,
                    scriptStartLine: plan.scriptStartLine,
                    scriptEndLine: plan.scriptEndLine,
                    scriptWordStart: plan.scriptWordStart,
                    scriptWordEnd: plan.scriptWordEnd,
                    start: plan.start,
                    end: plan.end
                });
            }
        } else {
            for (let i = 0; i < plans.length; i++) {
                const plan = plans[i];
                let similarity = 1.0;
                if (plan.scriptWordStart !== -1 && plan.words && plan.words.length > 0) {
                    const cleanGen = normalizeText(plan.transcription.fullText || plan.matchedText);
                    const cleanSource = normalizeText(plan.scriptText);
                    const diffs = dmp.diff_main(cleanGen, cleanSource);
                    dmp.diff_cleanupSemantic(diffs);
                    let equalLen = 0;
                    for (const [op, text] of diffs) {
                        if (op === 0) equalLen += text.length;
                    }
                    const maxLen = Math.max(cleanGen.length, cleanSource.length);
                    similarity = maxLen === 0 ? 1 : equalLen / maxLen;
                } else {
                    similarity = 0.0;
                }

                const simPercent = Math.round(similarity * 100);
                const isMismatch = simPercent < 85;
                if (isMismatch) anyClipMismatch = true;

                allClipsMatchInfo.push({
                    clipIndex: i,
                    sourceIndex: plan.sourceIndex,
                    fileName: path.basename(plan.realClipPath || plan.clipPath),
                    clipPath: plan.realClipPath || plan.clipPath,
                    scriptText: plan.scriptText || '',
                    recognizedText: plan.transcription.fullText || plan.matchedText || '',
                    similarity: simPercent,
                    isMismatch,
                    scriptStartLine: plan.scriptWordStart !== -1 ? scriptWords[plan.scriptWordStart].lineIndex : -1,
                    scriptEndLine: plan.scriptWordEnd !== -1 ? scriptWords[plan.scriptWordEnd].lineIndex : -1,
                    scriptWordStart: plan.scriptWordStart,
                    scriptWordEnd: plan.scriptWordEnd,
                    start: plan.start,
                    end: plan.end
                });
            }
        }

        if (anyClipMismatch) {
            hasMismatch = true;
        }

        console.log(`[自动剪辑] 全局文案匹配检测: 相似度为 ${globalSimPercent}% (阈值 80%), 单个片段存在不匹配: ${anyClipMismatch}, 是否触发阻断: ${hasMismatch && !ignoreMismatch}`);

        // 5. 计算视频音频中完全丢失/漏读的文案区块
        const missingBlocksInfo = [];
        const coveredWordIndices = new Set();
        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const matchInfo = allClipsMatchInfo[i];
            const similarity = matchInfo ? matchInfo.similarity : 0;
            // 只有当该片段识别出的发音相似度 >= 50% 时，才认为对应的参考文案字真正被读到了。
            // 否则（如 0% 匹配的错误片段或严重漏读片段），它所指定的参考文案仍然算作“缺失/漏读文案”，放入单独的补充卡片中。
            if (similarity >= 50 && plan.scriptWordStart !== -1 && plan.scriptWordEnd !== -1) {
                for (let w = plan.scriptWordStart; w <= plan.scriptWordEnd; w++) {
                    coveredWordIndices.add(w);
                }
            }
        }

        const missingScriptBlocks = [];
        let currentGap = null;

        for (let idx = 0; idx < scriptWords.length; idx++) {
            if (!coveredWordIndices.has(idx)) {
                if (!currentGap) {
                    currentGap = { start: idx, end: idx };
                } else {
                    currentGap.end = idx;
                }
            } else {
                if (currentGap) {
                    missingScriptBlocks.push(currentGap);
                    currentGap = null;
                }
            }
        }
        if (currentGap) {
            missingScriptBlocks.push(currentGap);
        }

        let blockIndex = 0;
        for (let i = 0; i < missingScriptBlocks.length; i++) {
            const block = missingScriptBlocks[i];
            const blockWords = scriptWords.slice(block.start, block.end + 1);
            const text = joinWordsSmart(blockWords.map(w => w.raw));
            if (normalizeText(text).length === 0) {
                continue; // Skip purely punctuation missing blocks
            }
            const startLine = blockWords[0].lineIndex;
            const endLine = blockWords[blockWords.length - 1].lineIndex;
            missingBlocksInfo.push({
                index: blockIndex++,
                startIdx: block.start,
                endIdx: block.end,
                text,
                startLine,
                endLine
            });
        }
        if (missingBlocksInfo.length > 0) {
            console.log(`[自动剪辑] 检测到全局漏读/缺失的文案区块数量: ${missingBlocksInfo.length}`);
        }

        // Always generate the matching/mismatch report to make it convenient to inspect results
        try {
            let reportContent = '';
            if (hasMismatch) {
                reportContent += `# ⚠️ 视频文案与音频不匹配检测报告 (Mismatch Report)\n\n`;
            } else {
                reportContent += `# ✅ 视频文案与音频匹配成功报告 (Alignment Report)\n\n`;
            }
            reportContent += `生成时间: ${new Date().toLocaleString()}\n\n`;
            
            const globalScriptText = lines.join('\n');
            const diffHtml = generateVisualDiffMarkdown(globalScriptText, globalGenText);

            reportContent += `## 📝 完整文本对照分析 (Full Text Comparison Analysis)\n\n`;
            reportContent += `<details open>\n`;
            reportContent += `<summary><b>🔍 点击展开/折叠 完整对比差异 (Visual Diff)</b></summary>\n\n`;
            reportContent += `> 💡 提示：<del style="background-color: #ffeef0; color: #b30000; text-decoration: line-through; padding: 0 4px; border-radius: 2px;">红色删除线部分</del> 表示**参考文案中有但视频音频漏读/丢失**的内容；\n`;
            reportContent += `> <ins style="background-color: #e6ffec; color: #008000; text-decoration: none; padding: 0 4px; border-radius: 2px;">绿色高亮部分</ins> 表示**实际发音多读或识别出多余**的内容。\n\n`;
            reportContent += `${diffHtml}\n\n`;
            reportContent += `</details>\n\n`;
            
            reportContent += `<details>\n`;
            reportContent += `<summary><b>📖 点击展开/折叠 完整原始参考文案 (Original Script)</b></summary>\n\n`;
            reportContent += `\`\`\`text\n${globalScriptText.trim()}\n\`\`\`\n\n`;
            reportContent += `</details>\n\n`;

            reportContent += `<details>\n`;
            reportContent += `<summary><b>🎙️ 点击展开/折叠 完整实际识别发音 (Transcribed Text)</b></summary>\n\n`;
            reportContent += `\`\`\`text\n${globalGenText.trim()}\n\`\`\`\n\n`;
            reportContent += `</details>\n\n`;
            
            reportContent += `---\n\n`;

            if (workflowMode !== 'concat_first') {
                if (missingBlocksInfo.length > 0) {
                    reportContent += `## ❌ 视频音频中漏读/丢失的文案 (Missing Script Sections)\n\n`;
                    reportContent += `以下文案在所有视频片段的语音中都**没有检测到对应的读音**。您可以选择忽略这些文案，或者为它们补录新的视频片段：\n\n`;
                    for (const b of missingBlocksInfo) {
                        reportContent += `### 🔴 丢失区块 #${b.index + 1} (对应文案行号: ${b.startLine + 1} - ${b.endLine + 1})\n`;
                        reportContent += `> \`\`\`text\n> ${b.text}\n> \`\`\`\n`;
                        reportContent += `- **操作**: [action:add-supplementary-clip|line:${b.startLine}]\n\n`;
                    }
                    reportContent += `---\n\n`;
                } else {
                    reportContent += `## ❌ 视频音频中漏读/丢失的文案 (Missing Script Sections)\n\n`;
                    reportContent += `🟢 没有检测到任何漏读/丢失的文案。\n\n`;
                    reportContent += `---\n\n`;
                }
            }

            if (workflowMode === 'concat_first') {
                reportContent += `说明: 合并后的完整视频转录与总文案相似度为 \`${globalSimPercent}%\`。${hasMismatch ? '🔴 未达到 80% 的匹配阈值或存在片段不匹配。' : '🟢 已达到 80% 的安全匹配阈值。'}\n\n`;
                reportContent += `## 📊 片段对齐分析\n\n`;
                
                const mismatches = allClipsMatchInfo.filter(m => m.isMismatch);
                
                for (const m of allClipsMatchInfo) {
                    reportContent += `### ${m.isMismatch ? '🔴' : '🟢'} 片段 #${m.sourceIndex + 1}: ${m.fileName}\n`;
                    reportContent += `- **视频路径**: \`${m.clipPath}\` [time:${m.start},${m.end}]\n`;
                    reportContent += `- **片段局部匹配度**: \`${m.similarity}%\`\n`;
                    reportContent += `- **应读参考文案**: "${m.scriptText.trim()}"\n`;
                    reportContent += `- **实际识别发音**: "${m.recognizedText.trim() || '(未检测到发音)'}"\n`;
                    if (m.isMismatch) {
                        reportContent += `- **操作**: [action:replace-clip|path:${m.clipPath}|index:${m.sourceIndex}] [action:retranscribe-clip|path:${m.clipPath}|index:${m.sourceIndex}]\n`;
                    }
                    reportContent += `\n`;
                }
                
                if (hasMismatch && mismatches.length > 0) {
                    reportContent += `---\n\n`;
                    reportContent += `## 🤖 Flow 智能体重新生成指令\n\n`;
                    reportContent += `请将下面的指令直接复制并发送给您的 Flow 视频生成智能体：\n\n`;
                    reportContent += `\`\`\`text\n`;
                    reportContent += `请根据以下提示重新生成文案不匹配 of 视频片段，确保视频中的发音与要求完全一致：\n\n`;
                    for (const m of mismatches) {
                        reportContent += `【重制片段 #${m.sourceIndex + 1}】\n`;
                        reportContent += `文件名: ${m.fileName}\n`;
                        reportContent += `要求读的文案: "${m.scriptText.replace(/\r?\n/g, ' ')}"\n\n`;
                    }
                    reportContent += `\`\`\`\n`;
                }
            } else {
                reportContent += `说明: 以下是各个片段识别出的实际发音内容与参考文案对比分析。${hasMismatch ? '⚠️ 部分片段匹配度较低（阈值设定为 85% 相似度，全局低于 80% 触发阻断）。' : '🟢 全片段匹配通过。'}\n\n`;
                reportContent += `---\n\n`;
                reportContent += `## 📊 片段对齐清单\n\n`;
                
                const mismatches = allClipsMatchInfo.filter(m => m.isMismatch);
                for (const m of allClipsMatchInfo) {
                    reportContent += `### ${m.isMismatch ? '🔴' : '🟢'} 片段 #${m.sourceIndex + 1}: ${m.fileName}\n`;
                    reportContent += `- **视频路径**: \`${m.clipPath}\` [time:${m.start},${m.end}]\n`;
                    reportContent += `- **匹配度 (Similarity)**: \`${m.similarity}%\`\n`;
                    reportContent += `- **应读参考文案**:\n  \`\`\`text\n  ${m.scriptText.trim()}\n  \`\`\`\n`;
                    reportContent += `- **视频实际识别**:\n  \`\`\`text\n  ${m.recognizedText.trim() || '(识别服务未返回文字结果)'}\n  \`\`\`\n`;
                    if (m.isMismatch) {
                        reportContent += `- **操作**: [action:replace-clip|path:${m.clipPath}|index:${m.sourceIndex}] [action:retranscribe-clip|path:${m.clipPath}|index:${m.sourceIndex}]\n`;
                    }
                    reportContent += `\n`;
                }
 
                if (hasMismatch && mismatches.length > 0) {
                    reportContent += `---\n\n`;
                    reportContent += `## 🤖 Flow 智能体重新生成指令\n\n`;
                    reportContent += `请将下面的指令直接复制并发送给您的 Flow 视频生成智能体：\n\n`;
                    reportContent += `\`\`\`text\n`;
                    reportContent += `请根据以下提示重新生成文案不匹配的视频片段，确保视频中的发音与要求完全一致：\n\n`;
                    for (const m of mismatches) {
                        reportContent += `【重制片段 #${m.sourceIndex + 1}】\n`;
                        reportContent += `文件名: ${m.fileName}\n`;
                        reportContent += `要求读的文案: "${m.scriptText.replace(/\r?\n/g, ' ')}"\n\n`;
                    }
                    reportContent += `\`\`\`\n`;
                }
            }
 
            const reportPath = path.join(outputDir, 'mismatch_report.md');
            fs.writeFileSync(reportPath, reportContent, 'utf-8');
            console.log(`[自动剪辑] 已在输出文件夹生成匹配报告: ${reportPath}`);
        } catch (reportErr) {
            console.error('[自动剪辑] 生成匹配报告失败:', reportErr);
        }

        const forceMismatch = opts.forceMismatch === true || opts.force_mismatch === true;
        if (opts.analysisOnly === true || opts.analysis_only === true) {
            const normalizedLineCounts = new Map();
            for (const line of lines) {
                const key = normalizeText(line);
                if (key) normalizedLineCounts.set(key, (normalizedLineCounts.get(key) || 0) + 1);
            }
            const analysisSegments = plans.map((plan, index) => {
                const info = allClipsMatchInfo[index] || {};
                const hasDuplicateScript = splitScriptLines(plan.scriptText).some(line => (normalizedLineCounts.get(normalizeText(line)) || 0) > 1);
                const isDuplicateClip = Number.isInteger(plan.duplicateOfSourceIndex) && plan.duplicateOfSourceIndex >= 0;
                return {
                    index: index + 1,
                    source_index: plan.sourceIndex + 1,
                    source: plan.realClipPath || plan.clipPath,
                    script_start_line: Number.isInteger(info.scriptStartLine) && info.scriptStartLine >= 0 ? info.scriptStartLine + 1 : null,
                    script_end_line: Number.isInteger(info.scriptEndLine) && info.scriptEndLine >= 0 ? info.scriptEndLine + 1 : null,
                    script: plan.scriptText || '',
                    recognized_text: plan.transcription.fullText || plan.matchedText || '',
                    matched_text: plan.matchedText || '',
                    match_score: Math.round((plan.matchScore || 0) * 1000) / 1000,
                    similarity: info.similarity || 0,
                    status: info.isMismatch || hasDuplicateScript || isDuplicateClip ? 'warning' : 'ready',
                    ambiguity: isDuplicateClip
                        ? `与原片段 #${plan.duplicateOfSourceIndex + 1} 朗读内容重复，已继承同一文案位置`
                        : (hasDuplicateScript ? '文案中存在重复句，请结合前后顺序确认位置' : ''),
                    duplicate_of_source_index: isDuplicateClip ? plan.duplicateOfSourceIndex + 1 : null,
                    start: plan.start,
                    end: plan.end,
                    duration: Math.round((plan.end - plan.start) * 1000) / 1000,
                    transcription_source: plan.transcription.source,
                    word_timeline: (plan.words || []).map(word => ({
                        word: word.raw,
                        start: word.start,
                        end: word.end,
                    })),
                };
            });
            const projectPath = path.join(outputDir, 'auto_edit_project.json');
            const projectData = {
                version: 1,
                created_at: new Date().toISOString(),
                clips,
                script_text: lines.join('\n'),
                    output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
                missing_blocks: missingBlocksInfo,
                segments: analysisSegments,
            };
            fs.writeFileSync(projectPath, JSON.stringify(projectData, null, 2), 'utf-8');
            return {
                success: true,
                analysis_only: true,
                message: `分析完成: ${analysisSegments.length} 段，请审核后正式导出`,
                output_dir: outputDir,
                report_path: path.join(outputDir, 'mismatch_report.md'),
                project_path: projectPath,
                output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
                missing_blocks: missingBlocksInfo,
                segments: analysisSegments,
            };
        }
        if ((hasMismatch || forceMismatch) && !ignoreMismatch) {
            throw new Error(JSON.stringify({
                code: 'AUTOEDIT_TEXT_MISMATCH',
                mismatches: allClipsMatchInfo,
                missingBlocks: missingBlocksInfo,
                report_path: path.join(outputDir, 'mismatch_report.md'),
                output_dir: outputDir
            }));
        }

        const reviewSegments = Array.isArray(opts.reviewSegments || opts.review_segments) ? (opts.reviewSegments || opts.review_segments) : [];
        const hasReviewedTimeline = reviewSegments.length > 0;
        if (reviewSegments.length > 0) {
            const bySource = new Map(plans.map(plan => [plan.realClipPath || plan.clipPath, plan]));
            const reviewedPlans = [];
            for (const review of reviewSegments) {
                if (review.enabled === false) continue;
                const plan = bySource.get(review.source);
                if (!plan) continue;
                const start = Number(review.start);
                const end = Number(review.end);
                if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= plan.duration + 0.01) {
                    plan.start = start;
                    plan.end = end;
                }
                if (typeof review.script === 'string' && review.script.trim()) plan.scriptText = review.script.trim();
                reviewedPlans.push(plan);
            }
            if (reviewedPlans.length === 0) throw new Error('审核时间线中没有可导出的片段');
            plans.splice(0, plans.length, ...reviewedPlans);
        }

        const coveredLines = new Set();
        let previousCutDuration = 0;
        const wordTimelineTimes = new Array(scriptWords.length).fill(null);

        for (let i = 0; i < plans.length; i++) {
            const plan = plans[i];
            const clipPath = plan.clipPath;
            emitProgress({
                percent: 52 + Math.round((i / Math.max(plans.length, 1)) * 30),
                stage: 'trim',
                current: i + 1,
                total: plans.length,
                message: `正在裁切第 ${i + 1}/${plans.length} 个匹配片段`,
            });

            const cutPath = path.join(tmpDir, `auto_${String(i + 1).padStart(4, '0')}.mp4`);
            const hasAudio = await ffmpegService.hasAudioTrack(clipPath);
            const args = ['-y'];
            args.push('-ss', plan.start.toFixed(3));
            args.push('-to', plan.end.toFixed(3));
            args.push('-i', clipPath);

            const clipSpeeds = opts.clipSpeeds || opts.clip_speeds || {};
            const targetClipPath = plan.realClipPath || clipPath;
            const speed = parseFloat(clipSpeeds[targetClipPath]) || 1.0;
            const vPts = (1.0 / speed).toFixed(5);

            let atempoFilter = '';
            if (speed >= 0.5 && speed <= 2.0) {
                atempoFilter = `atempo=${speed}`;
            } else if (speed > 2.0 && speed <= 4.0) {
                atempoFilter = `atempo=2.0,atempo=${(speed/2.0).toFixed(4)}`;
            } else if (speed < 0.5 && speed >= 0.25) {
                atempoFilter = `atempo=0.5,atempo=${(speed/0.5).toFixed(4)}`;
            } else {
                atempoFilter = `anull`;
            }

            let filterComplex;
            if (hasAudio) {
                filterComplex = `[0:v]setpts=${vPts}*PTS,${videoFitFilter},fps=${fps},setsar=1[v];[0:a]${atempoFilter},aformat=sample_rates=48000:channel_layouts=stereo[a]`;
            } else {
                args.push('-f', 'lavfi', '-i', 'anullsrc=cl=stereo:r=48000');
                filterComplex = `[0:v]setpts=${vPts}*PTS,${videoFitFilter},fps=${fps},setsar=1[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`;
            }

            args.push(
                '-filter_complex', filterComplex,
                '-map', '[v]', '-map', '[a]',
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                '-c:a', 'aac', '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                '-shortest',
                cutPath
            );
            await ffmpegService.runCommand('ffmpeg', args, { timeout: 1800000 });

            const cutDuration = await ffmpegService.getDuration(cutPath) || (plan.end - plan.start);
            tempClips.push(cutPath);

            const boundaryTransitionSec = i > 0
                ? computeAutoEditTransitionSec(previousCutDuration, cutDuration, transitionType, transitionDuration)
                : 0;
            const cutDurationMs = Math.max(1, Math.round(cutDuration * 1000));
            const srtStart = Math.max(0, timelineCursorMs - Math.round(boundaryTransitionSec * 1000));
            const srtEnd = srtStart + cutDurationMs;

            if (hasReviewedTimeline && plan.scriptText) {
                const reviewedLines = splitScriptLines(plan.scriptText);
                const lineMatches = [];
                let wordCursor = 0;
                for (const line of reviewedLines) {
                    const scopedWords = (plan.words || []).slice(wordCursor);
                    const match = scopedWords.length ? findBestWordWindow(scopedWords, line, 0.45) : null;
                    if (!match || !scopedWords[match.startIdx] || !scopedWords[match.endIdx]) {
                        lineMatches.length = 0;
                        break;
                    }
                    const firstWord = scopedWords[match.startIdx];
                    const lastWord = scopedWords[match.endIdx];
                    lineMatches.push({
                        text: line,
                        start: Math.max(srtStart, srtStart + Math.round(((firstWord.start - plan.start) / speed) * 1000)),
                        end: Math.min(srtEnd, srtStart + Math.round(((lastWord.end - plan.start) / speed) * 1000)),
                    });
                    wordCursor += match.endIdx + 1;
                }

                if (lineMatches.length === reviewedLines.length && lineMatches.every(item => item.end > item.start)) {
                    srtItems.push(...lineMatches);
                } else {
                    // 没有可靠逐词定位时仍严格保留用户断行，按每行有效字符数分配片段时长。
                    const weights = reviewedLines.map(line => Math.max(1, normalizeText(line).length));
                    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
                    let cursorMs = srtStart;
                    reviewedLines.forEach((line, lineIndex) => {
                        const isLast = lineIndex === reviewedLines.length - 1;
                        const lineEnd = isLast
                            ? srtEnd
                            : Math.min(srtEnd, cursorMs + Math.round((cutDurationMs * weights[lineIndex]) / totalWeight));
                        srtItems.push({ start: cursorMs, end: Math.max(cursorMs + 50, lineEnd), text: line });
                        cursorMs = lineEnd;
                    });
                }
            }

            if (!hasReviewedTimeline && plan.scriptWordStart !== -1) {
                if (workflowMode === 'concat_first') {
                    const subStartMs = srtStart + Math.round(((plan.origStartSec - plan.start) / speed) * 1000);
                    const subEndMs = srtStart + Math.round(((plan.origEndSec - plan.start) / speed) * 1000);
                    srtItems.push({
                        start: Math.max(0, subStartMs),
                        end: Math.min(srtStart + Math.round(cutDuration * 1000), subEndMs),
                        text: plan.scriptText,
                    });
                } else {
                    // 1. Calculate times for originally matched words
                    if (plan.matchedWordsArray) {
                        for (const item of plan.matchedWordsArray) {
                            const scriptWordIdx = item.scriptWordIdx;
                            const clipWord = plan.words[item.clipWordIdx];
                            if (clipWord) {
                                const startMs = srtStart + Math.round(((clipWord.start - plan.start) / speed) * 1000);
                                const endMs = srtStart + Math.round(((clipWord.end - plan.start) / speed) * 1000);
                                wordTimelineTimes[scriptWordIdx] = {
                                    start: Math.max(srtStart, Math.min(srtEnd, startMs)),
                                    end: Math.max(srtStart, Math.min(srtEnd, endMs))
                                };
                            }
                        }
                    }

                    // 2. Fill in times for unmatched/gap words assigned to this plan
                    const runStart = plan.scriptWordStart;
                    const runEnd = plan.scriptWordEnd;
                    let runIdx = runStart;
                    while (runIdx <= runEnd) {
                        if (wordTimelineTimes[runIdx] === null) {
                            let nullStart = runIdx;
                            while (runIdx <= runEnd && wordTimelineTimes[runIdx] === null) {
                                runIdx++;
                            }
                            let nullEnd = runIdx - 1;
                            
                            let prevTime = srtStart;
                            for (let k = nullStart - 1; k >= runStart; k--) {
                                if (wordTimelineTimes[k] !== null) {
                                    prevTime = wordTimelineTimes[k].end;
                                    break;
                                }
                            }
                            
                            let nextTime = srtEnd;
                            for (let k = nullEnd + 1; k <= runEnd; k++) {
                                if (wordTimelineTimes[k] !== null) {
                                    nextTime = wordTimelineTimes[k].start;
                                    break;
                                }
                            }
                            
                            const durationMs = Math.max(0, nextTime - prevTime);
                            const count = nullEnd - nullStart + 1;
                            const step = durationMs / (count + 1);
                            
                            for (let k = nullStart; k <= nullEnd; k++) {
                                const offset = k - nullStart;
                                wordTimelineTimes[k] = {
                                    start: Math.round(prevTime + step * (offset + 0.1)),
                                    end: Math.round(prevTime + step * (offset + 0.9))
                                };
                            }
                        } else {
                            runIdx++;
                        }
                    }
                }
                const pStartLine = scriptWords[plan.scriptWordStart].lineIndex;
                const pEndLine = scriptWords[plan.scriptWordEnd].lineIndex;
                for (let n = pStartLine; n <= pEndLine; n++) coveredLines.add(n);
            }
            timelineCursorMs = srtEnd;
            previousCutDuration = cutDuration;

            const pStartLine = plan.scriptWordStart !== -1 ? scriptWords[plan.scriptWordStart].lineIndex : -1;
            const pEndLine = plan.scriptWordEnd !== -1 ? scriptWords[plan.scriptWordEnd].lineIndex : -1;

            selected.push({
                index: i + 1,
                source_index: plan.sourceIndex + 1,
                source: plan.realClipPath || clipPath,
                script_start_line: pStartLine !== -1 ? pStartLine + 1 : null,
                script_end_line: pEndLine !== -1 ? pEndLine + 1 : null,
                script: plan.scriptText,
                recognized_text: plan.transcription.fullText || '',
                matched_text: plan.matchedText,
                match_score: Math.round((plan.matchScore || 0) * 1000) / 1000,
                start: plan.start,
                end: plan.end,
                duration: Math.round((plan.end - plan.start) * 1000) / 1000,
                transcription_source: plan.transcription.source,
                word_timeline: (plan.words || []).map(word => ({
                    word: word.raw,
                    start: word.start,
                    end: word.end,
                })),
            });
        }

        if (!hasReviewedTimeline && workflowMode !== 'concat_first') {
            for (let l = 0; l < lines.length; l++) {
                const lineWords = scriptWords.filter(w => w.lineIndex === l);
                if (lineWords.length === 0) continue;
                
                let lineStartMs = null;
                let lineEndMs = null;
                
                for (const w of lineWords) {
                    const t = wordTimelineTimes[w.wordIndex];
                    if (t !== null) {
                        if (lineStartMs === null || t.start < lineStartMs) lineStartMs = t.start;
                        if (lineEndMs === null || t.end > lineEndMs) lineEndMs = t.end;
                    }
                }
                
                if (lineStartMs !== null && lineEndMs !== null) {
                    srtItems.push({
                        start: lineStartMs,
                        end: lineEndMs,
                        text: lines[l]
                    });
                } else {
                    console.log(`[自动剪辑] 字幕行 #${l + 1} (${lines[l]}) 在视频中未匹配到对应的读音，跳过字幕生成`);
                }
            }
        }

        const outputPath = opts.outputPath || opts.output_path || path.join(outputDir, `auto_edit_${sessionId}.mp4`);
        try {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        } catch (e) {
            console.warn(`[AutoEdit] Failed to create directory: ${e.message}`);
        }
        if (tempClips.length === 1) {
            emitProgress({
                percent: 86,
                stage: 'encode',
                current: 1,
                total: 1,
                message: '正在生成最终视频',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', tempClips[0],
                '-vf', `${videoFitFilter},fps=${fps},setsar=1`,
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                '-c:a', 'aac', '-b:a', '192k',
                outputPath,
            ], { timeout: 1800000 });
        } else {
            const useTransitions = transitionType && transitionType !== 'none' && transitionDuration > 0;
            const concatFn = useTransitions ? ffmpegService.concatClipsWithTransitions : ffmpegService.concatClips;
            emitProgress({
                percent: 86,
                stage: 'concat',
                current: tempClips.length,
                total: tempClips.length,
                message: useTransitions ? '正在拼接视频并添加转场' : '正在拼接视频',
            });
            await concatFn({
                clips: tempClips,
                outputPath,
                targetWidth,
                targetHeight,
                fps,
                crf,
                preset,
                transition: transitionType,
                transitionDuration,
                skipNormalization: true,
            });
        }

        const srtPath = outputPath.replace(/\.[^.]+$/, '') + '.srt';
        if (srtItems.length === 0) {
            throw new Error('生成的字幕为空。请检查您的断行文案或尝试在下方调低匹配阈值。');
        }
        emitProgress({
            percent: 92,
            stage: 'subtitle',
            current: srtItems.length,
            total: srtItems.length,
            message: '正在写入最终字幕',
        });

        // 统一对 SRT 字幕条目进行排序并做时间去重重叠调整，从根本上解决字幕一闪一闪的闪烁问题
        srtItems.sort((a, b) => a.start - b.start);
        for (let idx = 1; idx < srtItems.length; idx++) {
            if (srtItems[idx].start < srtItems[idx - 1].end) {
                srtItems[idx - 1].end = srtItems[idx].start;
                if (srtItems[idx - 1].end <= srtItems[idx - 1].start) {
                    srtItems[idx - 1].end = srtItems[idx - 1].start + 50;
                    srtItems[idx].start = srtItems[idx - 1].end;
                    if (srtItems[idx].end <= srtItems[idx].start) {
                        srtItems[idx].end = srtItems[idx].start + 50;
                    }
                }
            }
        }

        subtitleService.writeSRT(srtItems, srtPath);

        let mp3Path = '';
        if (exportMp3 || voiceChangerEnabled) {
            mp3Path = outputPath.replace(/\.[^.]+$/, '_voicechanger.mp3');
            emitProgress({
                percent: 94,
                stage: 'mp3',
                current: 1,
                total: 1,
                message: '正在导出 Voice Changer MP3',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', outputPath,
                '-vn',
                '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2',
                mp3Path,
            ], { timeout: 1800000 });
        }

        let voiceChangedMp3Path = '';
        let voiceChangedVideoPath = '';
        let manualAudioVideoPath = '';
        let finalVideoForSubtitles = outputPath;
        if (voiceChangerEnabled) {
            if (!voiceChangerVoiceId) throw new Error('已开启高级 Voice Changer，但缺少 ElevenLabs Voice ID');
            const elevenlabsKeys = elevenlabsService.loadKeys();
            if (!elevenlabsKeys || elevenlabsKeys.length === 0) throw new Error('未配置 ElevenLabs API Key，无法执行 Voice Changer');

            voiceChangedMp3Path = outputPath.replace(/\.[^.]+$/, '_voicechanged.mp3');
            emitProgress({
                percent: 96,
                stage: 'voice_change',
                current: 1,
                total: 1,
                message: '正在调用 ElevenLabs Voice Changer',
            });
            const voiceSettings = {};
            if (Number.isFinite(voiceChangerStability)) voiceSettings.stability = Math.max(0, Math.min(1, voiceChangerStability));
            if (Number.isFinite(voiceChangerSimilarity)) voiceSettings.similarity_boost = Math.max(0, Math.min(1, voiceChangerSimilarity));
            const { audio } = await elevenlabsService.requestSpeechToSpeechWithRotation(elevenlabsKeys, voiceChangerVoiceId, mp3Path, {
                modelId: voiceChangerModelId,
                outputFormat: voiceChangerOutputFormat,
                voiceSettings,
                removeBackgroundNoise: voiceChangerRemoveNoise,
            });
            fs.writeFileSync(voiceChangedMp3Path, audio);

            if (voiceChangerReplaceAudio) {
                voiceChangedVideoPath = outputPath.replace(/\.[^.]+$/, '_voicechanged.mp4');
                emitProgress({
                    percent: 97,
                    stage: 'replace_audio',
                    current: 1,
                    total: 1,
                    message: '正在替换最终视频声音',
                });
                await ffmpegService.runCommand('ffmpeg', [
                    '-y',
                    '-i', outputPath,
                    '-i', voiceChangedMp3Path,
                    '-map', '0:v:0',
                    '-map', '1:a:0',
                    '-c:v', 'copy',
                    '-c:a', 'aac',
                    '-b:a', '192k',
                    '-shortest',
                    '-movflags', '+faststart',
                    voiceChangedVideoPath,
                ], { timeout: 1800000 });
                finalVideoForSubtitles = voiceChangedVideoPath;
            }
        }

        if (manualAudioReplace) {
            if (!manualAudioPath || !fs.existsSync(manualAudioPath)) throw new Error('已选择手动替换音频，但音频文件不存在');
            manualAudioVideoPath = outputPath.replace(/\.[^.]+$/, '_manualaudio.mp4');
            emitProgress({
                percent: voiceChangerEnabled ? 98 : 96,
                stage: 'manual_replace_audio',
                current: 1,
                total: 1,
                message: '正在用手动音频替换最终视频声音',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y',
                '-i', finalVideoForSubtitles,
                '-i', manualAudioPath,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest',
                '-movflags', '+faststart',
                manualAudioVideoPath,
            ], { timeout: 1800000 });
            finalVideoForSubtitles = manualAudioVideoPath;
        }

        let subtitledPath = '';
        if (burnSubtitles) {
            subtitledPath = finalVideoForSubtitles.replace(/\.[^.]+$/, '_subtitled.mp4');
            emitProgress({
                percent: voiceChangerEnabled ? 98 : 97,
                stage: 'burn',
                current: 1,
                total: 1,
                message: '正在烧录字幕',
            });
            await ffmpegService.runCommand('ffmpeg', [
                '-y', '-i', finalVideoForSubtitles,
                '-vf', `subtitles='${srtAssPath(srtPath)}'`,
                '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
                '-c:a', 'copy',
                subtitledPath,
            ], { timeout: 1800000 });
        }
        emitProgress({
            percent: 100,
            stage: 'done',
            current: selected.length,
            total: selected.length,
            message: '自动剪辑完成',
        });

        return {
            success: true,
            message: `自动剪辑完成: ${selected.length} 段`,
            output_path: outputPath,
            srt_path: srtPath,
            mp3_path: mp3Path,
            voice_changed_mp3_path: voiceChangedMp3Path,
            voice_changed_video_path: voiceChangedVideoPath,
            manual_audio_path: manualAudioPath,
            manual_audio_video_path: manualAudioVideoPath,
            subtitled_path: subtitledPath,
            final_video_path: subtitledPath || manualAudioVideoPath || voiceChangedVideoPath || outputPath,
            output_dir: outputDir,
            report_path: path.join(outputDir, 'mismatch_report.md'),
            used_clip_count: selected.length,
            unused_clip_count: Math.max(0, clips.length - selected.length),
            unused_script_count: Math.max(0, lines.length - coveredLines.size),
            transition_type: transitionType,
            transition_duration: transitionDuration,
            output_settings: { width: targetWidth, height: targetHeight, fps, source: 'first_clip', fit_mode: fitMode },
            segments: selected,
        };
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }
}

module.exports = {
    autoEditByScript,
    generateSrtForAudioScript,
    splitScriptLines,
    normalizeText,
    findBestWordWindow,
    findBestScriptWindowForClip,
    computeAutoEditTransitionSec,
    _test: { scoreCandidate, scoreWordCandidate, transcribeClip },
};
