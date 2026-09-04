/**
 * Winslet "Buy X get Y free" gift-picker. Same distribution model as
 * free-shipping-bar.js in this same directory (see that file's own
 * header comment for the full rationale): a loader <script> pasted
 * once in theme.liquid, and a separate, pure-HTML placement tag pasted
 * wherever the merchant wants the widget to show — safe inside a cart
 * drawer that re-renders via AJAX, since a plain custom-element tag
 * (unlike a <script>) still gets upgraded by the browser no matter how
 * it entered the DOM.
 *
 * Unlike the free-shipping bar, the Add-to-cart button is gated: it's
 * disabled until the shopper has actually met the campaign's own "buy
 * X" condition. That condition tree can reference arbitrary
 * product/cart fields, so this ships a deliberate, minimal duplicate
 * of extensions/winslet-discounts/src/condition-engine.ts's
 * evaluateConditionNode — evaluated here against whatever fields
 * Shopify's own /cart.js line items already expose (variant id,
 * vendor, product type, sku, cart quantity/subtotal). Fields the
 * condition tree could reference but /cart.js doesn't carry — product
 * metafields, market.languageCode — resolve to undefined, which the
 * evaluator already treats as a clean non-match rather than an error;
 * a campaign leaning on one of those fields will under-count matches
 * here even though the real Function (which has full product data)
 * evaluates it correctly at checkout. A known, documented limitation
 * of doing this client-side at all, not a bug.
 */
