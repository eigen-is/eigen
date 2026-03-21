import {useState} from "react"
import {zodResolver} from "@hookform/resolvers/zod"
import {useForm} from "react-hook-form"
import {z} from "zod"
import {Button} from "@workspace/ui/components/button"
import {
    Form,
    FormControl,
    FormDescription,
    FormField,
    FormItem,
    FormLabel,
    FormMessage
} from "@workspace/ui/components/form"
import {Input} from "@workspace/ui/components/input"
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from "@workspace/ui/components/card"
import {authClient} from "@workspace/lib/auth"
import {toast} from "sonner"
import {Checkbox} from "@workspace/ui/components/checkbox"
import {Bar} from "@workspace/ui/components/layout/braket/bar"
import {Ket} from "@workspace/ui/components/layout/braket/ket"
import {useApp} from "@workspace/ui/components/layout/app/layout-context"

const totpSchema = z.object({
    code: z.string().min(6, "Code must be 6 digits").max(6, "Code must be 6 digits"),
    trustDevice: z.boolean(),
});

const backupSchema = z.object({
    code: z.string().min(1, "Backup code is required"),
    trustDevice: z.boolean(),
});

export default function LoginFa2Page() {
    const {appName} = useApp();
    const [mode, setMode] = useState<"totp" | "backup">("totp");
    const [isLoading, setIsLoading] = useState(false);

    const totpForm = useForm<z.infer<typeof totpSchema>>({
        resolver: zodResolver(totpSchema),
        defaultValues: {code: "", trustDevice: false},
    });

    const backupForm = useForm<z.infer<typeof backupSchema>>({
        resolver: zodResolver(backupSchema),
        defaultValues: {code: "", trustDevice: false},
    });

    async function onTotpSubmit(values: z.infer<typeof totpSchema>) {
        try {
            setIsLoading(true);
            const result = await authClient.twoFactor.verifyTotp({
                code: values.code,
                trustDevice: values.trustDevice,
            });
            if (result.data) {
                toast.success("Verification successful");
                window.location.reload();
            } else {
                toast.error(result.error?.message || "Invalid verification code");
            }
        } catch {
            toast.error("Verification failed");
        } finally {
            setIsLoading(false);
        }
    }

    async function onBackupSubmit(values: z.infer<typeof backupSchema>) {
        try {
            setIsLoading(true);
            const result = await authClient.twoFactor.verifyBackupCode({
                code: values.code,
                trustDevice: values.trustDevice,
            });
            if (result.data) {
                toast.success("Verification successful");
                window.location.reload();
            } else {
                toast.error(result.error?.message || "Invalid backup code");
            }
        } catch {
            toast.error("Verification failed");
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="flex w-full h-[calc(100vh-64px)] items-center justify-center">
            <Card className="w-full max-w-md">
                <CardHeader className="text-center">
                    <CardTitle className="text-2xl text-app">
                        <span className="font-bold">eigen</span>
                        <span className="font-normal"><Bar/>{appName}<Ket/></span>
                    </CardTitle>
                    <CardDescription>
                        Your account is protected with two-factor authentication
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {mode === "totp" ? (
                        <Form {...totpForm}>
                            <form onSubmit={totpForm.handleSubmit(onTotpSubmit)} className="space-y-6">
                                <FormField
                                    control={totpForm.control}
                                    name="code"
                                    render={({field}) => (
                                        <FormItem>
                                            <FormLabel>Verification Code</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter 6-digit code"
                                                    {...field}
                                                    maxLength={6}
                                                    inputMode="numeric"
                                                    pattern="[0-9]*"
                                                    autoComplete="one-time-code"
                                                    autoFocus
                                                />
                                            </FormControl>
                                            <FormDescription>
                                                Enter the code from your authenticator app
                                            </FormDescription>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={totpForm.control}
                                    name="trustDevice"
                                    render={({field}) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                                            <FormControl>
                                                <Checkbox
                                                    checked={field.value}
                                                    onCheckedChange={field.onChange}
                                                />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>Trust this device</FormLabel>
                                                <FormDescription>
                                                    Don't ask for verification on this device for 30 days
                                                </FormDescription>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <Button type="submit" className="w-full" disabled={isLoading}>
                                    {isLoading ? "Verifying..." : "Verify"}
                                </Button>

                                <div className="text-center">
                                    <button
                                        type="button"
                                        className="text-sm text-muted-foreground hover:text-foreground underline"
                                        onClick={() => setMode("backup")}
                                    >
                                        Use a backup code instead
                                    </button>
                                </div>
                            </form>
                        </Form>
                    ) : (
                        <Form {...backupForm}>
                            <form onSubmit={backupForm.handleSubmit(onBackupSubmit)} className="space-y-6">
                                <FormField
                                    control={backupForm.control}
                                    name="code"
                                    render={({field}) => (
                                        <FormItem>
                                            <FormLabel>Backup Code</FormLabel>
                                            <FormControl>
                                                <Input
                                                    placeholder="Enter backup code"
                                                    {...field}
                                                    autoComplete="off"
                                                    autoFocus
                                                />
                                            </FormControl>
                                            <FormDescription>
                                                Enter one of your saved recovery codes
                                            </FormDescription>
                                            <FormMessage/>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={backupForm.control}
                                    name="trustDevice"
                                    render={({field}) => (
                                        <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                                            <FormControl>
                                                <Checkbox
                                                    checked={field.value}
                                                    onCheckedChange={field.onChange}
                                                />
                                            </FormControl>
                                            <div className="space-y-1 leading-none">
                                                <FormLabel>Trust this device</FormLabel>
                                                <FormDescription>
                                                    Don't ask for verification on this device for 30 days
                                                </FormDescription>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <Button type="submit" className="w-full" disabled={isLoading}>
                                    {isLoading ? "Verifying..." : "Verify with backup code"}
                                </Button>

                                <div className="text-center">
                                    <button
                                        type="button"
                                        className="text-sm text-muted-foreground hover:text-foreground underline"
                                        onClick={() => setMode("totp")}
                                    >
                                        Use authenticator app instead
                                    </button>
                                </div>
                            </form>
                        </Form>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
