/**
 * reels-fcpxml-export.js — 批量 Reels FCPXML 导出
 * 
 * 核心思路：将 Reels 任务行数据 → 转换为 segmentsToFcpxml 需要的 segments 格式
 * → 调用后端 API media/export-fcpxml-timeline（复用已验证的 segmentsToFcpxml 逻辑）
 * 
 * 这样确保输出格式与参考文件 100% 一致。
 */

async function reelsBatchFcpxmlExport(params) {
    const {
        tasks,
        outputDir,
        taskName = 'BatchTimeline',
        fps = 30,
        compoundMode = false,
        onLog
    } = params;

    const log = (msg) => {
        if (onLog) onLog(msg);
        console.log(`[FCPXML Bulk] ${msg}`);
    };

    if (!tasks || tasks.length === 0) {
        throw new Error('没有任务数据');
    }

    log(`准备生成 FCPXML 时间线，共有 ${tasks.length} 个任务`);

    // ═══ 将 Reels 任务行 → segments 格式 ═══
    // segmentsToFcpxml 需要的 segment 格式:
    //   { name, start, end, videoPath, videoDuration, subtitles: [text1, text2, ...], clipColor }
    const segments = [];

    for (let i = 0; i < tasks.length; i++) {
        const config = tasks[i];
        const { task, overlays, segments: srtSegments } = config;
        const videoPath = config.contentVideoPath || config.backgroundPath || '';

        const trimStart = parseFloat(config.contentVideoTrimStart) || 0;
        const trimEnd = parseFloat(config.contentVideoTrimEnd) || 0;
        const clipName = config.taskName || (task && task.fileName) || `Task_${i + 1}`;

        log(`处理任务行 ${i + 1}/${tasks.length}: ${clipName}`);

        // ── 计算时长（与预览 _getPreviewDuration 一致）──
        // 优先级: customDuration → 配音时长 → 内容视频裁剪/全长 → 背景视频时长 → 5s
        let duration = 0;
        let mediaDuration = 0;

        // 获取主视频素材实际时长
        if (videoPath) {
            try {
                if (window.electronAPI && window.electronAPI.getMediaDuration) {
                    mediaDuration = await window.electronAPI.getMediaDuration(videoPath) || 0;
                }
            } catch (e) {
                log(`获取素材时长失败: ${videoPath} - ${e.message}`);
            }
        }

        // 1) 自定义时长优先
        if (config.customDuration > 0) {
            duration = config.customDuration;
        }
        // 2) 有配音 → 以配音时长为准（背景自动循环）
        else if (config.voicePath) {
            try {
                if (window.electronAPI && window.electronAPI.getMediaDuration) {
                    duration = await window.electronAPI.getMediaDuration(config.voicePath) || 0;
                }
            } catch (e) { }
            // 音频变速
            const aDurScale = (task && task.audioDurScale) ? (task.audioDurScale / 100) : 1;
            if (duration > 0) duration = duration * aDurScale;
        }
        // 3) 内容视频裁剪/全长
        if (!duration && trimEnd > trimStart && trimStart >= 0) {
            duration = trimEnd - trimStart;
        }
        if (!duration && mediaDuration > 0) {
            duration = mediaDuration;
        }
        // 4) 兜底
        if (!duration) duration = 5;

        // ── 从覆层提取字幕文本 + 样式 + 位置 ──
        // 每个 subtitle 对象包含完整样式: { text, font, fontSize, fontColor, bold, posX, posY }
        // 位置: 使用参考文件已验证的基线 (720, 800)
        //   X = overlay 中心 X × 4/3 (验证: 540 × 4/3 = 720 ✓)
        //   Y = 基线 800，标题/正文/结尾通过偏移量区分
        const canvasW = 1080;
        const subtitleTexts = [];

        if (overlays && overlays.length > 0) {
            for (const ov of overlays) {
                if (ov.disabled) continue;

                const ovX = parseFloat(ov.x || 0);
                const ovW = parseFloat(ov.w || canvasW);
                // X: 覆层中心 × 4/3
                const fcpX = Math.round((ovX + ovW / 2) * 4 / 3);

                if (ov.type === 'textcard') {
                    const titleText = ov.title_text ? (ov.title_uppercase ? ov.title_text.toUpperCase() : ov.title_text).trim() : '';
                    const bodyText = (ov.body_text || '').trim();
                    const footerText = (ov.footer_text || '').trim();

                    // 标题: 卡片上方 Y=1000 (高于基线800)
                    if (titleText) subtitleTexts.push({
                        text: titleText.replace(/\n/g, '   '),
                        font: ov.title_font_family || 'Crimson Pro',
                        fontSize: ov.title_fontsize || 60,
                        fontColor: ov.title_color || '#000000',
                        bold: ov.title_bold !== false,
                        posX: fcpX, posY: 1000
                    });
                    // 正文: 卡片中部 Y=800 (基线)
                    if (bodyText) subtitleTexts.push({
                        text: bodyText.replace(/\n/g, '   '),
                        font: ov.body_font_family || 'Arial',
                        fontSize: ov.body_fontsize || 40,
                        fontColor: ov.body_color || '#000000',
                        bold: !!ov.body_bold,
                        posX: fcpX, posY: 800
                    });
                    // 结尾: 卡片底部 Y=600 (低于基线)
                    if (footerText) subtitleTexts.push({
                        text: footerText.replace(/\n/g, '   '),
                        font: ov.footer_font_family || 'Arial',
                        fontSize: ov.footer_fontsize || 32,
                        fontColor: ov.footer_color || '#666666',
                        bold: !!ov.footer_bold,
                        posX: fcpX, posY: 600
                    });

                } else if (ov.type === 'text') {
                    const text = (ov.content || '').trim();
                    if (text) subtitleTexts.push({
                        text: text.replace(/\n/g, '   '),
                        font: ov.font_family || 'Arial',
                        fontSize: ov.fontsize || 40,
                        fontColor: ov.color || '#FFFFFF',
                        bold: !!ov.bold,
                        posX: fcpX, posY: 800
                    });

                } else if (ov.type === 'scroll') {
                    const scrollTitle = (ov.scroll_title || '').trim();
                    const scrollContent = (ov.content || '').trim();
                    if (scrollTitle) subtitleTexts.push({
                        text: scrollTitle.replace(/\n/g, '   '),
                        font: ov.scroll_title_font_family || ov.font_family || 'Arial',
                        fontSize: ov.scroll_title_fontsize || 56,
                        fontColor: ov.scroll_title_color || ov.color || '#FFFFFF',
                        bold: ov.scroll_title_bold !== false,
                        posX: fcpX, posY: 1000
                    });
                    if (scrollContent) subtitleTexts.push({
                        text: scrollContent.replace(/\n/g, '   '),
                        font: ov.font_family || 'Arial',
                        fontSize: ov.fontsize || 40,
                        fontColor: ov.color || '#FFFFFF',
                        bold: !!ov.bold,
                        posX: fcpX, posY: 700
                    });
                }
            }
        }

        // 如果没有覆层文字，回退到 SRT segments 文本
        if (subtitleTexts.length === 0 && srtSegments && srtSegments.length > 0) {
            const allText = srtSegments.map(seg => seg.text).join('   ');
            subtitleTexts.push({
                text: allText, font: 'Playfair Display', fontSize: 32,
                fontColor: '#FFE500', bold: true, posX: 720, posY: 800
            });
        }

        // ── 构造 segment ──
        // 分离背景视频 + 内容视频（支持多轨道导出）
        // 如果有 contentVideoPath 则优先，否则用 videoPath（主视频）作为内容。
        const contentPath = config.contentVideoPath || config.videoPath || '';
        const bgPath2 = config.backgroundPath || '';
        // 只有当内容视频和背景视频都有值且不同时，才分为两个轨道
        const hasSeparateBg = contentPath && bgPath2 && bgPath2 !== contentPath;
        let bgDuration = 0;
        if (hasSeparateBg) {
            try {
                if (window.electronAPI && window.electronAPI.getMediaDuration) {
                    bgDuration = await window.electronAPI.getMediaDuration(bgPath2) || 0;
                }
            } catch (e) { }
        }

        const seg = {
            name: clipName,
            // 内容视频（主轨或 lane 1）
            videoPath: contentPath || bgPath2,
            videoDuration: mediaDuration || duration,
            start: trimStart,
            end: trimStart + duration,
            // 背景视频（spine V1，仅当有独立背景时）
            bgPath: hasSeparateBg ? bgPath2 : null,
            bgDuration: bgDuration,
            loopFadeDur: parseFloat(task?.loopFadeDur || config.loopFadeDur || 1.0),
            // 覆层
            subtitles: subtitleTexts,
            overlayPngPath: config.overlayPngPath || null,
        };

        segments.push(seg);
    }

    log(`已转换 ${segments.length} 个任务行为 segments，准备调用后端 API`);
    // 调试: 打印每个 segment 的关键字段
    for (let si = 0; si < segments.length; si++) {
        const s = segments[si];
        log(`  segment[${si}] "${s.name}": videoPath=${s.videoPath ? '✓' : '✗'}, bgPath=${s.bgPath || '✗'}, bgDur=${s.bgDuration || 0}, overlayPng=${s.overlayPngPath ? '✓' : '✗'}, subtitles=${s.subtitles?.length || 0}`);
    }

    // ═══ 调用后端 segmentsToFcpxml API ═══
    // apiFetch 是 app.js 的全局函数，内部通过 window.electronAPI.apiCall IPC 通信
    if (window.electronAPI && window.electronAPI.apiCall) {
        try {
            // 构建字幕样式 (使用与参考文件一致的列配置)
            const subtitleStyle = _buildSubtitleStyleFromTasks(tasks);

            const result = await window.electronAPI.apiCall('media/export-fcpxml-timeline', {
                multi_video: true,
                segments: segments,
                fps: fps,
                resolution: '1080x1920',
                output_dir: outputDir,
                subtitle_style: subtitleStyle,
                compound_mode: compoundMode,
            });

            if (result && result.success && result.data) {
                const outputPath = result.data.path;
                log(`达芬奇序列导出完成! 路径: ${outputPath}`);
                return { outputPath };
            } else {
                throw new Error(result?.error || 'API 返回失败');
            }
        } catch (err) {
            log(`后端 API 调用失败: ${err.message}，回退到前端生成`);
            // 回退：前端直接生成 FCPXML
            return await _fallbackFrontendExport(segments, outputDir, taskName, fps, tasks, log);
        }
    }

    // 无 API 时直接前端生成
    return await _fallbackFrontendExport(segments, outputDir, taskName, fps, tasks, log);
}


