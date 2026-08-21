/**
 * Pure guards for WuCloud pagehide / visibility chat flush.
 * Never save jsonl unless this session successfully loaded a chat (CHAT_LOADED).
 * this_chid 0 is a valid character index.
 *
 * @param {{
 *   thisChid?: unknown,
 *   selectedGroup?: unknown,
 *   loadedThisChid?: unknown,
 *   loadedSelectedGroup?: unknown,
 *   chatLoaded?: boolean,
 *   isChatSaving?: boolean,
 *   isStreaming?: boolean,
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
