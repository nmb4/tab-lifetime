import {
  ALARM_NAME,
  LAST_ACTIVITY_KEY,
  PERSISTED_TABS_KEY,
  SESSION_STATE_KEY,
  SETTINGS_KEY,
  SWEEP_PERIOD_MINUTES,
  normalizeSettings,
} from "./shared/settings.js";
import { getTabPlan, isTabProtected } from "./shared/tab-policy.js";

const STATE_VERSION = 1;
const CLOSE_GRACE_MS = 1_500;
const STARTUP_RESTORE_WINDOW_MS = 60_000;
const STARTUP_FRESH_TAB_WINDOW_MS = 5 * 60 * 1000;

let mutationQueue = Promise.resolve();
let heartbeatQueue = Promise.resolve();
let persistenceQueue = Promise.resolve();
let sweepInFlight = null;
let startupRestorePromise = Promise.resolve();
let startupRestoreUntil = 0;
let startupOfflineDurationMs = 0;
const closingCandidates = new Map();

function enqueue(task) {
  const result = mutationQueue.then(task);
  mutationQueue = result.catch(() => undefined);
  return result;
}

function normalizeSessionState(value) {
  const candidate = value && typeof value === "object" ? value : {};
  const tabs = {};

  if (candidate.tabs && typeof candidate.tabs === "object") {
    for (const [tabId, timestamp] of Object.entries(candidate.tabs)) {
      const normalizedId = Number(tabId);
      const normalizedTimestamp = Number(timestamp);

      if (
        Number.isInteger(normalizedId) &&
        normalizedId >= 0 &&
        Number.isFinite(normalizedTimestamp)
      ) {
        tabs[normalizedId] = normalizedTimestamp;
      }
    }
  }

  return {
    version: STATE_VERSION,
    tabs,
    lastSweepAt: Number(candidate.lastSweepAt) || 0,
    closedThisSession: Number(candidate.closedThisSession) || 0,
  };
}

async function readSessionState() {
  const stored = await chrome.storage.session.get(SESSION_STATE_KEY);
  return normalizeSessionState(stored[SESSION_STATE_KEY]);
}

