import type { ReactNode } from 'react';
import { UserAvatar } from './user-avatar';

export type UserDetailHeroProps = {
    name: string;
    email?: string;
    imageUrl?: string | null;
    userId?: string;
    subtitle?: ReactNode;
    badges?: ReactNode;
    layout?: 'inline' | 'profile';
};

export function UserDetailHero({
    name,
    email,
    imageUrl,
    userId,
    subtitle,
    badges,
    layout = 'inline',
}: UserDetailHeroProps) {
    if (layout === 'profile') {
        return (
            <div className="flex flex-col items-center gap-4 w-50">
                <div className="h-40 w-40">
                    <UserAvatar
                        name={name}
                        email={email}
                        imageUrl={imageUrl ?? undefined}
                        userId={userId}
                        className="h-full w-full"
                    />
                </div>
                <div className="text-center">
                    <h2 className="text-2xl font-medium">{name}</h2>
                    {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
                </div>
                {badges && <div className="flex flex-wrap gap-2 justify-center">{badges}</div>}
            </div>
        );
    }

    return (
        <div className="flex items-start gap-4">
            <UserAvatar name={name} email={email} imageUrl={imageUrl ?? undefined} userId={userId} size="lg" />
            <div className="min-w-0 flex-1">
                <h2 className="text-xl font-medium truncate">{name}</h2>
                {subtitle && <p className="text-muted-foreground truncate">{subtitle}</p>}
            </div>
        </div>
    );
}
