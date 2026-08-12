import { getMailComposeUrl } from '@workspace/lib/api';

// Shared by UserName and UserItem: an email that, in `mailLink` mode, links to the mail composer.
// Internal to those two — not a public primitive, so it stays out of the barrel.
export function MailComposeLink({ email, mailLink }: { email: string; mailLink: boolean }) {
    if (!mailLink) return <>{email}</>;
    return (
        <a className="hover:underline" href={getMailComposeUrl(email)}>
            {email}
        </a>
    );
}
