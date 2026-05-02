// Service worker registration. Lives outside index.html so the page
// can ship a strict CSP that forbids inline scripts.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
}
