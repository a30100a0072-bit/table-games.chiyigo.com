import { useT, LOCALES, LOCALE_LABEL } from "../i18n/useT";

export default function LocaleToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useT();
  return (
    <div className={["flex gap-1 rounded-full bg-green-800/80 p-0.5 text-xs", className ?? ""].join(" ")}>
      {LOCALES.map(l => (
        <button
          key={l}
          onClick={() => setLocale(l)}
          className={[
            "rounded-full px-2.5 py-0.5 font-bold transition",
            l === locale ? "bg-yellow-400 text-green-950" : "text-green-200 hover:text-yellow-200",
          ].join(" ")}
        >
          {LOCALE_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
