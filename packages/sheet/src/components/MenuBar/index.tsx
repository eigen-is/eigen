import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { DataMenu } from './data-menu';
import { EditMenu } from './edit-menu';
import { FormatMenu } from './format-menu';
import { FormatToolbar } from './format-toolbar';
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
export function MenuBar({ leftItems, rightItems }: Props) {
    return (
        <div
            className="grid items-center gap-1 app-gutter-x h-12 border-b border-border bg-background"
            style={{ gridTemplateColumns: '1fr auto 1fr' }}
        >
            <div className="flex items-center gap-1">
                {leftItems}
                <DropdownMenu>
                    <DropdownMenuTrigger className={triggerClass}>Edit</DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                        <EditMenu />
                    </DropdownMenuContent>
                </DropdownMenu>

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
            </div>

            <div className="flex justify-center">
                <FormatToolbar />
            </div>

            <div className="flex items-center justify-end gap-1">{rightItems}</div>
        </div>
    );
}
