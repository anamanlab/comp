'use client';

import { authClient } from '@/utils/auth-client';
import { buildAuthCallbackUrl } from '@/utils/auth-callback';
import { Button } from '@trycompai/ui/button';
import { cn } from '@trycompai/ui/cn';
import { Form, FormControl, FormField, FormItem } from '@trycompai/ui/form';
import { Input } from '@trycompai/ui/input';
import { zodResolver } from '@hookform/resolvers/zod';
import { KeyRound, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

const formSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8, 'Use at least 8 characters'),
    name: z.string().optional(),
  })
  .refine((values) => values.name === undefined || values.name.length > 0, {
    message: 'Enter your name',
    path: ['name'],
  });

type Mode = 'signin' | 'signup';

interface EmailPasswordSignInProps {
  className?: string;
  inviteCode?: string;
  redirectTo?: string;
}

/**
 * Email + password sign-in.
 *
 * Upstream signs users in with a magic link, an email OTP or an OAuth
 * provider. The magic link and the OTP both deliver their mail through a
 * Trigger.dev task, so they need a deployed Trigger.dev project. This form is
 * rendered only when NEXT_PUBLIC_EMAIL_PASSWORD_ENABLED is set, and the API
 * enables the matching server-side feature with AUTH_EMAIL_PASSWORD_ENABLED.
 */
export function EmailPasswordSignIn({
  className,
  inviteCode,
  redirectTo,
}: EmailPasswordSignInProps) {
  const [mode, setMode] = useState<Mode>('signup');
  const [isLoading, setLoading] = useState(false);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', password: '', name: '' },
  });

  async function onSubmit({
    email,
    password,
    name,
  }: z.infer<typeof formSchema>) {
    setLoading(true);

    const callbackURL = buildAuthCallbackUrl({ inviteCode, redirectTo });

    const result =
      mode === 'signup'
        ? await authClient.signUp.email({ email, password, name, callbackURL })
        : await authClient.signIn.email({ email, password, callbackURL });

    if (result.error) {
      toast.error(
        result.error.message ??
          (mode === 'signup'
            ? 'Could not create the account - try again?'
            : 'Could not sign in - check your credentials?'),
      );
      setLoading(false);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <div className={cn('flex flex-col space-y-3', className)}>
          {mode === 'signup' ? (
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      placeholder="Your name"
                      {...field}
                      autoCapitalize="words"
                      className="h-11"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          ) : null}

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    placeholder="name@example.com"
                    {...field}
                    autoFocus={mode === 'signin'}
                    autoCapitalize="false"
                    autoCorrect="off"
                    spellCheck="false"
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="password"
                    placeholder="Password"
                    {...field}
                    autoComplete={
                      mode === 'signup' ? 'new-password' : 'current-password'
                    }
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <Button
            type="submit"
            className="w-full h-11 font-medium"
            variant="default"
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                {mode === 'signup' ? 'Create account' : 'Sign in'}
              </>
            )}
          </Button>

          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === 'signup' ? 'signin' : 'signup');
              form.clearErrors();
            }}
          >
            {mode === 'signup'
              ? 'Already have an account? Sign in'
              : 'Need an account? Create one'}
          </button>
        </div>
      </form>
    </Form>
  );
}
