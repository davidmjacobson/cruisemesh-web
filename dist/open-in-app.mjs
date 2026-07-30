// The "Open in CruiseMesh" button, shared by both card pages.
//
// It must address the app over the cruisemesh:// scheme rather than the https
// link this page is already served from. **iOS does not fire a Universal Link
// for a same-domain navigation**, so a button on cruisemesh.app pointing back
// at cruisemesh.app is inert in Safari by design — which is exactly what a
// buyer reported on /r (2026-07-27: "copy/paste directions worked, 'open in
// CruiseMesh' did not"). Chrome declines the same navigation for the same
// reason, so the button was dead on both platforms. A custom scheme fires
// regardless of the page's origin. The app has claimed cruisemesh://f, ://r
// and ://lan since 1.0.4 (app PR #166).
//
// Only the on-page buttons need the scheme. Links that arrive from somewhere
// else — the purchase email, a message from a friend, the setup QR — are
// cross-origin, so their https form fires the Universal / App Link normally
// and still lands a phone without the app on this page. Those stay https.
//
// Nothing can ask a browser whether a scheme is registered, so an app older
// than 1.0.4 — or no app at all, or a desktop browser — fails, silently in
// Chrome and with "Safari cannot open the page" on iOS. The page therefore
// arms a timer when the button is tapped and, if it is still on screen when
// that timer fires, says so and points at the copy/paste path that always
// works. That is the whole fallback: there is no second link worth trying,
// because the https one is the one that does not work here.

// Long enough that a real app launch backgrounds the page first, short enough
// that someone who is stuck is not left watching a page that says nothing.
const FALLBACK_DELAY_MS = 1500;

/// The app-scheme link for a card: `cruisemesh://r#CMRELAY1:...`.
///
/// Both shells resolve the destination from the scheme and host and then read
/// the card from the fragment, so the card stays after the `#` here exactly as
/// it does in the https link — it never reaches this website or Cloudflare.
export function appLink(route, card) {
  return `cruisemesh://${route}#${card}`;
}

/// Attach the did-it-open check to the button. Call once per page; set the
/// button's href with `appLink` whenever the card is known.
export function armOpenButton({ button, notice, message }) {
  button.addEventListener("click", () => {
    let timer = 0;
    const stop = () => {
      clearTimeout(timer);
      removeEventListener("visibilitychange", onVisibilityChange);
      removeEventListener("pagehide", stop);
    };
    // The app opening backgrounds this page; that is the success signal, and
    // the only one available.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stop();
    };
    addEventListener("visibilitychange", onVisibilityChange);
    addEventListener("pagehide", stop);
    timer = setTimeout(() => {
      stop();
      if (document.visibilityState === "visible") notice.textContent = message;
    }, FALLBACK_DELAY_MS);
  });
}
