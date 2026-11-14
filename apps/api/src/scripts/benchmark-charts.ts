// Draws the formula benchmark's speed chart with Eigen's own chart code: each engine's time on every full-size
// workload of the Bun run, relative to ours on a log scale, painted by renderChartSpecSvg in the clean hand-drawn
// look with solid bars, in Excalifont, with the font slices its labels draw in embedded as the SVG preview embeds
// them. It lives with the API's scripts because it imports the chart code and reads the fonts where the API does.
// Run it by hand after the benchmark run and before its README is written.

import * as fs from 'node:fs';
import path from 'node:path';
import { defaultChartSpec } from '@workspace/lib/charts';
import type { ChartLook, ChartSpec } from '@workspace/lib/types/chart';
import { renderChartSpecSvg } from '@workspace/lib/vector';
import { serializeFill } from '@workspace/lib/vector/fill';
import { spliceAfterSvgOpenTag } from '@workspace/lib/xml';
import { drawnCodePoints, namedFamilies, slicesFaceCss } from '../lib/export/fonts';

// The benchmark's own results file: the formula package is a leaf, so it holds the types and this reads only the
// fields it draws.
type EngineResult = { status: string; median?: number };
type SpeedRow = { smallerFor?: string[]; engines: Record<string, EngineResult> };
type Results = { speed: { bun: { rows: SpeedRow[] } } };

const BENCHMARK = path.join(import.meta.dir, '../../../../packages/formula/benchmark');

// Ours first, so it takes the palette's first color; the others keep the palette's order.
const ENGINES = [
    { id: 'ours', name: 'Eigen' },
    { id: 'hyperformula', name: 'HyperFormula' },
    { id: 'ironcalc', name: 'IronCalc' },
    { id: 'univer', name: 'Univer' },
];

// A chart's text is 3.5% of its box's shorter side, so a height of 440 draws its labels at about a README's body
// text, in a box 800 px wide.
const WIDTH = 800;
const HEIGHT = 440;
const INK = '#1e1e1e';

// Excalidraw's architect sketch, roughness 0, with solid bars on a white background.
const LOOK: ChartLook = {
    fill: serializeFill({ type: 'solid', color: '#ffffff', style: 'solid' }),
    color: INK,
    strokeColor: INK,
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    seed: 7,
};

// A bar is its ratio's logarithm to base STEP, plus 1, so 1× sits one gridline above the bottom edge. The chart code
// fits four or five ticks at this height, too few for a gridline per 4× across the run's range.
const STEP = 16;

// Every full-size workload as T1, T2 and on, in the README's order, every engine a series. A ratio the engine did not
// measure at the full size, such as one it was too slow for, stays blank.
function speedChart(results: Results): ChartSpec {
    const rows = results.speed.bun.rows.filter((row) => row.smallerFor === undefined);
    const series = ENGINES.map(({ id, name }) => ({
        id,
        name,
        values: rows.map((row) => {
            const ours = row.engines['ours']?.median;
            const theirs = row.engines[id];
            if (ours === undefined || theirs?.status !== 'measured' || theirs.median === undefined) return null;
            return Math.log(theirs.median / ours) / Math.log(STEP) + 1;
        }),
    }));
    const base = defaultChartSpec('column', { source: 'inline', categories: rows.map((_, i) => `T${i + 1}`), series });
    const plotted = series.flatMap(({ values }) => values.filter((value) => value !== null));
    const { y } = base.axes;
    return {
        ...base,
        chart: { ...base.chart, fontFamily: 'Excalifont' },
        title: { text: 'Relative calculation time' },
        axes: {
            ...base.axes,
            y: {
                ...y,
                title: { text: 'Eigen = 1×, log scale, lower is faster' },
                labels: { format: TICK_FORMAT },
                scale: { ...y.scale, min: Math.floor(Math.min(0, ...plotted)), max: Math.ceil(Math.max(...plotted)) },
            },
        },
    };
}

// STOPGAP until the chart code has a logarithmic axis, which replaces this step: each tick's text v is rewritten in
// the SVG to the ratio it stands for, STEP^(v - 1), and one under 1× is blanked. The padded format leaves the real
// text its room and tells a tick from the other labels.
const TICK_FORMAT = '0"0000×"';
function logTicks(svg: string): string {
    return svg.replace(/>(-?\d+)0000×<\/text>/g, (_, v: string) => {
        const ratio = STEP ** (Number(v) - 1);
        return ratio < 1 ? '></text>' : `>${ratio.toLocaleString('en')}×</text>`;
    });
}

// The font slices the labels draw in, embedded, so the file draws the same anywhere.
function withFonts(svg: string): string {
    const css = slicesFaceCss(drawnCodePoints(svg), namedFamilies(svg));
    return css === '' ? svg : spliceAfterSvgOpenTag(svg, `<defs><style>${css}</style></defs>`);
}

const results: Results = JSON.parse(fs.readFileSync(path.join(BENCHMARK, 'results.json'), 'utf8'));
const svg = renderChartSpecSvg({ id: 'speed', spec: speedChart(results), width: WIDTH, height: HEIGHT, look: LOOK });
const out = path.join(BENCHMARK, 'speed.svg');
fs.writeFileSync(out, withFonts(logTicks(svg)));
console.log(`wrote ${out}`);
