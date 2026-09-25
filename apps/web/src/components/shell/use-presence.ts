import { useEffect, useRef } from 'react';
import { appSocket, type MachineStatusEvent } from '@/realtime';

/**
 * The `machine:status` subscription, once (04-contract.md §5).
 *
 * The patch itself is pure and lives in `lib/machine-presence.ts`; this file is
 * only the wire. The handler is read through a ref so a caller can pass an
 * inline closure without re-subscribing socket listeners on every render.
 */
export function useMachineStatus(handler: (e: MachineStatusEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const socket = appSocket();
    const onStatus = (e: MachineStatusEvent): void => ref.current(e);
    socket.on('machine:status', onStatus);
    return () => {
      socket.off('machine:status', onStatus);
    };
  }, []);
}
