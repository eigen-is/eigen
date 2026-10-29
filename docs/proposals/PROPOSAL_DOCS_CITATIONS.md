# Proposal: Citations and a bibliography in Docs

This proposal weighs citations in Docs: a citation mark in the text, a list of sources the doc keeps, and a bibliography generated from them in a chosen style, the way Word's References tab, Google Docs' Tools › Citations and Zotero's Word plugin do it.

**Status:** not started. Nothing here is built. This page tests a brief rather than designing a settled feature, and ends in a recommendation. Verify its claims about the code before building on them.

> **TLDR**: The brief was: worth it for scientific papers, but large; a v1 of citation marks plus a bibliography generated from a `.bib` attached to the doc, with a few CSL styles, exporting to docx and PDF as plain text; live Word fields and a Zotero round trip later. Tested against the corpus and the code, most of it holds, with three corrections. The demand is thin: of 234 distinct docx files, about a dozen are papers with a typed reference list, and 3 carry a reference manager's fields (1 Zotero, 2 EndNote), all of which already import as their text. A `.bib` file is the wrong thing to store: the doc should keep its sources as CSL-JSON in a root `Y.Map`, and BibTeX is one way in. And a few styles don't need a CSL engine: citeproc-js is about 1 MB and CPAL or AGPL licensed, so a v1 with three or four styles is better written as our own formatter, with the engine a package question for later. A Google-sized v1 (sources, citations, bibliography, four styles, BibTeX paste, plain-text export) is about 13 to 17 days, with no package, route or migration. Recommendation: not now. Pick it up when a research group asks, and build that v1 first.

## Why

