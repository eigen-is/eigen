// Blanks out comments, literal contents and JSX text of a TypeScript source, so the standards checks read only code. Shared
// by `check-standards.ts` and `sentence-case.ts`; every blanked range keeps its length and newlines, so offsets line up.

import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

// The scanner is TypeScript's own (`typescript/unstable/ast`, the one parser-grade surface the 7.x
// package exposes to JS), so escapes, template nesting and comment forms are tokenised, not guessed.
// Two decisions the grammar makes and a lexer cannot: whether a `/` opens a regular expression and
// whether a `<` opens a JSX element. Both hang on the same question — may an expression start here? —
// which the previous token answers: after a closer (`)`, `]`, `}`,
// `++`, `--`), an identifier or a literal an expression is already in hand, so the character divides
// or compares instead. Every other punctuator, and the keywords that take an operand, leave one open.
const CLOSERS = new Set<SyntaxKind>([
    SyntaxKind.CloseParenToken,
    SyntaxKind.CloseBracketToken,
    SyntaxKind.CloseBraceToken,
    SyntaxKind.PlusPlusToken,
    SyntaxKind.MinusMinusToken,
]);
const OPERAND_KEYWORDS = new Set<SyntaxKind>([
    SyntaxKind.AwaitKeyword,
    SyntaxKind.CaseKeyword,
    SyntaxKind.DeleteKeyword,
    SyntaxKind.DoKeyword,
    SyntaxKind.ElseKeyword,
    SyntaxKind.InKeyword,
    SyntaxKind.InstanceOfKeyword,
    SyntaxKind.NewKeyword,
    SyntaxKind.OfKeyword,
    SyntaxKind.ReturnKeyword,
    SyntaxKind.ThrowKeyword,
    SyntaxKind.TypeOfKeyword,
    SyntaxKind.VoidKeyword,
    SyntaxKind.YieldKeyword,
]);

function expressionMayStart(previous: SyntaxKind): boolean {
    if (previous === SyntaxKind.Unknown) return true;
    if (previous >= SyntaxKind.FirstPunctuation && previous <= SyntaxKind.LastPunctuation) {
        return !CLOSERS.has(previous);
    }
    return OPERAND_KEYWORDS.has(previous);
}

// Where the scanner sits: `code` is ordinary TypeScript, `template` a `${…}` substitution (its closing
// brace resumes the literal), `tag` the inside of `<Foo …>`, and `jsx` an element's children.
type Frame = { kind: 'code' | 'template' | 'tag' | 'closing-tag' | 'jsx'; depth: number };

