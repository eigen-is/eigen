import _ from "lodash";
import {
    clearFilter,
    Context,
    FilterColor,
    FilterDate,
    FilterValue,
    getFilterColumnColors,
    getFilterColumnValues,
    locale,
    orderbydatafiler,
    saveFilter,
} from "../../core";
import React, {useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,} from "react";
import produce from "immer";
import {WorkbookContext} from "../../context";
import {SVGIcon} from "../icon-map";
import {useAlert} from "../../hooks/useAlert";
import {Button} from "@workspace/ui/components/button";
import {ArrowUpDown} from "lucide-react";
import {useOutsideClick} from "../../hooks/useOutsideClick";

const SelectItem: React.FC<{
    item: FilterValue;
    isChecked: (key: string) => boolean;
    onChange: (item: FilterValue, checked: boolean) => void;
    isItemVisible: (item: FilterValue) => boolean;
}> = ({item, isChecked, onChange, isItemVisible}) => {
    const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);
    return isItemVisible(item) ? (
        <div className="select-item">
            <input
                className="filter-checkbox"
                type="checkbox"
                checked={checked}
                onChange={() => {
                    onChange(item, !checked);
                }}
            />
            <div>{item.text}</div>
            <span className="count">{`( ${item.rows.length} )`}</span>
        </div>
    ) : null;
};

const DateSelectTreeItem: React.FC<{
    item: FilterDate;
    depth?: number;
    initialExpand: (key: string) => boolean;
    onExpand?: (key: string, expand: boolean) => void;
    isChecked: (key: string) => boolean;
    onChange: (data: FilterDate, checked: boolean) => void;
    isItemVisible: (item: FilterDate) => boolean;
}> = ({
          item,
          depth = 0,
          initialExpand,
          onExpand,
          isChecked,
          onChange,
          isItemVisible,
      }) => {
    const [expand, setExpand] = useState(initialExpand(item.key));
    const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);

    return isItemVisible(item) ? (
        <div>
            <div
                className="select-item"
                style={{marginLeft: -2 + depth * 20}}
                onClick={() => {
                    onExpand?.(item.key, !expand);
                    setExpand(!expand);
                }}
                tabIndex={0}
            >
                {!item.children || item.children.length === 0 ? (
                    <div style={{width: 10}}/>
                ) : (
                    <div
                        className={`filter-caret ${expand ? "down" : "right"}`}
                        style={{cursor: "pointer"}}
                    />
                )}
                <input
                    className="filter-checkbox"
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                        onChange(item, !checked);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    tabIndex={0}
                />
                <div>{item.text}</div>
                <span className="count">{`( ${item.rows.length} )`}</span>
            </div>
            {expand &&
                item.children.map((v) => (
                    <DateSelectTreeItem
                        key={v.key}
                        item={v}
                        depth={depth + 1}
                        {...{initialExpand, onExpand, isChecked, onChange, isItemVisible}}
                    />
                ))}
        </div>
    ) : null;
};

const DateSelectTree: React.FC<{
    dates: FilterDate[];
    initialExpand: (key: string) => boolean;
    onExpand?: (key: string, expand: boolean) => void;
    isChecked: (key: string) => boolean;
    onChange: (item: FilterDate, checked: boolean) => void;
    isItemVisible: (item: FilterDate) => boolean;
}> = ({
          dates,
          initialExpand,
          onExpand,
          isChecked,
          onChange,
          isItemVisible,
      }) => {
    return (
        <>
            {dates.map((v) => (
                <DateSelectTreeItem
                    key={v.key}
                    item={v}
                    {...{initialExpand, onExpand, isChecked, onChange, isItemVisible}}
                />
            ))}
        </>
    );
};

