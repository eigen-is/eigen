// tokens() cuts typed formula text into the lexer's own tokens with their spans, for the editor: F4 finds the
// reference under the caret, highlighting colours each kind, and the bracket check counts what is outside strings.
// It reads text that may not parse, as it does while someone types. A word comes out as what the parser would take
// it for, and a whole reference, sheet prefix and both corners, is one token.

import type { TokenKind } from './lexer';
import { lexAt, Token, tokenEnd, tokenKind } from './lexer';
import { callsSpaced, referenceAt } from './parser';

export type FormulaToken = {
    readonly kind: TokenKind;
    readonly start: number;
    readonly end: number;
};

// The lexer packs a kind into a plain number, and its place here gives it back its type.
const KINDS = Object.values(Token);

export function tokens(text: string): FormulaToken[] {
    const list: FormulaToken[] = [];
    let start = 0;
    while (start < text.length) {
        const token = lexAt(text, start);
        let kind = KINDS[tokenKind(token)];
        let end = tokenEnd(token);
        if (kind === Token.Word && text.charCodeAt(end) === 40) {
            kind = Token.Function;
        } else if (kind === Token.Word || kind === Token.Number || kind === Token.Quote || kind === Token.Bracket) {
            const reference = referenceAt(text, start);
            if (reference) {
                kind = Token.Reference;
                end = reference.end;
            } else if (kind === Token.Word && callsSpaced(text, start, end)) {
                kind = Token.Function;
            } else if (kind === Token.Word) {
                const word = text.slice(start, end).toUpperCase();
                kind = word === 'TRUE' || word === 'FALSE' ? Token.Boolean : Token.Name;
            }
        }
        list.push({ kind, start, end });
        start = end;
    }
    return list;
}
