/**
 * WuCloud Sync — SillyTavern extension v0.8.1
 * Cloud backup to WuProj: characters, chats (lossless gzip blobs), personas, lorebooks, presets.
 * Install: Extensions → Install extension → https://github.com/shastitko1970-netizen/wucloud-sync
 * Branch: main or wucloud
 */
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'wucloud-sync';
const FOLDER = `third-party/${MODULE}`;
const LOG_PREFIX = '[WuCloud]';
const MAP_KEY = `${MODULE}_id_map`;
const EXT_VERSION = '0.8.1';

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
    autosave: 'off', // off | message | interval
    debounce_sec: 8,
    use_gzip: true,
    chat_push_mode: 'current', // current | character | all
    // Dual-write to platform /chats for Dashboard preview. Heavy — off by default.
    dual_write_platform: false,
    request_timeout_sec: 90,
});

/** @type {Record<string, { cloud_id?: number, content_hash?: string }>} */
let idMap = {};
let mapLoaded = false;
let mapDirty = false;
let mapSaveTimer = null;
let autosaveTimer = null;
let intervalHandle = null;
let pushInFlight = false;
let pushAbort = null;

function ctx() {
    try {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            return SillyTavern.getContext();
        }
    } catch (_) { /* ignore */ }
    return getContext();
}

function libs() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.libs) ? SillyTavern.libs : {};
    } catch (_) {
        return {};
    }
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
    try {
        const c = ctx();
        if (typeof c.getRequestHeaders === 'function') {
            return c.getRequestHeaders({ omitContentType });
        }
    } catch (_) { /* fall through */ }
    const headers = {};
    if (!omitContentType) headers['Content-Type'] = 'application/json';
    try {
        // ST global token used by getRequestHeaders
        if (typeof token !== 'undefined' && token) headers['X-CSRF-Token'] = token;
    } catch (_) { /* ignore */ }
    return headers;
}

/** POST JSON to SillyTavern local API with CSRF + optional abort. */
async function stFetch(url, body = null, { method = 'POST', omitContentType = false } = {}) {
    const headers = stHeaders({ omitContentType });
    const opts = { method, headers, cache: 'no-cache' };
    if (body != null && method !== 'GET') {
        opts.body = typeof body === 'string' || body instanceof FormData
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
    let u = (getSettings().base_url || 'https://api.wuproj.com').trim();
    u = u.replace(/\/+$/, '');
    // Common mistakes: pasted full chat path or missing scheme
    u = u.replace(/\/v1(\/chat\/completions)?$/i, '');
    u = u.replace(/\/api\/v2.*$/i, '');
    if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
    return u || 'https://api.wuproj.com';
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

async function apiFetch(path, { method = 'GET', body = null, formData = null } = {}) {
    const key = apiKey();
    if (!key) throw new Error('Введите API-ключ wu-… из кабинета WuProj (Dashboard → API keys)');
    if (!key.startsWith('wu-')) {
        throw new Error('Ключ должен начинаться с wu- (это API-ключ, не пароль и не JWT). Возьмите в Dashboard → API keys.');
    }

    const headers = { Authorization: `Bearer ${key}` };
    let payload = body;
    if (formData) {
        payload = formData;
    } else if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof Uint8Array)) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }

    const url = `${baseUrl()}${path}`;
    const timeoutMs = requestTimeoutMs();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // Link outer cancel (Stop): AbortController has .signal, not addEventListener
    const onOuterAbort = () => ctrl.abort();
    const outerSignal = pushAbort && pushAbort.signal ? pushAbort.signal : null;
    if (outerSignal) {
        if (outerSignal.aborted) {
            clearTimeout(timer);
            throw new Error('Отменено');
        }
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    let res;
    try {
        res = await fetch(url, { method, headers, body: payload, signal: ctrl.signal });
    } catch (e) {
        if (e?.name === 'AbortError') {
            if (isPushAborted()) throw new Error('Отменено');
            throw new Error(`Таймаут ${Math.round(timeoutMs / 1000)}с: ${path}`);
        }
        throw new Error(`Сеть: ${e.message} (url=${url}). Проверьте base URL и CORS.`);
    } finally {
        clearTimeout(timer);
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* raw */ }
    if (!res.ok) {
        const errMsg = formatApiError(json, text, res.statusText);
        if (res.status === 401) {
            throw new Error(`401 Unauthorized: ${errMsg}. Проверьте ключ wu-… (скопируйте заново из кабинета, без пробелов).`);
        }
        throw new Error(`${res.status}: ${errMsg}`);
    }
    return json;
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

    // 1) Context / globals
    try {
        const fromCtx = c.worldInfoSettings?.world_names
            || c.world_names
            || c.worldInfoNames
            || (typeof world_names !== 'undefined' ? world_names : null);
        if (Array.isArray(fromCtx)) names = fromCtx.slice();
    } catch (_) { /* ignore */ }

    // 2) Module import (most reliable on modern ST)
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
    // Export cloud character as JSON → ST import API
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
    const blob = new Blob([JSON.stringify(card)], { type: 'application/json' });
    const fd = new FormData();
    fd.append('avatar', blob, `${(char.name || 'card').replace(/[^\w\-]+/g, '_')}.json`);
    // ST import character endpoint
    const res = await fetch('/api/characters/import', { method: 'POST', body: fd });
    if (!res.ok) {
        // alternate: /api/character/import
        const res2 = await fetch('/api/character/import', { method: 'POST', body: fd });
        if (!res2.ok) throw new Error(`ST import failed ${res.status}/${res2.status}`);
        return res2.json().catch(() => ({}));
    }
    return res.json().catch(() => ({}));
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
async function importChatJsonlToST(charAvatar, fileName, jsonlText) {
    const baseName = String(fileName).replace(/\.jsonl$/i, '');
    // ST endpoint used by import chat from file
    const attempts = [
        { url: '/api/chats/import', body: () => {
            const fd = new FormData();
            fd.append('avatar_url', charAvatar);
            fd.append('file', new Blob([jsonlText], { type: 'application/jsonl' }), `${baseName}.jsonl`);
            return fd;
        }},
        { url: '/api/characters/import-chat', body: () => {
            const fd = new FormData();
            fd.append('avatar_url', charAvatar);
            fd.append('file', new Blob([jsonlText], { type: 'application/jsonl' }), `${baseName}.jsonl`);
            return fd;
        }},
    ];
    for (const a of attempts) {
        try {
            const res = await fetch(a.url, { method: 'POST', body: a.body() });
            if (res.ok) return { ok: true, via: a.url };
        } catch (_) { /* try next */ }
    }
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
    const attempts = [
        { url: '/api/worldinfo/import', json: true },
        { url: '/api/worldinfo/upload', form: true },
    ];
    for (const a of attempts) {
        try {
            if (a.json) {
                const res = await fetch(a.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(full),
                });
                if (res.ok) return { ok: true, via: a.url };
            } else {
                const fd = new FormData();
                fd.append('file', new Blob([JSON.stringify(full)], { type: 'application/json' }), `${name}.json`);
                const res = await fetch(a.url, { method: 'POST', body: fd });
                if (res.ok) return { ok: true, via: a.url };
            }
        } catch (_) { /* next */ }
    }
    return { ok: false };
}

