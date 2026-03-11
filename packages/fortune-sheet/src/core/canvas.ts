import _ from "lodash";
import {defaultContext, getFlowdata} from "./context";
import {getRealCellValue, normalizedAttr} from "./modules/cell";
import {clearMeasureTextCache, defaultFont, getCellTextInfo, getFontSet, getMeasureText,} from "./modules/text";
import {isInlineStringCell} from "./modules/inline-string";
import {getSheetIndex, indexToColumnChar} from "./utils";
import {getBorderInfoComputeRange} from "./modules/border";
import {checkCF, getComputeMap, validateCellData} from "./modules";

export const defaultStyle = {
  fillStyle: "#000000",
  textBaseline: "middle",
  strokeStyle: "#dfdfdf",
  rowFillStyle: "#5e5e5e",
  textAlign: "center",
};

// Check if value is a pure number
function isRealNum(val: any) {
  return !Number.isNaN(Number(val));
}



const BORDER_FIX = [-1, 0, 0, -1] as const;

function setLineDash(
  canvasborder: CanvasRenderingContext2D,
  type: any,
  hv: string,
  moveX: number,
  moveY: number,
  toX: number,
  toY: number
) {
  const borderType: any = {
    "0": "none",
    "1": "Thin",
    "2": "Hair",
    "3": "Dotted",
    "4": "Dashed",
    "5": "DashDot",
    "6": "DashDotDot",
    "7": "Double",
    "8": "Medium",
    "9": "MediumDashed",
    "10": "MediumDashDot",
    "11": "MediumDashDotDot",
    "12": "SlantedDashDot",
    "13": "Thick",
  };

  type = borderType[type.toString()];

  try {
    if (type === "Hair") {
      canvasborder.setLineDash([1, 2]);
    } else if (type.indexOf("DashDotDot") > -1) {
      canvasborder.setLineDash([2, 2, 5, 2, 2]);
    } else if (type.indexOf("DashDot") > -1) {
      canvasborder.setLineDash([2, 5, 2]);
    } else if (type.indexOf("Dotted") > -1) {
      canvasborder.setLineDash([2]);
    } else if (type.indexOf("Dashed") > -1) {
      canvasborder.setLineDash([3]);
    } else {
      canvasborder.setLineDash([0]);
    }
  } catch (e) {
    console.error(e);
  }

  canvasborder.beginPath();

  if (type.indexOf("Medium") > -1) {
    if (hv === "h") {
      canvasborder.moveTo(moveX, moveY - 0.5);
      canvasborder.lineTo(toX, toY - 0.5);
    } else {
      canvasborder.moveTo(moveX - 0.5, moveY);
      canvasborder.lineTo(toX - 0.5, toY);
    }

    canvasborder.lineWidth = 2;
  } else if (type === "Thick") {
    canvasborder.moveTo(moveX, moveY);
    canvasborder.lineTo(toX, toY);
    canvasborder.lineWidth = 3;
  } else {
    canvasborder.moveTo(moveX, moveY);
    canvasborder.lineTo(toX, toY);
    canvasborder.lineWidth = 1;
  }
}

// Module-level cache that persists across Canvas instances.
// Previously this lived on the Canvas class and was reset to {} on every
// new Canvas(), making it completely useless. The existing setTimeout in
// drawMain invalidates it after 100ms of idle time.
let sharedCellOverflowMapCache: any = {};
let sharedMeasureTextCacheTimeOut: any;

export class Canvas {
  private canvasElement: HTMLCanvasElement;

  private sheetCtx: ReturnType<typeof defaultContext>;

  constructor(
    canvasElement: HTMLCanvasElement,
    ctx: ReturnType<typeof defaultContext>
  ) {
    this.canvasElement = canvasElement;
    this.sheetCtx = ctx;
  }

  public drawRowHeader(scrollHeight: number, drawHeight?: number, offsetTop?: number) {
    if (drawHeight == null) {
      [, drawHeight] = this.sheetCtx.luckysheetTableContentHW;
    }

    if (offsetTop == null) {
      offsetTop = this.sheetCtx.columnHeaderHeight;
    }

    const renderCtx = this.canvasElement.getContext("2d");
    if (!renderCtx) return;

    renderCtx.save();
    renderCtx.scale(
      this.sheetCtx.devicePixelRatio,
      this.sheetCtx.devicePixelRatio
    );

    renderCtx.clearRect(
      0,
      offsetTop,
      this.sheetCtx.rowHeaderWidth - 1,
      drawHeight
    );

    renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
    // @ts-ignore
    renderCtx.textBaseline = defaultStyle.textBaseline;
    renderCtx.fillStyle = defaultStyle.fillStyle;

    let dataset_row_st;
    let dataset_row_ed;
    dataset_row_st = _.sortedIndex(this.sheetCtx.visibledatarow, scrollHeight);
    dataset_row_ed = _.sortedIndex(
      this.sheetCtx.visibledatarow,
      scrollHeight + drawHeight
    );

    if (dataset_row_st === -1) {
      dataset_row_st = 0;
    }
    if (dataset_row_ed === -1) {
      dataset_row_ed = this.sheetCtx.visibledatarow.length - 1;
    }

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(
      0,
      offsetTop - 1,
      this.sheetCtx.rowHeaderWidth - 1,
      drawHeight - 2
    );
    renderCtx.clip();

    let end_r;
    let start_r;
    const bodrder05 = 0.5; // Default 0.5
    let preEndR;
    for (let r = dataset_row_st; r <= dataset_row_ed; r += 1) {
      if (r === 0) {
        start_r = -scrollHeight - 1;
      } else {
        start_r = this.sheetCtx.visibledatarow[r - 1] - scrollHeight - 1;
      }
      end_r = this.sheetCtx.visibledatarow[r] - scrollHeight;

      const firstOffset = dataset_row_st === r ? -2 : 0;
      const lastOffset = dataset_row_ed === r ? -2 : 0;
      // Triggered before row header cell render; return false to skip
      if (
        this.sheetCtx.hooks.beforeRenderRowHeaderCell?.(
          `${r + 1}`,
          r,
          start_r + offsetTop + firstOffset,
          this.sheetCtx.rowHeaderWidth - 1,
          end_r - start_r + 1 + lastOffset - firstOffset,
          renderCtx
        ) === false
      ) {
        continue;
      }

      if (this.sheetCtx.config?.rowhidden?.[r] == null) {
        renderCtx.fillStyle = "#ffffff";
        renderCtx.fillRect(
          0,
          start_r + offsetTop + firstOffset,
          this.sheetCtx.rowHeaderWidth - 1,
          end_r - start_r + 1 + lastOffset - firstOffset
        );
        renderCtx.fillStyle = "#000000";

        // Row header sequence number
        const textMetrics = getMeasureText(r + 1, renderCtx, this.sheetCtx);

        const horizonAlignPos =
          (this.sheetCtx.rowHeaderWidth - textMetrics.width) / 2;
        const verticalAlignPos = start_r + (end_r - start_r) / 2 + offsetTop;

        renderCtx.fillText(
          `${r + 1}`,
          horizonAlignPos,
          verticalAlignPos
        );
      }

      // vertical
      renderCtx.beginPath();
      renderCtx.moveTo(
        this.sheetCtx.rowHeaderWidth - 2 + bodrder05,
        start_r + offsetTop - 2
      );
      renderCtx.lineTo(
        this.sheetCtx.rowHeaderWidth - 2 + bodrder05,
        end_r + offsetTop - 2
      );
      renderCtx.lineWidth = 1;

      renderCtx.strokeStyle = defaultStyle.strokeStyle;
      renderCtx.stroke();
      renderCtx.closePath();

      // Row header horizontal line
      if (
        this.sheetCtx.config.rowhidden &&
        this.sheetCtx.config.rowhidden[r] == null &&
        this.sheetCtx.config.rowhidden[r + 1] != null
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(-1, end_r + offsetTop - 4 + bodrder05);
        renderCtx.lineTo(
          this.sheetCtx.rowHeaderWidth - 1,
          end_r + offsetTop - 4 + bodrder05
        );
        renderCtx.closePath();
        renderCtx.stroke();
      } else if (
        this.sheetCtx.config.rowhidden == null ||
        this.sheetCtx.config.rowhidden[r] == null
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(-1, end_r + offsetTop - 2 + bodrder05);
        renderCtx.lineTo(
          this.sheetCtx.rowHeaderWidth - 1,
          end_r + offsetTop - 2 + bodrder05
        );

        renderCtx.closePath();
        renderCtx.stroke();
      }

      if (
        this.sheetCtx.config?.rowhidden?.[r - 1] != null &&
        preEndR !== undefined
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(-1, preEndR + offsetTop + bodrder05);
        renderCtx.lineTo(
          this.sheetCtx.rowHeaderWidth - 1,
          preEndR + offsetTop + bodrder05
        );
        renderCtx.closePath();
        renderCtx.stroke();
      }

      preEndR = end_r;

      this.sheetCtx.hooks.afterRenderRowHeaderCell?.(
        `${r + 1}`,
        r,
        start_r + offsetTop + firstOffset,
        this.sheetCtx.rowHeaderWidth - 1,
        end_r - start_r + 1 + lastOffset - firstOffset,
        renderCtx
      );
    }

    // Must be restored twice, otherwise it will be enlarged under window.devicePixelRatio = 1.5
    renderCtx.restore();
    renderCtx.restore();
  }

