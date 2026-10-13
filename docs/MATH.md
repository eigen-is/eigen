# Math

> **TLDR:** An equation is a tree of math nodes: identifiers, numbers, fractions, scripts, fences, large operators and the rest. Each format reads into that tree and is written out of it: Word's OMML, MathML and LaTeX, plus a plain-text form for search. `@workspace/math` (`packages/math/`) holds the tree, one reader and one writer per format, and the bounds every reader checks. It imports nothing, so the browser, the API, a Worker and Node run it unchanged.

A conversion is a reader and then a writer: `writeMathml(readOmml(oMath))` takes a Word equation to MathML. There are no converters between pairs of formats. Recognising structure, such as which large operator owns which body, happens once, in the reader that needs it. Each writer is a switch over the closed node union in `src/tree.ts`, so `tsc` proves it handles every node. The tree follows OMML's objects, because OMML is the most structured of the formats and every equation in the research corpus is OMML.

The package stores nothing. A caller keeps what a writer returns. `writeMathml(row, latex)` puts the LaTeX a user typed beside the tree as an `application/x-tex` annotation, and `readMathml` hands it back. So typed LaTeX never drifts: the annotation is the source, and `writeLatex` only writes LaTeX for an equation that came without it, such as one from Word. `readMathmlLatex` reads the annotation alone, so a consumer can still show the LaTeX of an equation whose tree is past a bound.

A reader never takes a string. It takes an element: `MathXmlElement`, a namespace, a local name, the attributes keyed as written and the children. The API's Bun-parsed `XmlElement` fits it as it is. In the browser `fromDom` adapts a DOM element. So the package holds no XML parser of untrusted bytes.

A picture can be written as more than one tree: `12` as one number or two, `sin` as one word or three letters. The canonical tree is the one form every reader produces, so a written tree reads back equal. A normalisation is a difference a round trip makes on purpose, listed with the equations it changes. The size of a tree counts its nodes, rows and characters, and the bounds cap it.

