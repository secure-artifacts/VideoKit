function cleanCapturedPath(value) {
    const text = String(value || '').trim().replace(/^["']|["']$/g, '');
    return text.replace(/[.]+$/, '');
}

function extractMissingPath(stderr) {
    const raw = String(stderr || '');
    const patterns = [
        /Error opening input file\s+(.+?)\.?\r?(?:\n|$)/i,
        /(?:^|\n)(.+?):\s*No such file or directory\r?(?:\n|$)/i,
    ];
    for (const pattern of patterns) {
        const match = raw.match(pattern);
        if (match && match[1]) return cleanCapturedPath(match[1]);
    }
    return '';
}

/**
 * Convert noisy FFmpeg/FFprobe stderr into a short user-facing Chinese message.
 * Full stderr should still be logged by the caller for diagnostics.
 */
function formatMediaError(stderr, options = {}) {
    const raw = String(stderr || '');
    const action = options.action || '媒体处理';
    const code = options.code;
    const missingLabel = options.missingLabel || '素材文件';
    const missingPath = extractMissingPath(raw);

    if (missingPath || /No such file or directory|ENOENT/i.test(raw)) {
        const target = missingPath ? `：${missingPath}` : '';
        return `${missingLabel}不存在或已被移动，请重新选择${target}`;
    }
    if (/Permission denied|Operation not permitted|EACCES|EPERM/i.test(raw)) {
        return `${action}失败：没有文件读取或写入权限，请检查文件和输出目录权限`;
    }
    if (/No space left on device|disk full|ENOSPC/i.test(raw)) {
        return `${action}失败：磁盘空间不足，请清理空间或更换输出目录`;
    }
    if (/Read-only file system|EROFS/i.test(raw)) {
        return `${action}失败：输出位置不可写，请更换输出目录`;
    }
    if (/Invalid data found when processing input|moov atom not found|could not find codec parameters|unsupported codec|unsupported format/i.test(raw)) {
        return `${action}失败：素材文件可能已损坏，或格式不受支持`;
    }
    if (/does not contain any stream|matches no streams|Output file does not contain any stream|audio stream.*not found/i.test(raw)) {
        return `${action}失败：素材中没有可用的音轨`;
    }
    if (/Unknown encoder|Encoder .* not found|Error while opening encoder|No capable devices found|cannot load.*(?:videotoolbox|nvenc|qsv)|device setup failed/i.test(raw)) {
        return `${action}失败：视频编码器不可用，请切换为 CPU 编码后重试`;
    }
    if (/Error initializing complex filters|Error reinitializing filters|No such filter|Failed to configure output pad/i.test(raw)) {
        return `${action}失败：滤镜或特效参数不兼容，请调整导出设置后重试`;
    }
    if (/Invalid argument/i.test(raw)) {
        return `${action}失败：导出参数或文件路径无效`;
    }

    const codeText = code === undefined || code === null ? '' : `（错误码 ${code}）`;
    return `${action}失败${codeText}。请检查素材格式和导出设置；详细日志已写入控制台`;
}

function formatProcessStartError(command, resolvedCommand, error) {
    const message = String(error?.message || error || '');
    if (/ENOENT|not found/i.test(message)) {
        return `${command} 未安装或程序文件不存在，无法启动媒体处理`;
    }
    if (/EACCES|EPERM|Permission denied/i.test(message)) {
        return `${command} 无法启动：没有程序执行权限`;
    }
    return `${command} 无法启动，请重新启动应用后重试`;
}

module.exports = {
    formatMediaError,
    formatProcessStartError,
    extractMissingPath,
};
