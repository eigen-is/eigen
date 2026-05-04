import { randomUUID } from 'node:crypto';
import { escapeHtml } from '@workspace/lib/html';
import { getDomain, getMailDomain, getServerConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';
import { composeWelcomeEmail } from '../core/mail-composers';

// Welcome lives in the user's own maildir so it persists in their Inbox — that's why this
// path bypasses sendMail() and writes a raw RFC822 message directly. Body comes from
// composeWelcomeEmail so the branded shell matches every other Eigen email.
export function welcomeMail(name: string, email: string): string | null {
    const settings = getServerSettings();
    if (!settings.onboarding.welcomeMail.enabled) return null;

    const config = getServerConfig();
    const domain = getDomain();
    const mailDomain = getMailDomain();
    const orgName = config?.orgName || 'Eigen';

    // Body template is HTML — escape token values so a name like `<script>` can't break out
    // of the wrapper. Subject is plain text; no escaping needed there.
    const subject = applyTokens(settings.onboarding.welcomeMail.subject, { name, orgName, domain });
    const bodyHtml = applyTokens(settings.onboarding.welcomeMail.body, {
        name: escapeHtml(name),
        orgName: escapeHtml(orgName),
        domain: escapeHtml(domain),
    });

    const mail = composeWelcomeEmail({
        recipient: { name, email },
        subject,
        bodyHtml,
        orgName,
    });

    const from = `noreply@${mailDomain}`;
    const date = new Date().toUTCString();
    const boundary = `eigen-${randomUUID()}`;

    return `From: ${orgName} <${from}>
To: ${name} <${email}>
Subject: ${mail.subject}
Date: ${date}
Message-ID: <welcome-${Date.now()}@${mailDomain}>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="${boundary}"

--${boundary}
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: 8bit

${mail.text}

--${boundary}
Content-Type: text/html; charset="utf-8"
Content-Transfer-Encoding: 8bit

${mail.html ?? ''}

--${boundary}--
`;
}

function applyTokens(template: string, values: Record<string, string>): string {
    let out = template;
    for (const [key, val] of Object.entries(values)) {
        out = out.replaceAll(`{${key}}`, val);
    }
    return out;
}
