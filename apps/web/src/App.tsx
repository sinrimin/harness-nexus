import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/auth';
import { RequireAuth, RequireAdmin } from '@/guards';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/components/theme-provider';
import { SkinProvider } from '@/components/skin-provider';
import { Toaster } from '@/components/ui/sonner';
import { AppShell } from '@/components/app-shell';
import { ROUTES, routeById, type RouteId } from '@/nav';
import { LoginPage } from '@/pages/Login';
import { RegisterPage } from '@/pages/Register';
import { DashboardPage } from '@/pages/Dashboard';
import { UsersPage } from '@/pages/Users';
import { SettingsPage } from '@/pages/Settings';
import { CredentialsPage } from '@/pages/Credentials';
import { LlmProvidersPage } from '@/pages/LlmProviders';
import { TokensPage } from '@/pages/Tokens';
import { McpManagementPage } from '@/pages/McpManagement';
import { ProfilesPage } from '@/pages/Profiles';
import { ResourcesPage } from '@/pages/Resources';
import { SkillsPage } from '@/pages/Skills';
import { MachinesPage } from '@/pages/Machines';
import { MachineDetailPage } from '@/pages/MachineDetail';
import { ChatPage } from '@/pages/Chat';
import { AgentSessionPage } from '@/pages/AgentSession';

/** The chrome every protected page renders inside (nav.ts holds the manifest). */
function ShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

/**
 * Page component per route id. The id → element mapping is the one thing the
 * manifest cannot carry (elements are code), so it lives next to the router
 * rather than in the nav table — which stays importable by the shell alone.
 */
const PAGES: Record<RouteId, ReactNode> = {
  home: <DashboardPage />,
  chat: <ChatPage />,
  chatSession: <AgentSessionPage />,
  machines: <MachinesPage />,
  machineDetail: <MachineDetailPage />,
  skills: <SkillsPage />,
  subAgents: <ResourcesPage fixedKind="sub_agent" />,
  rules: <ResourcesPage fixedKind="rule" />,
  commands: <ResourcesPage fixedKind="command" />,
  hooks: <ResourcesPage fixedKind="hook" />,
  profiles: <ProfilesPage />,
  mcp: <McpManagementPage />,
  credentials: <CredentialsPage />,
  llmProviders: <LlmProvidersPage />,
  tokens: <TokensPage />,
  users: <UsersPage />,
  settings: <SettingsPage />,
};

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <SkinProvider>
          <AuthProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route
                  element={
                    <RequireAuth>
                      <ShellLayout />
                    </RequireAuth>
                  }
                >
                  {ROUTES.map((route) => (
                    <Route
                      key={route.id}
                      path={route.path}
                      element={
                        route.admin === true ? (
                          <RequireAdmin>{PAGES[route.id]}</RequireAdmin>
                        ) : (
                          PAGES[route.id]
                        )
                      }
                    />
                  ))}
                  {/* Legacy paths: /resources was one page for five kinds, and
                      the skill hub had its own route before it became a tab. */}
                  <Route path="/resources" element={<Navigate to="/skills" replace />} />
                  <Route path="/skills/hub" element={<Navigate to="/skills?tab=hub" replace />} />
                  <Route
                    path="/admin/*"
                    element={<Navigate to={routeById('settings').path} replace />}
                  />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>
            <Toaster closeButton />
          </AuthProvider>
        </SkinProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
