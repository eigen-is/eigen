import { describe, expect, test } from 'bun:test';
import {
    type DrawingTheme,
    drawingColor,
    drawingLines,
    IDENTITY_COLOR_MAP,
    readColorMap,
    readColorScheme,
    SCHEME_SLOTS,
    themeXml,
} from '../../lib/core/drawingml';
import { A_NS, parseOoxml } from '../../lib/core/ooxml';
import { xmlAttr, xmlChild, xmlElements } from '../../lib/core/xml';

const STRICT_A = 'http://purl.oclc.org/ooxml/drawingml/main';

function read(xml: string, ns = A_NS) {
    const root = parseOoxml(`<a:x xmlns:a="${ns}">${xml}</a:x>`);
    if (!root) throw new Error('no root');
    return root;
}

const OFFICE_THEME = `<a:theme xmlns:a="${A_NS}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">
    <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
    <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
    <a:dk2><a:srgbClr val="44546A"/></a:dk2>
    <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
    <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
    <a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
    <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
    <a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
    <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
    <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
    <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`;

const scheme = readColorScheme(parseOoxml(OFFICE_THEME) ?? undefined);
const theme: DrawingTheme = { scheme, map: IDENTITY_COLOR_MAP };

const color = (fill: string, ns = A_NS, use = theme) => drawingColor(read(fill, ns), use);

describe("a theme's colour scheme", () => {
    test('reads every slot, a system colour by its last colour', () => {
        expect([...scheme.keys()]).toEqual([...SCHEME_SLOTS]);
        expect(Object.fromEntries(scheme)).toEqual({
            dk1: '#000000',
            lt1: '#ffffff',
            dk2: '#44546a',
            lt2: '#e7e6e6',
            accent1: '#4472c4',
            accent2: '#ed7d31',
            accent3: '#a5a5a5',
            accent4: '#ffc000',
            accent5: '#5b9bd5',
            accent6: '#70ad47',
            hlink: '#0563c1',
            folHlink: '#954f72',
        });
    });

    test('a part that is no theme, or a slot with no colour, gives nothing', () => {
        expect(readColorScheme(undefined).size).toBe(0);
        expect(readColorScheme(read('<a:themeElements/>')).size).toBe(0);
        const partial = parseOoxml(
            `<a:theme xmlns:a="${A_NS}"><a:themeElements><a:clrScheme><a:dk1/><a:accent1><a:srgbClr val="nothex"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2></a:clrScheme></a:themeElements></a:theme>`,
        );
        expect(Object.fromEntries(readColorScheme(partial ?? undefined))).toEqual({ accent2: '#ed7d31' });
    });
});

describe('the theme the writers write', () => {
    test('reads back as every slot, its major and minor font the document font', () => {
        const written = parseOoxml(themeXml('A & B'));
        expect([...readColorScheme(written ?? undefined).keys()]).toEqual([...SCHEME_SLOTS]);
        const elements = written && xmlChild(written, A_NS, 'themeElements');
        const fonts = elements && xmlChild(elements, A_NS, 'fontScheme');
        for (const name of ['majorFont', 'minorFont']) {
            const font = fonts && xmlChild(fonts, A_NS, name);
            const latin = font && xmlChild(font, A_NS, 'latin');
            expect(latin && xmlAttr(latin, '', 'typeface')).toBe('A & B');
        }
    });
});

