// Generate docs/SHARED-PRIMITIVES.md — the canonical, auto-generated index of everything that
// packages/ui and packages/lib publicly export, so the next author (human or LLM) can FIND a primitive
// before rebuilding it. Re-derivation is the project's main quality risk and it happens because the
// canonical thing isn't discoverable; this is the index AGENTS.md tells you to search first.
//
//   bun run primitives          regenerate docs/SHARED-PRIMITIVES.md
//   bun run primitives --check  fail (exit 1) if the committed file is stale — the CI gate
//
// Source of truth: each package's `exports` map. We enumerate the NAMED barrel entry points plus the
// curated type/constant/hook wildcards; the broad catch-alls (lib `./*`, ui `./components/*`) are skipped
// on purpose — they expose internals, not the public surface. A primitive that isn't reachable from a
// barrel simply won't appear here, which is the nudge to export it (see AGENTS.md "shared until exported").

import { basename, dirname, join, relative } from 'node:path';
import { Glob } from 'bun';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'docs/SHARED-PRIMITIVES.md');
const CODE = /\.tsx?$/;

const PACKAGES = [
    { name: '@workspace/lib', dir: 'packages/lib' },
    { name: '@workspace/ui', dir: 'packages/ui' },
];

type Kind = 'Component' | 'Provider' | 'Hook' | 'Cache' | 'Type' | 'Util';
type Primitive = { name: string; kind: Kind; importPath: string; file: string };

// Build the set of public entry files → the import path callers should use to reach them.
async function entryFiles(pkg: { name: string; dir: string }): Promise<Map<string, string>> {
    const pkgJson = await Bun.file(join(ROOT, pkg.dir, 'package.json')).json();
    const exportsMap: Record<string, string | string[]> = pkgJson.exports ?? {};
    const found = new Map<string, string>();

    const record = (subpath: string, fileTarget: string, stem = '') => {
        if (!CODE.test(fileTarget)) return;
        const abs = join(ROOT, pkg.dir, fileTarget);
        const importPath = pkg.name + subpath.slice(1).replace('*', stem);
        const prev = found.get(abs);
        if (!prev || importPath.split('/').length < prev.split('/').length) found.set(abs, importPath);
    };

    for (const [subpath, rawTarget] of Object.entries(exportsMap)) {
        if (subpath === './*') continue; // lib catch-all: exposes all internals, not the curated surface
        for (const target of Array.isArray(rawTarget) ? rawTarget : [rawTarget]) {
            if (!target.includes('*')) {
                record(subpath, target);
                continue;
            }
            // Enumerate the curated file-wildcards: types, constants, hooks, and the loose Eigen layout
            // components (ConfirmDialog etc.). The bare `./components/*` wildcard is excluded on purpose —
            // it only exposes raw shadcn primitives (DropdownMenuItem, DialogHeader, …) that nobody
            // re-derives. The glob is non-recursive, so named subdir barrels aren't duplicated.
            if (!/(types|constants|hooks|components\/layout)/.test(subpath)) continue;
            const baseDir = join(ROOT, pkg.dir, dirname(target));
            for await (const file of new Glob('*.{ts,tsx}').scan(baseDir)) {
                if (basename(file) === 'index.ts') continue;
                record(subpath, join(dirname(target), file), basename(file).replace(CODE, ''));
            }
        }
    }
    return found;
}

function classify(name: string, flags: ts.SymbolFlags): Kind {
    if (flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) return 'Type';
    if (/^use[A-Z]/.test(name)) return 'Hook';
    if (/^invalidate|Keys$/.test(name)) return 'Cache';
    if (/Provider$/.test(name)) return 'Provider';
    // PascalCase value (has a lowercase letter, unlike SCREAMING_SNAKE constants) → a component.
    const isValue = flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Class);
    if (isValue && /^[A-Z]/.test(name) && /[a-z]/.test(name)) return 'Component';
    return 'Util';
}

const fileToImport = new Map<string, string>();
for (const pkg of PACKAGES) {
    for (const [file, importPath] of await entryFiles(pkg)) {
        const prev = fileToImport.get(file);
        if (!prev || importPath.split('/').length < prev.split('/').length) fileToImport.set(file, importPath);
    }
}

