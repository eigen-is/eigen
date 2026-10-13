# Math

> **TLDR:** An equation is a tree of math nodes: identifiers, numbers, fractions, scripts, fences, large operators and the rest. Each format reads into that tree and is written out of it: Word's OMML and MathML. `@workspace/math` (`packages/math/`) holds the tree, one reader and one writer per format, and the bounds every reader checks. It imports nothing, so the browser, the API, a Worker and Node run it unchanged.

A conversion is a reader and then a writer: `writeMathml(readOmml(oMath))` takes a Word equation to MathML. There are no converters between pairs of formats. Recognising structure, such as which large operator owns which body, happens once, in the reader that needs it. Each writer is a switch over the closed node union in `src/tree.ts`, so `tsc` proves it handles every node. The tree follows OMML's objects, because OMML is the most structured of the formats and every equation in the research corpus is OMML.

The package stores nothing. A caller keeps what a writer returns. `writeMathml(row, latex)` puts the LaTeX a user typed beside the tree as an `application/x-tex` annotation, and `readMathml` hands it back.

A reader never takes a string. It takes an element: `MathXmlElement`, a namespace, a local name, the attributes keyed as written and the children. The API's Bun-parsed `XmlElement` fits it as it is. In the browser `fromDom` adapts a DOM element. So the package holds no XML parser of untrusted bytes.

A picture can be written as more than one tree: `12` as one number or two, `sin` as one word or three letters. The canonical tree is the one form every reader produces, so a written tree reads back equal. A normalisation is a difference a round trip makes on purpose, listed with the equations it changes. The size of a tree counts its nodes, rows and characters, and the bounds cap it.

