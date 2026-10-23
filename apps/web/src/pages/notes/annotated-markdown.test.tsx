// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { AnnotatedMarkdown } from './AnnotatedMarkdown';

describe('AnnotatedMarkdown', () => {
  it('renders an inline mark when the quote matches a text node', () => {
    const { container } = render(
      <StrictMode>
        <AnnotatedMarkdown
          text={'前置文字。目标句子在此处出现，后续还有内容。\n\n## 标题\n\n- 列表项'}
          marks={[{ id: 'a1', quote: '目标句子在此处出现', state: 'open', index: 1 }]}
          focusId={null}
          onFocusMark={() => undefined}
          onMatchedChange={() => undefined}
        />
      </StrictMode>,
    );
    const mark = container.querySelector<HTMLElement>('mark[data-annotation="a1"]');
    expect(mark).not.toBeNull();
    expect(mark?.dataset.state).toBe('open');
  });
});
