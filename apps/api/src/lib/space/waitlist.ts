import nodemailer from 'nodemailer';
import {validateEmailAddress} from '@workspace/lib/validation';
import {getDomain} from '../config/server-config';

export async function waitlist(email: string, notes: string) {
    // use nodemailer to send a notification email
    const transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail'
    });

    // sanitize email
    email = email.trim().toLowerCase();
    // validate email
    if (!validateEmailAddress(email)) {
        return false;
    }
    // make sure no xss
    notes = notes.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    try {
        // Send mail with defined transport object
        const info = await transporter.sendMail({
            from: `noreply-signup@${getDomain()}`,
            // TODO: make recipient configurable via server settings
            to: 'reinder@infi.nl',
            subject: 'New Eigen Waitlist Signup',
            text: `New waitlist signup:
            
Email: <${email}>
Notes: ${notes}

Time: ${new Date().toISOString()}`,
            html: `<h2>New Waitlist Signup</h2>
<p><strong>Email:</strong> ${email}</p>
<p><strong>Notes:</strong> ${notes}</p>
<p><strong>Time:</strong> ${new Date().toISOString()}</p>`,
        });

        console.log('Message sent: %s', info.messageId);
        return true;
    } catch (error) {
        console.error('Error sending email:', error);
        return false;
    }
}