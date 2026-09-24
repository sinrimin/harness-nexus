import {
  HomeIcon,
  MessageSquareIcon,
  LaptopIcon,
  SparklesIcon,
  BotIcon,
  ScaleIcon,
  SquareTerminalIcon,
  WebhookIcon,
  LayersIcon,
  ServerIcon,
  KeyRoundIcon,
  PlugZapIcon,
  TicketIcon,
  UsersIcon,
  SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';

/**
 * The route table AND the navigation — one manifest (#23 P2).
 *
 * Before P2 the router (`App.tsx`) and `navItems()` each carried their own list,
 * so a new page had to be remembered in two places, and neither knew what the
 * page was *called* or where it belonged in the section taxonomy. Pages also
 * re-wrote their own `<h1>` twelve times. Now a destination is declared once,
 * with its section, its title, and whether the nav shows it; the router, the
 * spine/plate, the breadcrumb and the mobile bay strip all read this table.
 *
 * Sections are addresses, not counters: `number` is fixed in code, so hiding
 * ADMIN for a non-admin never renumbers the spine (the CSS `content:` hack that
 * got this wrong is deleted in P7).
 */
export type NavGroupId = 'nav' | 'mesh' | 'asset' | 'access' | 'admin';

export interface NavGroupDef {
  id: NavGroupId;
  /** Bay address shown on the spine (`01`…`05`) — data, never CSS content. */
  number: string;
  labelKey: TranslationKey;
  /**
   * The plate repeats the section as a list heading. The leading group does
   * not: its two entries are the daily starting points, and a heading over
   * them would say nothing (`01 NAV` still labels the bay on the spine).
   */
  plateHeading?: boolean;
}

export const NAV_GROUPS: NavGroupDef[] = [
  { id: 'nav', number: '01', labelKey: 'app.navGroupNav' },
  { id: 'mesh', number: '02', labelKey: 'app.navGroupMesh', plateHeading: true },
  { id: 'asset', number: '03', labelKey: 'app.navGroupAsset', plateHeading: true },
  { id: 'access', number: '04', labelKey: 'app.navGroupAccess', plateHeading: true },
  { id: 'admin', number: '05', labelKey: 'app.navGroupAdmin', plateHeading: true },
];

/** Resource kinds with their own page (README §5.3 — one page per kind). */
export type ResourcePageKind = 'skill' | 'sub_agent' | 'rule' | 'command' | 'hook';

export type RouteId =
  | 'home'
  | 'chat'
  | 'chatSession'
  | 'machines'
  | 'machineDetail'
  | 'skills'
  | 'subAgents'
  | 'rules'
  | 'commands'
  | 'hooks'
  | 'profiles'
  | 'mcp'
  | 'credentials'
  | 'llmProviders'
  | 'tokens'
  | 'users'
  | 'settings';

export interface RouteDef {
  id: RouteId;
  /** React Router path pattern. */
  path: string;
  group: NavGroupId;
  /** Page title (the topbar's `<h1>`). */
  titleKey: TranslationKey;
  /** Nav label when the destination is named differently from the page title. */
  navLabelKey?: TranslationKey;
  /** Shown in the plate nav / mobile drawer when present. */
  nav?: { icon: LucideIcon; end?: boolean };
  /** Admin-only destination (route wrapped in RequireAdmin). */
  admin?: boolean;
  /** Ancestor page whose title prefixes the breadcrumb. */
  parent?: RouteId;
  /** `panes` hands scrolling to the page (chat session); default is `flow`. */
  layout?: 'flow' | 'panes';
  /** Resource-kind pages render the same component with the kind fixed here. */
  resourceKind?: ResourcePageKind;
}

export const ROUTES: RouteDef[] = [
  {
    id: 'home',
    path: '/',
    group: 'nav',
    titleKey: 'dashboard.title',
    nav: { icon: HomeIcon, end: true },
  },
  {
    id: 'chat',
    path: '/chat',
    group: 'nav',
    titleKey: 'chat.title',
    nav: { icon: MessageSquareIcon },
  },
  {
    id: 'chatSession',
    path: '/chat/agents/:agentId',
    group: 'nav',
    titleKey: 'chat.title',
    parent: 'chat',
    layout: 'panes',
  },
  {
    id: 'machines',
    path: '/machines',
    group: 'mesh',
    titleKey: 'machines.title',
    nav: { icon: LaptopIcon },
  },
  {
    id: 'machineDetail',
    path: '/machines/:id',
    group: 'mesh',
    titleKey: 'machineDetail.fallbackTitle',
    parent: 'machines',
  },
  {
    id: 'skills',
    path: '/skills',
    group: 'asset',
    titleKey: 'app.navSkills',
    nav: { icon: SparklesIcon },
    resourceKind: 'skill',
  },
  {
    id: 'subAgents',
    path: '/sub-agents',
    group: 'asset',
    titleKey: 'app.navSubAgents',
    nav: { icon: BotIcon },
    resourceKind: 'sub_agent',
  },
  {
    id: 'rules',
    path: '/rules',
    group: 'asset',
    titleKey: 'app.navRules',
    nav: { icon: ScaleIcon },
    resourceKind: 'rule',
  },
  {
    id: 'commands',
    path: '/commands',
    group: 'asset',
    titleKey: 'app.navCommands',
    nav: { icon: SquareTerminalIcon },
    resourceKind: 'command',
  },
  {
    id: 'hooks',
    path: '/hooks',
    group: 'asset',
    titleKey: 'app.navHooks',
    nav: { icon: WebhookIcon },
    resourceKind: 'hook',
  },
  {
    id: 'profiles',
    path: '/profiles',
    group: 'asset',
    titleKey: 'profiles.title',
    nav: { icon: LayersIcon },
  },
  {
    id: 'mcp',
    path: '/mcp-servers',
    group: 'asset',
    titleKey: 'mcp.title',
    // The destination is `MCP` (README §5.2); the page it opens manages it.
    navLabelKey: 'app.navMcp',
    nav: { icon: ServerIcon },
  },
  {
    id: 'credentials',
    path: '/credentials',
    group: 'access',
    titleKey: 'credentials.title',
    nav: { icon: KeyRoundIcon },
  },
  {
    id: 'llmProviders',
    path: '/llm-providers',
    group: 'access',
    titleKey: 'llmProviders.title',
    nav: { icon: PlugZapIcon },
  },
  {
    id: 'tokens',
    path: '/tokens',
    group: 'access',
    titleKey: 'tokens.title',
    nav: { icon: TicketIcon },
  },
  {
    id: 'users',
    path: '/admin/users',
    group: 'admin',
    titleKey: 'users.title',
    nav: { icon: UsersIcon },
    admin: true,
  },
  {
    id: 'settings',
    path: '/admin/settings',
    group: 'admin',
    titleKey: 'settings.title',
    nav: { icon: SettingsIcon },
    admin: true,
  },
];

const byId = new Map(ROUTES.map((r) => [r.id, r]));

export function routeById(id: RouteId): RouteDef {
  const route = byId.get(id);
  if (!route) throw new Error(`unknown route id: ${id}`);
  return route;
}

/** Nav destinations for one section, in manifest order (admin routes gated). */
export function groupRoutes(group: NavGroupId, isAdmin: boolean): RouteDef[] {
  return ROUTES.filter((r) => r.group === group && r.nav && (r.admin !== true || isAdmin));
}

/** The section's landing page — what the spine, bay strip and breadcrumb link to. */
export function groupLanding(group: NavGroupId, isAdmin: boolean): RouteDef | undefined {
  return groupRoutes(group, isAdmin)[0];
}

/** Sections that have at least one destination for this viewer. */
export function visibleGroups(isAdmin: boolean): NavGroupDef[] {
  return NAV_GROUPS.filter((g) => groupLanding(g.id, isAdmin) !== undefined);
}

function patternToRegExp(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) return '[^/]+';
      if (segment === '*') return '.*';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}/?$`);
}

const MATCHERS = ROUTES.map((route) => ({ route, re: patternToRegExp(route.path) }));

/** The route a pathname belongs to (`/machines/abc` → machineDetail). */
export function matchRoute(pathname: string): RouteDef | undefined {
  return MATCHERS.find((m) => m.re.test(pathname))?.route;
}

/** Ancestor chain, nearest last (breadcrumb order: section first). */
export function routeTrail(route: RouteDef): RouteDef[] {
  const trail: RouteDef[] = [];
  let current: RouteDef | undefined = route;
  while (current !== undefined) {
    trail.unshift(current);
    current = current.parent !== undefined ? byId.get(current.parent) : undefined;
  }
  return trail;
}
