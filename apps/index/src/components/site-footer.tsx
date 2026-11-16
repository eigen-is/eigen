// The one-line footer under every page of the public site: the build's version on the left, linking to the
// changelog, and the site's other pages and links on the right. SitePage draws it, so no page adds its own.

import { Link } from '@tanstack/react-router';
import { usePublicConfig } from '@workspace/lib/public';
import { VersionLabel } from '@workspace/ui/components/layout/app';
import { cn } from '@workspace/ui/lib/utils';

const LINK = 'hover:text-foreground';

export function SiteFooter() {
    const { data: config } = usePublicConfig();

    return (
        <footer className="app-gutter-x flex min-h-10 shrink-0 flex-wrap items-center gap-x-8 gap-y-1 py-2 text-xs text-muted-foreground">
            {config && (
                <Link to="/changelog" className={cn('tabular-nums', LINK)}>
                    <VersionLabel />
                </Link>
            )}
            <nav className="ml-auto flex flex-wrap gap-x-5 gap-y-1">
                <Link to="/support" className={LINK}>
                    Support
                </Link>
                <Link to="/blog" className={LINK}>
                    Blog
                </Link>
                <Link to="/changelog" className={LINK}>
                    Changelog
                </Link>
                <a href="https://github.com/eigen-is/eigen" target="_blank" rel="noreferrer" className={LINK}>
                    GitHub
                </a>
                <a href="https://github.com/sponsors/eigen-is" target="_blank" rel="noreferrer" className={LINK}>
                    Sponsor
                </a>
                <Link to="/licenses" className={LINK}>
                    Licenses
                </Link>
            </nav>
        </footer>
    );
}
