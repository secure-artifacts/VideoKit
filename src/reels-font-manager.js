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

// Google Fonts CDN 可加载的字体列表（按需懒加载，~200+ 热门字体）
const GOOGLE_FONTS = [
    // ── Sans-Serif 无衬线 (热门) ──
    'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
    'Inter', 'Raleway', 'Outfit', 'Oswald', 'Nunito',
    'Nunito Sans', 'Source Sans 3', 'Ubuntu', 'Rubik', 'Work Sans',
    'Quicksand', 'Mulish', 'Karla', 'Barlow', 'DM Sans',
    'Manrope', 'Figtree', 'Lexend', 'Space Grotesk', 'Sora',
    'Albert Sans', 'Plus Jakarta Sans', 'Red Hat Display', 'Urbanist', 'Jost',
    'Exo 2', 'Archivo', 'Archivo Black', 'Cabin', 'Hind', 'Mukta',
    'Overpass', 'Titillium Web', 'Fira Sans', 'Signika', 'Catamaran',
    'PT Sans', 'Roboto Condensed', 'Noto Sans Display', 'IBM Plex Sans',
    'IBM Plex Serif', 'Roboto Flex', 'Roboto Serif', 'Arimo', 'Tinos',
    'Play', 'Russo One', 'Cuprum', 'Literata', 'Noto Sans Tagalog',
    'Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic',
    'Cairo', 'Tajawal', 'Almarai', 'Amiri', 'Changa',
    'El Messiri', 'Lateef', 'Scheherazade New', 'Reem Kufi',
    'Mada', 'Markazi Text', 'IBM Plex Sans Arabic', 'Readex Pro',
    'Noto Sans', 'Noto Sans SC', 'Noto Sans JP', 'Noto Sans KR',
    'Noto Sans TC', 'Noto Sans HK',
    // ── Sans-Serif 无衬线 (更多) ──
    'Kanit', 'Josefin Sans', 'Libre Franklin', 'Asap', 'Dosis',
    'IBM Plex Sans', 'Yanone Kaffeesatz', 'Abel', 'Saira', 'Teko',
    'Prompt', 'Varela Round', 'Questrial', 'Archivo Narrow', 'Armata',
    'Public Sans', 'Nanum Gothic', 'Red Hat Text', 'Chivo', 'Heebo',
    'Assistant', 'Encode Sans', 'Encode Sans Condensed', 'Pathway Gothic One', 'Zen Kaku Gothic New',
    'Readex Pro', 'Atkinson Hyperlegible', 'Wix Madefor Display', 'Schibsted Grotesk', 'Geist',
    'Instrument Sans', 'Onest', 'Afacad', 'Bricolage Grotesque', 'Funnel Sans',
    // ── Serif 衬线 ──
    'Playfair Display', 'Crimson Pro', 'Lora', 'Merriweather', 'Libre Baskerville',
    'Noto Serif', 'Noto Serif SC', 'Noto Serif JP', 'Noto Serif KR',
    'Source Serif 4', 'EB Garamond', 'Cormorant Garamond', 'Bitter',
    'DM Serif Display', 'Libre Caslon Display', 'Gelasio', 'Spectral',
    'Brygada 1918', 'Vollkorn', 'Cardo',
    'PT Serif', 'Roboto Slab', 'Arvo', 'Domine', 'Rokkitt',
    'Josefin Slab', 'Slabo 27px', 'Noticia Text', 'Unna', 'Faustina',
    'Alegreya', 'Crimson Text', 'Old Standard TT', 'Sorts Mill Goudy',
    'Cormorant', 'Fraunces', 'Newsreader', 'Instrument Serif', 'Young Serif',
    'Bodoni Moda', 'Prata', 'Lora', 'Gentium Book Plus',
    // ── Display 标题/装饰 ──
    'Bebas Neue', 'Anton', 'Righteous', 'Fredoka', 'Lilita One',
    'Bowlby One SC', 'Black Ops One', 'Bungee', 'Orbitron',
    'Abril Fatface', 'Alfa Slab One', 'Comfortaa', 'Passion One',
    'Baloo 2', 'Bangers', 'Russo One', 'Press Start 2P',
    'Lobster Two', 'Fugaz One', 'Concert One', 'Bungee Shade',
    'Monoton', 'Fascinate Inline', 'Rampart One', 'Shrikhand',
    'Bree Serif', 'Crete Round', 'Patua One', 'Ultra',
    'Secular One', 'Staatliches', 'Francois One', 'Passion One',
    'Graduate', 'Oleo Script', 'Modak', 'Faster One',
    'Chango', 'Bungee Inline', 'Silkscreen', 'Rubik Mono One',
    'Rubik Glitch', 'Rubik Wet Paint', 'Rubik Burned', 'Rubik Dirt',
    'Climate Crisis', 'Nabla', 'Bagel Fat One', 'Honk',
    // ── Handwriting 手写/书法 ──
    'Permanent Marker', 'Pacifico', 'Lobster', 'Satisfy', 'Dancing Script',
    'Caveat', 'Kalam', 'Patrick Hand', 'Indie Flower', 'Shadows Into Light',
    'Amatic SC', 'Great Vibes', 'Sacramento', 'Yellowtail', 'Allura',
    'Courgette', 'Kaushan Script', 'Tangerine', 'Alex Brush', 'Pinyon Script',
    'Cookie', 'Damion', 'Mr Dafoe', 'Marck Script', 'Handlee',
    'Architects Daughter', 'Covered By Your Grace', 'Rock Salt', 'Reenie Beanie',
    'Homemade Apple', 'Just Another Hand', 'Nothing You Could Do', 'Cedarville Cursive',
    'Gloria Hallelujah', 'Gochi Hand', 'Coming Soon', 'La Belle Aurore',
    'Pangolin', 'Sue Ellen Francisco', 'Schoolbell', 'Short Stack',
    // ── Monospace 等宽 ──
    'Fira Code', 'JetBrains Mono', 'Source Code Pro', 'Roboto Mono',
    'Space Mono', 'IBM Plex Mono', 'Ubuntu Mono',
    'Inconsolata', 'PT Mono', 'Anonymous Pro', 'Cousine',
    'Share Tech Mono', 'Cutive Mono', 'Major Mono Display', 'Xanh Mono',
    'Azeret Mono', 'Red Hat Mono', 'Martian Mono', 'Geist Mono',
    // ── 中文/CJK 特色 ──
    'LXGW WenKai', 'LXGW WenKai TC', 'Ma Shan Zheng',
    'ZCOOL XiaoWei', 'ZCOOL QingKe HuangYou', 'ZCOOL KuaiLe',
    'Liu Jian Mao Cao', 'Long Cang', 'Zhi Mang Xing',
    'Noto Sans Mono', 'Noto Serif Display',
];

