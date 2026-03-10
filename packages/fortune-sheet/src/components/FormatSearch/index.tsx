import { useContext, useState, useCallback, useMemo } from "react";
import {
  cancelNormalSelected,
  getSheetIndex,
  locale,
  update,
} from "@fortune-sheet/core";
import _ from "lodash";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { cn } from "@workspace/ui/lib/utils";
import WorkbookContext from "../../context";
import { useDialog } from "../../hooks/useDialog";

export function FormatSearch({
  type,
  onCancel: _onCancel,
}: {
  type: "currency" | "date" | "number";
  onCancel: () => void;
}) {
  const {
    context,
    setContext,
    refs: { cellInput },
  } = useContext(WorkbookContext);
  const [decimalPlace, setDecimalPlace] = useState(2);
  const [selectedFormatIndex, setSelectedFormatIndex] = useState(0);
  const { button, format, currencyDetail, dateFmtList, numberFmtList } =
    locale(context);
  const { showDialog } = useDialog();
  const toolbarFormatAll = useMemo(
    () => ({
      currency: currencyDetail,
      date: dateFmtList,
      number: numberFmtList,
    }),
    [currencyDetail, dateFmtList, numberFmtList]
  );

  type ToolbarFormatType = { name: string; pos?: string; value: string };

  const toolbarFormat: ToolbarFormatType[] = useMemo(
    () => toolbarFormatAll[type],
    [toolbarFormatAll, type]
  );
  const tips = _.get(format, type);

  const onConfirm = useCallback(() => {
    if (decimalPlace < 0 || decimalPlace > 9) {
      _onCancel();
      showDialog(format.tipDecimalPlaces, "ok");
      return;
    }
    setContext((ctx) => {
      const index = getSheetIndex(ctx, ctx.currentSheetId);
      if (_.isNil(index)) return;
      const selectedFormatVal = toolbarFormat[selectedFormatIndex].value;

      let selectedFormatPos: string;
      if ("pos" in toolbarFormat[selectedFormatIndex])
        selectedFormatPos = toolbarFormat[selectedFormatIndex].pos || "before";

      _.forEach(ctx.luckysheet_select_save, (selection) => {
        for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
          for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
            if (
              ctx.luckysheetfile[index].data?.[r][c] &&
              ctx.luckysheetfile[index].data?.[r][c]?.ct?.t === "n"
            ) {
              const zero = 0;
              if (selectedFormatPos! === "after") {
                ctx.luckysheetfile[index].data![r][c]!.ct!.fa = zero
                  .toFixed(decimalPlace)
                  .concat(`${selectedFormatVal}`);
                ctx.luckysheetfile[index].data![r][c]!.m = update(
                  zero.toFixed(decimalPlace).concat(`${selectedFormatVal}`),
                  ctx.luckysheetfile[index].data![r][c]!.v
                );
              } else {
                ctx.luckysheetfile[index].data![r][c]!.ct!.fa =
                  `${selectedFormatVal}`.concat(zero.toFixed(decimalPlace));
                ctx.luckysheetfile[index].data![r][c]!.m = update(
                  `${selectedFormatVal}`.concat(zero.toFixed(decimalPlace)),
                  ctx.luckysheetfile[index].data![r][c]!.v
                );
              }
            }
          }
        }
      });
      _onCancel();
    });
  }, [
    _onCancel,
    decimalPlace,
    format.tipDecimalPlaces,
    selectedFormatIndex,
    setContext,
    showDialog,
    toolbarFormat,
  ]);

  const onCancel = useCallback(() => {
    setContext((ctx) => {
      cancelNormalSelected(ctx);
      if (cellInput.current) {
        cellInput.current.innerHTML = "";
      }
    });
    _onCancel();
  }, [_onCancel, cellInput, setContext]);

  return (
    <div className="w-[340px]">
      <div className="mb-3">
        <p className="text-sm font-medium mb-2">{tips}{format.format}:</p>
        <div className="flex items-center gap-2 mb-3">
          <Label className="text-sm whitespace-nowrap">{format.decimalPlaces}:</Label>
          <Input
            type="number"
            min={0}
            max={9}
            defaultValue={2}
            className="w-20 h-8"
            onChange={(e) => setDecimalPlace(parseInt(e.target.value, 10))}
          />
        </div>
        <div className="border rounded-md max-h-[200px] overflow-auto">
          {toolbarFormat.map((v: ToolbarFormatType, index: number) => (
            <div
              className={cn(
                "flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer hover:bg-accent",
                index === selectedFormatIndex && "bg-accent font-medium"
              )}
              key={v.name}
              onClick={() => setSelectedFormatIndex(index)}
              tabIndex={0}
            >
              <span>{v.name}</span>
              <span className="text-muted-foreground">{v.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {button.cancel}
        </Button>
        <Button size="sm" onClick={onConfirm}>
          {button.confirm}
        </Button>
      </div>
    </div>
  );
}
