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
