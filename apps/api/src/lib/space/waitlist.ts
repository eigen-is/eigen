import {validateEmailAddress} from '@workspace/lib/validation';
import {sendMail} from '../core/mailer';

export async function waitlist(email: string, notes: string) {
    email = email.trim().toLowerCase();
    if (!validateEmailAddress(email)) return false;

    // Sanitize against XSS
    notes = notes.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const time = new Date().toISOString();

    // TODO: make recipient configurable via server settings
    return sendMail({
        to: [{name: '', address: 'reinder@infi.nl'}],
        subject: 'New Eigen Waitlist Signup',
        text: `New waitlist signup:\n\nEmail: <${email}>\nNotes: ${notes}\n\nTime: ${time}`,
        html: `<h2>New Waitlist Signup</h2>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Notes:</strong> ${notes}</p>
<p><strong>Time:</strong> ${time}</p>`,
    });
}
