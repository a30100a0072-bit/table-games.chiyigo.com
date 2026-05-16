// Flat config (ESLint 10). Minimal — focused on React Hooks correctness,
// which tsc cannot catch. unused-vars / unused-imports are already gated
// by tsconfig.json (noUnusedLocals + noUnusedParameters), so we don't
// duplicate them here.                                                   // L2_隔離

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "dist/**", "node_modules/**", "playwright-report/**", "test-results/**",
      // Service-worker / SW-register are vanilla JS using worker globals
      // (self / caches / Headers etc.). Linting them would need a separate
      // env block; TS files in src/ are where ESLint's value actually is.
      "public/**/*.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // tsc already gates these via noUnusedLocals/Parameters — turn off
      // to avoid double-reporting.
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-vars": "off",
      // Project-wide pragmatic choices:
      "@typescript-eslint/no-explicit-any": "off",  // a few intentional anys
      "no-empty": ["error", { allowEmptyCatch: true }],
      // react-hooks v7 added this React-19-flavoured opinion ("don't
      // setState synchronously in an effect"). Our codebase is React 18
      // and intentionally uses the `setError(null); fetch().then(setData)`
      // pattern for clear-then-load UX. Disable.                          // L2_隔離
      "react-hooks/set-state-in-effect": "off",
      // Stale-closure detection: this is the load-bearing reason to run
      // ESLint at all. Keep as warning so CI surfaces it without blocking
      // on every i18n-`t` false positive.                                 // L3_架構含防禦觀測
      "react-hooks/exhaustive-deps": "warn",
      // TypeScript already checks symbol resolution; eslint's no-undef
      // flags browser globals (HTMLElement, etc.) as undefined.          // L2_隔離
      "no-undef": "off",
      // react-hooks v7 added this; pragma-pass-through `send` ref ends
      // up flagged as "ref read during render" even though it's only
      // invoked from event handlers downstream. Downgrade.               // L2_隔離
      "react-hooks/refs": "warn",
      // Style-only; rare and intentional (defensive default before
      // conditional reassignment).                                       // L2_隔離
      "no-useless-assignment": "off",
      // react-hooks v7 added a purity rule that flags Date.now() during
      // render. Our use is a display-only "X minutes ago" computation
      // on a WS-driven feed that re-renders on every frame anyway —
      // staleness is bounded to the next WS update, which is fine.      // L2_隔離
      "react-hooks/purity": "off",
    },
  },
];
