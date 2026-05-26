// FTS5's query grammar treats " * ( ) : ^ - and similar punctuation as operators, so raw
// user input cannot be passed through. Replace every non-letter/digit run with a space,
// phrase-quote each token and append a prefix wildcard: 'q3 budget!' -> '"q3"* "budget"*'.
export function sanitizeFtsQuery(text: string): string {
    return text
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter((token) => token.length > 0)
        .map((token) => `"${token}"*`)
        .join(' ');
}
