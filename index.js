/**
 * WuCloud Sync — SillyTavern extension v0.7.3
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
});

/** @type {Record<string, { cloud_id?: number, content_hash?: string }>} */
let idMap = {};
let mapLoaded = false;
let autosaveTimer = null;
let intervalHandle = null;
let pushInFlight = false;

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
    } catch (e) {
        console.warn(LOG_PREFIX, 'map save', e);
    }
}

function mapGet(key) {
    return idMap[key] || null;
}

async function mapSet(key, cloudId, hash) {
    idMap[key] = { cloud_id: cloudId, content_hash: hash };
    await saveMap();
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
    let res;
    try {
        res = await fetch(url, { method, headers, body: payload });
    } catch (e) {
        throw new Error(`Сеть: ${e.message} (url=${url}). Проверьте base URL и CORS.`);
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

    // Best-effort dual-write to platform chats for Dashboard preview (lossy OK)
    try {
        const fd2 = new FormData();
        fd2.append('file', new Blob([jsonl], { type: 'application/jsonl' }), `${safeName}.jsonl`);
        fd2.append('client_key', `platform:${clientKey}`);
        fd2.append('content_hash', hash);
        fd2.append('title', title || safeName);
        await apiFetch('/api/v2/chats/import', { method: 'POST', formData: fd2 });
    } catch (_) { /* non-fatal */ }

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
 * Best-effort: list chat files for current character via ST API.
 * Falls back to current chat only.
 */
async function pushAllChatsForCurrentCharacter() {
    const c = ctx();
    const char = c.characters?.[c.characterId];
    if (!char) return { pushed: 0, skipped: 0, errors: 0 };

    let files = [];
    try {
        // Official ST endpoint used by Manage chat files
        const res = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: char.avatar }),
        });
        if (res.ok) {
            const data = await res.json();
            files = Array.isArray(data) ? data : (data.chats || data.file_list || []);
        }
    } catch (e) {
        logLine(`list chats: ${e.message}`);
    }

    // Normalize to list of { file_name }
    files = files.map(f => {
        if (typeof f === 'string') return { file_name: f };
        return { file_name: f.file_name || f.filename || f.name || f };
    }).filter(f => f.file_name);

    if (!files.length) {
        const r = await pushCurrentChat();
        return {
            pushed: r?.skipped ? 0 : 1,
            skipped: r?.skipped ? 1 : 0,
            errors: 0,
        };
    }

    let pushed = 0, skipped = 0, errors = 0;
    for (const f of files) {
        try {
            setStatus(`Чат: ${f.file_name}…`, 'busy');
            const getRes = await fetch('/api/characters/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    avatar_url: char.avatar,
                    file_name: f.file_name,
                }),
            });
            // Some ST builds use /api/chats/get
            let chatArr = null;
            if (getRes.ok) {
                chatArr = await getRes.json();
            } else {
                const alt = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        avatar_url: char.avatar,
                        file_name: String(f.file_name).replace(/\.jsonl$/i, ''),
                    }),
                });
                if (alt.ok) chatArr = await alt.json();
            }
            if (!Array.isArray(chatArr) || !chatArr.length) {
                skipped++;
                continue;
            }
            // ST sometimes returns [meta, ...messages]
            const messages = chatArr;
            const clientKey = `chat:${char.avatar}:${f.file_name}`;
            const jsonl = buildChatJsonlFromArray(messages, {
                character_name: char.name,
            });
            const r = await pushChatPayload({
                clientKey,
                title: `${char.name} · ${f.file_name}`,
                jsonl,
            });
            if (r?.skipped) skipped++;
            else pushed++;
        } catch (e) {
            errors++;
            logLine(`chat ${f.file_name}: ${e.message}`);
        }
    }
    return { pushed, skipped, errors };
}

// ─── ST settings helpers ──────────────────────────────────────────────────

