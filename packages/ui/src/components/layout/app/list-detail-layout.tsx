// The page of a list whose items open a detail, such as the contacts, users and teams pages. With
// nothing selected the list fills the page. Selecting an item opens its detail beside a narrower list,
// and on a desktop the Close button this page adds to the detail's toolbar goes back. On a phone the
// detail replaces the list, with a back arrow to it. The page passes `detail` only while its URL names
// a selection.

import { cn } from '@workspace/ui/lib/utils';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { TooltipButton } from '../toolbar/tooltip-button';
import { Column, ColumnLayout } from './column-layout';
import { useLayout } from './layout-context';

type ListDetailLayoutProps = {
    listToolbar: ReactNode;
    children: ReactNode;
    detail?: ReactNode;
    detailToolbar?: ReactNode;
    onBackToList: () => void;
};

export function ListDetailLayout({
    listToolbar,
    children,
    detail,
    detailToolbar,
    onBackToList,
}: ListDetailLayoutProps) {
    const { isMobile } = useLayout();
    const open = !!detail;
    return (
        <ColumnLayout mobileColumn={open ? 'detail' : 'list'}>
            <Column id="list" width={open ? '350px' : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                <div className={cn('flex h-full flex-col overflow-y-auto', open && 'border-r')}>{children}</div>
            </Column>
            {open && (
                <Column
                    id="detail"
                    width="flex"
                    onBack={onBackToList}
                    toolbar={
                        <div className="flex w-full items-center justify-end gap-1">
                            {detailToolbar}
                            {!isMobile && (
                                <TooltipButton
                                    icon={X}
                                    tooltipText="Close"
                                    className="shrink-0"
                                    onClick={onBackToList}
                                />
                            )}
                        </div>
                    }
                >
                    {detail}
                </Column>
            )}
        </ColumnLayout>
    );
}
