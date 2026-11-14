// The frame of every page on the public site, between the top bar and the screen's bottom: one scrolling column
// with the footer after the content, so a short page's footer rests at the bottom. A Support page passes its
// section's color, which washes the rows and marks the table of contents inside it, and a page with a trail passes
// it as the toolbar, the bar the apps keep their location in. The top bar sits outside.

import { Column, ColumnLayout } from '@workspace/ui/components/layout/app';
import type { ReactNode } from 'react';
import { SiteFooter } from './site-footer';

type SitePageProps = {
    // A CSS color such as `var(--app-sheets-color)`.
    color?: string;
    // What the column's toolbar shows, such as a breadcrumb.
    toolbar?: ReactNode;
    children: ReactNode;
};

export function SitePage({ color, toolbar, children }: SitePageProps) {
    const style = color
        ? {
              '--app-current-color': color,
              '--app-current-color-soft': `color-mix(in oklab, ${color} 14%, var(--background))`,
          }
        : undefined;

    return (
        <ColumnLayout>
            <Column
                id="site"
                width="flex"
                toolbar={
                    // The toolbar pads with the gutter already, so the grid cancels it to line up with the page below.
                    toolbar && (
                        <div className="site-reading -mx-(--app-gutter-x) flex-1">
                            <div className="col-span-full min-w-0">{toolbar}</div>
                        </div>
                    )
                }
            >
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
