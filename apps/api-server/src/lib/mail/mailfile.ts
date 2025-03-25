import type { Email } from "./mailtypes";

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
    if (email.from) {
        // Use the text representation which is already formatted
        fromStr = email.from.text;
    }
    
    // Format the to address(es)
    let toStr = '';
    if (email.to) {
        if (Array.isArray(email.to)) {
            // If it's an array of address objects, join their text representations
            toStr = email.to.map(to => to.text).join(', ');
        } else {
            // Single address object
            toStr = email.to.text;
        }
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