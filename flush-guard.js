/**
 * Pure guards for WuCloud pagehide / visibility chat flush and «Сохранить сейчас».
 * Never save jsonl unless this session successfully loaded a chat (CHAT_LOADED).
 * this_chid 0 is a valid character index.
 */

/** Nest live-disk autosave interval (same work as «Сохранить сейчас»). */
export const NEST_DISK_AUTOSAVE_MS = 120_000;
/** Do not write settings.json on every tick — wu-8 homes are ~10 MiB. */
export const NEST_SETTINGS_AUTOSAVE_MS = 10 * 60 * 1000;

/**
 * Periodic Nest persist (not WuCloud zip). Skip if tab hidden (leave-flush
 * handles hide), if settings not hydrated, if a persist is already running,
 * or if a generation/chat-save is in flight (10 MiB settings.json stalls Send).
 *
 * @param {{
 *   nestMode?: boolean,
 *   settingsHydrated?: boolean,
 *   busy?: boolean,
 *   visible?: boolean,
 *   isStreaming?: boolean,
 *   isChatSaving?: boolean,
 * } | null | undefined} s
 * @returns {boolean}
 */
export function shouldRunNestDiskAutosave(s) {
    if (!s || typeof s !== 'object') {
        return false;
    }
    if (!s.nestMode) {
        return false;
    }
    if (!s.settingsHydrated) {
        return false;
    }
    if (s.busy) {
        return false;
    }
    if (s.isStreaming) {
        return false;
    }
    if (s.isChatSaving) {
        return false;
    }
    if (s.visible === false) {
        return false;
    }
    return true;
}

/**
 * Throttle settings.json on Nest autosave ticks. Leave-flush and Save Now
 * still pass persistSettings=true. lastPersistAt=0 means never written.
 *
 * @param {unknown} lastPersistAt
 * @param {unknown} [now]
 * @returns {boolean}
 */
export function shouldAutosaveNestSettings(lastPersistAt, now = Date.now()) {
    if (typeof lastPersistAt !== 'number' || typeof now !== 'number') {
        return false;
    }
    if (!Number.isFinite(lastPersistAt) || !Number.isFinite(now)) {
        return false;
    }
    return (now - lastPersistAt) >= NEST_SETTINGS_AUTOSAVE_MS;
}

/**
 * Hide/pagehide leave-flush while a persist holds the shared mutex.
 * Queue so the leave retries after the in-flight persist; do not drop it.
 * Debounce only applies when idle (hide+pagehide burst after a flush started).
 * A leave already queued during another persist must run on drain.
 *
 * @param {{ busy?: boolean, debounceActive?: boolean, queued?: boolean } | null | undefined} s
 * @returns {'run' | 'queue' | 'skip'}
 */
export function leaveFlushStartAction(s) {
    if (!s || typeof s !== 'object') {
        return 'skip';
    }
    if (s.busy) {
        return 'queue';
    }
    if (s.queued) {
        return 'run';
    }
    if (s.debounceActive) {
        return 'skip';
    }
    return 'run';
}

/**
 * @param {{
 *   thisChid?: unknown,
 *   selectedGroup?: unknown,
 *   loadedThisChid?: unknown,
 *   loadedSelectedGroup?: unknown,
 *   chatLoaded?: boolean,
 *   isChatSaving?: boolean,
 *   isStreaming?: boolean,
 *   menuType?: unknown,
 *   chatLength?: number,
 *   lastKnownLength?: number,
 * } | null | undefined} s
 * @returns {boolean}
 */
export function shouldFlushChat(s) {
    if (!s || typeof s !== 'object') {
        return false;
    }
    if (s.isChatSaving) {
        return false;
    }
    if (s.isStreaming) {
        return false;
    }
    if (!s.chatLoaded) {
        return false;
    }
    if (!_hasEntity(s.thisChid) && !_hasEntity(s.selectedGroup)) {
        return false;
    }
    if (_hasLoadedSnapshot(s) && !_sameEntity(s)) {
        return false;
    }
    if (typeof s.chatLength === 'number') {
        if (s.chatLength <= 1) {
            return false;
        }
        if (typeof s.lastKnownLength === 'number'
            && s.lastKnownLength > 1
            && s.chatLength < s.lastKnownLength) {
            return false;
        }
    }
    return true;
}

/**
 * ST 1.18 getChat: getChatResult emits CHAT_CHANGED, then CHAT_LOADED (1:1 only).
 * Groups emit CHAT_CHANGED after printMessages and never CHAT_LOADED.
 *
 * @param {'loaded' | 'changed'} kind
 * @param {boolean} hasGroup
 * @returns {boolean}
 */
export function chatLoadedAfterEvent(kind, hasGroup) {
    if (kind === 'loaded') {
        return true;
    }
    if (kind === 'changed') {
        return !!hasGroup;
    }
    return false;
}

/**
 * 1:1 character card + avatar (ST #create_button / createOrEditCharacter).
 * Not during group chats or the "new character" form.
 *
 * @param {object | null | undefined} s
 * @returns {boolean}
 */
export function shouldSaveCharacterCard(s) {
    if (!s || typeof s !== 'object') return false;
    if (s.isStreaming) return false;
    if (_hasEntity(s.selectedGroup)) return false;
    if (!_hasEntity(s.thisChid)) return false;
    if (s.menuType === 'create' || s.menuType === 'group_create') return false;
    if (_hasLoadedSnapshot(s) && !_sameEntity(s)) return false;
    return true;
}

/**
 * Group metadata (ST editGroup). Does not write member jsonl.
 *
 * @param {object | null | undefined} s
 * @returns {boolean}
 */
export function shouldSaveGroupMeta(s) {
    if (!s || typeof s !== 'object') return false;
    if (s.isStreaming) return false;
    if (!_hasEntity(s.selectedGroup)) return false;
    if (_hasLoadedSnapshot(s) && !_sameEntity(s)) return false;
    return true;
}

/**
 * Deduped lorebook names currently bound to the open home.
 * Empty / whitespace names are dropped.
 *
 * @param {{
 *   selectedWorldInfo?: unknown,
 *   chatWorld?: unknown,
 *   characterWorld?: unknown,
 *   extraBooks?: unknown,
 *   editorWorld?: unknown,
 *   personaWorld?: unknown,
 * } | null | undefined} s
 * @returns {string[]}
 */
export function worldNamesToFlush(s) {
    const out = [];
    const add = (n) => {
        if (typeof n !== 'string') return;
        const t = n.trim();
        if (!t || out.includes(t)) return;
        out.push(t);
    };
    if (!s || typeof s !== 'object') return out;
    if (Array.isArray(s.selectedWorldInfo)) s.selectedWorldInfo.forEach(add);
    add(s.chatWorld);
    add(s.characterWorld);
    if (Array.isArray(s.extraBooks)) s.extraBooks.forEach(add);
    add(s.editorWorld);
    add(s.personaWorld);
    return out;
}

function _hasEntity(v) {
    return v !== undefined && v !== null && v !== '';
}

function _entityKey(thisChid, selectedGroup) {
    if (_hasEntity(selectedGroup)) {
        return `g:${String(selectedGroup)}`;
    }
    if (_hasEntity(thisChid)) {
        return `c:${String(thisChid)}`;
    }
    return '';
}

function _hasLoadedSnapshot(s) {
    return _hasEntity(s.loadedThisChid) || _hasEntity(s.loadedSelectedGroup);
}

function _sameEntity(s) {
    return _entityKey(s.thisChid, s.selectedGroup) === _entityKey(s.loadedThisChid, s.loadedSelectedGroup);
}
