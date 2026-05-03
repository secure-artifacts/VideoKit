/**
 * reels-audio-spectrum.js — 音频频谱分析与可视化
 * 
 * 移植自 AutoSub_v8 audio_spectrum.py:
 *   - Web Audio API (AnalyserNode) 替代 numpy FFT
 *   - 实时频谱数据获取
 *   - 频谱可视化渲染
 *   - 多种可视化形状（柱状、波形、圆形）
 * 
 * 使用 Web Audio API 进行音频分析，Canvas 渲染频谱。
 */

(() => {

// ═══════════════════════════════════════════════════════
// 1. Audio Spectrum Analyzer
// ═══════════════════════════════════════════════════════

const DEFAULT_BANDS = 32;

class AudioSpectrumAnalyzer {
    constructor() {
        this._audioCtx = null;
        this._analyser = null;
        this._source = null;
        this._connected = false;
        this._dataArray = null;
        this._bands = DEFAULT_BANDS;
        this._smoothing = 0.8;
    }

    /**
     * 初始化音频分析器。
     * @param {HTMLVideoElement|HTMLAudioElement} mediaElement
     * @param {number} bands - 频带数
     */
    connect(mediaElement, bands = DEFAULT_BANDS) {
        if (this._connected) this.disconnect();

        try {
            this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this._analyser = this._audioCtx.createAnalyser();
            this._analyser.fftSize = Math.max(64, nearestPow2(bands * 4));
            this._analyser.smoothingTimeConstant = this._smoothing;

            this._source = this._audioCtx.createMediaElementSource(mediaElement);
            this._source.connect(this._analyser);
            this._analyser.connect(this._audioCtx.destination);

            this._bands = bands;
            this._dataArray = new Uint8Array(this._analyser.frequencyBinCount);
            this._connected = true;

            console.log(`[AudioSpectrum] Connected, ${bands} bands, fftSize=${this._analyser.fftSize}`);
        } catch (err) {
            console.warn('[AudioSpectrum] Failed to connect:', err);
        }
    }

    disconnect() {
        try {
            if (this._source) this._source.disconnect();
            if (this._analyser) this._analyser.disconnect();
            if (this._audioCtx && this._audioCtx.state !== 'closed') this._audioCtx.close();
        } catch (e) { /* ignore */ }
        this._connected = false;
        this._source = null;
        this._analyser = null;
        this._audioCtx = null;
    }

    /**
     * 获取当前频谱数据。
     * @returns {number[]} n_bands 个浮点值 [0.0, 1.0]
     */
    getSpectrum() {
        if (!this._connected || !this._analyser) {
            return new Array(this._bands).fill(0);
        }

        this._analyser.getByteFrequencyData(this._dataArray);
        const binCount = this._dataArray.length;
        const bands = [];

        for (let i = 0; i < this._bands; i++) {
            // 对数分频 (与 AutoSub 一致)
            const low = Math.floor(binCount * (Math.pow(2, i / this._bands) - 1));
            const high = Math.floor(binCount * (Math.pow(2, (i + 1) / this._bands) - 1));
            const lo = Math.max(0, Math.min(low, binCount - 1));
            const hi = Math.max(lo + 1, Math.min(high, binCount));

            let sum = 0;
            for (let j = lo; j < hi; j++) {
                sum += this._dataArray[j];
            }
            const avg = sum / Math.max(1, hi - lo);
            bands.push(avg / 255.0);
        }

        return bands;
    }
}

// ═══════════════════════════════════════════════════════
// 2. Spectrum Visualizer Renderer
// ═══════════════════════════════════════════════════════

const SPECTRUM_SHAPES = {
    bars: 'bars',           // 柱状
    wave: 'wave',           // 波形
    circle: 'circle',       // 圆形
    mirror_bars: 'mirror',  // 镜像柱状
};

/**
 * 渲染频谱可视化。
 * 移植自 AutoSub draw_spectrum
 * 
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} bands - 频谱数据 [0,1]
 * @param {object} style - 频谱样式
 * @param {number} canvasW
 * @param {number} canvasH
 */
function renderSpectrum(ctx, bands, style = {}, canvasW = 1920, canvasH = 1080) {
    if (!bands || bands.length === 0) return;

    const {
        shape = 'bars',
        x = canvasW * 0.1,
        y = canvasH * 0.7,
        width = canvasW * 0.8,
        height = canvasH * 0.2,
        color1 = '#FF6B6B',
        color2 = '#4ECDC4',
        opacity = 0.8,
        barGap = 2,
        barRadius = 2,
        mirrorEnabled = false,
        glowEnabled = false,
        glowColor = '#FFFFFF',
        glowBlur = 10,
    } = style;

    ctx.save();
    ctx.globalAlpha = opacity;

    if (glowEnabled) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
    }

    switch (shape) {
        case 'bars':
            _drawBars(ctx, bands, x, y, width, height, color1, color2, barGap, barRadius);
            break;
        case 'wave':
            _drawWave(ctx, bands, x, y, width, height, color1, color2);
            break;
        case 'circle':
            _drawCircle(ctx, bands, x + width / 2, y + height / 2, Math.min(width, height) / 2, color1, color2);
            break;
        case 'mirror':
            _drawMirrorBars(ctx, bands, x, y, width, height, color1, color2, barGap, barRadius);
            break;
        default:
            _drawBars(ctx, bands, x, y, width, height, color1, color2, barGap, barRadius);
    }

    ctx.restore();
}

// ── 柱状频谱 ──
function _drawBars(ctx, bands, x, y, w, h, c1, c2, gap, radius) {
    const n = bands.length;
    const barW = Math.max(1, (w - gap * (n - 1)) / n);

    for (let i = 0; i < n; i++) {
        const val = bands[i];
        const barH = Math.max(2, val * h);
        const bx = x + i * (barW + gap);
        const by = y + h - barH;

        // 渐变色
        const t = i / n;
        ctx.fillStyle = _lerpColor(c1, c2, t);

        if (radius > 0) {
            _roundRectSpec(ctx, bx, by, barW, barH, radius);
            ctx.fill();
        } else {
            ctx.fillRect(bx, by, barW, barH);
        }
    }
}

// ── 镜像柱状 ──
function _drawMirrorBars(ctx, bands, x, y, w, h, c1, c2, gap, radius) {
    const n = bands.length;
    const barW = Math.max(1, (w - gap * (n - 1)) / n);
    const midY = y + h / 2;

    for (let i = 0; i < n; i++) {
        const val = bands[i];
        const barH = Math.max(1, val * h / 2);
        const bx = x + i * (barW + gap);

        const t = i / n;
        ctx.fillStyle = _lerpColor(c1, c2, t);

        // 上半
        ctx.fillRect(bx, midY - barH, barW, barH);
        // 下半
        ctx.fillRect(bx, midY, barW, barH);
    }
}

// ── 波形频谱 ──
function _drawWave(ctx, bands, x, y, w, h, c1, c2) {
    const n = bands.length;
    const grad = ctx.createLinearGradient(x, y, x + w, y);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x, y + h);

    for (let i = 0; i < n; i++) {
        const px = x + (i / (n - 1)) * w;
        const py = y + h - bands[i] * h;
        if (i === 0) {
            ctx.lineTo(px, py);
        } else {
            const prevPx = x + ((i - 1) / (n - 1)) * w;
            const cpx = (prevPx + px) / 2;
            ctx.quadraticCurveTo(cpx, y + h - bands[i - 1] * h, px, py);
        }
    }

    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
}

