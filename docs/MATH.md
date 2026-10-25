# Math

> **TLDR:** An equation is a tree of math nodes: identifiers, numbers, fractions, scripts, fences, large operators and the rest. Each format reads into that tree and is written out of it: Word's OMML, MathML and LaTeX, plus a plain-text form. `@workspace/math` (`packages/math/`) holds the tree, one reader and one writer per format, and the bounds every reader checks. It imports nothing, so the browser, the API, a Worker and Node run it unchanged.

A conversion is a reader and then a writer: `writeMathml(readOmml(oMath))` takes a Word equation to MathML. There are no converters between pairs of formats. Recognising structure, such as which large operator owns which body, happens once, in the reader that needs it. Each writer is a switch over the closed node union in `src/tree.ts`, so `tsc` proves it handles every node. The tree follows OMML's objects, because OMML is the most structured of the formats.

The package stores nothing. A caller keeps what a writer returns. `writeMathml(row, latex)` puts the LaTeX a user typed beside the tree as an `application/x-tex` annotation, and `readMathmlLatex` hands it back. So typed LaTeX never drifts: the annotation is the source, and a caller needs `writeLatex` only for an equation that came without it, such as one from Word. Where a stored MathML's tree and annotation disagree, a caller shows the tree and edits the annotation, since the annotation is the source. `readMathml` reads the tree alone and `readMathmlLatex` the annotation alone, so an annotation one refuses, such as a pasted control character, never costs the tree, and a caller can still show the LaTeX of an equation whose tree is past a bound. `mathText` normalises a text node's text as the readers do, a tab or line break as a space, for a caller that builds one.

An XML reader never takes a string. It takes an element: `MathXmlElement`, a namespace, a local name, the attributes keyed as written and the children. The API's Bun-parsed `XmlElement` fits it as it is. In the browser `fromDom` adapts a DOM element. So the package holds no XML parser of untrusted bytes.

A picture can be written as more than one tree: `12` as one number or two, `sin` as one word or three letters. The canonical tree is the one form every reader produces, so a written tree reads back equal. A normalisation is a difference a round trip makes on purpose, listed with the equations it changes. The size of a tree counts its nodes, rows and characters, and the bounds cap it.

The sections cover the canonical form, the marks the MathML writer adds so its reader can find structure again, what the readers fold, how other tools' MathML reads, what Word loses, LaTeX, the text form and the bounds; their paths are in `packages/math/`. Four things surprise people: [a token's boundaries ignore Word's runs](#tokens-are-cut-by-style-not-by-runs-or-elements), [an empty script slot reads as hidden](#a-word-equation-comes-back-as-drawn-not-as-built), [`\sin(x)` is no function in LaTeX](#a-function-name-takes-the-next-atom-as-its-body) and [the bounds count every level a reader walks](#the-bounds-are-on-the-tree-and-the-mathml-cap-follows).

## Tokens are cut by style, not by runs or elements

Word splits a run wherever an edit happened, so `x+1` may be three runs or one. The readers feed characters with their style into `RowBuilder` (`src/tree.ts`), which cuts tokens only when the next node arrives:

