// The benchmark run: speed on Bun and on Node, correctness on every recorded row, and coverage, written to the
// results file the README is rendered from. Every timed run is a fresh child process of one engine and one workload,
// never two at once; the rounds interleave the engines, and a run starts on a quiet machine and is taken again when
// the machine got busy during it. A time counts only when the engine's values match ours. A correctness child that
// stops answering is killed, its row counted as crashed, and a new child goes on after it.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Verdict } from './correctness';
import { singleCalls, VERDICTS } from './correctness';
import type { Coverage } from './coverage';
import { coverage } from './coverage';
import { HYPERFORMULA_CONFIG } from './engines';
import { readData } from './rows';
import type { EngineName, Measured } from './speed';
import { ENGINES, WORKLOADS } from './speed';

const USAGE = `bun run.ts [options], from packages/formula/benchmark after bun install there
  --only <parts>      speed, correctness, coverage, comma-separated (default all); the others keep their results
  --rounds <n>        rounds per speed row, each a fresh process per engine (default 5)
  --runtimes <list>   bun, node (default both)
  --filter <regex>    only the speed workloads whose name matches
  --max-load <n>      wait before each round until the 1-minute load is below this (default 6)`;

const HERE = import.meta.dir;
export const RESULTS_FILE = path.join(HERE, 'results.json');
const REPS = 3;
// A child that prints nothing for this long is taken to hang.
const SILENT_MS = 20_000;
const WAIT_MS = 30 * 60_000;
const RETRIES = 5;

export type SpeedCell = {
    readonly status: 'measured' | 'not supported' | 'wrong values' | 'failed';
    readonly min?: number;
    readonly median?: number;
    readonly note?: string;
};
export type SpeedRow = {
    readonly workload: string;
    readonly what: string;
    readonly memory: boolean;
    readonly hyperformula: string;
    readonly engines: Readonly<Record<EngineName, SpeedCell>>;
};
export type SpeedRun = {
    readonly runtime: string;
    readonly rounds: number;
    readonly reps: number;
    readonly load: {
        readonly before: string;
        readonly after: string;
        readonly highest: number;
        readonly discarded: number;
    };
    readonly seconds: number;
    readonly rows: readonly SpeedRow[];
};
export type EngineVerdicts = {
    readonly total: Readonly<Record<Verdict, number>>;
    readonly byFile: Readonly<Record<string, Readonly<Record<Verdict, number>>>>;
    readonly hung: readonly string[];
};
export type Results = {
    readonly generated: string;
    readonly machine: { readonly cpu: string; readonly cores: number; readonly memoryGb: number; readonly os: string };
    readonly versions: Readonly<Record<string, string>>;
    readonly hyperformulaConfig: unknown;
    readonly speed: Readonly<Record<string, SpeedRun>>;
    readonly correctness?: {
        readonly source: string;
        readonly rows: number;
        readonly unjudged: number;
        readonly formulajsRows: number;
        readonly engines: Readonly<Record<EngineName, EngineVerdicts>>;
    };
    readonly coverage?: Coverage;
};

function loadText(): string {
    return os
        .loadavg()
        .map((average) => average.toFixed(2))
        .join(' ');
}

function waitForQuiet(limit: number): void {
    const until = Date.now() + WAIT_MS;
    while (os.loadavg()[0] >= limit && Date.now() < until) {
        process.stderr.write(`waiting: 1-minute load ${os.loadavg()[0].toFixed(2)}\n`);
        Bun.sleepSync(15_000);
    }
}

