/**
 * Shared subtitle text-direction helpers.
 *
 * `auto` follows the first strong character in the text.  Keep this module
 * dependency-free because it is also used by preview and export renderers.
 */
(function initReelsTextDirection(root) {
    const RTL_RANGES = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
    const LTR_RANGES = /[A-Za-z\u00C0-\u02AF\u0370-\u058F\u0900-\u1FFF\u2C00-\uD7FF\uF900-\uFB1C]/;

    function normalize(value) {
        const direction = String(value || 'auto').toLowerCase();
        return direction === 'rtl' || direction === 'ltr' ? direction : 'auto';
    }

    function detect(text, fallback = 'ltr') {
        for (const ch of String(text || '')) {
            if (RTL_RANGES.test(ch)) return 'rtl';
            if (LTR_RANGES.test(ch)) return 'ltr';
        }
        return fallback === 'rtl' ? 'rtl' : 'ltr';
    }

    function resolve(value, text, fallback = 'ltr') {
        const normalized = normalize(value);
        return normalized === 'auto' ? detect(text, fallback) : normalized;
    }

    function bidiMark(value, text) {
        return resolve(value, text) === 'rtl' ? '\u200F' : '\u200E';
    }

    function applyToElement(element, value, text) {
        if (!element) return;
        const normalized = normalize(value);
        const resolved = resolve(normalized, text !== undefined ? text : (element.value || element.textContent || ''));
        element.dir = normalized === 'auto' ? 'auto' : resolved;
        element.style.direction = resolved;
        element.style.unicodeBidi = 'plaintext';
    }

    const api = { normalize, detect, resolve, bidiMark, applyToElement };
    root.ReelsTextDirection = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
