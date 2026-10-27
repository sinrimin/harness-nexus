// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { MarkdownText } from './markdown-text.js';

/**
 * Mermaid fences (#93) — the mechanical contract only: a `language-mermaid`
 * fence swaps the well body for the lazily loaded mermaid view (strict
 * security, classic look, token-derived theme variables), anything that does
 * not parse — including a streaming half-fence — keeps the plain code block,
 * and other languages are untouched. Visual correctness is the agent-browser
 * pass.
 */

const { initMock, parseMock, renderMock } = vi.hoisted(() => ({
  initMock: vi.fn(),
  parseMock: vi.fn(),
  renderMock: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: { initialize: initMock, parse: parseMock, render: renderMock },
}));

function ui(text: string) {
  return (
    <I18nProvider>
      <SkinProvider>
        <MarkdownText text={text} />
      </SkinProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeAll(() => {
  // jsdom has no 2D canvas; the palette then falls back to its system colors.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

describe('mermaid fences (#93)', () => {
  it('renders a language-mermaid fence as a diagram', async () => {
    parseMock.mockResolvedValue({ diagramType: 'flowchart' });
    renderMock.mockResolvedValue({ svg: '<svg>DIAGRAM</svg>' });
    render(ui('```mermaid\ngraph TD\n  A-->B\n```\n'));

    await waitFor(() => expect(renderMock).toHaveBeenCalledOnce());
    expect(parseMock).toHaveBeenCalledWith('graph TD\n  A-->B\n', { suppressErrors: true });
    expect(initMock).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        look: 'classic',
        theme: 'neutral',
        startOnLoad: false,
        themeVariables: expect.objectContaining({
          background: 'transparent',
          primaryColor: expect.any(String),
          primaryTextColor: expect.any(String),
          lineColor: expect.any(String),
          edgeLabelBackground: expect.any(String),
        }),
      }),
    );
    const img = await screen.findByRole('img', { name: 'Diagram' });
    expect(img.innerHTML).toContain('DIAGRAM');
  });

  it('falls back to the plain code block when the source does not parse', async () => {
    parseMock.mockResolvedValue(false);
    render(ui('```mermaid\ngraph TD\n  A--'));

    const code = await screen.findByText(/graph TD/);
    expect(code.tagName).toBe('CODE');
    expect(document.querySelector('[role="img"]')).toBeNull();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('leaves non-mermaid fences as code', () => {
    parseMock.mockResolvedValue({ diagramType: 'flowchart' });
    render(ui('```ts\nconst x = 1;\n```\n'));

    // rehype-highlight splits the source into spans — assert on whole text.
    expect(document.body.textContent).toContain('const x = 1;');
    expect(document.querySelector('[role="img"]')).toBeNull();
    expect(parseMock).not.toHaveBeenCalled();
  });
});
