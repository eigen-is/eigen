import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Input } from '@workspace/ui/components/input';
import { Popover, PopoverAnchor, PopoverContent } from '@workspace/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { concat, debounce, omit, union, without, xor } from 'es-toolkit/compat';
import { ChevronDown, ChevronRight, Filter as FilterIcon } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useAlert } from '../../hooks/useAlert';
import {
    type Context,
    clearFilter,
    en,
    FILTER_CONDITION_ITEMS,
    type FilterColor,
    type FilterConditionName,
    type FilterDate,
    type FilterValue,
    filterConditionArity,
    getFilterColumnColors,
    getFilterColumnValues,
    getFilterConditionHiddenRows,
    orderbydatafiler,
    saveFilter,
} from '../../state';

type ColorKind = 'bgColors' | 'fcColors';

const menuItemClass =
    'relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground';

const FilterValueItem: React.FC<{
    item: FilterValue;
    isChecked: (key: string) => boolean;
    onChange: (item: FilterValue, checked: boolean) => void;
    isItemVisible: (item: FilterValue) => boolean;
}> = ({ item, isChecked, onChange, isItemVisible }) => {
    const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);
    if (!isItemVisible(item)) return null;
    return (
        <label className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded-sm text-sm">
            <Checkbox checked={checked} onCheckedChange={(v) => onChange(item, !!v)} />
            <span className="truncate">{item.text}</span>
            <span className="ml-auto text-xs text-muted-foreground">{`(${item.rows.length})`}</span>
        </label>
    );
};

const DateSelectTreeItem: React.FC<{
    item: FilterDate;
    depth?: number;
    initialExpand: (key: string) => boolean;
    onExpand?: (key: string, expand: boolean) => void;
    isChecked: (key: string) => boolean;
    onChange: (data: FilterDate, checked: boolean) => void;
    isItemVisible: (item: FilterDate) => boolean;
}> = ({ item, depth = 0, initialExpand, onExpand, isChecked, onChange, isItemVisible }) => {
    const [expand, setExpand] = useState(initialExpand(item.key));
    const checked = useMemo(() => isChecked(item.key), [isChecked, item.key]);
    if (!isItemVisible(item)) return null;
    const hasChildren = item.children && item.children.length > 0;
    return (
        <div>
            <div
                className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded-sm text-sm"
                style={{ paddingLeft: 8 + depth * 16 }}
                onClick={() => {
                    onExpand?.(item.key, !expand);
                    setExpand(!expand);
                }}
                tabIndex={0}
            >
                {hasChildren ? (
                    expand ? (
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : (
                        <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                    )
                ) : (
                    <span className="w-3.5 shrink-0" />
                )}
                <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => onChange(item, !!v)}
                    onClick={(e) => e.stopPropagation()}
                />
                <span className="truncate">{item.text}</span>
                <span className="ml-auto text-xs text-muted-foreground">{`(${item.rows.length})`}</span>
            </div>
            {expand &&
                item.children.map((v) => (
                    <DateSelectTreeItem
                        key={v.key}
                        item={v}
                        depth={depth + 1}
                        {...{ initialExpand, onExpand, isChecked, onChange, isItemVisible }}
                    />
                ))}
        </div>
    );
};

const DateSelectTree: React.FC<{
    dates: FilterDate[];
    initialExpand: (key: string) => boolean;
    onExpand?: (key: string, expand: boolean) => void;
    isChecked: (key: string) => boolean;
    onChange: (item: FilterDate, checked: boolean) => void;
    isItemVisible: (item: FilterDate) => boolean;
}> = ({ dates, initialExpand, onExpand, isChecked, onChange, isItemVisible }) => (
    <>
        {dates.map((v) => (
            <DateSelectTreeItem
                key={v.key}
                item={v}
                {...{ initialExpand, onExpand, isChecked, onChange, isItemVisible }}
            />
        ))}
    </>
);

