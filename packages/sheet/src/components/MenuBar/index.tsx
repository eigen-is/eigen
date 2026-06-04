import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { DataMenu } from './data-menu';
import { EditMenu } from './edit-menu';
import { FormatMenu } from './format-menu';
import { InsertMenu } from './insert-menu';
import { ViewMenu } from './view-menu';

type Props = {
    leftItems?: ReactNode;
    rightItems?: ReactNode;
};

const triggerClass = cn('px-3 h-8 text-sm rounded-sm', 'hover:bg-muted focus-visible:bg-muted', 'outline-hidden');

export function MenuBar({ leftItems, rightItems }: Props) {
    return (
        <div className="flex items-center gap-1 px-4 h-12 border-b border-border bg-background">
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
            {rightItems && <div className="ml-auto flex items-center gap-1">{rightItems}</div>}
        </div>
    );
}
