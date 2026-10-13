// Google Docs' five equation menus, item for item in their grid order, named by Google's labels (its editor, checked
// 2026-10-13). `preview` is the LaTeX a cell draws, `\Box` marking an empty slot; `insert` is what goes into the field.
type EquationMenuItem = { name: string; preview: string; insert: string };

type EquationMenu = { label: string; glyph: string; items: EquationMenuItem[] };

// A trailing space, so a letter typed next never runs into the command's name.
const symbols = (names: string): EquationMenuItem[] =>
    names.split(' ').map((name) => ({ name, preview: `\\${name}`, insert: `\\${name} ` }));

const template = (name: string, preview: string): EquationMenuItem => ({
    name,
    preview,
    insert: preview.replace(/\\Box ?/g, ''),
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
            template('frac', '\\frac{\\Box}{\\Box}'),
            template('sqrt', '\\sqrt{\\Box}'),
            template('rootof', '\\sqrt[\\Box]{\\Box}'),
            template('subsuperscript', '\\Box_{\\Box}^{\\Box}'),
            template('subscript', '\\Box_{\\Box}'),
            template('superscript', '\\Box^{\\Box}'),
            template('overline', '\\overline{\\Box}'),
            template('widehat', '\\widehat{\\Box}'),
            template('bigcapab', '\\bigcap_{\\Box}^{\\Box}'),
            template('bigcupab', '\\bigcup_{\\Box}^{\\Box}'),
            template('prodab', '\\prod_{\\Box}^{\\Box}'),
            template('coprodab', '\\coprod_{\\Box}^{\\Box}'),
            template('rbracelr', '\\left( \\Box \\right)'),
            template('sbracelr', '\\left[ \\Box \\right]'),
            template('bracelr', '\\left\\{ \\Box \\right\\}'),
            template('abs', '\\left| \\Box \\right|'),
            template('intab', '\\int_{\\Box}^{\\Box}'),
            template('ointab', '\\oint_{\\Box}^{\\Box}'),
            template('sumab', '\\sum_{\\Box}^{\\Box}'),
            template('limab', '\\lim_{\\Box \\to \\Box}'),
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
