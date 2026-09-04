/**
 * Winslet free-shipping progress bar. Hosted from this app's own
 * server (not a theme-extension asset) so it can be pasted into ANY
 * theme file at ANY spot — the cart drawer, the cart page, above the
 * footer — instead of being confined to wherever a "target: body" app
 * embed happens to land in the page's DOM (which turned out to be
 * right before </body>, i.e. off-screen unless force-positioned, and
 * force-positioning it — position:fixed at the top — collided with
 * themes whose own header is also fixed/sticky). Renders inline,
 * wherever its <winslet-free-shipping-bar> tag is placed — no special
 * positioning of its own, so it can never fight with a theme's header.
 *
 * Loaded via a plain <script src="..."> tag pasted ONCE into
 * theme.liquid — real full-page loads always execute a <script> tag
 * regardless of where it sits, so this only needs to run once ever to
 * register the <winslet-free-shipping-bar> custom element for the
 * whole site. The element TAG ITSELF is pasted separately, wherever
 * the merchant wants the bar to show (the cart drawer, the cart page,
 * anywhere) — that placement snippet is pure HTML, no <script> of its
 * own, which matters because a cart drawer's own AJAX refresh usually
 * replaces its markup via innerHTML, and browsers never execute a
 * <script> tag inserted that way. A plain element tag doesn't have
 * that problem: the browser auto-upgrades any matching custom element
 * the moment it appears in the DOM, no matter how it got there.
 *
 * Some themes go further and morph/patch the drawer's existing DOM
 * against fresh server-rendered HTML (rather than a full innerHTML
 * replace) — since the server-rendered placement tag has no children
 * of its own, a morph can strip everything this script built without
 * ever calling connectedCallback again (the top-level node itself is
 * preserved, just its contents get reconciled away). A MutationObserver
 * on each instance watches for exactly that and rebuilds immediately.
 *
 * Everything it needs (the real campaign threshold, the merchant's
 * chosen colors/messages/sizing) comes live from the App Proxy at
 * connect time — nothing is hand-typed into the theme, so it can never
 * drift out of sync with the real discount or the Storefront settings
 * page.
 *
 * Cart-change reactivity uses three independent signals, since theme
 * cart-update conventions vary and no single one is universal:
 *   1. The `cart:updated` / `cart:refresh` CustomEvents most modern
 *      themes dispatch after an AJAX cart change.
 *   2. A window.fetch patch that notices any request to Shopify's own
 *      /cart/add.js, /cart/update.js, /cart/change.js, /cart/clear.js
 *      endpoints and refreshes afterward — this covers themes that
 *      never dispatch the events above.
 *   3. A /cart.js poll on tab visibility change, as a last-resort
 *      catch-all for anything neither of the above sees.
 */