  public drawColumnHeader(
    scrollWidth: number,
    drawWidth?: number,
    offsetLeft?: number
  ) {
    if (drawWidth === undefined) {
      [drawWidth] = this.sheetCtx.luckysheetTableContentHW;
    }

    if (offsetLeft === undefined) {
      offsetLeft = this.sheetCtx.rowHeaderWidth;
    }

    const renderCtx = this.canvasElement.getContext("2d");
    if (!renderCtx) return;

    renderCtx.save();
    renderCtx.scale(
      this.sheetCtx.devicePixelRatio,
      this.sheetCtx.devicePixelRatio
    );
    renderCtx.clearRect(
      offsetLeft,
      0,
      drawWidth,
      this.sheetCtx.columnHeaderHeight - 1
    );

    renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
    // @ts-ignore
    renderCtx.textBaseline = defaultStyle.textBaseline;
    renderCtx.fillStyle = defaultStyle.fillStyle;

    let dataset_col_st;
    let dataset_col_ed;
    dataset_col_st = _.sortedIndex(
      this.sheetCtx.visibledatacolumn,
      scrollWidth
    );
    dataset_col_ed = _.sortedIndex(
      this.sheetCtx.visibledatacolumn,
      scrollWidth + drawWidth
    );

    if (dataset_col_st === -1) {
      dataset_col_st = 0;
    }
    if (dataset_col_ed === -1) {
      dataset_col_ed = this.sheetCtx.visibledatacolumn.length - 1;
    }

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(
      offsetLeft - 1,
      0,
      drawWidth,
      this.sheetCtx.columnHeaderHeight - 1
    );
    renderCtx.clip();

    let end_c;
    let start_c;
    const bodrder05 = 0.5; // Default 0.5
    let preEndC;
    for (let c = dataset_col_st; c <= dataset_col_ed; c += 1) {
      if (c === 0) {
        start_c = -scrollWidth;
      } else {
        start_c = this.sheetCtx.visibledatacolumn[c - 1] - scrollWidth;
      }
      end_c = this.sheetCtx.visibledatacolumn[c] - scrollWidth;

      const abc = indexToColumnChar(c);
      // Triggered before column header cell render; return false to skip
      if (
        this.sheetCtx.hooks.beforeRenderColumnHeaderCell?.(
          abc,
          c,
          start_c + offsetLeft - 1,
          end_c - start_c,
          this.sheetCtx.columnHeaderHeight - 1,
          renderCtx
        ) === false
      ) {
        continue;
      }

      if (this.sheetCtx.config?.colhidden?.[c] == null) {
        renderCtx.fillStyle = "#ffffff";
        renderCtx.fillRect(
          start_c + offsetLeft - 1,
          0,
          end_c - start_c,
          this.sheetCtx.columnHeaderHeight - 1
        );
        renderCtx.fillStyle = "#000000";

        // Column header sequence number
        const textMetrics = getMeasureText(abc, renderCtx, this.sheetCtx);

        const horizonAlignPos = Math.round(
          start_c + (end_c - start_c) / 2 + offsetLeft - textMetrics.width / 2
        );
        const verticalAlignPos = Math.round(
          this.sheetCtx.columnHeaderHeight / 2
        );

        renderCtx.fillText(
          abc,
          horizonAlignPos,
          verticalAlignPos
        );
      }

      // Column header vertical line
      if (
        this.sheetCtx.config.colhidden &&
        this.sheetCtx.config.colhidden[c] != null &&
        this.sheetCtx.config.colhidden[c + 1] != null
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(end_c + offsetLeft - 4 + bodrder05, 0);
        renderCtx.lineTo(
          end_c + offsetLeft - 4 + bodrder05,
          this.sheetCtx.columnHeaderHeight - 2
        );
        renderCtx.lineWidth = 1;
        renderCtx.strokeStyle = defaultStyle.strokeStyle;
        renderCtx.closePath();
        renderCtx.stroke();
      } else if (
        this.sheetCtx.config.colhidden == null ||
        this.sheetCtx.config.colhidden[c] == null
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(end_c + offsetLeft - 2 + bodrder05, 0);
        renderCtx.lineTo(
          end_c + offsetLeft - 2 + bodrder05,
          this.sheetCtx.columnHeaderHeight - 2
        );

        renderCtx.lineWidth = 1;
        renderCtx.strokeStyle = defaultStyle.strokeStyle;
        renderCtx.closePath();
        renderCtx.stroke();
      }

      if (
        this.sheetCtx.config?.colhidden?.[c - 1] != null &&
        preEndC !== undefined
      ) {
        renderCtx.beginPath();
        renderCtx.moveTo(preEndC + offsetLeft + bodrder05, 0);
        renderCtx.lineTo(
          preEndC + offsetLeft + bodrder05,
          this.sheetCtx.columnHeaderHeight - 2
        );
        renderCtx.closePath();
        renderCtx.stroke();
      }

      // horizen
      renderCtx.beginPath();
      renderCtx.moveTo(
        start_c + offsetLeft - 1,
        this.sheetCtx.columnHeaderHeight - 2 + bodrder05
      );
      renderCtx.lineTo(
        end_c + offsetLeft - 1,
        this.sheetCtx.columnHeaderHeight - 2 + bodrder05
      );
      renderCtx.stroke();
      renderCtx.closePath();

      preEndC = end_c;

      this.sheetCtx.hooks.afterRenderColumnHeaderCell?.(
        abc,
        c,
        start_c + offsetLeft - 1,
        end_c - start_c,
        this.sheetCtx.columnHeaderHeight - 1,
        renderCtx
      );
    }

    // Must be restored twice, otherwise it will be enlarged under window.devicePixelRatio = 1.5
    renderCtx.restore();
    renderCtx.restore();
  }

