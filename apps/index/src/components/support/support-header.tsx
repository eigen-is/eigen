import { Link } from '@tanstack/react-router';
import { getSpaceAppUrl } from '@workspace/lib/api';
import { Button } from '@workspace/ui/components/button';

// The help center's own public header — no app topbar (no avatar / app switcher).
export function SupportHeader() {
    return (
        <header className="bg-app text-white shrink-0">
            <div className="flex h-12 items-center px-4 gap-3">
                <Link to="/support" className="font-semibold">
                    eigen · Help Center
                </Link>
                <div className="flex-1" />
                <Button asChild variant="ghost" size="sm" className="text-white hover:bg-primary/20 hover:text-white">
                    <a href={getSpaceAppUrl()}>Sign in</a>
                </Button>
            </div>
        </header>
    );
}
