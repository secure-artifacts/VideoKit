/**
 * reels-style-engine.js — Subtitle style data model & defaults.
 * 
 * ✅ 移植自 AutoSub_v8/core/AutoSub_v4.0.py STYLE_KEYS + SubtitleStylePanel
 * 
 * Provides:
 * - DEFAULT_SUBTITLE_STYLE: all ~80 style keys with sensible defaults
 * - copyStyle(): deep-clone a style object
 * - mergeStyle(): merge partial overrides into a base style
 * - Preset save/load via electron-store or localStorage
 */

// ───────────────────────────────────────────────────────
// Complete style keys — 1:1 from AutoSub STYLE_KEYS
// ───────────────────────────────────────────────────────

const DEFAULT_SUBTITLE_STYLE = {
    // ── Font ──
    font_family: 'Arimo',
    font_weight: 700,
    fontsize: 74,
    bold: true,
    italic: false,
    letter_spacing: 0,

    // ── Position ──
    pos_x: 0.5,       // 0~1 normalized (0.5 = center)
    pos_y: 0.5,       // 0~1 normalized (0.5 = center)
    rotation: 0,
    opacity_text_global: 1.0,

    // ── Colors ──
    color_text: '#FFFFFF',
    color_high: '#FFD700',      // current-word highlight color
    color_bg: '#000000',
    color_shadow: '#000000',
    opacity_bg: 0.6,
    opacity_shadow: 0.8,

    // ── Background box ──
    use_box: false,
    box_padding_x: 12,
    box_padding_y: 8,
    box_radius: 8,
    box_blur: 0,
    box_adaptive_width: false,

    // ── Basic stroke ──
    use_stroke: true,
    border_width: 3,
    opacity_outline: 1.0,
    color_outline: '#000000',

    // ── Dynamic highlight box ──
    karaoke_highlight: false,
    dynamic_box: false,
    color_high_bg: '#FFD700',
    opacity_high_bg: 0.3,
    dynamic_radius: 6,

    // ── Advanced Typography ──
    text_transform: 'none',

    // ── Scrolling Lyrics Mode ──
    scrolling_mode: false,
    scrolling_visible_lines: 3,
    scrolling_opacity_context: 0.3,

    // ── Shadow ──
    shadow_blur: 4,

    // ── Underline ──
    use_underline: false,
    color_underline: '#FFD700',

    // ── Highlight box padding ──
    high_padding: 4,
    high_offset_y: 0,

    // ── Text wrapping ──
    wrap_width_percent: 90,
    wrap_lines: 2,
    wrap_left: 0,
    wrap_right: 0,
    line_spacing: 1.2,

    // ── Legacy stroke/shadow (compatibility) ──
    stroke: true,
    stroke_width: 3,
    shadow: true,
    shadow_offset: 2,
    bg_enabled: false,
    bg_opacity: 0.6,
    bg_padding: 10,
    bg_radius: 8,
    color: '#FFFFFF',
    stroke_color: '#000000',
    bg_color: '#000000',

    // ── Animation (Phase 1) ──
    anim_in_type: 'fade',
    anim_in_duration: 0.3,
    anim_in_easing: 'ease_out',
    anim_out_type: 'fade',
    anim_out_duration: 0.25,
    anim_out_easing: 'ease_in_out',

    // ── Typewriter ──
    tw_revealed_color: '#FFFFFF',
    tw_revealed_stroke_color: '#000000',
    tw_revealed_opacity: 1.0,
    tw_revealed_stroke_opacity: 1.0,
    tw_unrevealed_color: '#808080',
    tw_unrevealed_stroke_color: '#404040',
    tw_unrevealed_opacity: 0.4,

    // ── Character bounce ──
    char_bounce_height: 20,
    char_bounce_stagger: 0.05,

    // ── Dynamic box animation ──
    dyn_box_anim: false,
    dyn_box_anim_overshoot: 1.3,
    dyn_box_anim_duration: 0.15,

    // ── Phase 2 animations ──
    // Floating
    floating_amplitude: 8,
    floating_period: 2.0,
    // Bullet reveal
    bullet_stagger: 0.15,
    // Metronome
    metronome_bpm: 120,
    // Flash highlight
    flash_color: '#FFFFFF',
    flash_duration: 0.1,
    // Holy glow
    holy_glow_radius: 6,
    holy_glow_color: '#FFFFAA',
    holy_glow_period: 3.0,
    // Letter jump
    letter_jump_scale: 1.5,
    letter_jump_duration: 0.2,
    // Word pop random
    word_pop_random_min_scale: 0.86,
    word_pop_random_max_scale: 1.34,
    word_pop_random_duration: 0.22,
    word_pop_random_unread_opacity: 0.0,
    word_pop_random_read_opacity: 1.0,
    word_pop_random_pulse_min_scale: 1.08,
    word_pop_random_pulse_max_scale: 1.38,
    word_pop_random_pulse_duration: 0.22,
    // Block typography (line-fit square layout)
    block_typography_enabled: false,
    block_scale_min: 0.78,
    block_scale_max: 1.6,
    // Blur → Sharp
    blur_sharp_max: 20,
    blur_sharp_clear_frac: 0.4,

    // ── Multi-layer stroke expansion ──
    stroke_expand_enabled: false,
    stroke_expand_layers: 3,
    stroke_expand_step: 2,
    stroke_expand_feather: 1,
    stroke_expand_colors: ['#000000', '#333333', '#666666'],
    stroke_expand_layer_widths: [3, 5, 7],
    stroke_expand_layer_feathers: [0, 0.5, 1.0],

    // ── Gradient background ──
    bg_gradient_enabled: false,
    bg_gradient_type: 'linear',     // linear | radial
    bg_gradient_colors: ['#000000', '#333333'],
    bg_gradient_highlight: false,

    // ── Dynamic box images ──
    dyn_box_image_enabled: false,
    dyn_box_images: [],
    dyn_box_image_path: '',
    dyn_box_image_scale: 1.0,
    dyn_box_image_offset_x: 0,
    dyn_box_image_offset_y: 0,
    dyn_box_image_blend: 'normal',

    // ── Metronome read/unread styles ──
    metro_read_color: '#FFFFFF',
    metro_read_stroke_color: '#000000',
    metro_read_stroke_width: 3,
    metro_read_opacity: 1.0,
    metro_unread_color: '#808080',
    metro_unread_stroke_color: '#404040',
    metro_unread_stroke_width: 2,
    metro_unread_opacity: 0.4,

    // ── Box color transition ──
    box_transition_enabled: false,
    box_transition_color_to: '#FF6600',

    // ── Advanced subtitle text-box ──
    advanced_textbox_enabled: false,
    advanced_textbox_x: 0,
    advanced_textbox_y: 0,
    advanced_textbox_w: 100,
    advanced_textbox_h: 100,
    advanced_textbox_align: 'center',
    advanced_textbox_valign: 'center',

    // ── Advanced text-box extra params ──
    adv_bg_enabled: false,
    adv_bg_offset_x: 0,
    adv_bg_offset_y: 0,
    adv_bg_w: 100,
    adv_bg_h: 50,
    adv_bg_radius: 8,
    adv_bg_color: '#000000',
    adv_bg_opacity: 0.6,
    adv_bg_gradient_enabled: false,
    adv_bg_gradient_type: 'linear',
    adv_bg_gradient_colors: ['#000000', '#333333'],
    adv_bg_gradient_highlight: false,
    adv_line_spacing: 1.2,
    adv_text_align: 'center',
    adv_stroke_enabled: false,
    adv_stroke_width: 2,
    adv_stroke_color: '#000000',
    adv_stroke_opacity: 1.0,

    // ── Global Video Mask ──
    global_mask_enabled: false,
    global_mask_color: '#000000',
    global_mask_opacity: 0.5,

    // ── Audio spectrum ──
    spectrum_enabled: false,
    spectrum_bands: 32,
    spectrum_bar_width: 6,
    spectrum_bar_gap: 2,
    spectrum_max_height: 60,
    spectrum_color_bottom: '#4444FF',
    spectrum_color_top: '#FF4444',
    spectrum_position: 'bottom',    // bottom | top | behind
    spectrum_shape: 'bars',         // bars | curve | zigzag | dots | hearts
    spectrum_dual: false,
    spectrum_top_shape: 'bars',
    spectrum_opacity: 0.8,
    spectrum_roundness: 4,
};

