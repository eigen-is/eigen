import { useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';
import { publicKeys } from '../../public/hooks/keys';

// The name rides out on the public config, which every app reads.
export function useUpdateOrgName() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (name: string) => {
            const res = await settingsApi.organization.put({ name });
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: publicKeys.config });
            toast.success('Organization name saved');
        },
        onError: onMutationError,
    });
}
