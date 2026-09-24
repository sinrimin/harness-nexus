import { isValidElement, memo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useCopyFeedback } from './copy-feedback.js';

/**
 * Streaming markdown body (Phase 9 W6). One markdown stack for the whole chat
 * surface: react-markdown + remark-gfm + rehype-highlight, self-hosted (no
 * CDN — the font rule generalizes to every asset). The `streaming` caret goes
 * ONLY on the live last block. Fenced code keeps rehype-highlight's span tree
 * (never re-stringified) and gains a language tag + copy button on the `pre`
 * wrapper. Mermaid stays a plain code block (diagram rendering deferred).
 */

/** Recursively collect the literal text of a rendered node tree (copy source). */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

function PreBlock({ children }: { children?: ReactNode }) {
  const { copied, onCopy } = useCopyFeedback();
  const child = Array.isArray(children) ? children[0] : children;
  const className = isValidElement(child)
    ? ((child.props as { className?: string }).className ?? '')
    : '';
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? '';
  const code = nodeText(children);
  return (
    <div data-surface="well" className="bg-muted group/code my-2 overflow-hidden rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-1">
        <span className="text-muted-foreground font-mono text-[10px] uppercase">
          {language === '' ? 'code' : language}
        </span>
        <button
          type="button"
          onClick={() => onCopy(code)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded px-1 py-0.5 transition-colors"
          aria-label="Copy code"
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">{children}</pre>
    </div>
  );
}

interface MarkdownTextProps {
  text: string;
  /** Live last block only — renders the trailing caret. */
  streaming?: boolean;
}

export const MarkdownText = memo(function MarkdownText({ text, streaming }: MarkdownTextProps) {
  return (
    <div
      className="markdown-body text-muted-foreground min-w-0 text-sm leading-relaxed break-words"
      data-streaming={streaming || undefined}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <PreBlock>{children}</PreBlock>,
          code: ({ className, children, ...props }) => {
            const isBlock = typeof className === 'string' && className.includes('language-');
            if (!isBlock) {
              return (
                <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]" {...props}>
                  {children}
                </code>
              );
            }
            return <code className={className}>{children}</code>;
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-signal underline-offset-4 hover:underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming ? (
        <span
          className="bg-signal lamp-breath ml-0.5 inline-block h-4 w-[2px] translate-y-0.5"
          aria-hidden
        />
      ) : null}
    </div>
  );
});
