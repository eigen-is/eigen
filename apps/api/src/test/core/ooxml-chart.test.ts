import { describe, expect, test } from 'bun:test';
import { CHART_PALETTE, MAX_CHART_POINTS, MAX_CHART_SERIES } from '@workspace/lib/charts';
import type { ChartSpec } from '@workspace/lib/types/chart';
import { type DrawingTheme, IDENTITY_COLOR_MAP } from '../../lib/core/drawingml';
import { A_NS, C_NS, MC_NS, parseOoxml } from '../../lib/core/ooxml';
import { type ChartRead, readChart } from '../../lib/core/ooxml-chart';

const STRICT = 'http://purl.oclc.org/ooxml';
const ACCENTS = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'];
const theme: DrawingTheme = {
    scheme: new Map([
        ['dk1', '#000000'],
        ['lt1', '#ffffff'],
        ...ACCENTS.map((accent, i): [string, string] => [`accent${i + 1}`, accent]),
    ]),
    map: IDENTITY_COLOR_MAP,
};

const pts = (values: readonly (string | number | null)[]) =>
    values.map((value, i) => (value === null ? '' : `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`)).join('');
const strRef = (f: string, values: readonly string[]) =>
    `<c:strRef><c:f>${f}</c:f><c:strCache><c:ptCount val="${values.length}"/>${pts(values)}</c:strCache></c:strRef>`;
const numRef = (f: string, values: readonly (number | null)[], format = 'General') =>
    `<c:numRef><c:f>${f}</c:f><c:numCache><c:formatCode>${format}</c:formatCode><c:ptCount val="${values.length}"/>${pts(values)}</c:numCache></c:numRef>`;

const CATEGORIES = ['North', 'South', 'East'];

type Series = { idx: number; name?: string; values: (number | null)[]; extra?: string; cat?: string };

function ser({ idx, name, values, extra = '', cat }: Series): string {
    const column = String.fromCharCode(66 + idx);
    return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>${
        name === undefined ? '' : `<c:tx>${strRef(`Sheet1!$${column}$1`, [name])}</c:tx>`
    }${extra}<c:cat>${cat ?? strRef('Sheet1!$A$2:$A$4', CATEGORIES)}</c:cat><c:val>${numRef(
        `Sheet1!$${column}$2:$${column}$4`,
        values,
    )}</c:val></c:ser>`;
}

const TWO_SERIES = [
    { idx: 0, name: 'Plan', values: [1, 2, 3] },
    { idx: 1, name: 'Actual', values: [4.5, 5, 6] },
];

const AXES =
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="1"/></c:valAx>';

function bar(series: Series[] = TWO_SERIES, { dir = 'col', grouping = 'clustered', group = 'barChart' } = {}): string {
    return `<c:${group}><c:barDir val="${dir}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series
        .map(ser)
        .join('')}<c:axId val="1"/><c:axId val="2"/></c:${group}>`;
}

const LEGEND = '<c:legend><c:legendPos val="r"/></c:legend>';

function space(plot: string, { head = '<c:autoTitleDeleted val="0"/>', tail = LEGEND, before = '', ns = '' } = {}) {
    return `<c:chartSpace xmlns:c="${ns ? `${ns}/drawingml/chart` : C_NS}" xmlns:a="${
        ns ? `${ns}/drawingml/main` : A_NS
    }" xmlns:mc="${MC_NS}">${before}<c:chart>${head}<c:plotArea><c:layout/>${plot}</c:plotArea>${tail}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

function read(xml: string, data: Parameters<typeof readChart>[1]['data'] = 'cache'): ChartRead {
    const root = parseOoxml(xml);
    if (!root) throw new Error('no root');
    return readChart(root, { theme, data });
}

function spec(xml: string): ChartSpec {
    const result = read(xml);
    if (!('spec' in result)) throw new Error(`unsupported: ${JSON.stringify(result.unsupported)}`);
    return result.spec;
}

const title = (text: string) =>
    `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx></c:title>`;

