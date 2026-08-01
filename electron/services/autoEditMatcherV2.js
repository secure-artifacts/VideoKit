const ENGINE_ID = 'multilingual_v2';
const COMPARE_ENGINE_ID = 'compare_v2';
const ENGINE_VERSION = 2;

function normalizeEngine(value) {
    if (value === ENGINE_ID || value === COMPARE_ENGINE_ID) return value;
    return 'legacy';
}

function localeForLanguage(language) {
    const value = String(language || '').trim().toLowerCase();
    return value && value !== 'auto' ? value : 'en';
}

function normalizeToken(value, language = 'en') {
    const locale = localeForLanguage(language);
    let lowered;
    try {
        lowered = String(value || '').normalize('NFKC').toLocaleLowerCase(locale);
    } catch (_) {
        lowered = String(value || '').normalize('NFKC').toLowerCase();
    }
    return lowered
        .replace(/[\p{Pd}'’`´]/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

function segmentWords(text, language = 'en') {
    const source = String(text || '');
    const locale = localeForLanguage(language);
    try {
        const segmenter = new Intl.Segmenter(locale, { granularity: 'word' });
        return Array.from(segmenter.segment(source))
            .filter(item => item.isWordLike)
            .map(item => normalizeToken(item.segment, locale))
            .filter(Boolean);
    } catch (_) {
        return (source.match(/[\p{L}\p{N}]+(?:[\p{Pd}'’`´][\p{L}\p{N}]+)*/gu) || [])
            .map(token => normalizeToken(token, locale))
            .filter(Boolean);
    }
}

function editSimilarity(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = prev[0];
        prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const old = prev[j];
            prev[j] = Math.min(
                prev[j] + 1,
                prev[j - 1] + 1,
                diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            diagonal = old;
        }
    }
    return 1 - prev[b.length] / Math.max(a.length, b.length, 1);
}

function tokenEquivalent(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    if (Math.min(left.length, right.length) < 4) return false;
    const lengthRatio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return lengthRatio >= 0.72 && editSimilarity(left, right) >= 0.78;
}

function tokenLcsLength(left, right) {
    const previous = new Array(right.length + 1).fill(0);
    const current = new Array(right.length + 1).fill(0);
    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            current[j] = tokenEquivalent(left[i - 1], right[j - 1])
                ? previous[j - 1] + 1
                : Math.max(previous[j], current[j - 1]);
        }
        for (let j = 0; j <= right.length; j++) previous[j] = current[j];
    }
    return previous[right.length];
}

function tolerantSimilarity(scriptText, recognizedText, language = 'en') {
    const scriptWords = segmentWords(scriptText, language);
    const recognizedWords = segmentWords(recognizedText, language);
    if (!scriptWords.length || !recognizedWords.length) return 0;

    const lcs = tokenLcsLength(scriptWords, recognizedWords);
    const precision = lcs / recognizedWords.length;
    const recall = lcs / scriptWords.length;
    const wordF1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const compactScript = scriptWords.join('');
    const compactRecognized = recognizedWords.join('');
    if (compactScript === compactRecognized) return 1;
    const compactScore = editSimilarity(compactScript, compactRecognized);
    return Math.max(wordF1, wordF1 * 0.72 + compactScore * 0.28);
}

function findBestCutWindow(words, scriptText, language = 'en') {
    const sourceWords = (words || [])
        .map((word, sourceIndex) => ({ ...word, sourceIndex }))
        .filter(word => (
            word &&
            Number.isFinite(Number(word.start)) &&
            Number.isFinite(Number(word.end)) &&
            Number(word.end) >= Number(word.start) &&
            normalizeToken(word.raw || word.word, language)
        ));
    const targetWords = segmentWords(scriptText, language);
    if (!sourceWords.length || !targetWords.length) return null;

    const minLength = Math.max(1, Math.floor(targetWords.length * 0.45));
    const maxLength = Math.min(
        sourceWords.length,
        Math.max(targetWords.length + 5, Math.ceil(targetWords.length * 1.8))
    );
    let best = null;
    for (let startIdx = 0; startIdx < sourceWords.length; startIdx++) {
        for (let endIdx = startIdx; endIdx < sourceWords.length; endIdx++) {
            const length = endIdx - startIdx + 1;
            if (length > maxLength) break;
            if (length < minLength) continue;

            const candidateWords = sourceWords.slice(startIdx, endIdx + 1);
            const candidateText = candidateWords.map(word => word.raw || word.word).join(' ');
            const similarity = tolerantSimilarity(scriptText, candidateText, language);
            const lengthRatio = Math.min(length, targetWords.length) / Math.max(length, targetWords.length, 1);
            const firstTarget = targetWords[0];
            const lastTarget = targetWords[targetWords.length - 1];
            const firstCandidate = normalizeToken(candidateWords[0].raw || candidateWords[0].word, language);
            const lastCandidate = normalizeToken(candidateWords[candidateWords.length - 1].raw || candidateWords[candidateWords.length - 1].word, language);
            const boundaryScore = (tokenEquivalent(firstTarget, firstCandidate) ? 0.5 : 0) +
                (tokenEquivalent(lastTarget, lastCandidate) ? 0.5 : 0);
            const adjustedScore = similarity * 0.78 + lengthRatio * 0.14 + boundaryScore * 0.08;

            if (!best || adjustedScore > best.adjustedScore ||
                (adjustedScore === best.adjustedScore && length < best.length)) {
                best = {
                    startIdx: candidateWords[0].sourceIndex,
                    endIdx: candidateWords[candidateWords.length - 1].sourceIndex,
                    length,
                    similarity,
                    adjustedScore,
                    matchedText: candidateText,
                };
            }
        }
    }

    return best && best.adjustedScore >= 0.46 ? best : null;
}

function calculateCut(plan = {}, options = {}) {
    const words = Array.isArray(plan.words) ? plan.words : [];
    const scriptText = plan.scriptText || '';
    const language = options.language || 'en';
    const legacyStart = Math.max(0, Number(plan.start) || 0);
    const legacyEnd = Math.max(legacyStart, Number(plan.end) || legacyStart);
    const duration = Math.max(legacyEnd, Number(plan.duration) || legacyEnd);
    const leadPad = Math.max(0, Number(options.leadPad) || 0);
    const tailPad = Math.max(0, Number(options.tailPad) || 0);
    const match = findBestCutWindow(words, scriptText, language);

    if (!match || !words[match.startIdx] || !words[match.endIdx]) {
        return {
            engine: 'legacy_fallback',
            applied: false,
            start: legacyStart,
            end: legacyEnd,
            legacyStart,
            legacyEnd,
            score: 0,
            reason: 'V2 无法可靠定位文案边界，本片段沿用经典切点',
        };
    }

    const firstWord = words[match.startIdx];
    const lastWord = words[match.endIdx];
    const start = Math.max(0, Number(firstWord.start) - leadPad);
    const end = Math.min(duration, Math.max(start + 0.001, Number(lastWord.end) + tailPad));
    return {
        engine: ENGINE_ID,
        applied: true,
        start,
        end,
        legacyStart,
        legacyEnd,
        wordStartIdx: match.startIdx,
        wordEndIdx: match.endIdx,
        score: match.adjustedScore,
        textSimilarity: match.similarity,
        matchedText: match.matchedText,
        startDelta: start - legacyStart,
        endDelta: end - legacyEnd,
        reason: '',
    };
}

function reviewThreshold(wordCount) {
    if (wordCount <= 3) return 0.58;
    if (wordCount <= 7) return 0.68;
    if (wordCount <= 12) return 0.74;
    return 0.78;
}

function confidenceSummary(words) {
    const scores = (words || [])
        .map(word => Number(word.score))
        .filter(score => Number.isFinite(score) && score > 0);
    if (!scores.length) {
        return { available: false, average: 0, reliableRatio: 0 };
    }
    return {
        available: true,
        average: scores.reduce((sum, score) => sum + score, 0) / scores.length,
        reliableRatio: scores.filter(score => score >= 0.72).length / scores.length,
    };
}

function assessSegment({ plan = {}, info = {}, language = 'en' }) {
    const recognizedText = plan.transcription?.fullText || plan.matchedText || info.recognizedText || '';
    const scriptText = plan.scriptText || info.scriptText || '';
    const transcriptionFailed = plan.transcription?.source === 'failed';
    const recognitionEmpty = segmentWords(recognizedText, language).length === 0;
    const scriptUnmatched = plan.scriptStartLine === -1 || !scriptText;
    const scriptWordCount = segmentWords(scriptText, language).length;
    const legacySimilarity = Math.max(0, Math.min(1, Number(info.similarity || 0) / 100));
    const tolerantScore = tolerantSimilarity(scriptText, recognizedText, language);
    const effectiveScore = Math.max(legacySimilarity, tolerantScore);
    const threshold = reviewThreshold(scriptWordCount);
    const confidence = confidenceSummary(plan.words);

    if (transcriptionFailed || recognitionEmpty) {
        return {
            status: 'error',
            verificationLevel: 'service_error',
            effectiveSimilarity: Math.round(effectiveScore * 100),
            threshold: Math.round(threshold * 100),
            confidence,
            issueReason: transcriptionFailed
                ? String(plan.transcription?.error || recognizedText || '转录失败').replace(/^\(转录失败:\s*|\)$/g, '')
                : '识别服务未返回有效文字，无法判断是否漏读',
        };
    }

    if (scriptUnmatched) {
        return {
            status: 'warning',
            verificationLevel: 'review',
            effectiveSimilarity: Math.round(effectiveScore * 100),
            threshold: Math.round(threshold * 100),
            confidence,
            issueReason: '未能可靠定位到断行文案；仅标记待确认，不判定为漏读',
        };
    }

    if (effectiveScore < threshold) {
        const confidenceHint = confidence.available
            ? `，识别词平均置信度 ${Math.round(confidence.average * 100)}%`
            : '，且没有可用的真实逐词置信度';
        return {
            status: 'warning',
            verificationLevel: 'review',
            effectiveSimilarity: Math.round(effectiveScore * 100),
            threshold: Math.round(threshold * 100),
            confidence,
            issueReason: `文案与识别结果存在差异${confidenceHint}；请试听确认，V2 不会据此认定漏读`,
        };
    }

    return {
        status: 'ready',
        verificationLevel: tolerantScore > legacySimilarity + 0.04 ? 'tolerant_match' : 'matched',
        effectiveSimilarity: Math.round(effectiveScore * 100),
        threshold: Math.round(threshold * 100),
        confidence,
        issueReason: '',
    };
}

function assessMissingBlock(block = {}) {
    return {
        ...block,
        status: 'warning',
        verification_level: 'review',
        issue_reason: '识别结果中没有可靠归属，但这也可能是转写或片段边界误差；请试听相邻片段确认',
    };
}

function assessAnalysis({ plans = [], matchInfo = [], missingBlocks = [], language = 'en' }) {
    const segments = plans.map((plan, index) => assessSegment({
        plan,
        info: matchInfo[index] || {},
        language,
    }));
    return {
        engine: ENGINE_ID,
        version: ENGINE_VERSION,
        segments,
        missingBlocks: missingBlocks.map(assessMissingBlock),
        hasReviewWarnings: segments.some(item => item.status !== 'ready') || missingBlocks.length > 0,
        blocksExport: false,
    };
}

module.exports = {
    ENGINE_ID,
    COMPARE_ENGINE_ID,
    ENGINE_VERSION,
    normalizeEngine,
    segmentWords,
    tolerantSimilarity,
    findBestCutWindow,
    calculateCut,
    confidenceSummary,
    assessSegment,
    assessMissingBlock,
    assessAnalysis,
};
