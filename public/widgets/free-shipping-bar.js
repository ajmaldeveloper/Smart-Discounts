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
 * Everything it needs (the real campaign threshold, the merchant's
 * chosen colors/messages) comes live from the App Proxy at connect
 * time — nothing is hand-typed into the theme, so it can never drift
 * out of sync with the real discount.
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
  // Cached OUTSIDE the class, shared by every instance on the page —
  // a theme's cart drawer commonly re-renders its own markup via AJAX
  // (innerHTML replacement) on every cart change, which destroys and
  // recreates this element each time. Without a shared cache, each
  // fresh instance would start hidden again and wait on a brand-new
  // fetch before showing anything, flashing invisible on every drawer
  // open. With it, a freshly (re)connected instance renders instantly
  // from whatever the page already knows, then quietly revalidates.
  var sharedConfig = null;

  function formatRemaining(amount, metric, currency) {
    if (metric === "cart.quantity") {
      var count = Math.ceil(amount);
      return count + (count === 1 ? " item" : " items");
    }
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
    } catch (error) {
      return (currency || "") + " " + amount.toFixed(2);
    }
  }

  class Bar extends HTMLElement {
    connectedCallback() {
      this.proxyRoot = this.dataset.proxyRoot || "/apps/winslet";
      this.currency = this.dataset.currency || "";
      this.config = null;
      this.style.display = "none";

      this.innerHTML =
        '<div class="winslet-fsb__track" style="border-radius:999px;height:8px;overflow:hidden;">' +
        '<div class="winslet-fsb__fill" style="height:100%;border-radius:999px;width:0%;' +
        "box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);transition:width 0.3s ease,background-color 0.3s ease;" +
        '"></div>' +
        "</div>" +
        '<p class="winslet-fsb__message" style="margin:8px 0 0;font-size:14px;text-align:center;"></p>';
      this.trackEl = this.querySelector(".winslet-fsb__track");
      this.fillEl = this.querySelector(".winslet-fsb__fill");
      this.messageEl = this.querySelector(".winslet-fsb__message");
      this.style.cssText += "display:none;padding:8px 16px;";

      if (sharedConfig) {
        // Already known from an earlier instance on this page — show
        // it immediately, no fetch-and-wait, then revalidate quietly.
        this.applyConfig(sharedConfig);
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

    loadConfig() {
      fetch(this.proxyRoot + "/free-shipping", { headers: { accept: "application/json" } })
        .then((response) => response.json())
        .then((config) => {
          sharedConfig = config;
          this.applyConfig(config);
          if (config.active) this.refreshCart();
        })
        .catch(() => {
          /* Network hiccup — keep showing whatever config we already have. */
        });
    }

    applyConfig(config) {
      this.config = config;
      if (!config.active) {
        this.style.display = "none";
        return;
      }
      this.trackEl.style.backgroundColor = config.trackColor;
      this.style.display = "block";
    }

    refreshCart() {
      fetch("/cart.js", { headers: { accept: "application/json" } })
        .then((response) => response.json())
        .then((cart) => this.render(cart))
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
          ? config.completeMessage
          : config.progressMessage.replace("{remaining}", formatRemaining(remaining, config.minimumMetric, this.currency));
    }
  }

  customElements.define("winslet-free-shipping-bar", Bar);
})();