describe('a bar chart', () => {
    test('a clustered column chart reads as a column spec with inline data', () => {
        expect(spec(space(bar() + AXES))).toEqual({
            type: 'column',
            stacked: false,
            title: '',
            legend: 'right',
            blanks: 'gap',
            categoryAxis: { title: '' },
            valueAxis: { title: '', min: null, max: null, gridlines: true, format: null },
            sliceColors: [],
            data: {
                source: 'inline',
                categories: CATEGORIES,
                series: [
                    { name: 'Plan', color: ACCENTS[0], markers: false, smooth: false, values: [1, 2, 3] },
                    { name: 'Actual', color: ACCENTS[1], markers: false, smooth: false, values: [4.5, 5, 6] },
                ],
            },
        });
    });

    test('barDir bar is a bar chart, stacked grouping stacks', () => {
        expect(spec(space(bar(TWO_SERIES, { dir: 'bar', grouping: 'stacked' }) + AXES))).toMatchObject({
            type: 'bar',
            stacked: true,
        });
    });

    test('a 3D bar chart is flattened, its standard grouping read as clustered', () => {
        const flat = spec(space(bar(TWO_SERIES, { group: 'bar3DChart', grouping: 'standard' }) + AXES));
        expect(flat).toEqual(spec(space(bar() + AXES)));
    });

    test('percent stacked is no spec, its title kept', () => {
        expect(read(space(bar(TWO_SERIES, { grouping: 'percentStacked' }) + AXES, { head: title('Mix') }))).toEqual({
            unsupported: { title: 'Mix', type: 'barChart' },
        });
    });

    test("a series' solid fill is its colour; the rest take the theme's accents, then the palette", () => {
        const fill =
            '<c:spPr><a:solidFill><a:schemeClr val="accent6"><a:alpha val="50000"/></a:schemeClr></a:solidFill></c:spPr>';
        const series = [
            { idx: 0, name: 'A', values: [1], extra: fill },
            { idx: 1, name: 'B', values: [2] },
            { idx: 7, name: 'C', values: [3] },
        ];
        const read = spec(space(bar(series) + AXES));
        expect(read.data.series.map((s) => s.color)).toEqual(['#70ad4780', ACCENTS[1], CHART_PALETTE[7]]);
    });

    test('series draw in their c:order, and one without a name is named as Excel names it', () => {
        const series = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="1"/><c:val>${numRef('Sheet1!$B$2', [1])}</c:val></c:ser><c:ser><c:idx val="1"/><c:order val="0"/><c:tx><c:v>Literal</c:v></c:tx><c:val>${numRef('Sheet1!$C$2', [2])}</c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>`;
        expect(spec(space(series + AXES)).data.series.map((s) => s.name)).toEqual(['Literal', 'Series1']);
    });
});

describe('a line chart', () => {
    const line = (grouping: string, extra: string, group = '') =>
        `<c:lineChart><c:grouping val="${grouping}"/>${ser({ idx: 0, name: 'Trend', values: [1, 2, 3], extra })}${group}<c:axId val="1"/><c:axId val="2"/></c:lineChart>`;
    const stroke = '<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill></a:ln></c:spPr>';

    test('standard grouping reads its stroke colour, markers and smoothing', () => {
        const plain = spec(space(line('standard', `${stroke}<c:marker><c:symbol val="none"/></c:marker>`) + AXES));
        expect(plain.type).toBe('line');
        expect(plain.data.series[0]).toMatchObject({ color: '#c00000', markers: false, smooth: false });
        const marked = spec(space(line('standard', '<c:smooth val="1"/>', '<c:marker val="1"/>') + AXES));
        expect(marked.data.series[0]).toMatchObject({ color: ACCENTS[0], markers: true, smooth: true });
        const off = spec(space(line('standard', '', '<c:marker val="0"/>') + AXES));
        expect(off.data.series[0]).toMatchObject({ markers: false });
    });

    test('a 3D line chart is flattened; a stacked line is no spec', () => {
        expect(spec(space(line('standard', '').replaceAll('lineChart', 'line3DChart') + AXES)).type).toBe('line');
        expect(read(space(line('stacked', '') + AXES))).toEqual({ unsupported: { title: 'Trend', type: 'lineChart' } });
    });
});

describe('a pie chart', () => {
    const slice = (idx: number, rgb: string) =>
        `<c:dPt><c:idx val="${idx}"/><c:spPr><a:solidFill><a:srgbClr val="${rgb}"/></a:solidFill></c:spPr></c:dPt>`;
    const pie = (group = 'pieChart') =>
        `<c:${group}><c:varyColors val="1"/>${ser({
            idx: 0,
            name: 'Share',
            values: [10, 20, 30],
            extra: slice(1, '112233'),
        })}${ser({ idx: 1, name: 'Ignored', values: [1, 1, 1] })}<c:firstSliceAng val="90"/></c:${group}>`;

    test("reads its first series only, a data point's fill as its slice colour and the accents for the rest", () => {
        const read = spec(space(pie(), { head: title('Market') }));
        expect(read).toMatchObject({ type: 'pie', title: 'Market', sliceColors: [ACCENTS[0], '#112233', ACCENTS[2]] });
        expect(read.data).toEqual({
            source: 'inline',
            categories: CATEGORIES,
            series: [{ name: 'Share', color: ACCENTS[0], markers: false, smooth: false, values: [10, 20, 30] }],
        });
    });

    test('a 3D pie is flattened; a doughnut or a pie of pie is no spec', () => {
        expect(spec(space(pie('pie3DChart'))).type).toBe('pie');
        expect(read(space(pie('doughnutChart')))).toEqual({ unsupported: { title: '', type: 'doughnutChart' } });
        expect(read(space(pie('ofPieChart')))).toEqual({ unsupported: { title: '', type: 'ofPieChart' } });
    });
});

describe('a chart with no spec', () => {
    test('another chart type keeps its title', () => {
        const scatter = `<c:scatterChart>${ser({ idx: 0, name: 'S', values: [1] })}</c:scatterChart>`;
        expect(read(space(scatter, { head: title('Spread') }))).toEqual({
            unsupported: { title: 'Spread', type: 'scatterChart' },
        });
    });

    test('two chart groups, secondary axes or a log scale are no spec', () => {
        const line = `<c:lineChart><c:grouping val="standard"/>${ser({ idx: 2, name: 'L', values: [1] })}</c:lineChart>`;
        expect(read(space(bar() + line + AXES))).toEqual({
            unsupported: { title: '', type: 'barChart+lineChart' },
        });
        const secondary = AXES.replace('</c:valAx>', '</c:valAx><c:valAx><c:axId val="3"/></c:valAx>');
        expect(read(space(bar() + secondary))).toEqual({ unsupported: { title: '', type: 'barChart' } });
        const log = AXES.replace(
            '<c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>',
            '<c:logBase val="10"/><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/>',
        );
        expect(read(space(bar() + log))).toEqual({ unsupported: { title: '', type: 'barChart' } });
    });

    test('a plot area with no chart group is no spec', () => {
        expect(read(space(''))).toEqual({ unsupported: { title: '', type: '' } });
        expect(read(`<c:chartSpace xmlns:c="${C_NS}"/>`)).toEqual({ unsupported: { title: '', type: '' } });
    });
});

describe('the data from the caches', () => {
    test('a missing point is null, a point past ptCount is dropped and a non-number is null', () => {
        const values = `<c:numCache><c:ptCount val="4"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>x</c:v></c:pt><c:pt idx="3"><c:v>4</c:v></c:pt><c:pt idx="9"><c:v>9</c:v></c:pt></c:numCache>`;
        const sparse = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>S!$B$1:$B$4</c:f>${values}</c:numRef></c:val></c:ser></c:barChart>`;
        expect(spec(space(sparse + AXES)).data).toEqual({
            source: 'inline',
            categories: ['1', '2', '3', '4'],
            series: [{ name: 'Series1', color: ACCENTS[0], markers: false, smooth: false, values: [1, null, null, 4] }],
        });
    });

    test('literals read like caches; numeric categories keep their cached text', () => {
        const literal = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>2023</c:v></c:pt><c:pt idx="1"><c:v>2024.5</c:v></c:pt></c:numLit></c:cat><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>7</c:v></c:pt><c:pt idx="1"><c:v>-1e3</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart>`;
        const read = spec(space(literal + AXES));
        expect(read.data).toMatchObject({ categories: ['2023', '2024.5'], series: [{ values: [7, -1000] }] });
    });

    test('multi-level categories read their innermost level', () => {
        const cat = `<c:multiLvlStrRef><c:f>Sheet1!$A$2:$B$4</c:f><c:multiLvlStrCache><c:ptCount val="3"/><c:lvl>${pts(['Jan', 'Feb', 'Mar'])}</c:lvl><c:lvl>${pts(['Q1', null, null])}</c:lvl></c:multiLvlStrCache></c:multiLvlStrRef>`;
        expect(spec(space(bar([{ idx: 0, name: 'A', values: [1, 2, 3], cat }]) + AXES)).data).toMatchObject({
            categories: ['Jan', 'Feb', 'Mar'],
        });
    });

    test('a cache past the point limit is no spec, and its declared count is never allocated', () => {
        const huge = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1000000000"/><c:pt idx="999999999"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart>`;
        const started = performance.now();
        expect(read(space(huge + AXES, { head: title('Big') }))).toEqual({
            unsupported: { title: 'Big', type: 'barChart' },
        });
        expect(performance.now() - started).toBeLessThan(100);
        const noCount = huge.replace('<c:ptCount val="1000000000"/>', '');
        expect(read(space(noCount + AXES))).toEqual({ unsupported: { title: 'Series1', type: 'barChart' } });
    });

    test('more points in all than the limit, or more series than the limit, is no spec', () => {
        const half = Array.from({ length: MAX_CHART_POINTS / 2 + 1 }, (_, i) => i);
        expect(
            'unsupported' in
                read(
                    space(
                        bar([
                            { idx: 0, name: 'A', values: half },
                            { idx: 1, name: 'B', values: half },
                        ]) + AXES,
                    ),
                ),
        ).toBe(true);
        const many = Array.from({ length: MAX_CHART_SERIES + 1 }, (_, idx) => ({ idx, name: `S${idx}`, values: [1] }));
        expect('unsupported' in read(space(bar(many) + AXES))).toBe(true);
        const max = Array.from({ length: MAX_CHART_SERIES }, (_, idx) => ({ idx, name: `S${idx}`, values: [1] }));
        expect(spec(space(bar(max) + AXES)).data.series).toHaveLength(MAX_CHART_SERIES);
    });

    test('an overlong label is cut to the limit rather than costing the chart', () => {
        const long = 'x'.repeat(5000);
        expect(spec(space(bar([{ idx: 0, name: long, values: [1] }]) + AXES)).data.series[0]?.name).toHaveLength(200);
    });
});

