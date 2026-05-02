import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { tr } from "../i18n/dict";
import type { Locale, DictKey } from "../i18n/dict";

// Class component because hooks (useT) can't be used inside the
// componentDidCatch lifecycle. We read the locale straight off
// localStorage / navigator instead — the i18n provider may itself
// be unmounted by the error.

interface Props { children: ReactNode }
interface State { error: Error | null }

function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem("chiyigo.locale") as Locale | null;
    if (saved === "zh-TW" || saved === "en") return saved;
  } catch { /* SSR / disabled storage */ }
  if (typeof navigator !== "undefined" && navigator.language?.startsWith("zh")) return "zh-TW";
  return "en";
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface in the console so the user can report a stack trace.
    // Production logging hook would go here; we don't ship one.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    const locale = detectLocale();
    const t = (key: DictKey) => tr(locale, key);
    const err = this.state.error;
    const detail = `${err.name}: ${err.message}\n${err.stack ?? ""}`;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex w-full max-w-md flex-col gap-3 rounded-2xl bg-green-900 p-5 shadow-2xl ring-1 ring-red-500/40">
          <h2 className="text-lg font-bold text-red-300">⚠️ {t("boundary.title")}</h2>
          <p className="text-sm text-yellow-100">{t("boundary.body")}</p>
          <button
            onClick={() => location.reload()}
            className="rounded-md bg-yellow-500 px-4 py-2 text-sm font-bold text-green-950 hover:bg-yellow-400"
          >{t("boundary.reload")}</button>
          <details className="text-[11px] text-green-300">
            <summary className="cursor-pointer font-bold text-green-400">
              {t("boundary.details")}
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-green-950/60 p-2 font-mono text-[10px] text-red-200">
              {detail}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
