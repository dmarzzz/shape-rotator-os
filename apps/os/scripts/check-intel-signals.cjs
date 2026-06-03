#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const signalsPath = path.join(root, "src", "renderer", "intel", "intel-signals.js");
const source = fs.readFileSync(signalsPath, "utf8");
const exportNeedle = "export const INTEL_SIGNALS = ";
const start = source.indexOf(exportNeedle);

if (start < 0) {
  fail("INTEL_SIGNALS export missing");
}

const body = source.slice(start).replace(exportNeedle, "return").replace(/;\s*$/, "");
const signals = Function(body)();

const REQUIRED = [
  "id",
  "tier",
  "kind",
  "title",
  "claim",
  "shapeRotation",
  "chain",
  "coordinatorMove",
  "introduction",
  "watchFor",
  "limits",
  "sourceReceipts",
];

const BANNED_HEADLINE_PATTERNS = [
  /\bcoverage\b/i,
  /\battribution\b/i,
  /\bpipeline\b/i,
  /\bgenerated surface\b/i,
  /\bstatus score\b/i,
  /\bmissing repo\b/i,
  /\bfix data\b/i,
  /\brepair (?:data|attribution|pipeline)\b/i,
  /\brerun (?:the )?(?:panel|status|pipeline)\b/i,
  /\bHermes is\b/i,
  /\bdashboard\b/i,
  /\badmin(?:istrative)?\b/i,
  /\bmetadata\b/i,
];

const COORDINATOR_MOVE_VERBS = [
  "ask",
  "put",
  "run",
  "stage",
  "pair",
  "connect",
  "require",
  "give",
  "have",
  "make",
];

const allowedKinds = new Set([
  "catalytic-pairing",
  "hidden-teacher",
  "cross-domain",
  "phase-shape",
  "negative-space",
  "convergence",
  "proxy-signal",
  "centrality",
  "multi-hop",
  "tension-map",
  "interpret-decision",
]);

const PRIVATE_RECEIPT_PATTERNS = [
  /\bcorpus\//i,
  /\bstatus\//i,
  /\bgraph\//i,
  /\btranscripts\/sources\b/i,
  /\.txt\b/i,
  /\.json\b/i,
];

const errors = [];

if (signals.length < 4 || signals.length > 6) {
  errors.push(`expected 4-6 headline signals, got ${signals.length}`);
}

for (const signal of signals) {
  for (const field of REQUIRED) {
    if (!signal[field] || (Array.isArray(signal[field]) && signal[field].length === 0)) {
      errors.push(`${signal.id || "signal"} missing ${field}`);
    }
  }

  if (!allowedKinds.has(signal.kind)) {
    errors.push(`${signal.id} has unknown kind ${signal.kind}`);
  }

  if ((signal.entities || []).length < 2 && !signal.cohortPattern) {
    errors.push(`${signal.id} needs at least two concrete entities or cohortPattern: true`);
  }

  if ((signal.chain || []).length < 3) {
    errors.push(`${signal.id} chain is too thin`);
  }

  if (!/therefore/i.test(String(signal.chain?.[signal.chain.length - 1] || ""))) {
    errors.push(`${signal.id} final chain step must state the therefore`);
  }

  const joinedHeadline = [
    signal.title,
    signal.claim,
    signal.shapeRotation,
    signal.coordinatorMove,
    signal.introduction,
    signal.watchFor,
    signal.limits,
  ].join(" ");

  for (const pattern of BANNED_HEADLINE_PATTERNS) {
    if (pattern.test(joinedHeadline)) {
      errors.push(`${signal.id} looks like data/admin/system plumbing: matched ${pattern}`);
    }
  }

  const move = String(signal.coordinatorMove || "").trim().toLowerCase();
  if (!COORDINATOR_MOVE_VERBS.some((verb) => move.startsWith(`${verb} `))) {
    errors.push(`${signal.id} coordinatorMove must start with a concrete coordinator action verb`);
  }

  if (!/\bif\b/i.test(String(signal.watchFor || ""))) {
    errors.push(`${signal.id} watchFor must include a falsifiable if-condition`);
  }

  if (!/\brotate\b/i.test(String(signal.shapeRotation || ""))) {
    errors.push(`${signal.id} shapeRotation must name the rotation`);
  }

  if (!/\b(?:put|stage|pair|introduce|add|make)\b/i.test(String(signal.introduction || ""))) {
    errors.push(`${signal.id} introduction must stage people, projects, or a room`);
  }

  if (!/\b(?:hypothesis|inferred|validated|fails|should not|must not|limit|until)\b/i.test(String(signal.limits || ""))) {
    errors.push(`${signal.id} limits must state uncertainty, validation, or misuse bounds`);
  }

  for (const receipt of signal.sourceReceipts || []) {
    for (const pattern of PRIVATE_RECEIPT_PATTERNS) {
      if (pattern.test(String(receipt))) {
        errors.push(`${signal.id} sourceReceipts must be audience-facing labels, not private vault paths: ${receipt}`);
      }
    }
  }
}

if (errors.length) {
  fail(errors.join("\n"));
}

console.log(`[intel-quality] OK · ${signals.length} coordinator-move headline signals`);

function fail(message) {
  console.error(`[intel-quality] FAIL\n${message}`);
  process.exit(1);
}
