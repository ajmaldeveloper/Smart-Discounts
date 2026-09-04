/**
 * Winslet announcement bar. Same distribution model as the other
 * widgets in this directory (see free-shipping-bar.js's own header
 * comment for the full rationale): a loader <script> pasted once in
 * theme.liquid, and a separate, pure-HTML placement tag pasted
 * wherever the merchant wants it to show.
 *
 * Unlike the free-shipping bar and BOGO picker, this widget carries no
 * campaign/cart logic at all — it's a static, merchant-written message
 * plus an optional CTA link and a dismiss button. Still shares the
 * same config-cache + retry + self-heal patterns as the other two
 * widgets so it survives a theme's AJAX drawer/section morph the same
 * way they do.
 */
(function () {
  var TAG = "winslet-announcement-bar";
  if (customElements.get(TAG)) return;

  var CONFIG_REFRESH_MS = 60000;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-ab-shared-style";
  var sharedConfig = null;
  // Deliberately NOT persisted to localStorage/sessionStorage: a
  // dismiss should only hide the bar for the CURRENT page view (it
  // survives a theme's AJAX cart-drawer morph, same as sharedConfig/
  // sharedCart elsewhere in this file, since that isn't a real
  // navigation) — a genuine page reload re-runs this whole script from
  // scratch, resetting this back to false, so the bar always comes
  // back on the next visit even if the merchant hasn't changed the
  // message.
  var sharedDismissed = false;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      TAG +
      "{display:flex;align-items:center;justify-content:center;gap:12px;padding:var(--winslet-ab-padding-top) var(--winslet-ab-padding-right) var(--winslet-ab-padding-bottom) var(--winslet-ab-padding-left);font-size:var(--winslet-ab-font-size);text-align:center;}" +
      TAG +
      " .winslet-ab__message{margin:0;}" +
      TAG +
      " .winslet-ab__cta{text-decoration:underline;font-weight:600;white-space:nowrap;color:inherit;}" +
      TAG +
      " .winslet-ab__dismiss{appearance:none;background:none;border:none;padding:0;margin-left:4px;font-size:1.2em;line-height:1;cursor:pointer;color:inherit;opacity:0.7;}" +
      TAG +
      " .winslet-ab__dismiss:hover{opacity:1;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      TAG +
      "{padding:var(--winslet-ab-mobile-padding-top) var(--winslet-ab-mobile-padding-right) var(--winslet-ab-mobile-padding-bottom) var(--winslet-ab-mobile-padding-left);font-size:var(--winslet-ab-mobile-font-size);}" +
      "}";
    document.head.appendChild(style);
  }

  class AnnouncementBar extends HTMLElement {
    connectedCallback() {
      this.proxyRoot = this.dataset.proxyRoot || "/apps/winslet";
      this.config = null;

      ensureSharedStyle();
      this.buildMarkup(true);
      this.watchForMorph();

      if (sharedConfig) {
        this.applyConfig(sharedConfig);
      }
      this.loadConfig();
      this.configInterval = setInterval(() => this.loadConfig(), CONFIG_REFRESH_MS);
    }

    disconnectedCallback() {
      clearInterval(this.configInterval);
      if (this.morphObserver) this.morphObserver.disconnect();
    }

    buildMarkup(hide) {
      if (hide) this.style.display = "none";
      this.innerHTML = '<p class="winslet-ab__message"></p>';
      this.messageEl = this.querySelector(".winslet-ab__message");
    }

    watchForMorph() {
      this.morphObserver = new MutationObserver(() => {
        if (!this.messageEl || !this.contains(this.messageEl)) {
          this.buildMarkup(false);
          if (this.config) this.applyConfig(this.config);
        }
      });
      this.morphObserver.observe(this, { childList: true });
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/announcement-bar", { headers: { accept: "application/json" } })
        .then((response) => {
          if (!response.ok) throw new Error("bad status " + response.status);
          return response.json();
        })
        .then((config) => {
          sharedConfig = config;
          this.applyConfig(config);
        })
        .catch(() => {
          if (attemptsLeft > 0) setTimeout(() => this.loadConfig(attemptsLeft - 1), 1000);
        });
    }

    applyConfig(config) {
      this.config = config;
      if (!config.active || !config.message) {
        this.style.display = "none";
        return;
      }
      if (sharedDismissed) {
        this.style.display = "none";
        return;
      }

      this.style.backgroundColor = config.backgroundColor;
      this.style.color = config.textColor;
      this.style.setProperty("--winslet-ab-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-ab-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-ab-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-ab-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-ab-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-ab-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-ab-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-ab-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-ab-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-ab-mobile-padding-right", config.mobilePaddingRight + "px");

      this.messageEl.textContent = config.message;

      var existingCta = this.querySelector(".winslet-ab__cta");
      if (existingCta) existingCta.remove();
      if (config.ctaUrl && config.ctaLabel) {
        var cta = document.createElement("a");
        cta.className = "winslet-ab__cta";
        cta.href = config.ctaUrl;
        cta.textContent = config.ctaLabel;
        this.appendChild(cta);
      }

      var existingDismiss = this.querySelector(".winslet-ab__dismiss");
      if (existingDismiss) existingDismiss.remove();
      if (config.dismissible) {
        var dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "winslet-ab__dismiss";
        dismiss.setAttribute("aria-label", "Dismiss");
        dismiss.textContent = "×";
        dismiss.addEventListener("click", () => {
          sharedDismissed = true;
          this.style.display = "none";
        });
        this.appendChild(dismiss);
      }

      this.style.display = "flex";
    }
  }

  customElements.define(TAG, AnnouncementBar);
})();
