import { escapeHtml } from '@workspace/lib/html';
import {
    borderInfoExtent,
    borderSidesToCss,
    type Cell,
    type CellBorderSides,
    type CellWithRowAndCol,
    type ConditionalFormatRule,
    type MergeCell,
    mergedBorderSides,
    type Sheet,
} from '@workspace/lib/sheets';
import { resolveWebLink } from '@workspace/lib/sheets/web-link';
import {
    booleanDisplay,
    type CellFormatStyle,
    type CellResolver,
    type ComputeMap,
    type ConditionalFormatFormulaEvaluator,
    createArrayResolver,
    type DataBar,
    evaluateConditionalFormat,
    FormulaEngine,
    functionCopy,
} from '@workspace/sheet/engine';
import { FONT_STACK_SANS } from '../font-stacks';
import { getFontCSS } from '../fonts';
import { sanitizeExportHtml } from '../sanitize';
import { resolveFontFamily } from './fonts';

// Sheet[] -> HTML: the full-workbook export document, the budgeted preview body and
// the fixed-size PDF document. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in export-document.ts). This
// module must not reach the Mount or the main-thread transform seam - the Worker
// imports it.

const DEFAULT_COL_WIDTH = 73;
const DEFAULT_ROW_HEIGHT = 19;
// Defaults applied to every td: inline in the preview so the markup renders without the
// document <head> CSS (preview embedders strip it), and as the shared td{} rule in the
// class-based export stylesheet. Vertical-align is intentionally absent — buildCellStyle
// always emits one (`middle`, `top`, `bottom`, …) so we never end up with two competing
// declarations for one cell.
const BASE_TD_STYLE = 'overflow:hidden;white-space:nowrap;padding:1px 2px';

const HORIZONTAL_ALIGN: Record<number, string> = {
    0: 'center',
    1: 'left',
    2: 'right',
};

const VERTICAL_ALIGN: Record<number, string> = {
    0: 'middle',
    1: 'top',
    2: 'bottom',
};

const PAGE_MARGIN = 40;
const PAGE_SLACK = 20;

// Full exports intern every emitted style into a class ("s0", "s1", …) declared in a
// body <style> element: a real workbook repeats a few hundred distinct styles across
// hundreds of thousands of cells, and DOMPurify/jsdom CSS-parses every inline style
// attribute it sanitizes (the 82MB/104s pathology) while class attributes and style-
// element text pass through as plain strings. Keys are the exact declaration strings
// the inline path would emit; values already went through escapeHtml at build time.
// The preview keeps inline styles — its body fragment embeds without a <head>.
type StyleRegistry = Map<string, string>;

function internStyle(styles: StyleRegistry, declarations: string): string {
    let cls = styles.get(declarations);
    if (cls === undefined) {
        cls = `s${styles.size}`;
        styles.set(declarations, cls);
    }
    return cls;
}

function styleAttr(styles: StyleRegistry | undefined, declarations: string): string {
    return styles ? `class="${internStyle(styles, declarations)}"` : `style="${declarations}"`;
}

// Cell values are schemaless CRDT strings, and in a stylesheet they sit in CSS text
// rather than in an HTML attribute — a context where different characters are
// structural and where HTML entities are never decoded. Every declaration reaches the
// document through here, so the whole class is closed at this one seam instead of per
// field: `<`/`>` end the <style> element (and DOMPurify keeps what follows — an
// <svg><image href> is a server-side fetch under WeasyPrint), `{`/`}` open and close
// rule blocks, `\` starts a CSS escape (which also hides `url(`/`@import` from the
// sanitizer's scan by spelling them `\75 rl(` / `@\69 mport`), and `/*` opens a comment
// that swallows every later rule. None of them can appear in a legitimate declaration.
const CSS_TEXT_STRUCTURAL = /[<>{}\\]|\/\*|\*\//g;

