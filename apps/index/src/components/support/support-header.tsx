import { Link } from '@tanstack/react-router';
import { getSpaceAppUrl } from '@workspace/lib/api';
import { Button } from '@workspace/ui/components/button';
import { SearchTrigger } from './support-search';

// The help center's own public header — no app topbar (no avatar / app switcher).
export function SupportHeader() {
    return (
        <header className="bg-primary text-primary-foreground shrink-0">
            <div className="flex h-12 items-center px-4 gap-4">
                <Link to="/support" className="font-semibold">
                    eigen · Help Center
                </Link>
                <SearchTrigger className="flex items-center gap-2 rounded-md bg-primary-foreground/10 px-3 py-1.5 text-sm text-primary-foreground/80 hover:bg-primary-foreground/20" />
                <div className="flex-1" />
                <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
                >
                    <a href={getSpaceAppUrl()}>Sign in</a>
                </Button>
            </div>
        </header>
    );
}