const entries = [...fileToImport.keys()];
const program = ts.createProgram(entries, {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: ROOT,
});
const checker = program.getTypeChecker();

const collected: Primitive[] = [];
let unresolved = 0;
for (const entry of entries) {
    const source = program.getSourceFile(entry);
    const moduleSym = source && checker.getSymbolAtLocation(source);
    if (!moduleSym) continue;
    const importPath = fileToImport.get(entry)!;
    for (const exported of checker.getExportsOfModule(moduleSym)) {
        const name = exported.getName();
        if (name === 'default') continue;
        let sym = exported;
        if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym.declarations?.[0] ?? exported.declarations?.[0];
        if (!decl) {
            unresolved++;
            continue;
        }
        const declFile = decl.getSourceFile().fileName;
        if (declFile.includes('node_modules')) continue;
        const kind = classify(name, sym.flags);
        // Query-key factories + invalidators are intra-domain plumbing, co-located with the domain's hooks
        // (same @workspace/lib/<domain> import as the hook you already found). Listing them is redundant
        // noise, so they're excluded — the convention is documented in the header note instead.
        if (kind === 'Cache') continue;
        collected.push({ name, kind, importPath, file: relative(ROOT, declFile) });
    }
}

// Dedup by declaration identity, keeping the shortest (most canonical) import path.
const byKey = new Map<string, Primitive>();
for (const prim of collected) {
    const key = `${prim.file}::${prim.name}`;
    const prev = byKey.get(key);
    if (!prev || prim.importPath.split('/').length < prev.importPath.split('/').length) byKey.set(key, prim);
}
const primitives = [...byKey.values()].sort(
    (a, b) => a.importPath.localeCompare(b.importPath) || a.name.localeCompare(b.name),
);

const KINDS: { kind: Kind; title: string }[] = [
    { kind: 'Component', title: 'Components' },
    { kind: 'Provider', title: 'Providers & context' },
    { kind: 'Hook', title: 'Hooks' },
    { kind: 'Type', title: 'Types' },
    { kind: 'Util', title: 'Utilities & constants' },
];

function render(): string {
    const lines: string[] = [
        '# Shared Primitives',
        '',
        '> **Generated — do not edit by hand.** Run `bun run primitives` to regenerate;',
        '> `bun run primitives --check` is the CI gate. Source: the `exports` maps of `packages/lib` +',
        '> `packages/ui`. **Search here before building any shared hook, component, type, or util** — if it',
        "> already exists, import it; if it doesn't, add it here by exporting it from its package barrel.",
        '',
        `${primitives.length} primitives across ${KINDS.length} kinds. \`packages/sheet\` internals are excluded.`,
        '',
        "Not listed: each `@workspace/lib/<domain>` barrel also exports that domain's query-key factory",
        '(`<domain>Keys`) and its `invalidate*` helpers — they live beside the domain hooks above. Use those',
        'rather than inlining `queryClient.invalidateQueries`.',
        '',
    ];
    for (const { kind, title } of KINDS) {
        const rows = primitives.filter((p) => p.kind === kind);
        if (rows.length === 0) continue;
        lines.push(
            `## ${title} (${rows.length})`,
            '',
            '| Name | Import from | File |',
            '|------|-------------|------|',
        );
        for (const p of rows) lines.push(`| \`${p.name}\` | \`${p.importPath}\` | ${p.file} |`);
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

const markdown = render();

if (process.argv.includes('--check')) {
    const current = await Bun.file(OUT)
        .text()
        .catch(() => '');
    if (current !== markdown) {
        console.error('ERROR: docs/SHARED-PRIMITIVES.md is out of date — run `bun run primitives` and commit.');
        process.exit(1);
    }
    console.log(`docs/SHARED-PRIMITIVES.md is current (${primitives.length} primitives).`);
} else {
    await Bun.write(OUT, markdown);
    console.log(
        `Wrote ${relative(ROOT, OUT)} — ${primitives.length} primitives${unresolved ? ` (${unresolved} unresolved exports skipped)` : ''}.`,
    );
}
