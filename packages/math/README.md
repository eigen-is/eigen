# @workspace/math

`@workspace/math` reads and writes equations. Every format reads into one tree of math nodes, and every format is written out of that tree: LaTeX, MathML and Word's OMML, plus a plain-text form that is written only. A conversion is always a reader and then a writer, such as `writeMathml(readLatex(latex))`. The readers take untrusted input, check bounds as they build, and either return a tree every writer can write or throw a `MathError`. The package has no dependencies and uses no DOM, Bun or Node API, so it runs unchanged in a browser, a Worker, Bun and Node.

The design and every rule in depth: [MATH.md](../../docs/MATH.md).

## Using it

The package ships inside Eigen as a workspace package and is not published to a registry. A workspace that needs it lists it in its `package.json`:

```json
"dependencies": {
    "@workspace/math": "workspace:*"
}
```

Then import from the package root. It has one entry point, and nothing else is public:

```ts
import { readLatex, writeMathml } from '@workspace/math';
```

## Quick start

Each example below was run with Bun, and the output under it is that run's output.

### LaTeX to every format

```ts
import { readLatex, writeLatex, writeMathml, writeOmml, writeText } from '@workspace/math';

const latex = '\\frac{a+b}{2}';
const tree = readLatex(latex);

console.log(JSON.stringify(tree));
console.log(writeMathml(tree, latex));
console.log(writeOmml(tree));
console.log(writeLatex(tree));
console.log(writeText(tree));
```

```text
[{"kind":"fraction","numerator":[{"kind":"identifier","text":"a"},{"kind":"operator","text":"+"},{"kind":"identifier","text":"b"}],"denominator":[{"kind":"number","text":"2"}],"line":"bar"}]
<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac><annotation encoding="application/x-tex">\frac{a+b}{2}</annotation></semantics></math>
<m:oMath><m:f><m:num><m:r><m:t xml:space="preserve">a+b</m:t></m:r></m:num><m:den><m:r><m:t xml:space="preserve">2</m:t></m:r></m:den></m:f></m:oMath>
\frac{a+b}{2}
(a+b)/2
```

The second argument of `writeMathml` stores the typed LaTeX beside the tree as an annotation. `writeOmml` writes the `m:` prefix but no namespace declaration: the caller binds `m:` and `w:` on its own root element.

### Stored MathML back to LaTeX, in a browser

The readers take an element, not a string. In a browser, parse with `DOMParser` and adapt the result with `fromDom`:

```ts
import { fromDom, readMathml, readMathmlLatex, writeLatex, writeText } from '@workspace/math';

const stored =
    '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mn>1</mn></mrow><annotation encoding="application/x-tex">x^2+1</annotation></semantics></math>';
const document = new DOMParser().parseFromString(stored, 'application/xml');
const math = fromDom(document.documentElement);

console.log(readMathmlLatex(math));
const tree = readMathml(math);
console.log(writeLatex(tree));
console.log(writeText(tree));
```

```text
x^2+1
x^{2}+1
x^2+1
```

`readMathmlLatex` hands back the LaTeX exactly as it was typed. `writeLatex` writes LaTeX from the tree, so it is needed only for an equation that came without an annotation, such as one from Word. The run above used happy-dom's `DOMParser`, since Bun has none.

### A Word equation to LaTeX and MathML

Any object with a namespace, a local name, attributes and children is an element. The API's own XML parser produces that shape, and so does this hand-built one:

```ts
import type { MathXmlElement } from '@workspace/math';
import { OMML_NAMESPACE, readOmml, writeLatex, writeMathml } from '@workspace/math';

const m = (local: string, children: (string | MathXmlElement)[] = [], attributes = {}): MathXmlElement => ({
    ns: OMML_NAMESPACE,
    local,
    attributes,
    children,
});
const run = (text: string) => m('r', [m('t', [text])]);

// Word's ∑ from i=1 to n of i.
const oMath = m('oMath', [
    m('nary', [
        m('naryPr', [m('chr', [], { 'm:val': '∑' })]),
        m('sub', [run('i=1')]),
        m('sup', [run('n')]),
        m('e', [run('i')]),
    ]),
]);

const tree = readOmml(oMath);
console.log(writeLatex(tree));
console.log(writeMathml(tree));
```

