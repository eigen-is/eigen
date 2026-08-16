// Writes Eigen-owned edits back into a stored vCard while preserving every byte we don't own. Owned
// properties are diffed against the parsed projection (Task 3): a multi-value line (EMAIL/TEL/ADR) whose
// value is unchanged keeps its exact source bytes, a removed value drops its line (plus any now-orphaned
// same-group X- label), and an edited single-value property is rewritten in place — keeping the first line's
// group and params, and taking the whole property name so no repeated line of it survives the edit.
// Everything else — IMPP, URL, X-SOCIALPROFILE, unknown props, VERSION/UID/PRODID/REV — rides through
// untouched. `createVCard` emits the minimal clean 3.0 card a brand-new contact starts from.
import type { Address } from '@workspace/lib/types/contact';
import { escapeContentText, stripLineBreaks } from '../core/content-line';
import { makeLine, serializeVCardLines, unescapeText, type VCardLine } from './vcard-ast';
import type { ParsedCard } from './vcard-parse';

export type CardEdits = Partial<{
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    address: Address[];
    company: string;
    jobTitle: string;
    birthday: string;
    notes: string;
    categories: string[];
    eigenId: string | null; // null = remove X-EIGEN-ID
    photo: { bytes: Uint8Array; mediaType: string } | null; // null = remove PHOTO; absent key = keep
}>;

// BDAY is written verbatim (dates aren't TEXT-escaped), so only a strict YYYY-MM-DD value is ever emitted —
// exactly what the parse side can produce. Any other non-empty value is treated as a clear, closing the
// CR/newline injection path a raw BDAY string would otherwise open.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addressEquals(a: Address, b: Address): boolean {
    return (
        (a.street ?? '') === (b.street ?? '') &&
        (a.city ?? '') === (b.city ?? '') &&
        (a.state ?? '') === (b.state ?? '') &&
        (a.zipCode ?? '') === (b.zipCode ?? '') &&
        (a.country ?? '') === (b.country ?? '')
    );
}

// PO;ext;street;locality;region;code;country — Eigen owns only the last five components.
function buildAddressValue(a: Address): string {
    return `;;${escapeContentText(a.street ?? '')};${escapeContentText(a.city ?? '')};${escapeContentText(a.state ?? '')};${escapeContentText(a.zipCode ?? '')};${escapeContentText(a.country ?? '')}`;
}

function photoBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

// vCard 3.0 PHOTO TYPE is the bare, uppercased image subtype ('image/jpeg' -> 'JPEG').
export function photoParams(mediaType: string): [string, string][] {
    const subtype = mediaType.split('/')[1] ?? mediaType;
    return [
        ['ENCODING', 'b'],
        ['TYPE', subtype.toUpperCase()],
    ];
}

function insertBeforeEnd(lines: VCardLine[], added: VCardLine[]): VCardLine[] {
    if (added.length === 0) return lines;
    const idx = lines.findIndex((l) => l.name === 'END');
    return [...lines.slice(0, idx), ...added, ...lines.slice(idx)];
}

// Rewrite `name` as one line at the position of its first occurrence (keeping that line's group; params
// replaced only when given) and drop every further line of the same name, or insert before END when the card
// has none. Editing an owned property takes the whole name: CATEGORIES and NOTE are legally repeatable, but an
// owned edit replaces the whole property, so any repeated line — even one the projection folded in (CATEGORIES
// aggregates every line) — can't survive to drift from what the app just wrote.
function rewriteOwned(lines: VCardLine[], name: string, value: string, params?: [string, string][]): VCardLine[] {
    const idx = lines.findIndex((l) => l.name === name);
    if (idx === -1) return insertBeforeEnd(lines, [makeLine(name, value, params)]);
    const next: VCardLine[] = [];
    for (const [i, line] of lines.entries()) {
        if (line.name !== name) next.push(line);
        else if (i === idx) next.push({ ...line, value, ...(params && { params }), raw: null });
    }
    return next;
}

// Value-keyed write for a single-value owned prop: an unchanged value leaves the line byte-identical (the
// Task 8 full-replacement seam echoes every owned key on every save, so presence alone must not rewrite).
// A changed or cleared value owns every line named `name`.
function writeSingle(lines: VCardLine[], name: string, changed: boolean, value: string | null): VCardLine[] {
    if (!changed) return lines;
    if (value === null) return lines.filter((l) => l.name !== name);
    return rewriteOwned(lines, name, value);
}

