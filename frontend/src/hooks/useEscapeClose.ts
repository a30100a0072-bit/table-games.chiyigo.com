// /frontend/src/hooks/useEscapeClose.ts
// Wires Escape-key dismissal for modal-style overlays. The handler is
// installed at the document level (not on the modal node) so it fires
// regardless of focus location — including the common case where the
// user has clicked into a text field inside the modal.
//
// Pass `enabled = false` to suspend (e.g. when a confirm-typed-DELETE
// gate is active and you don't want Escape to short-circuit it).

import { useEffect } from "react";

export function useEscapeClose(onClose: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}
