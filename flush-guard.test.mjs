import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    shouldFlushChat,
    shouldRunNestDiskAutosave,
    shouldAutosaveNestSettings,
    leaveFlushStartAction,
    chatLoadedAfterEvent,
    shouldSaveCharacterCard,
    shouldSaveGroupMeta,
    worldNamesToFlush,
    NEST_DISK_AUTOSAVE_MS,
    NEST_SETTINGS_AUTOSAVE_MS,
} from './flush-guard.js';

test('welcome: no character, not loaded → no flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: undefined,
        selectedGroup: null,
        chatLoaded: false,
        isChatSaving: false,
        isStreaming: false,
    }), false);
});

test('loading: character selected but CHAT_LOADED not yet → no flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: 3,
        selectedGroup: null,
        chatLoaded: false,
        isChatSaving: false,
        isStreaming: false,
    }), false);
});

test('saving in flight → no second save', () => {
    assert.equal(shouldFlushChat({
        thisChid: 1,
        selectedGroup: null,
        chatLoaded: true,
        isChatSaving: true,
        isStreaming: false,
    }), false);
});

test('streaming reply → no flush of a partial mes', () => {
    assert.equal(shouldFlushChat({
        thisChid: 1,
        selectedGroup: null,
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: true,
    }), false);
});

test('loaded character chat → flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: 1,
        selectedGroup: null,
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), true);
});

test('this_chid 0 is a valid character index', () => {
    assert.equal(shouldFlushChat({
        thisChid: 0,
        selectedGroup: null,
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), true);
});

test('loaded group chat → flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: undefined,
        selectedGroup: 'grp-1',
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), true);
});

test('null input → no flush', () => {
    assert.equal(shouldFlushChat(null), false);
});

test('CHAT_LOADED marks session loaded', () => {
    assert.equal(chatLoadedAfterEvent('loaded', false), true);
    assert.equal(chatLoadedAfterEvent('loaded', true), true);
});

test('CHAT_CHANGED on 1:1 waits for CHAT_LOADED (ST emits CHANGED then LOADED)', () => {
    assert.equal(chatLoadedAfterEvent('changed', false), false);
});

test('CHAT_CHANGED on a group is load-complete (ST groups never emit CHAT_LOADED)', () => {
    assert.equal(chatLoadedAfterEvent('changed', true), true);
});

test('stale group load flag after switch to another group → no flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: undefined,
        selectedGroup: 'grp-2',
        loadedThisChid: undefined,
        loadedSelectedGroup: 'grp-1',
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), false);
});

test('stale group load flag after switch to a character → no flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: 3,
        selectedGroup: null,
        loadedThisChid: undefined,
        loadedSelectedGroup: 'grp-1',
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), false);
});

test('stale character load flag after switch to another character → no flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: 5,
        selectedGroup: null,
        loadedThisChid: 3,
        loadedSelectedGroup: null,
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), false);
});

test('group load snapshot matches the open group → flush', () => {
    assert.equal(shouldFlushChat({
        thisChid: undefined,
        selectedGroup: 'grp-1',
        loadedThisChid: undefined,
        loadedSelectedGroup: 'grp-1',
        chatLoaded: true,
        isChatSaving: false,
        isStreaming: false,
    }), true);
});

test('this_chid 0 → shouldSaveCharacterCard true', () => {
    assert.equal(shouldSaveCharacterCard({
        thisChid: 0,
        selectedGroup: null,
        isStreaming: false,
    }), true);
});

test('group selected → character card false, group meta true', () => {
    const s = {
        thisChid: 2,
        selectedGroup: 'grp-1',
        loadedThisChid: 2,
        loadedSelectedGroup: 'grp-1',
        isStreaming: false,
    };
    assert.equal(shouldSaveCharacterCard(s), false);
    assert.equal(shouldSaveGroupMeta(s), true);
});

test('menuType create → character card false', () => {
    assert.equal(shouldSaveCharacterCard({
        thisChid: 1,
        selectedGroup: null,
        menuType: 'create',
        isStreaming: false,
    }), false);
});

test('menuType group_create → character card false', () => {
    assert.equal(shouldSaveCharacterCard({
        thisChid: 1,
        selectedGroup: null,
        menuType: 'group_create',
        isStreaming: false,
    }), false);
});

test('streaming → character card and group meta false', () => {
    assert.equal(shouldSaveCharacterCard({
        thisChid: 1,
        selectedGroup: null,
        isStreaming: true,
    }), false);
    assert.equal(shouldSaveGroupMeta({
        thisChid: undefined,
        selectedGroup: 'grp-1',
        isStreaming: true,
    }), false);
});

test('snapshot mismatch → character card and group meta false', () => {
    assert.equal(shouldSaveCharacterCard({
        thisChid: 5,
        selectedGroup: null,
        loadedThisChid: 3,
        loadedSelectedGroup: null,
        isStreaming: false,
    }), false);
    assert.equal(shouldSaveGroupMeta({
        thisChid: undefined,
        selectedGroup: 'grp-2',
        loadedThisChid: undefined,
        loadedSelectedGroup: 'grp-1',
        isStreaming: false,
    }), false);
});

