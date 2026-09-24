// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ROUTES, groupRoutes, groupLanding, matchRoute, routeTrail, visibleGroups } from '@/nav';
import { PageSlot, PageSlotsProvider, usePageSlots } from '@/components/shell/page-slots';

/**
 * #23 P2 — the route manifest is the single source for the router, the nav and
 * the page identity, so these are the assertions that keep those three in
 * agreement (a page that is in the nav but not routable, a section with no
 * landing page, a crumb pointing at itself).
 */
describe('route manifest', () => {
  it('matches every declared path, including the parameterized ones', () => {
    for (const route of ROUTES) {
      const concrete = route.path.replace(':agentId', 'a1').replace(':id', 'm1').replace('/*', '/x');
      expect(matchRoute(concrete)?.id, `${route.path} → ${concrete}`).toBe(route.id);
    }
  });

  it('does not confuse a list page with its detail page', () => {
    expect(matchRoute('/machines')?.id).toBe('machines');
    expect(matchRoute('/machines/abc')?.id).toBe('machineDetail');
    expect(matchRoute('/chat')?.id).toBe('chat');
    expect(matchRoute('/chat/agents/a1')?.id).toBe('chatSession');
  });

  it('every section with entries has a landing page', () => {
    for (const group of visibleGroups(true)) {
      expect(groupLanding(group.id, true), group.id).toBeDefined();
    }
  });

  it('hides admin destinations from a regular user', () => {
    expect(visibleGroups(false).map((g) => g.id)).not.toContain('admin');
    expect(groupRoutes('admin', false)).toHaveLength(0);
    expect(groupRoutes('admin', true).map((r) => r.id)).toEqual(['users', 'settings']);
  });

  it('never nests a page deeper than its parent chain', () => {
    for (const route of ROUTES) {
      const trail = routeTrail(route);
      expect(trail[trail.length - 1]?.id).toBe(route.id);
      for (const ancestor of trail.slice(0, -1)) {
        expect(ancestor.group).toBe(route.group); // a crumb never crosses sections
      }
    }
  });
});

describe('page slots', () => {
  function Host() {
    const { value, ref } = usePageSlots();
    return (
      <>
        <div data-testid="title" ref={ref('title')} />
        <PageSlotsProvider value={value}>
          <PageSlot slot="title">
            <h1>a97bb4e6</h1>
          </PageSlot>
        </PageSlotsProvider>
      </>
    );
  }

  it('portals page content into the shell slot', async () => {
    render(
      <MemoryRouter>
        <Host />
      </MemoryRouter>,
    );
    const slot = await screen.findByTestId('title');
    expect(slot.querySelector('h1')?.textContent).toBe('a97bb4e6');
  });
});