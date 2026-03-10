import { Context, getSheetIndex, locale } from "@fortune-sheet/core";
import React, { useCallback, useContext, useEffect, useState } from "react";
import WorkbookContext from "../../context";
import { ColorPicker } from "@workspace/ui/components/layout/media/color-picker";

type Props = {
  triggerParentUpdate: (state: boolean) => void;
};

export const ChangeColor: React.FC<Props> = ({ triggerParentUpdate }) => {
  const { context, setContext } = useContext(WorkbookContext);
  const { toolbar, sheetconfig, button } = locale(context);
  const [inputColor, setInputColor] = useState("#000000");
  const [selectColor, setSelectColor] = useState<undefined | string>(
    context.luckysheetfile[
      getSheetIndex(context, context.currentSheetId) as number
    ].color
  );

  const certainBtn = useCallback(() => {
    setSelectColor(inputColor);
  }, [inputColor]);

  useEffect(() => {
    setContext((ctx: Context) => {
      if (ctx.allowEdit === false) return;
      const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
      ctx.luckysheetfile[index].color = selectColor;
    });
  }, [selectColor, setContext]);

  return (
    <div className="min-w-[164px] rounded-md border bg-popover p-2 shadow-md text-xs">
      <button
        className="w-full text-left px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
        onClick={() => setSelectColor(undefined)}
        type="button"
      >
        {sheetconfig.resetColor}
      </button>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span>{toolbar.customColor}:</span>
        <input
          type="color"
          value={inputColor}
          onChange={(e) => setInputColor(e.target.value)}
          onFocus={() => triggerParentUpdate(true)}
          onBlur={() => triggerParentUpdate(false)}
          className="w-6 h-6 border-none cursor-pointer"
        />
        <button
          className="px-2 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90"
          onClick={() => certainBtn()}
          type="button"
        >
          {button.confirm}
        </button>
      </div>
      <ColorPicker
        value={selectColor ?? ""}
        onChange={(color) => {
          setInputColor(color);
          setSelectColor(color);
        }}
        showReset={false}
      />
    </div>
  );
};