(function () {
  if (customElements.get("winslet-free-shipping-bar")) return;

  var CONFIG_REFRESH_MS = 60000;
  var CART_ENDPOINT_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;
  var MOBILE_BREAKPOINT = 640; // matches this developer's own product-options app
  var STYLE_ELEMENT_ID = "winslet-fsb-shared-style";
  // Cached OUTSIDE the class, shared by every instance on the page —
  // a theme's cart drawer commonly re-renders its own markup via AJAX
  // (innerHTML replacement) on every cart change, which destroys and
  // recreates this element each time. Without a shared cache, each
  // fresh instance would start hidden again and wait on a brand-new
  // fetch before showing anything, flashing invisible on every drawer
  // open. With it, a freshly (re)connected instance renders instantly
  // from whatever the page already knows, then quietly revalidates.
  var sharedConfig = null;
  // The last successfully fetched /cart.js payload, shared the same
  // way — lets a morph-triggered rebuild (see watchForMorph) repaint
  // synchronously from known data instead of a blank 0%-width frame
  // while a fresh fetch is in flight.
  var sharedCart = null;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      "winslet-free-shipping-bar{padding:var(--winslet-fsb-padding-top) var(--winslet-fsb-padding-right) var(--winslet-fsb-padding-bottom) var(--winslet-fsb-padding-left);}" +
      "winslet-free-shipping-bar .winslet-fsb__track{height:var(--winslet-fsb-thickness);border-radius:var(--winslet-fsb-roundness);overflow:hidden;}" +
      "winslet-free-shipping-bar .winslet-fsb__fill{height:100%;width:0%;border-radius:var(--winslet-fsb-roundness);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);transition:width 0.3s ease,background-color 0.3s ease;}" +
      "winslet-free-shipping-bar .winslet-fsb__message{margin:var(--winslet-fsb-gap) 0 0;font-size:var(--winslet-fsb-font-size);text-align:center;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      "winslet-free-shipping-bar{padding:var(--winslet-fsb-mobile-padding-top) var(--winslet-fsb-mobile-padding-right) var(--winslet-fsb-mobile-padding-bottom) var(--winslet-fsb-mobile-padding-left);}" +
      "winslet-free-shipping-bar .winslet-fsb__track{height:var(--winslet-fsb-mobile-thickness);border-radius:var(--winslet-fsb-mobile-roundness);}" +
      "winslet-free-shipping-bar .winslet-fsb__fill{border-radius:var(--winslet-fsb-mobile-roundness);}" +
      "winslet-free-shipping-bar .winslet-fsb__message{margin-top:var(--winslet-fsb-mobile-gap);font-size:var(--winslet-fsb-mobile-font-size);}" +
      "}";
    document.head.appendChild(style);
  }

  // {remaining} is deliberately a bare number, never a formatted money
  // string — Intl's own "$" rendering varies by locale (e.g. "US$" to
  // disambiguate from other dollar currencies, merchant-reported as
  // confusing) and baking in a symbol would leave a merchant with no
  // way to control placement, spacing, or whether one shows at all for
  // a quantity-based threshold. {currency_symbol}/{currency_code} are
  // separate tokens the merchant composes into their own message text.
  function formatRemainingNumber(amount, metric) {
    return metric === "cart.quantity" ? String(Math.ceil(amount)) : amount.toFixed(2);
  }

  function currencySymbolFor(currency) {
    try {
      var parts = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        currencyDisplay: "narrowSymbol",
      }).formatToParts(0);
      var currencyPart = parts.find(function (part) {
        return part.type === "currency";
      });
      return currencyPart ? currencyPart.value : currency || "";
    } catch (error) {
      return currency || "";
    }
  }

  function applyTokens(template, remaining, metric, currency) {
    return template
      .replace(/\{remaining\}/g, formatRemainingNumber(remaining, metric))
      .replace(/\{currency_symbol\}/g, currencySymbolFor(currency))
      .replace(/\{currency_code\}/g, currency || "");
  }

  class Bar extends HTMLElement {
    connectedCallback() {
      this.proxyRoot = this.dataset.proxyRoot || "/apps/winslet";
      this.currency = this.dataset.currency || "";
      this.config = null;

      ensureSharedStyle();
      this.buildMarkup(true);
      this.watchForMorph();

      if (sharedConfig) {
        // Already known from an earlier instance on this page — show
        // it immediately, no fetch-and-wait, then revalidate quietly.
        this.applyConfig(sharedConfig);
        if (sharedCart) this.render(sharedCart);
        this.refreshCart();
      }
      this.loadConfig();
      this.configInterval = setInterval(() => this.loadConfig(), CONFIG_REFRESH_MS);

      this._onCartEvent = () => this.refreshCart();
      document.addEventListener("cart:updated", this._onCartEvent);
      document.addEventListener("cart:refresh", this._onCartEvent);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.refreshCart();
      });

      this.patchFetch();
    }

    disconnectedCallback() {
      clearInterval(this.configInterval);
      document.removeEventListener("cart:updated", this._onCartEvent);
      document.removeEventListener("cart:refresh", this._onCartEvent);
      if (this.morphObserver) this.morphObserver.disconnect();
    }

    /**
     * (Re)builds the internal track/fill/message DOM — safe to call
     * repeatedly, e.g. after a theme morph strips it. `hide` controls
     * whether it resets to display:none first: true only for the very
     * first build, when nothing is known yet. A morph-triggered rebuild
     * passes false and instead re-applies the last known config/cart
     * synchronously right after, in the same tick — since nothing here
     * yields to the event loop, the browser paints only the final
     * result, never an intermediate hidden or 0%-width frame. Some
     * themes morph their ENTIRE cart drawer on every single change
     * (not just occasionally), so this path runs constantly — a
     * visible hide-then-show or restart-from-zero on every cart update
     * would be far more noticeable than the rare case it was built for.
     */
    buildMarkup(hide) {
      if (hide) this.style.display = "none";
      this.innerHTML =
        '<div class="winslet-fsb__track"><div class="winslet-fsb__fill"></div></div>' + '<p class="winslet-fsb__message"></p>';
      this.trackEl = this.querySelector(".winslet-fsb__track");
      this.fillEl = this.querySelector(".winslet-fsb__fill");
      this.messageEl = this.querySelector(".winslet-fsb__message");
    }

    /**
     * Some themes morph/patch this element's existing DOM against fresh
     * server-rendered HTML instead of a full innerHTML replace — since
     * the server-rendered tag has no children, that can silently strip
     * everything buildMarkup() created without connectedCallback firing
     * again (the top-level node is preserved, only its contents are
     * reconciled away). Watching for exactly that and rebuilding
     * immediately — synchronously, from cache — is far more reliable
     * than hoping a cart event fires again soon, and avoids any visible
     * flash since nothing here waits on a fetch.
     */
    watchForMorph() {
      this.morphObserver = new MutationObserver(() => {
        if (!this.trackEl || !this.contains(this.trackEl)) {
          this.buildMarkup(false);
          if (this.config) {
            this.applyConfig(this.config);
            if (sharedCart) this.render(sharedCart);
          }
          this.refreshCart();
        }
      });
      this.morphObserver.observe(this, { childList: true });
    }

    /** Detects AJAX cart mutations on themes that never dispatch cart:updated/cart:refresh. */
    patchFetch() {
      var self = this;
      var originalFetch = window.fetch;
      if (originalFetch.__winsletFsbPatched) return;

      var patched = function () {
        var request = originalFetch.apply(window, arguments);
        var url = arguments[0] instanceof Request ? arguments[0].url : String(arguments[0] || "");
        if (CART_ENDPOINT_PATTERN.test(url)) {
          request.then(function () {
            self.refreshCart();
          });
        }
        return request;
      };
      patched.__winsletFsbPatched = true;
      window.fetch = patched;
    }

    loadConfig(retriesLeft) {
      // The very first load, before sharedConfig exists, has nothing to
      // fall back to if this one request hiccups — an occasional
      // network blip would otherwise leave the bar permanently hidden
      // until the next 60s refresh. Retrying a couple of times, a
      // second apart, costs nothing once sharedConfig is already known
      // (the periodic refresh just tries once, same as before).
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/free-shipping", { headers: { accept: "application/json" } })
        .then((response) => {
          if (!response.ok) throw new Error("bad status " + response.status);
          return response.json();
        })
        .then((config) => {
          sharedConfig = config;
          this.applyConfig(config);
          if (config.active) this.refreshCart();
        })
        .catch(() => {
          if (attemptsLeft > 0) setTimeout(() => this.loadConfig(attemptsLeft - 1), 1000);
        });
    }

    applyConfig(config) {
      this.config = config;
      if (!config.active) {
        this.style.display = "none";
        return;
      }
      this.trackEl.style.backgroundColor = config.trackColor;
      this.style.setProperty("--winslet-fsb-thickness", config.barThickness + "px");
      this.style.setProperty("--winslet-fsb-mobile-thickness", config.mobileBarThickness + "px");
      this.style.setProperty("--winslet-fsb-roundness", config.barRoundness + "px");
      this.style.setProperty("--winslet-fsb-mobile-roundness", config.mobileBarRoundness + "px");
      this.style.setProperty("--winslet-fsb-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-fsb-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-fsb-gap", config.barMessageGap + "px");
      this.style.setProperty("--winslet-fsb-mobile-gap", config.mobileBarMessageGap + "px");
      this.style.setProperty("--winslet-fsb-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-fsb-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-fsb-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-fsb-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-fsb-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-fsb-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-fsb-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-fsb-mobile-padding-right", config.mobilePaddingRight + "px");
      this.style.display = "block";
    }

    refreshCart() {
      fetch("/cart.js", { headers: { accept: "application/json" } })
        .then((response) => response.json())
        .then((cart) => {
          sharedCart = cart;
          this.render(cart);
        })
        .catch(() => {
          /* Network hiccup — the bar just keeps its last known state. */
        });
    }

    render(cart) {
      var config = this.config;
      if (!config || !config.active) return;

      var isQuantity = config.minimumMetric === "cart.quantity";
      var current = isQuantity ? cart.item_count : cart.total_price / 100;
      var threshold = config.minimumValue;
      var percent = threshold > 0 ? Math.min(100, (current / threshold) * 100) : 0;
      var remaining = Math.max(0, threshold - current);

      this.fillEl.style.width = percent + "%";
      this.fillEl.style.backgroundColor =
        percent >= 100 ? config.reachedColor : percent >= config.nearThresholdPercent ? config.nearColor : config.startColor;

      this.messageEl.textContent =
        percent >= 100
          ? applyTokens(config.completeMessage, 0, config.minimumMetric, this.currency)
          : applyTokens(config.progressMessage, remaining, config.minimumMetric, this.currency);
    }
  }

  customElements.define("winslet-free-shipping-bar", Bar);
})();
