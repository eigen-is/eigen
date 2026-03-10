import React, { useContext, useCallback, useRef, useState } from "react";
import {
  toolbarItemClickHandler,
  handleTextBackground,
  handleTextColor,
  handleTextSize,
  normalizedCellAttr,
  getFlowdata,
  newComment,
  editComment,
  deleteComment,
  showHideComment,
  showHideAllComments,
  autoSelectionFormula,
  handleSum,
  locale,
  handleMerge,
  handleBorder,
  toolbarItemSelectedFunc,
  handleFreeze,
  insertImage,
  showImgChooser,
  updateFormat,
  handleSort,
  handleHorizontalAlign,
  handleVerticalAlign,
  handleScreenShot,
  createFilter,
  clearFilter,
  applyLocation,
} from "@fortune-sheet/core";
import _ from "lodash";
import WorkbookContext from "../../context";
import SVGIcon from "../SVGIcon";
import { useDialog } from "../../hooks/useDialog";
import { FormulaSearch } from "../FormulaSearch";
import { SplitColumn } from "../SplitColumn";
import { LocationCondition } from "../LocationCondition";
import DataVerification from "../DataVerification";
import ConditionalFormat from "../ConditionFormat";
import { CustomColor } from "./CustomColor";
import CustomBorder from "./CustomBorder";
import { FormatSearch } from "../FormatSearch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import {
  Undo2,
  Redo2,
  Paintbrush,
  RemoveFormatting,
  Bold,
  Italic,
  Strikethrough,
  Underline,
  Search,
  Camera,
  Columns3,
  ShieldCheck,
  ImagePlus,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  undo: Undo2,
  redo: Redo2,
  "format-painter": Paintbrush,
  "clear-format": RemoveFormatting,
  bold: Bold,
  italic: Italic,
  "strike-through": Strikethrough,
  underline: Underline,
  search: Search,
  screenshot: Camera,
  splitColumn: Columns3,
  dataVerification: ShieldCheck,
  image: ImagePlus,
};

const TB = "flex items-center rounded p-0.5 mx-0.5 select-none cursor-pointer hover:bg-accent active:bg-accent/80";

const Separator: React.FC = () => (
  <div className="w-px h-5 bg-border mx-1 shrink-0" />
);

