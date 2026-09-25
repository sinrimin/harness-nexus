import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/i18n';
import type { ElicitationField } from '@/realtime';
import type { ElicitationCardState } from './fold.js';

/**
 * Inline agent-question cards (Phase 9 W14.1): an ACP `elicitation/create`
 * rendered from the daemon's bounded field hints. Values ride VERBATIM as
 * the ACP `content` — the browser never rewrites what the user picked. Same
 * warn-tone chrome as permission cards: a pending question is a decision.
 * Settled cards vanish (the answer surfaces in the following assistant
 * message; permissions keep a settled line only because their choice has no
 * other visible trace).
 */

/** The draft payload an accept submits, keyed by field name. */
type DraftValue = string | number | boolean | string[];

export function ElicitationCards({
  elicitations,
  onRespond,
}: {
  elicitations: ElicitationCardState[];
  onRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values?: Record<string, DraftValue>,
  ) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2">
      {elicitations.map((e) => (
        <ElicitationCard key={e.requestId} card={e} onRespond={onRespond} labels={t} />
      ))}
    </div>
  );
}

type Labels = ReturnType<typeof useI18n>['t'];

function ElicitationCard({
  card,
  onRespond,
  labels,
}: {
  card: ElicitationCardState;
  onRespond: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values?: Record<string, DraftValue>,
  ) => void;
  labels: Labels;
}) {
  const [values, setValues] = useState<Record<string, DraftValue>>({});

  const missingRequired = useMemo(
    () =>
      card.fields.some(
        (f) =>
          f.required &&
          (values[f.name] === undefined ||
            (typeof values[f.name] === 'string' && (values[f.name] as string).trim() === '')),
      ),
    [card.fields, values],
  );

  const submit = (): void => {
    if (missingRequired) return;
    // Empty strings (a cleared/never-touched optional input) stay OUT of the
    // payload — the adapter validates `content` against its own schema.
    const payload: Record<string, DraftValue> = {};
    for (const [k, v] of Object.entries(values)) if (v !== '') payload[k] = v;
    onRespond(card.requestId, 'accept', payload);
  };

  return (
    <div className="border-warn/50 bg-warn/5 rounded-md border p-3 text-sm">
      <p className="mb-1.5 font-medium">
        {card.message !== '' ? card.message : labels('chat.elicitationAsk')}
      </p>
      {card.fields.length === 0 ? (
        <p className="text-muted-foreground mb-2 text-xs">
          {labels('chat.elicitationUnrenderable')}
        </p>
      ) : (
        <div className="mb-2 flex flex-col gap-2.5">
          {card.fields.map((f) => (
            <FieldInput
              key={f.name}
              field={f}
              value={values[f.name]}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
              labels={labels}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={submit} disabled={card.fields.length === 0 || missingRequired}>
          {labels('chat.elicitationSubmit')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond(card.requestId, 'decline')}>
          {labels('chat.elicitationDecline')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond(card.requestId, 'cancel')}>
          {labels('chat.elicitationCancel')}
        </Button>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  labels,
}: {
  field: ElicitationField;
  value: DraftValue | undefined;
  onChange: (v: DraftValue) => void;
  labels: Labels;
}) {
  const id = `eli-${field.name}`;
  const title = field.title ?? field.name;
  const meta = field.required
    ? labels('chat.elicitationRequired')
    : labels('chat.elicitationOptional');

  const header = (
    <Label htmlFor={id} className="text-xs font-normal">
      {title} <span className="text-muted-foreground">({meta})</span>
      {field.description !== undefined && field.description !== '' ? (
        <span className="text-muted-foreground block">{field.description}</span>
      ) : null}
    </Label>
  );

  if (field.type === 'enum' && field.options !== undefined) {
    const current = typeof value === 'string' ? value : undefined;
    return (
      <div className="flex flex-col gap-1">
        {header}
        <div className="flex flex-col gap-1">
          {field.options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-start gap-2">
              <input
                type="radio"
                name={id}
                checked={current === o.value}
                onChange={() => onChange(o.value)}
                className="accent-primary mt-0.5"
              />
              <span className="text-sm">
                {o.label ?? o.value}
                {o.description !== undefined && o.description !== '' ? (
                  <span className="text-muted-foreground block text-xs">{o.description}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'multi' && field.options !== undefined) {
    const current = Array.isArray(value) ? value : [];
    return (
      <div className="flex flex-col gap-1">
        {header}
        <div className="flex flex-col gap-1">
          {field.options.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={current.includes(o.value)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true ? [...current, o.value] : current.filter((v) => v !== o.value),
                  )
                }
              />
              <span className="text-sm">{o.label ?? o.value}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={value === true} onCheckedChange={(c) => onChange(c === true)} />
        {header}
      </div>
    );
  }

  if (field.type === 'number' || field.type === 'integer') {
    return (
      <div className="flex flex-col gap-1">
        {header}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="h-(--control-h-sm) w-48"
          placeholder={field.placeholder}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === '') {
              onChange('');
              return;
            }
            const parsed = field.type === 'integer' ? Number.parseInt(raw, 10) : Number(raw);
            onChange(Number.isNaN(parsed) ? '' : parsed);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {header}
      <Input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="h-(--control-h-sm)"
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
