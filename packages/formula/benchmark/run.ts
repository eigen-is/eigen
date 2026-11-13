// The benchmark run: speed on Bun and on Node, correctness on every recorded row, and coverage, written to the
// results file the README is rendered from. Every timed run is a fresh child process of one engine and one workload,
// never two at once; the rounds interleave the engines, and a run starts on a quiet machine and is taken again when
// the machine got busy during it. A time counts only when the engine's values match ours. A correctness child that
// stops answering is killed, its row counted as crashed, and a new child goes on after it. A quick run does the same
// at reduced sizes and prints its tables instead of writing the published results.

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Verdict } from './correctness';
import { sampled, singleCalls, VERDICTS } from './correctness';
import type { Coverage } from './coverage';
import { coverage } from './coverage';
import { HYPERFORMULA_CONFIG } from './engines';
import { marks } from './readme';
import { readData } from './rows';
import type { EngineName, Measured, Workload } from './speed';
import { ENGINES, workloads } from './speed';

// A quick run's sizes and sample: a look in a few minutes, not the published numbers.
const QUICK = { scale: 10, rounds: 3, reps: 1, every: 100 } as const;

const USAGE = `bun run.ts [options], from packages/formula/benchmark after bun install there
  --quick             a look in a few minutes: sizes divided by ${QUICK.scale}, ${QUICK.rounds} rounds of ${QUICK.reps} run each
                      (so no warm-up run), Bun only, every ${QUICK.every}th correctness row; prints its tables and
                      never touches results.json or the README
  --only <parts>      speed, correctness, coverage, comma-separated (default all); the others keep their results
  --rounds <n>        rounds per speed row, each a fresh process per engine (default 5)
  --runtimes <list>   bun, node (default both)
  --filter <regex>    only the speed workloads whose name matches
  --max-load <n>      wait before each round until the 1-minute load is below this (default 6)`;

const HERE = import.meta.dir;
const RESULTS_FILE = path.join(HERE, 'results.json');
const QUICK_FILE = path.join(os.tmpdir(), 'formula-benchmark-quick.json');
// A child that prints nothing for this long is taken to hang.
const SILENT_MS = 20_000;
const WAIT_MS = 30 * 60_000;
const RETRIES = 5;
// An engine whose one run takes longer than this is timed again at a tenth of the size, in a row of its own.
const TOO_SLOW_MS = 120_000;
const CHILD_MS = 600_000;

export type SpeedCell = {
    readonly status: 'measured' | 'not supported' | 'wrong values' | 'failed' | 'too slow' | 'not run';
    readonly min?: number;
    readonly median?: number;
    // The median time spent in the load or the edit itself, before the engine's recalc call.
    readonly step?: number;
    readonly note?: string;
};
export type SpeedRow = {
    readonly workload: string;
    readonly what: string;
    readonly memory: boolean;
    readonly hyperformula: string;
    // Set on a row at a tenth of the size, for the engines that were too slow at the full size.
    readonly smallerFor?: readonly EngineName[];
    readonly engines: Readonly<Record<EngineName, SpeedCell>>;
};
export type SpeedRun = {
    readonly runtime: string;
    readonly scale: number;
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
    readonly quick: boolean;
    // The wall time of the whole run, every part included.
    readonly seconds: number;
    readonly machine: { readonly cpu: string; readonly cores: number; readonly memoryGb: number; readonly os: string };
    readonly versions: Readonly<Record<string, string>>;
    readonly hyperformulaConfig: unknown;
    readonly speed: Readonly<Record<string, SpeedRun>>;
    readonly correctness?: {
        readonly source: string;
        readonly rows: number;
        // Every row is judged when this is 1; a quick run judges every n-th.
        readonly every: number;
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

// The bundle goes into a folder of its own with IronCalc's WebAssembly file beside it, where the bundle looks for it.
function nodeBundle(): string {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'formula-benchmark-'));
    const built = spawnSync(
        process.execPath,
        ['build', '--target', 'node', path.join(HERE, 'speed.ts'), '--outdir', out, '--entry-naming', '[name].mjs'],
        { encoding: 'utf8' },
    );
    if (built.status !== 0) throw new Error(`bun build failed: ${built.stderr}`);
    return path.join(out, 'speed.mjs');
}

type Options = {
    readonly rounds: number;
    readonly reps: number;
    readonly filter: RegExp;
    readonly limit: number;
    readonly scale: number;
};

