import { Link } from '@tanstack/react-router';
import { getDriveAppUrl, getSpaceAppUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import { cn } from '../../../lib/utils.ts';
import { Bar } from '../braket/bar.tsx';
import { Ket } from '../braket/ket.tsx';

type AppLogoProps = {
    appName?: string;
    className?: string;
    logoHref?: string;
};

export function AppLogo({ appName = 'mail', className, logoHref }: AppLogoProps) {
    const { user } = useAuth();
    const isSpace = appName.toLowerCase() === 'space';
    // Guests can't access the Space app — link them to Drive instead
    const defaultHref = user?.role === 'guest' ? getDriveAppUrl() : isSpace ? undefined : getSpaceAppUrl();
    const href = logoHref ?? defaultHref;

    return (
        <div className={cn('text-xl flex items-center select-none -mt-1', className)}>
            {isSpace || href === undefined ? (
                <Link to="/" className="text-white font-bold hover:opacity-75 transition-opacity">
                    eigen
                </Link>
            ) : (
                <a href={href} className="text-white font-bold hover:opacity-75 transition-opacity">
                    eigen
                </a>
            )}
            <span className="text-white">
                <Bar />
                <Link to="/" className="hover:opacity-75 transition-opacity">
                    {appName.toLowerCase()}
                </Link>
                <Ket />
            </span>
        </div>
    );
}
