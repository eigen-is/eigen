import type { PaletteResult, PaletteScope, ResultGroup, Sections } from '@workspace/lib/types/command-palette';
import { structuralMatchQuality } from './rank';

type BuildInput = {
    action: PaletteResult[];
    contact: PaletteResult[];
    smart: PaletteResult[];
    mail: PaletteResult[];
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
// the rendered Sections. The caller (useCommandResults) holds back the call while a
// search is in flight — so this never sees a partial state and never has to gate on
// pending. That gate is what made the palette feel unstable: local providers were
// updating before mail joined, then everything reordered when the search came back.
export function buildSections(input: BuildInput): Sections {
    // Empty input → suggested only, ignoring search / smart / contacts.
    if (input.input.trim().length === 0) {
        const ids = input.suggestedCommandIds ?? [];
        const suggested = input.action
            .filter((r) => ids.includes(r.id))
            .map((r) => (r.kind === 'action' ? ({ ...r, group: 'suggested' as ResultGroup } as PaletteResult) : r));
        return {
            topHit: undefined,
            groups: suggested.length
                ? [{ id: 'suggested', heading: 'Suggested', items: suggested.slice(0, SECTION_CAP) }]
                : [],
        };
    }

    // Scope filter — drop everything except the selected source. Smart is hidden
    // under any scope; the user has narrowed intent and cross-kind suggestions would
    // muddy that.
    let actionList = input.scope && input.scope !== 'actions' ? [] : input.action;
    let mailList = input.scope && input.scope !== 'mail' ? [] : input.mail;
    let contactList = input.scope && input.scope !== 'contacts' ? [] : input.contact;
    const smartList = input.scope ? [] : input.smart;

    // Engine owns final ordering: sort by descending rank, then cap. Providers can set rank
    // however they like; the engine guarantees the section is in rank order.
    actionList = [...actionList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    mailList = [...mailList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);
    contactList = [...contactList].sort((a, b) => b.rank - a.rank).slice(0, SECTION_CAP);

    // Top Hit: a deterministic smart parse claims it outright; otherwise the strongest
    // structural title match across the merged candidates wins.
    let topHit: PaletteResult | undefined;
    const deterministicSmart = smartList.find((r) => r.kind === 'smart' && r.deterministic);
    if (deterministicSmart) {
        topHit = { ...deterministicSmart, group: 'top-hit' };
    } else {
        const candidates: PaletteResult[] = [...actionList, ...mailList, ...contactList];
        let bestQuality = 0;
        for (const r of candidates) {
            const q = structuralMatchQuality(input.input, r.title);
            if (q && QUALITY_RANK[q] > bestQuality) {
                bestQuality = QUALITY_RANK[q];
                topHit = { ...r, group: 'top-hit' };
            }
        }
    }

    const groups: Sections['groups'] = [];
    // v1 invariant: every smart result is deterministic — the smart provider only ever
    // emits results with `deterministic: true` for email/URL shapes. Any deterministic smart
    // already claimed the Top Hit above, so we don't render a separate smart section here.
    if (actionList.length > 0) groups.push({ id: 'actions', heading: 'Actions', items: actionList });
    if (mailList.length > 0) groups.push({ id: 'mail', heading: 'Mail', items: mailList });
    if (contactList.length > 0) groups.push({ id: 'contacts', heading: 'Contacts', items: contactList });

    // Don't double-render the Top Hit in its own section. Filter by id from each group.
    if (topHit) {
        for (const g of groups) {
            g.items = g.items.filter((r) => r.id !== topHit!.id);
        }
    }

    return { topHit, groups };
}