// 默认展开时优先展示的热门 Google 字体。
// 覆盖英文短视频常用、欧洲语言、俄语/西里尔文、希腊语、菲律宾语、阿拉伯语等场景。
const POPULAR_GOOGLE_FONTS = [
    'Roboto', 'Open Sans', 'Montserrat', 'Lato', 'Poppins',
    'Inter', 'Oswald', 'Nunito Sans', 'Nunito', 'Raleway',
    'Rubik', 'Ubuntu', 'Fira Sans', 'Source Sans 3', 'DM Sans',
    'Work Sans', 'Merriweather', 'Playfair Display', 'Lora', 'Roboto Slab',
    'Bebas Neue', 'Anton', 'Archivo Black', 'Barlow', 'Barlow Condensed',
    'Roboto Condensed', 'PT Sans', 'PT Serif', 'PT Mono', 'Noto Sans',
    'Noto Serif', 'Noto Sans Display', 'Noto Serif Display', 'Noto Sans Mono', 'IBM Plex Sans',
    'IBM Plex Serif', 'IBM Plex Mono', 'Manrope', 'Exo 2', 'Comfortaa',
    'Russo One', 'Play', 'Cuprum', 'Cormorant Garamond', 'Cormorant',
    'Caveat', 'Pacifico', 'Rubik Mono One', 'Tinos', 'Arimo',
    'Roboto Flex', 'Roboto Serif', 'Roboto Mono', 'Libre Franklin', 'Karla',
    'Mulish', 'Quicksand', 'Lexend', 'Jost', 'Urbanist',
    'Outfit', 'Figtree', 'Space Grotesk', 'Sora', 'Plus Jakarta Sans',
    'Red Hat Display', 'Albert Sans', 'Overpass', 'Titillium Web', 'Kanit',
    'Josefin Sans', 'Asap', 'Dosis', 'Cabin', 'Hind',
    'Mukta', 'Signika', 'Catamaran', 'Public Sans', 'Heebo',
    'Assistant', 'Encode Sans', 'Readex Pro', 'Atkinson Hyperlegible', 'Instrument Sans',
    'Onest', 'Afacad', 'Bricolage Grotesque', 'Funnel Sans', 'Libre Baskerville',
    'Crimson Pro', 'EB Garamond', 'Bitter', 'DM Serif Display', 'Gelasio',
    'Spectral', 'Vollkorn', 'Cardo', 'Arvo', 'Domine',
    'Rokkitt', 'Alegreya', 'Crimson Text', 'Fraunces', 'Newsreader',
    'Instrument Serif', 'Young Serif', 'Bodoni Moda', 'Prata', 'Abril Fatface',
    'Alfa Slab One', 'Lilita One', 'Passion One', 'Bangers', 'Lobster',
    'Lobster Two', 'Permanent Marker', 'Satisfy', 'Dancing Script', 'Kalam',
    'Indie Flower', 'Great Vibes', 'Allura', 'Courgette', 'Cookie',
    // 欧洲语言 / 拉丁扩展 / 希腊语 / 西里尔文常用
    'Noto Sans', 'Noto Serif', 'Noto Sans Display', 'Noto Serif Display',
    'Noto Sans Mono', 'Noto Sans Georgian', 'Noto Serif Georgian',
    'Noto Sans Armenian', 'Noto Serif Armenian', 'Noto Sans Hebrew',
    'Noto Serif Hebrew', 'Noto Sans Greek', 'Noto Serif Greek',
    'Noto Sans Devanagari', 'Noto Sans Tagalog',
    'PT Sans', 'PT Serif', 'PT Mono', 'Ubuntu', 'Ubuntu Condensed',
    'Ubuntu Mono', 'Fira Sans', 'Fira Sans Condensed', 'Fira Sans Extra Condensed',
    'Fira Code', 'Roboto Condensed', 'Roboto Mono', 'Roboto Slab',
    'Literata', 'Spectral', 'Alegreya Sans', 'Alegreya',
    'Merriweather Sans', 'Source Serif 4', 'IBM Plex Sans',
    'IBM Plex Serif', 'IBM Plex Mono', 'Libre Franklin', 'Libre Baskerville',
    'Libre Caslon Text', 'Libre Caslon Display', 'Bitter', 'Vollkorn',
    'Cormorant', 'Cormorant Garamond', 'Cormorant Infant', 'Cormorant SC',
    'Cormorant Unicase', 'Gelasio', 'Old Standard TT', 'Neucha',
    'Philosopher', 'Forum', 'Oranienbaum', 'Poiret One', 'Yeseva One',
    'Tenor Sans', 'Jura', 'Didact Gothic', 'Scada', 'Podkova',
    'Prata', 'Kelly Slab', 'Pangolin', 'Bad Script', 'Marck Script',
    'Comfortaa', 'Exo 2', 'Play', 'Russo One', 'Cuprum',
    'Rubik Mono One', 'Rubik Glitch', 'Rubik Beastly', 'Sofia Sans',
    'Sofia Sans Condensed', 'Sofia Sans Extra Condensed', 'Sofia Sans Semi Condensed',
    'Ysabeau', 'Ysabeau SC', 'Ysabeau Infant', 'Ysabeau Office',
    'Commissioner', 'Afacad', 'Onest', 'Geologica', 'Wix Madefor Display',
    'Wix Madefor Text', 'Geist', 'Geist Mono', 'Manrope',
    // 阿拉伯语 / 中东语言常用
    'Noto Sans Arabic', 'Noto Naskh Arabic', 'Noto Kufi Arabic',
    'Cairo', 'Tajawal', 'Almarai', 'Amiri', 'Changa',
    'El Messiri', 'Lateef', 'Scheherazade New', 'Reem Kufi',
    'Reem Kufi Fun', 'Reem Kufi Ink', 'Mada', 'Markazi Text',
    'IBM Plex Sans Arabic', 'Readex Pro', 'Aref Ruqaa', 'Aref Ruqaa Ink',
    'Lalezar', 'Lemonada', 'Rakkas', 'Mirza', 'Katibeh',
    'Harmattan', 'Noto Nastaliq Urdu', 'Noto Sans Hebrew',
    'Noto Serif Hebrew',
];

