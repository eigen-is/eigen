# ooxml

ooxml is the Office Open XML core that Eigen's docx, xlsx and pptx readers and writers run on. It opens a zip from an untrusted upload, reads it as an OPC package and parses its parts under one budget. It knows the vocabulary the three formats share: namespaces, markup compatibility, units, DrawingML colours and themes, and charts. It also writes: a zip that is the same bytes for the same input, a package with its content types and relationships, a plain theme and a chart part. Each format's own vocabulary has a module here too, so a format's reader and writer share one source of truth without importing each other. The format readers and writers live outside this folder and build on it.

## What it reads and writes

| | Reads | Writes |
|---|---|---|
| Zip | Stored and deflated entries, ZIP64, one disk | Stored and deflated entries, no ZIP64 |
| Package | `[Content_Types].xml`, relationships, parts, media | `[Content_Types].xml`, `_rels/.rels`, `docProps/core.xml`, a part's relationships |
| XML | Transitional and Strict OOXML, `mc:AlternateContent` | Nothing: writers build their XML as strings |
| DrawingML | Colours with their transforms, themes, colour maps, blips, text bodies | Colours, fills, a plain theme, blips |
| Charts | A `c:chartSpace` as a `ChartSpec` and its look | A `ChartSpec` as a `c:chartSpace`, and the sheet of its embedded workbook |

## Layering

Each module imports only from the layers before it, with one exception: `opc.ts` parses parts with `parseOoxml` and names them with the namespaces of `ooxml.ts`, which imports nothing else from this folder.

1. `zip.ts`: bytes to entries and back.
2. `opc.ts`: entries as a package: content types, relationships, parts parsed once under a budget. `budget.ts` is the counter it charges.
3. `ooxml.ts`: the XML every format shares: namespaces, `parseOoxml`, markup compatibility, units, on/off values.
4. `drawingml.ts`, and the format vocabularies `wordml.ts`, `spreadsheetml.ts` and `presentationml.ts`.
5. `ooxml-chart.ts` reads a chart part, and `ooxml-chart-writer.ts` writes one.

The XML parser itself is `parseXml` in `../core/xml.ts`, which this folder calls through `parseOoxml`.

## Quick start

Each example runs as written from this folder: save it anywhere and run `bun -e "$(cat example.ts)"` with this folder as the working directory. The output below is pasted from real runs.

### Open a package and read a part

```ts
import { xmlChild, xmlText } from '../core/xml';
import { W_NS } from './ooxml';
import { openPackage, relOfType, writePackage } from './opc';
import { WML } from './wordml';

const bytes = writePackage({
    main: 'word/document.xml',
    title: 'Hello',
    defaults: {},
    parts: [
        [
            'word/document.xml',
            `<w:document xmlns:w="${W_NS}"><w:body><w:p><w:r><w:t>Hello, package</w:t></w:r></w:p></w:body></w:document>`,
            `${WML}.document.main+xml`,
        ],
    ],
    files: [],
});

const pkg = openPackage(bytes, { passwordProtected: 'Remove the password first', tooLarge: 'Too large to import' });
const main = relOfType(pkg.relationships(''), 'officeDocument') ?? '';
console.log(pkg.zip.names());
console.log(main, pkg.contentTypeOf(main));

let element = pkg.part(main);
for (const local of ['body', 'p', 'r', 't']) element = element && xmlChild(element, W_NS, local);
console.log(element && xmlText(element));
```

```
[ "[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/document.xml" ]
word/document.xml application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml
Hello, package
```

### Write a chart part

```ts
import { defaultChartSpec, FLAT_CHART_LOOK } from '@workspace/lib/charts';
import { EMU_PER_PX } from './ooxml';
import { writeChart } from './ooxml-chart-writer';

const spec = defaultChartSpec('column', {
    source: 'inline',
    categories: ['Q1', 'Q2', 'Q3'],
    series: [{ id: 'sales', name: 'Sales', values: [12, 19, 7] }],
});
const xml = writeChart(spec, { look: FLAT_CHART_LOOK, frame: { width: 480, height: 300, emuPerPx: EMU_PER_PX } });
console.log(xml.length);
console.log(xml.match(/<c:barChart>.*?<c:ser>/)?.[0]);
await Bun.write('/tmp/chart1.xml', xml);
```

```
2552
<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser>
```

### Read a chart

This reads back the part the previous example wrote, then a scatter chart, which the spec can't draw.