export const FilterMenu: React.FC = () => {
    const { context, setContext, settings } = useContext(WorkbookContext);
    const contextRef = useRef<Context>(context);
    const { filterContextMenu } = context;
    const { startRow, startCol, endRow, endCol, col } = filterContextMenu || {
        startRow: null,
        startCol: null,
        endRow: null,
        endCol: null,
        col: null,
    };
    const { filter } = en;
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
    const [searchText, setSearchText] = useState('');
    const [filterColors, setFilterColors] = useState<{
        bgColors: FilterColor[];
        fcColors: FilterColor[];
    }>({ bgColors: [], fcColors: [] });
    const [conditionExpanded, setConditionExpanded] = useState(false);
    const [conditionName, setConditionName] = useState<FilterConditionName | 'none'>('none');
    const [conditionValues, setConditionValues] = useState<[string, string]>(['', '']);
    const [showSubMenu, setShowSubMenu] = useState(false);
    const subMenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const { showAlert } = useAlert();
    contextRef.current = context;

    // Bridge the gap between the trigger and the portaled PopoverContent so the cursor
    // can cross the side-offset without unmounting the submenu.
    const openSubMenu = useCallback(() => {
        if (subMenuCloseTimer.current) clearTimeout(subMenuCloseTimer.current);
        setShowSubMenu(true);
    }, []);

    const closeSubMenu = useCallback(() => {
        if (subMenuCloseTimer.current) clearTimeout(subMenuCloseTimer.current);
        subMenuCloseTimer.current = setTimeout(() => setShowSubMenu(false), 120);
    }, []);

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.filterContextMenu = undefined;
        });
    }, [setContext]);

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
            debounce((text: string) => {
                setShowValues(data.flattenValues.filter((v) => v.toLowerCase().indexOf(text.toLowerCase()) > -1));
            }, 300),
        [data.flattenValues],
    );

    // Cancel a pending search when the column (and thus this debounce) changes or on
    // unmount, so a stale column's timer can't overwrite the new column's values.
    useEffect(() => searchValues.cancel, [searchValues]);

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
        setDatesUncheck((prev) => xor(prev, Object.keys(data.dateRowMap)));
        setValuesUncheck((prev) => xor(prev, Object.keys(data.valueRowMap)));
        hiddenRows.current = xor(hiddenRows.current, data.visibleRows);
    }, [data.dateRowMap, data.valueRowMap, data.visibleRows]);

    const onColorSelectChange = useCallback((key: ColorKind, color: string, checked: boolean) => {
        setFilterColors((prev) => ({
            ...prev,
            [key]: prev[key].map((v) => (v.color === color ? { ...v, checked } : v)),
        }));
    }, []);

    const sortData = useCallback(
        (asc: boolean) => {
            if (col == null) return;
            setContext((draftCtx) => {
                const errMsg = orderbydatafiler(draftCtx, startRow, startCol, endRow, endCol, col, asc);
                if (errMsg != null) showAlert(errMsg);
            });
        },
        [col, setContext, startRow, startCol, endRow, endCol, showAlert],
    );

    useEffect(() => {
        if (col == null) return;
        setSearchText('');
        setShowSubMenu(false);
        dateTreeExpandState.current = {};
        hiddenRows.current = filterContextMenu?.hiddenRows || [];
        const res = getFilterColumnValues(contextRef.current, col, startRow, endRow, startCol);
        setData(omit(res, ['datesUncheck', 'valuesUncheck']));
        setDatesUncheck(res.datesUncheck);
        setValuesUncheck(res.valuesUncheck);
        setShowValues(res.flattenValues);
        const savedCondition = contextRef.current.filter[col - startCol]?.byCondition;
        setConditionName(savedCondition?.conditionName ?? 'none');
        setConditionValues([savedCondition?.values[0] ?? '', savedCondition?.values[1] ?? '']);
        setConditionExpanded(savedCondition != null);
    }, [col, endRow, startRow, startCol, filterContextMenu?.hiddenRows]);

    useEffect(() => {
        if (col == null) return;
        setFilterColors(getFilterColumnColors(contextRef.current, col, startRow, endRow));
    }, [col, endRow, startRow]);

    if (!filterContextMenu) return null;

    return (
        <Popover open onOpenChange={(open) => !open && close()}>
            <PopoverAnchor asChild>
                <div
                    style={{
                        position: 'fixed',
                        left: filterContextMenu.x,
                        top: filterContextMenu.y,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                    }}
                />
            </PopoverAnchor>
            <PopoverContent
                side="bottom"
                align="start"
                collisionPadding={8}
                className="flex w-auto min-w-96 flex-col p-1 text-sm"
                onContextMenu={(e) => e.stopPropagation()}
            >
                {settings.filterContextMenu?.map((name, i) => {
                    if (name === '|') {
                        // biome-ignore lint/suspicious/noArrayIndexKey: divider in static config menu
                        return <div key={`divider-${i}`} className="h-px my-1 bg-border" />;
                    }
                    if (name === 'sort-by-asc') {
                        return (
                            <button
                                type="button"
                                key={name}
                                className={cn(menuItemClass, 'w-full')}
                                onClick={() => sortData(true)}
                            >
                                {filter.sortByAsc}
                            </button>
                        );
                    }
                    if (name === 'sort-by-desc') {
                        return (
                            <button
                                type="button"
                                key={name}
                                className={cn(menuItemClass, 'w-full')}
                                onClick={() => sortData(false)}
                            >
                                {filter.sortByDesc}
                            </button>
                        );
                    }
                    if (name === 'filter-by-color') {
                        return (
                            <Popover key={name} open={showSubMenu} onOpenChange={setShowSubMenu}>
                                <PopoverAnchor asChild>
                                    <button
                                        type="button"
                                        className={cn(menuItemClass, 'w-full justify-between gap-2')}
                                        onMouseEnter={openSubMenu}
                                        onMouseLeave={closeSubMenu}
                                        onClick={openSubMenu}
                                    >
                                        <span>{filter.filterByColor}</span>
                                        <ChevronRight className="size-3.5" aria-hidden="true" />
                                    </button>
                                </PopoverAnchor>
                                <PopoverContent
                                    side="right"
                                    align="start"
                                    sideOffset={4}
                                    className="w-auto p-2 text-sm"
                                    onMouseEnter={openSubMenu}
                                    onMouseLeave={closeSubMenu}
                                >
                                    {filterColors.bgColors.length < 2 && filterColors.fcColors.length < 2 ? (
                                        <div className="px-2 py-1 text-muted-foreground">
                                            {filter.filterContainerOneColorTip}
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {(
                                                [
                                                    {
                                                        key: 'bgColors',
                                                        title: filter.filiterByColorTip,
                                                        colors: filterColors.bgColors,
                                                    },
                                                    {
                                                        key: 'fcColors',
                                                        title: filter.filiterByTextColorTip,
                                                        colors: filterColors.fcColors,
                                                    },
                                                ] as const
                                            ).map(({ key, title, colors }) =>
                                                colors.length > 1 ? (
                                                    <div key={key}>
                                                        <div className="px-1 py-1 text-xs text-muted-foreground">
                                                            {title}
                                                        </div>
                                                        <div className="flex flex-col gap-1">
                                                            {colors.map((v) => (
                                                                <label
                                                                    key={v.color}
                                                                    className="flex items-center gap-2 px-2 py-1 cursor-pointer hover:bg-accent rounded-sm"
                                                                >
                                                                    <span
                                                                        className="size-4 rounded border"
                                                                        style={{ backgroundColor: v.color }}
                                                                    />
                                                                    <Checkbox
                                                                        checked={v.checked}
                                                                        onCheckedChange={(c) =>
                                                                            onColorSelectChange(key, v.color, !!c)
                                                                        }
                                                                    />
                                                                </label>
                                                            ))}
                                                        </div>
                                                    </div>
                                                ) : null,
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
                                                            {} as Record<string, number>,
                                                        );
                                                        saveFilter(
                                                            draftCtx,
                                                            Object.keys(rowHidden).length > 0,
                                                            rowHidden,
                                                            undefined,
                                                            startRow,
                                                            endRow,
                                                            col,
                                                            startCol,
                                                            endCol,
                                                        );
                                                        hiddenRows.current = [];
                                                        draftCtx.filterContextMenu = undefined;
                                                    });
                                                }}
                                            >
                                                {filter.filterConform}
                                            </Button>
                                        </div>
                                    )}
                                </PopoverContent>
                            </Popover>
                        );
                    }
                    if (name === 'filter-by-condition') {
                        const arity = conditionName === 'none' ? 0 : filterConditionArity(conditionName);
                        return (
                            <div key={name}>
                                <button
                                    type="button"
                                    className={cn(menuItemClass, 'w-full justify-between gap-2')}
                                    onClick={() => setConditionExpanded((prev) => !prev)}
                                >
                                    <span>{filter.filterByCondition}</span>
                                    {conditionExpanded ? (
                                        <ChevronDown className="size-3.5" aria-hidden="true" />
                                    ) : (
                                        <ChevronRight className="size-3.5" aria-hidden="true" />
                                    )}
                                </button>
                                {conditionExpanded && (
                                    <div className="px-2 pt-1 pb-1.5 space-y-1.5">
                                        <Select
                                            value={conditionName}
                                            onValueChange={(v) => setConditionName(v as FilterConditionName | 'none')}
                                        >
                                            <SelectTrigger size="sm" className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="none">{filter.conditionNone}</SelectItem>
                                                {FILTER_CONDITION_ITEMS.map((item) => (
                                                    <SelectItem key={item.name} value={item.name}>
                                                        {filter[item.localeKey]}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        {arity >= 1 && (
                                            <Input
                                                className="h-8"
                                                placeholder={filter.filiterInputTip}
                                                value={conditionValues[0]}
                                                onKeyDown={(e) => e.stopPropagation()}
                                                onChange={(e) =>
                                                    setConditionValues([e.target.value, conditionValues[1]])
                                                }
                                            />
                                        )}
                                        {arity === 2 && (
                                            <Input
                                                className="h-8"
                                                placeholder={filter.filiterInputTip}
                                                value={conditionValues[1]}
                                                onKeyDown={(e) => e.stopPropagation()}
                                                onChange={(e) =>
                                                    setConditionValues([conditionValues[0], e.target.value])
                                                }
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    }
                    if (name === 'filter-by-value') {
                        return (
                            // min-h-0 lets this section absorb the popover's viewport clamp; only the list scrolls.
                            <div key={name} className="mt-1 flex min-h-0 flex-col px-1">
                                <div className="flex items-center justify-between mb-1.5">
                                    <div className="text-xs">
                                        <button
                                            type="button"
                                            className="underline-offset-2 hover:underline"
                                            onClick={selectAll}
                                        >
                                            {filter.filterValueByAllBtn}
                                        </button>
                                        {' - '}
                                        <button
                                            type="button"
                                            className="underline-offset-2 hover:underline"
                                            onClick={clearAll}
                                        >
                                            {filter.filterValueByClearBtn}
                                        </button>
                                        {' - '}
                                        <button
                                            type="button"
                                            className="underline-offset-2 hover:underline"
                                            onClick={inverseSelect}
                                        >
                                            {filter.filterValueByInverseBtn}
                                        </button>
                                    </div>
                                    <FilterIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                                </div>
                                <Input
                                    onKeyDown={(e) => e.stopPropagation()}
                                    placeholder={filter.filterValueByTip}
                                    className="h-7 mb-1.5"
                                    value={searchText}
                                    onChange={(e) => {
                                        setSearchText(e.target.value);
                                        searchValues(e.target.value);
                                    }}
                                />
                                <div className="min-h-0 overflow-y-auto">
                                    <DateSelectTree
                                        dates={data.dates}
                                        onExpand={onExpand}
                                        initialExpand={initialExpand}
                                        isChecked={(key) => datesUncheck.find((v) => v.match(key) != null) == null}
                                        onChange={(item, checked) => {
                                            const rows = hiddenRows.current;
                                            hiddenRows.current = checked
                                                ? without(rows, ...item.rows)
                                                : union(rows, item.rows);
                                            setDatesUncheck((prev) =>
                                                checked
                                                    ? without(prev, ...item.dateValues)
                                                    : union(prev, item.dateValues),
                                            );
                                        }}
                                        isItemVisible={(item) =>
                                            showValues.length === data.flattenValues.length
                                                ? true
                                                : showValues.findIndex((v) => v.match(item.key) != null) > -1
                                        }
                                    />
                                    {data.values.map((v) => (
                                        <FilterValueItem
                                            key={v.key}
                                            item={v}
                                            isChecked={(key) => !valuesUncheck.includes(key)}
                                            onChange={(item, checked) => {
                                                const rows = hiddenRows.current;
                                                hiddenRows.current = checked
                                                    ? without(rows, ...item.rows)
                                                    : concat(rows, item.rows);
                                                setValuesUncheck((prev) =>
                                                    checked ? prev.filter((v) => v !== item.key) : [...prev, item.key],
                                                );
                                            }}
                                            isItemVisible={(item) =>
                                                showValues.length === data.flattenValues.length
                                                    ? true
                                                    : showValues.includes(item.text)
                                            }
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    }
                    return null;
                })}
                <div className="h-px my-1 bg-border" />
                <div className="flex items-center justify-between px-1 py-1">
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
                    <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={close}>
                            {filter.filterCancel}
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => {
                                if (col == null) return;
                                setContext((draftCtx) => {
                                    // A selected condition takes precedence over the by-values
                                    // checkboxes — one filter mode per column, like Google Sheets.
                                    const byCondition =
                                        conditionName === 'none'
                                            ? undefined
                                            : {
                                                  conditionName,
                                                  values: conditionValues.slice(0, filterConditionArity(conditionName)),
                                              };
                                    const rowHidden = byCondition
                                        ? getFilterConditionHiddenRows(
                                              draftCtx,
                                              col,
                                              startRow,
                                              endRow,
                                              startCol,
                                              byCondition,
                                          )
                                        : hiddenRows.current.reduce(
                                              (pre, curr) => {
                                                  pre[curr] = 0;
                                                  return pre;
                                              },
                                              {} as Record<string, number>,
                                          );
                                    saveFilter(
                                        draftCtx,
                                        byCondition != null || hiddenRows.current.length > 0,
                                        rowHidden,
                                        byCondition,
                                        startRow,
                                        endRow,
                                        col,
                                        startCol,
                                        endCol,
                                    );
                                    hiddenRows.current = [];
                                    draftCtx.filterContextMenu = undefined;
                                });
                            }}
                        >
                            {filter.filterConform}
                        </Button>
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
};
