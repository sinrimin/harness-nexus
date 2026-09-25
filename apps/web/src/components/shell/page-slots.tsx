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
 * **Title = a string, not a portal.** The title used to be portaled into the
 * topbar's `<h1>`, and that was a real bug: React renders that `<h1>`'s own text
 * child too, so the container had two writers. Whenever the node's children were
 * cleared behind React's back (React's text-content fast path, a browser feature
 * rewriting text nodes — anything), the page's text node was gone while React
 * still believed it owned it, and the next commit that unmounted the page threw
 * `NotFoundError: The node to be removed is not a child of this node` during the
 * deletion pass. With no error boundary above it, React then unmounts the whole
 * app: a blank page. Reproduced that way (wipe the slot's children, then
 * navigate). A string cannot desync — the shell renders it as the `<h1>`'s own
 * text, so exactly one writer owns that container.
 *
 * **Actions stay a portal.** The actions container is a `<div>` the shell renders
 * with no children of its own, so the page's buttons are its only writers, and
 * events still bubble through the page's React tree. The shell renders that
 * `<div>` unconditionally (`app-shell.tsx`), so a mounted portal's target can
 * never disappear underneath it.
 *
 * The node is captured with a memoized callback ref: an inline callback would be
 * detached and re-attached on every shell render, and the pair of null/node
 * updates would render forever.
 */
type PageSlotName = 'title' | 'actions' | 'margin';

type Targets = { actions?: HTMLElement | null; margin?: HTMLElement | null };
type Claims = Partial<Record<PageSlotName, boolean>>;

const noop = () => undefined;

interface PageSlotsValue {
  /** What the topbar's `<h1>` reads while a page claims the title slot. */
  title: string | null;
  /** Slots a page has claimed — the shell drops its own fallback for those. */
  claims: Claims;
  /** The shell's DOM nodes (the actions and folio-margin slots are portal
   *  targets; the margin one is the Region slot a skin may style). */
  targets: Targets;
  register: (name: PageSlotName, claimed: boolean) => void;
  setTitle: (title: string | null) => void;
}

const PageSlotsContext = createContext<PageSlotsValue>({
  title: null,
  claims: {},
  targets: {},
  register: noop,
  setTitle: noop,
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

/** Shell side: the slot state plus stable callback refs for the two DOM slots. */
export function usePageSlots(): {
  value: PageSlotsValue;
  actionsRef: RefCallback<HTMLElement | null>;
  marginRef: RefCallback<HTMLElement | null>;
} {
  const [targets, setTargets] = useState<Targets>({});
  const [claims, setClaims] = useState<Claims>({});
  const [title, setTitleState] = useState<string | null>(null);

  const actionsRef = useMemo<RefCallback<HTMLElement | null>>(
    () => (el) => {
      setTargets((prev) => (prev.actions === el ? prev : { ...prev, actions: el }));
    },
    [],
  );
  const marginRef = useMemo<RefCallback<HTMLElement | null>>(
    () => (el) => {
      setTargets((prev) => (prev.margin === el ? prev : { ...prev, margin: el }));
    },
    [],
  );

  const register = useCallback((name: PageSlotName, claimed: boolean) => {
    setClaims((prev) => (prev[name] === claimed ? prev : { ...prev, [name]: claimed }));
  }, []);

  const setTitle = useCallback((next: string | null) => {
    setTitleState((prev) => (prev === next ? prev : next));
  }, []);

  const value = useMemo(
    () => ({ title, claims, targets, register, setTitle }),
    [title, claims, targets, register, setTitle],
  );
  return { value, actionsRef, marginRef };
}

/** Page side: publish this page's title into the topbar. */
export function usePageTitle(title: string | null | undefined): void {
  const { register, setTitle } = useContext(PageSlotsContext);
  useLayoutEffect(() => {
    register('title', true);
    return () => register('title', false);
  }, [register]);
  useLayoutEffect(() => {
    setTitle(title ?? null);
  }, [setTitle, title]);
}

/** Page side: render the page's actions into the shell's slot. */
export function PageSlot({ slot, children }: { slot: PageSlotName; children: ReactNode }) {
  const { register, targets } = useContext(PageSlotsContext);
  useLayoutEffect(() => {
    register(slot, true);
    return () => register(slot, false);
  }, [register, slot]);

  const target = slot === 'actions' ? targets.actions : slot === 'margin' ? targets.margin : null;
  if (!target) return null;
  return createPortal(children, target);
}
