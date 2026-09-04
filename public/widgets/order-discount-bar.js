/**
 * Winslet order-discount progress bar. Same architecture as
 * free-shipping-bar.js in this same directory (see that file's own
 * header comment for the full rationale — loader script + placement
 * tag, config/cart caching, self-heal on morph, three cart-change
 * signals) — this one just tracks an active campaign's Order reward
 * (a %/fixed-amount discount on the whole order) instead of free
 * shipping, and adds a "{discount}" message token for the actual
 * amount unlocked.
 */
(function () {
  if (customElements.get("winslet-order-discount-bar")) return;

  var CONFIG_REFRESH_MS = 60000;
  var CART_ENDPOINT_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-odb-shared-style";
  var sharedConfig = null;
  var sharedCart = null;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      "winslet-order-discount-bar{display:flex;flex-direction:column;gap:var(--winslet-odb-gap);padding:var(--winslet-odb-padding-top) var(--winslet-odb-padding-right) var(--winslet-odb-padding-bottom) var(--winslet-odb-padding-left);}" +
      "winslet-order-discount-bar .winslet-odb__track{height:var(--winslet-odb-thickness);border-radius:var(--winslet-odb-roundness);overflow:hidden;}" +
      "winslet-order-discount-bar .winslet-odb__fill{height:100%;width:0%;border-radius:var(--winslet-odb-roundness);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);transition:width 0.3s ease,background-color 0.3s ease;}" +
      "winslet-order-discount-bar .winslet-odb__message{margin:0;font-size:var(--winslet-odb-font-size);text-align:center;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      "winslet-order-discount-bar{gap:var(--winslet-odb-mobile-gap);padding:var(--winslet-odb-mobile-padding-top) var(--winslet-odb-mobile-padding-right) var(--winslet-odb-mobile-padding-bottom) var(--winslet-odb-mobile-padding-left);}" +
      "winslet-order-discount-bar .winslet-odb__track{height:var(--winslet-odb-mobile-thickness);border-radius:var(--winslet-odb-mobile-roundness);}" +
      "winslet-order-discount-bar .winslet-odb__fill{border-radius:var(--winslet-odb-mobile-roundness);}" +
      "winslet-order-discount-bar .winslet-odb__message{font-size:var(--winslet-odb-mobile-font-size);}" +
      "}";
    document.head.appendChild(style);
  }

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

  /** "15%" for a percentage reward, or a currency-formatted "$10" for a fixed amount. */
  function formatDiscount(config, currency) {
    if (config.discountType === "fixedAmount") {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(config.discountValue);
      } catch (error) {
        return (currency || "") + " " + config.discountValue;
      }
    }
    return config.discountValue + "%";
  }

  function applyTokens(template, remaining, metric, currency, config) {
    return template
      .replace(/\{remaining\}/g, formatRemainingNumber(remaining, metric))
      .replace(/\{currency_symbol\}/g, currencySymbolFor(currency))
      .replace(/\{currency_code\}/g, currency || "")
      .replace(/\{discount\}/g, formatDiscount(config, currency));
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

    buildMarkup(hide) {
      if (hide) this.style.display = "none";
      this.innerHTML = '<div class="winslet-odb__track"><div class="winslet-odb__fill"></div></div>' + '<p class="winslet-odb__message"></p>';
      this.trackEl = this.querySelector(".winslet-odb__track");
      this.fillEl = this.querySelector(".winslet-odb__fill");
      this.messageEl = this.querySelector(".winslet-odb__message");
    }

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

    patchFetch() {
      var self = this;
      var originalFetch = window.fetch;
      if (originalFetch.__winsletOdbPatched) return;

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
      patched.__winsletOdbPatched = true;
      window.fetch = patched;
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/order-discount", { headers: { accept: "application/json" } })
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
      this.style.setProperty("--winslet-odb-thickness", config.barThickness + "px");
      this.style.setProperty("--winslet-odb-mobile-thickness", config.mobileBarThickness + "px");
      this.style.setProperty("--winslet-odb-roundness", config.barRoundness + "px");
      this.style.setProperty("--winslet-odb-mobile-roundness", config.mobileBarRoundness + "px");
      this.style.setProperty("--winslet-odb-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-odb-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-odb-gap", config.barMessageGap + "px");
      this.style.setProperty("--winslet-odb-mobile-gap", config.mobileBarMessageGap + "px");
      this.style.setProperty("--winslet-odb-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-odb-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-odb-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-odb-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-odb-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-odb-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-odb-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-odb-mobile-padding-right", config.mobilePaddingRight + "px");
      this.trackEl.style.order = config.barPosition === "bottom" ? "2" : "1";
      this.messageEl.style.order = config.barPosition === "bottom" ? "1" : "2";
      this.style.display = "flex";
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
          ? applyTokens(config.completeMessage, 0, config.minimumMetric, this.currency, config)
          : applyTokens(config.progressMessage, remaining, config.minimumMetric, this.currency, config);
    }
  }

  customElements.define("winslet-order-discount-bar", Bar);
})();
