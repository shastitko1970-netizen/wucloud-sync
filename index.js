/**
 * WuCloud — SillyTavern extension (ST 1.15+ / Nest 1.18)
 *
 * Two modes:
 *   external  — bridge: local/foreign ST ↔ WuApi packs (zip object store)
 *   nest      — companion on Nest hosts: live data is ST disk only; NO cloud Push/Pull
 *
 * Nest hosts: nest.wuproj.com, st.wuproj.com, tavern.wuproj.com
 * Install: Extensions → Install extension → https://github.com/shastitko1970-netizen/wucloud-sync
 *
 * Sibling product NestCloud (apps/nest-cloud) is the same code branded for Nest;
 * Nest servers preinstall only nest-cloud — not both.
 */
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { getRequestHeaders as stGetRequestHeaders, saveSettingsDebounced, saveChatConditional, saveSettings, isChatSaving, createOrEditCharacter } from '../../../../script.js';
import { editGroup } from '../../../group-chats.js';
import { selected_world_info, world_info, loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import {
    shouldFlushChat,
    shouldRunNestDiskAutosave,
    shouldAutosaveNestSettings,
    leaveFlushStartAction,
    NEST_DISK_AUTOSAVE_MS,
    chatLoadedAfterEvent,
    shouldSaveCharacterCard,
    shouldSaveGroupMeta,
    worldNamesToFlush,
} from './flush-guard.js';
import {
    DISK_TOAST_ID,
    SESSION_OVERLAY_ID,
    csrfHintInBody,
    isMutatingHttpMethod,
    isSameOriginUrl,
    isStCsrfFailClosedPath,
    isWuGatewayPath,
    nestDiskFingerprintChanged,
    openHomeDiskFingerprint,
    requestPathname,
    shouldShowSessionOverlay,
    shouldToastNestDiskAutosave,
} from './csrf-guard.js';

/** Extension folder / settings key. NestCloud emit rewrites to nest-cloud. */
const MODULE = 'wucloud-sync';
const PRODUCT_LABEL = 'WuCloud';
const GITHUB_HOME = 'https://github.com/shastitko1970-netizen/wucloud-sync';
/** Hostnames where this build auto-enters Nest companion mode (no cloud Push/Pull). */
const NEST_MANAGED_HOSTS = Object.freeze([
    'nest.wuproj.com',
    'st.wuproj.com',
    'tavern.wuproj.com',
]);
/** Both cloud products — never push each other as a third-party dependency. */
const CLOUD_SIBLING_MODULES = Object.freeze(['wucloud-sync', 'nest-cloud']);
const FOLDER = `third-party/${MODULE}`;
const LOG_PREFIX = '[WuCloud]';
const MAP_KEY = `${MODULE}_id_map`;
const EXT_VERSION = '0.15.3';

/** True after a successful chat load this session (see chatLoadedAfterEvent). */
let chatLoadedThisSession = false;
/** Entity that last completed load — mid-switch this_chid / selected_group already moved. */
let loadedThisChid = undefined;
let loadedSelectedGroup = undefined;
/** True after our bootstrap hydrated settings — flush settings.json on leave. */
let settingsHydrated = false;
/** GENERATION_STARTED … ENDED/STOPPED — do not flush a truncated stream. */
let generationInFlight = false;
let leaveFlushInFlight = false;
/** Hide/pagehide arrived while persist held the mutex — retry after release. */
let leaveFlushPending = false;
/** Hide+pagehide burst debounce only. Save Now must not write this. */
let lastLeaveFlushAt = 0;
/** Longest in-memory chat length seen for the loaded entity this session. */
let lastKnownChatLength = 0;
/** Last successful saveSettings from companion persist (Nest 10 MiB settings.json). */
let lastSettingsPersistAt = 0;
/** Last disk fingerprint we already persisted (autosave or Save Now). */
let lastDiskFingerprint = '';
/** Last quiet «Дом на диске» toast (ms). */
let lastDiskToastAt = 0;
/** Hide timer for the quiet disk toast node. */
let diskToastHideTimer = 0;

/** @typedef {'external' | 'nest'} WuCloudMode */

/**
 * chat_push_mode:
 *   current   — only open chat (fast, default)
 *   character — all chats of the selected character
 *   all       — all chats of every character (slow, cooperative)
 */
const defaultSettings = Object.freeze({
    api_key: '',
    base_url: 'https://api.wuproj.com',
    sync_characters: true,
    sync_chats: true,
    // Enabled by default so Push does not silently skip these (user can uncheck)
    sync_personas: true,
    sync_lorebooks: true,
    sync_presets: true,
    autosave: 'off', // off | message | interval — forced off on Nest
    debounce_sec: 8,
    use_gzip: true,
    chat_push_mode: 'current', // current | character | all
    // Dual-write to platform /chats for Dashboard preview. Heavy — off by default.
    dual_write_platform: false,
    request_timeout_sec: 90,
    // Phase 0: set true on nest.wuproj.com (companion mode)
    managed_nest: false,
});

/** @type {Record<string, { cloud_id?: number, content_hash?: string }>} */
let idMap = {};
let mapLoaded = false;
let mapDirty = false;
let mapSaveTimer = null;
let autosaveTimer = null;
let intervalHandle = null;
let nestDiskAutosaveKickTimer = null;
let pushInFlight = false;
let pushAbort = null;

function ctx() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            return SillyTavern.getContext();
        }
    } catch (_) { /* ignore */ }
    try {
        return getContext();
    } catch (_) {
        return {};
    }
}

function libs() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.libs) return SillyTavern.libs;
    } catch (_) { /* ignore */ }
    try {
        const c = ctx();
        if (c?.libs) return c.libs;
    } catch (_) { /* ignore */ }
    return {};
}

/**
 * CSRF + JSON headers for ST local API.
 * ST 1.15+ exposes getRequestHeaders on context; fall back to script.js export.
 */
function getRequestHeaders(opts = {}) {
    try {
        const c = ctx();
        if (typeof c.getRequestHeaders === 'function') {
            return c.getRequestHeaders(opts);
        }
    } catch (_) { /* fall through */ }
    try {
        if (typeof stGetRequestHeaders === 'function') {
            return stGetRequestHeaders(opts);
        }
    } catch (_) { /* ignore */ }
    const headers = {};
    if (!opts?.omitContentType) headers['Content-Type'] = 'application/json';
    try {
        if (typeof token !== 'undefined' && token) headers['X-CSRF-Token'] = token;
    } catch (_) { /* ignore */ }
    return headers;
}

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    // migrate legacy map out of settings into localforage
    const s = extension_settings[MODULE];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    if (s.map && typeof s.map === 'object' && Object.keys(s.map).length) {
        idMap = { ...idMap, ...s.map };
        delete s.map;
        persist();
        saveMap().catch(() => {});
    }
    return s;
}

function persist() {
    try { saveSettingsDebounced(); } catch (e) { console.warn(LOG_PREFIX, e); }
}

async function loadMap() {
    if (mapLoaded) return idMap;
    try {
        const lf = libs().localforage;
        if (lf) {
            const stored = await lf.getItem(MAP_KEY);
            if (stored && typeof stored === 'object') idMap = stored;
        } else {
            const raw = localStorage.getItem(MAP_KEY);
            if (raw) idMap = JSON.parse(raw);
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'map load', e);
    }
    mapLoaded = true;
    return idMap;
}

async function saveMap() {
    try {
        const lf = libs().localforage;
        if (lf) await lf.setItem(MAP_KEY, idMap);
        else localStorage.setItem(MAP_KEY, JSON.stringify(idMap));
        mapDirty = false;
    } catch (e) {
        console.warn(LOG_PREFIX, 'map save', e);
    }
}

/** Debounced map flush — avoid localforage write after every single chat. */
async function flushMap(force = false) {
    if (mapSaveTimer) {
        clearTimeout(mapSaveTimer);
        mapSaveTimer = null;
    }
    if (!mapDirty && !force) return;
    await saveMap();
}

function scheduleMapSave() {
    mapDirty = true;
    if (mapSaveTimer) return;
    mapSaveTimer = setTimeout(() => {
        mapSaveTimer = null;
        saveMap().catch(() => {});
    }, 800);
}

function mapGet(key) {
    return idMap[key] || null;
}

async function mapSet(key, cloudId, hash, { flush = false } = {}) {
    idMap[key] = { cloud_id: cloudId, content_hash: hash };
    mapDirty = true;
    if (flush) await flushMap(true);
    else scheduleMapSave();
}

/** Let the browser paint / handle input between heavy items. */
function yieldToUI(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatPushMode() {
    const m = String(getSettings().chat_push_mode || 'current').toLowerCase();
    if (m === 'character' || m === 'all') return m;
    return 'current';
}

function requestTimeoutMs() {
    const sec = Number(getSettings().request_timeout_sec);
    return Math.max(15, Number.isFinite(sec) ? sec : 90) * 1000;
}

/** True if the bulk-push AbortController was cancelled. */
function isPushAborted() {
    try {
        return !!(pushAbort && pushAbort.signal && pushAbort.signal.aborted);
    } catch (_) {
        return false;
    }
}

/**
 * ST-local fetch headers (CSRF). Without X-CSRF-Token ST returns 403/empty
 * and bulk chat listing silently finds 0 files.
 */
function stHeaders({ omitContentType = false } = {}) {
    return getRequestHeaders({ omitContentType });
}

/**
 * POST/GET to SillyTavern local API with CSRF + optional abort.
 * FormData auto-omits Content-Type so browser sets multipart boundary.
 * Missing X-CSRF-Token → ST returns 403 (classic import failure).
 */
async function stFetch(url, body = null, { method = 'POST', omitContentType = false } = {}) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = stHeaders({ omitContentType: omitContentType || isForm });
    const opts = { method, headers, cache: 'no-cache' };
    if (body != null && method !== 'GET') {
        opts.body = typeof body === 'string' || isForm
            ? body
            : JSON.stringify(body);
    }
    if (pushAbort?.signal) opts.signal = pushAbort.signal;
    const res = await fetch(url, opts);
    return res;
}

/** Ring buffer — survives re-render; shown in panel + Copy/Full */
const LOG_MAX = 400;
/** @type {string[]} */
const logBuffer = [];

function setStatus(msg, kind = '') {
    const el = document.getElementById('wucloud_status');
    if (el) {
        el.textContent = msg;
        el.classList.remove('is-ok', 'is-err', 'is-busy');
        if (kind) el.classList.add(`is-${kind}`);
    }
    // Also mirror important status into ST toasts (server log still won't show this)
    if (kind === 'err') toast('error', msg);
    else if (kind === 'ok' && /OK|Готово|синхрон/i.test(msg)) toast('success', msg.slice(0, 120));
}

function renderLogPanel() {
    const el = document.getElementById('wucloud_log');
    if (!el) return;
    // newest first
    el.textContent = logBuffer.join('\n');
    el.scrollTop = 0;
}

function logLine(line) {
    const t = new Date().toLocaleTimeString();
    const row = `[${t}] ${line}`;
    logBuffer.unshift(row);
    if (logBuffer.length > LOG_MAX) logBuffer.length = LOG_MAX;
    renderLogPanel();
    // Browser console (F12) — not ST Server Log
    try { console.log(LOG_PREFIX, line); } catch (_) { /* ignore */ }
}

function getLogText() {
    return logBuffer.join('\n');
}

async function copyLog() {
    const text = getLogText();
    if (!text) {
        toast('warning', 'Журнал пуст');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        toast('success', 'Журнал скопирован');
    } catch (_) {
        // Fallback prompt
        try {
            const c = ctx();
            if (c.Popup?.show?.input) {
                await c.Popup.show.input('WuCloud journal', 'Скопируй вручную:', text);
            } else {
                prompt('Скопируй журнал:', text);
            }
        } catch (e) {
            prompt('Скопируй журнал:', text);
        }
    }
}

function clearLog() {
    logBuffer.length = 0;
    renderLogPanel();
    setStatus('Журнал очищен', 'ok');
}

