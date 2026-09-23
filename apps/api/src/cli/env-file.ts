import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

type EnvLine = { raw: string; key: string | null; value: string };

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/;
const INTERPOLATION = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const BARE_SAFE = /^[\w.,:/@+=%-]*$/;

// Compose's dotenv rules: single quotes are literal; double quotes and bare values take `$$` as `$` and
// expand `$NAME` from earlier lines (unset = empty); a bare value ends at ` #`; the last duplicate wins.
function parseEnvLines(text: string): EnvLine[] {
    const seen = new Map<string, string>();
    const interpolate = (value: string) =>
        value.replace(INTERPOLATION, (match, braced?: string, plain?: string) =>
            match === '$$' ? '$' : (seen.get(braced ?? plain ?? '') ?? ''),
        );
    return text.split('\n').map((raw) => {
        const match = raw.replace(/\r$/, '').match(KEY_LINE);
        if (!match) return { raw, key: null, value: '' };
        const [, key = '', rest = ''] = match;
        let value: string;
        if (rest.startsWith("'")) {
            const end = rest.indexOf("'", 1);
            value = rest.slice(1, end === -1 ? undefined : end);
        } else if (rest.startsWith('"')) {
            let inner = '';
            for (let i = 1; i < rest.length && rest[i] !== '"'; i++) {
                const escaped = rest[i] === '\\' ? rest[i + 1] : undefined;
                if (escaped === undefined) {
                    inner += rest[i];
                    continue;
                }
                inner += escaped === 'n' ? '\n' : escaped === '\\' || escaped === '"' ? escaped : `\\${escaped}`;
                i++;
            }
            value = interpolate(inner);
        } else {
            value = interpolate(rest.replace(/\s+#.*$/, '').trim());
        }
        seen.set(key, value);
        return { raw, key, value };
    });
}

function formatEnvValue(value: string): string {
    if (/[\n\r]/.test(value)) throw new Error('An env file value cannot span lines');
    if (BARE_SAFE.test(value)) return value;
    if (!value.includes("'")) return `'${value}'`;
    return `"${value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('$', () => '$$')}"`;
}

export function readEnvFile(path: string): Map<string, string> {
    const entries = new Map<string, string>();
    if (!existsSync(path)) return entries;
    for (const line of parseEnvLines(readFileSync(path, 'utf8'))) {
        if (line.key !== null) entries.set(line.key, line.value);
    }
    return entries;
}

// `entries` is the whole new content: lines of keys it lacks are dropped, a line whose value is unchanged
// stays byte-for-byte, and keys the file did not have are appended in insertion order.
export function writeEnvFile(path: string, entries: Map<string, string>): void {
    const text = existsSync(path) ? readFileSync(path, 'utf8').replace(/\n$/, '') : '';
    const lines = text ? parseEnvLines(text) : [];
    const out: string[] = [];
    const written = new Set<string>();
    for (const line of lines) {
        if (line.key === null) {
            out.push(line.raw);
            continue;
        }
        const value = entries.get(line.key);
        if (value === undefined) continue;
        out.push(value === line.value ? line.raw : `${line.key}=${formatEnvValue(value)}`);
        written.add(line.key);
    }
    for (const [key, value] of entries) {
        if (!written.has(key)) out.push(`${key}=${formatEnvValue(value)}`);
    }
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${out.join('\n')}\n`, { mode: 0o600 });
    renameSync(temp, path);
}
