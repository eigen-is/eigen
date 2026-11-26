// The page of a list whose items open a detail, such as the contacts, users and teams pages. With nothing selected
// the list fills the page. Selecting an item opens its detail beside a narrower list, as a detail column, whose X, Esc
// and phone back close it. On a phone the detail replaces the list. The page passes `detail` only while its URL names
// a selection, and opens and closes it through useDetailHistory, so back after a close never reopens the item.

import type { ReactNode } from 'react';
import { Column, ColumnLayout } from './column-layout';
import { DetailColumn } from './detail-column';

type ListDetailLayoutProps = {
    listToolbar: ReactNode;
    children: ReactNode;
    detail?: ReactNode;
    // The detail's actions, at the right of its bar before the X.
    detailToolbar?: ReactNode;
    onClose: () => void;
    // The detail fills the column's body and scrolls itself, such as Mail's reader and composer.
    fillDetail?: boolean;
};

export function ListDetailLayout({
    listToolbar,
    children,
    detail,
    detailToolbar,
    onClose,
    fillDetail,
}: ListDetailLayoutProps) {
    const open = !!detail;
    return (
        <ColumnLayout mobileColumn={open ? 'detail' : 'list'}>
            <Column id="list" width={open ? 'large' : 'flex'} onBack="sidebar" toolbar={listToolbar}>
                <div className="flex h-full flex-col overflow-y-auto">{children}</div>
            </Column>
            {open && (
                <DetailColumn width="flex" actions={detailToolbar} onClose={onClose} fill={fillDetail}>
                    {detail}
                </DetailColumn>
            )}
        </ColumnLayout>
    );
}