```text
\sum_{i=1}^{n}{i}
<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><munderover><mo largeop="true">∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><mi>i</mi></mrow></math>
```

An attribute keeps its prefix as written: `m:val` answers to `val`.

### Errors

```ts
import { MathError, readLatex } from '@workspace/math';

for (const latex of ['\\frac{a}', 'x + \\foo', 'x^2^3']) {
    try {
        readLatex(latex);
    } catch (error) {
        if (!(error instanceof MathError)) throw error;
        console.log(`${latex}: ${error.message} at ${error.offset}`);
    }
}
```

```text
\frac{a}: An argument is missing at 8
x + \foo: Unknown command \foo at 4
x^2^3: A second superscript at 3
```

A LaTeX error's `offset` is the index in the LaTeX string where the reader stopped.

## Public API

Everything `src/index.ts` exports.

### The tree

- `type MathRow = MathNode[]`: a row of nodes, the unit every reader returns and every writer takes.
- `type MathNode`: the closed union of node kinds, shown under [The tree model](#the-tree-model).
- `type MathVariant`: a token's style, one of `normal`, `bold`, `italic`, `bold-italic`, `double-struck`, `bold-fraktur`, `script`, `bold-script`, `fraktur`, `sans-serif`, `bold-sans-serif`, `sans-serif-italic`, `sans-serif-bold-italic` and `monospace`.
- `mathText(raw: string): string`: normalises a text node's text as the readers do, a tab or line break as a space, for a caller that builds a text node itself.
- `MATH_LIMITS`: the bounds and caps every reader and writer checks, listed under [Bounds](#bounds).

### LaTeX

- `readLatex(latex: string): MathRow`: parses LaTeX into a tree.
- `writeLatex(row: MathRow): string`: writes a tree as LaTeX.
- `LATEX_COMMANDS: ReadonlyMap<string, LatexCommand>`: every command the reader knows, keyed by name without the backslash.
- `type LatexCommand = Readonly<LatexRow & { arguments: number }>`: one command, a `kind` with the fields that kind needs, plus `arguments`, the number of braced arguments it takes. An optional `[argument]`, a star or a `\left` delimiter comes on top.

### MathML

- `readMathml(math: MathXmlElement): MathRow`: reads a `math` element into a tree, ignoring any annotation.
- `readMathmlLatex(math: MathXmlElement): string | undefined`: returns the `application/x-tex` annotation when a `semantics` is the whole equation.
- `writeMathml(row: MathRow, latex?: string): string`: writes a `math` element, with the LaTeX as an annotation when given.
- `MATHML_NAMESPACE`: `http://www.w3.org/1998/Math/MathML`.

### OMML

- `readOmml(oMath: MathXmlElement): MathRow`: reads an `m:oMath` element into a tree.
- `readOmmlText(oMath: MathXmlElement): string`: reads the text of an equation, by the same rules for what Word shows, for an equation `readOmml` refuses past a bound.
- `writeOmml(row: MathRow): string`: writes an `m:oMath` element with unbound `m:` and `w:` prefixes.
- `OMML_NAMESPACE`, `WORDML_NAMESPACE`, `MARKUP_COMPATIBILITY_NAMESPACE`: the namespaces the OMML reader matches.

### Plain text

- `writeText(row: MathRow): string`: writes a tree on one line in a small subset of UnicodeMath, Word's linear format, such as `(a+b)/2`, `∑_(i=1)^n i` or `√(x+1)`.

### XML input

- `type MathXmlElement = { ns: string; local: string; attributes: Readonly<Record<string, string>>; children: readonly (string | object)[] }`: the element a reader takes. A child counts only if it is a string or has a `local`, so comment and processing-instruction objects are skipped.
- `fromDom(element: DomElement): MathXmlElement`: adapts a DOM element. `DomElement` is the DOM described by shape, since the package has no DOM types. Children are adapted only when a reader asks for them.

### Errors

- `class MathError extends Error`: the one error the package throws, with `readonly offset?: number` for a LaTeX error.

## The tree model

```ts
type MathNode =
    | { kind: 'identifier' | 'number' | 'operator'; text: string; variant?: MathVariant; color?: string }
    | { kind: 'text'; text: string; color?: string }
    | { kind: 'space'; width: MathSpace }
    | { kind: 'fraction'; numerator: MathRow; denominator: MathRow; line: 'bar' | 'none' | 'skewed' }
    | { kind: 'scripts'; base: MathRow; sub?: MathRow; sup?: MathRow; pre?: true }
    | { kind: 'radical'; body: MathRow; degree?: MathRow }
    | { kind: 'nary'; operator: string; limits: 'under' | 'side'; sub?: MathRow; sup?: MathRow; body: MathRow }
    | { kind: 'fenced'; open: string; close: string; separator: string; parts: MathRow[] }
    | { kind: 'function'; name: MathRow; body: MathRow }
    | { kind: 'accent'; accent: string; body: MathRow }
    | { kind: 'line'; position: 'over' | 'under'; body: MathRow }
    | { kind: 'brace'; char: string; position: 'over' | 'under'; body: MathRow }
    | { kind: 'limit'; position: 'over' | 'under'; base: MathRow; limit: MathRow }
    | { kind: 'enclose'; notation: MathEnclosure[]; body: MathRow }
    | { kind: 'table'; layout: 'matrix' | 'equations'; rows: MathRow[][] };
```

A node is a plain object, so a tree is plain JSON. Every slot that holds math is a row. The tree follows OMML's objects, because OMML is the most structured of the formats: an n-ary owns its body, and a function owns its name and its argument. Each writer is a `switch` over this union, so the type checker proves it handles every kind.

A picture can be written as more than one tree: `12` as one number or two, `sin` as one word or three letters. The readers always produce one canonical tree for it. Tokens are cut by style, not by how the input split its runs or elements: a number is a run of digits, an upright run of letters is one word, an italic letter is one identifier and an operator is one character. A `variant` is left out when it is the default, the minus sign is U+2212, and a colour is `#RRGGBB`. Because every reader produces the canonical form, `readMathml(writeMathml(tree))` returns the same tree, and so do OMML and LaTeX, apart from the losses below. [MATH.md](../../docs/MATH.md#tokens-are-cut-by-style-not-by-runs-or-elements) lists every rule.

## What is supported

| Format | Read | Write | Scope |
|---|---|---|---|
| LaTeX | `readLatex` | `writeLatex` | A TeX subset: the 388 commands in `LATEX_COMMANDS`, and the environments `matrix`, `pmatrix`, `bmatrix`, `Bmatrix`, `vmatrix`, `Vmatrix`, `cases` and `aligned` |
| MathML | `readMathml` | `writeMathml` | Eigen's own output, plus the MathML that KaTeX, Temml, MathJax, Word for the web, Microsoft's OMML2MML and Wikipedia write, read as the picture it draws |
| OMML | `readOmml` | `writeOmml` | Word's equation objects, read as Word shows them, tracked changes included |
| Text | none | `writeText` | A one-line subset of UnicodeMath |

LaTeX follows TeX where a user would notice: `%` starts a comment, `~` is a space, `\frac12` is ½, and `\left`, `\middle`, `\right`, `\big` and its family, `\not`, `\operatorname`, `\limits`, `\text`, `\color` and `\textcolor` all work. A colour is a hex value, `#RRGGBB`, or one of 22 names that CSS and LaTeX share.

What is not supported:

- LaTeX macros: `\newcommand`, `\over` and catcodes are unknown commands and throw a `MathError`, as does any environment outside the eight above, such as `align`.
- Negative space: `\!` reads as nothing, since the tree has no negative width. `\displaystyle` and `\textstyle` read as nothing too: whether an equation is displayed belongs to the document that holds it.
- `\sin(x)` is not a function of x: it reads as the name sin, then `(x)`, as in TeX. `\sin x` and `\sin{(x)}` are functions. [Why](../../docs/MATH.md#a-function-name-takes-the-next-atom-as-its-body).
- Content MathML: an element the reader doesn't know reads as its child elements, so an `apply` of `ci` elements reads as an empty row. A colour in a CSS `style` attribute is not read, and `displaystyle` and `scriptlevel` are ignored. The MathML writer never writes `display`.
- What OMML drops: Word's equation number, per-run font size, `w:b` and `w:i`, `m:lit`, `m:grow`, `m:mathPr` and matrix column settings. `m:box` and `m:phant` read as their content, a linear fraction reads as the row `a / b`, and a `w:sym` outside the Symbol font's math characters is dropped. [The full list](../../docs/MATH.md#a-word-equation-comes-back-as-drawn-not-as-built).
- What `writeLatex` loses: a skewed fraction is written upright, a fence character no command draws, such as ⟦, is written as a plain character, and a few accents and braces without a command are written as `\overset` or `\underset`. Typed LaTeX loses nothing, since the annotation keeps it. [The full list](../../docs/MATH.md#what-latex-loses).
- Nothing reads the text form back.

## Design notes

- **Zero dependencies.** The package imports no other package and no runtime API. Its `tsconfig.json` has `lib: ["ESNext"]` and no `types`, so a DOM, Bun or Node call fails the typecheck, and a Biome rule forbids any import from outside the package. The tests alone use Bun's types and happy-dom.
- **No XML parser.** A reader takes a `MathXmlElement` that its caller parsed, never a string, so the package parses no untrusted bytes. An element from the API's XML parser, built on Bun's, fits as it is. `fromDom` adapts a DOM element, typed by its shape, so the package needs no DOM types. A writer returns a string, escaping every value it writes, text and attribute alike.
- **It stores nothing.** A caller keeps what a writer returns. When MathML carries a LaTeX annotation, the annotation is the source: a caller shows the tree and edits the annotation.
- **Bounds.** Every reader counts as it builds. `MATH_LIMITS.depth` (32) caps the levels a reader walks, wrappers included, so deep nesting ends in a `MathError` and never in a stack overflow. `MATH_LIMITS.size` (4,000) caps the nodes, rows and characters. `marks` (30) caps the combining marks one character keeps. The caps `latexLength`, `mathmlLength`, `mathmlTags` and `mathmlQuotes` are set so whatever a reader admits, every writer can write and every reader can read back. Every reader and writer runs in linear time.
- **Errors.** `MathError` is the only error. A reader throws one at a bound or on a character XML can't hold. The LaTeX reader also throws on a syntax error and on a command or environment it doesn't know. The XML readers never throw on content they don't know: they read through it. A writer trusts the tree's types and checks no enum, but still throws on a character XML can't hold and when MathML would pass its caps. A caller that catches a refused equation can still show its text, with `readOmmlText` or `readMathmlLatex`.

### Bounds

| Field | Value | What it caps |
|---|---|---|
| `depth` | 32 | levels a reader walks |
| `size` | 4,000 | nodes, rows, table rows and characters |
| `marks` | 30 | combining marks one character keeps |
| `latexLength` | 204,000 | characters of LaTeX `readLatex` takes |
| `mathmlLength` | 1,480,512 | characters of MathML `writeMathml` writes |
| `mathmlTags` | 12,006 | tags in a MathML string |
| `mathmlQuotes` | 72,036 | double quotes in a MathML string |

[MATH.md](../../docs/MATH.md#the-bounds-are-on-the-tree-and-the-mathml-cap-follows) derives each number.

## Tests

```sh
cd packages/math
bun test
bun run typecheck
```

Lint runs from the repository root with `bun run lint`. The tests live in `src/test/`. Every reader's output passes a canonical-form check, and seeded generated trees go through every writer and back. A fixture of 108 Word equations comes from LibreOffice's (MPL-2.0) and docx4j's (Apache-2.0) test documents. Another holds the MathML that KaTeX, Temml, MathJax, Word for the web, OMML2MML and Wikipedia write. A robustness suite feeds every reader seeded random input and expects either a canonical tree or a `MathError`.
