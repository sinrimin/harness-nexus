import { useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '@/auth';
import { useI18n } from '@/i18n';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Note, Panel, PanelBody } from '@/components/kit';
import { Brand } from '@/components/brand-mark';

/**
 * Sign in (P5: panel material + the brand area; fields through the kit's
 * `Field`, and the failure is a `Note` — the device every other error surface
 * uses).
 *
 * This route renders OUTSIDE the shell (no topbar), so the heading here is the
 * page's own `<h1>` — not a panel nameplate.
 */
export function LoginPage() {
  const { login } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate(from, { replace: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('login failed:', e);
      setError(
        e instanceof HarnessNexusError
          ? e.message
          : t('login.failed', {
              message: e instanceof Error ? e.message : String(e),
            }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <Brand size={30} />
      <Panel className="w-full max-w-sm">
        <PanelBody variant="wide" className="flex flex-col gap-5">
          <div>
            <h1 className="text-lg font-semibold">{t('login.welcomeBack')}</h1>
            <p className="text-muted-foreground mt-1 text-sm">{t('login.signInSubtitle')}</p>
          </div>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error !== null ? <Note tone="fail">{error}</Note> : null}
            <Field label={t('login.username')} htmlFor="username" required>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </Field>
            <Field label={t('login.password')} htmlFor="password" required>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? t('login.signingIn') : t('login.signIn')}
            </Button>
            <p className="text-muted-foreground text-center text-sm">
              {t('login.noAccount')}{' '}
              <Link to="/register" className="text-signal underline-offset-4 hover:underline">
                {t('login.registerLink')}
              </Link>
            </p>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}
