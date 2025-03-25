import type { Email, AddressObject } from "./mailtypes";

/**
 * Creates an EML format content from an Email object
 * @param email Email object
 * @returns EML formatted string
 */
export function createELMContent(email: Email): string {
    // Format the date
    const date = email.date ? email.date.toUTCString() : new Date().toUTCString();
    
    // Format the from address
    let fromStr = '';
    if (typeof email.from === 'string') {
        fromStr = email.from;
    } else if (email.from && 'address' in email.from) {
        fromStr = email.from.name 
            ? `${email.from.name} <${email.from.address}>`
            : email.from.address;
    }
    
    // Format the to address(es)
    let toStr = '';
    if (typeof email.to === 'string') {
        toStr = email.to;
    } else if (Array.isArray(email.to)) {
        toStr = email.to.map((to: string | AddressObject) => {
            if (typeof to === 'string') return to;
            return to.name ? `${to.name} <${to.address}>` : to.address;
        }).join(', ');
    } else if (email.to && 'address' in email.to) {
        toStr = email.to.name 
            ? `${email.to.name} <${email.to.address}>`
            : email.to.address;
    }
    
    // Create the email headers
    const headers = [
        `From: ${fromStr}`,
        `To: ${toStr}`,
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