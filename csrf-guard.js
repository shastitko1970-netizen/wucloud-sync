/**
 * Pure guards for Nest CSRF session overlay and quiet disk-autosave toast.
 * No DOM, no fetch, no cookies — callers must never pass Cookie / token values here.
 */

/** Quiet «Дом на диске» at most once per this window (not every 2 min tick). */
export const DISK_AUTOSAVE_TOAST_MS = 5 * 60 * 1000;

export const SESSION_OVERLAY_ID = 'wucloud-session-overlay';
export const DISK_TOAST_ID = 'wucloud-disk-toast';

/** ST disk writes that fail closed on CSRF 403 after nest-st recreate. */
const ST_DISK_WRITE_PREFIXES = Object.freeze([
    '/api/chats',
    '/api/settings',
    '/api/characters',
    '/api/groups',
    '/api/worldinfo',
    '/api/backgrounds',
    '/api/avatars',
    '/api/files',
    '/api/sprites',
    '/api/themes',
    '/api/moving-ui',
    '/api/quick-replies',
    '/api/instruct-templates',
    '/api/context-templates',
    '/api/sysprompt',
    '/api/reasoning',
    '/api/preset-templates',
    '/api/user',
    '/api/users',
]);

/**
 * @param {unknown} method
 * @returns {boolean}
 */
