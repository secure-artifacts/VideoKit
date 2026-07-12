/**
 * IPC API 路由器
 * 将所有前端 API 调用路由到对应的 Node.js 服务
 * 替代 Python Flask 后端的所有 HTTP 端点
 */
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// 服务模块
const ffmpegService = require('./services/ffmpeg');
const elevenlabsService = require('./services/elevenlabs');
const settingsService = require('./services/settings');
const elevenlabsAuth = require('./services/elevenlabsAuth');
const subtitleService = require('./services/subtitle');
const fcpxmlService = require('./services/fcpxml');

const ytdlpService = require('./services/ytdlp');
const gladiaService = require('./services/gladia');
const imageClassifyService = require('./services/imageClassify');
const workflowService = require('./services/workflow');
const subtitleUtils = require('./services/subtitleUtils');
const { audioSubtitleSearchDifferentStrong } = require('./services/subtitleAlignment');
const wav2lipService = require('./services/wav2lip');
const geminiService = require('./services/gemini');
const templateService = require('./services/templates');
const autoEditService = require('./services/autoEdit');

function normalizeNumbers(text) {
    if (!text) return '';
    let res = String(text);
    // English number words
    const engNums = {
        'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
        'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9', 'ten': '10'
    };
    for (const [word, num] of Object.entries(engNums)) {
        res = res.replace(new RegExp(`\\b${word}\\b`, 'gi'), num);
    }
    // Chinese number words
    const cnNums = {
        '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4',
        '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'
    };
    for (const [word, num] of Object.entries(cnNums)) {
        res = res.replace(new RegExp(word, 'g'), num);
    }
    return res;
}

function normalizeForStrictTextMatch(text) {
    let clean = String(text || '')
        .toLowerCase()
        .normalize('NFKC');
    clean = normalizeNumbers(clean);
    return clean.replace(/[^\p{L}\p{N}]/gu, '');
}


function parseSourceTextCandidates(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

function getCandidateSourceText(candidate) {
    if (typeof candidate === 'string') return candidate;
    if (!candidate || typeof candidate !== 'object') return '';
    return candidate.source_text ?? candidate.sourceText ?? candidate.text ?? '';
}

function getCandidateTranslateText(candidate) {
    if (!candidate || typeof candidate !== 'object') return '';
    return candidate.translate_text ?? candidate.translateText ?? candidate.translation ?? '';
}

function buildAudioCacheKey(filePath) {
    const resolved = path.resolve(filePath);
    let statPart = '';
    try {
        const stat = fs.statSync(resolved);
        statPart = `${stat.size}:${stat.mtimeMs}`;
    } catch {
        statPart = 'missing';
    }
    return crypto.createHash('md5').update(`${resolved}:${statPart}`).digest('hex').slice(0, 12);
}

function pickExactSourceTextCandidate(recognizedText, candidates) {
    const normalizedRecognized = normalizeForStrictTextMatch(recognizedText);
    if (!normalizedRecognized || candidates.length === 0) return null;

    const matches = [];
    candidates.forEach((candidate, index) => {
        const sourceText = getCandidateSourceText(candidate);
        if (!sourceText) return;
        if (normalizeForStrictTextMatch(sourceText) === normalizedRecognized) {
            matches.push({
                index,
                candidate,
                sourceText,
                translateText: getCandidateTranslateText(candidate),
            });
        }
    });

    if (matches.length === 0) return null;
    if (matches.length > 1) {
        const uniqueSourceTexts = new Set(matches.map(m => normalizeForStrictTextMatch(m.sourceText)));
        const uniqueTranslateTexts = new Set(matches.map(m => normalizeForStrictTextMatch(m.translateText || '')));
        if (uniqueSourceTexts.size === 1 && uniqueTranslateTexts.size === 1) {
            console.warn(`[字幕对齐] 自动匹配文案有 ${matches.length} 条重复完全一致候选，使用第一条`);
            return matches[0];
        }
        const err = new Error(`自动匹配文案失败: 有 ${matches.length} 条文案完全一致，无法确定唯一文案`);
        err.code = 'AUTO_SOURCE_MATCH_AMBIGUOUS';
        throw err;
    }
    return matches[0];
}

function buildRecognizedText(generationSubtitleArray, fallbackText = '') {
    if (!Array.isArray(generationSubtitleArray)) return fallbackText || '';
    return generationSubtitleArray.map(p => {
        if (p.text) return p.text;
        if (Array.isArray(p.words)) return p.words.map(w => w.word).join(' ');
        return '';
    }).filter(Boolean).join('\n') || fallbackText || '';
}

async function runAutoEditByScript(data = {}, progressSender = null) {
    const clips = Array.isArray(data.clips) ? data.clips : (Array.isArray(data.files) ? data.files : []);
    if (clips.length === 0) throw new Error('缺少视频片段');
    if (!data.script_text && !data.scriptText) throw new Error('缺少断行文案');

    const gladiaKeysData = settingsService.loadGladiaKeys();
    let gladiaKeys = gladiaKeysData.keys || [];
    if (data.gladia_keys) {
        if (Array.isArray(data.gladia_keys)) {
            gladiaKeys = data.gladia_keys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
        } else if (typeof data.gladia_keys === 'string') {
            try {
                const parsed = JSON.parse(data.gladia_keys);
                if (Array.isArray(parsed)) {
                    gladiaKeys = parsed.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
                }
            } catch {}
        }
    }

    return await autoEditService.autoEditByScript({
        clips,
        ignore_mismatch: data.ignore_mismatch === true || data.ignore_mismatch === 'true',
        scriptText: data.script_text || data.scriptText,
        outputDir: data.output_dir,
        outputPath: data.output_path,
        language: data.language || 'auto',
        matchMode: data.match_mode || data.matchMode,
        workflowMode: data.workflow_mode || data.workflowMode || 'cut_first',
        gladiaKeys,
        leadPad: data.lead_pad,
        tailPad: data.tail_pad,
        minScore: data.min_score,
        burnSubtitles: data.burn_subtitles,
        exportMp3: data.export_mp3,
        voiceChangerEnabled: data.voice_changer_enabled,
        voiceChangerVoiceId: data.voice_changer_voice_id,
        voiceChangerReplaceAudio: data.voice_changer_replace_audio,
        voiceChangerModelId: data.voice_changer_model_id,
        voiceChangerOutputFormat: data.voice_changer_output_format,
        voiceChangerStability: data.voice_changer_stability,
        voiceChangerSimilarity: data.voice_changer_similarity,
        voiceChangerRemoveNoise: data.voice_changer_remove_noise,
        manualAudioPath: data.manual_audio_path,
        manualAudioReplace: data.manual_audio_replace,
        forceTranscribe: data.force_transcribe,
        transitionType: data.transition_type,
        transitionDuration: data.transition_duration,
        targetWidth: data.target_width,
        targetHeight: data.target_height,
        fps: data.fps,
        crf: data.crf,
        preset: data.preset,
        manualSubtitleMap: data.manual_subtitle_map,
        manualTranscripts: data.manual_transcripts || data.manualTranscripts,
        forceMismatch: data.force_mismatch === true || data.force_mismatch === 'true',
        clipSpeeds: data.clip_speeds || {},
        analysisOnly: data.analysis_only === true || data.analysis_only === 'true',
        reviewSegments: data.review_segments || data.reviewSegments || [],
        fitMode: data.fit_mode || data.fitMode || 'cover',
        onProgress: progressSender,
    });
}

function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function buildWordCharTimeline(generationSubtitleArray) {
    let text = '';
    const charTimes = [];
    for (const segment of generationSubtitleArray || []) {
        for (const word of (segment.words || [])) {
            const normalized = normalizeForStrictTextMatch(word.word || '');
            if (!normalized) continue;
            const start = finiteNumber(word.start) ?? finiteNumber(segment.audio_start);
            const end = finiteNumber(word.end) ?? finiteNumber(segment.audio_end);
            if (start === null || end === null) continue;
            for (let i = 0; i < normalized.length; i++) {
                text += normalized[i];
                charTimes.push({ start, end });
            }
        }
    }
    return { text, charTimes };
}

function findSubtitleTextTime(text, timeline, fromEnd = false) {
    const needle = normalizeForStrictTextMatch(text);
    if (!needle || !timeline.text || needle.length > timeline.text.length) return null;
    const index = fromEnd ? timeline.text.lastIndexOf(needle) : timeline.text.indexOf(needle);
    if (index < 0) return null;
    const first = timeline.charTimes[index];
    const last = timeline.charTimes[index + needle.length - 1];
    if (!first || !last) return null;
    return { start: first.start, end: last.end, index };
}

function getGlobalVoiceBounds(generationSubtitleArray) {
    let first = null;
    let last = null;
    for (const segment of generationSubtitleArray || []) {
        for (const word of (segment.words || [])) {
            const start = finiteNumber(word.start) ?? finiteNumber(segment.audio_start);
            const end = finiteNumber(word.end) ?? finiteNumber(segment.audio_end);
            if (start === null || end === null) continue;
            if (!first) first = { start, end };
            last = { start, end };
        }
    }
    return first && last ? { start: first.start, end: last.end } : null;
}

function calibrateSrtTimingFromWordTimeline(sourceSrtPath, srtPaths, generationSubtitleArray) {
    if (!sourceSrtPath || !fs.existsSync(sourceSrtPath)) return null;

    const items = subtitleService.parseSRT(fs.readFileSync(sourceSrtPath, 'utf-8'));
    if (items.length < 2) return null;

    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const oldStart = firstItem.start / 1000;
    const oldEnd = lastItem.end / 1000;
    const oldSpan = oldEnd - oldStart;
    if (oldSpan < 1) return null;

    const timeline = buildWordCharTimeline(generationSubtitleArray);
    const firstMatch = findSubtitleTextTime(firstItem.text, timeline, false);
    const lastMatch = findSubtitleTextTime(lastItem.text, timeline, true);
    const voiceBounds = getGlobalVoiceBounds(generationSubtitleArray);

    const targetStart = firstMatch?.start ?? voiceBounds?.start;
    const targetEnd = lastMatch?.end ?? voiceBounds?.end;
    if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd)) return null;

    const targetSpan = targetEnd - targetStart;
    if (targetSpan < 1) return null;

    const scale = targetSpan / oldSpan;
    const startDelta = targetStart - oldStart;
    const endDelta = targetEnd - oldEnd;
    const shouldCalibrate = Math.abs(startDelta) >= 0.15 || Math.abs(endDelta) >= 0.25 || Math.abs(scale - 1) >= 0.01;
    if (!shouldCalibrate) {
        return {
            applied: false,
            reason: '字幕首尾与识别时间轴基本一致',
            start_delta: startDelta,
            end_delta: endDelta,
            scale,
        };
    }

    const uniqueSrtPaths = [...new Set((srtPaths || []).filter(p => p && p.toLowerCase().endsWith('.srt') && fs.existsSync(p)))];
    for (const srtPath of uniqueSrtPaths) {
        const currentItems = subtitleService.parseSRT(fs.readFileSync(srtPath, 'utf-8'));
        const shifted = currentItems.map((item) => {
            const newStart = Math.max(0, Math.round((targetStart + ((item.start / 1000) - oldStart) * scale) * 1000));
            const newEnd = Math.max(newStart + 1, Math.round((targetStart + ((item.end / 1000) - oldStart) * scale) * 1000));
            return { ...item, start: newStart, end: newEnd };
        });
        subtitleService.writeSRT(shifted, srtPath);
    }

    console.log(`[字幕对齐] 已自动校准 SRT 时间轴: start=${startDelta.toFixed(3)}s end=${endDelta.toFixed(3)}s scale=${scale.toFixed(5)}`);
    return {
        applied: true,
        start_delta: startDelta,
        end_delta: endDelta,
        scale,
        first_match: !!firstMatch,
        last_match: !!lastMatch,
        files: uniqueSrtPaths,
    };
}