  public drawMain({
    scrollWidth,
    scrollHeight,
    drawWidth,
    drawHeight,
    offsetLeft,
    offsetTop,
    columnOffsetCell,
    rowOffsetCell,
    clear,
  }: {
    scrollWidth: number;
    scrollHeight: number;
    drawWidth?: number;
    drawHeight?: number;
    offsetLeft?: number;
    offsetTop?: number;
    columnOffsetCell?: number;
    rowOffsetCell?: number;
    clear?: boolean;
  }) {
    const flowdata = getFlowdata(this.sheetCtx);
    if (flowdata == null) {
      return;
    }

    clearTimeout(sharedMeasureTextCacheTimeOut);

    // Handle undefined parameters
    if (drawWidth === undefined) {
      [drawWidth] = this.sheetCtx.luckysheetTableContentHW;
    }
    if (drawHeight === undefined) {
      [, drawHeight] = this.sheetCtx.luckysheetTableContentHW;
    }

    if (offsetLeft === undefined) {
      offsetLeft = this.sheetCtx.rowHeaderWidth;
    }
    if (offsetTop === undefined) {
      offsetTop = this.sheetCtx.columnHeaderHeight;
    }

    if (columnOffsetCell === undefined) {
      columnOffsetCell = 0;
    }
    if (rowOffsetCell === undefined) {
      rowOffsetCell = 0;
    }

    const renderCtx = this.canvasElement.getContext("2d");
    if (!renderCtx) return;

    renderCtx.save();
    renderCtx.scale(
      this.sheetCtx.devicePixelRatio,
      this.sheetCtx.devicePixelRatio
    );
    if (clear) {
      renderCtx.clearRect(
        0,
        0,
        this.sheetCtx.luckysheetTableContentHW[0],
        this.sheetCtx.luckysheetTableContentHW[1]
      );
    }

    // Table render area: start/end row/column indices
    let rowStart: number;
    let rowEnd: number;
    let colStart: number;
    let colEnd: number;

    rowStart = _.sortedIndex(this.sheetCtx.visibledatarow, scrollHeight);
    rowEnd = _.sortedIndex(
      this.sheetCtx.visibledatarow,
      scrollHeight + drawHeight
    );

    if (rowStart === -1) {
      rowStart = 0;
    }

    rowStart += rowOffsetCell;

    if (rowEnd === -1) {
      rowEnd = this.sheetCtx.visibledatarow.length - 1;
    }

    rowEnd += rowOffsetCell;

    if (rowEnd >= this.sheetCtx.visibledatarow.length) {
      rowEnd = this.sheetCtx.visibledatarow.length - 1;
    }

    colStart = _.sortedIndex(this.sheetCtx.visibledatacolumn, scrollWidth);
    colEnd = _.sortedIndex(
      this.sheetCtx.visibledatacolumn,
      scrollWidth + drawWidth
    );

    if (colStart === -1) {
      colStart = 0;
    }

    colStart += columnOffsetCell;

    if (colEnd === -1) {
      colEnd = this.sheetCtx.visibledatacolumn.length - 1;
    }

    colEnd += columnOffsetCell;

    if (colEnd >= this.sheetCtx.visibledatacolumn.length) {
      colEnd = this.sheetCtx.visibledatacolumn.length - 1;
    }

    // Table render area: start/end coordinates
    const rowEndY = this.sheetCtx.visibledatarow[rowEnd];
    const colEndX = this.sheetCtx.visibledatacolumn[colEnd];

    // Initialize table canvas area
    renderCtx.fillStyle = "#ffffff";
    renderCtx.fillRect(
      offsetLeft - 1,
      offsetTop - 1,
      colEndX - scrollWidth,
      rowEndY - scrollHeight
    );
    renderCtx.font = defaultFont(this.sheetCtx.defaultFontSize);
    renderCtx.fillStyle = defaultStyle.fillStyle;

    // Non-empty cells with start/end coordinates
    const cellupdate: {
      r: number;
      c: number;
      startX: number;
      startY: number;
      endY: number;
      endX: number;
      firstcolumnlen: number;
    }[] = [];
    const mergeCache: any = {};
    const borderOffset: any = {};

    const bodrder05 = 0.5; // Default 0.5
    const drawGridLines =
      !this.sheetCtx.luckysheetcurrentisPivotTable &&
      this.sheetCtx.showGridLines;

    this.sheetCtx.hooks.beforeRenderCellArea?.(flowdata, renderCtx);

    for (let r = rowStart; r <= rowEnd; r += 1) {
      let startY;
      if (r === 0) {
        startY = -scrollHeight - 1;
      } else {
        startY = this.sheetCtx.visibledatarow[r - 1] - scrollHeight - 1;
      }

      const endY = this.sheetCtx.visibledatarow[r] - scrollHeight;

      if (this.sheetCtx.config?.rowhidden?.[r] != null) {
        continue;
      }

      for (let c = colStart; c <= colEnd; c += 1) {
        let startX;
        if (c === 0) {
          startX = -scrollWidth;
        } else {
          startX = this.sheetCtx.visibledatacolumn[c - 1] - scrollWidth;
        }

        const endX = this.sheetCtx.visibledatacolumn[c] - scrollWidth;

        if (this.sheetCtx.config?.colhidden?.[c] != null) {
          continue;
        }

        let firstcolumnlen = this.sheetCtx.defaultcollen;
        if (this.sheetCtx.config?.columnlen?.[c]) {
          firstcolumnlen = this.sheetCtx.config.columnlen[c];
        }

        if (flowdata?.[r]?.[c]) {
          const value = flowdata[r][c];

          if (value?.mc) {
            borderOffset[`${r}_${c}`] = {
              startY,
              startX,
              endY,
              endX,
            };

            if ("rs" in value.mc) {
              const key = `r${r}c${c}`;
              mergeCache[key] = cellupdate.length;
            } else {
              const key = `r${value.mc.r}c${value.mc.c}`;
              const margeMain = cellupdate[mergeCache[key]];

              if (margeMain == null) {
                mergeCache[key] = cellupdate.length;
                cellupdate.push({
                  r,
                  c,
                  startX,
                  startY,
                  endY,
                  endX,
                  firstcolumnlen,
                });
              } else {
                if (margeMain.c === c) {
                  margeMain.endY += endY - startY - 1;
                }

                if (margeMain.r === r) {
                  margeMain.endX += endX - startX;
                  margeMain.firstcolumnlen += firstcolumnlen;
                }
              }

              continue;
            }
          }
        }

        cellupdate.push({
          r,
          c,
          startY,
          startX,
          endY,
          endX,
          firstcolumnlen,
        });
        borderOffset[`${r}_${c}`] = {
          startY,
          startX,
          endY,
          endX,
        };
      }
    }

    const dynamicArrayCompute: any = {};
    const cfCompute: any = getComputeMap(this.sheetCtx);

    // Overflow cell configuration for render area
    const cellOverflowMap = this.getCellOverflowMap(
      renderCtx,
      colStart,
      colEnd,
      rowStart,
      rowEnd
    );

    const mcArr: typeof cellupdate = [];

    for (let cud = 0; cud < cellupdate.length; cud += 1) {
      const item = cellupdate[cud];
      const { r } = item;
      const { c } = item;
      const { startY } = item;
      const { startX } = item;
      const { endY } = item;
      const { endX } = item;

      if (flowdata[r] == null) {
        continue;
      }

      if (flowdata[r][c] == null) {
        // Empty cell
        this.nullCellRender(
          r,
          c,
          startY,
          startX,
          endY,
          endX,
          renderCtx,
          cfCompute,
          offsetLeft,
          offsetTop,
          dynamicArrayCompute,
          cellOverflowMap,
          colStart,
          colEnd,
          scrollHeight,
          scrollWidth,
          bodrder05,
          flowdata,
          drawGridLines
        );
      } else {
        const cell = flowdata[r][c];
        let value = null;

        if (cell?.mc) {
          mcArr.push(cellupdate[cud]);
        } else {
          value = getRealCellValue(r, c, flowdata);
        }

        if (value == null || value.toString().length === 0) {
          this.nullCellRender(
            r,
            c,
            startY,
            startX,
            endY,
            endX,
            renderCtx,
            cfCompute,
            offsetLeft,
            offsetTop,
            dynamicArrayCompute,
            cellOverflowMap,
            colStart,
            colEnd,
            scrollHeight,
            scrollWidth,
            bodrder05,
            flowdata,
            drawGridLines
          );
        } else {
          if (`${r}_${c}` in dynamicArrayCompute) {
            value = dynamicArrayCompute[`${r}_${c}`].v;
          }

          this.cellRender(
            r,
            c,
            startY,
            startX,
            endY,
            endX,
            value,
            renderCtx,
            cfCompute,
            offsetLeft,
            offsetTop,
            dynamicArrayCompute,
            cellOverflowMap,
            colStart,
            colEnd,
            scrollHeight,
            scrollWidth,
            bodrder05,
            flowdata,
            drawGridLines
          );
        }
      }
    }

    // Reprocess merged cells
    for (let m = 0; m < mcArr.length; m += 1) {
      const item = mcArr[m];
      let { r } = item;
      let { c } = item;
      let { startY } = item;
      let { startX } = item;
      let endY = item.endY - 1;
      let endX = item.endX - 1;

      const cell = flowdata[r][c];
      if (!cell) continue;

      let value = null;

      const mergeMaindata = cell.mc;
      if (!mergeMaindata) continue;

      value = getRealCellValue(mergeMaindata.r, mergeMaindata.c, flowdata);

      r = mergeMaindata.r;
      c = mergeMaindata.c;

      const mainCell = flowdata[r][c];

      if (!mainCell?.mc?.rs || !mainCell.mc?.cs) {
        continue;
      }

      if (c === 0) {
        startX = -scrollWidth;
      } else {
        startX = this.sheetCtx.visibledatacolumn[c - 1] - scrollWidth;
      }

      if (r === 0) {
        startY = -scrollHeight - 1;
      } else {
        startY = this.sheetCtx.visibledatarow[r - 1] - scrollHeight - 1;
      }

      endY =
        this.sheetCtx.visibledatarow[r + mainCell.mc.rs - 1] - scrollHeight;
      endX =
        this.sheetCtx.visibledatacolumn[c + mainCell.mc.cs - 1] - scrollWidth;

      if (value == null || value.toString().length === 0) {
        this.nullCellRender(
          r,
          c,
          startY,
          startX,
          endY,
          endX,
          renderCtx,
          cfCompute,
          offsetLeft,
          offsetTop,
          dynamicArrayCompute,
          cellOverflowMap,
          colStart,
          colEnd,
          scrollHeight,
          scrollWidth,
          bodrder05,
          flowdata,
          drawGridLines,
          true
        );
      } else {
        if (`${r}_${c}` in dynamicArrayCompute) {
          value = dynamicArrayCompute[`${r}_${c}`].v;
        }
        this.cellRender(
          r,
          c,
          startY,
          startX,
          endY,
          endX,
          value,
          renderCtx,
          cfCompute,
          offsetLeft,
          offsetTop,
          dynamicArrayCompute,
          cellOverflowMap,
          colStart,
          colEnd,
          scrollHeight,
          scrollWidth,
          bodrder05,
          flowdata,
          drawGridLines,
          true
        );
      }
    }

    // Border rendering
    if ((this.sheetCtx.config?.borderInfo?.length ?? 0) > 0) {
      const renderBorder = (
        style: any,
        color: string,
        dir: string,
        moveX: number,
        moveY: number,
        toX: number,
        toY: number
      ) => {
        renderCtx.save();
        setLineDash(renderCtx, style, dir, moveX, moveY, toX, toY);
        renderCtx.strokeStyle = color;
        renderCtx.stroke();
        renderCtx.closePath();
        renderCtx.restore();
      };

      const borderInfoCompute = getBorderInfoComputeRange(
        this.sheetCtx,
        rowStart,
        rowEnd,
        colStart,
        colEnd
      );

      const oL = offsetLeft!;
      const oT = offsetTop!;

      for (const [x, bdInfo] of Object.entries(borderInfoCompute)) {
        const sepIdx = x.indexOf("_");
        const bdRow = Number(x.substring(0, sepIdx));
        const bdCol = Number(x.substring(sepIdx + 1));

        const bdOffset = borderOffset[x];
        if (!bdOffset) continue;

        const { startY, startX, endY, endX } = bdOffset;

        const leftX = startX - 2 + bodrder05 + oL;
        const rightX = endX - 2 + bodrder05 + oL;
        const topY = startY + oT;
        const bottomY = endY - 2 + bodrder05 + oT;

        const cellOverflow_colInObj = this.cellOverflow_colIn(
          cellOverflowMap,
          bdRow,
          bdCol,
          colStart,
          colEnd
        );

        const notOverflowOrFirst =
          !cellOverflow_colInObj.colIn ||
          cellOverflow_colInObj.stc === bdCol;

        if (bdInfo.s && notOverflowOrFirst) {
          const mergeMap = this.sheetCtx.config.merge;
          const mergeCell = mergeMap?.[x];
          let slashEndX = rightX;
          let slashEndY = bottomY;
          if (mergeCell) {
            const mergeCellOffset =
              borderOffset[
                `${bdRow + mergeCell.rs - 1}_${bdCol + mergeCell.cs - 1}`
              ];
            slashEndX = mergeCellOffset.endX - 2 + bodrder05 + oL;
            slashEndY = mergeCellOffset.endY - 2 + bodrder05 + oT;
          }
          renderBorder(bdInfo.s.style, bdInfo.s.color, "v", leftX, topY, slashEndX, slashEndY);
        }

        if (bdInfo.l && notOverflowOrFirst) {
          renderBorder(bdInfo.l.style, bdInfo.l.color, "v", leftX, topY - 1, leftX, bottomY);
        }

        if (bdInfo.r && (!cellOverflow_colInObj.colIn || cellOverflow_colInObj.colLast)) {
          renderBorder(bdInfo.r.style, bdInfo.r.color, "v", rightX, topY - 1, rightX, bottomY);
        }

        if (bdInfo.t) {
          const tY = startY - 1 + bodrder05 + oT;
          renderBorder(bdInfo.t.style, bdInfo.t.color, "h", leftX, tY, rightX, tY);
        }

        if (bdInfo.b) {
          renderBorder(bdInfo.b.style, bdInfo.b.color, "h", leftX, bottomY, rightX, bottomY);
        }
      }
    }

    // Clear right gray area when last column is rendered to prevent overflow
    if (colEnd === this.sheetCtx.visibledatacolumn.length - 1) {
      renderCtx.clearRect(
        colEndX - scrollWidth + offsetLeft - 1,
        offsetTop - 1,
        this.sheetCtx.ch_width - this.sheetCtx.visibledatacolumn[colEnd],
        rowEndY - scrollHeight
      );
    }

    renderCtx.restore();

    sharedMeasureTextCacheTimeOut = setTimeout(() => {
      clearMeasureTextCache();
      sharedCellOverflowMapCache = {};
    }, 100);
  }

