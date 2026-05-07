// Phone-only nag that takes over the screen when the device is held in
// portrait. The actual game canvases assume landscape (CSS grid + 16:9
// hand layouts), so blocking portrait is simpler than reflowing.
//
// Tailwind's `portrait:` variant gates this on the media query — when
// in landscape the entire wrapper collapses to `hidden`.
//
// P6: added a best-effort "tap to enter fullscreen" button that combines
// requestFullscreen + screen.orientation.lock("landscape"). Both APIs
// require a user gesture and silently no-op on iOS Safari (which has
// neither), so the rotation copy remains the primary fallback.

import { useState } from "react";
import { useT } from "../i18n/useT";
import { Lock, RefreshCw } from "./Icons";

export default function RotateHint() {
  const { t } = useT();
  const [err, setErr] = useState<string>("");

  async function tryLockLandscape() {
    setErr("");
    try {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        await el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      }
      const orient = (screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
      if (orient?.lock) await orient.lock("landscape");
    } catch {
      // iOS Safari throws / lacks API — fall back to manual rotate copy.
      setErr(t("orient.lockUnsupported"));
    }
  }

  return (
    <div className="hidden portrait:fixed portrait:inset-0 portrait:z-[9999] portrait:flex portrait:flex-col portrait:items-center portrait:justify-center portrait:bg-black portrait:px-6 portrait:text-center portrait:text-yellow-300">
      <div className="animate-spin"><RefreshCw size={72} /></div>
      <div className="mt-6 text-xl tracking-widest">{t("orient.rotate")}</div>
      <p className="mt-2 max-w-xs text-xs text-yellow-500/80">{t("orient.why")}</p>

      <button
        onClick={tryLockLandscape}
        className="tap44 mt-6 inline-flex items-center gap-2 rounded-xl bg-yellow-400 px-6 py-3 text-sm font-bold text-green-950 hover:bg-yellow-300 active:scale-95"
      >
        <Lock size={16} />
        {t("orient.tryLock")}
      </button>
      <p className="mt-2 max-w-xs text-[10px] text-yellow-500/60">{t("orient.tryLockHint")}</p>
      {err && <p className="mt-1 max-w-xs text-[10px] text-red-400">{err}</p>}
    </div>
  );
}
