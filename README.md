# Tab Lifetime

A small Chrome extension that closes inactive tabs after a configurable timeout, similar to Arc's Auto Archive behavior.

## What it does

- Closes a tab after it has been inactive for the selected duration.
- Defaults to **12 hours**, matching Arc's current Auto Archive default.
- Preserves tab inactivity across browser restarts using Chrome's native `Tab.lastAccessed` metadata plus a local activity heartbeat.
- Resets a tab's timer when it is opened, activated, navigated while active, or in a browser window that regains focus.
- Gives manually reopened tabs a fresh timer when Chrome creates the new tab.
- Restores the exact existing tab timers when the extension itself is reloaded or updated.
- Protects active tabs and tabs playing audio.
- Protects pinned tabs permanently.
- Checks once per minute and supports a manual cleanup from the popup.
- Supports thresholds from **1 minute to 30 days**.

## Install locally

1. Open `chrome://extensions` in Chrome or Chromium.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `tab-lifetime` directory.
5. Pin **Tab Lifetime** and click its toolbar icon to change the timeout.

Chrome 121 or newer is required so the extension can use Chrome's native `Tab.lastAccessed` metadata across restarts.

The extension requests only the `alarms` and `storage` permissions. It does not request the `tabs` permission, host access, or content scripts, and it never reads page URLs or browsing history.

## Timing behavior

A tab becomes eligible when the time since it was last active is greater than or equal to the configured timeout. Chrome may delay an alarm slightly when the device is sleeping or busy, so cleanup normally happens within about one minute of the deadline.

The popup's **Close stale tabs now** action also uses a short grace period. Focusing a tab during that grace period cancels its pending close.

## Cleanup alarm

The extension creates one repeating Chrome alarm named `tab-lifetime-sweep` with a one-minute period. It does not create one alarm per tab.

Each time the alarm fires, Chrome wakes the Manifest V3 service worker if it was suspended. The extension then:

1. Loads the saved policy from `storage.local`.
2. Loads current-session timestamps from `storage.session` and uses heartbeat-adjusted Chrome `Tab.lastAccessed` metadata when reconciling a restored session.
3. Queries the currently open tabs.
4. Selects tabs that are past the timeout and are not active, audible, or protected pinned tabs.
5. Waits a 1.5-second grace period and rechecks each candidate before closing it.

Turning the extension off clears this alarm. Turning it back on recreates it. If the computer is asleep, Chrome can delay an alarm; a missed alarm runs after the device wakes, so closures are accurate to roughly one minute rather than the exact second.

## Browser startup

When Chrome launches, it fires `runtime.onStartup` after restoring its windows and tabs. This assumes Chrome's **On startup** setting is set to **Continue where you left off**; otherwise there are no old tabs for the extension to reconcile. The extension then:

1. Restores its saved enabled state, timeout, and pinned-tab preference from `storage.local`.
2. Recreates the one-minute cleanup alarm if the extension is enabled.
3. Reads each restored tab's Chrome-provided `Tab.lastAccessed` timestamp.
4. Rebuilds its timer map from that timestamp, so time spent inactive before shutdown still counts.
5. Lets the first alarm perform the first cleanup check.

Chrome can finish restoring some tabs shortly after `onStartup`, so the extension also watches for late restored-tab events during a short startup reconciliation window.

Chrome normalizes restored `lastAccessed` values so the most recently active tab is close to startup time. To account for time spent with the computer off, the extension keeps a small activity heartbeat in `storage.local` and shifts restored timestamps by the offline duration before evaluating them.

For example, if a tab was last used at 11 PM, the computer is off overnight, and the timeout is 12 hours, that tab becomes eligible around 11 AM the next day rather than receiving a new 12-hour grace period at startup. Focusing it before then resets its timer.

`storage.session` is cleared when the browser restarts, but Chrome restores the underlying tab activity metadata and the extension's activity heartbeat remains available. If a tab does not expose a usable `lastAccessed` value, the extension safely falls back to "now" for that tab. Configuration in `storage.local` persists.

If the service worker is merely suspended and restarted later during the same browser session, it does **not** reset all timers. It reloads the existing `storage.session` timestamps and continues counting from them.

When the extension itself is reloaded or updated, it restores a per-tab timestamp snapshot from `storage.local` rather than resetting everything. Only the first install starts tabs with a fresh grace period.

### Focus limitation

Chrome exposes tab activation and window focus to extensions, but not clicks on the tab that is already active. This extension resets timers when users switch tabs, open a tab, navigate the active tab, or return to the browser window. Detecting a click on the already-active tab would require injecting a tracking script into every website, which this extension intentionally avoids.

## Test

No dependencies are required.

```bash
npm test
```

For a syntax check plus tests:

```bash
npm run check
```

## Project layout

- `manifest.json`: Manifest V3 declaration.
- `background.js`: timer tracking, tab protection, alarms, and cleanup.
- `popup.html`, `popup.css`, `popup.js`: toolbar settings and status UI.
- `shared/settings.js`: settings validation and duration conversion.
- `shared/tab-policy.js`: pure tab eligibility rules.
- `tests/`: Node tests for policy, settings, manifest permissions, and background cleanup behavior.