async function mutateSessionState(mutator) {
  return enqueue(async () => {
    const stored = await chrome.storage.session.get(SESSION_STATE_KEY);
    const state = normalizeSessionState(stored[SESSION_STATE_KEY]);
    const result = await mutator(state);

    await chrome.storage.session.set({ [SESSION_STATE_KEY]: state });
    return result;
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function saveSettings(settings) {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

async function readLastActivityAt() {
  const stored = await chrome.storage.local.get(LAST_ACTIVITY_KEY);
  const timestamp = Number(stored[LAST_ACTIVITY_KEY]);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

async function recordLastActivityAt(timestamp) {
  const candidate = Number(timestamp);
  if (!Number.isFinite(candidate) || candidate <= 0) {
    return;
  }

  const task = heartbeatQueue.then(async () => {
    const stored = await chrome.storage.local.get(LAST_ACTIVITY_KEY);
    const previous = Number(stored[LAST_ACTIVITY_KEY]);
    const latest = Math.max(
      Number.isFinite(previous) && previous > 0 ? previous : 0,
      candidate,
    );
    await chrome.storage.local.set({ [LAST_ACTIVITY_KEY]: latest });
  });

  heartbeatQueue = task.catch(() => undefined);
  await task;
}

async function getStartupOfflineDuration(now) {
  const lastActivityAt = await readLastActivityAt();
  return lastActivityAt === null ? 0 : Math.max(0, now - lastActivityAt);
}

async function inferOfflineDuration(tabs, now) {
  const nativeTimestamps = tabs
    .map((tab) => nativeLastActiveAt(tab, now))
    .filter((timestamp) => timestamp !== null);
  const newestNativeTimestamp = Math.max(0, ...nativeTimestamps);

  if (now - newestNativeTimestamp < STARTUP_FRESH_TAB_WINDOW_MS) {
    return 0;
  }

  const lastActivityAt = await readLastActivityAt();
  return lastActivityAt === null
    ? 0
    : Math.max(0, newestNativeTimestamp - lastActivityAt);
}

function normalizePersistedTabs(value) {
  const candidate = value && typeof value === "object" ? value.tabs : value;
  const tabs = {};

  if (candidate && typeof candidate === "object") {
    for (const [tabId, timestamp] of Object.entries(candidate)) {
      const normalizedId = Number(tabId);
      const normalizedTimestamp = Number(timestamp);
      if (
        Number.isInteger(normalizedId) &&
        normalizedId >= 0 &&
        Number.isFinite(normalizedTimestamp) &&
        normalizedTimestamp > 0
      ) {
        tabs[normalizedId] = normalizedTimestamp;
      }
    }
  }

  return tabs;
}

async function readPersistedTabs() {
  const stored = await chrome.storage.local.get(PERSISTED_TABS_KEY);
  return normalizePersistedTabs(stored[PERSISTED_TABS_KEY]);
}

async function persistTabSnapshot(tabs) {
  const snapshot = normalizePersistedTabs(tabs);
  const task = persistenceQueue.then(async () => {
    await chrome.storage.local.set({
      [PERSISTED_TABS_KEY]: { tabs: snapshot },
    });
  });

  persistenceQueue = task.catch(() => undefined);
  await task;
}

async function persistTabTimestamp(tabId, timestamp) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  const task = persistenceQueue.then(async () => {
    const stored = await chrome.storage.local.get(PERSISTED_TABS_KEY);
    const tabs = normalizePersistedTabs(stored[PERSISTED_TABS_KEY]);
    const normalizedTimestamp = Number(timestamp);
    if (Number.isFinite(normalizedTimestamp) && normalizedTimestamp > 0) {
      tabs[tabId] = normalizedTimestamp;
    }
    await chrome.storage.local.set({ [PERSISTED_TABS_KEY]: { tabs } });
  });

  persistenceQueue = task.catch(() => undefined);
  await task;
}

async function removePersistedTab(tabId) {
  const task = persistenceQueue.then(async () => {
    const stored = await chrome.storage.local.get(PERSISTED_TABS_KEY);
    const tabs = normalizePersistedTabs(stored[PERSISTED_TABS_KEY]);
    delete tabs[tabId];
    await chrome.storage.local.set({ [PERSISTED_TABS_KEY]: { tabs } });
  });

  persistenceQueue = task.catch(() => undefined);
  await task;
}

async function syncAlarm(settings) {
  if (!settings.enabled) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== SWEEP_PERIOD_MINUTES) {
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: SWEEP_PERIOD_MINUTES,
      periodInMinutes: SWEEP_PERIOD_MINUTES,
    });
  }
}

function trackableTabIds(tabs) {
  return new Set(
    tabs
      .map((tab) => tab.id)
      .filter((tabId) => Number.isInteger(tabId) && tabId >= 0),
  );
}

function nativeLastActiveAt(tab, now) {
  const timestamp = Number(tab?.lastAccessed);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.min(timestamp, now)
    : null;
}

function restoredLastActiveAt(tab, now, offlineDurationMs = 0) {
  const nativeTimestamp = nativeLastActiveAt(tab, now);
  if (nativeTimestamp === null) {
    return now;
  }

  return Math.max(
    0,
    Math.min(now, nativeTimestamp - Math.max(0, offlineDurationMs)),
  );
}

function startupTabTimestamp(tab, now, offlineDurationMs) {
  if (tab.active) {
    return now;
  }

  const nativeTimestamp = nativeLastActiveAt(tab, now);
  if (
    nativeTimestamp === null ||
    nativeTimestamp > now - STARTUP_FRESH_TAB_WINDOW_MS
  ) {
    return now;
  }

  return restoredLastActiveAt(tab, now, offlineDurationMs);
}

async function ensureTracked(
  tabs,
  mode = "preserve",
  offlineDurationMs = 0,
  persistedTabs = {},
) {
  const now = Date.now();
  const openTabs = tabs.filter(
    (tab) => Number.isInteger(tab.id) && tab.id >= 0,
  );
  const openTabIds = new Set(openTabs.map((tab) => tab.id));

  await mutateSessionState((state) => {
    for (const tabId of Object.keys(state.tabs)) {
      if (!openTabIds.has(Number(tabId))) {
        delete state.tabs[tabId];
      }
    }

    for (const tab of openTabs) {
      const nativeTimestamp = nativeLastActiveAt(tab, now);
      const persistedTimestamp = Number(persistedTabs?.[tab.id]);
      const existingTimestamp = state.tabs[tab.id];

      if (mode === "reset") {
        state.tabs[tab.id] = now;
      } else if (mode === "restore") {
        state.tabs[tab.id] = startupTabTimestamp(
          tab,
          now,
          offlineDurationMs,
        );
      } else if (mode === "persisted") {
        state.tabs[tab.id] =
          Number.isFinite(persistedTimestamp) && persistedTimestamp > 0
            ? Math.min(persistedTimestamp, now)
            : nativeTimestamp ?? now;
      } else if (
        (!Number.isFinite(existingTimestamp) || existingTimestamp <= 0) &&
        Number.isFinite(persistedTimestamp) &&
        persistedTimestamp > 0
      ) {
        state.tabs[tab.id] = Math.min(persistedTimestamp, now);
      } else if (
        (!Number.isFinite(existingTimestamp) || existingTimestamp <= 0) &&
        nativeTimestamp !== null
      ) {
        state.tabs[tab.id] = nativeTimestamp;
      } else if (!Number.isFinite(existingTimestamp) || existingTimestamp <= 0) {
        state.tabs[tab.id] = now;
      }
    }
  });
}

function cancelClosingCandidate(tabId) {
  closingCandidates.delete(tabId);
}

async function touchTab(
  tabId,
  timestamp = Date.now(),
  cancelPendingClose = true,
) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  if (cancelPendingClose) {
    cancelClosingCandidate(tabId);
  }

  await mutateSessionState((state) => {
    state.tabs[tabId] = timestamp;
  });
  await persistTabTimestamp(tabId, timestamp).catch((error) => {
    console.warn("Tab Lifetime could not persist a tab timer.", error);
  });
}

