// Phone-only nag that takes over the screen when the device is held in
// portrait. The actual game canvases assume landscape (CSS grid + 16:9
// hand layouts), so blocking portrait is simpler than reflowing.
//
// Tailwind's `portrait:` variant gates this on the media query — when
// in landscape the entire wrapper collapses to `hidden`.

import { useT } from "../i18n/useT";

export default function RotateHint() {
  const { t } = useT();
  return (
    <div className="hidden portrait:fixed portrait:inset-0 portrait:z-[9999] portrait:flex portrait:flex-col portrait:items-center portrait:justify-center portrait:bg-black portrait:px-6 portrait:text-center portrait:text-yellow-300">
      <div className="animate-spin text-7xl">⟳</div>
      <div className="mt-6 text-xl tracking-widest">{t("orient.rotate")}</div>
      <p className="mt-2 max-w-xs text-xs text-yellow-500/80">{t("orient.why")}</p>
    </div>
  );
}
