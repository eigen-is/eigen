import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import type { LicensePackage } from './lib/content-types';

// apps/index/scripts → repo root is three levels up.
const INDEX_APP = join(import.meta.dir, '..');
const REPO_ROOT = join(INDEX_APP, '..', '..');
const OUT = join(INDEX_APP, 'src', 'content', '.generated', 'licenses.json');

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
    return files.sort().map((rel) => {
        const abs = join(REPO_ROOT, rel);
        return { dir: dirname(abs), pkg: JSON.parse(readFileSync(abs, 'utf-8')) as PackageJson };
    });
}

function normalizeLicense(pkg: PackageJson): string {
    if (typeof pkg.license === 'string') return pkg.license;
    if (pkg.license?.type) return pkg.license.type;
    if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
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

// Read a dependency's installed package.json directly. A direct fs read bypasses the
// `exports` field that blocks `<name>/package.json` module resolution for many packages.
// Isolated installs symlink each workspace's deps into its own node_modules; fall back
// to the hoisted root copy.
function readInstalled(dir: string, name: string): PackageJson | null {
    for (const base of [dir, REPO_ROOT]) {
        const p = join(base, 'node_modules', name, 'package.json');
        if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as PackageJson;
    }
    return null;
}

const byName = new Map<string, LicensePackage>();
const missing: string[] = [];

for (const { dir, pkg } of workspacePackageJsons()) {
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        // Skip internal workspace packages (not third-party OSS).
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
writeFileSync(OUT, JSON.stringify({ packages }));
console.log(`✓ Wrote ${OUT} — ${packages.length} packages`);
if (missing.length) console.warn(`⚠ Could not resolve ${missing.length}: ${missing.sort().join(', ')}`);
