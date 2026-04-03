import { validateEmailAddress } from '@workspace/lib/validation';
import { getServerSettings } from '../config/server-settings';
import { sendMail } from '../core/mailer';

export async function waitlist(email: string, notes: string) {
    email = email.trim().toLowerCase();
    if (!validateEmailAddress(email)) return false;

    // Sanitize against XSS
    notes = notes.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const time = new Date().toISOString();

    const settings = getServerSettings();
    const notifyEmail = settings.onboarding.waitlist.notifyEmail;
    if (!notifyEmail) return false;

    return sendMail({
        to: [{ name: '', address: notifyEmail }],
        subject: 'New Eigen Waitlist Signup',
        text: `New waitlist signup:\n\nEmail: <${email}>\nNotes: ${notes}\n\nTime: ${time}`,
        html: `<h2>New Waitlist Signup</h2>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Notes:</strong> ${notes}</p>
<p><strong>Time:</strong> ${time}</p>`,
    });
}