  // Get overflow cells for the render range
  private getCellOverflowMap(
    canvas: CanvasRenderingContext2D,
    colStart: number,
    colEnd: number,
    rowStart: number,
    rowEnd: number
  ) {
    const flowdata = getFlowdata(this.sheetCtx);
    const map: any = {};
    const data = flowdata;
    if (!data) {
      return map;
    }

    for (let r = rowStart; r <= rowEnd; r += 1) {
      if (data[r] == null) {
        continue;
      }

      if (sharedCellOverflowMapCache[r]) {
        map[r] = sharedCellOverflowMapCache[r];
        continue;
      }

      let hasCellOver = false;

      // Only scan columns near the visible range. Text overflow from cells
      // far outside the viewport cannot reach the visible area. A buffer of
      // 50 columns on each side is generous for even very wide text.
      const scanStart = Math.max(0, colStart - 50);
      const scanEnd = Math.min(data[r].length - 1, colEnd + 50);

      for (let c = scanStart; c <= scanEnd; c += 1) {
        const cell = data[r][c];

        if (this.sheetCtx.config?.colhidden?.[c] != null) {
          continue;
        }

        if (
          cell &&
          (!_.isEmpty(cell.v) || isInlineStringCell(cell)) &&
          cell.mc == null &&
          cell.tb === "1"
        ) {
          const horizonAlign = normalizedAttr(data, r, c, "ht");

          const textMetricsObj = getCellTextInfo(cell, canvas, this.sheetCtx, {
            r,
            c,
          });
          let textMetrics = 0;
          if (textMetricsObj) {
            textMetrics = textMetricsObj.textWidthAll;
          }

          // canvas.measureText(value).width;

          const startX = c - 1 < 0 ? 0 : this.sheetCtx.visibledatacolumn[c - 1];
          const endX = this.sheetCtx.visibledatacolumn[c];

          let stc;
          let edc;

          if (endX - startX < textMetrics) {
            if (horizonAlign === "0") {
              // Center aligned
              const trace_forward = this.cellOverflow_trace(
                r,
                c,
                c - 1,
                "forward",
                horizonAlign,
                textMetrics
              );
              const trace_backward = this.cellOverflow_trace(
                r,
                c,
                c + 1,
                "backward",
                horizonAlign,
                textMetrics
              );

              if (trace_forward.success) {
                stc = trace_forward.c;
              } else {
                stc = trace_forward.c + 1;
              }

              if (trace_backward.success) {
                edc = trace_backward.c;
              } else {
                edc = trace_backward.c - 1;
              }
            } else if (horizonAlign === "1") {
              // Left aligned
              const trace = this.cellOverflow_trace(
                r,
                c,
                c + 1,
                "backward",
                horizonAlign,
                textMetrics
              );
              stc = c;

              if (trace.success) {
                edc = trace.c;
              } else {
                edc = trace.c - 1;
              }
            } else if (horizonAlign === "2") {
              // Right aligned
              const trace = this.cellOverflow_trace(
                r,
                c,
                c - 1,
                "forward",
                horizonAlign,
                textMetrics
              );
              edc = c;

              if (trace.success) {
                stc = trace.c;
              } else {
                stc = trace.c + 1;
              }
            }
          } else {
            stc = c;
            edc = c;
          }

          if ((stc <= colEnd || edc >= colStart) && stc < edc) {
            const item = {
              r,
              stc,
              edc,
            };

            if (map[r] == null) {
              map[r] = {};
            }

            map[r][c] = item;

            hasCellOver = true;
          }
        }
      }

      if (hasCellOver) {
        sharedCellOverflowMapCache[r] = map[r];
      }
    }

    return map;
  }

