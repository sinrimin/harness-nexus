import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth';
import { useI18n } from '@/i18n';
import { api } from '@/api';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Note, Panel, PanelBody } from '@/components/kit';
import { Brand } from '@/components/brand-mark';

/**
 * Create an account (P5, same pass as sign-in): panel material, the brand
 * area, `Field` geometry, and errors as `Note`s — the registration switch being
 * closed is a state, not a failure, so it gets a neutral note rather than the
 * destructive Alert this page used to raise.
 */
export function RegisterPage() {
  const { register, user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  // Fetch the public registration switch so the form can disable itself.
  useEffect(() => {
    api
      .getRegistration()
      .then((r) => setRegistrationOpen(r.allowRegistration))
      .catch(() => setRegistrationOpen(true));
  }, []);

  // Already signed in → go home.
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(username, password, email || undefined);
      navigate('/', { replace: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('register failed:', e);
      setError(
        e instanceof HarnessNexusError
          ? e.message
          : t('register.failed', {
              message: e instanceof Error ? e.message : String(e),
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  const closed = registrationOpen === false;

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <Brand size={30} />
      <Panel className="w-full max-w-sm">
        <PanelBody variant="wide" className="flex flex-col gap-5">
          <div>
            <h1 className="text-lg font-semibold">{t('register.createAccount')}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{t('register.subtitle')}</p>
          </div>
          {closed ? <Note title={t('register.closed')} /> : null}
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error !== null ? <Note tone="fail">{error}</Note> : null}
            <Field label={t('register.username')} htmlFor="username" required>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={closed}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </Field>
            <Field
              label={t('register.password')}
              htmlFor="password"
              hint={t('register.minChars')}
              required
            >
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={closed}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label={t('register.emailOptional')} htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={closed}
                autoComplete="email"
              />
            </Field>
            <Button type="submit" disabled={busy || closed} className="w-full">
              {busy ? t('register.creating') : t('register.register')}
            </Button>
            <p className="text-muted-foreground text-center text-sm">
              {t('register.haveAccount')}{' '}
              <Link to="/login" className="text-signal underline-offset-4 hover:underline">
                {t('register.signInLink')}
              </Link>
            </p>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}
