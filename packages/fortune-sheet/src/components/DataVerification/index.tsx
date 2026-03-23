import {
    confirmMessage,
    getDropdownList,
    getFlowdata,
    getRangeByTxt,
    getRangetxt,
    getSheetIndex,
    locale,
    setCellValue,
} from "../../core";
import {useCallback, useContext, useEffect, useState} from "react";
import {WorkbookContext} from "../../context";
import {useDialog} from "../../hooks/useDialog";
import {Table} from "lucide-react";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Checkbox} from "@workspace/ui/components/checkbox";
import {Label} from "@workspace/ui/components/label";
import {DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";

export function DataVerification() {
    const {context, setContext} = useContext(WorkbookContext);
    const {showDialog, hideDialog} = useDialog();
    const {dataVerification, toolbar, button, generalDialog} = locale(context);
    const [numberCondition] = useState<string[]>([
        "between",
        "notBetween",
        "equal",
        "notEqualTo",
        "moreThanThe",
        "lessThan",
        "greaterOrEqualTo",
        "lessThanOrEqualTo",
    ]);

    const [dateCondition] = useState<string[]>([
        "between",
        "notBetween",
        "equal",
        "notEqualTo",
        "earlierThan",
        "noEarlierThan",
        "laterThan",
        "noLaterThan",
    ]);

    // Enable mouse selection
    const dataSelectRange = useCallback(
        (type: string, value: string) => {
            hideDialog();
            setContext((ctx) => {
                ctx.rangeDialog!.show = true;
                ctx.rangeDialog!.type = type;
                ctx.rangeDialog!.rangeTxt = value;
            });
        },
        [hideDialog, setContext]
    );

    // Confirm and cancel buttons
    const btn = useCallback(
        (type: string) => {
            if (type === "confirm") {
                setContext((ctx) => {
                    const isPass = confirmMessage(ctx, generalDialog, dataVerification);
                    if (isPass) {
                        const range = getRangeByTxt(
                            ctx,
                            ctx.dataVerification?.dataRegulation?.rangeTxt as string
                        );
                        if (range.length === 0) {
                            return;
                        }
                        const regulation = ctx.dataVerification!.dataRegulation!;
                        const verifacationT = regulation?.type;
                        const {value1} = regulation;
                        const item = {
                            ...regulation,
                            checked: false, // checkbox defaults to false in cell (unchecked), true for checked
                        };
                        if (verifacationT === "dropdown") {
                            const list = getDropdownList(ctx, value1);
                            item.value1 = list.join(",");
                        }
                        const currentDataVerification =
                            ctx.luckysheetfile[
                                getSheetIndex(ctx, ctx.currentSheetId) as number
                                ].dataVerification ?? {};

                        const str = range[range.length - 1]?.row[0];
                        const edr = range[range.length - 1]?.row[1];
                        const stc = range[range.length - 1]?.column[0];
                        const edc = range[range.length - 1]?.column[1];
                        const d = getFlowdata(ctx);
                        if (
                            !d ||
                            str == null ||
                            stc == null ||
                            edr == null ||
                            edc == null
                        )
                            return;
                        for (let r = str; r <= edr; r += 1) {
                            for (let c = stc; c <= edc; c += 1) {
                                const key = `${r}_${c}`;
                                currentDataVerification[key] = item;
                                if (regulation.type === "checkbox") {
                                    setCellValue(ctx, r, c, d, item.value2);
                                }
                            }
                        }
                        ctx.luckysheetfile[
                            getSheetIndex(ctx, ctx.currentSheetId) as number
                            ].dataVerification = currentDataVerification;
                    }
                });
            } else if (type === "delete") {
                setContext((ctx) => {
                    const range = getRangeByTxt(
                        ctx,
                        ctx.dataVerification?.dataRegulation?.rangeTxt as string
                    );
                    if (range.length === 0) {
                        showDialog(generalDialog.noSeletionError, "ok");
                        return;
                    }
                    const currentDataVerification =
                        ctx.luckysheetfile[getSheetIndex(ctx, ctx.currentSheetId) as number]
                            .dataVerification ?? {};
                    const str = range[range.length - 1]?.row[0];
                    const edr = range[range.length - 1]?.row[1];
                    const stc = range[range.length - 1]?.column[0];
                    const edc = range[range.length - 1]?.column[1];
                    if (str == null || stc == null || edr == null || edc == null)
                        return;
                    for (let r = str; r <= edr; r += 1) {
                        for (let c = stc; c <= edc; c += 1) {
                            delete currentDataVerification[`${r}_${c}`];
                        }
                    }
                });
            }
            hideDialog();
        },
        [dataVerification, generalDialog, hideDialog, setContext, showDialog]
    );

    // Initialize
    useEffect(() => {
        setContext((ctx) => {
            let rangeT = "";

            // If there's a selection, convert it to string form for display
            if (ctx.luckysheet_select_save) {
                const range =
                    ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
                rangeT = getRangetxt(
                    context,
                    context.currentSheetId,
                    range,
                    context.currentSheetId
                );
            }

            // Initialize values
            const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
            const ctxDataVerification =
                ctx.luckysheetfile[index].dataVerification ?? {};
            if (!ctx.luckysheet_select_save) return;
            const last =
                ctx.luckysheet_select_save[ctx.luckysheet_select_save.length - 1];
            const rowIndex = last.row_focus;
            const colIndex = last.column_focus;
            if (rowIndex == null || colIndex == null) return;
            const item = ctxDataVerification[`${rowIndex}_${colIndex}`];
            const defaultItem = item ?? {};
            let rangValue = defaultItem.value1 ?? "";
            // Range assignment related
            if (
                ctx.rangeDialog?.type === "dropDown" &&
                ctx.dataVerification &&
                ctx.dataVerification.dataRegulation &&
                ctx.dataVerification.dataRegulation.rangeTxt
            ) {
                // When it's a dropdown list selection, assign dropdown selection, keep range unchanged
                rangeT = ctx.dataVerification.dataRegulation.rangeTxt;
                rangValue = ctx.rangeDialog.rangeTxt;
            } else if (
                ctx.rangeDialog?.type === "rangeTxt" &&
                ctx.dataVerification &&
                ctx.dataVerification.dataRegulation &&
                ctx.dataVerification.dataRegulation.value1
            ) {
                // When it's a range selection, assign range, keep dropdown selection unchanged
                rangValue = ctx.dataVerification.dataRegulation.value1;
                rangeT = ctx.rangeDialog.rangeTxt;
            }
            ctx.rangeDialog!.type = "";

            if (item) {
                ctx.dataVerification!.dataRegulation = {
                    ...item,
                    value1: rangValue,
                    rangeTxt: rangeT,
                };
            } else {
                ctx.dataVerification!.dataRegulation! = {
                    type: "dropdown",
                    type2: "",
                    rangeTxt: rangeT,
                    value1: rangValue,
                    value2: "",
                    validity: "",
                    remote: false,
                    prohibitInput: false,
                    hintShow: false,
                    hintValue: "",
                };
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const selectClass = "h-8 w-full rounded-md border border-input bg-background px-3 text-sm";

    return (
        <div className="min-w-[500px] flex flex-col gap-4 select-none">
            <DialogHeader>
                <DialogTitle>{toolbar.dataVerification}</DialogTitle>
            </DialogHeader>

            <div className="text-sm space-y-4">
                <div>
                    <div className="text-sm font-semibold mb-2">{dataVerification.cellRange}</div>
                    <div className="flex h-8 rounded-md border border-input overflow-hidden">
                        <Input
                            className="flex-1 border-none rounded-none h-full"
                            spellCheck={false}
                            value={context.dataVerification!.dataRegulation?.rangeTxt}
                            onChange={(e) => {
                                const {value} = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.rangeTxt = value;
                                });
                            }}
                        />
                        <button
                            type="button"
                            className="px-2 hover:bg-muted cursor-pointer"
                            onClick={() => {
                                hideDialog();
                                dataSelectRange(
                                    "rangeTxt",
                                    context.dataVerification!.dataRegulation!.value1
                                );
                            }}
                        >
                            <Table className="size-4"/>
                        </button>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-semibold">
                        {dataVerification.verificationCondition}
                    </div>
                    <select
                        className={selectClass}
                        value={context.dataVerification!.dataRegulation!.type}
                        onChange={(e) => {
                            const {value} = e.target;
                            setContext((ctx) => {
                                ctx.dataVerification!.dataRegulation!.type = value;
                                if (value === "dropdown" || value === "checkbox") {
                                    ctx.dataVerification!.dataRegulation!.type2 = "";
                                } else if (
                                    value === "number" ||
                                    value === "number_integer" ||
                                    value === "number_decimal" ||
                                    value === "text_length" ||
                                    value === "date"
                                ) {
                                    ctx.dataVerification!.dataRegulation!.type2 = "between";
                                } else if (value === "text_content") {
                                    ctx.dataVerification!.dataRegulation!.type2 = "include";
                                } else if (value === "validity") {
                                    ctx.dataVerification!.dataRegulation!.type2 =
                                        "identificationNumber";
                                }
                                ctx.dataVerification!.dataRegulation!.value1 = "";
                                ctx.dataVerification!.dataRegulation!.value2 = "";
                            });
                        }}
                    >
                        {[
                            "dropdown",
                            "checkbox",
                            "number",
                            "number_integer",
                            "number_decimal",
                            "text_content",
                            "text_length",
                            "date",
                            "validity",
                        ].map((v) => (
                            <option value={v} key={v}>
                                {(dataVerification as any)[v]}
                            </option>
                        ))}
                    </select>

                    {context.dataVerification?.dataRegulation?.type === "dropdown" && (
                        <div className="space-y-2">
                            <div className="flex h-8 rounded-md border border-input overflow-hidden">
                                <Input
                                    className="flex-1 border-none rounded-none h-full"
                                    spellCheck={false}
                                    value={context.dataVerification!.dataRegulation!.value1}
                                    placeholder={dataVerification.placeholder1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                                <button
                                    type="button"
                                    className="px-2 hover:bg-muted cursor-pointer"
                                    onClick={() =>
                                        dataSelectRange(
                                            "dropDown",
                                            context.dataVerification!.dataRegulation!.value1
                                        )
                                    }
                                >
                                    <Table className="size-4"/>
                                </button>
                            </div>
                            <Label className="flex items-center gap-1.5">
                                <Checkbox
                                    checked={
                                        context.dataVerification!.dataRegulation!.type2 === "true"
                                    }
                                    onCheckedChange={(checked) => {
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.type2 = `${checked}`;
                                        });
                                    }}
                                />
                                {dataVerification.allowMultiSelect}
                            </Label>
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === "checkbox" && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <span className="text-sm shrink-0">{dataVerification.selected}</span>
                                <Input
                                    className="h-8"
                                    placeholder={dataVerification.placeholder2}
                                    value={context.dataVerification?.dataRegulation?.value1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-sm shrink-0">{dataVerification.notSelected}</span>
                                <Input
                                    className="h-8"
                                    placeholder={dataVerification.placeholder2}
                                    value={context.dataVerification?.dataRegulation?.value2}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value2 = value;
                                        });
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {(context.dataVerification?.dataRegulation?.type === "number" ||
                        context.dataVerification?.dataRegulation?.type ===
                        "number_integer" ||
                        context.dataVerification?.dataRegulation?.type ===
                        "number_decimal" ||
                        context.dataVerification?.dataRegulation?.type ===
                        "text_length") && (
                        <div className="space-y-2">
                            <select
                                className={selectClass}
                                value={context.dataVerification.dataRegulation.type2}
                                onChange={(e) => {
                                    const {value} = e.target;
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.type2 = value;
                                        ctx.dataVerification!.dataRegulation!.value1 = "";
                                        ctx.dataVerification!.dataRegulation!.value2 = "";
                                    });
                                }}
                            >
                                {numberCondition.map((v) => (
                                    <option value={v} key={v}>
                                        {(dataVerification as any)[v]}
                                    </option>
                                ))}
                            </select>
                            {context.dataVerification.dataRegulation.type2 === "between" ||
                            context.dataVerification.dataRegulation.type2 === "notBetween" ? (
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number"
                                        className="h-8"
                                        placeholder="1"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value1 = value;
                                            });
                                        }}
                                    />
                                    <span className="text-sm">-</span>
                                    <Input
                                        type="number"
                                        className="h-8"
                                        placeholder="100"
                                        value={context.dataVerification.dataRegulation.value2}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value2 = value;
                                            });
                                        }}
                                    />
                                </div>
                            ) : (
                                <Input
                                    type="number"
                                    className="h-8"
                                    placeholder={dataVerification.placeholder3}
                                    value={context.dataVerification.dataRegulation.value1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            )}
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type ===
                        "text_content" && (
                            <div className="space-y-2">
                                <select
                                    className={selectClass}
                                    value={context.dataVerification.dataRegulation.type2}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.type2 = value;
                                            ctx.dataVerification!.dataRegulation!.value1 = "";
                                            ctx.dataVerification!.dataRegulation!.value2 = "";
                                        });
                                    }}
                                >
                                    {["include", "exclude", "equal"].map((v) => (
                                        <option value={v} key={v}>
                                            {(dataVerification as any)[v]}
                                        </option>
                                    ))}
                                </select>
                                <Input
                                    className="h-8"
                                    placeholder={dataVerification.placeholder4}
                                    value={context.dataVerification.dataRegulation.value1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            </div>
                        )}

                    {context.dataVerification?.dataRegulation?.type === "date" && (
                        <div className="space-y-2">
                            <select
                                className={selectClass}
                                value={context.dataVerification.dataRegulation.type2}
                                onChange={(e) => {
                                    const {value} = e.target;
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.type2 = value;
                                        ctx.dataVerification!.dataRegulation!.value1 = "";
                                        ctx.dataVerification!.dataRegulation!.value2 = "";
                                    });
                                }}
                            >
                                {dateCondition.map((v) => (
                                    <option value={v} key={v}>
                                        {(dataVerification as any)[v]}
                                    </option>
                                ))}
                            </select>
                            {context.dataVerification.dataRegulation.type2 === "between" ||
                            context.dataVerification.dataRegulation.type2 === "notBetween" ? (
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="date"
                                        className="h-8"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value1 = value;
                                            });
                                        }}
                                    />
                                    <span className="text-sm">-</span>
                                    <Input
                                        type="date"
                                        className="h-8"
                                        value={context.dataVerification.dataRegulation.value2}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value2 = value;
                                            });
                                        }}
                                    />
                                </div>
                            ) : (
                                <Input
                                    type="date"
                                    className="h-8"
                                    placeholder={dataVerification.placeholder3}
                                    value={context.dataVerification.dataRegulation.value1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            )}
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === "validity" && (
                        <select
                            className={selectClass}
                            value={context.dataVerification.dataRegulation.type2}
                            onChange={(e) => {
                                const {value} = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.type2 = value;
                                    ctx.dataVerification!.dataRegulation!.value1 = "";
                                    ctx.dataVerification!.dataRegulation!.value2 = "";
                                });
                            }}
                        >
                            {["identificationNumber", "phoneNumber"].map((v) => (
                                <option value={v} key={v}>
                                    {(dataVerification as any)[v]}
                                </option>
                            ))}
                        </select>
                    )}
                </div>

                <div className="space-y-2">
                    {(["prohibitInput", "hintShow"] as const).map((v) => (
                        <Label className="flex items-center gap-1.5" key={v}>
                            <Checkbox
                                id={v}
                                checked={context.dataVerification!.dataRegulation![v]}
                                onCheckedChange={() => {
                                    setContext((ctx) => {
                                        const dataRegulation =
                                            ctx.dataVerification?.dataRegulation;
                                        if (v === "prohibitInput") {
                                            dataRegulation!.prohibitInput =
                                                !dataRegulation!.prohibitInput;
                                        } else if (v === "hintShow") {
                                            dataRegulation!.hintShow = !dataRegulation!.hintShow;
                                        }
                                    });
                                }}
                            />
                            {(dataVerification as any)[v]}
                        </Label>
                    ))}
                    {context.dataVerification?.dataRegulation?.hintShow && (
                        <Input
                            className="h-8"
                            placeholder={dataVerification.placeholder5}
                            value={context.dataVerification!.dataRegulation!.hintValue}
                            onChange={(e) => {
                                const {value} = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.hintValue = value;
                                });
                            }}
                        />
                    )}
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => btn("close")}>
                    {button.cancel}
                </Button>
                <Button variant="outline" size="sm" onClick={() => btn("delete")}>
                    {dataVerification.deleteVerification}
                </Button>
                <Button size="sm" onClick={() => btn("confirm")}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}

