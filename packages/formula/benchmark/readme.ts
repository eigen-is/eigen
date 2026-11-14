// Renders the benchmark's README from the results file and the notes beside it, so every number in the README
// comes from a run and none is typed by hand. The notes hold the prose with {{name}} marks; each mark becomes a
// table or a sentence built here from the results. A mark the notes use and this file lacks stops the render. A
// quick run prints some of the same marks to the terminal.

import * as fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from './correctness';
import { VERDICTS } from './correctness';
import type { Partner } from './coverage';
import type { EngineVerdicts, Results, SpeedCell, SpeedRow, SpeedRun } from './run';
import type { EngineName } from './speed';
import { ENGINES, LONG_RUN } from './speed';

const HERE = import.meta.dir;
// Our engine's display name; in a table cell its bar is escaped.
const OURS = 'eigen|formula⟩';
const LABELS: Readonly<Record<EngineName, string>> = {
    ours: OURS,
    hyperformula: 'HyperFormula',
    ironcalc: 'IronCalc',
    univer: 'Univer',
};
const PARTNERS: readonly Partner[] = ['hyperformula', 'ironcalc', 'univer'];
const FAMILIES: Readonly<Record<string, string>> = {
    math: 'math',
    statistical: 'statistical',
    date: 'date and time',
    logical: 'logical and information',
    reference: 'lookup and reference',
    text: 'text',
};
const RUNTIMES: Readonly<Record<string, string>> = { bun: 'Bun', node: 'Node' };

function cell(text: string): string {
    return text.replaceAll('|', '\\|');
}

function number(value: number): string {
    return value.toLocaleString('en');
}

function time(ms: number): string {
    if (ms < 10) return ms.toFixed(2);
    if (ms < 1000) return ms.toFixed(1);
    return number(Math.round(ms));
}

// How many times our median another engine's median is: above 1, ours took less time or memory.
function ratio(theirs: number, ours: number): string {
    const times = theirs / ours;
    return `${times >= 10 ? number(Math.round(times)) : times.toFixed(times >= 1 ? 1 : 2)}×`;
}