describe('the title', () => {
    const one = [{ idx: 0, name: 'Revenue', values: [1, 2, 3] }];

    test('rich text runs are joined, paragraphs by a space', () => {
        const rich =
            '<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales </a:t></a:r><a:r><a:t>2024</a:t></a:r></a:p><a:p><a:r><a:t>by region</a:t></a:r></a:p></c:rich></c:tx></c:title>';
        expect(spec(space(bar() + AXES, { head: rich })).title).toBe('Sales 2024 by region');
    });

    test("a title from a cell is the cell's cached text", () => {
        const cell = `<c:title><c:tx>${strRef('Sheet1!$A$1', ['From cell'])}</c:tx></c:title>`;
        expect(spec(space(bar() + AXES, { head: cell })).title).toBe('From cell');
    });

    test('a title with no text is the series name for one series, Chart Title for more', () => {
        const auto = '<c:title><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>';
        expect(spec(space(bar(one) + AXES, { head: auto })).title).toBe('Revenue');
        expect(spec(space(bar() + AXES, { head: auto })).title).toBe('Chart Title');
    });

    test('no title and an auto title not deleted shows the only series name', () => {
        expect(spec(space(bar(one) + AXES)).title).toBe('Revenue');
        expect(spec(space(bar() + AXES)).title).toBe('');
        expect(spec(space(bar(one) + AXES, { head: '<c:autoTitleDeleted val="1"/>' })).title).toBe('');
        expect(spec(space(bar(one) + AXES, { head: '<c:autoTitleDeleted/>' })).title).toBe('');
        expect(spec(space(bar(one) + AXES, { head: '' })).title).toBe('');
    });
});