The sections cover the canonical form, the marks the MathML writer adds so its reader can find structure again, what the readers fold, what Word loses, LaTeX, the text form and the bounds; their paths are in `packages/math/`. Four things surprise people: [a token's boundaries ignore Word's runs](#tokens-are-cut-by-style-not-by-runs-or-elements), [an empty script slot reads as hidden](#a-word-equation-comes-back-as-drawn-not-as-built), [`\sin(x)` is no function in LaTeX](#a-function-name-takes-the-next-atom-as-its-body) and [the bounds count every level a reader walks](#the-bounds-are-on-the-tree-and-the-mathml-cap-follows).

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

The OMML round trip keeps the object tree, every property the tree holds and every character with its style and colour. `src/test/omml.test.ts` compares that over 108 equations, and `src/test/canonical-omml.ts`, its yardstick, lists each normalisation with the equations it changes:

| Word wrote | Comes back as | Fixture equations |
|---|---|---|
| a spacing character as an accent (U+02D9, U+203E) | its combining twin | 71, 87 |
| a linear fraction (`m:f type=lin`) | the row `a / b` | 3 |
| double-struck or monospace with a weight | the script without the weight | 172 |
| a styled or coloured space | a plain space | 41, 172 |
| an empty script or degree that shows | a hidden one | 18, 69 |

An empty slot in Word draws only a placeholder box while editing, so hiding it changes nothing on the page. `m:box` reads as its content, and so does `m:phant`, shown even where Word hides it. Keeping a box or a linear fraction would put Word internals into the MathML for three corpus equations that look the same without them. Dropped and not compared: per-run font size (an equation takes its paragraph's size), `w:b` and `w:i` in math, `m:lit`, `m:ctrlPr` apart from a deletion, `m:grow`, `m:mcs`, `m:mcJc` and `m:groupChr`'s `vertJc` (the writer sets `top` under a brace, as Word does). `writeOmml` writes no LaTeX, because OMML has no slot for it.

## LaTeX is a small TeX subset, read through one command table

LaTeX is what a user types in the equation panel. `readLatex` is a tokenizer and a recursive-descent parser of our own; `writeLatex` writes the same subset. Every command is a row in `LATEX_COMMANDS` (`src/latex-commands.ts`): a symbol with its class, a function, a large operator, an accent, a font, a space, a colour command and so on. A new command is a row, not code, and the writer is the table read backwards: where two names give one character, it writes the first. Its large operators come from `src/notation.ts`, by their unicode-math names. It writes its accent characters out, and a test checks them against `src/notation.ts`: every accent command holds an accent there, and every variant and space there has its command. The table is exported for the equation editor's symbol menus and its `\name` + space completion, so each row carries how many braced arguments it takes, and it is read-only, since every caller shares the one the reader and the writer read.

The parser follows TeX where a user would notice. `%` starts a comment and `~` is a space. An argument is a group, one character, or a command with its own arguments: `\frac12` is ½, `x^23` is x² then 3 and `x_\text{max}` is x with max below. KaTeX and MathJax take a command as an argument only in a script or `\sqrt`, so `\frac\sqrt{2}{3}` reads here as √2 over 3 but renders in neither; it has one sensible reading, and `writeLatex` braces every argument. `\big(` and its family read as the delimiter, `\!` reads as nothing, since the tree has no negative space, and in an environment `\\[2pt]` skips its gap and a `\\` after the last row starts no empty one. A second `\middle` with another delimiter stays a character in its part, because the tree holds one separator, and a `\color` carries across `\middle` as TeX's group does. A character typed as itself, such as α or ≤, reads by its Unicode class. `\displaystyle` and `\textstyle` read as nothing, because Wikipedia's annotations start with them and the document node says whether an equation is displayed. There are no macros, no `\over` and no catcodes. An unknown command or environment, a syntax error, a C0 control or a lone surrogate is a `MathError` whose `offset` points into the LaTeX, so the editor can show where. A colour is `\textcolor{#RRGGBB}{…}` or `\color{…}` with a hex value or a name from `LATEX_COLORS`, which holds the values browsers draw, since KaTeX and MathJax hand the name to CSS.

## A function name takes the next atom as its body

`\sin x` reads as a function of x, but `\sin(x)` reads as the name sin and then `(x)`: a function command takes the next atom as its body unless it is a lone operator or space. A number is one atom there, as Word builds it, so `\sin 3.5` is sin of 3.5, not of 3. A large operator does the same, so `\sum_i x_i` is an n-ary over x_i. `\limits` and `\nolimits` after a function put its scripts under or beside it, as they do for a large operator. With neither scripts nor a body, `\sum` is just the operator. Word builds its functions and n-aries the same way, so this keeps the tree what Word would make. `writeLatex` always braces a body, `\sin{\left(x\right)}`, so its own output reads back unchanged.

## The LaTeX writer marks what its reader needs

`readLatex(writeLatex(t))` returns `t` for every canonical tree but [what LaTeX loses](#what-latex-loses). Where LaTeX alone is ambiguous, the writer marks the tree:

| Node | Written as |
|---|---|
| a large operator alone | `{\sum}`, so it takes no body |
| scripts on an empty base | `{}_{6}^{14}C`; prescripts are `\prescript{14}{6}{C}` (mathtools) |
| a fraction without a line | `\binom{n}{k}` in parentheses, else `\genfrac{}{}{0pt}{}{a}{b}` |
| a table in fences | `pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix` and `Vmatrix`; a `{` before equations is `cases`; bare tables are `matrix` and `aligned` |
| a brace with a label | `\overbrace{x}^{n}`, as Word puts a limit over a group character |
| an upright word or letter | `\mathrm{sin}`, `\mathrm{d}` |
| a function name the table lacks | `\operatorname{…}`, its letters written against the upright font inside |
| n-ary limits | `\limits` or `\nolimits` only where Word's default (integrals beside, the rest under and over) differs |
| text | `\text{…}` with `% # & ~ $ { } _ ^ \` escaped, a no-break space as `~` and a run of spaces as control spaces, since TeX reads a run as one |
| a prime after scripts or a brace label | `x^{2}{}'`: TeX would put the prime on the script's base, a double superscript |
| a table's empty last row, or a row starting with `[` | `\\ {}`, since a trailing `\\` starts no row and `\\[` reads as a gap |
| a fraction or table without fences in a fenced row | `\left. … \right.` around `\frac` or `matrix`, so it stays a fenced row |

## What LaTeX loses

Typed LaTeX is kept as it was typed. These losses only touch `writeLatex` output, such as a Word equation opened in the equation panel:

| The tree holds | LaTeX writes, and reads back as |
|---|---|
| a skewed fraction | `\frac`: an upright fraction |
| a brace character other than ⏞ ⏟ ⏜ ⏝, or one on its other side | `\overset` or `\underset`: a limit holding the character |
| an accent without a command, such as the macron U+0304 or the double acute | `\overset`: a limit holding its spacing character, ¯ or ˝; `\bar` is Word's bar, U+0305. An accent outside the accent table stays combining, which KaTeX can't read |
| a fence or separator character no command draws, such as Word's ⟦ ⟧ | the characters as they are, not a fenced row (fixture equation 49): neither KaTeX nor MathJax takes `\llbracket` after `\left` |
| an operator `^` or `~` | `\text{\textasciicircum{}}` or `\text{\textasciitilde{}}`: text, since math mode has no command both KaTeX and MathJax read for either |
| Word's U+2329 and U+232A angle brackets and its ∥ | `\langle`, `\rangle` and `\|`, reading back as ⟨ ⟩ and ‖ (fixture equations 51, 52, 53) |
| an n-ary over an operator outside the large-operator table | scripts on the operator, then its body |
| an apostrophe as an operator | `'`, which reads back as a prime ′ |

## The text form is Word's linear format, written only

`writeText` writes an equation on one line for search, word count and plain-text copy, in a small subset of UnicodeMath, Word's linear format: `(a+b)/2`, `x^(n+1)`, `∑_(i=1)^n i`, `√(x+1)`, `sin x`. An operand of more than one node is parenthesised, and so is a lone fraction, scripts, n-ary or function, so `(a/b)^2` never reads as a/(b²). A space after a fraction, scripts, n-ary or function ends it before anything but an operator, as UnicodeMath reads a space: `x^2 4`, never `x^24`. Variants stay as Unicode alphanumerics, so 𝐯 and ℝ are searchable. Nothing reads it back, so it is in no round trip; `src/test/text.test.ts` pins one example per node. It is not LaTeX, because `\sin{\left(x\right)}` is noise in a chat message and doesn't match a search for `x^2`.

## The bounds are on the tree, and the MathML cap follows

Every reader takes untrusted input: a docx, a paste, a string a peer stored. `MATH_LIMITS` holds two bounds that `bound()` beside it in `src/tree.ts` checks as a reader builds:

- `depth` counts the levels a reader walks: each node's rows, and each element it reads through without making a node, such as an unknown element or a `w:ins`. Deeply nested wrappers end in a `MathError`, not in a stack overflow. `fromDom` adapts children only when a reader asks, so a deep DOM stops at the same bound.
- `size` counts every node, row, table row and character of text, so one long token is bounded too.

The corpus's 177 equations nest at most 7 deep and reach size 316; the limits give about 4× and 13× room, enough for a 20-line aligned derivation. `latexLength` is 51 characters a unit, from `writeLatex`'s costliest unit: an enclose drawing every line around an empty row writes 101 characters for a node and a row. So the LaTeX of any admitted tree fits and reads back. `mathmlLength` follows from both: the costliest node, an `menclose` drawing every line around an empty row, writes 61 characters per unit it counts, and the cap allows 64 per unit, plus the longest annotation with every character escaped to six (`&quot;`), plus the root. `writeMathml` throws past it, so whatever a reader admits the writer can write, with the LaTeX it came from, and the reader can read again (`src/test/tree.test.ts` proves it on the deepest admitted tree, `src/test/robustness.test.ts` on the largest tree of each writer's costliest unit through every writer, `src/test/latex.test.ts` with the longest annotation).

Every reader counts the tree it makes, not its input: an empty optional slot, such as Word's empty `m:sup` in a prescript, counts no row, and an `&` that splits an equation counts as the cell it starts (`RowSlot` in `src/tree.ts`). So whatever one reader admits, every writer writes and every reader reads back. A LaTeX base is parsed a level deeper only when scripts follow it, which it knows before it reads the base because the tokenizer pairs every brace, `\left` and `\begin` up front. So the deepest and the largest tree MathML admits read back from their LaTeX and OMML, and one more level or unit is an error in each (`src/test/latex.test.ts`). A group, font or colour reads into the row around it without a tree level, so these count against `depth` on their own, to keep the parser's stack bounded.

The XML readers throw `MathError` only at a bound or on a character XML can't hold, in the LaTeX annotation too, and never on content they don't know. The LaTeX reader also throws on syntax and on a command it doesn't know. `src/test/robustness.test.ts` feeds every reader seeded random input: element trees built from each format's vocabulary, writer output with seeded damage, and LaTeX token strings. Each ends in a canonical tree that every writer writes and reads back, or in a `MathError`. The readers are the boundary: a writer trusts the tree's types and checks no enum. It still throws `MathError` on a tree or LaTeX holding a character XML can't hold, the MathML and OMML writers escape every value they write, text and attribute alike, and every writer writes a colour only as `#RRGGBB`, so a forged one reaches no output. Every reader and writer is linear in its input: whitespace is trimmed by an index loop, since a regex anchored at the end backtracks through every interior run.

## The fixture is the licensed part of the corpus

`src/test/fixtures/omml-corpus.json` holds the 108 equations from LibreOffice's (MPL-2.0) and docx4j's (Apache-2.0) test documents, each with its corpus index and source file name, `w:rFonts` stripped. The research tables cite equations by that index. The Zenodo and pandoc equations stay local: Zenodo's licences are unverified per file and pandoc's is the GPL.

## See also

- [ARCHITECTURE.md § Dependency direction](ARCHITECTURE.md#dependency-direction) for why the package imports nothing.
