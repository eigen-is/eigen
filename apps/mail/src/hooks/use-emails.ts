import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {mailApi} from '@workspace/lib/api.ts';
import {Email} from '@/types/email';
import {findCorrectMailboxPath, mailboxKeys, useMailboxes} from './use-mailboxes';

// Define query keys for reuse
export const emailKeys = {
    all: ['emails'] as const,
    lists: () => [...emailKeys.all, 'list'] as const,
    list: (mailbox: string) => [...emailKeys.lists(), {mailbox}] as const,
    details: () => [...emailKeys.all, 'detail'] as const,
    detail: (id: string) => [...emailKeys.details(), id] as const,
};

// Transform API email data to match our UI expectations
const transformEmailData = (email: any): Email => {
    console.log("Raw email data:", JSON.stringify(email, null, 2));

    // Create default from and to objects with text property
    const defaultFrom = {name: 'Unknown', email: 'unknown@example.com', text: 'Unknown'};
    const defaultTo = {name: 'Unknown', email: 'unknown@example.com', text: 'Unknown'};

    // Process from field - handle both string and object formats
    let fromField;
    if (typeof email.from === 'string') {
        fromField = {name: email.from, email: email.from, text: email.from};
    } else if (email.from && typeof email.from === 'object') {
        // Handle the case where from is an object with value array (from screenshot)
        if (Array.isArray(email.from.value) && email.from.value.length > 0) {
            const firstFrom = email.from.value[0];
            fromField = {
                name: firstFrom.name || firstFrom.address || 'Unknown',
                email: firstFrom.address || 'unknown@example.com',
                text: firstFrom.name ? `${firstFrom.name} <${firstFrom.address}>` : (firstFrom.address || 'Unknown')
            };
        }
        // Handle the case where from is an object with address and name properties
        else if (email.from.address) {
            fromField = {
                name: email.from.name || email.from.address,
                email: email.from.address,
                text: email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address
            };
        } else {
            fromField = {
                name: email.from.name || 'Unknown',
                email: email.from.email || 'unknown@example.com',
                text: email.from.text || email.from.name || email.from.email || 'Unknown'
            };
        }
    } else {
        fromField = defaultFrom;
    }

    // Process to field - handle both string and object formats
    let toField;
    if (typeof email.to === 'string') {
        toField = {name: email.to, email: email.to, text: email.to};
    } else if (email.to && typeof email.to === 'object') {
        // Handle the case where to is an array of objects
        if (Array.isArray(email.to)) {
            const firstTo = email.to[0] || {};
            toField = {
                name: firstTo.name || firstTo.address || 'Unknown',
                email: firstTo.address || 'unknown@example.com',
                text: firstTo.name ? `${firstTo.name} <${firstTo.address}>` : (firstTo.address || 'Unknown')
            };
        }
        // Handle the case where to is an object with value array (from screenshot)
        else if (email.to.value && Array.isArray(email.to.value) && email.to.value.length > 0) {
            const firstTo = email.to.value[0];
            toField = {
                name: firstTo.name || firstTo.address || 'Unknown',
                email: firstTo.address || 'unknown@example.com',
                text: firstTo.name ? `${firstTo.name} <${firstTo.address}>` : (firstTo.address || 'Unknown')
            };
        } else if (email.to.address) {
            toField = {
                name: email.to.name || email.to.address,
                email: email.to.address,
                text: email.to.name ? `${email.to.name} <${email.to.address}>` : email.to.address
            };
        } else {
            toField = {
                name: email.to.name || 'Unknown',
                email: email.to.email || 'unknown@example.com',
                text: email.to.text || email.to.name || email.to.email || 'Unknown'
            };
        }
    } else {
        toField = defaultTo;
    }

    // Create a transformed email object with default values
    const transformedEmail: Email = {
        id: email.id || email._filename || '',
        read: email.isRead || email.read || false,
        isRead: email.isRead || email.read || false,
        seen: email.isRead || email.read || false,
        starred: email.flags?.includes('\\Flagged') || false,
        flagged: email.flags?.includes('\\Flagged') || false,
        from: fromField,
        to: toField,
        subject: email.subject || email.headerLines?.find((h: any) => h.key === 'subject')?.value || '(No subject)',
        preview: email.preview || email.text?.substring(0, 100) || '',
        text: email.text || email.html || '',
        html: email.html || '',
        hasAttachment: !!email.attachments?.length,
        attachments: email.attachments || [],
        date: email.date || new Date().toISOString(),
        important: email.flags?.includes('\\Important') || false,
        flags: email.flags || [],
        // Keep original properties for reference
        ...email
    };

    console.log("Transformed email:", JSON.stringify(transformedEmail, null, 2));
    return transformedEmail;
};

