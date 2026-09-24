import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { DataText } from './text';
import { Well } from './well';

/**
 * CommandLine — a command the reader is meant to run (02-content.md §4).
 *
 * Yesterday this was a bare `<pre>` inside a dash-bordered card: not copyable,
 * and its `<placeholder>` tokens sat at the same visual weight as the real
 * values, so the one part that had to be replaced before running was the one
 * part you could not see. Here the placeholders are marked *in place* and
 * listed under the block, and both come from the same scan of the string — the
 * note cannot disagree with the command.
 */

const PLACEHOLDER = /<[^<>\s]+>/g;

/** The `<name>` tokens a command expects the reader to substitute. */
export function commandPlaceholders(command: string): string[] {
  const found = command.match(PLACEHOLDER) ?? [];
  return [...new Set(found)];
}

/** Split a command into text runs and highlighted placeholder tokens. */
export function markPlaceholders(command: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(PLACEHOLDER.source, 'g');
  let last = 0;
  let m = re.exec(command);
  while (m !== null) {
    if (m.index > last) nodes.push(command.slice(last, m.index));
    nodes.push(
      <span key={`${m.index}`} data-slot="placeholder" className="text-state-warn-ink">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
    m = re.exec(command);
  }
  if (last < command.length) nodes.push(command.slice(last));
  return nodes;
}

type CommandLineProps = {
  /** One command, or a block of them (newlines are kept). */
  command: string;
  /** Prose under the block — where the values come from. */
  note?: ReactNode;
  className?: string;
};

export function CommandLine({ command, note, className }: CommandLineProps) {
  const { t } = useI18n();
  const text = command.trim();
  const placeholders = commandPlaceholders(text);

  return (
    <div data-slot="command-line" className={cn('flex flex-col gap-2', className)}>
      <Well variant="code" copy={text} copyAlways>
        {markPlaceholders(text)}
      </Well>
      {placeholders.length > 0 ? (
        <p className="text-muted-foreground flex flex-wrap items-baseline gap-1.5 text-xs">
          {t('kit.substitute')}
          {placeholders.map((p) => (
            <DataText key={p} size="sm" tone="warn">
              {p}
            </DataText>
          ))}
        </p>
      ) : null}
      {note !== undefined ? <p className="text-muted-foreground text-xs">{note}</p> : null}
    </div>
  );
}
