import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  MAX_THRESHOLD_MINUTES,
  MIN_THRESHOLD_MINUTES,
  durationParts,
  durationToMinutes,
  formatDuration,
  normalizeSettings,
} from "../shared/settings.js";

test("defaults match Arc's 12-hour Auto Archive timing", () => {
  assert.deepEqual(normalizeSettings(), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.thresholdMinutes, 720);
});

test("settings are normalized to supported values", () => {
  assert.deepEqual(
    normalizeSettings({
      enabled: false,
      thresholdMinutes: 0,
    }),
    {
      enabled: false,
      thresholdMinutes: MIN_THRESHOLD_MINUTES,
    },
  );

  assert.deepEqual(
    normalizeSettings({
      enabled: true,
      thresholdMinutes: MAX_THRESHOLD_MINUTES + 5_000,
    }),
    {
      enabled: true,
      thresholdMinutes: MAX_THRESHOLD_MINUTES,
    },
  );
});

test("duration units convert to minute thresholds", () => {
  assert.equal(durationToMinutes(12, "hours"), 720);
  assert.equal(durationToMinutes(2, "days"), 2_880);
  assert.equal(durationToMinutes(15, "minutes"), 15);
  assert.equal(durationToMinutes(0, "hours"), null);
  assert.equal(durationToMinutes(31, "days"), null);
  assert.equal(durationToMinutes(12, "weeks"), null);
});

test("thresholds render in the clearest exact unit", () => {
  assert.deepEqual(durationParts(15), { value: 15, unit: "minutes" });
  assert.deepEqual(durationParts(720), { value: 12, unit: "hours" });
  assert.deepEqual(durationParts(10_080), { value: 7, unit: "days" });
  assert.equal(formatDuration(720), "12 hours");
  assert.equal(formatDuration(60), "1 hour");
  assert.equal(formatDuration(1), "1 minute");
});
