// Writes Eigen-owned edits back into a stored vCard while preserving every byte we don't own. Owned
// properties are diffed against the parsed projection (Task 3): a multi-value line (EMAIL/TEL/ADR) whose
// value is unchanged keeps its exact source bytes, a removed value drops its line (plus any now-orphaned
// same-group X- label), and a single-value property is rewritten in place keeping its group and params.
// Everything else — IMPP, URL, X-SOCIALPROFILE, unknown props, VERSION/UID/PRODID/REV — rides through
// untouched. `createVCard` emits the minimal clean 3.0 card a brand-new contact starts from.
import type { Address } from '@workspace/lib/types/contact';
import { escapeText, makeLine, serializeVCardLines, unescapeText, type VCardLine } from './vcard-ast';
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
    return `;;${escapeText(a.street ?? '')};${escapeText(a.city ?? '')};${escapeText(a.state ?? '')};${escapeText(a.zipCode ?? '')};${escapeText(a.country ?? '')}`;
}

function photoBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

// vCard 3.0 PHOTO TYPE is the bare, uppercased image subtype ('image/jpeg' -> 'JPEG').
function photoParams(mediaType: string): [string, string][] {
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

// Rewrite the first line named `name` in place (keeping its group + params), or insert it before END.
function rewriteFirst(lines: VCardLine[], name: string, value: string): VCardLine[] {
    const idx = lines.findIndex((l) => l.name === name);
    if (idx === -1) return insertBeforeEnd(lines, [makeLine(name, value)]);
    const next = lines.slice();
    next[idx] = { ...lines[idx], value, raw: null };
    return next;
}

// A cleared value (empty string / null) removes every line named `name`; otherwise rewrite the first in
// place. `params` replaces the existing params (PHOTO only); omitted keeps them.
function setOrRemove(lines: VCardLine[], name: string, value: string | null, params?: [string, string][]): VCardLine[] {
    if (value === null || value === '') return lines.filter((l) => l.name !== name);
    const idx = lines.findIndex((l) => l.name === name);
    if (idx === -1) return insertBeforeEnd(lines, [makeLine(name, value, params)]);
    const next = lines.slice();
    next[idx] = { ...lines[idx], value, params: params ?? lines[idx].params, raw: null };
    return next;
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
    for (const value of remaining) toAppend.push(makeLine(name, escapeText(value)));
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

    // Single-value owned props rewrite the first line in place (or remove it when the edit clears it).
    if (edits.firstName !== undefined || edits.lastName !== undefined) {
        const first = edits.firstName ?? card.firstName;
        const last = edits.lastName ?? card.lastName;
        result = rewriteFirst(result, 'N', `${escapeText(last)};${escapeText(first)};;;`);
        result = rewriteFirst(result, 'FN', escapeText(`${first} ${last}`.trim()));
    }
    if (edits.company !== undefined) result = setOrRemove(result, 'ORG', escapeText(edits.company));
    if (edits.jobTitle !== undefined) result = setOrRemove(result, 'TITLE', escapeText(edits.jobTitle));
    if (edits.birthday !== undefined) result = setOrRemove(result, 'BDAY', edits.birthday);
    if (edits.notes !== undefined) result = setOrRemove(result, 'NOTE', escapeText(edits.notes));
    if (edits.categories !== undefined) {
        result = setOrRemove(result, 'CATEGORIES', edits.categories.map(escapeText).join(','));
    }
    if (edits.eigenId !== undefined) result = setOrRemove(result, 'X-EIGEN-ID', edits.eigenId);
    if (edits.photo !== undefined) {
        result = edits.photo
            ? setOrRemove(result, 'PHOTO', photoBase64(edits.photo.bytes), photoParams(edits.photo.mediaType))
            : setOrRemove(result, 'PHOTO', null);
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
        makeLine('N', `${escapeText(input.lastName)};${escapeText(input.firstName)};;;`),
        makeLine('FN', escapeText(`${input.firstName} ${input.lastName}`.trim())),
    ];
    for (const email of input.email) lines.push(makeLine('EMAIL', escapeText(email)));
    for (const phone of input.phone) lines.push(makeLine('TEL', escapeText(phone)));
    for (const a of input.address ?? []) lines.push(makeLine('ADR', buildAddressValue(a)));
    if (input.company) lines.push(makeLine('ORG', escapeText(input.company)));
    if (input.jobTitle) lines.push(makeLine('TITLE', escapeText(input.jobTitle)));
    if (input.birthday) lines.push(makeLine('BDAY', input.birthday));
    if (input.notes) lines.push(makeLine('NOTE', escapeText(input.notes)));
    if (input.categories?.length) lines.push(makeLine('CATEGORIES', input.categories.map(escapeText).join(',')));
    if (input.eigenId) lines.push(makeLine('X-EIGEN-ID', input.eigenId));
    if (input.photo) lines.push(makeLine('PHOTO', photoBase64(input.photo.bytes), photoParams(input.photo.mediaType)));
    lines.push(makeLine('END', 'VCARD'));
    return serializeVCardLines(lines);
}
