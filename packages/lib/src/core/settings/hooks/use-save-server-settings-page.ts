// The one Save of the admin's Server settings page, whose drafts span three routes: the organization's name, the
// default S3 storage and the server settings. It writes the parts that changed one after another and refreshes what
// each write changed as it lands, so a refused write stops the rest and a retry sends only what is still a draft. The
// page stays where it is, but a save of many sections shows nowhere at once, so one toast says it saved.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@workspace/lib/api';
import type { S3Config } from '@workspace/lib/types/mount';
import type { ServerSettings } from '@workspace/lib/types/settings';
import type { DeepPartial } from '@workspace/lib/types/util';
import { toast } from 'sonner';
import { invalidateAdminTeams, invalidateAdminUsers } from '../../admin';
import { AppError, onMutationError } from '../../api-error';
import { invalidateMyTeams } from '../../home';
import { publicKeys } from '../../public/hooks/keys';
import { invalidateServerS3Config, invalidateServerSettings } from './keys';

type ServerSettingsPageSave = {
    orgName?: string;
    s3Config?: S3Config;
    settings?: DeepPartial<ServerSettings>;
};

export function useSaveServerSettingsPage(organizationId?: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ orgName, s3Config, settings }: ServerSettingsPageSave) => {
            if (orgName !== undefined) {
                const res = await settingsApi.organization.put({ name: orgName });
                if (res.error) throw new AppError(res);
                // The name rides out on the public config, which every app reads; the default team is renamed with it.
                // The page shows the config's name once its draft clears, so the save waits for the refetch.
                invalidateAdminTeams(queryClient, organizationId ?? '');
                invalidateMyTeams(queryClient);
                invalidateAdminUsers(queryClient);
                await queryClient.invalidateQueries({ queryKey: publicKeys.config });
            }
            if (s3Config) {
                const res = await settingsApi.s3config.put(s3Config);
                if (res.error) throw new AppError(res);
                invalidateServerS3Config(queryClient);
            }
            if (!settings) return null;
            const res = await settingsApi.server.put(settings);
            if (res.error) throw new AppError(res);
            invalidateServerSettings(queryClient);
            return res.data;
        },
        onSuccess: () => toast.success('Settings saved'),
        onError: onMutationError,
    });
}