// Blanks out comment bodies, literal contents and JSX text so identifier-shaped metrics never fire on
// prose ("treat it as a secret") or on a string that happens to spell a keyword. Every blanked range
// keeps its length and its newlines, so offsets and line numbers still line up with the source.
export function stripNoise(source: string, tsx = false): string {
    const scanner = createScanner(false, tsx ? LanguageVariant.JSX : LanguageVariant.Standard, source);
    const frames: Frame[] = [{ kind: 'code', depth: 0 }];
    const ranges: [number, number][] = [];
    const blank = (start: number, end: number) => {
        if (end > start) ranges.push([start, end]);
    };
    // `scanJsxAttributeValue` reports the `=` before the value as the token's start while its full
    // start is the opening quote, so a literal takes the later of the two; for every other token the
    // full start only reaches back over trivia, which the token start already skips.
    const tokenStart = () => Math.max(scanner.getTokenStart(), scanner.getTokenFullStart());
    // A `<T,>` or `<T extends …>` in .tsx is a type parameter list, the one other thing that may open
    // where an element may. The compiler's parser decides it by lookahead too.
    const opensTypeParameters = () =>
        scanner.lookAhead(() => {
            let token = scanner.scan();
            while (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) token = scanner.scan();
            if (token !== SyntaxKind.Identifier) return false;
            token = scanner.scan();
            while (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) token = scanner.scan();
            return token === SyntaxKind.CommaToken || token === SyntaxKind.ExtendsKeyword;
        });

    let previous = SyntaxKind.Unknown;
    for (;;) {
        const frame = frames[frames.length - 1];
        let token: SyntaxKind;
        if (frame.kind === 'jsx') token = scanner.scanJsxToken();
        else if (frame.kind === 'tag' && previous === SyntaxKind.EqualsToken) token = scanner.scanJsxAttributeValue();
        else token = scanner.scan();
        if (token === SyntaxKind.EndOfFile) break;
        if (token >= SyntaxKind.FirstTriviaToken && token <= SyntaxKind.LastTriviaToken) {
            if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
                blank(tokenStart(), scanner.getTokenEnd());
            }
            continue;
        }

        // A slash the grammar reads as a regular expression: rescan it, unless the body runs off the
        // end of the file, which means the guess was wrong and the slash really did divide.
        if (
            (token === SyntaxKind.SlashToken || token === SyntaxKind.SlashEqualsToken) &&
            (frame.kind === 'code' || frame.kind === 'template') &&
            expressionMayStart(previous) &&
            scanner.lookAhead(
                () => scanner.reScanSlashToken() === SyntaxKind.RegularExpressionLiteral && !scanner.isUnterminated(),
            )
        ) {
            token = scanner.reScanSlashToken();
        }

        switch (token) {
            case SyntaxKind.StringLiteral:
            case SyntaxKind.NoSubstitutionTemplateLiteral:
                blank(tokenStart() + 1, scanner.getTokenEnd() - 1);
                break;
            case SyntaxKind.RegularExpressionLiteral:
            case SyntaxKind.JsxText:
            case SyntaxKind.JsxTextAllWhiteSpaces:
                blank(tokenStart(), scanner.getTokenEnd());
                break;
            // `` `head${ `` opens a substitution; the frame it pushes ends on the matching `}`.
            case SyntaxKind.TemplateHead:
                blank(tokenStart() + 1, scanner.getTokenEnd() - 2);
                frames.push({ kind: 'template', depth: 0 });
                break;
            case SyntaxKind.OpenBraceToken:
                if (frame.kind === 'tag' || frame.kind === 'jsx') frames.push({ kind: 'code', depth: 0 });
                else frame.depth++;
                break;
            case SyntaxKind.CloseBraceToken:
                if (frame.depth > 0) frame.depth--;
                else if (frame.kind === 'template') {
                    token = scanner.reScanTemplateToken(false);
                    const tail = token === SyntaxKind.TemplateTail;
                    blank(tokenStart() + 1, scanner.getTokenEnd() - (tail ? 1 : 2));
                    if (tail) frames.pop();
                } else if (frames.length > 1) frames.pop();
                break;
            case SyntaxKind.LessThanToken:
                if (frame.kind === 'jsx') frames.push({ kind: 'tag', depth: 0 });
                else if (tsx && frame.kind !== 'tag' && expressionMayStart(previous) && !opensTypeParameters()) {
                    frames.push({ kind: 'tag', depth: 0 });
                }
                break;
            case SyntaxKind.LessThanSlashToken:
                frames.pop();
                frames.push({ kind: 'closing-tag', depth: 0 });
                break;
            case SyntaxKind.GreaterThanToken:
                if (frame.kind === 'closing-tag') frames.pop();
                else if (frame.kind === 'tag') {
                    frames.pop();
                    // `/>` closes the element outright; a bare `>` opens its children.
                    if (previous !== SyntaxKind.SlashToken) frames.push({ kind: 'jsx', depth: 0 });
                }
                break;
        }
        previous = token;
    }

    let out = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
        out += source.slice(cursor, start) + source.slice(start, end).replaceAll(/[^\n]/g, ' ');
        cursor = end;
    }
    return out + source.slice(cursor);
}