// ═══════════════════════════════════════════════════════
// 2. FontManager Class
// ═══════════════════════════════════════════════════════

class ReelsFontManager {
    constructor() {
        this._registered = false;
        this._allowedFonts = [...BUILTIN_FONTS];
        this._customFonts = [];   // 用户上传的自定义字体
        this._systemFonts = new Set();   // 系统扫描到的字体
        this._embeddedFonts = new Set(); // 内置 assets/fonts 字体
        this._fontCache = {};
        this._loadedGoogleFonts = new Set();
        this._fontVariants = new Map(); // family -> Set of "weight|style"
    }

    /**
     * 注册字体系统。
     * - 白名单字体：通过 Canvas 检测系统是否已安装
     * - Electron 环境：扫描 fonts/ 目录 + 系统字体目录
     *   - 系统字体：直接加入白名单（已安装，无需 FontFace 注册）
     *   - 内置字体：通过 FontFace API 注册（确保可用）
     */
    async register() {
        // 检测白名单字体可用性
        const available = [];
        for (const font of BUILTIN_FONTS) {
            if (this._isFontAvailable(font)) {
                available.push(font);
                this._recordVariant(font, '400', 'normal');
                this._recordVariant(font, '700', 'normal');
            }
        }

        // 加载 Electron 扫描的字体 (内置 + 系统)
        if (window.electronAPI && window.electronAPI.scanFonts) {
            try {
                const scannedFonts = await window.electronAPI.scanFonts();
                if (Array.isArray(scannedFonts)) {
                    const systemFamilies = new Set();
                    const embeddedFonts = [];

                    for (const fontInfo of scannedFonts) {
                        if (!fontInfo.family) continue;
                        if (fontInfo.system) {
                            // 系统字体 — 直接加入白名单，不加载 FontFace
                            systemFamilies.add(fontInfo.family);
                            this._systemFonts.add(fontInfo.family);
                            this._recordVariant(fontInfo.family, fontInfo.weight || '400', fontInfo.style || 'normal');
                        } else {
                            // 内置字体 — 需要 FontFace 注册
                            embeddedFonts.push(fontInfo);
                        }
                    }

                    // 批量添加系统字体到白名单
                    for (const family of systemFamilies) {
                        if (!available.includes(family)) {
                            available.push(family);
                        }
                    }

                    // 逐个注册内置字体
                    for (const fontInfo of embeddedFonts) {
                        await this._registerLocalFont(fontInfo);
                        this._embeddedFonts.add(fontInfo.family);
                        if (fontInfo.family && !available.includes(fontInfo.family)) {
                            available.push(fontInfo.family);
                        }
                    }

                    console.log(`[FontManager] ${systemFamilies.size} system font families, ${embeddedFonts.length} embedded fonts loaded`);
                }
            } catch (err) {
                console.warn('[FontManager] Failed to scan fonts:', err);
            }
        }

        const merged = new Set(available.length > 0 ? available : [...BUILTIN_FONTS]);
        // Always expose hardcoded Google-font families in selector
        for (const gf of GOOGLE_FONTS) merged.add(gf);

        // ── 动态拉取 Google Fonts 全量列表 (1700+) ──
        const dynamicGoogleFonts = await this._fetchGoogleFontsCatalog();
        if (dynamicGoogleFonts.length > 0) {
            this._googleFontsFull = new Set(dynamicGoogleFonts);
            for (const gf of dynamicGoogleFonts) merged.add(gf);
        } else {
            this._googleFontsFull = new Set(GOOGLE_FONTS);
        }

        this._allowedFonts = Array.from(merged);
        this._registered = true;

        const googleCount = this._googleFontsFull ? this._googleFontsFull.size : GOOGLE_FONTS.length;
        console.log(`[FontManager] ✅ Registered ${this._allowedFonts.length} fonts total — 💻 系统:${this._systemFonts.size} | 🌐 Google:${googleCount} | 📦 内置:${this._embeddedFonts.size} | 📤 自定义:${this._customFonts.length}`);
        return true;
    }

