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
import * as ts from 'typescript/unstable/ast';
import { API, SymbolFlags } from 'typescript/unstable/async';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'docs/SHARED-PRIMITIVES.md');
const CODE = /\.tsx?$/;

const PACKAGES = [
    { name: '@workspace/lib', dir: 'packages/lib' },
    { name: '@workspace/ui', dir: 'packages/ui' },
];

type Kind = 'Component' | 'Provider' | 'Schema' | 'Hook' | 'Cache' | 'Type' | 'Util';
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

// Simple callee name of a call expression: `createContext` from `createContext(...)`
// or `React.createContext(...)`; `create` from `Node.create(...)` / `Mark.create(...)`.
function calleeName(call: ts.CallExpression): string | undefined {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return undefined;
}

// React class components (ErrorBoundary) extend Component/PureComponent; error and other
// utility classes (AppError) don't — only the latter belong with the schemas/classes.
function isReactComponentClass(decl: ts.Declaration): boolean {
    if (!ts.isClassDeclaration(decl)) return false;
    for (const clause of decl.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of clause.types) {
            const e = t.expression;
            const base = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : '';
            if (base === 'Component' || base === 'PureComponent') return true;
        }
    }
    return false;
}

function classify(name: string, flags: SymbolFlags, decl: ts.Declaration): Kind {
    if (flags & (SymbolFlags.TypeAlias | SymbolFlags.Interface)) return 'Type';
    if (/^use[A-Z]/.test(name)) return 'Hook';
    if (/^invalidate|Keys$/.test(name)) return 'Cache';
    if (/Provider$/.test(name)) return 'Provider';
    // Non-component classes (AppError), React contexts, and TipTap Node/Mark schemas are
    // values but not components — name+flags alone can't tell them apart, so inspect the
    // declaration; React class components (ErrorBoundary) still classify as Component.
    if (flags & SymbolFlags.Class) return isReactComponentClass(decl) ? 'Component' : 'Schema';
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
        let init = decl.initializer;
        if (ts.isCallExpression(init) && (calleeName(init) === 'createContext' || calleeName(init) === 'create')) {
            return 'Schema';
        }
        if (ts.isAsExpression(init)) init = init.expression;
        // PascalCase `const X = { … } (as const)` is an enum-like constant (SSEventType), not a component.
        if (ts.isObjectLiteralExpression(init)) return 'Util';
    }
    // PascalCase value (has a lowercase letter, unlike SCREAMING_SNAKE constants) → a component.
    const isValue = flags & (SymbolFlags.Function | SymbolFlags.Variable | SymbolFlags.Class);
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
const collected: Primitive[] = [];
let unresolved = 0;
const api = new API({ cwd: ROOT });
const snapshot = await api.updateSnapshot({ openFiles: entries });
try {
    for (const entry of entries) {
        const project = await snapshot.getDefaultProjectForFile(entry);
        const source = await project?.program.getSourceFile(entry);
        const moduleSym = source && (await project?.checker.getSymbolAtLocation(source));
        if (!project || !moduleSym) continue;
        const importPath = fileToImport.get(entry)!;
        for (const exported of await project.checker.getExportsOfModule(moduleSym)) {
            const name = exported.name;
            if (name === 'default') continue;
            const sym =
                exported.flags & SymbolFlags.Alias ? await project.checker.getAliasedSymbol(exported) : exported;
            const declHandle = sym.declarations[0] ?? exported.declarations[0];
            const decl = await declHandle?.resolve();
            if (!decl) {
                unresolved++;
                continue;
            }
            const declFile = decl.getSourceFile().fileName;
            if (declFile.includes('node_modules')) continue;
            const kind = classify(name, sym.flags, decl);
            // Query-key factories + invalidators are intra-domain plumbing, co-located with the domain's hooks
            // (same @workspace/lib/<domain> import as the hook you already found). Listing them is redundant
            // noise, so they're excluded — the convention is documented in the header note instead.
            if (kind === 'Cache') continue;
            // Normalize to POSIX separators so the generated doc is identical across
            // platforms (Windows `relative()` yields backslashes, which would otherwise
            // flip every path and break `primitives:check`).
            collected.push({ name, kind, importPath, file: relative(ROOT, declFile).replaceAll('\\', '/') });
        }
    }
} finally {
    await snapshot.dispose();
    await api.close();
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
    { kind: 'Provider', title: 'Providers' },
    { kind: 'Schema', title: 'Contexts, schemas & classes' },
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