Anyone writing a paper, a thesis or a report with sources needs citations that stay in step with a reference list. Word has it built in, Google Docs has had a small version since 2020, and Zotero, Mendeley and EndNote plug into both. Eigen has footnotes ([DOCS.md § A footnote is an inline node](../DOCS.md#a-footnote-is-an-inline-node-that-holds-its-notes-paragraphs)) and nothing else for sources: a reference list is typed by hand.

The question is not whether citations are useful. It is whether they are worth their cost now, for the people who use Eigen, against the other Office gaps that cost less and reach more files.

## Non-goals

- A reference manager. Eigen keeps the sources a doc cites; a library shared across docs is Zotero's job.
- Syncing with Zotero's or Mendeley's servers.
- Note styles (Chicago notes and bibliography, OSCOLA) in v1. A citation inside a footnote works as written text, and the note numbering is the footnote's own.
- Citations in a header, a footer or a sheet or slide.

## What the others do

**Word** keeps every source of a doc in one custom XML part, a `b:Sources` element in the namespace `http://schemas.openxmlformats.org/officeDocument/2006/bibliography`, stored under `customXml/` with the style it was last formatted in (`SelectedStyle="\APASixthEditionOfficeOnline.xsl"`). Each `b:Source` has a `b:Tag`, a `b:SourceType` (`Book`, `JournalArticle`, `InternetSite` and about a dozen more) and fields such as a `b:Author` name list, `b:Title` and `b:Year`. A citation is a `CITATION Tag` field with switches for a page (`\p`), more sources (`\m`), a prefix or suffix (`\f`, `\s`) and suppressions (`\n`, `\y`, `\t`), wrapped in a `w:sdt` whose properties hold `w:citation`; its result is the formatted text, `(Mattmann & Zitting, 2011)`. The bibliography is a `BIBLIOGRAPHY` field in a `w:sdt` marked `w:bibliography`, its result the formatted list in the Bibliography paragraph style. The styles are XSL files that ship with Word, about a dozen. Word re-renders a field only when asked, so a file always carries the last formatted text.

**Zotero** writes complex fields of its own: `ADDIN ZOTERO_ITEM CSL_CITATION {json}`, where the JSON holds a `citationID`, the formatted text and `citationItems`, each with its locator, prefix and suffix and a full copy of the source as CSL-JSON (`itemData`). The bibliography is `ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY`. The document's style and settings go in custom document properties, `ZOTERO_PREF_1` and on, in `docProps/custom.xml`. Because every citation carries its own data, a Zotero doc is self-contained: another Zotero user can refresh it without the author's library. Mendeley Desktop wrote the same `CSL_CITATION` JSON behind `ADDIN CSL_CITATION`; as far as we know the newer Mendeley Cite writes content controls instead. **EndNote** writes `ADDIN EN.CITE` with its own record XML, often base64 in the field's data, and `ADDIN EN.REFLIST` for the list.

**Google Docs** (Tools › Citations) offers three styles: MLA 8th edition, APA 7th edition and Chicago author-date 17th edition, with no notes style. Sources are typed into a sidebar form per type (book, book section, website, journal article, newspaper article and a few more) and live in the doc. Inserting a citation writes its text. Insert bibliography writes the formatted list where the caret is, and the list does not update itself afterwards: Google's help says to insert it once all sources are cited. The Word download writes both as plain text. That is the bar for Google parity, and it is a low one.

## The corpus

The docx corpus (`.superpowers/corpus/docx/` in the main checkout) holds 351 files, 234 of them distinct by content. A scan of each package's XML found:

| What | Files |
|---|---|
| Word's own citation (`w:citation` sdt, `CITATION` field, a non-empty `b:Sources`) and bibliography | 1, an Apache Tika test file |
| Zotero fields (`ZOTERO_ITEM`, `ZOTERO_BIBL`) | 1, a paper with 4 Zotero citations among typed ones |
| EndNote fields (`EN.CITE`, `EN.REFLIST`) | 2 |
| Mendeley's or Citavi's fields | 0 |
| An empty `b:Sources` part (Word writes one into many files) | 69 |
| A paragraph reading References, Bibliography, Works Cited or the like | 19 |
| Three or more typed `(Author, Year)` citations | 9 |
| Three or more typed `[n]` citations | 9 |

So about a dozen files are papers with a typed reference list, nearly all from Zenodo, a research repository the corpus samples on purpose. Only 3 carry a reference manager's fields, and Word's own citation tool appears only in a test file. The corpus is not a census of Eigen's users, but it agrees with what reference-manager users report: people who cite seriously use Zotero, Mendeley or EndNote, not Word's built-in tool.

## What Eigen does today

A docx import keeps a complex field's result and drops its code (`fieldChar` in `apps/api/src/lib/import/doc/runs.ts`), and reads through a `w:sdt` into its content, inline in `walkInline` and as blocks in `readBlocks` (`apps/api/src/lib/import/doc/paragraphs.ts`). So a Word, Zotero or EndNote citation comes in as the text it last showed, `(Norling 2021)`, and a bibliography as its paragraphs. No warning counts it, and the text is right. What is lost is the link: edit the doc in Eigen, download it, and Zotero can no longer refresh it. For the 3 corpus files that is the whole loss.

## Testing the brief

| The brief | Finding |
|---|---|
| Worth it for scientific papers | True for the people who write them, but few files show it: about 5% of the corpus, and those already import readably. Most of them cite through a reference manager, so the value for them sits in the Zotero round trip, which is the costly part. |
| Large | True for the whole of it (an engine, any style, live Word and Zotero fields: 30 days or more). A Google-sized v1 is about three weeks. |
| A `.bib` attached to the doc | Store sources as CSL-JSON in the doc instead, and read a `.bib` into them (§ Stored format). |
| A few CSL styles | A few styles don't need a CSL engine, and the only mature engine is a licence and size question (§ The package question). Our own formatter for three or four styles is the v1; the engine comes with "any journal's style". |
| docx and PDF as plain text in v1 | Agreed. It is cheap, and it is what Google does. |
| Live Word fields and Zotero later | Agreed. Word's format is simple enough that live Word fields are a modest later phase, not a large one. |

## Design (v1)

### Stored format: sources in a root map, beside the page

A doc keeps its sources in a root `Y.Map` named `sources`, one key per source id, each value one CSL-JSON item: `type`, `title`, `author` and `editor` as name lists, `issued` as date parts, `container-title`, `volume`, `issue`, `page`, `publisher`, `DOI`, `URL` and the few more the styles read. It sits beside the page and style maps ([DOCS.md § A doc stores its page in a page map](../DOCS.md#a-doc-stores-its-page-in-a-page-map-beside-its-content)) and goes into the doc's `yjsRoots` (`packages/lib/src/types/drive.ts`), so a version restore takes the sources with it. One key per source lets two people edit two sources and both keep their change. Every reader goes through one `readSources(map.toJSON())` in `packages/lib/src/docs/eigendoc/`, which keeps only the known types and fields, caps each string and list, and reads anything forged as absent, as `readPageSetup` does.

The style is one key, `citationStyle`, in the existing `style` map ([DOCS.md § A doc stores its Normal text in a style map](../DOCS.md#a-doc-stores-its-normal-text-in-a-style-map-beside-its-page)), read by its own reader; a missing or unknown value is APA. Not a nested map inside `sources`: two peers creating a nested map at once each make their own, and one peer's sources vanish.

Why not keep the `.bib` file in the doc's `media/` folder, referenced by name as a figure is ([MEDIA-REFERENCES.md](../MEDIA-REFERENCES.md)):

- Every renderer would parse BibTeX, the server's exports and the preview included, on every render.
- The sources couldn't be edited in Eigen, only replaced, and two people couldn't add sources at once.
- Nothing that comes from Word or Zotero is a `.bib`. Word's `b:Sources` and Zotero's `itemData` both map to CSL-JSON, so one model takes every input.
- CSL-JSON is what every style processor reads, so the engine phase changes no stored data.

A `.bib` is one way in: Phase 2 reads one into the map.

This is a stored-format choice, the owner's. It needs no API route (the map syncs like the page) and no migration (a Yjs root is no schema version).

### The citation node

`citation` is an inline atom, as `footnote` and `pageNumber` are, in `packages/lib/src/docs/eigendoc/nodes/citation.ts`. Its one attribute, `items`, is a list in CSL's citation-item shape, the one Zotero writes: `{ id, locator?, label?, prefix?, suffix?, suppressAuthor? }`. It stores no text. Its text comes from the sources, the style and its place in the doc, as a footnote's number does, computed by one lib function both sides call, `citationTexts(doc, sources, style)`, as `footnoteNumbers` and `footnotesInOrder` are ([DOCS.md § A footnote is an inline node](../DOCS.md#a-footnote-is-an-inline-node-that-holds-its-notes-paragraphs)). A numeric style numbers sources by first citation in document order, notes included. An id with no source draws as its id in brackets, as Word draws a missing tag.

It joins `MARKLESS_ATOMS`, so a mark over a range never lands on it, and `BAND_EXCLUDED_NODES`, so a band has none. A note holds the body's paragraph, so a citation can sit in a footnote.

A copy writes each cited source's CSL-JSON into the node's HTML, as Zotero writes `itemData` into each field, and a paste into another doc adds the sources it lacks. Without that a citation pasted between docs is a dangling id.

### The bibliography node

`bibliography` is a block atom with no content: it draws the list of cited sources, sorted and formatted by the style, from the same function. Its heading is the user's own paragraph above it, as in Word. A doc may hold more than one; each draws the same list. The editor redraws it when the sources, the style or a citation change, as the notes list under the text does (`FootnoteList`). Unlike Google's, it never goes stale.

### Styles

A formatter of our own in `packages/lib/src/docs/eigendoc/citations/`, React-free so the server's renderers import it, for four styles: APA 7, MLA, Chicago author-date 17 and IEEE. Google's three, MLA at its current 9th edition, plus one numeric style for the sciences. It handles name order and particles, "et al." past each style's threshold, dates, page ranges, the a/b suffix for one author's two papers in a year, sorting, and italics for container titles, which the bibliography's runs carry as an italic mark. About 700 to 1,000 lines with their tests, and it stops at what these four styles need. A fifth style is a day.

### Editor

- **Insert › Citation** opens a picker at the caret: type to find a source by author, title or year, Enter inserts it, and a page number goes in a field beside. "New source" opens the source form. The picker can add more sources to the same citation.
- **Tools › Citations** opens a side panel, as the comments panel opens: the style, the doc's sources with edit and delete, and Insert bibliography. Deleting a cited source asks first and leaves its citations as missing.
- A source form per type, with Google's types (book, chapter, journal article, newspaper or magazine article, website, report, thesis) and a free "other".
- The citation's node view draws its text from a node decoration, as the footnote's draws its number, so a citation inserted earlier renumbers the ones after it with no node rewritten. A click selects it and shows its items in the panel.
- A viewer and a phone see the text, with no panel.

### Renderers

- **Preview, HTML and PDF.** `renderDocHtml` writes a citation as a span of its text and the bibliography as paragraphs with a hanging indent, through the same `citationTexts`. WeasyPrint needs nothing new.
- **docx, v1.** A citation is runs of its text, the bibliography paragraphs in Word's own Bibliography style with its hanging indent: what Google writes. A re-import reads them back as text.
- **Search** indexes the citation's and the bibliography's text, so a search for an author finds the doc. **Word count** counts neither, as it skips footnotes (an open question).

## Later phases

- **BibTeX, RIS and CSL-JSON in.** "Import sources…" in the panel reads a file from the computer or Drive in the browser and adds its entries to the map, keyed by the BibTeX key. BibTeX parsing is our own, for the subset real files use: `@type{key, field = {…} | "…" | number}` with `#` concatenation, `@string` macros, the month macros, nested braces that protect case, LaTeX accents and `--`, `@comment` and `@preamble` skipped, and names split as BibTeX does ("von Last, Jr, First", "and others"), with biblatex's `date` and `journaltitle`. About 300 lines. The browser parses and the map's reader validates, so the server never sees BibTeX. A re-import updates sources by key.
- **docx import, live.** The reader turns Word's `CITATION` fields and the `b:Sources` part into citation nodes and sources, a `BIBLIOGRAPHY` sdt into the node, and `SelectedStyle` into the nearest style. Zotero's and Mendeley's `CSL_CITATION` fields bring their `itemData` straight into the map, and the style from `ZOTERO_PREF_n`. A field whose data can't be read keeps its text, as today. EndNote stays text. The field JSON is charged against the package's budget ([EXPORT.md § A docx import is weighed by what it emits](../EXPORT.md#a-docx-import-is-weighed-by-what-it-emits)).
- **docx export, live.** The writer writes Word's own form: a `b:Sources` custom XML part, each citation a `CITATION` field in a `w:citation` sdt and the bibliography a `BIBLIOGRAPHY` field in a `w:bibliography` sdt, each with our text as its cached result. Word's References tab then manages them, and Update Citations and Bibliography re-renders them in Word's own style. Verify the exact sdt wrapping against a Word-made file before writing it. A doc whose sources came from Zotero could instead write Zotero's fields and `ZOTERO_PREF`, so the author's Zotero can refresh it.
- **A CSL engine.** Any of the CSL project's 10,000-odd styles, chosen by name, and note styles. This is the phase that needs citeproc-js (§ The package question).

## The package question

The only mature CSL processor in JavaScript is **citeproc-js** (npm `citeproc`, 2.4.63): one 967 KB file, 194 KB gzipped, no dependencies, last published in 2023. Zotero and Mendeley run it. It is licensed CPAL-1.0 or AGPL-3.0. Eigen is MIT. AGPL would bind Eigen as a whole. CPAL is a file-level copyleft, close to MPL, with an attribution term, and the package names no attribution notice; bundling it unmodified under CPAL is likely fine, but that is the owner's call, not ours. It needs the styles and locales too, which the CSL project publishes under CC BY-SA 3.0, 10 to 60 KB per style. citation-js (`@citation-js/core`, MIT) is a friendly wrapper, but its CSL output plugin depends on citeproc, so the licence question stays. Its BibTeX plugin (`@citation-js/plugin-bibtex`, MIT, 205 KB, pulling in `moo` and two small citation-js packages) would replace our own BibTeX reader.

The simpler alternative, which this proposal recommends for v1, is no package: our own formatter for four styles and our own BibTeX subset reader, about 1,300 lines between them. A package becomes worth asking for only when someone needs a style outside the four.

## Phases

| | Phase | Delivers | Size | Days |
|---|---|---|---|---|
| **1** | The `sources` map and `readSources`, the `citation` and `bibliography` nodes, `citationTexts` and four styles, the picker, the panel and the source form, the renderers, plain-text docx | Google Docs parity, with a bibliography that stays current | L | 11–14 |
| **2** | BibTeX, RIS and CSL-JSON import of sources | A researcher's `.bib` in one step | S–M | 2–3 |
| **3** | docx import of Word's and Zotero's citations as live nodes | A Word or Zotero paper stays a cited paper | M | 3–4 |
| **4** | docx export of Word's citation fields and sources | Word's References tab manages an exported doc | M | 2–3 |
| **5** | citeproc-js, any CSL style, note styles | Any journal's style | L | 6–9, after the package yes |

Each phase ships on its own, and every phase writes its tests, DOCS.md, EXPORT.md and help-center lines in its days. Phases 1 and 2 together are the v1 the brief asked for, at about 13 to 17 days.

## Recommendation

Not now. The case is honest but narrow: about 5% of the corpus, and those files already import as readable text. For the same three weeks, the docx gaps the ROADMAP lists reach far more files: cell borders in 53 of the 234 distinct files, text boxes in 42, tab leaders in 29. And the people who cite most rely on a reference manager, so a v1 without Zotero meets them only halfway.

Pick it up when a research group, a university or a paying customer asks. Then build phases 1 and 2 with no package, and phase 3 if they come from Word. Ask for the CSL engine only when someone names a style outside the four.

## Open questions

1. CSL-JSON in a `sources` root map, rather than a `.bib` in `media/`: the owner's call on the stored format.
2. Which four styles? APA, MLA and Chicago author-date are Google's; IEEE is a guess at what the sciences need, and Vancouver is the other candidate.
3. Should word count count citations and the bibliography? Word counts field results; Google's count is unknown.
4. Should an import count a Word, Zotero or EndNote citation it kept as text, so the toast says the reference manager can no longer refresh it? A counted warning is half a day.

## Related

- [DOCS.md § A footnote is an inline node](../DOCS.md#a-footnote-is-an-inline-node-that-holds-its-notes-paragraphs): the pattern the citation follows, an atom whose text is computed in document order.
- [EXPORT.md § A docx import replaces the document](../EXPORT.md#a-docx-import-replaces-the-document) and [§ A doc's docx is written from its JSON](../EXPORT.md#a-docs-docx-is-written-from-its-json-with-the-editors-css-values): the reader and writer phases 3 and 4 extend.
- [DOCS-TODO.md](../DOCS-TODO.md), the row "Docs: what Word and Google Docs show that a doc can't hold": the gaps this competes with.
