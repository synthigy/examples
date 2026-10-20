// examples/shared/chrome.js — the page behaviour every demo shares, paired
// with theme.css. Load it right after tools-rail.js.
//
// 1. No flash of un-upgraded tags: theme.css keeps <body> invisible until
//    <html> carries .ty-ready; this sets it once the Tyrell components the
//    page uses are defined (or after 2s, whatever happens).
// 2. The tools dock (Model / Console / Logs) sits in the footer, in
//    #footer-tools, instead of floating over the page. tools-rail.js builds
//    it on DOMContentLoaded when the page is still parsing, so this waits on
//    the same event, registered after it, and runs second.
(function () {
  var reveal = function () { document.documentElement.classList.add("ty-ready"); };
  if (window.customElements) {
    Promise.all(["ty-button", "ty-tag", "ty-icon"].map(function (n) {
      return customElements.whenDefined(n);
    })).then(reveal);
  }
  setTimeout(reveal, 2000);

  function dock() {
    var d = document.querySelector(".syn-tools-dock");
    var slot = document.getElementById("footer-tools");
    if (d && slot && d.parentNode !== slot) slot.appendChild(d);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", dock);
  else dock();
})();