describe('the axes, legend and blanks', () => {
    const axis = (title: string) =>
        `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>`;

    test('value-axis bounds, titles and a format of its own', () => {
        const axes = `<c:catAx><c:axId val="1"/>${axis('Region')}</c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="100"/><c:min val="-5.5"/></c:scaling>${axis('Units')}<c:numFmt formatCode="0.0%" sourceLinked="0"/></c:valAx>`;
        expect(spec(space(bar() + axes))).toMatchObject({
            categoryAxis: { title: 'Region' },
            valueAxis: { title: 'Units', min: -5.5, max: 100, gridlines: false, format: '0.0%' },
        });
    });

    test("a format linked to its source is the first series' cache format", () => {
        const linked = bar([{ idx: 0, name: 'A', values: [1] }]).replace(
            '<c:formatCode>General',
            '<c:formatCode>#,##0',
        );
        expect(spec(space(linked + AXES)).valueAxis.format).toBe('#,##0');
        expect(spec(space(bar() + AXES)).valueAxis.format).toBeNull();
    });

    test('a date axis titles the categories', () => {
        const axes = AXES.replace('<c:catAx><c:axId val="1"/>', `<c:dateAx><c:axId val="1"/>${axis('When')}`).replace(
            '</c:catAx>',
            '</c:dateAx>',
        );
        expect(spec(space(bar() + axes)).categoryAxis.title).toBe('When');
    });

    test('legend positions; top right is right; none without a legend', () => {
        const legend = (pos: string) => spec(space(bar() + AXES, { tail: `<c:legend>${pos}</c:legend>` })).legend;
        expect(legend('<c:legendPos val="t"/>')).toBe('top');
        expect(legend('<c:legendPos val="b"/>')).toBe('bottom');
        expect(legend('<c:legendPos val="l"/>')).toBe('left');
        expect(legend('<c:legendPos val="tr"/>')).toBe('right');
        expect(legend('')).toBe('right');
        expect(spec(space(bar() + AXES, { tail: '' })).legend).toBe('none');
    });

    test('dispBlanksAs reads as blanks', () => {
        expect(spec(space(bar() + AXES).replace('val="gap"', 'val="span"')).blanks).toBe('span');
        expect(spec(space(bar() + AXES).replace('<c:dispBlanksAs val="gap"/>', '')).blanks).toBe('gap');
    });
});