/**
 * 根据任务列表中覆层的字体样式构建 subtitle_style.columns
 * 与 segmentsToFcpxml 的 columns 格式对齐
 */
function _buildSubtitleStyleFromTasks(tasks) {
    // 取第一个有覆层的任务作为样式参考
    let maxCols = 0;
    for (const config of tasks) {
        const subs = _countSubtitleTexts(config);
        if (subs > maxCols) maxCols = subs;
    }
    if (maxCols === 0) maxCols = 1;

    // 默认列样式 (与参考文件一致)
    const columns = [];
    for (let ci = 0; ci < maxCols; ci++) {
        columns.push({
            font: 'Playfair Display',
            fontFace: 'SemiBold',
            fontSize: 32,
            color: '#FFE500',  // 黄色
            posX: 720,
            posY: 800,
            bold: true,
            tracking: '0',
            lineSpacing: '0',
        });
    }

    // 从第一个有覆层的任务中读取字体样式覆盖
    for (const config of tasks) {
        const overlays = config.overlays || [];
        let colIdx = 0;
        for (const ov of overlays) {
            if (ov.disabled) continue;
            if (ov.type === 'textcard') {
                if ((ov.title_text || '').trim() && colIdx < columns.length) {
                    columns[colIdx].font = ov.title_font_family || 'Crimson Pro';
                    columns[colIdx].fontSize = ov.title_fontsize || 60;
                    if (ov.title_color) columns[colIdx].color = ov.title_color;
                    columns[colIdx].bold = ov.title_bold !== false;
                    colIdx++;
                }
                if ((ov.body_text || '').trim() && colIdx < columns.length) {
                    columns[colIdx].font = ov.body_font_family || 'Arial';
                    columns[colIdx].fontSize = ov.body_fontsize || 40;
                    if (ov.body_color) columns[colIdx].color = ov.body_color;
                    columns[colIdx].bold = !!ov.body_bold;
                    colIdx++;
                }
                if ((ov.footer_text || '').trim() && colIdx < columns.length) {
                    columns[colIdx].font = ov.footer_font_family || 'Arial';
                    columns[colIdx].fontSize = ov.footer_fontsize || 32;
                    if (ov.footer_color) columns[colIdx].color = ov.footer_color;
                    columns[colIdx].bold = !!ov.footer_bold;
                    colIdx++;
                }
            } else if (ov.type === 'text' && (ov.content || '').trim() && colIdx < columns.length) {
                columns[colIdx].font = ov.font_family || 'Arial';
                columns[colIdx].fontSize = ov.fontsize || 40;
                if (ov.color) columns[colIdx].color = ov.color;
                columns[colIdx].bold = !!ov.bold;
                colIdx++;
            } else if (ov.type === 'scroll') {
                if ((ov.scroll_title || '').trim() && colIdx < columns.length) {
                    columns[colIdx].font = ov.scroll_title_font_family || ov.font_family || 'Arial';
                    columns[colIdx].fontSize = ov.scroll_title_fontsize || 56;
                    if (ov.scroll_title_color || ov.color) columns[colIdx].color = ov.scroll_title_color || ov.color;
                    columns[colIdx].bold = ov.scroll_title_bold !== false;
                    colIdx++;
                }
                if ((ov.content || '').trim() && colIdx < columns.length) {
                    columns[colIdx].font = ov.font_family || 'Arial';
                    columns[colIdx].fontSize = ov.fontsize || 40;
                    if (ov.color) columns[colIdx].color = ov.color;
                    columns[colIdx].bold = !!ov.bold;
                    colIdx++;
                }
            }
        }
        if (colIdx > 0) break; // 用第一个有效任务的样式
    }

    return { columns };
}