async function showLogPopup() {
    const text = getLogText() || '(пусто)';
    try {
        const c = ctx();
        if (c.Popup?.show?.text) {
            await c.Popup.show.text('WuCloud journal', `<pre class="wucloud-log-popup-body">${escapeHtml(text)}</pre>`);
            return;
        }
        if (c.Popup) {
            const popup = new c.Popup(
                `<pre class="wucloud-log-popup-body">${escapeHtml(text)}</pre>`,
                c.POPUP_TYPE?.TEXT ?? 1,
                '',
                { okButton: 'Close', wide: true, allowVerticalScrolling: true },
            );
            await popup.show();
            return;
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'popup log failed', e);
    }
    // Last resort
    alert(text.slice(0, 4000));
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toast(kind, msg) {
    const m = String(msg || '').slice(0, 200);
    try {
        if (typeof toastr !== 'undefined') {
            if (kind === 'error') toastr.error(m, 'WuCloud', { timeOut: 8000 });
            else if (kind === 'warning') toastr.warning(m, 'WuCloud', { timeOut: 6000 });
            else if (kind === 'info') toastr.info(m, 'WuCloud', { timeOut: 4000 });
            else toastr.success(m, 'WuCloud', { timeOut: 4000 });
            return;
        }
    } catch (_) { /* ignore */ }
    // ensure something visible even without toastr
    if (kind === 'error') logLine(`TOAST/ERR: ${m}`);
}

function baseUrl() {
    let u = String(getSettings().base_url || 'https://api.wuproj.com');
    // Strip zero-width / BOM / newlines that break fetch (Failed to fetch)
    u = u.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim();
    u = u.replace(/\/+$/, '');
    // Common mistakes: pasted full chat path or missing scheme
    u = u.replace(/\/v1(\/chat\/completions)?$/i, '');
    u = u.replace(/\/api\/v2.*$/i, '');
    if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
    // Force https for our hosts (http often blocked / mixed)
    try {
        const host = new URL(u || 'https://api.wuproj.com').hostname.toLowerCase();
        if (host === 'api.wuproj.com' || host === 'eco.wuproj.com' || host.endsWith('.wuproj.com')) {
            u = u.replace(/^http:\/\//i, 'https://');
        }
    } catch (_) {
        u = 'https://api.wuproj.com';
    }
    return u || 'https://api.wuproj.com';
}

function isNetworkFetchError(e) {
    const msg = String(e?.message || e || '').toLowerCase();
    const name = String(e?.name || '');
    if (name === 'TypeError' && msg.includes('fetch')) return true;
    return (
        msg.includes('failed to fetch')
        || msg.includes('networkerror')
        || msg.includes('network request failed')
        || msg.includes('load failed')
        || msg.includes('err_connection')
        || msg.includes('err_name_not_resolved')
        || msg.includes('err_timed_out')
    );
}

/** Normalize key from dashboard: strip Bearer/, quotes, whitespace. Must start with wu- */
function apiKey() {
    let k = String(getSettings().api_key || '').trim();
    k = k.replace(/^["']|["']$/g, '');
    k = k.replace(/^Bearer\s+/i, '').trim();
    // Some clients wrap as "Authorization: Bearer wu-..."
    k = k.replace(/^Authorization:\s*Bearer\s+/i, '').trim();
    return k;
}

function formatApiError(json, text, status) {
    if (json && typeof json === 'object') {
        // proxy writeError: { error: { message, type, code } }
        if (json.error && typeof json.error === 'object') {
            const m = json.error.message || json.error.type;
            if (m) return String(m);
            try { return JSON.stringify(json.error); } catch (_) { /* fallthrough */ }
        }
        if (typeof json.error === 'string') return json.error;
        if (typeof json.message === 'string') return json.message;
        try { return JSON.stringify(json); } catch (_) { /* fallthrough */ }
    }
    if (text && text.trim()) return text.slice(0, 300);
    return status || 'unknown error';
}

async function sha256Hex(textOrBuf) {
    const data = typeof textOrBuf === 'string'
        ? new TextEncoder().encode(textOrBuf)
        : (textOrBuf instanceof ArrayBuffer ? new Uint8Array(textOrBuf) : textOrBuf);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Gzip string → Uint8Array (ST fflate / CompressionStream). Always returns Uint8Array. */
async function maybeGzip(text) {
    const s = getSettings();
    const plain = new TextEncoder().encode(text);
    if (!s.use_gzip) {
        return { bytes: plain, gzipped: false };
    }
    const L = libs();
    // SillyTavern exports gzipSync / gzip from fflate
    const gzipFn = L.gzipSync || L.gzip || null;
    if (typeof gzipFn === 'function') {
        try {
            const out = gzipFn(plain);
            const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
            if (bytes.length && bytes[0] === 0x1f && bytes[1] === 0x8b) {
                return { bytes, gzipped: true };
            }
        } catch (e) {
            logLine(`gzip(fflate): ${e.message}`);
        }
    }
    if (typeof CompressionStream !== 'undefined') {
        try {
            const stream = new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'));
            const ab = await new Response(stream).arrayBuffer();
            return { bytes: new Uint8Array(ab), gzipped: true };
        } catch (e) {
            logLine(`gzip(stream): ${e.message}`);
        }
    }
    return { bytes: plain, gzipped: false };
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, formData?: FormData|null, retries?: number, formDataFactory?: (() => FormData)|null }} opts
 * formDataFactory: rebuild FormData per attempt (streams / some browsers consume body).
 */
async function apiFetch(path, {
    method = 'GET',
    body = null,
    formData = null,
    retries = 2,
    formDataFactory = null,
} = {}) {
    const key = apiKey();
    if (!key) throw new Error('Введите API-ключ wu-… из кабинета WuProj (Dashboard → API keys)');
    if (!key.startsWith('wu-')) {
        throw new Error('Ключ должен начинаться с wu- (это API-ключ, не пароль и не JWT). Возьмите в Dashboard → API keys.');
    }

    const url = `${baseUrl()}${path}`;
    const timeoutMs = requestTimeoutMs();
    const maxAttempts = Math.max(1, 1 + (Number(retries) || 0));
    let lastErr = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (isPushAborted()) throw new Error('Отменено');

        const headers = { Authorization: `Bearer ${key}` };
        let payload = body;
        if (typeof formDataFactory === 'function') {
            payload = formDataFactory();
        } else if (formData) {
            payload = formData;
        } else if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof Uint8Array)) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const onOuterAbort = () => ctrl.abort();
        const outerSignal = pushAbort && pushAbort.signal ? pushAbort.signal : null;
        if (outerSignal) {
            if (outerSignal.aborted) {
                clearTimeout(timer);
                throw new Error('Отменено');
            }
            outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        }

        try {
            const res = await fetch(url, {
                method,
                headers,
                body: payload,
                signal: ctrl.signal,
                mode: 'cors',
                credentials: 'omit',
                cache: 'no-store',
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (_) { /* raw */ }
            if (!res.ok) {
                const errMsg = formatApiError(json, text, res.statusText);
                // Retry transient edge/gateway errors
                if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < maxAttempts) {
                    lastErr = new Error(`${res.status}: ${errMsg}`);
                    logLine(`apiFetch retry ${attempt}/${maxAttempts} ${path} HTTP ${res.status}`);
                    await new Promise((r) => setTimeout(r, 600 * attempt));
                    continue;
                }
                if (res.status === 401) {
                    throw new Error(`401 Unauthorized: ${errMsg}. Проверьте ключ wu-… (скопируйте заново из кабинета, без пробелов).`);
                }
                throw new Error(`${res.status}: ${errMsg}`);
            }
            return json;
        } catch (e) {
            if (e?.message === 'Отменено' || e?.message?.startsWith('401') || e?.message?.match(/^[45]\d\d:/)) {
                // non-retryable business/auth errors already formatted
                if (e?.message?.match(/^[45]\d\d:/) && !e?.message?.match(/^50[234]:/)) throw e;
                if (e?.message?.startsWith('401') || e?.message === 'Отменено') throw e;
            }
            if (e?.name === 'AbortError') {
                if (isPushAborted()) throw new Error('Отменено');
                lastErr = new Error(`Таймаут ${Math.round(timeoutMs / 1000)}с: ${path}`);
            } else if (isNetworkFetchError(e) || String(e?.message || '').startsWith('Сеть:')) {
                lastErr = e;
            } else if (String(e?.message || '').match(/^50[234]:/)) {
                lastErr = e;
            } else {
                throw e;
            }
            if (attempt < maxAttempts && (isNetworkFetchError(e) || e?.name === 'AbortError' || String(e?.message || '').match(/^50[234]:/))) {
                logLine(`apiFetch retry ${attempt}/${maxAttempts} ${path}: ${e?.message || e}`);
                await new Promise((r) => setTimeout(r, 700 * attempt));
                continue;
            }
            // final network error — human message
            const base = baseUrl();
            const nestHint = isNestMode()
                ? ' На Nest для переноса используйте «Из облака» / Import, не Push pack.'
                : ' Откройте в браузере https://api.wuproj.com/health — должен быть {"status":"ok"}.';
            throw new Error(
                `Сеть: ${lastErr?.message || e?.message || 'Failed to fetch'} (url=${url}). `
                + `Проверьте интернет, base URL (${base}), VPN/блокировки.${nestHint}`,
            );
        } finally {
            clearTimeout(timer);
            if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
        }
    }
    throw lastErr || new Error('Сеть: запрос не удался');
}

/** Quick auth check against quotas endpoint */
async function testConnection() {
    setStatus('Проверка ключа…', 'busy');
    try {
        const key = apiKey();
        if (!key) throw new Error('Введите API-ключ wu-…');
        if (!key.startsWith('wu-')) throw new Error('Ключ должен начинаться с wu-');
        logLine(`base=${baseUrl()} key=${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`);
        const q = await apiFetch('/api/v2/user/quotas');
        const msg = `OK · auth · chats ${q?.usage?.chats ?? 0}/${q?.limits?.chats ?? '∞'} · sub=${!!q?.has_subscription}`;
        setStatus(msg, 'ok');
        toast('success', 'Ключ принят');
        logLine(msg);
    } catch (e) {
        setStatus(e.message, 'err');
        toast('error', e.message);
        logLine(e.message);
    }
}

// ─── Characters ───────────────────────────────────────────────────────────

async function pushCharacter(char) {
    if (!char?.avatar) return { skipped: true, reason: 'no avatar' };
    const clientKey = `char:${char.avatar}`;
    const avatarRes = await fetch(`/characters/${char.avatar}`);
    if (!avatarRes.ok) return { skipped: true, reason: 'avatar fetch failed' };

    const blob = await avatarRes.blob();
    const buf = await blob.arrayBuffer();
    const hash = await sha256Hex(
        `${char.name || ''}|${char.avatar}|${buf.byteLength}|${char.data?.description || char.description || ''}`
    );

    const prev = mapGet(clientKey);
    if (prev?.content_hash === hash && prev.cloud_id) {
        return { skipped: true, reason: 'unchanged', id: prev.cloud_id };
    }

    const fd = new FormData();
    const fname = char.avatar.endsWith('.png') ? char.avatar : `${char.avatar}.png`;
    fd.append('file', blob, fname);
    fd.append('client_key', clientKey);
    fd.append('content_hash', hash);

    const res = await apiFetch('/api/v2/characters/import', { method: 'POST', formData: fd });
    const id = res?.id || res?.data?.id;
    if (id) await mapSet(clientKey, id, hash);
    return res;
}

// ─── Chats ────────────────────────────────────────────────────────────────

function buildChatJsonlFromArray(chatArr, meta = {}) {
    const lines = [];
    lines.push(JSON.stringify({
        user_name: meta.user_name || 'User',
        character_name: meta.character_name || 'Character',
        create_date: Date.now(),
        chat_metadata: meta.chat_metadata || {},
    }));
    for (const m of chatArr || []) {
        if (!m || typeof m !== 'object') continue;
        lines.push(JSON.stringify({
            name: m.name,
            is_user: !!m.is_user,
            is_name: m.is_name !== false,
            send_date: m.send_date,
            mes: m.mes ?? m.message ?? '',
            swipes: m.swipes,
            swipe_id: m.swipe_id,
            extra: m.extra,
        }));
    }
    return lines.join('\n') + '\n';
}

async function pushChatPayload({ clientKey, title, jsonl }) {
    const hash = await sha256Hex(jsonl);
    const prev = mapGet(clientKey);
    if (prev?.content_hash === hash && prev.cloud_id) {
        return { skipped: true, reason: 'unchanged', id: prev.cloud_id };
    }

    const { bytes, gzipped } = await maybeGzip(jsonl);
    const safeName = String(title || clientKey).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'chat';
    const fd = new FormData();
    const fname = gzipped ? `${safeName}.jsonl.gz` : `${safeName}.jsonl`;
    fd.append('file', new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/jsonl' }), fname);
    fd.append('client_key', clientKey);
    fd.append('kind', 'chat_jsonl');
    fd.append('name', title || safeName);
    fd.append('content_hash', hash);
    fd.append('meta', JSON.stringify({ source: 'wucloud-sync', gzipped: !!gzipped }));

    // Lossless blob API (gzip at rest on server)
    const res = await apiFetch('/api/v2/st-sync/blobs', { method: 'POST', formData: fd });
    const id = res?.id;
    if (id) await mapSet(clientKey, id, hash);

    // Optional dual-write to platform chats for Dashboard preview (lossy, slow)
    if (getSettings().dual_write_platform) {
        try {
            const fd2 = new FormData();
            fd2.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `${safeName}.jsonl`);
            fd2.append('client_key', `platform:${clientKey}`);
            fd2.append('content_hash', hash);
            fd2.append('title', title || safeName);
            await apiFetch('/api/v2/chats/import', { method: 'POST', formData: fd2 });
        } catch (_) { /* non-fatal */ }
    }

    return res;
}

/**
 * Discover third-party extensions + git remote URLs.
 * ST user backup only includes data/<handle>/extensions — global installs
 * (public/.../third-party) ship empty extensions/ in the zip while
 * extension_settings still carry configs. We embed a reinstall manifest so Nest
 * can git-clone missing folders after import.
 * @returns {Promise<Array<{folder:string,type:string,remote_url:string,display_name?:string,version?:string,settings_key?:string}>>}
 */
async function collectThirdPartyExtensions() {
    const headers = getRequestHeaders();
    /** @type {Array<{folder:string,type:string,remote_url:string,display_name?:string,version?:string,settings_key?:string}>} */
    const out = [];
    let list = [];
    try {
        const res = await fetch('/api/extensions/discover', {
            headers,
            signal: pushAbort?.signal,
        });
        if (res.ok) list = await res.json();
        else logLine(`ext discover HTTP ${res.status}`);
    } catch (e) {
        logLine(`ext discover fail: ${e?.message || e}`);
        return out;
    }
    if (!Array.isArray(list)) return out;

    for (const e of list) {
        if (isPushAborted()) throw new Error('Отменено');
        if (!e || e.type === 'system') continue;
        const rawName = String(e.name || '');
        if (!rawName.includes('third-party/') && e.type !== 'local' && e.type !== 'global') continue;
        const folder = rawName.replace(/^third-party\//, '').replace(/\\/g, '/').split('/').filter(Boolean).pop();
        if (!folder || CLOUD_SIBLING_MODULES.includes(folder)) continue; // Nest seeds companion separately

        let remoteUrl = '';
        let displayName = '';
        let version = '';
        try {
            const vRes = await fetch('/api/extensions/version', {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    extensionName: folder,
                    global: e.type === 'global',
                }),
                signal: pushAbort?.signal,
            });
            if (vRes.ok) {
                const v = await vRes.json();
                remoteUrl = String(v?.remoteUrl || '').trim();
            }
        } catch (_) { /* no git remote */ }

        try {
            const mRes = await fetch(`/scripts/extensions/third-party/${encodeURIComponent(folder)}/manifest.json`, {
                headers,
                signal: pushAbort?.signal,
            });
            if (mRes.ok) {
                const m = await mRes.json();
                displayName = String(m?.display_name || m?.displayName || '').trim();
                version = String(m?.version || '').trim();
                if (!remoteUrl && m?.homePage && /github\.com|gitlab\.com|codeberg\.org/i.test(String(m.homePage))) {
                    remoteUrl = String(m.homePage).trim();
                }
            }
        } catch (_) { /* ignore */ }

        // settings keys often differ from folder (e.g. horae vs SillyTavern-Horae)
        let settingsKey = '';
        try {
            const es = extension_settings || {};
            if (es[folder] != null) settingsKey = folder;
            else {
                const low = folder.toLowerCase();
                for (const k of Object.keys(es)) {
                    if (k.toLowerCase() === low || low.includes(k.toLowerCase()) || k.toLowerCase().includes(low)) {
                        settingsKey = k;
                        break;
                    }
                }
            }
        } catch (_) { /* ignore */ }

        out.push({
            folder,
            type: String(e.type || 'local'),
            remote_url: remoteUrl,
            display_name: displayName || undefined,
            version: version || undefined,
            settings_key: settingsKey || undefined,
        });
        await yieldToUI(0);
    }
    logLine(`ext manifest: ${out.length} third-party (${out.filter((x) => x.remote_url).length} with git url)`);
    return out;
}

/** Persist manifest into user/files so ST zip backup includes it. */
async function writeExtensionsManifestToUserFiles(entries) {
    const payload = {
        version: 1,
        format: 'wucloud_extensions',
        created_at: new Date().toISOString(),
        ext_version: EXT_VERSION,
        extensions: entries || [],
    };
    const json = JSON.stringify(payload, null, 2);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    try {
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'wucloud-extensions.json', data: b64 }),
            signal: pushAbort?.signal,
        });
        if (!res.ok) {
            logLine(`ext manifest write HTTP ${res.status}`);
            return false;
        }
        logLine('ext manifest written → user/files/wucloud-extensions.json');
        return true;
    } catch (e) {
        logLine(`ext manifest write fail: ${e?.message || e}`);
        return false;
    }
}

/**
 * Phase 2: push one ST data pack to object store (/api/v2/wucloud/packs).
 * Prefer ST native zip via /api/users/backup; fallback JSON asset pack.
 */
async function pushPackToCloud() {
    if (!assertExternalBridge('Push pack')) return;
    if (pushInFlight) {
        toast('warning', 'Уже идёт выгрузка');
        return;
    }
    pushInFlight = true;
    pushAbort = new AbortController();
    setStopButtonVisible(true);
    setStatus('Push pack…', 'busy');
    logLine('pack push: start');

    try {
        let blob = null;
        let filename = '';
        let format = 'zip';
        /** @type {Array<{folder:string,type:string,remote_url:string}>} */
        let extManifest = [];

        // 0) Extension reinstall manifest (settings alone don't install code)
        try {
            setStatus('Push: scan extensions…', 'busy');
            extManifest = await collectThirdPartyExtensions();
            if (extManifest.length) {
                await writeExtensionsManifestToUserFiles(extManifest);
            }
        } catch (e) {
            if (e?.message === 'Отменено') throw e;
            logLine(`ext scan: ${e?.message || e}`);
        }

        // 1) ST native backup zip (multi-user or default handle)
        try {
            setStatus('Push: ST backup zip…', 'busy');
            const meRes = await fetch('/api/users/me', { headers: getRequestHeaders() });
            if (meRes.ok) {
                const me = await meRes.json();
                const handle = me.handle || me.name || '';
                if (handle) {
                    const res = await fetch('/api/users/backup', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ handle }),
                        signal: pushAbort?.signal,
                    });
                    if (res.ok) {
                        blob = await res.blob();
                        const cd = res.headers.get('Content-Disposition') || '';
                        const m = /filename="?([^";]+)"?/i.exec(cd);
                        filename = (m && m[1]) || `${handle}-backup.zip`;
                        format = 'zip';
                        logLine(`pack push: ST zip ${Math.round(blob.size / 1024)} KB`);
                    } else {
                        logLine(`pack push: ST backup HTTP ${res.status} — JSON fallback`);
                    }
                }
            } else {
                logLine(`pack push: /api/users/me ${meRes.status} — JSON fallback`);
            }
        } catch (e) {
            if (e?.name === 'AbortError' || e?.message === 'Отменено') throw new Error('Отменено');
            logLine(`pack push: ST zip fail ${e.message} — JSON fallback`);
        }

        // 2) JSON asset pack fallback (no multi-user backup)
        if (!blob) {
            setStatus('Push: JSON pack…', 'busy');
            const json = await buildJsonAssetPack(extManifest);
            const { bytes, gzipped } = await maybeGzip(json);
            blob = new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/json' });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            filename = gzipped ? `st-pack-${stamp}.json.gz` : `st-pack-${stamp}.json`;
            format = gzipped ? 'json.gz' : 'json';
            logLine(`pack push: JSON ${Math.round(blob.size / 1024)} KB`);
            toast(
                'warning',
                'ST zip backup недоступен — ушёл JSON-pack (chars/chats + ext manifest). '
                + 'Для полного Nest-переноса: Data → Backup zip, затем Push.',
            );
        }

        if (isPushAborted()) throw new Error('Отменено');

        const sizeMB = (blob.size || 0) / (1024 * 1024);
        const sizeLabel = sizeMB >= 1024
            ? `${(sizeMB / 1024).toFixed(2)} ГиБ`
            : `${sizeMB.toFixed(1)} МиБ`;
        logLine(`pack push: upload size ${sizeLabel} (${blob.size} bytes)`);
        // Soft guide: very large zips need current API (4 GiB) + long timeout
        if (blob.size > 3.5 * 1024 * 1024 * 1024) {
            throw new Error(
                `Pack слишком большой (${sizeLabel}). Макс. ~4 ГиБ. `
                + 'Сожмите backup или перенесите через Nest Export/Import без cloud pack.',
            );
        }
        if (blob.size > 100 * 1024 * 1024) {
            toast('info', `Большой pack ${sizeLabel} — грузим чанками (~80 МиБ)…`);
            try {
                const s = getSettings();
                if ((Number(s.request_timeout_sec) || 90) < 600) {
                    s.request_timeout_sec = 900;
                    persist();
                    logLine('pack push: raised request_timeout_sec to 900 for chunked pack');
                }
            } catch (_) { /* */ }
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const clientKey = `pack:mod:${stamp}`;
        const metaStr = JSON.stringify({
            source: 'wucloud-sync',
            format,
            ext_version: EXT_VERSION,
            extensions: extManifest,
        });

        // Multi‑GB: one POST of 1.3GiB → Failed to fetch on most browsers.
        // Chunk under ~80MiB (safe for CF/nginx/browser).
        const PACK_CHUNK = 80 * 1024 * 1024;
        const useChunks = blob.size > PACK_CHUNK;
        let res;

        if (useChunks) {
            const nChunks = Math.max(1, Math.ceil(blob.size / PACK_CHUNK));
            const uploadId = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
            // Pre-slice so File handle stays valid (Android)
            const parts = [];
            for (let i = 0; i < nChunks; i++) {
                parts.push(blob.slice(i * PACK_CHUNK, Math.min(blob.size, (i + 1) * PACK_CHUNK)));
            }
            logLine(`pack push: chunked upload_id=${uploadId} chunks=${nChunks} chunk_mb=80`);
            toast('info', `Чанки: 0/${nChunks} · ${sizeLabel}`);
            for (let i = 0; i < nChunks; i++) {
                if (isPushAborted()) throw new Error('Отменено');
                setStatus(`Push: чанк ${i + 1}/${nChunks} · ${sizeLabel}`, 'busy');
                logLine(`pack push: chunk ${i + 1}/${nChunks} size=${parts[i].size}`);
                const chunkRes = await apiFetch('/api/v2/wucloud/packs', {
                    method: 'POST',
                    retries: 4,
                    formDataFactory: () => {
                        const f = new FormData();
                        f.append('file', parts[i], filename || `pack-${stamp}.bin`);
                        f.append('client_key', clientKey);
                        f.append('name', filename || `ST pack ${stamp}`);
                        f.append('source', 'mod');
                        f.append('meta', metaStr);
                        f.append('upload_id', uploadId);
                        f.append('chunk', String(i));
                        f.append('chunks', String(nChunks));
                        // server hashes assembled file; skip 1.3GiB client hash
                        f.append('content_hash', '');
                        return f;
                    },
                });
                res = chunkRes;
                if (chunkRes?.done || chunkRes?.id) {
                    logLine(`pack push: assemble done at chunk ${i + 1}/${nChunks}`);
                    break;
                }
                if (chunkRes?.have != null) {
                    logLine(`pack push: server have ${chunkRes.have}/${nChunks}`);
                }
            }
            if (!res?.id && !res?.done) {
                throw new Error('chunked upload incomplete — попробуйте ещё раз (resume по upload_id пока только на сервере по чанкам)');
            }
        } else {
            // Small packs: single POST + client content hash
            const ab = await blob.arrayBuffer();
            const hash = await sha256Hex(ab);
            setStatus(`Push: upload ${sizeLabel}…`, 'busy');
            res = await apiFetch('/api/v2/wucloud/packs', {
                method: 'POST',
                retries: 3,
                formDataFactory: () => {
                    const f = new FormData();
                    f.append('file', blob, filename || `pack-${stamp}.bin`);
                    f.append('client_key', clientKey);
                    f.append('name', filename || `ST pack ${stamp}`);
                    f.append('content_hash', hash);
                    f.append('source', 'mod');
                    f.append('meta', metaStr);
                    return f;
                },
            });
        }

        const id = res?.id;
        logLine(res?.skipped
            ? `pack skip unchanged #${id}`
            : `pack OK #${id} · ${res?.size_bytes || blob.size} b · ${res?.encoding || format}`);
        setStatus(id ? `Pack #${id} в облаке` : 'Push: нет id', id ? 'ok' : 'err');
        if (id) toast('success', `Pack #${id} — Dashboard → WuCloud packs`);
        return res;
    } catch (e) {
        if (e?.message === 'Отменено') {
            setStatus('Push отменён', 'err');
            logLine('pack push: cancelled');
        } else {
            // If network died after server wrote pack, list may still show it
            setStatus(`Push: ${e.message}`, 'err');
            toast('error', e.message);
            logLine(`pack push error: ${e.message}`);
            try {
                const list = await apiFetch('/api/v2/wucloud/packs', { retries: 1 });
                const items = list?.items || [];
                if (items.length) {
                    const last = items[0];
                    logLine(`pack push: after error, cloud has #${last.id} ${last.name || ''} — возможно upload прошёл`);
                    toast('info', `В облаке уже есть pack #${last.id}. Проверьте Dashboard → WuCloud packs.`);
                }
            } catch (_) { /* ignore secondary */ }
        }
        throw e;
    } finally {
        pushInFlight = false;
        pushAbort = null;
        setStopButtonVisible(false);
    }
}