The sections cover the canonical form, the marks the MathML writer adds so its reader can find structure again, what the readers fold, what Word loses, and the bounds; their paths are in `packages/math/`. Three things surprise people: [a token's boundaries ignore Word's runs](#tokens-are-cut-by-style-not-by-runs-or-elements), [an empty script slot reads as hidden](#a-word-equation-comes-back-as-drawn-not-as-built) and [the bounds count every level a reader walks](#the-bounds-are-on-the-tree-and-the-mathml-cap-follows).

## Tokens are cut by style, not by runs or elements

Word splits a run wherever an edit happened, so `x+1` may be three runs or one. The readers feed characters with their style into `RowBuilder` (`src/tree.ts`), which cuts tokens only when the next node arrives:

- A number is a maximal run of digits with at most one decimal point between digits.
- An identifier is one letter (`\p{L}`), italic or styled, or a maximal run of upright letters (`sin`, Word's `sty=p`).
- An operator is one character.
- `variant` is left out when it is the default: italic for one letter, upright for a word, a number and an operator. `color` is `#RRGGBB`, left out for Word's `auto`; an explicit `#000000` stays.
- A Unicode Mathematical Alphanumeric (𝐯, ℝ, ℎ) folds to its letter and a variant.

The other rules of the form:

- A space is one of six widths: U+0020, thin U+2009, medium U+205F, thick U+2004, quad U+2003 and two quads. Two em spaces pair up from the left. U+200B and U+2061 to U+2064 are dropped. A U+00A0 between math characters is a plain space; inside text it stays.
- Neighbouring text nodes of one colour are one node. A text never starts or ends with U+00A0 and holds no tab, CR or LF: each reads as a space.
- An accent holds a combining character; a spacing one read from any format folds to its combining twin (`src/notation.ts`). The over-line is a `line`, never an accent.
- A fence holds one character or none, with OMML's defaults resolved. The separator is empty unless there are two parts or more.
- A sub, sup or degree is absent or non-empty. A required slot, such as a numerator, may be an empty row.
- A large operator without scripts takes its default limits: integrals beside, the rest under and over, as Word does.
- A table of equations splits each row into cells at the `&` Word uses as an alignment mark. A table has a row and every row a cell, as OMML requires: an empty one reads as one empty cell.

`src/test/canonical.ts` checks every rule. Every reader's output passes it, and `src/test/generate.ts` makes seeded canonical trees for the round-trip tests.

## MathML is written with marks its reader finds again

`readMathml(writeMathml(t))` returns `t` for every canonical tree, so the stored form loses nothing. MathML alone is ambiguous, so the writer marks what its reader needs:

| Node | Written as |
|---|---|
| large operator with a body | an `mrow`: the operator `mo largeop="true"`, in `munderover`, `msubsup` or their one-script forms, then the body |
| a large operator alone in a base | wrapped in an `mrow`, so no reader takes its scripts, limit, accent, line or brace for an n-ary |
| fenced | an `mrow` with both fence `mo`s always written, `fence="true"`, empty when there is no fence, and `mo separator="true"` between parts |
| function | an `mrow` of the name, U+2061 and the body |
| accent | `mover accent="true"` with the accent's spacing character |
| line | `mover accent="true"` with U+203E, or `munder accentunder="true"` with `_` |
| brace | `mover` or `munder` with its character as `mo stretchy="true"` |
| a bare fence character | `mo stretchy="false"`, so it doesn't grow around a fraction beside it |
| text | `mtext`, its edge spaces as U+00A0, which MathML doesn't trim |

A variant is the Unicode alphanumeric where one exists and `mathvariant` where none does, such as bold-italic digits. Chrome honours only `mathvariant="normal"` but draws the alphanumerics. The writer never writes `display`: whether an equation stands on its own line belongs to the document that holds it.

## The readers take only what their format shows

The OMML reader takes text only from `m:t`. A tracked insertion (`w:ins`, `w:moveTo`) reads as written and a deletion (`w:del`, `w:moveFrom`) is dropped. An object whose control character is deleted (its `m:ctrlPr` holds `w:del` or `w:moveFrom`, ECMA-376 §22.1.2.23) is dropped whole. `mc:AlternateContent` reads its `mc:Fallback`, because the package can't know which `mc:Choice` prefixes its caller understands. An on/off property is on when present without a value or with `1`, `on` or `true`. A run without `m:sty` draws letters italic and the rest upright, as Word does. A colour is six hex digits or nothing, since a forged `w:color` is attacker text. `m:mathPr` is ignored: every corpus document holds Word's defaults.

The MathML reader reads Eigen's own dialect. `math` reads as an `mrow`. An `mrow` that starts with a large operator from the table carrying scripts, or with an operator marked `largeop`, is an n-ary over the rest of the row; any other `munderover` reads as a limit under inside a limit over. `semantics` reads as its first child, and its `application/x-tex` annotation is the LaTeX only when the `semantics` is the whole equation. Other annotations and `annotation-xml` are skipped. Token text is trimmed of XML whitespace. Any element it doesn't know, `mfenced` and `mstyle` among them, reads as its children.

Both readers skip comments and processing instructions: a child counts only if it is a string or has a `local`. `fromDom` drops comment and processing-instruction nodes and reads a CDATA section as text.

## A Word equation comes back as drawn, not as built

The OMML round trip keeps the object tree, every property the tree holds and every character with its style and colour. `src/test/omml.test.ts` compares that over 108 equations and lists each normalisation with the equations it changes:

| Word wrote | Comes back as | Fixture equations |
|---|---|---|
| a spacing character as an accent (U+02D9, U+203E) | its combining twin | 71, 87 |
| a linear fraction (`m:f type=lin`) | the row `a / b` | 3 |
| double-struck or monospace with a weight | the script without the weight | 172 |
| a styled or coloured space | a plain space | 41, 172 |
| an empty script or degree that shows | a hidden one | 18, 69 |

An empty slot in Word draws only a placeholder box while editing, so hiding it changes nothing on the page. `m:box` reads as its content, and so does `m:phant`, shown even where Word hides it. Keeping a box or a linear fraction would put Word internals into the MathML for three corpus equations that look the same without them. Dropped and not compared: per-run font size (an equation takes its paragraph's size), `w:b` and `w:i` in math, `m:lit`, `m:ctrlPr` apart from a deletion, `m:grow`, `m:mcs`, `m:mcJc` and `m:groupChr`'s `vertJc` (the writer sets `top` under a brace, as Word does). `writeOmml` writes no LaTeX, because OMML has no slot for it.

## The bounds are on the tree, and the MathML cap follows

Every reader takes untrusted input: a docx, a paste, a string a peer stored. `MATH_LIMITS` holds two bounds that `bound()` beside it in `src/tree.ts` checks as a reader builds:

- `depth` counts the levels a reader walks: each node's rows, and each element it reads through without making a node, such as an unknown element or a `w:ins`. Deeply nested wrappers end in a `MathError`, not in a stack overflow. `fromDom` adapts children only when a reader asks, so a deep DOM stops at the same bound.
- `size` counts every node, row, table row and character of text, so one long token is bounded too.

The corpus's 177 equations nest at most 7 deep and reach size 316; the limits give about 4× and 30× room. `mathmlLength` follows from `size`: the costliest node, an `menclose` drawing every line around an empty row, writes 61 characters per unit it counts, and the cap allows 64 per unit plus the root. `writeMathml` throws past it, so whatever a reader admits the writer can write, and the reader can read again (`src/test/tree.test.ts` proves it on the deepest and the largest admitted trees). The LaTeX annotation is not counted in `size`, so a tree near the cap with a long annotation makes `writeMathml` throw.

A reader throws `MathError` only at a bound or on a character XML can't hold, in the LaTeX annotation too; `writeMathml` refuses LaTeX holding such a character. Unknown content never throws. Every reader and writer is linear in its input: whitespace is trimmed by an index loop, since a regex anchored at the end backtracks through every interior run.

## The fixture is the licensed part of the corpus

`src/test/fixtures/omml-corpus.json` holds the 108 equations from LibreOffice's (MPL-2.0) and docx4j's (Apache-2.0) test documents, each with its corpus index and source file name, `w:rFonts` stripped. The research tables cite equations by that index. The Zenodo and pandoc equations stay local: Zenodo's licences are unverified per file and pandoc's is the GPL.

## See also

- [ARCHITECTURE.md § Dependency direction](ARCHITECTURE.md#dependency-direction) for why the package imports nothing.
