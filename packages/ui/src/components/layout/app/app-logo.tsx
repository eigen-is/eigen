import { Link } from '@tanstack/react-router';
import { getSpaceAppUrl } from '@workspace/lib/api';
import { cn } from '../../../lib/utils.ts';
import { Bar } from '../braket/bar.tsx';
import { Ket } from '../braket/ket.tsx';

type AppLogoProps = {
    appName?: string;
    className?: string;
};

export function AppLogo({ appName = 'mail', className }: AppLogoProps) {
    const isSpace = appName.toLowerCase() === 'space';

    return (
        <div className={cn('text-xl flex items-center select-none -mt-1', className)}>
            {isSpace ? (
                <Link to="/" className="text-white font-bold hover:opacity-75 transition-opacity">
                    eigen
                </Link>
            ) : (
                <a href={getSpaceAppUrl()} className="text-white font-bold hover:opacity-75 transition-opacity">
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