function and(items: readonly string[]): string {
    return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function percent(part: number, whole: number): string {
    return `${((100 * part) / whole).toFixed(1)}%`;
}

// A row an engine was too slow for comes again at a tenth of the size, for that engine and ours only.
function label(row: SpeedRow): string {
    if (row.smallerFor === undefined) return row.workload;
    return `${row.workload}, a tenth of the size for ${and(row.smallerFor.map((engine) => LABELS[engine]))}`;
}

function shownCell(found: SpeedCell, memory: boolean): string {
    if (found.status === 'not supported') return 'not supported';
    if (found.status === 'not run') return 'not run at this size';
    if (found.status === 'too slow') return `too slow: ${found.note}; see the row at a tenth of the size`;
    if (found.status !== 'measured' || found.min === undefined || found.median === undefined)
        return `${found.status}${found.note ? `: ${cell(found.note)}` : ''}`;
    const rounds = found.rounds === undefined ? '' : ` (${found.rounds} rounds)`;
    return `${memory ? `${found.median.toFixed(1)} MB` : `${time(found.min)} / ${time(found.median)}`}${rounds}`;
}

function ratioCell(row: SpeedRow, engine: EngineName): string {
    const ours = row.engines.ours.median;
    const theirs = row.engines[engine].median;
    return ours === undefined || theirs === undefined ? '' : ratio(theirs, ours);
}

function speedTable(run: SpeedRun): string {
    const lines = [
        `| workload | ${cell(OURS)} | ${PARTNERS.map((engine) => `${LABELS[engine]} | ratio`).join(' | ')} |`,
        `|---|---|${PARTNERS.map(() => '---|---|').join('')}`,
    ];
    for (const row of run.rows) {
        const shown = (engine: EngineName) => shownCell(row.engines[engine], row.memory);
        const theirs = PARTNERS.map((engine) => `${shown(engine)} | ${ratioCell(row, engine)}`);
        lines.push(`| ${label(row)} | ${shown('ours')} | ${theirs.join(' | ')} |`);
    }
    return lines.join('\n');
}

// The key under the speed chart, which draws the Bun run: a label per full-size workload, as the chart names its
// bars, and every engine's ratio. run.ts appends the rows at a tenth of the size in the order of the rows they repeat.
function chartKey(run: SpeedRun): { readonly table: string; readonly gaps: string } {
    const full = run.rows.filter((row) => row.smallerFor === undefined);
    const smaller = run.rows.filter((row) => row.smallerFor !== undefined);
    const repeated = full.filter((row) => PARTNERS.some((engine) => row.engines[engine].status === 'too slow'));
    const gaps = new Map<Partner, string[]>();
    const lines = full.map((row, i) => {
        const cells = PARTNERS.map((engine) => {
            const found = row.engines[engine];
            if (found.status === 'measured') return ratioCell(row, engine);
            if (found.status !== 'too slow') return found.status;
            gaps.set(engine, [...(gaps.get(engine) ?? []), `T${i + 1}`]);
            const again = smaller[repeated.indexOf(row)];
            return `${ratioCell(again, engine)} at 1/10 size`;
        });
        return `| T${i + 1} | ${row.workload} | ${ratio(1, 1)} | ${cells.join(' | ')} |`;
    });
    const table = [
        `| | workload | ${cell(OURS)} | ${PARTNERS.map((engine) => LABELS[engine]).join(' | ')} |`,
        `|---|---|---:|${PARTNERS.map(() => '---:|').join('')}`,
        ...lines,
    ].join('\n');
    const missing = [...gaps].map(
        ([engine, labels]) =>
            `${LABELS[engine]} has no bar at ${and(labels)}: one of its runs took more than two minutes at the full size, so it ran again at a tenth of the size, and the key gives its ratio there.`,
    );
    return { table, gaps: missing.join(' ') };
}

// Per engine, the median time in the load or the edit itself out of the median time of the whole run.
function stepTable(run: SpeedRun): string {
    const lines = [
        `| workload | ${ENGINES.map((engine) => cell(LABELS[engine])).join(' | ')} |`,
        `|---|${ENGINES.map(() => '---').join('|')}|`,
    ];
    for (const row of run.rows) {
        if (row.memory) continue;
        const shown = (engine: EngineName) => {
            const { status, step, median } = row.engines[engine];
            return step === undefined || median === undefined ? status : `${time(step)} of ${time(median)}`;
        };
        lines.push(`| ${label(row)} | ${ENGINES.map(shown).join(' | ')} |`);
    }
    return lines.join('\n');
}

function speedSetup(run: SpeedRun, results: Results): string {
    const version = results.versions[run.runtime];
    const size = run.scale === 1 ? '' : ` Every count is divided by ${run.scale}.`;
    return `${RUNTIMES[run.runtime]} ${version}:${size} ${run.rounds} rounds, ${run.reps === 1 ? 'one run' : `at most ${run.reps} runs`} in each process. The load averages over 1, 5 and 15 minutes were ${run.load.before} when the run started, before it waited for a quiet machine, and ${run.load.after} at its end; the highest 1-minute load seen after a kept run was ${run.load.highest.toFixed(2)}, and ${run.load.discarded} runs were taken again because the machine got busy during them. The run took ${number(run.seconds)} seconds.`;
}

// The workloads where another engine's median is below ours, on one runtime.
function losses(run: SpeedRun, engine: EngineName): SpeedRow[] {
    return run.rows.filter((row) => {
        const ours = row.engines.ours.median;
        const theirs = row.engines[engine].median;
        return ours !== undefined && theirs !== undefined && theirs <= ours;
    });
}

function compared(
    run: SpeedRun,
    engine: EngineName,
): { readonly count: number; readonly low: string; readonly high: string } {
    const ratios = run.rows.flatMap((row) => {
        const ours = row.engines.ours.median;
        const theirs = row.engines[engine].median;
        return ours === undefined || theirs === undefined ? [] : [theirs / ours];
    });
    const sorted = ratios.sort((a, b) => a - b);
    const shown = (value: number | undefined) => (value === undefined ? '' : ratio(value, 1));
    return { count: sorted.length, low: shown(sorted[0]), high: shown(sorted[sorted.length - 1]) };
}

function speedSummary(run: SpeedRun): string {
    const parts = PARTNERS.map((engine) => {
        const { count, low, high } = compared(run, engine);
        const lost = losses(run, engine);
        const faster = `${OURS} was faster than ${LABELS[engine]} in ${count - lost.length} of the ${count} workloads both ran, where ${LABELS[engine]} took from ${low} to ${high} of our time`;
        return lost.length === 0
            ? faster
            : `${faster}; ${LABELS[engine]} was as fast or faster in: ${lost.map(label).join('; ')}`;
    });
    return `Speed on ${RUNTIMES[run.runtime]}: ${parts.join('. ')}.`;
}

// Where the numbers come from: one run, or a run that kept some engines' figures from earlier runs.
function runDates(results: Results): string {
    const kept = new Map<string, string[]>();
    for (const engine of PARTNERS) {
        const date = results.keptFrom?.[engine];
        if (date !== undefined) kept.set(date, [...(kept.get(date) ?? []), LABELS[engine]]);
    }
    if (kept.size === 0) return `The numbers below come from one run on ${results.generated}.`;
    const from = [...kept].map(([date, names]) => `those of ${and(names)} from the run on ${date}`);
    return `The numbers below come from a run on ${results.generated}, apart from the speed and correctness figures it kept from earlier runs: ${and(from)}.`;
}

function lossList(results: Results): string {
    const lines: string[] = [];
    for (const run of Object.values(results.speed)) {
        for (const engine of PARTNERS) {
            for (const row of losses(run, engine))
                lines.push(
                    `- ${RUNTIMES[run.runtime]}, ${label(row)}: ${LABELS[engine]} took ${ratioCell(row, engine)} of our time.`,
                );
        }
    }
    return lines.length === 0 ? `- None: ${OURS} was faster in every workload that ran in both.` : lines.join('\n');
}

function totals(verdicts: EngineVerdicts): string {
    const all = VERDICTS.reduce((sum, verdict) => sum + verdicts.total[verdict], 0);
    return VERDICTS.map(
        (verdict) => `${number(verdicts.total[verdict])} (${percent(verdicts.total[verdict], all)})`,
    ).join(' | ');
}

function correctness(results: Results): Readonly<Record<string, string>> {
    const found = results.correctness;
    if (found === undefined) throw new Error('No correctness results: run bun run.ts --only correctness');
    const { engines } = found;
    const header = `| engine | rows judged | ${VERDICTS.join(' | ')} | equal where it answered |\n|---|---|---|---|---|---|---|`;
    const total = ENGINES.map((engine) => {
        const { equal, differs } = engines[engine].total;
        const all = VERDICTS.reduce((sum, verdict) => sum + engines[engine].total[verdict], 0);
        return `| ${cell(LABELS[engine])} | ${number(all)} | ${totals(engines[engine])} | ${percent(equal, equal + differs)} |`;
    });
    const files = Object.keys(engines.ours.byFile);
    const families = [...new Set(files.map((file) => FAMILIES[file] ?? 'mixed checks'))];
    const equalIn = (engine: EngineName, family: string) => {
        let equal = 0;
        let all = 0;
        for (const [file, counts] of Object.entries(engines[engine].byFile)) {
            if ((FAMILIES[file] ?? 'mixed checks') !== family) continue;
            equal += counts.equal;
            all += VERDICTS.reduce((sum, verdict: Verdict) => sum + counts[verdict], 0);
        }
        return all === 0 ? 'not judged' : `${percent(equal, all)} of ${number(all)}`;
    };
    const byFamily = [
        `| family | ${ENGINES.map((engine) => cell(LABELS[engine])).join(' | ')} |`,
        `|---|${ENGINES.map(() => '---').join('|')}|`,
        ...families.map((family) => `| ${family} | ${ENGINES.map((engine) => equalIn(engine, family)).join(' | ')} |`),
    ].join('\n');
    const hung = ENGINES.flatMap((engine) =>
        engines[engine].hung.map((formula) => `- ${LABELS[engine]}: \`${formula}\``),
    );
    const equal = (engine: EngineName) => engines[engine].total.equal;
    const judged = (engine: EngineName) => VERDICTS.reduce((sum, verdict) => sum + engines[engine].total[verdict], 0);
    return {
        'correctness-rows': number(found.rows),
        'correctness-unjudged': number(found.unjudged),
        'correctness-totals': `${header}\n${total.join('\n')}`,
        'correctness-families': byFamily,
        hung: hung.length === 0 ? '- None.' : hung.join('\n'),
        'summary-correctness': `Correctness: of ${number(found.rows)} answers recorded in Excel, ${OURS} gave Excel's answer on ${percent(equal('ours'), judged('ours'))}, HyperFormula on ${percent(equal('hyperformula'), judged('hyperformula'))}, IronCalc on ${percent(equal('ironcalc'), judged('ironcalc'))} and Univer on ${percent(equal('univer'), judged('univer'))}.`,
    };
}

function coverage(results: Results): Readonly<Record<string, string>> {
    const found = results.coverage;
    if (found === undefined) throw new Error('No coverage results: run bun run.ts --only coverage');
    const { functions } = found;
    const rows = ENGINES.map((engine) => {
        const { excel, other } = functions[engine];
        return `| ${cell(LABELS[engine])} | ${excel} | ${percent(excel, found.excel)} | ${other ?? 'not known'} |`;
    });
    const gaps = PARTNERS.map((engine) => {
        const mine = found.onlyOurs[engine];
        const listed =
            mine.length <= 12 ? `${mine.length}: ${mine.map((name) => `\`${name}\``).join(', ')}` : String(mine.length);
        return `| ${LABELS[engine]} | ${found.onlyTheirs[engine].length} | ${mine.length === 0 ? '0' : listed} |`;
    });
    const yes = (passes: boolean) => (passes ? 'yes' : 'no');
    const features = found.features.map(
        (feature) =>
            `| ${feature.name} | \`${cell(feature.probe)}\` | ${ENGINES.map((engine) => `${yes(feature.passes[engine])} (${cell(feature.answers[engine])})`).join(' | ')} |`,
    );
    return {
        'excel-functions': String(found.excel),
        'coverage-functions': [
            "| engine | Excel's functions it has | share | other names it registers |",
            '|---|---|---|---|',
            ...rows,
        ].join('\n'),
        'coverage-gaps': [
            `| engine | Excel's functions it has and ${cell(OURS)} lacks | Excel's functions ${cell(OURS)} has and it lacks |`,
            '|---|---|---|',
            ...gaps,
        ].join('\n'),
        'coverage-features': [
            `| feature | probe | ${ENGINES.map((engine) => cell(LABELS[engine])).join(' | ')} |`,
            `|---|---|${ENGINES.map(() => '---').join('|')}|`,
            ...features,
        ].join('\n'),
        'summary-coverage': `Coverage: of Excel's ${found.excel} functions, ${OURS} has ${functions.ours.excel}, HyperFormula ${functions.hyperformula.excel}, IronCalc ${functions.ironcalc.excel} and Univer ${functions.univer.excel}.`,
    };
}

