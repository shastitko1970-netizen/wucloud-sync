import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    DISK_AUTOSAVE_TOAST_MS,
    isMutatingHttpMethod,
    isSameOriginUrl,
    requestPathname,
    isWuGatewayPath,
    isStDiskWritePath,
    isStCsrfFailClosedPath,
    csrfHintInBody,
    shouldAutoReloadOnCsrf,
    shouldShowSessionOverlay,
    shouldToastNestDiskAutosave,
    openHomeDiskFingerprint,
    nestDiskFingerprintChanged,
} from './csrf-guard.js';

const origin = 'https://nest.wuproj.com';

const saveChat = {
    alreadyVisible: false,
    status: 403,
    sameOrigin: true,
    pathname: '/api/chats/save',
    mutating: true,
    csrfHint: false,
};

test('mutating POST/PUT/PATCH/DELETE; GET/HEAD/OPTIONS are not', () => {
    assert.equal(isMutatingHttpMethod('POST'), true);
    assert.equal(isMutatingHttpMethod('put'), true);
    assert.equal(isMutatingHttpMethod('PATCH'), true);
    assert.equal(isMutatingHttpMethod('DELETE'), true);
    assert.equal(isMutatingHttpMethod('GET'), false);
    assert.equal(isMutatingHttpMethod('HEAD'), false);
    assert.equal(isMutatingHttpMethod('OPTIONS'), false);
    assert.equal(isMutatingHttpMethod(undefined), false);
});

test('same-origin: relative /api, nest host; cross-origin and empty are not', () => {
    assert.equal(isSameOriginUrl('/api/chats/save', origin), true);
    assert.equal(isSameOriginUrl('https://nest.wuproj.com/api/settings/save', origin), true);
    assert.equal(isSameOriginUrl('https://api.wuproj.com/v1/models', origin), false);
    assert.equal(isSameOriginUrl('', origin), false);
    assert.equal(isSameOriginUrl('//evil.example/api/chats/save', origin), false);
});

test('requestPathname strips query and works for relative URLs', () => {
    assert.equal(requestPathname('/api/chats/save?x=1', origin), '/api/chats/save');
    assert.equal(requestPathname('https://nest.wuproj.com/api/settings/save', origin), '/api/settings/save');
});

test('Wu gateway paths are never ST CSRF overlay', () => {
    assert.equal(isWuGatewayPath('/_nest/usage'), true);
    assert.equal(isWuGatewayPath('/_wu/api/me'), true);
    assert.equal(isWuGatewayPath('/api/chats/save'), false);
});

test('ST disk write paths cover save chat/settings/character/lore', () => {
    assert.equal(isStDiskWritePath('/api/chats/save'), true);
    assert.equal(isStDiskWritePath('/api/settings/save'), true);
    assert.equal(isStDiskWritePath('/api/characters/merge-attributes'), true);
    assert.equal(isStDiskWritePath('/api/groups/edit'), true);
    assert.equal(isStDiskWritePath('/api/worldinfo/edit'), true);
    assert.equal(isStDiskWritePath('/api/backends/chat-completions/generate'), false);
    assert.equal(isStDiskWritePath('/_nest/import'), false);
});

test('csrfHintInBody matches ST csrf-sync copy; empty is not a hint', () => {
    assert.equal(csrfHintInBody('Invalid CSRF token. Please refresh the page and try again.'), true);
    assert.equal(csrfHintInBody('csrf mismatch'), true);
    assert.equal(csrfHintInBody(''), false);
    assert.equal(csrfHintInBody('forbidden: no such user'), false);
    const expressForbidden = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Forbidden</pre>\n</body>\n</html>\n';
    assert.equal(csrfHintInBody(expressForbidden), true);
});

test('never auto-reload (reload-loop guard)', () => {
    assert.equal(shouldAutoReloadOnCsrf(), false);
});

test('403 POST /api/chats/save → overlay (fail-closed, empty body ok)', () => {
    assert.equal(shouldShowSessionOverlay(saveChat), true);
    assert.equal(shouldShowSessionOverlay({ ...saveChat, csrfHint: false }), true);
});

test('403 POST /api/settings/save → overlay', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, pathname: '/api/settings/save' }), true);
});

test('already visible → do not re-arm', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, alreadyVisible: true }), false);
});

test('GET 403 save path → no overlay', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, mutating: false }), false);
});

test('401 is not CSRF overlay', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, status: 401 }), false);
});

test('cross-origin 403 → no overlay', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, sameOrigin: false }), false);
});

test('/_nest and /_wu 403 → no overlay (no cookie leak path)', () => {
    assert.equal(shouldShowSessionOverlay({ ...saveChat, pathname: '/_nest/wipe' }), false);
    assert.equal(shouldShowSessionOverlay({ ...saveChat, pathname: '/_wu/api/me' }), false);
});

