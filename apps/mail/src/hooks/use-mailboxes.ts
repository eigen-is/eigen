import { useQuery } from '@tanstack/react-query';
import { mailApi } from '@workspace/lib/api.ts';

// Define query keys for reuse
export const mailboxKeys = {
  all: ['mailboxes'] as const,
  lists: () => [...mailboxKeys.all, 'list'] as const,
  list: (filters: Record<string, any>) => [...mailboxKeys.lists(), { filters }] as const,
  details: () => [...mailboxKeys.all, 'detail'] as const,
  detail: (id: string) => [...mailboxKeys.details(), id] as const,
  exists: (id: string) => [...mailboxKeys.detail(id), 'exists'] as const,
};

export interface Mailbox {
  path: string;
  name: string;
  flags: string[];
  total: number;
  unread: number;
  subscribed: boolean;
  children?: Mailbox[];
}

/**
 * Helper function to find the correct case-sensitive mailbox path
 * from a list of mailboxes using a case-insensitive comparison
 * 
 * @param mailboxes List of mailboxes from the API
 * @param searchPath The mailbox path to search for (case-insensitive)
 * @returns The correct case-sensitive mailbox path, or null if not found
 */
export function findCorrectMailboxPath(mailboxes: Mailbox[], searchPath: string): string | null {
  if (!searchPath || !mailboxes || !mailboxes.length) {
    return null;
  }
  
  // Normalize the search path to lowercase for case-insensitive comparison
  const normalizedSearchPath = searchPath.toLowerCase();
  
  // Find the mailbox with a matching path (case-insensitive)
  const matchedMailbox = mailboxes.find(mailbox => 
    mailbox.path.toLowerCase() === normalizedSearchPath
  );
  
  // Return the correct case-sensitive path if found, otherwise null
  return matchedMailbox ? matchedMailbox.path : null;
}

/**
 * Helper function to check if a mailbox exists in the list (case-insensitive)
 * 
 * @param mailboxes List of mailboxes from the API
 * @param searchPath The mailbox path to search for (case-insensitive)
 * @returns True if the mailbox exists, false otherwise
 */
export function mailboxExistsInList(mailboxes: Mailbox[], searchPath: string): boolean {
  return !!findCorrectMailboxPath(mailboxes, searchPath);
}

/**
 * Hook to fetch all mailboxes
 */
export function useMailboxes() {
  return useQuery({
    queryKey: mailboxKeys.lists(),
    queryFn: async () => {
      try {
        const response = await mailApi.mailboxes.get();
        return response.data || [];
      } catch (error) {
        console.error('Error fetching mailboxes:', error);
        return [];
      }
    },
    staleTime: 60000, // 1 minute
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Hook to check if a mailbox exists
 * 
 * @param mailboxPath The mailbox path to check (case-insensitive)
 * @returns Query result with exists property indicating if the mailbox exists
 */
export function useMailboxExists(mailboxPath: string) {
  // Get the list of mailboxes
  const { data: mailboxes = [] } = useMailboxes();
  
  // Return a query that checks if the mailbox exists in the list
  return useQuery({
    queryKey: mailboxKeys.exists(mailboxPath),
    queryFn: async () => {
      // First check if the mailbox exists in our cached list (case-insensitive)
      if (mailboxExistsInList(mailboxes, mailboxPath)) {
        return { exists: true, path: findCorrectMailboxPath(mailboxes, mailboxPath) };
      }
      
      // If not found in the cached list, try to fetch it directly
      // This is a fallback in case our mailbox list is stale
      try {
        // Use a type-safe approach to access the mailbox API
        const fetchMailbox = async (path: string) => {
          // Using any here to bypass TypeScript's index signature check
          // This is safe because we know the API structure
          return await (mailApi as any).mailbox[path].get();
        };
        
        await fetchMailbox(mailboxPath);
        return { exists: true, path: mailboxPath };
      } catch (error) {
        console.error(`Error checking if mailbox ${mailboxPath} exists:`, error);
        return { exists: false, path: null };
      }
    },
    enabled: !!mailboxPath,
    staleTime: 60000, // 1 minute
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * Hook to get a specific mailbox
 * 
 * @param mailboxPath The mailbox path to fetch
 * @returns Query result with the mailbox data
 */
export function useMailbox(mailboxPath: string) {
  return useQuery({
    queryKey: mailboxKeys.detail(mailboxPath),
    queryFn: async () => {
      try {
        // Use a type-safe approach to access the mailbox API
        const fetchMailbox = async (path: string) => {
          // Using any here to bypass TypeScript's index signature check
          // This is safe because we know the API structure
          return await (mailApi as any).mailbox[path].get();
        };
        
        const response = await fetchMailbox(mailboxPath);
        return response.data;
      } catch (error) {
        console.error(`Error fetching mailbox ${mailboxPath}:`, error);
        return null;
      }
    },
    enabled: !!mailboxPath,
    staleTime: 60000, // 1 minute
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
