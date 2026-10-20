import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  /** The thing being acted on, shown prominently (e.g. the event's title). */
  subject?: string;
  /** Short facts about what happens, one per line ("3 later events are deleted too"). */
  details?: ReactNode[];
  /** A closing note, e.g. that it cannot be undone. */
  note?: ReactNode;
  confirmLabel: string;
  /** Destructive: the confirm button is red and Cancel has the focus. */
  danger?: boolean;
  /** Optional extra action shown on the left (e.g. "Export first"). It does not close the dialog. */
  extra?: ReactNode;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(async () => false);

/** In-app replacement for window.confirm: `if (await confirm({...})) ...`. */
export const useConfirm = () => useContext(ConfirmContext);

/** Renders the confirm dialog for everything below it. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);

  const ask = useCallback<Ask>((options) => new Promise((resolve) => setOpen({ options, resolve })), []);
  const close = (ok: boolean) => {
    open?.resolve(ok);
    setOpen(null);
  };

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {open && <ConfirmDialog options={open.options} onClose={close} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ options, onClose }: { options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // A destructive action starts on Cancel, so Enter alone never deletes anything.
    (options.danger ? cancelRef : confirmRef).current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [options.danger, onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={() => onClose(false)}>
      <div
        className={`modal confirm ${options.danger ? 'confirm--danger' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div className="confirm__head">
          {options.danger && (
            <span className="confirm__icon" aria-hidden>
              🗑️
            </span>
          )}
          <h2 id="confirm-title">{options.title}</h2>
        </div>
        {options.subject && <p className="confirm__subject">{options.subject}</p>}
        {options.details && options.details.length > 0 && (
          <ul className="confirm__details">
            {options.details.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        )}
        {options.note && <p className="confirm__note muted small">{options.note}</p>}
        <div className="confirm__actions">
          <div className="confirm__extra">{options.extra}</div>
          <button ref={cancelRef} type="button" className="btn" onClick={() => onClose(false)}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${options.danger ? 'btn--danger-solid' : 'btn--primary'}`}
            onClick={() => onClose(true)}
          >
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
