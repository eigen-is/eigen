import type {Email, EmailAddress} from "./mailtypes";

/**
 * Creates an EML format content from an Email object
 * @param email Email object
 * @returns EML formatted string
 */
export function createELMContent(email: Email): string {
    // Format the date
    const date = email.date ? email.date.toUTCString() : new Date().toUTCString();

    const formatAdresses = (field: { value: EmailAddress[] }) => {
        if (field.value && Array.isArray(field.value)) {
            return field.value.map(addr => {
                if (addr.name && addr.address) {
                    return `${addr.name.trim()} <${addr.address.trim()}>`;
                } else if (addr.address) {
                    return addr.address;
                } else if (addr.name) {
                    return addr.name;
                }
                return '';
            }).join(', ');
        }
        return '';
    };

    // Format the from address
    const fromStr = email.from && email.from.value && Array.isArray(email.from.value) ? formatAdresses(email.from) : '';
    const toStr = email.to && !Array.isArray(email.to) && email.to.value && Array.isArray(email.to.value) ? formatAdresses(email.to) : '';
    const ccStr = email.cc && !Array.isArray(email.cc) && email.cc.value && Array.isArray(email.cc.value) ? formatAdresses(email.cc) : '';
    const bccStr = email.bcc && !Array.isArray(email.bcc) && email.bcc.value && Array.isArray(email.bcc.value) ? formatAdresses(email.bcc) : '';

    // Create the email headers
    const headers = [
        `From: ${fromStr}`,
        `To: ${toStr}`,
        `CC: ${ccStr}`,
        `BCC: ${bccStr}`,
        `Subject: ${email.subject || ''}`,
        `Date: ${date}`,
        `Message-ID: <${email.id}@eigen.local>`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="boundary-string"`
    ];

    // Create the email body
    const body = [
        ``,
        `--boundary-string`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        email.text || '',
        ``,
        `--boundary-string`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        email.html || '',
        ``,
        `--boundary-string--`
    ];

    // Combine headers and body
    return [...headers, ...body].join('\r\n');
}