/**
 * 注册所有 IPC API 路由
 */
function registerAPIHandlers() {
    // ==================== 通用 API 调用接口 ====================
    ipcMain.handle('api-call', async (event, endpoint, data) => {
        try {
            const result = await routeAPI(endpoint, data || {}, (progress) => {
                try {
                    event.sender.send(endpoint === 'subtitle/generate' ? 'subtitle-progress' : 'auto-edit-progress', progress);
                } catch (_) { }
            });
            return { success: true, data: result };
        } catch (error) {
            const rawMsg = String(error.message || 'Unknown error');
            const safeMsg = (rawMsg.includes('AUTOEDIT_TEXT_MISMATCH') || rawMsg.includes('TEXT_MISMATCH'))
                ? rawMsg
                : rawMsg.replace(/[a-zA-Z0-9_-]{20,}/g, (m) => /^(AUTO_SOURCE_MATCH_NOT_FOUND|AUTO_SOURCE_MATCH_REQUIRED)$/.test(m) ? m : '***');
            console.error(`[API Error] ${endpoint}: request failed`);
            return { success: false, error: safeMsg };
        }
    });

    // ==================== 文件上传（需要特殊处理 Buffer） ====================
    ipcMain.handle('api-upload', async (event, endpoint, fileBuffer, fileName, formData) => {
        try {
            const result = await routeUpload(endpoint, fileBuffer, fileName, formData || {});
            return { success: true, data: result };
        } catch (error) {
            const rawMsg = String(error.message || 'Unknown error');
            const safeMsg = (rawMsg.includes('AUTOEDIT_TEXT_MISMATCH') || rawMsg.includes('TEXT_MISMATCH'))
                ? rawMsg
                : rawMsg.replace(/[a-zA-Z0-9_-]{20,}/g, (m) => /^(AUTO_SOURCE_MATCH_NOT_FOUND|AUTO_SOURCE_MATCH_REQUIRED)$/.test(m) ? m : '***');
            console.error(`[Upload Error] ${endpoint}: request failed`);
            return { success: false, error: safeMsg };
        }
    });
}

/**
 * API 路由分发
 */
