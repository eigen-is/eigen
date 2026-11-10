// The frame of every page on the public site, between the top bar and the screen's bottom: one scrolling column
// with the footer after the content, so a short page's footer rests at the bottom. A Support page passes its
// section's color, which washes the rows and marks the table of contents inside it; the top bar sits outside.

import { Column, ColumnLayout } from '@workspace/ui';
import type { ReactNode } from 'react';
import { SiteFooter } from './site-footer';

type SitePageProps = {
    // A CSS color such as `var(--app-sheets-color)`.
    color?: string;
    children: ReactNode;
};

export function SitePage({ color, children }: SitePageProps) {
    const style = color
        ? {
              '--app-current-color': color,
              '--app-current-color-soft': `color-mix(in oklab, ${color} 14%, var(--background))`,
          }
        : undefined;

    return (
        <ColumnLayout>
            <Column id="site" width="flex">
                <div className="h-full overflow-y-auto scroll-smooth">
                    <div className="flex min-h-full flex-col">
                        <div className="flex flex-1 flex-col" style={style}>
                            {children}
                        </div>
                        <SiteFooter />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
