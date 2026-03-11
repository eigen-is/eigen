import {useCallback, useContext, useMemo, useRef, useState} from "react";
import {
    applyLocation,
    autoSelectionFormula,
    clearFilter,
    createFilter,
    deleteComment,
    editComment,
    getFlowdata,
    handleBorder,
    handleFreeze,
    handleHorizontalAlign,
    handleMerge,
    handleScreenShot,
    handleSort,
    handleSum,
    handleTextBackground,
    handleTextColor,
    handleTextSize,
    handleVerticalAlign,
    locale,
    newComment,
    normalizedCellAttr,
    showHideAllComments,
    showHideComment,
    showImgChooser,
    toolbarItemClickHandler,
    toolbarItemSelectedFunc,
    updateFormat,
} from "../../core";
import _ from "lodash";
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {Toolbar as SharedToolbar, TooltipButton} from "@workspace/ui";
import WorkbookContext from "../../context";
import {useDialog} from "../../hooks/useDialog";
import {FormulaSearch} from "../FormulaSearch";
import {SplitColumn} from "../SplitColumn";
import {LocationCondition} from "../LocationCondition";
import DataVerification from "../DataVerification";
import ConditionalFormat from "../ConditionFormat";
import {CustomBorder} from "./CustomBorder";
import {FormatSearch} from "../FormatSearch";
import {
    ColorCombo,
    ICON_MAP,
    ToolbarDropdown,
    ToolbarIcon,
    ToolbarMenuButton,
    ToolbarSeparator,
} from "./toolbar-helpers";