  // Empty cell rendering
  private nullCellRender(
    r: number,
    c: number,
    startY: number,
    startX: number,
    endY: number,
    endX: number,
    renderCtx: CanvasRenderingContext2D,
    cfCompute: any,
    offsetLeft: number,
    offsetTop: number,
    dynamicArrayCompute: any,
    cellOverflowMap: any,
    colStart: number,
    colEnd: number,
    scrollHeight: number,
    scrollWidth: number,
    bodrder05: any,
    flowdata: any,
    drawGridLines = false,
    isMerge = false
  ) {
    const checksCF = checkCF(r, c, cfCompute);

    const borderfix = BORDER_FIX;

    // Background color
    let fillStyle = normalizedAttr(flowdata, r, c, "bg");

    if (checksCF?.cellColor != null) {
      fillStyle = checksCF.cellColor;
    }

    if (!fillStyle) {
      renderCtx.fillStyle = "#FFFFFF";
    } else {
      renderCtx.fillStyle = fillStyle;
    }

    const cellsize = [
      startX + offsetLeft + borderfix[0],
      startY + offsetTop + borderfix[1],
      endX - startX + borderfix[2] - (isMerge ? 1 : 0),
      endY - startY + borderfix[3],
    ];

    // Before cell render (merged cells may re-render)
    if (
      this.sheetCtx.hooks.beforeRenderCell?.(
        flowdata[r][c],
        {
          row: r,
          column: c,
          startX: cellsize[0],
          startY: cellsize[1],
          endX: cellsize[2] + cellsize[0],
          endY: cellsize[3] + cellsize[1],
        },
        renderCtx
      ) === false
    ) {
      return;
    }

    renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

    if (`${r}_${c}` in dynamicArrayCompute) {
      const value = dynamicArrayCompute[`${r}_${c}`].v;

      renderCtx.fillStyle = "#000000";
      // Text width and height
      const fontset = defaultFont(this.sheetCtx.defaultFontSize);
      renderCtx.font = fontset;

      // Horizontal align (default: left)
      const horizonAlignPos = startX + 4 + offsetLeft;

      // Vertical align (default: bottom)
      const verticalAlignPos = endY + offsetTop - 2;
      renderCtx.textBaseline = "bottom";

      renderCtx.fillText(
        value == null ? "" : value,
        horizonAlignPos,
        verticalAlignPos
      );
    }

    // Cell comment indicator (red triangle top-right)
    if (flowdata?.[r]?.[c]?.ps) {
      renderCtx.beginPath();
      renderCtx.moveTo(endX + offsetLeft - 9, startY + offsetTop);
      renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop);
      renderCtx.lineTo(endX + offsetLeft - 1, startY + offsetTop + 8);
      renderCtx.fillStyle = "#FC6666";
      renderCtx.fill();
      renderCtx.closePath();
    }

    // Check overflow cell relationship
    const cellOverflow_colInObj = this.cellOverflow_colIn(
      cellOverflowMap,
      r,
      c,
      colStart,
      colEnd
    );

    // Last column of overflow range: render overflow cell content
    if (
      cellOverflow_colInObj.colLast &&
      cellOverflow_colInObj.rowIndex != null &&
      cellOverflow_colInObj.colIndex != null &&
      cellOverflow_colInObj.stc != null &&
      cellOverflow_colInObj.edc != null
    ) {
      this.cellOverflowRender(
        cellOverflow_colInObj.rowIndex,
        cellOverflow_colInObj.colIndex,
        cellOverflow_colInObj.stc,
        cellOverflow_colInObj.edc,
        renderCtx,
        scrollHeight,
        scrollWidth,
        offsetLeft,
        offsetTop,
        cfCompute,
        flowdata
      );
    }

    // Overflow cell spans this cell, skip right border
    if (!cellOverflow_colInObj.colIn || cellOverflow_colInObj.colLast) {
      // Right border
      if (drawGridLines) {
        renderCtx.beginPath();
        renderCtx.moveTo(endX + offsetLeft - 2 + bodrder05, startY + offsetTop);
        renderCtx.lineTo(endX + offsetLeft - 2 + bodrder05, endY + offsetTop);
        renderCtx.lineWidth = 1;
        renderCtx.strokeStyle = defaultStyle.strokeStyle;
        renderCtx.stroke();
        renderCtx.closePath();
      }
    }

    // Bottom border
    if (drawGridLines) {
      renderCtx.beginPath();
      renderCtx.moveTo(
        startX + offsetLeft - 1,
        endY + offsetTop - 2 + bodrder05
      );
      renderCtx.lineTo(endX + offsetLeft - 1, endY + offsetTop - 2 + bodrder05);
      renderCtx.lineWidth = 1;
      renderCtx.strokeStyle = defaultStyle.strokeStyle;
      renderCtx.stroke();
      renderCtx.closePath();
    }

