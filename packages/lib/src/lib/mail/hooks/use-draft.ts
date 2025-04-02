import {useMutation, useQueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api';
import {Email} from '@apps/api-server/types/mail';
import { emailKeys } from './use-emails';

// Define interface for recipient
export interface EmailRecipient {
    name?: string;
    address: string;
}

// Interface for draft creation parameters
export interface CreateDraftParams {
    subject?: string;
    text?: string;
    to?: EmailRecipient[];
    cc?: EmailRecipient[];
    bcc?: EmailRecipient[];
}

/**
 * Creates an email draft with the specified parameters
 * @param params Draft creation parameters
 * @returns Promise with the created draft email ID
 */
export async function createDraftEmail(params: CreateDraftParams): Promise<string> {
    // Create a properly formatted email object
    const emailDraft: Partial<Email> = {
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

    // Send the draft to the server
    const response = await mailApi.message.draft.post({
        mail: emailDraft
    });

    // Return the ID of the created draft
    return response.data?.id || '';
}

/**
 * Hook for creating email drafts
 * @returns Mutation function and status for creating drafts
 */
export function useCreateDraft() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: createDraftEmail,
        onSuccess: () => {
            // Invalidate relevant queries to refresh the drafts list
            queryClient.invalidateQueries({queryKey: emailKeys.list('drafts')});
        }
    });
}
