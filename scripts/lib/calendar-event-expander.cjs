const DEFAULT_TIME_ZONE = "America/New_York";
const DEFAULT_TIMED_DURATION_MINUTES = 30;
const WEEKDAY_INDEX = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dateIsoWithOffset(dateIso, dayOffset = 0) {
  if (!dayOffset) return dateIso;
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return isoDate(date);
}

function truncateSummary(value) {
  const summary = String(value || "").replace(/\s+/g, " ").trim() || "Shape Rotator session";
  return summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
}

function cleanTitleRest(value) {
  return String(value || "")
    .replace(/^\s*(?:[-*]\s*)?/, "")
    .replace(/^\s*(?:[:\-–—]+|\)+)\s*/, "")
    .replace(/^\s+/, "")
    .trim();
}

function stripLeadingBullet(value) {
  return String(value || "").replace(/^\s*[-*]\s+/, "").trim();
}

function stripAllDayPrefix(value) {
  return stripLeadingBullet(value)
    .replace(/^\s*\[\s*all\s+day\s*\]\s*/i, "")
    .trim();
}

function firstNonEmptyLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function isDayHeaderLine(value) {
  return /^\s*(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?(?:\s+[a-z]{3,9})?(?:\s+\d{1,2})?\s*:?\s*$/i.test(value || "");
}

function stripBlockDayHeader(block) {
  const lines = String(block || "").split(/\r?\n/);
  if (lines.length > 1 && isDayHeaderLine(lines[0])) {
    return lines.slice(1).join("\n").trim();
  }
  return String(block || "").trim();
}

function splitCalendarCellBlocks(description) {
  return String(description || "")
    .split(/\r?\n\s*\r?\n/)
    .map(stripBlockDayHeader)
    .map((block) => block.trim())
    .filter(Boolean)
    .filter((block) => !isDayHeaderLine(block));
}

function parseMeridiem(value) {
  const match = String(value || "").toLowerCase().match(/([ap])\.?m\.?(?![a-z])/);
  return match ? (match[1] === "p" ? "pm" : "am") : null;
}

function parseTimeToken(token) {
  const raw = String(token || "").trim().toLowerCase();
  const meridiem = parseMeridiem(raw);
  const compact = raw.replace(/\s*(?:[ap]\.?m\.?)\s*$/i, "");
  let hour;
  let minute;
  const colon = compact.match(/^(\d{1,2})(?::(\d{2}))?$/);
  const digits = compact.match(/^(\d{3,4})$/);
  if (colon) {
    hour = Number(colon[1]);
    minute = colon[2] == null ? 0 : Number(colon[2]);
  } else if (digits) {
    hour = Number(compact.slice(0, -2));
    minute = Number(compact.slice(-2));
  } else {
    return null;
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  const originalHour = hour;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { minutes: hour * 60 + minute, meridiem, originalHour };
}

function inferRangeMinutes(startToken, endToken) {
  const start = parseTimeToken(startToken);
  const end = parseTimeToken(endToken);
  if (!start || !end) return null;
  let startMinutes = start.minutes;
  let endMinutes = end.minutes;

  if (!start.meridiem && end.meridiem === "pm" && start.originalHour <= end.originalHour && start.originalHour < 12) {
    startMinutes += 12 * 60;
  }
  if (!end.meridiem && start.meridiem === "pm" && end.originalHour < 12) {
    endMinutes += 12 * 60;
  }
  if (!end.meridiem && startMinutes >= 12 * 60 && endMinutes < 12 * 60) {
    endMinutes += 12 * 60;
  }
  if (endMinutes <= startMinutes) {
    endMinutes += 24 * 60;
  }
  return { startMinutes, endMinutes };
}

function titleAfterFirstLine(block) {
  const lines = String(block || "").split(/\r?\n/).slice(1);
  return lines.map(stripAllDayPrefix).find(Boolean) || "";
}

function parseLeadingTiming(block) {
  const firstLine = firstNonEmptyLine(block);
  const timeToken = String.raw`\d{1,2}(?::?\d{2})?\s*(?:[ap]\.?m\.?(?![a-z]))?`;
  const dashedRange = firstLine.match(new RegExp(String.raw`^\s*(?:[-*]\s*)?(?<start>${timeToken})\s*[-\u2013\u2014]{1,2}\s*~?\s*(?<end>${timeToken})(?<rest>.*)$`, "i"));
  const colonTypoRange = firstLine.match(new RegExp(String.raw`^\s*(?:[-*]\s*)?(?<start>\d{1,2}:\d{2})\s*:\s*(?<end>\d{1,2}:\d{2})(?<rest>.*)$`, "i"));
  const range = dashedRange || colonTypoRange;
  if (range?.groups) {
    const timing = inferRangeMinutes(range.groups.start, range.groups.end);
    if (timing) {
      return {
        ...timing,
        title: cleanTitleRest(range.groups.rest) || titleAfterFirstLine(block) || stripAllDayPrefix(firstLine),
      };
    }
  }

  const single = firstLine.match(new RegExp(String.raw`^\s*(?:[-*]\s*)?(?<start>${timeToken})\s*:?\s*(?<rest>.*)$`, "i"));
  if (single?.groups) {
    const start = parseTimeToken(single.groups.start);
    const rest = cleanTitleRest(single.groups.rest) || titleAfterFirstLine(block);
    if (start && rest) {
      return {
        startMinutes: start.minutes,
        endMinutes: start.minutes + DEFAULT_TIMED_DURATION_MINUTES,
        title: rest,
      };
    }
  }

  return null;
}

function parseAllDaySpanDays(block) {
  const firstLine = stripAllDayPrefix(firstNonEmptyLine(block)).toLowerCase();
  const match = firstLine.match(/^(mon|tue|wed|thu|fri|sat|sun)\s*[-\u2013\u2014]\s*(mon|tue|wed|thu|fri|sat|sun)\s*:/i);
  if (!match) return 1;
  const start = WEEKDAY_INDEX[match[1]];
  const end = WEEKDAY_INDEX[match[2]];
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return 1;
  return end - start + 1;
}

function uidWithBlockSuffix(baseUid, blockNumber) {
  const at = baseUid.indexOf("@");
  const local = at === -1 ? baseUid : baseUid.slice(0, at);
  const domain = at === -1 ? "shape-rotator-os" : baseUid.slice(at + 1);
  return `${local}-block-${blockNumber}@${domain}`;
}

function expandCollectedEvent(event) {
  const blocks = splitCalendarCellBlocks(event.description);
  if (!blocks.length) return [event];
  return blocks.map((block, index) => {
    const timing = parseLeadingTiming(block);
    const rawTitle = timing?.title || stripAllDayPrefix(firstNonEmptyLine(block));
    const summary = truncateSummary(rawTitle);
    const blockNumber = index + 1;
    return {
      ...event,
      uid: index === 0 ? event.uid : uidWithBlockSuffix(event.uid, blockNumber),
      baseUid: event.uid,
      blockIndex: blockNumber,
      summary,
      description: block,
      timeKind: timing ? "timed" : "all_day",
      startMinutes: timing?.startMinutes ?? null,
      endMinutes: timing?.endMinutes ?? null,
      allDaySpanDays: timing ? 1 : parseAllDaySpanDays(block),
    };
  });
}

module.exports = {
  DEFAULT_TIME_ZONE,
  DEFAULT_TIMED_DURATION_MINUTES,
  dateIsoWithOffset,
  expandCollectedEvent,
  firstNonEmptyLine,
  isoDate,
  parseAllDaySpanDays,
  parseLeadingTiming,
  splitCalendarCellBlocks,
  stripAllDayPrefix,
  truncateSummary,
};
