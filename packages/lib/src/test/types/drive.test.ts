import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EIGEN_DOC_TYPE_INFO, type YjsRootKind } from '../../types/drive';

// Scans each collab app's source for Y.Doc root-type access and asserts the
// referenced names are declared in EIGEN_DOC_TYPE_INFO[type].yjsRoots. Catches
// the silent-drift footgun where a new `doc.getMap('newRoot')` lands without
// the registry update — version restore would otherwise skip that root.

const APPS_BY_TYPE = {
    doc: 'docs',
    sheets: 'sheets',
    slides: 'slides',
    stickies: 'stickies',
} as const;

const KIND_BY_METHOD: Record<string, YjsRootKind> = {
    getMap: 'map',
    getArray: 'array',
    getText: 'text',
    getXmlFragment: 'xmlfragment',
};

// `\bgetMap(` etc. — no other type in this codebase exposes these method
// names, so non-Yjs false positives haven't materialised. If they ever do,
// tighten by anchoring to known receivers (`yjsDoc`, `yDoc`, `doc`, `this.doc`).
const TYPED_GETTER = /\.(getMap|getArray|getText|getXmlFragment)\(\s*['"]([A-Za-z_][\w-]*)['"]/g;

// Tiptap's Collaboration extension calls getXmlFragment internally based on
// `field` (defaults to 'default'). We match the configure call and look for a
// `field:` override; absent → implicit 'default'.
const TIPTAP_COLLAB_CONFIG = /Collaboration\.configure\(\s*\{([^}]*)\}/g;
const TIPTAP_FIELD = /\bfield\s*:\s*['"]([A-Za-z_][\w-]*)['"]/;

function walkSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...walkSourceFiles(full));
        } else if (/\.(tsx?|mts)$/.test(entry) && !/\.test\.[mt]sx?$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

function collectUsage(appType: keyof typeof APPS_BY_TYPE, files: string[]): Map<string, YjsRootKind> {
    const usage = new Map<string, YjsRootKind>();
    const add = (name: string, kind: YjsRootKind, where: string) => {
        const existing = usage.get(name);
        if (existing && existing !== kind) {
            throw new Error(`Conflicting Y root kind for "${name}" (${existing} vs ${kind}); see ${where}`);
        }
        usage.set(name, kind);
    };

    for (const file of files) {
        const src = readFileSync(file, 'utf-8');
        for (const m of src.matchAll(TYPED_GETTER)) {
            const kind = KIND_BY_METHOD[m[1]];
            if (!kind) continue;
            add(m[2], kind, file);
        }
        if (appType === 'doc') {
            for (const m of src.matchAll(TIPTAP_COLLAB_CONFIG)) {
                const fieldMatch = TIPTAP_FIELD.exec(m[1]);
                const field = fieldMatch ? fieldMatch[1] : 'default';
                add(field, 'xmlfragment', file);
            }
        }
    }
    return usage;
}

// types/drive.test.ts → packages/lib/src/types → repo root is 4 up.
const REPO_ROOT = resolve(import.meta.dir, '../../../../..');

describe('EIGEN_DOC_TYPE_INFO.yjsRoots covers every Y root the app touches', () => {
    for (const [type, appDir] of Object.entries(APPS_BY_TYPE) as [keyof typeof APPS_BY_TYPE, string][]) {
        test(`${type}: every Y root accessed under apps/${appDir}/src is declared`, () => {
            const files = walkSourceFiles(resolve(REPO_ROOT, 'apps', appDir, 'src'));
            const usage = collectUsage(type, files);
            // Widen the as-const narrowed union to a plain index signature so
            // the test can look roots up by string name.
            const declared = (EIGEN_DOC_TYPE_INFO[type].yjsRoots ?? {}) as Record<string, YjsRootKind>;

            const missing: string[] = [];
            const mismatched: string[] = [];
            for (const [name, kind] of usage) {
                if (!(name in declared)) {
                    missing.push(`  '${name}' (${kind})`);
                } else if (declared[name] !== kind) {
                    mismatched.push(`  '${name}': declared as '${declared[name]}', app uses '${kind}'`);
                }
            }

            // Sanity: at least one root must be observed. Otherwise the regex
            // broke and we'd silently green-light any future drift.
            expect(usage.size).toBeGreaterThan(0);

            if (missing.length || mismatched.length) {
                throw new Error(
                    `EIGEN_DOC_TYPE_INFO.${type}.yjsRoots is out of sync with apps/${appDir}/src:\n` +
                        (missing.length ? `Missing from registry:\n${missing.join('\n')}\n` : '') +
                        (mismatched.length ? `Kind mismatch:\n${mismatched.join('\n')}\n` : ''),
                );
            }
        });
    }
});

describe('EIGEN_DOC_TYPE_INFO declares roots an app does not write yet', () => {
    // Frames are read by the vector reader before any writer exists (phase 2 adds
    // one). The root must be declared now: applySnapshotState throws for an
    // undeclared root the moment a restored vector document carries one.
    test('vector declares the frames root alongside elements and meta', () => {
        expect(EIGEN_DOC_TYPE_INFO.vector.yjsRoots).toEqual({ elements: 'map', frames: 'map', meta: 'map' });
    });
});
