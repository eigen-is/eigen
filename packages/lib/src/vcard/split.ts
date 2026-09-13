// Splits a multi-card file (the vCard "directory" of RFC 6350 §3.3) into one text per card. Each card
// keeps its own source bytes — its line endings and the terminator after END:VCARD included — so it
// reaches parseVCardLines exactly as the exporting client wrote it.
import { VCardError } from './ast';

export function splitVCards(text: string): string[] {
    const body = text.startsWith('﻿') ? text.slice(1) : text;
    const n = body.length;
    const cards: string[] = [];
    let start = -1;
    let i = 0;
    while (i < n) {
        const lineStart = i;
        let j = i;
        while (j < n && body[j] !== '\n' && body[j] !== '\r') j++;
        const content = body.slice(i, j);
        if (j >= n) i = j;
        else if (body[j] === '\r' && body[j + 1] === '\n') i = j + 2;
        else i = j + 1;

        // Markers match whole lines only, so a value mentioning BEGIN:VCARD never opens a card.
        const trimmed = content.trim();
        const marker = trimmed.toUpperCase();
        if (marker === 'BEGIN:VCARD') {
            if (start !== -1) throw new VCardError('nested BEGIN:VCARD');
            start = lineStart;
        } else if (start === -1) {
            if (trimmed !== '') throw new VCardError('content outside the vCard envelope');
        } else if (marker === 'END:VCARD') {
            cards.push(body.slice(start, i));
            start = -1;
        }
    }
    if (start !== -1) throw new VCardError('missing END:VCARD');
    return cards;
}
