// Reviewed links between freeform Phala calendar blocks and bundled
// transcript files. The calendar text is intentionally not treated as a
// stable event database, so matches use date + title fragments and carry a
// confidence flag for the review trail.

export const CALENDAR_TRANSCRIPT_MATCHES = [
  {
    date: "2026-05-19",
    title_contains: ["Project intros&workflow"],
    section: "info markets and consumer project intros",
    confidence: "high",
    sources: [
      {
        role: "notes",
        label: "project intros notes",
        path: "apps/os/src/content/context/raw-scripts/Day 1 Project Intros Notes May 19 2026.txt",
      },
    ],
  },
  {
    date: "2026-05-20",
    title_contains: ["Tutorial: Dstack"],
    section: "dstack tutorial",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "dstack intro",
        path: "apps/os/src/content/context/raw-scripts/Dstack Intro Salon Session Transcript_May_20.txt",
      },
    ],
  },
  {
    date: "2026-05-20",
    title_contains: ["Project Intros", "Local/Private first"],
    section: "local and private-first project intros",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "local/private intros",
        path: "apps/os/src/content/context/raw-scripts/Project Intros Local Private First Phil Transcript (2)_May_20.txt",
      },
    ],
  },
  {
    date: "2026-05-20",
    title_contains: ["Phil Daian"],
    section: "phil daian founder journey",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "phil segment",
        path: "apps/os/src/content/context/raw-scripts/Project Intros Local Private First Phil Transcript (2)_May_20.txt",
      },
    ],
  },
  {
    date: "2026-05-21",
    title_contains: ["Dumb agent tricks"],
    section: "dumb agent tricks tutorial",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "dumb agent tricks",
        path: "apps/os/src/content/context/raw-scripts/Dumb Agent Tricks Transcript_May_21.txt",
      },
    ],
  },
  {
    date: "2026-05-21",
    title_contains: ["Project Intros", "Agentic"],
    section: "agentic project intros",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "agentic intros",
        path: "apps/os/src/content/context/raw-scripts/Project Intros Agents Day 3 Transcript_May_21.txt",
      },
    ],
  },
  {
    date: "2026-05-22",
    title_contains: ["Project Mappings"],
    section: "project mappings",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "project map guests",
        path: "apps/os/src/content/context/raw-scripts/Shape Rotator Project Map Guests Transcript_May_22.txt",
      },
    ],
  },
  {
    date: "2026-05-22",
    title_contains: ["PMF Roast"],
    section: "pmf roast",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "shaw and greg",
        path: "apps/os/src/content/context/raw-scripts/Friday Shaw & Greg Transcript_May_22.txt",
      },
    ],
  },
  {
    date: "2026-05-22",
    title_contains: ["Founders Journey w/ Shaw"],
    section: "shaw founder journey",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "shaw and greg",
        path: "apps/os/src/content/context/raw-scripts/Friday Shaw & Greg Transcript_May_22.txt",
      },
    ],
  },
  {
    date: "2026-05-26",
    title_contains: ["Project Intros", "Elocute", "Wikigen", "Crossroads"],
    section: "week 2 project intros",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "elocute",
        path: "apps/os/src/content/context/raw-scripts/Elocute Transcript May 26.txt",
      },
      {
        role: "transcript",
        label: "wikigen/crossroads",
        path: "apps/os/src/content/context/raw-scripts/May 26, wikigen, crossroads.txt",
      },
    ],
  },
  {
    date: "2026-05-27",
    title_contains: ["Ideal Customer Profiling", "User Interviews"],
    section: "ideal customer profiling",
    confidence: "high",
    sources: [
      {
        role: "transcript",
        label: "icp user interviews",
        path: "apps/os/src/content/context/raw-scripts/Ideal Customer Profiling User Interviews Transcript from Albiona.txt",
      },
    ],
  },
];
