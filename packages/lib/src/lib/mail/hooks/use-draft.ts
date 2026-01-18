import {useMutation} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api';
import {EmailDraft} from '@workspace/lib/types/mail';

export type EmailRecipient = {
    name?: string;
    address: string;
};

export type CreateDraftParams = {
    subject?: string;
    text?: string;
    to?: EmailRecipient[];
    cc?: EmailRecipient[];
    bcc?: EmailRecipient[];
};

export function createDraftEmail(params: CreateDraftParams): EmailDraft {
    // Create a properly formatted email object
    const emailDraft: Partial<EmailDraft> = {
        id: undefined, // Will be set by the server
        subject: params.subject || '',
        text: params.text || '',
        // Format recipients in the structure expected by the API
        from: undefined, // Will be set by the server
        to: params.to?.length ? {
            value: params.to.map(recipient => ({
                name: recipient.name || recipient.address,
                address: recipient.address
            })),
            html: params.to.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', '),
            text: params.to.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', ')
        } : undefined,
        cc: params.cc?.length ? {
            value: params.cc.map(recipient => ({
                name: recipient.name || recipient.address,
                address: recipient.address
            })),
            html: params.cc.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', '),
            text: params.cc.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', ')
        } : undefined,
        bcc: params.bcc?.length ? {
            value: params.bcc.map(recipient => ({
                name: recipient.name || recipient.address,
                address: recipient.address
            })),
            html: params.bcc.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', '),
            text: params.bcc.map(r => r.name ? `${r.name} <${r.address}>` : r.address).join(', ')
        } : undefined,
        isDraft: true,
        mailbox: 'Drafts'
    };

    return emailDraft as EmailDraft;
}

/**
 * Updates an existing email draft
 * @param draft The draft email to update
 * @returns Promise with the updated draft or null if failed
 */
export async function updateDraftEmail(draft: EmailDraft): Promise<EmailDraft | null> {
    try {
        // Send the update to the server
        const response = await mailApi.message.draft.put({
            mail: draft
        });

        return response.data || null;
    } catch (error) {
        console.error('Error updating draft:', error);
        return null;
    }
}

/**
 * Sends an email draft
 * @param draft The draft email to send
 * @returns Promise with the sent email ID or null if failed
 */
export async function sendDraftEmail(draft: EmailDraft): Promise<EmailDraft | null> {
    try {
        // Send the email
        console.log(draft);
        const response = await mailApi.message.send.post({
            mail: draft
        });

        return response.data || null;
    } catch (error) {
        console.error('Error sending draft:', error);
        return null;
    }
}

export function useUpdateDraft() {
    return useMutation({
        mutationFn: updateDraftEmail,
    });
}

export function useSendDraft() {
    return useMutation({
        mutationFn: sendDraftEmail,
    });
}
