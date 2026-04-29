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
    let lastError = null;
    let keyIndex = Math.floor(Math.random() * keys.length);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const apiKey = keys[keyIndex % keys.length].trim();

        try {
            console.log(`[Gemini] 第 ${attempt + 1}/${maxRetries} 次请求 (Key #${keyIndex % keys.length + 1}, ${isAiStudioKey(apiKey) ? 'AI Studio' : 'Vertex AI'})`);

            const ai = createAiInstance(apiKey);
            const response = await ai.models.generateContent({
                model: modelId,
                ...config
            });

            return response;

        } catch (e) {
            const msg = e.message || String(e);
            const status = e.status || e.httpStatusCode || 0;

            // 可重试：429 限流、503 过载、500 内部错误
            if (status === 429 || status === 503 || status === 500 ||
                msg.includes('429') || msg.includes('503') || msg.includes('RESOURCE_EXHAUSTED')) {
                const waitSec = Math.pow(2, attempt) * 2 + Math.random() * 2;
                console.warn(`[Gemini] ${status || '限流'}，等待 ${waitSec.toFixed(1)}s 后重试...`);
                lastError = e;
                keyIndex++;
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }

            // 不可重试
            throw new Error(`Gemini API 错误: ${msg}`);
        }
    }

    throw new Error(`Gemini 请求在 ${maxRetries} 次重试后仍然失败。\n最后错误：${lastError?.message || '未知错误'}\n\n建议：\n1. 等待 1-2 分钟后重试\n2. 检查是否有其他可用的 API Key`);
}

/**
 * AI 处理文案 (Voice Mode)
 */
async function processScripts(scripts, keys, customPrompt, modelId) {
    if (!keys || keys.length === 0) {
        throw new Error('未配置 Gemini API Keys，请在设置中配置');
    }

    const systemPrompt = customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_GEMINI_PROMPT;
    const resolvedModel = (modelId && modelId.trim()) ? modelId.trim() : 'gemini-2.5-flash';
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
 * 批量测试 API Keys（并发，每波 20 个）
 * 自动根据 Key 前缀路由到 AI Studio 或 Vertex AI 端点
 */
async function testKeys(keys, modelId) {
    const resolvedModel = (modelId && modelId.trim()) ? modelId.trim() : 'gemini-2.5-flash';
    const CONCURRENCY = 20;

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
                reason = 'Key 格式无效';
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
