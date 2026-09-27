import {
  DEFAULT_SETTINGS,
  MAX_THRESHOLD_MINUTES,
  durationParts,
  durationToMinutes,
  formatDuration,
  normalizeSettings,
} from "./shared/settings.js";

const elements = {
  enabled: document.querySelector("#enabled"),
  durationValue: document.querySelector("#duration-value"),
  durationUnit: document.querySelector("#duration-unit"),
  durationError: document.querySelector("#duration-error"),
  dueCount: document.querySelector("#due-count"),
  trackedCount: document.querySelector("#tracked-count"),
  closedCount: document.querySelector("#closed-count"),
  policySummary: document.querySelector("#policy-summary"),
  policyBadge: document.querySelector("#policy-badge"),
  cleanNow: document.querySelector("#clean-now"),
  notice: document.querySelector("#notice"),
  summaryTitle: document.querySelector("#summary-title"),
};

const UNIT_LIMITS = Object.freeze({
  minutes: { min: 1, max: MAX_THRESHOLD_MINUTES },
  hours: { min: 1, max: MAX_THRESHOLD_MINUTES / 60 },
  days: { min: 1, max: MAX_THRESHOLD_MINUTES / (24 * 60) },
});

let settings = normalizeSettings(DEFAULT_SETTINGS);
let status = null;
let saveQueue = Promise.resolve();
let saveRevision = 0;
let pendingSaves = 0;
let cleaning = false;
let noticeTimer = null;

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });

  if (!response) {
    throw new Error("The extension background did not respond.");
  }

  if (!response.ok) {
    throw new Error(response.error || "The request could not be completed.");
  }

  return response;
}

function setBusy(isBusy) {
  document.body.toggleAttribute("aria-busy", isBusy);
}

function showNotice(message, tone = "neutral") {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.dataset.tone = tone;

  if (tone !== "error") {
    noticeTimer = window.setTimeout(() => {
      elements.notice.textContent = "";
      elements.notice.dataset.tone = "neutral";
    }, 4_000);
  }
}

function updateUnitLimits() {
  const limits = UNIT_LIMITS[elements.durationUnit.value];
  elements.durationValue.min = String(limits.min);
  elements.durationValue.max = String(limits.max);
}

function renderSettings() {
  const parts = durationParts(settings.thresholdMinutes);

  elements.enabled.checked = settings.enabled;
  elements.durationUnit.value = parts.unit;
  elements.durationValue.value = String(parts.value);
  elements.durationValue.min = String(UNIT_LIMITS[parts.unit].min);
  elements.durationValue.max = String(UNIT_LIMITS[parts.unit].max);
  elements.policyBadge.textContent = settings.enabled ? "On" : "Paused";
  elements.policySummary.textContent = settings.enabled
    ? `Inactive tabs close after ${formatDuration(settings.thresholdMinutes)}. Time while Chrome is closed still counts.`
    : "Automatic cleanup is paused. Timers resume when you turn it back on.";
}

function renderStatus() {
  if (!status) {
    return;
  }

  elements.dueCount.textContent = String(status.dueCount);
  elements.trackedCount.textContent = String(status.trackedCount);
  elements.closedCount.textContent = String(status.closedThisSession);

  if (!settings.enabled) {
    document.body.dataset.state = "paused";
    elements.summaryTitle.textContent = "Auto close is paused";
  } else if (status.dueCount > 0) {
    document.body.dataset.state = "due";
    elements.summaryTitle.textContent = `${status.dueCount} ${
      status.dueCount === 1 ? "tab is" : "tabs are"
    } ready to close`;
  } else {
    document.body.dataset.state = "ready";
    elements.summaryTitle.textContent = "Nothing is due";
  }

  elements.cleanNow.disabled =
    !settings.enabled || status.dueCount === 0 || pendingSaves > 0 || cleaning;
}

function applyResponse(response) {
  settings = normalizeSettings(response.settings);
  status = response.status;
  renderSettings();
  renderStatus();
}

async function loadStatus({ showErrors = true } = {}) {
  try {
    const response = await sendMessage("GET_STATUS");
    applyResponse(response);
  } catch (error) {
    document.body.dataset.state = "error";
    elements.summaryTitle.textContent = "Tab Lifetime is unavailable";
    elements.policySummary.textContent = "Reload Chrome and try again.";

    if (showErrors) {
      showNotice(error.message, "error");
    }
  }
}

function queueSettingsSave(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  elements.durationError.hidden = true;
  renderSettings();
  renderStatus();

  const revision = ++saveRevision;
  pendingSaves += 1;
  setBusy(true);

  const snapshot = { ...settings };
  const task = saveQueue.then(() =>
    sendMessage("UPDATE_SETTINGS", { settings: snapshot }),
  );
  saveQueue = task.catch(() => undefined);

  task
    .then((response) => {
      if (revision === saveRevision) {
        applyResponse(response);
      }
    })
    .catch(async (error) => {
      if (revision === saveRevision) {
        showNotice(error.message, "error");
        await loadStatus({ showErrors: false });
      }
    })
    .finally(() => {
      pendingSaves = Math.max(0, pendingSaves - 1);
      setBusy(pendingSaves > 0 || cleaning);
      renderStatus();
    });
}

function readDurationInput() {
  const minutes = durationToMinutes(
    elements.durationValue.value,
    elements.durationUnit.value,
  );

  if (minutes === null) {
    elements.durationError.textContent =
      "Choose a duration from 1 minute to 30 days.";
    elements.durationError.hidden = false;
    return null;
  }

  elements.durationError.hidden = true;
  return minutes;
}

async function cleanNow() {
  cleaning = true;
  elements.cleanNow.disabled = true;
  elements.cleanNow.textContent = "Checking tabs";
  setBusy(true);

  try {
    const response = await sendMessage("CLEAN_NOW");
    applyResponse(response);
    const count = response.result.closedCount;
    showNotice(
      count === 0
        ? "Nothing needed closing."
        : `Closed ${count} stale ${count === 1 ? "tab" : "tabs"}.`,
      count === 0 ? "neutral" : "success",
    );
  } catch (error) {
    showNotice(error.message, "error");
    await loadStatus({ showErrors: false });
  } finally {
    cleaning = false;
    elements.cleanNow.textContent = "Close stale tabs now";
    setBusy(pendingSaves > 0);
    renderStatus();
  }
}

elements.enabled.addEventListener("change", () => {
  queueSettingsSave({ enabled: elements.enabled.checked });
});

elements.durationValue.addEventListener("change", () => {
  const minutes = readDurationInput();
  if (minutes !== null) {
    queueSettingsSave({ thresholdMinutes: minutes });
  } else {
    renderSettings();
  }
});

elements.durationUnit.addEventListener("change", () => {
  updateUnitLimits();
  const minutes = readDurationInput();
  if (minutes !== null) {
    queueSettingsSave({ thresholdMinutes: minutes });
  } else {
    renderSettings();
  }
});

elements.cleanNow.addEventListener("click", () => {
  void cleanNow();
});

renderSettings();
void loadStatus();

window.setInterval(() => {
  if (
    document.visibilityState === "visible" &&
    pendingSaves === 0 &&
    !cleaning
  ) {
    void loadStatus({ showErrors: false });
  }
}, 30_000);
