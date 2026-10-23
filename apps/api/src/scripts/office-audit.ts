// What the docx, xlsx and pptx audits share: the corpus walk, the child process each file runs in, and the round trip
// gate, which imports a file, writes it with our writer, imports that again and compares the two imports. Each format's
// script brings its own reader, writer, comparison and LISTED table, the differences it explains; a difference none
// explains is unlisted, and the run passes with no crash, no cut and no unlisted difference.
import * as fs from 'node:fs';
import path from 'node:path';
import { peakRss } from '../lib/core/peak-rss';
import { type ExportMedia, toTransferableBuffer } from '../lib/document/transform/protocol';
import { TRANSFORM_LIMITS } from '../lib/document/transform/runner';
import type { OfficeMedia } from '../lib/export/office-image';
import type { ImportedMedia } from '../lib/import/image-types';

export const MB = 1024 * 1024;

const POLL_MS = 250;

export const DEFAULT_MAX_RSS_MB = 8192;
// An import, an export and an import again.
const DEFAULT_ROUNDTRIP_TIMEOUT_MS = 2 * TRANSFORM_LIMITS.import.deadlineMs + TRANSFORM_LIMITS.export.deadlineMs;

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Object keys sorted, so two importers building the same map in another order fingerprint alike.
export function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, inner: unknown) =>
        inner && typeof inner === 'object' && !Array.isArray(inner)
            ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : inner,
    );
}

export function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

export const cellText = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 100);

export type CorpusFile = { key: string; absolute: string };

// The files of the corpora a name matches, keyed by their corpus dir's name and their path inside it; Office's lock
// files (~$name.docx) are no packages.
export function listCorpus(corpora: string[], pattern: RegExp, noun: string): CorpusFile[] {
    const files = new Map<string, string>();
    for (const corpus of corpora) {
        const root = path.resolve(corpus);
        for (const relative of new Bun.Glob('**/*').scanSync({ cwd: root, onlyFiles: true, dot: true })) {
            if (!pattern.test(relative) || path.basename(relative).startsWith('~$')) continue;
            const key = `${path.basename(root)}/${relative}`;
            if (files.has(key)) throw new Error(`Two corpora hold ${key}`);
            files.set(key, path.join(root, relative));
        }
    }
    if (files.size === 0) throw new Error(`No ${noun} under ${corpora.join(', ')}`);
    return [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, absolute]) => ({ key, absolute }));
}

// The child's peak as ps sees it, for a child cut before it could say.
function residentMb(pid: number): number {
    const ps = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]);
    return Number(ps.stdout.toString().trim() || 0) / 1024;
}