function serializeStyleRules(styles: StyleRegistry): string {
    const rules = [`td{${BASE_TD_STYLE}}`];
    for (const [declarations, cls] of styles) {
        rules.push(`.${cls}{${declarations.replace(CSS_TEXT_STRUCTURAL, '')}}`);
    }
    return rules.join('\n');
}

// A font-family quote must be a real `"` in stylesheet text and `&quot;` in a style
// attribute, where a literal `"` would close the attribute early and silently drop every
// later declaration. Both emitters ask here so the two never disagree.
function fontQuote(forStylesheet: boolean): string {
    return forStylesheet ? '"' : '&quot;';
}

// Dimensions are schemaless at the Yjs boundary — a collaborator can store a string.
// getSheetContentSize coerces for the same reason (its result reaches the @page rule);
// these reach the width/height declarations, so they get the same treatment at the
// source rather than relying on the structural strip above.
function cssLength(value: number | undefined, fallback: number): number {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? n : fallback;
}

// Runs inside the transform Worker (worker.ts owns execution; the format logic
// stays here in export/).
export function renderSheetsExportDocument(sheets: Sheet[], title: string): string {
    const { html, css } = renderSheetsHtml(sheets);
    // target isn't in DOMPurify's default allowlist; hyperlink anchors always pair
    // it with rel="noopener noreferrer", so letting it through is tabnabbing-safe.
    const sanitized = sanitizeExportHtml(`<style>${css}</style>\n${html}`, { ADD_ATTR: ['target'] });
    return wrapInDocument(title, sanitized);
}

// Runs inside the transform Worker. The page is sized to the widest/tallest sheet
// so WeasyPrint never clips a wide grid. Unlike the HTML export this sanitizes
// with no options — no `target` on anchors in a PDF.
export function renderSheetsPdfDocument(sheets: Sheet[], title: string): string {
    let maxW = 0;
    let maxH = 0;
    for (const sheet of sheets) {
        const size = getSheetContentSize(sheet);
        if (size.width > maxW) maxW = size.width;
        if (size.height > maxH) maxH = size.height;
    }

    const { html, css } = renderSheetsHtml(sheets);
    const sanitized = sanitizeExportHtml(`<style>${css}</style>\n${html}`);
    const pageSize = {
        width: maxW + 2 * PAGE_MARGIN + PAGE_SLACK,
        height: maxH + 2 * PAGE_MARGIN + PAGE_SLACK,
    };
    return wrapInDocument(title, sanitized, pageSize);
}

// Preview budget (proposal § Preview output budget): rendered from the top-left
// of the used range. maxCells is an independent ceiling so tuning rows/columns
// against fixtures can never silently remove the bound (at the defaults it never
// binds: 200 × 50 = 10,000).
export type SheetPreviewBudget = { maxRows: number; maxCols: number; maxCells: number };
export const PREVIEW_SHEET_BUDGET: SheetPreviewBudget = { maxRows: 200, maxCols: 50, maxCells: 10_000 };

// One engine + resolver per render, shared across sheets so cross-sheet refs in
// formula CF rules (e.g. `=Sheet2!A1>10`) resolve correctly. The resolver reads
// saved `cell.v` values from the snapshot — formulas are not recomputed, only the
// CF rule's own formula is evaluated against existing cell values.
function createRenderContext(sheets: Sheet[]): { engine: FormulaEngine; resolver: CellResolver } {
    const engine = new FormulaEngine();
    const resolver = createArrayResolver(
        sheets.map((s) => ({
            id: s.id ?? s.name,
            name: s.name,
            data: s.data ?? null,
            calculationChain: [],
            dynamicArrayCompute: [],
        })),
    );
    return { engine, resolver };
}

export function renderSheetsHtml(sheets: Sheet[]): { html: string; css: string } {
    const { engine, resolver } = createRenderContext(sheets);
    const styles: StyleRegistry = new Map();
    const html = sheets
        .map((sheet, i) => renderSheet(sheet, i === sheets.length - 1, engine, resolver, undefined, styles).html)
        .join('\n');
    return { html, css: serializeStyleRules(styles) };
}

