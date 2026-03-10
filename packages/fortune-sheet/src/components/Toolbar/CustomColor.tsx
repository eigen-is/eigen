import { locale } from "@fortune-sheet/core";
import React, { useContext, useState } from "react";
import WorkbookContext from "../../context";
import { ColorPicker as SharedColorPicker } from "@workspace/ui/components/layout/media/color-picker";

type Props = {
  onCustomPick: (color: string | undefined) => void;
  onColorPick: (color: string) => void;
};

export const CustomColor: React.FC<Props> = ({ onCustomPick, onColorPick }) => {
  const { context } = useContext(WorkbookContext);
  const { toolbar, sheetconfig, button } = locale(context);
  const [inputColor, setInputColor] = useState("#000000");

  return (
    <div className="min-w-[164px] rounded-md border bg-popover p-2 shadow-md text-xs">
      <button
        className="w-full text-left px-2 py-1.5 rounded hover:bg-accent cursor-pointer"
        onClick={() => onCustomPick(undefined)}
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
          className="w-6 h-6 border-none cursor-pointer"
        />
        <button
          className="px-2 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90"
          onClick={() => onCustomPick(inputColor)}
          type="button"
        >
          {button.confirm}
        </button>
      </div>
      <SharedColorPicker
        value=""
        onChange={onColorPick}
        showReset={false}
      />
    </div>
  );
};
