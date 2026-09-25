import { useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { toast } from 'sonner';
import { invalidateAdminTeams, invalidateAdminUsers } from '../../admin';
import { AppError, onMutationError } from '../../api-error';
import { invalidateMyTeams } from '../../home';
import { publicKeys } from '../../public/hooks/keys';

// The name rides out on the public config, which every app reads; the default team is renamed with it.
export function useUpdateOrgName(organizationId?: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (name: string) => {
            const res = await settingsApi.organization.put({ name });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            toast.success('Organization name saved');
            invalidateAdminTeams(queryClient, organizationId ?? '');
            invalidateMyTeams(queryClient);
            invalidateAdminUsers(queryClient);
            return queryClient.invalidateQueries({ queryKey: publicKeys.config });
        },
        onError: onMutationError,
    });
}
