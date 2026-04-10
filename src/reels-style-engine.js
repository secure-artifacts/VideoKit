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

    // ── Basic stroke ──
    use_stroke: true,
    border_width: 3,
    opacity_outline: 1.0,
    color_outline: '#000000',

    // ── Dynamic highlight box ──
    dynamic_box: false,
    color_high_bg: '#FFD700',
    opacity_high_bg: 0.3,
    dynamic_radius: 6,

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
const MAX_PRESETS = 50;

function _loadPresetsFromStorage() {
    try {
        const raw = localStorage.getItem(PRESET_STORAGE_KEY);
        if (!raw) return { default: {}, presets: {} };
        const data = JSON.parse(raw);
        if (typeof data !== 'object') return { default: {}, presets: {} };
        data.default = data.default || {};
        data.presets = data.presets || {};
        return data;
    } catch (e) {
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
    return JSON.stringify(loadSubtitlePresets(), null, 2);
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
        for (const [name, style] of Object.entries(incoming.presets || {})) {
            if (Object.keys(presets).length >= MAX_PRESETS && !(name in presets)) {
                result.skipped.push(name);
                continue;
            }
            if (name in presets) {
                result.conflicts.push(name);
                continue;
            }
            presets[name] = extractStyleKeys(style);
            result.added.push(name);
        }
        data.presets = presets;
        _savePresetsToStorage(data);
    } catch (e) { /* ignore */ }
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
};

if (typeof window !== 'undefined') window.ReelsStyleEngine = ReelsStyleEngine;
if (typeof module !== 'undefined' && module.exports) module.exports = ReelsStyleEngine;