export function isMutatingHttpMethod(method) {
    const m = String(method || 'GET').toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/**
 * Relative URLs count as same-origin. Cross-origin WuApi/OpenRouter must not arm overlay.
 *
 * @param {unknown} url
 * @param {unknown} pageOrigin
 * @returns {boolean}
 */
export function isSameOriginUrl(url, pageOrigin) {
    const raw = String(url || '');
    if (!raw) return false;
    if (raw.startsWith('/') && !raw.startsWith('//')) return true;
    const origin = String(pageOrigin || '');
    if (!origin) return !/^https?:\/\//i.test(raw);
    try {
        return new URL(raw, origin).origin === new URL(origin).origin;
    } catch (_) {
        return false;
    }
}

/**
 * @param {unknown} url
 * @param {unknown} pageOrigin
 * @returns {string}
 */
export function requestPathname(url, pageOrigin) {
    const raw = String(url || '');
    if (!raw) return '';
    try {
        return new URL(raw, String(pageOrigin || 'https://nest.wuproj.com')).pathname;
    } catch (_) {
        const q = raw.indexOf('?');
        const h = raw.indexOf('#');
        let p = raw;
        if (q >= 0) p = p.slice(0, q);
        if (h >= 0) p = p.slice(0, h);
        return p.startsWith('/') ? p : '';
    }
}

/**
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isWuGatewayPath(pathname) {
    const p = String(pathname || '');
    return p === '/_wu' || p === '/_nest'
        || p.startsWith('/_wu/') || p.startsWith('/_nest/');
}

/**
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isStDiskWritePath(pathname) {
    const p = String(pathname || '');
    if (!p.startsWith('/api/')) return false;
    for (const pre of ST_DISK_WRITE_PREFIXES) {
        if (p === pre || p.startsWith(`${pre}/`)) return true;
    }
    return false;
}

/**
 * Mutating ST calls that 403 as Express Forbidden after nest-st recreate.
 * Tokenizer count is what hides Send (script.js uncaught 403) — not a disk write.
 *
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isStCsrfFailClosedPath(pathname) {
    if (isStDiskWritePath(pathname)) return true;
    const p = String(pathname || '');
    return p === '/api/tokenizers' || p.startsWith('/api/tokenizers/');
}

/**
 * Body sniff only. Never log the string. Empty body is not a CSRF hint
 * (empty 403 on disk-write paths is handled by fail-closed path match).
 *
 * @param {unknown} bodyText
 * @returns {boolean}
 */
export function csrfHintInBody(bodyText) {
    const t = String(bodyText || '');
    if (!t) return false;
    if (/csrf/i.test(t) || /invalid token/i.test(t)) return true;
    // csrf-sync / Express default 403: <title>Error</title><pre>Forbidden</pre> — no "csrf" word.
    if (/<title>Error<\/title>/i.test(t) && /<pre>Forbidden<\/pre>/i.test(t)) {
        return true;
    }
    return false;
}

/**
 * Never auto-reload: a stale tab after recreate would loop.
 *
 * @returns {false}
 */
export function shouldAutoReloadOnCsrf() {
    return false;
}

/**
 * Fail-closed on mutating same-origin ST disk APIs (save chat/settings/…).
 * Other /api 403 only if the body literally mentions CSRF.
 * Wu gateway and cross-origin never arm. Overlay already up → skip (no loop).
 *
 * @param {{
 *   alreadyVisible?: boolean,
 *   status?: unknown,
 *   sameOrigin?: boolean,
 *   pathname?: unknown,
 *   mutating?: boolean,
 *   csrfHint?: boolean,
 * } | null | undefined} s
 * @returns {boolean}
 */
export function shouldShowSessionOverlay(s) {
    if (!s || typeof s !== 'object') return false;
    if (s.alreadyVisible) return false;
    if (s.status !== 403) return false;
    if (!s.sameOrigin) return false;
    if (!s.mutating) return false;
    const path = String(s.pathname || '');
    if (isWuGatewayPath(path)) return false;
    if (isStCsrfFailClosedPath(path)) return true;
    return !!s.csrfHint;
}

/**
 * Autosave (includeExtras) only. Not leave-flush, not the loud Save Now button.
 * Skip identical 2-min ticks. Debounce so a busy RP does not toast every tick.
 *
 * @param {{
 *   source?: unknown,
 *   includeExtras?: boolean,
 *   overlayVisible?: boolean,
 *   fingerprintChanged?: boolean,
 *   persistOk?: boolean,
 *   lastToastAt?: unknown,
 *   now?: unknown,
 *   minIntervalMs?: unknown,
 * } | null | undefined} s
 * @returns {boolean}
 */
export function shouldToastNestDiskAutosave(s) {
    if (!s || typeof s !== 'object') return false;
    if (s.source !== 'autosave') return false;
    if (!s.includeExtras) return false;
    if (s.overlayVisible) return false;
    if (s.persistOk !== true) return false;
    if (!s.fingerprintChanged) return false;
    const last = s.lastToastAt;
    const now = s.now;
    const min = s.minIntervalMs;
    const gap = typeof min === 'number' && Number.isFinite(min)
        ? min
        : DISK_AUTOSAVE_TOAST_MS;
    if (typeof last === 'number' && Number.isFinite(last)
        && typeof now === 'number' && Number.isFinite(now)
        && last > 0
        && (now - last) < gap) {
        return false;
    }
    return true;
}

/**
 * In-memory dirty key. Length + last-mes length/send_date — not message text.
 *
 * @param {{
 *   thisChid?: unknown,
 *   selectedGroup?: unknown,
 *   chatLength?: unknown,
 *   lastMesLen?: unknown,
 *   lastSend?: unknown,
 *   settingsAt?: unknown,
 * } | null | undefined} s
 * @returns {string}
 */
export function openHomeDiskFingerprint(s) {
    if (!s || typeof s !== 'object') return '';
    return [
        s.thisChid ?? '',
        s.selectedGroup ?? '',
        s.chatLength ?? 0,
        s.lastMesLen ?? 0,
        s.lastSend ?? '',
        s.settingsAt ?? 0,
    ].join('|');
}

/**
 * Empty last = not baselined yet. First idle tick and pre-init must not look dirty.
 * Callers advance last on successful persist (autosave and Save Now).
 *
 * @param {unknown} lastFingerprint
 * @param {unknown} currentFingerprint
 * @returns {boolean}
 */
export function nestDiskFingerprintChanged(lastFingerprint, currentFingerprint) {
    const last = String(lastFingerprint ?? '');
    if (!last) return false;
    return last !== String(currentFingerprint ?? '');
}
