const { GoogleGenAI } = require('@google/genai');
const { DEFAULT_GEMINI_PROMPT } = require('./settings');

/**
 * 判断 Key 类型：AIza 开头 = AI Studio，其他 = Vertex AI
 * 与 AI 创作工具包 (aiStudioDetect.ts) 完全一致的逻辑
 */
function isAiStudioKey(apiKey) {
    return apiKey.trim().startsWith('AIza');
}

/**
 * 根据 Key 类型创建 GoogleGenAI 实例
 * - AIza... → AI Studio 端点 (generativelanguage.googleapis.com)
 * - 其他    → Vertex AI 端点 (aiplatform.googleapis.com)
 */
function createAiInstance(apiKey) {
    const key = apiKey.trim();
    if (isAiStudioKey(key)) {
        return new GoogleGenAI({ apiKey: key });
    }
    // Vertex AI 模式：不需要 Project ID，SDK 通过 API Key 自动关联项目
    return new GoogleGenAI({
        apiKey: key,
        vertexai: true,
        httpOptions: { baseUrl: 'https://aiplatform.googleapis.com/' }
    });
}

/**
 * 带重试和 Key 轮换的 Gemini SDK 调用
 */
async function callWithRetry(keys, modelId, config, maxRetries = 3) {
    const usableKeys = (keys || []).map(k => String(k || '').trim()).filter(Boolean);
    if (usableKeys.length === 0) throw new Error('未配置可用的 Gemini API Key');

    const startIndex = Math.floor(Math.random() * usableKeys.length);
    const orderedKeys = usableKeys.map((_, i) => usableKeys[(startIndex + i) % usableKeys.length]);
    const retryQueue = [];
    const failures = [];
    const maxAttempts = usableKeys.length + Math.max(0, maxRetries - 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const apiKey = attempt < orderedKeys.length
            ? orderedKeys[attempt]
            : retryQueue.shift();
        if (!apiKey) break;
        const keyNumber = usableKeys.indexOf(apiKey) + 1;

        try {
            console.log(`[Gemini] 第 ${attempt + 1}/${maxAttempts} 次请求 (Key #${keyNumber}, ${isAiStudioKey(apiKey) ? 'AI Studio' : 'Vertex AI'})`);

            const ai = createAiInstance(apiKey);
            const response = await ai.models.generateContent({
                model: modelId,
                ...config
            });

            return response;

        } catch (e) {
            const msg = e.message || String(e);
            const status = e.status || e.httpStatusCode || 0;
            const isTransient = status === 429 || status === 503 || status === 500 ||
                msg.includes('429') || msg.includes('503') || msg.includes('RESOURCE_EXHAUSTED') ||
                msg.includes('UNAVAILABLE') || msg.includes('high demand');
            const isAuthFailure = status === 401 || status === 403 ||
                msg.includes('401') || msg.includes('403') || msg.includes('API_KEY_INVALID') ||
                msg.includes('PERMISSION_DENIED') || msg.includes('API key expired');
            const isModelFailure = status === 404 || msg.includes('404') || msg.toLowerCase().includes('model') && msg.toLowerCase().includes('not found');

            failures.push({ keyNumber, message: msg, transient: isTransient });

            // 模型不存在是全局配置错误，换 Key 没有意义。
            if (isModelFailure) {
                throw new Error(`Gemini 模型 ${modelId} 不存在或当前项目无权使用，请更换模型。原始错误：${msg}`);
            }

            // 限流/服务繁忙：先尝试下一个 Key，所有 Key 试过后再短暂重试。
            if (isTransient) {
                if (retryQueue.length < Math.max(0, maxRetries - 1)) retryQueue.push(apiKey);
                const hasNext = attempt + 1 < maxAttempts && (attempt + 1 < orderedKeys.length || retryQueue.length > 0);
                if (hasNext) {
                    const waitMs = Math.min(3000, 500 * (attempt + 1));
                    console.warn(`[Gemini] Key #${keyNumber} 暂时受限/繁忙，${waitMs}ms 后切换下一个 Key`);
                    await new Promise(r => setTimeout(r, waitMs));
                }
                continue;
            }

            // 单个 Key 的鉴权失败不能拖垮整个池，继续尝试其他 Key。
            if (isAuthFailure && attempt + 1 < orderedKeys.length) {
                console.warn(`[Gemini] Key #${keyNumber} 鉴权失败，切换下一个 Key`);
                continue;
            }

            // 400/INVALID_ARGUMENT 通常是请求或模型配置错误，不能误报成 Key 无效。
            if (status === 400 || msg.includes('400') || msg.includes('INVALID_ARGUMENT')) {
                throw new Error(`Gemini 请求参数或模型配置不兼容：${msg}`);
            }

            // 其他错误仍尝试尚未检查的 Key。
            if (attempt + 1 < orderedKeys.length) continue;
            throw new Error(`Gemini API 错误: ${msg}`);
        }
    }

    const transientCount = failures.filter(f => f.transient).length;
    const summary = failures.slice(-3).map(f => `Key #${f.keyNumber}: ${f.message.slice(0, 160)}`).join('\n');
    throw new Error(`所有 Gemini Key 均尝试失败（共 ${usableKeys.length} 个，暂时限流/繁忙 ${transientCount} 次）。\n${summary}\n\n429 不代表 Key 失效；请等待后重试或检查项目实际额度。`);
}

