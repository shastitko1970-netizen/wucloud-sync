/**
 * WuCloud Sync — SillyTavern extension
 * Cloud backup to WuProj (api.wuproj.com): characters, chats, personas, lorebooks, presets.
 * Install: Extensions → Install extension → https://github.com/shastitko1970-netizen/wucloud-sync
 */
import { getContext, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'wucloud-sync';
const FOLDER = `third-party/${MODULE}`;
const LOG_PREFIX = '[WuCloud]';

const defaultSettings = Object.freeze({
    api_key: '',
    base_url: 'https://api.wuproj.com',
    sync_characters: true,
    sync_chats: true,
    sync_personas: false,
    sync_lorebooks: false,
    sync_presets: false,
    autosave: 'off', // off | message | interval
    debounce_sec: 8,
    /** @type {Record<string, { cloud_id?: number, content_hash?: string }>} */
    map: {},
});

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

function getSettings() {
    if (!extension_settings[MODULE]) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE], key)) {
            extension_settings[MODULE][key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!extension_settings[MODULE].map || typeof extension_settings[MODULE].map !== 'object') {
        extension_settings[MODULE].map = {};
    }
    return extension_settings[MODULE];
}

function persist() {
    try {
        saveSettingsDebounced();
    } catch (e) {
        console.warn(LOG_PREFIX, 'saveSettingsDebounced failed', e);
    }
}

function setStatus(msg, kind = '') {
    const el = document.getElementById('wucloud_status');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('is-ok', 'is-err', 'is-busy');
    if (kind) el.classList.add(`is-${kind}`);
}

function logLine(line) {
    const el = document.getElementById('wucloud_log');
    if (!el) return;
    const t = new Date().toLocaleTimeString();
    el.textContent = `[${t}] ${line}\n` + (el.textContent || '');
    console.log(LOG_PREFIX, line);
}

function baseUrl() {
    const s = getSettings();
    return (s.base_url || 'https://api.wuproj.com').replace(/\/+$/, '');
}

function apiKey() {
    return (getSettings().api_key || '').trim();
}

async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function mapGet(key) {
    return getSettings().map[key] || null;
}

function mapSet(key, cloudId, hash) {
    const s = getSettings();
    s.map[key] = { cloud_id: cloudId, content_hash: hash };
    persist();
}

