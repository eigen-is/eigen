// Tests the unused-primitives check of scripts/check-standards.ts: an exported primitive with no importer outside its
// own file is unused, one only tests import is test-only, and barrels, dynamic imports and re-exports resolve to it.

import { describe, expect, test } from 'bun:test';
import { stripNoise } from '../../../../../scripts/strip-noise';
import type { SourceFile } from '../../../../../scripts/unused-primitives';
import { readPrimitivesIndex, unusedPrimitives } from '../../../../../scripts/unused-primitives';

const INDEX = `# Shared Primitives

## Components (2)

| Name | Import from | File |
|------|-------------|------|
| \`Card\` | \`@workspace/ui/components/card\` | packages/ui/src/components/card.tsx |
| \`Lonely\` | \`@workspace/ui/components/card\` | packages/ui/src/components/card.tsx |

## Types (3)

| Name | Import from | File |
|------|-------------|------|
| \`CardProps\` | \`@workspace/ui/components/card\` | packages/ui/src/components/card.tsx |
| \`LonelyProps\` | \`@workspace/ui/components/card\` | packages/ui/src/components/card.tsx |
| \`Shape\` | \`@workspace/lib/thing\` | packages/lib/src/thing.ts |

## Utilities & constants (4)

| Name | Import from | File |
|------|-------------|------|
| \`helper\` | \`@workspace/lib/thing\` | packages/lib/src/thing.ts |
| \`LIMIT\` | \`@workspace/lib/thing\` | packages/lib/src/thing.ts |
| \`render\` | \`@workspace/ui/test/render\` | packages/ui/src/test/render.ts |
| \`tidy\` | \`@workspace/lib/thing\` | packages/lib/src/thing.ts |
`;

const EXPORTS = {
    lib: { './thing': './src/index.ts' },
    ui: { './components/*': './src/components/*.tsx', './test/*': './src/test/*.ts' },
};

const LIB_FILES = {
    'packages/lib/src/index.ts': "export * from './thing';",
    'packages/lib/src/thing.ts': [
        'export type Shape = { side: number };',
        'export function helper(shape: Shape) { return tidy(shape.side); }',
        'export const LIMIT = 3;',
        'export function tidy(n: number) { return n; }',
    ].join('\n'),
};

const UI_FILES = {
    'packages/ui/src/components/card.tsx': [
        'export type CardProps = { title: string };',
        'export function Card({ title }: CardProps) { return title; }',
        'export type LonelyProps = { title: string };',
        'export function Lonely({ title }: LonelyProps) { return title; }',
    ].join('\n'),
    'packages/ui/src/test/render.ts': 'export function render() {}',
};

function sources(files: Record<string, string>): SourceFile[] {
    return Object.entries({ ...LIB_FILES, ...UI_FILES, ...files }).map(([path, text]) => ({
        path,
        text,
        code: stripNoise(text, path.endsWith('.tsx')),
    }));
}

// The names the check reports, as `unused` and `testOnly`.
function report(files: Record<string, string>) {
    const { unused, testOnly } = unusedPrimitives(readPrimitivesIndex(INDEX), sources(files), EXPORTS);
    return { unused: unused.map((p) => p.name).sort(), testOnly: testOnly.map((p) => p.name).sort() };
}

const CARD_USER = { 'apps/x/src/page.tsx': "import { Card } from '@workspace/ui/components/card';\nCard;" };

describe('readPrimitivesIndex', () => {
    test('reads each row with its file, and a row under Types as a type', () => {
        const rows = readPrimitivesIndex(INDEX);
        expect(rows).toHaveLength(9);
        expect(rows.find((row) => row.name === 'Shape')).toEqual({
            name: 'Shape',
            isType: true,
            importPath: '@workspace/lib/thing',
            file: 'packages/lib/src/thing.ts',
        });
        expect(rows.find((row) => row.name === 'helper')?.isType).toBe(false);
    });
});

