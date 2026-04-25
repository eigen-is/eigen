import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Copy, Grid3x3, Pencil, Unlink, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import {
    getRangetxt,
    goToLink,
    isLinkValid,
    type LinkCardProps,
    locale,
    normalizeSelection,
    onRangeSelectionModalMoveStart,
    removeHyperlink,
    replaceHtml,
    saveHyperlink,
} from '../../state';

const modalBase =
    'absolute overflow-hidden bg-popover z-[300] rounded-md border border-border shadow-md px-5 pt-1.5 pb-2.5';
const titleClass = 'inline-block h-4 w-[74px] py-[7px] mr-1.5 text-xs leading-4 text-foreground';
const inputWidth = 'w-[232px] h-[26px] text-xs';

export function LinkEditCard({
    r,
    c,
    rc,
    originText,
    originType,
    originAddress,
    isEditing,
    position,
    selectingCellRange,
}: LinkCardProps) {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const [linkText, setLinkText] = useState<string>(originText);
    const [linkAddress, setLinkAddress] = useState<string>(originAddress);
    const [linkType, setLinkType] = useState<string>(originType);
    const { insertLink, linkTypeList, button } = locale(context);
    const lastCell = useRef(normalizeSelection(context, [{ row: [r, r], column: [c, c] }]));
    const skipCellRangeSet = useRef(true);
    const isLinkAddressValid = isLinkValid(context, linkType, linkAddress);
    const invalidBorder = linkAddress && !isLinkAddressValid.isValid && 'border-destructive';

    const tooltip = <div className="h-[17px] my-[3px] text-xs text-destructive">{isLinkAddressValid.tooltip}</div>;

    const hideLinkCard = useCallback(() => {
        if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
        setContext((draftCtx) => {
            draftCtx.linkCard = undefined;
        });
    }, [refs.globalCache, setContext]);

    const setRangeModalVisible = useCallback(
        (visible: boolean) =>
            setContext((draftCtx) => {
                draftCtx.luckysheet_select_save! = lastCell.current!;
                if (draftCtx.linkCard != null) draftCtx.linkCard.selectingCellRange = visible;
            }),
        [setContext],
    );

    const containerEvent = useMemo(
        () => ({
            onMouseEnter: () => {
                if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = true;
            },
            onMouseLeave: () => {
                if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
            },
            onMouseDown: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onMouseMove: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onMouseUp: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => e.stopPropagation(),
            onDoubleClick: (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => e.stopPropagation(),
        }),
        [refs.globalCache],
    );

    const renderBottomButton = useCallback(
        (onOk: () => void, onCancel: () => void) => (
            <div className="flex gap-3.5">
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
                <Button size="sm" onClick={onOk}>
                    {button.confirm}
                </Button>
            </div>
        ),
        [button],
    );

    const renderToolbarButton = useCallback(
        (Icon: LucideIcon, onClick: () => void) => (
            <button type="button" className="p-1.5 cursor-pointer hover:bg-accent" onClick={onClick}>
                <Icon width={18} height={18} aria-hidden="true" />
            </button>
        ),
        [],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: `rc` is the trigger — when the active cell changes, reset the form even if the cell's stored link is identical
    useLayoutEffect(() => {
        setLinkAddress(originAddress);
        setLinkText(originText);
        setLinkType(originType);
    }, [rc, originAddress, originText, originType]);

    useLayoutEffect(() => {
        if (selectingCellRange) {
            skipCellRangeSet.current = true;
        }
    }, [selectingCellRange]);

    useLayoutEffect(() => {
        if (skipCellRangeSet.current) {
            skipCellRangeSet.current = false;
            return;
        }
        if (selectingCellRange) {
            const len = context.luckysheet_select_save?.length ?? 0;
            if (len > 0) {
                setLinkAddress(
                    getRangetxt(context, context.currentSheetId, context.luckysheet_select_save![len - 1], ''),
                );
            }
        }
    }, [context, selectingCellRange]);

    if (!isEditing) {
        return (
            <div
                {...containerEvent}
                onKeyDown={(e) => {
                    e.stopPropagation();
                }}
                className={cn(modalBase, 'flex flex-row items-center py-0.5 pl-4 pr-2')}
                style={{ left: position.cellLeft + 20, top: position.cellBottom }}
            >
                <button
                    type="button"
                    className="mr-1.5 cursor-pointer hover:text-primary"
                    onClick={() => {
                        setContext((draftCtx) =>
                            goToLink(
                                draftCtx,
                                r,
                                c,
                                linkType,
                                linkAddress,
                                refs.scrollbarX.current!,
                                refs.scrollbarY.current!,
                            ),
                        );
                    }}
                >
                    {linkType === 'webpage' ? insertLink.openLink : replaceHtml(insertLink.goTo, { linkAddress })}
                </button>
                {context.allowEdit === true && <div className="w-px h-4 mx-1.5 bg-border shrink-0" />}
                {context.allowEdit === true &&
                    linkType === 'webpage' &&
                    renderToolbarButton(Copy, () => {
                        navigator.clipboard.writeText(originAddress);
                        hideLinkCard();
                    })}
                {context.allowEdit === true &&
                    renderToolbarButton(Pencil, () =>
                        setContext((draftCtx) => {
                            if (draftCtx.linkCard != null && draftCtx.allowEdit) {
                                draftCtx.linkCard.isEditing = true;
                            }
                        }),
                    )}
                {context.allowEdit === true && <div className="w-px h-4 mx-1.5 bg-border shrink-0" />}
                {context.allowEdit === true &&
                    renderToolbarButton(Unlink, () =>
                        setContext((draftCtx) => {
                            if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
                            removeHyperlink(draftCtx, r, c);
                        }),
                    )}
            </div>
        );
    }

    return selectingCellRange ? (
        <div
            className={cn(modalBase, 'fortune-link-modify-modal range-selection-modal w-[380px] p-[22px] select-auto')}
            style={{ left: position.cellLeft, top: position.cellBottom + 5 }}
            {...Object.fromEntries(
                Object.entries(containerEvent).filter(
                    ([k]) => !['onMouseDown', 'onMouseMove', 'onMouseUp'].includes(k),
                ),
            )}
            onMouseDown={(e) => {
                const { nativeEvent } = e;
                onRangeSelectionModalMoveStart(context, refs.globalCache, nativeEvent);
                e.stopPropagation();
            }}
        >
            <button
                type="button"
                className="absolute right-[22px] top-[22px] cursor-pointer"
                onClick={() => setRangeModalVisible(false)}
            >
                <X aria-hidden="true" />
            </button>
            <div className="mb-3 text-base font-medium leading-6 text-foreground">{insertLink.selectCellRange}</div>
            <Input
                {...containerEvent}
                className={cn('h-8 w-full', invalidBorder)}
                placeholder={insertLink.cellRangePlaceholder}
                onChange={(e) => setLinkAddress(e.target.value)}
                value={linkAddress}
            />
            {tooltip}
            <div className="flex justify-end">
                {renderBottomButton(
                    () => {
                        if (isLinkAddressValid.isValid) setRangeModalVisible(false);
                    },
                    () => {
                        setLinkAddress(originAddress);
                        setRangeModalVisible(false);
                    },
                )}
            </div>
        </div>
    ) : (
        <div
            className={modalBase}
            style={{
                left: position.cellLeft + 20,
                top: position.cellBottom,
            }}
            {...containerEvent}
        >
            <div className="pt-2.5">
                <div className={titleClass}>{insertLink.linkText}</div>
                <Input
                    className={inputWidth}
                    spellCheck="false"
                    autoFocus
                    value={linkText}
                    onChange={(e) => setLinkText(e.target.value)}
                />
            </div>
            <div className="pt-2.5">
                <div className={titleClass}>{insertLink.linkType}</div>
                <Select
                    value={linkType}
                    onValueChange={(value) => {
                        if (value === 'sheet') {
                            if (!linkText) {
                                setLinkText(context.luckysheetfile[0].name);
                            }
                            setLinkAddress(context.luckysheetfile[0].name);
                        } else {
                            setLinkAddress('');
                        }
                        if (value === 'cellrange') setRangeModalVisible(true);
                        setLinkType(value);
                    }}
                >
                    <SelectTrigger size="sm" className="w-[232px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {linkTypeList.map((type) => (
                            <SelectItem key={type.value} value={type.value}>
                                {type.text}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <div className="pt-2.5">
                {linkType === 'webpage' && (
                    <>
                        <div className={titleClass}>{insertLink.linkAddress}</div>
                        <Input
                            className={cn(inputWidth, invalidBorder)}
                            spellCheck="false"
                            value={linkAddress}
                            onChange={(e) => setLinkAddress(e.target.value)}
                        />
                        {tooltip}
                    </>
                )}
                {linkType === 'cellrange' && (
                    <>
                        <div className={titleClass}>{insertLink.linkCell}</div>
                        <Input
                            className={cn(inputWidth, invalidBorder)}
                            spellCheck="false"
                            value={linkAddress}
                            onChange={(e) => setLinkAddress(e.target.value)}
                        />
                        <button
                            type="button"
                            className="absolute right-6 inline-block w-5 p-1 cursor-pointer"
                            onClick={() => setRangeModalVisible(true)}
                        >
                            <Grid3x3 aria-hidden="true" />
                        </button>
                        {tooltip}
                    </>
                )}
                {linkType === 'sheet' && (
                    <>
                        <div className={titleClass}>{insertLink.linkSheet}</div>
                        <Select
                            value={linkAddress}
                            onValueChange={(value) => {
                                if (!linkText) setLinkText(value);
                                setLinkAddress(value);
                            }}
                        >
                            <SelectTrigger size="sm" className="w-[232px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {context.luckysheetfile.map((sheet) => (
                                    <SelectItem key={sheet.id} value={sheet.name}>
                                        {sheet.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {tooltip}
                    </>
                )}
            </div>
            <div className="flex justify-end pb-1">
                {renderBottomButton(() => {
                    if (!isLinkAddressValid.isValid) return;
                    if (refs.globalCache.linkCard) refs.globalCache.linkCard.mouseEnter = false;
                    setContext((draftCtx) => saveHyperlink(draftCtx, r, c, linkText, linkType, linkAddress));
                }, hideLinkCard)}
            </div>
        </div>
    );
}
