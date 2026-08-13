import { Link } from '@tanstack/react-router';
import { getDriveAppUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { cn } from '../../../lib/utils.ts';
import { Bar } from '../../braket/bar.tsx';
import { Ket } from '../../braket/ket.tsx';

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
            <span style={{ color: 'var(--topbar-bracket)' }}>
                <Bar />
                <a href={`/${app}`} className="hover:opacity-75 transition-opacity">
                    {app}
                </a>
                <Ket />
            </span>
        </div>
    );
}
