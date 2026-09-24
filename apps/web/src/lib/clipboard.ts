import { useCallback, useRef, useState } from 'react';

/** Copy a string to the clipboard with a short "copied" settle. */
export function useCopyFeedback(settleMs = 1000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const onCopy = useCallback(
    (text: string) => {
      if (text === '') return;
      navigator.clipboard
        ?.writeText(text)
        .then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), settleMs);
        })
        .catch(() => undefined);
    },
    [settleMs],
  );
  return { copied, onCopy };
}