function median(sorted: readonly number[]): number {
    const half = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

function nodeBundle(): string {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-benchmark-'));
    const built = spawnSync(
        process.execPath,
        ['build', '--target', 'node', path.join(HERE, 'speed.ts'), '--outfile', path.join(out, 'speed.mjs')],
        { encoding: 'utf8' },
    );
    if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
    return path.join(out, 'speed.mjs');
}

function speedRun(runtime: 'bun' | 'node', rounds: number, filter: RegExp, limit: number): SpeedRun {
    const started = Date.now();
    const before = loadText();
    const command =
        runtime === 'bun' ? [process.execPath, path.join(HERE, 'speed.ts')] : ['node', '--expose-gc', nodeBundle()];
    const workloads = WORKLOADS.filter((workload) => filter.test(workload.name));
    const times = new Map<string, number[]>();
    const values = new Map<string, readonly string[]>();
    const failures = new Map<string, string>();
    let highest = 0;
    let discarded = 0;
    for (let round = 0; round < rounds; round += 1) {
        for (const [w, workload] of workloads.entries()) {
            const shift = (round + w) % ENGINES.length;
            for (const engine of [...ENGINES.slice(shift), ...ENGINES.slice(0, shift)]) {
                const key = `${workload.name}\t${engine}`;
                if (engine === 'formulajs' && (workload.formulajs === undefined || workload.memory)) continue;
                if (failures.has(key)) continue;
                const [file, ...args] = command;
                const spawned = () =>
                    spawnSync(
                        file,
                        [...args, '--workload', workload.name, '--engine', engine, '--reps', String(REPS)],
                        {
                            encoding: 'utf8',
                            maxBuffer: 1 << 26,
                            timeout: 600_000,
                        },
                    );
                // A run the machine got busy during is discarded and taken again once it is quiet.
                waitForQuiet(limit);
                let child = spawned();
                for (let retry = 0; retry < RETRIES && os.loadavg()[0] >= limit; retry += 1) {
                    discarded += 1;
                    waitForQuiet(limit);
                    child = spawned();
                }
                highest = Math.max(highest, os.loadavg()[0]);
                const last = child.stdout.trim().split('\n').pop() ?? '';
                if (child.status !== 0 || !last.startsWith('{')) {
                    const why = child.error
                        ? 'timed out after 600 s'
                        : (child.stderr || last).trim().split('\n').slice(-2).join(' ');
                    failures.set(key, why.slice(0, 200));
                    continue;
                }
                const measured: Measured = JSON.parse(last);
                times.set(key, [...(times.get(key) ?? []), measured.ms]);
                if (!values.has(key)) values.set(key, measured.values);
                process.stderr.write(`${runtime} round ${round + 1}: ${key} ${measured.ms.toFixed(1)}\n`);
            }
        }
    }
    const rows = workloads.map((workload): SpeedRow => {
        const ours = values.get(`${workload.name}\tours`);
        const cell = (engine: EngineName): SpeedCell => {
            const key = `${workload.name}\t${engine}`;
            const failed = failures.get(key);
            if (failed !== undefined) return { status: 'failed', note: failed };
            const measured = [...(times.get(key) ?? [])].sort((a, b) => a - b);
            if (measured.length === 0) return { status: 'not supported' };
            const own = values.get(key) ?? [];
            const at = ours === undefined ? 0 : own.findIndex((value, i) => value !== ours[i]);
            const same = ours !== undefined && own.length === ours.length && at < 0;
            if (!same) return { status: 'wrong values', note: `cell ${at}: ${own[at]} where ours is ${ours?.[at]}` };
            return { status: 'measured', min: measured[0], median: median(measured) };
        };
        return {
            workload: workload.name,
            what: workload.what,
            memory: workload.memory === true,
            hyperformula: JSON.stringify(workload.hyperformula ?? {}),
            engines: { ours: cell('ours'), hyperformula: cell('hyperformula'), formulajs: cell('formulajs') },
        };
    });
    return {
        runtime,
        rounds,
        reps: REPS,
        load: { before, after: loadText(), highest, discarded },
        seconds: Math.round((Date.now() - started) / 1000),
        rows,
    };
}

// One engine's verdict on every row it is judged on, in child processes that are restarted after a row hangs.
async function verdictsOf(engine: EngineName, places: readonly number[]): Promise<Map<number, Verdict | 'hung'>> {
    const verdicts = new Map<number, Verdict | 'hung'>();
    let from = 0;
    while (from <= places[places.length - 1]) {
        const child = spawn(process.execPath, [
            path.join(HERE, 'correctness.ts'),
            '--engine',
            engine,
            '--from',
            String(from),
        ]);
        let buffered = '';
        let timer = setTimeout(() => child.kill(), SILENT_MS);
        child.stdout.on('data', (chunk: Buffer) => {
            clearTimeout(timer);
            timer = setTimeout(() => child.kill(), SILENT_MS);
            buffered += chunk.toString();
            const lines = buffered.split('\n');
            buffered = lines.pop() ?? '';
            for (const line of lines) {
                const [place, verdict] = line.split('\t');
                const known = VERDICTS.find((name) => name === verdict);
                if (known !== undefined) verdicts.set(Number(place), known);
            }
        });
        const code = await new Promise<number | null>((done) => child.on('close', done));
        clearTimeout(timer);
        const next = places.find((place) => !verdicts.has(place));
        if (next === undefined) break;
        if (code === 0) throw new Error(`${engine} stopped before row ${next}`);
        verdicts.set(next, 'hung');
        process.stderr.write(`${engine}: row ${next} did not answer in ${SILENT_MS / 1000} s\n`);
        from = next + 1;
    }
    return verdicts;
}

async function correctnessRun(): Promise<NonNullable<Results['correctness']>> {
    const { header, rows } = readData();
    const calls = singleCalls(rows).map((call) => call.place);
    const everyRow = rows.map((_, place) => place);
    const engines: Partial<Record<EngineName, EngineVerdicts>> = {};
    for (const engine of ENGINES) {
        const verdicts = await verdictsOf(engine, engine === 'formulajs' ? calls : everyRow);
        const zero = (): Record<Verdict, number> => ({ equal: 0, differs: 0, 'not supported': 0, crashed: 0 });
        const total = zero();
        const byFile: Record<string, Record<Verdict, number>> = {};
        const hung: string[] = [];
        for (const [place, verdict] of verdicts) {
            const counted = verdict === 'hung' ? 'crashed' : verdict;
            const file = rows[place][0];
            byFile[file] ??= zero();
            byFile[file][counted] += 1;
            total[counted] += 1;
            if (verdict === 'hung') hung.push(rows[place][2]);
        }
        engines[engine] = { total, byFile, hung };
        process.stderr.write(`${engine}: ${JSON.stringify(total)}\n`);
    }
    const { ours, hyperformula, formulajs } = engines;
    if (ours === undefined || hyperformula === undefined || formulajs === undefined)
        throw new Error('an engine is missing');
    return {
        source: header.source,
        rows: rows.length,
        unjudged: header.unjudged,
        formulajsRows: calls.length,
        engines: { ours, hyperformula, formulajs },
    };
}

function packageVersion(name: string): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules', name, 'package.json'), 'utf8'));
    return String(manifest.version);
}

