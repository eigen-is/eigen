import { randomUUID } from 'node:crypto';
import { escapeHtml, stripTagsServer } from '@workspace/lib/html';
import { getDomain, getMailDomain, getOrgName } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { renderEigenEmail } from '../core/mail-template';

// Welcome lives in the user's own maildir so it persists in their Inbox — that's why this
// path bypasses sendMail() and writes a raw RFC822 message directly. The body is built with
// renderEigenEmail so the branded shell matches every other Eigen email.
export function welcomeMail(name: string, email: string): string | null {
    const settings = getServerSettings();
    if (!settings.onboarding.welcomeMail.enabled) return null;

    const domain = getDomain();
    const mailDomain = getMailDomain();
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

    const html = renderEigenEmail({ title: subject, bodyHtml, footerLine: orgName });
    const text = stripTagsServer(bodyHtml);

    const from = `noreply@${mailDomain}`;
    const date = new Date().toUTCString();
    const boundary = `eigen-${randomUUID()}`;

    return `From: ${orgName} <${from}>
To: ${name} <${email}>
Subject: ${subject}
Date: ${date}
Message-ID: <welcome-${Date.now()}@${mailDomain}>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="${boundary}"

--${boundary}
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

${text}

--${boundary}
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 8bit

${html}

--${boundary}--
`;
}
