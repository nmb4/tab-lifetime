import test from "node:test";
import assert from "node:assert/strict";

import {
  LAST_ACTIVITY_KEY,
  PERSISTED_TABS_KEY,
  SESSION_STATE_KEY,
  SETTINGS_KEY,
} from "../shared/settings.js";

class FakeEvent {
  constructor() {
    this.listeners = [];
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  emit(...args) {
    for (const listener of this.listeners) {
      listener(...args);
    }
  }
}

function clone(value) {
  return structuredClone(value);
}

function createStorageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) {
      if (typeof key === "string") {
        return { [key]: clone(values[key]) };
      }

      return Object.fromEntries(
        key.map((entry) => [entry, clone(values[entry])]),
      );
    },
    async set(valuesToSet) {
      Object.assign(values, structuredClone(valuesToSet));
    },
  };
}

test("background closes stale tabs, cancels focus, and shifts restored timers", async () => {
  const now = Date.now();
  const staleTime = now - 5 * 60 * 1000;
  let tabs = [
    { id: 1, active: true, windowId: 10 },
    { id: 2, audible: true, windowId: 10 },
    { id: 3, pinned: true, windowId: 10 },
    { id: 4, windowId: 10 },
    { id: 5, windowId: 10 },
  ];
  const local = createStorageArea({
    [SETTINGS_KEY]: {
      enabled: true,
      thresholdMinutes: 1,
    },
  });
  const session = createStorageArea({
    [SESSION_STATE_KEY]: {
      version: 1,
      tabs: {
        1: staleTime,
        2: staleTime,
        3: staleTime,
        4: staleTime,
        5: now,
      },
      lastSweepAt: 0,
      closedThisSession: 0,
    },
  });
  const alarms = new Map();

  const events = {
    installed: new FakeEvent(),
    startup: new FakeEvent(),
    message: new FakeEvent(),
    alarm: new FakeEvent(),
    tabCreated: new FakeEvent(),
    tabActivated: new FakeEvent(),
    tabUpdated: new FakeEvent(),
    tabRemoved: new FakeEvent(),
    tabReplaced: new FakeEvent(),
    windowFocus: new FakeEvent(),
  };

  globalThis.chrome = {
    storage: { local, session },
    alarms: {
      onAlarm: events.alarm,
      async get(name) {
        return alarms.get(name);
      },
      async create(name, info) {
        alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return alarms.delete(name);
      },
    },
    tabs: {
      onCreated: events.tabCreated,
      onActivated: events.tabActivated,
      onUpdated: events.tabUpdated,
      onRemoved: events.tabRemoved,
      onReplaced: events.tabReplaced,
      async get(tabId) {
        const tab = tabs.find((entry) => entry.id === tabId);
        if (!tab) {
          throw new Error(`No tab with id ${tabId}.`);
        }
        return clone(tab);
      },
      async remove(tabId) {
        tabs = tabs.filter((entry) => entry.id !== tabId);
      },
      async query(query = {}) {
        return tabs
          .filter((tab) => {
            if (query.active !== undefined && tab.active !== query.active) {
              return false;
            }
            if (
              query.windowId !== undefined &&
              tab.windowId !== query.windowId
            ) {
              return false;
            }
            return true;
          })
          .map(clone);
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.windowFocus,
    },
    runtime: {
      onInstalled: events.installed,
      onStartup: events.startup,
      onMessage: events.message,
    },
  };

  await import(`../background.js?test=${Date.now()}`);

  const send = (message) =>
    new Promise((resolve) => {
      const keepChannelOpen = events.message.listeners[0](
        message,
        {},
        resolve,
      );
      assert.equal(keepChannelOpen, true);
    });

  const firstSweep = await send({ type: "CLEAN_NOW" });
  assert.equal(firstSweep.ok, true);
  assert.equal(firstSweep.result.closedCount, 1);
  assert.deepEqual(
    tabs.map((tab) => tab.id),
    [1, 2, 3, 5],
  );

  session.values[SESSION_STATE_KEY].tabs[5] = Date.now() - 5 * 60 * 1000;
  const focusedSweep = send({ type: "CLEAN_NOW" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  events.tabActivated.emit({ tabId: 5, windowId: 10 });

  const secondSweep = await focusedSweep;
  assert.equal(secondSweep.ok, true);
  assert.equal(secondSweep.result.closedCount, 0);
  assert.equal(tabs.some((tab) => tab.id === 5), true);

  const status = await send({ type: "GET_STATUS" });
  assert.equal(status.ok, true);
  assert.equal(status.status.dueCount, 0);
  assert.equal(status.status.closedThisSession, 1);

  const persistedStaleTime = Date.now() - 5 * 60 * 1000;
  tabs = [
    { id: 21, windowId: 30, lastAccessed: Date.now() },
  ];
  local.values[PERSISTED_TABS_KEY] = {
    tabs: { 21: persistedStaleTime },
  };
  session.values[SESSION_STATE_KEY] = {
    version: 1,
    tabs: {},
    lastSweepAt: 0,
    closedThisSession: 0,
  };
  events.installed.emit({ reason: "update" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const updateStatus = await send({ type: "GET_STATUS" });
  assert.equal(updateStatus.ok, true);
  assert.equal(updateStatus.status.dueCount, 1);

  delete local.values[PERSISTED_TABS_KEY];
  local.values[LAST_ACTIVITY_KEY] = Date.now() - 16 * 60 * 60 * 1000;
  tabs = [
    {
      id: 22,
      windowId: 30,
      lastAccessed: Date.now() - 8 * 60 * 60 * 1000,
    },
  ];
  session.values[SESSION_STATE_KEY] = {
    version: 1,
    tabs: {},
    lastSweepAt: 0,
    closedThisSession: 0,
  };
  events.installed.emit({ reason: "update" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const migratedStatus = await send({ type: "GET_STATUS" });
  assert.equal(migratedStatus.ok, true);
  assert.equal(migratedStatus.status.dueCount, 1);

  const restoredAt = Date.now() - 13 * 60 * 60 * 1000;
  tabs = [
    { id: 11, active: true, windowId: 20, lastAccessed: restoredAt },
    { id: 12, windowId: 20, lastAccessed: restoredAt },
    { id: 13, windowId: 20, lastAccessed: restoredAt },
  ];
  local.values[LAST_ACTIVITY_KEY] = Date.now() - 8 * 60 * 60 * 1000;
  session.values[SESSION_STATE_KEY] = {
    version: 1,
    tabs: {
      11: Date.now(),
      12: Date.now(),
      13: Date.now(),
    },
    lastSweepAt: 0,
    closedThisSession: 0,
  };

  events.startup.emit();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const restoredStatus = await send({ type: "GET_STATUS" });
  assert.equal(restoredStatus.ok, true);
  assert.equal(restoredStatus.status.dueCount, 2);
  assert.ok(
    session.values[SESSION_STATE_KEY].tabs[12] <
      Date.now() - 7.9 * 60 * 60 * 1000,
  );
});
