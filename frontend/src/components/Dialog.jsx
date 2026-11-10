/**
 * A modal dialog: a titled panel over a dimmed page.
 *
 *   <Dialog title="Create a task" onClose={...} size="md|lg">...</Dialog>
 *
 * Accessibility: role="dialog" with aria-modal and its title as the label; focus moves into the
 * dialog when it opens and goes back to what had it when it closes; Tab stays inside it; Escape, the
 * close button and a click on the backdrop close it; the page behind does not scroll.
 */

import { useEffect, useId, useRef } from 'react';
import { CloseIcon } from './Icons.jsx';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';
const SIZES = Object.freeze({ md: 'max-w-lg', lg: 'max-w-3xl' });

export default function Dialog({ title, onClose, size = 'md', children }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const panel = panelRef.current;
    (panel.querySelector('[data-autofocus]') ?? panel.querySelector(FOCUSABLE) ?? panel).focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function handleKeyDown(keyEvent) {
      if (keyEvent.key === 'Escape') {
        keyEvent.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (keyEvent.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll(FOCUSABLE)];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
    }
    panel.addEventListener('keydown', handleKeyDown);
    return () => {
      panel.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="fixed inset-0 bg-slate-950/50 backdrop-blur-sm"
        onClick={() => onCloseRef.current()}
      />
      {/* min-h-full: a dialog taller than the screen starts at the top and scrolls, instead of being
          centred with its top (and its close button) out of reach. */}
      <div className="pointer-events-none relative flex min-h-full items-start justify-center p-4 sm:items-center">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={`pointer-events-auto relative my-8 w-full ${SIZES[size]} rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200 focus:outline-none`}
        >
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold text-slate-900">
              {title}
            </h2>
            <button
              type="button"
              onClick={() => onCloseRef.current()}
              aria-label="Close"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <div className="px-5 py-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