async function apiFetch(path, { method = 'GET', body = null, formData = null } = {}) {
    const key = apiKey();
    if (!key) throw new Error('Введите API-ключ wu-…');

    const headers = { Authorization: `Bearer ${key}` };
    let payload = body;
    if (formData) {
        payload = formData;
    } else if (body && typeof body === 'object' && !(body instanceof Blob)) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }

    const res = await fetch(`${baseUrl()}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* raw */ }
    if (!res.ok) {
        const errMsg = (json && (json.error || json.message)) || text || res.statusText;
        throw new Error(`${res.status}: ${errMsg}`);
    }
    return json;
}

// ─── Characters ───────────────────────────────────────────────────────────

async function pushCharacter(char) {
    if (!char?.avatar) return { skipped: true, reason: 'no avatar' };
    const clientKey = `char:${char.avatar}`;
    const avatarUrl = `/characters/${char.avatar}`;
    const avatarRes = await fetch(avatarUrl);
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
    fd.append('file', blob, char.avatar.endsWith('.png') ? char.avatar : `${char.avatar}.png`);
    fd.append('client_key', clientKey);
    fd.append('content_hash', hash);

    const res = await apiFetch('/api/v2/characters/import', { method: 'POST', formData: fd });
    const id = res?.id || res?.data?.id;
    if (id) mapSet(clientKey, id, hash);
    return res;
}

// ─── Chats (JSONL) ────────────────────────────────────────────────────────

function currentChatFileName(c) {
    // ST exposes chat file name in various places depending on version
    return c?.chatMetadata?.file_name
        || c?.name2
        || (c?.characters?.[c?.characterId]?.avatar || 'chat')
        || 'chat';
}

function buildChatJsonl(c) {
    const chat = c.chat || [];
    // Minimal ST-compatible lines: metadata + messages with mes
    const lines = [];
    const meta = {
        user_name: c.name1 || 'User',
        character_name: c.name2 || 'Character',
        create_date: Date.now(),
        chat_metadata: c.chatMetadata || {},
    };
    lines.push(JSON.stringify(meta));
    for (const m of chat) {
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

async function pushCurrentChat() {
    const c = ctx();
    if (!c?.chat?.length) return { skipped: true, reason: 'empty chat' };

    const char = c.characters?.[c.characterId];
    const avatar = char?.avatar || 'unknown';
    // Prefer real file name if available on metadata
    const fileHint = c.getCurrentChatId?.() || c.chatId || currentChatFileName(c);
    const clientKey = `chat:${avatar}:${fileHint}`;
    const jsonl = buildChatJsonl(c);
    const hash = await sha256Hex(jsonl);

    const prev = mapGet(clientKey);
    if (prev?.content_hash === hash && prev.cloud_id) {
        return { skipped: true, reason: 'unchanged', id: prev.cloud_id };
    }

    const blob = new Blob([jsonl], { type: 'application/jsonl' });
    const fd = new FormData();
    const safeName = String(fileHint).replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'chat';
    fd.append('file', blob, `${safeName}.jsonl`);
    fd.append('client_key', clientKey);
    fd.append('content_hash', hash);
    fd.append('title', `${char?.name || avatar} · ${safeName}`);

    const res = await apiFetch('/api/v2/chats/import', { method: 'POST', formData: fd });
    const id = res?.chat_id;
    if (id) mapSet(clientKey, id, hash);
    return res;
}

// ─── Personas ─────────────────────────────────────────────────────────────

async function pushPersonas() {
    const c = ctx();
    // power_user.personas is the usual store
    const personas = c.powerUser?.personas || c.power_user?.personas || {};
    const descriptions = c.powerUser?.persona_descriptions || c.power_user?.persona_descriptions || {};
    const names = Object.keys(personas);
    let n = 0, skipped = 0;
    for (const name of names) {
        const descObj = descriptions[name] || {};
        const description = typeof descObj === 'string' ? descObj : (descObj.description || descObj.prompt || '');
        const clientKey = `persona:${name}`;
        const payload = JSON.stringify({ name, description });
        const hash = await sha256Hex(payload);
        const prev = mapGet(clientKey);
        if (prev?.content_hash === hash) {
            skipped++;
            continue;
        }
        // Reuse persona import: send a minimal card-like JSON
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
        const blob = new Blob([JSON.stringify(card)], { type: 'application/json' });
        const fd = new FormData();
        fd.append('file', blob, `${name}.json`);
        fd.append('client_key', clientKey);
        fd.append('content_hash', hash);
        fd.append('name', name);
        fd.append('description', description);
        try {
            const res = await apiFetch('/api/v2/personas/import', { method: 'POST', formData: fd });
            const id = res?.persona?.id || res?.id;
            if (id) mapSet(clientKey, id, hash);
            n++;
        } catch (e) {
            logLine(`persona ${name}: ${e.message}`);
        }
    }
    return { pushed: n, skipped };
}

// ─── Lorebooks ────────────────────────────────────────────────────────────

async function pushLorebooks() {
    const c = ctx();
    const wi = c.worldInfo || c.world_info;
    // ST world_names + world_info
    const names = c.worldInfoSettings?.world_names
        || c.world_names
        || (typeof world_names !== 'undefined' ? world_names : [])
        || [];
    // Fallback: only currently selected
    const list = Array.isArray(names) && names.length ? names : [];
    let n = 0, skipped = 0;

    // Prefer exporting via ST if available
    for (const name of list) {
        try {
            const clientKey = `lorebook:${name}`;
            // Attempt to load book data from context worldInfoData if matches
            let book = null;
            if (c.worldInfoData && (c.worldInfoData.name === name || !list.length)) {
                book = c.worldInfoData;
            }
            // If no structured data, skip silently (full export needs ST internal API)
            if (!book && typeof c.loadWorldInfo === 'function') {
                book = await c.loadWorldInfo(name);
            }
            if (!book) {
                skipped++;
                continue;
            }
            const payload = JSON.stringify(book);
            const hash = await sha256Hex(payload);
            const prev = mapGet(clientKey);
            if (prev?.content_hash === hash) {
                skipped++;
                continue;
            }
            const blob = new Blob([payload], { type: 'application/json' });
            const fd = new FormData();
            fd.append('file', blob, `${name}.json`);
            fd.append('client_key', clientKey);
            fd.append('content_hash', hash);
            const res = await apiFetch('/api/v2/lorebooks/import', { method: 'POST', formData: fd });
            const id = res?.id;
            if (id) mapSet(clientKey, id, hash);
            n++;
        } catch (e) {
            logLine(`lorebook ${name}: ${e.message}`);
        }
    }
    return { pushed: n, skipped };
}

// ─── Presets ──────────────────────────────────────────────────────────────

async function pushPresets() {
    const c = ctx();
    let n = 0, skipped = 0;
    try {
        const pm = c.getPresetManager?.();
        if (!pm) return { pushed: 0, skipped: 0, reason: 'no preset manager' };
        const name = pm.getSelectedPresetName?.() || pm.getAllPresets?.()?.[0];
        if (!name) return { pushed: 0, skipped: 0 };
        const data = pm.getPresetSettings?.(name) || pm.getCompletionPresetByName?.(name);
        if (!data) return { pushed: 0, skipped: 0 };
        const payloadObj = typeof data === 'object' ? { ...data, name: data.name || name } : { name, raw: data };
        const payload = JSON.stringify(payloadObj);
        const clientKey = `preset:${name}`;
        const hash = await sha256Hex(payload);
        const prev = mapGet(clientKey);
        if (prev?.content_hash === hash) return { pushed: 0, skipped: 1 };
        await apiFetch('/api/v2/presets/import', { method: 'POST', body: payloadObj });
        // presets import has no client_key yet — still count as pushed
        mapSet(clientKey, 0, hash);
        n = 1;
    } catch (e) {
        logLine(`preset: ${e.message}`);
    }
    return { pushed: n, skipped };
}

// ─── Orchestration ────────────────────────────────────────────────────────

async function syncPush({ onlyCurrentChat = false } = {}) {
    if (pushInFlight) {
        setStatus('Уже идёт синхронизация…', 'busy');
        return;
    }
    pushInFlight = true;
    setStatus('Синхронизация…', 'busy');
    const s = getSettings();
    const stats = { characters: 0, chats: 0, personas: 0, lorebooks: 0, presets: 0, skipped: 0, errors: 0 };

    try {
        if (onlyCurrentChat || s.sync_chats) {
            try {
                const r = await pushCurrentChat();
                if (r?.skipped) stats.skipped++;
                else if (r?.chat_id || r?.updated) stats.chats++;
                logLine(r?.skipped ? `chat skip: ${r.reason || 'ok'}` : `chat → cloud #${r?.chat_id}`);
            } catch (e) {
                stats.errors++;
                logLine(`chat error: ${e.message}`);
            }
            if (onlyCurrentChat) {
                setStatus(stats.errors ? 'Чат: ошибка (см. лог)' : 'Текущий чат синхронизирован', stats.errors ? 'err' : 'ok');
                return;
            }
        }

        if (s.sync_characters) {
            const c = ctx();
            const chars = c.characters || [];
            for (const char of chars) {
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
            } catch (e) {
                stats.errors++;
                logLine(`personas: ${e.message}`);
            }
        }

        if (s.sync_lorebooks) {
            try {
                const r = await pushLorebooks();
                stats.lorebooks += r.pushed || 0;
                stats.skipped += r.skipped || 0;
            } catch (e) {
                stats.errors++;
                logLine(`lorebooks: ${e.message}`);
            }
        }

        if (s.sync_presets) {
            try {
                const r = await pushPresets();
                stats.presets += r.pushed || 0;
                stats.skipped += r.skipped || 0;
            } catch (e) {
                stats.errors++;
                logLine(`presets: ${e.message}`);
            }
        }

        const summary = `Готово · char ${stats.characters} · chat ${stats.chats} · persona ${stats.personas} · lore ${stats.lorebooks} · preset ${stats.presets} · skip ${stats.skipped} · err ${stats.errors}`;
        setStatus(summary, stats.errors ? 'err' : 'ok');
        logLine(summary);
    } catch (e) {
        setStatus(`Ошибка: ${e.message}`, 'err');
        logLine(e.message);
    } finally {
        pushInFlight = false;
    }
}