/** Build lightweight JSON asset pack when ST zip backup is unavailable. */
async function buildJsonAssetPack(extManifest = null) {
    const c = ctx();
    const characters = c.characters || [];
    const pack = {
        version: 1,
        format: 'wucloud_st_pack',
        created_at: new Date().toISOString(),
        source: 'wucloud-sync',
        ext_version: EXT_VERSION,
        note: 'JSON asset pack fallback. Prefer ST /api/users/backup zip when available.',
        assets: {
            characters: [],
            chats: [],
            personas: {},
            lorebooks: {},
            presets: [],
            extensions: Array.isArray(extManifest) ? extManifest : [],
        },
    };
    for (let i = 0; i < characters.length; i++) {
        if (isPushAborted()) throw new Error('Отменено');
        const ch = characters[i];
        pack.assets.characters.push({ avatar: ch.avatar, name: ch.name, data: ch.data || null });
        if (i % 8 === 0) {
            setStatus(`Pack: chars ${i + 1}/${characters.length}…`, 'busy');
            await yieldToUI(0);
        }
    }
    let chatBytes = 0;
    const chatSoftCap = 40 * 1024 * 1024;
    for (let ci = 0; ci < characters.length; ci++) {
        if (isPushAborted()) throw new Error('Отменено');
        const char = characters[ci];
        if (!char?.avatar) continue;
        let files = [];
        try { files = await listChatFilesForCharacter(char); } catch (_) { continue; }
        for (const f of files) {
            if (isPushAborted()) throw new Error('Отменено');
            if (chatBytes >= chatSoftCap) break;
            try {
                const chatArr = await loadChatArray(char, f.file_name);
                if (!Array.isArray(chatArr) || !chatArr.length) continue;
                const jsonl = buildChatJsonlFromArray(chatArr, { character_name: char.name });
                chatBytes += jsonl.length;
                pack.assets.chats.push({
                    character_avatar: char.avatar,
                    character_name: char.name,
                    file_name: f.file_name,
                    jsonl,
                });
            } catch (_) { /* skip */ }
            await yieldToUI(0);
        }
        if (chatBytes >= chatSoftCap) break;
    }
    try {
        const pu = c.powerUser || c.power_user || {};
        pack.assets.personas = pu.personas || pu.persona_descriptions || {};
    } catch (_) { /* ignore */ }
    try {
        const worlds = c.world_names || c.worldNames || [];
        if (Array.isArray(worlds)) pack.assets.lorebooks = { names: worlds };
    } catch (_) { /* ignore */ }
    if (!pack.assets.extensions?.length) {
        try {
            pack.assets.extensions = await collectThirdPartyExtensions();
        } catch (_) { /* ignore */ }
    }
    return JSON.stringify(pack);
}

/** @deprecated alias */
async function pushUserBackupSnapshot() {
    return pushPackToCloud();
}

/**
 * Phase 2 pull: list packs, download latest (or chosen) as browser file.
 * User imports via ST Data Management → Import Backup.
 */
async function pullPackFromCloud({ packId = null } = {}) {
    if (!assertExternalBridge('Pull pack')) return;
    setStatus('Pull pack…', 'busy');
    try {
        const list = await apiFetch('/api/v2/wucloud/packs');
        const items = list?.items || [];
        if (!items.length) {
            setStatus('Нет packs в облаке', 'err');
            toast('warning', 'Облако пусто — сначала Push pack');
            logLine('pack pull: empty list');
            return;
        }
        logLine(`pack pull: ${items.length} packs · legacy_count=${list?.legacy_count ?? 0}`);
        let target = items[0];
        if (packId) {
            target = items.find(i => Number(i.id) === Number(packId)) || target;
        }
        setStatus(`Pull: #${target.id}…`, 'busy');
        const key = apiKey();
        const url = `${baseUrl()}/api/v2/wucloud/packs/get?id=${target.id}`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${key}` },
            signal: pushAbort?.signal,
        });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(formatApiError(null, t, res.status));
        }
        const blob = await res.blob();
        const enc = String(target.encoding || '');
        let fname = String(target.name || `pack-${target.id}`).replace(/[^\w.\-]+/g, '_').slice(0, 80);
        if (enc === 'zip' && !fname.endsWith('.zip')) fname += '.zip';
        else if (enc === 'gzip' && !fname.endsWith('.gz')) fname += '.gz';
        const a = document.createElement('a');
        const obj = URL.createObjectURL(blob);
        a.href = obj;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(obj);
        setStatus(`Pull: ${fname} (${Math.round(blob.size / 1024)} KB)`, 'ok');
        toast('success', 'Pack скачан — Import Backup в ST');
        logLine(`pack pull OK #${target.id} ${fname}`);
    } catch (e) {
        setStatus(`Pull: ${e.message}`, 'err');
        toast('error', e.message);
        logLine(`pack pull error: ${e.message}`);
    }
}

async function listPacksCloud() {
    if (!assertExternalBridge('List packs')) return;
    try {
        setStatus('List packs…', 'busy');
        const list = await apiFetch('/api/v2/wucloud/packs');
        const items = list?.items || [];
        if (!items.length) {
            logLine('packs: (empty)');
            setStatus('Packs: 0', 'ok');
            toast('info', 'Нет packs');
            return;
        }
        for (const p of items.slice(0, 20)) {
            const kb = Math.round((p.size_bytes || 0) / 1024);
            logLine(`pack #${p.id} · ${p.name || p.client_key} · ${kb} KB · ${p.encoding || '?'} · ${p.source || ''}`);
        }
        if (items.length > 20) logLine(`… +${items.length - 20} more`);
        setStatus(`Packs: ${items.length}`, 'ok');
        toast('success', `${items.length} packs (см. журнал)`);
    } catch (e) {
        setStatus(`List: ${e.message}`, 'err');
        toast('error', e.message);
    }
}

async function pushCurrentChat() {
    const c = ctx();
    if (!c?.chat?.length) return { skipped: true, reason: 'empty chat' };

    const char = c.characters?.[c.characterId];
    const avatar = char?.avatar || 'unknown';
    const fileHint = (typeof c.getCurrentChatId === 'function' && c.getCurrentChatId())
        || c.chatId
        || c.chatMetadata?.file_name
        || 'chat';
    const clientKey = `chat:${avatar}:${fileHint}`;
    const jsonl = buildChatJsonlFromArray(c.chat, {
        user_name: c.name1,
        character_name: c.name2 || char?.name,
        chat_metadata: c.chatMetadata || {},
    });
    return pushChatPayload({
        clientKey,
        title: `${char?.name || avatar} · ${fileHint}`,
        jsonl,
    });
}

/**
 * List chat files for a character via ST API (needs CSRF).
 * ST returns array of { file_name, file_id, ... } or { error: true }.
 */
async function listChatFilesForCharacter(char) {
    if (!char?.avatar) return [];
    const label = char.name || char.avatar;
    try {
        // simple:true → lightweight list of file names (official ST endpoint)
        const res = await stFetch('/api/characters/chats', {
            avatar_url: char.avatar,
            simple: true,
        });
        if (!res.ok) {
            logLine(`list chats ${label}: HTTP ${res.status} (CSRF/headers?)`);
            // retry without simple for older ST
            const res2 = await stFetch('/api/characters/chats', { avatar_url: char.avatar });
            if (!res2.ok) {
                logLine(`list chats ${label}: HTTP ${res2.status}`);
                return [];
            }
            const data2 = await res2.json();
            return normalizeChatFileList(data2, label);
        }
        const data = await res.json();
        return normalizeChatFileList(data, label);
    } catch (e) {
        if (e?.name === 'AbortError' || e?.message === 'Отменено') throw new Error('Отменено');
        logLine(`list chats ${label}: ${e.message}`);
        return [];
    }
}

function normalizeChatFileList(data, label = '') {
    if (data == null) return [];
    if (typeof data === 'object' && !Array.isArray(data) && data.error === true) {
        logLine(`list chats ${label}: ST error (нет папки чатов?)`);
        return [];
    }
    let files;
    if (Array.isArray(data)) {
        files = data;
    } else if (typeof data === 'object') {
        // ST getPastCharacterChats uses Object.values(data)
        files = data.chats || data.file_list || Object.values(data);
    } else {
        files = [];
    }
    const out = files.map(f => {
        if (typeof f === 'string') return { file_name: f };
        if (!f || typeof f !== 'object') return null;
        const name = f.file_name || f.filename || f.file_id || f.name;
        if (!name || typeof name !== 'string') return null;
        return { file_name: name, file_id: f.file_id || String(name).replace(/\.jsonl$/i, '') };
    }).filter(Boolean);
    return out;
}

/**
 * Load full chat jsonl content from ST.
 * Correct endpoint is /api/chats/get (NOT /api/characters/get — that returns the card).
 * file_name must be WITHOUT .jsonl — server appends it.
 */
