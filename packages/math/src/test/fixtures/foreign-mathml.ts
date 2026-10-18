// C5: MathML other tools write, each to read as its expected LaTeX does. KaTeX, Temml and MathJax wrote theirs once,
// in display mode; MathJax's is pretty-printed. `latex` is the x-tex annotation the reader returns.
export type ForeignMathml = { source: string; mathml: string; latex: string | undefined; expected: string };

export const FOREIGN_MATHML: ForeignMathml[] = [
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msub><mi>y</mi><mn>1</mn></msub></mrow><annotation encoding="application/x-tex">x^2+y_1</annotation></semantics></math>',
        latex: 'x^2+y_1',
        expected: 'x^2+y_1',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><msup><mi>x</mi><mn class="tml-sml-pad">2</mn></msup><mo>+</mo><msub><mi>y</mi><mn>1</mn></msub></mrow><annotation encoding="application/x-tex">x^2+y_1</annotation></semantics></math>',
        latex: 'x^2+y_1',
        expected: 'x^2+y_1',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="x^2+y_1" display="block">\n  <msup data-latex="x^2">\n    <mi data-latex="x">x</mi>\n    <mn data-latex="2">2</mn>\n  </msup>\n  <mo data-latex="+">+</mo>\n  <msub data-latex="y_1">\n    <mi data-latex="y">y</mi>\n    <mn data-latex="1">1</mn>\n  </msub>\n</math>',
        latex: undefined,
        expected: 'x^2+y_1',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">\\frac{a+b}{2}</annotation></semantics></math>',
        latex: '\\frac{a+b}{2}',
        expected: '\\frac{a+b}{2}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac><annotation encoding="application/x-tex">\\frac{a+b}{2}</annotation></semantics></math>',
        latex: '\\frac{a+b}{2}',
        expected: '\\frac{a+b}{2}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\frac{a+b}{2}" display="block">\n  <mfrac data-latex="\\frac{a+b}{2}">\n    <mrow data-latex="a+b">\n      <mi data-latex="a">a</mi>\n      <mo data-latex="+">+</mo>\n      <mi data-latex="b">b</mi>\n    </mrow>\n    <mn data-latex="2">2</mn>\n  </mfrac>\n</math>',
        latex: undefined,
        expected: '\\frac{a+b}{2}',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msqrt><mi>x</mi></msqrt><mo>+</mo><mroot><mi>y</mi><mn>3</mn></mroot></mrow><annotation encoding="application/x-tex">\\sqrt{x}+\\sqrt[3]{y}</annotation></semantics></math>',
        latex: '\\sqrt{x}+\\sqrt[3]{y}',
        expected: '\\sqrt{x}+\\sqrt[3]{y}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><msqrt><mrow><mi>x</mi><mspace width="0pt" height="0.5em"></mspace></mrow></msqrt><mo>+</mo><mroot><mi>y</mi><mn>3</mn></mroot></mrow><annotation encoding="application/x-tex">\\sqrt{x}+\\sqrt[3]{y}</annotation></semantics></math>',
        latex: '\\sqrt{x}+\\sqrt[3]{y}',
        expected: '\\sqrt{x}+\\sqrt[3]{y}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\sqrt{x}+\\sqrt[3]{y}" display="block">\n  <msqrt data-latex="\\sqrt{x}">\n    <mi data-latex="x">x</mi>\n  </msqrt>\n  <mo data-latex="+">+</mo>\n  <mroot data-latex="\\sqrt[3]{y}">\n    <mi data-latex="y">y</mi>\n    <mn data-latex="3">3</mn>\n  </mroot>\n</math>',
        latex: undefined,
        expected: '\\sqrt{x}+\\sqrt[3]{y}',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><msup><mi>i</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\sum_{i=1}^{n} i^2</annotation></semantics></math>',
        latex: '\\sum_{i=1}^{n} i^2',
        expected: '\\sum_{i=1}^{n} i^2',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mrow><munderover><mo movablelimits="false">∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover></mrow><msup><mi>i</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\sum_{i=1}^{n} i^2</annotation></semantics></math>',
        latex: '\\sum_{i=1}^{n} i^2',
        expected: '\\sum_{i=1}^{n} i^2',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\sum_{i=1}^{n} i^2" display="block">\n  <munderover data-latex="\\sum_{i=1}^{n}">\n    <mo data-latex="\\sum">&#x2211;</mo>\n    <mrow data-mjx-texclass="ORD" data-latex="{i=1}">\n      <mi data-latex="i">i</mi>\n      <mo data-latex="=">=</mo>\n      <mn data-latex="1">1</mn>\n    </mrow>\n    <mrow data-mjx-texclass="ORD" data-latex="{n}">\n      <mi data-latex="n">n</mi>\n    </mrow>\n  </munderover>\n  <msup data-latex="i^2">\n    <mi data-latex="i">i</mi>\n    <mn data-latex="2">2</mn>\n  </msup>\n</math>',
        latex: undefined,
        expected: '\\sum_{i=1}^{n} i^2',
    },
    // KaTeX writes \, as U+2009 in an mtext, which stays text.
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi><mo stretchy="false">(</mo><mi>x</mi><mo stretchy="false">)</mo><mtext>\u2009</mtext><mi>d</mi><mi>x</mi></mrow><annotation encoding="application/x-tex">\\int_0^1 f(x)\\,dx</annotation></semantics></math>',
        latex: '\\int_0^1 f(x)\\,dx',
        expected: '\\int_0^1 f(x)\\text{\u2009}dx',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><msubsup><mo movablelimits="false">∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi><mrow><mo fence="true" form="prefix" stretchy="false">(</mo><mi>x</mi><mo fence="true" form="postfix" stretchy="false">)</mo></mrow><mspace width="0.1667em"></mspace><mi>d</mi><mi>x</mi></mrow><annotation encoding="application/x-tex">\\int_0^1 f(x)\\,dx</annotation></semantics></math>',
        latex: '\\int_0^1 f(x)\\,dx',
        expected: '\\int_0^1 f(x)\\,dx',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\int_0^1 f(x)\\,dx" display="block">\n  <msubsup data-latex="\\int_0^1">\n    <mo data-latex="\\int">&#x222B;</mo>\n    <mn data-latex="0">0</mn>\n    <mn data-latex="1">1</mn>\n  </msubsup>\n  <mi data-latex="f">f</mi>\n  <mo data-latex="(" stretchy="false">(</mo>\n  <mi data-latex="x">x</mi>\n  <mo data-latex=")" stretchy="false">)</mo>\n  <mspace width="0.167em" data-latex="\\,"></mspace>\n  <mi data-latex="d">d</mi>\n  <mi data-latex="x">x</mi>\n</math>',
        latex: undefined,
        expected: '\\int_0^1 f(x)\\,dx',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mo fence="true">(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo fence="true">)</mo></mrow><annotation encoding="application/x-tex">\\left(\\frac{a}{b}\\right)</annotation></semantics></math>',
        latex: '\\left(\\frac{a}{b}\\right)',
        expected: '\\left(\\frac{a}{b}\\right)',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mo fence="true" form="prefix" stretchy="true">(</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mo fence="true" form="postfix" stretchy="true">)</mo></mrow><annotation encoding="application/x-tex">\\left(\\frac{a}{b}\\right)</annotation></semantics></math>',
        latex: '\\left(\\frac{a}{b}\\right)',
        expected: '\\left(\\frac{a}{b}\\right)',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\left(\\frac{a}{b}\\right)" display="block">\n  <mrow data-mjx-texclass="INNER" data-latex="\\left(\\frac{a}{b}\\right)">\n    <mo data-mjx-texclass="OPEN" data-latex="\\left(">(</mo>\n    <mfrac data-latex="\\frac{a}{b}">\n      <mi data-latex="a">a</mi>\n      <mi data-latex="b">b</mi>\n    </mfrac>\n    <mo data-mjx-texclass="CLOSE" data-latex="\\right)">)</mo>\n  </mrow>\n</math>',
        latex: undefined,
        expected: '\\left(\\frac{a}{b}\\right)',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi>sin</mi><mo>\u2061</mo><mi>x</mi><mo>+</mo><mi>cos</mi><mo>\u2061</mo><mo stretchy="false">(</mo><mi>y</mi><mo stretchy="false">)</mo></mrow><annotation encoding="application/x-tex">\\sin x+\\cos(y)</annotation></semantics></math>',
        latex: '\\sin x+\\cos(y)',
        expected: '\\sin x+\\cos(y)',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mrow><mi>sin</mi><mo>\u2061</mo><mspace width="0.1667em"></mspace></mrow><mi>x</mi><mo>+</mo><mrow><mi>cos</mi><mo>\u2061</mo></mrow><mrow><mo fence="true" form="prefix" stretchy="false">(</mo><mi>y</mi><mo fence="true" form="postfix" stretchy="false">)</mo></mrow></mrow><annotation encoding="application/x-tex">\\sin x+\\cos(y)</annotation></semantics></math>',
        latex: '\\sin x+\\cos(y)',
        expected: '\\sin x+\\cos(y)',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\sin x+\\cos(y)" display="block">\n  <mi data-latex="\\sin">sin</mi>\n  <mo data-mjx-texclass="NONE">&#x2061;</mo>\n  <mi data-latex="x">x</mi>\n  <mo data-latex="+">+</mo>\n  <mi data-latex="\\cos">cos</mi>\n  <mo data-mjx-texclass="NONE">&#x2061;</mo>\n  <mo data-latex="(" stretchy="false">(</mo>\n  <mi data-latex="y">y</mi>\n  <mo data-latex=")" stretchy="false">)</mo>\n</math>',
        latex: undefined,
        expected: '\\sin x+\\cos(y)',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mo fence="true">(</mo><mfrac linethickness="0px"><mi>n</mi><mi>k</mi></mfrac><mo fence="true">)</mo></mrow><annotation encoding="application/x-tex">\\binom{n}{k}</annotation></semantics></math>',
        latex: '\\binom{n}{k}',
        expected: '\\binom{n}{k}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mo fence="true">(</mo><mfrac linethickness="0px"><mi>n</mi><mi>k</mi></mfrac><mo fence="true">)</mo></mrow><annotation encoding="application/x-tex">\\binom{n}{k}</annotation></semantics></math>',
        latex: '\\binom{n}{k}',
        expected: '\\binom{n}{k}',
    },
    // MathJax sizes the parentheses as \biggl( and \biggr), no fences.
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\binom{n}{k}" display="block">\n  <mrow data-mjx-texclass="ORD" data-latex="\\binom{n}{k}">\n    <mrow data-mjx-texclass="OPEN" data-latex="\\biggl (">\n      <mo minsize="2.047em" maxsize="2.047em">(</mo>\n    </mrow>\n    <mfrac linethickness="0">\n      <mi data-latex="n">n</mi>\n      <mi data-latex="k">k</mi>\n    </mfrac>\n    <mrow data-mjx-texclass="CLOSE" data-latex="\\biggr )">\n      <mo minsize="2.047em" maxsize="2.047em">)</mo>\n    </mrow>\n  </mrow>\n</math>',
        latex: undefined,
        expected: '(\\genfrac{}{}{0pt}{}{n}{k})',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mo fence="true">(</mo><mtable rowspacing="0.16em" columnalign="center center" columnspacing="1em"><mtr><mtd><mstyle scriptlevel="0" displaystyle="false"><mn>1</mn></mstyle></mtd><mtd><mstyle scriptlevel="0" displaystyle="false"><mn>0</mn></mstyle></mtd></mtr><mtr><mtd><mstyle scriptlevel="0" displaystyle="false"><mn>0</mn></mstyle></mtd><mtd><mstyle scriptlevel="0" displaystyle="false"><mi>λ</mi></mstyle></mtd></mtr></mtable><mo fence="true">)</mo></mrow><annotation encoding="application/x-tex">\\begin{pmatrix}1 &amp; 0\\\\ 0 &amp; \\lambda\\end{pmatrix}</annotation></semantics></math>',
        latex: '\\begin{pmatrix}1 & 0\\\\ 0 & \\lambda\\end{pmatrix}',
        expected: '\\begin{pmatrix}1 & 0\\\\ 0 & \\lambda\\end{pmatrix}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mo fence="true" form="prefix" stretchy="true">(</mo><mtable><mtr><mtd style="padding-left:0em;padding-right:5.9776pt;"><mn>1</mn></mtd><mtd style="padding-left:5.9776pt;padding-right:0em;"><mn>0</mn></mtd></mtr><mtr><mtd style="padding-left:0em;padding-right:5.9776pt;"><mn>0</mn></mtd><mtd style="padding-left:5.9776pt;padding-right:0em;"><mi>λ</mi></mtd></mtr></mtable><mo fence="true" form="postfix" stretchy="true">)</mo></mrow><annotation encoding="application/x-tex">\\begin{pmatrix}1 &amp; 0\\\\ 0 &amp; \\lambda\\end{pmatrix}</annotation></semantics></math>',
        latex: '\\begin{pmatrix}1 & 0\\\\ 0 & \\lambda\\end{pmatrix}',
        expected: '\\begin{pmatrix}1 & 0\\\\ 0 & \\lambda\\end{pmatrix}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\begin{pmatrix}1 &amp; 0\\\\ 0 &amp; \\lambda\\end{pmatrix}" display="block">\n  <mrow data-mjx-texclass="INNER" data-latex="\\begin{pmatrix}1 &amp; 0\\\\ 0 &amp; \\lambda\\end{pmatrix}">\n    <mo data-mjx-texclass="OPEN">(</mo>\n    <mtable columnspacing="1em" rowspacing="4pt">\n      <mtr>\n        <mtd>\n          <mn data-latex="1">1</mn>\n        </mtd>\n        <mtd>\n          <mn data-latex="0">0</mn>\n        </mtd>\n      </mtr>\n      <mtr>\n        <mtd>\n          <mn data-latex="0">0</mn>\n        </mtd>\n        <mtd>\n          <mi data-latex="\\lambda">&#x3BB;</mi>\n        </mtd>\n      </mtr>\n    </mtable>\n    <mo data-mjx-texclass="CLOSE">)</mo>\n  </mrow>\n</math>',
        latex: undefined,
        expected: '\\begin{pmatrix}1 & 0\\\\ 0 & \\lambda\\end{pmatrix}',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mover accent="true"><mi>x</mi><mo>^</mo></mover><mo>+</mo><mover accent="true"><mi>y</mi><mo stretchy="true">‾</mo></mover><mo>+</mo><mover accent="true"><mi>v</mi><mo>\u20D7</mo></mover></mrow><annotation encoding="application/x-tex">\\hat{x}+\\overline{y}+\\vec{v}</annotation></semantics></math>',
        latex: '\\hat{x}+\\overline{y}+\\vec{v}',
        expected: '\\hat{x}+\\overline{y}+\\vec{v}',
    },
    // Temml draws \overline as menclose top.
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mover><mi>x</mi><mo stretchy="false" class="chr-sml wbk-sml-acc" style="math-depth:0;">ˆ</mo></mover><mo>+</mo><menclose notation="top" class="tml-overline"><mi>y</mi></menclose><mo>+</mo><mover><mi>v</mi><mo stretchy="false" class="tml-vec chr-sml wbk-sml-vec">→</mo></mover></mrow><annotation encoding="application/x-tex">\\hat{x}+\\overline{y}+\\vec{v}</annotation></semantics></math>',
        latex: '\\hat{x}+\\overline{y}+\\vec{v}',
        expected: '\\hat{x}+\\enclose{top}{y}+\\vec{v}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\hat{x}+\\overline{y}+\\vec{v}" display="block">\n  <mrow data-mjx-texclass="ORD" data-latex="\\hat{x}">\n    <mover>\n      <mi data-latex="x">x</mi>\n      <mo stretchy="false">^</mo>\n    </mover>\n  </mrow>\n  <mo data-latex="+">+</mo>\n  <mover data-latex="\\overline{y}">\n    <mi data-latex="y">y</mi>\n    <mo accent="true">&#x2015;</mo>\n  </mover>\n  <mo data-latex="+">+</mo>\n  <mrow data-mjx-texclass="ORD" data-latex="\\vec{v}">\n    <mover>\n      <mi data-latex="v">v</mi>\n      <mo stretchy="false">&#x2192;</mo>\n    </mover>\n  </mrow>\n</math>',
        latex: undefined,
        expected: '\\hat{x}+\\overline{y}+\\vec{v}',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mi mathvariant="bold">v</mi><mo>∈</mo><msup><mi mathvariant="double-struck">R</mi><mn>3</mn></msup></mrow><annotation encoding="application/x-tex">\\mathbf{v}\\in\\mathbb{R}^3</annotation></semantics></math>',
        latex: '\\mathbf{v}\\in\\mathbb{R}^3',
        expected: '\\mathbf{v}\\in\\mathbb{R}^3',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mi>𝐯</mi><mo>∈</mo><msup><mi>ℝ</mi><mn>3</mn></msup></mrow><annotation encoding="application/x-tex">\\mathbf{v}\\in\\mathbb{R}^3</annotation></semantics></math>',
        latex: '\\mathbf{v}\\in\\mathbb{R}^3',
        expected: '\\mathbf{v}\\in\\mathbb{R}^3',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\mathbf{v}\\in\\mathbb{R}^3" display="block">\n  <mrow data-mjx-texclass="ORD" data-latex="\\mathbf{v}">\n    <mi mathvariant="bold" data-latex="v">v</mi>\n  </mrow>\n  <mo data-latex="\\in">&#x2208;</mo>\n  <msup data-latex="\\mathbb{R}^3">\n    <mrow data-mjx-texclass="ORD" data-latex="\\mathbb{R}">\n      <mi mathvariant="double-struck" data-latex="R">R</mi>\n    </mrow>\n    <mn data-latex="3">3</mn>\n  </msup>\n</math>',
        latex: undefined,
        expected: '\\mathbf{v}\\in\\mathbb{R}^3',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mstyle mathcolor="red"><mi>x</mi></mstyle><mo>+</mo><mtext>if\u00A0</mtext><mi>y</mi></mrow><annotation encoding="application/x-tex">\\textcolor{red}{x}+\\text{if } y</annotation></semantics></math>',
        latex: '\\textcolor{red}{x}+\\text{if } y',
        expected: '\\textcolor{red}{x}+\\text{if } y',
    },
    // Temml colours through CSS, which the reader doesn't read.
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mi style="color:#ff0000;">x</mi><mo>+</mo><mtext>if\u00A0</mtext><mi>y</mi></mrow><annotation encoding="application/x-tex">\\textcolor{red}{x}+\\text{if } y</annotation></semantics></math>',
        latex: '\\textcolor{red}{x}+\\text{if } y',
        expected: 'x+\\text{if } y',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\textcolor{red}{x}+\\text{if } y" display="block">\n  <mstyle mathcolor="red" data-latex="\\textcolor{red}{x}">\n    <mi data-latex="x">x</mi>\n  </mstyle>\n  <mo data-latex="+">+</mo>\n  <mtext data-latex="\\text{if }">if&#xA0;</mtext>\n  <mi data-latex="y">y</mi>\n</math>',
        latex: undefined,
        expected: '\\textcolor{red}{x}+\\text{if } y',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><menclose notation="box"><mstyle scriptlevel="0" displaystyle="false"><mstyle scriptlevel="0" displaystyle="false"><mstyle scriptlevel="0" displaystyle="true"><mi>a</mi></mstyle></mstyle></mstyle></menclose><mo>+</mo><menclose notation="updiagonalstrike"><mi>b</mi></menclose></mrow><annotation encoding="application/x-tex">\\boxed{a}+\\cancel{b}</annotation></semantics></math>',
        latex: '\\boxed{a}+\\cancel{b}',
        expected: '\\boxed{a}+\\cancel{b}',
    },
    // Temml boxes through a CSS border.
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mrow scriptlevel="0" displaystyle="true" style="padding:3pt;border:1px solid;"><mi>a</mi></mrow><mo>+</mo><menclose notation="updiagonalstrike"><mi>b</mi><mrow class="tml-cancel upstrike"></mrow></menclose></mrow><annotation encoding="application/x-tex">\\boxed{a}+\\cancel{b}</annotation></semantics></math>',
        latex: '\\boxed{a}+\\cancel{b}',
        expected: 'a+\\cancel{b}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\boxed{a}+\\cancel{b}" display="block">\n  <menclose notation="box" data-latex="\\fbox{$\\displaystyle{a}$}">\n    <mrow data-mjx-texclass="ORD">\n      <mrow data-mjx-texclass="ORD" data-latex="\\displaystyle{a}">\n        <mi data-latex="a">a</mi>\n      </mrow>\n    </mrow>\n  </menclose>\n  <mo data-latex="+">+</mo>\n  <menclose notation="updiagonalstrike" data-latex="\\cancel{b}">\n    <mi data-latex="b">b</mi>\n  </menclose>\n</math>',
        latex: undefined,
        expected: '\\boxed{a}+\\cancel{b}',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><munder><mrow><mi>lim</mi><mo>\u2061</mo></mrow><mrow><mi>x</mi><mo>→</mo><mn>0</mn></mrow></munder><mi>f</mi><mo stretchy="false">(</mo><mi>x</mi><mo stretchy="false">)</mo></mrow><annotation encoding="application/x-tex">\\lim_{x\\to 0} f(x)</annotation></semantics></math>',
        latex: '\\lim_{x\\to 0} f(x)',
        expected: '\\lim_{x\\to 0} f(x)',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><munder><mi>lim</mi><mrow><mi>x</mi><mo>→</mo><mn>0</mn></mrow></munder><mo>\u2061</mo><mspace width="0.1667em"></mspace><mi>f</mi><mrow><mo fence="true" form="prefix" stretchy="false">(</mo><mi>x</mi><mo fence="true" form="postfix" stretchy="false">)</mo></mrow></mrow><annotation encoding="application/x-tex">\\lim_{x\\to 0} f(x)</annotation></semantics></math>',
        latex: '\\lim_{x\\to 0} f(x)',
        expected: '\\lim_{x\\to 0} f(x)',
    },
    // MathJax writes no U+2061 after \lim.
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\lim_{x\\to 0} f(x)" display="block">\n  <munder data-latex="\\lim_{x\\to0}">\n    <mo data-mjx-texclass="OP" movablelimits="true" data-latex="\\lim">lim</mo>\n    <mrow data-mjx-texclass="ORD" data-latex="{x\\to0}">\n      <mi data-latex="x">x</mi>\n      <mo accent="false" stretchy="false" data-latex="\\to">&#x2192;</mo>\n      <mn data-latex="0">0</mn>\n    </mrow>\n  </munder>\n  <mi data-latex="f">f</mi>\n  <mo data-latex="(" stretchy="false">(</mo>\n  <mi data-latex="x">x</mi>\n  <mo data-latex=")" stretchy="false">)</mo>\n</math>',
        latex: undefined,
        expected: '\\underset{x\\to 0}{\\mathrm{lim}} f(x)',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mover><mover><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mo stretchy="true">⏞</mo></mover><mi>n</mi></mover></mrow><annotation encoding="application/x-tex">\\overbrace{a+b}^{n}</annotation></semantics></math>',
        latex: '\\overbrace{a+b}^{n}',
        expected: '\\overbrace{a+b}^{n}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mover><mover><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mo stretchy="true" style="math-depth:0;">⏞</mo></mover><mi>n</mi></mover></mrow><annotation encoding="application/x-tex">\\overbrace{a+b}^{n}</annotation></semantics></math>',
        latex: '\\overbrace{a+b}^{n}',
        expected: '\\overbrace{a+b}^{n}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\overbrace{a+b}^{n}" display="block">\n  <mover data-latex="\\overbrace{a+b}^{n}">\n    <mrow data-mjx-texclass="OP" data-latex="\\overbrace{a+b}">\n      <mover>\n        <mrow data-latex="a+b">\n          <mi data-latex="a">a</mi>\n          <mo data-latex="+">+</mo>\n          <mi data-latex="b">b</mi>\n        </mrow>\n        <mo>&#x23DE;</mo>\n      </mover>\n    </mrow>\n    <mrow data-mjx-texclass="ORD" data-latex="{n}">\n      <mi data-latex="n">n</mi>\n    </mrow>\n  </mover>\n</math>',
        latex: undefined,
        expected: '\\overbrace{a+b}^{n}',
    },
    // An n-ary's body that is a function or an n-ary of its own.
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msubsup><mo>∫</mo><mn>0</mn><mi>π</mi></msubsup><mi>sin</mi><mo>\u2061</mo><mi>x</mi><mtext>\u2009</mtext><mi>d</mi><mi>x</mi></mrow><annotation encoding="application/x-tex">\\int_0^\\pi \\sin x\\,dx</annotation></semantics></math>',
        latex: '\\int_0^\\pi \\sin x\\,dx',
        expected: '\\int_0^\\pi \\sin x\\text{\u2009}dx',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><msubsup><mo movablelimits="false">∫</mo><mn>0</mn><mi>π</mi></msubsup><mrow><mi>sin</mi><mo>\u2061</mo><mspace width="0.1667em"></mspace></mrow><mi>x</mi><mspace width="0.1667em"></mspace><mi>d</mi><mi>x</mi></mrow><annotation encoding="application/x-tex">\\int_0^\\pi \\sin x\\,dx</annotation></semantics></math>',
        latex: '\\int_0^\\pi \\sin x\\,dx',
        expected: '\\int_0^\\pi \\sin x\\,dx',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\int_0^\\pi \\sin x\\,dx" display="block">\n  <msubsup data-latex="\\int_0^\\pi">\n    <mo data-latex="\\int">&#x222B;</mo>\n    <mn data-latex="0">0</mn>\n    <mi data-latex="\\pi">&#x3C0;</mi>\n  </msubsup>\n  <mi data-latex="\\sin">sin</mi>\n  <mo data-mjx-texclass="NONE">&#x2061;</mo>\n  <mi data-latex="x">x</mi>\n  <mspace width="0.167em" data-latex="\\,"></mspace>\n  <mi data-latex="d">d</mi>\n  <mi data-latex="x">x</mi>\n</math>',
        latex: undefined,
        expected: '\\int_0^\\pi \\sin x\\,dx',
    },
    {
        source: 'KaTeX 0.19.0',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><munder><mo>∑</mo><mi>i</mi></munder><munder><mo>∑</mo><mi>j</mi></munder><msub><mi>a</mi><mrow><mi>i</mi><mi>j</mi></mrow></msub></mrow><annotation encoding="application/x-tex">\\sum_i\\sum_j a_{ij}</annotation></semantics></math>',
        latex: '\\sum_i\\sum_j a_{ij}',
        expected: '\\sum_i\\sum_j a_{ij}',
    },
    {
        source: 'Temml 0.14.0',
        mathml: '<math display="block" class="tml-display" style="display:block math;"><semantics><mrow><mrow><munder><mo movablelimits="false">∑</mo><mi>i</mi></munder></mrow><mrow><munder><mo movablelimits="false">∑</mo><mi>j</mi></munder></mrow><msub><mi>a</mi><mrow><mi>i</mi><mi>j</mi></mrow></msub></mrow><annotation encoding="application/x-tex">\\sum_i\\sum_j a_{ij}</annotation></semantics></math>',
        latex: '\\sum_i\\sum_j a_{ij}',
        expected: '\\sum_i\\sum_j a_{ij}',
    },
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\sum_i\\sum_j a_{ij}" display="block">\n  <munder data-latex="\\sum_i">\n    <mo data-latex="\\sum">&#x2211;</mo>\n    <mi data-latex="i">i</mi>\n  </munder>\n  <munder data-latex="\\sum_j">\n    <mo data-latex="\\sum">&#x2211;</mo>\n    <mi data-latex="j">j</mi>\n  </munder>\n  <msub data-latex="a_{i j}">\n    <mi data-latex="a">a</mi>\n    <mrow data-mjx-texclass="ORD" data-latex="{i j}">\n      <mi data-latex="i">i</mi>\n      <mi data-latex="j">j</mi>\n    </mrow>\n  </msub>\n</math>',
        latex: undefined,
        expected: '\\sum_i\\sum_j a_{ij}',
    },
    // mathtools' \prescript with a superscript after it, which MathJax writes as one mmultiscripts holding both sides.
    {
        source: 'MathJax 4.1.3',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" data-latex="\\prescript{14}{6}{C}^{2+}" display="block">\n  <mmultiscripts data-latex="\\prescript{14}{6}{C}^{2+}">\n    <mi data-latex="C">C</mi>\n    <none></none>\n    <mrow data-mjx-texclass="ORD" data-latex="{2+}">\n      <mn data-latex="2">2</mn>\n      <mo data-latex="+">+</mo>\n    </mrow>\n    <mprescripts></mprescripts>\n    <mn data-latex="6">6</mn>\n    <mn data-latex="14">14</mn>\n  </mmultiscripts>\n</math>',
        latex: undefined,
        expected: '\\prescript{14}{6}{C^{2+}}',
    },
    // Word for the web's clipboard (text/html): the hidden math MathJax keeps for assistive technology, Word's class
    // attributes removed. mfenced, and λ as U+1D706.
    {
        source: 'Word for the web',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mi>A</mi><mo>=</mo><mfenced><mrow><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mi>𝜆</mi></mtd></mtr></mtable></mrow></mfenced></math>',
        latex: undefined,
        expected: 'A=\\begin{pmatrix}1&0\\\\0&\\lambda\\end{pmatrix}',
    },
    // Microsoft's OMML2MML.XSL, as its omml2mathml 1.3.0 port writes an m:d, an m:nary and a bracketed m:m: no
    // namespace, mfenced with Word's | separator.
    {
        source: 'OMML2MML (omml2mathml 1.3.0)',
        mathml: '<math display="inline">\n<mfenced separators="|"><mrow><mi>a</mi></mrow><mrow><mi>b</mi></mrow></mfenced><mo>=</mo>\n<mrow><msubsup><mo stretchy="false">∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mrow><mi>n</mi></mrow></msubsup><mrow><mfrac><mrow><mn>1</mn></mrow><mrow><msup><mrow><mi>i</mi></mrow><mrow><mn>2</mn></mrow></msup></mrow></mfrac></mrow></mrow>\n<mfenced open="[" close="]" separators="|"><mrow><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable></mrow></mfenced>\n</math>',
        latex: undefined,
        expected:
            '\\left(a\\middle|b\\right)=\\sum\\nolimits_{i=1}^{n}\\frac{1}{i^{2}}\\begin{bmatrix}1&0\\\\0&1\\end{bmatrix}',
    },
    // Wikipedia's (Mathoid): mstyle displaystyle, each operator spelled out in a comment, a {\displaystyle …}
    // annotation.
    {
        source: 'Wikipedia',
        mathml: '<math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle x={\\frac {-b\\pm {\\sqrt {b^{2}-4ac}}}{2a}}}"><semantics><mrow class="MJX-TeXAtom-ORD"><mstyle displaystyle="true" scriptlevel="0"><mi>x</mi><mo>=</mo><mrow class="MJX-TeXAtom-ORD"><mfrac><mrow><mo>−<!-- − --></mo><mi>b</mi><mo>±<!-- ± --></mo><mrow class="MJX-TeXAtom-ORD"><msqrt><msup><mi>b</mi><mrow class="MJX-TeXAtom-ORD"><mn>2</mn></mrow></msup><mo>−<!-- − --></mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></mrow></mstyle></mrow><annotation encoding="application/x-tex">{\\displaystyle x={\\frac {-b\\pm {\\sqrt {b^{2}-4ac}}}{2a}}}</annotation></semantics></math>',
        latex: '{\\displaystyle x={\\frac {-b\\pm {\\sqrt {b^{2}-4ac}}}{2a}}}',
        expected: '{\\displaystyle x={\\frac {-b\\pm {\\sqrt {b^{2}-4ac}}}{2a}}}',
    },
];
