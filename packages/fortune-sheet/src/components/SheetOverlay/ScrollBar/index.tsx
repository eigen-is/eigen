import React, {useCallback, useContext, useEffect} from "react";
import WorkbookContext from "../../../context";
import "./index.css";

type Props = {
  axis: "x" | "y";
};

const ScrollBar: React.FC<Props> = ({ axis }) => {
  const {context, refs} = useContext(WorkbookContext);
  const {globalCache} = refs;

  // When something other than scroll (e.g. programmatic scroll, "back to top"
  // button) sets context.scrollLeft/scrollTop, sync the DOM scrollbar and
  // globalCache. This effect only runs on actual context changes (rare during
  // user scrolling since we no longer write scroll to context on every tick).
  useEffect(() => {
    if (axis === "x") {
      globalCache.scrollLeft = context.scrollLeft;
      refs.scrollbarX.current!.scrollLeft = context.scrollLeft;
    } else {
      globalCache.scrollTop = context.scrollTop;
      refs.scrollbarY.current!.scrollTop = context.scrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis === "x" ? context.scrollLeft : context.scrollTop]);

  const onScroll = useCallback(() => {
    if (axis === "x") {
      globalCache.scrollLeft = refs.scrollbarX.current!.scrollLeft;
    } else {
      globalCache.scrollTop = refs.scrollbarY.current!.scrollTop;
    }
    globalCache.notifyScrollListeners();
  }, [axis, globalCache, refs.scrollbarX, refs.scrollbarY]);

  return (
    <div
      ref={axis === "x" ? refs.scrollbarX : refs.scrollbarY}
      style={
        axis === "x"
          ? {
              left: context.rowHeaderWidth,
              width: `calc(100% - ${context.rowHeaderWidth}px)`,
            }
          : { height: "100%" }
      }
      className={`luckysheet-scrollbars luckysheet-scrollbar-ltr luckysheet-scrollbar-${axis}`}
      onScroll={onScroll}
    >
      <div
        style={
          axis === "x"
            ? { width: context.ch_width, height: 10 }
            : { width: 10, height: context.rh_height }
        }
      />
    </div>
  );
};

export default ScrollBar;