async function loadChatArray(char, fileName) {
    const bare = String(fileName || '').replace(/\.jsonl$/i, '');
    if (!bare) return null;
    try {
        const res = await stFetch('/api/chats/get', {
            ch_name: char.name || '',
            file_name: bare,
            avatar_url: char.avatar,
        });
        if (!res.ok) {
            logLine(`chats/get ${char.name}/${bare}: HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();
        // empty object {} when missing; array when ok
        if (!Array.isArray(data)) {
            logLine(`chats/get ${char.name}/${bare}: not array (${typeof data})`);
            return null;
        }
        return data;
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error('Отменено');
        logLine(`chats/get ${char.name}/${bare}: ${e.message}`);
        return null;
    }
}

/**
 * Push all chat files for one character. Yields to UI between items.
 */
async function pushChatsForCharacter(char, { progressLabel = '' } = {}) {
    if (!char?.avatar) return { pushed: 0, skipped: 0, errors: 0 };
    const files = await listChatFilesForCharacter(char);
    logLine(`list ${char.name || char.avatar}: ${files.length} chat file(s)`);
    if (!files.length) {
        // Only fall back to in-memory chat if this is the currently open character
        const c = ctx();
        const cur = c.characters?.[c.characterId];
        if (cur?.avatar === char.avatar && c?.chat?.length) {
            logLine(`list empty → fallback current open chat (${c.chat.length} msgs)`);
            const r = await pushCurrentChat();
            return {
                pushed: r?.skipped ? 0 : 1,
                skipped: r?.skipped ? 1 : 0,
                errors: 0,
            };
        }
        return { pushed: 0, skipped: 0, errors: 0 };
    }

    let pushed = 0, skipped = 0, errors = 0;
    const total = files.length;
    for (let i = 0; i < files.length; i++) {
        if (isPushAborted()) break;
        const f = files[i];
        try {
            const label = progressLabel || (char.name || char.avatar);
            setStatus(`Чат ${i + 1}/${total} · ${label}: ${f.file_name}`, 'busy');
            if (i > 0 && i % 5 === 0) {
                logLine(`… ${label}: ${i}/${total} (push ${pushed}, skip ${skipped}, err ${errors})`);
            }
            const chatArr = await loadChatArray(char, f.file_name);
            if (!Array.isArray(chatArr) || !chatArr.length) {
                skipped++;
                await yieldToUI(0);
                continue;
            }
            // Prefer stable file_id / name with extension for client_key
            const keyName = f.file_name.endsWith('.jsonl') ? f.file_name : `${String(f.file_name).replace(/\.jsonl$/i, '')}.jsonl`;
            const clientKey = `chat:${char.avatar}:${keyName}`;
            const jsonl = buildChatJsonlFromArray(chatArr, {
                character_name: char.name,
            });
            const r = await pushChatPayload({
                clientKey,
                title: `${char.name} · ${keyName}`,
                jsonl,
            });
            if (r?.skipped) skipped++;
            else pushed++;
        } catch (e) {
            if (e?.message === 'Отменено') throw e;
            errors++;
            logLine(`chat ${char.name || char.avatar}/${f.file_name}: ${e.message}`);
        }
        // Cooperative multitasking — keep ST responsive on large libraries
        await yieldToUI(i % 3 === 0 ? 8 : 0);
    }
    return { pushed, skipped, errors };
}

async function pushAllChatsForCurrentCharacter() {
    const c = ctx();
    // characterId may be string index
    const id = c.characterId ?? c.this_chid;
    const char = (id != null && c.characters) ? c.characters[id] : null;
    if (!char?.avatar) {
        logLine('chats character: нет выбранного персонажа — открой карточку в ST');
        return { pushed: 0, skipped: 0, errors: 1 };
    }
    logLine(`chats character: ${char.name || char.avatar}`);
    return pushChatsForCharacter(char);
}

/**
 * All chats for every character (can take a long time).
 */
async function pushAllChatsForAllCharacters() {
    const c = ctx();
    const chars = (c.characters || []).filter(ch => ch?.avatar);
    let pushed = 0, skipped = 0, errors = 0;
    logLine(`chats all: ${chars.length} characters…`);
    for (let i = 0; i < chars.length; i++) {
        if (isPushAborted()) break;
        const char = chars[i];
        setStatus(`Персонаж ${i + 1}/${chars.length}: ${char.name || char.avatar}…`, 'busy');
        try {
            const r = await pushChatsForCharacter(char, {
                progressLabel: `${i + 1}/${chars.length} ${char.name || char.avatar}`,
            });
            pushed += r.pushed || 0;
            skipped += r.skipped || 0;
            errors += r.errors || 0;
            // Always log per-character so bulk progress is visible
            logLine(`chats · ${char.name || char.avatar}: +${r.pushed} skip ${r.skipped} err ${r.errors}`);
        } catch (e) {
            if (e?.message === 'Отменено') throw e;
            errors++;
            logLine(`chats char ${char.name}: ${e.message}`);
        }
        await yieldToUI(16);
    }
    return { pushed, skipped, errors };
}

/**
 * Resolve which chats to push from settings (or explicit override).
 * @param {'current'|'character'|'all'|null} override
 */
async function pushChatsByMode(override = null) {
    const mode = override || chatPushMode();
    if (mode === 'all') return pushAllChatsForAllCharacters();
    if (mode === 'character') return pushAllChatsForCurrentCharacter();
    // current
    const r = await pushCurrentChat();
    return {
        pushed: r?.skipped ? 0 : 1,
        skipped: r?.skipped ? 1 : 0,
        errors: 0,
        current: r,
    };
}

// ─── ST settings helpers ──────────────────────────────────────────────────

/** Full ST settings (includes power_user). */
async function fetchSTSettings() {
    try {
        const res = await stFetch('/api/settings/get', null, { method: 'GET' });
        // some ST builds only accept POST
        if (!res.ok) {
            const res2 = await stFetch('/api/settings/get', {});
            if (res2.ok) return await res2.json();
            return null;
        }
        return await res.json();
    } catch (e) {
        logLine(`settings/get: ${e.message}`);
    }
    return null;
}

async function getPowerUser() {
    const c = ctx();
    if (c.powerUser && typeof c.powerUser === 'object') return c.powerUser;
    if (c.power_user && typeof c.power_user === 'object') return c.power_user;
    // Live module (ST loads power-user.js)
    try {
        const mod = await import(/* webpackIgnore: true */ '/scripts/power-user.js');
        if (mod?.power_user) return mod.power_user;
    } catch (_) { /* ignore */ }
    const settings = await fetchSTSettings();
    return settings?.power_user || settings?.powerUser || {};
}

// ─── Personas ─────────────────────────────────────────────────────────────

/**
 * Collect ST user personas.
 * ST: power_user.personas (name→avatar file) + persona_descriptions (avatar→{description}).
 */
async function collectSTPersonas() {
    const c = ctx();
    const power = await getPowerUser();
    /** @type {Array<{name:string, description:string, avatar?:string}>} */
    const out = [];
    const seen = new Set();

    const add = (name, description, avatar) => {
        const key = `${avatar || ''}|${name || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            name: String(name || avatar || 'Persona'),
            description: String(description || ''),
            avatar: avatar || undefined,
        });
    };

    const personasMap = power.personas || {};
    const descriptions = power.persona_descriptions || power.personaDescriptions || {};
    const isImg = (s) => typeof s === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(s);

    const descFor = (avatar, nameKey) => {
        const descObj = descriptions[avatar] || descriptions[nameKey] || {};
        if (typeof descObj === 'string') return descObj;
        return descObj?.description || descObj?.prompt || power.persona_description || '';
    };

    logLine(`personas debug: keys=${Object.keys(personasMap).length} descs=${Object.keys(descriptions).length} has_default_desc=${!!power.persona_description}`);

    // ST native: power_user.personas maps avatarFile → displayName
    // Also seen: displayName → avatarFile
    for (const [key, val] of Object.entries(personasMap)) {
        if (isImg(key) && typeof val === 'string' && !isImg(val)) {
            // avatar → name
            add(val || key, descFor(key, val), key);
            continue;
        }
        if (typeof val === 'string' && isImg(val)) {
            // name → avatar
            add(key, descFor(val, key), val);
            continue;
        }
        if (typeof val === 'string') {
            // ambiguous: prefer key as name
            add(key, val, isImg(key) ? key : undefined);
            continue;
        }
        if (val && typeof val === 'object') {
            const avatar = val.avatar || (isImg(key) ? key : undefined);
            add(val.name || key, val.description || val.prompt || descFor(avatar, key), avatar);
        }
    }

    for (const [key, descObj] of Object.entries(descriptions)) {
        if (out.some(p => p.avatar === key || p.name === key)) continue;
        const description = typeof descObj === 'string'
            ? descObj
            : (descObj?.description || descObj?.prompt || '');
        if (!description && !key) continue;
        // key is almost always avatar filename in ST
        const display = isImg(key)
            ? (typeof personasMap[key] === 'string' && !isImg(personasMap[key]) ? personasMap[key] : key.replace(/\.(png|jpe?g|webp|gif)$/i, ''))
            : key;
        add(display, description, isImg(key) ? key : undefined);
    }

    // Default persona text only
    if (!out.length && power.persona_description) {
        add(power.user_name || c.name1 || 'User', power.persona_description, power.user_avatar);
    }

    // Fallback: list avatar files from User Avatars API if any
    if (!out.length) {
        try {
            const res = await fetch('/api/avatars/get', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            if (res.ok) {
                const list = await res.json();
                const arr = Array.isArray(list) ? list : (list.avatars || []);
                for (const f of arr.slice(0, 50)) {
                    const name = typeof f === 'string' ? f : (f.name || f.filename);
                    if (name) add(String(name).replace(/\.(png|jpe?g|webp)$/i, ''), '', name);
                }
            }
        } catch (_) { /* ignore */ }
    }

    return out;
}

async function pushPersonas() {
    let list = await collectSTPersonas();
    logLine(`personas found in ST: ${list.length}`);
    if (!list.length) {
        logLine('personas: в ST не найдено (Persona Management пуст или другой формат)');
        return { pushed: 0, skipped: 0, empty: true };
    }

    let n = 0, skipped = 0, errors = 0;
    for (const p of list) {
        const name = (p.name && !/\.(png|jpe?g|webp|gif)$/i.test(p.name)) ? p.name : (p.name || 'Persona');
        const description = p.description || '';
        // v2: forces re-upload after persona name mapping fix
        const clientKey = `persona:v2:${p.avatar || name}`;
        // Full ST-shaped payload for lossless round-trip
        const stPersona = {
            name,
            description,
            avatar: p.avatar || '',
            // ST persona_descriptions fields (best-effort)
            position: 0,
            depth: 4,
            role: 0,
            format: 'native',
        };
        const hash = await sha256Hex('v2|' + JSON.stringify(stPersona));
        if (mapGet(clientKey)?.content_hash === hash) {
            skipped++;
            logLine(`persona skip (unchanged): ${name}`);
            continue;
        }
        try {
            const payload = JSON.stringify(stPersona, null, 0);
            const { bytes, gzipped } = await maybeGzip(payload);
            const safe = String(name).replace(/[^\w\-а-яА-ЯёЁ]+/gi, '_').slice(0, 60) || 'persona';
            const fd = new FormData();
            fd.append('file', new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/json' }),
                `${safe}.json${gzipped ? '.gz' : ''}`);
            fd.append('client_key', clientKey);
            fd.append('kind', 'persona_json');
            fd.append('name', name);
            fd.append('content_hash', hash);
            const blobRes = await apiFetch('/api/v2/st-sync/blobs', { method: 'POST', formData: fd });
            if (blobRes?.id) await mapSet(clientKey, blobRes.id, hash);

            // Dashboard row (plain text description — not a character card)
            // Use create endpoint when possible to avoid card parser mangling
            try {
                await apiFetch('/api/v2/personas/create', {
                    method: 'POST',
                    body: { name, description, avatar_url: p.avatar || '' },
                });
            } catch (_) {
                // fallback import
                const card = {
                    name,
                    description,
                    personality: '',
                    scenario: '',
                    first_mes: '',
                    mes_example: '',
                    data: { name, description },
                };
                const fd2 = new FormData();
                fd2.append('file', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${safe}.json`);
                fd2.append('client_key', `platform:${clientKey}`);
                fd2.append('content_hash', hash);
                fd2.append('name', name);
                fd2.append('description', description);
                await apiFetch('/api/v2/personas/import', { method: 'POST', formData: fd2 });
            }

            if (blobRes?.skipped) skipped++;
            else n++;
            logLine(`persona OK: ${name} (desc ${description.length} chars, avatar=${p.avatar || '—'})`);
        } catch (e) {
            errors++;
            logLine(`persona ${name}: ${e.message}`);
        }
    }
    return { pushed: n, skipped, errors };
}

// ─── Lorebooks ────────────────────────────────────────────────────────────

async function listSTWorldInfoNames() {
    const c = ctx();
    let names = [];

    // 1) ST 1.18 getContext().getWorldInfoNames() — preferred public API
    try {
        if (typeof c.getWorldInfoNames === 'function') {
            const fromApi = c.getWorldInfoNames();
            if (Array.isArray(fromApi) && fromApi.length) names = fromApi.slice();
        }
    } catch (_) { /* ignore */ }

    // 2) Context / globals
    if (!names.length) {
        try {
            const fromCtx = c.worldInfoSettings?.world_names
                || c.world_names
                || c.worldInfoNames
                || (typeof world_names !== 'undefined' ? world_names : null);
            if (Array.isArray(fromCtx)) names = fromCtx.slice();
        } catch (_) { /* ignore */ }
    }

    // 3) Module import (fallback)
    if (!names.length) {
        try {
            const mod = await import(/* webpackIgnore: true */ '/scripts/world-info.js');
            if (Array.isArray(mod?.world_names)) names = mod.world_names.slice();
            else if (typeof mod?.getWorldInfoSettings === 'function') {
                const wi = mod.getWorldInfoSettings();
                if (Array.isArray(wi?.world_names)) names = wi.world_names.slice();
            }
        } catch (e) {
            logLine(`world-info module: ${e.message}`);
        }
    }

    // 3) Settings blob
    if (!names.length) {
        const settings = await fetchSTSettings();
        const cand = settings?.world_info?.world_names
            || settings?.world_names
            || settings?.power_user?.world_names;
        if (Array.isArray(cand)) names = cand.slice();
    }

    // 4) HTTP endpoints used by various ST builds
    if (!names.length) {
        for (const [url, body] of [
            ['/api/worldinfo/get', {}],
            ['/api/worldinfo', {}],
            ['/api/worldinfo/list', {}],
            ['/api/files/list', { folder: 'worlds', path: 'worlds' }],
            ['/api/data/list', { type: 'world' }],
        ]) {
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) continue;
                const data = await res.json();
                let arr = null;
                if (Array.isArray(data)) arr = data;
                else if (Array.isArray(data?.list)) arr = data.list;
                else if (Array.isArray(data?.world_names)) arr = data.world_names;
                else if (Array.isArray(data?.files)) arr = data.files;
                if (arr?.length) {
                    names = arr.map(x => {
                        if (typeof x === 'string') return x.replace(/\.json$/i, '');
                        return x.name || x.filename || x.file_name || '';
                    }).filter(Boolean);
                    if (names.length) {
                        logLine(`lore list via ${url}: ${names.length}`);
                        break;
                    }
                }
            } catch (_) { /* next */ }
        }
    }

    // 5) Currently selected books
    if (!names.length) {
        const selected = c.worldInfoSettings?.world_info?.globalSelect
            || c.selected_world
            || c.worldInfoData?.name
            || null;
        if (selected) names = Array.isArray(selected) ? selected : [selected];
    }

    // 6) Open book in UI memory
    if (!names.length && c.worldInfoData && (c.worldInfoData.entries || c.worldInfoData.name)) {
        names = [c.worldInfoData.name || 'current_world'];
    }

    return [...new Set(names.filter(Boolean).map(n => String(n).replace(/\.json$/i, '')))];
}

async function loadSTWorldInfo(name) {
    const c = ctx();
    if (typeof c.loadWorldInfo === 'function') {
        try {
            const book = await c.loadWorldInfo(name);
            if (book) return book;
        } catch (_) { /* fallthrough */ }
    }
    try {
        const mod = await import(/* webpackIgnore: true */ '/scripts/world-info.js');
        if (typeof mod?.loadWorldInfo === 'function') {
            const book = await mod.loadWorldInfo(name);
            if (book) return book;
        }
    } catch (_) { /* ignore */ }

    for (const body of [
        { name },
        { worldInfoName: name },
        { file: name },
        { file_name: name },
        { filename: `${name}.json` },
    ]) {
        try {
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                const book = await res.json();
                if (book && typeof book === 'object' && (book.entries || book.name || Object.keys(book).length > 2)) {
                    return book;
                }
            }
        } catch (_) { /* next */ }
    }
    return null;
}

async function pushLorebooks() {
    const names = await listSTWorldInfoNames();
    logLine(`lorebooks found in ST: ${names.length}${names.length ? ' · ' + names.slice(0, 5).join(', ') : ''}`);
    if (!names.length) {
        logLine('lorebooks: в ST не найдено World Info (создай/открой лорбук)');
        return { pushed: 0, skipped: 0, empty: true };
    }

    let n = 0, skipped = 0, errors = 0;
    for (const name of names) {
        try {
            const book = await loadSTWorldInfo(name);
            if (!book) {
                logLine(`lorebook skip (load failed): ${name}`);
                errors++;
                continue;
            }
            if (!book.name) book.name = name;
            // Keep full raw ST book for lossless blob
            const payload = JSON.stringify(book);
            // v2: after disable→enabled parser fix
            const clientKey = `lorebook:v2:${name}`;
            const hash = await sha256Hex('v2|' + payload);
            if (mapGet(clientKey)?.content_hash === hash) {
                skipped++;
                continue;
            }
            // Lossless blob
            const { bytes, gzipped } = await maybeGzip(payload);
            const fd = new FormData();
            fd.append('file', new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/json' }),
                `${String(name).replace(/[^\w\-]+/g, '_')}.json${gzipped ? '.gz' : ''}`);
            fd.append('client_key', clientKey);
            fd.append('kind', 'lorebook_json');
            fd.append('name', name);
            fd.append('content_hash', hash);
            const blobRes = await apiFetch('/api/v2/st-sync/blobs', { method: 'POST', formData: fd });
            if (blobRes?.id) await mapSet(clientKey, blobRes.id, hash);

            // Dashboard dual-write is best-effort (large books can fail CORS/timeout — blob is source of truth)
            try {
                const fd2 = new FormData();
                fd2.append('file', new Blob([payload], { type: 'application/json' }), `${name}.json`);
                fd2.append('client_key', `platform:${clientKey}`);
                fd2.append('content_hash', hash);
                await apiFetch('/api/v2/lorebooks/import', { method: 'POST', formData: fd2 });
            } catch (e) {
                logLine(`lorebook dashboard preview skip (${name}): ${e.message}`);
            }

            if (blobRes?.skipped) skipped++;
            else n++;
            const ent = book.entries ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries).length) : 0;
            logLine(`lorebook OK: ${name} (entries≈${ent}, blob #${blobRes?.id ?? '—'}, ${payload.length}b)`);
        } catch (e) {
            errors++;
            logLine(`lorebook ${name}: ${e.message}`);
        }
    }
    return { pushed: n, skipped, errors };
}

// ─── Presets ──────────────────────────────────────────────────────────────

async function pushPresets() {
    const c = ctx();
    let n = 0, skipped = 0, errors = 0;
    try {
        const pm = typeof c.getPresetManager === 'function' ? c.getPresetManager() : null;
        if (!pm) {
            logLine('presets: getPresetManager() недоступен (открой Chat Completion API)');
            return { pushed: 0, skipped: 0, empty: true };
        }

        let names = [];
        if (typeof pm.getAllPresets === 'function') {
            const all = pm.getAllPresets() || [];
            names = all.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
        }
        const current = pm.getSelectedPresetName?.() || pm.getPresetName?.();
        if (current && !names.includes(current)) names.push(current);
        // Some ST versions expose oai_settings.preset_settings_names
        try {
            const oai = c.oai_settings || c.openai_setting_names;
            if (Array.isArray(oai)) {
                for (const x of oai) if (x && !names.includes(x)) names.push(x);
            }
        } catch (_) { /* ignore */ }

        logLine(`presets found in ST: ${names.length}${names.length ? ' · ' + names.slice(0, 8).join(', ') : ''}`);
        if (!names.length) {
            logLine('presets: список пуст');
            return { pushed: 0, skipped: 0, empty: true };
        }

        for (const name of names) {
            if (!name) continue;
            try {
                let data = null;
                // Prefer full named preset objects; avoid empty Default stubs
                if (typeof pm.getCompletionPresetByName === 'function') {
                    data = pm.getCompletionPresetByName(name);
                }
                if (!data && typeof pm.getPresetSettings === 'function') {
                    data = pm.getPresetSettings(name);
                }
                if (!data && typeof pm.getPreset === 'function') {
                    data = pm.getPreset(name);
                }
                // oai_settings may hold the active preset fields only
                if ((!data || Object.keys(data).length < 3) && name !== 'Default') {
                    try {
                        const settings = await fetchSTSettings();
                        const oai = settings?.oai_settings || settings?.openai_settings;
                        if (oai && typeof oai === 'object' && (oai.preset_settings_openai === name || oai.preset_settings === name)) {
                            data = { ...oai, name };
                        }
                    } catch (_) { /* ignore */ }
                }
                if (!data || typeof data !== 'object') {
                    logLine(`preset skip (no data): ${name}`);
                    continue;
                }
                const keys = Object.keys(data);
                if (keys.length <= 2 && name === 'Default') {
                    logLine(`preset skip (empty Default stub, keys=${keys.join(',')})`);
                    continue;
                }
                const payloadObj = { ...data, name: data.name || name };
                const payload = JSON.stringify(payloadObj);
                logLine(`preset data: ${name} keys=${Object.keys(payloadObj).length} bytes=${payload.length}`);
                const clientKey = `preset:v2:${name}`;
                const hash = await sha256Hex('v2|' + payload);
                if (mapGet(clientKey)?.content_hash === hash) {
                    skipped++;
                    continue;
                }
                // Blob lossless
                const { bytes, gzipped } = await maybeGzip(payload);
                const fd = new FormData();
                fd.append('file', new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/json' }),
                    `${String(name).replace(/[^\w\-]+/g, '_')}.json${gzipped ? '.gz' : ''}`);
                fd.append('client_key', clientKey);
                fd.append('kind', 'preset_json');
                fd.append('name', name);
                fd.append('content_hash', hash);
                const blobRes = await apiFetch('/api/v2/st-sync/blobs', { method: 'POST', formData: fd });
                if (blobRes?.id) await mapSet(clientKey, blobRes.id, hash);

                const q = new URLSearchParams({ client_key: `platform:${clientKey}`, content_hash: hash });
                await apiFetch(`/api/v2/presets/import?${q}`, { method: 'POST', body: payloadObj });

                if (blobRes?.skipped) skipped++;
                else n++;
                logLine(`preset OK: ${name}`);
            } catch (e) {
                errors++;
                logLine(`preset ${name}: ${e.message}`);
            }
        }
    } catch (e) {
        logLine(`presets: ${e.message}`);
        errors++;
    }
    return { pushed: n, skipped, errors };
}

// ─── Pull (download into ST) ──────────────────────────────────────────────

async function importCharacterCardFromCloud(char) {
    // Match ST public/script.js importCharacter: FormData avatar + file_type + CSRF.
    // Without X-CSRF-Token and file_type ST returns 403 / 400.
    const card = {
        name: char.name,
        description: char.description || '',
        personality: char.personality || '',
        scenario: char.scenario || '',
        first_mes: char.first_message || '',
        mes_example: char.mes_example || '',
        creatorcomment: char.creator_notes || '',
        system_prompt: char.system_prompt || '',
        post_history_instructions: char.post_history_instructions || '',
        tags: char.tags || [],
        creator_notes: char.creator_notes || '',
        alternate_greetings: char.alternate_greetings || [],
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: char.name,
            description: char.description || '',
            personality: char.personality || '',
            scenario: char.scenario || '',
            first_mes: char.first_message || '',
            mes_example: char.mes_example || '',
            creator_notes: char.creator_notes || '',
            system_prompt: char.system_prompt || '',
            post_history_instructions: char.post_history_instructions || '',
            tags: char.tags || [],
            alternate_greetings: char.alternate_greetings || [],
        },
    };
    const safeName = String(char.name || 'card').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'card';
    const file = new File([JSON.stringify(card)], `${safeName}.json`, { type: 'application/json' });
    const c = ctx();
    const fd = new FormData();
    fd.append('avatar', file);
    fd.append('file_type', 'json');
    fd.append('user_name', c.name1 || 'User');

    const res = await stFetch('/api/characters/import', fd);
    if (!res.ok) {
        const hint = await res.text().catch(() => '');
        throw new Error(`ST import failed ${res.status}${hint ? `: ${hint.slice(0, 120)}` : ''} (csrf/file_type?)`);
    }
    const data = await res.json().catch(() => ({}));
    if (data?.error) throw new Error(`ST import error: ${data.error}`);
    return data;
}

async function fetchBlobText(id) {
    const key = apiKey();
    const res = await fetch(`${baseUrl()}/api/v2/st-sync/blobs/get?id=${id}`, {
        headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`blob get ${res.status}`);
    return res.text();
}

function downloadJsonFile(name, obj) {
    const blob = new Blob([typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String(name || 'export').replace(/[^\w\-а-яА-ЯёЁ]+/gi, '_').slice(0, 60)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/**
 * Save a chat jsonl into ST for a character avatar.
 * Tries common ST endpoints; falls back to browser download.
 */
async function importChatJsonlToST(charAvatar, fileName, jsonlText, characterName = 'Character') {
    const baseName = String(fileName).replace(/\.jsonl$/i, '');
    const c = ctx();
    // ST importCharacterChat: FormData avatar file + avatar_url + file_type + CSRF
    const fd = new FormData();
    fd.append('avatar', new File([jsonlText], `${baseName}.jsonl`, { type: 'application/jsonl' }));
    fd.append('file_type', 'jsonl');
    fd.append('avatar_url', charAvatar);
    fd.append('character_name', characterName || 'Character');
    fd.append('user_name', c.name1 || 'User');
    try {
        const res = await stFetch('/api/chats/import', fd);
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            if (data?.res || data?.fileNames) return { ok: true, via: '/api/chats/import' };
            if (!data?.error) return { ok: true, via: '/api/chats/import' };
        }
    } catch (_) { /* fallback download */ }
    // Fallback: trigger download for user to place manually
    const blob = new Blob([jsonlText], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: false, via: 'download' };
}

async function importLorebookToST(full) {
    const name = full.name || full.Name || 'imported_lore';
    // Prefer multipart (ST worldinfo import often expects a file + CSRF)
    try {
        const fd = new FormData();
        fd.append('avatar', new File([JSON.stringify(full)], `${name}.json`, { type: 'application/json' }));
        fd.append('file_type', 'json');
        let res = await stFetch('/api/worldinfo/import', fd);
        if (res.ok) return { ok: true, via: '/api/worldinfo/import' };
        res = await stFetch('/api/worldinfo/import', full);
        if (res.ok) return { ok: true, via: '/api/worldinfo/import#json' };
    } catch (_) { /* next */ }
    return { ok: false };
}

async function importPresetToST(preset) {
    const raw = preset.raw_data || preset;
    const name = preset.name || raw.name || 'imported_preset';
    try {
        const res = await stFetch('/api/presets/save', {
            name,
            apiId: raw.apiId || raw.api_id || 'openai',
            preset: raw,
        });
        if (res.ok) return { ok: true };
        const res2 = await stFetch('/api/settings/import', raw);
        if (res2.ok) return { ok: true };
    } catch (_) { /* ignore */ }
    // Download fallback
    const blob = new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String(name).replace(/[^\w\-]+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: false, via: 'download' };
}

async function syncPull({ importCharacters = true } = {}) {
    // Phase 2: packs-first. Component dual-model pull is legacy/dead (410 platform).
    return pullPackFromCloud();
}

/** @deprecated Phase 1 component pull — kept for reference, not wired. */
async function syncPullLegacyComponents({ importCharacters = true } = {}) {
    if (!assertExternalBridge('Pull')) return;
    setStatus('Pull: загрузка…', 'busy');
    await loadMap();
    const s = getSettings();
    try {
        const [chars, personas, lore, presets, blobs, quotas] = await Promise.all([
            apiFetch('/api/v2/characters').catch(() => ({ characters: [] })),
            apiFetch('/api/v2/personas').catch(() => ({ personas: [] })),
            apiFetch('/api/v2/lorebooks').catch(() => ({ lorebooks: [] })),
            apiFetch('/api/v2/presets').catch(() => ({ presets: [] })),
            apiFetch('/api/v2/st-sync/blobs?kind=chat_jsonl').catch(() => ({ items: [] })),
            apiFetch('/api/v2/user/quotas').catch(() => null),
        ]);

        const cloudChars = (chars.characters || []).filter(c => c.creator_id);
        const chatBlobs = blobs.items || [];
        const summary = [
            `chars ${cloudChars.length}`,
            `chat-blobs ${chatBlobs.length}`,
            `personas ${(personas.personas || []).length}`,
            `lore ${(lore.lorebooks || []).length}`,
            `presets ${(presets.presets || []).length}`,
        ].join(' · ');
        logLine(`cloud: ${summary}`);
        if (quotas?.usage) {
            logLine(`quota chats ${quotas.usage.chats || 0}/${quotas.limits?.chats ?? '∞'}`);
        }

        let imported = 0, failed = 0, downloads = 0;
        const c = ctx();

        // Characters
        if (importCharacters && s.sync_characters !== false && cloudChars.length) {
            const existingNames = new Set((c.characters || []).map(x => (x.name || '').toLowerCase()));
            for (const ch of cloudChars) {
                if (existingNames.has((ch.name || '').toLowerCase())) continue;
                try {
                    setStatus(`Pull char: ${ch.name}…`, 'busy');
                    await importCharacterCardFromCloud(ch);
                    imported++;
                } catch (e) {
                    failed++;
                    logLine(`char ${ch.name}: ${e.message}`);
                }
            }
            try {
                if (typeof c.getCharacters === 'function') await c.getCharacters();
                else if (typeof getCharacters === 'function') await getCharacters();
            } catch (_) { /* ignore */ }
        }

        // Chat blobs → ST: prefer avatar from client_key (chat:avatar:filename),
        // else selected character. Without a matching local char → download fallback.
        if (s.sync_chats && chatBlobs.length) {
            const selected = c.characters?.[c.characterId];
            const byAvatar = new Map((c.characters || []).map(ch => [String(ch.avatar || '').toLowerCase(), ch]));
            for (const item of chatBlobs) {
                try {
                    setStatus(`Pull chat: ${item.name}…`, 'busy');
                    const text = await fetchBlobText(item.id);
                    // client_key often chat:avatar:filename
                    let fileName = item.name || `chat_${item.id}`;
                    let keyAvatar = '';
                    const parts = String(item.client_key || '').split(':');
                    if (parts[0] === 'chat' && parts.length >= 3) {
                        keyAvatar = parts[1];
                        fileName = parts.slice(2).join(':');
                    }
                    const local = (keyAvatar && byAvatar.get(keyAvatar.toLowerCase()))
                        || (selected?.avatar ? selected : null);
                    if (!local?.avatar) {
                        downloads++;
                        logLine(`chat ${fileName}: нет персонажа в ST (key avatar=${keyAvatar || '?'}) — скачай JSONL вручную после импорта char`);
                        // still offer browser download
                        await importChatJsonlToST(keyAvatar || 'unknown.png', fileName, text, item.name || 'Character');
                        continue;
                    }
                    const r = await importChatJsonlToST(local.avatar, fileName, text, local.name || 'Character');
                    if (r.ok) imported++;
                    else { downloads++; logLine(`chat ${fileName}: saved as download`); }
                    await mapSet(item.client_key, item.id, item.content_hash);
                } catch (e) {
                    failed++;
                    logLine(`chat blob ${item.id}: ${e.message}`);
                }
            }
        }

        // Prefer lossless blobs for lore / persona / preset when present
        const allBlobs = await apiFetch('/api/v2/st-sync/blobs').catch(() => ({ items: [] }));
        const byKind = (k) => (allBlobs.items || []).filter(i => i.kind === k);

        if (s.sync_lorebooks) {
            const loreBlobs = byKind('lorebook_json');
            if (loreBlobs.length) {
                for (const item of loreBlobs) {
                    try {
                        setStatus(`Pull lore blob: ${item.name}…`, 'busy');
                        const text = await fetchBlobText(item.id);
                        const full = JSON.parse(text);
                        const r = await importLorebookToST(full);
                        if (r.ok) imported++;
                        else {
                            downloads++;
                            downloadJsonFile(item.name || 'lore', full);
                        }
                    } catch (e) {
                        failed++;
                        logLine(`lore blob ${item.name}: ${e.message}`);
                    }
                }
            } else if ((lore.lorebooks || []).length) {
                for (const lb of lore.lorebooks) {
                    try {
                        setStatus(`Pull lore: ${lb.name}…`, 'busy');
                        const full = await apiFetch(`/api/v2/lorebooks/export?id=${lb.id}`);
                        const r = await importLorebookToST(full);
                        if (r.ok) imported++;
                        else {
                            downloads++;
                            downloadJsonFile(lb.name || 'lore', full);
                        }
                    } catch (e) {
                        failed++;
                        logLine(`lore ${lb.name}: ${e.message}`);
                    }
                }
            }
        }

        if (s.sync_personas) {
            const personaBlobs = byKind('persona_json');
            for (const item of personaBlobs) {
                try {
                    setStatus(`Pull persona blob: ${item.name}…`, 'busy');
                    const text = await fetchBlobText(item.id);
                    const full = JSON.parse(text);
                    downloadJsonFile(item.name || 'persona', full);
                    downloads++;
                    logLine(`persona ${item.name}: скачан JSON (импорт в ST Persona — вручную / следующий релиз)`);
                } catch (e) {
                    failed++;
                    logLine(`persona blob ${item.name}: ${e.message}`);
                }
            }
        }

        if (s.sync_presets) {
            const presetBlobs = byKind('preset_json');
            if (presetBlobs.length) {
                for (const item of presetBlobs) {
                    try {
                        setStatus(`Pull preset blob: ${item.name}…`, 'busy');
                        const text = await fetchBlobText(item.id);
                        const full = JSON.parse(text);
                        const r = await importPresetToST(full);
                        if (r.ok) imported++;
                        else {
                            downloads++;
                            downloadJsonFile(item.name || 'preset', full);
                        }
                    } catch (e) {
                        failed++;
                        logLine(`preset blob ${item.name}: ${e.message}`);
                    }
                }
            } else if ((presets.presets || []).length) {
                for (const pr of presets.presets) {
                    try {
                        setStatus(`Pull preset: ${pr.name}…`, 'busy');
                        const full = await apiFetch(`/api/v2/presets/export?id=${pr.id}`).catch(() => pr);
                        const r = await importPresetToST(full?.raw_data ? { ...full.raw_data, name: full.name } : full);
                        if (r.ok) imported++;
                        else downloads++;
                    } catch (e) {
                        failed++;
                        logLine(`preset ${pr.name}: ${e.message}`);
                    }
                }
            }
        }

        const msg = `${summary} · in-ST ${imported} · download ${downloads} · fail ${failed}`;
        setStatus(msg, failed ? 'err' : 'ok');
        toast(failed ? 'warning' : 'success', msg);
    } catch (e) {
        setStatus(`Pull error: ${e.message}`, 'err');
        toast('error', e.message);
    }
}

// ─── Orchestration ────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {boolean} [opts.onlyCurrentChat] force single open chat
 * @param {'current'|'character'|'all'|null} [opts.chatMode] override settings chat_push_mode
 * @param {boolean} [opts.chatsOnly] only push chats (bulk buttons); skip cards/personas/…
 */
async function syncPush({ onlyCurrentChat = false, chatMode = null, chatsOnly = false } = {}) {
    // Phase 2: packs-first. Component dual-model push is not the product path.
    void onlyCurrentChat; void chatMode; void chatsOnly;
    return pushPackToCloud();
}

/** @deprecated Phase 1 component push — not wired in UI. */
async function syncPushLegacyComponents({ onlyCurrentChat = false, chatMode = null, chatsOnly = false } = {}) {
    if (!assertExternalBridge('Push')) return;
    if (pushInFlight) {
        setStatus('Уже идёт синхронизация…', 'busy');
        return;
    }
    pushInFlight = true;
    pushAbort = new AbortController();
    setStopButtonVisible(true);
    await loadMap();
    setStatus('Синхронизация…', 'busy');
    const s = getSettings();
    const stats = { characters: 0, chats: 0, personas: 0, lorebooks: 0, presets: 0, skipped: 0, errors: 0 };
    const mode = onlyCurrentChat ? 'current' : (chatMode || chatPushMode());
    logLine(`push flags: char=${!!s.sync_characters && !chatsOnly} chat=${!!s.sync_chats || chatsOnly || onlyCurrentChat} mode=${mode} chatsOnly=${!!chatsOnly} persona=${!!s.sync_personas && !chatsOnly} lore=${!!s.sync_lorebooks && !chatsOnly} preset=${!!s.sync_presets && !chatsOnly} gzip=${!!s.use_gzip} dual=${!!s.dual_write_platform}`);

    try {
        if (onlyCurrentChat) {
            try {
                const r = await pushCurrentChat();
                if (r?.skipped) stats.skipped++;
                else stats.chats++;
                const cid = r?.id ?? r?.chat_id ?? r?.blob_id;
                logLine(r?.skipped ? `chat skip: ${r.reason || 'ok'}` : `chat → #${cid} (${r?.encoding || 'ok'})`);
            } catch (e) {
                stats.errors++;
                logLine(`chat error: ${e.message}`);
            }
            await flushMap(true);
            const ok = !stats.errors;
            setStatus(ok ? 'Текущий чат синхронизирован' : 'Ошибка чата (лог)', ok ? 'ok' : 'err');
            if (ok) toast('success', 'Чат сохранён в облако');
            return;
        }

        // Always push chats for bulk buttons; otherwise respect checkbox
        if (s.sync_chats || chatsOnly) {
            try {
                const r = await pushChatsByMode(mode);
                stats.chats += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
                if (mode === 'current' && r.current) {
                    const cid = r.current?.id ?? r.current?.chat_id ?? r.current?.blob_id;
                    logLine(r.current?.skipped
                        ? `chat skip: ${r.current.reason || 'ok'}`
                        : `chat → #${cid} (${r.current?.encoding || 'ok'})`);
                } else {
                    logLine(`chats [${mode}]: +${r.pushed || 0} skip ${r.skipped || 0} err ${r.errors || 0}`);
                }
            } catch (e) {
                if (e?.message === 'Отменено') {
                    logLine('chats: отменено пользователем');
                    stats.errors++;
                } else {
                    stats.errors++;
                    logLine(`chat: ${e.message}`);
                }
            }
        }

        if (!chatsOnly && s.sync_characters && !isPushAborted()) {
            const c = ctx();
            const list = c.characters || [];
            for (let i = 0; i < list.length; i++) {
                if (isPushAborted()) break;
                const char = list[i];
                try {
                    setStatus(`Персонаж ${i + 1}/${list.length}: ${char.name || char.avatar}…`, 'busy');
                    const r = await pushCharacter(char);
                    if (r?.skipped) stats.skipped++;
                    else stats.characters++;
                } catch (e) {
                    if (e?.message === 'Отменено') break;
                    stats.errors++;
                    logLine(`char ${char?.name}: ${e.message}`);
                }
                await yieldToUI(i % 4 === 0 ? 8 : 0);
            }
        }

        if (!chatsOnly && s.sync_personas && !isPushAborted()) {
            try {
                const r = await pushPersonas();
                stats.personas += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`personas: ${e.message}`);
            }
        } else if (!chatsOnly && !s.sync_personas) {
            logLine('personas: выкл в настройках мода (галочка)');
        }

        if (!chatsOnly && s.sync_lorebooks && !isPushAborted()) {
            try {
                const r = await pushLorebooks();
                stats.lorebooks += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`lorebooks: ${e.message}`);
            }
        } else if (!chatsOnly && !s.sync_lorebooks) {
            logLine('lorebooks: выкл в настройках мода (галочка)');
        }

        if (!chatsOnly && s.sync_presets && !isPushAborted()) {
            try {
                const r = await pushPresets();
                stats.presets += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`presets: ${e.message}`);
            }
        } else if (!chatsOnly && !s.sync_presets) {
            logLine('presets: выкл в настройках мода (галочка)');
        }

        await flushMap(true);
        const cancelled = isPushAborted();
        const summary = `${cancelled ? 'Остановлено' : 'Готово'} · char ${stats.characters} · chat ${stats.chats} · persona ${stats.personas} · lore ${stats.lorebooks} · preset ${stats.presets} · skip ${stats.skipped} · err ${stats.errors}`;
        setStatus(summary, stats.errors || cancelled ? 'err' : 'ok');
        toast(stats.errors || cancelled ? 'warning' : 'success', summary);
        logLine(summary);
    } catch (e) {
        setStatus(`Ошибка: ${e.message}`, 'err');
        toast('error', e.message);
        logLine(e.message);
        await flushMap(true).catch(() => {});
    } finally {
        pushInFlight = false;
        pushAbort = null;
        setStopButtonVisible(false);
    }
}

function cancelPush() {
    if (!pushInFlight || !pushAbort) {
        setStatus('Нечего останавливать', 'ok');
        return;
    }
    pushAbort.abort();
    setStatus('Останавливаю…', 'busy');
    logLine('stop: запрос отмены');
}

function setStopButtonVisible(visible) {
    const el = document.getElementById('wucloud_stop_btn');
    if (!el) return;
    el.style.display = visible ? '' : 'none';
    el.disabled = !visible;
}

// ─── Autosave ─────────────────────────────────────────────────────────────

function scheduleAutosave() {
    // Phase 2 packs: no autosave of full ST zip on every message (too heavy).
    // Nest: never cloud-write. Legacy component autosave retired.
    return;
}

function isSessionOverlayVisible() {
    try {
        return !!(typeof document !== 'undefined' && document.getElementById(SESSION_OVERLAY_ID));
    } catch (_) {
        return false;
    }
}

function fetchRequestMeta(input, init) {
    let url = '';
    let method = 'GET';
    try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
            url = input.url;
            method = input.method || 'GET';
        } else if (typeof input === 'string') {
            url = input;
        } else if (input && typeof input.url === 'string') {
            url = input.url;
        }
        if (init && init.method) method = init.method;
    } catch (_) { /* ignore */ }
    return { url, method };
}

function inspectCsrfStatus({ status, method, url, csrfHint }) {
    try {
        const origin = typeof location !== 'undefined' ? location.origin : '';
        const pathname = requestPathname(url, origin);
        if (shouldShowSessionOverlay({
            alreadyVisible: isSessionOverlayVisible(),
            status,
            sameOrigin: isSameOriginUrl(url, origin),
            pathname,
            mutating: isMutatingHttpMethod(method),
            csrfHint: !!csrfHint,
        })) {
            showSessionOverlay();
        }
    } catch (_) { /* never break ST */ }
}

async function inspectFetchCsrf(res, input, init) {
    if (!res || res.status !== 403) return;
    const { url, method } = fetchRequestMeta(input, init);
    const origin = typeof location !== 'undefined' ? location.origin : '';
    const pathname = requestPathname(url, origin);
    let csrfHint = false;
    if (!isStCsrfFailClosedPath(pathname) && !isWuGatewayPath(pathname)) {
        try {
            const text = await res.clone().text();
            csrfHint = csrfHintInBody(text.slice(0, 2000));
        } catch (_) {
            csrfHint = false;
        }
    }
    inspectCsrfStatus({ status: res.status, method, url, csrfHint });
}

function showSessionOverlay() {
    if (typeof document === 'undefined' || !document.body) return;
    if (isSessionOverlayVisible()) return;
    const root = document.createElement('div');
    root.id = SESSION_OVERLAY_ID;
    root.className = 'wucloud-session-overlay';
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'wucloud-session-overlay-title');
    root.innerHTML = '<div class="wucloud-session-overlay__card">'
        + '<p class="wucloud-session-overlay__kicker">WuNest · сессия</p>'
        + '<h2 class="wucloud-session-overlay__title" id="wucloud-session-overlay-title">Сессия таверны обновилась</h2>'
        + '<p class="wucloud-session-overlay__body">Эта вкладка держит старый ключ. Сохранение сейчас молчит. '
        + 'Обнови страницу — дом на диске подхватится заново.</p>'
        + '<button type="button" class="wucloud-session-overlay__reload" id="wucloud-session-overlay-reload">'
        + 'Обновить страницу</button>'
        + '</div>';
    document.body.appendChild(root);
    const btn = document.getElementById('wucloud-session-overlay-reload');
    if (btn) {
        btn.addEventListener('click', () => {
            btn.disabled = true;
            try { location.reload(); } catch (_) { /* ignore */ }
        });
        try { btn.focus(); } catch (_) { /* ignore */ }
    }
    logLine('session overlay: CSRF 403 — refresh required');
}

function currentDiskFingerprint() {
    const c = ctx();
    const snap = openHomeSnapshot(c);
    let lastMesLen = 0;
    let lastSend = '';
    try {
        const chat = c?.chat;
        if (Array.isArray(chat) && chat.length) {
            const last = chat[chat.length - 1];
            lastMesLen = String(last?.mes ?? '').length;
            lastSend = String(last?.send_date ?? '');
        }
    } catch (_) { /* ignore */ }
    return openHomeDiskFingerprint({
        thisChid: snap.thisChid,
        selectedGroup: snap.selectedGroup,
        chatLength: snap.chatLength,
        lastMesLen,
        lastSend,
        settingsAt: lastSettingsPersistAt,
    });
}

function showDiskToast() {
    if (typeof document === 'undefined' || !document.body) return;
    if (isSessionOverlayVisible()) return;
    let el = document.getElementById(DISK_TOAST_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = DISK_TOAST_ID;
        el.className = 'wucloud-disk-toast';
        el.setAttribute('role', 'status');
        document.body.appendChild(el);
    }
    el.textContent = 'Дом на диске';
    el.classList.add('is-on');
    if (diskToastHideTimer) clearTimeout(diskToastHideTimer);
    diskToastHideTimer = setTimeout(() => {
        el.classList.remove('is-on');
        diskToastHideTimer = 0;
    }, 2400);
}

function noteDiskFingerprint() {
    try {
        lastDiskFingerprint = currentDiskFingerprint();
    } catch (_) { /* ignore */ }
}

function maybeToastDiskAutosave(result) {
    try {
        const persistOk = !!result?.ok;
        const fp = currentDiskFingerprint();
        const show = shouldToastNestDiskAutosave({
            source: 'autosave',
            includeExtras: !!result?.includeExtras,
            overlayVisible: isSessionOverlayVisible(),
            fingerprintChanged: nestDiskFingerprintChanged(lastDiskFingerprint, fp),
            persistOk,
            lastToastAt: lastDiskToastAt,
            now: Date.now(),
        });
        if (persistOk) {
            lastDiskFingerprint = fp;
        }
        if (!show) return;
        lastDiskToastAt = Date.now();
        showDiskToast();
    } catch (_) { /* ignore */ }
}

function installSessionCsrfWatch() {
    if (typeof window === 'undefined' || window.__wucloudCsrfWatch) return;
    window.__wucloudCsrfWatch = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = function wucloudFetch(input, init) {
        return origFetch(input, init).then((res) => {
            try { void inspectFetchCsrf(res, input, init); } catch (_) { /* ignore */ }
            return res;
        });
    };
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function wucloudXhrOpen(method, url, ...rest) {
        try {
            this.__wucloudXhr = { method, url: String(url || '') };
        } catch (_) { /* ignore */ }
        return origOpen.call(this, method, url, ...rest);
    };
    proto.send = function wucloudXhrSend(...args) {
        this.addEventListener('loadend', function wucloudXhrEnd() {
            try {
                const meta = this.__wucloudXhr || {};
                const url = this.responseURL || meta.url || '';
                const method = meta.method || 'GET';
                if (this.status !== 403) return;
                const origin = location.origin;
                const pathname = requestPathname(url, origin);
                let csrfHint = false;
                if (!isStCsrfFailClosedPath(pathname) && !isWuGatewayPath(pathname)) {
                    try {
                        const raw = typeof this.responseText === 'string' ? this.responseText : '';
                        csrfHint = csrfHintInBody(raw.slice(0, 2000));
                    } catch (_) {
                        csrfHint = false;
                    }
                }
                inspectCsrfStatus({ status: this.status, method, url, csrfHint });
            } catch (_) { /* ignore */ }
        });
        return origSend.apply(this, args);
    };
}

function nestDiskAutosaveTick() {
    // Never fight a multi‑GB import for nestmgr / ST disk.
    if (nestImportRun && !nestImportRun.abort) return;
    const visible = typeof document === 'undefined'
        || document.visibilityState === 'visible';
    if (!shouldRunNestDiskAutosave({
        nestMode: isNestMode(),
        settingsHydrated,
        busy: leaveFlushInFlight,
        visible,
        isStreaming: isStreamingNow(),
        isChatSaving: !!isChatSaving,
    })) {
        return;
    }
    leaveFlushInFlight = true;
    const persistSettings = shouldAutosaveNestSettings(lastSettingsPersistAt);
    persistOpenHomeNow({ includeExtras: true, persistSettings })
        .then((result) => {
            logLine('nest disk autosave: open home → ST disk (same as Сохранить сейчас)');
            maybeToastDiskAutosave(result);
        })
        .catch((e) => {
            console.warn(LOG_PREFIX, 'nest disk autosave failed', e);
        })
        .finally(() => {
            releaseLeaveFlushMutex();
        });
}

function setupIntervalAutosave() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    if (nestDiskAutosaveKickTimer) {
        clearTimeout(nestDiskAutosaveKickTimer);
        nestDiskAutosaveKickTimer = null;
    }
    // External ST: packs stay manual Push. Nest: same work as «Сохранить сейчас».
    if (!isNestMode()) {
        return;
    }
    intervalHandle = setInterval(nestDiskAutosaveTick, NEST_DISK_AUTOSAVE_MS);
    nestDiskAutosaveKickTimer = setTimeout(nestDiskAutosaveTick, 15_000);
}

