import { useEffect, useRef } from 'react';

import type { SampleInspection } from '../server/system-detail-types.ts';
import { SampleInspector } from './sample-inspector.tsx';

// Native modal focus handling also gives the phone sheet keyboard dismissal.
export function SampleSheet({
  failed,
  loading,
  onClose,
  open,
  sample,
}: {
  failed: boolean;
  loading: boolean;
  onClose: () => void;
  open: boolean;
  sample: SampleInspection | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const desktop = globalThis.matchMedia('(min-width: 1024px)');
    const sync = () => {
      if (open && !desktop.matches) {
        if (element?.open === false) {
          element.showModal();
        }
      } else {
        element?.close();
      }
    };
    sync();
    desktop.addEventListener('change', sync);
    return () => {
      desktop.removeEventListener('change', sync);
      element?.close();
    };
  }, [open]);
  return (
    <dialog
      aria-labelledby="sample-sheet-title"
      className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[80dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border bg-background p-0 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-foreground backdrop:bg-black/60 lg:inset-0 lg:m-auto lg:max-w-lg lg:rounded-2xl lg:p-0"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          ) {
            onClose();
          }
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialog}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-2">
        <h2 className="text-lg font-semibold" id="sample-sheet-title">
          Vitals sample
        </h2>
        <button className="min-h-11 px-3 text-base text-primary" onClick={onClose} type="button">
          Close
        </button>
      </div>
      <div className="p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
        <SampleInspector failed={failed} loading={loading} sample={sample} />
      </div>
    </dialog>
  );
}
