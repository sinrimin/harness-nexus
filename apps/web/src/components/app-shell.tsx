import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import {
  HomeIcon,
  SettingsIcon,
  UsersIcon,
  LogOutIcon,
  KeyRoundIcon,
  ServerIcon,
  LayersIcon,
  TicketIcon,
  BoxesIcon,
  StoreIcon,
  LaptopIcon,
  MessageSquareIcon,
  PlugZapIcon,
} from 'lucide-react';
import { useAuth } from '@/auth';
import { useI18n, type TFunc } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';
import { SkinToggle } from '@/components/skin-toggle';
import { LanguageToggle } from '@/components/language-toggle';
import { Brand } from '@/components/brand-mark';
import { MobileNav } from '@/components/mobile-nav';
import { cn } from '@/lib/utils';

/**
 * Dashboard chrome: left sidebar nav + top header. The mobile drawer mirrors
 * the same nav. The shell is viewport-locked: the sidebar stays put while the
 * main column scrolls independently (the header is sticky inside that column).
 * `variant="full"` (chat session page): the main column drops its width cap +
 * padding and hands scrolling to the page itself, which lays out full-height
 * panes.
 */
export function AppShell({
  children,
  variant = 'default',
}: {
  children: ReactNode;
  variant?: 'default' | 'full';
}) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const items = navItems(isAdmin, t);
  const full = variant === 'full';

  return (
    <div className="bg-background text-foreground flex h-svh overflow-hidden">
      {/* Skip link — first focusable element, jumps to main content. */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:absolute focus:left-4 focus:top-4"
      >
        {t('app.skipToContent')}
      </a>

      {/* Sidebar (desktop) — brand row and footer pinned; the nav list is the
          only scrolling part, so short viewports keep both ends reachable.
          data-region markers are the skin system's hooks (see wiki
          design-skin-system.md) — skins restyle regions, never restructure. */}
      <aside
        data-region="sidebar"
        className="bg-sidebar text-sidebar-foreground hidden w-60 shrink-0 flex-col overflow-hidden border-r md:flex"
      >
        <div data-region="brand" className="flex h-14 shrink-0 items-center px-5">
          <Link to="/" aria-label={t('app.brandHome')}>
            <Brand size={22} />
          </Link>
        </div>
        <Separator />
        <nav
          data-region="nav"
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
          aria-label={t('app.primaryNav')}
        >
          {items.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
        <div data-region="signed-in" className="shrink-0 p-3">
          <div className="text-muted-foreground px-2 pb-2 text-xs uppercase tracking-wide">
            {t('app.signedIn')}
          </div>
          <div className="flex items-center justify-between rounded-md px-2 py-1.5">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{user?.username}</div>
              <div className="mt-0.5">
                <Badge variant={isAdmin ? 'default' : 'secondary'} className="text-[10px]">
                  {isAdmin ? t('common.roleAdmin') : t('common.roleUser')}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main column — the scroll container; the sidebar beside it never moves */}
      <div className={cn('flex min-w-0 flex-1 flex-col', !full && 'overflow-y-auto')}>
        <header
          data-region="header"
          className="bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-4 backdrop-blur md:px-6"
        >
          {/* Mobile: drawer trigger + brand (sidebar is hidden below md) */}
          <MobileNav>
            {items.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </MobileNav>
          <Link to="/" className="md:hidden" aria-label={t('app.brandHome')}>
            <Brand size={20} />
          </Link>

          <div className="ml-auto flex items-center gap-1">
            <LanguageToggle />
            <SkinToggle />
            <ThemeToggle />
            <Separator orientation="vertical" className="mx-1 h-6" />
            <Button variant="ghost" size="sm" onClick={logout} className="gap-1.5">
              <LogOutIcon className="size-4" />
              <span className="hidden sm:inline">{t('app.signOut')}</span>
            </Button>
          </div>
        </header>

        <main
          id="main"
          data-region="main"
          className={cn(
            'mx-auto w-full flex-1',
            full ? 'max-w-none overflow-hidden p-0' : 'max-w-6xl p-4 md:p-8',
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Nav groups — the skin system's spine labels (BAY's numbered bays, etc.).
 *  Data only: the default chrome ignores them; skins read data-nav-group. */
type NavGroup = 'nav' | 'fleet' | 'mesh' | 'asset' | 'tokens' | 'admin';

type NavItemProps = {
  to: string;
  icon: ReactNode;
  label: string;
  group: NavGroup;
  end?: boolean;
};

function NavItem({ to, icon, label, group, end }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      data-nav-group={group}
      className={({ isActive }) =>
        cn(
          'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
        )
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}

/** Single source of truth for the nav — shared by desktop sidebar and mobile drawer. */
function navItems(isAdmin: boolean, t: TFunc): NavItemProps[] {
  const items: NavItemProps[] = [
    {
      to: '/',
      icon: <HomeIcon className="size-4" />,
      label: t('app.navHome'),
      group: 'nav',
      end: true,
    },
    {
      to: '/machines',
      icon: <LaptopIcon className="size-4" />,
      label: t('app.navMachines'),
      group: 'fleet',
    },
    {
      to: '/chat',
      icon: <MessageSquareIcon className="size-4" />,
      label: t('app.navChat'),
      group: 'fleet',
    },
    {
      to: '/mcp-servers',
      icon: <ServerIcon className="size-4" />,
      label: t('app.navMcp'),
      group: 'mesh',
    },
    {
      to: '/profiles',
      icon: <LayersIcon className="size-4" />,
      label: t('app.navProfiles'),
      group: 'asset',
    },
    {
      to: '/resources',
      icon: <BoxesIcon className="size-4" />,
      label: t('app.navResources'),
      group: 'asset',
    },
    {
      to: '/skills/hub',
      icon: <StoreIcon className="size-4" />,
      label: t('app.navSkillHub'),
      group: 'asset',
    },
    {
      to: '/credentials',
      icon: <KeyRoundIcon className="size-4" />,
      label: t('app.navCredentials'),
      group: 'asset',
    },
    {
      to: '/llm-providers',
      icon: <PlugZapIcon className="size-4" />,
      label: t('app.navProviders'),
      group: 'asset',
    },
    {
      to: '/tokens',
      icon: <TicketIcon className="size-4" />,
      label: t('app.navTokens'),
      group: 'tokens',
    },
  ];
  if (isAdmin) {
    items.push(
      {
        to: '/admin/users',
        icon: <UsersIcon className="size-4" />,
        label: t('app.navUsers'),
        group: 'admin',
      },
      {
        to: '/admin/settings',
        icon: <SettingsIcon className="size-4" />,
        label: t('app.navSettings'),
        group: 'admin',
      },
    );
  }
  return items;
}
