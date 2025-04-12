import { useQuery } from "@tanstack/react-query";
import { api } from "@workspace/lib/api";

// Define query keys for reuse
export const docsKeys = {
  all: ['docs'] as const,
  access: () => [...docsKeys.all, 'access'] as const,
  document: (ownerId: string, pathId: string) => 
    [...docsKeys.access(), ownerId, pathId] as const,
};

/**
 * Hook to check if user has access to a document
 * Returns canRead and canWrite permissions
 */
export function useDocumentAccess(ownerId: string, pathId: string | undefined) {
  return useQuery({
    queryKey: docsKeys.document(ownerId, pathId || ''),
    queryFn: async () => {
      if (!pathId) return { canRead: false, canWrite: false };
      
      const response = await api.collab.access[ownerId][pathId].get();
      
      if (response.error) {
        console.error('Error fetching document access:', response.error);
        return { canRead: false, canWrite: false };
      }
      
      return response.data || { canRead: false, canWrite: false };
    },
    enabled: !!ownerId && !!pathId,
    staleTime: 60 * 1000, // Cache for 1 minute
  });
}