```ts
import { NO_DRAWING_THEME } from './drawingml';
import { C_NS, parseOoxml } from './ooxml';
import { readChart, readChartPartLook } from './ooxml-chart';

const root = parseOoxml(await Bun.file('/tmp/chart1.xml').text());
if (!root) throw new Error('empty part');
const read = readChart(root, { theme: NO_DRAWING_THEME, data: 'cache' });
if ('spec' in read) console.log(read.spec.chart.type, JSON.stringify(read.spec.data));
console.log(readChartPartLook(root, { theme: NO_DRAWING_THEME, emuPerPx: 9525, host: 'xlsx' }));

const scatter = parseOoxml(
    `<c:chartSpace xmlns:c="${C_NS}"><c:chart><c:plotArea><c:scatterChart>` +
        '<c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/></c:ser>' +
        '</c:scatterChart></c:plotArea></c:chart></c:chartSpace>',
);
if (scatter) console.log(readChart(scatter, { theme: NO_DRAWING_THEME, data: 'cache' }));
```

```
column {"source":"inline","categories":["Q1","Q2","Q3"],"series":[{"id":"x-0","name":"Sales","values":[12,19,7]}]}
{
  fill: "{\"type\":\"solid\",\"color\":\"transparent\",\"style\":\"solid\"}",
  color: "#202124",
  strokeWidth: 2,
  strokeColor: "#757575",
}
{
  unsupported: {
    title: "",
    name: "Scatter with Straight Lines and Markers",
  },
}
```

The series id comes back as `x-0`: a part without a `c16:uniqueId` gives its series ids by place.

## Public API

Signatures are as the code declares them. Types the signatures name but the module keeps private, such as `ChartFrame`, are described where they are used.

### zip.ts

- `openZip(bytes: Uint8Array): ZipReader`: reads the directory and checks it. It inflates nothing.
- `ZipReader`: `names(): string[]`, `entry(name: string): ZipEntry | undefined` (name, method, CRC-32 and sizes), `read(name: string): Uint8Array | undefined`, which inflates and checks one entry.
- `ZipError`: every refusal of `openZip` and `read`, with its `code: ZipErrorCode`. It is an `ApiError`: 413 past a cap, 400 otherwise.
- `writeZip(files: Iterable<ZipWriteEntry>): Uint8Array`: `ZipWriteEntry` is `{ name, data, store? }`, where `data` is bytes, a string, or a function yielding chunks.
- `MAX_ZIP_ENTRIES`, `MAX_DECOMPRESSED_BYTES`: the reader's caps.

### opc.ts

