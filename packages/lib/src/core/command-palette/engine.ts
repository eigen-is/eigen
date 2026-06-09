import type { PaletteResult, PaletteScope, Sections } from '@workspace/lib/types/command-palette';
import { structuralMatchQuality } from './rank';

type BuildInput = {
    action: PaletteResult[];
    contact: PaletteResult[];
    smart: PaletteResult[];
    mail: PaletteResult[];
    file: PaletteResult[];
    help: PaletteResult[];
    input: string;
    scope?: PaletteScope;
    suggestedCommandIds?: string[];
};

const SECTION_CAP = 6;

const QUALITY_RANK: Record<NonNullable<ReturnType<typeof structuralMatchQuality>>, number> = {
    exact: 3,
    'title-prefix': 2,
    'all-tokens-in-title': 1,
};

// Pure merge function: given the four provider outputs for a settled query, produce
// the rendered Sections. The caller (useCommandResults) holds the call back while a
// search is in flight — so this never sees a partial state and never has to gate on
// pending.
//
// Section order top-to-bottom:
//   1. Top Hit            — a deterministic smart parse, else strongest structural match
//   2. Suggestions        — non-deterministic smart results (e.g. "Send mail to <email>"
//                           derived from a contact name match), shown alongside Top Hit
//   3. Selection          — selection-aware actions (Share X, Preview X, …) when a
//                           selection is present
//   4. Files              — search results
//   5. Mail               — search results
//   6. Contacts           — search results
//   7. Help               — help-centre articles (client-side Pagefind)
//   8. Actions            — catalog commands ("Go to Mail", "New doc", …)
//
// Catalog actions live at the bottom because they're the least time-sensitive — the
// user reaches them via type-to-match. Search results and selection-aware actions are
// what the user usually opens the palette for and belong above.
export function buildSections(input: BuildInput): Sections {
    const actionList = input.action.filter((r) => r.group === 'actions');
    const selectionList = input.action.filter((r) => r.group === 'selection');

    // Empty input: prefer the selection actions (always shown when a selection exists);
    // otherwise fall back to the curated Suggested set of catalog actions.
    if (input.input.trim().length === 0) {
        if (selectionList.length > 0) {
            const capped = [...selectionList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
            return { topHit: undefined, groups: [{ id: 'selection', heading: 'Selection', items: capped }] };
        }
        const ids = input.suggestedCommandIds ?? [];
        const suggested = actionList.flatMap<PaletteResult>((r) =>
            r.kind === 'action' && ids.includes(r.id) ? [{ ...r, group: 'suggested' }] : [],
        );
        return {
            topHit: undefined,
            groups: suggested.length
                ? [{ id: 'suggested', heading: 'Suggested', items: suggested.slice(0, SECTION_CAP) }]
                : [],
        };
    }

    // Scope filter — drop everything except the selected source. Selection-aware items
    // stay visible under any scope (the user can still act on the current item even
    // while narrowing the result list to a kind). Smart is hidden under any scope.
    const inActionsScope = !input.scope || input.scope === 'actions';
    let scopedActions = inActionsScope ? actionList : [];
    let mailList = input.scope && input.scope !== 'mail' ? [] : input.mail;
    let fileList = input.scope && input.scope !== 'file' ? [] : input.file;
    let contactList = input.scope && input.scope !== 'contacts' ? [] : input.contact;
    let helpList = input.scope && input.scope !== 'help' ? [] : input.help;
    const smartList = input.scope ? [] : input.smart;

    // Engine owns final ordering: sort by descending rank, then cap.
    scopedActions = [...scopedActions].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    mailList = [...mailList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    fileList = [...fileList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    contactList = [...contactList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    helpList = [...helpList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    const scopedSelection = [...selectionList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);

    // Top Hit: a deterministic smart parse claims it outright; otherwise the strongest
    // structural title match across the merged candidates wins.
    let topHit: PaletteResult | undefined;
    const deterministicSmart = smartList.find((r) => r.kind === 'smart' && r.deterministic);
    if (deterministicSmart) {
        topHit = { ...deterministicSmart, group: 'top-hit' };
    } else {
        const candidates: PaletteResult[] = [
            ...scopedSelection,
            ...fileList,
            ...mailList,
            ...contactList,
            ...helpList,
            ...scopedActions,
        ];
        let bestQuality = 0;
        for (const r of candidates) {
            const q = structuralMatchQuality(input.input, r.title);
            if (q && QUALITY_RANK[q] > bestQuality) {
                bestQuality = QUALITY_RANK[q];
                topHit = { ...r, group: 'top-hit' };
            }
        }
    }

    // Suggestions section: non-deterministic smart results that don't claim Top Hit
    // but are still relevant to the query (e.g., "Send mail to <email>" derived from
    // a matched contact name).
    const suggestionsList = smartList
        .filter((r) => r.kind === 'smart' && !r.deterministic)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, SECTION_CAP);

    const groups: Sections['groups'] = [];
    if (suggestionsList.length > 0) groups.push({ id: 'smart', heading: 'Suggestions', items: suggestionsList });
    if (scopedSelection.length > 0) groups.push({ id: 'selection', heading: 'Selection', items: scopedSelection });
    if (fileList.length > 0) groups.push({ id: 'file', heading: 'Files', items: fileList });
    if (mailList.length > 0) groups.push({ id: 'mail', heading: 'Mail', items: mailList });
    if (contactList.length > 0) groups.push({ id: 'contacts', heading: 'Contacts', items: contactList });
    if (helpList.length > 0) groups.push({ id: 'help', heading: 'Help', items: helpList });
    if (scopedActions.length > 0) groups.push({ id: 'actions', heading: 'Actions', items: scopedActions });

    // Don't double-render the Top Hit in its own section, and drop any group that
    // became empty after the dedup (otherwise an orphan "Contacts" header renders
    // when the only contact got promoted to Top Hit).
    const finalGroups = topHit
        ? groups
              .map((g) => ({ ...g, items: g.items.filter((r) => r.id !== topHit.id) }))
              .filter((g) => g.items.length > 0)
        : groups;

    return { topHit, groups: finalGroups };
}