- A number is a maximal run of digits with at most one decimal point between digits.
- An identifier is one letter (`\p{L}`), italic or styled, or a maximal run of upright letters (`sin`, Word's `sty=p`). A hyphen-minus between two letters of such a run stays a hyphen in the word (`arg-max`), as amsmath's `\operatorname`, KaTeX and MathJax draw it. Only `\operatorname{…}` and an `mi` whose text holds the hyphen say so; in OMML a `-` is the minus, upright or not, and the writer writes a word's hyphen as U+2010, which Word draws as a hyphen and the reader reads back as one.
- An operator is one character. The minus sign is U+2212: every reader folds any other ASCII hyphen-minus outside text (OMML's upright runs too, as Word draws it) to it, since Chrome draws a `-` in an `mo` as a hyphen. The LaTeX reader keeps a hyphen only inside `\operatorname` and the MathML reader never in an `mo`, since TeX and MathML draw a minus sign there. MathML, OMML and the text form write U+2212, and LaTeX writes `-`.
- `variant` is left out when it is the default: italic for one letter, but upright for a capital Greek letter as TeX and Word draw it, and upright for a word, a number and an operator. So an upright Γ beside other upright letters is part of a word: `\Gamma\Delta` reads as `\mathrm{\Gamma\Delta}` does. `color` is `#RRGGBB`, left out for Word's `auto`; an explicit `#000000` stays.
- A Unicode Mathematical Alphanumeric (𝐯, ℝ, ℎ) folds to its letter and a variant.

The other rules of the form:

- A space is one of six widths: U+0020, thin U+2009, medium U+205F, thick U+2004, quad U+2003 and two quads. Two em spaces pair up from the left. U+200B, U+2061 to U+2064 and the variation selectors U+FE0E and U+FE0F are dropped, since an emoji presentation is no math. A U+00A0 between math characters is a plain space; inside text it stays.
- Neighbouring text nodes of one colour are one node. A text never starts or ends with U+00A0 and holds no tab, CR or LF: each reads as a space.
- An accent holds a combining character; a spacing one read from any format folds to its combining twin (`src/notation.ts`). The over-line is a `line`, never an accent.
- A combining mark belongs to the character before it, in Word's runs, MathML's tokens and typed LaTeX alike. A mark from the accent table makes an accent over that character; any other stays in its token, composed where Unicode composes it, so `=` and U+0338 read as ≠. A character with a mark is a token of its own, never part of a word or a number. A mark after a space, after a node such as a fraction, or at the start of a row marks nothing and is dropped; in LaTeX a group is no node, so a mark after `{x}` or `x{}` joins the x. A character keeps its first 30 marks, Unicode's stream-safe limit (`MATH_LIMITS.marks`), and the rest are dropped, so composing them stays cheap. A dropped mark or invisible character still counts toward the size bound as it arrives, so a long run of them is a `MathError`, as a long token is.
- Unicode's superscript and subscript digits and signs, such as ² ₂ ⁺ ⁽ (`SCRIPT_CHARS` in `src/notation.ts`), read as scripts in every reader. A run of them is one scripts node on the token before it, or on an empty base after anything else, and holds the plain characters, ⁻ as −, with their marks: x²́ is x with an accented 2 above.
- A fence holds one character or none, with OMML's defaults resolved. The separator is empty unless there are two parts or more.
- The canonical prime is the operator ′ in the row after its base, as LaTeX's `x'` reads. A superscript holding ′ is another tree, which Word draws at the same height.
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
| a matrix alone in a `{` with no closing fence, LaTeX's cases | its `mtable` with `columnalign="left"`, as amsmath aligns cases |
| a lone operator as a limit | wrapped in an `mrow`, so no reader takes it for an accent or a brace without the attribute |
| a lone space as a function's body | wrapped in an `mrow`, so no reader takes it for the space Temml puts after a name |

A variant is the Unicode alphanumeric where one exists and `mathvariant` where none does, such as bold-italic digits. MathML draws a lone letter italic, so an upright capital Greek letter is written `mathvariant="normal"` and an italic one as its alphanumeric, 𝛤. Chrome honours only `mathvariant="normal"` but draws the alphanumerics. The writer never writes `display`: whether an equation stands on its own line belongs to the document that holds it.

A separator `mo` carries neither `stretchy="true"` nor `symmetric="true"`. Chromium stretches an infix `|` only when it is marked stretchy (Temml and MathJax add both), so whether a separator grows with a tall part is unchecked, a [ROADMAP](ROADMAP.md) row.

## The readers take only what their format shows

The OMML reader takes text only from `m:t` and from a `w:sym` in a run, which Word writes for a character in the Symbol font: a table reads its letters and common math characters, such as ∈, ∑ and ≤, and any other `w:sym` is dropped. A tracked insertion (`w:ins`, `w:moveTo`) reads as written and a deletion (`w:del`, `w:moveFrom`) is dropped. An object whose control character is deleted (its `m:ctrlPr` holds `w:del` or `w:moveFrom`, ECMA-376 §22.1.2.23) is dropped whole. `mc:AlternateContent` reads its `mc:Fallback`, because the package can't know which `mc:Choice` prefixes its caller understands. An on/off property is on when present, unless its value is `0`, `off` or `false`. A run without `m:sty` draws letters italic and the rest upright, as Word does, capital Greek letters too, so the writer gives an upright one `sty=p`. A colour is six hex digits or nothing, since a forged `w:color` is attacker text. `m:mathPr` is ignored, since the tree has no slot for document-wide math settings. `readOmmlText` reads the text of an equation `readOmml` refuses past a bound by these same rules, without a bound of its own, so the docx import shows such an equation as its text. Word cuts runs by style, not by word, so in that text runs side by side are one word and each object is a word of its own.

The MathML reader reads Eigen's own dialect first. `math` reads as an `mrow`. An `mrow` that starts with an operator marked `largeop`, one character and with or without scripts, is an n-ary over the rest of the row: that is how the writer writes one, and a mark makes ∑̸ a symbol of its own. Any other `munderover` reads as a limit under inside a limit over. `semantics` reads as its first child, and its `application/x-tex` annotation is the LaTeX only when the `semantics` is the whole equation. Other annotations and `annotation-xml` are skipped. Token text is trimmed of XML whitespace. Any element it doesn't know reads as its children. It also reads the MathML other tools write: [other tools' MathML reads as the picture it draws](#other-tools-mathml-reads-as-the-picture-it-draws).

Both readers skip comments and processing instructions: a child counts only if it is a string or has a `local`. `fromDom` drops comment and processing-instruction nodes and reads a CDATA section as text.

## Other tools' MathML reads as the picture it draws

A paste brings MathML that KaTeX, Temml, MathJax, Word for the web, Microsoft's OMML2MML or Wikipedia wrote. Each draws the same picture with different markup, and none says where an n-ary's body ends. The reader takes each shape to the tree `readLatex` makes of the same formula, so a pasted equation edits as if it had been typed:

- Namespaces. An HTML DOM may put `math` in the XHTML namespace or in none, Temml writes no `xmlns`, and a prefix (`mml:mi`) may stay in a browser's local name. In those namespaces an element reads by its local name after the prefix. An element of any other namespace, such as SVG, reads as its children.
- Style. Any element's `mathvariant` and `mathcolor` pass down to the tokens in it, as `mstyle`'s do, and a token's own win. `displaystyle` and `scriptlevel` are ignored. A colour is `#RRGGBB`, `#RGB` or a name in `COLOR_NAMES` (`src/notation.ts`: CSS's basic names and the rest of LaTeX's that CSS shares), the one table the LaTeX reader uses too. Anything else is no colour, so a forged value reaches no writer. Temml's colour in a CSS `style` attribute is not read, nor its `\boxed`, a CSS border.
- An n-ary and a function. A large operator from the table under scripts, without Eigen's `largeop` mark, takes the next element as its body, unless that element starts with an operator or a space, as `\sum` does in LaTeX. So do a name and U+2061 before it. A body that is a function or an n-ary of its own reads whole, so `\int_0^\pi \sin x` is the integral of sin x and `\sum_i \sum_j a` nests. The waiting crosses an `mrow` end only when the construct is all the `mrow` holds, since Temml wraps `\sum_i` and `\sin` in one; KaTeX's `{a+\sum_i}` is a TeX group, which ends the n-ary in it. One `mspace` of 0.1667em right after U+2061 is Temml's and is skipped; any other space there was typed and stays. KaTeX puts the U+2061 after `\lim` inside the base of the limit. MathJax writes no U+2061 after `\lim`, so its `\lim_{x\to 0}` reads as a limit.
- Fences. An `mrow` between `mo fence="true"` reads as fenced unless the fences say `stretchy="false"`, which Temml writes for plain parentheses, or the fences between them don't balance, as in `(a)+(b)` with all four marked. MathJax marks `\left( … \right)` only by its classes: an `mrow` with `data-mjx-texclass="INNER"` between `OPEN` and `CLOSE` operators. `mfenced` is fenced, with `(`, `)` and `,` as its defaults. The tree holds one separator, so the first of `separators` stands for them all, and `separators=""` makes one part.
- Accents and braces. MathJax and Temml leave accent and stretch to MathML's operator dictionary, so an `mover` with one character from the accent table, no `accent` attribute and no stretch reads as an accent, and one of ⏞ ⏟ ⏜ ⏝ ⎴ ⎵ as a brace. `accent` counts on the `mo` too. KaTeX's and MathJax's ASCII `^` and `~`, the modifier letters ˊ and ˋ and MathJax's over-line U+2015 fold to their combining twins (`COMBINING_ACCENTS`), so the tree never holds one as an accent. A line is U+203E or U+2015 over and `_`, U+203E or U+2015 under, when `accent` or `accentunder` says so; without it, U+203E or U+2015 over is the accent U+0305. An accent, line or brace over a large operator from the table is no n-ary: `\hat{\sum}` is the accent over ∑.
- The rest. A `linethickness` whose number is zero in any unit (`0`, `0.0em`, `0pt`, `0%`, `0ex`) is no bar, as is a zero thickness in LaTeX's `\genfrac`; both readers share `isNoLine`. An `mspace` is the space whose em width is within 0.01 of its own: KaTeX writes a thin space 0.1667em and MathJax 0.167em. `menclose` draws the lines nearest its notation: `box`, `roundedbox` and `circle` all four, `actuarial` top and right, `madruwb` right and bottom, `longdiv` left and top. `maction` reads its `selection`th child, the first by default. `ms` reads as text without quotes, as MathML Core draws it. `mpadded` and `mphantom` read as their content: the tree has no phantom. Entities arrive decoded by the parser. An `mmultiscripts` with prescripts and postscripts, which MathJax writes for mathtools' `\prescript{14}{6}{C}^{2+}`, reads as the prescripts around the base with its postscripts, as `\prescript{14}{6}{C^{2+}}`; a postscript pair after the first is scripts on an empty base.

Where a foreign shape meets Eigen's own, the writer marks its own so the stored trip stays exact. `src/test/fixtures/foreign-mathml.ts` holds KaTeX's, Temml's and MathJax's output for 17 formulas, MathJax's for one more that only mathtools has, Word for the web's clipboard, OMML2MML's and Wikipedia's, each read to its expected tree, through an XML and an HTML DOM, and through every round trip.

## A Word equation comes back as drawn, not as built

The OMML round trip keeps the object tree, every property the tree holds and every character with its style and colour. `src/test/omml.test.ts` compares that over 108 equations, and `src/test/canonical-omml.ts`, its yardstick, lists each normalisation with the equations it changes:

| Word wrote | Comes back as | Fixture equations |
|---|---|---|
| a spacing character as an accent (U+02D9, U+203E) | its combining twin | 71, 87 |
| a linear fraction (`m:f type=lin`) | the row `a / b` | 3 |
| double-struck or monospace with a weight | the script without the weight | 172 |
| a styled or coloured space | a plain space | 41, 172 |
| a hyphen-minus as an operator | the minus sign U+2212 | 12, 43, 44, 56, 57, 60, 61, 63, 79, 80, 83, 90, 91, 156, 158, 159, 160 |
| an empty script or degree that shows | a hidden one | 18, 69 |

An empty slot in Word draws only a placeholder box while editing, so hiding it changes nothing on the page. `m:box` reads as its content, and so does `m:phant`, shown even where Word hides it. Keeping a box or a linear fraction would put Word internals into the MathML for equations that look the same without them. Dropped and not compared: Word's equation number, the `#` in a run of an `m:eqArr` equation and the `(8)` after it, which belongs to the document. A run in a tracked insertion or in an alternative's fallback counts as the equation's own, since Word shows it as part of the equation. The writer puts a `#` in an equation in an `m:box`, a marked one too, so it reads back as the character. Also dropped: per-run font size (an equation takes its paragraph's size), `w:b` and `w:i` in math, `m:lit`, `m:ctrlPr` apart from a deletion, `m:grow`, `m:mcs`, `m:mcJc` and `m:groupChr`'s `vertJc` (the writer sets `top` under a brace, as Word does). The writer still writes an `m:d`'s fences and an `m:m`'s column count, centred, where they are Word's defaults: Google Docs drops the fences an `m:d` leaves out and draws a matrix without `m:mcs` flat. A matrix alone in a `{` with no closing fence, LaTeX's cases, is justified left. Word writes cases as an `m:d` with `{` around an `m:eqArr` (fixture equation 173), which stays an equations table. `writeOmml` writes no LaTeX, because OMML has no slot for it.

## LaTeX is a small TeX subset, read through one command table

LaTeX is the format a person types. `readLatex` is a tokenizer and a recursive-descent parser of our own; `writeLatex` writes the same subset. Every command is a row in `LATEX_COMMANDS` (`src/latex-commands.ts`): a symbol with its class, a function, a large operator, an accent, a font, a space, a colour command and so on. A new command is a row, not code, and the writer is the table read backwards: where two names give one character, it writes the first. Its large operators come from `src/notation.ts`, by their unicode-math names. It writes its accent characters out, and a test checks them against `src/notation.ts`: every accent command holds an accent there, and every variant and space there has its command. The table is exported, so a caller can list the commands, and each row carries how many braced arguments it takes, so a caller can complete one. It is read-only, since every caller shares the one the reader and the writer read.

The parser follows TeX where a user would notice. `%` starts a comment and `~` is a space. An argument is a group, one character, or a command with its own arguments: `\frac12` is ½, `x^23` is x² then 3 and `x_\text{max}` is x with max below. KaTeX and MathJax take a command as an argument only in a script or `\sqrt`, so `\frac\sqrt{2}{3}` reads here as √2 over 3 but renders in neither; it has one sensible reading, and `writeLatex` braces every argument. `\big(` and its family read as the delimiter, `\!` reads as nothing, since the tree has no negative space, and in an environment `\\[2pt]` and `\\*` only space the rows, which the tree doesn't keep. As in amsmath, the `[` or `*` must follow the `\\` directly, so `a\\ [b]` is a row holding `[b]`, and a gap must be a dimension KaTeX and MathJax both read. A `\\` after the last row starts no empty one. A second `\middle` with another delimiter stays a character in its part, because the tree holds one separator, and a `\color` carries across `\middle` as TeX's group does. A character typed as itself, such as α or ≤, reads by its Unicode class. `\not` puts a slash through the next symbol, one character or command and never a group, after the marks written after the symbol, composed where Unicode has the character: `\not=` is ≠, `\not\in` is ∉, `\not\preceq` stays ⪯ with U+0338 and `\not\sum` is the symbol ∑ with U+0338, no large operator. `\not\not x` slashes twice. The writer writes a slashed symbol through its own command where one exists, `\ne` or `\notin`, and else as `\not` before the symbol, so it writes no U+0338, which KaTeX rejects. One slash stays as itself: a slash before another mark, as in x̸⃒, since `\not` would put it last. That other mark is one no command draws, written as itself anyway. So does U+2ADC, whose decomposition ends in the slash but which NFC never composes back, so `\not` would read as U+2ADD and U+0338. A mark no command draws, such as U+20D2, is written as itself: MathJax draws it, and KaTeX rejects most. `\displaystyle` and `\textstyle` read as nothing, because Wikipedia's annotations start with them and whether an equation is displayed belongs to the document that holds it. There are no macros, no `\over` and no catcodes. An unknown command or environment, a syntax error, a bound or a character XML can't hold, such as a C0 control or a lone surrogate, is a `MathError` whose `offset` points into the LaTeX: the reader puts where it is on its `MathBudget`, which `bound()` reads. A colour is `\textcolor{#RRGGBB}{…}` or `\color{…}` with a hex value or a name from `COLOR_NAMES` (`src/notation.ts`), which holds the values browsers draw, since KaTeX and MathJax hand the name to CSS.

## A function name takes the next atom as its body

`\sin x` reads as a function of x, but `\sin(x)` reads as the name sin and then `(x)`: a function command takes the next atom as its body unless it is a lone operator or space. A number is one atom there, as Word builds it, so `\sin 3.5` is sin of 3.5, not of 3. A large operator does the same, so `\sum_i x_i` is an n-ary over x_i. `\limits` and `\nolimits` after a function put its scripts under or beside it, as they do for a large operator. With neither scripts nor a body, `\sum` is just the operator. Word builds its functions and n-aries the same way, so this keeps the tree what Word would make. `writeLatex` always braces a body, `\sin{\left(x\right)}`, so its own output reads back unchanged.

## The LaTeX writer marks what its reader needs

`readLatex(writeLatex(t))` returns `t` for every canonical tree but [what LaTeX loses](#what-latex-loses). Where LaTeX alone is ambiguous, the writer marks the tree:

| Node | Written as |
|---|---|
| a large operator alone | `{\sum}`, so it takes no body |
| scripts on an empty base | `{}_{6}^{14}C`; prescripts are `\prescript{14}{6}{C}` (mathtools) |
| a fraction without a line | `\binom{n}{k}` in parentheses, else `\genfrac{}{}{0pt}{}{a}{b}` |
| a table in fences | `pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix` and `Vmatrix`; a `{` before a matrix is `cases`, before equations `\left\{` around `aligned`; bare tables are `matrix` and `aligned` |
| a brace with a label | `\overbrace{x}^{n}`, as Word puts a limit over a group character |
| an upright word or letter | `\mathrm{sin}`, `\mathrm{d}` |
| an italic capital Greek letter | `\mathit{\Gamma}`; an upright one is `\Gamma`, as TeX draws it |
| a function name the table lacks | `\operatorname{…}`, its letters written against the upright font inside, and a minus sign as U+2212, since a `-` there is a hyphen |
| a word with a hyphen | `{\operatorname{arg-max}}`, the only place a `-` is a hyphen, braced so it takes no body |
| n-ary limits | `\limits` or `\nolimits` only where Word's default (integrals beside, the rest under and over) differs |
| text | `\text{…}` with `% # & ~ $ { } _ ^ \` escaped, a no-break space as `~` and a run of spaces as control spaces, since TeX reads a run as one |
| a combining accent outside the accent table, such as U+0311 | `\overset{̑}{x}`, its bare mark, which reads back as the accent; MathJax draws it, KaTeX rejects it |
| a superscript of primes alone | `x^{\prime}`: TeX raises a `'` as a superscript, so `x^{'}` would draw it twice as high |
| a prime after scripts or a brace label | `x^{2}{}'`: TeX would put the prime on the script's base, a double superscript |
| a table's empty last row | `\\ {}`, since a trailing `\\` starts no row |
| a fraction or table without fences in a fenced row | `\left. … \right.` around `\frac` or `matrix`, so it stays a fenced row |

## What LaTeX loses

Typed LaTeX is kept as it was typed. These losses only touch `writeLatex` output, such as the LaTeX of a Word equation:

| The tree holds | LaTeX writes, and reads back as |
|---|---|
| a skewed fraction | `\frac`: an upright fraction |
| a brace character other than ⏞ ⏟ ⏜ ⏝, or one on its other side | `\overset` or `\underset`: a limit holding the character |
| an accent from the accent table without a command, such as the macron U+0304 or the double acute | `\overset`: a limit holding its spacing character, ¯ or ˝; `\bar` is Word's bar, U+0305 |
| an accent holding a character that is no combining mark, such as ∘ or `*` | `\overset`: a limit holding the character |
| a fence or separator character no command draws, such as Word's ⟦ ⟧ | the characters as they are, not a fenced row (fixture equation 49): neither KaTeX nor MathJax takes `\llbracket` after `\left` |
| an operator `^` or `~`, marked or not | `\text{\textasciicircum{}}` or `\text{\textasciitilde{}}`: text without the marks, since math mode has no command both KaTeX and MathJax read for either; MathJax reads these text commands only with its `textmacros` extension |
| Word's U+2329 and U+232A angle brackets and its ∥ | `\langle`, `\rangle` and `\|`, reading back as ⟨ ⟩ and ‖ (fixture equations 51, 52, 53) |
| an n-ary over an operator outside the large-operator table | scripts on the operator, then its body |
| an apostrophe as an operator, slashed or not | `'` or `\not\prime`, which reads back as a prime ′ |
| a fence or separator that is a lone combining mark | `\left.`, `\middle.` or `\right.`, or nothing where the fenced row is written as its characters: no fence, since the mark as itself would join the character after it |

## The text form is Word's linear format, written only

`writeText` writes an equation on one line as plain text, in a small subset of UnicodeMath, Word's linear format: `(a+b)/2`, `x^(n+1)`, `∑_(i=1)^n i`, `√(x+1)`, `sin x`. A fraction without a bar takes UnicodeMath's `¦`, so a binomial is `(n¦k)`, never n over k. An operand of more than one node is parenthesised, and so is a lone fraction, scripts, n-ary or function, so `(a/b)^2` never reads as a/(b²). A space after a fraction, scripts, n-ary or function ends it before anything but an operator or a space, as UnicodeMath reads a space: `x^2 4`, never `x^24`. Variants stay as Unicode alphanumerics, such as 𝐯 and ℝ. Nothing reads it back, so it is in no round trip; `src/test/text.test.ts` pins one example per node. It is not LaTeX, because as plain text `sin(x)` reads better than `\sin{\left(x\right)}`.

## The bounds are on the tree, and the MathML cap follows

Every reader takes untrusted input: a docx, a paste, a string a peer stored. `MATH_LIMITS` in `src/tree.ts` holds seven fields. Two are bounds that `bound()` beside it checks as a reader builds:

- `depth` counts the levels a reader walks: each node's rows, and each element it reads through without making a node, such as an unknown element or a `w:ins`. Deeply nested wrappers end in a `MathError`, not in a stack overflow. `fromDom` adapts children only when a reader asks, so a deep DOM stops at the same bound.
- `size` counts every node, row, table row and character of text, so one long token is bounded too.

The other five are caps: `marks`, the marks one character keeps, `latexLength` on the LaTeX, and `mathmlLength`, `mathmlTags` and `mathmlQuotes` on a MathML string.

The fixture's 108 equations nest at most 7 levels deep and reach size 182, so the limits leave about 4.5 and 22 times that room. `latexLength` is 51 characters a unit, from `writeLatex`'s costliest unit: an enclose drawing every line around an empty row writes 101 characters for a node and a row. So the LaTeX of any admitted tree fits, and reads back but for [what LaTeX loses](#what-latex-loses): a lossy tree may read back larger, so at the size bound its LaTeX can be past it (`src/test/latex.test.ts`). `mathmlLength` follows from both: the costliest node, an `menclose` drawing every line around an empty row, writes 61 characters per unit it counts, and the cap allows 64 per unit, plus the longest annotation with every character escaped to six (`&quot;`), plus the root. `writeMathml` throws past it, so whatever a reader admits the writer can write, with the LaTeX it came from, and the reader can read again (`src/test/tree.test.ts` proves it on the deepest admitted tree, `src/test/robustness.test.ts` on the largest tree of each writer's costliest unit through every writer, `src/test/latex.test.ts` with the longest annotation).

`mathmlTags` caps the elements a MathML string can hold. The writer escapes every other `<`, so each one it writes opens or closes a tag, and its densest units, an accent, line or brace over an empty row and a fence pair around one, write three tags each. So the cap is three a unit plus six for `math`, `semantics` and `annotation`, and `writeMathml` throws past it. The writer writes at most three attributes a tag, each in double quotes, and escapes every other `"`, so `mathmlQuotes` is six a tag, and the tag cap keeps the writer under it. lib's `readEquation` (`packages/lib/src/docs/eigendoc/nodes/equation.ts`) counts the `<` and the `"` of a stored string before it parses it, as it checks the length. A peer's string of hundreds of thousands of empty elements fits `mathmlLength`, since the cap leaves room for a long annotation, and would cost every reader of the document a parse of each; past `mathmlTags` it is refused in a single pass.

Every reader counts the tree it makes: an empty optional slot, such as Word's empty `m:sup` in a prescript, counts no row, and an `&` that splits an equation counts as the cell it starts (`RowSlot` in `src/tree.ts`). The MathML reader also counts one for each element it reads through or finds empty, such as an unknown element, an `mstyle`, an empty `mrow` or `mi`, a `none` or an annotation, since a paste has no length cap and may hold any number of them. The reader walks no such element in Eigen's own output, so a tree the writer writes counts no more. So whatever one reader admits, every writer writes and every reader reads back. A LaTeX base is parsed a level deeper only when scripts follow it, which it knows before it reads the base because the tokenizer pairs every brace, `\left` and `\begin` up front. So the deepest and the largest tree MathML admits read back from their LaTeX and OMML, and one more level or unit is an error in each (`src/test/latex.test.ts`). A group, font or colour reads into the row around it without a tree level, so these count against `depth` on their own, to keep the parser's stack bounded.

The XML readers throw `MathError` only at a bound or on a character XML can't hold, in the LaTeX annotation too, and never on content they don't know. The LaTeX reader also throws on syntax and on a command it doesn't know. `src/test/robustness.test.ts` feeds every reader seeded random input: element trees built from each format's vocabulary, writer output with seeded damage, and LaTeX token strings. Each ends in a canonical tree that every writer writes and reads back, or in a `MathError`. The readers are the boundary: a writer trusts the tree's types and checks no enum. It still throws `MathError` on a tree or LaTeX holding a character XML can't hold, the MathML and OMML writers escape every value they write, text and attribute alike, and every writer writes a colour only as `#RRGGBB`, so a forged one reaches no output. Every reader and writer is linear in its input: whitespace is trimmed by an index loop, since a regex anchored at the end backtracks through every interior run.

## The fixture is the licensed part of the corpus

`src/test/fixtures/omml-corpus.json` holds the 108 equations from LibreOffice's (MPL-2.0) and docx4j's (Apache-2.0) test documents, each with its corpus index and source file name, `w:rFonts` stripped.

## See also

- [ARCHITECTURE.md § Dependency direction](ARCHITECTURE.md#dependency-direction) for why the package imports nothing.
