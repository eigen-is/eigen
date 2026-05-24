// Base ranks for the static command catalog. Sort-only within a rendered section
// (Actions or Selection); higher wins. The two sections render independently, so
// a Selection rank never competes with an Actions rank — CREATE_EIGENDOC and
// DRIVE_RENAME both being 12 is intentional and harmless.
//
// Tuning guide
//
// Actions section (catalog commands shown alongside nav + view):
//   CREATE_EIGENDOC (12) — "New doc", "New sheet", … Slightly above nav because
//     creating is a deliberate verb; the topbar app switcher already covers casual
//     "jump to" navigation, so creation should out-rank it in the empty state.
//   NAV_APP          (10) — "Go to <App>". Mid-tier.
//   CREATE_FOLDER     (8) — Below nav: folders are organisational, not the typical
//     "what do I want to do".
//   VIEW_UTILITY      (4) — Rarely-used preferences (theme toggle, …).
//
// Selection section (drive commands shown when a selection is published, ordered
// open → destructive). Tier spacing leaves room for a future command to slot in
// without re-numbering the chain.
export const BASE_RANKS = {
    CREATE_EIGENDOC: 12,
    NAV_APP: 10,
    CREATE_FOLDER: 8,
    VIEW_UTILITY: 4,

    DRIVE_OPEN: 18,
    DRIVE_OPEN_NEW_TAB: 17,
    DRIVE_QUICK_PREVIEW: 16,
    DRIVE_MAIL_TO: 15,
    DRIVE_COPY_LINK: 14,
    DRIVE_DOWNLOAD: 13,
    DRIVE_RENAME: 12,
    DRIVE_SHARE: 11,
    DRIVE_EMAIL_COLLABORATORS: 10,
    DRIVE_DELETE: 9,
} as const;