// Hook to fetch emails for a specific mailbox
export function useEmails(mailboxPath: string) {
    // Get the list of mailboxes to find the correct case-sensitive path
    const {data: mailboxes = []} = useMailboxes();

    // Find the correct case-sensitive mailbox path
    const correctPath = findCorrectMailboxPath(mailboxes, mailboxPath);

    // Use the correct path if found, otherwise use the original path
    const finalMailboxPath = correctPath || mailboxPath;

    return useQuery({
        queryKey: emailKeys.list(finalMailboxPath),
        queryFn: async () => {
            console.log(`Fetching emails for mailbox: ${finalMailboxPath}`);
            // @ts-ignore
            const response = await mailApi.mailbox[finalMailboxPath].get();
            console.log(finalMailboxPath, response);
            return response.data || [];
        }
    });
}

// Hook to fetch a specific email by ID
export function useEmail(messageId: string) {
    return useQuery({
        queryKey: emailKeys.detail(messageId),
        queryFn: async () => {
            try {
                if (!messageId) {
                    console.log('No messageId provided to useEmail');
                    return null;
                }

                console.log(`Fetching email with ID: ${messageId}`);

                // @ts-ignore - Dynamic property access
                const response = await mailApi.message[messageId].get();
                console.log(`Full email response:`, response);

                // Transform the email data for detail view
                const transformedEmail = transformEmailData(response.data);
                console.log(`Transformed email for detail view:`, transformedEmail);

                return transformedEmail;
            } catch (error) {
                console.error(`Error fetching email ${messageId}:`, error);
                throw error;
            }
        },
        enabled: !!messageId,
        staleTime: 60000, // 1 minute
        refetchOnWindowFocus: false,
    });
}

// Hook to mark an email as read/unread
export function useSetEmailReadStatus() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
                               messageId,
                               isRead,
                           }: {
            messageId: string;
            isRead: boolean;
        }) => {
            try {
                // @ts-ignore - Dynamic property access
                const response = await mailApi.message[messageId].read.post({
                    isRead,
                });
                return response.data;
            } catch (error) {
                console.error(`Error marking email ${messageId} as ${isRead ? 'read' : 'unread'}:`, error);
                throw error;
            }
        },
        onSuccess: (data, variables) => {
            // Invalidate the specific email query
            queryClient.invalidateQueries({
                queryKey: emailKeys.detail(variables.messageId),
            });

            // Invalidate all email lists to refresh counts
            queryClient.invalidateQueries({
                queryKey: emailKeys.lists(),
            });

            // Invalidate mailbox queries to refresh unread counts
            queryClient.invalidateQueries({
                queryKey: mailboxKeys.all,
            });
        },
    });
}

// Hook to delete an email
export function useDeleteEmail() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({messageId}: { messageId: string }) => {
            try {
                // @ts-ignore - Dynamic property access
                const response = await mailApi.message[messageId].delete();
                return response.data;
            } catch (error) {
                console.error(`Error deleting email ${messageId}:`, error);
                throw error;
            }
        },
        onSuccess: (data, variables) => {
            // Invalidate all email lists to refresh
            queryClient.invalidateQueries({
                queryKey: emailKeys.lists(),
            });

            // Invalidate mailbox queries to refresh counts
            queryClient.invalidateQueries({
                queryKey: mailboxKeys.all,
            });
        },
    });
}

// Hook to move an email to another mailbox
export function useMoveEmail() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({
                               messageId,
                               targetMailbox,
                           }: {
            messageId: string;
            targetMailbox: string;
        }) => {
            try {
                // @ts-ignore - Dynamic property access
                const response = await mailApi.message[messageId].move.post({
                    destination: targetMailbox,
                });
                return response.data;
            } catch (error) {
                console.error(`Error moving email ${messageId} to ${targetMailbox}:`, error);
                throw error;
            }
        },
        onSuccess: (data, variables) => {
            // Invalidate all email lists to refresh
            queryClient.invalidateQueries({
                queryKey: emailKeys.lists(),
            });

            // Invalidate mailbox queries to refresh counts
            queryClient.invalidateQueries({
                queryKey: mailboxKeys.all,
            });
        },
    });
}