async function buildStatus(settings) {
  const activeSettings = settings ?? (await getSettings());
  const [tabs, state] = await Promise.all([
    chrome.tabs.query({}),
    readSessionState(),
  ]);
  const plan = getTabPlan(tabs, state.tabs, activeSettings);

  return {
    ...plan.summary,
    lastSweepAt: state.lastSweepAt,
    closedThisSession: state.closedThisSession,
  };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function closeCandidate(candidate) {
  const { tab, lastActiveAt } = candidate;
  const token = Symbol(tab.id);
  closingCandidates.set(tab.id, token);

  await wait(CLOSE_GRACE_MS);

  if (closingCandidates.get(tab.id) !== token) {
    return false;
  }

  try {
    const [currentTab, state, currentSettings] = await Promise.all([
      chrome.tabs.get(tab.id),
      readSessionState(),
      getSettings(),
    ]);
    const currentLastActiveAt = state.tabs[tab.id];

    if (!currentSettings.enabled) {
      return false;
    }

    if (
      !Number.isFinite(currentLastActiveAt) ||
      currentLastActiveAt <= 0 ||
      currentLastActiveAt !== lastActiveAt
    ) {
      return false;
    }

    if (
      Date.now() - currentLastActiveAt <
        currentSettings.thresholdMinutes * 60 * 1000
    ) {
      return false;
    }

    if (isTabProtected(currentTab)) {
      return false;
    }

    if (closingCandidates.get(tab.id) !== token) {
      return false;
    }

    await chrome.tabs.remove(tab.id);
    return true;
  } catch (error) {
    console.warn(`Tab Lifetime could not close tab ${tab.id}.`, error);
    return false;
  } finally {
    if (closingCandidates.get(tab.id) === token) {
      closingCandidates.delete(tab.id);
    }
  }
}

async function performSweep(reason) {
  await startupRestorePromise.catch(() => undefined);
  const settings = await getSettings();
  if (!settings.enabled) {
    return { reason, closedCount: 0, checkedCount: 0, skipped: true };
  }

  const tabs = await chrome.tabs.query({});
  const persistedTabs = await readPersistedTabs();
  await ensureTracked(tabs, "preserve", 0, persistedTabs);
  const state = await readSessionState();
  const now = Date.now();
  const plan = getTabPlan(tabs, state.tabs, settings, now);
  const outcomes = await Promise.all(
    plan.closableTabs.map((candidate) => closeCandidate(candidate)),
  );
  const closedIds = plan.closableTabs
    .filter((_, index) => outcomes[index])
    .map(({ tab }) => tab.id);
  const sweptAt = Date.now();
  const currentTabs = await chrome.tabs.query({});

  const sweepState = await mutateSessionState((currentState) => {
    const openTabIds = trackableTabIds(currentTabs);
    let newestTimestamp = 0;

    for (const tabId of Object.keys(currentState.tabs)) {
      if (!openTabIds.has(Number(tabId))) {
        delete currentState.tabs[tabId];
      }
    }

    for (const tabId of closedIds) {
      delete currentState.tabs[tabId];
    }

    for (const tab of currentTabs) {
      if (!Number.isInteger(tab.id) || tab.id < 0) {
        continue;
      }

      const existingTimestamp = currentState.tabs[tab.id];
      if (!Number.isFinite(existingTimestamp) || existingTimestamp <= 0) {
        currentState.tabs[tab.id] = nativeLastActiveAt(tab, sweptAt) ?? sweptAt;
      }
      newestTimestamp = Math.max(newestTimestamp, currentState.tabs[tab.id]);
    }

    currentState.lastSweepAt = sweptAt;
    currentState.closedThisSession += closedIds.length;
    return {
      latestActivity: newestTimestamp,
      tabs: { ...currentState.tabs },
    };
  });

  await Promise.all([
    recordLastActivityAt(sweepState.latestActivity).catch((error) => {
      console.warn("Tab Lifetime could not save its activity heartbeat.", error);
    }),
    persistTabSnapshot(sweepState.tabs).catch((error) => {
      console.warn("Tab Lifetime could not persist its tab snapshot.", error);
    }),
  ]);

  return {
    reason,
    closedCount: closedIds.length,
    checkedCount: plan.summary.eligibleCount,
    skipped: false,
  };
}

async function sweepTabs(reason) {
  if (sweepInFlight) {
    return sweepInFlight;
  }

  sweepInFlight = performSweep(reason);
  try {
    return await sweepInFlight;
  } finally {
    sweepInFlight = null;
  }
}

async function initialize(
  reason,
  trackingMode = "preserve",
  offlineDurationMs = 0,
) {
  const settings = await saveSettings(await getSettings());
  await syncAlarm(settings);
  const tabs = await chrome.tabs.query({});
  const persistedTabs =
    trackingMode === "reset" || trackingMode === "restore"
      ? {}
      : await readPersistedTabs();
  let effectiveMode = trackingMode;
  let effectiveOfflineDuration = offlineDurationMs;

  if (
    trackingMode === "persisted" &&
    Object.keys(persistedTabs).length === 0
  ) {
    effectiveMode = "restore";
    effectiveOfflineDuration = await inferOfflineDuration(tabs, Date.now());
  }

  await ensureTracked(
    tabs,
    effectiveMode,
    effectiveOfflineDuration,
    persistedTabs,
  );

  const state = await readSessionState();
  const latestActivity = Math.max(
    0,
    ...Object.values(state.tabs).filter(
      (timestamp) => Number.isFinite(timestamp) && timestamp > 0,
    ),
  );
  await Promise.all([
    recordLastActivityAt(latestActivity).catch((error) => {
      console.warn("Tab Lifetime could not save its activity heartbeat.", error);
    }),
    persistTabSnapshot(state.tabs).catch((error) => {
      console.warn("Tab Lifetime could not persist its tab snapshot.", error);
    }),
  ]);

  return { settings, tabCount: tabs.length, reason };
}

async function handleMessage(message) {
  await startupRestorePromise.catch(() => undefined);

  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Unsupported message." };
  }

  if (message.type === "GET_STATUS") {
    const settings = await initialize("status", "preserve");
    return {
      ok: true,
      settings: settings.settings,
      status: await buildStatus(settings.settings),
    };
  }

  if (message.type === "UPDATE_SETTINGS") {
    const current = await getSettings();
    const settings = await saveSettings({ ...current, ...message.settings });
    await syncAlarm(settings);

    const result = settings.enabled
      ? await sweepTabs("settings-change")
      : { closedCount: 0, skipped: true };

    return {
      ok: true,
      settings,
      result,
      status: await buildStatus(settings),
    };
  }

  if (message.type === "CLEAN_NOW") {
    const settings = await getSettings();
    if (!settings.enabled) {
      return { ok: false, error: "Auto close is paused." };
    }

    const result = await sweepTabs("manual");
    return { ok: true, result, status: await buildStatus(settings) };
  }

  return { ok: false, error: "Unsupported message." };
}

