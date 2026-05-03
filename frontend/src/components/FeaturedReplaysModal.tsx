import { useEffect, useState } from "react";
import { listFeaturedReplaysApi, formatApiError, type FeaturedReplay } from "../api/http";
import { useT } from "../i18n/useT";
import { useEscapeClose } from "../hooks/useEscapeClose";
import { useFocusTrap } from "../hooks/useFocusTrap";

interface Props {
  /** Opens the shared-replay viewer for this token (delegated to App). */
  onOpenShared: (shareToken: string) => void;
  onClose: () => void;
}

const ICON: Record<string, string> = { bigTwo: "🃏", mahjong: "🀄", texas: "♠️" };

export default function FeaturedReplaysModal({ onOpenShared, onClose }: Props) {
  const { t } = useT();
  const [items, setItems] = useState<FeaturedReplay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEscapeClose(onClose);
  const trapRef = useFocusTrap<HTMLDivElement>();

  useEffect(() => {
    listFeaturedReplaysApi(undefined, 30)
      .then(r => setItems(r.featured))
      .catch(e => setError(formatApiError(e, t)))
      .finally(() => setLoading(false));
  }, [t]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70 px-4" role="dialog" aria-modal="true" ref={trapRef}>
      <div className="w-full max-w-md rounded-2xl bg-green-900 p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-yellow-300">{t("rep.featured")}</h2>
          <button onClick={onClose} className="text-green-400 hover:text-yellow-300" aria-label={t("common.close")}>✕</button>
        </div>
        {loading && <p className="text-center text-sm text-green-300">{t("common.loading")}</p>}
        {error && <p className="text-center text-sm text-red-400">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="text-center text-sm text-green-400">{t("rep.featuredEmpty")}</p>
        )}
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
          {items.map(it => (
            <button
              key={it.gameId}
              onClick={() => onOpenShared(it.shareToken)}
              className="flex items-start gap-3 rounded-xl bg-green-950/60 p-3 text-left ring-1 ring-green-700 hover:bg-green-950"
            >
              <span className="text-2xl">{ICON[it.gameType] ?? "🎮"}</span>
              <span className="flex-1">
                <span className="block text-sm font-bold text-yellow-200">
                  {it.playerIds.join(" · ")}
                </span>
                {it.note && <span className="mt-0.5 block text-xs text-green-300">{it.note}</span>}
                <span className="mt-1 block text-[10px] text-green-500">
                  {new Date(it.finishedAt).toLocaleString()}
                  {it.viewCount > 0 && ` · 👁 ${it.viewCount}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
