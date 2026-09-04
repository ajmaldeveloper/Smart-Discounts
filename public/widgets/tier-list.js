/**
 * Winslet tier-list popup. Same distribution model as the other
 * widgets in this directory (loader script + placement tag, config
 * caching, self-heal on morph) — but instead of a bar, this renders a
 * trigger button that opens a native <dialog> listing every tier of
 * the active volume/quantity discount ("Buy 2+, save 10% · Buy 4+,
 * save 20%"), highlighting whichever tier the shopper's current cart
 * already qualifies for.
 */
(function () {
  if (customElements.get("winslet-tier-list")) return;

  var CONFIG_REFRESH_MS = 60000;
  var CART_ENDPOINT_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-tl-shared-style";
  var sharedConfig = null;
  var sharedCart = null;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      "winslet-tier-list{display:inline-block;}" +
      "winslet-tier-list .winslet-tl__trigger{border:1px solid rgba(0,0,0,0.15);background:none;border-radius:6px;padding:8px 14px;font-size:var(--winslet-tl-font-size);cursor:pointer;}" +
      "winslet-tier-list .winslet-tl__dialog{border:none;border-radius:10px;padding:0;max-width:min(420px,92vw);width:100%;color:var(--winslet-tl-text);background:var(--winslet-tl-bg);}" +
      "winslet-tier-list .winslet-tl__dialog::backdrop{background:rgba(0,0,0,0.5);}" +
      "winslet-tier-list .winslet-tl__inner{padding:var(--winslet-tl-padding-top) var(--winslet-tl-padding-right) var(--winslet-tl-padding-bottom) var(--winslet-tl-padding-left);}" +
      "winslet-tier-list .winslet-tl__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}" +
      "winslet-tier-list .winslet-tl__heading{margin:0;font-size:calc(var(--winslet-tl-font-size) + 2px);font-weight:600;}" +
      "winslet-tier-list .winslet-tl__close{appearance:none;background:none;border:none;font-size:1.4em;line-height:1;cursor:pointer;color:inherit;opacity:0.7;padding:0;}" +
      "winslet-tier-list .winslet-tl__close:hover{opacity:1;}" +
      "winslet-tier-list .winslet-tl__rows{display:flex;flex-direction:column;gap:8px;font-size:var(--winslet-tl-font-size);}" +
      "winslet-tier-list .winslet-tl__row{padding:8px 10px;border-radius:6px;border:1px solid rgba(0,0,0,0.1);}" +
      "winslet-tier-list .winslet-tl__row--current{border-color:var(--winslet-tl-accent);background:color-mix(in srgb, var(--winslet-tl-accent) 12%, transparent);font-weight:600;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      "winslet-tier-list{--winslet-tl-font-size:var(--winslet-tl-mobile-font-size);}" +
      "winslet-tier-list .winslet-tl__inner{padding:var(--winslet-tl-mobile-padding-top) var(--winslet-tl-mobile-padding-right) var(--winslet-tl-mobile-padding-bottom) var(--winslet-tl-mobile-padding-left);}" +
      "}";
    document.head.appendChild(style);
  }

  function formatDiscount(tier, currency) {
    if (tier.discountType === "fixedAmount") {
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(tier.discountValue);
      } catch (error) {
        return (currency || "") + " " + tier.discountValue;
      }
    }
    return tier.discountValue + "%";
  }

  function formatQuantity(tier, tierMetric) {
    return tierMetric === "cart.quantity" ? String(tier.minValue) : tier.minValue.toFixed(2);
  }

  function applyRowTokens(template, tier, tierMetric, currency) {
    return template.replace(/\{quantity\}/g, formatQuantity(tier, tierMetric)).replace(/\{discount\}/g, formatDiscount(tier, currency));
  }

  class TierList extends HTMLElement {
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
        '<button type="button" class="winslet-tl__trigger"></button>' +
        '<dialog class="winslet-tl__dialog">' +
        '<div class="winslet-tl__inner">' +
        '<div class="winslet-tl__head">' +
        '<p class="winslet-tl__heading"></p>' +
        '<button type="button" class="winslet-tl__close" aria-label="Close">×</button>' +
        "</div>" +
        '<div class="winslet-tl__rows"></div>' +
        "</div>" +
        "</dialog>";
      this.triggerEl = this.querySelector(".winslet-tl__trigger");
      this.dialogEl = this.querySelector(".winslet-tl__dialog");
      this.headingEl = this.querySelector(".winslet-tl__heading");
      this.closeEl = this.querySelector(".winslet-tl__close");
      this.rowsEl = this.querySelector(".winslet-tl__rows");

      this.triggerEl.addEventListener("click", () => {
        if (typeof this.dialogEl.showModal === "function") this.dialogEl.showModal();
      });
      this.closeEl.addEventListener("click", () => this.dialogEl.close());
      this.dialogEl.addEventListener("click", (event) => {
        if (event.target === this.dialogEl) this.dialogEl.close();
      });
    }

    watchForMorph() {
      this.morphObserver = new MutationObserver(() => {
        if (!this.triggerEl || !this.contains(this.triggerEl)) {
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
      if (originalFetch.__winsletTlPatched) return;

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
      patched.__winsletTlPatched = true;
      window.fetch = patched;
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/tier-list", { headers: { accept: "application/json" } })
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
      this.style.setProperty("--winslet-tl-font-size", config.fontSize + "px");
      this.style.setProperty("--winslet-tl-mobile-font-size", config.mobileFontSize + "px");
      this.style.setProperty("--winslet-tl-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-tl-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-tl-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-tl-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-tl-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-tl-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-tl-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-tl-mobile-padding-right", config.mobilePaddingRight + "px");
      this.style.setProperty("--winslet-tl-bg", config.backgroundColor);
      this.style.setProperty("--winslet-tl-text", config.textColor);
      this.style.setProperty("--winslet-tl-accent", config.accentColor);

      this.triggerEl.textContent = config.triggerLabel;
      this.headingEl.textContent = config.heading;

      this.style.display = "inline-block";
    }

    refreshCart() {
      fetch("/cart.js", { headers: { accept: "application/json" } })
        .then((response) => response.json())
        .then((cart) => {
          sharedCart = cart;
          this.render(cart);
        })
        .catch(() => {
          /* Network hiccup — the popup just keeps its last known state. */
        });
    }

    render(cart) {
      var config = this.config;
      if (!config || !config.active || !config.tiers || config.tiers.length === 0) return;

      var isQuantity = config.tierMetric === "cart.quantity";
      var current = isQuantity ? cart.item_count : cart.total_price / 100;
      var currentTier = null;
      for (var i = 0; i < config.tiers.length; i++) {
        if (config.tiers[i].minValue <= current) currentTier = config.tiers[i];
      }

      this.rowsEl.innerHTML = "";
      config.tiers.forEach((tier) => {
        var row = document.createElement("div");
        row.className = "winslet-tl__row" + (tier === currentTier ? " winslet-tl__row--current" : "");
        row.textContent = applyRowTokens(config.rowTemplate, tier, config.tierMetric, this.currency);
        this.rowsEl.appendChild(row);
      });
    }
  }

  customElements.define("winslet-tier-list", TierList);
})();
