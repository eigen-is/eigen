import { getMailComposeUrl } from '@workspace/lib/api';
import { useResolvedUser } from '@workspace/lib/public';
import type { HTMLAttributes, ReactNode } from 'react';

export type UserNameProps = HTMLAttributes<HTMLDivElement> & {
    name?: string;
    email?: string;
    userId?: string;
    label?: ReactNode;
    className?: string;
    mailLink?: boolean;
};

export function UserName({ name, email, userId, label, className, mailLink = false, ...props }: UserNameProps) {
    const { displayName, resolvedEmail, isLoading } = useResolvedUser({ userId, email, name });

    if (isLoading) return <span />;

    return (
        <span className={className} {...props}>
            {displayName}
            {resolvedEmail && (resolvedEmail !== displayName || mailLink) && (
                <>
                    {' '}
                    (
                    {mailLink ? (
                        <a className="hover:underline" href={getMailComposeUrl(resolvedEmail)}>
                            {resolvedEmail}
                        </a>
                    ) : (
                        resolvedEmail
                    )}
                    )
                </>
            )}
        </span>
    );
}