async function routeAPI(endpoint, data, progressSender = null) {
    // 去除前导斜杠
    const ep = endpoint.replace(/^\/?(api\/)?/, '');

    switch (ep) {
        // ==================== 健康检查 ====================
        case 'health':
            return { status: 'ok', uptime: process.uptime(), backend: 'nodejs' };

        // ==================== 设置 ====================
        case 'settings/gladia-keys':
            if (data._method === 'GET') return settingsService.loadGladiaKeys();
            settingsService.saveGladiaKeys(data);
            return { message: '保存成功' };

        case 'settings/gemini-keys':
            if (data._method === 'GET') return settingsService.loadGeminiKeys();
            settingsService.saveGeminiKeys(data);
            return { message: '保存成功' };

        case 'settings/elevenlabs':
            if (data._method === 'GET') return settingsService.loadElevenLabsSettings();
            return settingsService.saveElevenLabsSettings(data);

        case 'settings/elevenlabs-keys-status':
            if (data._method === 'GET') return { keys: settingsService.loadElevenLabsKeysWithStatus() };
            settingsService.saveElevenLabsKeysWithStatus(data.keys || data);
            return { message: '保存成功' };

        case 'settings/replace-rules':
            if (data._method === 'GET') return settingsService.loadReplaceRules();
            settingsService.saveReplaceRules(data);
            return { message: '保存成功' };

        case 'languages':
            return { languages: settingsService.getLanguages() };

        // ==================== 文件操作 ====================
        case 'open-folder':
            return await settingsService.openFolder(data.path);

        case 'media/rename-original-clips': {
            const clips = data.clips || []; // array of { source, index }
            const renamed = [];
            const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');

            for (const item of clips) {
                const source = item.source;
                const index = parseInt(item.index, 10);
                if (!source || isNaN(index)) continue;
                if (!fs.existsSync(source)) {
                    console.warn(`[Rename] File not found: ${source}`);
                    continue;
                }

                try {
                    const stat = fs.statSync(source);
                    const dir = path.dirname(source);
                    const base = path.basename(source);
                    const extName = path.extname(source);

                    // Strip existing digits-hyphen prefix if present
                    const cleanBase = base.replace(/^\d+-/, '');
                    const padIndex = String(index).padStart(2, '0');
                    const newBaseName = `${padIndex}-${path.parse(cleanBase).name}`;
                    const newBase = `${newBaseName}${extName}`;
                    const newPath = path.join(dir, newBase);

                    if (source !== newPath) {
                        // Compute cache keys before renaming
                        const oldBaseName = path.parse(source).name.replace(/[^\w.-]+/g, '_');
                        const sanitizedNewBaseName = newBaseName.replace(/[^\w.-]+/g, '_');
                        
                        const oldCacheKey = crypto
                            .createHash('sha1')
                            .update(`${source}|${stat.size}|${Math.floor(stat.mtimeMs)}`)
                            .digest('hex')
                            .slice(0, 12);
                            
                        // Perform the file rename
                        fs.renameSync(source, newPath);
                        renamed.push({ oldPath: source, newPath: newPath });
                        console.log(`[Rename] Renamed file: ${base} -> ${newBase}`);

                        // Get updated stat to compute new cache key
                        const postStat = fs.statSync(newPath);
                        const newCacheKey = crypto
                            .createHash('sha1')
                            .update(`${newPath}|${postStat.size}|${Math.floor(postStat.mtimeMs)}`)
                            .digest('hex')
                            .slice(0, 12);

                        // Rename associated cache files
                        if (fs.existsSync(cacheDir)) {
                            const cacheFiles = fs.readdirSync(cacheDir);
                            for (const f of cacheFiles) {
                                if (f.includes(`_${oldCacheKey}_autoedit.`)) {
                                    const suffix = `_${oldBaseName}_${oldCacheKey}_autoedit.`;
                                    const idx = f.indexOf(suffix);
                                    if (idx !== -1) {
                                        const langCode = f.substring(0, idx);
                                        const ext = f.split('.').pop();
                                        const newCacheFileName = `${langCode}_${sanitizedNewBaseName}_${newCacheKey}_autoedit.${ext}`;
                                        const oldCacheFilePath = path.join(cacheDir, f);
                                        const newCacheFilePath = path.join(cacheDir, newCacheFileName);
                                        try {
                                            if (fs.existsSync(oldCacheFilePath)) {
                                                fs.renameSync(oldCacheFilePath, newCacheFilePath);
                                                console.log(`[Cache Rename] Renamed cache file: ${f} -> ${newCacheFileName}`);
                                            }
                                        } catch (cacheErr) {
                                            console.error(`[Cache Rename] Failed to rename cache file ${f}: ${cacheErr.message}`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Rename] Failed to rename ${source}: ${err.message}`);
                }
            }
            return { success: true, renamed };
        }

        // ==================== ElevenLabs ====================
        case 'elevenlabs/web-login':
            elevenlabsAuth.openElevenLabsAuthWindow();
            return { message: '登录页面已打开' };

        case 'elevenlabs/web-logout':
            await elevenlabsAuth.clearElevenLabsSession();
            return { message: '网页凭证已清除' };

        case 'elevenlabs/web-status': {
            const data = elevenlabsService.loadSettings();
            const hasToken = !!(data.web_token && (data.web_token.authorization || data.web_token.xiApiKey || data.web_token.cookie));
            return { hasToken, tokenData: data.web_token };
        }

        case 'elevenlabs/web-token-manual': {
            // 手动粘贴 Token
            const settingsData = elevenlabsService.loadSettings();
            const tokenData = {};
            if (data.authorization) tokenData.authorization = data.authorization;
            if (data.xiApiKey) tokenData.xiApiKey = data.xiApiKey;
            if (data.cookie) tokenData.cookie = data.cookie;
            if (!tokenData.authorization && !tokenData.xiApiKey) {
                return { success: false, message: '请至少提供 Authorization Token 或 xi-api-key' };
            }
            settingsData.web_token = tokenData;
            // 关键：同时激活 web token 模式，否则 loadKeys() 不会把它加入轮询池
            settingsData.use_web_token = true;
            settingsData.web_token_enabled = true;
            settingsData.web_token_manual_disabled = false;
            settingsData.web_token_auto_disabled = false;
            elevenlabsService.saveSettings(settingsData);
            console.log('[ElevenLabs] 手动保存 Web Token 成功，已自动启用 web token 模式');

            // 验证 Token 是否有效
            try {
                const quota = await elevenlabsService.getQuota('__WEB_TOKEN__');
                const remaining = (quota.limit || 0) - (quota.usage || 0);
                return { success: true, message: `✅ Token 已保存并验证成功 (剩余额度: ${remaining.toLocaleString()})` };
            } catch (verifyErr) {
                // Token 保存了但验证失败，提醒用户
                return { success: true, message: `⚠️ Token 已保存，但验证失败: ${verifyErr.message}。请检查 Token 是否过期。` };
            }
        }

        case 'elevenlabs/voices': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) return { voices: [], error: '未配置 API Key' };
            // 依次尝试所有可用 Key，遇到 401 自动停用并切换下一个
            let lastError = null;
            for (let i = 0; i < keys.length; i++) {
                const apiKey = keys[i];
                try {
                    // Web Token 默认启用扩展模式；也允许前端显式请求社区热门音色。
                    const extended = data.extended === true || data.include_shared === true || apiKey === '__WEB_TOKEN__';
                    const voices = await elevenlabsService.getVoices(apiKey, extended);
                    return { voices };
                } catch (e) {
                    lastError = e;
                    const msg = (e.message || '').toLowerCase();
                    // 401/auth 错误 → 自动停用这把 Key，尝试下一把
                    if (msg.includes('401') || msg.includes('invalid') || msg.includes('unauthorized')) {
                        console.log(`[ElevenLabs] Key${i + 1} 获取音色失败(auth)，自动停用并切换下一个`);
                        try { elevenlabsService.setKeyEnabled(apiKey, false, 'auth'); } catch {}
                        continue;
                    }
                    // 其他错误也尝试下一把
                    console.log(`[ElevenLabs] Key${i + 1} 获取音色失败: ${e.message}，尝试下一个`);
                }
            }
            return { voices: [], error: lastError ? lastError.message : '所有 Key 均失败' };
        }

        case 'elevenlabs/search': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) return { voices: [], error: '未配置 API Key' };
            const apiKey = elevenlabsService.selectKey(keys, data.key_index);
            const voices = await elevenlabsService.searchVoices(apiKey, data.search_term);
            return { voices };
        }

        case 'elevenlabs/add-voice': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) throw new Error('未配置 API Key');
            const apiKey = elevenlabsService.selectKey(keys, data.key_index);
            return await elevenlabsService.addVoice(apiKey, data.public_voice_id, data.name || 'My Voice', data.auto_delete !== false);
        }

        case 'elevenlabs/delete-voice': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) throw new Error('未配置 API Key');
            const apiKey = elevenlabsService.selectKey(keys, data.key_index);
            return await elevenlabsService.deleteVoice(apiKey, data.voice_id);
        }

        case 'elevenlabs/quota': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) return { usage: -1, limit: -1, error: '未配置 API Key' };
            const apiKey = elevenlabsService.selectKey(keys, data.key_index);
            return await elevenlabsService.getQuota(apiKey);
        }

        case 'elevenlabs/all-quotas':
            return await elevenlabsService.getAllQuotas();

        case 'elevenlabs/tts': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) throw new Error('未配置 API Key');
            if (!data.text || !data.voice_id) throw new Error('缺少必需参数');

            let stabilityVal = parseFloat(data.stability || 0.5);
            if (stabilityVal > 1) stabilityVal /= 100;
            stabilityVal = Math.max(0, Math.min(1, stabilityVal));

            const { audio, usedKey } = await elevenlabsService.requestTTSWithRotation(
                keys, data.voice_id, data.text,
                data.model_id || 'eleven_multilingual_v2',
                stabilityVal,
                data.output_format || 'mp3_44100_128',
                data.key_index
            );

            let savePath = data.save_path;
            if (!savePath) {
                savePath = elevenlabsService.buildTTSSavePath(data.text, data.output_format || 'mp3_44100_128', 'tts');
            }
            fs.writeFileSync(savePath, audio);
            return { message: '生成成功', file_path: savePath, used_key: usedKey };
        }

        case 'elevenlabs/tts-batch': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) throw new Error('未配置 API Key');
            const items = data.items || [];
            if (items.length === 0) throw new Error('缺少生成项目');

            const modelId = data.model_id || 'eleven_multilingual_v2';
            let stabilityVal = parseFloat(data.stability || 0.5);
            if (stabilityVal > 1) stabilityVal /= 100;
            const outputFormat = data.output_format || 'mp3_44100_128';

            const results = [];
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                try {
                    const { audio, usedKey } = await elevenlabsService.requestTTSWithRotation(
                        keys, item.voice_id || data.voice_id, item.text,
                        modelId, stabilityVal, outputFormat, item.key_index || data.key_index
                    );
                    let savePath = item.save_path;
                    if (!savePath) {
                        savePath = elevenlabsService.buildTTSSavePath(item.text, outputFormat, 'batch', `${String(i + 1).padStart(3, '0')}`);
                    }
                    fs.writeFileSync(savePath, audio);
                    results.push({ index: i, success: true, file_path: savePath, used_key: usedKey });
                } catch (e) {
                    results.push({ index: i, success: false, error: e.message });
                }
            }
            return { results, total: items.length, success_count: results.filter(r => r.success).length };
        }

        case 'elevenlabs/tts-workflow':
            return await workflowService.ttsWorkflow(data);

        case 'elevenlabs/sfx': {
            const keys = elevenlabsService.loadKeys();
            if (!keys || keys.length === 0) throw new Error('未配置 API Key');
            if (!data.prompt) throw new Error('缺少音效描述');
            const apiKey = elevenlabsService.selectKey(keys, data.key_index);
            const audio = await elevenlabsService.generateSFX(apiKey, data.prompt, data.duration || 5);
            let savePath = data.save_path;
            if (!savePath) {
                savePath = elevenlabsService.buildTTSSavePath(data.prompt, 'mp3_44100_128', 'sfx');
            }
            fs.writeFileSync(savePath, audio);
            return { message: '生成成功', file_path: savePath };
        }

        case 'elevenlabs/toggle-key': {
            // 必须加载包含已停用的 key，否则停用后找不到目标 key 无法重新启用
            const allKeys = elevenlabsService.loadKeys(true);
            if (!allKeys || allKeys.length === 0) throw new Error('未配置 API Key');
            const targetKey = data.api_key;
            if (!targetKey) throw new Error('缺少 api_key');
            elevenlabsService.setKeyEnabled(targetKey, data.enabled !== false, data.reason || '', data.source || 'manual');
            return { message: '已更新' };
        }

        // ==================== 字幕操作 ====================
        case 'srt/adjust':
            if (!data.src_path) throw new Error('缺少必需参数: src_path');
            return subtitleService.adjustSRT(data.src_path, {
                intervalTime: data.interval_time,
                charTime: data.char_time,
                minCharCount: data.min_char_count,
                scale: data.scale,
                ignore: data.ignore,
            });

        case 'srt/seamless':
            if (!data.src_path) throw new Error('缺少必需参数: src_path');
            return subtitleService.seamlessSRT(data.src_path);

        case 'srt/compute-char-time':
            if (!data.ref_path) throw new Error('缺少必需参数: ref_path');
            return subtitleService.computeCharTime(data.ref_path, data.interval_time);

        // ==================== AI 文案处理 ====================
        case 'ai/process-scripts': {
            if (!data.scripts || !Array.isArray(data.scripts)) {
                throw new Error('缺少文案列表');
            }
            const keysData = settingsService.loadGeminiKeys() || {};
            const keys = keysData.keys || [];
            const customPrompt = keysData.prompt || null;
            const geminiModel = keysData.model || null;
            return await geminiService.processScripts(data.scripts, keys, customPrompt, geminiModel);
        }

        case 'ai/test-keys': {
            if (!data.keys || !Array.isArray(data.keys) || data.keys.length === 0) throw new Error('缺少 API Keys');
            return await geminiService.testKeys(data.keys, data.model || null);
        }

        // ==================== 媒体操作 ====================
        case 'media/info': {
            if (!data.file_path) throw new Error('缺少文件路径');
            const [duration, frameRate, resolution] = await Promise.all([
                ffmpegService.getDuration(data.file_path),
                ffmpegService.getFrameRate(data.file_path),
                ffmpegService.getResolution(data.file_path)
            ]);
            return { duration, frame_rate: frameRate, resolution };
        }

        case 'media/concat-clips': {
            const clips = Array.isArray(data.clips) ? data.clips : [];
            if (clips.length < 2) throw new Error('至少需要 2 个视频片段');
            if (!data.output_path) throw new Error('缺少输出路径');
            return await ffmpegService.concatClips({
                clips,
                outputPath: data.output_path,
                targetWidth: parseInt(data.target_width || 1080, 10),
                targetHeight: parseInt(data.target_height || 1920, 10),
                fps: parseInt(data.fps || 30, 10),
                crf: parseInt(data.crf || 18, 10),
                preset: data.preset || 'fast',
            });
        }

        case 'media/clear-clip-cache': {
            if (!data.file_path) throw new Error('缺少文件路径');
            const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
            const baseName = path.parse(data.file_path).name.replace(/[^\w.-]+/g, '_');
            let deletedCount = 0;
            if (fs.existsSync(cacheDir)) {
                const files = fs.readdirSync(cacheDir);
                const baseNameEscaped = baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const regex = new RegExp(`^[a-z]{2,4}_${baseNameEscaped}_[a-f0-9]{12}_autoedit\\.(json|txt)$`);
                for (const file of files) {
                    if (regex.test(file)) {
                        try {
                            fs.unlinkSync(path.join(cacheDir, file));
                            deletedCount++;
                        } catch (_) {}
                    }
                }
            }
            return { success: true, deletedCount };
        }

        case 'media/auto-edit-replace-clip': {
            const { originalClipPath, newClipPath } = data;
            if (!originalClipPath || !newClipPath) throw new Error('缺少文件路径参数');
            if (!fs.existsSync(originalClipPath)) throw new Error(`原始视频文件不存在: ${originalClipPath}`);
            if (!fs.existsSync(newClipPath)) throw new Error(`替换视频文件不存在: ${newClipPath}`);

            // 1. Delete old Gladia cache files
            try {
                const cacheDir = settingsService.getSecureTmpDir('videokit_autoedit_cache');
                const baseName = path.parse(originalClipPath).name.replace(/[^\w.-]+/g, '_');
                if (fs.existsSync(cacheDir)) {
                    const files = fs.readdirSync(cacheDir);
                    const baseNameEscaped = baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                    const regex = new RegExp(`^[a-z]{2,4}_${baseNameEscaped}_[a-f0-9]{12}_autoedit\\.(json|txt)$`);
                    for (const file of files) {
                        if (regex.test(file)) {
                            try {
                                fs.unlinkSync(path.join(cacheDir, file));
                            } catch (_) {}
                        }
                    }
                }
            } catch (cacheErr) {
                console.warn('[Replace Clip] Failed to clear old cache files:', cacheErr.message);
            }

            // 2. Backup the old file to a backup folder inside the same directory
            const dir = path.dirname(originalClipPath);
            const backupDir = path.join(dir, 'backup_clips');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            const base = path.basename(originalClipPath);
            const ext = path.extname(originalClipPath);
            const timestamp = Date.now();
            const backupFileName = `${path.parse(base).name}_err_${timestamp}${ext}`;
            const backupPath = path.join(backupDir, backupFileName);

            fs.copyFileSync(originalClipPath, backupPath);
            console.log(`[Replace Clip] Backed up old file to: ${backupPath}`);

            // 3. Overwrite the original file with the new file (handling extension change if necessary)
            const newExt = path.extname(newClipPath);
            let targetClipPath = originalClipPath;
            if (newExt.toLowerCase() !== ext.toLowerCase()) {
                targetClipPath = path.join(dir, `${path.parse(base).name}${newExt}`);
                fs.copyFileSync(newClipPath, targetClipPath);
                try {
                    fs.unlinkSync(originalClipPath);
                } catch (unlinkErr) {
                    console.warn('[Replace Clip] Failed to delete old clip file:', unlinkErr.message);
                }
            } else {
                fs.copyFileSync(newClipPath, originalClipPath);
            }
            console.log(`[Replace Clip] Replaced original file. Target path: ${targetClipPath}`);

            return { success: true, backupPath, updatedPath: targetClipPath };
        }

        case 'media/copy-file': {
            const { srcPath, destDir, destFileName } = data;
            if (!srcPath || !destDir) throw new Error('缺少文件路径或目标目录参数');
            if (!fs.existsSync(srcPath)) throw new Error(`源文件不存在: ${srcPath}`);

            // Ensure destination directory exists
            fs.mkdirSync(destDir, { recursive: true });

            const targetName = destFileName || path.basename(srcPath);
            const srcDirNormalized = path.normalize(path.dirname(srcPath));
            const destDirNormalized = path.normalize(destDir);

            // If it is already in the target directory, no need to copy
            if (srcDirNormalized === destDirNormalized) {
                return { success: true, path: srcPath, copied: false };
            }

            let targetPath = path.join(destDir, targetName);
            let finalName = targetName;
            
            // Check for duplicate/collision in target folder
            if (fs.existsSync(targetPath)) {
                const ext = path.extname(targetName);
                const nameWithoutExt = path.parse(targetName).name;
                // Generate a unique suffix to prevent collision
                finalName = `${nameWithoutExt}_added_${Date.now()}${ext}`;
                targetPath = path.join(destDir, finalName);
            }

            // Copy file
            fs.copyFileSync(srcPath, targetPath);
            console.log(`[Copy File] Copied ${srcPath} -> ${targetPath}`);

            return { success: true, path: targetPath, copied: true };
        }

        case 'media/auto-edit-by-script':
        case 'media/auto-edit':
        case 'auto-edit-by-script':
            return await runAutoEditByScript(data, progressSender);

        case 'media/waveform': {
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.getWaveformBinary(data.file_path, data.num_peaks || 300);
        }

        case 'media/trim':
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.mediaTrim(
                data.file_path,
                parseFloat(data.start_time ?? data.start),
                parseFloat(data.end_time ?? data.end),
                data.output_dir,
                data.precise !== false
            );

        case 'media/scene-detect':
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.sceneDetect(
                data.file_path,
                parseFloat(data.threshold || 0.3),
                parseFloat(data.min_interval || 0.5)
            );

        case 'media/scene-split':
            if (!data.file_path || !data.segments) throw new Error('缺少参数');
            return await ffmpegService.sceneSplit(data.file_path, data.segments, data.output_dir, {
                folderMode: data.folder_mode || 'per_video',
                batchName: data.batch_name || '',
            });

        case 'media/scene-detect-frames': {
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.sceneDetectFrames(data.file_path, {
                threshold: parseFloat(data.threshold || 0.3),
                minInterval: parseFloat(data.min_interval || 0.5),
                framesPerScene: parseInt(data.frames_per_scene || 0),
                format: data.format || 'jpg',
                quality: parseInt(data.quality || 2),
                outputDir: data.output_dir || '',
                boundaryOffset: parseFloat(data.boundary_offset || 0.04),
                cleanOld: !!data.clean_old,
                folderMode: data.folder_mode || 'per_video',
                batchName: data.batch_name || '',
            });
        }

        case 'media/scene-export-frames': {
            if (!data.file_path) throw new Error('缺少文件路径');
            if (!data.frames || data.frames.length === 0) throw new Error('缺少帧列表');
            return await ffmpegService.sceneExportFrames(data.file_path, data.frames, {
                format: data.format || 'jpg',
                quality: parseInt(data.quality || 2),
                outputDir: data.output_dir || '',
                cleanOld: !!data.clean_old,
                folderMode: data.folder_mode || 'per_video',
                batchName: data.batch_name || '',
            });
        }

        case 'media/download-and-detect-frames': {
            // 从视频链接下载 → 场景检测 → 关键帧截取 → 删除临时视频
            if (!data.urls || data.urls.length === 0) throw new Error('缺少视频链接列表');
            const outDir = data.output_dir || settingsService.getSecureTmpDir('smart_keyframes');
            fs.mkdirSync(outDir, { recursive: true });

            const { BrowserWindow: BWFrames } = require('electron');
            const winsFrames = BWFrames.getAllWindows();

            const allResults = [];
            for (let i = 0; i < data.urls.length; i++) {
                const url = data.urls[i].trim();
                if (!url) continue;

                // 通知进度
                for (const w of winsFrames) {
                    try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'downloading', url }); } catch {}
                }

                let tmpVideoPath = null;
                try {
                    // 下载视频
                    const tmpDir = settingsService.getSecureTmpDir('smart_kf_dl');
                    fs.mkdirSync(tmpDir, { recursive: true });
                    const dlResult = await ytdlpService.downloadVideo(url, {
                        quality: data.download_quality || 'best',
                        outputDir: tmpDir,
                        outputTemplate: `kf_${i}_%(id)s.%(ext)s`,
                    });
                    tmpVideoPath = dlResult.file_path || dlResult.output_path || null;

                    if (!tmpVideoPath || !fs.existsSync(tmpVideoPath)) {
                        const files = fs.readdirSync(tmpDir)
                            .filter(f => f.startsWith(`kf_${i}_`))
                            .map(f => ({ f, mtime: fs.statSync(path.join(tmpDir, f)).mtimeMs }))
                            .sort((a, b) => b.mtime - a.mtime);
                        if (files.length > 0) tmpVideoPath = path.join(tmpDir, files[0].f);
                    }

                    if (!tmpVideoPath || !fs.existsSync(tmpVideoPath)) throw new Error('下载后找不到视频文件');

                    // 通知进度：分析中
                    for (const w of winsFrames) {
                        try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'analyzing', url }); } catch {}
                    }

                    // 场景检测 + 关键帧截取
                    const result = await ffmpegService.sceneDetectFrames(tmpVideoPath, {
                        threshold: parseFloat(data.threshold || 0.3),
                        minInterval: parseFloat(data.min_interval || 0.5),
                        framesPerScene: parseInt(data.frames_per_scene || 0),
                        format: data.format || 'jpg',
                        quality: parseInt(data.quality || 2),
                        outputDir: outDir,
                        boundaryOffset: parseFloat(data.boundary_offset || 0.04),
                    });

                    allResults.push({ url, success: true, ...result });

                } catch (e) {
                    allResults.push({ url, success: false, error: e.message });
                } finally {
                    // 删除临时视频
                    if (tmpVideoPath && fs.existsSync(tmpVideoPath)) {
                        try { fs.unlinkSync(tmpVideoPath); } catch {}
                    }
                    for (const w of winsFrames) {
                        try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'done', url }); } catch {}
                    }
                }
            }

            const successCount = allResults.filter(r => r.success).length;
            const totalFrames = allResults.reduce((sum, r) => sum + (r.success || 0), 0);
            return {
                message: `处理 ${successCount}/${allResults.length} 个视频，共导出 ${totalFrames} 帧`,
                results: allResults,
                output_dir: outDir,
            };
        }

        case 'media/batch-cut':
            if (!data.file_path) throw new Error('缺少文件路径');
            if (!data.segments || data.segments.length === 0) throw new Error('缺少剪辑片段');
            return await ffmpegService.batchCut(
                data.file_path,
                data.segments,
                data.output_dir,
                data.precise !== false
            );

        case 'media/reels-compose':
            if (!data.background_path) throw new Error('缺少背景素材路径');
            if (!data.voice_path) throw new Error('缺少配音音频路径');
            if (!data.ass_content) throw new Error('缺少 ASS 字幕内容');
            if (!data.output_path) throw new Error('缺少输出路径');
            return await ffmpegService.composeReel({
                backgroundPath: data.background_path,
                voicePath: data.voice_path,
                assContent: data.ass_content,
                outputPath: data.output_path,
                crf: parseInt(data.crf || 23, 10),
                useGPU: data.use_gpu === true,
                loopFade: data.loop_fade !== false,
                loopFadeDur: parseFloat(data.loop_fade_dur ?? 1.0),
                voiceVolume: parseFloat(data.voice_volume ?? 1.0),
                bgVolume: parseFloat(data.bg_volume ?? 0.0),
            });

        case 'media/export-fcpxml-timeline': {
            const isMultiVideo = data.multi_video === true;
            if (!isMultiVideo && !data.file_path) throw new Error('缺少文件路径');
            if (!data.segments || data.segments.length === 0) throw new Error('缺少剪辑片段');

            // 多视频模式：为每个片段获取视频时长
            if (isMultiVideo) {
                for (const seg of data.segments) {
                    if (seg.videoPath && !seg.videoDuration) {
                        try {
                            seg.videoDuration = await ffmpegService.getDuration(seg.videoPath);
                        } catch (e) {
                            console.warn(`获取视频时长失败: ${seg.videoPath}`, e.message);
                        }
                    }
                }
            }

            const refPath = data.file_path || (data.segments[0]?.videoPath) || '';
            const outDir = data.output_dir || (refPath ? path.dirname(refPath) : os.tmpdir());
            const baseName = refPath ? path.basename(refPath, path.extname(refPath)) : 'multi_timeline';
            const fcpxmlPath = path.join(outDir, `${baseName}_timeline.fcpxml`);
            return fcpxmlService.segmentsToFcpxml(
                data.file_path || '',
                data.segments,
                data.duration || 0,
                data.fps || 30,
                data.resolution || '1920x1080',
                fcpxmlPath,
                data.subtitle_style || null,
                data.compound_mode || false
            );
        }

        case 'media/replace-audio': {
            const videoPath = data.video_path || data.videoPath;
            const audioPath = data.audio_path || data.audioPath;
            if (!videoPath || !fs.existsSync(videoPath)) throw new Error('缺少有效视频文件');
            if (!audioPath || !fs.existsSync(audioPath)) throw new Error('缺少有效音频文件');
            const outDir = data.output_dir || path.dirname(videoPath);
            fs.mkdirSync(outDir, { recursive: true });
            const baseName = path.parse(videoPath).name;
            const outputPath = data.output_path || path.join(outDir, `${baseName}_replaced_audio.mp4`);
            await ffmpegService.runCommand('ffmpeg', [
                '-y',
                '-i', videoPath,
                '-i', audioPath,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-b:a', '192k',
                '-shortest',
                '-movflags', '+faststart',
                outputPath,
            ], { timeout: 1800000 });

            let srtPath = '';
            let subtitledPath = '';
            if (data.regenerate_subtitles === true || data.retranscribe_audio === true) {
                const gladiaKeysData = settingsService.loadGladiaKeys();
                const gladiaKeys = gladiaKeysData.keys || [];
                const srtResult = await autoEditService.generateSrtForAudioScript({
                    audioPath,
                    scriptText: data.script_text || data.scriptText || '',
                    language: data.language || 'auto',
                    gladiaKeys,
                    srtPath: outputPath.replace(/\.[^.]+$/, '.srt'),
                    force: true,
                    minScore: data.min_score,
                });
                srtPath = srtResult.srt_path || '';

                if (data.burn_subtitles === true && srtPath) {
                    subtitledPath = outputPath.replace(/\.[^.]+$/, '_subtitled.mp4');
                    const assPath = String(srtPath).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    await ffmpegService.runCommand('ffmpeg', [
                        '-y',
                        '-i', outputPath,
                        '-vf', `subtitles='${assPath}'`,
                        '-c:v', 'libx264',
                        '-crf', String(parseInt(data.crf || 18, 10)),
                        '-preset', data.preset || 'fast',
                        '-c:a', 'copy',
                        subtitledPath,
                    ], { timeout: 1800000 });
                }
            }

            return {
                success: true,
                message: srtPath ? '音频替换完成，已按新音频重新生成字幕' : '音频替换完成',
                output_path: outputPath,
                srt_path: srtPath,
                subtitled_path: subtitledPath,
                final_video_path: subtitledPath || outputPath,
                video_path: videoPath,
                audio_path: audioPath,
                output_dir: outDir,
            };
        }




        case 'media/convert': {
            const files = data.files || [data.file_path];
            const mode = data.mode || 'mp3';
            const outDir = data.output_dir || path.dirname(files[0]);
            const allResults = [];

            if (mode === 'auto_edit') {
                return await runAutoEditByScript({ ...data, files }, progressSender);
            }

            if (mode === 'audio_split') {
                // 音频裁切导出
                const cutPointsMap = data.cut_points_map || {};
                const exportMp3 = data.export_mp3 !== false;
                const exportMp4 = data.export_mp4 || false;

                for (const file of files) {
                    try {
                        const baseName = path.parse(file).name;
                        const fileOutDir = path.join(outDir || path.dirname(file), `${baseName}_splits`);
                        fs.mkdirSync(fileOutDir, { recursive: true });

                        const rawCutPoints = cutPointsMap[file] || '';
                        const cutPoints = ffmpegService.parseCutPoints(rawCutPoints);
                        const segments = ffmpegService.buildSegments(cutPoints);

                        // 获取总时长用于最后一段
                        const totalDuration = await ffmpegService.getDuration(file);

                        for (let i = 0; i < segments.length; i++) {
                            const [start, end] = segments[i];
                            const segEnd = end != null ? end : totalDuration;
                            if (segEnd == null || segEnd - start <= 0) continue;

                            const idx = String(i + 1).padStart(2, '0');
                            const duration = segEnd - start;

                            // 导出 MP3（双声道）
                            if (exportMp3) {
                                const mp3Path = path.join(fileOutDir, `${baseName}_${idx}.mp3`);
                                await ffmpegService.runCommand('ffmpeg', [
                                    '-y', '-i', file,
                                    '-ss', start.toFixed(3), '-to', segEnd.toFixed(3),
                                    '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-ac', '2',
                                    mp3Path
                                ]);
                                allResults.push(mp3Path);
                            }

                            // 导出黑屏 MP4
                            if (exportMp4) {
                                const mp4Path = path.join(fileOutDir, `${baseName}_${idx}.mp4`);
                                await ffmpegService.generateBlackMp4(file, mp4Path, start, duration);
                                allResults.push(mp4Path);
                            }
                        }
                    } catch (e) {
                        allResults.push({ error: e.message, file });
                    }
                }
            } else if (mode === 'audio_fx') {
                // 单独处理音频特效(立体声/混响)
                console.log('[AudioFX Route] files:', files, 'outDir:', outDir, 'data keys:', Object.keys(data));
                for (const file of files) {
                    try {
                        const fileOutDir = outDir || path.dirname(file);
                        fs.mkdirSync(fileOutDir, { recursive: true });
                        const results = await ffmpegService.applyAudioFx(file, fileOutDir, data);
                        allResults.push(...results);
                    } catch (e) {
                        console.error('[AudioFX Route] Error processing file:', file, e.message, e.stack);
                        allResults.push({ error: e.message, file });
                    }
                }
            } else if (mode === 'watermark') {
                // 文字水印
                console.log('[Watermark Route] files:', files, 'outDir:', outDir);
                for (const file of files) {
                    try {
                        const fileOutDir = outDir || path.dirname(file);
                        fs.mkdirSync(fileOutDir, { recursive: true });
                        const results = await ffmpegService.applyWatermark(file, fileOutDir, data.watermark || {});
                        allResults.push(...results);
                    } catch (e) {
                        console.error('[Watermark Route] Error:', file, e.message);
                        allResults.push({ error: e.message, file });
                    }
                }
            } else if (mode === 'custom_logo' || ['hailuo', 'vidu', 'veo', 'heygen', 'dream', 'ai_generated'].includes(mode)) {
                // 图片 Logo 叠加 (自定义或内置预设)
                console.log('[Logo Route] files:', files, 'outDir:', outDir, 'mode:', mode);
                for (const file of files) {
                    try {
                        const fileOutDir = outDir || path.dirname(file);
                        fs.mkdirSync(fileOutDir, { recursive: true });
                        const results = await ffmpegService.applyLogo(file, fileOutDir, data);
                        allResults.push(...results);
                    } catch (e) {
                        console.error('[Logo Route] Error:', file, e.message);
                        allResults.push({ error: e.message, file });
                    }
                }
            } else {
                for (const file of files) {
                    try {
                        const results = await ffmpegService.mediaConvert(file, mode, outDir, data);
                        allResults.push(...results);
                    } catch (e) {
                        allResults.push({ error: e.message, file });
                    }
                }
            }

            // 收集文件信息
            const filesInfo = [];
            for (const item of allResults) {
                if (typeof item === 'string' && fs.existsSync(item)) {
                    try {
                        const dur = await ffmpegService.getDuration(item);
                        filesInfo.push({ path: item, filename: path.basename(item), duration: dur });
                    } catch { filesInfo.push({ path: item, filename: path.basename(item) }); }
                }
            }

            const successFiles = allResults.filter(r => typeof r === 'string');
            const errorItems = allResults.filter(r => typeof r === 'object' && r.error);
            let msg = `转换完成: ${successFiles.length} 个文件`;
            if (errorItems.length > 0) {
                msg += `\n失败 ${errorItems.length} 个: ${errorItems.map(e => e.error).join('; ')}`;
            }

            return {
                message: msg,
                files: successFiles,
                files_info: filesInfo,
                converted: allResults,
            };
        }

        case 'media/batch-thumbnail': {
            if (!data.files || data.files.length === 0) throw new Error('缺少文件列表');
            const outDir = data.output_dir || settingsService.getSecureTmpDir('thumbnails');
            const results = await ffmpegService.batchThumbnail(
                data.files, outDir,
                data.format || 'jpg',
                data.quality || 2,
                data.mode || 'first'
            );
            return {
                message: `截图完成: ${results.filter(r => r.success).length}/${results.length}`,
                results,
                output_dir: outDir,
            };
        }

        case 'media/url-thumbnail': {
            // 从视频链接批量截图：下载 → 截图 → 删除临时视频
            if (!data.urls || data.urls.length === 0) throw new Error('缺少视频链接列表');
            const outDir = data.output_dir || settingsService.getSecureTmpDir('url_thumbnails');
            fs.mkdirSync(outDir, { recursive: true });

            const format = data.format || 'jpg';
            const quality = parseInt(data.quality || 2);
            const mode = data.mode || 'first'; // 'first' | 'last'
            const { BrowserWindow: BWThumb } = require('electron');
            const winsThumb = BWThumb.getAllWindows();

            const results = [];
            for (let i = 0; i < data.urls.length; i++) {
                const url = data.urls[i].trim();
                if (!url) continue;

                // 通知前端进度
                for (const w of winsThumb) {
                    try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'downloading', url }); } catch {}
                }

                let tmpVideoPath = null;
                try {
                    // 下载到临时目录（只下最低画质以加速）
                    const tmpDir = settingsService.getSecureTmpDir('url_thumb_dl');
                    fs.mkdirSync(tmpDir, { recursive: true });
                    const dlResult = await ytdlpService.downloadVideo(url, {
                        quality: 'worst',
                        outputDir: tmpDir,
                        outputTemplate: `thumb_${i}_%(id)s.%(ext)s`,
                    });
                    tmpVideoPath = dlResult.file_path || dlResult.output_path || null;

                    // 兼容：如果没有 file_path，扫描 tmpDir 找最新文件
                    if (!tmpVideoPath || !fs.existsSync(tmpVideoPath)) {
                        const files = fs.readdirSync(tmpDir)
                            .filter(f => f.startsWith(`thumb_${i}_`))
                            .map(f => ({ f, mtime: fs.statSync(path.join(tmpDir, f)).mtimeMs }))
                            .sort((a, b) => b.mtime - a.mtime);
                        if (files.length > 0) tmpVideoPath = path.join(tmpDir, files[0].f);
                    }

                    if (!tmpVideoPath || !fs.existsSync(tmpVideoPath)) throw new Error('下载后找不到视频文件');

                    // 通知进度：截图中
                    for (const w of winsThumb) {
                        try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'screenshotting', url }); } catch {}
                    }

                    // FFmpeg 截图
                    const baseName = path.basename(tmpVideoPath, path.extname(tmpVideoPath));
                    const outName = `${baseName}.${format}`;
                    const outPath = path.join(outDir, outName);

                    let ffmpegArgs;
                    if (mode === 'last') {
                        const dur = await ffmpegService.getDuration(tmpVideoPath);
                        const seekTime = Math.max(0, dur - 0.5).toFixed(3);
                        ffmpegArgs = ['-y', '-ss', seekTime, '-i', tmpVideoPath, '-vframes', '1'];
                    } else {
                        ffmpegArgs = ['-y', '-i', tmpVideoPath, '-vframes', '1', '-ss', '0'];
                    }

                    if (format === 'jpg') {
                        ffmpegArgs.push('-qscale:v', String(quality));
                    }
                    ffmpegArgs.push(outPath);

                    await ffmpegService.runCommand('ffmpeg', ffmpegArgs);
                    results.push({ url, success: true, output: outPath });

                } catch (e) {
                    results.push({ url, success: false, error: e.message });
                } finally {
                    // 删除临时视频文件
                    if (tmpVideoPath && fs.existsSync(tmpVideoPath)) {
                        try { fs.unlinkSync(tmpVideoPath); } catch {}
                    }
                    // 通知进度：完成
                    for (const w of winsThumb) {
                        try { w.webContents.send('url-thumbnail-progress', { index: i, total: data.urls.length, status: 'done', url }); } catch {}
                    }
                }
            }

            const successCount = results.filter(r => r.success).length;
            return {
                message: `链接截图完成: ${successCount}/${results.length} 成功`,
                results,
                output_dir: outDir,
                success: successCount,
                failed: results.length - successCount,
            };
        }

        case 'media/smart-split':
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.smartSplitAnalyze(data.file_path, data.max_duration || 29);

        case 'media/image-classify':
            if (!data.input_dir) throw new Error('缺少输入目录');
            return await imageClassifyService.imageClassify(
                data.input_dir,
                data.output_dir || path.join(data.input_dir, '_classified'),
                {
                    threshold: data.threshold || 5,
                    moveMode: data.move_mode || false,
                }
            );

        // ==================== 字幕生成（Gladia + 完整对齐） ====================
        case 'subtitle/clear-cache': {
            if (!data.audio_path && !data.audio_file_path) throw new Error('缺少音频文件路径');
            const audioPath = data.audio_path || data.audio_file_path;
            
            const langInput = data.language || 'english';
            let currentLanguage = langInput;
            for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
                if (info.name === langInput) { currentLanguage = code; break; }
            }
            
            const fileName = path.parse(audioPath).name;
            const logDir = settingsService.getSecureTmpDir('videokit_log');
            const audioCacheKey = buildAudioCacheKey(audioPath);
            const jsonPath = path.join(logDir, `${currentLanguage}_${fileName}_${audioCacheKey}_audio_text_whittime.json`);
            const txtPath = path.join(logDir, `${currentLanguage}_${fileName}_${audioCacheKey}_finally.txt`);
            
            let deletedJson = false;
            let deletedTxt = false;
            
            try { if (fs.existsSync(jsonPath)) { fs.unlinkSync(jsonPath); deletedJson = true; } } catch {}
            try { if (fs.existsSync(txtPath)) { fs.unlinkSync(txtPath); deletedTxt = true; } } catch {}
            
            return {
                message: '清除缓存成功',
                deletedJson,
                deletedTxt,
                jsonPath,
                txtPath
            };
        }


        case 'subtitle/generate': {
            if (!data.audio_path && !data.audio_file_path) throw new Error('缺少音频文件路径');
            const audioPath = data.audio_path || data.audio_file_path;
            if (!fs.existsSync(audioPath)) {
                throw new Error(`音频文件不存在或无法读取: ${audioPath}`);
            }
            try {
                if (!fs.statSync(audioPath).isFile()) throw new Error('选择的不是文件');
            } catch (error) {
                throw new Error(`无法读取音频文件: ${error.message}`);
            }
            const gladiaKeysData = settingsService.loadGladiaKeys();
            let gladiaKeys = gladiaKeysData.keys || [];
            if (data.gladia_keys) {
                if (Array.isArray(data.gladia_keys)) {
                    gladiaKeys = data.gladia_keys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
                } else if (typeof data.gladia_keys === 'string') {
                    try {
                        const parsed = JSON.parse(data.gladia_keys);
                        if (Array.isArray(parsed)) {
                            gladiaKeys = parsed.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean);
                        }
                    } catch {}
                }
            }
            if (gladiaKeys.length === 0) throw new Error('未配置 Gladia API Key');

            // 确定语言
            const langInput = data.language || 'english';
            let currentLanguage = langInput;
            // 如果传入中文名称，转为语言代码
            for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
                if (info.name === langInput) { currentLanguage = code; break; }
            }
            const langEnName = subtitleUtils.getLanguage(currentLanguage);

            // 构建日志路径
            const fileName = path.parse(audioPath).name;
            const logDir = settingsService.getSecureTmpDir('videokit_log');
            fs.mkdirSync(logDir, { recursive: true });
            const audioCacheKey = buildAudioCacheKey(audioPath);
            const jsonPath = path.join(logDir, `${currentLanguage}_${fileName}_${audioCacheKey}_audio_text_whittime.json`);
            const txtPath = path.join(logDir, `${currentLanguage}_${fileName}_${audioCacheKey}_finally.txt`);
            const forceTranscribe = data.force === true || data.force === 'true';
            console.log(`[字幕对齐] 音频: ${audioPath}`);
            console.log(`[字幕对齐] 转录缓存: ${path.basename(jsonPath)}`);
            console.log(`[字幕对齐] 强制重新转录: ${forceTranscribe ? '是' : '否'}`);

            // JSON 文件输入
            let generationSubtitleArray;
            let generationSubtitleText;
            let transcriptionSource = 'unknown'; // 追踪转录数据来源

            // 强制重新转录时，不允许继续读旧缓存。
            if (forceTranscribe) {
                const hadCache = fs.existsSync(jsonPath);
                try { if (hadCache) fs.unlinkSync(jsonPath); } catch { }
                try { if (fs.existsSync(txtPath)) fs.unlinkSync(txtPath); } catch { }
                console.log(`[字幕对齐] 强制模式: 不使用缓存 ${path.basename(jsonPath)}${hadCache ? '（已删除旧缓存）' : '（无旧缓存）'}`);
            }

            if (audioPath.toLowerCase().endsWith('.json')) {
                // 直接读取 JSON 结果
                const audioJson = JSON.parse(fs.readFileSync(audioPath, 'utf-8'));
                const transcription = audioJson.result?.transcription || audioJson.transcription || {};
                const wordTimeInfo = transcription.utterances || [];
                let allText = '';
                generationSubtitleArray = [];
                for (const single of wordTimeInfo) {
                    const newSingle = { audio_start: single.start, audio_end: single.end, text: single.text, words: [] };
                    for (const word of (single.words || [])) {
                        allText += ' ' + word.word.trim();
                        newSingle.words.push({ word: word.word.trim(), start: word.start, end: word.end, score: word.confidence || 0 });
                    }
                    generationSubtitleArray.push(newSingle);
                }
                generationSubtitleText = allText.trimStart();
                fs.writeFileSync(jsonPath, JSON.stringify(generationSubtitleArray, null, 4), 'utf-8');
                fs.writeFileSync(txtPath, generationSubtitleText, 'utf-8');
                transcriptionSource = 'json_file';
            } else if (forceTranscribe || !fs.existsSync(jsonPath)) {
                // Gladia 转录
                console.log(`[字幕对齐] 🎙️ 正在调用 Gladia 进行语音识别${forceTranscribe ? '（强制重新转录）' : ''}...`);
                const cutLength = parseFloat(data.audio_cut_length || 5.0);
                const result = await gladiaService.transcribeAudioFull(
                    audioPath, gladiaKeys, langEnName, jsonPath, txtPath, cutLength,
                    (message) => progressSender?.({ stage: 'transcribe', message })
                );
                generationSubtitleArray = result.wordTimeInfo;
                generationSubtitleText = result.fullText;
                transcriptionSource = 'gladia_fresh';
                console.log(`[字幕对齐] ✅ Gladia 转录完成，${generationSubtitleArray.length} 个片段`);
            } else {
                generationSubtitleArray = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                generationSubtitleText = fs.readFileSync(txtPath, 'utf-8').trim();
                transcriptionSource = 'gladia_cache';
                console.log(`[字幕对齐] 📦 使用缓存转录数据: ${path.basename(jsonPath)}`);
            }

            const sourceTextCandidates = parseSourceTextCandidates(data.source_text_candidates);
            const requireAutoSourceMatch = data.require_auto_source_match === true || data.require_auto_source_match === 'true';
            let selectedSourceText = data.source_text || '';
            let selectedTranslateText = data.translate_text || '';
            const ignoreMismatch = data.ignore_mismatch === true || data.ignore_mismatch === 'true';
            let autoMatchedSource = null;

            // Check if current row's text is 100% exact normalized match
            let ownTextMatches = false;
            if (selectedSourceText.trim()) {
                const normSelected = normalizeForStrictTextMatch(selectedSourceText);
                const normRecognized = normalizeForStrictTextMatch(generationSubtitleText);
                if (normSelected && normRecognized && normSelected === normRecognized) {
                    ownTextMatches = true;
                    console.log(`[字幕对齐] 当前行文案符合100%归一化匹配，直接使用当前行文案`);
                }
            }

            if (!ignoreMismatch && !ownTextMatches) {
                if (sourceTextCandidates.length > 0) {
                    autoMatchedSource = pickExactSourceTextCandidate(generationSubtitleText, sourceTextCandidates);
                    if (!autoMatchedSource) {
                        throw new Error(JSON.stringify({
                            code: 'AUTO_SOURCE_MATCH_NOT_FOUND',
                            similarity: 0,
                            recognized_text: buildRecognizedText(generationSubtitleArray, generationSubtitleText),
                            message: '自动匹配文案失败: 识别文本和候选文案没有完全一致项（已忽略大小写、标点、空格和换行）'
                        }));
                    }
                    selectedSourceText = autoMatchedSource.sourceText;
                    selectedTranslateText = autoMatchedSource.translateText || selectedTranslateText;
                    console.log(`[字幕对齐] 自动匹配文案成功: 候选 #${autoMatchedSource.index + 1}`);
                } else {
                    const diff_match_patch = require('diff-match-patch');
                    const dmp = new diff_match_patch();
                    const cleanGen = normalizeForStrictTextMatch(generationSubtitleText);
                    const cleanSource = normalizeForStrictTextMatch(selectedSourceText);
                    const diffs = dmp.diff_main(cleanGen, cleanSource);
                    let equalLen = 0;
                    for (const [op, text] of diffs) {
                        if (op === 0) equalLen += text.length;
                    }
                    const maxLen = Math.max(cleanGen.length, cleanSource.length);
                    const similarity = maxLen === 0 ? 1 : equalLen / maxLen;

                    throw new Error(JSON.stringify({
                        code: 'TEXT_MISMATCH',
                        similarity: Math.round(similarity * 100),
                        recognized_text: buildRecognizedText(generationSubtitleArray, generationSubtitleText)
                    }));
                }
            } else {
                if (!ownTextMatches && sourceTextCandidates.length > 0) {
                    autoMatchedSource = pickExactSourceTextCandidate(generationSubtitleText, sourceTextCandidates);
                    if (autoMatchedSource) {
                        selectedSourceText = autoMatchedSource.sourceText;
                        selectedTranslateText = autoMatchedSource.translateText || selectedTranslateText;
                        console.log(`[字幕对齐] 自动匹配文案成功: 候选 #${autoMatchedSource.index + 1}`);
                    }
                } else if (!ownTextMatches && requireAutoSourceMatch) {
                    throw new Error(JSON.stringify({
                        code: 'AUTO_SOURCE_MATCH_REQUIRED',
                        similarity: 0,
                        recognized_text: buildRecognizedText(generationSubtitleArray, generationSubtitleText),
                        message: '自动匹配文案失败: 前端要求自动匹配，但候选池为空'
                    }));
                }
            }

            // 如果提供了原文本，执行完整对齐
            if (selectedSourceText) {
                const sourceTextPath = settingsService.secureTmpFile('source', '.txt');
                fs.writeFileSync(sourceTextPath, selectedSourceText, 'utf-8');

                const translateTextDict = {};
                if (selectedTranslateText) {
                    const translatePath = settingsService.secureTmpFile('translate', '.txt');
                    fs.writeFileSync(translatePath, selectedTranslateText, 'utf-8');
                    translateTextDict['翻译文本'] = {
                        filename: '翻译文本',
                        filepath: translatePath,
                        translate_text_with_info: subtitleUtils.readTextWithGoogleDoc(translatePath),
                        trans_srt: '',
                    };
                }

                const sourceTextWithInfo = subtitleUtils.readTextWithGoogleDoc(sourceTextPath);

                const dateStr = new Date().toISOString().replace(/[T:.]/g, '').slice(0, 15);
                const outputDir = data.output_dir || path.join(os.homedir(), 'Desktop', `字幕输出_${dateStr}`);
                fs.mkdirSync(outputDir, { recursive: true });

                const genMergeSrt = data.gen_merge_srt === true || data.gen_merge_srt === 'true';
                const sourceUpOrder = data.source_up_order === true || data.source_up_order === 'true';
                const exportFcpxml = data.export_fcpxml === true || data.export_fcpxml === 'true';
                const seamlessFcpxml = data.seamless_fcpxml === true || data.seamless_fcpxml === 'true';

                progressSender?.({ stage: 'align', message: '正在对齐字幕时间轴' });
                const alignResult = audioSubtitleSearchDifferentStrong(
                    currentLanguage, outputDir, fileName,
                    generationSubtitleArray, generationSubtitleText,
                    sourceTextWithInfo, translateTextDict,
                    genMergeSrt, sourceUpOrder, exportFcpxml, seamlessFcpxml,
                    null, null,
                    data.ignore_mismatch === true
                );

                if (typeof alignResult === 'string' && !alignResult.startsWith('生成了字幕文件')) {
                    if (alignResult.startsWith('{"code":"TEXT_MISMATCH"')) {
                        throw new Error(alignResult);
                    }
                    throw new Error(`字幕对齐失败: ${alignResult}`);
                }

                // 收集生成的文件
                const generatedFiles = [];
                const sourceSrt = path.join(outputDir, `${fileName}_${currentLanguage}_source.srt`);
                if (fs.existsSync(sourceSrt)) generatedFiles.push(sourceSrt);
                for (const k of Object.keys(translateTextDict)) {
                    const transSrt = path.join(outputDir, `${fileName}_${currentLanguage}_${k.replace('.txt', '')}_translate.srt`);
                    if (fs.existsSync(transSrt)) generatedFiles.push(transSrt);
                }
                const mergeSrt = path.join(outputDir, `${fileName}_${currentLanguage}_merge.srt`);
                if (fs.existsSync(mergeSrt)) generatedFiles.push(mergeSrt);
                const fcpxmlFile = path.join(outputDir, `${fileName}_${currentLanguage}.fcpxml`);
                if (fs.existsSync(fcpxmlFile)) generatedFiles.push(fcpxmlFile);

                const timingCalibration = calibrateSrtTimingFromWordTimeline(sourceSrt, generatedFiles, generationSubtitleArray);
                if (timingCalibration?.applied && exportFcpxml && fs.existsSync(sourceSrt)) {
                    const translateSrtList = Object.keys(translateTextDict)
                        .map(k => path.join(outputDir, `${fileName}_${currentLanguage}_${k.replace('.txt', '')}_translate.srt`))
                        .filter(p => fs.existsSync(p))
                        .map(p => fs.readFileSync(p, 'utf-8'));
                    fcpxmlService.SrtsToFcpxml(fs.readFileSync(sourceSrt, 'utf-8'), translateSrtList, fcpxmlFile, seamlessFcpxml);
                }

                // 清理
                try { fs.unlinkSync(sourceTextPath); } catch { }

                return {
                    message: '处理完成',
                    result: alignResult,
                    files: generatedFiles,
                    output_dir: outputDir,
                    audio_path: audioPath,
                    cache_key: audioCacheKey,
                    transcription_source: transcriptionSource,
                    aligned_at: new Date().toISOString(),
                    timing_calibration: timingCalibration,
                    recognized_text: buildRecognizedText(generationSubtitleArray, generationSubtitleText),
                    auto_matched_source: autoMatchedSource ? {
                        index: autoMatchedSource.index,
                        source_text: autoMatchedSource.sourceText,
                    } : null,
                };
            }

            // 盲转模式 (无 source_text)：直接利用 AI 识别分句生成 SRT
            const dateStr = new Date().toISOString().replace(/[T:.]/g, '').slice(0, 15);
            const blindOutputDir = data.output_dir || path.join(os.homedir(), 'Desktop', `字幕输出_${dateStr}`);
            fs.mkdirSync(blindOutputDir, { recursive: true });
            
            const sourceSrt = path.join(blindOutputDir, `${fileName}_${currentLanguage}_source.srt`);
            
            const srtEntries = [];
            let srtIndex = 1;
            for (const utt of generationSubtitleArray) {
                let text = utt.text;
                if (!text && Array.isArray(utt.words)) {
                    text = utt.words.map(w => w.word).join(' ');
                }
                if (!text || !text.trim()) continue;
                
                srtEntries.push({
                    index: srtIndex++,
                    start: Math.round(utt.audio_start * 1000),
                    end: Math.round(utt.audio_end * 1000),
                    text: text.trim()
                });
            }
            
            if (srtEntries.length > 0) {
                const { writeSRT } = require('./services/subtitle');
                writeSRT(srtEntries, sourceSrt);
            }

            return {
                message: '纯语音转录完成',
                result: `生成了字幕文件（无文案校对模式）: ${sourceSrt}`,
                files: fs.existsSync(sourceSrt) ? [sourceSrt] : [],
                output_dir: blindOutputDir,
                word_time_info: generationSubtitleArray,
                full_text: generationSubtitleText,
                transcription_source: transcriptionSource,
                aligned_at: new Date().toISOString(),
            };
        }

        case 'subtitle/generate-with-file':
            // 文件上传版本在 routeUpload 中处理
            throw new Error('文件上传请使用 api-upload 通道');

        // ==================== 视频下载 ====================
        case 'video/analyze':
            if (!data.url) throw new Error('缺少视频链接');
            return await ytdlpService.analyzeVideo(data.url);

        case 'video/download':
            if (!data.url) throw new Error('缺少视频链接');
            return await ytdlpService.downloadVideo(data.url, {
                quality: data.quality,
                outputDir: data.output_dir,
                downloadSubtitle: data.download_subtitle,
            });

        case 'video/download-batch':
            if (!data.items || data.items.length === 0) throw new Error('没有要下载的视频');
            return await ytdlpService.downloadBatch(data.items, {
                outputDir: data.output_dir || undefined,
                audioOnly: data.options?.audio_only,
                ext: data.options?.ext,
                quality: data.options?.quality,
                subtitles: data.options?.subtitles,
                subLang: data.options?.sub_lang,
            });

        case 'video/download-batch-links': {
            if (!data.urls || data.urls.length === 0) throw new Error('没有要下载的链接');
            const { BrowserWindow: BW } = require('electron');
            const wins = BW.getAllWindows();
            return await ytdlpService.downloadBatchSequential(data.urls, {
                outputDir: data.output_dir || undefined,
                quality: data.quality || 'best',
                ext: data.ext || 'mp4',
                audioOnly: data.audio_only || false,
                outputTemplate: data.output_template || '%(id)s.%(ext)s',
                onProgress: (index, total, status, message) => {
                    for (const win of wins) {
                        try {
                            win.webContents.send('batch-download-progress', { index, total, status, message });
                        } catch { /* window closed */ }
                    }
                },
            });
        }

        // ==================== 别名兼容 ====================
        case 'settings/elevenlabs/keys':
            if (data._method === 'GET') return { keys: settingsService.loadElevenLabsKeysWithStatus() };
            if (data._method === 'POST') {
                settingsService.addElevenLabsKey(data.key || '');
                return { message: '添加成功' };
            }
            if (data._method === 'DELETE') {
                settingsService.deleteElevenLabsKey(data.index);
                return { message: '删除成功' };
            }
            if (data._method === 'PUT') {
                return settingsService.updateElevenLabsKeys(data);
            }
            settingsService.saveElevenLabsKeysWithStatus(data.keys || data);
            return { message: '保存成功' };

        case 'audio/smart-split-analyze':
            if (!data.file_path) throw new Error('缺少文件路径');
            return await ffmpegService.smartSplitAnalyze(data.file_path, data.max_duration || 29);

        case 'file/upload':
            // 简易文件上传（非 FormData 方式，直接传路径）
            return { message: '请使用 api-upload 通道上传文件' };

        case 'file/open-folder':
            return await settingsService.openFolder(data.path || data.folder_path);

        case 'file/download-zip':
        case 'subtitle/download-zip': {
            if (!data.files || data.files.length === 0) throw new Error('缺少文件列表');
            const zipPath = settingsService.secureTmpFile('download', '.zip');
            await settingsService.createZip(data.files, zipPath);
            return { message: '打包完成', zip_path: zipPath };
        }

        case 'media/batch-thumbnail-progress':
            // 进度查询（TODO: 如需实时进度可通过 WebSocket 或 IPC 事件）
            return { status: 'completed', progress: 100 };

        case 'status':
            return { status: 'ok', backend: 'nodejs', uptime: process.uptime() };

        // ==================== 视频模板预设 ====================
        case 'templates/list':
            return templateService.listTemplates();

        case 'templates/get':
            if (!data.id) throw new Error('缺少模板 ID');
            return templateService.getTemplate(data.id);

        case 'templates/save':
            if (!data.name) throw new Error('缺少模板名称');
            if (!data.projectData) throw new Error('缺少工程数据');
            return templateService.saveTemplate(data);

        case 'templates/delete':
            if (!data.id) throw new Error('缺少模板 ID');
            return templateService.deleteTemplate(data.id);

        case 'templates/rename':
            if (!data.id || !data.name) throw new Error('缺少模板 ID 或新名称');
            return templateService.renameTemplate(data.id, data.name);

        case 'templates/export-archive': {
            if (!data.id) throw new Error('缺少模板 ID');
            const tplData = templateService.getTemplate(data.id);
            const exportId = `archive_${Date.now()}`;
            const tmpDir = settingsService.getSecureTmpDir(exportId);
            const assetsDir = path.join(tmpDir, 'Assets');
            fs.mkdirSync(assetsDir, { recursive: true });

            const assetMap = {};
            function extractAndRewritePaths(obj) {
                if (typeof obj === 'string') {
                    let checkPath = obj;
                    let prefix = '';
                    if (checkPath.startsWith('local-media://')) {
                        prefix = 'local-media://';
                        checkPath = checkPath.replace('local-media://', '');
                    }
                    // On Windows, if checkPath starts with "/" and a drive letter (e.g. "/C:"), strip the leading "/"
                    if (process.platform === 'win32' && checkPath.startsWith('/') && checkPath.includes(':')) {
                        checkPath = checkPath.substring(1);
                    }
                    if (checkPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(checkPath)) {
                        try {
                            if (fs.existsSync(checkPath) && fs.statSync(checkPath).isFile()) {
                                if (!assetMap[checkPath]) {
                                    const ext = path.extname(checkPath);
                                    const name = path.basename(checkPath, ext);
                                    const newName = `${name}_${Object.keys(assetMap).length}${ext}`;
                                    assetMap[checkPath] = newName;
                                    fs.copyFileSync(checkPath, path.join(assetsDir, newName));
                                }
                                return `${prefix}Assets/${assetMap[checkPath]}`;
                            }
                        } catch (e) {}
                    }
                    return obj;
                }
                if (Array.isArray(obj)) {
                    for (let i = 0; i < obj.length; i++) obj[i] = extractAndRewritePaths(obj[i]);
                    return obj;
                }
                if (obj !== null && typeof obj === 'object') {
                    for (const key of Object.keys(obj)) obj[key] = extractAndRewritePaths(obj[key]);
                    return obj;
                }
                return obj;
            }

            const rewrittenProjectData = extractAndRewritePaths(tplData.projectData);
            const exportObj = {
                _format: 'videokit-template-archive',
                _version: 1,
                name: tplData.name,
                description: tplData.description || '',
                thumbnail: tplData.thumbnail || '',
                tags: tplData.tags || [],
                createdAt: tplData.createdAt,
                projectData: rewrittenProjectData,
            };

            const jsonPath = path.join(tmpDir, 'template.json');
            fs.writeFileSync(jsonPath, JSON.stringify(exportObj, null, 2), 'utf-8');

            const zipPath = settingsService.secureTmpFile(`Template_${tplData.name || 'Archive'}_${Date.now()}`, '.vkpkg');
            const archiver = require('archiver');
            await new Promise((resolve, reject) => {
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 6 } });
                output.on('close', resolve);
                archive.on('error', reject);
                archive.pipe(output);
                archive.directory(tmpDir, false);
                archive.finalize();
            });

            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

            return { message: '归档导出完成', zip_path: zipPath, name: tplData.name };
        }

        case 'templates/import-archive': {
            const zipPath = data.zip_path;
            if (!zipPath || !fs.existsSync(zipPath)) throw new Error('无效的归档文件');
            
            const extractDir = settingsService.getSecureTmpDir(`import_${Date.now()}`);
            const extract = require('extract-zip');
            await extract(zipPath, { dir: extractDir });

            const jsonPath = path.join(extractDir, 'template.json');
            if (!fs.existsSync(jsonPath)) {
                try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
                throw new Error('归档包内找不到 template.json，不是有效的模板包');
            }

            const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (parsed._format !== 'videokit-template-archive') {
                try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
                throw new Error('不支持的归档格式');
            }

            const { app } = require('electron');
            const permAssetsDir = path.join(app.getPath('userData'), 'videokit-templates', 'assets', `tpl_${Date.now()}`);
            fs.mkdirSync(permAssetsDir, { recursive: true });

            const tmpAssetsDir = path.join(extractDir, 'Assets');
            if (fs.existsSync(tmpAssetsDir)) {
                fs.cpSync(tmpAssetsDir, permAssetsDir, { recursive: true });
            }

            function restorePaths(obj) {
                if (typeof obj === 'string') {
                    let checkPath = obj;
                    let prefix = '';
                    if (checkPath.startsWith('local-media://')) {
                        prefix = 'local-media://';
                        checkPath = checkPath.replace('local-media://', '');
                    }
                    if (checkPath.startsWith('Assets/')) {
                        const rel = checkPath.replace('Assets/', '');
                        return `${prefix}${path.join(permAssetsDir, rel)}`;
                    }
                    return obj;
                }
                if (Array.isArray(obj)) {
                    for (let i = 0; i < obj.length; i++) obj[i] = restorePaths(obj[i]);
                    return obj;
                }
                if (obj !== null && typeof obj === 'object') {
                    for (const key of Object.keys(obj)) obj[key] = restorePaths(obj[key]);
                    return obj;
                }
                return obj;
            }

            const restoredProjectData = restorePaths(parsed.projectData);

            const res = templateService.saveTemplate({
                name: parsed.name,
                description: parsed.description || '',
                thumbnail: parsed.thumbnail || '',
                tags: parsed.tags || [],
                projectData: restoredProjectData
            });

            try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
            return { message: '导入成功', id: res.id, name: parsed.name };
        }

        // ==================== Wav2Lip 口型同步 ====================
        case 'wav2lip/check':
            return await wav2lipService.checkEnvironment();

        case 'wav2lip/run': {
            if (!data.face_path) throw new Error('缺少视频/图片路径');
            if (!data.audio_path) throw new Error('缺少音频路径');

            // 获取窗口以发送进度事件
            const { BrowserWindow } = require('electron');
            const wins = BrowserWindow.getAllWindows();

            return await wav2lipService.lipSync({
                facePath: data.face_path,
                audioPath: data.audio_path,
                outputPath: data.output_path || '',
                pads: data.pads || [0, 10, 0, 0],
                resizeFactor: parseInt(data.resize_factor) || 1,
                batchSize: parseInt(data.batch_size) || 32,
                onProgress: (percent, message) => {
                    // 通过 IPC 事件发送进度到渲染进程
                    for (const win of wins) {
                        try {
                            win.webContents.send('wav2lip-progress', { percent, message });
                        } catch { /* window closed */ }
                    }
                },
            });
        }

        case 'file/write-text': {
            const filePath = data.path;
            const content = data.content || '';
            if (!filePath) throw new Error('缺少文件路径');
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, content, 'utf-8');
            return { message: '写入成功', path: filePath };
        }

        case 'file/write-base64': {
            const filePath = data.path;
            const content = data.content || '';
            if (!filePath) throw new Error('缺少文件路径');
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            let base64Data = content;
            if (base64Data.includes(',')) {
                base64Data = base64Data.split(',')[1];
            }
            fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
            return { message: '写入成功', path: filePath };
        }

        case 'file/rename': {
            const source = data.source;
            const target = data.target;
            const copyMode = data.copy !== false;
            if (!source || !target) throw new Error('缺少源文件或目标路径');
            if (!fs.existsSync(source)) throw new Error(`文件不存在: ${source}`);
            if (copyMode) {
                fs.copyFileSync(source, target);
            } else {
                fs.renameSync(source, target);
            }
            return { message: copyMode ? '复制成功' : '重命名成功', target };
        }

        case 'file/delete': {
            const filePath = data.path;
            if (!filePath) throw new Error('缺少文件路径');
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            return { message: '删除成功', path: filePath };
        }

        default:
            throw new Error(`未知接口: ${ep}`);
    }
}

/**
 * 文件上传路由
 */
async function routeUpload(endpoint, fileBuffer, fileName, formData) {
    const ep = endpoint.replace(/^\/?(api\/)?/, '');

    switch (ep) {
        case 'upload-image':
        case 'upload': {
            const result = settingsService.uploadFile(Buffer.from(fileBuffer), fileName);
            return result;
        }

        case 'subtitle/generate-with-file': {
            // 保存临时文件
            const tempDir = settingsService.getSecureTmpDir();
            const tempPath = path.join(tempDir, `batch_${crypto.randomUUID()}_${fileName}`);
            fs.writeFileSync(tempPath, Buffer.from(fileBuffer));

            try {
                const gladiaKeysData = settingsService.loadGladiaKeys();
                let gladiaKeys = gladiaKeysData.keys || [];
                if (formData.gladia_keys) {
                    try { gladiaKeys = JSON.parse(formData.gladia_keys); } catch { }
                }

                let sourceText = formData.source_text || '';
                let translateText = formData.translate_text || '';
                const langInput = formData.language || 'en';

                // 确定语言
                let currentLanguage = langInput;
                for (const [code, info] of Object.entries(subtitleUtils.LANGUAGES)) {
                    if (info.name === langInput || info.code === langInput) { currentLanguage = code; break; }
                }
                const langEnName = subtitleUtils.getLanguage(currentLanguage);

                // 构建日志路径
                const baseName = path.parse(fileName).name;
                const logDir = settingsService.getSecureTmpDir('videokit_log');
                fs.mkdirSync(logDir, { recursive: true });
                const audioCacheKey = buildAudioCacheKey(tempPath);
                const jsonPath = path.join(logDir, `${currentLanguage}_${baseName}_${audioCacheKey}_audio_text_whittime.json`);
                const txtPath = path.join(logDir, `${currentLanguage}_${baseName}_${audioCacheKey}_finally.txt`);

                // Gladia 转录
                const cutLength = parseFloat(formData.audio_cut_length || 5.0);
                const result = await gladiaService.transcribeAudioFull(
                    tempPath, gladiaKeys, langEnName, jsonPath, txtPath, cutLength
                );

                const sourceTextCandidates = parseSourceTextCandidates(formData.source_text_candidates);
                let autoMatchedSource = null;

                // Check if current row's text is 100% exact normalized match
                let ownTextMatches = false;
                if (sourceText.trim()) {
                    const normSelected = normalizeForStrictTextMatch(sourceText);
                    const normRecognized = normalizeForStrictTextMatch(result.fullText);
                    if (normSelected && normRecognized && normSelected === normRecognized) {
                        ownTextMatches = true;
                        console.log(`[字幕对齐] 当前行文件文案符合100%归一化匹配，直接使用`);
                    }
                }

                if (!ownTextMatches && sourceTextCandidates.length > 0) {
                    autoMatchedSource = pickExactSourceTextCandidate(result.fullText, sourceTextCandidates);
                    if (!autoMatchedSource) {
                        throw new Error(JSON.stringify({
                            code: 'AUTO_SOURCE_MATCH_NOT_FOUND',
                            similarity: 0,
                            recognized_text: buildRecognizedText(result.wordTimeInfo, result.fullText),
                            message: '自动匹配文案失败: 识别文本和候选文案没有完全一致项（已忽略大小写、标点、空格和换行）'
                        }));
                    }
                    sourceText = autoMatchedSource.sourceText;
                    translateText = autoMatchedSource.translateText || translateText;
                    console.log(`[字幕对齐] 自动匹配文案成功: 候选 #${autoMatchedSource.index + 1}`);
                }

                if (!sourceText) throw new Error('缺少原文本');

                // 写入原文本到临时文件
                const sourceTextPath = settingsService.secureTmpFile('source_upload', '.txt');
                fs.writeFileSync(sourceTextPath, sourceText, 'utf-8');
                const sourceTextWithInfo = subtitleUtils.readTextWithGoogleDoc(sourceTextPath);

                // 翻译文本
                const translateTextDict = {};
                if (translateText) {
                    const translatePath = settingsService.secureTmpFile('translate_upload', '.txt');
                    fs.writeFileSync(translatePath, translateText, 'utf-8');
                    translateTextDict['翻译文本'] = {
                        filename: '翻译文本',
                        filepath: translatePath,
                        translate_text_with_info: subtitleUtils.readTextWithGoogleDoc(translatePath),
                        trans_srt: '',
                    };
                }

                // 输出目录
                const dateStr = new Date().toISOString().replace(/[T:.]/g, '').slice(0, 15);
                const outputDir = formData.output_dir || path.join(os.homedir(), 'Desktop', `字幕输出_${dateStr}`);
                fs.mkdirSync(outputDir, { recursive: true });

                // 选项
                const genMergeSrt = formData.gen_merge_srt === 'true' || formData.gen_merge_srt === true;
                const sourceUpOrder = formData.source_up_order === 'true' || formData.source_up_order === true;
                const exportFcpxml = formData.export_fcpxml === 'true' || formData.export_fcpxml === true;
                const seamlessFcpxml = formData.seamless_fcpxml === 'true' || formData.seamless_fcpxml === true;

                // 完整对齐
                const alignResult = audioSubtitleSearchDifferentStrong(
                    currentLanguage, outputDir, baseName,
                    result.wordTimeInfo, result.fullText,
                    sourceTextWithInfo, translateTextDict,
                    genMergeSrt, sourceUpOrder, exportFcpxml, seamlessFcpxml
                );

                if (typeof alignResult === 'string' && !alignResult.startsWith('生成了字幕文件')) {
                    throw new Error(`字幕对齐失败: ${alignResult}`);
                }

                // 收集生成的文件
                const generatedFiles = [];
                const sourceSrt = path.join(outputDir, `${baseName}_${currentLanguage}_source.srt`);
                if (fs.existsSync(sourceSrt)) generatedFiles.push(sourceSrt);
                for (const k of Object.keys(translateTextDict)) {
                    const transSrt = path.join(outputDir, `${baseName}_${currentLanguage}_${k.replace('.txt', '')}_translate.srt`);
                    if (fs.existsSync(transSrt)) generatedFiles.push(transSrt);
                }
                const mergeSrt = path.join(outputDir, `${baseName}_${currentLanguage}_merge.srt`);
                if (fs.existsSync(mergeSrt)) generatedFiles.push(mergeSrt);
                const fcpxmlFile = path.join(outputDir, `${baseName}_${currentLanguage}.fcpxml`);
                if (fs.existsSync(fcpxmlFile)) generatedFiles.push(fcpxmlFile);

                const timingCalibration = calibrateSrtTimingFromWordTimeline(sourceSrt, generatedFiles, result.wordTimeInfo);
                if (timingCalibration?.applied && exportFcpxml && fs.existsSync(sourceSrt)) {
                    const translateSrtList = Object.keys(translateTextDict)
                        .map(k => path.join(outputDir, `${baseName}_${currentLanguage}_${k.replace('.txt', '')}_translate.srt`))
                        .filter(p => fs.existsSync(p))
                        .map(p => fs.readFileSync(p, 'utf-8'));
                    fcpxmlService.SrtsToFcpxml(fs.readFileSync(sourceSrt, 'utf-8'), translateSrtList, fcpxmlFile, seamlessFcpxml);
                }

                // 清理临时文件
                try { fs.unlinkSync(tempPath); } catch { }
                try { fs.unlinkSync(sourceTextPath); } catch { }

                return {
                    message: '处理完成',
                    result: alignResult,
                    files: generatedFiles,
                    output_dir: outputDir,
                    timing_calibration: timingCalibration,
                    auto_matched_source: autoMatchedSource ? {
                        index: autoMatchedSource.index,
                        source_text: autoMatchedSource.sourceText,
                    } : null,
                };
            } catch (e) {
                try { fs.unlinkSync(tempPath); } catch { }
                throw e;
            }
        }

        case 'audio/smart-split-analyze': {
            // 保存上传的音频文件到临时目录
            const tempDir = settingsService.getSecureTmpDir();
            const tempPath = path.join(tempDir, `smart_split_${crypto.randomUUID()}_${fileName}`);
            fs.writeFileSync(tempPath, Buffer.from(fileBuffer));

            try {
                const maxDuration = parseFloat(formData.max_duration || 29);
                const result = await ffmpegService.smartSplitAnalyze(tempPath, maxDuration);
                return result;
            } finally {
                try { fs.unlinkSync(tempPath); } catch { }
            }
        }

        default:
            throw new Error(`未知上传接口: ${ep}`);
    }
}

module.exports = { registerAPIHandlers };
