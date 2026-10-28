// The unused-primitives check of `check-standards.ts`: a primitive the shared-primitives index lists needs a user
// outside its own file. It follows every import, through the packages' `exports` maps and their barrels, to the file
// that defines the name, and reports each primitive nothing imports and each one only tests import. It reads code as
// stripNoise blanked it, so an import inside a comment or a string is no use.

import { dirname, join, normalize } from 'node:path/posix';

export type Primitive = { name: string; type: boolean; importPath: string; file: string };

export type SourceFile = {
    path: string;
    // Raw file text — use it for anything that lives in a comment, a string, or a class name.
    text: string;
    // Comments and literal contents blanked out by stripNoise, offsets kept — use it for anything identifier-shaped.
    code: string;
};

// Each package's `exports` map, keyed by the package's folder name under `packages/`.
export type ExportsMaps = Record<string, Record<string, string>>;

// The helpers of `packages/ui/src/test/` exist for tests, so a test is all the use they get.
const TEST_HELPERS = 'packages/ui/src/test/';
const CODE_FILE = /\.(?:ts|tsx|js|jsx|mjs)$/;
const INDEX_HEADING = /^## (.+) \(\d+\)$/;
const INDEX_ROW = /^\| `([^`]+)` \| `([^`]+)` \| (\S+) \|$/;

// The statements that import or re-export from a module. stripNoise left the quotes of the specifier and blanked what
// sat between them, so the specifier is read from the text at the same place.
const FROM_STATEMENT =
    /\b(import|export)\s+(?:type\s+)?(\*\s+as\s+[\w$]+|\*|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*(['"])[^'"\n]*\3/g;
const LOCAL_DECLARATION =
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class|interface|type|enum|namespace)\s+([\w$]+)/g;
const LOCAL_EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/g;
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])[^'"\n]*\1\s*\)/;
// Before a name that stands on its own: no identifier character, and no `.` of a member access, though a spread's `...`
// is fine.
const NOT_A_MEMBER = String.raw`(?<![\w$])(?<![^.]\.)`;
const PROMISE_ALL = /\b(?:const|let|var)\s*\[([\s\S]*?)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)/g;

// A name read off a module, which the module may define or pass on from another.
type Binding = { spec: string; name: string };
type Module = {
    // Each exported name, with the local declaration it is or the module it comes from.
    exports: Map<string, { local: string } | Binding>;
    // The modules of each `export *`.
    stars: string[];
    // The names this file reads off other modules.
    uses: Binding[];
};

export function readPrimitivesIndex(markdown: string): Primitive[] {
    const primitives: Primitive[] = [];
    let section = '';
    for (const line of markdown.split('\n')) {
        section = INDEX_HEADING.exec(line)?.[1] ?? section;
        const row = INDEX_ROW.exec(line);
        if (row) primitives.push({ name: row[1], type: section === 'Types', importPath: row[2], file: row[3] });
    }
    return primitives;
}

// The primitives with no user outside their own file, and those only tests use. A use from anywhere else, a script or
// a config included, counts. The props type of a component that is used may stay unused: callers can name it.
export function unusedPrimitives(
    primitives: Primitive[],
    sources: SourceFile[],
    exportsMaps: ExportsMaps,
): { unused: Primitive[]; testOnly: Primitive[] } {
    const files = new Map(sources.map((source) => [source.path, source]));
    const modules = new Map<string, Module>();
    const moduleAt = (path: string): Module | undefined => {
        const source = files.get(path);
        if (!source) return undefined;
        const module = modules.get(path) ?? parseModule(source);
        modules.set(path, module);
        return module;
    };
    const resolve = (from: string, spec: string) => resolveSpecifier(from, spec, files, exportsMaps);

    // Where an exported name of a module is declared, as `file::local`, through re-exports and `export *`.
    const definition = (path: string, name: string, seen = new Set<string>()): string | undefined => {
        const module = moduleAt(path);
        if (!module || seen.has(`${path}::${name}`)) return undefined;
        seen.add(`${path}::${name}`);
        const exported = module.exports.get(name);
        if (exported) {
            if ('local' in exported) return `${path}::${exported.local}`;
            const target = resolve(path, exported.spec);
            return target && definition(target, exported.name, seen);
        }
        for (const spec of module.stars) {
            const starTarget = resolve(path, spec);
            const found = starTarget && definition(starTarget, name, seen);
            if (found) return found;
        }
        return undefined;
    };

    const byDefinition = new Map<string, Primitive>();
    for (const primitive of primitives) {
        const entry = resolve('', primitive.importPath);
        const key = (entry && definition(entry, primitive.name)) ?? `${primitive.file}::${primitive.name}`;
        byDefinition.set(key, primitive);
    }

    const users = new Map<Primitive, 'production' | 'test'>();
    for (const source of sources) {
        for (const use of moduleAt(source.path)?.uses ?? []) {
            const target = resolve(source.path, use.spec);
            const key = target && definition(target, use.name);
            const primitive = key ? byDefinition.get(key) : undefined;
            if (!primitive || primitive.file === source.path) continue;
            if (!isTest(source.path)) users.set(primitive, 'production');
            else if (!users.has(primitive)) users.set(primitive, 'test');
        }
    }

    const used = (primitive: Primitive) => users.get(primitive) === 'production';
    const propsOfUsedComponent = (primitive: Primitive) =>
        primitive.type &&
        primitive.name.endsWith('Props') &&
        primitives.some(
            (other) => other.file === primitive.file && other.name === primitive.name.slice(0, -5) && used(other),
        );
    const reported = primitives.filter(
        (primitive) => !primitive.file.startsWith(TEST_HELPERS) && !used(primitive) && !propsOfUsedComponent(primitive),
    );
    return {
        unused: reported.filter((primitive) => !users.has(primitive)),
        testOnly: reported.filter((primitive) => users.has(primitive)),
    };
}

function isTest(path: string): boolean {
    return path.includes('/src/test/') || /\.test\.[jt]sx?$/.test(path);
}

// A relative path or a `@workspace/` package import, to the file it loads. Anything else is a dependency.
function resolveSpecifier(
    from: string,
    spec: string,
    files: Map<string, SourceFile>,
    exportsMaps: ExportsMaps,
): string | undefined {
    if (spec.startsWith('.')) return withExtension(normalize(join(dirname(from), spec)), files);
    const [scope, packageName, ...rest] = spec.split('/');
    const exportsMap = scope === '@workspace' ? exportsMaps[packageName] : undefined;
    if (!exportsMap) return undefined;
    const subpath = rest.length > 0 ? `./${rest.join('/')}` : '.';
    const target = exportsMap[subpath] ?? wildcardTarget(exportsMap, subpath);
    return target === undefined ? undefined : withExtension(join('packages', packageName, target), files);
}

// The target of the `*` entry with the longest prefix that matches, as Node picks one.
function wildcardTarget(exportsMap: Record<string, string>, subpath: string): string | undefined {
    let target: string | undefined;
    let longest = -1;
    for (const [pattern, patternTarget] of Object.entries(exportsMap)) {
        const star = pattern.indexOf('*');
        if (star <= longest) continue;
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (subpath.length < star + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
        longest = star;
        target = patternTarget.replace('*', subpath.slice(star, subpath.length - suffix.length));
    }
    return target;
}

function withExtension(path: string, files: Map<string, SourceFile>): string | undefined {
    if (CODE_FILE.test(path) && files.has(path)) return path;
    const bare = path.replace(/\.jsx?$/, '');
    return [`${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`, `${bare}/index.tsx`].find((candidate) =>
        files.has(candidate),
    );
}

function parseModule({ text, code }: SourceFile): Module {
    const module: Module = { exports: new Map(), stars: [], uses: [] };
    // The specifier of a match on `code`: the text between the match's last two quotes.
    const specifier = (index: number, match: string) => {
        const close = Math.max(match.lastIndexOf("'"), match.lastIndexOf('"'));
        return text.slice(index + match.lastIndexOf(match[close], close - 1) + 1, index + close);
    };

    const bindings = new Map<string, Binding>();
    for (const match of code.matchAll(FROM_STATEMENT)) {
        const [statement, keyword, clause] = match;
        const spec = specifier(match.index, statement);
        const named = namesIn(/\{([^}]*)\}/.exec(clause)?.[1] ?? '');
        const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
        if (keyword === 'export') {
            if (clause === '*') module.stars.push(spec);
            for (const { name, alias } of named) module.exports.set(alias, { spec, name });
            continue;
        }
        if (namespace) bindings.set(namespace, { spec, name: '*' });
        const defaultImport = /^[\w$]+/.exec(clause)?.[0];
        if (defaultImport) bindings.set(defaultImport, { spec, name: 'default' });
        for (const { name, alias } of named) bindings.set(alias, { spec, name });
    }
    for (const match of code.matchAll(LOCAL_DECLARATION)) module.exports.set(match[1], { local: match[1] });
    for (const match of code.matchAll(LOCAL_EXPORT_LIST)) {
        for (const { name, alias } of namesIn(match[1]))
            module.exports.set(alias, bindings.get(name) ?? { local: name });
    }

    // An import is a use where the file's code names it. A barrel that only passes it on in `export { X }` names it
    // nowhere else, which is no use.
    const body = code.replaceAll(FROM_STATEMENT, ' ').replaceAll(LOCAL_EXPORT_LIST, ' ');
    for (const [local, binding] of bindings) {
        if (binding.name !== '*') {
            if (new RegExp(`${NOT_A_MEMBER}${escapeDollar(local)}(?![\\w$])`).test(body)) module.uses.push(binding);
            continue;
        }
        for (const read of body.matchAll(memberReads(local))) module.uses.push({ spec: binding.spec, name: read[1] });
    }
    module.uses.push(...dynamicUses(code, specifier));
    return module;
}

// `{ a, type B, c as d }` as each name with the local alias it gets.
function namesIn(list: string): { name: string; alias: string }[] {
    const names: { name: string; alias: string }[] = [];
    for (const part of list.split(',')) {
        const match = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part.trim());
        if (match) names.push({ name: match[1], alias: match[2] ?? match[1] });
    }
    return names;
}

// The names a file reads off a dynamic import: destructured from it, read as a member of it or of the variable that
// holds it, or by position from a `Promise.all` of several. A spread passes the whole module on, which names nothing.
function dynamicUses(code: string, specifier: (index: number, match: string) => string): Binding[] {
    const uses: Binding[] = [];
    const promiseAlls: [number, number][] = [];
    for (const match of code.matchAll(PROMISE_ALL)) {
        const [statement, targets, imports] = match;
        const targetParts = topLevelParts(targets, 0);
        const importsAt = match.index + statement.lastIndexOf(imports);
        for (const [position, part] of topLevelParts(imports, importsAt).entries()) {
            const dynamic = DYNAMIC_IMPORT.exec(part.text);
            const destructured = /^\s*\{([^{}]*)\}/.exec(targetParts[position]?.text ?? '');
            if (!dynamic || !destructured) continue;
            const spec = specifier(part.start + dynamic.index, dynamic[0]);
            for (const name of destructuredNames(destructured[1])) uses.push({ spec, name });
        }
        promiseAlls.push([match.index, match.index + statement.length]);
    }

    for (const match of code.matchAll(new RegExp(DYNAMIC_IMPORT, 'g'))) {
        if (promiseAlls.some(([start, end]) => match.index >= start && match.index < end)) continue;
        const end = match.index + match[0].length;
        const before = code.slice(Math.max(0, match.index - 300), match.index);
        const after = code.slice(end, end + 60);
        const names: string[] = [];
        // `import('x').Name`, `(await import('x')).Name` and `typeof import('x').fn`.
        const member = /^\s*\)?\s*\.([\w$]+)/.exec(after)?.[1];
        if (member !== undefined && member !== 'then') names.push(member);
        const thenArgument = /^\s*\.then\(\s*\(?\s*([\w$]+)\s*\)?\s*=>/.exec(after)?.[1];
        if (thenArgument) {
            for (const read of code.slice(end, end + 400).matchAll(memberReads(thenArgument))) names.push(read[1]);
        }
        const destructured = /\{([^{}]*)\}\s*=\s*\(?\s*await\s+\(?\s*$/.exec(before)?.[1];
        if (destructured) names.push(...destructuredNames(destructured));
        const variable = /(?:const|let|var)\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*\(?\s*await\s+$/.exec(before)?.[1];
        if (variable && member === undefined) {
            for (const read of code.matchAll(memberReads(variable))) names.push(read[1]);
            for (const read of code.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${escapeDollar(variable)}\\b`, 'g'))) {
                names.push(...destructuredNames(read[1]));
            }
        }
        const spec = specifier(match.index, match[0]);
        for (const name of names) uses.push({ spec, name });
    }
    return uses;
}

function memberReads(name: string): RegExp {
    return new RegExp(`${NOT_A_MEMBER}${escapeDollar(name)}\\.([\\w$]+)`, 'g');
}

// A name as a pattern: `$` is the one character of an identifier that a regular expression reads as more than itself.
function escapeDollar(name: string): string {
    return name.replaceAll('$', '\\$');
}

// `a, b: renamed, c = 1, ...rest` as the names it reads: a, b and c.
function destructuredNames(list: string): string[] {
    return list
        .split(',')
        .map((part) => part.trim().split(/[:=]/)[0].trim())
        .filter((name) => /^[\w$]+$/.test(name));
}

// The comma-separated parts of a list, ignoring commas inside brackets, each with where it starts in the file.
function topLevelParts(list: string, offset: number): { text: string; start: number }[] {
    const parts: { text: string; start: number }[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index <= list.length; index++) {
        const char = list[index];
        if (char === '{' || char === '(' || char === '[') depth++;
        if (char === '}' || char === ')' || char === ']') depth--;
        if (index === list.length || (char === ',' && depth === 0)) {
            parts.push({ text: list.slice(start, index), start: offset + start });
            start = index + 1;
        }
    }
    return parts;
}
