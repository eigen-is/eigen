import { IMPORT_MAX_CARDS } from '@workspace/lib/constants/contact';
import { formatContactAddress, formatContactCompany, formatContactRole } from '@workspace/lib/contacts/format';
import { formatDateOnly } from '@workspace/lib/date';
import { escapeHtml } from '@workspace/lib/html';
import type { Contact } from '@workspace/lib/types/contact';
import {
    droppedLine,
    parsedCardToContact,
    parseVCard,
    remainingLine,
    splitVCards,
    transcodeTo30,
} from '@workspace/lib/vcard';
import type { TransformWarning } from '../document/transform/protocol';
import { sanitizeExportHtml } from '../export/sanitize';
import { applyPreviewByteGuard, renderPreviewNotice } from './preview-marker';

// File bytes → sanitized preview body. Runs inside the transform Worker (worker.ts owns execution;
// the main-thread orchestration lives in preview-cache.ts). This module must not reach the Mount or
// the transform seam — the Worker imports it.
//
// It shows the same fields as ContactDetailCard (packages/ui/src/components/user/contact-detail-card.tsx):
// a stored contact and a previewed card must read alike, so the two stay in sync.
//
// Every value here is untrusted file content, so each one is escaped and the assembled body goes
// through the shared ref restriction. The only reference that survives is an inline PHOTO turned into
// a data: URI by parsedCardToContact — a PHOTO;VALUE=uri is dropped there rather than fetched.

// A quick look reads, it doesn't scroll a whole address book: the rest is a counted line.
const VCARD_PREVIEW_MAX_CARDS = 200;

function renderField(label: string, values: string[]): string {
    if (values.length === 0) return '';
    return `<dt>${label}</dt>${values.map((value) => `<dd>${escapeHtml(value)}</dd>`).join('')}`;
}

function renderCard(contact: Contact, categories: string[]): string {
    const name = `${contact.firstName} ${contact.lastName}`.trim() || contact.email[0] || 'Unnamed contact';
    const role = formatContactRole(contact);
    const subtitle = role ? `<p class="vcard-subtitle">${escapeHtml(role)}</p>` : '';
    const avatar = contact.avatar ? `<img class="vcard-avatar" src="${escapeHtml(contact.avatar)}" alt="">` : '';
    const labels =
        categories.length > 0
            ? `<ul class="vcard-labels">${categories.map((label) => `<li>${escapeHtml(label)}</li>`).join('')}</ul>`
            : '';

    const company = formatContactCompany(contact);
    const fields = [
        renderField('Email', contact.email),
        renderField('Phone', contact.phone),
        renderField('Company', company ? [company] : []),
        renderField('Birthday', contact.birthday ? [formatDateOnly(contact.birthday)] : []),
        renderField('Address', (contact.address ?? []).map(formatContactAddress).filter(Boolean)),
        renderField('Notes', contact.notes ? [contact.notes] : []),
    ].join('');

    return `<article class="vcard-card"><header class="vcard-card-head">${avatar}<div><h2 class="vcard-name">${escapeHtml(name)}</h2>${subtitle}${labels}</div></header><dl class="vcard-fields">${fields}</dl></article>`;
}

export function renderVCardPreviewBody(data: ArrayBuffer): { body: string; warnings: TransformWarning[] } {
    const warnings: TransformWarning[] = [];

    let texts: string[];
    try {
        // The same fatal decode both import routes take: a file in another encoding is not a book of
        // names stored with replacement characters.
        texts = splitVCards(new TextDecoder('utf-8', { fatal: true }).decode(data));
    } catch {
        return { body: renderPreviewNotice('Could not read this file'), warnings };
    }

    // No more cards than an import would accept, and one card the parser refuses never costs the
    // preview the rest of the file.
    const cards: { contact: Contact; categories: string[] }[] = [];
    let dropped = 0;
    for (const text of texts.slice(0, IMPORT_MAX_CARDS)) {
        try {
            cards.push(parsedCardToContact(parseVCard(transcodeTo30(text))));
        } catch {
            dropped++;
        }
    }

    // The cards the file holds that this preview shows no card for — the unreadable ones get their own
    // line. Counted before the nothing-to-show case, so a file whose first IMPORT_MAX_CARDS cards all
    // fail still says how many it never looked at.
    const shown = cards.slice(0, VCARD_PREVIEW_MAX_CARDS);
    const remaining = texts.length - dropped - shown.length;
    const notes = [
        ...(remaining > 0 ? [remainingLine(remaining)] : []),
        ...(dropped > 0 ? [droppedLine(dropped)] : []),
    ];

    if (shown.length === 0) {
        const lines = notes.length > 0 ? notes : ['No contacts in this file'];
        return { body: lines.map(renderPreviewNotice).join(''), warnings };
    }

    const blocks = [
        ...shown.map(({ contact, categories }) => renderCard(contact, categories)),
        ...notes.map((note) => `<p class="vcard-note">${note}</p>`),
    ];
    const body = sanitizeExportHtml(`<div class="vcard-preview">${blocks.join('')}</div>`);
    return { body: applyPreviewByteGuard(body, warnings), warnings };
}
