// Renders the benchmark's README from the results file and the notes beside it, so every number in the README
// comes from a run and none is typed by hand. The notes hold the prose with {{name}} marks; each mark becomes a
// table or a sentence built here from the results. A mark the notes use and this file lacks stops the render.

import * as fs from 'node:fs';
import path from 'node:path';
import type { Verdict } from './correctness';
import { VERDICTS } from './correctness';
import type { EngineVerdicts, Results, SpeedCell, SpeedRow, SpeedRun } from './run';
import type { EngineName } from './speed';

const HERE = import.meta.dir;
// Our engine's display name; in a table cell its bar is escaped.
const OURS = 'eigen|formula⟩';
const LABELS: Readonly<Record<EngineName, string>> = {
    ours: OURS,
    hyperformula: 'HyperFormula',
    formulajs: 'formulajs',
};
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

function percent(part: number, whole: number): string {
    return `${((100 * part) / whole).toFixed(1)}%`;
}

function shownCell(found: SpeedCell, memory: boolean): string {
    if (found.status === 'not supported') return 'not supported';
    if (found.status !== 'measured' || found.min === undefined || found.median === undefined)
        return `${found.status}${found.note ? `: ${cell(found.note)}` : ''}`;
    return memory ? `${found.median.toFixed(1)} MB` : `${time(found.min)} / ${time(found.median)}`;
}

function ratioCell(row: SpeedRow, engine: EngineName): string {
    const ours = row.engines.ours.median;
    const theirs = row.engines[engine].median;
    return ours === undefined || theirs === undefined ? '' : ratio(theirs, ours);
}

function speedTable(run: SpeedRun): string {
    const lines = [
        `| workload | ${cell(OURS)} | HyperFormula | HyperFormula ÷ ${cell(OURS)} | formulajs | formulajs ÷ ${cell(OURS)} |`,
        '|---|---|---|---|---|---|',
    ];
    for (const row of run.rows) {
        const shown = (engine: EngineName) => shownCell(row.engines[engine], row.memory);
        lines.push(
            `| ${row.workload} | ${shown('ours')} | ${shown('hyperformula')} | ${ratioCell(row, 'hyperformula')} | ${shown('formulajs')} | ${ratioCell(row, 'formulajs')} |`,
        );
    }
    return lines.join('\n');
}

function speedSetup(run: SpeedRun, results: Results): string {
    const version = results.versions[run.runtime];
    return `${RUNTIMES[run.runtime]} ${version}: ${run.rounds} rounds, at most ${run.reps} runs in each process. The load averages over 1, 5 and 15 minutes were ${run.load.before} when the run started, before it waited for a quiet machine, and ${run.load.after} at its end; the highest 1-minute load seen after a kept run was ${run.load.highest.toFixed(2)}, and ${run.load.discarded} runs were taken again because the machine got busy during them. The run took ${number(run.seconds)} seconds.`;
}

// The workloads where another engine's median is below ours, by name, on one runtime.
function losses(run: SpeedRun, engine: EngineName): string[] {
    return run.rows
        .filter((row) => {
            const ours = row.engines.ours.median;
            const theirs = row.engines[engine].median;
            return ours !== undefined && theirs !== undefined && theirs <= ours;
        })
        .map((row) => row.workload);
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
    const parts = (['hyperformula', 'formulajs'] as const).map((engine) => {
        const { count, low, high } = compared(run, engine);
        const lost = losses(run, engine);
        const faster = `${OURS} was faster than ${LABELS[engine]} in ${count - lost.length} of the ${count} workloads both ran, where ${LABELS[engine]} took from ${low} to ${high} of our time`;
        return lost.length === 0 ? faster : `${faster}; ${LABELS[engine]} was as fast or faster in: ${lost.join('; ')}`;
    });
    return `Speed on ${RUNTIMES[run.runtime]}: ${parts.join('. ')}.`;
}