describe('markup compatibility, Strict and colour maps', () => {
    test("the Fallback of a choice the reader doesn't know is read", () => {
        const style = `<mc:AlternateContent><mc:Choice Requires="c14" xmlns:c14="http://schemas.microsoft.com/office/drawing/2007/8/2/chart"><c14:style val="102"/></mc:Choice><mc:Fallback><c:style val="2"/></mc:Fallback></mc:AlternateContent>`;
        const wrapped = `<mc:AlternateContent><mc:Choice Requires="c99" xmlns:c99="urn:x"><c99:legend/></mc:Choice><mc:Fallback><c:legend><c:legendPos val="b"/></c:legend></mc:Fallback></mc:AlternateContent>`;
        expect(spec(space(bar() + AXES, { before: style, tail: wrapped })).legend).toBe('bottom');
    });

    test('a Strict chart reads as its transitional twin, percentages too', () => {
        const fill = (lumMod: string) =>
            `<c:spPr><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="${lumMod}"/></a:schemeClr></a:solidFill></c:spPr>`;
        const series = (lumMod: string) => [{ idx: 0, name: 'A', values: [1, 2], extra: fill(lumMod) }];
        const strict = spec(space(bar(series('50%')) + AXES, { ns: STRICT }));
        expect(strict).toEqual(spec(space(bar(series('50000')) + AXES)));
        expect(strict.data.series[0]?.color).toBe('#203864');
    });

    test("the chart's own colour map overrides the theme's", () => {
        const text = '<c:spPr><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></c:spPr>';
        const override =
            '<c:clrMapOvr bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
        const xml = space(bar([{ idx: 0, name: 'A', values: [1], extra: text }]) + AXES);
        expect(spec(xml).data.series[0]?.color).toBe('#000000');
        expect(spec(xml.replace('</c:chart>', `</c:chart>${override}`)).data.series[0]?.color).toBe('#ffffff');
    });
});