// All style keys list (for iteration / validation)
const STYLE_KEYS = Object.keys(DEFAULT_SUBTITLE_STYLE);

// ───────────────────────────────────────────────────────
// Style utility functions
// ───────────────────────────────────────────────────────

/**
 * Deep-clone a style object.
 */
function copyStyle(style) {
    if (!style || typeof style !== 'object') return { ...DEFAULT_SUBTITLE_STYLE };
    return JSON.parse(JSON.stringify(style));
}

/**
 * Create a full style with defaults, then apply overrides.
 */
function mergeStyle(overrides) {
    const base = copyStyle(DEFAULT_SUBTITLE_STYLE);
    if (!overrides || typeof overrides !== 'object') return base;
    for (const key of STYLE_KEYS) {
        if (key in overrides) {
            base[key] = typeof overrides[key] === 'object' && Array.isArray(overrides[key])
                ? [...overrides[key]]
                : overrides[key];
        }
    }
    return base;
}

/**
 * Extract only STYLE_KEYS from a mixed object (sanitize).
 */
function extractStyleKeys(obj) {
    if (!obj || typeof obj !== 'object') return {};
    const result = {};
    for (const key of STYLE_KEYS) {
        if (key in obj) {
            result[key] = typeof obj[key] === 'object' && Array.isArray(obj[key])
                ? [...obj[key]]
                : typeof obj[key] === 'object' && obj[key] !== null
                    ? JSON.parse(JSON.stringify(obj[key]))
                    : obj[key];
        }
    }
    return result;
}

