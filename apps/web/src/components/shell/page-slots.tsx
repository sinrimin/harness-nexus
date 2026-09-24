import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Topbar slots — how a page puts its identity and its actions in the chrome
 * (01-skeleton.md §4).
 *
 * Not a context holding nodes: that shape re-renders the shell on every page
 * render (node identity changes), and comparing nodes to break that loop is a
 * losing game. The shell owns empty DOM nodes instead, and a page *portals*
 * into them — so updates flow with the page's own render tree, events bubble
 * through the React tree as usual, and the shell never hears about the page's
 * state. A page that claims the title slot also replaces the route-derived
 * fallback, which is why claiming is tracked separately from the target node.
 *
 * The node is captured with a callback ref and the claim in a layout effect, so
 * both land in the same pre-paint flush (the first render finds the slot empty,
 * the re-render portals into place). The refs are memoized: an inline callback
 * would be detached and re-attached on every shell render, and the pair of
 * null/node updates would render forever.
 */
export type PageSlotName = 'title' | 'actions';

type Slots = Partial<Record<PageSlotName, HTMLElement | null>>;
type Claims = Partial<Record<PageSlotName, boolean>>;

export interface PageSlotsValue {
  targets: Slots;
  /** Slots a page has claimed — the shell drops its own fallback for those. */
  claims: Claims;
  register: (name: PageSlotName, claimed: boolean) => void;
}

const PageSlotsContext = createContext<PageSlotsValue>({
  targets: {},
  claims: {},
  register: () => undefined,
});

export function PageSlotsProvider({
  value,
  children,
}: {
  value: PageSlotsValue;
  children: ReactNode;
}) {
  return <PageSlotsContext.Provider value={value}>{children}</PageSlotsContext.Provider>;
}

/** Slot state plus stable callback refs for the shell's slot elements. */
export function usePageSlots(): {
  value: PageSlotsValue;
  ref: (name: PageSlotName) => RefCallback<HTMLElement | null>;
} {
  const [targets, setTargets] = useState<Slots>({});
  const [claims, setClaims] = useState<Claims>({});

  const refs = useMemo(() => {
    const make =
      (name: PageSlotName): RefCallback<HTMLElement | null> =>
      (el) => {
        setTargets((prev) => (prev[name] === el ? prev : { ...prev, [name]: el }));
      };
    return { title: make('title'), actions: make('actions') };
  }, []);

  const register = useCallback((name: PageSlotName, claimed: boolean) => {
    setClaims((prev) => (prev[name] === claimed ? prev : { ...prev, [name]: claimed }));
  }, []);

  const value = useMemo(() => ({ targets, claims, register }), [targets, claims, register]);
  return { value, ref: (name) => refs[name] };
}

/** Renders into the shell's slot; nothing when the shell did not provide one. */
export function PageSlot({ slot, children }: { slot: PageSlotName; children: ReactNode }) {
  const { register, targets } = useContext(PageSlotsContext);
  useLayoutEffect(() => {
    register(slot, true);
    return () => register(slot, false);
  }, [register, slot]);

  const target = targets[slot];
  if (!target) return null;
  return createPortal(children, target);
}