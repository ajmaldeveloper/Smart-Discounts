/**
 * Winslet countdown timer. Same distribution model as the other
 * widgets in this directory (loader script + placement tag, config
 * caching, self-heal on morph) — but like announcement-bar.js, it
 * carries no campaign/cart data at all. Everything it needs is the
 * merchant's own restart mode + end time/colors, fetched once, then
 * ticked locally every second.
 *
 * Three restart modes (see widget-settings.ts's CountdownTimerSettings
 * for the full rationale):
 *   - "fixed": counts down to one absolute end time. Once it passes,
 *     either stops (showing expiredMessage, or hiding entirely if
 *     that's blank) or — if restartAfterEnd is on — keeps repeating a
 *     fixed-length cycle (repeatHours) forever, anchored at that end
 *     time.
 *   - "daily"/"weekly": counts down to the next occurrence of a fixed
 *     UTC time-of-day / UTC weekday+time. Deliberately UTC rather than
 *     each shopper's own local time, so every visitor sees the SAME
 *     countdown at any given moment instead of their own private timer
 *     starting fresh on first view.
 */
(function () {
  var TAG = "winslet-countdown-timer";
  if (customElements.get(TAG)) return;

  var CONFIG_REFRESH_MS = 60000;
  var MOBILE_BREAKPOINT = 640;
  var STYLE_ELEMENT_ID = "winslet-ctd-shared-style";
  var sharedConfig = null;

  function ensureSharedStyle() {
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent =
      TAG +
      "{display:flex;flex-direction:column;align-items:center;gap:8px;background:var(--winslet-ctd-bg);color:var(--winslet-ctd-text);padding:var(--winslet-ctd-padding-top) var(--winslet-ctd-padding-right) var(--winslet-ctd-padding-bottom) var(--winslet-ctd-padding-left);}" +
      TAG +
      " .winslet-ctd__message{margin:0;font-size:var(--winslet-ctd-font-size);text-align:center;}" +
      TAG +
      " .winslet-ctd__digits{display:flex;gap:8px;}" +
      TAG +
      " .winslet-ctd__unit{display:flex;flex-direction:column;align-items:center;min-width:48px;padding:6px 8px;border-radius:6px;background:var(--winslet-ctd-digit-bg);color:var(--winslet-ctd-digit-text);}" +
      TAG +
      " .winslet-ctd__value{font-size:calc(var(--winslet-ctd-font-size) + 8px);font-weight:700;line-height:1.2;}" +
      TAG +
      " .winslet-ctd__label{font-size:calc(var(--winslet-ctd-font-size) - 3px);opacity:0.75;text-transform:uppercase;letter-spacing:0.04em;}" +
      TAG +
      " .winslet-ctd__expired{margin:0;font-size:var(--winslet-ctd-font-size);text-align:center;}" +
      "@media (max-width:" +
      MOBILE_BREAKPOINT +
      "px){" +
      TAG +
      "{gap:6px;padding:var(--winslet-ctd-mobile-padding-top) var(--winslet-ctd-mobile-padding-right) var(--winslet-ctd-mobile-padding-bottom) var(--winslet-ctd-mobile-padding-left);}" +
      TAG +
      " .winslet-ctd__message,.winslet-ctd__expired{font-size:var(--winslet-ctd-mobile-font-size);}" +
      TAG +
      " .winslet-ctd__value{font-size:calc(var(--winslet-ctd-mobile-font-size) + 6px);}" +
      TAG +
      " .winslet-ctd__label{font-size:calc(var(--winslet-ctd-mobile-font-size) - 3px);}" +
      "}";
    document.head.appendChild(style);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function partsFromMs(ms) {
    var totalSeconds = Math.max(0, Math.floor(ms / 1000));
    return {
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }

  function utcTimeToday(hhmm, now) {
    var parts = hhmm.split(":");
    var hour = Number(parts[0]) || 0;
    var minute = Number(parts[1]) || 0;
    var nowDate = new Date(now);
    return Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(), hour, minute, 0, 0);
  }

  function nextDailyTarget(hhmm, now) {
    var today = utcTimeToday(hhmm, now);
    return today > now ? today : today + 86400000;
  }

  function nextWeeklyTarget(weekday, hhmm, now) {
    var parts = hhmm.split(":");
    var hour = Number(parts[0]) || 0;
    var minute = Number(parts[1]) || 0;
    var nowDate = new Date(now);
    var currentDay = nowDate.getUTCDay();
    var daysUntil = (weekday - currentDay + 7) % 7;
    var candidate = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate() + daysUntil, hour, minute, 0, 0);
    return candidate > now ? candidate : candidate + 7 * 86400000;
  }

  /** Returns the next target timestamp to count down to, and whether the countdown is over for good (fixed mode, no restart). */
  function computeTarget(config, now) {
    if (config.restartMode === "daily") return { target: nextDailyTarget(config.dailyResetTime, now), expired: false };
    if (config.restartMode === "weekly") return { target: nextWeeklyTarget(config.weeklyResetDay, config.weeklyResetTime, now), expired: false };

    var endAt = new Date(config.endAt).getTime();
    if (isNaN(endAt)) return { target: now, expired: true };
    if (now < endAt) return { target: endAt, expired: false };
    if (!config.restartAfterEnd) return { target: endAt, expired: true };

    var cycleMs = Math.max(1, config.repeatHours) * 3600000;
    var elapsedSinceEnd = now - endAt;
    var cyclesPassed = Math.floor(elapsedSinceEnd / cycleMs) + 1;
    return { target: endAt + cyclesPassed * cycleMs, expired: false };
  }

  function unitMarkup(key, label) {
    return (
      '<div class="winslet-ctd__unit" data-unit="' +
      key +
      '"><span class="winslet-ctd__value">00</span><span class="winslet-ctd__label">' +
      label +
      "</span></div>"
    );
  }

  class CountdownTimer extends HTMLElement {
    connectedCallback() {
      this.proxyRoot = this.dataset.proxyRoot || "/apps/winslet";
      this.config = null;

      ensureSharedStyle();
      this.buildMarkup(true);
      this.watchForMorph();

      if (sharedConfig) this.applyConfig(sharedConfig);
      this.loadConfig();
      this.configInterval = setInterval(() => this.loadConfig(), CONFIG_REFRESH_MS);
      this.tickInterval = setInterval(() => this.tick(), 1000);
    }

    disconnectedCallback() {
      clearInterval(this.configInterval);
      clearInterval(this.tickInterval);
      if (this.morphObserver) this.morphObserver.disconnect();
    }

    buildMarkup(hide) {
      if (hide) this.style.display = "none";
      this.innerHTML =
        '<p class="winslet-ctd__message"></p>' +
        '<div class="winslet-ctd__digits">' +
        unitMarkup("days", "Days") +
        unitMarkup("hours", "Hrs") +
        unitMarkup("minutes", "Min") +
        unitMarkup("seconds", "Sec") +
        "</div>" +
        '<p class="winslet-ctd__expired" hidden></p>';
      this.messageEl = this.querySelector(".winslet-ctd__message");
      this.digitsEl = this.querySelector(".winslet-ctd__digits");
      this.expiredEl = this.querySelector(".winslet-ctd__expired");
      this.valueEls = {
        days: this.querySelector('[data-unit="days"] .winslet-ctd__value'),
        hours: this.querySelector('[data-unit="hours"] .winslet-ctd__value'),
        minutes: this.querySelector('[data-unit="minutes"] .winslet-ctd__value'),
        seconds: this.querySelector('[data-unit="seconds"] .winslet-ctd__value'),
      };
    }

    watchForMorph() {
      this.morphObserver = new MutationObserver(() => {
        if (!this.digitsEl || !this.contains(this.digitsEl)) {
          this.buildMarkup(false);
          if (this.config) this.applyConfig(this.config);
        }
      });
      this.morphObserver.observe(this, { childList: true });
    }

    loadConfig(retriesLeft) {
      var attemptsLeft = typeof retriesLeft === "number" ? retriesLeft : sharedConfig ? 0 : 3;

      fetch(this.proxyRoot + "/countdown-timer", { headers: { accept: "application/json" } })
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
      if (!config.active) {
        this.style.display = "none";
        return;
      }
      this.style.setProperty("--winslet-ctd-bg", config.backgroundColor);
      this.style.setProperty("--winslet-ctd-text", config.textColor);
      this.style.setProperty("--winslet-ctd-digit-bg", config.digitBackgroundColor);
      this.style.setProperty("--winslet-ctd-digit-text", config.digitTextColor);
      this.style.setProperty("--winslet-ctd-font-size", config.messageFontSize + "px");
      this.style.setProperty("--winslet-ctd-mobile-font-size", config.mobileMessageFontSize + "px");
      this.style.setProperty("--winslet-ctd-padding-top", config.paddingTop + "px");
      this.style.setProperty("--winslet-ctd-padding-bottom", config.paddingBottom + "px");
      this.style.setProperty("--winslet-ctd-padding-left", config.paddingLeft + "px");
      this.style.setProperty("--winslet-ctd-padding-right", config.paddingRight + "px");
      this.style.setProperty("--winslet-ctd-mobile-padding-top", config.mobilePaddingTop + "px");
      this.style.setProperty("--winslet-ctd-mobile-padding-bottom", config.mobilePaddingBottom + "px");
      this.style.setProperty("--winslet-ctd-mobile-padding-left", config.mobilePaddingLeft + "px");
      this.style.setProperty("--winslet-ctd-mobile-padding-right", config.mobilePaddingRight + "px");

      this.messageEl.textContent = config.message;
      this.tick();
    }

    tick() {
      var config = this.config;
      if (!config || !config.active) return;

      var now = Date.now();
      var result = computeTarget(config, now);

      if (result.expired) {
        this.digitsEl.hidden = true;
        if (config.expiredMessage) {
          this.expiredEl.hidden = false;
          this.expiredEl.textContent = config.expiredMessage;
          this.style.display = "flex";
        } else {
          this.style.display = "none";
        }
        return;
      }

      this.digitsEl.hidden = false;
      this.expiredEl.hidden = true;
      this.style.display = "flex";

      var parts = partsFromMs(result.target - now);
      this.valueEls.days.textContent = pad2(parts.days);
      this.valueEls.hours.textContent = pad2(parts.hours);
      this.valueEls.minutes.textContent = pad2(parts.minutes);
      this.valueEls.seconds.textContent = pad2(parts.seconds);
    }
  }

  customElements.define(TAG, CountdownTimer);
})();