/**
 * ST importTheme() saves the file + power_user.theme name but does NOT call
 * applyTheme() — UI stays on previous colors until user re-selects.
 * Re-fire #themes change so stock ST applyTheme runs (user freedom: we only
 * apply what they already selected, never pick a theme for them).
 */
function reapplySelectedTheme(reason = '') {
    try {
        const $ = (typeof jQuery !== 'undefined') ? jQuery : null;
        if (!$) return;
        const c = ctx();
        const pu = c.powerUserSettings || c.power_user || {};
        const name = String(pu.theme || '').trim() || String($('#themes').val() || '').trim();
        if (!name) return;
        const $sel = $('#themes');
        if (!$sel.length) return;
        let val = null;
        $sel.find('option').each(function () {
            const v = String(this.value || '');
            const t = String($(this).text() || '').trim();
            if (v === name || t === name || v.includes(name) || name.includes(v)) {
                val = this.value;
                return false;
            }
        });
        if (val == null) return; // theme file not in list yet
        // Force change event even if value already selected (ST skips applyTheme otherwise)
        if ($sel.val() === val) {
            $sel.val('');
        }
        $sel.val(val);
        $sel.trigger('change');
        if (reason) logLine(`theme reapply (${reason}): ${val}`);
    } catch (e) {
        logLine(`theme reapply: ${e.message || e}`);
    }
}

