import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import { getDomain, getMailDomain, getOrgName } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { renderEigenEmail } from '../core/mail-template';
import { composeRfc822 } from '../core/mailer';

// Welcome lives in the user's own maildir so it persists in their Inbox — that's why this
// path bypasses sendMail() (which goes over SMTP) and writes RFC822 bytes straight to disk.
// composeRfc822 builds those bytes via nodemailer so we get RFC 2047 header encoding,
// proper multipart boundaries, and per-part Content-Transfer-Encoding for free.
export async function welcomeMail(name: string, email: string): Promise<Buffer | null> {
    const settings = getServerSettings();
    if (!settings.onboarding.welcomeMail.enabled) return null;

    const domain = getDomain();
    const orgName = getOrgName();

    // Body template is HTML — escape token values so a name like `<script>` can't break out
    // of the wrapper. Subject is plain text; no escaping needed there.
    const subject = settings.onboarding.welcomeMail.subject
        .replaceAll('{name}', name)
        .replaceAll('{orgName}', orgName)
        .replaceAll('{domain}', domain);
    const bodyHtml = settings.onboarding.welcomeMail.body
        .replaceAll('{name}', escapeHtml(name))
        .replaceAll('{orgName}', escapeHtml(orgName))
        .replaceAll('{domain}', escapeHtml(domain));

    return composeRfc822({
        from: { name: orgName, address: `noreply@${getMailDomain()}` },
        to: [{ name, address: email }],
        subject,
        text: stripTagsServer(bodyHtml),
        html: renderEigenEmail({ title: subject, bodyHtml, footerLine: orgName }),
    });
}
