import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const link = require("./daybook/link.js");

test("device-link day windows are clamped before peer scans", () => {
  assert.equal(link.normalizeDays("9999", { fallback: 30, max: link.MAX_RECENT_DAYS }), link.MAX_RECENT_DAYS);
  assert.equal(link.normalizeDays("-4", { fallback: 30, max: link.MAX_RECENT_DAYS }), 30);
  assert.equal(link.normalizeDays("3.9", { fallback: 30, max: link.MAX_RECENT_DAYS }), 3);
  assert.equal(link.normalizeDays("999", { fallback: 7, max: link.MAX_RAW_DAYS }), link.MAX_RAW_DAYS);
});

test("device-link drops oversized unauthenticated socket input", async () => {
  const info = await link.startHost({ perms: { recent: true, raw: false } });
  assert.ok(info?.port);
  const socket = net.connect({ host: "127.0.0.1", port: info.port });
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    socket.write(Buffer.alloc(link.MAX_LINK_PREAUTH_BYTES + 1, "x"));
    const closed = await Promise.race([
      once(socket, "close").then(() => true),
      delay(1500).then(() => false),
    ]);
    assert.equal(closed, true);
    assert.equal(link.hostInfo()?.peers || 0, 0);
  } finally {
    try { socket.destroy(); } catch {}
    link.stopHost();
  }
});