// Index of the first unescaped ';' in a structured value, or -1 — a preceding backslash escapes it.
function firstUnescapedSemi(value: string): number {
    for (let i = 0; i < value.length; i++) {
        if (value[i] === '\\') i++;
        else if (value[i] === ';') return i;
    }
    return -1;
}

// A company change keeps the card's existing trailing ORG components verbatim (`Acme;Engineering` +
// `NewCorp` -> `NewCorp;Engineering`) — the department is unowned bytes, not ours to destroy.
function buildOrgValue(card: ParsedCard, company: string): string {
    const existing = card.lines.find((l) => l.name === 'ORG');
    if (!existing) return escapeContentText(company);
    const semi = firstUnescapedSemi(existing.value);
    return escapeContentText(company) + (semi === -1 ? '' : existing.value.slice(semi));
}

// Order-insensitive multiset equality — CATEGORIES is a set of labels, order carries no meaning.
function sameNames(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
}

// Diff a text-valued multi-value property (EMAIL/TEL): kept lines stay byte-for-byte, unmatched lines are
// marked for removal, and wanted values with no matching line append a bare new line.
function diffText(
    lines: VCardLine[],
    name: string,
    wanted: string[],
    toRemove: Set<VCardLine>,
    toAppend: VCardLine[],
): void {
    const remaining = [...wanted];
    for (const line of lines) {
        if (line.name !== name) continue;
        const pos = remaining.indexOf(unescapeText(line.value).trim());
        if (pos === -1) toRemove.add(line);
        else remaining.splice(pos, 1);
    }
    for (const value of remaining) toAppend.push(makeLine(name, escapeContentText(value)));
}

// ADR diffs by the mapped Address (field-wise, '' ≡ absent). Existing ADR lines correspond positionally to
// `card.address`, so we compare against the projection instead of re-parsing the value.
function diffAddresses(card: ParsedCard, wanted: Address[], toRemove: Set<VCardLine>, toAppend: VCardLine[]): void {
    const remaining = [...wanted];
    let k = 0;
    for (const line of card.lines) {
        if (line.name !== 'ADR') continue;
        const existing = card.address[k++];
        const pos = remaining.findIndex((a) => addressEquals(a, existing));
        if (pos === -1) toRemove.add(line);
        else remaining.splice(pos, 1);
    }
    for (const a of remaining) toAppend.push(makeLine('ADR', buildAddressValue(a)));
}

