import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve("apps/os/src/renderer/share-link.js");
const source = fs.readFileSync(sourcePath, "utf8");
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const { WEB_BASE, buildLinkIndex, parseLocation, serializeLocation } = mod;

const RADIX = 36;
const CODE_LEN = 5;
const CODE_SPACE = Math.pow(RADIX, CODE_LEN);

function hash5(str) {
  const s = String(str);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return (n % CODE_SPACE).toString(RADIX).padStart(CODE_LEN, "0");
}

test("asks links canonicalize to the merged activity page", () => {
  buildLinkIndex([]);

  const activityLink = serializeLocation({ tab: "alchemy", alchMode: "activity" });
  assert.equal(serializeLocation({ tab: "alchemy", alchMode: "asks" }), activityLink);
  assert.deepEqual(parseLocation(activityLink), { tab: "alchemy", alchMode: "activity" });

  const legacyAskLink = WEB_BASE + hash5("v:alchemy/asks");
  assert.deepEqual(parseLocation(legacyAskLink), { tab: "alchemy", alchMode: "activity" });
});

test("onboarding links canonicalize to the Program Info onboarding view", () => {
  buildLinkIndex([]);

  const onboardingView = { tab: "alchemy", alchMode: "program", programPage: "onboarding" };
  const onboardingLink = serializeLocation(onboardingView);
  assert.equal(serializeLocation({ tab: "alchemy", alchMode: "onboarding" }), onboardingLink);
  assert.deepEqual(parseLocation(onboardingLink), onboardingView);

  const legacyOnboardingLink = WEB_BASE + hash5("v:alchemy/onboarding");
  assert.deepEqual(parseLocation(legacyOnboardingLink), onboardingView);
});

test("old say-did-shipped constellation links resolve to mirror", () => {
  buildLinkIndex([]);

  const mirrorLink = serializeLocation({ tab: "alchemy", alchMode: "mirror" });
  assert.equal(
    serializeLocation({ tab: "alchemy", alchMode: "constellation", constMode: "shipped" }),
    mirrorLink,
  );
  assert.deepEqual(parseLocation(mirrorLink), { tab: "alchemy", alchMode: "mirror" });

  const legacyShippedLink = WEB_BASE + hash5("v:alchemy/constellation/shipped");
  assert.deepEqual(parseLocation(legacyShippedLink), { tab: "alchemy", alchMode: "mirror" });
});

test("retired context intel links resolve to evidence", () => {
  buildLinkIndex([]);

  const evidenceLink = serializeLocation({ tab: "alchemy", alchMode: "context", ctxView: "evidence" });
  assert.equal(
    serializeLocation({ tab: "alchemy", alchMode: "context", ctxView: "signals" }),
    evidenceLink,
  );
  assert.equal(
    serializeLocation({ tab: "alchemy", alchMode: "context", ctxView: "data" }),
    evidenceLink,
  );
  assert.deepEqual(parseLocation(evidenceLink), { tab: "alchemy", alchMode: "context", ctxView: "evidence" });

  const legacySignalsLink = WEB_BASE + hash5("v:alchemy/context/signals");
  const legacyDataLink = WEB_BASE + hash5("v:alchemy/context/data");
  const legacyIntelLink = WEB_BASE + hash5("v:alchemy/intel");
  assert.deepEqual(parseLocation(legacySignalsLink), { tab: "alchemy", alchMode: "context", ctxView: "evidence" });
  assert.deepEqual(parseLocation(legacyDataLink), { tab: "alchemy", alchMode: "context", ctxView: "evidence" });
  assert.deepEqual(parseLocation(legacyIntelLink), { tab: "alchemy", alchMode: "context", ctxView: "evidence" });
});
