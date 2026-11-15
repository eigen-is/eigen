// The grid of a reading page: an optional left gutter, the column and an empty right gutter, centered, with the
// page's vertical padding. The gutter holds what sits beside the column, such as a table of contents, stacked and stuck
// at the top of the page's padding while the page scrolls. It goes below 76rem, where the column stands alone. Blog
// posts, the changelog and Support articles read in it, for example.

import type { ReactNode } from 'react';

type ReadingLayoutProps = {
    aside?: ReactNode;
    children: ReactNode;
};

export function ReadingLayout({ aside, children }: ReadingLayoutProps) {
    return (
        <div className="site-reading py-12">
            {aside && (
                <aside className="site-reading-aside">
                    <div className="sticky top-12 flex max-h-[calc(100dvh-8rem)] flex-col gap-4">{aside}</div>
                </aside>
            )}
            <div className="site-reading-column min-w-0">{children}</div>
        </div>
    );
}
