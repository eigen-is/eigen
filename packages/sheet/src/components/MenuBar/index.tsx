import { useMediaQuery } from '@workspace/lib/media';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import { useFindBarRefocus } from '@workspace/ui/components/layout/search/find-in-document-button';
import { cn } from '@workspace/ui/lib/utils';
import { type ReactNode, useContext } from 'react';
import { WorkbookContext } from '../../context';
import { DataMenu } from './data-menu';
import { EditMenu } from './edit-menu';
import { FormatMenu } from './format-menu';
import { FormatToolbar, formatToolbarQuery } from './format-toolbar';
import { InsertMenu } from './insert-menu';
import { ViewMenu } from './view-menu';

type Props = {
    leftItems?: ReactNode;
    rightItems?: ReactNode;
};

const triggerClass = cn('px-3 h-8 text-sm rounded-sm', 'hover:bg-muted focus-visible:bg-muted', 'outline-hidden');

// 1fr·auto·1fr grid: the equal side columns keep the center column at the bar's true
// center, so FormatToolbar sits dead-center regardless of the menu / right-icon widths.
// The center slot is always rendered so the columns stay put when the toolbar hides.
// Below FormatToolbar's own seam nothing needs centering, so the side columns give way:
// the menu row scrolls in the leftover space and the right icons keep their width on-screen.
export function MenuBar({ leftItems, rightItems }: Props) {
    const { context } = useContext(WorkbookContext);
    const { focusFindBarRef, onCloseAutoFocus } = useFindBarRefocus();
    const centered = useMediaQuery(formatToolbarQuery);
    return (
        <div
            className="grid items-center gap-1 app-gutter-x h-12 border-b border-border bg-background"
            style={{ gridTemplateColumns: centered ? '1fr auto 1fr' : 'minmax(0, 1fr) auto auto' }}
        >
            <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
                {leftItems}
                <DropdownMenu>
                    <DropdownMenuTrigger className={triggerClass}>Edit</DropdownMenuTrigger>
                    <DropdownMenuContent
                        align="start"
                        className="w-56 luckysheet-mousedown-cancel"
                        onCloseAutoFocus={onCloseAutoFocus}
                    >
                        <EditMenu focusFindBarRef={focusFindBarRef} />
                    </DropdownMenuContent>
                </DropdownMenu>

                {/* View / Insert / Format / Data are wholly mutating — hidden for viewers, like
                    FormatToolbar. Edit stays (Copy / Find gate per-item); comment viewing stays
                    reachable via the cell context menu. */}
                {context.allowEdit && (
                    <>
                        <DropdownMenu>
                            <DropdownMenuTrigger className={triggerClass}>View</DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                                <ViewMenu />
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger className={triggerClass}>Insert</DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                                <InsertMenu />
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger className={triggerClass}>Format</DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-64 luckysheet-mousedown-cancel">
                                <FormatMenu />
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger className={triggerClass}>Data</DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                                <DataMenu />
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                )}
            </div>

            <div className="flex justify-center">
                <FormatToolbar />
            </div>

            <div className="flex items-center justify-self-end gap-1">{rightItems}</div>
        </div>
    );
}
