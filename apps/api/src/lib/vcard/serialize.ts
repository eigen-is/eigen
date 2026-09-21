// Writes Eigen-owned edits back into a stored card while preserving every byte Eigen does not own.
import { escapeContentText, stripLineBreaks } from '@workspace/lib/content-line';
import type { Address } from '@workspace/lib/types/contact';
import { makeLine, photoParams, serializeVCardLines, splitValue, unescapeText } from './ast';
import { ISO_DATE } from './parse';
import type { CardEdits, ParsedCard, VCardLine } from './types';

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

function insertBeforeEnd(lines: VCardLine[], added: VCardLine[]): VCardLine[] {
    if (added.length === 0) return lines;
    const idx = lines.findIndex((l) => l.name === 'END');
    return [...lines.slice(0, idx), ...added, ...lines.slice(idx)];
}

// An owned edit takes the whole property name, so no repeated line survives to drift from what the app just wrote.
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

// updateContact echoes every owned key on every save, so presence alone must not rewrite a byte-identical line.
function writeSingle(lines: VCardLine[], name: string, changed: boolean, value: string | null): VCardLine[] {
    if (!changed) return lines;
    if (value === null) return lines.filter((l) => l.name !== name);
    return rewriteOwned(lines, name, value);
}

// A company change keeps the trailing ORG components verbatim: the department is unowned bytes.
function buildOrgValue(card: ParsedCard, company: string): string {
    const existing = card.lines.find((l) => l.name === 'ORG');
    if (!existing) return escapeContentText(company);
    const [, ...rest] = splitValue(existing.value, ';');
    return [escapeContentText(company), ...rest].join(';');
}

// A rename keeps N components 3-5 verbatim (Apple's middle name, prefix and suffix): they are unowned bytes.
function buildNameValue(card: ParsedCard, first: string, last: string): string {
    const owned = `${escapeContentText(last)};${escapeContentText(first)}`;
    const existing = card.lines.find((l) => l.name === 'N');
    const rest = existing ? splitValue(existing.value, ';').slice(2) : [];
    return rest.length === 0 ? `${owned};;;` : `${owned};${rest.join(';')}`;
}

// Order-insensitive multiset equality — CATEGORIES is a set of labels, order carries no meaning.
function sameNames(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const x = [...a].sort();
    const y = [...b].sort();
    return x.every((v, i) => v === y[i]);
}

// One line out against one value in is an edit, so the new line inherits the dropped line's group and params.
function appendDiffed(name: string, values: string[], dropped: VCardLine[], toAppend: VCardLine[]): void {
    const edited = dropped.length === 1 && values.length === 1 ? dropped[0] : null;
    for (const value of values) toAppend.push(makeLine(name, value, edited?.params, edited?.group ?? null));
}

function diffText(
    lines: VCardLine[],
    name: string,
    wanted: string[],
    toRemove: Set<VCardLine>,
    toAppend: VCardLine[],
): void {
    const remaining = [...wanted];
    const dropped: VCardLine[] = [];
    for (const line of lines) {
        if (line.name !== name) continue;
        const pos = remaining.indexOf(unescapeText(line.value).trim());
        if (pos === -1) {
            dropped.push(line);
            toRemove.add(line);
        } else remaining.splice(pos, 1);
    }
    appendDiffed(name, remaining.map(escapeContentText), dropped, toAppend);
}

// ADR lines correspond positionally to `card.address`, so the diff compares the projection instead of re-parsing.
function diffAddresses(card: ParsedCard, wanted: Address[], toRemove: Set<VCardLine>, toAppend: VCardLine[]): void {
    const remaining = [...wanted];
    const dropped: VCardLine[] = [];
    let k = 0;
    for (const line of card.lines) {
        if (line.name !== 'ADR') continue;
        const existing = card.address[k++];
        const pos = remaining.findIndex((a) => addressEquals(a, existing));
        if (pos === -1) {
            dropped.push(line);
            toRemove.add(line);
        } else remaining.splice(pos, 1);
    }
    appendDiffed('ADR', remaining.map(buildAddressValue), dropped, toAppend);
}

export function mergeVCard(card: ParsedCard, edits: CardEdits): string {
    const toRemove = new Set<VCardLine>();
    const toAppend: VCardLine[] = [];
    if (edits.email !== undefined) diffText(card.lines, 'EMAIL', edits.email, toRemove, toAppend);
    if (edits.phone !== undefined) diffText(card.lines, 'TEL', edits.phone, toRemove, toAppend);
    if (edits.address !== undefined) diffAddresses(card, edits.address, toRemove, toAppend);

    // Once nothing non-X keeps a group, its X- label lines are orphans (item1.X-ABLabel) and go too.
    const removedGroups = new Set<string>();
    for (const line of toRemove) if (line.group) removedGroups.add(line.group);
    for (const group of removedGroups) {
        const anchored =
            toAppend.some((l) => l.group === group) ||
            card.lines.some((l) => l.group === group && !l.name.startsWith('X-') && !toRemove.has(l));
        if (!anchored) {
            for (const l of card.lines) if (l.group === group && l.name.startsWith('X-')) toRemove.add(l);
        }
    }

    let result = card.lines.filter((l) => !toRemove.has(l));

    // Only a genuinely changed value rewrites its line, so a full-projection save keeps the unchanged bytes; N and FN move as a pair.
    if (edits.firstName !== undefined || edits.lastName !== undefined) {
        const first = edits.firstName ?? card.firstName;
        const last = edits.lastName ?? card.lastName;
        if (first !== card.firstName || last !== card.lastName) {
            result = rewriteOwned(result, 'N', buildNameValue(card, first, last));
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
        // BDAY is written verbatim, so anything but a strict ISO date is a clear: that closes the newline injection path.
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
        // X-EIGEN-ID is written verbatim, so stripping CR/LF is what stops a REST body injecting a second content line.
        const eigenId = edits.eigenId === null ? null : stripLineBreaks(edits.eigenId);
        const changed = (eigenId ?? '') !== (card.eigenId ?? '');
        result = writeSingle(result, 'X-EIGEN-ID', changed, eigenId ? eigenId : null);
    }
    if (edits.photo !== undefined) {
        // Presence-triggered: callers pass the key only when the photo actually changed.
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
