---
title: Sheets
description: Spreadsheets with formulas, charts and Excel files, edited together on your own server.
---

<!-- DRAFT: the owner rewrites this -->

eigen|sheets⟩ is the spreadsheet app in Eigen. You type a formula, the totals update, and everyone with the sheet open sees it happen. It saves as you work, so there is no Save button.

::: video src="/data/about/media/sheets-hero" caption="A formula typed, the totals update, and undo takes it back."
:::

## Working together

Several people can edit the same sheet at the same time. Their changes merge as they type, so nobody overwrites anyone. You share a sheet with people, a team or a link, and you can leave a comment on a cell without touching its value ([Get started](/support/sheets/get-started), [Share a spreadsheet and comment on cells](/support/sheets/share-and-comment)).

::: video src="/data/about/media/sheets-collab-pair" caption="Two people in one budget. Anouk changes Security on the right; Bram sees it arrive on the left."
:::

## Formulas and Excel files

Formulas work the way you expect: type `=`, pick a function from the autocomplete, click cells to add them ([Use formulas and functions](/support/sheets/formulas)). There is [conditional formatting](/support/sheets/conditional-formatting) and [data validation](/support/sheets/data-validation) too.

You can bring your `.xlsx` files. An import keeps the values, formulas, formatting, charts and images ([Import an Excel file](/support/sheets/import-excel)). Not everything comes across: comments, icon sets and some chart types are left out, and the article lists them. When you leave, you download the sheet as Excel, PDF or a web page ([Download a spreadsheet](/support/sheets/export-spreadsheet)).

## Charts

Select a table and insert a chart: column, bar, line or pie. The chart reads its cells, so it changes as soon as a number does ([Add a chart to a spreadsheet](/support/sheets/add-a-chart)).

::: video src="/data/about/media/sheets-chart" caption="A cost changes, and its bar beside the table grows."
:::

::: carousel caption="A festival budget with its chart, and a pie chart in dark mode."
![A budget table with a column chart of the costs beside it](/data/about/media/sheets-still-budget.webp)
![A pie chart in dark mode](/data/about/media/sheets-still-chart.webp)
:::

## The fastest* formula engine

<div class="eigen-callout">

**Draft:** Sheets switches to this engine in step 1b. This section must not ship before it does.

</div>

I wrote a new formula engine for Sheets, eigen|formula⟩, and compared it with three other formula engines that run in JavaScript: HyperFormula, IronCalc and Univer.

- **Speed**: it was faster than HyperFormula in 15 of 17 workloads, and faster than IronCalc and Univer in 17 of 17.
- **Correctness**: of 17,584 answers recorded in Excel, it gave Excel's answer on 92.0%. HyperFormula did on 55.4%, IronCalc on 74.3% and Univer on 82.6%.
- **Coverage**: this is the weak spot. It has 219 of Excel's 524 functions. HyperFormula has 384, IronCalc 492 and Univer 495.

The method, every workload and every number are in the [benchmark README](https://github.com/eigen-is/eigen/blob/main/packages/formula/benchmark/README.md).

\* Our own benchmark, on one machine. You can run it yourself.