export function marks(results: Results): Record<string, string> {
    const speed: Record<string, string> = {};
    const first = Object.values(results.speed)[0];
    for (const [runtime, run] of Object.entries(results.speed)) {
        speed[`speed-${runtime}`] = speedTable(run);
        speed[`steps-${runtime}`] = stepTable(run);
        speed[`setup-${runtime}`] = speedSetup(run, results);
        speed[`summary-speed-${runtime}`] = speedSummary(run);
    }
    const bun = results.speed.bun;
    if (bun !== undefined) {
        const { table, gaps } = chartKey(bun);
        speed['chart-key'] = table;
        speed['chart-gaps'] = gaps;
    }
    const { machine, versions } = results;
    return {
        ...speed,
        ...correctness(results),
        ...coverage(results),
        ours: OURS,
        'run-dates': runDates(results),
        'long-seconds': String(LONG_RUN.ms / 1000),
        'long-rounds': String(LONG_RUN.rounds),
        machine: `${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.os}`,
        versions: `Bun ${versions.bun}, Node ${versions.node.replace(/^v/, '')}, HyperFormula ${versions.hyperformula}, IronCalc ${versions.ironcalc}, Univer ${versions.univer}`,
        workloads: (first?.rows ?? [])
            .filter((row) => row.smallerFor === undefined)
            .map((row) => `- **${row.workload}.** ${row.what}`)
            .join('\n'),
        'lookup-config': JSON.stringify(
            Object.fromEntries(
                (first?.rows ?? [])
                    .filter((row) => row.hyperformula !== '{}' && row.smallerFor === undefined)
                    .map((row) => [row.workload, JSON.parse(row.hyperformula)]),
            ),
        ),
        losses: lossList(results),
        'hyperformula-config': JSON.stringify(results.hyperformulaConfig, null, 2),
    };
}

if (import.meta.main) {
    const results: Results = JSON.parse(fs.readFileSync(path.join(HERE, 'results.json'), 'utf8'));
    const notes = fs.readFileSync(path.join(HERE, 'notes.md'), 'utf8');
    const values = marks(results);
    const readme = notes.replace(/\{\{([a-z-]+)\}\}/g, (_, name: string) => {
        const value = values[name];
        if (value === undefined) throw new Error(`The notes use {{${name}}}, which the results do not give`);
        return value;
    });
    fs.writeFileSync(path.join(HERE, 'README.md'), readme);
    console.log(`wrote ${path.join(HERE, 'README.md')}`);
}
