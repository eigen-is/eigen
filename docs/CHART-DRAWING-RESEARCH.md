# How mature chart libraries lay out and draw a chart

Sources: the checkouts and full blobless histories of apache/echarts (with ecomfe/zrender, its renderer), chartjs/Chart.js, plotly/plotly.js, vega/vega-lite (with vega/vega, where the drawing happens) and highcharts/highcharts in `/tmp/chart-libs/`, a sparse clone of LibreOffice core (`chart2/`, `oox/source/drawingml/chart/`), and Excel as ECMA-376 Part 1 §21.2, the Excel-written test files in LibreOffice's `chart2/qa/extras/data` and Microsoft's support pages document it. Google Sheets is cited from the Google Charts gallery docs, since Sheets draws through the same engine. Commit hashes are from those clones; "LO" is LibreOffice. Nothing was run in the libraries. Eigen's layout was run on generated inputs to test the claims made here about it. The chart-spec research, kept outside git, studied the same libraries' stored models; this one studies how they draw.

Eigen's drawing is one pure function, `layoutChart` (`packages/lib/src/charts/layout.ts`), which returns canvas elements and text lines in the box's coordinates, and one painter, `renderChartSvg`/`renderChartSpecSvg` (`packages/lib/src/vector/kinds/chart-render.ts`), which writes them as SVG through each shape's own kind. Ticks are `packages/lib/src/charts/ticks.ts`, text widths `packages/lib/src/vector/text-width.ts`, the look `packages/lib/src/charts/look.ts`. [CHARTS.md](CHARTS.md) describes it; [CHARTS-TODO.md](CHARTS-TODO.md) lists the kinds still to draw.

## 1. Plot area and legend layout

| Library | How the plot rect is found | Legend overflow |
|---|---|---|
| ECharts | `grid` is a fixed inset of the container (master: left 15%, top 65, right 10%, bottom 80); title and legend never shrink it. v6 `outerBounds` (`src/coord/cartesian/Grid.ts` `layOutGridByOuterBounds`) estimates axis-label and axis-name rects once and shrinks the grid by the overflow, clamped to 25% a side; one pass, not iterated | `type: 'scroll'` pages with arrows (`ScrollableLegendView.ts`); plain legend wraps (`util/layout.ts` `boxLayout`), no truncation |
| Chart.js | box layout (`src/core/core.layouts.js` `fitBoxes`): full-size boxes, then vertical, then horizontal, then vertical again if the height changed; each box re-fits when its own size changes; scale overhang feeds the padding (`autoPadding`) | wraps rows (`_fitRows`) or columns (`_fitCols`) up to `maxWidth`/`maxHeight`, then simply clips |
| Plotly | fixed default margins (l80 r80 t100 b80); components push margins (`plots/plots.js` `autoMargin`, `doAutoMargin`) and the whole plot redraws until margins settle, capped at `3 * (1 + nPushIds)` redraws | scrollbox past `_maxHeight` (`components/legend/draw.js`); horizontal legends wrap into a grid of `maxItemWidth` slots |
| Vega | `autosize: 'pad'` by default: the plot keeps its size and the view grows by the axes', legends' and title's overhangs (`vega-view-transforms/src/ViewLayout.js`); `fit` subtracts them instead | legends gridded by orient; labels cut at `labelLimit` 160 px |
| Highcharts | `spacing` [10,10,15,10]; `getMargins` reserves title and legend; `getAxisMargins` adds axis offsets; `render` reruns tick choice while the plot shrank by over 10% (5% vertically), at most `axisLayoutRuns` (2) times (`ts/Core/Chart/Chart.ts`) | pages with 12 px arrows past `maxHeight` (`Legend.ts` `handleOverflow`); `alignColumns` grids a wrapped horizontal legend |
| LO | `ChartView.cxx`: title, legend and axis titles each take from `maRemainingSpace`, then the diagram is sized with its longest labels, autoscaled again (tick count depends on label size) and re-adjusted after labels wrap | `VLegend.cxx`: rows × columns by expansion; a single entry left is cut with "..."; entries past the room are dropped with no count |
| Excel | `c:manualLayout` (`layoutTarget` inner or outer, `xMode` edge or factor) when stored; otherwise Office's own; 2013+ writes `c:legendPos b` | not specified |

History:

- Every library moved from fixed margins to measured ones, and every one bounded the loop that measuring causes. Plotly's automargin (1.35.0, #2243) looped forever until 1.48.0 (#3811) and got a hard cap in 1.50.0 (`631014a16`, 2019-09-24, "Add (large) upper bound on the number of redraw calls", issue #2704). 2.x then threw away the last adjustment when the cap hit (`0594ed47b`, 2020-10-20). Highcharts added the same cap as `overheatProtector` (`793470555c`, 2023-11-10, #19794), now `axisLayoutRuns`. ECharts' v6 `outerBounds` (`f75a6031`, `0009d457`, 2025) is one pass by design and deprecated `containLabel` (2015, `b03a1c99`), which subtracted the union of label rects without a second look.
- Chart.js reworked its fitting four times (`db6a6d59` 2019, `7a2acebc` 2020 "negative chartArea rejected", `bc8385e6` 2021 refit, `47d4b048` 2021 stacked boxes). The 2020 fix exists because a narrow chart produced a negative plot area.
- Legends: Highcharts paged since 2.2.5 (`eafc186b11`, 2012); ECharts added scroll in 3.7.0 (`aeab552e`, 2017); Plotly's horizontal legend wrapped in 1.16.0 (#786) and moved overflowed items to a new row in 1.46.0 (#3628). LO cut the last entry with an ellipsis for tdf#150434 (`e59db22b3b`, 2022).