export const FilterMenu: React.FC = () => {
    const {context, setContext, settings} = useContext(WorkbookContext);
    const contextRef = useRef<Context>(context);
    const containerRef = useRef<HTMLDivElement>(null);
    const byColorMenuRef = useRef<HTMLDivElement>(null);
    const subMenuRef = useRef<HTMLDivElement>(null);
    const {filterContextMenu} = context;
    const {startRow, startCol, endRow, endCol, col, listBoxMaxHeight} =
    filterContextMenu || {
        startRow: null,
        startCol: null,
        endRow: null,
        endCol: null,
        col: null,
        listBoxMaxHeight: 400,
    };
    const {filter} = locale(context);
    const [data, setData] = useState<{
        dates: FilterDate[];
        dateRowMap: Record<string, number[]>;
        values: FilterValue[];
        valueRowMap: Record<string, number[]>;
        visibleRows: number[];
        flattenValues: string[];
    }>({
        dates: [],
        dateRowMap: {},
        values: [],
        valueRowMap: {},
        visibleRows: [],
        flattenValues: [],
    });
    const [datesUncheck, setDatesUncheck] = useState<string[]>([]);
    const [valuesUncheck, setValuesUncheck] = useState<string[]>([]);
    const dateTreeExpandState = useRef<Record<string, boolean>>({});
    const hiddenRows = useRef<number[]>([]);
    const [showValues, setShowValues] = useState<string[]>([]);
    const [searchText, setSearchText] = useState("");
    const [subMenuPos, setSubMenuPos] = useState<{
        left?: number;
        top: number;
        right?: number;
    }>();
    const [filterColors, setFilterColors] = useState<{
        bgColors: FilterColor[];
        fcColors: FilterColor[];
    }>({bgColors: [], fcColors: []});
    const [showSubMenu, setShowSubMenu] = useState(false);
    const {showAlert} = useAlert();
    const mouseHoverSubMenu = useRef<boolean>(false);
    contextRef.current = context;

    // Close FilterMenu
    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.filterContextMenu = undefined;
        });
    }, [setContext]);

    useOutsideClick(containerRef, close, [close]);

    const initialExpand = useCallback((key: string) => {
        const expand = dateTreeExpandState.current[key];
        if (expand == null) {
            dateTreeExpandState.current[key] = true;
            return true;
        }
        return expand;
    }, []);

    const onExpand = useCallback((key: string, expand: boolean) => {
        dateTreeExpandState.current[key] = expand;
    }, []);

    const searchValues = useMemo(
        () =>
            _.debounce((text: string) => {
                setShowValues(
                    data.flattenValues.filter(
                        (v) => v.toLowerCase().indexOf(text.toLowerCase()) > -1
                    )
                );
            }, 300),
        [data.flattenValues]
    );

    const selectAll = useCallback(() => {
        setDatesUncheck([]);
        setValuesUncheck([]);
        hiddenRows.current = [];
    }, []);

    const clearAll = useCallback(() => {
        setDatesUncheck(Object.keys(data.dateRowMap));
        setValuesUncheck(Object.keys(data.valueRowMap));
        hiddenRows.current = data.visibleRows;
    }, [data.dateRowMap, data.valueRowMap, data.visibleRows]);

    const inverseSelect = useCallback(() => {
        setDatesUncheck(produce((draft) => _.xor(draft, Object.keys(data.dateRowMap))));
        setValuesUncheck(
            produce((draft) => _.xor(draft, Object.keys(data.valueRowMap)))
        );
        hiddenRows.current = _.xor(hiddenRows.current, data.visibleRows);
    }, [data.dateRowMap, data.valueRowMap, data.visibleRows]);

    const onColorSelectChange = useCallback(
        (key: string, color: string, checked: boolean) => {
            setFilterColors(
                produce((draft) => {
                    const colorData = (draft as any)[key]?.find((v: FilterColor) => v.color === color);
                    if (colorData) colorData.checked = checked;
                })
            );
        },
        []
    );

    const delayHideSubMenu = useMemo(
        () =>
            _.debounce(() => {
                if (mouseHoverSubMenu.current) return;
                setShowSubMenu(false);
            }, 200),
        []
    );

    const sortData = useCallback(
        (asc: boolean) => {
            if (col == null) return;
            setContext((draftCtx) => {
                const errMsg = orderbydatafiler(
                    draftCtx,
                    startRow,
                    startCol,
                    endRow,
                    endCol,
                    col,
                    asc
                );
                if (errMsg != null) showAlert(errMsg);
            });
        },
        [col, setContext, startRow, startCol, endRow, endCol, showAlert]
    );

    const renderColorList = useCallback(
        (
            key: string,
            title: string,
            colors: FilterColor[],
            onSelectChange: (datakey: string, color: string, checked: boolean) => void
        ) =>
            colors.length > 1 ? (
                <div key={key}>
                    <div className="title">{title}</div>
                    <div className="color-list">
                        {colors.map((v) => (
                            <div
                                key={v.color}
                                className="item"
                                onClick={() => onSelectChange(key, v.color, !v.checked)}
                                tabIndex={0}
                            >
                                <div
                                    className="color-label"
                                    style={{backgroundColor: v.color}}
                                />
                                <input
                                    className="luckysheet-mousedown-cancel"
                                    type="checkbox"
                                    checked={v.checked}
                                    onChange={() => {
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            ) : null,
        []
    );

    // Reposition main container if it overflows the viewport
    useLayoutEffect(() => {
        if (!containerRef.current || !filterContextMenu) return;
        const rect = containerRef.current.getBoundingClientRect();
        const winH = window.innerHeight;
        const winW = window.innerWidth;
        let needsUpdate = false;
        let newX = filterContextMenu.x;
        let newY = filterContextMenu.y;
        if (newX + rect.width > winW) { newX = winW - rect.width - 8; needsUpdate = true; }
        if (newY + rect.height > winH) { newY = winH - rect.height - 8; needsUpdate = true; }
        if (newX < 0) { newX = 8; needsUpdate = true; }
        if (newY < 0) { newY = 8; needsUpdate = true; }
        if (needsUpdate && (newX !== filterContextMenu.x || newY !== filterContextMenu.y)) {
            setContext((draftCtx) => {
                if (draftCtx.filterContextMenu) {
                    draftCtx.filterContextMenu.x = newX;
                    draftCtx.filterContextMenu.y = newY;
                }
            });
        }
    }, [filterContextMenu?.x, filterContextMenu?.y, setContext]);

    useLayoutEffect(() => {
        if (!subMenuPos) return;
        // re-position the subMenu if it overflows the window
        const rect = byColorMenuRef.current?.getBoundingClientRect();
        const subMenuRect = subMenuRef.current?.getBoundingClientRect();
        if (rect == null || subMenuRect == null) return;

        const winW = window.innerWidth;
        const pos = _.cloneDeep(subMenuPos);
        if (subMenuRect.left + subMenuRect.width > winW) {
            pos.left! -= subMenuRect.width;
            setSubMenuPos(pos);
        }
    }, [subMenuPos]);

    useEffect(() => {
        if (col == null) return;
        setSearchText("");
        setShowSubMenu(false);
        dateTreeExpandState.current = {};
        hiddenRows.current = filterContextMenu?.hiddenRows || [];
        const res = getFilterColumnValues(
            contextRef.current,
            col,
            startRow,
            endRow,
            startCol
        );
        setData(_.omit(res, ["datesUncheck", "valuesUncheck"]));
        setDatesUncheck(res.datesUncheck);
        setValuesUncheck(res.valuesUncheck);
        setShowValues(res.flattenValues);
    }, [
        col,
        endRow,
        startRow,
        startCol,
        hiddenRows,
        filterContextMenu?.hiddenRows,
    ]);

    useEffect(() => {
        if (col == null) return;
        setFilterColors(
            getFilterColumnColors(contextRef.current, col, startRow, endRow)
        );
    }, [col, endRow, startRow]);

    if (!filterContextMenu) return null;

    return (
        <>
            <div
                ref={containerRef}
                className="fixed rounded-md border bg-popover p-1 shadow-lg text-sm fortune-filter-menu"
                style={{left: filterContextMenu.x, top: filterContextMenu.y, zIndex: 1010}}
                onContextMenu={(e) => e.stopPropagation()}
            >
                {settings.filterContextMenu?.map((name, i) => {
                    if (name === "|") {
                        return <div key={`divider-${i}`} className="h-px my-1 bg-border"/>;
                    }
                    if (name === "sort-by-asc") {
                        return (
                            <div
                                key={name}
                                className="relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                                onClick={() => sortData(true)}
                            >
                                {filter.sortByAsc}
                            </div>
                        );
                    }
                    if (name === "sort-by-desc") {
                        return (
                            <div
                                key={name}
                                className="relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
                                onClick={() => sortData(false)}
                            >
                                {filter.sortByDesc}
                            </div>
                        );
                    }
                    if (name === "filter-by-color") {
                        return (
                            <div
                                key={name}
                                ref={byColorMenuRef}
                                onMouseEnter={() => {
                                    if (!filterContextMenu) {
                                        return;
                                    }
                                    setShowSubMenu(true);
                                    const rect = byColorMenuRef.current?.getBoundingClientRect();
                                    if (rect == null) return;
                                    setSubMenuPos({top: rect.top - 5, left: rect.right});
                                }}
                                onMouseLeave={delayHideSubMenu}
                            >
                                <div className="relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground">
                                    <div className="filter-bycolor-container">
                                        {filter.filterByColor}
                                        <div className="filter-caret right"/>
                                    </div>
                                </div>
                            </div>
                        );
                    }
                    if (name === "filter-by-condition") {
                        return (
                            <div key={name}>
                                <div className="relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground">
                                    <div className="filter-caret right"/>
                                    {filter.filterByCondition}
                                </div>
                                <div
                                    className="luckysheet-${menuid}-bycondition"
                                    style={{display: "none"}}
                                >
                                    <div
                                        className="luckysheet-flat-menu-button luckysheet-mousedown-cancel"
                                        id="luckysheet-${menuid}-selected"
                                    >
                                        <span
                                            className="luckysheet-mousedown-cancel"
                                            data-value="null"
                                            data-type="0"
                                        >
                                            {filter.filiterInputNone}
                                        </span>
                                        <div className="luckysheet-mousedown-cancel">
                                            <ArrowUpDown size={14}/>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    }
                    if (name === "filter-by-value") {
                        return (
                            <div key={name}>
                                <div className="relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground">
                                    <div className="filter-caret right"/>
                                    {filter.filterByValues}
                                </div>
                                <div className="luckysheet-filter-byvalue">
                                    <div className="fortune-menuitem-row byvalue-btn-row">
                                        <div>
                                            <span
                                                className="fortune-byvalue-btn"
                                                onClick={selectAll}
                                                tabIndex={0}
                                            >
                                                {filter.filterValueByAllBtn}
                                            </span>
                                            {" - "}
                                            <span
                                                className="fortune-byvalue-btn"
                                                onClick={clearAll}
                                                tabIndex={0}
                                            >
                                                {filter.filterValueByClearBtn}
                                            </span>
                                            {" - "}
                                            <span
                                                className="fortune-byvalue-btn"
                                                onClick={inverseSelect}
                                                tabIndex={0}
                                            >
                                                {filter.filterValueByInverseBtn}
                                            </span>
                                        </div>
                                        <div className="byvalue-filter-icon">
                                            <SVGIcon
                                                name="filter-fill"
                                                style={{width: 20, height: 20}}
                                            />
                                        </div>
                                    </div>
                                    <div className="filtermenu-input-container">
                                        <input
                                            type="text"
                                            onKeyDown={(e) => e.stopPropagation()}
                                            placeholder={filter.filterValueByTip}
                                            className="luckysheet-mousedown-cancel"
                                            id="luckysheet-${menuid}-byvalue-input"
                                            value={searchText}
                                            onChange={(e) => {
                                                setSearchText(e.target.value);
                                                searchValues(e.target.value);
                                            }}
                                        />
                                    </div>
                                    <div
                                        id="luckysheet-filter-byvalue-select"
                                        style={{maxHeight: listBoxMaxHeight}}
                                    >
                                        <DateSelectTree
                                            dates={data.dates}
                                            onExpand={onExpand}
                                            initialExpand={initialExpand}
                                            isChecked={(key: string) =>
                                                datesUncheck.find(
                                                    (v: string) => v.match(key) != null
                                                ) == null
                                            }
                                            onChange={(item: FilterDate, checked: boolean) => {
                                                const rows = hiddenRows.current;
                                                hiddenRows.current = checked
                                                    ? _.without(rows, ...item.rows)
                                                    : _.union(rows, item.rows);
                                                setDatesUncheck(
                                                    produce((draft) => {
                                                        return checked
                                                            ? _.without(draft, ...item.dateValues)
                                                            : _.union(draft, item.dateValues);
                                                    })
                                                );
                                            }}
                                            isItemVisible={(item) => {
                                                return showValues.length === data.flattenValues.length
                                                    ? true
                                                    : showValues.findIndex(
                                                    (v) => v.match(item.key) != null
                                                ) > -1;
                                            }}
                                        />
                                        {data.values.map((v) => (
                                            <SelectItem
                                                key={v.key}
                                                item={v}
                                                isChecked={(key: string) =>
                                                    !valuesUncheck.includes(key)
                                                }
                                                onChange={(item: FilterValue, checked: boolean) => {
                                                    const rows = hiddenRows.current;
                                                    hiddenRows.current = checked
                                                        ? _.without(rows, ...item.rows)
                                                        : _.concat(rows, item.rows);
                                                    setValuesUncheck(
                                                        produce((draft) => {
                                                            if (checked) {
                                                                _.pull(draft, item.key);
                                                            } else {
                                                                draft.push(item.key);
                                                            }
                                                        })
                                                    );
                                                }}
                                                isItemVisible={(item) => {
                                                    return showValues.length === data.flattenValues.length
                                                        ? true
                                                        : showValues.includes(item.text);
                                                }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            </div>
                        );
                    }
                    return null;
                })}
                <div className="h-px my-1 bg-border"/>
                <div className="fortune-menuitem-row">
                    <Button
                        size="sm"
                        onClick={() => {
                            if (col == null) return;
                            setContext((draftCtx) => {
                                const rowHidden = hiddenRows.current.reduce(
                                    (pre, curr) => {
                                        pre[curr] = 0;
                                        return pre;
                                    },
                                    {} as Record<string, number>
                                );
                                saveFilter(
                                    draftCtx,
                                    hiddenRows.current.length > 0,
                                    rowHidden,
                                    {},
                                    startRow,
                                    endRow,
                                    col,
                                    startCol,
                                    endCol
                                );
                                hiddenRows.current = [];
                                draftCtx.filterContextMenu = undefined;
                            });
                        }}
                    >
                        {filter.filterConform}
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                            setContext((draftCtx) => {
                                draftCtx.filterContextMenu = undefined;
                            });
                        }}
                    >
                        {filter.filterCancel}
                    </Button>
                    <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => {
                            setContext((draftCtx) => {
                                clearFilter(draftCtx);
                            });
                        }}
                    >
                        {filter.clearFilter}
                    </Button>
                </div>
            </div>
            {showSubMenu && (
                <div
                    ref={subMenuRef}
                    className="luckysheet-filter-bycolor-submenu"
                    style={subMenuPos}
                    onMouseEnter={() => {
                        mouseHoverSubMenu.current = true;
                    }}
                    onMouseLeave={() => {
                        mouseHoverSubMenu.current = false;
                        setShowSubMenu(false);
                    }}
                >
                    {filterColors.bgColors.length < 2 &&
                    filterColors.fcColors.length < 2 ? (
                        <div className="one-color-tip">
                            {filter.filterContainerOneColorTip}
                        </div>
                    ) : (
                        <>
                            {[
                                {
                                    key: "bgColors",
                                    title: filter.filiterByColorTip,
                                    colors: filterColors.bgColors,
                                },
                                {
                                    key: "fcColors",
                                    title: filter.filiterByTextColorTip,
                                    colors: filterColors.fcColors,
                                },
                            ].map((v) =>
                                renderColorList(v.key, v.title, v.colors, onColorSelectChange)
                            )}
                            <Button
                                size="sm"
                                onClick={() => {
                                    if (col == null) return;
                                    setContext((draftCtx) => {
                                        const uncheckedRows = Object.values(filterColors)
                                            .flat()
                                            .flatMap((v) => (v.checked ? [] : v.rows));
                                        const rowHidden = uncheckedRows.reduce(
                                            (pre, curr) => {
                                                pre[curr] = 0;
                                                return pre;
                                            },
                                            {} as Record<string, number>
                                        );
                                        saveFilter(
                                            draftCtx,
                                            Object.keys(rowHidden).length > 0,
                                            rowHidden,
                                            {},
                                            startRow,
                                            endRow,
                                            col,
                                            startCol,
                                            endCol
                                        );
                                        hiddenRows.current = [];
                                        draftCtx.filterContextMenu = undefined;
                                    });
                                }}
                            >
                                {filter.filterConform}
                            </Button>
                        </>
                    )}
                </div>
            )}
        </>
    );
};