function lossList(results: Results): string {
    const lines: string[] = [];
    for (const run of Object.values(results.speed)) {
        for (const engine of ['hyperformula', 'formulajs'] as const) {
            for (const name of losses(run, engine)) {
                const row = run.rows.find((candidate) => candidate.workload === name);
                if (row === undefined) continue;
                lines.push(
                    `- ${RUNTIMES[run.runtime]}, ${name}: ${LABELS[engine]} took ${ratioCell(row, engine)} of our time.`,
                );
            }
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
    const total = (['ours', 'hyperformula', 'formulajs'] as const).map((engine) => {
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
        return all === 0 ? 'not judged' : `${number(equal)} of ${number(all)} (${percent(equal, all)})`;
    };
    const byFamily = [
        `| family | ${cell(OURS)} equal | HyperFormula equal | formulajs equal |`,
        '|---|---|---|---|',
        ...families.map(
            (family) =>
                `| ${family} | ${equalIn('ours', family)} | ${equalIn('hyperformula', family)} | ${equalIn('formulajs', family)} |`,
        ),
    ].join('\n');
    const hung = (['ours', 'hyperformula', 'formulajs'] as const).flatMap((engine) =>
        engines[engine].hung.map((formula) => `- ${LABELS[engine]}: \`${formula}\``),
    );
    const equal = (engine: EngineName) => engines[engine].total.equal;
    const judged = (engine: EngineName) => VERDICTS.reduce((sum, verdict) => sum + engines[engine].total[verdict], 0);
    return {
        'correctness-rows': number(found.rows),
        'correctness-unjudged': number(found.unjudged),
        'correctness-totals': `${header}\n${total.join('\n')}`,
        'correctness-families': byFamily,
        'formulajs-rows': number(found.formulajsRows),
        'formulajs-share': percent(found.formulajsRows, found.rows),
        hung: hung.length === 0 ? '- None.' : hung.join('\n'),
        'summary-correctness': `Correctness: of ${number(found.rows)} answers recorded in Excel, ${OURS} gave Excel's answer on ${percent(equal('ours'), judged('ours'))} and HyperFormula on ${percent(equal('hyperformula'), judged('hyperformula'))}; formulajs, judged only on the ${number(found.formulajsRows)} rows that are one function call, on ${percent(equal('formulajs'), judged('formulajs'))} of those.`,
    };
}

function coverage(results: Results): Readonly<Record<string, string>> {
    const found = results.coverage;
    if (found === undefined) throw new Error('No coverage results: run bun run.ts --only coverage');
    const { functions } = found;
    const rows = (['ours', 'hyperformula', 'formulajs'] as const).map(
        (engine) =>
            `| ${cell(LABELS[engine])} | ${functions[engine].excel} | ${percent(functions[engine].excel, found.excel)} | ${functions[engine].other} |`,
    );
    const yes = (passes: boolean) => (passes ? 'yes' : 'no');
    const features = found.features.map(
        (feature) =>
            `| ${feature.name} | \`${cell(feature.probe)}\` | ${yes(feature.passes.ours)} (${cell(feature.answers.ours)}) | ${yes(feature.passes.hyperformula)} (${cell(feature.answers.hyperformula)}) | no |`,
    );
    return {
        'excel-functions': String(found.excel),
        'coverage-functions': [
            "| engine | Excel's functions it has | share | other names it registers |",
            '|---|---|---|---|',
            ...rows,
        ].join('\n'),
        'coverage-features': [
            `| feature | probe | ${cell(OURS)} | HyperFormula | formulajs |`,
            '|---|---|---|---|---|',
            ...features,
        ].join('\n'),
        'only-hyperformula': String(found.onlyHyperformula.length),
        'only-ours': found.onlyOurs.map((name) => `\`${name}\``).join(', '),
        'summary-coverage': `Coverage: of Excel's ${found.excel} functions, ${OURS} has ${functions.ours.excel}, HyperFormula ${functions.hyperformula.excel} and formulajs ${functions.formulajs.excel}.`,
    };
}

function marks(results: Results): Record<string, string> {
    const speed: Record<string, string> = {};
    const first = Object.values(results.speed)[0];
    for (const [runtime, run] of Object.entries(results.speed)) {
        speed[`speed-${runtime}`] = speedTable(run);
        speed[`setup-${runtime}`] = speedSetup(run, results);
        speed[`summary-speed-${runtime}`] = speedSummary(run);
    }
    const { machine, versions } = results;
    return {
        ...speed,
        ...correctness(results),
        ...coverage(results),
        ours: OURS,
        generated: results.generated,
        machine: `${machine.cpu}, ${machine.cores} cores, ${machine.memoryGb} GB, ${machine.os}`,
        versions: `Bun ${versions.bun}, Node ${versions.node.replace(/^v/, '')}, HyperFormula ${versions.hyperformula}, formulajs ${versions.formulajs}`,
        workloads: (first?.rows ?? []).map((row) => `- **${row.workload}.** ${row.what}`).join('\n'),
        'lookup-config': JSON.stringify(
            Object.fromEntries(
                (first?.rows ?? [])
                    .filter((row) => row.hyperformula !== '{}')
                    .map((row) => [row.workload, JSON.parse(row.hyperformula)]),
            ),
        ),
        losses: lossList(results),
        'hyperformula-config': JSON.stringify(results.hyperformulaConfig, null, 2),
    };
}

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
