const fs = require('fs');
const path = require('path');
const { getBackendDir, DEFAULT_GEMINI_PROMPT } = require('./settings');

/**
 * 带重试和 Key 轮换的 Gemini API 调用
 * @param {string} url - API endpoint (不含 key 参数)
 * @param {object} payload - 请求体
 * @param {string[]} keys - 可用的 API key 列表
 * @param {number} maxRetries - 最大重试次数，默认 3
 * @returns {Promise<object>} - 解析后的 JSON 响应
 */
async function callGeminiWithRetry(baseUrl, payload, keys, maxRetries = 3) {
    let lastError = null;
    let keyIndex = Math.floor(Math.random() * keys.length);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const apiKey = keys[keyIndex % keys.length].trim();
        const url = `${baseUrl}?key=${apiKey}`;

        try {
            console.log(`[Gemini] 第 ${attempt + 1}/${maxRetries} 次请求 (Key #${keyIndex % keys.length + 1})`);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                return await response.json();
            }

            const errText = await response.text();
            const status = response.status;

            // 可重试的状态码：429 (限流)、503 (过载)、500 (内部错误)
            if (status === 429 || status === 503 || status === 500) {
                const waitSec = Math.pow(2, attempt) * 2 + Math.random() * 2; // 指数退避: ~2s, ~6s, ~14s
                console.warn(`[Gemini] 收到 ${status}，等待 ${waitSec.toFixed(1)}s 后重试...`);
                lastError = new Error(`API 错误 (${status}): ${errText}`);
                keyIndex++; // 换一个 key 再试
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }

            // 不可重试的错误码（400 参数错误、401/403 鉴权失败等），直接抛出
            throw new Error(`API 错误 (${status}): ${errText}`);

        } catch (e) {
            // 网络超时等可能的 fetch 异常
            if (e.message.startsWith('API 错误')) {
                // 已经格式化的 API 错误，非网络问题
                if (!e.message.includes('429') && !e.message.includes('503') && !e.message.includes('500')) {
                    throw e; // 不可重试
                }
                lastError = e;
            } else {
                // 网络层面的异常 (ECONNRESET, timeout 等)
                const waitSec = Math.pow(2, attempt) * 2 + Math.random() * 2;
                console.warn(`[Gemini] 网络异常: ${e.message}，等待 ${waitSec.toFixed(1)}s 后重试...`);
                lastError = e;
                keyIndex++;
                await new Promise(r => setTimeout(r, waitSec * 1000));
            }
        }
    }

    throw new Error(`Gemini 请求在 ${maxRetries} 次重试后仍然失败。\n最后一次错误：${lastError?.message || '未知错误'}\n\n建议：\n1. 等待 1-2 分钟后重试（模型可能正在高峰期）\n2. 检查是否有其他可用的 API Key`);
}

/**
 * AI 处理文案 (Voice Mode)
 */
async function processScripts(scripts, keys, customPrompt) {
    if (!keys || keys.length === 0) {
        throw new Error('未配置 Gemini API Keys，请在设置中配置');
    }
    
    // 默认指令，如果用户没有自定义则使用此默认版本
    const VOICE_MODE_SYSTEM_INSTRUCTION = customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_GEMINI_PROMPT;

    const numberedInputs = scripts.map((s) => `[${s.idx}] ${s.text}`).join('\n\n');
    
    const userPrompt = `请为以下每条文案添加情感标签并断行：

${numberedInputs}

按格式输出每条结果：[编号] 加标签结果|||断句结果
注意：断句结果中的换行用 \\n 表示，不要真正换行。`;
    
    const payload = {
        system_instruction: {
            parts: [{ text: VOICE_MODE_SYSTEM_INSTRUCTION }]
        },
        contents: [
            {
                role: "user",
                parts: [{ text: userPrompt }]
            }
        ],
        generationConfig: {
            temperature: 0.4
        }
    };
    
    const baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent`;
    
    // 使用带重试的调用
    const json = await callGeminiWithRetry(baseUrl, payload, keys, 3);
    
    const aiText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
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

module.exports = {
    processScripts
};