    /**
     * 从 Google Fonts 公开 API 拉取全量字体列表 (~1700+)。
     * 结果缓存到 localStorage，7天内不重复请求。
     * 离线或请求失败时返回空数组（回退到硬编码列表）。
     */
    async _fetchGoogleFontsCatalog() {
        const CACHE_KEY = 'gfonts_catalog';
        const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7天

        // 1. 尝试从缓存读取
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const { ts, fonts } = JSON.parse(cached);
                if (Date.now() - ts < CACHE_TTL && Array.isArray(fonts) && fonts.length > 100) {
                    console.log(`[FontManager] Google Fonts 目录缓存命中: ${fonts.length} 个字体`);
                    return fonts;
                }
            }
        } catch { /* ignore parse errors */ }

        // 2. 离线时跳过
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            return [];
        }

        // 3. 从 Google Fonts API 拉取
        try {
            const resp = await fetch('https://fonts.google.com/metadata/fonts', {
                signal: AbortSignal.timeout(8000),
            });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const text = await resp.text();
            // Google Fonts metadata 前面有 )]}' 安全前缀，需要去掉
            const jsonStr = text.replace(/^\)\]\}'\n?/, '');
            const data = JSON.parse(jsonStr);

            let fontFamilies = [];
            if (data.familyMetadataList && Array.isArray(data.familyMetadataList)) {
                fontFamilies = data.familyMetadataList.map(f => f.family).filter(Boolean);
            }

            if (fontFamilies.length > 100) {
                // 缓存到 localStorage
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify({
                        ts: Date.now(),
                        fonts: fontFamilies,
                    }));
                } catch { /* quota exceeded — ignore */ }
                console.log(`[FontManager] 🌐 Google Fonts 全量目录: ${fontFamilies.length} 个字体已加载`);
                return fontFamilies;
            }
        } catch (err) {
            console.warn(`[FontManager] Google Fonts 目录拉取失败:`, err.message);
        }

        return [];
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
            const fontUrl = (window.electronAPI && window.electronAPI.toFileUrl)
                ? window.electronAPI.toFileUrl(fontInfo.path)
                : (fontInfo.path.startsWith('file://') ? fontInfo.path : `file://${fontInfo.path}`);

            const descriptors = {};
            if (fontInfo.weight) descriptors.weight = String(fontInfo.weight);
            if (fontInfo.style) descriptors.style = String(fontInfo.style);
            const fontFace = new FontFace(fontInfo.family, `url("${fontUrl}")`, descriptors);
            await fontFace.load();
            document.fonts.add(fontFace);

            if (!this._allowedFonts.includes(fontInfo.family)) {
                this._allowedFonts.push(fontInfo.family);
            }
            this._recordVariant(fontInfo.family, descriptors.weight || '400', descriptors.style || 'normal');
        } catch (err) {
            console.warn(`[FontManager] Failed to load font: ${fontInfo.family}`, err);
        }
    }

    /**
     * 按需从 Google Fonts 加载字体。
     * 仅在联网且字体未通过系统/本地注册时才从 CDN 加载。
     */
    async loadGoogleFont(fontFamily) {
        if (this._loadedGoogleFonts.has(fontFamily)) return;
        // 允许加载硬编码列表或动态拉取的全量目录中的字体
        const isGoogleFont = GOOGLE_FONTS.includes(fontFamily) ||
            (this._googleFontsFull && this._googleFontsFull.has(fontFamily));
        if (!isGoogleFont) return;

        // 如果已通过系统字体注册，无需从 CDN 加载
        if (this._customFonts.includes(fontFamily) || this._isFontAvailable(fontFamily)) {
            this._loadedGoogleFonts.add(fontFamily);
            return;
        }

        // 离线时跳过（避免 Electron 中的 MIME type 报错）
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            console.warn(`[FontManager] Offline, skipping Google Font: ${fontFamily}`);
            return;
        }

        try {
            const encoded = fontFamily.replace(/ /g, '+');
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@300;400;500;600;700&display=swap`;
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
     * 刷新字体下拉框 — 带分类分组。
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
            'Microsoft YaHei': '微软雅黑', '微软雅黑': '微软雅黑',
            'SimHei': '黑体', '黑体': '黑体',
            'SimSun': '宋体', '宋体': '宋体',
            'KaiTi': '楷体', '楷体': '楷体',
            'STHeiti': '华文黑体', 'STSong': '华文宋体',
            'STKaiti': '华文楷体', 'STFangsong': '华文仿宋',
            'PingFang SC': '苹方', 'Hiragino Sans GB': '冬青黑体',
            'Noto Sans SC': 'Noto Sans SC (思源黑体)',
            'Noto Serif SC': 'Noto Serif SC (思源宋体)',
            'Noto Sans JP': 'Noto Sans JP (日文黑体)',
            'Noto Sans KR': 'Noto Sans KR (韩文黑体)',
            'Noto Sans TC': 'Noto Sans TC (繁体黑体)',
            'Noto Sans HK': 'Noto Sans HK (香港黑体)',
            'Noto Serif JP': 'Noto Serif JP (日文宋体)',
            'Noto Serif KR': 'Noto Serif KR (韩文宋体)',
            'MS Gothic': 'MS Gothic (日文)', 'Yu Gothic': 'Yu Gothic (日文)',
            'Malgun Gothic': 'Malgun Gothic (韩文)',
            'Hiragino Kaku Gothic ProN': '冬青角ゴシック (日文)',
            'LXGW WenKai': '霞鹜文楷', 'Ma Shan Zheng': '马善政楷',
            'ZCOOL XiaoWei': '站酷小薇', 'ZCOOL QingKe HuangYou': '站酷庆科黄油',
            'Liu Jian Mao Cao': '流建毛草', 'Long Cang': '龙藏',
            'Zhi Mang Xing': '芫荽行书',
            'Crimson Pro': 'Crimson Pro (衬线)',
            'Playfair Display': 'Playfair Display (衬线)',
            'Lora': 'Lora (衬线)', 'Merriweather': 'Merriweather (衬线)',
            'EB Garamond': 'EB Garamond (衬线)',
            'DM Serif Display': 'DM Serif Display (标题)',
            'Bebas Neue': 'Bebas Neue (标题)', 'Anton': 'Anton (标题)',
            'Abril Fatface': 'Abril Fatface (标题)',
            'Fira Code': 'Fira Code (等宽)', 'JetBrains Mono': 'JetBrains Mono (等宽)',
            'Source Code Pro': 'Source Code Pro (等宽)', 'Roboto Mono': 'Roboto Mono (等宽)',
            'Space Mono': 'Space Mono (等宽)', 'IBM Plex Mono': 'IBM Plex Mono (等宽)',
            'Pacifico': 'Pacifico (手写)', 'Dancing Script': 'Dancing Script (手写)',
            'Lobster': 'Lobster (手写)', 'Satisfy': 'Satisfy (手写)',
            'Permanent Marker': 'Permanent Marker (手写)',
            'Press Start 2P': 'Press Start 2P (像素)',
        };

        // ── 分类字体 ──
        const googleFontsSet = this._googleFontsFull || new Set(GOOGLE_FONTS);
        const groups = {
            system: [],   // 系统自带
            google: [],   // Google 免费
            embedded: [], // 内置字体
            custom: [],   // 用户上传
        };

        for (const font of fonts) {
            if (this._customFonts.includes(font)) {
                groups.custom.push(font);
            } else if (this._embeddedFonts.has(font)) {
                groups.embedded.push(font);
            } else if (googleFontsSet.has(font) && !this._systemFonts.has(font)) {
                groups.google.push(font);
            } else {
                groups.system.push(font);
            }
        }

        const priority = new Map(POPULAR_GOOGLE_FONTS.map((font, idx) => [font, idx]));
        const popularFirst = (a, b) => {
            const ap = priority.has(a) ? priority.get(a) : Number.POSITIVE_INFINITY;
            const bp = priority.has(b) ? priority.get(b) : Number.POSITIVE_INFINITY;
            if (ap !== bp) return ap - bp;
            return a.localeCompare(b, undefined, { sensitivity: 'base' });
        };

        groups.google.sort(popularFirst);
        groups.embedded.sort(popularFirst);
        groups.system.sort(popularFirst);
        groups.custom.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

        const groupDefs = [
            { key: 'system',   label: '💻 系统字体', emoji: '💻' },
            { key: 'google',   label: '🌐 Google 免费 · 热门优先', emoji: '🌐' },
            { key: 'embedded', label: '📦 内置字体', emoji: '📦' },
            { key: 'custom',   label: '📤 用户上传', emoji: '📤' },
        ];

        // ── 填充隐藏 <select>（保证 form 兼容 + .value 正常工作）──
        select.innerHTML = '';
        for (const { key } of groupDefs) {
            for (const font of groups[key]) {
                const opt = document.createElement('option');
                opt.value = font;
                opt.textContent = DISPLAY_NAMES[font] || font;
                select.appendChild(opt);
            }
        }

        // 恢复选中
        if (currentValue && fonts.includes(currentValue)) {
            select.value = currentValue;
        } else if (oldValue && fonts.includes(oldValue)) {
            select.value = oldValue;
        } else {
            select.value = DEFAULT_FONT_FAMILY;
        }

        // ── 搜索式下拉框 ──
        this._ensureFontPickerCSS();
        this._buildFontPicker(select, groups, groupDefs, DISPLAY_NAMES);
    }

    /**
     * 注入字体搜索下拉框的全局 CSS（只注入一次）。
     */
    _ensureFontPickerCSS() {
        if (document.getElementById('font-picker-css')) return;
        const style = document.createElement('style');
        style.id = 'font-picker-css';
        style.textContent = `
            .fp-wrap { position:relative; display:inline-block; }
            .fp-wrap .fp-hidden-select { position:absolute; opacity:0; pointer-events:none; width:0; height:0; }
            .fp-input {
                width:100%; box-sizing:border-box;
                padding:4px 24px 4px 8px; border:1px solid var(--border-color, #555);
                border-radius:4px; font-size:12px; cursor:text;
                background:var(--bg-input, #1e1e2e); color:var(--text-primary, #eee);
                outline:none; text-overflow:ellipsis;
            }
            .fp-input:hover { border-color:var(--accent, #4c9eff); }
            .fp-input:focus { border-color:var(--accent, #4c9eff); }
            .fp-input::placeholder { color:var(--text-muted, #888); }
            .fp-arrow {
                position:absolute; right:6px; top:50%; transform:translateY(-50%);
                pointer-events:none; font-size:10px; color:var(--text-muted, #888);
            }
            .fp-dropdown {
                display:none; position:absolute; left:0; top:100%; z-index:99999;
                width:100%; min-width:220px; max-width:min(320px, 92vw); max-height:420px; overflow-y:auto;
                background:var(--bg-secondary, #1e1e2e); border:1px solid var(--border-color, #555);
                border-radius:6px; box-shadow:0 8px 24px rgba(0,0,0,0.4);
                margin-top:2px; padding:4px 0;
            }
            .fp-dropdown.fp-open { display:block; }
            .fp-group-label {
                padding:4px 10px; font-size:11px; font-weight:600;
                color:var(--text-muted, #aaa); background:var(--bg-hover, rgba(255,255,255,0.04));
                position:sticky; top:0; z-index:1;
            }
            .fp-item {
                padding:5px 12px; font-size:12px; cursor:pointer;
                color:var(--text-primary, #eee); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            }
            .fp-item:hover, .fp-item.fp-active { background:var(--accent, #4c9eff); color:#fff; }
            .fp-no-results { padding:12px; text-align:center; font-size:12px; color:var(--text-muted, #888); }
            .fp-count { font-size:10px; color:var(--text-muted, #888); margin-left:4px; }
            .fp-tip {
                padding:6px 10px; font-size:11px; color:var(--text-muted, #888);
                border-bottom:1px solid var(--border-color, #444);
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 为指定 <select> 构建可搜索的下拉框。
     */
    _buildFontPicker(select, groups, groupDefs, displayNames) {
        // 如果已有 wrapper，更新数据而不是重建整个 DOM
        let wrap = select.parentElement;
        if (!wrap || !wrap.classList.contains('fp-wrap')) {
            // 首次：创建 wrapper
            wrap = document.createElement('div');
            wrap.className = 'fp-wrap';
            // 继承原 select 宽度
            const sw = select.style.width || select.style.minWidth;
            if (sw) wrap.style.width = sw;
            wrap.style.minWidth = select.style.minWidth || '120px';
            wrap.style.flex = select.style.flex || '';

            select.parentElement.insertBefore(wrap, select);
            select.classList.add('fp-hidden-select');
            wrap.appendChild(select);

            // 搜索输入框
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'fp-input';
            input.placeholder = '搜索字体...';
            input.autocomplete = 'off';
            input.spellcheck = false;
            wrap.insertBefore(input, select);

            // 下拉箭头
            const arrow = document.createElement('span');
            arrow.className = 'fp-arrow';
            arrow.textContent = '▼';
            wrap.insertBefore(arrow, select);

            // 下拉面板
            const dropdown = document.createElement('div');
            dropdown.className = 'fp-dropdown';
            wrap.appendChild(dropdown);
        }

        const input = wrap.querySelector('.fp-input');
        const dropdown = wrap.querySelector('.fp-dropdown');

        // 把当前选中值显示在输入框里
        const currentFont = select.value || DEFAULT_FONT_FAMILY;
        input.value = displayNames[currentFont] || currentFont;

        // 存储数据到 wrapper 以供搜索/筛选使用
        wrap._fpData = { groups, groupDefs, displayNames, selectEl: select };

        // ── 事件绑定（只绑一次）──
        if (!wrap._fpBound) {
            wrap._fpBound = true;
            const self = this;

            const enterSearchMode = () => {
                input.value = '';
                input.placeholder = '输入字体名搜索...';
                _renderDropdown('');
                dropdown.classList.add('fp-open');
            };

            const restoreCurrentValue = () => {
                const d = wrap._fpData;
                const cv = d.selectEl.value;
                input.value = d.displayNames[cv] || cv;
                input.placeholder = '搜索字体...';
            };

            // 点击输入框 → 进入搜索模式
            input.addEventListener('focus', enterSearchMode);
            input.addEventListener('click', enterSearchMode);

            // 输入搜索
            input.addEventListener('input', () => {
                _renderDropdown(input.value.trim());
            });

            // 键盘导航
            input.addEventListener('keydown', (e) => {
                const items = dropdown.querySelectorAll('.fp-item');
                let active = dropdown.querySelector('.fp-item.fp-active');
                let idx = active ? Array.from(items).indexOf(active) : -1;

                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (idx < items.length - 1) idx++;
                    items.forEach(i => i.classList.remove('fp-active'));
                    if (items[idx]) { items[idx].classList.add('fp-active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (idx > 0) idx--;
                    items.forEach(i => i.classList.remove('fp-active'));
                    if (items[idx]) { items[idx].classList.add('fp-active'); items[idx].scrollIntoView({ block: 'nearest' }); }
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (active) active.click();
                } else if (e.key === 'Escape') {
                    dropdown.classList.remove('fp-open');
                    restoreCurrentValue();
                    input.blur();
                }
            });

            // 点击外部关闭
            document.addEventListener('mousedown', (e) => {
                if (!wrap.contains(e.target)) {
                    dropdown.classList.remove('fp-open');
                    restoreCurrentValue();
                }
            });

            function _renderDropdown(query) {
                const d = wrap._fpData;
                const q = query.toLowerCase();
                dropdown.innerHTML = '';
                let totalShown = 0;
                const MAX_PER_GROUP = q ? 300 : 150; // 默认多展示，搜索时尽量给足结果

                const tip = document.createElement('div');
                tip.className = 'fp-tip';
                tip.textContent = q
                    ? `搜索: ${query}`
                    : '输入字体名即可搜索，支持系统字体、内置字体和 Google 字体';
                dropdown.appendChild(tip);

                for (const { key, label } of d.groupDefs) {
                    const list = d.groups[key];
                    if (!list || list.length === 0) continue;

                    const filtered = q
                        ? list.filter(f => {
                            const display = d.displayNames[f] || f;
                            return f.toLowerCase().includes(q) || display.toLowerCase().includes(q);
                        })
                        : list;

                    if (filtered.length === 0) continue;

                    const groupLabel = document.createElement('div');
                    groupLabel.className = 'fp-group-label';
                    groupLabel.textContent = `${label} (${filtered.length})`;
                    dropdown.appendChild(groupLabel);

                    const shown = filtered.slice(0, MAX_PER_GROUP);
                    for (const font of shown) {
                        const item = document.createElement('div');
                        item.className = 'fp-item';
                        item.textContent = d.displayNames[font] || font;
                        item.dataset.value = font;
                        item.style.fontFamily = `"${font}", sans-serif`;
                        item.addEventListener('click', () => {
                            d.selectEl.value = font;
                            input.value = d.displayNames[font] || font;
                            dropdown.classList.remove('fp-open');
                            // 触发 change 事件
                            d.selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                            // 按需加载 Google 字体
                            self.loadGoogleFont(font).catch(() => {});
                        });
                        dropdown.appendChild(item);
                        totalShown++;
                    }

                    if (filtered.length > MAX_PER_GROUP) {
                        const more = document.createElement('div');
                        more.className = 'fp-no-results';
                        more.textContent = `还有 ${filtered.length - MAX_PER_GROUP} 个，请输入关键词筛选...`;
                        dropdown.appendChild(more);
                    }
                }

                if (totalShown === 0) {
                    const noRes = document.createElement('div');
                    noRes.className = 'fp-no-results';
                    noRes.textContent = `未找到 "${query}" 相关字体`;
                    dropdown.appendChild(noRes);
                }
            }
        } else {
            // 数据已更新，无需重新绑定事件
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
