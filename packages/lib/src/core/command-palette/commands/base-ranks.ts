// The base ranks of the static command catalog, which order the Actions section; higher wins. They
// only sort within that section. The Selection section is ordered by the rows a page published, so
// none of these ranks competes with a selection row.
//
//   CREATE_EIGENDOC (12): "New doc", "New sheet" and the rest. Above nav, because creating is a
//     deliberate verb, and the topbar's app switcher already covers a casual jump to an app.
//   NAV_APP (10): "Go to <App>".
//   CREATE_FOLDER (8): below nav, because a folder organizes rather than starts the work.
//   VIEW_UTILITY (4): preferences people rarely change, such as the theme toggle.

export const BASE_RANKS = {
    CREATE_EIGENDOC: 12,
    NAV_APP: 10,
    CREATE_FOLDER: 8,
    VIEW_UTILITY: 4,
} as const;
