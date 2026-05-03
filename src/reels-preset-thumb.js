/**
 * reels-preset-thumb.js - 覆层预设缩略图渲染引擎
 * 
 * 用于在 OffscreenCanvas / Canvas 上将覆层数据渲染为 270x480 的缩略图。
 */

class PresetThumbRenderer {
    constructor() {
        this.THUMB_W = 540;
        this.THUMB_H = 960;
        this.SCALE = this.THUMB_W / 1080; // 从 1080x1920 缩放
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.THUMB_W;
        this.canvas.height = this.THUMB_H;
        this.ctx = this.canvas.getContext('2d');
    }

    /**
     * 渲染覆层组缩略图
     * @param {Array} layers - 覆层数据数组
     * @param {string} bgColor - 背景色
     * @returns {string} base64 DataURL (image/webp)
     */
    renderThumb(layers, bgColor = '#1a1a2e') {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.THUMB_W, this.THUMB_H);
        
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, this.THUMB_W, this.THUMB_H);

        ctx.save();
        ctx.scale(this.SCALE, this.SCALE);

        // 屏蔽导出标志，否则会跳过一些预览辅助线(但这里我们不想看辅助线,所以强制导出模式为 true 以隐藏辅助线)
        for (const ov of layers) {
            const renderOv = JSON.parse(JSON.stringify(ov)); // 深拷贝防止污染
            renderOv._exporting = true; // 隐藏辅助线
            
            // 占位文案处理
            if (!renderOv.fixed_text) {
                if (renderOv.type === 'textcard') {
                    if (!renderOv.title_text) renderOv.title_text = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                    if (!renderOv.body_text)  renderOv.body_text  = 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.';
                } else if (renderOv.type === 'scroll') {
                    if (!renderOv.scroll_title) renderOv.scroll_title = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                    if (!renderOv.content) renderOv.content = 'Lord, in the name of Jesus, March has begun. I rebuke every spiritual curse, evil eye, jealousy, sickness, and confusion coming against me and my family! I cut off every hidden opening and destroy every trap set by the enemy.';
                } else if (renderOv.type === 'text') {
                    if (!renderOv.content) renderOv.content = 'IN MARCH, READ THIS JUST ONCE AND IT WILL COME TO PASS IMMEDIATELY';
                }
            }

            // 时间置零以显示初始状态
            const currentTime = Math.max(parseFloat(renderOv.start || 0), 0);

            if (typeof ReelsOverlay !== 'undefined' && ReelsOverlay.drawOverlay) {
                ReelsOverlay.drawOverlay(ctx, renderOv, currentTime, 1080, 1920);
            }
        }

        ctx.restore();
        
        try {
            // 压缩成 WebP 返回
            return this.canvas.toDataURL('image/webp', 0.8);
        } catch (e) {
            console.warn('[PresetThumb] toDataURL 失败(可能是本地图片跨域污染):', e);
            return ''; // 返回空字符串以触发 fallback
        }
    }

    /**
     * 异步渲染缩略图（等待媒体资源加载）
     * @param {Array} layers - 覆层数据数组
     * @param {string} bgColor - 背景色
     * @returns {Promise<string>} base64 DataURL (image/webp)
     */
    async renderThumbAsync(layers, bgColor = '#1a1a2e') {
        const ctx = this.ctx;
        
        // 1. 先触发一次绘制，让底层的 ReelsOverlay 发起本地文件预载请求
        for (const ov of layers) {
            const renderOv = JSON.parse(JSON.stringify(ov));
            const currentTime = Math.max(parseFloat(renderOv.start || 0), 0);
            if (typeof ReelsOverlay !== 'undefined' && ReelsOverlay.drawOverlay) {
                ReelsOverlay.drawOverlay(ctx, renderOv, currentTime, 1080, 1920);
            }
        }
        
        // 2. 等待 500ms 让图片完成读取（本地文件通常瞬间完成）
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 3. 再次正式渲染并返回
        return this.renderThumb(layers, bgColor);
    }
}

// 导出
if (typeof window !== 'undefined') {
    window.PresetThumbRenderer = PresetThumbRenderer;
}
