import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@workspace/ui/components/dropdown-menu';
import { cn } from '@workspace/ui/lib/utils';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { locale } from '../../state';
import { DataMenu } from './data-menu';
import { EditMenu } from './edit-menu';
import { FormatMenu } from './format-menu';
import { InsertMenu } from './insert-menu';
import { ViewMenu } from './view-menu';

const triggerClass = cn('px-3 h-8 text-sm rounded-sm', 'hover:bg-muted focus-visible:bg-muted', 'outline-hidden');

export function MenuBar() {
    const { context } = useContext(WorkbookContext);
    const { toolbar } = locale(context);

    return (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background">
            <DropdownMenu>
                <DropdownMenuTrigger className={triggerClass}>
                    {(toolbar as Record<string, string>).edit ?? 'Edit'}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                    <EditMenu />
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger className={triggerClass}>
                    {(toolbar as Record<string, string>).view ?? 'View'}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                    <ViewMenu />
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger className={triggerClass}>
                    {(toolbar as Record<string, string>).insert ?? 'Insert'}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                    <InsertMenu />
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger className={triggerClass}>
                    {(toolbar as Record<string, string>).menuFormat ?? 'Format'}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64 luckysheet-mousedown-cancel">
                    <FormatMenu />
                </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
                <DropdownMenuTrigger className={triggerClass}>
                    {(toolbar as Record<string, string>).data ?? 'Data'}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56 luckysheet-mousedown-cancel">
                    <DataMenu />
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