function speedRun(runtime: 'bun' | 'node', { rounds, reps, filter, limit, scale }: Options): SpeedRun {
    const started = Date.now();
    const before = loadText();
    const command =
        runtime === 'bun' ? [process.execPath, path.join(HERE, 'speed.ts')] : ['node', '--expose-gc', nodeBundle()];
    let highest = 0;
    let discarded = 0;
    // Every round times each workload on each engine in a fresh child, the engines in a changing order.
    const timeRows = (chosen: readonly Workload[], engines: readonly EngineName[], size: number): SpeedRow[] => {
        const times = new Map<string, Measured[]>();
        const values = new Map<string, readonly string[]>();
        const failures = new Map<string, string>();
        const slow = new Map<string, string>();
        for (let round = 0; round < rounds; round += 1) {
            for (const [w, workload] of chosen.entries()) {
                const shift = (round + w) % engines.length;
                for (const engine of [...engines.slice(shift), ...engines.slice(0, shift)]) {
                    const key = `${workload.name}\t${engine}`;
                    if (engine === 'formulajs' && (workload.formulajs === undefined || workload.memory)) continue;
                    if (failures.has(key) || slow.has(key)) continue;
                    const [file, ...args] = command;
                    const spawned = () =>
                        spawnSync(
                            file,
                            [
                                ...args,
                                '--workload',
                                workload.name,
                                '--engine',
                                engine,
                                '--reps',
                                String(reps),
                                '--scale',
                                String(size),
                            ],
                            { encoding: 'utf8', maxBuffer: 1 << 26, timeout: CHILD_MS },
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
                    if (child.error) {
                        slow.set(key, `one run took over ${CHILD_MS / 1000} s`);
                        continue;
                    }
                    if (child.status !== 0 || !last.startsWith('{')) {
                        failures.set(key, (child.stderr || last).trim().split('\n').slice(-2).join(' ').slice(0, 200));
                        continue;
                    }
                    const measured: Measured = JSON.parse(last);
                    process.stderr.write(`${runtime} round ${round + 1}: ${key} ${measured.ms.toFixed(1)}\n`);
                    if (measured.ms > TOO_SLOW_MS && !workload.memory) {
                        slow.set(key, `one run took ${Math.round(measured.ms / 1000)} s`);
                        continue;
                    }
                    times.set(key, [...(times.get(key) ?? []), measured]);
                    if (!values.has(key)) values.set(key, measured.values);
                }
            }
        }
        return chosen.map((workload): SpeedRow => {
            const ours = values.get(`${workload.name}\tours`);
            const cell = (engine: EngineName): SpeedCell => {
                const key = `${workload.name}\t${engine}`;
                if (!engines.includes(engine)) return { status: 'not run' };
                const failed = failures.get(key);
                if (failed !== undefined) return { status: 'failed', note: failed };
                const tooSlow = slow.get(key);
                if (tooSlow !== undefined) return { status: 'too slow', note: tooSlow };
                const runs = times.get(key) ?? [];
                const measured = runs.map((run) => run.ms).sort((a, b) => a - b);
                if (measured.length === 0) return { status: 'not supported' };
                const own = values.get(key) ?? [];
                const at = ours === undefined ? 0 : own.findIndex((value, i) => value !== ours[i]);
                const same = ours !== undefined && own.length === ours.length && at < 0;
                if (!same)
                    return { status: 'wrong values', note: `cell ${at}: ${own[at]} where ours is ${ours?.[at]}` };
                const steps = runs.map((run) => run.step).sort((a, b) => a - b);
                return { status: 'measured', min: measured[0], median: median(measured), step: median(steps) };
            };
            return {
                workload: workload.name,
                what: workload.what,
                memory: workload.memory === true,
                hyperformula: JSON.stringify(workload.hyperformula ?? {}),
                engines: {
                    ours: cell('ours'),
                    hyperformula: cell('hyperformula'),
                    formulajs: cell('formulajs'),
                    ironcalc: cell('ironcalc'),
                    univer: cell('univer'),
                },
            };
        });
    };
    const all = workloads(scale);
    const smaller = workloads(scale * 10);
    const places = all.flatMap((workload, place) => (filter.test(workload.name) ? [place] : []));
    const rows = timeRows(
        places.map((place) => all[place]),
        ENGINES,
        scale,
    );
    const again = rows.flatMap((row, i): SpeedRow[] => {
        const slow = ENGINES.filter((engine) => row.engines[engine].status === 'too slow');
        if (slow.length === 0) return [];
        return timeRows([smaller[places[i]]], ['ours', ...slow], scale * 10).map((found) => ({
            ...found,
            smallerFor: slow,
        }));
    });
    return {
        runtime,
        scale,
        rounds,
        reps,
        load: { before, after: loadText(), highest, discarded },
        seconds: Math.round((Date.now() - started) / 1000),
        rows: [...rows, ...again],
    };
}

// One engine's verdict on every row it is judged on, in child processes that are restarted after a row hangs.
async function verdictsOf(
    engine: EngineName,
    places: readonly number[],
    every: number,
): Promise<Map<number, Verdict | 'hung'>> {
    const verdicts = new Map<number, Verdict | 'hung'>();
    let from = 0;
    while (from <= places[places.length - 1]) {
        const child = spawn(process.execPath, [
            path.join(HERE, 'correctness.ts'),
            '--engine',
            engine,
            '--from',
            String(from),
            '--every',
            String(every),
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

async function correctnessRun(every: number): Promise<NonNullable<Results['correctness']>> {
    const { header, rows } = readData();
    const calls = singleCalls(rows)
        .map((call) => call.place)
        .filter((place) => sampled(place, every));
    const everyRow = rows.map((_, place) => place).filter((place) => sampled(place, every));
    const engines: Partial<Record<EngineName, EngineVerdicts>> = {};
    for (const engine of ENGINES) {
        const verdicts = await verdictsOf(engine, engine === 'formulajs' ? calls : everyRow, every);
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
    const { ours, hyperformula, formulajs, ironcalc, univer } = engines;
    if (
        ours === undefined ||
        hyperformula === undefined ||
        formulajs === undefined ||
        ironcalc === undefined ||
        univer === undefined
    )
        throw new Error('an engine is missing');
    return {
        source: header.source,
        rows: everyRow.length,
        every,
        unjudged: header.unjudged,
        formulajsRows: calls.length,
        engines: { ours, hyperformula, formulajs, ironcalc, univer },
    };
}

function packageVersion(name: string): string {
    const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules', name, 'package.json'), 'utf8'));
    return String(manifest.version);
}

if (import.meta.main) {
    const { values: options } = parseArgs({
        options: {
            quick: { type: 'boolean', default: false },
            only: { type: 'string', default: 'speed,correctness,coverage' },
            rounds: { type: 'string' },
            runtimes: { type: 'string' },
            filter: { type: 'string', default: '' },
            'max-load': { type: 'string', default: '6' },
            help: { type: 'boolean', default: false },
        },
    });
    if (options.help) {
        console.log(USAGE);
        process.exit(0);
    }
    const { quick } = options;
    const file = quick ? QUICK_FILE : RESULTS_FILE;
    const parts = new Set(options.only.split(','));
    // A full run keeps the parts it does not measure again; a quick run starts afresh.
    const earlier: Partial<Results> = !quick && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const speed: Record<string, SpeedRun> = { ...earlier.speed };
    const run: Options = {
        rounds: Number(options.rounds ?? (quick ? QUICK.rounds : 5)),
        reps: quick ? QUICK.reps : 3,
        filter: new RegExp(options.filter),
        limit: Number(options['max-load']),
        scale: quick ? QUICK.scale : 1,
    };
    const started = Date.now();
    if (parts.has('speed')) {
        for (const runtime of (options.runtimes ?? (quick ? 'bun' : 'bun,node')).split(',')) {
            if (runtime !== 'bun' && runtime !== 'node') throw new Error(`No runtime ${runtime}`);
            speed[runtime] = speedRun(runtime, run);
        }
    }
    const node = spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim();
    const results: Results = {
        generated: new Date().toISOString().slice(0, 10),
        quick,
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
            ironcalc: packageVersion('@ironcalc/wasm'),
            univer: packageVersion('@univerjs/core'),
        },
        hyperformulaConfig: HYPERFORMULA_CONFIG,
        speed,
        correctness: parts.has('correctness') ? await correctnessRun(quick ? QUICK.every : 1) : earlier.correctness,
        coverage: parts.has('coverage') ? await coverage() : earlier.coverage,
        seconds: Math.round((Date.now() - started) / 1000),
    };
    fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    if (quick) {
        const shown = marks(results);
        console.log(
            [
                `QUICK NUMBERS at reduced sizes, not the published ones: every count divided by ${QUICK.scale} (100,000 rows become ${(100_000 / QUICK.scale).toLocaleString('en')}), ${run.rounds} rounds of ${run.reps} run each with no warm-up run, every ${QUICK.every}th correctness row.`,
                'Ratios at a tenth of the size can differ from the full ones, since index and setup costs do not scale linearly.',
                ...Object.keys(speed).flatMap((runtime) => [
                    '',
                    shown[`setup-${runtime}`],
                    '',
                    shown[`speed-${runtime}`],
                    '',
                    shown[`steps-${runtime}`],
                ]),
                '',
                shown['correctness-totals'],
                '',
                shown['coverage-functions'],
                '',
                `Took ${results.seconds} seconds. The results are in ${file}.`,
            ].join('\n'),
        );
    } else {
        spawnSync(process.execPath, ['x', '--bun', '@biomejs/biome', 'format', '--write', file], { stdio: 'inherit' });
        console.log(`wrote ${file}`);
    }
}
