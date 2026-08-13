import { useResolvedUser } from '@workspace/lib/public';
import type { HTMLAttributes, ReactNode } from 'react';
import { MailComposeLink } from './mail-compose-link';

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
                    (<MailComposeLink email={resolvedEmail} mailLink={mailLink} />)
                </>
            )}
        </span>
    );
}
