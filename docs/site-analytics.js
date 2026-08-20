(function () {
  "use strict";

  const POSTHOG_KEY = "phc_uTkU2fJnFVZPNpwPgsaK84GN9o2ow7YDqRpwQWQc4XUT";
  const POSTHOG_HOST = "https://us.i.posthog.com";
  const FEEDBACK_MAX_LENGTH = 280;
  const FEEDBACK_SEEN_KEY = "settlement-edge-feedback-seen";
  const TEST_EVENT_PREFIX = "settlement_edge_test_site_";
  const ATTRIBUTION_SESSION_KEY = "settlement-edge-referral-attribution";
  const ATTRIBUTION_CAPTURED_KEY = "settlement-edge-referral-captured";
  const AI_REFERRERS = [
    { source: "chatgpt", hosts: ["chatgpt.com", "chat.openai.com"] },
    { source: "claude", hosts: ["claude.ai"] },
    { source: "perplexity", hosts: ["perplexity.ai"] },
    { source: "gemini", hosts: ["gemini.google.com", "bard.google.com"] },
    { source: "copilot", hosts: ["copilot.microsoft.com"] },
    { source: "poe", hosts: ["poe.com"] },
    { source: "you", hosts: ["you.com"] },
    { source: "mistral", hosts: ["chat.mistral.ai"] },
    { source: "meta_ai", hosts: ["meta.ai"] },
  ];
  const TEST_REFERRER_OVERRIDES = Object.fromEntries(AI_REFERRERS.map(({ source, hosts }) => [source, `https://${hosts[0]}/`]));
  const route = window.location.pathname.replace(/\/index\.html$/, "/") || "/";
  const searchParams = new URLSearchParams(window.location.search);
  const isTest = searchParams.get("analytics_test") === "true";

  function hostMatches(hostname, expected) {
    return hostname === expected || hostname.endsWith(`.${expected}`);
  }

  function classifyReferrer(value) {
    if (typeof value !== "string" || value.trim() === "") return { acquisition_channel: "direct", referral_source: "direct" };
    try {
      const hostname = new URL(value, window.location.origin).hostname.toLowerCase();
      const aiReferrer = AI_REFERRERS.find(({ hosts }) => hosts.some((host) => hostMatches(hostname, host)));
      if (aiReferrer) return { acquisition_channel: "ai_assistant", referral_source: aiReferrer.source };
      if (
        /(^|\.)google\.[a-z.]+$/.test(hostname) ||
        /(^|\.)yahoo\.[a-z.]+$/.test(hostname) ||
        /(^|\.)yandex\.[a-z.]+$/.test(hostname) ||
        ["bing.com", "duckduckgo.com", "search.brave.com", "baidu.com", "ecosia.org", "kagi.com"].some((host) => hostMatches(hostname, host))
      ) {
        return { acquisition_channel: "search", referral_source: "search" };
      }
      return { acquisition_channel: "other", referral_source: "other" };
    } catch {
      return { acquisition_channel: "other", referral_source: "other" };
    }
  }

  function readSessionValue(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function writeSessionValue(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      /* Attribution still works for this page when session storage is unavailable. */
    }
  }

  function referralAttribution() {
    const sessionKey = isTest ? `${ATTRIBUTION_SESSION_KEY}-test` : ATTRIBUTION_SESSION_KEY;
    const saved = readSessionValue(sessionKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const aiSources = AI_REFERRERS.map(({ source }) => source);
        const isAllowed =
          (parsed.acquisition_channel === "ai_assistant" && aiSources.includes(parsed.referral_source)) ||
          (["search", "direct", "other"].includes(parsed.acquisition_channel) && parsed.referral_source === parsed.acquisition_channel);
        if (isAllowed) return parsed;
      } catch {
        /* Replace invalid stored attribution with a fresh bounded value. */
      }
    }
    const testSource = isTest ? searchParams.get("analytics_test_source") : null;
    const testReferrer = testSource && Object.hasOwn(TEST_REFERRER_OVERRIDES, testSource) ? TEST_REFERRER_OVERRIDES[testSource] : null;
    const referrer = testReferrer || document.referrer;
    const attribution = classifyReferrer(referrer);
    writeSessionValue(sessionKey, JSON.stringify(attribution));
    return attribution;
  }

  const attribution = referralAttribution();

  function cleanUrl(value) {
    if (typeof value !== "string") return value;
    try {
      const url = new URL(value, window.location.origin);
      return `${url.origin}${url.pathname}`;
    } catch {
      return value.split(/[?#]/, 1)[0];
    }
  }

  function sanitizeEvent(event) {
    if (!event || !event.properties) return event;
    Object.assign(event.properties, attribution);
    for (const key of [
      "$current_url",
      "$initial_current_url",
      "$session_entry_url",
      "$external_click_url",
    ]) {
      if (key in event.properties) event.properties[key] = cleanUrl(event.properties[key]);
    }
    delete event.properties.$referrer;
    delete event.properties.$initial_referrer;
    return event;
  }

  function loadPostHog() {
    /* PostHog's official array loader keeps captures queued until the SDK is ready. */
    !(function (document, posthog) {
      let methods;
      let index;
      let script;
      let firstScript;
      posthog.__SV ||
        ((window.posthog = posthog),
        (posthog._i = []),
        (posthog.init = function (token, config, name) {
          function stub(target, method) {
            const parts = method.split(".");
            if (parts.length === 2) {
              target = target[parts[0]];
              method = parts[1];
            }
            target[method] = function () {
              target.push([method].concat(Array.prototype.slice.call(arguments, 0)));
            };
          }
          script = document.createElement("script");
          script.type = "text/javascript";
          script.crossOrigin = "anonymous";
          script.async = true;
          script.src = `${config.api_host.replace(".i.posthog.com", "-assets.i.posthog.com")}/static/array.js`;
          firstScript = document.getElementsByTagName("script")[0];
          firstScript.parentNode.insertBefore(script, firstScript);
          let instance = posthog;
          if (name !== undefined) instance = posthog[name] = [];
          else name = "posthog";
          instance.people = instance.people || [];
          instance.toString = function (asPeople) {
            let value = "posthog";
            if (name !== "posthog") value += `.${name}`;
            if (!asPeople) value += " (stub)";
            return value;
          };
          instance.people.toString = function () {
            return `${instance.toString(1)}.people (stub)`;
          };
          methods =
            "init capture register register_once register_for_session unregister unregister_for_session identify reset get_distinct_id get_session_id startSessionRecording stopSessionRecording sessionRecordingStarted opt_in_capturing opt_out_capturing has_opted_out_capturing set_config".split(
              " ",
            );
          for (index = 0; index < methods.length; index += 1) stub(instance, methods[index]);
          posthog._i.push([token, config, name]);
        }),
        (posthog.__SV = 1));
    })(document, window.posthog || []);

    window.posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      defaults: "2026-05-30",
      persistence: "localStorage",
      person_profiles: "never",
      disable_compression: isTest,
      autocapture: {
        dom_event_allowlist: isTest ? [] : ["click"],
        element_allowlist: ["a", "button"],
      },
      capture_pageview: !isTest,
      capture_pageleave: !isTest,
      disable_session_recording: false,
      rageclick: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "#settlement-edge-feedback textarea",
      },
      before_send: sanitizeEvent,
      loaded: initializeSiteAnalytics,
    });
  }

  function eventProperties(extra) {
    return Object.assign({ route, is_test: isTest }, attribution, extra || {});
  }

  function captureSiteEvent(posthog, eventName, extra) {
    const isolatedName = isTest ? `${TEST_EVENT_PREFIX}${eventName}` : eventName;
    posthog.capture(isolatedName, eventProperties(extra));
  }

  function createFeedbackPrompt(posthog) {
    const prompt = document.createElement("aside");
    prompt.id = "settlement-edge-feedback";
    prompt.className = "feedback-prompt ph-no-capture";
    prompt.hidden = true;
    prompt.setAttribute("aria-labelledby", "feedback-question");
    prompt.innerHTML = `
      <button class="feedback-close" type="button" aria-label="Dismiss feedback question">×</button>
      <p class="feedback-label">One useful question</p>
      <form class="feedback-form">
        <label id="feedback-question" for="feedback-response">What were you hoping to understand about Settlement Edge?</label>
        <textarea id="feedback-response" name="feedback" rows="2" maxlength="${FEEDBACK_MAX_LENGTH}" required data-ph-no-capture></textarea>
        <div class="feedback-actions">
          <small><span class="feedback-count">0</span>/${FEEDBACK_MAX_LENGTH}</small>
          <button class="feedback-submit" type="submit">Send feedback</button>
        </div>
        <p class="feedback-privacy">Your typed answer is masked in session recordings.</p>
      </form>`;
    document.body.appendChild(prompt);

    const form = prompt.querySelector("form");
    const textarea = prompt.querySelector("textarea");
    const count = prompt.querySelector(".feedback-count");
    const close = prompt.querySelector(".feedback-close");

    textarea.addEventListener("input", function () {
      count.textContent = String(textarea.value.length);
    });

    close.addEventListener("click", function () {
      prompt.hidden = true;
      window.localStorage.setItem(FEEDBACK_SEEN_KEY, "dismissed");
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const comment = textarea.value.trim().slice(0, FEEDBACK_MAX_LENGTH);
      if (!comment) return;
      captureSiteEvent(posthog, "feedback_submitted", { response: "answered", comment });
      window.localStorage.setItem(FEEDBACK_SEEN_KEY, "submitted");
      form.innerHTML = '<p class="feedback-thanks" role="status">Thank you. This goes straight into the next product read.</p>';
      window.setTimeout(function () {
        prompt.hidden = true;
      }, 2400);
    });

    return function showFeedback() {
      if (!isTest && window.localStorage.getItem(FEEDBACK_SEEN_KEY)) return;
      prompt.hidden = false;
    };
  }

  function observeOnce(element, callback, options) {
    if (!element || !("IntersectionObserver" in window)) return;
    let dwellTimer;
    const observer = new IntersectionObserver(function (entries) {
      if (!entries.some((entry) => entry.isIntersecting)) {
        window.clearTimeout(dwellTimer);
        return;
      }
      dwellTimer = window.setTimeout(function () {
        observer.disconnect();
        callback();
      }, 1200);
    }, options);
    observer.observe(element);
  }

  function initializeSiteAnalytics(posthog) {
    posthog.register_for_session(Object.assign({ is_test: isTest }, attribution));
    posthog.startSessionRecording(true);
    document.documentElement.dataset.analyticsReady = "true";
    const capturedKey = isTest ? `${ATTRIBUTION_CAPTURED_KEY}-test` : ATTRIBUTION_CAPTURED_KEY;
    if (!readSessionValue(capturedKey)) {
      captureSiteEvent(posthog, `referral_${attribution.acquisition_channel}`);
      writeSessionValue(capturedKey, "true");
    }
    const showFeedback = createFeedbackPrompt(posthog);

    const guide = route.endsWith("/prediction-market-trading-agent-vs-forecasting-agent.html")
      ? "trading-vs-forecasting"
      : route.endsWith("/settlement-edge-vs-gnosis-prediction-market-agent.html")
        ? "settlement-edge-vs-gnosis"
        : null;
    if (guide) {
      captureSiteEvent(posthog, "guide_viewed", { guide });
      let guideEngaged = false;
      window.addEventListener(
        "scroll",
        function () {
          if (guideEngaged) return;
          const available = document.documentElement.scrollHeight - window.innerHeight;
          if (available <= 0 || window.scrollY / available < 0.55) return;
          guideEngaged = true;
          captureSiteEvent(posthog, "guide_engaged", { guide, milestone: "55_percent" });
          showFeedback();
        },
        { passive: true },
      );
    }

    const proof = document.getElementById("proof");
    observeOnce(
      proof,
      function () {
        captureSiteEvent(posthog, "demo_engaged", { component: "decision_receipt" });
        showFeedback();
      },
      { threshold: 0.55 },
    );

    const emptyState = document.querySelector(".status-strip");
    observeOnce(
      emptyState,
      function () {
        captureSiteEvent(posthog, "site_state_encountered", { state: "competition_activity_empty" });
      },
      { threshold: 0.65 },
    );

    for (const asset of document.querySelectorAll("[data-analytics-demo-asset]")) {
      asset.addEventListener("error", function () {
        captureSiteEvent(posthog, "site_state_encountered", { state: "demo_asset_error" });
      });
    }
  }

  loadPostHog();
})();