// ───────────────────────────────────────────────────────
// Preset management (localStorage-based for browser)
// ───────────────────────────────────────────────────────

const PRESET_STORAGE_KEY = 'reels_subtitle_presets';
const MAX_PRESETS = 200;

const BUILTIN_PRESETS = {
    // ── 爆贴底框系列 ──
    "焦糖橙_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#9D4512", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#F5D678", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "深海蓝_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#0E4B7E", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#F6D371", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "暗夜青_青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#033045", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#00BFFF", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "明亮紫_黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#9D70A8", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#EFE174", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "奶油底_藏青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#EAD3B3", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#213555", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "浅丁香_藏青高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#B0B6CE", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#2A3A5A", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "砖红_金黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#B34A4D", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFD700", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "亮蓝_明黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#008CDE", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFEB3B", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "深紫_粉红高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#350B4D", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FF80AB", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "棕褐_奶黄高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#8C3B0E", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#FFF59D", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    "暗蓝灰_薄荷高亮": { karaoke_highlight: true, use_box: true, box_adaptive_width: true, color_bg: "#1D3B4C", opacity_bg: 255, color_text: "#FFFFFF", color_high: "#A7FFEB", use_stroke: false, shadow_blur: 0, box_radius: 2, box_padding_x: 16, box_padding_y: 10, font_weight: 900, line_spacing: 1.2 },
    
    // ── 经典系列 ──
    "逐个大小出字-55": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 72, color_text: "#FFFFFF", color_high: "#fff701", use_box: false, use_stroke: true, border_width: 6, color_outline: "#3E2723", opacity_outline: 255, shadow_blur: 0, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.12, font_weight: 900 },
    "逐个大小出字-45": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 45, color_text: "#FFFFFF", color_high: "#fbff00", use_box: false, use_stroke: true, border_width: 6, color_outline: "#0A192F", opacity_outline: 255, dynamic_box: false, shadow_blur: 0, line_spacing: 1.12, font_weight: 900 },
    "深蓝大底框+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 45, color_text: "#FFFFFF", color_high: "#ffffff", use_box: true, box_adaptive_width: false, color_bg: "#1A2238", opacity_bg: 165, box_radius: 26, box_padding_x: 37, box_padding_y: 15, use_stroke: false, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 7, line_spacing: 1.56, font_weight: 900 },
    "深褐底框+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 55, color_text: "#FFFFFF", color_high: "#ffffff", use_box: true, box_adaptive_width: true, color_bg: "#2C1E16", opacity_bg: 128, box_radius: 25, box_padding_x: 21, box_padding_y: 6, use_stroke: false, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 9, line_spacing: 1.51, font_weight: 900 },
    "逐个出字+红色动画": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 58, color_text: "#FFFFFF", color_high: "#f0f000", use_box: false, use_stroke: true, border_width: 6, color_outline: "#1B1229", opacity_outline: 255, dynamic_box: true, color_high_bg: "#cc0003", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.12, font_weight: 900 },
    "极简纯文+电光青高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 56, color_text: "#F0F0F0", color_high: "#00FFFF", use_box: false, use_stroke: true, border_width: 3, color_outline: "#022B3A", opacity_outline: 255, shadow_blur: 8, color_shadow: "#022B3A", opacity_shadow: 204, shadow_offset_x: 3, shadow_offset_y: 3, dynamic_box: false, line_spacing: 1.2, font_weight: 900 },
    "重金大字+强对比排版": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FFD700", use_box: false, use_stroke: true, border_width: 8, color_outline: "#2A241D", opacity_outline: 255, dynamic_box: false, line_spacing: 1.1, font_weight: 900 },
    "蓝底白字+动感回弹": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 48, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: true, box_adaptive_width: true, color_bg: "#1E90FF", opacity_bg: 216, box_radius: 8, box_padding_x: 15, box_padding_y: 6, use_stroke: false, dynamic_box: true, color_high_bg: "#FF0050", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.4, font_weight: 900 },
    "逐个出字大小-爆贴": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 72, color_text: "#FFFFFF", color_high: "#fff701", use_box: false, use_stroke: true, border_width: 6, color_outline: "#2D1B4E", opacity_outline: 255, dynamic_box: true, color_high_bg: "#c61e00", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.27, font_weight: 900 },

    // ── 社交风格系列 ──
    "黑边_粉红高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "黑边_薄荷高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#00FA9A", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "黑边_电蓝高亮": { karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#4169E1", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "滚动歌词_粉高亮": { scrolling_mode: true, scrolling_visible_lines: 3, scrolling_opacity_context: 0.25, karaoke_highlight: true, font_family: "Impact", fontsize: 68, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: false, use_stroke: true, border_width: 8, color_outline: "#000000", opacity_outline: 255, shadow_blur: 0, line_spacing: 1.1, font_weight: 900, text_transform: "uppercase" },
    "白底框_紫字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#000000", color_high: "#8A2BE2", use_box: true, box_adaptive_width: true, color_bg: "#FFFFFF", opacity_bg: 255, box_radius: 4, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "黑底框_粉字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#FFFFFF", color_high: "#FF69B4", use_box: true, box_adaptive_width: true, color_bg: "#333333", opacity_bg: 255, box_radius: 4, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "软阴影_青字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#00FFFF", use_box: false, use_stroke: false, shadow_blur: 12, color_shadow: "#000000", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 4, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "硬阴影_黄字高亮": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#FFD700", use_box: false, use_stroke: false, shadow_blur: 0, color_shadow: "#000000", opacity_shadow: 255, shadow_offset_x: 6, shadow_offset_y: 6, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "紫色动态底框": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: false, use_stroke: false, shadow_blur: 4, color_shadow: "#000000", opacity_shadow: 150, shadow_offset_x: 2, shadow_offset_y: 2, dynamic_box: true, color_high_bg: "#7B68EE", opacity_high_bg: 255, dynamic_radius: 8, line_spacing: 1.2, font_weight: 900 },
    "荧光绿底框_黑字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 60, color_text: "#000000", color_high: "#000000", use_box: true, box_adaptive_width: true, color_bg: "#ADFF2F", opacity_bg: 255, box_radius: 6, box_padding_x: 20, box_padding_y: 10, use_stroke: false, shadow_blur: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "纯白发光字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FFFFFF", color_high: "#FFFFFF", use_box: false, use_stroke: false, shadow_blur: 15, color_shadow: "#FFFFFF", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" },
    "粉红发光字": { karaoke_highlight: true, font_family: "Segoe UI", fontsize: 65, color_text: "#FF69B4", color_high: "#FF69B4", use_box: false, use_stroke: false, shadow_blur: 15, color_shadow: "#FF69B4", opacity_shadow: 200, shadow_offset_x: 0, shadow_offset_y: 0, line_spacing: 1.2, font_weight: 900, text_transform: "uppercase" }
};