test('worldNamesToFlush: dedup, trim, skip empty, collect all sources', () => {
    assert.deepEqual(worldNamesToFlush(null), []);
    assert.deepEqual(worldNamesToFlush({
        selectedWorldInfo: [' Alpha ', 'Beta', '', 'Alpha'],
        chatWorld: 'Beta',
        characterWorld: '  Gamma  ',
        extraBooks: ['Delta', '  ', null, 'Alpha'],
        editorWorld: 'Epsilon',
        personaWorld: '  Zeta',
    }), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
});

const loadedChar = {
    thisChid: 1,
    selectedGroup: null,
    chatLoaded: true,
    isChatSaving: false,
    isStreaming: false,
};

test('greeting-only (chatLength 1) must not flush over a loaded chat', () => {
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 1, lastKnownLength: 80 }), false);
});

test('empty in-memory chat must not flush', () => {
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 0, lastKnownLength: 12 }), false);
});

test('in-memory chat shorter than last known length must not flush', () => {
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 3, lastKnownLength: 80 }), false);
});

test('grown chat at or above last known length still flushes', () => {
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 81, lastKnownLength: 80 }), true);
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 80, lastKnownLength: 80 }), true);
});

test('new greeting chat with no prior length still does not leave-flush', () => {
    assert.equal(shouldFlushChat({ ...loadedChar, chatLength: 1 }), false);
});

test('omitted chatLength keeps previous flush behaviour (other guards only)', () => {
    assert.equal(shouldFlushChat(loadedChar), true);
});

const nestAutosaveReady = {
    nestMode: true,
    settingsHydrated: true,
    busy: false,
    visible: true,
};

test('nest disk autosave runs when companion is idle and tab is visible', () => {
    assert.equal(shouldRunNestDiskAutosave(nestAutosaveReady), true);
});

test('nest disk autosave skips external ST, hidden tab, busy persist, and pre-hydrate', () => {
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, nestMode: false }), false);
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, visible: false }), false);
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, busy: true }), false);
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, settingsHydrated: false }), false);
    assert.equal(shouldRunNestDiskAutosave(null), false);
});

test('nest disk autosave skips generation and in-flight chat save (do not stall Send)', () => {
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, isStreaming: true }), false);
    assert.equal(shouldRunNestDiskAutosave({ ...nestAutosaveReady, isChatSaving: true }), false);
});

test('nest disk autosave still runs when visible is omitted', () => {
    const { visible, ...rest } = nestAutosaveReady;
    assert.equal(visible, true);
    assert.equal(shouldRunNestDiskAutosave(rest), true);
});

test('nest autosave intervals: 2 min disk, 10 min settings.json', () => {
    assert.equal(NEST_DISK_AUTOSAVE_MS, 120_000);
    assert.equal(NEST_SETTINGS_AUTOSAVE_MS, 10 * 60 * 1000);
});

test('settings.json autosave waits 10 min after last persist (incl. hydrate seed)', () => {
    const now = 1_700_000_000_000;
    assert.equal(shouldAutosaveNestSettings(0, now), true);
    assert.equal(shouldAutosaveNestSettings(now, now), false);
    assert.equal(shouldAutosaveNestSettings(now - 1000, now), false);
    assert.equal(shouldAutosaveNestSettings(now - NEST_SETTINGS_AUTOSAVE_MS + 1, now), false);
    assert.equal(shouldAutosaveNestSettings(now - NEST_SETTINGS_AUTOSAVE_MS, now), true);
    assert.equal(shouldAutosaveNestSettings(now - NEST_SETTINGS_AUTOSAVE_MS - 1, now), true);
    assert.equal(shouldAutosaveNestSettings(null, now), false);
    assert.equal(shouldAutosaveNestSettings(Number.NaN, now), false);
});

test('leave-flush queues when a persist already holds the mutex', () => {
    assert.equal(leaveFlushStartAction({ busy: true, debounceActive: false }), 'queue');
    assert.equal(leaveFlushStartAction({ busy: true, debounceActive: true }), 'queue');
});

test('leave-flush runs when idle and not debounce-suppressed', () => {
    assert.equal(leaveFlushStartAction({ busy: false, debounceActive: false }), 'run');
});

test('leave-flush skips a hide+pagehide burst after a flush already started', () => {
    assert.equal(leaveFlushStartAction({ busy: false, debounceActive: true }), 'skip');
    assert.equal(leaveFlushStartAction(null), 'skip');
});

test('queued leave-flush runs after release even when debounce is active', () => {
    assert.equal(leaveFlushStartAction({
        busy: false,
        debounceActive: true,
        queued: true,
    }), 'run');
});

test('leave-flush stays queued while another persist still holds the mutex', () => {
    assert.equal(leaveFlushStartAction({
        busy: true,
        debounceActive: true,
        queued: true,
    }), 'queue');
});
