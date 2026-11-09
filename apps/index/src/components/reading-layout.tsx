// The grid of a reading page: an optional left gutter, the column and an empty right gutter, centered, with the
// page's vertical padding. The gutter holds a table of contents or a date and goes below 76rem, where the column
// stands alone. Blog posts, the changelog and the Support section and article pages all read in it.

import type { ReactNode } from 'react';

type ReadingLayoutProps = {
    aside?: ReactNode;
    children: ReactNode;
};

export function ReadingLayout({ aside, children }: ReadingLayoutProps) {
    return (
        <div className="site-reading py-12">
            {aside && <aside className="site-reading-aside">{aside}</aside>}
            <div className="site-reading-column min-w-0">{children}</div>
        </div>
    );
}