const ColorCombo: React.FC<{
  name: string;
  tooltip: string;
  recentColor: string | undefined;
  onPick: (color: string | undefined) => void;
}> = ({ name, tooltip, recentColor, onPick }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex items-center" key={name}>
      <div
        className="absolute bottom-1.5 left-2 w-[17px] h-0.5 z-10 pointer-events-none"
        style={{ backgroundColor: recentColor }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={TB}
            onClick={() => { if (recentColor) onPick(recentColor); }}
            tabIndex={0}
            role="button"
            aria-label={tooltip}
          >
            <SVGIcon name={name} />
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
      </Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <div className="cursor-pointer px-0.5 hover:bg-accent rounded">
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <CustomColor
            onCustomPick={(color) => { onPick(color); setOpen(false); }}
            onColorPick={(color) => { onPick(color); setOpen(false); }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
};

const ToolbarDropdown: React.FC<{
  iconId?: string;
  text?: string;
  tooltip: string;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ iconId, text, tooltip, onClick, children }) => (
  <div className="flex items-center rounded p-0.5 mx-0.5 hover:bg-accent">
    {onClick ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center text-xs cursor-pointer" onClick={onClick} tabIndex={0} role="button">
            {iconId ? <SVGIcon name={iconId} /> : <span className="mx-1 whitespace-nowrap">{text ?? ""}</span>}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    ) : null}
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <div className={`flex items-center cursor-pointer text-xs ${onClick ? "px-0.5" : ""}`} tabIndex={0} role="button">
              {!onClick && (iconId ? <SVGIcon name={iconId} /> : <span className="mx-1 whitespace-nowrap">{text ?? ""}</span>)}
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </div>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {!onClick && <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>}
      </Tooltip>
      <DropdownMenuContent align="start" className="max-h-[75vh] overflow-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);

const Toolbar: React.FC<{
  leftItems?: React.ReactNode;
  rightItems?: React.ReactNode;
}> = ({ leftItems, rightItems }) => {
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

  const [customColor, setcustomColor] = useState("#000000");
  const [customStyle, setcustomStyle] = useState("1");

  const getToolbarItem = useCallback(
    (name: string, i: number) => {
      // @ts-ignore
      const tooltip = toolbar[name];

      if (name === "|") {
        return <Separator key={i} />;
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
            currentFmt = format != null ? format.text : defaultFormat[defaultFormat.length - 1].text;
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
                          showDialog(<FormatSearch onCancel={hideDialog} type="currency" />);
                        }}
                      >
                        {toolbarFormat.moreCurrency}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          showDialog(<FormatSearch onCancel={hideDialog} type="number" />);
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
          { title: "align-left", text: align.left, value: 1 },
          { title: "align-center", text: align.center, value: 0 },
          { title: "align-right", text: align.right, value: 2 },
        ];
        return (
          <ToolbarDropdown
            iconId={_.find(items, (item) => `${item.value}` === `${cell?.ht}`)?.title || "align-left"}
            key={name}
            tooltip={toolbar.horizontalAlign}
          >
            {items.map(({ text, title }) => (
              <DropdownMenuItem
                key={title}
                onClick={() => {
                  setContext((ctx) => {
                    handleHorizontalAlign(ctx, refs.cellInput.current!, title.replace("align-", ""));
                  });
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <SVGIcon name={title} />
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "vertical-align") {
        const items = [
          { title: "align-top", text: align.top, value: 1 },
          { title: "align-middle", text: align.middle, value: 0 },
          { title: "align-bottom", text: align.bottom, value: 2 },
        ];
        return (
          <ToolbarDropdown
            iconId={_.find(items, (item) => `${item.value}` === `${cell?.vt}`)?.title || "align-top"}
            key={name}
            tooltip={toolbar.verticalAlign}
          >
            {items.map(({ text, title }) => (
              <DropdownMenuItem
                key={title}
                onClick={() => {
                  setContext((ctx) => {
                    handleVerticalAlign(ctx, refs.cellInput.current!, title.replace("align-", ""));
                  });
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <SVGIcon name={title} />
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "undo") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={refs.globalCache.undoList.length === 0 ? `${TB} opacity-30 pointer-events-none` : TB}
                onClick={() => handleUndo()}
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                <Icon className="h-5 w-5 p-0.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        );
      }

      if (name === "redo") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={refs.globalCache.redoList.length === 0 ? `${TB} opacity-30 pointer-events-none` : TB}
                onClick={() => handleRedo()}
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                <Icon className="h-5 w-5 p-0.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        );
      }

      if (name === "screenshot") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={TB}
                onClick={() => {
                  const imgsrc = handleScreenShot(contextRef.current);
                  if (imgsrc) {
                    showDialog(
                      <div>
                        <div>{screenshot.screenshotTipSuccess}</div>
                        <img src={imgsrc} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} />
                      </div>
                    );
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                <Icon className="h-5 w-5 p-0.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        );
      }

      if (name === "splitColumn") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={TB}
                onClick={() => {
                  if (context.allowEdit === false) return;
                  if (_.isUndefined(context.luckysheet_select_save)) {
                    showDialog(splitText.tipNoSelect, "ok");
                  } else {
                    const currentColumn =
                      context.luckysheet_select_save[context.luckysheet_select_save.length - 1].column;
                    if (context.luckysheet_select_save.length > 1) {
                      showDialog(splitText.tipNoMulti, "ok");
                    } else if (currentColumn[0] !== currentColumn[1]) {
                      showDialog(splitText.tipNoMultiColumn, "ok");
                    } else {
                      showDialog(<SplitColumn />);
                    }
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                <Icon className="h-5 w-5 p-0.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        );
      }

      if (name === "dataVerification") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={TB}
                onClick={() => {
                  if (context.allowEdit === false) return;
                  showDialog(<DataVerification />);
                }}
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                <Icon className="h-5 w-5 p-0.5" />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
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
          <ToolbarDropdown iconId="locationCondition" key={name} tooltip={findAndReplace.location}>
            {items.map(({ text, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  if (context.luckysheet_select_save == null) {
                    showDialog(freezen.noSeletionError, "ok");
                    return;
                  }
                  const last = context.luckysheet_select_save[0];
                  let range: { row: any[]; column: any[] }[];
                  let rangeArr: any[] = [];
                  if (
                    context.luckysheet_select_save?.length === 0 ||
                    (context.luckysheet_select_save?.length === 1 &&
                      last.row[0] === last.row[1] &&
                      last.column[0] === last.column[1])
                  ) {
                    range = [{ row: [0, flowdata!.length - 1], column: [0, flowdata![0].length - 1] }];
                  } else {
                    range = _.assignIn([], context.luckysheet_select_save);
                  }
                  if (value === "location") {
                    showDialog(<LocationCondition />);
                  } else if (value === "locationFormula") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationFormula", "all", ctx); });
                  } else if (value === "locationDate") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationConstant", "d", ctx); });
                  } else if (value === "locationDigital") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationConstant", "n", ctx); });
                  } else if (value === "locationString") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationConstant", "s,g", ctx); });
                  } else if (value === "locationError") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationConstant", "e", ctx); });
                  } else if (value === "locationCondition") {
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationCF", undefined, ctx); });
                  } else if (value === "locationRowSpan") {
                    if (
                      context.luckysheet_select_save?.length === 0 ||
                      (context.luckysheet_select_save?.length === 1 &&
                        context.luckysheet_select_save[0].row[0] === context.luckysheet_select_save[0].row[1])
                    ) {
                      showDialog(findAndReplace.locationTiplessTwoRow, "ok");
                      return;
                    }
                    range = _.assignIn([], context.luckysheet_select_save);
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationRowSpan", undefined, ctx); });
                  } else if (value === "locationColumnSpan") {
                    if (
                      context.luckysheet_select_save?.length === 0 ||
                      (context.luckysheet_select_save?.length === 1 &&
                        context.luckysheet_select_save[0].column[0] === context.luckysheet_select_save[0].column[1])
                    ) {
                      showDialog(findAndReplace.locationTiplessTwoColumn, "ok");
                      return;
                    }
                    range = _.assignIn([], context.luckysheet_select_save);
                    setContext((ctx) => { rangeArr = applyLocation(range, "locationColumnSpan", undefined, ctx); });
                  }
                  if (rangeArr.length === 0 && value !== "location")
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
                }}
              >
                {text}
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
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
          <DropdownMenu key={name}>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <div className={TB}>
                    <SVGIcon name="conditionFormat" />
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  </div>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{toolbar.conditionalFormat}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              <ConditionalFormat items={items} />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      }

      if (name === "image") {
        const Icon = ICON_MAP[name]!;
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={TB}
                onClick={() => {
                  if (context.allowEdit === false) return;
                  showImgChooser();
                }}
                tabIndex={0}
                role="button"
                aria-label={toolbar.insertImage}
              >
                <Icon className="h-5 w-5 p-0.5" />
                <input
                  id="fortune-img-upload"
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;
                    const render = new FileReader();
                    render.readAsDataURL(file);
                    render.onload = (event) => {
                      if (event.target == null) return;
                      const src = event.target?.result;
                      const image = new Image();
                      image.onload = () => {
                        setContext((draftCtx) => { insertImage(draftCtx, image); });
                      };
                      image.src = src as string;
                    };
                    e.currentTarget.value = "";
                  }}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{toolbar.insertImage}</TooltipContent>
          </Tooltip>
        );
      }

      if (name === "comment") {
        const last =
          context.luckysheet_select_save?.[context.luckysheet_select_save.length - 1];
        let row_index = last?.row_focus;
        let col_index = last?.column_focus;
        if (!last) {
          row_index = 0;
          col_index = 0;
        } else {
          if (row_index == null) [row_index] = last.row;
          if (col_index == null) [col_index] = last.column;
        }
        let itemData: { key: string; text: string; onClick: any }[];
        if (flowdata?.[row_index]?.[col_index]?.ps != null) {
          itemData = [
            { key: "edit", text: comment.edit, onClick: editComment },
            { key: "delete", text: comment.delete, onClick: deleteComment },
            { key: "showOrHide", text: comment.showOne, onClick: showHideComment },
            { key: "showOrHideAll", text: comment.showAll, onClick: showHideAllComments },
          ];
        } else {
          itemData = [
            { key: "new", text: comment.insert, onClick: newComment },
            { key: "showOrHideAll", text: comment.showAll, onClick: showHideAllComments },
          ];
        }
        return (
          <ToolbarDropdown iconId={name} key={name} tooltip={tooltip}>
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
          </ToolbarDropdown>
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
          <ToolbarDropdown
            iconId="formula-sum"
            key={name}
            tooltip={toolbar.autoSum}
            onClick={() =>
              setContext((ctx) => {
                handleSum(ctx, refs.cellInput.current!, refs.fxInput.current, refs.globalCache!);
              })
            }
          >
            {itemData.map(({ value, text }) => (
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
            <DropdownMenuItem onClick={() => showDialog(<FormulaSearch onCancel={hideDialog} />)}>
              {`${formula.find}...`}
            </DropdownMenuItem>
          </ToolbarDropdown>
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
          <ToolbarDropdown
            iconId="merge-all"
            key={name}
            tooltip={tooltip}
            onClick={() => setContext((ctx) => { handleMerge(ctx, "merge-all"); })}
          >
            {itemdata.map(({ text, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => { setContext((ctx) => { handleMerge(ctx, value); }); }}
              >
                <div className="flex items-center gap-2">
                  <SVGIcon name={value} />
                  <span>{text}</span>
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
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
          <ToolbarDropdown
            iconId="border-all"
            key={name}
            tooltip={tooltip}
            onClick={() => setContext((ctx) => { handleBorder(ctx, "border-all", customColor, customStyle); })}
          >
            {items.map(({ text, value }, ii) =>
              value !== "divider" ? (
                <DropdownMenuItem
                  key={value}
                  onClick={() => { setContext((ctx) => { handleBorder(ctx, value, customColor, customStyle); }); }}
                >
                  <div className="flex items-center justify-between w-full">
                    <span>{text}</span>
                    <SVGIcon name={value} />
                  </div>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSeparator key={`divider-${ii}`} />
              )
            )}
            <CustomBorder
              onPick={(color, style) => {
                setcustomColor(color as string);
                setcustomStyle(style as string);
              }}
            />
          </ToolbarDropdown>
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
          <ToolbarDropdown
            iconId="freeze-row-col"
            key={name}
            tooltip={tooltip}
            onClick={() => setContext((ctx) => { handleFreeze(ctx, "freeze-row-col"); })}
          >
            {items.map(({ text, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => { setContext((ctx) => { handleFreeze(ctx, value); }); }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <SVGIcon name={value} />
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "text-wrap") {
        const items = [
          { text: textWrap.clip, iconId: "text-clip", value: "clip" },
          { text: textWrap.overflow, iconId: "text-overflow", value: "overflow" },
          { text: textWrap.wrap, iconId: "text-wrap", value: "wrap" },
        ];
        let curr = items[0];
        if (cell?.tb != null) curr = _.get(items, cell.tb);
        return (
          <ToolbarDropdown iconId={curr.iconId} key={name} tooltip={toolbar.textWrap}>
            {items.map(({ text, iconId, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  setContext((ctx) => {
                    const d = getFlowdata(ctx);
                    if (d == null) return;
                    updateFormat(ctx, refs.cellInput.current!, d, "tb", value);
                  });
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <SVGIcon name={iconId} />
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "text-rotation") {
        const items = [
          { text: rotation.none, iconId: "text-rotation-none", value: "none" },
          { text: rotation.angleup, iconId: "text-rotation-angleup", value: "angleup" },
          { text: rotation.angledown, iconId: "text-rotation-angledown", value: "angledown" },
          { text: rotation.vertical, iconId: "text-rotation-vertical", value: "vertical" },
          { text: rotation.rotationUp, iconId: "text-rotation-up", value: "rotation-up" },
          { text: rotation.rotationDown, iconId: "text-rotation-down", value: "rotation-down" },
        ];
        let curr = items[0];
        if (cell?.tr != null) curr = _.get(items, cell.tr);
        return (
          <ToolbarDropdown iconId={curr.iconId} key={name} tooltip={toolbar.textRotate}>
            {items.map(({ text, iconId, value }) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  setContext((ctx) => {
                    const d = getFlowdata(ctx);
                    if (d == null) return;
                    updateFormat(ctx, refs.cellInput.current!, d, "tr", value);
                  });
                }}
              >
                <div className="flex items-center justify-between w-full">
                  <span>{text}</span>
                  <SVGIcon name={iconId} />
                </div>
              </DropdownMenuItem>
            ))}
          </ToolbarDropdown>
        );
      }

      if (name === "filter") {
        const items = [
          { iconId: "sort-asc", value: "sort-asc", text: sort.asc, onClick: () => setContext((ctx) => { handleSort(ctx, true); }) },
          { iconId: "sort-desc", value: "sort-desc", text: sort.desc, onClick: () => setContext((ctx) => { handleSort(ctx, false); }) },
          { iconId: "", value: "divider" },
          { iconId: "filter1", value: "filter", text: filter.filter, onClick: () => setContext((draftCtx) => { createFilter(draftCtx); }) },
          { iconId: "eraser", value: "eraser", text: filter.clearFilter, onClick: () => setContext((draftCtx) => { clearFilter(draftCtx); }) },
        ];
        return (
          <ToolbarDropdown iconId="filter" key={name} tooltip={toolbar.sortAndFilter}>
            {items.map(({ text, iconId, value, onClick }, index) =>
              value !== "divider" ? (
                <DropdownMenuItem key={value} onClick={() => onClick?.()}>
                  <div className="flex items-center justify-between w-full">
                    <span>{text}</span>
                    <SVGIcon name={iconId} />
                  </div>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSeparator key={`divider-${index}`} />
              )
            )}
          </ToolbarDropdown>
        );
      }

      {
        const Icon = ICON_MAP[name];
        const selected = toolbarItemSelectedFunc(name)?.(cell);
        return (
          <Tooltip key={name}>
            <TooltipTrigger asChild>
              <div
                className={selected ? `${TB} bg-accent` : TB}
                onClick={() =>
                  setContext((draftCtx) => {
                    toolbarItemClickHandler(name)?.(
                      draftCtx,
                      refs.cellInput.current!,
                      refs.globalCache
                    );
                  })
                }
                tabIndex={0}
                role="button"
                aria-label={tooltip}
              >
                {Icon ? <Icon className="h-5 w-5 p-0.5" /> : <SVGIcon name={name} />}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{tooltip}</TooltipContent>
          </Tooltip>
        );
      }
    },
    [
      toolbar,
      cell,
      setContext,
      refs.cellInput,
      refs.fxInput,
      refs.globalCache,
      defaultFormat,
      align,
      handleUndo,
      handleRedo,
      flowdata,
      formula,
      showDialog,
      hideDialog,
      merge,
      border,
      freezen,
      screenshot,
      sort,
      textWrap,
      rotation,
      filter,
      splitText,
      findAndReplace,
      context.luckysheet_select_save,
      context.defaultFontSize,
      context.allowEdit,
      comment,
      fontarray,
      refs.canvas,
      customColor,
      customStyle,
      toolbarFormat.moreCurrency,
      toolbarFormat.moreNumber,
    ]
  );

  return (
    <header>
      <div
        className="flex flex-row bg-background relative py-1 pl-4 border-b border-border whitespace-nowrap items-center flex-wrap"
        role="toolbar"
        aria-label={toolbar.toolbar}
      >
        {leftItems}
        {leftItems ? <Separator key="leftDivider" /> : null}
        {settings.customToolbarItems.map((n) => {
          const content = (
            <div
              className={TB}
              onClick={n.onClick}
              key={n.key}
              tabIndex={0}
              role="button"
            >
              {n.icon ?? (n.iconName ? <SVGIcon name={n.iconName} /> : null)}
              {n.children}
            </div>
          );
          if (!n.tooltip) return content;
          return (
            <Tooltip key={n.key}>
              <TooltipTrigger asChild>{content}</TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{n.tooltip}</TooltipContent>
            </Tooltip>
          );
        })}
        {settings.customToolbarItems?.length > 0 ? <Separator key="customDivider" /> : null}
        {settings.toolbarItems.map((name, i) => getToolbarItem(name, i))}
        {rightItems ? <div className="ml-auto flex items-center gap-1">{rightItems}</div> : null}
      </div>
    </header>
  );
};

export default Toolbar;