    // After cell render
    this.sheetCtx.hooks.afterRenderCell?.(
      flowdata[r][c],
      {
        row: r,
        column: c,
        startY: cellsize[1],
        startX: cellsize[0],
        endY: cellsize[3] + cellsize[1],
        endX: cellsize[2] + cellsize[0],
      },
      renderCtx
    );
  }

  private cellRender(
    r: number,
    c: number,
    startY: number,
    startX: number,
    endY: number,
    endX: number,
    value: any,
    renderCtx: CanvasRenderingContext2D,
    cfCompute: any,
    offsetLeft: number,
    offsetTop: number,
    dynamicArrayCompute: any,
    cellOverflowMap: any,
    colStart: number,
    colEnd: number,
    scrollHeight: number,
    scrollWidth: number,
    bodrder05: number,
    flowdata: any,
    drawGridLines = false,
    isMerge = false
  ) {
    const cell = flowdata[r][c];
    const cellWidth = endX - startX - 2;
    const cellHeight = endY - startY - 2;
    const space_width = 2;
    const space_height = 2;

    const horizonAlign = Number(normalizedAttr(flowdata, r, c, "ht"));
    const verticalAlign = Number(normalizedAttr(flowdata, r, c, "vt"));

    const checksCF = checkCF(r, c, cfCompute);

    // Background color
    let fillStyle = normalizedAttr(flowdata, r, c, "bg");
    if (checksCF?.cellColor != null) {
      fillStyle = checksCF.cellColor;
    }
    if (!fillStyle) {
      renderCtx.fillStyle = "#FFFFFF";
    } else {
      renderCtx.fillStyle = fillStyle;
    }

    const borderfix = BORDER_FIX;

    const cellsize = [
      startX + offsetLeft + borderfix[0],
      startY + offsetTop + borderfix[1],
      endX - startX + borderfix[2] - (isMerge ? 1 : 0),
      endY - startY + borderfix[3],
    ];

    // Before cell render (merged cells may re-render)
    if (
      this.sheetCtx.hooks.beforeRenderCell?.(
        flowdata[r][c],
        {
          row: r,
          column: c,
          startY: cellsize[1],
          startX: cellsize[0],
          endY: cellsize[3] + cellsize[1],
          endX: cellsize[2] + cellsize[0],
        },
        renderCtx
      ) === false
    ) {
      return;
    }

    renderCtx.fillRect(cellsize[0], cellsize[1], cellsize[2], cellsize[3]);

    // const { dataVerification } = dataVerificationCtrl;

    const index = getSheetIndex(
      this.sheetCtx,
      this.sheetCtx.currentSheetId
    ) as number;

    const { dataVerification } = this.sheetCtx.luckysheetfile[index];

    if (
      dataVerification?.[`${r}_${c}`] &&
      !validateCellData(this.sheetCtx, dataVerification[`${r}_${c}`], value)
    ) {
      // Data validation error indicator (red triangle top-left)
      renderCtx.beginPath();
      renderCtx.moveTo(startX + offsetLeft, startY + offsetTop);
      renderCtx.lineTo(startX + offsetLeft + 5, startY + offsetTop);
      renderCtx.lineTo(startX + offsetLeft, startY + offsetTop + 5);
      renderCtx.fillStyle = "#FC6666";
      renderCtx.fill();
      renderCtx.closePath();
    }

    // Cell comment indicator (red triangle top-right)
    if (cell?.ps) {
      renderCtx.beginPath();
      renderCtx.moveTo(endX + offsetLeft - 8, startY + offsetTop);
      renderCtx.lineTo(endX + offsetLeft, startY + offsetTop);
      renderCtx.lineTo(endX + offsetLeft, startY + offsetTop + 8);
      renderCtx.fillStyle = "#FC6666";
      renderCtx.fill();
      renderCtx.closePath();
    }

    // Forced-string indicator (green triangle top-left)
    if (cell?.qp === 1 && isRealNum(cell?.v)) {
      renderCtx.beginPath();
      renderCtx.moveTo(startX + offsetLeft + 5, startY + offsetTop);
      renderCtx.lineTo(startX + offsetLeft - 1, startY + offsetTop);
      renderCtx.lineTo(startX + offsetLeft - 1, startY + offsetTop + 6);
      renderCtx.fillStyle = "#487f1e";
      renderCtx.fill();
      renderCtx.closePath();
    }

    // Overflow cell handling
    let cellOverflow_bd_r_render = true;
    const cellOverflow_colInObj = this.cellOverflow_colIn(
      cellOverflowMap,
      r,
      c,
      colStart,
      colEnd
    );

    if (cell?.tb === "1" && cellOverflow_colInObj.colIn) {
      // Last column of overflow range: render overflow cell content
      if (
        cellOverflow_colInObj.colLast &&
        cellOverflow_colInObj.rowIndex != null &&
        cellOverflow_colInObj.colIndex != null &&
        cellOverflow_colInObj.stc != null &&
        cellOverflow_colInObj.edc != null
      ) {
        this.cellOverflowRender(
          cellOverflow_colInObj.rowIndex,
          cellOverflow_colInObj.colIndex,
          cellOverflow_colInObj.stc,
          cellOverflow_colInObj.edc,
          renderCtx,
          scrollHeight,
          scrollWidth,
          offsetLeft,
          offsetTop,
          cfCompute,
          flowdata
        );
      } else {
        cellOverflow_bd_r_render = false;
      }
    }
    // Data validation checkbox
    else if (dataVerification?.[`${r}_${c}`]?.type === "checkbox") {
      const pos_x = startX + offsetLeft;
      const pos_y = startY + offsetTop + 1;

      renderCtx.save();
      renderCtx.beginPath();
      renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
      renderCtx.clip();

      const measureText = getMeasureText(value, renderCtx, this.sheetCtx);
      const textMetrics = measureText.width + 14;
      const oneLineTextHeight =
        measureText.actualBoundingBoxDescent +
        measureText.actualBoundingBoxAscent;

      let horizonAlignPos = pos_x + space_width;
      if (horizonAlign === 0) {
        horizonAlignPos = pos_x + cellWidth / 2 - textMetrics / 2;
      } else if (horizonAlign === 2) {
        horizonAlignPos = pos_x + cellWidth - space_width - textMetrics;
      }

      const verticalCellHeight =
        cellHeight > oneLineTextHeight ? cellHeight : oneLineTextHeight;

      let verticalAlignPos_text = pos_y + verticalCellHeight - space_height;
      renderCtx.textBaseline = "bottom";
      let verticalAlignPos_checkbox = verticalAlignPos_text - 13;

      if (verticalAlign === 0) {
        verticalAlignPos_text = pos_y + verticalCellHeight / 2;
        renderCtx.textBaseline = "middle";
        verticalAlignPos_checkbox = verticalAlignPos_text - 6;
      } else if (verticalAlign === 1) {
        verticalAlignPos_text = pos_y + space_height;
        renderCtx.textBaseline = "top";
        verticalAlignPos_checkbox = verticalAlignPos_text + 1;
      }

      // Checkbox
      renderCtx.lineWidth = 1;
      renderCtx.strokeStyle = "#000";
      renderCtx.strokeRect(horizonAlignPos, verticalAlignPos_checkbox, 10, 10);

      if (dataVerification[`${r}_${c}`].checked) {
        renderCtx.beginPath();
        renderCtx.lineTo(horizonAlignPos + 1, verticalAlignPos_checkbox + 6);
        renderCtx.lineTo(horizonAlignPos + 4, verticalAlignPos_checkbox + 9);
        renderCtx.lineTo(horizonAlignPos + 9, verticalAlignPos_checkbox + 2);
        renderCtx.stroke();
        renderCtx.closePath();
      }

      // Text
      renderCtx.fillStyle = normalizedAttr(flowdata, r, c, "fc");
      renderCtx.fillText(
        value == null ? "" : value,
        horizonAlignPos + 14,
        verticalAlignPos_text
      );

      renderCtx.restore();
    } else {
      // Conditional formatting data bar
      if (
        checksCF?.dataBar?.valueLen &&
        checksCF?.dataBar?.valueLen?.toString() !== "NaN"
      ) {
        const x = startX + offsetLeft + space_width;
        const y = startY + offsetTop + space_height;
        const w = cellWidth - space_width * 2;
        const h = cellHeight - space_height * 2;

        const { valueType } = checksCF.dataBar;
        const { valueLen } = checksCF.dataBar;
        const { format } = checksCF.dataBar;

        if (valueType === "minus") {
          // Negative value
          const { minusLen } = checksCF.dataBar;

          if (format.length > 1) {
            // Gradient
            const my_gradient = renderCtx.createLinearGradient(
              x + w * minusLen * (1 - valueLen),
              y,
              x + w * minusLen,
              y
            );
            my_gradient.addColorStop(0, "#ffffff");
            my_gradient.addColorStop(1, "#ff0000");

            renderCtx.fillStyle = my_gradient;
          } else {
            // Solid
            renderCtx.fillStyle = "#ff0000";
          }

          renderCtx.fillRect(
            x + w * minusLen * (1 - valueLen),
            y,
            w * minusLen * valueLen,
            h
          );

          renderCtx.beginPath();
          renderCtx.moveTo(x + w * minusLen * (1 - valueLen), y);
          renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y + h);
          renderCtx.lineTo(x + w * minusLen, y + h);
          renderCtx.lineTo(x + w * minusLen, y);
          renderCtx.lineTo(x + w * minusLen * (1 - valueLen), y);
          renderCtx.lineWidth = 1;
          renderCtx.strokeStyle = "#ff0000";
          renderCtx.stroke();
          renderCtx.closePath();
        } else if (valueType === "plus") {
          // Positive value
          const { plusLen } = checksCF.dataBar;

          if (plusLen === 1) {
            if (format.length > 1) {
              // Gradient
              const my_gradient = renderCtx.createLinearGradient(
                x,
                y,
                x + w * valueLen,
                y
              );
              my_gradient.addColorStop(0, format[0]);
              my_gradient.addColorStop(1, format[1]);

              renderCtx.fillStyle = my_gradient;
            } else {
              // Solid
              [renderCtx.fillStyle] = format;
            }

            renderCtx.fillRect(x, y, w * valueLen, h);

            renderCtx.beginPath();
            renderCtx.moveTo(x, y);
            renderCtx.lineTo(x, y + h);
            renderCtx.lineTo(x + w * valueLen, y + h);
            renderCtx.lineTo(x + w * valueLen, y);
            renderCtx.lineTo(x, y);
            renderCtx.lineWidth = 1;
            [renderCtx.strokeStyle] = format;
            renderCtx.stroke();
            renderCtx.closePath();
          } else {
            const { minusLen } = checksCF.dataBar;

            if (format.length > 1) {
              // Gradient
              const my_gradient = renderCtx.createLinearGradient(
                x + w * minusLen,
                y,
                x + w * minusLen + w * plusLen * valueLen,
                y
              );
              my_gradient.addColorStop(0, format[0]);
              my_gradient.addColorStop(1, format[1]);

              renderCtx.fillStyle = my_gradient;
            } else {
              // Solid
              [renderCtx.fillStyle] = format;
            }

            renderCtx.fillRect(x + w * minusLen, y, w * plusLen * valueLen, h);

            renderCtx.beginPath();
            renderCtx.moveTo(x + w * minusLen, y);
            renderCtx.lineTo(x + w * minusLen, y + h);
            renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y + h);
            renderCtx.lineTo(x + w * minusLen + w * plusLen * valueLen, y);
            renderCtx.lineTo(x + w * minusLen, y);
            renderCtx.lineWidth = 1;
            [renderCtx.strokeStyle] = format;
            renderCtx.stroke();
            renderCtx.closePath();
          }
        }
      }

      const pos_x = startX + offsetLeft;
      const pos_y = startY + offsetTop + 1;

      renderCtx.save();
      renderCtx.beginPath();
      renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
      renderCtx.clip();

      const textInfo = cell
        ? getCellTextInfo(
            cell,
            renderCtx,
            this.sheetCtx,
            {
              cellWidth,
              cellHeight,
              space_width,
              space_height,
              r,
              c,
            },
            this.sheetCtx
          )
        : undefined;

      // Cell text color
      renderCtx.fillStyle = normalizedAttr(flowdata, r, c, "fc");

      if (checksCF?.textColor) {
        renderCtx.fillStyle = checksCF.textColor;
      }

      // Custom number format [Red]: set text color to red
      if (
        (cell?.ct?.fa?.indexOf("[Red]") ?? -1) > -1 &&
        cell?.ct?.t === "n" &&
        (cell?.v as number) < 0
      ) {
        renderCtx.fillStyle = "#ff0000";
      }

      this.cellTextRender(textInfo, renderCtx, {
        pos_x,
        pos_y,
      });

      renderCtx.restore();
    }

    if (cellOverflow_bd_r_render && drawGridLines) {
      // Right border
      renderCtx.beginPath();
      renderCtx.moveTo(endX + offsetLeft - 2 + bodrder05, startY + offsetTop);
      renderCtx.lineTo(endX + offsetLeft - 2 + bodrder05, endY + offsetTop);
      renderCtx.lineWidth = 1;
      renderCtx.strokeStyle = defaultStyle.strokeStyle;
      renderCtx.stroke();
      renderCtx.closePath();
    }

    // Bottom border
    if (drawGridLines) {
      renderCtx.beginPath();
      renderCtx.moveTo(
        startX + offsetLeft - 1,
        endY + offsetTop - 2 + bodrder05
      );
      renderCtx.lineTo(endX + offsetLeft - 1, endY + offsetTop - 2 + bodrder05);
      renderCtx.lineWidth = 1;
      renderCtx.strokeStyle = defaultStyle.strokeStyle;
      renderCtx.stroke();
      renderCtx.closePath();
    }

    // After cell render
    this.sheetCtx.hooks.afterRenderCell?.(
      flowdata[r]?.[c],
      {
        row: r,
        column: c,
        startX: cellsize[0],
        startY: cellsize[1],
        endX: cellsize[2] + cellsize[0],
        endY: cellsize[3] + cellsize[1],
      },
      renderCtx
    );
  }

  // Overflow cell rendering
  private cellOverflowRender(
    r: number,
    c: number,
    stc: number,
    edc: number,
    renderCtx: CanvasRenderingContext2D,
    scrollHeight: number,
    scrollWidth: number,
    offsetLeft: number,
    offsetTop: number,
    cfCompute: any,
    flowdata: any
  ) {
    // Overflow cell start/end row/column coordinates
    let startY;
    if (r === 0) {
      startY = -scrollHeight - 1;
    } else {
      startY = this.sheetCtx.visibledatarow[r - 1] - scrollHeight - 1;
    }

    const endY = this.sheetCtx.visibledatarow[r] - scrollHeight;

    let startX;
    if (stc === 0) {
      startX = -scrollWidth;
    } else {
      startX = this.sheetCtx.visibledatacolumn[stc - 1] - scrollWidth;
    }

    const endX = this.sheetCtx.visibledatacolumn[edc] - scrollWidth;

    const cell = flowdata[r][c];
    const cellWidth = endX - startX - 2;
    const cellHeight = endY - startY - 2;
    const space_width = 2;
    const space_height = 2;

    const pos_x = startX + offsetLeft;
    const pos_y = startY + offsetTop + 1;

    const fontset = getFontSet(
      cell,
      this.sheetCtx.defaultFontSize,
      this.sheetCtx
    );
    renderCtx.font = fontset;

    renderCtx.save();
    renderCtx.beginPath();
    renderCtx.rect(pos_x, pos_y, cellWidth, cellHeight);
    renderCtx.clip();

    const textInfo = cell
      ? getCellTextInfo(
          cell,
          renderCtx,
          this.sheetCtx,
          {
            cellWidth,
            cellHeight,
            space_width,
            space_height,
            r,
            c,
          },
          this.sheetCtx
        )
      : undefined;

    const checksCF = checkCF(r, c, cfCompute);

    // Cell text color
    renderCtx.fillStyle = normalizedAttr(flowdata, r, c, "fc");

    if (checksCF?.textColor) {
      renderCtx.fillStyle = checksCF.textColor;
    }

    this.cellTextRender(textInfo, renderCtx, {
      pos_x,
      pos_y,
    });

    renderCtx.restore();
  }

  private cellOverflow_trace(
    r: number,
    curC: number,
    traceC: number,
    traceDir: string,
    horizonAlign: string,
    textMetrics: number
  ): any {
    const flowdata = getFlowdata(this.sheetCtx);
    if (!flowdata) return {};
    const data = flowdata;

    // Trace terminates if column index is out of array bounds
    if (traceDir === "forward" && traceC < 0) {
      return {
        success: false,
        r,
        c: traceC,
      };
    }

    if (traceDir === "backward" && traceC > data[r].length - 1) {
      return {
        success: false,
        r,
        c: traceC,
      };
    }

    // Trace terminates if cell is non-empty or merged
    const cell = data[r][traceC];
    if (cell && (!_.isEmpty(cell.v) || cell.mc)) {
      return {
        success: false,
        r,
        c: traceC,
      };
    }

    let start_curC =
      curC - 1 < 0 ? 0 : this.sheetCtx.visibledatacolumn[curC - 1];
    let end_curC = this.sheetCtx.visibledatacolumn[curC];

    const w = textMetrics - (end_curC - start_curC);

    if (horizonAlign === "0") {
      // Center align
      start_curC -= w / 2;
      end_curC += w / 2;
    } else if (horizonAlign === "1") {
      // Left align
      end_curC += w;
    } else if (horizonAlign === "2") {
      // Right align
      start_curC -= w;
    }

    const start_traceC =
      traceC - 1 < 0 ? 0 : this.sheetCtx.visibledatacolumn[traceC - 1];
    const end_traceC = this.sheetCtx.visibledatacolumn[traceC];

    if (traceDir === "forward") {
      if (start_curC < start_traceC) {
        return this.cellOverflow_trace(
          r,
          curC,
          traceC - 1,
          traceDir,
          horizonAlign,
          textMetrics
        );
      }
      if (start_curC < end_traceC) {
        return {
          success: true,
          r,
          c: traceC,
        };
      }
      return {
        success: false,
        r,
        c: traceC,
      };
    }

    if (traceDir === "backward") {
      if (end_curC > end_traceC) {
        return this.cellOverflow_trace(
          r,
          curC,
          traceC + 1,
          traceDir,
          horizonAlign,
          textMetrics
        );
      }
      if (end_curC > start_traceC) {
        return {
          success: true,
          r,
          c: traceC,
        };
      }
      return {
        success: false,
        r,
        c: traceC,
      };
    }
    return null;
  }

  private cellOverflow_colIn(
    map: any,
    r: number,
    c: number,
    col_st: number,
    col_ed: number
  ) {
    let colIn = false; // Whether this cell is within an overflow cell's render range
    let colLast = false; // Whether this cell is the last column in an overflow cell's render range
    let rowIndex: number | undefined; // Overflow cell row index
    let colIndex: number | undefined; // Overflow cell column index
    let stc: number | undefined;
    let edc: number | undefined;

    if (map) {
      for (const rkey of Object.keys(map)) {
        const row = map[rkey];
        for (const ckey of Object.keys(row)) {
          const mapItem = row[ckey];
          const ri = Number(rkey);
          const ci = Number(ckey);

          if (ri === r && c >= mapItem.stc && c <= mapItem.edc) {
            colIn = true;
            rowIndex = ri;
            colIndex = ci;
            stc = mapItem.stc;
            edc = mapItem.edc;

            if (c === mapItem.edc || c === col_ed) {
              colLast = true;
              break;
            }
          }
        }
        if (colLast) break;
      }
    }

    return {
      colIn,
      colLast,
      rowIndex,
      colIndex,
      stc,
      edc,
    };
  }

  private cellTextRender(textInfo: any, ctx: CanvasRenderingContext2D, option: any) {
    if (!textInfo) {
      return;
    }
    const { values } = textInfo;
    const { pos_x } = option;
    const { pos_y } = option;
    if (!values) {
      return;
    }
    if (textInfo.rotate !== 0 && textInfo.type !== "verticalWrap") {
      ctx.save();
      ctx.translate(
        pos_x + textInfo.textLeftAll,
        pos_y + textInfo.textTopAll
      );
      ctx.rotate((-textInfo.rotate * Math.PI) / 180);
      ctx.translate(
        -(textInfo.textLeftAll + pos_x),
        -(pos_y + textInfo.textTopAll)
      );
    }

    for (let i = 0; i < values.length; i += 1) {
      const word = values[i];
      if (word.inline === true && word.style) {
        ctx.font = word.style.fontset;
        ctx.fillStyle = word.style.fc;
      } else {
        ctx.font = word.style;
      }

      // Handle word.content being an object (edge case)
      const txt = _.isPlainObject(word.content) ? word.content.m : word.content;
      ctx.fillText(txt, pos_x + word.left, pos_y + word.top);

      if (word.cancelLine) {
        const c = word.cancelLine;
        ctx.beginPath();
        ctx.moveTo(
          Math.floor(pos_x + c.startX) + 0.5,
          Math.floor(pos_y + c.startY) + 0.5
        );
        ctx.lineTo(
          Math.floor(pos_x + c.endX) + 0.5,
          Math.floor(pos_y + c.endY) + 0.5
        );
        ctx.lineWidth = Math.floor(c.fs / 9);
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
        ctx.closePath();
      }

      if (word.underLine) {
        const underLines = word.underLine;
        for (let a = 0; a < underLines.length; a += 1) {
          const item = underLines[a];
          ctx.beginPath();
          ctx.moveTo(
            Math.floor(pos_x + item.startX) + 0.5,
            Math.floor(pos_y + item.startY)
          );
          ctx.lineTo(
            Math.floor(pos_x + item.endX) + 0.5,
            Math.floor(pos_y + item.endY) + 0.5
          );
          ctx.lineWidth = Math.floor(item.fs / 9);
          ctx.strokeStyle = ctx.fillStyle;
          ctx.stroke();
          ctx.closePath();
        }
      }
    }
    if (textInfo.rotate !== 0 && textInfo.type !== "verticalWrap") {
      ctx.restore();
    }
  }

  public drawFreezeLine({
    horizontalTop,
    verticalLeft,
  }: {
    horizontalTop?: number;
    verticalLeft?: number;
  }) {
    const renderCtx = this.canvasElement.getContext("2d");
    if (!renderCtx) return;

    renderCtx.save();
    renderCtx.scale(
      this.sheetCtx.devicePixelRatio,
      this.sheetCtx.devicePixelRatio
    );
    renderCtx.strokeStyle = "#ccc";
    renderCtx.lineWidth = 2;

    if (horizontalTop) {
      renderCtx.beginPath();
      renderCtx.moveTo(0, horizontalTop);
      renderCtx.lineTo(this.canvasElement.width, horizontalTop);
      renderCtx.stroke();
      renderCtx.closePath();
    }

    if (verticalLeft) {
      renderCtx.beginPath();
      renderCtx.moveTo(verticalLeft, 0);
      renderCtx.lineTo(verticalLeft, this.canvasElement.height);
      renderCtx.stroke();
      renderCtx.closePath();
    }

    renderCtx.restore();
  }
}
