import { useTheme } from 'next-themes';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from 'lucide-react';

/**
 * Toast container (03-interaction.md §3). Mount once near the app root; call
 * `toast()` anywhere.
 *
 * Sonner's own palette (`richColors`) is switched OFF: it ships its own hues,
 * which is exactly what made toasts look like a different product. The surface
 * is the `Note`'s material instead — panel background, 1px frame, a 3px tone
 * edge on the left, mono body — with every colour read from the semantic
 * tokens, so a skin restyles it without a component change (`index.css` owns
 * the per-type edges and icon inks). The 106 `toast.*` call sites are
 * untouched: the engine and the API stay, the surface changes.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();
  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        error: <CircleAlertIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        loading: <LoaderCircleIcon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast: 'hnx-toast',
          title: 'role-data-sm',
          description: 'text-muted-foreground role-data-sm',
        },
      }}
      style={
        {
          '--normal-bg': 'var(--card)',
          '--normal-text': 'var(--foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
