// /frontend/src/hooks/useFocusTrap.ts
// Keeps Tab / Shift+Tab focus inside a modal subtree. On mount, moves
// focus to the first focusable element so screen readers + keyboard
// users land inside the dialog instead of remaining on the page button
// that opened it. On unmount, restores focus to whichever element had
// it before the modal opened — which is almost always the trigger.
//
// `enabled` lets a parent suspend the trap (e.g. while a confirm-typed-
// DELETE input is active and you want focus discipline elsewhere).
//
// Implementation notes:
//  - We re-query focusable elements on each Tab keypress rather than
//    caching, because modals add/remove rows (e.g. share lists) over
//    their lifetime. The selector matches the WAI-ARIA Authoring
//    Practices guidance for "tabbable" elements.
//  - The trap intentionally does NOT block Escape; useEscapeClose is
//    a sibling concern.                                                // L3_架構含防禦觀測

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  enabled: boolean = true,
): React.RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!enabled) return;
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Auto-focus first focusable element. Falls back to the container
    // itself (with tabindex=-1) so focus lands somewhere reasonable.
    const focusables = () => Array.from(
      node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(el => !el.hasAttribute("aria-hidden"));

    const initial = focusables();
    if (initial.length > 0) {
      initial[0]!.focus();
    } else {
      node.setAttribute("tabindex", "-1");
      node.focus();
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      if (!node) return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last  = list[list.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !node.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      // Restore focus to the trigger so keyboard users don't get
      // dumped at the top of the page after closing the modal.
      previouslyFocused?.focus?.();
    };
  }, [enabled]);

  return ref;
}
