// A settings page, such as Space's Personal info or Admin's Server settings: one column with the page's title in its
// toolbar and its sections below, scrolling inside a readable width. On a phone its back arrow opens the sidebar. An
// app's settings routes render their page inside it.

import type { ReactNode } from 'react';
import { ToolbarTitle } from '../toolbar/toolbar-title';
import { Column, ColumnLayout } from './column-layout';

type SettingsPageProps = {
    title: string;
    children: ReactNode;
};

export function SettingsPage({ title, children }: SettingsPageProps) {
    return (
        <ColumnLayout>
            <Column id="detail" width="flex" onBack="sidebar" toolbar={<ToolbarTitle>{title}</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl app-gutter">{children}</div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