// ── 圆形频谱 ──
function _drawCircle(ctx, bands, cx, cy, radius, c1, c2) {
    const n = bands.length;
    const angleStep = (Math.PI * 2) / n;

    for (let i = 0; i < n; i++) {
        const angle = i * angleStep - Math.PI / 2;
        const val = bands[i];
        const innerR = radius * 0.4;
        const outerR = innerR + val * (radius - innerR);

        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * outerR;
        const y2 = cy + Math.sin(angle) * outerR;

        const t = i / n;
        ctx.strokeStyle = _lerpColor(c1, c2, t);
        ctx.lineWidth = Math.max(2, (2 * Math.PI * innerR) / n * 0.7);
        ctx.lineCap = 'round';

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
    }
}

// ═══════════════════════════════════════════════════════
// 3. Helpers
// ═══════════════════════════════════════════════════════

function nearestPow2(n) {
    let p = 1;
    while (p < n) p *= 2;
    return Math.max(64, Math.min(8192, p));
}

function _lerpColor(hex1, hex2, t) {
    const r1 = parseInt(hex1.slice(1, 3), 16);
    const g1 = parseInt(hex1.slice(3, 5), 16);
    const b1 = parseInt(hex1.slice(5, 7), 16);
    const r2 = parseInt(hex2.slice(1, 3), 16);
    const g2 = parseInt(hex2.slice(3, 5), 16);
    const b2 = parseInt(hex2.slice(5, 7), 16);
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `rgb(${r},${g},${b})`;
}

function _roundRectSpec(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

const ReelsAudioSpectrum = {
    AudioSpectrumAnalyzer,
    SPECTRUM_SHAPES,
    renderSpectrum,
    DEFAULT_BANDS,
};

if (typeof window !== 'undefined') window.ReelsAudioSpectrum = ReelsAudioSpectrum;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsAudioSpectrum;

})();
