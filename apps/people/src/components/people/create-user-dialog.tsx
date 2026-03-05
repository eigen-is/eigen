import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Button} from '@workspace/ui/components/button';
import {Input} from '@workspace/ui/components/input';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {InputGroup, InputGroupAddon, InputGroupInput, InputGroupText} from '@workspace/ui/components/input-group';
import {Field, FieldContent, FieldGroup, FieldLabel} from '@workspace/ui/components/field';
import {useCreateUser} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {toast} from 'sonner';

interface CreateUserDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    organizationId?: string;
}

export function CreateUserDialog({open, onOpenChange}: CreateUserDialogProps) {
    const [name, setName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState('member');
    const createUser = useCreateUser();
    const {data: config} = usePublicConfig();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const email = username.toLowerCase().split('@')[0] + '@' + (config?.domain ?? 'eigen.is');
        if (!name || !username || !password) return;

        try {
            await createUser.mutateAsync({name, email, password, role});
            toast.success(`User ${name} created`);
            onOpenChange(false);
            setName('');
            setUsername('');
            setPassword('');
            setRole('member');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to create user');
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Create User</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit}>
                    <FieldGroup>
                        <Field>
                            <FieldLabel htmlFor="name">Name</FieldLabel>
                            <FieldContent>
                                <Input id="name" value={name} onChange={e => setName(e.target.value)} required/>
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="username">Username</FieldLabel>
                            <FieldContent>
                                <InputGroup>
                                    <InputGroupInput id="username" value={username}
                                                     onChange={e => setUsername(e.target.value)} required/>
                                    <InputGroupAddon align="inline-end">
                                        <InputGroupText>@{config?.domain ?? 'eigen.is'}</InputGroupText>
                                    </InputGroupAddon>
                                </InputGroup>
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="password">Password</FieldLabel>
                            <FieldContent>
                                <Input id="password" type="password" value={password}
                                       onChange={e => setPassword(e.target.value)}
                                       minLength={8} required/>
                            </FieldContent>
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="role">Role</FieldLabel>
                            <FieldContent>
                                <Select value={role} onValueChange={setRole}>
                                    <SelectTrigger>
                                        <SelectValue/>
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="member">Member</SelectItem>
                                        <SelectItem value="admin">Admin</SelectItem>
                                    </SelectContent>
                                </Select>
                            </FieldContent>
                        </Field>
                    </FieldGroup>
                    
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                        <Button type="submit" disabled={createUser.isPending}>
                            {createUser.isPending ? 'Creating...' : 'Create'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
