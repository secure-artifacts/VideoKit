/**
 * reels-font-manager.js — 字体管理器
 * 
 * 移植自 AutoSub_v8 FontManager:
 *   - 内嵌字体扫描与注册 (使用 CSS @font-face)
 *   - 白名单过滤
 *   - 字体列表管理
 *   - 字体缓存
 * 
 * 在 Electron 环境通过 IPC 扫描 fonts/ 目录；
 * 在浏览器环境使用 Google Fonts CDN 或本地字体列表。
 */

// ═══════════════════════════════════════════════════════
// 1. Default Font Configuration
// ═══════════════════════════════════════════════════════

const DEFAULT_FONT_FAMILY = 'Arial';

// 内置字体白名单 — 可安全使用的字体
const BUILTIN_FONTS = [
    // 英文
    'Arial', 'Helvetica', 'Impact', 'Georgia', 'Verdana',
    'Times New Roman', 'Courier New', 'Comic Sans MS',
    // 中文
    'Microsoft YaHei', '微软雅黑', 'SimHei', '黑体',
    'SimSun', '宋体', 'KaiTi', '楷体',
    'STHeiti', 'STSong', 'STKaiti', 'STFangsong',
    'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Noto Serif SC',
    // 日文
    'MS Gothic', 'Yu Gothic', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP',
    // 韩文
    'Malgun Gothic', 'Noto Sans KR',
    // 设计字体
    'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Oswald', 'Poppins',
    'Raleway', 'Inter', 'Outfit', 'Bebas Neue', 'Playfair Display', 'Crimson Pro',
];

// Google Fonts CDN 可加载的字体列表
const GOOGLE_FONTS = [
    'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR', 'Noto Serif SC',
    'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Oswald', 'Poppins',
    'Raleway', 'Inter', 'Outfit', 'Bebas Neue', 'Playfair Display',
    'Noto Sans', 'Noto Serif', 'Crimson Pro',
];

// ═══════════════════════════════════════════════════════
// 2. FontManager Class
// ═══════════════════════════════════════════════════════

class ReelsFontManager {
    constructor() {
        this._registered = false;
        this._allowedFonts = [...BUILTIN_FONTS];
        this._customFonts = [];   // 用户上传的自定义字体
        this._fontCache = {};
        this._loadedGoogleFonts = new Set();
        this._fontVariants = new Map(); // family -> Set of "weight|style"
    }

    /**
     * 注册字体系统。
     * - 浏览器环境：检测系统已安装字体
     * - Electron 环境：扫描 fonts/ 目录并注册
     */
    async register() {
        // 检测系统字体可用性
        const available = [];
        for (const font of BUILTIN_FONTS) {
            if (this._isFontAvailable(font)) {
                available.push(font);
                this._recordVariant(font, '400', 'normal');
                this._recordVariant(font, '700', 'normal');
            }
        }

        // 加载 Electron 自定义字体 (如果有)
        if (window.electronAPI && window.electronAPI.scanFonts) {
            try {
                const embeddedFonts = await window.electronAPI.scanFonts();
                if (Array.isArray(embeddedFonts)) {
                    for (const fontInfo of embeddedFonts) {
                        await this._registerLocalFont(fontInfo);
                        if (fontInfo.family && !available.includes(fontInfo.family)) {
                            available.push(fontInfo.family);
                        }
                    }
                }
            } catch (err) {
                console.warn('[FontManager] Failed to scan embedded fonts:', err);
            }
        }

        const merged = new Set(available.length > 0 ? available : [...BUILTIN_FONTS]);
        // Always expose Google-font families in selector so users can pick and lazy-load them.
        for (const gf of GOOGLE_FONTS) merged.add(gf);
        this._allowedFonts = Array.from(merged);
        this._registered = true;

        console.log(`[FontManager] Registered ${this._allowedFonts.length} fonts`);
        return true;
    }

