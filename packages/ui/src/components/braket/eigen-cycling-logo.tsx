import { apps, isMailApp } from '@workspace/lib/apps';
import { useMailEnabled } from '@workspace/lib/public';
import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Bar } from './bar';
import { Ket } from './ket';

type EigenCyclingLogoProps = {
    className?: string;
};

const CYCLE_MS = 2000;

// Animated "eigen|app>" wordmark that cycles through every enabled app. Matches the
// topbar AppLogo color split: "eigen" in the foreground, the bra-ket and app
// name in the app's own color. Size and spacing come from `className`.
export function EigenCyclingLogo({ className }: EigenCyclingLogoProps) {
    const mailEnabled = useMailEnabled();
    const shown = apps.filter((app) => mailEnabled || !isMailApp(app));
    const [appIndex, setAppIndex] = useState(0);
    const app = shown[appIndex % shown.length];

    useEffect(() => {
        const interval = setInterval(() => {
            setAppIndex((prev) => prev + 1);
        }, CYCLE_MS);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className={cn('select-none', className)}>
            <span className="text-foreground font-medium">eigen</span>
            <span className="font-normal" style={{ color: app.color }}>
                <Bar />
                {app.name.toLowerCase()}
                <Ket />
            </span>
        </div>
    );
}
