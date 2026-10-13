import { describe, expect, test } from 'bun:test';
import { parseChartSpec } from '@workspace/lib/charts';
import { TRANSPARENT_COLOR } from '@workspace/lib/vector';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { MAX_PPTX_WEIGHT } from '../../../lib/import/slides/shapes';
import { buildPptx, graphicFrame, groupXfrm, grp, NS, type PptxFixture, PX, rel } from '../../fixtures/pptx';

// A graphic frame's chart: its part read through the core chart reader into a chart element, or the box saying what
// was there.

const OPTIONS = { maxMediaBytes: 35 * 1024 * 1024 };
const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const chartType = (path: string, type = CHART_TYPE) => `<Override PartName="/${path}" ContentType="${type}"/>`;

// A frame of 600×300 px at (100, 50) naming its chart by r:id.
const frame = (id = 'rId5', x = 100, y = 50) =>
    graphicFrame(C, x * PX, y * PX, 600 * PX, 300 * PX, `<c:chart xmlns:c="${C}" r:id="${id}"/>`);

const pts = (values: readonly (string | number)[]) =>
    `<c:ptCount val="${values.length}"/>${values.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('')}`;
const CATEGORIES = ['North', 'South', 'East'];

function ser(idx: number, name: string, values: number[], inner = ''): string {
    return `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>${pts([name])}</c:strCache></c:strRef></c:tx>${inner}<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache>${pts(CATEGORIES)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode>${pts(values)}</c:numCache></c:numRef></c:val></c:ser>`;
}

const AXES =
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx>';

function chartSpace(plot: string, title = ''): string {
    const head = title
        ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>`
        : '';
    return `<c:chartSpace xmlns:c="${C}" ${NS}><c:chart>${head}<c:autoTitleDeleted val="${title ? 0 : 1}"/><c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
}

const scheme = (slot: string) => `<c:spPr><a:solidFill><a:schemeClr val="${slot}"/></a:solidFill></c:spPr>`;

