import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Table } from 'lucide-react';
import { useCallback, useContext, useEffect } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import {
    applyDataVerification,
    CHECKBOX_CHECKED_VALUE,
    CHECKBOX_UNCHECKED_VALUE,
    confirmMessage,
    en,
    getDropdownList,
    getRangeByTxt,
    getRangetxt,
    getSheetIndex,
} from '../../state';
import { RangeDialog } from './RangeDialog';

const VERIFICATION_TYPES = [
    'dropdown',
    'checkbox',
    'number',
    'number_integer',
    'number_decimal',
    'text_content',
    'text_length',
    'date',
] as const;

const NUMBER_CONDITIONS = [
    'between',
    'notBetween',
    'equal',
    'notEqualTo',
    'moreThanThe',
    'lessThan',
    'greaterOrEqualTo',
    'lessThanOrEqualTo',
] as const;

const DATE_CONDITIONS = [
    'between',
    'notBetween',
    'equal',
    'notEqualTo',
    'earlierThan',
    'noEarlierThan',
    'laterThan',
    'noLaterThan',
] as const;

const TEXT_CONTENT_CONDITIONS = ['include', 'exclude', 'equal'] as const;

export function DataVerification() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog, showNonModalDialog, hideDialog } = useDialog();
    const { dataVerification, toolbar, button, generalDialog } = en;

    // Enable mouse selection
    const dataSelectRange = useCallback(
        (type: string, value: string) => {
            setContext((ctx) => {
                ctx.rangeDialog!.show = true;
                ctx.rangeDialog!.type = type;
                ctx.rangeDialog!.rangeTxt = value;
            });
            showNonModalDialog(<RangeDialog />);
        },
        [setContext, showNonModalDialog],
    );

    // Confirm and cancel buttons
    const btn = useCallback(
        (type: string) => {
            if (type === 'confirm') {
                setContext((ctx) => {
                    const isPass = confirmMessage(ctx, generalDialog, dataVerification);
                    if (isPass) {
                        const range = getRangeByTxt(ctx, ctx.dataVerification?.dataRegulation?.rangeTxt as string);
                        if (range.length === 0) {
                            return;
                        }
                        const target = range[range.length - 1];
                        if (!target) return;
                        const regulation = ctx.dataVerification!.dataRegulation!;
                        const item = { ...regulation };
                        if (regulation.type === 'dropdown') {
                            item.value1 = getDropdownList(ctx, regulation.value1).join(',');
                        }
                        applyDataVerification(ctx, target, item);
                    }
                });
            } else if (type === 'delete') {
                setContext((ctx) => {
                    const range = getRangeByTxt(ctx, ctx.dataVerification?.dataRegulation?.rangeTxt as string);
                    if (range.length === 0) {
                        showDialog(generalDialog.noSeletionError, 'ok');
                        return;
                    }
                    const currentDataVerification =
                        ctx.sheets[getSheetIndex(ctx, ctx.currentSheetId) as number].dataVerification ?? {};
                    const str = range[range.length - 1]?.row[0];
                    const edr = range[range.length - 1]?.row[1];
                    const stc = range[range.length - 1]?.column[0];
                    const edc = range[range.length - 1]?.column[1];
                    if (str == null || stc == null || edr == null || edc == null) return;
                    for (let r = str; r <= edr; r += 1) {
                        for (let c = stc; c <= edc; c += 1) {
                            delete currentDataVerification[`${r}_${c}`];
                        }
                    }
                });
            }
            hideDialog();
        },
        [hideDialog, setContext, showDialog],
    );

    // Initialize
    // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — initialises the data-verification dialog from current selection + rangeDialog
    useEffect(() => {
        setContext((ctx) => {
            let rangeT = '';

            // If there's a selection, convert it to string form for display
            if (ctx.selections) {
                const range = ctx.selections[ctx.selections.length - 1];
                rangeT = getRangetxt(context, context.currentSheetId, range, context.currentSheetId);
            }

            // Initialize values
            const index = getSheetIndex(ctx, ctx.currentSheetId) as number;
            const ctxDataVerification = ctx.sheets[index].dataVerification ?? {};
            if (!ctx.selections) return;
            const last = ctx.selections[ctx.selections.length - 1];
            const rowIndex = last.row_focus;
            const colIndex = last.column_focus;
            if (rowIndex == null || colIndex == null) return;
            const item = ctxDataVerification[`${rowIndex}_${colIndex}`];
            const defaultItem = item ?? {};
            let rangValue = defaultItem.value1 ?? '';
            // Range assignment related
            if (
                ctx.rangeDialog?.type === 'dropDown' &&
                ctx.dataVerification &&
                ctx.dataVerification.dataRegulation &&
                ctx.dataVerification.dataRegulation.rangeTxt
            ) {
                // When it's a dropdown list selection, assign dropdown selection, keep range unchanged
                rangeT = ctx.dataVerification.dataRegulation.rangeTxt;
                rangValue = ctx.rangeDialog.rangeTxt;
            } else if (
                ctx.rangeDialog?.type === 'rangeTxt' &&
                ctx.dataVerification &&
                ctx.dataVerification.dataRegulation &&
                ctx.dataVerification.dataRegulation.value1
            ) {
                // When it's a range selection, assign range, keep dropdown selection unchanged
                rangValue = ctx.dataVerification.dataRegulation.value1;
                rangeT = ctx.rangeDialog.rangeTxt;
            }
            ctx.rangeDialog!.type = '';

            if (item) {
                ctx.dataVerification!.dataRegulation = {
                    ...item,
                    value1: rangValue,
                    rangeTxt: rangeT,
                    validity: item.validity ?? '',
                    remote: item.remote ?? false,
                    prohibitInput: item.prohibitInput ?? false,
                    hintShow: item.hintShow ?? false,
                    hintValue: item.hintValue ?? '',
                };
            } else {
                ctx.dataVerification!.dataRegulation! = {
                    type: 'dropdown',
                    type2: '',
                    rangeTxt: rangeT,
                    value1: rangValue,
                    value2: '',
                    validity: '',
                    remote: false,
                    prohibitInput: false,
                    hintShow: false,
                    hintValue: '',
                };
            }
        });
    }, []);

    return (
        <div className="flex flex-col gap-4 select-none">
            <DialogHeader>
                <DialogTitle>{toolbar.dataVerification}</DialogTitle>
            </DialogHeader>

            <div className="text-sm space-y-4">
                <div>
                    <div className="text-sm font-medium mb-2">{dataVerification.cellRange}</div>
                    <div className="flex h-8 rounded-md border border-input overflow-hidden">
                        <Input
                            className="flex-1 border-none rounded-none h-full"
                            spellCheck={false}
                            value={context.dataVerification!.dataRegulation?.rangeTxt}
                            onChange={(e) => {
                                const { value } = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.rangeTxt = value;
                                });
                            }}
                        />
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            className="rounded-none"
                            onClick={() => {
                                hideDialog();
                                dataSelectRange('rangeTxt', context.dataVerification!.dataRegulation!.value1);
                            }}
                        >
                            <Table />
                        </Button>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="text-sm font-medium">{dataVerification.verificationCondition}</div>
                    <Select
                        value={context.dataVerification!.dataRegulation!.type}
                        onValueChange={(value) => {
                            setContext((ctx) => {
                                ctx.dataVerification!.dataRegulation!.type = value;
                                if (value === 'dropdown' || value === 'checkbox') {
                                    ctx.dataVerification!.dataRegulation!.type2 = '';
                                } else if (
                                    value === 'number' ||
                                    value === 'number_integer' ||
                                    value === 'number_decimal' ||
                                    value === 'text_length' ||
                                    value === 'date'
                                ) {
                                    ctx.dataVerification!.dataRegulation!.type2 = 'between';
                                } else if (value === 'text_content') {
                                    ctx.dataVerification!.dataRegulation!.type2 = 'include';
                                }
                                // A tick box arrives usable: the same TRUE/FALSE
                                // pair Insert → Tick box writes, so the two
                                // routes to a checkbox rule agree.
                                const isCheckbox = value === 'checkbox';
                                ctx.dataVerification!.dataRegulation!.value1 = isCheckbox ? CHECKBOX_CHECKED_VALUE : '';
                                ctx.dataVerification!.dataRegulation!.value2 = isCheckbox
                                    ? CHECKBOX_UNCHECKED_VALUE
                                    : '';
                            });
                        }}
                    >
                        <SelectTrigger size="sm" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {VERIFICATION_TYPES.map((v) => (
                                <SelectItem value={v} key={v}>
                                    {dataVerification[v]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    {context.dataVerification?.dataRegulation?.type === 'dropdown' && (
                        <div className="space-y-2">
                            <div className="flex h-8 rounded-md border border-input overflow-hidden">
                                <Input
                                    className="flex-1 border-none rounded-none h-full"
                                    spellCheck={false}
                                    value={context.dataVerification!.dataRegulation!.value1}
                                    placeholder={dataVerification.placeholder1}
                                    onChange={(e) => {
                                        const { value } = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    className="rounded-none"
                                    onClick={() =>
                                        dataSelectRange('dropDown', context.dataVerification!.dataRegulation!.value1)
                                    }
                                >
                                    <Table />
                                </Button>
                            </div>
                            <Label className="flex items-center gap-1.5">
                                <Checkbox
                                    checked={context.dataVerification!.dataRegulation!.type2 === 'true'}
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

                    {context.dataVerification?.dataRegulation?.type === 'checkbox' && (
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <span className="text-sm shrink-0">{dataVerification.selected}</span>
                                <Input
                                    className="h-8"
                                    placeholder={dataVerification.placeholder2}
                                    value={context.dataVerification?.dataRegulation?.value1}
                                    onChange={(e) => {
                                        const { value } = e.target;
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
                                        const { value } = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value2 = value;
                                        });
                                    }}
                                />
                            </div>
                        </div>
                    )}

                    {(context.dataVerification?.dataRegulation?.type === 'number' ||
                        context.dataVerification?.dataRegulation?.type === 'number_integer' ||
                        context.dataVerification?.dataRegulation?.type === 'number_decimal' ||
                        context.dataVerification?.dataRegulation?.type === 'text_length') && (
                        <div className="space-y-2">
                            <Select
                                value={context.dataVerification.dataRegulation.type2}
                                onValueChange={(value) => {
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.type2 = value;
                                        ctx.dataVerification!.dataRegulation!.value1 = '';
                                        ctx.dataVerification!.dataRegulation!.value2 = '';
                                    });
                                }}
                            >
                                <SelectTrigger size="sm" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {NUMBER_CONDITIONS.map((v) => (
                                        <SelectItem value={v} key={v}>
                                            {dataVerification[v]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {context.dataVerification.dataRegulation.type2 === 'between' ||
                            context.dataVerification.dataRegulation.type2 === 'notBetween' ? (
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="number"
                                        className="h-8"
                                        placeholder="1"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const { value } = e.target;
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
                                            const { value } = e.target;
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
                                        const { value } = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            )}
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === 'text_content' && (
                        <div className="space-y-2">
                            <Select
                                value={context.dataVerification.dataRegulation.type2}
                                onValueChange={(value) => {
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.type2 = value;
                                        ctx.dataVerification!.dataRegulation!.value1 = '';
                                        ctx.dataVerification!.dataRegulation!.value2 = '';
                                    });
                                }}
                            >
                                <SelectTrigger size="sm" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {TEXT_CONTENT_CONDITIONS.map((v) => (
                                        <SelectItem value={v} key={v}>
                                            {dataVerification[v]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Input
                                className="h-8"
                                placeholder={dataVerification.placeholder4}
                                value={context.dataVerification.dataRegulation.value1}
                                onChange={(e) => {
                                    const { value } = e.target;
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.value1 = value;
                                    });
                                }}
                            />
                        </div>
                    )}

                    {context.dataVerification?.dataRegulation?.type === 'date' && (
                        <div className="space-y-2">
                            <Select
                                value={context.dataVerification.dataRegulation.type2}
                                onValueChange={(value) => {
                                    setContext((ctx) => {
                                        ctx.dataVerification!.dataRegulation!.type2 = value;
                                        ctx.dataVerification!.dataRegulation!.value1 = '';
                                        ctx.dataVerification!.dataRegulation!.value2 = '';
                                    });
                                }}
                            >
                                <SelectTrigger size="sm" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {DATE_CONDITIONS.map((v) => (
                                        <SelectItem value={v} key={v}>
                                            {dataVerification[v]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {context.dataVerification.dataRegulation.type2 === 'between' ||
                            context.dataVerification.dataRegulation.type2 === 'notBetween' ? (
                                <div className="flex items-center gap-2">
                                    <Input
                                        type="date"
                                        className="h-8"
                                        value={context.dataVerification.dataRegulation.value1}
                                        onChange={(e) => {
                                            const { value } = e.target;
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
                                            const { value } = e.target;
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
                                        const { value } = e.target;
                                        setContext((ctx) => {
                                            ctx.dataVerification!.dataRegulation!.value1 = value;
                                        });
                                    }}
                                />
                            )}
                        </div>
                    )}
                </div>

                <div className="space-y-2">
                    {(['prohibitInput', 'hintShow'] as const).map((v) => (
                        <Label className="flex items-center gap-1.5" key={v}>
                            <Checkbox
                                id={v}
                                checked={context.dataVerification!.dataRegulation![v]}
                                onCheckedChange={() => {
                                    setContext((ctx) => {
                                        const dataRegulation = ctx.dataVerification?.dataRegulation;
                                        if (v === 'prohibitInput') {
                                            dataRegulation!.prohibitInput = !dataRegulation!.prohibitInput;
                                        } else if (v === 'hintShow') {
                                            dataRegulation!.hintShow = !dataRegulation!.hintShow;
                                        }
                                    });
                                }}
                            />
                            {dataVerification[v]}
                        </Label>
                    ))}
                    {context.dataVerification?.dataRegulation?.hintShow && (
                        <Input
                            className="h-8"
                            placeholder={dataVerification.placeholder5}
                            value={context.dataVerification!.dataRegulation!.hintValue}
                            onChange={(e) => {
                                const { value } = e.target;
                                setContext((ctx) => {
                                    ctx.dataVerification!.dataRegulation!.hintValue = value;
                                });
                            }}
                        />
                    )}
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
                <Button variant="outline" size="sm" onClick={() => btn('delete')}>
                    {dataVerification.deleteVerification}
                </Button>
                <Button size="sm" onClick={() => btn('confirm')}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}