async function handleStartup() {
  const now = Date.now();
  startupOfflineDurationMs = await getStartupOfflineDuration(now);
  await initialize("startup", "restore", startupOfflineDurationMs);
}

async function handleInstalled(details) {
  if (details.reason === "install") {
    startupRestorePromise = Promise.resolve();
    startupRestoreUntil = 0;
    startupOfflineDurationMs = 0;
    await initialize(details.reason, "reset");
    return;
  }

  await startupRestorePromise.catch(() => undefined);
  if (Date.now() < startupRestoreUntil) {
    await initialize(details.reason, "restore", startupOfflineDurationMs);
    return;
  }

  // Reloading or updating the extension must not restart existing tab timers.
  // The persisted per-tab snapshot restores the exact pre-reload timestamps.
  await initialize(details.reason, "persisted");
}

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details).catch((error) => {
    console.error("Tab Lifetime failed to initialize.", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  startupRestoreUntil = Date.now() + STARTUP_RESTORE_WINDOW_MS;
  startupRestorePromise = handleStartup();
  void startupRestorePromise.catch((error) => {
    console.error("Tab Lifetime failed to start.", error);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("Tab Lifetime request failed.", error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected error.",
      });
    });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void sweepTabs("alarm").catch((error) => {
      console.error("Tab Lifetime sweep failed.", error);
    });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  // During startup, Chrome can create restored background tabs after onStartup
  // fires. Preserve their native activity timestamp; active tabs and ordinary
  // new/reopened tabs start with a fresh timer.
  const restoringStartupSession = Date.now() < startupRestoreUntil;
  const timestamp = restoringStartupSession
    ? startupTabTimestamp(tab, Date.now(), startupOfflineDurationMs)
    : Date.now();
  void touchTab(tab.id, timestamp).catch((error) => {
    console.error("Tab Lifetime could not track a new tab.", error);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  cancelClosingCandidate(tabId);
  void touchTab(tabId).catch((error) => {
    console.error("Tab Lifetime could not reset a tab timer.", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const didFinishLoading = changeInfo.status === "complete" || changeInfo.url;
  if (!didFinishLoading) {
    return;
  }

  if (tab.active) {
    cancelClosingCandidate(tabId);
    void touchTab(tabId).catch((error) => {
      console.error("Tab Lifetime could not reset a tab timer.", error);
    });
    return;
  }

  const restoringStartupSession = Date.now() < startupRestoreUntil;
  const restoredTimestamp = restoringStartupSession
    ? startupTabTimestamp(tab, Date.now(), startupOfflineDurationMs)
    : null;
  if (restoredTimestamp !== null) {
    void touchTab(tabId, restoredTimestamp, false).catch((error) => {
      console.error("Tab Lifetime could not refresh a tab timer.", error);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelClosingCandidate(tabId);
  void Promise.all([
    mutateSessionState((state) => {
      delete state.tabs[tabId];
    }),
    removePersistedTab(tabId),
  ]).catch((error) => {
    console.error("Tab Lifetime could not remove tab state.", error);
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  cancelClosingCandidate(removedTabId);
  void Promise.all([
    mutateSessionState((state) => {
      delete state.tabs[removedTabId];
    }),
    removePersistedTab(removedTabId),
    touchTab(addedTabId),
  ]).catch((error) => {
    console.error("Tab Lifetime could not replace tab state.", error);
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  void chrome.tabs
    .query({ active: true, windowId })
    .then((tabs) => {
      const activeTab = tabs[0];
      return activeTab ? touchTab(activeTab.id) : undefined;
    })
    .catch((error) => {
      console.error("Tab Lifetime could not reset the focused tab.", error);
    });
});
