'use client';

/**
 * Branded replacement for window.confirm() and window.alert().
 *
 * Usage:
 *   const dialog = useDialog();
 *   if (await dialog.confirm({ title: 'Delete?', message: '...' })) { ... }
 *   await dialog.alert({ title: 'Saved', message: 'All done.' });
 *
 * Wrap the tree once with <DialogProvider> (already done inside AuthGuard
 * so every authenticated page gets it for free).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Variant = 'default' | 'destructive';

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: Variant;
}

interface AlertOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  variant?: 'info' | 'success' | 'error';
}

interface DialogState {
  kind: 'confirm' | 'alert';
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant: 'default' | 'destructive' | 'info' | 'success' | 'error';
  resolve: (val: boolean) => void;
}

interface DialogApi {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  alert: (opts: AlertOpts) => Promise<void>;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    // Soft fallback so the app doesn't crash if a component renders outside
    // the provider during dev. Should never happen in production.
    return {
      confirm: async opts => window.confirm(`${opts.title}\n\n${typeof opts.message === 'string' ? opts.message : ''}`),
      alert: async opts => { window.alert(`${opts.title}\n\n${typeof opts.message === 'string' ? opts.message : ''}`); },
    };
  }
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);

  const confirm = useCallback((opts: ConfirmOpts) => {
    return new Promise<boolean>(resolve => {
      setState({
        kind: 'confirm',
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        variant: opts.variant || 'default',
        resolve,
      });
    });
  }, []);

  const alert = useCallback((opts: AlertOpts) => {
    return new Promise<void>(resolve => {
      setState({
        kind: 'alert',
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel || 'OK',
        variant: opts.variant || 'info',
        resolve: () => resolve(),
      });
    });
  }, []);

  const api = useMemo<DialogApi>(() => ({ confirm, alert }), [confirm, alert]);

  // Esc closes (cancel for confirm, OK for alert)
  useEffect(() => {
    if (!state) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handle(false);
      if (e.key === 'Enter' && state?.kind === 'alert') handle(true);
    }
    function handle(value: boolean) {
      if (state) { state.resolve(value); setState(null); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  function close(value: boolean) {
    if (!state) return;
    state.resolve(value);
    setState(null);
  }

  // Variant → button colours
  const confirmBg =
    state?.variant === 'destructive' ? '#DC2626'
    : state?.variant === 'error' ? '#DC2626'
    : state?.variant === 'success' ? '#0D8A9E'
    : '#0D8A9E';
  const confirmHover =
    state?.variant === 'destructive' ? '#B91C1C'
    : state?.variant === 'error' ? '#B91C1C'
    : '#0a6c7c';
  const headerAccent =
    state?.variant === 'destructive' || state?.variant === 'error' ? '#DC2626'
    : state?.variant === 'success' ? '#16A34A'
    : '#0D8A9E';

  return (
    <DialogContext.Provider value={api}>
      {children}
      {state && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="um-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ backgroundColor: 'rgba(15, 23, 33, 0.55)', backdropFilter: 'blur(2px)' }}
          onClick={e => {
            // click-outside cancels confirm dialogs only; alerts must be acknowledged
            if (e.target === e.currentTarget && state.kind === 'confirm') close(false);
          }}
        >
          <div
            className="bg-white rounded-lg shadow-xl border border-slate-200 w-full max-w-md overflow-hidden"
            style={{ animation: 'um-dialog-pop 140ms ease-out' }}
          >
            <div
              className="h-1.5 w-full"
              style={{ backgroundColor: headerAccent }}
            />
            <div className="px-6 pt-5 pb-2">
              <h2
                id="um-dialog-title"
                className="text-base font-semibold text-slate-900"
              >
                {state.title}
              </h2>
              {state.message && (
                <div className="mt-2 text-sm text-slate-600 leading-relaxed">
                  {state.message}
                </div>
              )}
            </div>
            <div className="px-6 py-4 flex justify-end gap-2 bg-slate-50 border-t border-slate-100">
              {state.kind === 'confirm' && (
                <button
                  onClick={() => close(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-slate-400 transition-colors"
                >
                  {state.cancelLabel}
                </button>
              )}
              <button
                onClick={() => close(true)}
                autoFocus
                className="px-4 py-2 text-sm font-medium text-white rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1"
                style={{ backgroundColor: confirmBg }}
                onMouseEnter={e => { e.currentTarget.style.backgroundColor = confirmHover; }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = confirmBg; }}
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
          <style>{`
            @keyframes um-dialog-pop {
              from { opacity: 0; transform: scale(0.96) translateY(4px); }
              to   { opacity: 1; transform: scale(1) translateY(0); }
            }
          `}</style>
        </div>
      )}
    </DialogContext.Provider>
  );
}
