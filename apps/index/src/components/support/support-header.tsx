import { Link } from '@tanstack/react-router';
import { getSpaceAppUrl } from '@workspace/lib/api';
import { Button } from '@workspace/ui/components/button';
import { SearchTrigger } from './support-search';

// The help center's own public header — no app topbar (no avatar / app switcher).
export function SupportHeader() {
    return (
        <header className="bg-app text-white shrink-0">
            <div className="flex h-12 items-center px-4 gap-4">
                <Link to="/support" className="font-semibold">
                    eigen · Help Center
                </Link>
                <SearchTrigger className="flex items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm text-white/80 hover:bg-white/20" />
                <div className="flex-1" />
                <Button asChild variant="ghost" size="sm" className="text-white hover:bg-primary/20 hover:text-white">
                    <a href={getSpaceAppUrl()}>Sign in</a>
                </Button>
            </div>
        </header>
    );
}