/**
 * AI 处理文案 (Voice Mode)
 */
async function processScripts(scripts, keys, customPrompt, modelId) {
    if (!keys || keys.length === 0) {
        throw new Error('未配置 Gemini API Keys，请在设置中配置');
    }

    const systemPrompt = customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_GEMINI_PROMPT;
    const resolvedModel = (modelId && modelId.trim()) ? modelId.trim() : 'gemini-3.5-flash-lite';
    console.log(`[Gemini] 使用模型: ${resolvedModel}`);

    const numberedInputs = scripts.map((s) => `[${s.idx}] ${s.text}`).join('\n\n');

    const userPrompt = `请为以下每条文案添加情感标签并断行：

${numberedInputs}

按格式输出每条结果：[编号] 加标签结果|||断句结果
注意：断句结果中的换行用 \\n 表示，不要真正换行。`;

    const response = await callWithRetry(keys, resolvedModel, {
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.4
        },
        contents: userPrompt
    });

    const aiText = response.text || '';

    const results = [];
    for (const line of aiText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const match = trimmed.match(/^\[([^\]]+)\]\s*(.+)$/);
        if (match) {
            const idx = parseInt(match[1], 10);
            const content = match[2];

            const parts = content.split('|||');
            if (parts.length >= 2) {
                results.push({
                    idx,
                    tts_text: parts[0].trim(),
                    display_text: parts[1].trim().replace(/\\n/g, '\n')
                });
            } else {
                results.push({
                    idx,
                    tts_text: content,
                    display_text: content.replace(/\\n/g, '\n')
                });
            }
        }
    }
    return { results };
}

/**
 * 批量测试 API Keys（低并发，避免测试动作本身触发免费额度 429）
 * 自动根据 Key 前缀路由到 AI Studio 或 Vertex AI 端点
 */
async function testKeys(keys, modelId) {
    const resolvedModel = (modelId && modelId.trim()) ? modelId.trim() : 'gemini-3.5-flash-lite';
    const CONCURRENCY = 3;

    const testOne = async (apiKey, idx) => {
        const startTime = Date.now();
        const mode = isAiStudioKey(apiKey) ? 'AI Studio' : 'Vertex AI';
        try {
            const ai = createAiInstance(apiKey);
            await ai.models.generateContent({
                model: resolvedModel,
                contents: 'Hi',
                config: { temperature: 0, maxOutputTokens: 5 }
            });
            const elapsed = Date.now() - startTime;
            return { idx, key: apiKey, success: true, latency: elapsed, mode };
        } catch (e) {
            const elapsed = Date.now() - startTime;
            const msg = e.message || String(e);
            console.error(`[TestKey #${idx}] (${mode}) 原始错误:`, msg);
            let reason = msg;
            // 按优先级匹配具体错误原因
            if (msg.includes('API_KEY_INVALID') || msg.includes('API key expired')) {
                reason = 'Key 已过期或被删除';
            } else if (msg.includes('denied access') || msg.includes('API_KEY_SERVICE_BLOCKED')) {
                reason = '项目已被封禁';
            } else if (msg.includes('PERMISSION_DENIED') || msg.includes('401') || msg.includes('403')) {
                reason = 'Key 无权限';
            } else if (msg.includes('RATE_LIMIT_EXCEEDED') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
                reason = '配额耗尽(429)';
            } else if (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand')) {
                reason = '模型暂时繁忙(503)，Key 可能有效';
            } else if (msg.includes('404') || msg.includes('not found')) {
                reason = `模型 ${resolvedModel} 不存在`;
            } else if (msg.includes('400') || msg.includes('INVALID_ARGUMENT')) {
                reason = '请求参数或模型配置不兼容（不代表 Key 无效）';
            }
            if (reason.length > 80) reason = reason.slice(0, 77) + '...';
            return { idx, key: apiKey, success: false, error: reason, latency: elapsed, mode };
        }
    };

    // 分波执行
    const results = [];
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
        const chunk = keys.slice(i, i + CONCURRENCY);
        const wave = await Promise.all(chunk.map((k, j) => testOne(k, i + j)));
        results.push(...wave);
    }
    return results;
}

module.exports = {
    processScripts,
    testKeys
};