/** Nest defaults: Russian UI if browser is ru* and user never chose a language. */
function ensureNestLocaleDefault() {
    if (!isNestMode()) return;
    try {
        if (localStorage.getItem('language')) return;
        const nav = String(navigator.language || navigator.userLanguage || '').toLowerCase();
        if (nav === 'ru' || nav.startsWith('ru-')) {
            localStorage.setItem('language', 'ru-ru');
            logLine('locale default → ru-ru (Nest)');
            // One reload so i18n picks it up (same as ST language select)
            if (!sessionStorage.getItem('wucloud_locale_reload')) {
                sessionStorage.setItem('wucloud_locale_reload', '1');
                location.reload();
            }
        }
    } catch (_) { /* ignore */ }
}

function chatLengthOf(c) {
    return Array.isArray(c?.chat) ? c.chat.length : 0;
}

function rememberLoadedEntity(c, loaded) {
    if (!loaded) {
        loadedThisChid = undefined;
        loadedSelectedGroup = undefined;
        return;
    }
    loadedThisChid = c.characterId ?? c.this_chid;
    loadedSelectedGroup = c.groupId ?? c.selected_group;
    lastKnownChatLength = chatLengthOf(c);
}

function isStreamingNow() {
    if (generationInFlight) {
        return true;
    }
    try {
        const c = ctx();
        const sp = c.streamingProcessor;
        if (sp && (sp.isFinished === false || sp.isRunning === true || sp.running === true)) {
            return true;
        }
    } catch (_) { /* ignore */ }
    return false;
}

function openHomeSnapshot(c) {
    return {
        thisChid: c.characterId ?? c.this_chid,
        selectedGroup: c.groupId ?? c.selected_group,
        loadedThisChid,
        loadedSelectedGroup,
        chatLoaded: chatLoadedThisSession,
        isChatSaving: !!isChatSaving,
        isStreaming: isStreamingNow(),
        menuType: c.menuType ?? c.menu_type,
        chatLength: chatLengthOf(c),
        lastKnownLength: lastKnownChatLength,
    };
}

function worldEditorSelectedName() {
    try {
        if (typeof jQuery === 'function') {
            const $sel = jQuery('#world_editor_select');
            if (!$sel.length) return '';
            return String($sel.val() ?? '').trim();
        }
        const sel = document.getElementById('world_editor_select');
        if (!sel) return '';
        return String(sel.value ?? '').trim();
    } catch (_) {
        return '';
    }
}

function extraBooksForOpenCharacter(c) {
    const lore = world_info?.charLore;
    if (!Array.isArray(lore)) return [];
    const char = c.characters?.[c.characterId];
    const avatar = char?.avatar != null ? String(char.avatar) : '';
    const fileName = avatar.replace(/\.[^/.]+$/, '');
    const out = [];
    for (const e of lore) {
        const n = String(e?.name || '');
        if (!n || (n !== fileName && n !== avatar)) continue;
        if (Array.isArray(e.extraBooks)) out.push(...e.extraBooks);
    }
    return out;
}

function collectOpenWorldNames(c) {
    const char = c.characters?.[c.characterId];
    const meta = c.chatMetadata || c.chat_metadata || {};
    return worldNamesToFlush({
        selectedWorldInfo: Array.isArray(selected_world_info) ? selected_world_info : [],
        chatWorld: meta.world_info,
        characterWorld: char?.data?.extensions?.world,
        extraBooks: extraBooksForOpenCharacter(c),
        editorWorld: worldEditorSelectedName(),
        personaWorld: c.powerUserSettings?.persona_description_lorebook,
    });
}

async function triggerCharacterCardSave() {
    try {
        if (typeof createOrEditCharacter === 'function') {
            await createOrEditCharacter();
            return true;
        }
        if (typeof jQuery === 'function') {
            jQuery('#create_button').trigger('click');
            return true;
        }
        document.getElementById('create_button')?.click();
        return true;
    } catch (e) {
        console.warn(LOG_PREFIX, 'character card save failed', e);
        return false;
    }
}

/**
 * Persist open-home state to the live ST disk.
 * includeExtras false = leave-flush (chat + settings only).
 * includeExtras true = button «Сохранить сейчас» (also metadata, group, card, lorebooks).
 * Not cloud Push, not zip, not freeze.
 */
async function persistOpenHomeNow({ includeExtras = false, persistSettings = true } = {}) {
    const c = ctx();
    const snap = openHomeSnapshot(c);
    const chatOk = shouldFlushChat(snap);
    let ok = true;

    if (chatOk) {
        try {
            await saveChatConditional();
            const n = chatLengthOf(c);
            if (n > lastKnownChatLength) {
                lastKnownChatLength = n;
            }
        } catch (e) {
            ok = false;
            console.warn(LOG_PREFIX, 'persist chat failed', e);
        }
        if (includeExtras && typeof c.saveMetadata === 'function') {
            try {
                await c.saveMetadata();
            } catch (e) {
                ok = false;
                console.warn(LOG_PREFIX, 'persist metadata failed', e);
            }
        }
    }

    if (persistSettings && settingsHydrated) {
        try {
            await saveSettings();
            lastSettingsPersistAt = Date.now();
        } catch (e) {
            ok = false;
            console.warn(LOG_PREFIX, 'persist settings failed', e);
        }
    }

    if (!includeExtras) {
        return { includeExtras: false, ok };
    }

    if (shouldSaveGroupMeta(snap)) {
        try {
            await editGroup(snap.selectedGroup, true, false);
        } catch (e) {
            ok = false;
            console.warn(LOG_PREFIX, 'persist group failed', e);
        }
    }

    if (shouldSaveCharacterCard(snap)) {
        if (!await triggerCharacterCardSave()) {
            ok = false;
        }
    }

    const editorBook = worldEditorSelectedName();
    const names = collectOpenWorldNames(c);
    for (const name of names) {
        if (editorBook && name === editorBook) {
            logLine(`save-now: skip lore editor book «${name}» (immediately=true would clobber unsaved WI edits)`);
            continue;
        }
        try {
            const load = typeof loadWorldInfo === 'function' ? loadWorldInfo : c.loadWorldInfo;
            const save = typeof saveWorldInfo === 'function' ? saveWorldInfo : c.saveWorldInfo;
            if (typeof load !== 'function' || typeof save !== 'function') {
                logLine(`save-now: no load/saveWorldInfo for «${name}»`);
                continue;
            }
            const book = await load(name);
            if (!book) {
                logLine(`save-now: lore load empty «${name}»`);
                continue;
            }
            await save(name, book, true);
        } catch (e) {
            ok = false;
            console.warn(LOG_PREFIX, `persist lore ${name} failed`, e);
            logLine(`save-now lore ${name}: ${e?.message || e}`);
        }
    }
    return { includeExtras: true, ok };
}

function releaseLeaveFlushMutex() {
    leaveFlushInFlight = false;
    if (leaveFlushPending) {
        void flushOnLeave();
    }
}

async function flushOnLeave() {
    if (nestImportRun && !nestImportRun.abort) {
        return;
    }
    const now = Date.now();
    const action = leaveFlushStartAction({
        busy: leaveFlushInFlight,
        debounceActive: (now - lastLeaveFlushAt) < 1500,
        queued: leaveFlushPending,
    });
    if (action === 'queue') {
        leaveFlushPending = true;
        return;
    }
    if (action === 'skip') {
        leaveFlushPending = false;
        return;
    }
    leaveFlushInFlight = true;
    leaveFlushPending = false;
    lastLeaveFlushAt = now;
    try {
        await persistOpenHomeNow({ includeExtras: false });
    } finally {
        releaseLeaveFlushMutex();
    }
}

async function persistOpenHomeFromButton() {
    if (leaveFlushInFlight) {
        toast('info', 'Сохранение уже идёт…');
        return;
    }
    leaveFlushInFlight = true;
    const btn = document.getElementById('wucloud_nest_save_now');
    if (btn) btn.disabled = true;
    setStatus('Сохраняю открытый дом на диск…', 'busy');
    try {
        const result = await persistOpenHomeNow({ includeExtras: true });
        if (result?.ok) {
            noteDiskFingerprint();
        }
        setStatus('Дом записан на диск таверны', 'ok');
        toast('success', 'Открытый дом сохранён на диск');
        logLine('save-now: flushed open home to ST disk (not Push, not zip)');
    } catch (e) {
        const msg = e?.message || String(e);
        setStatus(`Сохранить сейчас: ${msg}`, 'err');
        toast('error', msg);
        logLine(`save-now: ${msg}`);
    } finally {
        releaseLeaveFlushMutex();
        if (btn) btn.disabled = false;
    }
}

function bindLeaveFlush() {
    if (typeof window === 'undefined' || window.__wucloudLeaveFlush) {
        return;
    }
    window.__wucloudLeaveFlush = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            void flushOnLeave();
        }
    });
    window.addEventListener('pagehide', () => {
        void flushOnLeave();
    });
}

function bindEvents() {
    const c = ctx();
    const es = c.eventSource;
    const et = c.event_types || c.eventTypes;
    if (!es || !et) {
        logLine('eventSource unavailable — autosave limited');
        return;
    }
    const bump = () => {
        try {
            const n = chatLengthOf(ctx());
            if (n > lastKnownChatLength) {
                lastKnownChatLength = n;
            }
        } catch (_) { /* ignore */ }
        scheduleAutosave();
    };
    const types = [
        et.MESSAGE_RECEIVED, et.MESSAGE_SENT, et.MESSAGE_EDITED,
        et.MESSAGE_DELETED, et.MESSAGE_SWIPED, et.CHAT_CHANGED,
    ].filter(Boolean);
    for (const t of types) {
        try { es.on(t, bump); } catch (_) { /* ignore */ }
    }
    if (et.CHAT_CHANGED) {
        try {
            es.on(et.CHAT_CHANGED, () => {
                const c2 = ctx();
                const g = c2.groupId ?? c2.selected_group;
                const hasGroup = g !== undefined && g !== null && g !== '';
                chatLoadedThisSession = chatLoadedAfterEvent('changed', hasGroup);
                rememberLoadedEntity(c2, chatLoadedThisSession);
            });
        } catch (_) { /* ignore */ }
    }
    // ST 1.18 events.js: CHAT_LOADED: 'chatLoaded'. Bind the string too if the
    // context copy omits the key (groups still rely on CHAT_CHANGED above).
    const chatLoadedEvt = et.CHAT_LOADED || 'chatLoaded';
    try {
        es.on(chatLoadedEvt, () => {
            chatLoadedThisSession = chatLoadedAfterEvent('loaded', false);
            rememberLoadedEntity(ctx(), chatLoadedThisSession);
        });
    } catch (_) { /* ignore */ }
    if (et.GENERATION_STARTED) {
        try {
            es.on(et.GENERATION_STARTED, () => {
                generationInFlight = true;
            });
        } catch (_) { /* ignore */ }
    }
    for (const done of [et.GENERATION_ENDED, et.GENERATION_STOPPED].filter(Boolean)) {
        try {
            es.on(done, () => {
                generationInFlight = false;
            });
        } catch (_) { /* ignore */ }
    }
    // Apply selected theme after settings hydrate (importTheme does not apply).
    const loaded = et.SETTINGS_LOADED || et.SETTINGS_LOADED_AFTER || et.APP_READY;
    if (loaded) {
        try {
            es.on(loaded, () => setTimeout(() => reapplySelectedTheme('settings-loaded'), 100));
        } catch (_) { /* ignore */ }
    }
    // After UI theme file import, ST only appends option — force apply.
    const file = document.getElementById('ui_preset_import_file');
    if (file && !file.dataset.wuThemeHook) {
        file.dataset.wuThemeHook = '1';
        file.addEventListener('change', () => {
            setTimeout(() => reapplySelectedTheme('theme-import'), 400);
        });
    }
}

