// Splits a multi-card file (the vCard "directory" of RFC 6350 §3.3) into one text per card. Each card
// keeps its own source bytes — its line endings and the terminator after END:VCARD included — so it
// reaches parseVCardLines exactly as the exporting client wrote it.
import { VCardError } from './ast';

export function splitVCards(text: string): string[] {
    const n = text.length;
    const cards: string[] = [];
    let start = -1;
    let i = 0;
    while (i < n) {
        // A BOM belongs to a file, not to a card, and concatenated exports (`cat a.vcf b.vcf`) leave one in
        // front of any card — so skip it wherever it sits, and keep it out of the card's own bytes.
        const lineStart = text[i] === '\uFEFF' ? i + 1 : i;
        let j = lineStart;
        while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
        const content = text.slice(lineStart, j);
        if (j >= n) i = j;
        else if (text[j] === '\r' && text[j + 1] === '\n') i = j + 2;
        else i = j + 1;

        // Markers match whole physical lines only, so neither a value mentioning BEGIN:VCARD nor a folded
        // continuation line (RFC 2425 §5.8.1 — leading SPACE or TAB, which ast.ts joins to the line above)
        // can open or close a card.
        const trimmed = content.trimEnd();
        const folded = content.startsWith(' ') || content.startsWith('\t');
        const marker = folded ? '' : trimmed.toUpperCase();
        if (marker === 'BEGIN:VCARD') {
            if (start !== -1) throw new VCardError('nested BEGIN:VCARD');
            start = lineStart;
        } else if (start === -1) {
            if (trimmed !== '') throw new VCardError('content outside the vCard envelope');
        } else if (marker === 'END:VCARD') {
            cards.push(text.slice(start, i));
            start = -1;
        }
    }
    if (start !== -1) throw new VCardError('missing END:VCARD');
    return cards;
}
