"use client"

import * as React from "react"
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
import {InfoIcon} from "lucide-react"
import {Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle} from "@workspace/ui/components/card"
import {authClient} from "@workspace/lib/auth"
import {toast} from "sonner"
import {Checkbox} from "@workspace/ui/components/checkbox"
import {usePublicConfig} from "@workspace/lib/public"

// Define form schema with validation
const formSchema = z.object({
    code: z.string().min(6, "Verification code must be 6 digits").max(6, "Verification code must be 6 digits"),
    trustDevice: z.boolean(),
});

export function LoginFa2Form() {
    const [isLoading, setIsLoading] = React.useState<boolean>(false)
    const {data: config} = usePublicConfig()

    // Initialize form
    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            code: "",
            trustDevice: false,
        },
    });

    // Handle form submission
    async function onSubmit(values: z.infer<typeof formSchema>) {

        try {
            setIsLoading(true)

            // Verify the TOTP code
            const result = await authClient.twoFactor.verifyTotp({
                code: values.code,
                trustDevice: values.trustDevice
            })

            if (result.data) {
                toast.success("Verification successful")

                // Wait a short time before navigating to give the toast time to show
                await new Promise(resolve => setTimeout(resolve, 350))

                // TODO: Reinder, dit moet misschien anders
                window.location.reload();
            } else {
                toast.error(result.error?.message || "Invalid verification code")
            }
        } catch (error: unknown) {
            console.error("Error verifying 2FA:", error)
            toast.error(error instanceof Error ? error.message : "Verification failed")
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Card className="w-full max-w-md mx-auto">
            <CardHeader>
                <CardTitle>Two-Factor Authentication</CardTitle>
                <CardDescription>
                    Enter the verification code from your authenticator app
                </CardDescription>
            </CardHeader>
            <CardContent>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                        <FormField
                            control={form.control}
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
                                        Enter the 6-digit code from your authenticator app
                                    </FormDescription>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
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
                                            Don't ask for verification code on this device for 60 days
                                        </FormDescription>
                                    </div>
                                </FormItem>
                            )}
                        />

                        <div className="flex items-start gap-2 text-sm text-muted-foreground">
                            <InfoIcon className="h-4 w-4 mt-0.5 flex-shrink-0"/>
                            <p>
                                If you've lost access to your authenticator app, contact your administrator for
                                assistance.
                            </p>
                        </div>

                        <Button type="submit" className="w-full" disabled={isLoading}>
                            {isLoading ? "Verifying..." : "Verify"}
                        </Button>
                    </form>
                </Form>
            </CardContent>
            <CardFooter className="flex justify-center">
                <div className="text-sm text-muted-foreground">
                    <span>Need help? </span>
                    <a href={`mailto:support@${config?.domain ?? 'eigen.is'}`} className="text-primary hover:underline">
                        Contact support
                    </a>
                </div>
            </CardFooter>
        </Card>
    );
}

export default function LoginFa2Page() {
    return (
        <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-background">
            <div className="w-full max-w-md">
                <div className="mb-8 text-center">
                    <h1 className="text-2xl font-bold tracking-tight">Verification Required</h1>
                    <p className="text-muted-foreground mt-2">
                        Your account is protected with two-factor authentication
                    </p>
                </div>
                <LoginFa2Form/>
            </div>
        </div>
    );
}