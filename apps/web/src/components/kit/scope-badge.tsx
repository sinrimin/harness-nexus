// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { GlobeIcon, UserIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';

/**
 * ScopeBadge — the one way a row's #36 scope renders (design-ui-system.md:
 * scope is an enum, so a Badge — never a Well, never hand-rolled mono text).
 * Replaces the per-page copies that had drifted apart. global = filled
 * (default variant) + globe, personal = secondary + user.
 */
export function ScopeBadge({ scope }: { scope: 'global' | 'personal' }) {
  const { t } = useI18n();
  return (
    <Badge variant={scope === 'global' ? 'default' : 'secondary'} className="gap-1">
      {scope === 'global' ? <GlobeIcon className="size-3" /> : <UserIcon className="size-3" />}
      {scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
    </Badge>
  );
}