- `openPackage(bytes: Uint8Array, messages: PackageMessages): OoxmlPackage`: `messages` is `{ passwordProtected, tooLarge }`, the format's words for its two refusals.
- `OoxmlPackage`: `zip`, `part(path)`, `relationships(partPath)` (`''` for the package's own), `contentTypeOf(path)`, `readMedia(path)`.
- `Part`: `{ path, root, rels }`, a parsed part with its relationships. `Relationship`: `{ type, target, external? }`.
- `relsPathOf(partPath: string): string`, `relationshipsOf(root: XmlElement | undefined, partPath: string): Map<string, Relationship>`.
- `relOfType(rels: ReadonlyMap<string, Relationship>, type: string): string | undefined`, `relTarget(rels: ReadonlyMap<string, Relationship>, id: string | undefined, type: string): string | undefined`: a type is matched by its last segment.
- `optional<T>(read: () => T): T | undefined`: a damaged part is `undefined`. The budget and an out-of-memory still throw.
- `isEncryptedPackage(bytes: Uint8Array): boolean`, `tagsIn(data: Uint8Array): number`.
- `MAX_PACKAGE_XML_BYTES`, `MAX_PACKAGE_XML_TAGS`: the package's parse budget.
- `writePackage({ main, title, defaults, parts, files })`: `parts` are `PackagePart`s, `[path, xml, contentType?]`, with the XML whole or as chunks. `files` are written as given.
- `relationshipsXml(relationships: Relationship[]): string`, `partRelationships(): PartRelationships`: `relate(type, target, external?)` returns the same `rId` for the same type and target.
- `uriReference(href: string): string`: a relationship target with what a URI can't hold percent-encoded.

### budget.ts

- `budget(limit: number, tooLarge: string): Budget`: `charge(units)` throws a 413 past the limit, and for NaN, an infinity or a negative amount. `affords(units)` asks without charging. `spend(units)` charges only when what is left covers it.

### ooxml.ts

- Namespaces: `W_NS`, `R_NS`, `A_NS`, `C_NS`, `SML_NS`, `P_NS`, `MC_NS` and the rest, one constant each.
- `parseOoxml(input: string | Uint8Array): XmlElement | null`: parses with Strict namespaces read as transitional.
- `alternativeFor(understood: ReadonlySet<string>)`, `isAlternateContent(element)`, `ooxmlElements(element, alternative)`, `ooxmlChild(element, ns, local, alternative)`: markup compatibility.
- `EMU_PER_PX`, `EMU_PER_POINT`, `POINTS_PER_UNIT`.
- `emu(value: string | undefined): number | undefined`, `measure(value: string | undefined, perPoint: number): number | undefined`.
- `isOn(value: string | undefined): boolean | undefined`, `isOnElement(element: XmlElement | undefined, ns = ''): boolean | undefined`.

### drawingml.ts

- `DrawingTheme`: `{ scheme, map, phClr? }`. `NO_DRAWING_THEME`, `IDENTITY_COLOR_MAP`, `SCHEME_SLOTS`.
- `readColorScheme(theme)`, `readColorMap(element)`, `drawingTheme(theme)`.
- `drawingColor(fill: XmlElement | undefined, theme: DrawingTheme): string | undefined`: `#rrggbb`, or `#rrggbbaa` when not opaque.
- `percent(value)`, `DEGREE`, `HUNDRED_PERCENT`.
- `colorXml(color, opacity = 1)`, `solidFillXml(color, opacity = 1)`, `themeXml(font)`, `THEME_TYPE`.
- `blipXml(rId, svgRId, effects = '')`, `blipEmbeds(blip)`, `IMAGE_EXTENSION_BY_MIME`, `MIME_ALIASES`.
- `ALGN_BY_ALIGN`, `ALIGN_BY_ALGN`, `ANCHOR_BY_ALIGN`, `ALIGN_BY_ANCHOR`, `LINE_END_BY_ARROWHEAD`, `ARROWHEAD_BY_LINE_END`, `PRESET_DASH_BY_STYLE`, `strokeStyleOf(dash)`.
- `drawingLines(body: XmlElement): string[]`: a text body's plain text, a line per paragraph and break.
- `isSideways(degrees)`, `anchoredBox(box: Box, degrees: number): Box`.

### ooxml-chart.ts

- `chartPart(pkg, rels, id, folder): XmlElement | undefined`: the chart part an r:id names, or nothing.
- `chartCost(root: XmlElement): number`: what to charge before `readChart`.
- `readChart(root, { theme, data }): ChartRead`: `data` is `'cache'` or `{ ranges: (sheetName) => sheetId | undefined }`. The result is `{ spec }` or `{ unsupported: { title, name } }`.
- `readChartPartLook(root, { theme, emuPerPx, host }): Pick<ChartLook, …>`: the background, label colour, stroke and line series width.
- `droppedChart({ title, name }): string[]`, `CHART_NOT_IMPORTED`: what a format shows in place of an unsupported chart.
- `CHART_CONTENT_TYPE`, `STACKING_BY_GROUPING`, `LEGEND_BY_POSITION`, `PERCENT_AXIS_FORMAT`, `ChartHost`.

### ooxml-chart-writer.ts

- `writeChart(spec: ChartSpec, options: ChartWriteOptions): string`: `options` holds the `look`, the `frame` (`{ width, height, emuPerPx }`, the box Eigen lays the chart out in), and for range data `ranges` and `cache`. For an embedded workbook it also holds `workbook`, the r:id of the workbook.
- `addChartPart(parts, spec, options): string`: adds a numbered chart part to an xlsx and returns its r:id.
- `chartGraphicXml(rId: string): string`: the `a:graphic` a host frame shows the chart with.
- `embeddedChartSheet(spec: ChartSpec): Sheet | undefined`: the sheet of a docx's or pptx's embedded workbook.
- `chartLookSimplified(look, layer?): boolean`: whether the part draws the look plainer than Eigen does.

### wordml.ts, spreadsheetml.ts, presentationml.ts

Constants and small functions of one format each, such as `STYLE_NAMES`, `spellNumber`, `BUILTIN_NUMBER_FORMATS`, `withFuturePrefixes`, `SLIDE_TYPE` and `MAX_SLIDE_EMU`. Each module's header lists what it holds.

## Safety model for untrusted files

An upload is hostile until proven otherwise. Every bound below holds before the work it bounds, not after.

The zip:

- `openZip` refuses more than `MAX_ZIP_ENTRIES` (10,000) entries, and a declared total past `MAX_DECOMPRESSED_BYTES` (200 MiB), before it inflates anything.
- `read` inflates an entry no further than its declared size, then checks the length and the CRC-32. So a directory that lies about a size is refused too.
- It refuses what other readers would read differently: a second end record, an end-record signature after the end, ZIP64 fields that disagree with the plain ones, bytes before the first entry, overlapping or duplicate entries, a local name that differs from the directory's, more than one disk, encryption and any method but stored and deflate.
- Names are kept verbatim and found only by their exact name, so `../` or a backslash never aliases another entry.
- Every refusal is a `ZipError`: a 413 past a cap and a 400 otherwise. Its message never names an entry.

The package:

- `openPackage` refuses an encrypted package with a 400 in the format's words, which name the application that removes the password.
- Every part it parses, `[Content_Types].xml` and the relationships parts included, is charged against one budget per package. A part's declared size is charged against `MAX_PACKAGE_XML_BYTES` (32 MiB) before it is inflated, and its tags against `MAX_PACKAGE_XML_TAGS` (1,500,000) before it is parsed. Past either, the whole file is a 413 in the format's words.
- A part is parsed once. A part that failed keeps its error, so asking again costs nothing.
- `optional` lets a damaged part cost only what it adds. It never swallows the budget's 413 or an out-of-memory.
- A relationship target resolves `.` and `..` against its source part, never above the package root. So no `..` survives for a format's prefix check to miss. An External target is kept as written, and `relOfType` and `relTarget` never follow one.

The XML:

- `parseXml` refuses a DOCTYPE, so no entity expands, and refuses a tree nested too deep.
- `emu` and `measure` ignore a value longer than 64 characters unread.

Budgets and charts:

- `budget()` is the counter every reader uses for its own caps: `charge` for work a file can't be read without, `spend` for work that may be left out, such as a chart.
- A reader charges `chartCost(root)` before `readChart`. `readChart` checks the series count against `MAX_CHART_SERIES` (32) and each cache's point count against `MAX_CHART_POINTS` (2,000) before it builds anything.
- A chart's line width outside ST_LineWidth's 0 to 20,116,800 EMU reads as the automatic width.
- `chartPart` reads a chart only through a chart relationship, under the format's charts folder, and only when it has the chart content type.

Past all of these, the transform process's memory limit is the backstop. Inflating and parsing are synchronous, so the readers run in that process rather than on the server's main thread.

## What it does not do

- It never streams a part's XML: a part is parsed whole. The xlsx reader parses a sheet's grid in batches itself, outside this folder.
- It doesn't decrypt a package, verify a signature or read macros.
- It doesn't write ZIP64, so an archive past 4 GB or 65,534 entries throws.
- It doesn't validate parts against the schemas. A reader takes what it understands and leaves the rest.
- It finds a part's entry in the zip by its exact name. Only content types compare part names as OPC does, decoded and case-insensitively.
- DrawingML colour transforms beyond alpha, lumMod, lumOff, satMod, tint and shade are ignored.
- A chart is read only when the spec draws it as the file does: a column, bar, line or pie chart with one group, at most one category and one value axis, and no stacked line, log scale or reversed value axis. Excel 2016's chartEx parts are not read.
- It renders nothing.

## Tests

The tests live in `apps/api/src/test/ooxml/`, a file per module. Run them from `apps/api`:

```
bun test --preload ./src/test/preload.ts ./src/test/ooxml
```

The format readers and writers have their own tests under `src/test/import/` and `src/test/export/`. Round trips over real corpora run through `src/scripts/xlsx-audit.ts`, `docx-audit.ts` and `pptx-audit.ts`.

## Further reading

- [EXPORT.md](../../../../../docs/EXPORT.md): the Office writers and readers, and the zip guards.
- [DOCUMENT-TRANSFORMS.md](../../../../../docs/DOCUMENT-TRANSFORMS.md): the transform process and the package's parse budget.
- [CHARTS.md](../../../../../docs/CHARTS.md): how a chart goes to Office and comes back.
- [ARCHITECTURE.md](../../../../../docs/ARCHITECTURE.md): where each module sits among the rest of the server.
