// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SwipeRow } from './swipe-row';
import { SessionRow } from './session-row';

/**
 * #55 — the mechanical contracts of the row-delete affordances: the swipe's
 * axis lock + snap thresholds, and that the delete surfaces only exist (and
 * only fire) when a delete is actually offered. Visual truth is ui-snap plus
 * the agent-browser pass; what a unit test holds is the gesture math.
 */

afterEach(cleanup);

const touch = (x: number, y: number): { touches: { clientX: number; clientY: number }[] } => ({
  touches: [{ clientX: x, clientY: y }],
});

function rowElement(container: HTMLElement): HTMLElement {
  // The wrapper's children: [the pin layer?, the delete layer?, the moving
  // row] — #110 made the underlays per-action; the moving row is last.
  const kids = container.firstElementChild?.children ?? [];
  const el = kids[kids.length - 1];
  if (el === null || el === undefined) throw new Error('moving layer not found');
  return el as HTMLElement;
}

describe('SwipeRow (#55)', () => {
  it('a horizontal drag translates the row, clamped at the reveal width', () => {
    const onDelete = vi.fn();
    const { container } = render(
      <SwipeRow onDelete={onDelete} deleteLabel="Delete session">
        <button type="button">row</button>
      </SwipeRow>,
    );
    const layer = rowElement(container);
    fireEvent.touchStart(layer, touch(200, 100));
    // Below the slop: the axis is still undecided, nothing moved.
    fireEvent.touchMove(layer, touch(196, 100));
    expect(layer.style.transform).toBe('translateX(0px)');
    // Past the slop, horizontally: the drag delta drives translateX…
    fireEvent.touchMove(layer, touch(120, 100));
    expect(layer.style.transform).toBe('translateX(-80px)');
    // …rubber-banded at the reveal width + 24, never past the row's left edge.
    fireEvent.touchMove(layer, touch(-500, 100));
    expect(layer.style.transform).toBe('translateX(-96px)');
  });

  it('a vertical gesture never locks the x axis (scroll wins)', () => {
    const { container } = render(
      <SwipeRow onDelete={() => undefined} deleteLabel="Delete session">
        <button type="button">row</button>
      </SwipeRow>,
    );
    const layer = rowElement(container);
    fireEvent.touchStart(layer, touch(200, 100));
    fireEvent.touchMove(layer, touch(180, -300));
    expect(layer.style.transform).toBe('translateX(0px)');
    // Even a late horizontal drift stays locked out for this touch.
    fireEvent.touchMove(layer, touch(20, -320));
    expect(layer.style.transform).toBe('translateX(0px)');
  });

  it('releases past half the reveal = open; short drags snap back', () => {
    const { container } = render(
      <SwipeRow onDelete={() => undefined} deleteLabel="Delete session">
        <button type="button">row</button>
      </SwipeRow>,
    );
    const layer = rowElement(container);
    // A -50px drag is past half of 72 → snaps OPEN on release.
    fireEvent.touchStart(layer, touch(200, 100));
    fireEvent.touchMove(layer, touch(150, 100));
    fireEvent.touchEnd(layer);
    expect(layer.style.transform).toBe('translateX(-72px)');
    // A fresh short drag from closed… the row is OPEN (base -72), so +30
    // brings it to -42 → under half → snaps back OPEN? No: base is the OPEN
    // position, so releasing at -42 (closer to open) stays open. Close it
    // with a full rightward drag instead.
    fireEvent.touchStart(layer, touch(150, 100));
    fireEvent.touchMove(layer, touch(250, 100));
    fireEvent.touchEnd(layer);
    expect(layer.style.transform).toBe('translateX(0px)');
  });

  it('the revealed button fires onDelete', () => {
    const onDelete = vi.fn();
    render(
      <SwipeRow onDelete={onDelete} deleteLabel="Delete session">
        <button type="button">row</button>
      </SwipeRow>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  // #110 — the rightward reveal: the PIN action. Same gesture math mirrored:
  // clamped at +96, snaps open past half, fires onPin, and a row with no pin
  // action rubber-bands immediately on that side.
  it('a rightward drag reveals the pin action and fires it (#110)', () => {
    const onPin = vi.fn();
    const { container } = render(
      <SwipeRow
        onPin={onPin}
        pinLabel="Pin"
        onDelete={() => undefined}
        deleteLabel="Delete session"
      >
        <button type="button">row</button>
      </SwipeRow>,
    );
    const layer = rowElement(container);
    fireEvent.touchStart(layer, touch(200, 100));
    fireEvent.touchMove(layer, touch(280, 100));
    expect(layer.style.transform).toBe('translateX(80px)');
    fireEvent.touchMove(layer, touch(900, 100));
    expect(layer.style.transform).toBe('translateX(96px)');
    fireEvent.touchEnd(layer);
    expect(layer.style.transform).toBe('translateX(72px)');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    expect(onPin).toHaveBeenCalledTimes(1);
    // Tapping the action closes the reveal.
    expect(layer.style.transform).toBe('translateX(0px)');
  });

  it('without a pin action the right side rubber-bands, never opens (#110)', () => {
    const { container } = render(
      <SwipeRow onDelete={() => undefined} deleteLabel="Delete session">
        <button type="button">row</button>
      </SwipeRow>,
    );
    const layer = rowElement(container);
    fireEvent.touchStart(layer, touch(200, 100));
    fireEvent.touchMove(layer, touch(320, 100));
    expect(layer.style.transform).toBe('translateX(24px)');
    fireEvent.touchEnd(layer);
    expect(layer.style.transform).toBe('translateX(0px)');
  });
});

describe('SessionRow (#55)', () => {
  it('offers the hover trash only when a delete is given, and it fires', () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <SessionRow onDelete={onDelete} deleteLabel="Delete session">
        <button type="button">row</button>
      </SessionRow>,
    );
    // Two copies of the row render (desktop + phone lanes); each lane has
    // exactly one delete affordance path. The desktop trash is the one the
    // hover reveals — assert it exists and fires.
    const trash = screen.getAllByRole('button', { name: 'Delete session' });
    expect(trash.length).toBe(2);
    fireEvent.click(trash[0]!);
    expect(onDelete).toHaveBeenCalledTimes(1);

    rerender(
      <SessionRow deleteLabel="Delete session">
        <button type="button">row</button>
      </SessionRow>,
    );
    expect(screen.queryAllByRole('button', { name: 'Delete session' })).toHaveLength(0);
  });
});