// Category mapping for collapsible preset picker
const PRESET_CATEGORIES = {
    '🎯 底框样式': ['焦糖橙_黄高亮','深海蓝_黄高亮','暗夜青_青高亮','明亮紫_黄高亮','奶油底_藏青高亮','浅丁香_藏青高亮','砖红_金黄高亮','亮蓝_明黄高亮','深紫_粉红高亮','棕褐_奶黄高亮','暗蓝灰_薄荷高亮','白底框_紫字高亮','黑底框_粉字高亮','荧光绿底框_黑字','深蓝大底框+红色动画','深褐底框+红色动画','粉色气泡','渐变蓝色框','红色警报'],
    '📝 基础字幕': ['默认白字','黄字黑边 (经典)','上滑入场','左滑入场','黑底白字 (新闻)'],
    '🎤 卡拉OK高亮': ['卡拉OK高亮','节奏逐词','闪光高亮','黑边_粉红高亮','黑边_薄荷高亮','黑边_电蓝高亮','极简纯文+电光青高亮','重金大字+强对比排版'],
    '🔥 逐词动态': ['逐个大小出字-55','逐个大小出字-45','逐个出字+红色动画','逐个出字大小-爆贴','蓝底白字+动感回弹','紫色动态底框','逐字放大','逐词弹出(随机大小)','逐词弹出(随机回弹)','Hormozi 风格字幕'],
    '✨ 特殊动画': ['打字机模式','逐行出现','悬浮漂移','霓虹多层描边','滚动歌词_粉高亮','圣光降临','阴影沉浸式'],
    '💫 阴影发光': ['软阴影_青字高亮','硬阴影_黄字高亮','纯白发光字','粉红发光字'],
};

