/**
 * Winslet tier-progress bar. Same architecture as free-shipping-bar.js
 * in this same directory (loader script + placement tag, config/cart
 * caching, self-heal on morph, three cart-change signals) — but
 * instead of one threshold, it tracks a whole LADDER of volume/
 * quantity tiers (see storefront-widgets.server.ts's
 * getActiveTieredDiscount): the fill always shows progress toward the
 * shopper's NEXT unmet tier, and small tick marks along the track show
 * where every tier sits.
 */
(function () {
  if (customElements.get("winslet-tier-progress-bar")) return;

  var CONFIG_REFRESH_MS = 60000;
  var CART_ENDPOINT_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-tpb-shared-style";
  var sharedConfig = null;
  var sharedCart = null;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      "winslet-tier-progress-bar{display:flex;flex-direction:column;gap:var(--winslet-tpb-gap);padding:var(--winslet-tpb-padding-top) var(--winslet-tpb-padding-right) var(--winslet-tpb-padding-bottom) var(--winslet-tpb-padding-left);}" +
      "winslet-tier-progress-bar .winslet-tpb__track{position:relative;height:var(--winslet-tpb-thickness);border-radius:var(--winslet-tpb-roundness);overflow:hidden;}" +
      "winslet-tier-progress-bar .winslet-tpb__fill{height:100%;width:0%;border-radius:var(--winslet-tpb-roundness);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);transition:width 0.3s ease,background-color 0.3s ease;}" +
      "winslet-tier-progress-bar .winslet-tpb__ticks{position:absolute;inset:0;pointer-events:none;}" +
      "winslet-tier-progress-bar .winslet-tpb__tick{position:absolute;top:0;bottom:0;width:2px;background:rgba(255,255,255,0.6);transform:translateX(-1px);}" +
      "winslet-tier-progress-bar .winslet-tpb__message{margin:0;font-size:var(--winslet-tpb-font-size);text-align:center;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      "winslet-tier-progress-bar{gap:var(--winslet-tpb-mobile-gap);padding:var(--winslet-tpb-mobile-padding-top) var(--winslet-tpb-mobile-padding-right) var(--winslet-tpb-mobile-padding-bottom) var(--winslet-tpb-mobile-padding-left);}" +
      "winslet-tier-progress-bar .winslet-tpb__track{height:var(--winslet-tpb-mobile-thickness);border-radius:var(--winslet-tpb-mobile-roundness);}" +
      "winslet-tier-progress-bar .winslet-tpb__fill{border-radius:var(--winslet-tpb-mobile-roundness);}" +
      "winslet-tier-progress-bar .winslet-tpb__message{font-size:var(--winslet-tpb-mobile-font-size);}" +
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

  function formatDiscount(tier, currency) {
    if (!tier) return "";
    if (tier.discountType === "fixedAmount") {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(tier.discountValue);
      } catch (error) {
        return (currency || "") + " " + tier.discountValue;
      }
    }
    return tier.discountValue + "%";
  }

  // "{{token_name}}", double-curly snake_case — matches this
  // developer's own bundle-upsells app's template convention. An
  // unknown token is left untouched rather than silently deleted.
  function resolveTemplateTokens(text, values) {
    return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, function (match, token) {
      return Object.prototype.hasOwnProperty.call(values, token) ? values[token] : match;
    });
  }

  function applyTokens(template, remaining, metric, currency, tier) {
    return resolveTemplateTokens(template, {
      remaining: formatRemainingNumber(remaining, metric),
      currency_symbol: currencySymbolFor(currency),
      currency_code: currency || "",
      discount: formatDiscount(tier, currency),
    });
  }

  class TierProgressBar extends HTMLElement {
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
      this.innerHTML =
        '<div class="winslet-tpb__track"><div class="winslet-tpb__fill"></div><div class="winslet-tpb__ticks"></div></div>' +
        '<p class="winslet-tpb__message"></p>';
      this.trackEl = this.querySelector(".winslet-tpb__track");
      this.fillEl = this.querySelector(".winslet-tpb__fill");
      this.ticksEl = this.querySelector(".winslet-tpb__ticks");
      this.messageEl = this.querySelector(".winslet-tpb__message");
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
      if (originalFetch.__winsletTpbPatched) return;

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
      patched.__winsletTpbPatched = true;
      window.fetch = patched;
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/tier-progress", { headers: { accept: "application/json" } })
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
      if (!config.active || !config.tiers || config.tiers.length === 0) {
        this.style.display = "none";
        return;
      }
      this.trackEl.style.backgroundColor = config.trackColor;
      this.style.setProperty("--winslet-tpb-thickness", config.barThickness + "px");
      this.style.setProperty("--winslet-tpb-mobile-thickness", config.mobileBarThickness + "px");
      this.style.setProperty("--winslet-tpb-roundness", config.barRoundness + "px");
      this.style.setProperty("--winslet-tpb-mobile-roundness", config.mobileBarRoundness + "px");
      this.style.setProperty("--winslet-tpb-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-tpb-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-tpb-gap", config.barMessageGap + "px");
      this.style.setProperty("--winslet-tpb-mobile-gap", config.mobileBarMessageGap + "px");
      this.style.setProperty("--winslet-tpb-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-tpb-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-tpb-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-tpb-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-tpb-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-tpb-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-tpb-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-tpb-mobile-padding-right", config.mobilePaddingRight + "px");
      this.trackEl.style.order = config.barPosition === "bottom" ? "2" : "1";
      this.messageEl.style.order = config.barPosition === "bottom" ? "1" : "2";

      var highest = config.tiers[config.tiers.length - 1].minValue;
      this.ticksEl.innerHTML = "";
      config.tiers.forEach((tier) => {
        var tick = document.createElement("span");
        tick.className = "winslet-tpb__tick";
        tick.style.left = Math.min(100, (tier.minValue / highest) * 100) + "%";
        this.ticksEl.appendChild(tick);
      });

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
      if (!config || !config.active || !config.tiers || config.tiers.length === 0) return;

      var isQuantity = config.tierMetric === "cart.quantity";
      var current = isQuantity ? cart.item_count : cart.total_price / 100;

      var nextTier = config.tiers.find(function (tier) {
        return tier.minValue > current;
      });
      var currentTier = null;
      for (var i = 0; i < config.tiers.length; i++) {
        if (config.tiers[i].minValue <= current) currentTier = config.tiers[i];
      }

      if (nextTier) {
        var percent = Math.min(100, (current / nextTier.minValue) * 100);
        var remaining = Math.max(0, nextTier.minValue - current);
        this.fillEl.style.width = percent + "%";
        this.fillEl.style.backgroundColor = config.progressColor;
        this.messageEl.textContent = applyTokens(config.messageTemplate, remaining, config.tierMetric, this.currency, nextTier);
      } else {
        this.fillEl.style.width = "100%";
        this.fillEl.style.backgroundColor = config.reachedColor;
        this.messageEl.textContent = applyTokens(config.completeMessage, 0, config.tierMetric, this.currency, currentTier);
      }
    }
  }

  customElements.define("winslet-tier-progress-bar", TierProgressBar);
})();
