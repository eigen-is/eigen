// Tests the dialog-footer check of scripts/check-standards.ts: DialogFooter outside FormDialog fails unless the file is
// on OWN_DIALOG_FOOTER, and an entry whose file no longer uses it fails too.

import { describe, expect, test } from 'bun:test';
import { dialogFooterHits, OWN_DIALOG_FOOTER } from '../../../../../scripts/dialog-footer';
import { stripNoise } from '../../../../../scripts/strip-noise';
import type { SourceFile } from '../../../../../scripts/unused-primitives';

const FOOTER = `import { DialogFooter } from '@workspace/ui/components/dialog';
export function Thing() {
    return <DialogFooter>ok</DialogFooter>;
}
`;

function source(path: string, text: string): SourceFile {
    return { path, text, code: stripNoise(text, path.endsWith('x')) };
}

// Every listed file as it is today, so only the fixture under test can fail.
const listed = [...OWN_DIALOG_FOOTER].map((path) => source(path, FOOTER));

describe('dialogFooterHits', () => {
    test('a dialog footer outside the list fails', () => {
        const hits = dialogFooterHits([...listed, source('apps/x/src/new-dialog.tsx', FOOTER)]);
        expect(hits).toEqual({ outside: ['apps/x/src/new-dialog.tsx'], stale: [] });
    });

    test('the files that define DialogFooter and FormDialog pass', () => {
        const hits = dialogFooterHits([
            ...listed,
            source('packages/ui/src/components/dialog.tsx', FOOTER),
            source('packages/ui/src/components/form-dialog.tsx', FOOTER),
        ]);
        expect(hits).toEqual({ outside: [], stale: [] });
    });

    test('a test file passes', () => {
        const hits = dialogFooterHits([
            ...listed,
            source('packages/ui/src/test/components/new-dialog.test.tsx', FOOTER),
            source('apps/x/src/test/fixtures.tsx', FOOTER),
        ]);
        expect(hits).toEqual({ outside: [], stale: [] });
    });

    test('a mention in a comment or a string is no use', () => {
        const text = "// a DialogFooter is drawn by FormDialog\nconst name = 'DialogFooter';\n";
        expect(dialogFooterHits([...listed, source('apps/x/src/a.tsx', text)]).outside).toEqual([]);
    });

    test('a listed file that no longer uses DialogFooter, or is gone, is stale', () => {
        const [moved, gone, ...rest] = [...OWN_DIALOG_FOOTER];
        const hits = dialogFooterHits([
            source(moved, 'export const a = 1;\n'),
            ...rest.map((path) => source(path, FOOTER)),
        ]);
        expect(hits).toEqual({ outside: [], stale: [moved, gone] });
    });
});
