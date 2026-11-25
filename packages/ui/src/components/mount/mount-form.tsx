// The fields of a Drive mount's dialog: its name, its storage type and its maximum size, with the S3 fields when a
// bucket is picked. It renders inside a FormDialog, such as the admin's Add mount and Edit mount, and mounts with it,
// so each opening starts from the saved or default values. A missing name, a size below the minimum or a missing S3
// field shows under its field once Save was pressed; otherwise the submit hands the values on and the dialog waits.

import { isStorageType, STORAGE_TYPE_HINTS, STORAGE_TYPE_LABELS } from '@workspace/lib/constants/mount';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import type { MountStorageType, S3Config } from '@workspace/lib/types/mount';
import { EMPTY_S3, isS3ConfigValid, mountStorageIdentity } from '@workspace/lib/types/mount';
import type { S3CheckResult, S3HardenResult } from '@workspace/lib/types/settings';
import { useId, useState } from 'react';
import { Field, FieldDescription, FieldError, FieldLabel } from '../field';
import { FormDialogForm } from '../form-dialog';
import { useFormSubmitted } from '../form-shell';
import { Input } from '../input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';
import { S3ConfigCard } from './s3-config-card';

export type MountFormValues = {
    name: string;
    storageType: MountStorageType;
    maxSizeMB: number;
    s3Config?: S3Config;
};

type MountFormProps = {
    defaultStorageType?: MountStorageType;
    defaultMaxSizeMB?: number;
    defaultS3Config?: S3Config;
    initialValues?: Partial<MountFormValues>;
    onSubmit: (values: MountFormValues) => Promise<void>;
    onS3Check: (config: S3Config) => Promise<S3CheckResult>;
    onS3Harden: (config: S3Config, noncurrentDays: number) => Promise<S3HardenResult>;
    submitLabel: string;
    isEdit?: boolean;
};

export function MountForm({
    defaultStorageType = 'local',
    defaultMaxSizeMB = 500,
    defaultS3Config,
    initialValues,
    onSubmit,
    onS3Check,
    onS3Harden,
    submitLabel,
    isEdit = false,
}: MountFormProps) {
    const [initial] = useState(
        (): MountDraft => ({
            name: initialValues?.name ?? '',
            storageType: initialValues?.storageType ?? defaultStorageType,
            size: String(initialValues?.maxSizeMB ?? defaultMaxSizeMB),
            s3Config: initialValues?.s3Config ?? defaultS3Config ?? EMPTY_S3,
        }),
    );
    const [draft, setDraft] = useState(initial);
    const isS3 = draft.storageType === 's3';

    return (
        <FormDialogForm
            changed={
                draft.name !== initial.name ||
                draft.size !== initial.size ||
                mountStorageIdentity(draft) !== mountStorageIdentity(initial)
            }
            submitLabel={submitLabel}
            onSubmit={() => {
                const { name, storageType, size, s3Config } = draft;
                if (!name.trim() || !sizeFits(size) || (isS3 && !isS3ConfigValid(s3Config))) return false;
                return onSubmit({
                    name: name.trim(),
                    storageType,
                    maxSizeMB: Number(size),
                    s3Config: isS3 ? s3Config : undefined,
                });
            }}
        >
            <MountFields
                draft={draft}
                onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                onS3Check={onS3Check}
                onS3Harden={onS3Harden}
                isEdit={isEdit}
            />
        </FormDialogForm>
    );
}

// What the fields hold while they are edited: the size as typed, so a value below the minimum stays to be corrected.
type MountDraft = { name: string; storageType: MountStorageType; size: string; s3Config: S3Config };

const sizeFits = (size: string) => Number(size) >= QUOTA_MIN_MB;

// Inside the form, so it reads whether its Save was pressed and a missing name or a small size says so.
function MountFields({
    draft,
    onChange,
    onS3Check,
    onS3Harden,
    isEdit,
}: {
    draft: MountDraft;
    onChange: (patch: Partial<MountDraft>) => void;
    onS3Check: MountFormProps['onS3Check'];
    onS3Harden: MountFormProps['onS3Harden'];
    isEdit: boolean;
}) {
    const id = useId();
    const submitted = useFormSubmitted();
    const nameMissing = submitted && !draft.name.trim();
    const sizeRefused = submitted && !sizeFits(draft.size);

    return (
        <>
            <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                    id={`${id}-name`}
                    value={draft.name}
                    onChange={(e) => onChange({ name: e.target.value })}
                    placeholder="e.g. shared files"
                    aria-invalid={nameMissing || undefined}
                    aria-describedby={nameMissing ? `${id}-name-error` : undefined}
                />
                {nameMissing && <FieldError id={`${id}-name-error`}>Add a name</FieldError>}
            </Field>

            <Field>
                <FieldLabel htmlFor={`${id}-type`}>Storage type</FieldLabel>
                <Select
                    value={draft.storageType}
                    onValueChange={(value) => isStorageType(value) && onChange({ storageType: value })}
                    disabled={isEdit}
                >
                    <SelectTrigger id={`${id}-type`}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {Object.entries(STORAGE_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <FieldDescription>{STORAGE_TYPE_HINTS[draft.storageType]}</FieldDescription>
            </Field>

            <Field>
                <FieldLabel htmlFor={`${id}-size`}>Max size (MB)</FieldLabel>
                <Input
                    id={`${id}-size`}
                    type="number"
                    min={QUOTA_MIN_MB}
                    value={draft.size}
                    onChange={(e) => onChange({ size: e.target.value })}
                    aria-invalid={sizeRefused || undefined}
                    aria-describedby={sizeRefused ? `${id}-size-error` : undefined}
                />
                {sizeRefused && <FieldError id={`${id}-size-error`}>Use at least {QUOTA_MIN_MB} MB</FieldError>}
            </Field>

            {draft.storageType === 's3' && (
                <S3ConfigCard
                    value={draft.s3Config}
                    onChange={(s3Config) => onChange({ s3Config })}
                    onCheck={onS3Check}
                    onHarden={onS3Harden}
                    isEdit={isEdit}
                />
            )}
        </>
    );
}
