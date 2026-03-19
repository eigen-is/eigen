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
import {Check, ClipboardCopy, InfoIcon} from "lucide-react"
import {Card, CardContent} from "@workspace/ui/components/card"
import {Separator} from "@workspace/ui/components/separator"
import QRCode from "react-qr-code"

// Define form schemas with validation for each step
const passwordFormSchema = z.object({
    password: z.string().min(1, "Password is required"),
});

const verificationFormSchema = z.object({
    verificationCode: z.string().min(6, "Verification code must be 6 digits").max(6, "Verification code must be 6 digits"),
    enableTwoFactor: z.boolean(),
});

type TwoFactorSetupProps = {
    onInitialize2FA: (password: string) => Promise<void>;
    onVerifyTotp: (code: string, enableTwoFactor: boolean) => Promise<void>;
    onBack: () => void;
    totpUri: string | null;
    secretKey: string;
    currentStep: "password" | "qrcode" | "verification";
    setCurrentStep: (step: "password" | "qrcode" | "verification") => void;
}

export function TwoFactorSetup({
                                   onInitialize2FA,
                                   onVerifyTotp,
                                   onBack,
                                   totpUri,
                                   secretKey,
                                   currentStep,
                                   setCurrentStep
                               }: TwoFactorSetupProps) {
    const [isLoading, setIsLoading] = React.useState<boolean>(false)
    const [isCopied, setIsCopied] = React.useState<boolean>(false)

    // Initialize password form
    const passwordForm = useForm<z.infer<typeof passwordFormSchema>>({
        resolver: zodResolver(passwordFormSchema),
        defaultValues: {
            password: "",
        },
    });

    // Initialize verification form
    const verificationForm = useForm<z.infer<typeof verificationFormSchema>>({
        resolver: zodResolver(verificationFormSchema),
        defaultValues: {
            verificationCode: "",
            enableTwoFactor: true,
        },
    });

    const copyToClipboard = () => {
        if (secretKey) {
            navigator.clipboard.writeText(secretKey);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        }
    };

    const proceedToVerification = () => {
        setCurrentStep("verification");
    };

    // Handle password form submission
    async function onPasswordSubmit(values: z.infer<typeof passwordFormSchema>) {
        try {
            setIsLoading(true);
            await onInitialize2FA(values.password);
        } catch (error) {
            console.error("Error initializing two-factor authentication:", error);
        } finally {
            setIsLoading(false);
        }
    }

    // Handle verification form submission
    async function onVerificationSubmit(values: z.infer<typeof verificationFormSchema>) {
        try {
            setIsLoading(true);
            await onVerifyTotp(values.verificationCode, values.enableTwoFactor);
        } catch (error) {
            console.error("Error verifying two-factor authentication:", error);
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="space-y-8 pb-20">
            <div className="space-y-2">
                <p className="text-muted-foreground">
                    Add an extra layer of security to your account by enabling two-factor authentication.
                </p>
            </div>

            <Separator/>

            {currentStep === "password" && (
                <Form {...passwordForm}>
                    <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="space-y-6">
                        <div className="bg-accent border text-accent-foreground rounded-md p-4">
                            <div className="flex">
                                <InfoIcon className="h-5 w-5 text-primary mr-2"/>
                                <div>
                                    <h3 className="font-medium">Important</h3>
                                    <p className="text-sm">
                                        Two-factor authentication adds an extra layer of security to your account.
                                        Once enabled, you'll need both your password and a verification code from your
                                        authentication app to sign in.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <FormField
                            control={passwordForm.control}
                            name="password"
                            render={({field}) => (
                                <FormItem>
                                    <FormLabel>Current Password</FormLabel>
                                    <FormControl>
                                        <Input
                                            type="password"
                                            placeholder="Enter current password"
                                            autoComplete="current-password"
                                            {...field}
                                        />
                                    </FormControl>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        <div className="flex justify-end gap-3">
                            <Button type="submit" disabled={isLoading}>
                                {isLoading ? "Setting up..." : "Enable Two-Factor Authentication"}
                            </Button>
                        </div>
                    </form>
                </Form>
            )}

            {currentStep === "qrcode" && totpUri && (
                <div className="space-y-6">
                    <div className="bg-accent border text-accent-foreground rounded-md p-4">
                        <div className="flex">
                            <InfoIcon className="h-5 w-5 text-primary mr-2"/>
                            <div>
                                <h3 className="font-medium">Set up authenticator app</h3>
                                <p className="text-sm">
                                    Scan the QR code below with your authenticator app (like Google Authenticator,
                                    Authy, or Microsoft Authenticator) to set up two-factor authentication.
                                </p>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-lg font-medium">Step 1: Scan QR code</h3>
                        <p className="text-sm text-muted-foreground">
                            Scan this QR code with your authentication app.
                        </p>

                        <Card className="border-dashed">
                            <CardContent className="flex items-center justify-center p-6">
                                <div className="w-48 h-48 flex items-center justify-center">
                                    <QRCode value={totpUri} size={192}/>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="space-y-4">
                        <h3 className="text-lg font-medium">Step 2: Or enter setup key manually</h3>
                        <p className="text-sm text-muted-foreground">
                            If you can't scan the QR code, you can manually enter this setup key into your app.
                        </p>

                        <div className="flex items-center space-x-2">
                            <Input
                                value={secretKey}
                                readOnly
                                className="font-mono"
                            />
                            <Button
                                variant="outline"
                                size="icon"
                                onClick={copyToClipboard}
                                title="Copy to clipboard"
                            >
                                {isCopied ? <Check className="h-4 w-4"/> : <ClipboardCopy className="h-4 w-4"/>}
                            </Button>
                        </div>
                    </div>

                    <div className="flex justify-between">
                        <Button
                            variant="outline"
                            onClick={onBack}
                        >
                            Back
                        </Button>
                        <Button onClick={proceedToVerification}>
                            Continue
                        </Button>
                    </div>
                </div>
            )}

            {currentStep === "verification" && (
                <Form {...verificationForm}>
                    <form onSubmit={verificationForm.handleSubmit(onVerificationSubmit)} className="space-y-6">
                        <div className="bg-accent border text-accent-foreground rounded-md p-4">
                            <div className="flex">
                                <InfoIcon className="h-5 w-5 text-primary mr-2"/>
                                <div>
                                    <h3 className="font-medium">Verify your setup</h3>
                                    <p className="text-sm">
                                        Enter the 6-digit verification code from your authenticator app to complete the
                                        setup.
                                    </p>
                                </div>
                            </div>
                        </div>

                        <FormField
                            control={verificationForm.control}
                            name="verificationCode"
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
                                        />
                                    </FormControl>
                                    <FormDescription>
                                        Enter the 6-digit code from your authentication app
                                    </FormDescription>
                                    <FormMessage/>
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={verificationForm.control}
                            name="enableTwoFactor"
                            render={({field}) => (
                                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-4">
                                    <div className="space-y-0.5">
                                        <FormLabel className="text-base">
                                            Enable Two-Factor Authentication
                                        </FormLabel>
                                        <FormDescription>
                                            Require a verification code when signing in
                                        </FormDescription>
                                    </div>
                                    <FormControl>
                                        <div
                                            className="relative inline-flex h-[24px] w-[44px] shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input"
                                            data-state={field.value ? "checked" : "unchecked"}
                                            onClick={() => field.onChange(!field.value)}>
                      <span
                          className="pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform duration-200 ease-in-out data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
                          data-state={field.value ? "checked" : "unchecked"}/>
                                        </div>
                                    </FormControl>
                                </FormItem>
                            )}
                        />

                        <div className="flex items-start gap-2 text-sm text-muted-foreground">
                            <InfoIcon className="h-4 w-4 mt-0.5 flex-shrink-0"/>
                            <p>
                                After enabling two-factor authentication, you'll need both your password and a
                                verification code to sign in.
                                Make sure to save your recovery codes in a safe place in case you lose access to your
                                authentication app.
                            </p>
                        </div>

                        <div className="flex justify-between gap-3">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={onBack}
                            >
                                Back
                            </Button>
                            <Button type="submit" disabled={isLoading}>
                                {isLoading ? "Verifying..." : "Verify and Enable"}
                            </Button>
                        </div>
                    </form>
                </Form>
            )}
        </div>
    );
}