async function importPresetToST(preset) {
    const raw = preset.raw_data || preset;
    const name = preset.name || raw.name || 'imported_preset';
    // Chat completion presets live in settings — try ST API
    try {
        const res = await fetch('/api/settings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(raw),
        });
        if (res.ok) return { ok: true };
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

        // Chat blobs → ST (need a character selected)
        if (s.sync_chats && chatBlobs.length) {
            const char = c.characters?.[c.characterId];
            const avatar = char?.avatar;
            if (!avatar) {
                logLine('chats pull: выбери персонажа в ST, затем Pull снова');
            } else {
                for (const item of chatBlobs) {
                    try {
                        setStatus(`Pull chat: ${item.name}…`, 'busy');
                        const text = await fetchBlobText(item.id);
                        // client_key often chat:avatar:filename
                        let fileName = item.name || `chat_${item.id}`;
                        const parts = String(item.client_key || '').split(':');
                        if (parts.length >= 3) fileName = parts.slice(2).join(':');
                        const r = await importChatJsonlToST(avatar, fileName, text);
                        if (r.ok) imported++;
                        else { downloads++; logLine(`chat ${fileName}: saved as download`); }
                        await mapSet(item.client_key, item.id, item.content_hash);
                    } catch (e) {
                        failed++;
                        logLine(`chat blob ${item.id}: ${e.message}`);
                    }
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
    const s = getSettings();
    if (s.autosave !== 'message' || !s.sync_chats) return;
    const sec = Math.max(2, Number(s.debounce_sec) || 8);
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
        syncPush({ onlyCurrentChat: true }).catch(e => logLine(`autosave: ${e.message}`));
    }, sec * 1000);
}

function setupIntervalAutosave() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    const s = getSettings();
    if (s.autosave !== 'interval' || !s.sync_chats) return;
    const sec = Math.max(15, Number(s.debounce_sec) || 60);
    intervalHandle = setInterval(() => {
        syncPush({ onlyCurrentChat: true }).catch(e => logLine(`interval: ${e.message}`));
    }, sec * 1000);
}

function bindEvents() {
    const c = ctx();
    const es = c.eventSource;
    const et = c.event_types || c.eventTypes;
    if (!es || !et) {
        logLine('eventSource unavailable — autosave limited');
        return;
    }
    const bump = () => scheduleAutosave();
    const types = [
        et.MESSAGE_RECEIVED, et.MESSAGE_SENT, et.MESSAGE_EDITED,
        et.MESSAGE_DELETED, et.MESSAGE_SWIPED, et.CHAT_CHANGED,
    ].filter(Boolean);
    for (const t of types) {
        try { es.on(t, bump); } catch (_) { /* ignore */ }
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

    $('wucloud_push_btn')?.addEventListener('click', () => syncPush({}));
    // Chat bulk overrides (chats only — ignore cards/personas/presets this run)
    $('wucloud_push_all_chats_btn')?.addEventListener('click', () => syncPush({
        chatMode: 'character',
        chatsOnly: true,
    }));
    $('wucloud_push_all_lib_btn')?.addEventListener('click', () => {
        const ok = confirm(
            'Выгрузить ВСЕ чаты ВСЕХ персонажей в облако?\n\n'
            + 'Это может занять много времени. Можно нажать «Стоп».',
        );
        if (!ok) return;
        syncPush({ chatMode: 'all', chatsOnly: true });
    });
    $('wucloud_push_chat_btn')?.addEventListener('click', () => syncPush({ onlyCurrentChat: true }));
    $('wucloud_pull_btn')?.addEventListener('click', () => syncPull({ importCharacters: true }));
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

async function init() {
    getSettings();
    await loadMap();
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
    bindEvents();
    setupIntervalAutosave();
    logLine(`WuCloud Sync ${EXT_VERSION} loaded · chat_mode=${chatPushMode()} · dual=${!!getSettings().dual_write_platform}`);
    setStatus(`Готов · WuCloud Sync ${EXT_VERSION}`, 'ok');
    toast('info', `WuCloud ${EXT_VERSION}`);
    console.log(LOG_PREFIX, `loaded v${EXT_VERSION}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => jQuery(init));
} else {
    jQuery(init);
}
