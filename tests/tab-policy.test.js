import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSettings } from "../shared/settings.js";
import { getTabPlan, isTabProtected } from "../shared/tab-policy.js";

const HOUR = 60 * 60 * 1_000;
const NOW = 1_700_000_000_000;
const SETTINGS = normalizeSettings({ thresholdMinutes: 120 });

test("active, audible, and pinned tabs are always protected", () => {
  assert.equal(isTabProtected({ id: 1, active: true }), true);
  assert.equal(isTabProtected({ id: 2, audible: true }), true);
  assert.equal(isTabProtected({ id: 3, pinned: true }), true);
  assert.equal(isTabProtected({ id: 4 }), false);
});

test("only old, unprotected tabs become close candidates", () => {
  const tabs = [
    { id: 1, active: true },
    { id: 2, audible: true },
    { id: 3, pinned: true },
    { id: 4 },
    { id: 5 },
    { id: 6 },
  ];
  const timestamps = {
    1: NOW - 10 * HOUR,
    2: NOW - 10 * HOUR,
    3: NOW - 10 * HOUR,
    4: NOW - 2 * HOUR,
    5: NOW - 3 * HOUR,
    6: NOW - 30 * 60 * 1_000,
  };

  const plan = getTabPlan(tabs, timestamps, SETTINGS, NOW);

  assert.deepEqual(
    plan.closableTabs.map(({ tab }) => tab.id),
    [4, 5],
  );
  assert.deepEqual(plan.summary, {
    trackedCount: 6,
    protectedCount: 3,
    eligibleCount: 3,
    dueCount: 2,
    nextDueAt: NOW + 90 * 60 * 1_000,
  });
});

test("an untracked tab receives a safe grace period", () => {
  const plan = getTabPlan([{ id: 9 }], {}, SETTINGS, NOW);

  assert.equal(plan.summary.dueCount, 0);
  assert.equal(plan.summary.nextDueAt, NOW + 2 * HOUR);
});

test("the worker's persisted timestamp stays authoritative after startup", () => {
  const plan = getTabPlan(
    [{ id: 10, lastAccessed: NOW }],
    { 10: NOW - 13 * HOUR },
    SETTINGS,
    NOW,
  );

  assert.equal(plan.summary.dueCount, 1);
  assert.equal(plan.closableTabs[0].lastActiveAt, NOW - 13 * HOUR);
});

test("an explicit extension touch wins over older native metadata", () => {
  const plan = getTabPlan(
    [{ id: 11, lastAccessed: NOW - 13 * HOUR }],
    { 11: NOW - 5 * 60 * 1000 },
    SETTINGS,
    NOW,
  );

  assert.equal(plan.summary.dueCount, 0);
  assert.equal(plan.closableTabs.length, 0);
});