describe('a DrawingML colour', () => {
    test('an RGB colour is lower-case #rrggbb', () => {
        expect(color('<a:srgbClr val="FF8000"/>')).toBe('#ff8000');
    });

    test('alpha adds the alpha byte; full opacity adds none', () => {
        expect(color('<a:srgbClr val="4472C4"><a:alpha val="50000"/></a:srgbClr>')).toBe('#4472c480');
        expect(color('<a:srgbClr val="4472C4"><a:alpha val="100000"/></a:srgbClr>')).toBe('#4472c4');
    });

    test('a scheme colour reads its slot, tx and bg through the map', () => {
        expect(color('<a:schemeClr val="accent2"/>')).toBe('#ed7d31');
        expect(color('<a:schemeClr val="tx1"/>')).toBe('#000000');
        expect(color('<a:schemeClr val="bg2"/>')).toBe('#e7e6e6');
        const inverted = { scheme, map: new Map([...IDENTITY_COLOR_MAP, ['tx1', 'lt1']]) };
        expect(color('<a:schemeClr val="tx1"/>', A_NS, inverted)).toBe('#ffffff');
    });

    // Excel's own: text 65% from black, the light gray gridline, accent 1 lighter 40%.
    test('lumMod and lumOff work on HSL lightness, as Office computes them', () => {
        expect(color('<a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr>')).toBe(
            '#595959',
        );
        expect(color('<a:schemeClr val="bg1"><a:lumMod val="85000"/></a:schemeClr>')).toBe('#d9d9d9');
        expect(color('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>')).toBe(
            '#8faadc',
        );
    });

    test("Strict's percentages read as transitional's", () => {
        expect(color('<a:schemeClr val="tx1"><a:lumMod val="65%"/><a:lumOff val="35%"/></a:schemeClr>', STRICT_A)).toBe(
            '#595959',
        );
        expect(color('<a:srgbClr val="4472C4"><a:alpha val="50%"/></a:srgbClr>', STRICT_A)).toBe('#4472c480');
    });

    test('satMod scales HSL saturation', () => {
        expect(color('<a:srgbClr val="4472C4"><a:satMod val="0"/></a:srgbClr>')).toBe('#848484');
    });

    test('shade darkens and tint lightens in linear RGB', () => {
        expect(color('<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>')).toBe('#bdbdbd');
        expect(color('<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>')).toBe('#bdbdbd');
        expect(color('<a:srgbClr val="4472C4"><a:shade val="100000"/></a:srgbClr>')).toBe('#4472c4');
    });

    test('system, preset, scRGB and HSL colours', () => {
        expect(color('<a:sysClr val="windowText" lastClr="1F1F1F"/>')).toBe('#1f1f1f');
        expect(color('<a:prstClr val="black"/>')).toBe('#000000');
        expect(color('<a:prstClr val="dkSlateGray"/>')).toBe('#2f4f4f');
        expect(color('<a:prstClr val="medPurple"/>')).toBe('#9370db');
        expect(color('<a:scrgbClr r="100000" g="0" b="0"/>')).toBe('#ff0000');
        expect(color('<a:hslClr hue="0" sat="100000" lum="50000"/>')).toBe('#ff0000');
        expect(color('<a:hslClr hue="7200000" sat="100000" lum="50000"/>')).toBe('#00ff00');
    });

    test('what names no colour gives nothing', () => {
        expect(color('<a:schemeClr val="phClr"/>')).toBeUndefined();
        expect(color('<a:schemeClr val="accent1"/>', A_NS, { scheme: new Map(), map: IDENTITY_COLOR_MAP })).toBe(
            undefined,
        );
        expect(color('<a:srgbClr val="F00"/>')).toBeUndefined();
        expect(color('<a:prstClr val="currentColor"/>')).toBeUndefined();
        expect(color('<a:prstClr val="transparent"/>')).toBeUndefined();
        expect(color('<a:prstClr val="rebeccaPurple"/>')).toBeUndefined();
        expect(color('<a:prstClr val="rgb(1,2,3)"/>')).toBeUndefined();
        expect(color('<a:sysClr val="windowText"/>')).toBeUndefined();
        expect(color('<a:noFill/>')).toBeUndefined();
        expect(drawingColor(undefined, theme)).toBeUndefined();
    });

    test('out-of-range transforms clamp', () => {
        expect(color('<a:srgbClr val="808080"><a:lumOff val="900000"/></a:srgbClr>')).toBe('#ffffff');
        expect(color('<a:srgbClr val="808080"><a:alpha val="-5"/></a:srgbClr>')).toBe('#80808000');
    });
});

describe('the placeholder colour', () => {
    const referenced = (phClr: string) => ({ ...theme, phClr });

    test("phClr is the colour the theme carries, the entry's own transforms applied on top", () => {
        expect(color('<a:schemeClr val="phClr"/>', A_NS, referenced('#4472c4'))).toBe('#4472c4');
        expect(
            color('<a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr>', A_NS, referenced('#ffffff')),
        ).toBe(color('<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>'));
        expect(
            color('<a:schemeClr val="phClr"><a:lumMod val="50000"/></a:schemeClr>', A_NS, referenced('#808080')),
        ).toBe('#404040');
    });

    test("the placeholder's alpha is kept unless the entry sets its own", () => {
        expect(color('<a:schemeClr val="phClr"/>', A_NS, referenced('#4472c480'))).toBe('#4472c480');
        expect(
            color('<a:schemeClr val="phClr"><a:alpha val="25000"/></a:schemeClr>', A_NS, referenced('#4472c480')),
        ).toBe('#4472c440');
    });

    test('phClr names no slot: the map never reaches it, and a placeholder that is no colour gives nothing', () => {
        const mapped = { ...theme, map: new Map([...IDENTITY_COLOR_MAP, ['phClr', 'accent1']]) };
        expect(color('<a:schemeClr val="phClr"/>', A_NS, mapped)).toBeUndefined();
        expect(color('<a:schemeClr val="phClr"/>', A_NS, referenced('red'))).toBeUndefined();
        expect(color('<a:schemeClr val="accent2"/>', A_NS, referenced('#000000'))).toBe('#ed7d31');
    });
});

describe('a colour map', () => {
    test("reads a clrMap's slots over the identity, ignoring what names no slot", () => {
        const [clrMap] = xmlElements(read('<a:clrMap bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="nope"/>'));
        if (!clrMap) throw new Error('no clrMap');
        const map = readColorMap(clrMap);
        expect(map.get('bg1')).toBe('dk1');
        expect(map.get('tx1')).toBe('lt1');
        expect(map.get('accent1')).toBe('accent1');
        expect(map.get('accent2')).toBe('accent2');
    });
});

describe('the plain text of a text body', () => {
    test('one line per paragraph or break, runs and fields joined', () => {
        const body = read(
            '<a:bodyPr/><a:p><a:r><a:t>Sales</a:t></a:r><a:r><a:t> 2024</a:t></a:r></a:p><a:p><a:fld type="x"><a:t>Q1</a:t></a:fld><a:br/><a:r><a:t>line\nend</a:t></a:r></a:p><a:p/>',
        );
        expect(drawingLines(body)).toEqual(['Sales 2024', 'Q1', 'line end', '']);
    });
});
