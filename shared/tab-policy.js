function hasTrackableId(tab) {
  return Number.isInteger(tab?.id) && tab.id >= 0;
}

function lastActiveAtFor(tab, timestamps, now) {
  const storedTimestamp = Number(timestamps?.[tab.id]);

  // The background worker owns the timestamp map. During startup it shifts
  // Chrome's normalized lastAccessed values by the offline duration, so the
  // policy layer must not replace that value with the native timestamp again.
  return Number.isFinite(storedTimestamp) && storedTimestamp > 0
    ? Math.min(storedTimestamp, now)
    : now;
}

export function isTabProtected(tab) {
  if (!hasTrackableId(tab)) {
    return true;
  }

  return Boolean(tab.active || tab.audible || tab.pinned);
}

export function getTabPlan(tabs, timestamps, settings, now = Date.now()) {
  const thresholdMs = settings.thresholdMinutes * 60 * 1000;
  const closableTabs = [];

  let trackedCount = 0;
  let protectedCount = 0;
  let eligibleCount = 0;
  let nextDueAt = null;

  for (const tab of tabs) {
    if (!hasTrackableId(tab)) {
      continue;
    }

    trackedCount += 1;
    const lastActiveAt = lastActiveAtFor(tab, timestamps, now);
    const dueAt = lastActiveAt + thresholdMs;
    const candidate = { tab, lastActiveAt, dueAt };

    if (isTabProtected(tab)) {
      protectedCount += 1;
      continue;
    }

    eligibleCount += 1;

    if (now >= dueAt) {
      closableTabs.push(candidate);
    } else if (nextDueAt === null || dueAt < nextDueAt) {
      nextDueAt = dueAt;
    }
  }

  return {
    closableTabs,
    summary: {
      trackedCount,
      protectedCount,
      eligibleCount,
      dueCount: closableTabs.length,
      nextDueAt,
    },
  };
}