test('LLM generate 403 without csrf hint → no overlay', () => {
    assert.equal(shouldShowSessionOverlay({
        ...saveChat,
        pathname: '/api/backends/chat-completions/generate',
        csrfHint: false,
    }), false);
});

test('403 POST tokenizer count (hides Send) → overlay even without csrf word', () => {
    assert.equal(isStCsrfFailClosedPath('/api/tokenizers/openai/count'), true);
    assert.equal(isStDiskWritePath('/api/tokenizers/openai/count'), false);
    assert.equal(shouldShowSessionOverlay({
        ...saveChat,
        pathname: '/api/tokenizers/openai/count',
        csrfHint: false,
    }), true);
});

test('non-disk /api 403 with csrf hint → overlay', () => {
    assert.equal(shouldShowSessionOverlay({
        ...saveChat,
        pathname: '/api/backends/chat-completions/generate',
        csrfHint: true,
    }), true);
});

test('null / missing fields → no overlay', () => {
    assert.equal(shouldShowSessionOverlay(null), false);
    assert.equal(shouldShowSessionOverlay({}), false);
});

test('overlay decision ignores extra cookie field (must not require secrets)', () => {
    assert.equal(shouldShowSessionOverlay({
        ...saveChat,
        cookie: 'session=SHOULD_NOT_MATTER',
        csrfToken: 'SHOULD_NOT_MATTER',
    }), true);
});

const toastReady = {
    source: 'autosave',
    includeExtras: true,
    overlayVisible: false,
    fingerprintChanged: true,
    persistOk: true,
    lastToastAt: 0,
    now: 1_000_000,
    minIntervalMs: DISK_AUTOSAVE_TOAST_MS,
};

test('autosave includeExtras + dirty + first time → toast', () => {
    assert.equal(shouldToastNestDiskAutosave(toastReady), true);
});

test('leave-flush (includeExtras false) → no toast', () => {
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, includeExtras: false }), false);
});

test('Save Now button source → no quiet toast (loud toast is separate)', () => {
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, source: 'button' }), false);
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, source: 'leave' }), false);
});

test('unchanged 2-min tick → no toast', () => {
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, fingerprintChanged: false }), false);
});

test('debounce: not more than once per N minutes even if dirty', () => {
    const now = 1_000_000;
    assert.equal(shouldToastNestDiskAutosave({
        ...toastReady,
        lastToastAt: now - DISK_AUTOSAVE_TOAST_MS + 1,
        now,
    }), false);
    assert.equal(shouldToastNestDiskAutosave({
        ...toastReady,
        lastToastAt: now - DISK_AUTOSAVE_TOAST_MS,
        now,
    }), true);
});

test('CSRF overlay visible → no success toast', () => {
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, overlayVisible: true }), false);
});

test('null toast state → no toast', () => {
    assert.equal(shouldToastNestDiskAutosave(null), false);
});

test('fingerprint is stable for same home and does not embed mes text', () => {
    const a = openHomeDiskFingerprint({
        thisChid: 1,
        selectedGroup: null,
        chatLength: 12,
        lastMesLen: 40,
        lastSend: '2026-08-24',
        settingsAt: 9,
    });
    const b = openHomeDiskFingerprint({
        thisChid: 1,
        selectedGroup: null,
        chatLength: 12,
        lastMesLen: 40,
        lastSend: '2026-08-24',
        settingsAt: 9,
    });
    const dirty = openHomeDiskFingerprint({
        thisChid: 1,
        selectedGroup: null,
        chatLength: 13,
        lastMesLen: 40,
        lastSend: '2026-08-24',
        settingsAt: 9,
    });
    assert.equal(a, b);
    assert.notEqual(a, dirty);
    assert.equal(a.includes('secret mes'), false);
    assert.equal(openHomeDiskFingerprint(null), '');
});

test('failed persist → no success toast', () => {
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, persistOk: false }), false);
    assert.equal(shouldToastNestDiskAutosave({ ...toastReady, persistOk: undefined }), false);
});

test('empty last fingerprint is not dirty (unbaselined / first idle tick)', () => {
    const fp = openHomeDiskFingerprint({
        thisChid: 1,
        selectedGroup: null,
        chatLength: 12,
        lastMesLen: 40,
        lastSend: '2026-08-24',
        settingsAt: 9,
    });
    assert.equal(nestDiskFingerprintChanged('', fp), false);
    assert.equal(nestDiskFingerprintChanged(null, fp), false);
    assert.equal(nestDiskFingerprintChanged(fp, fp), false);
    assert.equal(nestDiskFingerprintChanged(fp, `${fp}|dirty`), true);
});
