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
import WorkbookContext from "../../context";
import {useDialog} from "../../hooks/useDialog";
import {SVGIcon} from "../icon-map";
import {Button} from "@workspace/ui/components/button";

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
                ctx.luckysheetfile[index].dataVerification || {};
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

    return (
        <div className="min-w-[500px] py-2.5 select-none">
            <div className="text-base">{toolbar.dataVerification}</div>
            <div className="text-sm">
                <div className="p-2.5 border-t border-b border-[#e1e4e8]">
                    <div className="text-sm font-semibold mb-2.5">{dataVerification.cellRange}</div>
                    <div className="w-full h-[30px] border border-[#d4d4d4] flex">
                        <input
                            className="flex-1 h-[30px] px-2.5 border-none outline-none"
                            spellCheck="false"
                            value={context.dataVerification!.dataRegulation?.rangeTxt}
                            onChange={(e) => {
                                const {value} = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.rangeTxt = value;
                                });
                            }}
                        />
                        <i
                            className="float-right mt-1 mr-1.5 cursor-pointer"
                            aria-hidden="true"
                            onClick={() => {
                                hideDialog();
                                dataSelectRange(
                                    "rangeTxt",
                                    context.dataVerification!.dataRegulation!.value1
                                );
                            }}
                            tabIndex={0}
                        >
                            <SVGIcon name="tab" width={18}/>
                        </i>
                    </div>
                </div>
                <div className="p-2.5 border-b border-[#e1e4e8]">
                    <div className="text-sm font-semibold mb-2.5">
                        {dataVerification.verificationCondition}
                    </div>
                    <select
                        className="w-full h-[30px] border-[#d4d4d4] outline-none"
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
                        <div className="mt-1.5 text-xs">
                            <div className="w-full h-[30px] border border-[#d4d4d4] flex">
                                <input
                                    className="flex-1 h-[30px] px-2.5 border-none outline-none"
                                    spellCheck="false"
                                    value={context.dataVerification!.dataRegulation!.value1}
                                    placeholder={dataVerification.placeholder1}
                                    onChange={(e) => {
                                        const {value} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                                <i
                                    className="float-right mt-1 mr-1.5 cursor-pointer"
                                    aria-hidden="true"
                                    onClick={() =>
                                        dataSelectRange(
                                            "dropDown",
                                            context.dataVerification!.dataRegulation!.value1
                                        )
                                    }
                                    tabIndex={0}
                                >
                                    <SVGIcon name="tab" width={18}/>
                                </i>
                            </div>
                            <div className="text-xs leading-6">
                                <input
                                    type="checkbox"
                                    className="align-text-top"
                                    checked={
                                        context.dataVerification!.dataRegulation!.type2 === "true"
                                    }
                                    id="mul"
                                    onChange={(e) => {
                                        const {checked} = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.type2 = `${checked}`;
                                        });
                                    }}
                                />
                                <label htmlFor="mul">{dataVerification.allowMultiSelect}</label>
                            </div>
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === "checkbox" && (
                        <div className="mt-1.5 text-xs">
                            <div className="h-[30px] leading-[30px] mb-2.5">
                                <span>{dataVerification.selected} —— </span>
                                <input
                                    type="text"
                                    className="h-[30px] px-2.5 border border-[#d4d4d4] box-border"
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
                            <div className="h-[30px] leading-[30px] mb-2.5">
                                <span>{dataVerification.notSelected} —— </span>
                                <input
                                    type="text"
                                    className="h-[30px] px-2.5 border border-[#d4d4d4] box-border"
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
                        <div className="show-box-item">
                            <select
                                className="w-full h-[30px] border-[#d4d4d4] outline-none"
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
                                <div className="input-box">
                                    <input
                                        type="number"
                                        placeholder="1"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value1 = value;
                                            });
                                        }}
                                    />
                                    <span>-</span>
                                    <input
                                        type="number"
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
                                <div className="input-box">
                                    <input
                                        type="number"
                                        style={{width: "100%"}}
                                        placeholder={dataVerification.placeholder3}
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
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type ===
                        "text_content" && (
                            <div className="show-box-item">
                                <select
                                    className="w-full h-[30px] border-[#d4d4d4] outline-none"
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
                                <div className="input-box">
                                    <input
                                        type="text"
                                        style={{width: "100%"}}
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
                            </div>
                        )}

                    {context.dataVerification?.dataRegulation?.type === "date" && (
                        <div className="show-box-item">
                            <select
                                className="w-full h-[30px] border-[#d4d4d4] outline-none"
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
                                <div className="input-box">
                                    <input
                                        type="date"
                                        placeholder="1"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const {value} = e.target;
                                            setContext((ctx) => {
                                                ctx.dataVerification!.dataRegulation!.value1 = value;
                                            });
                                        }}
                                    />
                                    <span>-</span>
                                    <input
                                        type="date"
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
                                <div className="input-box">
                                    <input
                                        type="date"
                                        style={{width: "100%"}}
                                        placeholder={dataVerification.placeholder3}
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
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === "validity" && (
                        <div className="show-box-item">
                            <select
                                className="w-full h-[30px] border-[#d4d4d4] outline-none"
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
                        </div>
                    )}
                </div>

                <div className="box-item">
                    {
                        // (["remote", "prohibitInput", "hintShow"] as const)
                        (["prohibitInput", "hintShow"] as const).map((v) => (
                            <div className="check" key={`div${v}`}>
                                <input
                                    type="checkbox"
                                    id={v}
                                    key={`input${v}`}
                                    checked={context.dataVerification!.dataRegulation![v]}
                                    onChange={() => {
                                        setContext((ctx) => {
                                            const dataRegulation =
                                                ctx.dataVerification?.dataRegulation;
                                            // if (v === "remote") {
                                            //   dataRegulation!.remote = !dataRegulation!.remote;
                                            // } else
                                            if (v === "prohibitInput") {
                                                dataRegulation!.prohibitInput =
                                                    !dataRegulation!.prohibitInput;
                                            } else if (v === "hintShow") {
                                                dataRegulation!.hintShow = !dataRegulation!.hintShow;
                                            }
                                        });
                                    }}
                                />
                                <label htmlFor={v} key={`label${v}`}>
                                    {(dataVerification as any)[v]}
                                </label>
                            </div>
                        ))
                    }
                    {context.dataVerification?.dataRegulation?.hintShow && (
                        <div className="input-box">
                            <input
                                type="text"
                                style={{width: "100%"}}
                                placeholder={dataVerification.placeholder5}
                                value={context.dataVerification!.dataRegulation!.hintValue}
                                onChange={(e) => {
                                    const {value} = e.target;
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.hintValue = value;
                                    });
                                }}
                            />
                        </div>
                    )}
                </div>
            </div>

            <div className="flex gap-2 mt-2.5">
                <Button size="sm" onClick={() => btn("confirm")}>
                    {button.confirm}
                </Button>
                <Button variant="outline" size="sm" onClick={() => btn("delete")}>
                    {dataVerification.deleteVerification}
                </Button>
                <Button variant="outline" size="sm" onClick={() => btn("close")}>
                    {button.cancel}
                </Button>
            </div>
        </div>
    );
}

