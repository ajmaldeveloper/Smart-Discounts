/**
 * Winslet A/B test bootstrap. Unlike every other file in this
 * directory, this isn't a custom element with a placement tag — it's
 * a single invisible script, pasted once in theme.liquid, that's the
 * ONLY way an anonymous shopper can be split between two campaign
 * variants at all: Shopify's checkout Functions have no session state
 * or randomness of their own (see extensions/winslet-discounts/src/
 * cart_lines_discounts_generate_run.ts's own comment), so the split
 * has to happen here, once, and be handed to the Function as a cart
 * attribute it can read on every invocation.
 *
 * On every page load: ask the app which (if any) A/B test is
 * currently live and what percent should see Variant A. If the
 * shopper's cart doesn't have a bucket yet, randomly assign one
 * (weighted by that percent) and save it to the cart — from then on
 * it's stable for the life of that cart, so the same shopper always
 * sees the same variant. If no test is running but a stale bucket is
 * still on the cart (left over from an earlier, now-concluded test),
 * it's cleared so a future test starts fresh rather than reusing it.
 */
(function () {
  var PROXY_ROOT = "/apps/winslet";
  var BUCKET_KEY = "_winslet_ab_bucket";

  function getCart() {
    return fetch("/cart.js", { headers: { accept: "application/json" } }).then(function (response) {
      return response.json();
    });
  }

  function setBucket(value) {
    var attributes = {};
    attributes[BUCKET_KEY] = value;
    return fetch("/cart/update.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ attributes: attributes }),
    });
  }

  function pickBucket(variantAWeight) {
    return Math.random() * 100 < variantAWeight ? "A" : "B";
  }

  fetch(PROXY_ROOT + "/ab-test", { headers: { accept: "application/json" } })
    .then(function (response) {
      return response.json();
    })
    .then(function (config) {
      return getCart().then(function (cart) {
        var current = cart.attributes && cart.attributes[BUCKET_KEY];

        if (!config.active) {
          if (current) setBucket("");
          return;
        }

        if (current === "A" || current === "B") return;
        setBucket(pickBucket(config.variantAWeight));
      });
    })
    .catch(function () {
      /* Network hiccup — no bucket assigned this page view. The checkout Function's own default-to-A fallback keeps this safe. */
    });
})();