async function syncPull() {
    setStatus('Загрузка списков…', 'busy');
    try {
        const [chars, chats, personas, lore, presets, quotas] = await Promise.all([
            apiFetch('/api/v2/characters').catch(() => ({ characters: [] })),
            apiFetch('/api/v2/chats').catch(() => ({ chats: [] })),
            apiFetch('/api/v2/personas').catch(() => ({ personas: [] })),
            apiFetch('/api/v2/lorebooks').catch(() => ({ lorebooks: [] })),
            apiFetch('/api/v2/presets').catch(() => ({ presets: [] })),
            apiFetch('/api/v2/user/quotas').catch(() => null),
        ]);
        const msg = [
            `В облаке: chars ${(chars.characters || []).length}`,
            `chats ${(chats.chats || []).length}`,
            `personas ${(personas.personas || []).length}`,
            `lore ${(lore.lorebooks || []).length}`,
            `presets ${(presets.presets || []).length}`,
        ].join(' · ');
        setStatus(msg + ' · полный Pull в ST — в след. версии (см. Файлы ИИ)', 'ok');
        logLine(msg);
        if (quotas?.usage) {
            logLine(`quota chats ${quotas.usage.chats || 0} / ${quotas.limits?.chats ?? '∞'}`);
        }
    } catch (e) {
        setStatus(`Pull error: ${e.message}`, 'err');
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

    const auto = $('wucloud_autosave');
    if (auto) {
        auto.value = s.autosave || 'off';
        auto.addEventListener('change', () => {
            getSettings().autosave = auto.value;
            persist();
            setupIntervalAutosave();
        });
    }

    $('wucloud_push_btn')?.addEventListener('click', () => syncPush());
    $('wucloud_push_chat_btn')?.addEventListener('click', () => syncPush({ onlyCurrentChat: true }));
    $('wucloud_pull_btn')?.addEventListener('click', () => syncPull());
}

async function init() {
    getSettings();
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
            if (host) {
                // Avoid double inject
                if (!document.getElementById('wucloud-sync-panel')) {
                    host.insertAdjacentHTML('beforeend', html);
                }
            }
        }
    } catch (e) {
        console.error(LOG_PREFIX, 'UI inject failed', e);
    }

    bindUi();
    bindEvents();
    setupIntervalAutosave();
    setStatus('Готов · WuCloud Sync 1.1.0', 'ok');
    console.log(LOG_PREFIX, 'loaded');
}

// Boot when DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => jQuery(init));
} else {
    jQuery(init);
}