describe('unusedPrimitives', () => {
    test('a primitive only its own file uses is unused, and one only a test imports is test-only', () => {
        expect(
            report({
                ...CARD_USER,
                'apps/x/src/main.ts': "import { helper } from '@workspace/lib/thing';\nhelper({ side: 1 });",
                'apps/x/src/test/fixtures.ts': "import { LIMIT } from '@workspace/lib/thing';\nLIMIT;",
                'packages/lib/src/thing.test.ts': "import { tidy } from './thing';\ntidy(1);",
            }),
        ).toEqual({ unused: ['Lonely', 'LonelyProps', 'Shape'], testOnly: ['LIMIT', 'tidy'] });
    });

    test('an import resolves through a relative path and through a barrel of another barrel', () => {
        expect(
            report({
                ...CARD_USER,
                'packages/lib/src/use.ts':
                    "import { helper, type Shape } from './thing';\nhelper({ side: 1 } satisfies Shape);",
                'packages/lib/src/again.ts': "export { LIMIT as MAX } from './index';",
                'apps/x/src/main.ts': "import { MAX } from '../../../packages/lib/src/again';\nMAX;",
            }).unused,
        ).toEqual(['Lonely', 'LonelyProps', 'tidy']);
    });

    test('a file that reaches its own export through a barrel is no user of it', () => {
        const thing = `import { LIMIT as MAX } from './index';\n${LIB_FILES['packages/lib/src/thing.ts']}\nMAX;`;
        expect(report({ ...CARD_USER, 'packages/lib/src/thing.ts': thing }).unused).toContain('LIMIT');
    });

    test('a script or a config outside any src folder counts as a user', () => {
        expect(
            report({ ...CARD_USER, 'scripts/tool.ts': "import { tidy } from '@workspace/lib/thing';\ntidy(1);" })
                .unused,
        ).toEqual(['LIMIT', 'Lonely', 'LonelyProps', 'Shape', 'helper']);
    });

    test('an import in a comment or a string is no use', () => {
        const comment = "/* import { tidy } from '@workspace/lib/thing';\ntidy(1); */";
        const string = 'const s = "import { LIMIT } from \'@workspace/lib/thing\'; LIMIT";';
        const { unused } = report({ ...CARD_USER, 'apps/x/src/a.ts': comment, 'apps/x/src/b.ts': string });
        expect(unused).toContain('tidy');
        expect(unused).toContain('LIMIT');
    });

    test('a spread names an import, and a member of the same name on another object does not', () => {
        const spread =
            "import { LIMIT, tidy } from '@workspace/lib/thing';\nconst o = { ...tidy(1), size: other.LIMIT };";
        const { unused } = report({ ...CARD_USER, 'apps/x/src/a.ts': spread });
        expect(unused).not.toContain('tidy');
        expect(unused).toContain('LIMIT');
    });

    test('a barrel written as an import and a bare export is no use, unless the file also calls it', () => {
        const relay = "import { tidy } from '@workspace/lib/thing';\nexport { tidy };";
        expect(report({ ...CARD_USER, 'packages/ui/src/relay.ts': relay }).unused).toContain('tidy');
        const caller = `${relay}\nexport const twice = tidy(2);`;
        expect(report({ ...CARD_USER, 'packages/ui/src/relay.ts': caller }).unused).not.toContain('tidy');
    });

    test('a destructured or member-read dynamic import counts its names, and a spread counts none', () => {
        const dynamic = {
            ...CARD_USER,
            'apps/x/src/test/a.test.ts': "const { tidy } = await import('@workspace/lib/thing');",
            'apps/x/src/test/b.test.ts': "const mod = await import('@workspace/lib/thing');\nmod.LIMIT;",
            'apps/x/src/test/c.test.ts': "mock.module('x', () => ({ ...(await import('@workspace/lib/thing')) }));",
            'apps/x/src/test/d.test.ts': "type H = typeof import('@workspace/lib/thing').helper;",
        };
        expect(report(dynamic)).toEqual({
            unused: ['Lonely', 'LonelyProps', 'Shape'],
            testOnly: ['LIMIT', 'helper', 'tidy'],
        });
    });

    test('a Promise.all of dynamic imports counts each destructured name against its own module', () => {
        const all = [
            'const [{ Card }, { tidy }] = await Promise.all([',
            "    import('@workspace/ui/components/card'),",
            "    import('@workspace/lib/thing'),",
            ']);',
        ].join('\n');
        expect(report({ 'apps/x/src/test/all.test.ts': all }).testOnly).toEqual(['Card', 'tidy']);
    });

    test('the props type of a used component and the test helpers are never reported', () => {
        const { unused } = report(CARD_USER);
        expect(unused).not.toContain('CardProps');
        expect(unused).toContain('LonelyProps');
        expect(unused).not.toContain('render');
    });
});
