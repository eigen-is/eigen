import { getDomain, getServerConfig } from '../config/server-config';
import { getServerSettings } from '../config/server-settings';

export function welcomeMail(name: string, email: string): string | null {
    const settings = getServerSettings();
    if (!settings.onboarding.welcomeMail.enabled) return null;

    const config = getServerConfig();
    const domain = getDomain();
    const orgName = config?.orgName || 'eigen';

    const body = settings.onboarding.welcomeMail.body
        .replace(/\{name\}/g, name)
        .replace(/\{orgName\}/g, orgName)
        .replace(/\{domain\}/g, domain);

    const from = `noreply@${domain}`;
    const date = new Date().toUTCString();

    return `From: ${orgName} <${from}>
To: ${name} <${email}>
Subject: Welcome!
Date: ${date}
Message-ID: <welcome-${Date.now()}@${domain}>
Content-Type: text/plain; charset="utf-8"

${body}
`;
}