// Preview is a glance, not a document — render only the first sheet, clipped to
// the hard row/column/cell budget, to keep the cached body small. The resolver
// still spans every sheet so cross-sheet CF formula refs resolve correctly.
// `truncated` is true whenever rows, columns, cells, or additional sheets were
// omitted — the caller appends the shared truncated marker.
export function renderSheetsPreviewHtml(sheets: Sheet[]): { html: string; truncated: boolean } {
    if (sheets.length === 0) return { html: '', truncated: false };
    const { engine, resolver } = createRenderContext(sheets);
    const first = renderSheet(sheets[0], true, engine, resolver, PREVIEW_SHEET_BUDGET);
    return { html: first.html, truncated: first.truncated || sheets.length > 1 };
}

// Builds the `evaluateFormula` callback for a single sheet's CF formula rules. The
// engine evaluates the rule's formula at each target cell with refs shifted by the
// offset from the rule's anchor — same shape as the state-side wiring in
// state/modules/condition-format.ts::getComputeMap.
function buildCfFormulaEvaluator(
    engine: FormulaEngine,
    resolver: CellResolver,
    sheetId: string,
): ConditionalFormatFormulaEvaluator {
    return (formula, anchorRow, anchorCol, targetRow, targetCol) => {
        const offsetRow = targetRow - anchorRow;
        const offsetCol = targetCol - anchorCol;
        let shifted = formula;
        if (offsetRow > 0) shifted = `=${functionCopy(shifted, 'down', offsetRow)}`;
        if (offsetCol > 0) shifted = `=${functionCopy(shifted, 'right', offsetCol)}`;
        return engine.evaluate(shifted, sheetId, anchorRow, anchorCol, resolver).value;
    };
}

// A formula rule keeps its range start: the anchor is the range's top-left, and the
// engine shifts relative refs by target-minus-anchor — moving the start would
// re-anchor the rule and recolor the visible cells. Targets evaluate independently,
// so end-clipping alone bounds the common case; the ceiling catches a range whose
// kept area is still enormous (content far below a rule anchored at the top).
const PREVIEW_CF_FORMULA_MAX_CELLS = 50_000;

// Preview only: a rule may name the whole sheet while the preview renders a small
// window, and the evaluator visits every coordinate of every range — a formula rule
// runs the engine once per visited cell. Clipping keeps that work proportional to
// what is rendered; a rule that misses the window (or trips the formula ceiling)
// drops out entirely.
function clipRulesToWindow(
    rules: ConditionalFormatRule[],
    firstRow: number,
    lastRow: number,
    firstCol: number,
    lastCol: number,
): ConditionalFormatRule[] {
    const clipped: ConditionalFormatRule[] = [];
    for (const rule of rules) {
        const keepStart = rule.type === 'default' && rule.conditionName === 'formula';
        const cellrange = rule.cellrange
            .map((range) => ({
                row: [keepStart ? range.row[0] : Math.max(range.row[0], firstRow), Math.min(range.row[1], lastRow)],
                column: [
                    keepStart ? range.column[0] : Math.max(range.column[0], firstCol),
                    Math.min(range.column[1], lastCol),
                ],
            }))
            .filter(
                (range) =>
                    range.row[0] <= range.row[1] &&
                    range.column[0] <= range.column[1] &&
                    (!keepStart ||
                        (range.row[1] - range.row[0] + 1) * (range.column[1] - range.column[0] + 1) <=
                            PREVIEW_CF_FORMULA_MAX_CELLS),
            );
        if (cellrange.length > 0) clipped.push({ ...rule, cellrange });
    }
    return clipped;
}

