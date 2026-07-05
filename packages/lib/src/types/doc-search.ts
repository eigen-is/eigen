// Shared FE contract for in-document search. Matches are plain serialisable data
// (no closures) so the command palette can list them and reveal keys by id.

export type DocSearchOptions = {
    matchCase: boolean;
    wholeWord: boolean;
    regex: boolean;
};

export type DocSearchMatch = {
    // MUST be self-describing — resolvable from the string alone (`${from}:${to}`,
    // `${sheetId}:${r}:${c}`, an object/card id), never via a cached last-search lookup:
    // the palette calls search() then reveal(id) with no highlightAll in between,
    // interleaved with an open bar session on the same controller.
    id: string;
    label: string; // the matched text or card title
    context?: string; // where it is: "To do" / "Sheet1 · B12" / "Slide 3"
};

// Implemented once per eigendoc app over its own live state. Drives the find bar,
// the palette `doc:` scope, and the `?q=` landing — three callers, one notion of a match.
// Surfaces republish their controller when the document changes; the provider re-runs
// the search on controller identity change.
// v1 is search-only: the whole contract is these three methods. v1.5 (the replace plan)
// extends it with optional canReplace/replace/replaceAll members — a non-breaking addition.
export type DocSearchController = {
    search(query: string, opts: DocSearchOptions): DocSearchMatch[]; // PURE — no document side-effects
    // paint all; [] clears — always the immediately-preceding search()'s result, so impls may
    // cache the last query to paint. The array is a paint HINT: some surfaces ignore it (docs
    // paints from its own installed prosemirror-search query, not from these ids) — the asymmetry
    // is intended.
    highlightAll(matches: DocSearchMatch[]): void;
    // scroll-to + flash; MUST tolerate stale ids (validate/clamp/no-op, never throw). MUST NOT
    // move focus while a bar session is open — that would break Enter/⌘G stepping (docs uses
    // setTextSelection; never chain .focus()). Reveal centres the match so the bar can't cover it.
    reveal(matchId: string): void;
};
