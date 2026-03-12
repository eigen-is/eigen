import React, { useCallback, useContext, useRef, useState } from "react";
import {
  Context,
  MAX_ZOOM_RATIO,
  MIN_ZOOM_RATIO,
  getSheetIndex,
  locale,
} from "../../core";
import WorkbookContext from "../../context";
import {SVGIcon} from "../icon-map";
import { useOutsideClick } from "../../hooks/useOutsideClick";

const presets = [
  {
    text: "10%",
    value: 0.1,
  },
  {
    text: "30%",
    value: 0.3,
  },
  {
    text: "50%",
    value: 0.5,
  },
  {
    text: "70%",
    value: 0.7,
  },
  {
    text: "100%",
    value: 1,
  },
  {
    text: "150%",
    value: 1.5,
  },
  {
    text: "200%",
    value: 2,
  },
  {
    text: "300%",
    value: 3,
  },
  {
    text: "400%",
    value: 4,
  },
];

const ZoomControl: React.FC = () => {
  const { context, setContext } = useContext(WorkbookContext);
  const menuRef = useRef<HTMLDivElement>(null);
  const [radioMenuOpen, setRadioMenuOpen] = useState(false);
  const { info } = locale(context);

  useOutsideClick(
    menuRef,
    () => {
      setRadioMenuOpen(false);
    },
    []
  );

  const zoomTo = useCallback(
    (val: number) => {
      val = parseFloat(val.toFixed(1));
      if (val > MAX_ZOOM_RATIO || val < MIN_ZOOM_RATIO) {
        return;
      }
      setContext(
        (ctx: Context) => {
          const index = getSheetIndex(ctx, ctx.currentSheetId);
          if (index == null) {
            return;
          }
          ctx.luckysheetfile[index].zoomRatio = val;
          ctx.zoomRatio = val;
        },
        { noHistory: true }
      );
    },
    [setContext]
  );

  return (
    <aside title="Zoom settings" className="whitespace-nowrap overflow-visible flex items-center select-none">
      <div
        className="flex cursor-pointer items-center justify-center w-6 h-6 hover:bg-muted rounded"
        aria-label={info.zoomOut}
        onClick={(e) => {
          zoomTo(context.zoomRatio - 0.1);
          e.stopPropagation();
        }}
        tabIndex={0}
        role="button"
      >
        <SVGIcon name="minus" width={16} height={16} />
      </div>
      <div className="relative flex justify-center w-12 text-xs cursor-pointer">
        <div
          className="w-full flex cursor-pointer items-center justify-center w-6 h-6 hover:bg-muted rounded"
          onClick={() => setRadioMenuOpen(true)}
          tabIndex={0}
        >
          {(context.zoomRatio * 100).toFixed(0)}%
        </div>
        {radioMenuOpen && (
          <div className="absolute bottom-[30px] left-0 leading-6 shadow-md py-2.5 rounded-md bg-popover z-[1004]" ref={menuRef}>
            {presets.map((v) => (
              <div
                className="hover:bg-muted"
                key={v.text}
                onClick={(e) => {
                  zoomTo(v.value);
                  e.preventDefault();
                }}
                tabIndex={0}
              >
                <div className="px-2.5">{v.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div
        className="flex cursor-pointer items-center justify-center w-6 h-6 hover:bg-muted rounded"
        aria-label={info.zoomIn}
        onClick={(e) => {
          zoomTo(context.zoomRatio + 0.1);
          e.stopPropagation();
        }}
        tabIndex={0}
        role="button"
      >
        <SVGIcon name="plus" width={16} height={16} />
      </div>
    </aside>
  );
};

export default ZoomControl;
