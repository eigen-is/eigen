// The wordmark in the top bar: "eigen" in the text color, then the app's name between a bar and a ket, such as
// "eigen|mail⟩". With an empty app name it is the bare "eigen", as on the public landing page.

import { Link } from '@tanstack/react-router';
import { getDriveAppUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { cn } from '../../../lib/utils';
import { Bar } from '../../braket/bar';
import { Ket } from '../../braket/ket';

type AppLogoProps = {
    appName?: string;
    className?: string;
    logoHref?: string;
};

export function AppLogo({ appName = 'mail', className, logoHref }: AppLogoProps) {
    const { isAuthenticated } = useAuth();
    const isGuest = useIsGuest();
    const app = appName.toLowerCase();
    const isSpace = app === 'space';
    // "eigen" links to: the public landing page when signed out, Drive for guests
    // (no Space access), or the user's Space. undefined → <Link to="/"> (app root).
    const defaultHref = !isAuthenticated || isSpace ? undefined : isGuest ? getDriveAppUrl() : getSpaceAppUrl();
    const href = logoHref ?? defaultHref;

    return (
        <div className={cn('text-xl flex items-center select-none whitespace-nowrap', className)}>
            {isSpace || href === undefined ? (
                <Link to="/" className="text-[var(--topbar-fg)] font-medium hover:opacity-75 transition-opacity">
                    eigen
                </Link>
            ) : (
                <a href={href} className="text-[var(--topbar-fg)] font-medium hover:opacity-75 transition-opacity">
                    eigen
                </a>
            )}
            {app && (
                <span style={{ color: 'var(--topbar-bracket)' }}>
                    <Bar />
                    <a href={`/${app}`} className="hover:opacity-75 transition-opacity">
                        {app}
                    </a>
                    <Ket />
                </span>
            )}
        </div>
    );
}