// A child running the script, cut at the time or memory cap: the JSON lines it reported, in order, whether it was cut,
// the peak ps saw and, for a child that stopped short, why.
export async function spawnChild<Report>(
    script: string,
    args: string[],
    options: { timeoutMs: number; maxRssMb: number; reports: string },
): Promise<{ reports: Report[]; cut?: 'timeout' | 'memory'; observedMb: number; wallMs: number; why: string }> {
    fs.rmSync(options.reports, { force: true });
    const started = performance.now();
    const child = Bun.spawn([process.execPath, script, ...args, '--reports', options.reports], {
        stdout: 'ignore',
        stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    let cut: 'timeout' | 'memory' | undefined;
    let observedMb = 0;
    const timer = setTimeout(() => {
        cut ??= 'timeout';
        child.kill('SIGKILL');
    }, options.timeoutMs);
    for (let exited = false; !exited; ) {
        observedMb = Math.max(observedMb, residentMb(child.pid));
        if (observedMb > options.maxRssMb) {
            cut ??= 'memory';
            child.kill('SIGKILL');
        }
        exited = await Promise.race([child.exited.then(() => true), Bun.sleep(POLL_MS).then(() => false)]);
    }
    clearTimeout(timer);
    const wallMs = performance.now() - started;
    const reports: Report[] = fs.existsSync(options.reports)
        ? fs
              .readFileSync(options.reports, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];
    fs.rmSync(options.reports, { force: true });
    // Why the child stopped short, where it did: Bun ends an uncaught error's report with its own version.
    const lines = (await stderr).split('\n').map((line) => line.trim());
    const why =
        cut ??
        (lines.find((line) => /error/i.test(line)) ||
            (child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`));
    return { reports, cut, observedMb, wallMs, why };
}

// ── Round trip ──────────────────────────────────────────────────────────────────────────────────────────────────

// One thing the two imports hold differently: a feature at a place, as the first import holds it and the second.
export type RoundtripDifference = { feature: string; at: string; a: unknown; b: unknown };

// A difference the format's writer explains, with why it is no loss or a loss the writer accepts.
export type Listed<D, C> = { kind: string; why: string; matches(difference: D, context: C): boolean };

type DifferenceExample = { at: string; a: string; b: string };
export type DifferenceGroup = { kind: string; listed: boolean; count: number; examples: DifferenceExample[] };

const ROUNDTRIP_EXAMPLES = 3;
const EXAMPLE_CHARS = 300;

const shown = (value: unknown) => (value === undefined ? '–' : canonical(value));

// By kind, the listed ones under their own name, the rest under their feature, most first.
export function classify<D extends RoundtripDifference, C>(
    differences: D[],
    listed: readonly Listed<D, C>[],
    context: C,
    place: (difference: D) => string = (difference) => difference.at,
): DifferenceGroup[] {
    const groups = new Map<string, DifferenceGroup>();
    for (const difference of differences) {
        const entry = listed.find((candidate) => candidate.matches(difference, context));
        const kind = entry?.kind ?? difference.feature;
        const group = groups.get(kind) ?? { kind, listed: entry !== undefined, count: 0, examples: [] };
        groups.set(kind, group);
        group.count++;
        if (group.examples.length < ROUNDTRIP_EXAMPLES)
            group.examples.push({
                at: place(difference),
                a: shown(difference.a).slice(0, EXAMPLE_CHARS),
                b: shown(difference.b).slice(0, EXAMPLE_CHARS),
            });
    }
    return [...groups.values()].sort((x, y) => y.count - x.count);
}

type RoundtripOutcome = 'ok' | 'skipped' | 'crash' | 'timeout' | 'memory';
const STAGES = ['import', 'export', 'reimport', 'compare'] as const;
type Stage = (typeof STAGES)[number];

// What the round trip's child reports, a line a stage.
type RoundtripReport =
    | { kind: 'stage'; stage: Stage; ms: number }
    | { kind: 'failed'; stage: Stage; status?: number; error: string }
    | { kind: 'done'; warnings: Record<string, number>; groups: DifferenceGroup[]; rssMb: number };

export type RoundtripResult = {
    file: string;
    bytes: number;
    outcome: RoundtripOutcome;
    // Where a crash happened.
    stage?: Stage;
    status?: number;
    error?: string;
    ms: Partial<Record<Stage, number>>;
    rssMb: number;
    warnings: Record<string, number>;
    groups: DifferenceGroup[];
};

export type RoundtripMeta = {
    corpora: string[];
    files: number;
    outcomes: Record<RoundtripOutcome, number>;
    // Differences, and the files holding any.
    unlisted: { differences: number; files: number };
    listed: { differences: number; files: number };
    maxRssMb: number;
    totalMs: number;
    pass: boolean;
};

// A format's gate: its script, which runs the child, the files it reads, its writer and its LISTED table.
export type RoundtripGate = {
    format: string;
    script: string;
    pattern: RegExp;
    noun: string;
    writer: string;
    listed: readonly { kind: string; why: string }[];
};

export type RoundtripOptions = {
    corpora: string[];
    out: string;
    writer?: string;
    dump?: string;
    timeoutMs?: number;
    maxRssMb?: number;
};

export type Step = <T>(name: Stage, run: () => T | Promise<T>) => Promise<T>;

// The round trip's child: `run` takes each stage through `step`, which reports it, and returns the writer's warnings,
// by code, and the differences classified; a stage that throws is reported with it. With `dump`, the bytes the export
// stage returns are written there.
export async function roundtripChild(
    { reports, dump }: { reports: string; dump?: string },
    run: (step: Step) => Promise<{ warnings: ReadonlyMap<string, number>; groups: DifferenceGroup[] }>,
): Promise<void> {
    const report = (line: RoundtripReport) => fs.appendFileSync(reports, `${JSON.stringify(line)}\n`);
    let stage: Stage = 'import';
    const step: Step = async (name, inner) => {
        stage = name;
        const started = performance.now();
        const value = await inner();
        report({ kind: 'stage', stage: name, ms: performance.now() - started });
        if (dump && name === 'export') {
            if (!(value instanceof Uint8Array)) throw new Error('The writer returned no bytes to dump');
            fs.mkdirSync(path.dirname(dump), { recursive: true });
            fs.writeFileSync(dump, value);
        }
        return value;
    };
    try {
        const { warnings, groups } = await run(step);
        report({ kind: 'done', warnings: Object.fromEntries(warnings), groups, rssMb: peakRss() / MB });
    } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
        report({
            kind: 'failed',
            stage,
            ...(typeof status === 'number' && { status }),
            error: error instanceof Error && stage !== 'import' ? (error.stack ?? error.message) : message(error),
        });
    }
}

// An import's pictures as the export's media prep makes them (export/media.ts): a raster re-encoded as PNG or JPEG, an
// SVG as it is, and any the writer draws itself, each SVG with its PNG beside it.
export async function officeMedia(media: ImportedMedia[], drawn: ExportMedia[] = []): Promise<OfficeMedia[]> {
    const { encodeOfficeImage, WEBP_SCAN_BYTES, withSvgFallbacks } = await import('../lib/export/office-image');
    const { sharpResize } = await import('../lib/shared/sharp-resize');
    const prepared: ExportMedia[] = [];
    for (const { name, contentType, data } of media) {
        if (contentType === 'image/svg+xml') {
            prepared.push({ name, contentType, data: toTransferableBuffer(data) });
            continue;
        }
        const webp = contentType === 'image/webp' ? data.subarray(0, WEBP_SCAN_BYTES) : null;
        const item = await encodeOfficeImage(name, contentType, webp, (options) => sharpResize(data, options));
        if (item) prepared.push(item);
    }
    return withSvgFallbacks([...prepared, ...drawn]);
}

async function roundtripOne(
    gate: RoundtripGate,
    file: CorpusFile,
    options: { writer: string; dump?: string; timeoutMs: number; maxRssMb: number; reports: string },
): Promise<RoundtripResult> {
    const dump = options.dump ? ['--dump', path.join(options.dump, `${file.key}.${gate.format}`)] : [];
    const { reports, cut, observedMb, why } = await spawnChild<RoundtripReport>(
        gate.script,
        ['roundtrip-child', file.absolute, '--writer', options.writer, ...dump],
        options,
    );
    const ms: RoundtripResult['ms'] = {};
    for (const line of reports) if (line.kind === 'stage') ms[line.stage] = Math.round(line.ms);
    const failed = reports.find((line) => line.kind === 'failed');
    const done = reports.find((line) => line.kind === 'done');
    // The first import refusing the file skips it, as the writer refusing what it made does (an empty deck): the
    // corpus run counts those.
    const skipped = (failed?.stage === 'import' || failed?.stage === 'export') && failed.status !== undefined;
    return {
        file: file.key,
        bytes: fs.statSync(file.absolute).size,
        outcome: done ? 'ok' : skipped ? 'skipped' : (cut ?? 'crash'),
        ...(!done && { stage: failed?.stage ?? STAGES.find((stage) => !(stage in ms)) }),
        status: failed?.status,
        error: failed?.error ?? (done ? undefined : why),
        ms,
        rssMb: Math.round(done?.rssMb ?? observedMb),
        warnings: done?.warnings ?? {},
        groups: done?.groups ?? [],
    };
}

const differencesIn = (results: RoundtripResult[], listed: boolean) => {
    const counted = results.map((result) =>
        result.groups.filter((group) => group.listed === listed).reduce((sum, group) => sum + group.count, 0),
    );
    return { differences: counted.reduce((sum, n) => sum + n, 0), files: counted.filter((n) => n > 0).length };
};

// Pass: no crash, cut or unlisted difference. With `dump`, each file our writer wrote lands there under its key, so two
// runs compare byte for byte (`diff -rq`).
export async function runRoundtrip(gate: RoundtripGate, options: RoundtripOptions): Promise<RoundtripMeta> {
    const started = performance.now();
    const files = listCorpus(options.corpora, gate.pattern, gate.noun);
    // A file left from another run would compare as this one's.
    if (options.dump && fs.existsSync(options.dump) && fs.readdirSync(options.dump).length > 0)
        throw new Error(`${options.dump} is not empty`);
    fs.mkdirSync(options.out, { recursive: true });
    fs.rmSync(path.join(options.out, 'files'), { recursive: true, force: true });
    const results: RoundtripResult[] = [];
    for (const [index, file] of files.entries()) {
        const result = await roundtripOne(gate, file, {
            writer: path.resolve(options.writer ?? gate.writer),
            dump: options.dump && path.resolve(options.dump),
            timeoutMs: options.timeoutMs ?? DEFAULT_ROUNDTRIP_TIMEOUT_MS,
            maxRssMb: options.maxRssMb ?? DEFAULT_MAX_RSS_MB,
            reports: path.join(options.out, 'child.jsonl'),
        });
        results.push(result);
        const target = path.join(options.out, 'files', `${file.key}.json`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(result)}\n`);
        const unlisted = differencesIn([result], false).differences;
        console.log(
            `[${index + 1}/${files.length}] ${file.key}: ${result.outcome}${result.stage ? ` at ${result.stage}` : ''}${unlisted ? `, ${unlisted} unlisted` : ''}`,
        );
    }
    const count = (outcome: RoundtripOutcome) => results.filter((result) => result.outcome === outcome).length;
    const outcomes = {
        ok: count('ok'),
        skipped: count('skipped'),
        crash: count('crash'),
        timeout: count('timeout'),
        memory: count('memory'),
    };
    const unlisted = differencesIn(results, false);
    const meta: RoundtripMeta = {
        corpora: options.corpora.map((corpus) => path.resolve(corpus)),
        files: results.length,
        outcomes,
        unlisted,
        listed: differencesIn(results, true),
        maxRssMb: Math.max(0, ...results.map((result) => result.rssMb)),
        totalMs: Math.round(performance.now() - started),
        pass: outcomes.crash + outcomes.timeout + outcomes.memory === 0 && unlisted.differences === 0,
    };
    fs.writeFileSync(path.join(options.out, 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
    fs.writeFileSync(path.join(options.out, 'summary.md'), roundtripMarkdown(gate, meta, results));
    return meta;
}

export function roundtripLine(meta: RoundtripMeta): string {
    const { outcomes, unlisted, listed } = meta;
    return `Round trip ${meta.pass ? 'pass' : 'FAIL'}: ${meta.files} files, ${outcomes.ok} imported and written back, ${outcomes.skipped} skipped, ${outcomes.crash} crashes, ${outcomes.timeout + outcomes.memory} cut; ${unlisted.differences} unlisted differences in ${unlisted.files} files, ${listed.differences} listed in ${listed.files}`;
}

function roundtripMarkdown(gate: RoundtripGate, meta: RoundtripMeta, results: RoundtripResult[]): string {
    const kinds = new Map<string, { listed: boolean; count: number; files: number }>();
    for (const result of results) {
        for (const group of result.groups) {
            const entry = kinds.get(group.kind) ?? { listed: group.listed, count: 0, files: 0 };
            kinds.set(group.kind, entry);
            entry.count += group.count;
            entry.files++;
        }
    }
    const why = new Map(gate.listed.map((entry) => [entry.kind, entry.why]));
    const failed = results.filter((result) => result.outcome !== 'ok' && result.outcome !== 'skipped');
    const differing = results.filter((result) => result.groups.length > 0);
    const examples = (examples: DifferenceExample[]) =>
        examples
            .map((example) => `${cellText(example.at)}: ${cellText(example.a)} → ${cellText(example.b)}`)
            .join('<br>');
    return [
        `# ${gate.format} round trip`,
        '',
        `Import → our export → import on ${meta.corpora.map((corpus) => `\`${corpus}\``).join(', ')}, the two imports compared.`,
        '',
        `**${roundtripLine(meta)}.**`,
        '',
        `Peak RSS, largest ${meta.maxRssMb} MB; total ${seconds(meta.totalMs)}.`,
        '',
        '## Kinds',
        '',
        '| Kind | Listed | Differences | Files | Why |',
        '|---|---|---:|---:|---|',
        ...[...kinds]
            .sort(([, x], [, y]) => Number(x.listed) - Number(y.listed) || y.count - x.count)
            .map(
                ([kind, entry]) =>
                    `| ${kind} | ${entry.listed ? 'listed' : '**unlisted**'} | ${entry.count} | ${entry.files} | ${why.get(kind) ?? ''} |`,
            ),
        '',
        '## Crashed or cut',
        '',
        '| File | Outcome | Stage | Message |',
        '|---|---|---|---|',
        ...failed.map(
            (result) =>
                `| ${result.file} | ${result.outcome} | ${result.stage ?? ''} | ${cellText(result.error ?? '')} |`,
        ),
        '',
        '## Files',
        '',
        '| File | Kind | Listed | Differences | Examples (at: first import → second) |',
        '|---|---|---|---:|---|',
        ...differing.flatMap((result) =>
            result.groups.map(
                (group) =>
                    `| ${result.file} | ${group.kind} | ${group.listed ? 'listed' : '**unlisted**'} | ${group.count} | ${examples(group.examples)} |`,
            ),
        ),
        '',
    ].join('\n');
}