// ─── UI ───────────────────────────────────────────────────────────────────

function bindUi() {
    const s = getSettings();
    const $ = (id) => document.getElementById(id);

    const bindText = (id, key) => {
        const el = $(id);
        if (!el) return;
        el.value = s[key] ?? '';
        el.addEventListener('input', () => {
            getSettings()[key] = el.type === 'number' ? Number(el.value) : el.value;
            persist();
            if (key === 'autosave' || key === 'debounce_sec') setupIntervalAutosave();
        });
    };
    const bindCheck = (id, key) => {
        const el = $(id);
        if (!el) return;
        el.checked = !!s[key];
        el.addEventListener('change', () => {
            getSettings()[key] = el.checked;
            persist();
        });
    };

    bindText('wucloud_api_key', 'api_key');
    bindText('wucloud_base_url', 'base_url');
    bindText('wucloud_debounce_ms', 'debounce_sec');
    bindText('wucloud_request_timeout', 'request_timeout_sec');
    bindCheck('wucloud_sync_characters', 'sync_characters');
    bindCheck('wucloud_sync_chats', 'sync_chats');
    bindCheck('wucloud_sync_personas', 'sync_personas');
    bindCheck('wucloud_sync_lorebooks', 'sync_lorebooks');
    bindCheck('wucloud_sync_presets', 'sync_presets');
    bindCheck('wucloud_use_gzip', 'use_gzip');
    bindCheck('wucloud_dual_write', 'dual_write_platform');

    const auto = $('wucloud_autosave');
    if (auto) {
        auto.value = s.autosave || 'off';
        auto.addEventListener('change', () => {
            getSettings().autosave = auto.value;
            persist();
            setupIntervalAutosave();
        });
    }

    const chatMode = $('wucloud_chat_push_mode');
    if (chatMode) {
        chatMode.value = s.chat_push_mode || 'current';
        chatMode.addEventListener('change', () => {
            getSettings().chat_push_mode = chatMode.value;
            persist();
            updateChatModeHint();
        });
    }
    updateChatModeHint();

    $('wucloud_push_btn')?.addEventListener('click', () => {
        const ok = confirm(
            'Push pack: zip ST data (или JSON fallback) → WuCloud object store?\n\n'
            + 'Список: Dashboard → WuCloud packs.',
        );
        if (!ok) return;
        pushPackToCloud().catch(() => {});
    });
    $('wucloud_pull_btn')?.addEventListener('click', () => {
        const ok = confirm(
            'Pull pack: скачать последний pack из облака?\n\n'
            + 'Затем: SillyTavern → Data Management → Import Backup.',
        );
        if (!ok) return;
        pullPackFromCloud().catch(() => {});
    });
    $('wucloud_list_btn')?.addEventListener('click', () => listPacksCloud().catch(() => {}));
    $('wucloud_stop_btn')?.addEventListener('click', () => cancelPush());
    $('wucloud_test_btn')?.addEventListener('click', () => testConnection());
    $('wucloud_log_copy')?.addEventListener('click', () => copyLog());
    $('wucloud_log_clear')?.addEventListener('click', () => clearLog());
    $('wucloud_log_popup')?.addEventListener('click', () => showLogPopup());
    setStopButtonVisible(false);
    renderLogPanel();
}

function updateChatModeHint() {
    const el = document.getElementById('wucloud_chat_mode_hint');
    if (!el) return;
    const mode = chatPushMode();
    if (mode === 'all') {
        el.textContent = 'Push отправит все чаты всех персонажей (может занять много времени).';
    } else if (mode === 'character') {
        el.textContent = 'Push отправит все чаты текущего выбранного персонажа.';
    } else {
        el.textContent = 'Push отправит только открытый чат. Для bulk выбери «персонаж» или «все».';
    }
}

function isManagedNestHost() {
    try {
        if (typeof location === 'undefined') return false;
        const host = String(location.hostname || '').toLowerCase();
        if (!host) return false;
        if (NEST_MANAGED_HOSTS.includes(host)) return true;
        // Future Nest project domain(s): keep nest.* suffix for sibling subdomains.
        if (host.endsWith('.nest.wuproj.com')) return true;
        return false;
    } catch (_) {
        return false;
    }
}

/** Phase 0 mode: nest companion vs external bridge */
function getMode() {
    if (isManagedNestHost() || !!getSettings().managed_nest) return 'nest';
    return 'external';
}

function isNestMode() {
    return getMode() === 'nest';
}

/**
 * Nest companion must never write to WuApi BYTEA (st_cloud_artifacts).
 * Live RP data is already on ST disk under data/wu-*.
 */
function assertExternalBridge(action) {
    if (!isNestMode()) return true;
    const msg = `Nest companion: «${action}» отключён — данные уже в таверне, без дубля в PG`;
    logLine(msg);
    setStatus('Nest: без cloud sync', 'ok');
    try {
        toast('info', 'На Nest live-данные в ST. Cloud Push/Pull не нужен.');
    } catch (_) { /* ignore */ }
    return false;
}

/**
 * Nest companion bootstrap: flag mode, force autosave off, optional session key
 * (key kept for future export API / dashboard; NOT for st-sync push on Nest).
 */
async function maybeBootstrapManagedNest() {
    if (!isManagedNestHost()) return false;
    try {
        const s = getSettings();
        s.managed_nest = true;
        // Phase 0: never auto-push chats into BYTEA from Nest
        s.autosave = 'off';
        s.dual_write_platform = false;
        // st-sync host stays api (external packs later); LLM is Eco via ST profile
        s.base_url = 'https://api.wuproj.com';

        const res = await fetch('/_wu/api/me', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) {
            logLine(`Nest companion: /_wu/api/me → ${res.status}`);
            persist();
            return true;
        }
        const me = await res.json();
        const key = String(me?.apiKey || me?.api_key || '').trim();
        if (key.startsWith('wu-')) {
            s.api_key = key;
            logLine(`Nest companion: session key ${key.slice(0, 6)}…${key.slice(-4)} (LLM/profile only)`);
        } else {
            logLine('Nest companion: session has no wu- key');
        }
        persist();
        return true;
    } catch (e) {
        logLine(`Nest companion bootstrap: ${e.message || e}`);
        return isManagedNestHost();
    }
}

function fmtGiB(n) {
    const g = Number(n || 0) / (1024 ** 3);
    if (!isFinite(g) || g === 0) return '0';
    if (g < 0.01) return g.toFixed(3);
    if (g < 10) return g.toFixed(2);
    return g.toFixed(1);
}

/** Nest: refresh FS quota from nestmgr (du data/wu-*) */
async function refreshNestUsage() {
    if (!isNestMode()) return;
    const el = document.getElementById('wucloud_nest_quota');
    const bar = document.getElementById('wucloud_nest_quota_bar');
    try {
        const res = await fetch('/_nest/usage', { credentials: 'include', cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const u = await res.json();
        if (!u.access) {
            if (el) el.textContent = 'нет доступа Nest';
            return;
        }
        const used = Number(u.storage_used_bytes || 0);
        const quota = Number(u.storage_quota_bytes || 0);
        const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
        if (el) {
            el.textContent = `${fmtGiB(used)} / ${fmtGiB(quota)} ГБ · ${u.level || '—'} · ${pct}% · ${u.handle || ''}`;
        }
        if (bar) {
            bar.style.width = `${pct}%`;
            bar.classList.toggle('is-ok', pct < 85);
        }
    } catch (e) {
        if (el) el.textContent = `квота: ${e.message || e}`;
    }
}

/** Export: reuse ST native POST /api/users/backup (zip of data/wu-*) */
async function nestExportZip() {
    if (!isNestMode()) return;
    try {
        setStatus('Export zip…', 'busy');
        const meRes = await fetch('/api/users/me', { headers: getRequestHeaders() });
        if (!meRes.ok) throw new Error('не удалось получить handle');
        const me = await meRes.json();
        const handle = me.handle;
        if (!handle) throw new Error('empty handle');
        const res = await fetch('/api/users/backup', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ handle }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `backup HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        const m = /filename="?([^";]+)"?/i.exec(cd);
        const filename = (m && m[1]) || `${handle}-backup.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(`Export: ${filename}`, 'ok');
        toast('success', 'Бэкап .zip скачан на компьютер');
        logLine(`export zip ok ${filename}`);
    } catch (e) {
        setStatus(`Export: ${e.message}`, 'err');
        toast('error', e.message);
        logLine(`export: ${e.message}`);
    }
}

/** ST backup name/type: zip (desktop) or tar.gz (Android ST). Server also sniffs magic. */
function looksLikeStBackup(name, type) {
    const n = String(name || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    return n.endsWith('.zip') || n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.tar')
        || t.includes('zip') || t.includes('gzip') || t.includes('tar') || t.includes('compressed')
        || t === 'application/octet-stream' || t === '';
}

/**
 * CF free/pro: ~100MB body + ~100s proxy timeout. 80MB chunks on mobile die
 * mid-POST → 502/timeout → user sees every part «restart». 16MB is safer.
 */
const NEST_IMPORT_CHUNK_DEFAULT = 16 * 1024 * 1024;
const NEST_IMPORT_CHUNK_MAX_RELIABLE = 24 * 1024 * 1024;
const NEST_IMPORT_LS = 'wucloud_nest_import_v1';
const NEST_IMPORT_CHUNK_RETRIES = 14;
/** Sequential only — parallel multi‑MB POSTs reset nestmgr behind nginx. */
const NEST_IMPORT_CONCURRENCY_MAX = 1;

/** @type {{ abort: boolean } | null} */
let nestImportRun = null;

function nestImportSleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** Smaller chunks on bad links = more resume checkpoints, under CF 100s. */
function nestImportChunkBytes() {
    try {
        const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c) {
            if (c.saveData) return 8 * 1024 * 1024;
            const t = String(c.effectiveType || '').toLowerCase();
            if (t === 'slow-2g' || t === '2g') return 8 * 1024 * 1024;
            if (t === '3g') return 12 * 1024 * 1024;
            const down = Number(c.downlink);
            if (Number.isFinite(down) && down > 0 && down < 1.5) return 10 * 1024 * 1024;
        }
    } catch (_) { /* */ }
    return NEST_IMPORT_CHUNK_DEFAULT;
}

/** Nest import stays sequential (CF + nestmgr stability). */
function nestImportConcurrency() {
    return NEST_IMPORT_CONCURRENCY_MAX;
}

function nestImportLoadSession() {
    try {
        return JSON.parse(localStorage.getItem(NEST_IMPORT_LS) || 'null');
    } catch (_) {
        return null;
    }
}

function nestImportSaveSession(s) {
    try {
        localStorage.setItem(NEST_IMPORT_LS, JSON.stringify({ ...s, updated_at: Date.now() }));
    } catch (_) { /* quota / private mode */ }
}

function nestImportClearSession() {
    try { localStorage.removeItem(NEST_IMPORT_LS); } catch (_) { /* */ }
}

function nestImportIsRetryable(err, status, payload) {
    if (payload?.session_kept) return true;
    if (payload?.session_cleared) return false;
    const msg = String(err?.message || err || '').toLowerCase();
    // Mid-body disconnect (was HTTP 400) — must retry, not abort whole import.
    if (msg.includes('incomplete chunk')) return true;
    if (status === 408 || status === 425) return true;
    if (status === 401 || status === 403 || status === 413) {
        return false;
    }
    if (status === 400) {
        return false;
    }
    if (status === 409) {
        return false;
    }
    if (status === 502 || status === 503 || status === 504 || status === 429) {
        return true;
    }
    if (status && status >= 500) return true;
    return (
        msg.includes('failed to fetch')
        || msg.includes('network')
        || msg.includes('abort')
        || msg.includes('timeout')
        || msg.includes('load failed')
        || msg.includes('connection')
        || msg.includes('502')
        || msg.includes('503')
    );
}

function nestImportFormatBytes(n) {
    const b = Number(n) || 0;
    if (b >= 1024 ** 3) return `${(b / (1024 ** 3)).toFixed(2)} ГБ`;
    if (b >= 1024 ** 2) return `${(b / (1024 ** 2)).toFixed(1)} МБ`;
    return `${Math.round(b / 1024)} КБ`;
}

async function nestImportRefreshResumeBanner() {
    const box = document.getElementById('wucloud_nest_resume');
    const text = document.getElementById('wucloud_nest_resume_text');
    if (!box || !text || !isNestMode()) return;
    const prev = nestImportLoadSession();
    if (!prev?.upload_id || !prev.file_name) {
        box.style.display = 'none';
        box.hidden = true;
        return;
    }
    try {
        const stRes = await fetch(`/_nest/import-status?id=${encodeURIComponent(prev.upload_id)}`, {
            credentials: 'include',
            headers: { Accept: 'application/json' },
        });
        const st = await stRes.json().catch(() => ({}));
        if (!stRes.ok || !st.exists || !(st.have_count > 0)) {
            box.style.display = 'none';
            box.hidden = true;
            return;
        }
        const have = Number(st.have_count) || 0;
        const chunks = Number(st.chunks || prev.chunks) || 0;
        const pct = chunks ? Math.round((have / chunks) * 100) : 0;
        const ttlH = st.ttl_sec_left != null ? Math.max(0, Math.round(Number(st.ttl_sec_left) / 3600)) : 48;
        const fname = decodeURIComponent(String(prev.file_name || st.file_name || 'бэкап'));
        text.textContent = `Недолитый бэкап «${fname}»: на сервере уже ${have}/${chunks} частей (~${pct}%, ${nestImportFormatBytes(st.have_bytes)}). `
            + `Выберите тот же файл — докачаем остаток. Хранится ещё ~${ttlH} ч. `
            + `«Отменить» удалит части с сервера.`;
        box.hidden = false;
        box.style.display = '';
    } catch (_) {
        box.style.display = 'none';
        box.hidden = true;
    }
}

async function nestImportAbortSession() {
    const prev = nestImportLoadSession();
    const id = prev?.upload_id;
    nestImportClearSession();
    if (nestImportRun) nestImportRun.abort = true;
    if (id) {
        try {
            await fetch('/_nest/import-abort', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ id }),
            });
        } catch (_) { /* */ }
    }
    await nestImportRefreshResumeBanner();
    setStatus('Недолитый бэкап отменён', 'ok');
    toast('info', 'Недолитый бэкап сброшен — можно начать заново');
}

/**
 * Nest import: multi-GB via parallel chunks (each < CF limit).
 * Resumable: server keeps chunks 48h; client retries + Wake Lock + localStorage.
 * Slice all parts before any await so Android File stays valid.
 */
