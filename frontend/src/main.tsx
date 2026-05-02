import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n/useT";
import "./index.css";

// ErrorBoundary wraps I18nProvider rather than the other way round so
// even a crash inside the i18n machinery itself still renders the
// fallback (the boundary reads the locale from localStorage directly).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
