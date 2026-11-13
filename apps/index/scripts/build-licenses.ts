// Writes the data of the index app's /licenses page before it builds: every third-party package any workspace depends
// on, read from its installed package.json, plus the code and fonts the repo carries itself, which no package.json
// names and so are listed here by hand.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { LicenseFont, LicensePackage, LicenseVendored } from './lib/content-types';

// The script sits in the index app's scripts folder, so the app is one level up and the repo root three.
const INDEX_APP = join(import.meta.dir, '..');
const REPO_ROOT = join(INDEX_APP, '..', '..');
const OUT = join(INDEX_APP, 'src', 'content', '.generated', 'licenses.json');

// Code ported or forked into the tree. Not in any package.json, so listed by hand.
const VENDORED: LicenseVendored[] = [
    {
        name: 'Excalidraw',
        license: 'MIT',
        url: 'https://github.com/excalidraw/excalidraw',
        note: 'eigen|vector⟩ ports its elbow-arrow routing, freehand and elbow SVG path generation, and fractional-index repair',
    },
    {
        name: 'fortune-sheet',
        license: 'MIT',
        url: 'https://github.com/ruilisi/fortune-sheet',
        note: 'the sheets engine and grid started as a fork of fortune-sheet 1.0.4',
    },
    {
        name: 'Luckysheet',
        license: 'MIT',
        url: 'https://github.com/dream-num/Luckysheet',
        note: "fortune-sheet's own origin; the conditional-format color presets come from it",
    },
    {
        name: 'fractional-indexing',
        license: 'CC0-1.0',
        url: 'https://github.com/rocicorp/fractional-indexing',
        note: 'vendored verbatim to pin z-order behavior in eigen|vector⟩',
    },
    {
        name: 'ECMA-376 preset shape definitions',
        license: 'Ecma copyright notice',
        url: 'https://ecma-international.org/publications-and-standards/standards/ecma-376/',
        note: "presetShapeDefinitions.xml, unchanged, draws a PowerPoint file's preset shapes on import",
    },
];

// Bundled font files, not packages, so listed by hand.
const FONTS: LicenseFont[] = [
    { name: 'Inter', license: 'OFL-1.1', url: 'https://github.com/rsms/inter' },
    { name: 'Source Serif 4', license: 'OFL-1.1', url: 'https://github.com/adobe-fonts/source-serif' },
    { name: 'JetBrains Mono', license: 'OFL-1.1', url: 'https://github.com/JetBrains/JetBrainsMono' },
    { name: 'Excalifont', license: 'OFL-1.1', url: 'https://plus.excalidraw.com/excalifont' },
    { name: 'Noto Emoji', license: 'OFL-1.1', url: 'https://github.com/googlefonts/noto-emoji' },
    { name: 'Noto Sans SC', license: 'OFL-1.1', url: 'https://github.com/notofonts/noto-cjk' },
    { name: 'Noto Sans KR', license: 'OFL-1.1', url: 'https://github.com/notofonts/noto-cjk' },
    {
        name: 'New Computer Modern Math',
        license: 'GUST Font License',
        url: 'https://download.gnu.org.ua/release/newcm/',
    },
];

type PackageJson = {
    version?: string;
    license?: string | { type?: string };
    licenses?: ({ type?: string } | string)[];
    repository?: string | { url?: string };
    homepage?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
};

// Every workspace package.json, paired with its directory so we can read each declared
// dependency's installed copy from that workspace's node_modules.
function workspacePackageJsons(): { dir: string; pkg: PackageJson }[] {
    const files = ['package.json'];
    for (const pattern of ['apps/*/package.json', 'packages/*/package.json']) {
        files.push(...new Glob(pattern).scanSync(REPO_ROOT));
    }
    return files.sort().map((relative) => {
        const file = join(REPO_ROOT, relative);
        return { dir: dirname(file), pkg: JSON.parse(readFileSync(file, 'utf-8')) };
    });
}

function normalizeLicense(pkg: PackageJson): string {
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license?.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses))
        return pkg.licenses.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ');
    return 'Unknown';
}

function normalizeUrl(pkg: PackageJson, name: string): string {
    const raw = (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ?? pkg.homepage;
    if (!raw) return `https://www.npmjs.com/package/${name}`;
    let url = raw
        .replace(/^git\+/, '')
        .replace(/\.git$/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/^ssh:\/\/git@/, 'https://')
        .replace(/^git@github\.com:/, 'https://github.com/');
    if (url.startsWith('github:')) url = `https://github.com/${url.slice('github:'.length)}`;
    else if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    return url;
}

// A dependency's installed package.json, read from disk, because many packages' `exports` field blocks resolving
// `<name>/package.json`. An isolated install links each workspace's dependencies into its own node_modules, and the
// root's hoisted copy is the fallback.
function readInstalled(dir: string, name: string): PackageJson | null {
    for (const base of [dir, REPO_ROOT]) {
        const file = join(base, 'node_modules', name, 'package.json');
        if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
    }
    return null;
}

const byName = new Map<string, LicensePackage>();
const missing: string[] = [];

for (const { dir, pkg } of workspacePackageJsons()) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        // The repo's own workspace packages are not third-party code.
        if (name.startsWith('@workspace/') || name.startsWith('@apps/') || byName.has(name)) continue;
        const installed = readInstalled(dir, name);
        if (!installed?.version) {
            missing.push(name);
            continue;
        }
        byName.set(name, {
            name,
            version: installed.version,
            license: normalizeLicense(installed),
            url: normalizeUrl(installed, name),
        });
    }
}

const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ packages, vendored: VENDORED, fonts: FONTS }));
console.log(`✓ Wrote ${OUT}: ${packages.length} packages, ${VENDORED.length} vendored, ${FONTS.length} fonts`);
if (missing.length) console.warn(`⚠ Could not resolve ${missing.length}: ${missing.sort().join(', ')}`);