function getPresetsByCategory() {
    const data = loadSubtitlePresets();
    const allPresets = data.presets || {};
    const allNames = Object.keys(allPresets);
    const categorized = [];
    const used = new Set();

    // Add categorized built-in presets
    for (const [catName, presetNames] of Object.entries(PRESET_CATEGORIES)) {
        const items = presetNames.filter(n => n in allPresets);
        if (items.length > 0) {
            categorized.push({ category: catName, names: items });
            items.forEach(n => used.add(n));
        }
    }

    // Add uncategorized (user-saved) presets
    const uncategorized = allNames.filter(n => !used.has(n));
    if (uncategorized.length > 0) {
        categorized.push({ category: '💾 我的预设', names: uncategorized });
    }

    return { categorized, presetsMap: allPresets };
}

function _loadPresetsFromStorage() {
    try {
        const raw = localStorage.getItem(PRESET_STORAGE_KEY);
        if (!raw) {
            console.warn('[StyleEngine] localStorage 中无预设数据 (key:', PRESET_STORAGE_KEY, ')');
            return { default: {}, presets: {} };
        }
        const data = JSON.parse(raw);
        if (typeof data !== 'object') return { default: {}, presets: {} };
        data.default = data.default || {};
        data.presets = data.presets || {};
        return data;
    } catch (e) {
        console.error('[StyleEngine] 读取预设失败:', e);
        return { default: {}, presets: {} };
    }
}

function _savePresetsToStorage(data) {
    try {
        const json = JSON.stringify(data);
        localStorage.setItem(PRESET_STORAGE_KEY, json);
        console.log(`[StyleEngine] 预设已保存 (${(json.length / 1024).toFixed(1)}KB, ${Object.keys(data.presets || {}).length}个预设)`);
        return true;
    } catch (e) {
        console.error(`[StyleEngine] 保存预设失败:`, e);
        return false;
    }
}