    /**
     * 检测某字体是否在系统中可用 (通过 Canvas fallback 测量)。
     */
    _isFontAvailable(fontFamily) {
        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const testStr = 'abcdefghijklmnopqrstuvwxyz0123456789';

            ctx.font = `72px monospace`;
            const baselineWidth = ctx.measureText(testStr).width;

            ctx.font = `72px "${fontFamily}", monospace`;
            const testWidth = ctx.measureText(testStr).width;

            return testWidth !== baselineWidth;
        } catch {
            return false;
        }
    }

    /**
     * 通过 @font-face 注册本地字体文件。
     */
    async _registerLocalFont(fontInfo) {
        if (!fontInfo.path || !fontInfo.family) return;
        try {
            const fontUrl = fontInfo.path.startsWith('file://')
                ? fontInfo.path
                : `file://${fontInfo.path}`;

            const descriptors = {};
            if (fontInfo.weight) descriptors.weight = String(fontInfo.weight);
            if (fontInfo.style) descriptors.style = String(fontInfo.style);
            const fontFace = new FontFace(fontInfo.family, `url("${fontUrl}")`, descriptors);
            await fontFace.load();
            document.fonts.add(fontFace);

            if (!this._customFonts.includes(fontInfo.family)) {
                this._customFonts.push(fontInfo.family);
            }
            this._recordVariant(fontInfo.family, descriptors.weight || '400', descriptors.style || 'normal');
        } catch (err) {
            console.warn(`[FontManager] Failed to load font: ${fontInfo.family}`, err);
        }
    }

    /**
     * 按需从 Google Fonts 加载字体。
     */
    async loadGoogleFont(fontFamily) {
        if (this._loadedGoogleFonts.has(fontFamily)) return;
        if (!GOOGLE_FONTS.includes(fontFamily)) return;

        try {
            const encoded = fontFamily.replace(/ /g, '+');
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${encoded}:ital,wght@0,100..900;1,100..900&display=swap`;
            document.head.appendChild(link);

            // 等待字体加载
            await document.fonts.load(`16px "${fontFamily}"`);
            this._loadedGoogleFonts.add(fontFamily);

            if (!this._allowedFonts.includes(fontFamily)) {
                this._allowedFonts.push(fontFamily);
            }
            for (const w of ['100', '200', '300', '400', '500', '600', '700', '800', '900']) {
                this._recordVariant(fontFamily, w, 'normal');
                this._recordVariant(fontFamily, w, 'italic');
            }

            console.log(`[FontManager] Loaded Google Font: ${fontFamily}`);
        } catch (err) {
            console.warn(`[FontManager] Failed to load Google Font: ${fontFamily}`, err);
        }
    }

    /**
     * 用户上传自定义字体文件。
     */
    async uploadFont(file) {
        if (!file) return null;

        try {
            const buffer = await file.arrayBuffer();
            // 从文件名推断 family name
            const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
            const familyName = baseName.charAt(0).toUpperCase() + baseName.slice(1);

            const fontFace = new FontFace(familyName, buffer, { weight: '100 900', style: 'normal' });
            await fontFace.load();
            document.fonts.add(fontFace);

            if (!this._customFonts.includes(familyName)) {
                this._customFonts.push(familyName);
            }
            if (!this._allowedFonts.includes(familyName)) {
                this._allowedFonts.push(familyName);
            }
            this._recordVariant(familyName, '100 900', 'normal');

            console.log(`[FontManager] Uploaded custom font: ${familyName}`);
            return familyName;
        } catch (err) {
            console.error('[FontManager] Failed to upload font:', err);
            return null;
        }
    }

    /**
     * 白名单过滤 — 非白名单字体强制替换为默认字体。
     */
    sanitizeFontFamily(name) {
        if (!name) return DEFAULT_FONT_FAMILY;
        name = String(name).trim();
        if (this._allowedFonts.includes(name)) return name;
        if (this._customFonts.includes(name)) return name;
        return DEFAULT_FONT_FAMILY;
    }

    /**
     * 获取所有可用字体列表。
     */
    getAllFonts() {
        const fonts = new Set([...this._allowedFonts, ...this._customFonts]);
        return Array.from(fonts).sort();
    }

    _recordVariant(fontFamily, weight = '400', style = 'normal') {
        if (!fontFamily) return;
        if (!this._fontVariants.has(fontFamily)) this._fontVariants.set(fontFamily, new Set());
        this._fontVariants.get(fontFamily).add(`${String(weight)}|${String(style)}`);
    }

    _weightLabel(weight) {
        const w = parseInt(weight, 10);
        if (!Number.isFinite(w)) return String(weight || 'Regular');
        if (w <= 150) return 'Thin';
        if (w <= 250) return 'ExtraLight';
        if (w <= 350) return 'Light';
        if (w <= 450) return 'Regular';
        if (w <= 550) return 'Medium';
        if (w <= 650) return 'SemiBold';
        if (w <= 750) return 'Bold';
        if (w <= 850) return 'ExtraBold';
        return 'Black';
    }

    getFontWeightEntries(fontFamily, preferStyle = 'normal') {
        const fallbackWeights = ['100', '200', '300', '400', '500', '600', '700', '800', '900'];
        const fallback = fallbackWeights.map(w => ({ value: w, label: this._weightLabel(w), style: 'normal' }));

        const variants = this._fontVariants.get(fontFamily);
        if (!variants || variants.size === 0) return fallback;

        const parsed = [];
        for (const v of variants) {
            const [weightRaw, styleRaw] = String(v).split('|');
            const style = styleRaw || 'normal';
            const weight = String(weightRaw || '400');
            if (weight.includes(' ')) {
                for (const fw of fallbackWeights) {
                    parsed.push({ value: fw, style });
                }
            } else if (/^\d+$/.test(weight)) {
                parsed.push({ value: weight, style });
            }
        }

        if (parsed.length === 0) return fallback;

        const hasPreferredStyle = parsed.some(p => p.style === preferStyle);
        const effective = hasPreferredStyle
            ? parsed.filter(p => p.style === preferStyle)
            : parsed;

        const uniq = new Map();
        for (const p of effective) {
            if (!uniq.has(p.value)) {
                uniq.set(p.value, { value: p.value, label: this._weightLabel(p.value), style: p.style });
            }
        }
        const list = Array.from(uniq.values()).sort((a, b) => Number(a.value) - Number(b.value));
        return list.length > 0 ? list : fallback;
    }

    getFontWeightOptions(fontFamily) {
        return this.getFontWeightEntries(fontFamily, 'normal').map(x => x.value);
    }

    /**
     * 刷新字体下拉框。
     * @param {string} selectId - <select> 元素的 ID
     * @param {string} currentValue - 当前选中值
     */
    refreshFontSelect(selectId, currentValue) {
        const select = document.getElementById(selectId);
        if (!select) return;

        const fonts = this.getAllFonts();
        const oldValue = select.value;

        // 中文显示名称映射
        const DISPLAY_NAMES = {
            'Microsoft YaHei': '微软雅黑',
            '微软雅黑': '微软雅黑',
            'SimHei': '黑体',
            '黑体': '黑体',
            'SimSun': '宋体',
            '宋体': '宋体',
            'KaiTi': '楷体',
            '楷体': '楷体',
            'STHeiti': '华文黑体',
            'STSong': '华文宋体',
            'STKaiti': '华文楷体',
            'STFangsong': '华文仿宋',
            'PingFang SC': '苹方',
            'Hiragino Sans GB': '冬青黑体',
            'Noto Sans SC': 'Noto Sans SC (思源黑)',
            'Noto Serif SC': 'Noto Serif SC (思源宋)',
            'Noto Sans JP': 'Noto Sans JP (日文)',
            'Noto Sans KR': 'Noto Sans KR (韩文)',
            'MS Gothic': 'MS Gothic (日文)',
            'Yu Gothic': 'Yu Gothic (日文)',
            'Malgun Gothic': 'Malgun Gothic (韩文)',
            'Crimson Pro': 'Crimson Pro (衬线)',
        };

        select.innerHTML = '';
        for (const font of fonts) {
            const opt = document.createElement('option');
            opt.value = font;
            opt.textContent = DISPLAY_NAMES[font] || font;
            opt.style.fontFamily = `"${font}", sans-serif`;
            select.appendChild(opt);
        }

        // 恢复选中
        if (currentValue && fonts.includes(currentValue)) {
            select.value = currentValue;
        } else if (oldValue && fonts.includes(oldValue)) {
            select.value = oldValue;
        } else {
            select.value = DEFAULT_FONT_FAMILY;
        }
    }
}

// ═══════════════════════════════════════════════════════
// Singleton
// ═══════════════════════════════════════════════════════

let _fontManagerInstance = null;

function getFontManager() {
    if (!_fontManagerInstance) {
        _fontManagerInstance = new ReelsFontManager();
    }
    return _fontManagerInstance;
}

// ═══════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════

if (typeof window !== 'undefined') {
    window.ReelsFontManager = ReelsFontManager;
    window.getFontManager = getFontManager;
    window.DEFAULT_FONT_FAMILY = DEFAULT_FONT_FAMILY;
    window.BUILTIN_FONTS = BUILTIN_FONTS;
    window.GOOGLE_FONTS = GOOGLE_FONTS;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ReelsFontManager, getFontManager, DEFAULT_FONT_FAMILY, BUILTIN_FONTS, GOOGLE_FONTS };
}
