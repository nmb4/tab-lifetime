import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(projectRoot, "manifest.json"), "utf8"),
);

test("uses a module-based Manifest V3 service worker", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.minimum_chrome_version, "121");
});

test("requests no browsing-data permissions", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "storage"]);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("content_scripts" in manifest, false);
  assert.equal(manifest.permissions.includes("tabs"), false);
});

test("all declared icon assets exist", async () => {
  const icons = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]);

  for (const icon of icons) {
    await access(join(projectRoot, icon));
  }
});