export function Toolbar({
  leftItems,
  rightItems,
}: {
  leftItems?: React.ReactNode;
  rightItems?: React.ReactNode;
}) {
  const { context, setContext, refs, settings, handleUndo, handleRedo } =
    useContext(WorkbookContext);
  const contextRef = useRef(context);
  const { showDialog, hideDialog } = useDialog();
  const firstSelection = context.luckysheet_select_save?.[0];
  const flowdata = getFlowdata(context);
  contextRef.current = context;
  const row = firstSelection?.row_focus;
  const col = firstSelection?.column_focus;
  const cell =
    flowdata && row != null && col != null ? flowdata?.[row]?.[col] : undefined;
  const {
    toolbar,
    merge,
    border,
    freezen,
    defaultFmt,
    formula,
    sort,
    align,
    textWrap,
    rotation,
    screenshot,
    filter,
    splitText,
    findAndReplace,
    comment,
    fontarray,
  } = locale(context);
  const toolbarFormat = locale(context).format;
  const { currency } = settings;
  const defaultFormat = defaultFmt(currency);

  const [customColor, setCustomColor] = useState("#000000");
  const [customStyle, setCustomStyle] = useState("1");

  const getToolbarItem = useCallback(
    (name: string, i: number) => {
      // @ts-ignore
      const tooltip = toolbar[name];

      if (name === "|") {
        return <ToolbarSeparator key={i} />;
      }

      if (["font-color", "background"].includes(name)) {
        const pick = (color: string | undefined) => {
          setContext((draftCtx) =>
            (name === "font-color" ? handleTextColor : handleTextBackground)(
              draftCtx,
              refs.cellInput.current!,
              color as string
            )
          );
          if (name === "font-color") {
            refs.globalCache.recentTextColor = color;
          } else {
            refs.globalCache.recentBackgroundColor = color;
          }
        };
        return (
          <ColorCombo
            key={name}
            name={name}
            tooltip={tooltip}
            recentColor={
              name === "font-color"
                ? refs.globalCache.recentTextColor
                : refs.globalCache.recentBackgroundColor
            }
            onPick={pick}
          />
        );
      }

      if (name === "format") {
        let currentFmt = defaultFormat[0].text;
        if (cell) {
          const curr = normalizedCellAttr(cell, "ct");
          const format = _.find(defaultFormat, (v) => v.value === curr?.fa);
          if (curr?.fa != null) {
            currentFmt =
              format != null
                ? format.text
                : defaultFormat[defaultFormat.length - 1].text;
          }
        }
        return (
          <ToolbarDropdown text={currentFmt} key={name} tooltip={tooltip}>
            {defaultFormat.map(({ text, value, example }, ii) => {
              if (value === "split") {
                return <DropdownMenuSeparator key={ii} />;
              }
              if (value === "fmtOtherSelf") {
                return (
                  <DropdownMenuSub key={value}>
                    <DropdownMenuSubTrigger>{text}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem
                        onClick={() => {
                          showDialog(
                            <FormatSearch
                              onCancel={hideDialog}
                              type="currency"
                            />
                          );
                        }}
                      >
                        {toolbarFormat.moreCurrency}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          showDialog(
                            <FormatSearch
                              onCancel={hideDialog}
                              type="number"
                            />
                          );
                        }}
                      >
                        {toolbarFormat.moreNumber}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              }
              return (
                <DropdownMenuItem
                  key={value}
                  onClick={() => {
                    setContext((ctx) => {
                      const d = getFlowdata(ctx);
                      if (d == null) return;
                      updateFormat(ctx, refs.cellInput.current!, d, "ct", value);
                    });
                  }}
                >
                  <div className="flex items-center justify-between w-full">
                    <span>{text}</span>
                    <span className="text-xs opacity-50 pl-6">{example}</span>
                  </div>
                </DropdownMenuItem>
              );
            })}
          </ToolbarDropdown>
        );
      }

      if (name === "font") {
        let current = fontarray[0];
        if (cell?.ff != null) {
          current = _.isNumber(cell.ff) ? fontarray[cell.ff] : cell.ff;
        }
        return (
          <ToolbarDropdown text={current} key={name} tooltip={tooltip}>
            {fontarray.map((o) => (
              <DropdownMenuItem
                key={o}
                onClick={() => {
                  setContext((ctx) => {
                    const d = getFlowdata(ctx);
                    if (!d) return;
                    updateFormat(ctx, refs.cellInput.current!, d, "ff", o);
                  });
                }}
              >
                {o}
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "font-size") {
        return (
          <ToolbarDropdown
            text={
              cell
                ? normalizedCellAttr(cell, "fs", context.defaultFontSize)
                : context.defaultFontSize.toString()
            }
            key={name}
            tooltip={tooltip}
          >
            {[9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72].map(
              (num) => (
                <DropdownMenuItem
                  key={num}
                  onClick={() => {
                    setContext((draftContext) =>
                      handleTextSize(
                        draftContext,
                        refs.cellInput.current!,
                        num,
                        refs.canvas.current!.getContext("2d")!
                      )
                    );
                  }}
                >
                  {num}
                </DropdownMenuItem>
              )
            )}
          </ToolbarDropdown>
        );
      }

      if (name === "horizontal-align") {
        const items = [
          { id: "align-left", text: align.left, value: 1 },
          { id: "align-center", text: align.center, value: 0 },
          { id: "align-right", text: align.right, value: 2 },
        ];
        const currentId =
          _.find(items, (item) => `${item.value}` === `${cell?.ht}`)?.id ||
          "align-left";
        return (
          <ToolbarMenuButton
            iconId={currentId}
            key={name}
            tooltip={toolbar.horizontalAlign}
          >
            {items.map(({ text, id }) => (
              <DropdownMenuItem
                key={id}
                onClick={() => {
                  setContext((ctx) => {
                    handleHorizontalAlign(
                      ctx,
                      refs.cellInput.current!,
                      id.replace("align-", "")
                    );
                  });
                }}
              >
                <div className="flex items-center gap-2">
                  <ToolbarIcon name={id} className="h-4 w-4" />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "vertical-align") {
        const items = [
          { id: "align-top", text: align.top, value: 1 },
          { id: "align-middle", text: align.middle, value: 0 },
          { id: "align-bottom", text: align.bottom, value: 2 },
        ];
        const currentId =
          _.find(items, (item) => `${item.value}` === `${cell?.vt}`)?.id ||
          "align-top";
        return (
          <ToolbarMenuButton
            iconId={currentId}
            key={name}
            tooltip={toolbar.verticalAlign}
          >
            {items.map(({ text, id }) => (
              <DropdownMenuItem
                key={id}
                onClick={() => {
                  setContext((ctx) => {
                    handleVerticalAlign(
                      ctx,
                      refs.cellInput.current!,
                      id.replace("align-", "")
                    );
                  });
                }}
              >
                <div className="flex items-center gap-2">
                  <ToolbarIcon name={id} className="h-4 w-4" />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "undo") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={tooltip}
            disabled={refs.globalCache.undoList.length === 0}
            onClick={() => handleUndo()}
          />
        );
      }

      if (name === "redo") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={tooltip}
            disabled={refs.globalCache.redoList.length === 0}
            onClick={() => handleRedo()}
          />
        );
      }

      if (name === "screenshot") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={tooltip}
            onClick={() => {
              const imgsrc = handleScreenShot(contextRef.current);
              if (imgsrc) {
                showDialog(
                  <div className="p-6">
                    <p className="text-sm mb-3">
                      {screenshot.screenshotTipSuccess}
                    </p>
                    <img
                      src={imgsrc}
                      alt=""
                      style={{ maxWidth: "100%", maxHeight: "100%" }}
                    />
                  </div>
                );
              }
            }}
          />
        );
      }

      if (name === "splitColumn") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={tooltip}
            onClick={() => {
                if (contextRef.current.allowEdit === false) return;
                if (_.isUndefined(contextRef.current.luckysheet_select_save)) {
                showDialog(splitText.tipNoSelect, "ok");
              } else {
                const currentColumn =
                    contextRef.current.luckysheet_select_save[
                    contextRef.current.luckysheet_select_save.length - 1
                  ].column;
                    if (contextRef.current.luckysheet_select_save.length > 1) {
                  showDialog(splitText.tipNoMulti, "ok");
                } else if (currentColumn[0] !== currentColumn[1]) {
                  showDialog(splitText.tipNoMultiColumn, "ok");
                } else {
                  showDialog(<SplitColumn />);
                }
              }
            }}
          />
        );
      }

      if (name === "dataVerification") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={tooltip}
            onClick={() => {
                if (contextRef.current.allowEdit === false) return;
              showDialog(<DataVerification />);
            }}
          />
        );
      }

      if (name === "locationCondition") {
        const items = [
          { text: findAndReplace.location, value: "location" },
          { text: findAndReplace.locationFormula, value: "locationFormula" },
          { text: findAndReplace.locationDate, value: "locationDate" },
          { text: findAndReplace.locationDigital, value: "locationDigital" },
          { text: findAndReplace.locationString, value: "locationString" },
          { text: findAndReplace.locationError, value: "locationError" },
          { text: findAndReplace.locationRowSpan, value: "locationRowSpan" },
          { text: findAndReplace.columnSpan, value: "locationColumnSpan" },
        ];
        return (
          <ToolbarMenuButton
            iconId="locationCondition"
            key={name}
            tooltip={findAndReplace.location}
          >
            {items.map(({ text, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                    const ctx = contextRef.current;
                    if (ctx.luckysheet_select_save == null) {
                    showDialog(freezen.noSeletionError, "ok");
                    return;
                  }
                    const last = ctx.luckysheet_select_save[0];
                    const fd = getFlowdata(ctx);
                  let range: { row: any[]; column: any[] }[];
                  let rangeArr: any[] = [];
                  if (
                      ctx.luckysheet_select_save?.length === 0 ||
                      (ctx.luckysheet_select_save?.length === 1 &&
                      last.row[0] === last.row[1] &&
                      last.column[0] === last.column[1])
                  ) {
                    range = [
                      {
                          row: [0, fd!.length - 1],
                          column: [0, fd![0].length - 1],
                      },
                    ];
                  } else {
                      range = _.assignIn([], ctx.luckysheet_select_save);
                  }
                  if (value === "location") {
                    showDialog(<LocationCondition />);
                  } else if (value === "locationFormula") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationFormula", "all", c);
                      });
                  } else if (value === "locationDate") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationConstant", "d", c);
                      });
                  } else if (value === "locationDigital") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationConstant", "n", c);
                      });
                  } else if (value === "locationString") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationConstant", "s,g", c);
                      });
                  } else if (value === "locationError") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationConstant", "e", c);
                      });
                  } else if (value === "locationCondition") {
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationCF", undefined, c);
                      });
                  } else if (value === "locationRowSpan") {
                    if (
                        ctx.luckysheet_select_save?.length === 0 ||
                        (ctx.luckysheet_select_save?.length === 1 &&
                            ctx.luckysheet_select_save[0].row[0] ===
                            ctx.luckysheet_select_save[0].row[1])
                    ) {
                        showDialog(findAndReplace.locationTiplessTwoRow, "ok");
                      return;
                    }
                      range = _.assignIn([], ctx.luckysheet_select_save);
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationRowSpan", undefined, c);
                      });
                  } else if (value === "locationColumnSpan") {
                    if (
                        ctx.luckysheet_select_save?.length === 0 ||
                        (ctx.luckysheet_select_save?.length === 1 &&
                            ctx.luckysheet_select_save[0].column[0] ===
                            ctx.luckysheet_select_save[0].column[1])
                    ) {
                        showDialog(findAndReplace.locationTiplessTwoColumn, "ok");
                      return;
                    }
                      range = _.assignIn([], ctx.luckysheet_select_save);
                      setContext((c) => {
                          rangeArr = applyLocation(range, "locationColumnSpan", undefined, c);
                      });
                  }
                  if (rangeArr.length === 0 && value !== "location")
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
                }}
              >
                {text}
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "conditionFormat") {
        const items = [
          "highlightCellRules",
          "itemSelectionRules",
          "-",
          "deleteRule",
        ];
        return (
          <ToolbarMenuButton
            iconId="conditionFormat"
            key={name}
            tooltip={toolbar.conditionalFormat}
          >
            <ConditionalFormat items={items} />
          </ToolbarMenuButton>
        );
      }

      if (name === "image") {
        return (
          <TooltipButton
            key={name}
            icon={ICON_MAP[name]!}
            tooltipText={toolbar.insertImage}
            onClick={() => {
                if (contextRef.current.allowEdit === false) return;
              showImgChooser();
            }}
          />
        );
      }

      if (name === "comment") {
        const last =
            contextRef.current.luckysheet_select_save?.[
            contextRef.current.luckysheet_select_save.length - 1
          ];
        let row_index = last?.row_focus;
        let col_index = last?.column_focus;
        if (!last) {
          row_index = 0;
          col_index = 0;
        } else {
          if (row_index == null) [row_index] = last.row;
          if (col_index == null) [col_index] = last.column;
        }
          const fd = getFlowdata(contextRef.current);
        let itemData: { key: string; text: string; onClick: any }[];
          if (fd?.[row_index]?.[col_index]?.ps != null) {
          itemData = [
            { key: "edit", text: comment.edit, onClick: editComment },
            { key: "delete", text: comment.delete, onClick: deleteComment },
              {key: "showOrHide", text: comment.showOne, onClick: showHideComment},
              {key: "showOrHideAll", text: comment.showAll, onClick: showHideAllComments},
          ];
        } else {
          itemData = [
            { key: "new", text: comment.insert, onClick: newComment },
              {key: "showOrHideAll", text: comment.showAll, onClick: showHideAllComments},
          ];
        }
        return (
          <ToolbarMenuButton iconId={name} key={name} tooltip={tooltip}>
            {itemData.map(({ key, text, onClick }) => (
              <DropdownMenuItem
                key={key}
                onClick={() => {
                  setContext((draftContext) =>
                      onClick(draftContext, refs.globalCache, row_index, col_index)
                  );
                }}
              >
                {text}
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "quick-formula") {
        const itemData = [
          { text: formula.sum, value: "SUM" },
          { text: formula.average, value: "AVERAGE" },
          { text: formula.count, value: "COUNT" },
          { text: formula.max, value: "MAX" },
          { text: formula.min, value: "MIN" },
        ];
        return (
            <ToolbarMenuButton iconId="formula-sum" key={name} tooltip={toolbar.autoSum}>
            <DropdownMenuItem
                onClick={() => setContext((ctx) => {
                    handleSum(ctx, refs.cellInput.current!, refs.fxInput.current, refs.globalCache!);
                })}
            >
              {formula.sum} (SUM)
            </DropdownMenuItem>
            {itemData.slice(1).map(({ value, text }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  setContext((ctx) => {
                      autoSelectionFormula(ctx, refs.cellInput.current!, refs.fxInput.current, value, refs.globalCache);
                  });
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <span className="text-xs opacity-50 pl-6">{value}</span>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => showDialog(<FormulaSearch onCancel={hideDialog}/>)}>
              {`${formula.find}...`}
            </DropdownMenuItem>
          </ToolbarMenuButton>
        );
      }

      if (name === "merge-cell") {
        const itemdata = [
          { text: merge.mergeAll, value: "merge-all" },
          { text: merge.mergeV, value: "merge-vertical" },
          { text: merge.mergeH, value: "merge-horizontal" },
          { text: merge.mergeCancel, value: "merge-cancel" },
        ];
        return (
            <ToolbarMenuButton iconId="merge-all" key={name} tooltip={tooltip}>
            {itemdata.map(({ text, value }) => (
                <DropdownMenuItem key={value} onClick={() => {
                    setContext((ctx) => {
                        handleMerge(ctx, value);
                    });
                }}>
                {text}
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "border") {
        const items = [
          { text: border.borderTop, value: "border-top" },
          { text: border.borderBottom, value: "border-bottom" },
          { text: border.borderLeft, value: "border-left" },
          { text: border.borderRight, value: "border-right" },
          { text: "", value: "divider" },
          { text: border.borderNone, value: "border-none" },
          { text: border.borderAll, value: "border-all" },
          { text: border.borderOutside, value: "border-outside" },
          { text: "", value: "divider" },
          { text: border.borderInside, value: "border-inside" },
          { text: border.borderHorizontal, value: "border-horizontal" },
          { text: border.borderVertical, value: "border-vertical" },
          { text: border.borderSlash, value: "border-slash" },
          { text: "", value: "divider" },
        ];
        return (
            <ToolbarMenuButton iconId="border-all" key={name} tooltip={tooltip}>
            {items.map(({ text, value }, ii) =>
              value !== "divider" ? (
                  <DropdownMenuItem key={value} onClick={() => {
                      setContext((ctx) => {
                          handleBorder(ctx, value, customColor, customStyle);
                      });
                  }}>
                  {text}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSeparator key={`divider-${ii}`} />
              )
            )}
                <CustomBorder onPick={(color, style) => {
                    setCustomColor(color as string);
                    setCustomStyle(style as string);
                }}/>
          </ToolbarMenuButton>
        );
      }

      if (name === "freeze") {
        const items = [
          { text: freezen.freezenRowRange, value: "freeze-row" },
          { text: freezen.freezenColumnRange, value: "freeze-col" },
          { text: freezen.freezenRCRange, value: "freeze-row-col" },
          { text: freezen.freezenCancel, value: "freeze-cancel" },
        ];
        return (
            <ToolbarMenuButton iconId="freeze-row-col" key={name} tooltip={tooltip}>
            {items.map(({ text, value }) => (
                <DropdownMenuItem key={value} onClick={() => {
                    setContext((ctx) => {
                        handleFreeze(ctx, value);
                    });
                }}>
                <div className="flex items-center gap-2">
                  <ToolbarIcon name={value} className="h-4 w-4" />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "text-wrap") {
        const items = [
          { text: textWrap.clip, id: "text-clip", value: "clip" },
          { text: textWrap.overflow, id: "text-overflow", value: "overflow" },
          { text: textWrap.wrap, id: "text-wrap", value: "wrap" },
        ];
        return (
            <ToolbarMenuButton iconId="text-wrap" key={name} tooltip={toolbar.textWrap}>
            {items.map(({ text, id, value }) => (
                <DropdownMenuItem key={value} onClick={() => {
                    setContext((ctx) => {
                        const d = getFlowdata(ctx);
                        if (d == null) return;
                        updateFormat(ctx, refs.cellInput.current!, d, "tb", value);
                    });
                }}>
                <div className="flex items-center gap-2">
                  <ToolbarIcon name={id} className="h-4 w-4" />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "text-rotation") {
        const items = [
          { text: rotation.none, id: "text-rotation-none", value: "none" },
            {text: rotation.angleup, id: "text-rotation-angleup", value: "angleup"},
            {text: rotation.angledown, id: "text-rotation-angledown", value: "angledown"},
            {text: rotation.vertical, id: "text-rotation-vertical", value: "vertical"},
            {text: rotation.rotationUp, id: "text-rotation-up", value: "rotation-up"},
            {text: rotation.rotationDown, id: "text-rotation-down", value: "rotation-down"},
        ];
        return (
            <ToolbarMenuButton iconId="text-rotation-none" key={name} tooltip={toolbar.textRotate}>
            {items.map(({ text, id, value }) => (
                <DropdownMenuItem key={value} onClick={() => {
                    setContext((ctx) => {
                        const d = getFlowdata(ctx);
                        if (d == null) return;
                        updateFormat(ctx, refs.cellInput.current!, d, "tr", value);
                    });
                }}>
                <div className="flex items-center gap-2">
                  <ToolbarIcon name={id} className="h-4 w-4" />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarMenuButton>
        );
      }

      if (name === "filter") {
        const items = [
            {
                id: "sort-asc", value: "sort-asc", text: sort.asc, onClick: () => setContext((ctx) => {
                    handleSort(ctx, true);
                })
            },
            {
                id: "sort-desc", value: "sort-desc", text: sort.desc, onClick: () => setContext((ctx) => {
                    handleSort(ctx, false);
                })
            },
          { id: "", value: "divider" },
            {
                id: "filter1", value: "filter", text: filter.filter, onClick: () => setContext((draftCtx) => {
                    createFilter(draftCtx);
                })
            },
            {
                id: "eraser", value: "eraser", text: filter.clearFilter, onClick: () => setContext((draftCtx) => {
                    clearFilter(draftCtx);
                })
            },
        ];
        return (
            <ToolbarMenuButton iconId="filter" key={name} tooltip={toolbar.sortAndFilter}>
            {items.map(({ text, id, value, onClick }, index) =>
              value !== "divider" ? (
                <DropdownMenuItem key={value} onClick={() => onClick?.()}>
                  <div className="flex items-center gap-2">
                    <ToolbarIcon name={id} className="h-4 w-4" />
                    <span>{text}</span>
                  </div>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSeparator key={`divider-${index}`} />
              )
            )}
          </ToolbarMenuButton>
        );
      }

      {
        const Icon = ICON_MAP[name];
        if (Icon) {
          const selected = toolbarItemSelectedFunc(name)?.(cell);
          return (
            <TooltipButton
              key={name}
              icon={Icon}
              tooltipText={tooltip}
              active={!!selected}
              onClick={() =>
                setContext((draftCtx) => {
                    toolbarItemClickHandler(name)?.(draftCtx, refs.cellInput.current!, refs.globalCache);
                })
              }
            />
          );
        }

        return (
          <ToolbarMenuButton iconId={name} key={name} tooltip={tooltip}>
            <DropdownMenuItem
              onClick={() =>
                setContext((draftCtx) => {
                    toolbarItemClickHandler(name)?.(draftCtx, refs.cellInput.current!, refs.globalCache);
                })
              }
            >
              {tooltip}
            </DropdownMenuItem>
          </ToolbarMenuButton>
        );
      }
    },
      // Only rebuild when the focused cell or relevant toolbar state changes.
      // During drag selection, cell/row/col don't change, so this is stable.
    [
        cell, row, col,
        toolbar, setContext, refs.cellInput, refs.fxInput, refs.globalCache, refs.canvas,
        defaultFormat, align, handleUndo, handleRedo, formula, showDialog, hideDialog,
        merge, border, freezen, screenshot, sort, textWrap, rotation, filter,
        splitText, findAndReplace, comment, fontarray,
        context.defaultFontSize, context.allowEdit,
        customColor, customStyle, toolbarFormat.moreCurrency, toolbarFormat.moreNumber,
    ]
  );

    // Memoize the entire toolbar output. During drag selection, none of these
    // deps change (cell stays the same, focused row/col don't move), so React
    // reuses the cached JSX and skips reconciliation of 1100+ lines of toolbar.
    return useMemo(() => (
    <header className="border-b border-border">
      <SharedToolbar>
        <div className="flex items-center gap-0.5 shrink-0">
          {leftItems}
          {leftItems ? <ToolbarSeparator /> : null}
          {getToolbarItem("undo", -1)}
          {getToolbarItem("redo", -2)}
        </div>
        <div className="flex items-center gap-0.5 flex-wrap">
          {settings.customToolbarItems.length > 0 && (
            <>
              {settings.customToolbarItems.map((n) => (
                <TooltipButton
                  key={n.key}
                  icon={n.icon as any}
                  tooltipText={n.tooltip ?? ""}
                  onClick={() => n.onClick?.({} as any)}
                />
              ))}
              <ToolbarSeparator />
            </>
          )}
          {settings.toolbarItems
            .filter((n) => !["undo", "redo", "format-painter", "clear-format"].includes(n))
            .map((name, i) => getToolbarItem(name, i))}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {getToolbarItem("format-painter", -3)}
          {getToolbarItem("clear-format", -4)}
          {rightItems && <ToolbarSeparator />}
          {rightItems}
        </div>
      </SharedToolbar>
    </header>
    ), [getToolbarItem, leftItems, rightItems, settings.customToolbarItems, settings.toolbarItems]);
}

export default Toolbar;
