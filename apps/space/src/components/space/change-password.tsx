"use client"

import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { 
  Form, 
  FormControl, 
  FormField, 
  FormItem, 
  FormLabel, 
  FormMessage 
} from "@workspace/ui/components/form"
import { Input } from "@workspace/ui/components/input"
import { Progress } from "@workspace/ui/components/progress"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { InfoIcon } from "lucide-react"
import { Label } from "@workspace/ui/components/label"

/**
 * Validates password strength on a scale from 0 to 1.
 * Assumes password is always 8+ characters.
 * @param password The password to validate
 * @returns A score between 0 and 1 representing password strength
 */
function validatePasswordStrength(password: string): number {
  let score = 0.4 * Math.min((password.length-1) / 8, 1.0);
  
  // Check for uppercase letters
  if (/[A-Z]/.test(password)) score += 0.1;
  
  // Check for lowercase letters
  if (/[a-z]/.test(password)) score += 0.1;
  
  // Check for numbers
  if (/\d/.test(password)) score += 0.1;
  
  // Check for special characters
  if (/[^A-Za-z0-9]/.test(password)) score += 0.1;
  
  // Bonus for length beyond 8
  score += Math.min(1, Math.max(password.length - 8, 0) * 0.03);
  
  // Ensure score is between 0 and 1
  return Math.min(1, Math.max(0, score));
}

const getPasswordStrengthColor = (strength: number): string => {
  if (strength < 0.4) return "bg-red-500";
  if (strength < 0.7) return "bg-yellow-500";
  return "bg-green-500";
};

const getPasswordStrengthLabel = (strength: number): string => {
  if (strength < 0.4) return "Weak";
  if (strength < 0.7) return "Good";
  return "Strong";
};

// Define form schema with validation
const formSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string().min(8, "Password must be at least 8 characters"),
  revokeOtherSessions: z.boolean().default(true),
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export function ChangePassword({ onPasswordChange }: { onPasswordChange: (data: { currentPassword: string, newPassword: string, revokeOtherSessions: boolean }) => Promise<void> }) {
  const [passwordStrength, setPasswordStrength] = React.useState(0);
  
  // Initialize form
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
      revokeOtherSessions: true,
    },
  });

  // Handle password change to update strength meter
  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const password = e.target.value;
      setPasswordStrength(validatePasswordStrength(password));
    form.setValue("newPassword", password);
  };
 
  // Handle form submission
  async function onSubmit(values: z.infer<typeof formSchema>) {
    onPasswordChange({ 
      currentPassword: values.currentPassword, 
      newPassword: values.newPassword, 
      revokeOtherSessions: values.revokeOtherSessions
    });
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Change Password</CardTitle>
        <CardDescription>
          Update your account password
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="currentPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Current Password</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Enter current password" autoComplete="current-password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="newPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>New Password</FormLabel>
                  <FormControl>
                    <Input 
                      type="password" 
                      placeholder="Enter new password" 
                      autoComplete="new-password"
                      {...field} 
                      onChange={handlePasswordChange}
                    />
                  </FormControl>
                  {field.value.length > 0 && (
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Password strength:</span>
                        <span className="text-xs font-medium">{getPasswordStrengthLabel(passwordStrength)}</span>
                      </div>
                      <Progress 
                        value={passwordStrength * 100} 
                        className="h-1.5"
                        indicatorClassName={getPasswordStrengthColor(passwordStrength)}
                      />
                      
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Confirm New Password</FormLabel>
                  <FormControl>
                    <Input autoComplete="new-password" type="password" placeholder="Confirm new password" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="revokeOtherSessions"
              render={({ field }) => (
                
                <FormItem className="flex items-center">
                  <FormControl>
                    <Checkbox id="revokeOtherSessions" checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <Label htmlFor="revokeOtherSessions" className="cursor-pointer">Log out of all other devices</Label>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <InfoIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <p>
                Choose a strong password and don't reuse it for other accounts. 
                You may be signed out of your account on some devices. Learn more about where you'll stay signed in.
              </p>
            </div>

            <div className="flex justify-end gap-3">
              <Button type="submit">Change Password</Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}