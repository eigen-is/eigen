import { LATEX_COMMANDS } from '@workspace/math';

// Google Docs' five equation menus, item for item in their grid order, named by Google's labels (its editor, checked
// 2026-10-13). `label` is what a screen reader says: a symbol's character, which it names, or a template's words.
// `preview` is the LaTeX a cell draws, `\Box` marking an empty slot; `insert` is what goes into the field, and `caret`
// where in it the caret lands.
type EquationMenuItem = { name: string; label: string; preview: string; insert: string; caret: number };

type EquationMenu = { label: string; glyph: string; items: EquationMenuItem[] };

// A trailing space, so a letter typed next never runs into the command's name.
const symbols = (names: string): EquationMenuItem[] =>
    names.split(' ').map((name) => {
        const command = LATEX_COMMANDS.get(name);
        const insert = `\\${name} `;
        const label = command?.kind === 'symbol' ? command.char : name;
        return { name, label, preview: `\\${name}`, insert, caret: insert.length };
    });

const withoutSlots = (latex: string) => latex.replace(/\\Box ?/g, '');

// The caret lands in the first slot past a base, which the text before the caret already holds.
const template = (name: string, label: string, preview: string): EquationMenuItem => ({
    name,
    label,
    preview,
    insert: withoutSlots(preview),
    caret: withoutSlots(preview.slice(0, preview.indexOf('\\Box', 1))).length,
});

export const EQUATION_MENUS: readonly EquationMenu[] = [
    {
        label: 'Greek letters',
        glyph: 'α',
        items: symbols(
            'alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega',
        ),
    },
    {
        label: 'Miscellaneous operations',
        glyph: '±',
        items: symbols(
            'times div cdot pm mp ast star circ bullet oplus ominus oslash otimes odot dagger ddagger vee wedge cap cup aleph Re Im top bot infty partial forall exists neg triangle diamond',
        ),
    },
    {
        label: 'Relations',
        glyph: '≤',
        items: symbols(
            'leq geq prec succ preceq succeq ll gg equiv sim simeq asymp approx ne subset supset subseteq supseteq in ni notin',
        ),
    },
    {
        label: 'Math operations',
        glyph: '√',
        items: [
            template('frac', 'Fraction', '\\frac{\\Box}{\\Box}'),
            template('sqrt', 'Square root', '\\sqrt{\\Box}'),
            template('rootof', 'Root', '\\sqrt[\\Box]{\\Box}'),
            template('subsuperscript', 'Subscript and superscript', '\\Box_{\\Box}^{\\Box}'),
            template('subscript', 'Subscript', '\\Box_{\\Box}'),
            template('superscript', 'Superscript', '\\Box^{\\Box}'),
            template('overline', 'Overline', '\\overline{\\Box}'),
            template('widehat', 'Hat', '\\widehat{\\Box}'),
            template('bigcapab', 'Intersection', '\\bigcap_{\\Box}^{\\Box}'),
            template('bigcupab', 'Union', '\\bigcup_{\\Box}^{\\Box}'),
            template('prodab', 'Product', '\\prod_{\\Box}^{\\Box}'),
            template('coprodab', 'Coproduct', '\\coprod_{\\Box}^{\\Box}'),
            template('rbracelr', 'Parentheses', '\\left( \\Box \\right)'),
            template('sbracelr', 'Square brackets', '\\left[ \\Box \\right]'),
            template('bracelr', 'Braces', '\\left\\{ \\Box \\right\\}'),
            template('abs', 'Absolute value', '\\left| \\Box \\right|'),
            template('intab', 'Integral', '\\int_{\\Box}^{\\Box}'),
            template('ointab', 'Contour integral', '\\oint_{\\Box}^{\\Box}'),
            template('sumab', 'Sum', '\\sum_{\\Box}^{\\Box}'),
            template('limab', 'Limit', '\\lim_{\\Box \\to \\Box}'),
        ],
    },
    {
        label: 'Arrows',
        glyph: '→',
        items: symbols(
            'leftarrow rightarrow leftrightarrow Leftarrow Rightarrow Leftrightarrow uparrow downarrow updownarrow Uparrow Downarrow Updownarrow',
        ),
    },
];