export function mergeVCard(card: ParsedCard, edits: CardEdits): string {
    // Multi-value owned props: diff EMAIL/TEL/ADR against the projection, collecting drops + appends. Only
    // touched when the edit key is present.
    const toRemove = new Set<VCardLine>();
    const toAppend: VCardLine[] = [];
    if (edits.email !== undefined) diffText(card.lines, 'EMAIL', edits.email, toRemove, toAppend);
    if (edits.phone !== undefined) diffText(card.lines, 'TEL', edits.phone, toRemove, toAppend);
    if (edits.address !== undefined) diffAddresses(card, edits.address, toRemove, toAppend);

    // Dropping a grouped value orphans its label (item1.EMAIL + item1.X-ABLabel): once nothing non-X keeps
    // the group, drop the group's X- lines too.
    const removedGroups = new Set<string>();
    for (const line of toRemove) if (line.group) removedGroups.add(line.group);
    for (const group of removedGroups) {
        const anchored = card.lines.some((l) => l.group === group && !l.name.startsWith('X-') && !toRemove.has(l));
        if (!anchored) {
            for (const l of card.lines) if (l.group === group && l.name.startsWith('X-')) toRemove.add(l);
        }
    }

    let result = card.lines.filter((l) => !toRemove.has(l));

    // Single-value owned props are value-keyed: only a genuinely changed value rewrites its line, so an
    // unchanged name/company/… on a full-projection save keeps its exact bytes (Apple's N middle name, an
    // ORG department). N/FN are rewritten as a pair, or skipped entirely when neither name changed.
    if (edits.firstName !== undefined || edits.lastName !== undefined) {
        const first = edits.firstName ?? card.firstName;
        const last = edits.lastName ?? card.lastName;
        if (first !== card.firstName || last !== card.lastName) {
            result = rewriteOwned(result, 'N', `${escapeContentText(last)};${escapeContentText(first)};;;`);
            result = rewriteOwned(result, 'FN', escapeContentText(`${first} ${last}`.trim()));
        }
    }
    if (edits.company !== undefined) {
        const changed = edits.company !== card.company;
        result = writeSingle(result, 'ORG', changed, edits.company === '' ? null : buildOrgValue(card, edits.company));
    }
    if (edits.jobTitle !== undefined) {
        const value = edits.jobTitle === '' ? null : escapeContentText(edits.jobTitle);
        result = writeSingle(result, 'TITLE', edits.jobTitle !== card.jobTitle, value);
    }
    if (edits.birthday !== undefined) {
        const birthday = ISO_DATE.test(edits.birthday) ? edits.birthday : '';
        const value = birthday === '' ? null : birthday;
        result = writeSingle(result, 'BDAY', birthday !== card.birthday, value);
    }
    if (edits.notes !== undefined) {
        const value = edits.notes === '' ? null : escapeContentText(edits.notes);
        result = writeSingle(result, 'NOTE', edits.notes !== card.notes, value);
    }
    if (edits.categories !== undefined) {
        const value = edits.categories.length === 0 ? null : edits.categories.map(escapeContentText).join(',');
        result = writeSingle(result, 'CATEGORIES', !sameNames(edits.categories, card.categories), value);
    }
    if (edits.eigenId !== undefined) {
        // X-EIGEN-ID is written verbatim (an arbitrary id from another server rides through by shape), so the
        // only sanitize is stripping CR/LF that would otherwise inject a new content line off the REST body.
        const eigenId = edits.eigenId === null ? null : stripLineBreaks(edits.eigenId);
        const changed = (eigenId ?? '') !== (card.eigenId ?? '');
        result = writeSingle(result, 'X-EIGEN-ID', changed, eigenId ? eigenId : null);
    }
    if (edits.photo !== undefined) {
        // Presence-triggered: callers only pass the key when the photo actually changed. Fresh ENCODING=b
        // params replace whatever the old PHOTO line carried.
        result = edits.photo
            ? rewriteOwned(result, 'PHOTO', photoBase64(edits.photo.bytes), photoParams(edits.photo.mediaType))
            : result.filter((l) => l.name !== 'PHOTO');
    }

    return serializeVCardLines(insertBeforeEnd(result, toAppend));
}

export function createVCard(
    input: {
        firstName: string;
        lastName: string;
        email: string[];
        phone: string[];
        company?: string;
        jobTitle?: string;
        address?: Address[];
        birthday?: string;
        notes?: string;
        categories?: string[];
        eigenId?: string;
        photo?: { bytes: Uint8Array; mediaType: string };
    },
    uid: string,
): string {
    const lines: VCardLine[] = [
        makeLine('BEGIN', 'VCARD'),
        makeLine('VERSION', '3.0'),
        makeLine('PRODID', '-//Eigen//CardDAV//EN'),
        makeLine('UID', uid),
        makeLine('N', `${escapeContentText(input.lastName)};${escapeContentText(input.firstName)};;;`),
        makeLine('FN', escapeContentText(`${input.firstName} ${input.lastName}`.trim())),
    ];
    for (const email of input.email) lines.push(makeLine('EMAIL', escapeContentText(email)));
    for (const phone of input.phone) lines.push(makeLine('TEL', escapeContentText(phone)));
    for (const a of input.address ?? []) lines.push(makeLine('ADR', buildAddressValue(a)));
    if (input.company) lines.push(makeLine('ORG', escapeContentText(input.company)));
    if (input.jobTitle) lines.push(makeLine('TITLE', escapeContentText(input.jobTitle)));
    if (input.birthday && ISO_DATE.test(input.birthday)) lines.push(makeLine('BDAY', input.birthday));
    if (input.notes) lines.push(makeLine('NOTE', escapeContentText(input.notes)));
    if (input.categories?.length) lines.push(makeLine('CATEGORIES', input.categories.map(escapeContentText).join(',')));
    // Verbatim id, minus the CR/LF that would inject a second content line off the REST body (mirrors the BDAY guard).
    if (input.eigenId) lines.push(makeLine('X-EIGEN-ID', stripLineBreaks(input.eigenId)));
    if (input.photo) lines.push(makeLine('PHOTO', photoBase64(input.photo.bytes), photoParams(input.photo.mediaType)));
    lines.push(makeLine('END', 'VCARD'));
    return serializeVCardLines(lines);
}