async function nestImportFromFile(file) {
    if (!isNestMode()) {
        toast('warning', 'Загрузка бэкапа в дом доступна только на Nest');
        return;
    }
    if (!file) {
        toast('warning', 'Файл не выбран');
        return;
    }
    if (nestImportRun && !nestImportRun.abort) {
        toast('info', 'Загрузка уже идёт — дождитесь или нажмите «Отменить недолитый бэкап»');
        return;
    }
    const name = String(file.name || 'backup.bin');
    const size = Number(file.size) || 0;
    const mb = size / (1024 * 1024);
    if (!looksLikeStBackup(name, file.type)) {
        toast('warning', `Нужен .zip / .tar.gz (выбрано: ${name})`);
        return;
    }
    // Resume must reuse chunk size — but pre-0.15.3 80MB chunks die on CF/mobile.
    let prev = nestImportLoadSession();
    let chunkBytes = nestImportChunkBytes();
    if (
        prev
        && prev.file_name === name
        && Number(prev.file_size) === size
        && Number(prev.chunk_size) > 0
        && Number(prev.chunk_size) <= NEST_IMPORT_CHUNK_MAX_RELIABLE
    ) {
        chunkBytes = Number(prev.chunk_size);
    } else if (prev?.upload_id && Number(prev.chunk_size) > NEST_IMPORT_CHUNK_MAX_RELIABLE) {
        logLine(`import migrate: drop oversized chunk_size=${prev.chunk_size} → ${chunkBytes}`);
        try {
            await fetch('/_nest/import-abort', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ id: prev.upload_id }),
            });
        } catch (_) { /* */ }
        nestImportClearSession();
        prev = null;
        toast('info', 'Переключаю на мелкие части (стабильнее на телефоне) — заливка начнётся заново, зато без вечных обрывов');
    }
    const chunks = Math.max(1, Math.ceil(size / chunkBytes) || 1);
    // Prepare Blob slices BEFORE any await (Android File permission)
    const parts = [];
    for (let i = 0; i < chunks; i++) {
        parts.push(file.slice(i * chunkBytes, Math.min(size, (i + 1) * chunkBytes)));
    }

    // Resume same file (name+size) with same upload_id if server still has chunks
    let id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    let haveSet = new Set();
    if (
        prev
        && prev.file_name === name
        && Number(prev.file_size) === size
        && Number(prev.chunks) === chunks
        && Number(prev.chunk_size) === chunkBytes
        && prev.upload_id
    ) {
        id = String(prev.upload_id);
        try {
            const stRes = await fetch(`/_nest/import-status?id=${encodeURIComponent(id)}`, {
                credentials: 'include',
                headers: { Accept: 'application/json' },
            });
            const st = await stRes.json().catch(() => ({}));
            if (stRes.ok && st.exists && Array.isArray(st.have)) {
                haveSet = new Set(st.have.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
                logLine(`import resume id=${id} have=${haveSet.size}/${chunks}`);
            } else {
                logLine(`import status empty — fresh session id=${id}`);
            }
        } catch (e) {
            logLine(`import-status: ${e?.message || e} — continue`);
        }
    }

    nestImportSaveSession({
        upload_id: id,
        file_name: name,
        file_size: size,
        chunks,
        chunk_size: chunkBytes,
    });

    const sizeLabel = mb >= 1024 ? `${(mb / 1024).toFixed(2)} ГБ` : `${mb.toFixed(1)} МБ`;
    const already = haveSet.size;
    setStatus(
        already
            ? `Загрузка бэкапа: ${name} · продолжаем ${already}/${chunks}…`
            : `Загрузка бэкапа: ${name} (${sizeLabel}, части по ${Math.round(chunkBytes / (1024 * 1024))} МБ)…`,
        'busy',
    );
    toast(
        'info',
        already
            ? `Продолжаем «${name}»: на сервере уже ${already}/${chunks}. Обрыв интернета — снова выберите этот же файл.`
            : `Загрузка «${name}» (${sizeLabel}). Не гасите экран. Если оборвётся — выберите тот же файл, докачаем.`,
    );
    logLine(`import start name=${name} size_mb=${mb.toFixed(2)} chunks=${chunks} chunk_mb=${(chunkBytes / (1024 * 1024)).toFixed(0)} id=${id} resume_have=${already}`);

    const run = { abort: false };
    nestImportRun = run;

    // Keep screen awake on mobile (best-effort; fails silently if denied)
    let wakeLock = null;
    const acquireWake = async () => {
        try {
            if (navigator.wakeLock && navigator.wakeLock.request) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener?.('release', () => { /* re-acquire on visibility */ });
            }
        } catch (_) { /* not supported / denied */ }
    };
    const onVis = () => {
        if (document.visibilityState === 'visible') acquireWake();
    };
    await acquireWake();
    try { document.addEventListener('visibilitychange', onVis); } catch (_) { /* */ }

    const postChunk = async (i) => {
        if (run.abort) throw new Error('загрузка отменена');
        const headers = {
            'Content-Type': 'application/octet-stream',
            'X-Nest-Upload-Id': id,
            'X-Nest-Chunk': String(i),
            'X-Nest-Chunks': String(chunks),
            'X-Nest-File-Size': String(size),
        };
        // ASCII-safe file name for header
        try {
            headers['X-Nest-File-Name'] = encodeURIComponent(name).slice(0, 200);
        } catch (_) { /* */ }

        let lastErr = null;
        for (let attempt = 1; attempt <= NEST_IMPORT_CHUNK_RETRIES; attempt++) {
            if (run.abort) throw new Error('загрузка отменена');
            try {
                const res = await fetch('/_nest/import', {
                    method: 'POST',
                    credentials: 'include',
                    headers,
                    body: parts[i],
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const hint = data.error || `HTTP ${res.status}`;
                    const err = new Error(res.status === 401 ? `${hint} — войдите снова` : hint);
                    err.status = res.status;
                    err.payload = data;
                    if (data.session_cleared) nestImportClearSession();
                    if (!nestImportIsRetryable(err, res.status, data) || attempt === NEST_IMPORT_CHUNK_RETRIES) {
                        throw err;
                    }
                    lastErr = err;
                } else {
                    return data;
                }
            } catch (e) {
                lastErr = e;
                const status = e?.status;
                const payload = e?.payload;
                if (!nestImportIsRetryable(e, status, payload) || attempt === NEST_IMPORT_CHUNK_RETRIES) {
                    throw e;
                }
            }
            // Exponential backoff: 1s, 2s, 4s… cap 45s (network blip / screen wake)
            const delay = Math.min(45000, 1000 * (2 ** (attempt - 1)));
            setStatus(
                `Загрузка бэкапа: обрыв части ${i + 1}/${chunks}, повтор ${attempt}/${NEST_IMPORT_CHUNK_RETRIES} через ${Math.round(delay / 1000)}с… (можно выбрать тот же файл позже)`,
                'busy',
            );
            logLine(`import retry chunk=${i + 1} attempt=${attempt} wait_ms=${delay} err=${lastErr?.message || lastErr}`);
            nestImportSaveSession({
                upload_id: id,
                file_name: name,
                file_size: size,
                chunks,
                chunk_size: chunkBytes,
                last_chunk: i,
            });
            await nestImportSleep(delay);
            if (document.visibilityState === 'visible') await acquireWake();
        }
        throw lastErr || new Error('chunk upload failed');
    };

    try {
        // Which chunks still need upload; if all present, re-send last to trigger assemble
        const need = [];
        for (let i = 0; i < chunks; i++) {
            if (!haveSet.has(i)) need.push(i);
        }
        if (need.length === 0 && chunks > 0) {
            need.push(chunks - 1);
            logLine('import all chunks on server — re-send last to assemble');
        }

        const conc = Math.min(nestImportConcurrency(), Math.max(1, need.length));
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        let liveBytes = 0;
        logLine(`import parallel concurrency=${conc} queue=${need.length}`);

        let data = {};
        let doneCount = haveSet.size;
        let nextIdx = 0;
        let hardFail = null;
        let finished = false;
        const inFlight = new Set();

        const bumpStatus = () => {
            const pct = Math.min(99, Math.round((doneCount / chunks) * 100));
            const elapsed = Math.max(0.001, (
                ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0
            ) / 1000);
            const mibs = liveBytes / (1024 * 1024) / elapsed;
            const speed = mibs >= 0.05 ? ` · ~${mibs.toFixed(1)} МиБ/с` : '';
            const par = conc > 1 ? ` ×${inFlight.size || conc}` : '';
            setStatus(`Загрузка бэкапа: ${name} · ${doneCount}/${chunks} (${pct}%)${par}${speed}`, 'busy');
        };

        const runOne = async (i) => {
            inFlight.add(i);
            bumpStatus();
            logLine(`import chunk ${i + 1}/${chunks} (parallel)`);
            try {
                const chunkData = await postChunk(i);
                liveBytes += parts[i]?.size || 0;
                if (Array.isArray(chunkData.have_list)) {
                    for (const h of chunkData.have_list) haveSet.add(Number(h));
                    doneCount = Math.max(doneCount, haveSet.size);
                } else {
                    haveSet.add(i);
                    doneCount = Math.max(doneCount, haveSet.size, Number(chunkData.have) || 0);
                }
                nestImportSaveSession({
                    upload_id: id,
                    file_name: name,
                    file_size: size,
                    chunks,
                    chunk_size: chunkBytes,
                    last_ok_chunk: i,
                });
                if (chunkData.done) {
                    data = chunkData;
                    finished = true;
                } else if (!finished) {
                    data = chunkData;
                }
            } finally {
                inFlight.delete(i);
                bumpStatus();
            }
        };

        const workers = Array.from({ length: conc }, async () => {
            while (!hardFail && !finished) {
                const my = nextIdx++;
                if (my >= need.length) return;
                try {
                    await runOne(need[my]);
                } catch (e) {
                    hardFail = e;
                    return;
                }
            }
        });
        await Promise.all(workers);

        if (hardFail) throw hardFail;

        if (!data.done && data.files == null) {
            throw new Error(data.error || 'upload incomplete — выберите тот же файл ещё раз, загрузка продолжится');
        }
        nestImportClearSession();
        const elapsed = Math.max(0.001, (
            ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0
        ) / 1000);
        const avg = (liveBytes / (1024 * 1024) / elapsed).toFixed(1);
        setStatus(
            `Бэкап загружен: ${data.files || 0} файлов (${data.format || '?'}) → ${data.handle} · ${avg} МиБ/с. Обновляю страницу…`,
            'ok',
        );
        toast('success', 'Бэкап загружен на Nest — страница обновится, затем откройте список чатов');
        logLine(`import ok files=${data.files} format=${data.format} chunks=${chunks} conc=${conc} avg_mib_s=${avg}`);
        refreshNestUsage();
        setTimeout(() => { try { location.reload(); } catch (_) { /* */ } }, 1200);
    } catch (e) {
        const msg = e?.message || String(e);
        const permanent = /unsupported|invalid (zip|tar|header|json)|not an ST|empty |gzip decompress|нужен ST backup|JSON pack пуст|Bad magic|not a gzip|WuCloud JSON/i.test(msg);
        // Always drop resume on 4xx format problems so we don't skip-reupload forever
        if (permanent || /invalid header/i.test(msg)) {
            nestImportClearSession();
            const hint = /invalid header|gzip|json/i.test(msg)
                ? ' Нужен обычный zip-бэкап SillyTavern. Если pack уже в WuProj — нажмите «Подтянуть из облака WuProj».'
                : '';
            setStatus(`Загрузка бэкапа: ${msg}`, 'err');
            toast('error', msg + hint);
        } else {
            setStatus(`Загрузка бэкапа: ${msg} (выберите тот же файл ещё раз — продолжим)`, 'err');
            toast('error', `${msg}. Выберите тот же файл снова — загрузка продолжится с места обрыва.`);
        }
        logLine(`import: ${msg}${permanent || /invalid header/i.test(msg) ? ' (session cleared)' : ''}`);
        nestImportRefreshResumeBanner().catch(() => {});
    } finally {
        if (nestImportRun === run) nestImportRun = null;
        try { document.removeEventListener('visibilitychange', onVis); } catch (_) { /* */ }
        try { await wakeLock?.release?.(); } catch (_) { /* */ }
    }
}

/** Nest companion panel vs external bridge panel */
function applyManagedUi() {
    const nest = isNestMode();
    const banner = document.getElementById('wucloud_managed_banner');
    const external = document.getElementById('wucloud_external_panel');
    const status = document.getElementById('wucloud_managed_key_status');
    const modeBadge = document.getElementById('wucloud_mode_badge');

    if (banner) banner.style.display = nest ? '' : 'none';
    if (external) external.style.display = nest ? 'none' : '';
    if (modeBadge) {
        modeBadge.textContent = nest ? 'Nest' : 'External';
        modeBadge.classList.toggle('is-nest', nest);
        modeBadge.classList.toggle('is-ext', !nest);
    }
    if (status && nest) {
        status.textContent = 'Чаты на диске Nest. Бэкап — зелёная кнопка ниже. Обрыв сети: тот же файл → докачка.';
        status.classList.add('is-ok');
        status.classList.remove('is-bad');
    }
    const s = getSettings();
    const keyEl = document.getElementById('wucloud_api_key');
    const baseEl = document.getElementById('wucloud_base_url');
    if (keyEl && s.api_key) keyEl.value = s.api_key;
    if (baseEl) baseEl.value = s.base_url || 'https://api.wuproj.com';
    if (nest) {
        refreshNestUsage();
        wireNestImportExport();
        nestImportRefreshResumeBanner().catch(() => {});
    }
}

/**
 * Nest: apply latest WuCloud pack from server disk (no browser re-upload).
 * Avoids «invalid header» when local ST pushed JSON.gz fallback and the user
 * re-uploads a corrupted/misread download.
 */
async function nestImportFromCloudPack() {
    if (!isNestMode()) {
        toast('warning', 'Подтянуть из облака можно только на Nest');
        return;
    }
    nestImportClearSession();
    setStatus('Подтягиваю последний pack из облака WuProj…', 'busy');
    logLine('import-cloud: start');
    try {
        const res = await fetch('/_nest/import-cloud', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        setStatus(
            `Import cloud: ${data.files || 0} files (${data.format || '?'}) · ${data.source_file || ''}`,
            'ok',
        );
        toast('success', `Из облака: ${data.files || 0} файлов — страница обновится`);
        logLine(`import-cloud ok files=${data.files} format=${data.format} src=${data.source_file}`);
        refreshNestUsage();
        setTimeout(() => { try { location.reload(); } catch (_) { /* */ } }, 1200);
        return data;
    } catch (e) {
        const msg = e?.message || String(e);
        setStatus(`Import cloud: ${msg}`, 'err');
        toast('error', msg);
        logLine(`import-cloud: ${msg}`);
        throw e;
    }
}

/** Full wipe of Nest home via nestmgr POST /_nest/wipe (reusable API). */
async function nestWipeAllData() {
    if (!isNestMode()) {
        toast('warning', 'Wipe только на Nest');
        return;
    }
    const ok1 = window.confirm(
        'Полная очистка Nest?\n\n'
        + 'Будут удалены ВСЕ данные дома:\n'
        + '• чаты, персонажи, worlds, extensions\n'
        + '• settings.json, secrets, ST backups\n'
        + '• freeze-архив (если был)\n\n'
        + 'WuAuth-аккаунт останется. Действие необратимо.',
    );
    if (!ok1) return;
    const typed = window.prompt(
        'Чтобы подтвердить, введите точно:\nWIPE_MY_NEST',
        '',
    );
    if (typed !== 'WIPE_MY_NEST') {
        toast('info', 'Wipe отменён');
        return;
    }
    setStatus('Wipe Nest data…', 'busy');
    logLine('wipe: confirm=WIPE_MY_NEST');
    try {
        const res = await fetch('/_nest/wipe', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ confirm: 'WIPE_MY_NEST', delete_archive: true }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const mb = (Number(data.bytes_before || 0) / (1024 * 1024)).toFixed(1);
        setStatus(`Wipe ok · ${data.handle} · was ${mb} MiB`, 'ok');
        toast('success', `Nest очищен (${data.handle}). Reload…`);
        logLine(`wipe ok handle=${data.handle} bytes_before=${data.bytes_before} dirs=${data.removed_dirs}`);
        setTimeout(() => {
            try { location.reload(); } catch (_) { /* */ }
        }, 900);
    } catch (e) {
        const msg = e?.message || String(e);
        setStatus(`Wipe: ${msg}`, 'err');
        toast('error', msg);
        logLine(`wipe: ${msg}`);
    }
}

/** Bind Nest export/import/wipe. Label+overlay input only (no synthetic click). */
function wireNestImportExport() {
    const exp = document.getElementById('wucloud_nest_export');
    const file = document.getElementById('wucloud_nest_import_file');
    const cloud = document.getElementById('wucloud_nest_import_cloud');
    const wipe = document.getElementById('wucloud_nest_wipe');
    const saveNow = document.getElementById('wucloud_nest_save_now');
    if (saveNow && !saveNow.dataset.bound) {
        saveNow.dataset.bound = '1';
        saveNow.addEventListener('click', (ev) => {
            ev.preventDefault();
            persistOpenHomeFromButton().catch(() => {});
        });
    }
    if (exp && !exp.dataset.bound) {
        exp.dataset.bound = '1';
        exp.addEventListener('click', (ev) => {
            ev.preventDefault();
            nestExportZip();
        });
    }
    if (cloud && !cloud.dataset.bound) {
        cloud.dataset.bound = '1';
        cloud.addEventListener('click', (ev) => {
            ev.preventDefault();
            nestImportFromCloudPack().catch(() => {});
        });
    }
    if (file && !file.dataset.bound) {
        file.dataset.bound = '1';
        try { file.removeAttribute('accept'); } catch (_) { /* */ }
        let busy = false;
        file.addEventListener('change', () => {
            if (busy) return;
            const f = file.files && file.files[0];
            if (!f) return;
            busy = true;
            // Read first (inside change chain), then clear — see nestImportFromFile
            nestImportFromFile(f).finally(() => {
                try { file.value = ''; } catch (_) { /* */ }
                busy = false;
            });
        });
    }
    if (wipe && !wipe.dataset.bound) {
        wipe.dataset.bound = '1';
        wipe.addEventListener('click', (ev) => {
            ev.preventDefault();
            nestWipeAllData();
        });
    }
    const abortBtn = document.getElementById('wucloud_nest_import_abort');
    if (abortBtn && !abortBtn.dataset.bound) {
        abortBtn.dataset.bound = '1';
        abortBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            nestImportAbortSession().catch(() => {});
        });
    }
}

async function init() {
    getSettings();
    await loadMap();
    const managed = await maybeBootstrapManagedNest();
    try {
        let html = null;
        if (typeof renderExtensionTemplateAsync === 'function') {
            html = await renderExtensionTemplateAsync(FOLDER, 'settings');
        }
        if (!html) {
            const res = await fetch(`/scripts/extensions/${FOLDER}/settings.html`);
            if (res.ok) html = await res.text();
        }
        if (html) {
            const host = document.getElementById('extensions_settings2')
                || document.getElementById('extensions_settings');
            if (host && !document.getElementById('wucloud-sync-panel')) {
                host.insertAdjacentHTML('beforeend', html);
            }
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'UI inject failed', e);
    }

    bindUi();
    applyManagedUi();
    // Keep HTML badges in sync with EXT_VERSION (never hardcode drift)
    try {
        const b = document.getElementById('wucloud_ver_badge');
        if (b) b.textContent = EXT_VERSION;
        const f = document.getElementById('wucloud_ver_foot');
        if (f) f.textContent = `v${EXT_VERSION} · Phase 2 packs`;
    } catch (_) { /* ignore */ }
    ensureNestLocaleDefault();
    bindEvents();
    bindLeaveFlush();
    settingsHydrated = true;
    // Seed so the 15s kick does not dump ~10 MiB settings.json; leave-flush
    // and Save Now still write settings. Autosave settings wait 10 minutes.
    lastSettingsPersistAt = Date.now();
    // Same idea as settingsAt: first idle tick must not look dirty.
    noteDiskFingerprint();
    setupIntervalAutosave();
    // Late reapply if settings already loaded before our handlers bound
    setTimeout(() => reapplySelectedTheme('init'), 800);
    const mode = getMode();
    const keyOk = apiKey().startsWith('wu-');
    logLine(`WuCloud ${EXT_VERSION} mode=${mode} · nestHost=${managed} · key=${keyOk ? 'yes' : 'n/a'} · BYTEA_sync=${mode === 'external' ? 'on' : 'OFF'}`);
    if (mode === 'nest') {
        setStatus(`NestCloud ${EXT_VERSION} · дом на диске · бэкап — кнопка «Загрузить бэкап с компьютера»`, 'ok');
        toast('info', `WuCloud Nest · live data на диске ST`);
    } else {
        setStatus(keyOk ? `External bridge ${EXT_VERSION}` : `External · нет ключа`, keyOk ? 'ok' : 'err');
        toast('info', `WuCloud External ${EXT_VERSION}`);
    }
    console.log(LOG_PREFIX, `loaded v${EXT_VERSION} mode=${mode}`);
}

/**
 * Boot after ST is ready when possible (ST 1.15+ APP_READY).
 * Avoids racing settings/UI before multi-user session hydrate.
 */
function bootWuCloud() {
    const run = () => {
        try {
            if (typeof jQuery === 'function') jQuery(init);
            else init().catch((e) => console.error(LOG_PREFIX, e));
        } catch (e) {
            console.error(LOG_PREFIX, 'boot', e);
        }
    };
    try {
        const c = ctx();
        const es = c.eventSource;
        const et = c.event_types || c.eventTypes || {};
        const ready = et.APP_READY || et.SETTINGS_LOADED || 'app_ready';
        if (es && typeof es.once === 'function' && ready) {
            let done = false;
            const once = () => {
                if (done) return;
                done = true;
                run();
            };
            es.once(ready, once);
            // Fallback if event already fired
            setTimeout(() => {
                if (!done) once();
            }, 2500);
            return;
        }
    } catch (_) { /* fall through */ }
    run();
}

installSessionCsrfWatch();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWuCloud);
} else {
    bootWuCloud();
}