/** Full ST settings (includes power_user). */
async function fetchSTSettings() {
    try {
        const res = await fetch('/api/settings/get');
        if (res.ok) return await res.json();
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

    logLine(`personas debug: keys=${Object.keys(personasMap).length} descs=${Object.keys(descriptions).length} has_default_desc=${!!power.persona_description}`);

    // Shape A: { "Display Name": "User Avatars/xxx.png" }
    for (const [key, val] of Object.entries(personasMap)) {
        if (typeof val === 'string' && /\.(png|jpe?g|webp|gif)$/i.test(val)) {
            const avatar = val;
            const descObj = descriptions[avatar] || descriptions[key] || {};
            const description = typeof descObj === 'string'
                ? descObj
                : (descObj?.description || descObj?.prompt || power.persona_description || '');
            add(key, description, avatar);
            continue;
        }
        if (typeof val === 'string') {
            add(key, val, key);
            continue;
        }
        if (val && typeof val === 'object') {
            add(val.name || key, val.description || val.prompt || '', val.avatar || key);
        }
    }

    for (const [key, descObj] of Object.entries(descriptions)) {
        if (out.some(p => p.avatar === key || p.name === key)) continue;
        const description = typeof descObj === 'string'
            ? descObj
            : (descObj?.description || descObj?.prompt || '');
        if (!description && !key) continue;
        add(String(key).replace(/\.(png|jpe?g|webp|gif)$/i, ''), description, key);
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
        const name = p.name || 'Persona';
        const description = p.description || '';
        const clientKey = `persona:${p.avatar || name}`;
        const hash = await sha256Hex(JSON.stringify({ name, description }));
        if (mapGet(clientKey)?.content_hash === hash) {
            skipped++;
            continue;
        }
        // Prefer blob for lossless; also personas/import for Dashboard
        try {
            const payload = JSON.stringify({ name, description, avatar: p.avatar || '' });
            const { bytes, gzipped } = await maybeGzip(payload);
            const fd = new FormData();
            fd.append('file', new Blob([bytes], { type: gzipped ? 'application/gzip' : 'application/json' }),
                `${name.replace(/[^\w\-]+/g, '_')}.json${gzipped ? '.gz' : ''}`);
            fd.append('client_key', clientKey);
            fd.append('kind', 'persona_json');
            fd.append('name', name);
            fd.append('content_hash', hash);
            const blobRes = await apiFetch('/api/v2/st-sync/blobs', { method: 'POST', formData: fd });
            if (blobRes?.id) await mapSet(clientKey, blobRes.id, hash);

            // Dashboard-visible persona row
            const card = {
                name,
                description,
                personality: '',
                scenario: '',
                first_mes: '',
                mes_example: '',
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: { name, description, personality: '', scenario: '' },
            };
            const fd2 = new FormData();
            fd2.append('file', new Blob([JSON.stringify(card)], { type: 'application/json' }), `${name}.json`);
            fd2.append('client_key', `platform:${clientKey}`);
            fd2.append('content_hash', hash);
            fd2.append('name', name);
            fd2.append('description', description);
            await apiFetch('/api/v2/personas/import', { method: 'POST', formData: fd2 });

            if (blobRes?.skipped) skipped++;
            else n++;
            logLine(`persona OK: ${name}`);
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
            const payload = JSON.stringify(book);
            const clientKey = `lorebook:${name}`;
            const hash = await sha256Hex(payload);
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

            // Dashboard import
            const fd2 = new FormData();
            fd2.append('file', new Blob([payload], { type: 'application/json' }), `${name}.json`);
            fd2.append('client_key', `platform:${clientKey}`);
            fd2.append('content_hash', hash);
            await apiFetch('/api/v2/lorebooks/import', { method: 'POST', formData: fd2 });

            if (blobRes?.skipped) skipped++;
            else n++;
            logLine(`lorebook OK: ${name}`);
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
                const data = pm.getPresetSettings?.(name)
                    || pm.getCompletionPresetByName?.(name)
                    || (typeof pm.getPreset === 'function' ? pm.getPreset(name) : null)
                    || null;
                if (!data || typeof data !== 'object') {
                    logLine(`preset skip (no data): ${name}`);
                    continue;
                }
                const payloadObj = { ...data, name: data.name || name };
                const payload = JSON.stringify(payloadObj);
                const clientKey = `preset:${name}`;
                const hash = await sha256Hex(payload);
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

        // Lorebooks
        if (s.sync_lorebooks && (lore.lorebooks || []).length) {
            for (const lb of lore.lorebooks) {
                try {
                    setStatus(`Pull lore: ${lb.name}…`, 'busy');
                    const full = await apiFetch(`/api/v2/lorebooks/export?id=${lb.id}`);
                    const r = await importLorebookToST(full);
                    if (r.ok) imported++;
                    else {
                        downloads++;
                        const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `${(lb.name || 'lore').replace(/[^\w\-]+/g, '_')}.json`;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        URL.revokeObjectURL(url);
                    }
                } catch (e) {
                    failed++;
                    logLine(`lore ${lb.name}: ${e.message}`);
                }
            }
        }

        // Presets
        if (s.sync_presets && (presets.presets || []).length) {
            for (const pr of presets.presets) {
                try {
                    setStatus(`Pull preset: ${pr.name}…`, 'busy');
                    const full = await apiFetch(`/api/v2/presets/export?id=${pr.id}`).catch(() => pr);
                    const r = await importPresetToST(full);
                    if (r.ok) imported++;
                    else downloads++;
                } catch (e) {
                    failed++;
                    logLine(`preset ${pr.name}: ${e.message}`);
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

async function syncPush({ onlyCurrentChat = false, allChats = false } = {}) {
    if (pushInFlight) {
        setStatus('Уже идёт синхронизация…', 'busy');
        return;
    }
    pushInFlight = true;
    await loadMap();
    setStatus('Синхронизация…', 'busy');
    const s = getSettings();
    const stats = { characters: 0, chats: 0, personas: 0, lorebooks: 0, presets: 0, skipped: 0, errors: 0 };
    logLine(`push flags: char=${!!s.sync_characters} chat=${!!s.sync_chats} persona=${!!s.sync_personas} lore=${!!s.sync_lorebooks} preset=${!!s.sync_presets} gzip=${!!s.use_gzip}`);

    try {
        if (onlyCurrentChat) {
            try {
                const r = await pushCurrentChat();
                if (r?.skipped) stats.skipped++;
                else stats.chats++;
                logLine(r?.skipped ? `chat skip: ${r.reason || 'ok'}` : `chat → #${r?.chat_id}`);
            } catch (e) {
                stats.errors++;
                logLine(`chat error: ${e.message}`);
            }
            const ok = !stats.errors;
            setStatus(ok ? 'Текущий чат синхронизирован' : 'Ошибка чата (лог)', ok ? 'ok' : 'err');
            if (ok) toast('success', 'Чат сохранён в облако');
            return;
        }

        if (s.sync_chats) {
            try {
                if (allChats) {
                    const r = await pushAllChatsForCurrentCharacter();
                    stats.chats += r.pushed || 0;
                    stats.skipped += r.skipped || 0;
                    stats.errors += r.errors || 0;
                    logLine(`chats batch: +${r.pushed} skip ${r.skipped} err ${r.errors}`);
                } else {
                    const r = await pushCurrentChat();
                    if (r?.skipped) stats.skipped++;
                    else stats.chats++;
                    logLine(r?.skipped ? `chat skip: ${r.reason || 'ok'}` : `chat → #${r?.chat_id}`);
                }
            } catch (e) {
                stats.errors++;
                logLine(`chat: ${e.message}`);
            }
        }

        if (s.sync_characters) {
            const c = ctx();
            for (const char of (c.characters || [])) {
                try {
                    setStatus(`Персонаж: ${char.name || char.avatar}…`, 'busy');
                    const r = await pushCharacter(char);
                    if (r?.skipped) stats.skipped++;
                    else stats.characters++;
                } catch (e) {
                    stats.errors++;
                    logLine(`char ${char?.name}: ${e.message}`);
                }
            }
        }

        if (s.sync_personas) {
            try {
                const r = await pushPersonas();
                stats.personas += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`personas: ${e.message}`);
            }
        } else {
            logLine('personas: выкл в настройках мода (галочка)');
        }

        if (s.sync_lorebooks) {
            try {
                const r = await pushLorebooks();
                stats.lorebooks += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`lorebooks: ${e.message}`);
            }
        } else {
            logLine('lorebooks: выкл в настройках мода (галочка)');
        }

        if (s.sync_presets) {
            try {
                const r = await pushPresets();
                stats.presets += r.pushed || 0;
                stats.skipped += r.skipped || 0;
                stats.errors += r.errors || 0;
            } catch (e) {
                stats.errors++;
                logLine(`presets: ${e.message}`);
            }
        } else {
            logLine('presets: выкл в настройках мода (галочка)');
        }

        const summary = `Готово · char ${stats.characters} · chat ${stats.chats} · persona ${stats.personas} · lore ${stats.lorebooks} · preset ${stats.presets} · skip ${stats.skipped} · err ${stats.errors}`;
        setStatus(summary, stats.errors ? 'err' : 'ok');
        toast(stats.errors ? 'warning' : 'success', summary);
        logLine(summary);
    } catch (e) {
        setStatus(`Ошибка: ${e.message}`, 'err');
        toast('error', e.message);
        logLine(e.message);
    } finally {
        pushInFlight = false;
    }
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
    bindCheck('wucloud_sync_characters', 'sync_characters');
    bindCheck('wucloud_sync_chats', 'sync_chats');
    bindCheck('wucloud_sync_personas', 'sync_personas');
    bindCheck('wucloud_sync_lorebooks', 'sync_lorebooks');
    bindCheck('wucloud_sync_presets', 'sync_presets');
    bindCheck('wucloud_use_gzip', 'use_gzip');

    const auto = $('wucloud_autosave');
    if (auto) {
        auto.value = s.autosave || 'off';
        auto.addEventListener('change', () => {
            getSettings().autosave = auto.value;
            persist();
            setupIntervalAutosave();
        });
    }

    $('wucloud_push_btn')?.addEventListener('click', () => syncPush({ allChats: false }));
    $('wucloud_push_all_chats_btn')?.addEventListener('click', () => syncPush({ allChats: true }));
    $('wucloud_push_chat_btn')?.addEventListener('click', () => syncPush({ onlyCurrentChat: true }));
    $('wucloud_pull_btn')?.addEventListener('click', () => syncPull({ importCharacters: true }));
    $('wucloud_test_btn')?.addEventListener('click', () => testConnection());
    $('wucloud_log_copy')?.addEventListener('click', () => copyLog());
    $('wucloud_log_clear')?.addEventListener('click', () => clearLog());
    $('wucloud_log_popup')?.addEventListener('click', () => showLogPopup());
    renderLogPanel();
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
    logLine('WuCloud Sync 0.7.3 loaded · логи здесь + F12 Console [WuCloud], не в Server Log ST');
    setStatus('Готов · WuCloud Sync 0.7.3', 'ok');
    toast('info', 'WuCloud 0.7.3 · журнал в настройках расширения');
    console.log(LOG_PREFIX, 'loaded v0.7.3');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => jQuery(init));
} else {
    jQuery(init);
}
