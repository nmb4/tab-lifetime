export const SETTINGS_KEY = "tabLifetimeSettings";
export const SESSION_STATE_KEY = "tabLifetimeSession";
export const LAST_ACTIVITY_KEY = "tabLifetimeLastActivityAt";
export const PERSISTED_TABS_KEY = "tabLifetimePersistedTabs";
export const ALARM_NAME = "tab-lifetime-sweep";
export const SWEEP_PERIOD_MINUTES = 1;

export const MIN_THRESHOLD_MINUTES = 1;
export const MAX_THRESHOLD_MINUTES = 30 * 24 * 60;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  thresholdMinutes: 12 * 60,
});

const UNIT_MINUTES = Object.freeze({
  minutes: 1,
  hours: 60,
  days: 24 * 60,
});

export function normalizeSettings(value = {}) {
  const candidate = value && typeof value === "object" ? value : {};
  const threshold = Number(candidate.thresholdMinutes);

  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_SETTINGS.enabled,
    thresholdMinutes: Number.isFinite(threshold)
      ? Math.min(
          MAX_THRESHOLD_MINUTES,
          Math.max(MIN_THRESHOLD_MINUTES, Math.round(threshold)),
        )
      : DEFAULT_SETTINGS.thresholdMinutes,
  };
}

export function durationToMinutes(value, unit) {
  const amount = Number(value);
  const unitMinutes = UNIT_MINUTES[unit];

  if (!Number.isFinite(amount) || amount <= 0 || !unitMinutes) {
    return null;
  }

  const minutes = Math.round(amount * unitMinutes);
  if (
    minutes < MIN_THRESHOLD_MINUTES ||
    minutes > MAX_THRESHOLD_MINUTES
  ) {
    return null;
  }

  return minutes;
}

export function durationParts(minutes) {
  const normalizedMinutes = normalizeSettings({
    thresholdMinutes: minutes,
  }).thresholdMinutes;

  if (
    normalizedMinutes >= UNIT_MINUTES.days &&
    normalizedMinutes % UNIT_MINUTES.days === 0
  ) {
    return {
      value: normalizedMinutes / UNIT_MINUTES.days,
      unit: "days",
    };
  }

  if (
    normalizedMinutes >= UNIT_MINUTES.hours &&
    normalizedMinutes % UNIT_MINUTES.hours === 0
  ) {
    return {
      value: normalizedMinutes / UNIT_MINUTES.hours,
      unit: "hours",
    };
  }

  return { value: normalizedMinutes, unit: "minutes" };
}

export function formatDuration(minutes) {
  const parts = durationParts(minutes);
  const unit = parts.value === 1 ? parts.unit.replace(/s$/, "") : parts.unit;
  return `${parts.value} ${unit}`;
}