export function getSheetContentSize(sheet: Sheet): { width: number; height: number } {
    const config = sheet.config ?? {};
    const { minRow, minCol, maxRow, maxCol } = getGridBounds(sheet, config.borderInfo ?? {});
    if (maxRow < 0 || maxCol < 0) return { width: 0, height: 0 };

    // The dimension maps are schemaless at the Yjs boundary — coerce so a stray string can never
    // concatenate itself into the un-sanitized @page CSS that pdf.ts derives from this size.
    let width = 0;
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c]) continue;
        const w = Number(config.columnlen?.[c] ?? DEFAULT_COL_WIDTH);
        width += Number.isFinite(w) ? w : DEFAULT_COL_WIDTH;
    }

    let height = 0;
    for (let r = minRow; r <= maxRow; r++) {
        if (config.rowhidden?.[r]) continue;
        const h = Number(config.rowlen?.[r] ?? DEFAULT_ROW_HEIGHT);
        height += Number.isFinite(h) ? h : DEFAULT_ROW_HEIGHT;
    }

    return { width, height };
}

function renderSheet(
    sheet: Sheet,
    isLast: boolean,
    engine: FormulaEngine,
    resolver: CellResolver,
    budget?: SheetPreviewBudget,
    styles?: StyleRegistry,
): { html: string; truncated: boolean } {
    const config = sheet.config ?? {};
    const showGrid = sheet.showGridLines !== false && sheet.showGridLines !== 0;

    // Find the minimal bounding box containing all visible content
    const { minRow, minCol, maxRow, maxCol } = getGridBounds(sheet, config.borderInfo ?? {});
    if (maxRow < 0 || maxCol < 0) {
        return { html: `<div class="sheet"></div>`, truncated: false };
    }

    // The render window comes first: everything below is bounded by what is actually
    // rendered rather than by what the document declares (a merge or a CF range can
    // name millions of cells).
    let truncated = false;
    const renderCols: number[] = [];
    for (let c = minCol; c <= maxCol; c++) {
        if (config.colhidden?.[c]) continue;
        if (budget && renderCols.length >= budget.maxCols) {
            truncated = true;
            break;
        }
        renderCols.push(c);
    }

    const renderRows: number[] = [];
    let cellCount = 0;
    for (let r = minRow; r <= maxRow; r++) {
        if (config.rowhidden?.[r]) continue;
        if (budget && (renderRows.length >= budget.maxRows || cellCount + renderCols.length > budget.maxCells)) {
            truncated = true;
            break;
        }
        cellCount += renderCols.length;
        renderRows.push(r);
    }
    const lastRow = renderRows.at(-1) ?? -1;
    const lastCol = renderCols.at(-1) ?? -1;

    // A merge's perimeter sits on the master, the only cell this renderer emits for it. Bounded
    // to the render window so a merge beyond it (in preview, past the budget) is never expanded.
    const borderMap = mergedBorderSides(config.borderInfo, config.merge, [minRow, lastRow, minCol, lastCol]);

    // Conditional formatting — engine produces a "r_c" -> { textColor, cellColor, dataBar } map.
    // Evaluation needs the dense `data` matrix; loaded snapshots without it skip CF (the canvas
    // painter does the same fallback). Formula-based rules get a resolver-backed evaluator so
    // `=A1>10` style rules can fire server-side.
    const rules =
        budget && sheet.conditionalFormatRules
            ? clipRulesToWindow(sheet.conditionalFormatRules, minRow, lastRow, minCol, lastCol)
            : sheet.conditionalFormatRules;
    const cfMap: ComputeMap | null =
        rules && sheet.data
            ? evaluateConditionalFormat(rules, sheet.data, {
                  evaluateFormula: buildCfFormulaEvaluator(engine, resolver, sheet.id ?? sheet.name),
              })
            : null;

    // Merge lookup. Anchors are one entry per merge, but coverage is tested per rendered
    // row against the merge list: expanding every merge into a per-cell set first is an
    // allocation bomb, since one legal merge can span a million rows.
    const merges = config.merge ? Object.values(config.merge) : [];
    const mergeAnchors = new Map<string, MergeCell>();
    for (const m of merges) mergeAnchors.set(`${m.r},${m.c}`, m);

    // Build cell lookup: "r,c" -> CellWithRowAndCol
    const cellMap = new Map<string, CellWithRowAndCol>();
    if (sheet.celldata) {
        for (const cd of sheet.celldata) {
            cellMap.set(`${cd.r},${cd.c}`, cd);
        }
    }

    // Colgroup
    const cols: string[] = [];
    let tableWidth = 0;
    for (const c of renderCols) {
        const w = cssLength(config.columnlen?.[c], DEFAULT_COL_WIDTH);
        tableWidth += w;
        cols.push(`<col ${styleAttr(styles, `width:${w}px`)}>`);
    }
    const colgroup = `<colgroup>${cols.join('')}</colgroup>`;

    // Rows
    const rows: string[] = [];
    for (const r of renderRows) {
        const h = cssLength(config.rowlen?.[r], DEFAULT_ROW_HEIGHT);
        const cells: string[] = [];
        const rowMerges = merges.filter((m) => m.r <= r && r < m.r + m.rs);

        for (const c of renderCols) {
            const key = `${r},${c}`;

            // Skip cells covered by a merge anchored elsewhere
            if (rowMerges.some((m) => c >= m.c && c < m.c + m.cs && (m.r !== r || m.c !== c))) continue;

            const cd = cellMap.get(key);
            const v = cd?.v ?? null;
            const merge = mergeAnchors.get(key);
            const cfStyle = cfMap ? cfMap[`${r}_${c}`] : undefined;

            const attrs: string[] = [];
            if (merge) {
                // A span reaching past the window would claim table cells the preview
                // never emitted.
                const cs = budget ? Math.min(merge.cs, lastCol - c + 1) : merge.cs;
                const rs = budget ? Math.min(merge.rs, lastRow - r + 1) : merge.rs;
                if (cs !== merge.cs || rs !== merge.rs) truncated = true;
                if (cs > 1) attrs.push(`colspan="${cs}"`);
                if (rs > 1) attrs.push(`rowspan="${rs}"`);
            }

            const cellStyle = buildCellStyle(v, borderMap[`${r}_${c}`], showGrid, cfStyle, styles !== undefined);
            if (styles) {
                // The base td declarations live in the shared td{} rule; an unstyled
                // cell needs no class at all.
                if (cellStyle) attrs.push(styleAttr(styles, cellStyle));
            } else {
                attrs.push(`style="${cellStyle ? `${BASE_TD_STYLE};${cellStyle}` : BASE_TD_STYLE}"`);
            }

            // Webpage links render as anchors gated by the same scheme allowlist as
            // FE navigation; blocked schemes and internal sheet/cellrange links (no
            // meaningful target in standalone HTML) stay plain text.
            const link = sheet.hyperlink?.[`${r}_${c}`];
            const href = link?.linkType === 'webpage' ? resolveWebLink(link.linkAddress) : null;
            let display = getCellDisplay(v);
            if (href != null) {
                display = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${display}</a>`;
            }
            const dataBarLayer = cfStyle?.dataBar ? renderDataBar(cfStyle.dataBar, display, styles) : null;
            const inner = wrapForRotation(v, dataBarLayer ?? display, styles);
            const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            cells.push(`<td${attrStr}>${inner}</td>`);
        }

        rows.push(`<tr ${styleAttr(styles, `height:${h}px`)}>${cells.join('')}</tr>`);
    }

    // The .sheet div already carries a class, so the page-break style joins it as a
    // second class token rather than going through styleAttr.
    const divClass = isLast || !styles ? 'sheet' : `sheet ${internStyle(styles, 'page-break-after:always')}`;
    const pageBreak = isLast || styles ? '' : ' style="page-break-after:always"';
    const q = fontQuote(styles !== undefined);
    const tableStyle = `border-collapse:collapse;table-layout:fixed;font-family:${q}Inter${q},system-ui,sans-serif;font-size:11px;color:#1a1a2e;background:#fff;width:${tableWidth}px`;
    const html = `<div class="${divClass}"${pageBreak}>
<table ${styleAttr(styles, tableStyle)}>${colgroup}<tbody>${rows.join('')}</tbody></table>
</div>`;
    return { html, truncated };
}

function getCellDisplay(v: Cell | null): string {
    if (!v) return '';
    if (v.m != null) return escapeHtml(String(v.m));
    if (v.v == null) return '';
    if (typeof v.v === 'boolean') return booleanDisplay(v.v);
    return escapeHtml(String(v.v));
}

// Mirrors the dataBar geometry + colors from the canvas painter
// (packages/sheet/src/state/canvas.ts ~line 1660). For a "minus" entry the bar fills
// the negative half (left of the zero line); for "plus" it fills the positive half.
// Colors match canvas exactly: positive bars use `format` (user-configurable), negative
// bars use a hardcoded red — that's a long-standing canvas behavior, intentionally
// inherited here for visual parity. Diverging would mean the export differs from what
// users see on screen.
function renderDataBar(bar: DataBar, display: string, styles?: StyleRegistry): string {
    // Bar colors come from the schemaless rule format — escape like every other cell color.
    const from = escapeHtml(bar.format[0]);
    const to = bar.format.length > 1 ? escapeHtml(bar.format[1]) : '';
    let left: number;
    let width: number;
    let fill: string;
    if (bar.valueType === 'minus') {
        left = bar.minusLen * (1 - bar.valueLen) * 100;
        width = bar.minusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? 'linear-gradient(to right, #ffffff, #ff0000)' : '#ff0000';
    } else if (bar.plusLen === 1) {
        left = 0;
        width = bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    } else {
        // Mixed range, positive value: bar starts at the zero line (minusLen) and extends right.
        left = bar.minusLen * 100;
        width = bar.plusLen * bar.valueLen * 100;
        fill = bar.format.length > 1 ? `linear-gradient(to right, ${from}, ${to})` : from;
    }

    const barStyle = `position:absolute;top:0;left:${left}%;width:${width}%;height:100%;background:${fill};z-index:0`;
    return `<div ${styleAttr(styles, barStyle)}></div><span ${styleAttr(styles, 'position:relative;z-index:1')}>${display}</span>`;
}

function buildCellStyle(
    v: Cell | null,
    borders: CellBorderSides | undefined,
    showGrid: boolean,
    cfStyle: CellFormatStyle | undefined,
    forStylesheet: boolean,
): string {
    const parts: string[] = [];

    const rotated = isNumericRotation(v);

    if (v) {
        const family = resolveFontFamily(v.ff);
        // The name itself is escaped for its context too: entity-encoded in an attribute,
        // but in stylesheet text entities stay literal, so escapeHtml there would render
        // a font called "Bell MT & Co" as "Bell MT &amp; Co". Dropping the quote
        // characters is what a stylesheet actually needs — they are all that could end
        // the quoted value early, and the seam strips the CSS-structural rest.
        if (family) {
            const name = forStylesheet ? family.replace(/["'\\]/g, '') : escapeHtml(family);
            const q = fontQuote(forStylesheet);
            parts.push(`font-family:${q}${name}${q},sans-serif`);
        }
        if (v.bl === 1) parts.push('font-weight:bold');
        if (v.it === 1) parts.push('font-style:italic');
        if (typeof v.fs === 'number') parts.push(`font-size:${v.fs}pt`);
        // CF colors override the static `fc`/`bg` fields, matching the canvas painter. Every
        // color is escaped (like font-family above) — schemaless cell strings must not break
        // out of the style="…" attribute.
        if (cfStyle?.textColor) {
            parts.push(`color:${escapeHtml(cfStyle.textColor)}`);
        } else if (v.fc) {
            parts.push(`color:${escapeHtml(v.fc)}`);
        }
        if (cfStyle?.cellColor) {
            parts.push(`background:${escapeHtml(cfStyle.cellColor)}`);
        } else if (v.bg) {
            parts.push(`background:${escapeHtml(v.bg)}`);
        }
        // Rotated cells skip ht/vt — the rotated span is absolutely-positioned in the
        // cell (see wrapForRotation) so neither alignment property has anything to act
        // on. Non-rotated cells emit text-align if the user picked one, plus a single
        // vertical-align (default `middle`, matching the canvas painter).
        if (!rotated) {
            if (v.ht != null && v.ht in HORIZONTAL_ALIGN) parts.push(`text-align:${HORIZONTAL_ALIGN[v.ht]}`);
            const valign = v.vt != null && v.vt in VERTICAL_ALIGN ? VERTICAL_ALIGN[v.vt] : 'middle';
            parts.push(`vertical-align:${valign}`);
        }
        if (v.tb === '2') parts.push('white-space:pre-wrap;word-wrap:break-word');
        if (v.un === 1 && v.cl === 1) {
            parts.push('text-decoration:underline line-through');
        } else if (v.un === 1) {
            parts.push('text-decoration:underline');
        } else if (v.cl === 1) {
            parts.push('text-decoration:line-through');
        }
    } else if (cfStyle) {
        // CF can land on a cell with no `v` (engine still emits an entry for empty cells in some
        // rules); render its color overrides without dragging in the v-block defaults.
        if (cfStyle.textColor) parts.push(`color:${escapeHtml(cfStyle.textColor)}`);
        if (cfStyle.cellColor) parts.push(`background:${escapeHtml(cfStyle.cellColor)}`);
    }

    if (borders) {
        // CSS has no diagonal border, so the slash side `s` is not rendered.
        parts.push(...borderSidesToCss(borders, escapeHtml));
    } else if (showGrid) {
        parts.push('border:1px solid #d4d4d4');
    }

    // `position:relative` is the cell's contribution to two unrelated overlay patterns:
    // the absolutely-positioned data-bar div from renderDataBar() and the rotated span
    // from wrapForRotation(). One declaration covers both.
    if (rotated || cfStyle?.dataBar) {
        parts.push('position:relative');
    }

    return parts.join(';');
}

function isNumericRotation(v: Cell | null): v is Cell & { rt: number } {
    return !!v && typeof v.rt === 'number' && v.rt !== 0 && v.rt >= -90 && v.rt <= 90;
}

// Render the cell's content with rotation applied. The td has `position:relative` (set in
// buildCellStyle), so the span anchors itself absolutely at the cell corner the rotation
// pivots around — no inline-flow / vertical-align gymnastics, no zero-height wrapper.
//
// Geometry mirrors the canvas painter (text.ts ~line 1692). Three pieces:
//
//   1. Anchor: positive rt (CCW / "up") pins to left+bottom; negative rt (CW / "down")
//      pins to left+top. transform-origin matches the same corner so the pivot stays
//      exactly on the cell edge.
//
//   2. Rotation: CSS `rotate()` is CW-positive while our `rt` is CCW-positive (matching
//      Excel/OOXML), so the emitted angle is negated.
//
//   3. Counter-translation: rotating around a corner makes the character tops (positive
//      rt) or character bottoms (negative rt) swing past the cell's left edge — at
//      rt = ±90 the whole rotated bbox sits OUTSIDE the cell and `overflow:hidden`
//      eats it. Canvas adds a `textHeight * sin(rt)` rightward offset to the pivot for
//      the same reason; in CSS we get the same effect with `translateX(|sin(rt)| em)`
//      applied AFTER rotation (the transform reads right-to-left). 1em ≈ font-size ≈
//      canvas's textHeight, so the offset scales naturally with the cell's font.
//
// `rt: 'vertical'` uses CSS writing-mode for stacked top-to-bottom characters; the span
// flows naturally without absolute positioning since writing-mode handles the layout.
function wrapForRotation(v: Cell | null, inner: string, styles?: StyleRegistry): string {
    if (!v || v.rt == null) return inner;
    if (v.rt === 'vertical') {
        return `<span ${styleAttr(styles, 'writing-mode:vertical-rl;text-orientation:upright')}>${inner}</span>`;
    }
    if (isNumericRotation(v)) {
        const { rt } = v;
        const cssAngle = -rt;
        const yPin = rt > 0 ? 'bottom:0' : 'top:0';
        const origin = rt > 0 ? 'left bottom' : 'left top';
        const overhangEm = Math.abs(Math.sin((rt * Math.PI) / 180)).toFixed(3);
        const decl =
            `position:absolute;left:0;${yPin};display:inline-block;white-space:nowrap;` +
            `transform-origin:${origin};transform:translateX(${overhangEm}em) rotate(${cssAngle}deg)`;
        return `<span ${styleAttr(styles, decl)}>${inner}</span>`;
    }
    return inner;
}

function hasVisibleContent(v: Cell | null): boolean {
    if (!v) return false;
    if (v.v != null || v.m != null) return true;
    if (v.bg || v.fc) return true;
    if (v.bl === 1 || v.it === 1 || v.un === 1 || v.cl === 1) return true;
    if (v.mc && 'rs' in v.mc) return true; // merge anchor
    return false;
}

function getGridBounds(
    sheet: Sheet,
    borderInfo: Record<string, CellBorderSides>,
): { minRow: number; minCol: number; maxRow: number; maxCol: number } {
    let minRow = Number.MAX_SAFE_INTEGER;
    let minCol = Number.MAX_SAFE_INTEGER;
    let maxRow = -1;
    let maxCol = -1;

    if (sheet.celldata) {
        for (const { r, c, v } of sheet.celldata) {
            if (!hasVisibleContent(v)) continue;
            if (r < minRow) minRow = r;
            if (c < minCol) minCol = c;
            if (r > maxRow) maxRow = r;
            if (c > maxCol) maxCol = c;
        }
    }

    // Extend bounds to cover border cells (raw keys — folding only ever drops keys onto masters).
    const be = borderInfoExtent(borderInfo);
    if (be.minRow < minRow) minRow = be.minRow;
    if (be.minCol < minCol) minCol = be.minCol;
    if (be.maxRow > maxRow) maxRow = be.maxRow;
    if (be.maxCol > maxCol) maxCol = be.maxCol;

    // Extend bounds to cover merge ranges
    if (sheet.config?.merge) {
        for (const m of Object.values(sheet.config.merge)) {
            if (m.r < minRow) minRow = m.r;
            if (m.c < minCol) minCol = m.c;
            const endRow = m.r + m.rs - 1;
            const endCol = m.c + m.cs - 1;
            if (endRow > maxRow) maxRow = endRow;
            if (endCol > maxCol) maxCol = endCol;
        }
    }

    if (maxRow < 0) return { minRow: 0, minCol: 0, maxRow: -1, maxCol: -1 };
    return { minRow, minCol, maxRow, maxCol };
}

function wrapInDocument(title: string, bodyHtml: string, pageSize?: { width: number; height: number }): string {
    const pageCSS = pageSize
        ? `@page { size: ${pageSize.width}px ${pageSize.height}px; margin: 40px; }`
        : '@page { size: landscape; margin: 1.5cm; }';
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>${getFontCSS()}${SHEET_CSS_BASE}${pageCSS}${SHEET_CSS_PRINT}</style>
</head>
<body>
    ${bodyHtml}
</body>
</html>`;
}

const SHEET_CSS_BASE = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: ${FONT_STACK_SANS};
    font-size: 11px;
    color: #1a1a2e;
    background: #fff;
    margin: 0;
    padding: 2rem;
}

.sheet {
    margin-bottom: 2rem;
}
`;

const SHEET_CSS_PRINT = `
@media print {
    body { padding: 0; background: #fff; }
    .sheet { margin-bottom: 0; }
}
`;