(function () {
  if (customElements.get("winslet-bogo-gift-picker")) return;

  var CONFIG_REFRESH_MS = 60000;
  var CART_ENDPOINT_PATTERN = /\/cart\/(add|update|change|clear)(\.js)?(\?|$)/;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-bgp-shared-style";
  var sharedConfig = null;
  var sharedCart = null;

  // ---- condition-engine.ts duplicate (evaluator only — no builder UI needed here) ----

  function toComparable(value) {
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(",");
    return String(value);
  }
  function lower(value) {
    return toComparable(value).toLowerCase();
  }
  function toNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      var parsed = Number(value);
      return isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  function overlapsAny(actualItems, options) {
    return actualItems.some(function (item) {
      return options.some(function (option) {
        return lower(option) === lower(item);
      });
    });
  }

  function evaluateCondition(leaf, context) {
    var actual = context[leaf.field];
    var actualItems = Array.isArray(actual) ? actual : null;

    switch (leaf.operator) {
      case "is_empty":
        return actual === undefined || actual === null || toComparable(actual) === "";
      case "is_not_empty":
        return !(actual === undefined || actual === null || toComparable(actual) === "");
      case "equals":
        return lower(actual) === lower(leaf.value);
      case "not_equals":
        return lower(actual) !== lower(leaf.value);
      case "contains":
        if (actualItems) return overlapsAny(actualItems, leaf.value !== undefined ? [leaf.value] : []);
        return lower(actual).indexOf(lower(leaf.value)) !== -1;
      case "not_contains":
        if (actualItems) return !overlapsAny(actualItems, leaf.value !== undefined ? [leaf.value] : []);
        return lower(actual).indexOf(lower(leaf.value)) === -1;
      case "in": {
        var inOptions = Array.isArray(leaf.value) ? leaf.value : [];
        if (actualItems) return overlapsAny(actualItems, inOptions);
        return inOptions.some(function (option) {
          return lower(option) === lower(actual);
        });
      }
      case "not_in": {
        var notInOptions = Array.isArray(leaf.value) ? leaf.value : [];
        if (actualItems) return !overlapsAny(actualItems, notInOptions);
        return !notInOptions.some(function (option) {
          return lower(option) === lower(actual);
        });
      }
      case "greater_than":
      case "greater_than_or_equal":
      case "less_than":
      case "less_than_or_equal": {
        var left = toNumber(actual);
        var right = toNumber(leaf.value);
        if (left === null || right === null) return false;
        if (leaf.operator === "greater_than") return left > right;
        if (leaf.operator === "greater_than_or_equal") return left >= right;
        if (leaf.operator === "less_than") return left < right;
        return left <= right;
      }
      case "between": {
        var betweenLeft = toNumber(actual);
        var bounds = Array.isArray(leaf.value) ? leaf.value : [];
        var min = toNumber(bounds[0]);
        var max = toNumber(bounds[1]);
        if (betweenLeft === null || min === null || max === null) return false;
        return betweenLeft >= min && betweenLeft <= max;
      }
      default:
        return false;
    }
  }

  function evaluateConditionNode(node, context) {
    if (node.type === "condition") return evaluateCondition(node, context);

    var activeChildren = node.children.filter(function (child) {
      return !(child.type === "condition" && child.enabled === false);
    });
    if (activeChildren.length === 0) return node.combinator === "ALL";

    return node.combinator === "ANY"
      ? activeChildren.some(function (child) {
          return evaluateConditionNode(child, context);
        })
      : activeChildren.every(function (child) {
          return evaluateConditionNode(child, context);
        });
  }

  /** Sums the quantity of every /cart.js line matching the campaign's own buy conditions. */
  function matchedQuantity(conditions, cart) {
    var cartContext = {
      "cart.subtotal": cart.total_price / 100,
      "cart.quantity": cart.item_count,
    };

    return cart.items.reduce(function (sum, line) {
      var lineContext = {
        "variant.id": "gid://shopify/ProductVariant/" + line.variant_id,
        "product.vendor": line.vendor || "",
        "product.type": line.product_type || "",
        "variant.sku": line.sku || "",
      };
      for (var key in cartContext) lineContext[key] = cartContext[key];
      return evaluateConditionNode(conditions, lineContext) ? sum + line.quantity : sum;
    }, 0);
  }

  // ---- widget ----

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      "winslet-bogo-gift-picker{display:flex;flex-direction:column;gap:var(--winslet-bgp-gap);padding:var(--winslet-bgp-padding-top) var(--winslet-bgp-padding-right) var(--winslet-bgp-padding-bottom) var(--winslet-bgp-padding-left);}" +
      "winslet-bogo-gift-picker .winslet-bgp__track{height:var(--winslet-bgp-thickness);border-radius:var(--winslet-bgp-roundness);overflow:hidden;}" +
      "winslet-bogo-gift-picker .winslet-bgp__fill{height:100%;width:0%;border-radius:var(--winslet-bgp-roundness);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.08);transition:width 0.3s ease,background-color 0.3s ease;}" +
      "winslet-bogo-gift-picker .winslet-bgp__message{margin:0;font-size:var(--winslet-bgp-font-size);text-align:center;}" +
      "winslet-bogo-gift-picker .winslet-bgp__products{display:flex;flex-direction:column;gap:8px;}" +
      "winslet-bogo-gift-picker .winslet-bgp__product{display:flex;align-items:center;gap:12px;border:1px solid rgba(0,0,0,0.08);border-radius:8px;padding:8px;}" +
      "winslet-bogo-gift-picker .winslet-bgp__product img{width:48px;height:48px;object-fit:cover;border-radius:4px;}" +
      "winslet-bogo-gift-picker .winslet-bgp__product-title{flex:1;font-size:var(--winslet-bgp-font-size);}" +
      "winslet-bogo-gift-picker .winslet-bgp__add{border:none;border-radius:6px;padding:8px 16px;font-size:var(--winslet-bgp-font-size);cursor:pointer;background:var(--winslet-bgp-add-bg);color:var(--winslet-bgp-add-fg);}" +
      "winslet-bogo-gift-picker .winslet-bgp__add:disabled{opacity:0.5;cursor:not-allowed;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      "winslet-bogo-gift-picker{gap:var(--winslet-bgp-mobile-gap);padding:var(--winslet-bgp-mobile-padding-top) var(--winslet-bgp-mobile-padding-right) var(--winslet-bgp-mobile-padding-bottom) var(--winslet-bgp-mobile-padding-left);}" +
      "winslet-bogo-gift-picker .winslet-bgp__track{height:var(--winslet-bgp-mobile-thickness);border-radius:var(--winslet-bgp-mobile-roundness);}" +
      "winslet-bogo-gift-picker .winslet-bgp__fill{border-radius:var(--winslet-bgp-mobile-roundness);}" +
      "winslet-bogo-gift-picker .winslet-bgp__message,winslet-bogo-gift-picker .winslet-bgp__product-title,winslet-bogo-gift-picker .winslet-bgp__add{font-size:var(--winslet-bgp-mobile-font-size);}" +
      "}";
    document.head.appendChild(style);
  }

  function formatMoney(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(amount);
    } catch (error) {
      return (currency || "") + " " + amount.toFixed(2);
    }
  }

  class GiftPicker extends HTMLElement {
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
        '<div class="winslet-bgp__track"><div class="winslet-bgp__fill"></div></div>' +
        '<p class="winslet-bgp__message"></p>' +
        '<div class="winslet-bgp__products"></div>';
      this.trackEl = this.querySelector(".winslet-bgp__track");
      this.fillEl = this.querySelector(".winslet-bgp__fill");
      this.messageEl = this.querySelector(".winslet-bgp__message");
      this.productsEl = this.querySelector(".winslet-bgp__products");
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
      if (originalFetch.__winsletBgpPatched) return;

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
      patched.__winsletBgpPatched = true;
      window.fetch = patched;
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/bogo-gift", { headers: { accept: "application/json" } })
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
      this.trackEl.style.order = config.barPosition === "bottom" ? "2" : "1";
      this.messageEl.style.order = config.barPosition === "bottom" ? "1" : "2";
      this.style.setProperty("--winslet-bgp-thickness", config.barThickness + "px");
      this.style.setProperty("--winslet-bgp-mobile-thickness", config.mobileBarThickness + "px");
      this.style.setProperty("--winslet-bgp-roundness", config.barRoundness + "px");
      this.style.setProperty("--winslet-bgp-mobile-roundness", config.mobileBarRoundness + "px");
      this.style.setProperty("--winslet-bgp-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-bgp-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-bgp-gap", config.barMessageGap + "px");
      this.style.setProperty("--winslet-bgp-mobile-gap", config.mobileBarMessageGap + "px");
      this.style.setProperty("--winslet-bgp-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-bgp-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-bgp-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-bgp-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-bgp-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-bgp-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-bgp-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-bgp-mobile-padding-right", config.mobilePaddingRight + "px");
      this.style.setProperty("--winslet-bgp-add-bg", config.addButtonColor);
      this.style.setProperty("--winslet-bgp-add-fg", config.addButtonTextColor);
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
          /* Network hiccup — the widget just keeps its last known state. */
        });
    }

    addToCart(variantId, button) {
      button.disabled = true;
      fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
      })
        .then(() => {
          document.dispatchEvent(new CustomEvent("cart:updated"));
          this.refreshCart();
        })
        .catch(() => {
          button.disabled = false;
        });
    }

    render(cart) {
      var config = this.config;
      if (!config || !config.active) return;

      var current = matchedQuantity(config.conditions, cart);
      var threshold = config.buyQuantity;
      // threshold+1 is the unit count that earns the first free gift
      // (see reward-types.ts's progressive-BOGO comment) — always >= 1,
      // so this is never a divide-by-zero even when threshold is 0
      // ("free gift with any purchase").
      var percent = Math.min(100, (current / (threshold + 1)) * 100);
      var remaining = Math.max(0, threshold + 1 - current);
      var qualified = current > threshold;

      this.fillEl.style.width = percent + "%";
      this.fillEl.style.backgroundColor = qualified ? config.unlockedColor : config.progressColor;
      this.messageEl.textContent = qualified
        ? config.unlockedMessage
        : config.lockedMessage.replace(/\{remaining\}/g, String(remaining));

      this.productsEl.innerHTML = "";
      (config.products || []).forEach((product) => {
        var row = document.createElement("div");
        row.className = "winslet-bgp__product";

        var img = document.createElement("img");
        img.src = product.image || "";
        img.alt = product.title;
        row.appendChild(img);

        var title = document.createElement("span");
        title.className = "winslet-bgp__product-title";
        title.textContent = product.title + (qualified ? " — FREE" : " — " + formatMoney(Number(product.price), product.currencyCode));
        row.appendChild(title);

        var button = document.createElement("button");
        button.type = "button";
        button.className = "winslet-bgp__add";
        button.textContent = "Add";
        button.disabled = !qualified || !product.availableForSale;
        button.addEventListener("click", () => this.addToCart(product.variantId, button));
        row.appendChild(button);

        this.productsEl.appendChild(row);
      });
    }
  }

  customElements.define("winslet-bogo-gift-picker", GiftPicker);
})();