describe('range data for a workbook', () => {
    const SHEETS = new Map([
        ['Sheet1', 's1'],
        ["My 'Q' sheet", 's2'],
    ]);
    const ranges = { ranges: (name: string) => SHEETS.get(name) };
    const byRange = (xml: string) => {
        const result = read(xml, ranges);
        if (!('spec' in result)) throw new Error(`unsupported: ${JSON.stringify(result.unsupported)}`);
        return result.spec;
    };

    test('refs become cell ranges through the sheet names; the caches are ignored', () => {
        expect(byRange(space(bar() + AXES)).data).toEqual({
            source: 'range',
            categories: { sheetId: 's1', row: [1, 3], column: [0, 0] },
            series: [
                {
                    name: { sheetId: 's1', row: [0, 0], column: [1, 1] },
                    values: { sheetId: 's1', row: [1, 3], column: [1, 1] },
                    color: ACCENTS[0],
                    markers: false,
                    smooth: false,
                },
                {
                    name: { sheetId: 's1', row: [0, 0], column: [2, 2] },
                    values: { sheetId: 's1', row: [1, 3], column: [2, 2] },
                    color: ACCENTS[1],
                    markers: false,
                    smooth: false,
                },
            ],
        });
    });

    test('a quoted sheet name, relative refs and a reversed range; an unknown sheet or #REF! is no range', () => {
        const series = (f: string) =>
            `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Lit</c:v></c:tx><c:val><c:numRef><c:f>${f}</c:f></c:numRef></c:val></c:ser></c:barChart>`;
        const values = (f: string) => {
            const [first] = byRange(space(series(f) + AXES)).data.series;
            return first?.values;
        };
        expect(values("'My ''Q'' sheet'!C10:$B$2")).toEqual({ sheetId: 's2', row: [1, 9], column: [1, 2] });
        expect(values('Sheet1!$XFD$1048576')).toEqual({
            sheetId: 's1',
            row: [1048575, 1048575],
            column: [16383, 16383],
        });
        expect(values('Nope!$B$2:$B$4')).toBeNull();
        expect(values('Sheet1!#REF!')).toBeNull();
        expect(byRange(space(series('Sheet1!B2') + AXES)).data.series[0]?.name).toBe('Lit');
    });

    test('a ref the model cannot hold is no spec', () => {
        const series = (f: string) =>
            `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:f>${f}</c:f></c:numRef></c:val></c:ser></c:barChart>`;
        for (const f of ['(Sheet1!$B$2,Sheet1!$B$4)', 'Sheet1!$B:$B', 'Sheet1!$XFE$1', 'Sheet1!B0', 'B2:B4', '']) {
            expect('unsupported' in read(space(series(f) + AXES), ranges)).toBe(true);
        }
        const literal = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser></c:barChart>`;
        expect('unsupported' in read(space(literal + AXES), ranges)).toBe(true);
    });

    test('an empty c:cat or c:val names no cells', () => {
        const empty = `<c:lineChart><c:ser><c:idx val="0"/><c:order val="0"/><c:cat/><c:val/></c:ser></c:lineChart>`;
        expect(byRange(space(empty + AXES)).data).toMatchObject({ categories: null, series: [{ values: null }] });
    });

    test('multi-level categories take their innermost column', () => {
        const cat = `<c:multiLvlStrRef><c:f>Sheet1!$A$2:$B$4</c:f></c:multiLvlStrRef>`;
        expect(byRange(space(bar([{ idx: 0, name: 'A', values: [1, 2, 3], cat }]) + AXES)).data.categories).toEqual({
            sheetId: 's1',
            row: [1, 3],
            column: [1, 1],
        });
    });

    test("a pie's slice colours cover its value range", () => {
        const pie = `<c:pieChart><c:varyColors val="1"/>${ser({ idx: 0, name: 'P', values: [1, 2, 3] })}</c:pieChart>`;
        expect(byRange(space(pie)).sliceColors).toEqual(ACCENTS.slice(0, 3));
    });
});