const COLUMN = chartSpace(
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${ser(0, 'Plan', [1, 2, 3])}${ser(1, 'Actual', [4, 5, 6], scheme('accent4'))}<c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`,
    'Revenue',
);
const LINE = chartSpace(
    `<c:lineChart><c:grouping val="standard"/>${ser(0, 'Trend', [3, 1, 2], '<c:smooth val="1"/>')}<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>${AXES}`,
    'Trend',
);
const PIE = chartSpace(`<c:pieChart><c:varyColors val="1"/>${ser(0, 'Share', [5, 3, 2])}</c:pieChart>`);
const SCATTER = chartSpace(`<c:scatterChart>${ser(0, 'Spread', [1, 2, 3])}</c:scatterChart>`, 'Spread');

// The theme's accents, as the fixture's theme states them.
const ACCENT = { 1: '#4f81bd', 2: '#c0504d', 3: '#9bbb59', 4: '#8064a2' };

// accent1 shows accent3 and accent4 accent1 on the slide: a chart's colours go through the slide's clrMap.
const OVERRIDE =
    '<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent3" accent2="accent2" accent3="accent3" accent4="accent1" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>';

function deckWith(part: string, fixture: Partial<PptxFixture> = {}, shapes = frame()) {
    return readPptx(
        buildPptx({
            slides: [{ shapes, rels: rel('rId5', 'chart', '../charts/chart1.xml') }],
            types: chartType('ppt/charts/chart1.xml'),
            files: { 'ppt/charts/chart1.xml': part },
            ...fixture,
        }),
        OPTIONS,
    );
}

function chartOf(part: string, fixture: Partial<PptxFixture> = {}) {
    const deck = deckWith(part, fixture);
    const [element] = deck.slides[0].elements;
    if (element?.type !== 'chart') throw new Error(`not a chart: ${JSON.stringify(element)}`);
    return { element, spec: parseChartSpec(element.chart ?? ''), deck };
}

describe('a chart', () => {
    test("a column chart is a chart element at the frame's box with its series, categories, colours and title", () => {
        const { element, spec, deck } = chartOf(COLUMN, {
            slides: [{ shapes: frame(), rels: rel('rId5', 'chart', '../charts/chart1.xml'), after: OVERRIDE }],
        });
        expect(element).toMatchObject({ x: 100, y: 50, width: 600, height: 300, angle: 0 });
        expect(element).toMatchObject({ fontFamily: 'Inter', strokeStyle: 'solid', roughness: 0 });
        expect(element.fill && JSON.parse(element.fill)).toMatchObject({ color: TRANSPARENT_COLOR });
        expect(spec).toMatchObject({
            type: 'column',
            title: 'Revenue',
            legend: 'bottom',
            data: {
                source: 'inline',
                categories: CATEGORIES,
                series: [
                    { name: 'Plan', values: [1, 2, 3], color: ACCENT[3] },
                    { name: 'Actual', values: [4, 5, 6], color: ACCENT[1] },
                ],
            },
        });
        expect(deck.warnings).toEqual([]);
    });

    test('a line chart keeps its series, smoothing and markers; a pie its slices in the accents', () => {
        expect(chartOf(LINE).spec).toMatchObject({
            type: 'line',
            title: 'Trend',
            data: { series: [{ name: 'Trend', values: [3, 1, 2], color: ACCENT[1], smooth: true, markers: true }] },
        });
        expect(chartOf(PIE).spec).toMatchObject({
            type: 'pie',
            title: '',
            sliceColors: [ACCENT[1], ACCENT[2], ACCENT[3]],
            data: { categories: CATEGORIES, series: [{ values: [5, 3, 2] }] },
        });
    });

    test('a chart in a group lands where the group places it, and one on a layout on every slide that shows it', () => {
        const grouped = grp(
            groupXfrm([0, 0, 1200 * PX, 600 * PX], [0, 0, 2400 * PX, 1200 * PX]),
            frame('rId5', 200, 100),
        );
        expect(deckWith(COLUMN, {}, grouped).slides[0].elements[0]).toMatchObject({
            type: 'chart',
            x: 100,
            y: 50,
            width: 300,
            height: 150,
        });
        const deck = readPptx(
            buildPptx({
                layouts: [{ shapes: frame(), rels: rel('rId5', 'chart', '../charts/chart1.xml') }],
                slides: [{}, {}, { after: OVERRIDE }],
                types: chartType('ppt/charts/chart1.xml'),
                files: { 'ppt/charts/chart1.xml': COLUMN },
            }),
            OPTIONS,
        );
        const colors = deck.slides.map(({ elements: [found] }) =>
            found?.type === 'chart' ? parseChartSpec(found.chart ?? '')?.data.series[0].color : undefined,
        );
        expect(colors).toEqual([ACCENT[1], ACCENT[1], ACCENT[3]]);
    });

    test("the chart part's own relationships are never followed", () => {
        // A damaged user-shapes part and rels: reading either would drop the chart.
        const { spec } = chartOf(COLUMN, {
            files: {
                'ppt/charts/chart1.xml': COLUMN.replace(
                    '</c:chartSpace>',
                    '<c:userShapes r:id="rId1"/></c:chartSpace>',
                ),
                'ppt/charts/_rels/chart1.xml.rels': '<Relationships',
                'ppt/drawings/drawing1.xml': '<c:userShapes',
            },
        });
        expect(spec?.title).toBe('Revenue');
    });
});

describe('a chart left as a box', () => {
    const boxOf = (deck: ReturnType<typeof readPptx>) => {
        const [found] = deck.slides[0].elements;
        return { type: found?.type, html: found?.html };
    };

    test('a chart the reader cannot draw says its kind and title, counted as a dropped chart', () => {
        const deck = deckWith(SCATTER);
        expect(boxOf(deck)).toEqual({ type: 'richtext', html: '<p>Scatter chart not imported</p><p>Spread</p>' });
        expect(deck.warnings).toEqual([{ code: 'charts-dropped', count: 1 }]);
        const bar3D = chartSpace(
            `<c:bar3DChart><c:barDir val="col"/><c:grouping val="percentStacked"/>${ser(0, 'S', [1, 2, 3])}</c:bar3DChart>`,
        );
        expect(boxOf(deckWith(bar3D)).html).toBe('<p>Bar 3D chart not imported</p>');
    });

    test('a damaged chart part is the plain box', () => {
        expect(boxOf(deckWith(`<c:chartSpace xmlns:c="${C}"><c:chart>`)).html).toBe('<p>Chart not imported</p>');
        expect(boxOf(deckWith(`<p:sld ${NS}/>`)).html).toBe('<p>Chart not imported</p>');
    });

    test('a relationship to a part outside ppt/charts/, of another content type, external or not a chart is not read', () => {
        const at = (target: string, type = 'chart', external = false) => ({
            slides: [{ shapes: frame(), rels: rel('rId5', type, target, external) }],
        });
        const cases: Partial<PptxFixture>[] = [
            {
                ...at('../embeddings/chart1.xml'),
                types: chartType('ppt/embeddings/chart1.xml'),
                files: { 'ppt/embeddings/chart1.xml': COLUMN },
            },
            { types: chartType('ppt/charts/chart1.xml', 'application/xml') },
            { ...at('../charts/chart1.xml', 'image') },
            { ...at('../charts/chart1.xml', 'chart', true) },
            { ...at('../charts/missing.xml') },
            { slides: [{ shapes: frame('rId9'), rels: rel('rId5', 'chart', '../charts/chart1.xml') }] },
        ];
        for (const fixture of cases) expect(boxOf(deckWith(COLUMN, fixture)).html).toBe('<p>Chart not imported</p>');
    });

    test('every dropped object is an unfilled dashed box, so what it overlaps stays readable', () => {
        const [found] = deckWith(SCATTER).slides[0].elements;
        expect(found).toMatchObject({ strokeStyle: 'dashed', textAlign: 'center', verticalAlign: 'center' });
        expect(found?.strokeColor).not.toBe(TRANSPARENT_COLOR);
        expect(found?.fill && JSON.parse(found.fill)).toMatchObject({ color: TRANSPARENT_COLOR });
    });
});

describe('bounds', () => {
    // 2,000 labels of 20 characters: a spec of about 55 KB, over 100 weight units a copy.
    const labels = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(15)}`);
    const HEAVY = chartSpace(
        `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit>${pts(labels)}</c:strLit></c:cat><c:val><c:numLit>${pts(labels.map((_, i) => i))}</c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>${AXES}`,
    );

    const many = (count: number, part: string) =>
        buildPptx({
            slides: Array.from({ length: count }, () => ({
                shapes: frame(),
                rels: rel('rId5', 'chart', '../charts/chart1.xml'),
            })),
            types: chartType('ppt/charts/chart1.xml'),
            files: { 'ppt/charts/chart1.xml': part },
        });

    test("every copy of a chart weighs its spec: one part on enough slides passes the output's cap", () => {
        const one = readPptx(many(1, HEAVY), OPTIONS).slides[0].elements[0];
        const weight = 1 + Math.floor((one?.chart?.length ?? 0) / 512);
        expect(one?.type).toBe('chart');
        expect(weight).toBeGreaterThan(100);
        const fits = Math.floor(MAX_PPTX_WEIGHT / (weight + 1));
        expect(readPptx(many(fits - 1, HEAVY), OPTIONS).slides).toHaveLength(fits - 1);
        expect(() => readPptx(many(fits + 5, HEAVY), OPTIONS)).toThrow('This presentation is too large to import');
    });

    test('slides painting one large chart part in as many colour maps read it a bounded number of times', () => {
        const junk = `<c:x/>`.repeat(200_000);
        const part = COLUMN.replace('<c:idx val="0"/>', `<c:idx val="0"/>${junk}`);
        const permutations = (slots: string[]): string[][] =>
            slots.length <= 1
                ? [slots]
                : slots.flatMap((slot, i) =>
                      permutations(slots.filter((_, j) => j !== i)).map((rest) => [slot, ...rest]),
                  );
        const maps = permutations(['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']).slice(0, 400);
        const pptx = buildPptx({
            slides: maps.map((map) => ({
                shapes: frame(),
                rels: rel('rId5', 'chart', '../charts/chart1.xml'),
                after: `<p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ${map.map((slot, i) => `accent${i + 1}="${slot}"`).join(' ')} hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>`,
            })),
            types: chartType('ppt/charts/chart1.xml'),
            files: { 'ppt/charts/chart1.xml': part },
        });
        const started = performance.now();
        // Read for each map, the part took a minute.
        expect(() => readPptx(pptx, OPTIONS)).toThrow('This presentation is too large to import');
        expect(performance.now() - started).toBeLessThan(3000);
    });

    test('many slides naming one large chart part read it once', () => {
        // 200,000 junk elements in the series: read for every slide, they took seconds.
        const junk = `<c:x/>`.repeat(200_000);
        const part = COLUMN.replace('<c:idx val="0"/>', `<c:idx val="0"/>${junk}`);
        const pptx = many(400, part);
        const started = performance.now();
        const deck = readPptx(pptx, OPTIONS);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(deck.slides.every(({ elements: [found] }) => found?.type === 'chart')).toBe(true);
    });
});