if (import.meta.main) {
    const { values: options } = parseArgs({
        options: {
            only: { type: 'string', default: 'speed,correctness,coverage' },
            rounds: { type: 'string', default: '5' },
            runtimes: { type: 'string', default: 'bun,node' },
            filter: { type: 'string', default: '' },
            'max-load': { type: 'string', default: '6' },
            help: { type: 'boolean', default: false },
        },
    });
    if (options.help) {
        console.log(USAGE);
        process.exit(0);
    }
    const parts = new Set(options.only.split(','));
    const earlier: Partial<Results> = fs.existsSync(RESULTS_FILE)
        ? JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'))
        : {};
    const speed: Record<string, SpeedRun> = { ...earlier.speed };
    if (parts.has('speed')) {
        for (const runtime of options.runtimes.split(',')) {
            if (runtime !== 'bun' && runtime !== 'node') throw new Error(`No runtime ${runtime}`);
            speed[runtime] = speedRun(
                runtime,
                Number(options.rounds),
                new RegExp(options.filter),
                Number(options['max-load']),
            );
        }
    }
    const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim();
    const results: Results = {
        generated: new Date().toISOString().slice(0, 10),
        machine: {
            cpu: os.cpus()[0]?.model ?? 'unknown',
            cores: os.cpus().length,
            memoryGb: Math.round(os.totalmem() / 2 ** 30),
            os: `${os.type()} ${os.release()} ${os.arch()}`,
        },
        versions: {
            bun: process.versions.bun ?? '',
            node,
            hyperformula: packageVersion('hyperformula'),
            formulajs: packageVersion('@formulajs/formulajs'),
        },
        hyperformulaConfig: HYPERFORMULA_CONFIG,
        speed,
        correctness: parts.has('correctness') ? await correctnessRun() : earlier.correctness,
        coverage: parts.has('coverage') ? coverage() : earlier.coverage,
    };
    fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(results, null, 2)}\n`);
    spawnSync(process.execPath, ['x', '--bun', '@biomejs/biome', 'format', '--write', RESULTS_FILE], {
        stdio: 'inherit',
    });
    console.log(`wrote ${RESULTS_FILE}`);
}
