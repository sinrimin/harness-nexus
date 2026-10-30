// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Children, cloneElement, isValidElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { cn } from '@/lib/utils';
import { CodeBlock } from '@/components/chat/markdown-text';

/**
 * Markdown with inline annotation marks (#88 划词批注).
 *
 * Anchors are quote strings on the RENDERED text, so re-anchoring happens at
 * the text-node level: every text-bearing block splits its string children on
 * the quotes that occur in them. The split is a PURE function (no shared
 * render-pass state — StrictMode's double render made a mutable matched-set
 * silently drop every mark); which annotations actually landed is read back
 * from the committed DOM in the effect below, so a quote that no longer
 * matches this version surfaces as `lost` in the pane instead of silently
 * disappearing.
 *
 * The markdown stack is the app's one stack (see MarkdownText); the code-block
 * wrapper is shared so both surfaces render fenced code identically.
 */

export interface AnnotationMarkModel {
  id: string;
  quote: string;
  state: 'open' | 'done';
  /** Display number (1-based, creation order) — rendered as a circled figure. */
  index: number;
}

type BlockTag = 'p' | 'li' | 'td' | 'th' | 'blockquote' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

const ANNOTATED_TAGS: BlockTag[] = [
  'p',
  'li',
  'td',
  'th',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

export function AnnotatedMarkdown({
  text,
  marks,
  focusId,
  onFocusMark,
  onMatchedChange,
}: {
  text: string;
  marks: AnnotationMarkModel[];
  focusId: string | null;
  onFocusMark: (id: string) => void;
  onMatchedChange: (matched: Set<string>) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);

  const components = useMemo(() => {
    const table: Record<string, (props: { children?: ReactNode }) => ReactNode> = {};
    for (const tag of ANNOTATED_TAGS) {
      table[tag] = ({ children }) => {
        const Tag = tag;
        return (
          <Tag>
            {children === undefined
              ? null
              : annotateNodes(Children.toArray(children), marks, focusId, onFocusMark)}
          </Tag>
        );
      };
    }
    return table;
  }, [marks, focusId, onFocusMark]);

  // Truth is what the user sees: read the landed marks off the committed DOM.
  useEffect(() => {
    const landed = new Set(
      [...(rootRef.current?.querySelectorAll('mark[data-annotation]') ?? [])].map(
        (m) => (m as HTMLElement).dataset.annotation ?? '',
      ),
    );
    onMatchedChange(landed);
  }, [text, marks, onMatchedChange]);

  return (
    <div
      ref={rootRef}
      className="markdown-body text-muted-foreground min-w-0 text-sm leading-relaxed break-words"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          ...components,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function annotateNodes(
  nodes: ReactNode[],
  marks: AnnotationMarkModel[],
  focusId: string | null,
  onFocusMark: (id: string) => void,
): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      return annotateString(node, marks, focusId, onFocusMark, `s${i}`);
    }
    if (isValidElement(node)) {
      const children = (node.props as { children?: ReactNode }).children;
      if (children === undefined) return node;
      return cloneElement(
        node,
        undefined,
        annotateNodes(Children.toArray(children), marks, focusId, onFocusMark),
      );
    }
    return node;
  });
}

/**
 * Split one text node on every quote that occurs in it (pure: the same input
 * always yields the same segments, so a re-render cannot consume a match a
 * previous pass already claimed). A quote spanning inline formatting matches
 * nothing here — the pane flags it as lost.
 */
function annotateString(
  text: string,
  marks: AnnotationMarkModel[],
  focusId: string | null,
  onFocusMark: (id: string) => void,
  keyPrefix: string,
): ReactNode {
  // Occurrences of every mark's quote in this text node, left to right.
  const hits: { at: number; end: number; mark: AnnotationMarkModel }[] = [];
  for (const mark of marks) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(mark.quote, from);
      if (at < 0) break;
      hits.push({ at, end: at + mark.quote.length, mark });
      from = at + mark.quote.length;
    }
  }
  if (hits.length === 0) return text;
  hits.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let cursor = 0;
  let n = 0;
  // Overlapping quotes (one selection inside another): first come, first marked.
  for (const hit of hits) {
    if (hit.at < cursor) continue;
    if (hit.at > cursor) out.push(text.slice(cursor, hit.at));
    out.push(
      <Mark
        key={`${keyPrefix}-${n++}`}
        mark={hit.mark}
        focused={focusId === hit.mark.id}
        onFocus={onFocusMark}
      >
        {hit.mark.quote}
      </Mark>,
    );
    cursor = hit.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function Mark({
  mark,
  focused,
  onFocus,
  children,
}: {
  mark: AnnotationMarkModel;
  focused: boolean;
  onFocus: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <mark
      data-annotation={mark.id}
      data-state={mark.state}
      data-focus={focused ? 'true' : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onFocus(mark.id);
      }}
      className={cn(
        // text-inherit: the UA paints <mark> black, unreadable on dark.
        'text-inherit box-decoration-clone cursor-pointer rounded-sm border-b-2 px-px',
        mark.state === 'open'
          ? 'border-b-signal bg-signal/10'
          : 'border-b-lamp-off bg-muted/60 [border-bottom-style:dashed]',
        focused && 'bg-signal/20',
      )}
    >
      {children}
      <sup
        className={cn(
          'role-data-sm ml-0.5 align-super text-[9px] font-medium',
          mark.state === 'open' ? 'text-signal' : 'text-muted-foreground',
        )}
      >
        {circled(mark.index)}
      </sup>
    </mark>
  );
}

/** ①–⑩ for the first ten; plain numbers after (annotation counts stay small). */
export function circled(index: number): string {
  const chars = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  return index >= 1 && index <= 10 ? chars[index - 1]! : String(index);
}