function loadSubtitlePresets() {
    const data = _loadPresetsFromStorage();
    data.default = extractStyleKeys(data.default);
    const presets = {};
    // 加载内置预设（style-engine 自带）
    for (const [name, style] of Object.entries(BUILTIN_PRESETS)) {
        presets[name] = extractStyleKeys(style);
    }
    // 加载 presets-init.js 中的内置预设（如果已注册到 window）
    if (typeof window !== 'undefined' && window.REELS_BUILTIN_PRESETS) {
        for (const [name, style] of Object.entries(window.REELS_BUILTIN_PRESETS)) {
            presets[name] = extractStyleKeys(style);
        }
    }
    // 加载用户预设 (覆盖同名内置预设)
    for (const [name, style] of Object.entries(data.presets || {})) {
        presets[name] = extractStyleKeys(style);
    }
    data.presets = presets;
    return data;
}

function saveDefaultSubtitleStyle(style) {
    const data = _loadPresetsFromStorage();
    data.default = extractStyleKeys(style);
    return _savePresetsToStorage(data);
}

function saveNamedSubtitlePreset(name, style) {
    if (!name || typeof name !== 'string') return false;
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (!(name in presets) && Object.keys(presets).length >= MAX_PRESETS) return false;
    presets[name] = extractStyleKeys(style);
    data.presets = presets;
    return _savePresetsToStorage(data);
}

function deleteSubtitlePreset(name) {
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (name in presets) {
        delete presets[name];
        data.presets = presets;
        return _savePresetsToStorage(data);
    }
    return false;
}

function renameSubtitlePreset(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    const data = _loadPresetsFromStorage();
    const presets = data.presets || {};
    if (!(oldName in presets)) return false;
    if (newName in presets) return false;
    presets[newName] = presets[oldName];
    delete presets[oldName];
    data.presets = presets;
    return _savePresetsToStorage(data);
}

function applySubtitlePreset(name) {
    const data = loadSubtitlePresets();
    const presets = data.presets || {};
    if (name in presets) return mergeStyle(presets[name]);
    return mergeStyle(data.default);
}

function exportSubtitlePresets() {
    // 只导出用户自定义预设（排除内置预设），避免导入时产生大量冲突
    const data = _loadPresetsFromStorage();
    const userPresets = data.presets || {};
    return JSON.stringify({ default: data.default || {}, presets: userPresets }, null, 2);
}

function importSubtitlePresets(jsonString) {
    const result = { added: [], conflicts: [], skipped: [] };
    try {
        const incoming = JSON.parse(jsonString);
        if (typeof incoming !== 'object') return result;
        const data = _loadPresetsFromStorage();
        if (incoming.default) {
            data.default = extractStyleKeys(incoming.default);
        }
        const presets = data.presets || {};
        // 收集内置预设名，导入时跳过纯内置预设（避免污染用户存储）
        const builtinNames = new Set(Object.keys(BUILTIN_PRESETS));
        for (const [name, style] of Object.entries(incoming.presets || {})) {
            // 如果是内置预设且本地没有用户覆盖版本，跳过
            if (builtinNames.has(name) && !(name in presets)) {
                result.skipped.push(name);
                continue;
            }
            if (Object.keys(presets).length >= MAX_PRESETS && !(name in presets)) {
                result.skipped.push(name);
                continue;
            }
            if (name in presets) {
                // 同名预设：覆盖而非跳过
                presets[name] = extractStyleKeys(style);
                result.conflicts.push(name);
                continue;
            }
            presets[name] = extractStyleKeys(style);
            result.added.push(name);
        }
        data.presets = presets;
        _savePresetsToStorage(data);
    } catch (e) {
        console.error('[StyleEngine] 导入预设失败:', e);
    }
    return result;
}

// ───────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────

const ReelsStyleEngine = {
    DEFAULT_SUBTITLE_STYLE,
    STYLE_KEYS,
    MAX_PRESETS,
    // Utils
    copyStyle,
    mergeStyle,
    extractStyleKeys,
    // Presets
    loadSubtitlePresets,
    saveDefaultSubtitleStyle,
    saveNamedSubtitlePreset,
    deleteSubtitlePreset,
    renameSubtitlePreset,
    applySubtitlePreset,
    exportSubtitlePresets,
    importSubtitlePresets,
    getPresetsByCategory,
};

if (typeof window !== 'undefined') window.ReelsStyleEngine = ReelsStyleEngine;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsStyleEngine;
