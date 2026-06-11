// Reviewed links between freeform Phala calendar blocks and bundled
// transcript files. The calendar text is intentionally not treated as a
// stable event database, so matches use date + title fragments and carry a
// confidence flag for the review trail.
//
// Sources come in two shapes:
// - { path } — a public-safe file bundled under raw-scripts/ (redacted
//   excerpts and distilled recaps only, per the content policy).
// - { held: "private-vault", vault_id, mentions_direct, mentions_any } —
//   a raw transcript that exists but is held outside the public repo.
//   The timeline anchor (date, session, label, confidence) stays here so
//   the canonical cohort timeline keeps full fidelity; mentions_* are the
//   person/team record_ids whose alias scan hit the raw text, snapshotted
//   when the file left the repo. vault_id is the stable join key for a
//   future gated private-vault fetch.

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
        held: "private-vault",
        vault_id: "day1-project-intros-notes-2026-05-19",
        mentions_direct: ["andrew-forman", "andrew-miller", "enclave", "etherea", "fran", "freya-zhang", "gonzo-gelso", "james-barnes", "josh-chang", "mikeishiring", "novel-tokens", "prova", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sri", "will-cory"],
        mentions_any: ["andrew-forman", "andrew-miller", "enclave", "etherea", "fran", "freya-zhang", "gonzo-gelso", "james-barnes", "josh-chang", "justin-gaffney", "mikeishiring", "novel-tokens", "pramaana", "prova", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sri", "teesql", "will-cory"],
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
        held: "private-vault",
        vault_id: "dstack-intro-salon-2026-05-20",
        mentions_direct: ["andrew-forman", "andrew-miller", "fran", "josh-chang", "lsdan", "quasimatt", "will-cory"],
        mentions_any: ["andrew-forman", "andrew-miller", "fran", "josh-chang", "lsdan", "quasimatt", "teesql", "teleport-router", "will-cory"],
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
        held: "private-vault",
        vault_id: "project-intros-local-private-first-phil-2026-05-20",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "dmarz", "enclave", "fran", "hudson", "hunter-horsfall", "james-barnes", "josh-chang", "kelsen-liu", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "patrick-messall", "qendresa-hoti", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sam-gbafa", "shake", "sm86", "sri", "tinycloud", "will-cory"],
        mentions_any: ["abra", "albiona-hoti", "andrew-forman", "andrew-miller", "bitrouter", "contexto", "dmarz", "elocute", "enclave", "etherea", "fran", "hudson", "hunter-horsfall", "james-barnes", "josh-chang", "kelsen-liu", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "patrick-messall", "pramaana", "qendresa-hoti", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sam-gbafa", "searxng-wth-frnds", "shake", "signalstack", "sm86", "sri", "teesql", "teleport-router", "tinycloud", "will-cory"],
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
        held: "private-vault",
        vault_id: "project-intros-local-private-first-phil-2026-05-20",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "dmarz", "enclave", "fran", "hudson", "hunter-horsfall", "james-barnes", "josh-chang", "kelsen-liu", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "patrick-messall", "qendresa-hoti", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sam-gbafa", "shake", "sm86", "sri", "tinycloud", "will-cory"],
        mentions_any: ["abra", "albiona-hoti", "andrew-forman", "andrew-miller", "bitrouter", "contexto", "dmarz", "elocute", "enclave", "etherea", "fran", "hudson", "hunter-horsfall", "james-barnes", "josh-chang", "kelsen-liu", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "patrick-messall", "pramaana", "qendresa-hoti", "quasimatt", "rajat", "rajat-verma", "roman-svistel", "sam-gbafa", "searxng-wth-frnds", "shake", "signalstack", "sm86", "sri", "teesql", "teleport-router", "tinycloud", "will-cory"],
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
        held: "private-vault",
        vault_id: "dumb-agent-tricks-2026-05-21",
        mentions_direct: ["andrew-forman", "andrew-miller", "archer-yang", "hudson", "hunter-horsfall", "josh-chang", "lsdan", "novel-tokens", "quasimatt", "sm86", "teleport-router", "tinycloud", "will-cory"],
        mentions_any: ["andrew-forman", "andrew-miller", "archer-yang", "contexto", "hudson", "hunter-horsfall", "josh-chang", "lsdan", "novel-tokens", "patrick-messall", "quasimatt", "roman-svistel", "sam-gbafa", "sevenfloor", "signalstack", "sm86", "sxysun", "teesql", "teleport-router", "tinycloud", "will-cory"],
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
        held: "private-vault",
        vault_id: "project-intros-agents-day3-2026-05-21",
        mentions_direct: ["andrew-forman", "andrew-miller", "conclave", "dmarz", "feedling", "gonzo-gelso", "hunter-horsfall", "james-barnes", "josh-chang", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "prakhar", "prova", "quasimatt", "rajat", "rajat-verma", "sm86", "will-cory"],
        mentions_any: ["andrew-forman", "andrew-miller", "conclave", "contexto", "dmarz", "etherea", "feedling", "gonzo-gelso", "hunter-horsfall", "james-barnes", "josh-chang", "justin-gaffney", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "parth-thapliyal", "prakhar", "pramaana", "prova", "quasimatt", "rajat", "rajat-verma", "searxng-wth-frnds", "sm86", "teesql", "teleport-router", "will-cory"],
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
        held: "private-vault",
        vault_id: "shape-rotator-project-map-guests-2026-05-22",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "conclave", "daedalus", "dmarz", "etherea", "feedling", "fran", "gonzo-gelso", "hunter-horsfall", "james-barnes", "josh-chang", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "patrick-messall", "prakhar", "qendresa-hoti", "roman-svistel", "shape-rotator-os", "shaw-walters", "sm86", "teleport-router", "tinycloud", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "conclave", "contexto", "daedalus", "dmarz", "etherea", "feedling", "fran", "freya-zhang", "gonzo-gelso", "hunter-horsfall", "james-barnes", "jay-wang", "josh-chang", "kristel", "kristel-alliksaar", "leo-fang", "lsdan", "novel-tokens", "parth-thapliyal", "patrick-messall", "prakhar", "qendresa-hoti", "roman-svistel", "sam-gbafa", "searxng-wth-frnds", "sevenfloor", "shape-rotator-os", "shaw-walters", "sm86", "sxysun", "teesql", "teleport-router", "tinycloud", "will-cory"],
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
        held: "private-vault",
        vault_id: "friday-shaw-greg-2026-05-22",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "chloe-wang", "daedalus", "dmarz", "fran", "gonzo-gelso", "hunter-horsfall", "james-barnes", "jay-wang", "josh-chang", "kristel", "kristel-alliksaar", "lila-rivers", "lsdan", "novel-tokens", "patrick-messall", "prova", "qendresa-hoti", "quasimatt", "robert-cordwell", "roman-svistel", "shake", "shaw-walters", "sm86", "teleport-router", "vishesh", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "chloe-wang", "contexto", "daedalus", "dmarz", "elocute", "etherea", "fran", "freya-zhang", "gonzo-gelso", "hunter-horsfall", "james-barnes", "jay-wang", "josh-chang", "justin-gaffney", "kristel", "kristel-alliksaar", "leo-fang", "lila-rivers", "lsdan", "novel-tokens", "patrick-messall", "prova", "qendresa-hoti", "quasimatt", "robert-cordwell", "roman-svistel", "searxng-wth-frnds", "sevenfloor", "shake", "shaw-walters", "sm86", "sxysun", "teesql", "teleport-router", "vishesh", "will-cory"],
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
        held: "private-vault",
        vault_id: "friday-shaw-greg-2026-05-22",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "chloe-wang", "daedalus", "dmarz", "fran", "gonzo-gelso", "hunter-horsfall", "james-barnes", "jay-wang", "josh-chang", "kristel", "kristel-alliksaar", "lila-rivers", "lsdan", "novel-tokens", "patrick-messall", "prova", "qendresa-hoti", "quasimatt", "robert-cordwell", "roman-svistel", "shake", "shaw-walters", "sm86", "teleport-router", "vishesh", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "chloe-wang", "contexto", "daedalus", "dmarz", "elocute", "etherea", "fran", "freya-zhang", "gonzo-gelso", "hunter-horsfall", "james-barnes", "jay-wang", "josh-chang", "justin-gaffney", "kristel", "kristel-alliksaar", "leo-fang", "lila-rivers", "lsdan", "novel-tokens", "patrick-messall", "prova", "qendresa-hoti", "quasimatt", "robert-cordwell", "roman-svistel", "searxng-wth-frnds", "sevenfloor", "shake", "shaw-walters", "sm86", "sxysun", "teesql", "teleport-router", "vishesh", "will-cory"],
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
        held: "private-vault",
        vault_id: "elocute-2026-05-26",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "elocute", "josh-chang", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "qendresa-hoti", "quasimatt", "shaw-walters", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "elocute", "josh-chang", "kristel", "kristel-alliksaar", "lsdan", "novel-tokens", "qendresa-hoti", "quasimatt", "shaw-walters", "teesql", "teleport-router", "will-cory"],
      },
      {
        role: "transcript",
        label: "wikigen/crossroads",
        held: "private-vault",
        vault_id: "wikigen-crossroads-gil-pmf-2026-05-26",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "crossroads", "dmarz", "hudson", "james-barnes", "jay-wang", "josh-chang", "lsdan", "novel-tokens", "prova", "qendresa-hoti", "quasimatt", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "crossroads", "dmarz", "elocute", "hudson", "james-barnes", "jay-wang", "josh-chang", "justin-gaffney", "lsdan", "novel-tokens", "prova", "qendresa-hoti", "quasimatt", "searxng-wth-frnds", "signalstack", "teesql", "teleport-router", "will-cory"],
      },
    ],
  },
  {
    date: "2026-05-26",
    title_contains: ["Lecture", "Defining Product Market Fit", "Gil Rosen"],
    section: "gil rosen product market fit lecture",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "gil pmf lecture segment",
        held: "private-vault",
        vault_id: "wikigen-crossroads-gil-pmf-2026-05-26",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "crossroads", "dmarz", "hudson", "james-barnes", "jay-wang", "josh-chang", "lsdan", "novel-tokens", "prova", "qendresa-hoti", "quasimatt", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "archer-yang", "chloe-wang", "crossroads", "dmarz", "elocute", "hudson", "james-barnes", "jay-wang", "josh-chang", "justin-gaffney", "lsdan", "novel-tokens", "prova", "qendresa-hoti", "quasimatt", "searxng-wth-frnds", "signalstack", "teesql", "teleport-router", "will-cory"],
      },
    ],
  },
  {
    date: "2026-05-27",
    title_contains: ["Onboarding for teleport router", "q&a"],
    section: "teleport router onboarding",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "teleport router onboarding",
        held: "private-vault",
        vault_id: "teleport-router-onboarding-2026-05-27",
        mentions_direct: ["andrew-miller", "gonzo-gelso", "james-barnes", "shape-rotator-os", "teleport-router"],
        mentions_any: ["andrew-miller", "gonzo-gelso", "james-barnes", "shape-rotator-os", "teleport-router"],
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
        held: "private-vault",
        vault_id: "icp-user-interviews-2026-05-27",
        mentions_direct: ["albiona-hoti", "andrew-forman", "andrew-miller", "feedling", "hunter-horsfall", "james-barnes", "josh-chang", "kristel", "kristel-alliksaar", "patrick-messall", "qendresa-hoti", "quasimatt", "sevenfloor", "tinycloud", "will-cory"],
        mentions_any: ["albiona-hoti", "andrew-forman", "andrew-miller", "elocute", "etherea", "feedling", "hunter-horsfall", "james-barnes", "josh-chang", "kristel", "kristel-alliksaar", "patrick-messall", "qendresa-hoti", "quasimatt", "roman-svistel", "sam-gbafa", "sevenfloor", "teesql", "teleport-router", "tinycloud", "will-cory"],
      },
    ],
  },
  {
    date: "2026-05-28",
    title_contains: ["Agentic Tooling workshops/clinic"],
    section: "agentic tooling clinic",
    confidence: "medium",
    sources: [
      {
        role: "transcript",
        label: "agentic tooling workshop",
        held: "private-vault",
        vault_id: "agentic-tooling-workshop-2026-05-28",
        mentions_direct: ["andrew-miller", "dmarz", "elizaos", "shaw-walters"],
        mentions_any: ["andrew-miller", "dmarz", "elizaos", "shaw-walters"],
      },
    ],
  },
  {
    date: "2026-06-08",
    title_contains: ["WDYDLW with Shaw"],
    section: "wdydlw standup #1 — what thirteen teams shipped",
    confidence: "high",
    sources: [
      {
        role: "recap",
        label: "wdydlw standup recap (reconstructed)",
        path: "apps/os/src/content/context/raw-scripts/WDYDLW Standup Recap June 8 2026.txt",
      },
    ],
  },
];