/** 统计一个任务中的字幕文本数量 */
function _countSubtitleTexts(config) {
    const overlays = config.overlays || [];
    let count = 0;
    for (const ov of overlays) {
        if (ov.disabled) continue;
        if (ov.type === 'textcard') {
            if ((ov.title_text || '').trim()) count++;
            if ((ov.body_text || '').trim()) count++;
            if ((ov.footer_text || '').trim()) count++;
        } else if (ov.type === 'text' && (ov.content || '').trim()) {
            count++;
        } else if (ov.type === 'scroll') {
            if ((ov.scroll_title || '').trim()) count++;
            if ((ov.content || '').trim()) count++;
        }
    }
    // 回退到 SRT segments
    if (count === 0 && config.segments && config.segments.length > 0) count = 1;
    return count;
}


/**
 * 前端回退方案：直接生成 FCPXML（完全对标 segmentsToFcpxml 的输出格式）
 */
async function _fallbackFrontendExport(segments, outputDir, taskName, fps, tasks, log) {
    const fpsInt = Math.round(fps);
    const secToFrac = (sec) => `${Math.round(sec * fpsInt)}/${fpsInt}s`;
    const xmlEscape = (str) => {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    };
    const toFileUrl = (filePath) => {
        if (!filePath) return '';
        if (window.electronAPI && window.electronAPI.toFileUrl) {
            return window.electronAPI.toFileUrl(filePath);
        }
        if (filePath.startsWith('file://')) return filePath;
        return 'file://' + filePath;
    };

    // 默认列样式
    const defaultCol = { font: 'Playfair Display', fontFace: 'SemiBold', fontSize: 32, color: '1 0.8980392156862745 0 1', posX: 720, posY: 800, bold: '1' };

    // 计算总时长
    let totalDuration = 0;
    for (const seg of segments) {
        const d = (seg.videoPath && seg.videoDuration) ? seg.videoDuration : (seg.end - seg.start);
        totalDuration += d > 0 ? d : 0;
    }

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<!DOCTYPE fcpxml>\n';
    xml += '<fcpxml version="1.9">\n';
    xml += '\t<resources>\n';
    xml += `\t\t<format id="r0" name="FFVideoFormat1920p${fpsInt}" frameDuration="1/${fpsInt}s" width="1080" height="1920"/>\n`;

    // 注册 assets
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const clipName = xmlEscape(seg.name || `片段${i + 1}`);
        const assetSrc = xmlEscape(toFileUrl(seg.videoPath || ''));
        const assetDurStr = seg.videoDuration > 0 ? secToFrac(seg.videoDuration) : `0/${fpsInt}s`;
        xml += `\t\t<asset name="${clipName}" src="${assetSrc}" start="0/${fpsInt}s" duration="${assetDurStr}" hasVideo="1" hasAudio="1" format="r0" id="r${i + 1}"/>\n`;
    }
    // PNG 覆层 assets
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.overlayPngPath) {
            const pngSrc = xmlEscape(toFileUrl(seg.overlayPngPath));
            xml += `\t\t<asset name="overlay_${i + 1}" src="${pngSrc}" start="0/${fpsInt}s" duration="0/${fpsInt}s" hasVideo="1" hasAudio="0" format="r0" id="r${200 + i}"/>\n`;
        }
    }
    xml += `\t\t<effect name="Basic Title" uid=".../Titles.localized/Build In:Out.localized/Basic Title.localized/Basic Title.moti" id="r100"/>\n`;
    xml += '\t</resources>\n';

    const safeTimelineName = xmlEscape(taskName);
    xml += '\t<library>\n';
    xml += `\t\t<event name="${safeTimelineName}">\n`;
    xml += `\t\t\t<project name="${safeTimelineName}">\n`;
    xml += `\t\t\t\t<sequence tcFormat="NDF" tcStart="0/${fpsInt}s" duration="${secToFrac(totalDuration)}" format="r0">\n`;
    xml += '\t\t\t\t\t<spine>\n';

    // 逐个 segment 生成 asset-clip
    let timelineOffset = 0;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segStart = seg.start || 0;
        // 尊重裁剪点
        const hasExplicitTrim = (seg.start > 0) || (seg.end != null && seg.end > 0);
        const segEnd = hasExplicitTrim ? (seg.end || seg.videoDuration || 0) : (seg.videoDuration || (seg.end || 0));
        const segDuration = segEnd - segStart;
        const clipName = xmlEscape(seg.name || `片段${i + 1}`);
        const subtitles = seg.subtitles || [];

        xml += `\t\t\t\t\t\t<asset-clip name="${clipName}" ref="r${i + 1}" offset="${secToFrac(timelineOffset)}" start="${secToFrac(segStart)}" duration="${secToFrac(segDuration)}" format="r0" tcFormat="NDF">\n`;

        // ── PNG 覆层优先，否则用 Basic Title ──
        if (seg.overlayPngPath) {
            xml += `\t\t\t\t\t\t\t<asset-clip name="overlay_${clipName}" ref="r${200 + i}" lane="1" offset="${secToFrac(segStart)}" duration="${secToFrac(segDuration)}" format="r0" tcFormat="NDF"/>\n`;
        } else {
        const totalLanes = subtitles.length;
        for (let ci = 0; ci < subtitles.length; ci++) {
            const subEntry = subtitles[ci];
            const isObj = subEntry && typeof subEntry === 'object';
            const text = isObj ? (subEntry.text || '').trim() : (subEntry || '').trim();
            if (!text) continue;

            const lane = totalLanes - ci;
            const styleId = `ts_${i}_${ci + 1}`;
            const posX = isObj && subEntry.posX != null ? subEntry.posX : defaultCol.posX;
            const posY = isObj && subEntry.posY != null ? subEntry.posY : defaultCol.posY;

            // 字体: 优先用 subtitle 对象的样式
            const subFont = isObj && subEntry.font ? subEntry.font : defaultCol.font;
            const subFontSize = isObj && subEntry.fontSize ? subEntry.fontSize : defaultCol.fontSize;
            const subBold = isObj && subEntry.bold != null ? (subEntry.bold ? '1' : '0') : defaultCol.bold;
            let subFontColor = defaultCol.color;
            if (isObj && subEntry.fontColor) {
                const hex = subEntry.fontColor.replace('#', '');
                if (hex.length >= 6) {
                    const r = parseInt(hex.substring(0, 2), 16) / 255;
                    const g = parseInt(hex.substring(2, 4), 16) / 255;
                    const b = parseInt(hex.substring(4, 6), 16) / 255;
                    subFontColor = `${r} ${g} ${b} 1`;
                }
            }

            xml += `\t\t\t\t\t\t\t<title name="${xmlEscape(text.slice(0, 40))}" lane="${lane}" offset="${secToFrac(segStart)}" ref="r100" duration="${secToFrac(segDuration)}" start="3600/1s">\n`;
            xml += `\t\t\t\t\t\t\t\t<param name="Position" key="9999/999166631/999166633/2/100/101" value="${posX} ${posY}"/>\n`;
            xml += `\t\t\t\t\t\t\t\t<text>\n`;
            xml += `\t\t\t\t\t\t\t\t\t<text-style ref="${styleId}">${xmlEscape(text)}</text-style>\n`;
            xml += `\t\t\t\t\t\t\t\t</text>\n`;
            xml += `\t\t\t\t\t\t\t\t<text-style-def id="${styleId}">\n`;
            xml += `\t\t\t\t\t\t\t\t\t<text-style font="${xmlEscape(subFont)}" fontFace="SemiBold" fontSize="${subFontSize}" fontColor="${subFontColor}" bold="${subBold}" tracking="0" lineSpacing="0" alignment="center" verticalAlignment="top"/>\n`;
            xml += `\t\t\t\t\t\t\t\t</text-style-def>\n`;
            xml += `\t\t\t\t\t\t\t</title>\n`;
        }
        } // end else (Basic Title fallback)

        xml += `\t\t\t\t\t\t</asset-clip>\n`;
        timelineOffset += segDuration;
    }

    xml += '\t\t\t\t\t</spine>\n';
    xml += '\t\t\t\t</sequence>\n';
    xml += '\t\t\t</project>\n';
    xml += '\t\t</event>\n';
    xml += '\t</library>\n';
    xml += '</fcpxml>\n';

    // 写入文件
    let sep = outputDir.includes('\\') ? '\\' : '/';
    let safeDir = outputDir.endsWith(sep) ? outputDir.slice(0, -1) : outputDir;
    const outputPath = `${safeDir}${sep}${taskName}.fcpxml`;

    log(`写入 FCPXML: ${outputPath}`);

    if (window.electronAPI) {
        if (window.electronAPI.ensureDirectory) {
            try { await window.electronAPI.ensureDirectory(safeDir); } catch (err) { }
        }
        if (window.electronAPI.writeFileText) {
            const writeOk = await window.electronAPI.writeFileText(outputPath, xml);
            if (writeOk === false) throw new Error('写入文件失败');
        } else {
            throw new Error('缺少 writeFileText 接口');
        }
    } else {
        throw new Error('非 Electron 环境');
    }

    log('达芬奇序列导出完成!');
    return { outputPath };
}


if (typeof window !== 'undefined') {
    window.reelsFcpxmlExport = reelsBatchFcpxmlExport;
    window.reelsBatchFcpxmlExport = reelsBatchFcpxmlExport;
}