Eigen: one pass, top down, never revisited (`layoutChart`, `layout.ts:98`). `placeTitle` (`layout.ts:209`) takes a line at 1.3× the base size, `placeLegend` (`layout.ts:221`) a row block (at most 30% of the height, `LABEL_SHARE`) or a column (30% of the width), and `layoutCartesian` (`layout.ts:317`) sizes the plot from its labels: the bar chart's value axis is the one loop (ticks thinned until labels stop touching, `layout.ts:370`), the column chart estimates the tick count from one line of category labels before it knows whether they turn. A legend past its room drops entries and ends with "+N", which no library does: they page (interactive) or drop silently (LO). For a static SVG that has to print, Eigen's choice is the right one. The side legend computes `items.slice(0, fits - 1)` (`layout.ts:293`), which keeps all but one item when `fits` is 0; that frame is always too small for a plot, so the message replaces it and nothing wrong draws.

## 2. Text measuring and fit

| Library | Measuring | Fit |
|---|---|---|
| ECharts | canvas `measureText` on one shared context with LRU caches per font (zrender `src/contain/text.ts`); without a canvas (SSR, node) a built-in table of advances for ASCII 32–126 measured at 12 px sans-serif, everything else one em (zrender `165dcdc`, 2021) | `overflow: 'truncate' | 'break' | 'breakAll'`, ellipsis `'...'`, `lineOverflow: 'truncate'` (`parseText.ts` `truncateText2`) |
| Chart.js | `ctx.measureText` cached per font with a half-eviction gc (`helpers.canvas.ts` `_measureText`, `_longestText`); measures a sample of tick labels (`sampleSize`) | none: no truncation or ellipsis anywhere; multi-line labels by array |
| Plotly | clones the node into a hidden SVG tester and reads `getBoundingClientRect` (`components/drawing/index.js` `bBox`), cached by text and style, wiped at 10,000 | `uniformtext` shrinks or hides bar text to one size; bar text `textposition: 'auto'` goes inside only if it fits |
| Vega | canvas `measureText` with an LRU, else an estimate `0.8 × fontSize × length` (`vega-scenegraph/src/util/text.js`); a user `textMetrics.width` wins (`ddd151a3`, 2023) | binary-search truncation to `limit` with `'…'`; baselines computed, not left to the renderer (top 0.79 h, middle 0.30 h) |
| Highcharts | DOM `getBBox`, cached by the text with every digit turned to `0` (#5899), 250 keys (`SVGElement.ts`); `fontMetrics` derives line height and baseline from the size alone | `TextBuilder`: word wrap, `textOverflow: 'ellipsis'` by binary search on `getSubStringLength`, `lineClamp` |
| LO | EditEngine on a reference device in 1/100 mm; text shapes auto-grow up to a max frame width and wrap | `TextBreak` on category labels (`VCartesianAxis::isBreakOfLabelsAllowed`) at the tick spacing minus 5% |

Font size: ECharts 12 px (title 18), Chart.js 12 px, Plotly 12 px, Vega 10 px labels / 11 titles / 13 chart title, Highcharts `1rem` root with `0.8em` labels so one setting scales the chart (v11, PR #18562, 2023), Excel 2013+ 9 pt text and a 14 pt title, LO 10 pt and 18 pt from the 2007 style. Google's `fontSize` is "automatic", from the chart's size. Only LO scales text with the chart, by `ReferencePageSize` (`RelativeSizeHelper::calculate`).

History: ECharts and Vega both added a DOM-free width path for server rendering, and both made it overridable because the estimate is wrong for real fonts (`setPlatformAPI`, zrender `2d4e1d1`; Vega `textMetrics.width`). ECharts reworked truncation for proportional fonts in 2025 (zrender `fabe0ca`, wrapping from about 15 ms to 4 ms a frame). Highcharts' digit-to-zero cache key is what lets a 1,000-tick axis measure a handful of strings.

Eigen: `measureLabel` (`text-width.ts:17`) sums advances from a committed table generated from the bundled TTFs (`text-width-data.ts`), regular and bold, for Basic Latin and Latin-1 only; every other code point is about one em (Inter's fallback is 994/1000). This is the ECharts SSR approach with a table per bundled font instead of one generic one, so it is right for the faces Eigen actually ships. The gap is the range. `…` (Eigen's own ellipsis, `layout.ts:76`), `–`, `−`, `€`, curly quotes and every Greek and Cyrillic letter measure as 0.994 em in Inter, though the font has them all: `Москва` measures 5.96 em where Inter's own advances sum to 3.74 em (its Latin `Moskva` is 3.70), and `–` is 0.5 em. So a Russian category name reserves about 60% too much, rotates or ellipsizes where Google keeps it upright, and drops legend entries early. `fit` (`layout.ts:792`) is a linear prefix walk with an ellipsis, as Vega's and Highcharts' binary searches compute it; nothing wraps. Base size is 3.5% of the shorter side, 9 to 64 px (`layout.ts:50`), as Google's "automatic".

## 3. Tick choice and nice numbers

| Library | Step | How many | Domain ends and zero |
|---|---|---|---|
| ECharts | `nice()` (`src/util/number.ts`) to 1, 2, 3, 5, 10 | `splitNumber` 5, not pixel-based | ends extended to a multiple of the step; zero included unless `scale: true`; `'dataMin'` pins |
| Chart.js | `niceNum` to 1, 2, 5, 10 (`scale.linearbase.js` `generateTicks`) | `min(maxTicksLimit 11, ceil(length / min(40, lineHeight)))` | `bounds: 'ticks'` floors and ceils to the step; `beginAtZero` (bars by default, `b4649998` 2020); `grace` pads; `includeBounds` adds a pinned min or max as its own tick |
| Plotly | `roundDTick` to 1, 2, 5 (`plots/cartesian/axes.js` `autoTicks`) | `constrain(len / 80 (x) or 40 (y), 4, 9) + 1` | autorange pads 5% of the length (`autorange.js` `makePadFn`); bars `tozero`; one value v gives [v-1, v+1] |
| Vega | d3-array `tickSpec` 1, 2, 5 with the √50, √10, √2 cut points | `ceil(size / 40)` (Vega-Lite `defaultTickCount`), clamped by `tickMinStep` | `nice: true`; `zero: true` for bars and areas and for every quantitative x/y unless a domain is given |
| Highcharts | `normalizeTickInterval` to 1, 2, 2.5, 5, 10 (`ts/Shared/Utilities.ts`) | `range × tickPixelInterval / length`, 72 px on y, 100 on x | `startOnTick`/`endOnTick`; `maxPadding` 0.05 on y; `softThreshold` takes in zero only when the data sits on one side of it |
| LO | normalise to 1, 2, 5, 10 (`ScaleAutomatism.cxx` `calculateExplicitIncrementAndScaleForLinear`) | at most 10, lowered to axis length ÷ longest label (`VCartesianAxis::estimateMaximumAutoMainIncrementCount`), and so labels don't repeat (tdf#48041, `7f373a4c88`, 2019) | zero when min/max < 5/6, else min lowered by half the span; one more step when data fills over 20/21 of the axis |
| Excel | not documented; depends on plot size and font (Peltier) | | min 0 when (max − min) > max/6 for column and line alike; else a step below min − (max − min)/20; max a step above max + 5% of the span |

Label format: Chart.js `formatters.numeric` uses decimals from the step and turns scientific when the end tick is under 1e-4 or over 1e15 (`core.ticks.js:40`). Plotly rounds to `2 - floor(log10(dtick))` decimals, with an exponent past `minexponent` 3 and SI prefixes on request. Vega uses d3-format `precisionFixed(step)`. Highcharts abbreviates with `numericSymbols` k, M, G, T, chosen by the step so every label shares the suffix.

History: Highcharts' `softThreshold` (`86383898d2`, 2015, 4.1.9) exists to "prevent showing subzero axis ticks for line series that consist of positive data only". Chart.js made bars begin at zero only in 2020 and added `grace` (2021, #8581) because nice ends put the tallest bar on the top gridline. d3-array 3.2.2 "tries harder to generate at least one tick" (the `0.5 <= count < 2` retry, which Eigen's port keeps). ECharts moved all nice logic out of the scales in 6.1.0 (`18a23a87`, `fe932a2a`, 2026) to stop bars overflowing the axis (#19972, #17858).

Eigen: a port of d3-array 3.2's `ticks`/`tickStep` and d3-scale's bounded `nice` (`ticks.ts`), the Vega approach. The count follows pixels, 4 em between ticks on a vertical axis and 6 em on a horizontal one, never over 20 (`layout.ts:57-61`). Bars and stacks take in zero; a line fits its data and takes in zero only when flat (`valueExtent`, `layout.ts:465`). Labels carry the step's decimals and go scientific past six decimals or from a step of 1e15 (`formatTickValue`, `ticks.ts:78`); the comment there calls these Chart.js's bounds, but Chart.js switches on the end tick's size (under 1e-4), not the decimal count. A sheet chart formats ticks with the cell format and ignores the step (`packages/sheet/src/engine/chart-data.ts:101`), so an integer format over a 0.5 step repeats labels (`0 1 1 2 2`), as Excel does and as LO's tdf#48041 cap prevents. Where Eigen and Excel differ:

- **Lines and zero.** For a line of 50, 70, 100 Eigen ticks 50 to 100. Excel and LO tick 0 to 100 (or 120), because the spread is over a sixth of the max. CHARTS.md says a line fits its data "as Excel's and Google's do", which is wrong about Excel.
- **No headroom.** A column of 95, 98, 100 runs from 0 to 100, the same as Google, and its tallest bar ends on the top gridline. Excel, LO, Highcharts and Plotly all add headroom so it doesn't.
- **A pinned min.** A pinned `min` of 3 ticks at 20, 40, … with no label at 3. Excel steps from the min, and Chart.js's `includeBounds` labels it.

## 4. Label collision and rotation

| Library | Category axis | Value labels and data labels |
|---|---|---|
| ECharts | `interval: 'auto'` from 40 sampled labels' rects × 1.3 (`axisTickLabelBuilder.ts` `calculateCategoryInterval`), cached so it doesn't jitter while zooming; no auto rotation | `hideOverlap` greedy by priority on oriented boxes; `moveOverlap: 'shiftX' | 'shiftY'` (`labelLayoutHelper.ts`) |
| Chart.js | continuous rotation up to `maxRotation` 50° (`core.scale.js` `calculateLabelRotation`), then `autoSkip` with 3 px padding (`core.scale.autoskip.js`) | value ticks thinned by `computeTickLimit`; data labels are a plugin |
| Plotly | `autotickangles` [0, 30, 90]: the first angle whose cosine fits the spacing, applied only if neighbours intersect (`axes.js` `fixLabelOverlaps`); `ticklabelstep` | `ticklabeloverflow` hides labels past the plot |
| Vega | `labelAngle` −90 for nominal x in Vega-Lite; `labelOverlap` `parity` (hide every other until none overlap) or `greedy` (`vega-view-transforms/src/Overlap.js`); `labelFlush` aligns the end labels inward | the same transform on every axis; `vega-label` places mark labels on an occupancy bitmap |
| Highcharts | `autoRotation` [-45] tried below `autoRotationLimit` 80 px a slot, scored by fewest skipped labels then flattest angle (`Axis.ts` `unsquish`); word-wraps into the slot before turning (`renderUnsquish`) | data labels `allowOverlap: false`: every pair tested, the lower `labelrank` hidden (`OverlappingDataLabels.ts`) |
| LO | labels placed in sequence; on overlap, stagger (compat) or turn 45° (`autoRotate45`, preferred since 5.1), else show every nth (`VCartesianAxis::createTextShapes`); wraps category labels first | |
| Excel | auto rotation (`a:bodyPr rot="-60000000"` is the automatic sentinel in 146 test files); `c:tickLblSkip` automatic when absent | |

History: LO turned overlapping labels automatically for n#791985 (`228ba082d3`, 2013) and fixed its 45° layout for tdf#88154 (`d52d448e7b`, 2015). Highcharts' auto rotation shipped in 4.1.0 (2015); overlap hiding for data labels moved from Highmaps into core the same year (`9ce129bae1`). Plotly replaced its fixed rule (30°, or 90° when the spacing was under 2.5 font sizes) with `autotickangles` in 2.29.0 (#6790, `b31d45b74`, 2024), and keeps a previous 90° during automargin redraws so turning doesn't loop (`7a8eedf44`). Vega's overlap transform (`a8e00a13`, 2017) and its `labelSeparation` (#1507, 2019) are the simplest complete answer: whatever produced the ticks, the drawn labels never touch.

Eigen: category labels stay upright while every name fits its band, else turn −45° and show every nth, ellipsized to 30% of the height (`placeCategoryLabels`, `layout.ts:563`), which is Highcharts' default angle and LO's rule; a bar chart's names show every nth row. Value labels are spaced by the tick count, and on a bar chart by the loop at `layout.ts:370`. That loop stops at `n <= 2` and keeps whatever d3 returns for a count of 2, which can be four ticks, so their labels can touch (bug 1 below). Nothing checks the drawn labels after placement, as Vega's `Overlap` and Highcharts' `hideOverlappingLabels` do. Category labels never wrap, where Highcharts, LO and Google wrap to a second line before they turn.

## 5. Stacking and bar band maths

| Library | Band share a category's bars fill (one series) | Grouped bars | Stacks |
|---|---|---|---|
| ECharts | `barCategoryGap` `max(35 − 4·stacks, 15)%` → 69% for one stack; `barGap` 10% between series (20% before 6.0, `230ca049`) (`src/layout/barGrid.ts`) | `(band − gap) / (n + (n−1)·barGap)` | `stackStrategy` `samesign` by default (`edeff8b1`, 2022); no percent stack |
| Chart.js | `categoryPercentage` 0.8 × `barPercentage` 0.9 = 72% (`controller.bar.js` `computeFitCategoryTraits`) | the category split into a chunk per stack | same-sign stacks apart (`applyStack`); `inflateAmount` 0.33 px hides seams between adjacent bars |
| Plotly | `1 − bargap` = 80% (`traces/bar/cross_trace_calc.js` `setOffsetAndWidth`) | `bargroupgap` 0 | `Sieve` keys negatives apart in `relative` mode; `barnorm` percent or fraction |
| Vega-Lite | `paddingInner` 0.1 for bars → 90%, outer padding half of that | `xOffset` (5.2, #7684) | Vega `stack`: positives and negatives apart; `normalize` by the sum of absolute values |
| Highcharts | `groupPadding` 0.2 each side, `pointPadding` 0.1 each side → 60% × 0.8 = 48% (`ColumnSeries.ts` `getColumnMetrics`) | one column per stack key | negatives on a `-` prefixed key; `percent` scales to 100 / total |
| LO | gap width 100% (model) → 50% (`CategoryPositionHelper.cxx`) | slot = band / (n + gap + overlap·(n−1)) | positives and negatives apart; 100% reference is the positive sum minus the negative sum (#i70395) |
| Excel | `c:gapWidth` default 150 (0–500) → 40%; 2013+ writes 219 → 31%; `c:overlap` 0 (−100–100), 2013+ writes −27 | the same slot formula | grouping per group; percent by absolute sum |
| Google | `bar.groupWidth` 61.8% (the golden ratio) | bars adjacent | `isStacked: 'percent'` |

History: Chart.js moved `barPercentage`/`categoryPercentage` from the axis to the dataset in 3.0 and made bars equal-width in 2017 (`15d1056b`, keeping the old variable width as `barThickness: 'flex'`). ECharts narrowed its default series gap in 6.0. Highcharts and Plotly snap bars to pixels (`crisp`; Plotly's `expandToVisible` keeps bars under 2 px visible), and Chart.js inflates them 0.33 px because adjacent anti-aliased bars showed hairline seams (#9399).

Eigen: `bandScale` (`layout.ts:547`) is Observable Plot's band with 0.1 inner and outer padding, so one series' bars fill 90% of the category, as Vega-Lite's. Every office suite draws thinner: Google 62%, Excel 40% (31% for a 2013+ file), LO 50%. Bars of one category sit side by side with no overlap, the band split equally (`barMarks`, `layout.ts:594`). Stacks sum positives and negatives apart, and a 100% stack divides by the category's absolute sum (`shares`, `layout.ts:502`), which is what Excel, LO's #i70395 and Vega's `normalize` do. The spec has no gap or overlap (`plots.<type>` holds only `stacking`), so the OOXML reader drops `c:gapWidth` and `c:overlap` and the writer writes 150 (`apps/api/src/lib/ooxml/ooxml-chart-writer.ts:77`). The result: an xlsx chart round-trips with bars more than twice as wide as Excel drew them, and Excel opens Eigen's export at 40% where Eigen showed 90%. Bars aren't pixel-snapped; at roughness 0 the SVG antialiases their edges.

## 6. Pie slices and labels

| Library | Start and direction | Labels | Collision |
|---|---|---|---|
| ECharts | 90° (12 o'clock) clockwise; `minAngle` lifts small slices | outside with a two-segment leader (`length` 15, `length2` 30) | split into left and right halves, shifted vertically (`shiftLayoutOnXY`), x put back on an ellipse; text width limited to the room (`chart/pie/labelLayout.ts`, `f3ed3fab` 2020) |
| Chart.js | 0° (top) clockwise | none in core; legend and tooltip only | — |
| Plotly | 12 o'clock **counterclockwise**, sorted descending by default | inside when the text fits unscaled, else outside (`transformInsideText`) | `scootLabels` per quadrant, from the equator outward, plus leader lines (since 2012, `e4a11468f`) |
| Vega | 0 at 12 o'clock clockwise | text mark at a radius | none |
| Highcharts | 0 at 12 o'clock clockwise | outside at `distance` 30 with a `crookedLine` connector (v11, `ab261983eb`) | `distribute` spreads each half vertically, dropping the lowest rank when they can't fit (`RendererUtilities.ts`); the pie shrinks to `minSize` 80 to make room (`verifyDataLabelOverflow`) |
| LO | 90° counterclockwise from 3 o'clock, i.e. 12 o'clock | best fit: inside if it fits, else outside (`performLabelBestFitInnerPlacement`) | up to 50 rounds of `detectLabelOverlapsAndMove`, then leader lines for moved labels (tdf#90839 2015, tdf#62363 2017, tdf#133376 and tdf#137116 2020) |
| Excel | `c:firstSliceAng` 0, clockwise from 12 | `c:dLblPos bestFit | outEnd | inEnd | ctr`; leader lines `c15:leaderLines` | best fit moves labels apart |
| Google | `pieStartAngle` 0 | `pieSliceText: 'percentage'` inside each slice; names in the legend on the right | slices under `sliceVisibilityThreshold` (0.5/360) merge into "Other" |

History: every library that labels outside the pie had to add a vertical distribution pass, and LO took four years of tdf bugs to make best fit stop overlapping. Google avoids the problem by putting the share inside the slice and the name in the legend.

Eigen: slices clockwise from 12 o'clock, as Excel and Google (`layoutPie`, `layout.ts:691`). Each slice of 5% or more gets "name share%" just outside its arc's middle, anchored start, middle or end by the cosine, with no leader line; the radius shrinks until every label fits the frame, and if that would halve it, no labels draw (`layout.ts:744`). Nothing keeps two labels apart: near 12 and 6 o'clock two neighbouring 5–10% slices put middle-anchored labels about r·sin 18° apart, less than a label's width (bug 2 below). The legend is off for a pie by default (`spec.ts:120`), unlike Google's. `c:firstSliceAng` is not read, so an Excel pie turned by it draws from 12 o'clock (2 of 48 test-file pies use a non-zero angle).

## 7. Null and blank handling

| Library | Line | Stack | Default |
|---|---|---|---|
| ECharts | `connectNulls` (false) skips illegal points; `'-'`, `''` and null parse to NaN (`dataValueHelper.ts`) | NaN stacks to [NaN, NaN] | gap |
| Chart.js | `spanGaps` true or a maximum gap (`helpers.segment.js` `_computeSegments`, numeric since `7eb0c2ca` 2020) | null skipped | gap |
| Plotly | `connectgaps` (false); `Lib.cleanNumber` strips `$`, `%`, `,` | scatter `stackgaps: 'infer zero' | 'interpolate'` | gap |
| Vega-Lite | `mark.invalid`: `filter`, `break-paths-filter-domains`, `break-paths-show-domains`, `show` (5.19, `502db1d8`, 2024) | `impute` transform | break paths for lines, filter for the rest |
| Highcharts | `connectNulls`; `nullInteraction` keeps nulls hoverable (12.2) | null skipped; percent area connects nulls | gap |
| LO | `MissingValueTreatment` LEAVE_GAP, USE_ZERO, CONTINUE; default by type (gap for column, bar, line; zero for area; continue for scatter) | | |
| Excel | `c:dispBlanksAs` gap, span, zero; the schema default is zero, but Excel assumes gap when absent and writes gap; `#N/A` is bridged in line, scatter and radar charts unless 365's `c16r3:dispNaAsBlank` is set | | gap |
| Google | `interpolateNulls` false | | gap |

Eigen: `chart.blanks` is `gap`, `zero` or `span` for the whole chart, as Excel's `c:dispBlanksAs` (`lineMarks`, `layout.ts:641`; `barMarks`, `layout.ts:614`). A missing `c:dispBlanksAs` reads as gap, as Excel reads it (`apps/api/src/lib/ooxml/ooxml-chart.ts:237`). A sheet chart reads every non-number cell as blank (`packages/sheet/src/engine/chart-data.ts:70`), errors included. So `#N/A` in a line follows the blanks setting and breaks the line, where Excel bridges it. Excel users use `NA()` for exactly this, to skip a point without breaking the line. A point between two gaps draws nothing when markers are off, as in Excel and Google.

## 8. Colour and palette

| Library | Default palette | Assigned by |
|---|---|---|
| ECharts | 9 (6.0: `#5070dd #b6d634 #505372 …`; 5.x `#5470c6 #91cc75 …`) | running index per scope, memoised by name; `colorBy: 'data'` for pies, over the unfiltered data so a legend toggle keeps colours (5.2, `95c870b7`) |
| Chart.js | 7 in the Colors plugin (blue, red, orange, yellow, green, purple, grey), skipped if anything sets a colour; before v4 every dataset was `rgba(0,0,0,0.1)` | dataset index; slices per point |
| Plotly | D3 category10 (`#1f77b4 …`) | `colorway[count % len]`, skipping explicitly hidden traces; pies per label, lightened then darkened past the end (`extendpiecolors`) |
| Vega | tableau10 (`4c78a8 f58518 …`), switched from category10 in 2017 (`0673aac3`, no reason given) | ordinal scale over the sorted domain |
| Highcharts | 10 (v11: `#2caffe #544fc5 #00e272 …`), CSS variables with dark variants | `colorCounter % 10`; `colorByPoint` for pies |
| LO | 12 (`004586 ff420e ffd320 …`), theme palettes in 2025 | series index |
| Excel | theme accent1–6, then the same six at `lumMod 60000`, then `lumMod 80000 lumOff 20000`, … (`colors1.xml`, `cs:colorStyle meth="cycle"`) | series index; `c:varyColors` per point |

History: Chart.js added its palette in v4 (`1c2f66a0`, 2022, #10764) to stop every new chart drawing in one grey, a request open since 2015 (#815). ECharts made colours follow the data, not the drawn order, so toggling a series doesn't recolour the rest. Highcharts tweaked a v4 colour that was nearly a duplicate (#3222).

Eigen: `chartColor(i)` (`spec.ts:79`) cycles the 17 accent colours from pink, so twelve series never repeat. An automatic colour is fixed by the series' place in the spec, not its drawn index (`layout.ts:115`), which is the stability ECharts' `colorBy` buys. Seventeen is about twice anyone else's palette. What the libraries add on top is a second, non-colour channel: ECharts' `aria.decal` patterns. Eigen already has hatches, but the hatch style is the whole chart's (`ChartPaint.fillStyle`), not per series.

## 9. Hit testing

| Library | How a pointer finds a mark |
|---|---|
| ECharts | zrender `Handler.findHover` walks the display list top down with each element's `contain` (bounds, then stroke within 5 px, then fill); a hover layer past 3,000 elements; axis trigger maps the pointer to the nearest category per series (`axisTrigger.ts`) |
| Chart.js | `core.interaction.js` modes `nearest` (default, with `intersect`), `index`, `point`, `dataset`, `x`, `y`; binary search over sorted data (`9fda5ec6`, 2020) |
| Plotly | each trace's `hoverPoints`; `hovermode: 'closest'` (default since 2.0, #5647), `hoverdistance` 20 px; WebGL scatter searches a point-cluster tree past 1e5 points |
| Vega | scenegraph `pick`: bounds, then canvas `isPointInPath` or SVG DOM events; Vega-Lite `nearest: true` adds an invisible Voronoi layer |
| Highcharts | k-d tree per series (`buildKDTree`, async) searched by `findNearestPointBy` `x` or `xy`; lines get an invisible path 10 px wider (`tooltip.snap`) |
| LO | every shape named with an object id; SdrView pick, then `requestQuickHelp` for the tooltip |

Eigen: a chart is one element whose hit test is its box (`packages/lib/src/vector/kinds/chart.ts:61`). Nothing hovers, and no tooltip shows a value, in any app. The shapes already carry what a hit test needs: each id is `${chartId}:bar:<series>:<index>`, `marker:…` or `slice:0:<index>` (`layout.ts:631`, `671`, `752`), so the series and point under the pointer can be read from the layout without a new structure.

## 10. The rendering seam

| Library | Seam | Server output |
|---|---|---|
| ECharts | zrender: one display list, canvas and SVG painters (SVG a snabbdom vdom since `79ad104`, 2021); dirty rects on canvas | `ssr: true` + `renderToSVGString` (5.3, `b14b8850`), text as `<text>` with `dominant-baseline: central` |
| Chart.js | canvas 2D only; `BasicPlatform` for workers and OffscreenCanvas | node-canvas or skia-canvas (third party); SVG declined (#8522: "the big differentiator for chart.js is that it uses the Canvas") |
| Plotly | D3 SVG layers plus WebGL canvases (regl) for gl traces | `toImage` serialises the SVG, rasterising GL canvases into `<image>`; Kaleido renders headless; fonts by family name only |
| Vega | scenegraph to `CanvasRenderer`, `SVGRenderer`, headless `SVGStringRenderer`, `HybridRenderer` (SVG text over canvas marks, 5.26, #3810) | `view.toSVG()`; text with a computed `dy`, not `alignment-baseline` |
| Highcharts | `SVGRenderer` only (VML removed 2023, `ccfaac9401`); Boost draws WebGL into an SVG `<image>` past 5,000 points | export server, local export by default since 12.3 |
| LO | UNO/Svx shapes on an SdrPage (`ShapeFactory.cxx`), with invisible named rects for the plot area | a GDIMetaFile as the ODF replacement image |
| Excel | chart part only in xlsx and docx, no cached image; chartex (`cx:`) carries an `mc:Fallback` (a shape in xlsx, a picture in pptx) | |

History: the libraries converge on one scene description with several painters, and on a DOM-free path to SVG for the server. ECharts, Vega and Plotly built theirs after shipping canvas or DOM-only renderers. Vega's hybrid renderer exists because canvas text exports badly and SVG marks are slow past a few thousand.

Eigen: the layout is the scene description (`ChartLayout`, `types/chart.ts:224`) and the painter is pure string SVG through each kind's own `render` (`chart-render.ts:92`), safe on the server. That is Vega's `SVGStringRenderer` model, and it is why a chart is identical live, in a PDF through WeasyPrint and in the docx picture. Labels are SVG text with the baseline offset added by the painter (`svgTextLine`), as Vega computes `dy` itself. The cost seam is roughjs: past `MAX_SKETCH_POINTS` (200, `layout.ts:47`) marks draw flat, the role Highcharts' Boost threshold and ECharts' large mode play. A canvas painter isn't needed for the four kinds drawn today. A scatter of thousands of points would be the first case for one (Highcharts at 5,000, ECharts at 3,000).

## Defects in Eigen's drawing found by this study

Both come from laying out a few thousand generated charts and testing every pair of labels for overlap, with boxes measured by `measureLabel`, the same function the layout uses.

1. **Bar value-axis labels overlap on a narrow plot.** A bar chart of 12,500,000, 38,000,000 and −15,000,000 at 200 × 220 ticks −20,000,000, 0, 20,000,000 and 40,000,000 at x 38, 81, 123 and 166, and the last two labels (about 50 px wide) overlap by about 7 px. The loop at `layout.ts:385` breaks on `n <= 2` with whatever d3 returns for a count of 2. Google and Excel draw fewer labels instead.
2. **Pie labels of small neighbouring slices overlap.** Values 44, 6, 6, 6 and 38 named Delta, Alpha region, Beta region, Gamma region and Eps at 400 × 300: "Alpha region 6%" and "Beta region 6%" sit on one line, centered at x 224 and 176, and overlap by about 29 px (`layout.ts:716-766`). It takes neighbouring small slices near the top or bottom: 1% of random pies of 2 to 13 slices overlap, and pies of up to 25 slices gave 135 overlapping pairs in about 750 charts. Google puts shares inside the slices and names in the legend; Excel's best fit moves labels apart.

## Recommendations, ranked

1. **A final overlap pass over every drawn label set.** After placement, hide labels that touch: value ticks by Vega's `parity` (every other, keeping the ends), pie and later data labels by rank as Highcharts' `hideOverlappingLabels` does. One helper over `ChartLabel` boxes, already measurable with `measureLabel`. Fixes both defects above for every input and gives data labels (CHARTS-TODO, "Lost without a note") their collision rule before they ship. Vega `Overlap.js`, Highcharts `OverlappingDataLabels.ts`. Size S. Impact high: overlapping text is the one visibly broken output found.
2. **Pie labels distributed per half with leader lines.** Split labels into left and right halves, sort by angle, spread each half vertically to one line apart within the frame, and draw a two-segment leader from the arc to each moved label. Small slices keep a label instead of losing it at 5%. ECharts `shiftLayoutOnXY`, Highcharts `distribute`, Plotly `scootLabels`, LO `rearrangeLabelToAvoidOverlapIfRequested`. Size M (the leader is a `line` shape the layout already makes). Impact medium-high: pies are the kind people label, and Excel's best-fit pies import with labels Eigen now crowds.
3. **Bar gap and overlap in the spec, read and written as Excel's.** Add `gapWidth` and `overlap` to `plots.column` and `plots.bar` (percent units, as `c:gapWidth`/`c:overlap`), read and write them in `ooxml-chart.ts`/`ooxml-chart-writer.ts`, and compute the slot with LO's formula, `band / (n + gap + overlap·(n−1))` (`CategoryPositionHelper.cxx`). Pick the default deliberately: Google's 61.8% matches the "Google look" Eigen aims for; today's 90% is wider than Excel, Google and LO. Size S–M (a field that nests, per CHARTS.md § A stored spec grows). Impact medium: every imported clustered chart and every xlsx export changes visibly.
4. **Width table for the scripts people chart in.** Extend `TEXT_WIDTH_RANGES` and the generator (`apps/api/src/scripts/chart-text-widths.ts`) to Latin Extended-A, Greek, Cyrillic, General Punctuation (`…`, `–`, quotes) and currency symbols, all present in the bundled fonts. Cyrillic and Greek labels then stop reserving about 60% too much (Inter and Excalifont both carry the glyphs), and the ellipsis Eigen appends measures its own 0.86 em. ECharts keeps a table for the same reason (zrender `165dcdc`). Size S. Impact medium for non-English users.
5. **Hover tooltips from the layout's shape ids.** Hit-test the chart's layout (bars and slices by containment, line points nearest within a few px, as Highcharts' `snap` and Plotly's `hoverdistance` 20) and show series, category and value. The ids already encode series and index. Sheets first, since Google Sheets shows values on hover. Chart.js `core.interaction.js`, Highcharts `Pointer.ts`. Size M. Impact medium: today there is no way to read a value off a chart without its data.
6. **`#N/A` bridges a line, as Excel's does.** Have `resolveRangeChartData` mark an `#N/A` cell apart from a blank, so a line draws through it whatever `blanks` says, and read `c16r3:dispNaAsBlank` to turn that off. Excel support page "Display empty cells, null (#N/A) values"; LO lacks it too. Size S. Impact medium-low: it's the standard Excel trick for skipping points, and imports break lines today.
7. **Category labels wrap to two lines before turning.** Break at spaces into the band width, at most two lines, and turn −45° only if two lines don't fit. Highcharts `renderUnsquish`, LO `TextBreak`, Google's default. Size M (the row height becomes per-label). Impact medium-low: long category names stay readable and level.
8. **Value-axis ends: decide on headroom and Excel's zero rule.** Consider Excel's and LO's 5/6 rule for lines (zero when the spread passes a sixth of the max), or keep fitting data and correct CHARTS.md's claim that Excel fits it too. Consider one step of headroom when the data fills over 20/21 of the axis (LO `ExpandIfValuesCloseToBorder`; Highcharts `maxPadding` 0.05; Plotly 5%), so the tallest bar never ends on the top gridline. Label a pinned min as Chart.js's `includeBounds` does. Size S each. Impact low-medium: imported Excel line charts change scale today, which users notice when they compare.
9. **Thin a sheet chart's ticks so formatted labels don't repeat.** When `formatTick` gives two neighbours the same text, ask for fewer ticks (LO tdf#48041, `7f373a4c88`). Size S. Impact low: integer formats over small ranges.
10. **Read `c:firstSliceAng`.** One number on `plots.pie`, drawn by the start angle `layoutPie` already takes. Size S. Impact low (2 of 48 test-file pies).

Not recommended: a canvas painter (no kind drawn today needs it, and the SVG-only seam is what makes print and docx identical); paging or scrolling legends (a static export can't page, and "+N" is better than LO's silent drop); pixel snapping (WeasyPrint and the docx picture scale anyway, and Chart.js's seam fix exists for canvas antialiasing).
