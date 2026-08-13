import { useAuth } from '@workspace/lib/auth';
import { useUploadContactAvatar } from '@workspace/lib/contacts';
import { useUpload } from './upload-provider/upload-provider';

// Bridges the lib avatar mutation to the upload chip: one chip per file, completed on success,
// marked failed on the single rejection (the mutation already toasts the actionable error).
// Guards on the signed-in user so a missing id never builds a malformed upload URL.
export function useContactAvatarUpload(onUploaded: (url: string) => void) {
    const { user } = useAuth();
    const upload = useUpload();
    const { mutateAsync } = useUploadContactAvatar();

    return async (file: File) => {
        if (!user) return;
        const handler = upload.createUpload(file.name);
        try {
            const url = await mutateAsync(file);
            handler.complete();
            onUploaded(url);
        } catch {
            handler.error();
        }
    };
}
