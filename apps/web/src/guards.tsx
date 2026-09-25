import type { ReactNode } from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from './auth.js';
import { useI18n } from '@/i18n';
import { AppShell } from '@/components/app-shell.js';
import { EmptyState, Panel } from '@/components/kit';
import { Button } from '@/components/ui/button.js';

/**
 * Front-end permission interceptors (see wiki design-phase-1-auth.md).
 *
 * `<RequireAuth>` — redirects to /login (remembering where we came from) when
 * there is no authenticated user. While the initial /me lookup is in flight it
 * renders nothing to avoid a login flash.
 *
 * `<RequireAdmin>` — renders a 403 view when the current user is not an admin.
 * Sits inside <RequireAuth>, so it can assume a user exists.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();
  if (user?.role !== 'admin') {
    return (
      <AppShell>
        {/* A 403 is a dead end, not a panel: the kit's empty state (the comp's
            lamp sockets), with the way out as its action. */}
        <Panel className="mx-auto mt-12 max-w-md">
          <EmptyState
            title={t('app.adminsOnlyTitle')}
            hint={t('app.adminsOnlyBody')}
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/">{t('app.backToOverview')}</Link>
              </Button>
            }
          />
        </Panel>
      </AppShell>
    );
  }
  return <>{children}</>;
}
