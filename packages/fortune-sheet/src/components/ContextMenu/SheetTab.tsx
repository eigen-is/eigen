import {api, deleteSheet, locale} from "../../core";
import React, {useCallback, useContext, useState,} from "react";
import {WorkbookContext} from "../../context";
import {useAlert} from "../../hooks/useAlert";
import {ChangeColor} from "../ChangeColor";
import {ChevronRight} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";

export function SheetTabContextMenu() {
    const {context, setContext, settings} = useContext(WorkbookContext);
    const {x, y, sheet, onRename} = context.sheetTabContextMenu;
    const {sheetconfig} = locale(context);
    const [isShowChangeColor, setIsShowChangeColor] = useState<boolean>(false);
    const [isShowInputColor, setIsShowInputColor] = useState<boolean>(false);
    const {showAlert, hideAlert} = useAlert();

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.sheetTabContextMenu = {};
        });
    }, [setContext]);

    const moveSheet = useCallback(
        (delta: number) => {
            if (context.allowEdit === false) return;
            if (!sheet) return;
            setContext((ctx) => {
                let currentOrder = -1;
                const sorted = ctx.luckysheetfile
                    .slice()
                    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                for (const [i, _sheet] of sorted.entries()) {
                    _sheet.order = i;
                    if (_sheet.id === sheet.id) {
                        currentOrder = i;
                    }
                }
                api.setSheetOrder(ctx, {[sheet.id!]: currentOrder + delta});
            });
        },
        [context.allowEdit, setContext, sheet]
    );

    const hideSheet = useCallback(() => {
        if (context.allowEdit === false) return;
        if (!sheet) return;
        setContext((ctx) => {
            const shownSheets = ctx.luckysheetfile.filter(
                (oneSheet) => oneSheet.hide === undefined || oneSheet?.hide !== 1
            );
            if (shownSheets.length > 1) {
                api.hideSheet(ctx, sheet.id as string);
            } else {
                showAlert(sheetconfig.noMoreSheet, "ok");
            }
        });
    }, [context.allowEdit, setContext, sheet, showAlert, sheetconfig]);

    const copySheet = useCallback(() => {
        if (context.allowEdit === false) return;
        if (!sheet?.id) return;
        setContext(
            (ctx) => {
                api.copySheet(ctx, sheet.id!);
            },
            {addSheetOp: true}
        );
    }, [context.allowEdit, setContext, sheet?.id]);
    const updateShowInputColor = useCallback((state: boolean) => {
        setIsShowInputColor(state);
    }, []);

    const focusSheet = useCallback(() => {
        if (context.allowEdit === false) return;
        if (!sheet?.id) return;
        setContext((ctx) => {
            for (const sheetfile of ctx.luckysheetfile) {
                sheetfile.status = sheet.id === sheetfile.id ? 1 : 0;
            }
        });
    }, [context.allowEdit, setContext, sheet?.id]);

    const isOpen = sheet != null && x != null && y != null;

    return (
        <DropdownMenu open={isOpen} onOpenChange={(open) => {
            if (!open) close();
        }}>
            <DropdownMenuTrigger asChild>
                <div
                    style={{
                        position: 'fixed',
                        left: x,
                        top: y,
                        width: 0,
                        height: 0,
                        pointerEvents: 'none',
                    }}
                />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                side="top"
                align="start"
                collisionPadding={8}
                style={{zIndex: 1010}}
                onContextMenu={(e) => e.stopPropagation()}
            >
                {settings.sheetTabContextMenu?.map((name, i) => {
                    if (name === "delete") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onClick={() => {
                                    const shownSheets = context.luckysheetfile.filter(
                                        (singleSheet) =>
                                            singleSheet.hide === undefined || singleSheet.hide !== 1
                                    );
                                    if (
                                        context.luckysheetfile.length > 1 &&
                                        shownSheets.length > 1
                                    ) {
                                        showAlert(sheetconfig.confirmDelete, "yesno", () => {
                                            setContext(
                                                (ctx) => {
                                                    deleteSheet(ctx, sheet!.id!);
                                                },
                                                {
                                                    deleteSheetOp: {
                                                        id: sheet!.id!,
                                                    },
                                                }
                                            );
                                            hideAlert();
                                        });
                                    } else {
                                        showAlert(sheetconfig.noMoreSheet, "ok");
                                    }
                                    close();
                                }}
                            >
                                {sheetconfig.delete}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "rename") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onClick={() => {
                                    onRename?.();
                                    close();
                                }}
                            >
                                {sheetconfig.rename}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "move") {
                        return (
                            <React.Fragment key={name}>
                                <DropdownMenuItem
                                    onClick={() => {
                                        moveSheet(-1.5);
                                        close();
                                    }}
                                >
                                    {sheetconfig.moveLeft}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onClick={() => {
                                        moveSheet(1.5);
                                        close();
                                    }}
                                >
                                    {sheetconfig.moveRight}
                                </DropdownMenuItem>
                            </React.Fragment>
                        );
                    }
                    if (name === "hide") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onClick={() => {
                                    hideSheet();
                                    close();
                                }}
                            >
                                {sheetconfig.hide}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "copy") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onClick={() => {
                                    copySheet();
                                    close();
                                }}
                            >
                                {sheetconfig.copy}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "color") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onMouseEnter={() => {
                                    setIsShowChangeColor(true);
                                }}
                                onMouseLeave={() => {
                                    if (!isShowInputColor) {
                                        setIsShowChangeColor(false);
                                    }
                                }}
                            >
                                {sheetconfig.changeColor}
                                <span className="change-color-triangle">
                                    <ChevronRight width={18} height={18} aria-hidden="true"/>
                                </span>
                                {isShowChangeColor && context.allowEdit && (
                                    <ChangeColor triggerParentUpdate={updateShowInputColor}/>
                                )}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "focus") {
                        return (
                            <DropdownMenuItem
                                key={name}
                                onClick={() => {
                                    focusSheet();
                                    close();
                                }}
                            >
                                {sheetconfig.focus}
                            </DropdownMenuItem>
                        );
                    }
                    if (name === "|") {
                        return <DropdownMenuSeparator key={`divide-${i}`}/>;
                    }
                    return null;
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
