import { useMutation } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import { toast } from 'sonner';
import { AppError, onMutationError } from '../../api-error';

export function useSendTestMail() {
    return useMutation({
        mutationFn: async () => {
            const res = await settingsApi.mail.test.post();
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onSuccess: ({ to }) => {
            toast.success(`Test mail sent to ${to}`);
        },
        onError: onMutationError,
    });
}
