(function () {
  "use strict";

  // Save original fetch BEFORE any patching — used for our own cart API calls
  var _fetch = window.fetch.bind(window);

  var config = null;
  var cart = null;
  var isOpen = false;
  var isLoading = false;
  var drawerReady = false;
  var pendingOpen = false;

  // --- ANALYTICS ---
  function trackEvent(event, metadata) {
    try {
      var body = { event: event };
      if (metadata) body.metadata = metadata;
      navigator.sendBeacon(
        "/apps/supercartd/events",
        new Blob([JSON.stringify(body)], { type: "application/json" })
      );
    } catch (e) {
      // Silent fail — never block UX for analytics
    }
  }

  // --- CONFIG LOADING ---
  function parseConfig(raw) {
    if (!raw) return null;
    // Handle double-encoded JSON (Liquid | json on a json metafield can produce a string)
    var obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof obj === "string") obj = JSON.parse(obj);
    // Validate minimal structure
    if (!obj || !obj.header || !obj.body || !obj.footer) {
      console.warn("SuperCartD: invalid config structure", Object.keys(obj || {}));
      return null;
    }
    return obj;
  }

  // Check billing status via app proxy — called after config is loaded
  function checkBillingStatus() {
    _fetch("/apps/supercartd/status")
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (data) {
        if (!data || !config) return;
        var changed = false;
        if (data.overLimit && !config._overLimit) {
          config._overLimit = true;
          changed = true;
        } else if (!data.overLimit && config._overLimit) {
          config._overLimit = false;
          changed = true;
        }
        if (changed && cart) renderCart();
      })
      .catch(function () {
        // Silent fail — never block UX for billing check
      });
  }

  function loadConfig(cb) {
    // 1. Try embedded metafield config (zero latency)
    if (window.__SUPERCARTD_CONFIG__) {
      try {
        var parsed = parseConfig(window.__SUPERCARTD_CONFIG__);
        if (parsed) {
          console.log("SuperCartD: config loaded from metafield");
          cb(parsed);
          // Check billing status in parallel — may degrade features after render
          checkBillingStatus();
          return;
        }
      } catch (e) {
        console.warn("SuperCartD: failed to parse metafield config", e);
      }
    }
    console.warn("SuperCartD: metafield config unavailable, trying app proxy...");
    // 2. Fallback: fetch from app proxy (already includes _overLimit flag)
    _fetch("/apps/supercartd/config")
      .then(function (r) {
        if (!r.ok) {
          console.warn("SuperCartD: app proxy returned", r.status);
          return null;
        }
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("json") === -1) {
          console.warn("SuperCartD: app proxy returned non-JSON:", ct);
          return null;
        }
        return r.json();
      })
      .then(function (c) {
        var parsed = parseConfig(c);
        if (parsed) {
          console.log("SuperCartD: config loaded from app proxy");
          cb(parsed);
        } else {
          console.warn("SuperCartD: no config available (not published?)");
        }
      })
      .catch(function (err) {
        console.warn("SuperCartD: failed to load config", err);
      });
  }

  // --- DOM CREATION ---
  function createDrawer() {
    var overlay = document.createElement("div");
    overlay.id = "supercartd-overlay";

    var drawer = document.createElement("div");
    drawer.id = "supercartd-drawer";

    drawer.innerHTML =
      '<div class="scd-header">' +
        '<span class="scd-header-title"></span>' +
        '<button class="scd-close" aria-label="Close cart">&times;</button>' +
      '</div>' +
      '<div class="scd-announcement" style="display:none;"></div>' +
      '<div class="scd-rewards"></div>' +
      '<div class="scd-items"></div>' +
      '<div class="scd-upsells"></div>' +
      '<div class="scd-footer">' +
        '<div class="scd-subtotal">' +
          '<span>Subtotal</span>' +
          '<span class="scd-subtotal-value"></span>' +
        '</div>' +
        '<a class="scd-checkout-btn" href="/checkout"></a>' +
        '<div class="scd-trust-badges" style="display:none;">' +
          '🔒 Secure Checkout · 💳 All major cards accepted' +
        '</div>' +
      '</div>' +
      '<div class="scd-loading" style="display:none;">' +
        '<div class="scd-spinner"></div>' +
      '</div>';

    overlay.appendChild(drawer);
    document.body.appendChild(overlay);

    applyConfig();
    bindDrawerEvents(overlay);
    bindTouchGestures(drawer);
  }

  function applyConfig() {
    var drawer = document.getElementById("supercartd-drawer");
    if (drawer) {
      drawer.style.backgroundColor = config.body.backgroundColor || "#FFFFFF";
    }

    var h = config.header;
    var headerEl = qs(".scd-header");
    headerEl.style.backgroundColor = h.backgroundColor;
    headerEl.style.color = h.textColor;
    qs(".scd-header-title").textContent = h.title;
    qs(".scd-header-title").style.fontSize = h.fontSize + "px";

    var ann = config.body.announcementBar;
    var annEl = qs(".scd-announcement");
    if (ann.enabled && ann.text) {
      annEl.style.display = "";
      annEl.style.backgroundColor = ann.backgroundColor;
      annEl.style.color = ann.textColor;
      annEl.textContent = ann.text;
    }

    var footer = config.footer;
    var btnEl = qs(".scd-checkout-btn");
    btnEl.textContent = footer.checkoutButtonText;
    btnEl.style.backgroundColor = footer.checkoutButtonColor;
    btnEl.style.color = footer.checkoutButtonTextColor;

    if (footer.showTrustBadges) {
      qs(".scd-trust-badges").style.display = "";
    }
  }

  // --- TOUCH GESTURES ---
  function bindTouchGestures(drawer) {
    var startX = 0;
    var currentX = 0;
    var isDragging = false;

    drawer.addEventListener("touchstart", function (e) {
      startX = e.touches[0].clientX;
      currentX = startX;
      isDragging = true;
      drawer.style.transition = "none";
    }, { passive: true });

    drawer.addEventListener("touchmove", function (e) {
      if (!isDragging) return;
      currentX = e.touches[0].clientX;
      var diff = currentX - startX;
      if (diff > 0) {
        drawer.style.transform = "translateX(" + diff + "px)";
      }
    }, { passive: true });

    drawer.addEventListener("touchend", function () {
      if (!isDragging) return;
      isDragging = false;
      drawer.style.transition = "";
      if (currentX - startX > 80) {
        closeDrawer();
      } else {
        drawer.style.transform = "";
      }
    }, { passive: true });
  }

  // --- DRAWER EVENTS (close, qty, checkout) ---
  function bindDrawerEvents(overlay) {
    qs(".scd-close").addEventListener("click", closeDrawer);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDrawer();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closeDrawer();
    });

    // Checkout tracking via document-level delegation (capture phase)
    // to guarantee it fires regardless of other scripts or DOM changes
    document.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest(".scd-checkout-btn");
      if (!btn) return;
      if (cart) {
        trackEvent("checkout_click", {
          cartTotal: (cart.total_price / 100).toFixed(2),
          itemCount: cart.item_count,
        });
      }
    }, true);
  }

  // --- ADD-TO-CART INTERCEPTION (set up BEFORE config loads) ---
  function setupInterception() {
    // Helper: returns true when drawer is disabled via config
    function isDisabled() {
      return config && config.enabled === false;
    }

    // 1. Intercept <form action="/cart/add"> submissions
    document.addEventListener("submit", function (e) {
      if (isDisabled()) return;
      var form = e.target;
      if (!form || !form.action) return;
      if (form.action.indexOf("/cart/add") === -1) return;

      e.preventDefault();
      e.stopPropagation();

      var formData = new FormData(form);
      formData.delete("return_to");
      addToCartFromForm(formData);
    }, true); // capture phase — run before theme handlers

    // 2. Intercept clicks on cart links (a[href="/cart"])
    document.addEventListener("click", function (e) {
      if (isDisabled()) return;
      // Custom trigger attribute
      var trigger = e.target.closest("[data-supercartd-add]");
      if (trigger) {
        e.preventDefault();
        var vid = trigger.dataset.variantId;
        var qty = parseInt(trigger.dataset.quantity || "1", 10);
        if (vid) addToCart({ id: vid, quantity: qty });
        return;
      }

      // Cart page links → open drawer instead
      var cartLink = e.target.closest('a[href="/cart"]');
      if (cartLink) {
        e.preventDefault();
        refreshAndOpen();
      }
    });

    // 3. Monkey-patch fetch — intercept AJAX add-to-cart (Dawn & most modern themes)
    var origFetch = window.fetch;
    window.fetch = function () {
      var url = arguments[0];
      var urlStr = typeof url === "string" ? url : (url && url.url ? url.url : "");

      if (urlStr.indexOf("/cart/add") !== -1 && !isDisabled()) {
        // Let the original request through, then open our drawer
        return origFetch.apply(this, arguments).then(function (response) {
          // Small delay so theme can process its response first
          setTimeout(function () { refreshAndOpen(); }, 100);
          return response;
        });
      }

      return origFetch.apply(this, arguments);
    };

    // 4. Monkey-patch XMLHttpRequest — older themes
    var origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function () {
      var url = arguments[1] || "";
      if (typeof url === "string" && url.indexOf("/cart/add") !== -1) {
        this._scdIntercept = true;
      }
      return origXHROpen.apply(this, arguments);
    };

    var origXHRSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this._scdIntercept && !isDisabled()) {
        this.addEventListener("load", function () {
          setTimeout(function () { refreshAndOpen(); }, 100);
        });
      }
      return origXHRSend.apply(this, arguments);
    };
  }

  // --- CART API (uses _fetch to bypass our monkey-patch) ---
  function fetchCart() {
    return _fetch("/cart.js")
      .then(function (r) { return r.json(); });
  }

  function addToCartFromForm(formData) {
    setLoading(true);
    _fetch("/cart/add.js", {
      method: "POST",
      body: formData,
    })
      .then(function (r) {
        if (!r.ok) throw new Error("Add to cart failed: " + r.status);
        return refreshAndOpen();
      })
      .catch(function (err) {
        console.error("SuperCartD:", err);
        setLoading(false);
      });
  }

  function addToCart(data) {
    setLoading(true);
    return _fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("Add to cart failed: " + r.status);
        return r.json();
      })
      .then(function (addedItem) {
        refreshAndOpen();
        return addedItem;
      })
      .catch(function (err) {
        console.error("SuperCartD:", err);
        setLoading(false);
      });
  }

  function changeQuantity(lineKey, quantity) {
    setLoading(true);
    _fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lineKey, quantity: quantity }),
    })
      .then(function () { return refreshCart(); })
      .catch(function (err) {
        console.error("SuperCartD:", err);
        setLoading(false);
      });
  }

  function refreshCart() {
    return fetchCart().then(function (c) {
      cart = c;
      if (drawerReady) renderCart();
      setLoading(false);
    });
  }

  function refreshAndOpen() {
    return fetchCart().then(function (c) {
      cart = c;
      if (drawerReady) {
        renderCart();
        openDrawer();
        setLoading(false);
      } else {
        // Drawer not ready yet — queue the open for when config loads
        pendingOpen = true;
      }
    });
  }

  // --- RENDER ---
  function renderCart() {
    if (!cart || !config) return;

    // When shop is over plan limit, only render basic cart (items + footer)
    // Never block checkout — just hide upsells and rewards
    var degraded = config._overLimit === true;

    if (!degraded) renderRewards();
    else qs(".scd-rewards").innerHTML = "";

    renderItems();

    if (!degraded) renderUpsells();
    else qs(".scd-upsells").innerHTML = "";

    renderFooter();
  }

  function renderRewards() {
    var container = qs(".scd-rewards");
    container.innerHTML = "";

    var rewards = config.body.rewards.filter(function (r) { return r.enabled; });
    if (rewards.length === 0) return;

    var totalPrice = (cart.items_subtotal_price || cart.total_price) / 100;
    var totalQty = cart.items.reduce(function (s, i) { return s + i.quantity; }, 0);

    rewards.forEach(function (reward) {
      var current = reward.condition.type === "price" ? totalPrice : totalQty;
      var target = reward.condition.value || 1;
      var pct = Math.min(Math.max((current / target) * 100, 0), 100);
      var met = current >= target;
      var remaining =
        reward.condition.type === "price"
          ? "$" + Math.max(target - current, 0).toFixed(2)
          : String(Math.max(target - current, 0));

      var rewardLabel = "";
      if (reward.type === "free_shipping") {
        rewardLabel = "free shipping";
      } else if (reward.type === "percentage_discount") {
        rewardLabel = (reward.discountValue || 10) + "% off";
      }

      var text = met
        ? reward.design.textAfter
        : reward.design.textBefore
            .replace("{{remaining}}", remaining)
            .replace("{{target}}", String(target))
            .replace("{{reward}}", rewardLabel);

      var el = document.createElement("div");
      el.className = "scd-reward";
      el.style.backgroundColor = reward.design.backgroundColor;
      el.style.color = reward.design.textColor;

      var textDiv = document.createElement("div");
      textDiv.className = "scd-reward-text";
      textDiv.textContent = text;

      var track = document.createElement("div");
      track.className = "scd-progress-track";

      var fill = document.createElement("div");
      fill.className = "scd-progress-fill";
      var fillColor = reward.design.progressColor || "#4CAF50";
      fill.style.width = pct + "%";
      fill.style.height = "8px";
      fill.style.backgroundColor = fillColor;
      fill.style.borderRadius = "4px";
      fill.style.display = "block";
      track.appendChild(fill);

      el.appendChild(textDiv);
      el.appendChild(track);
      container.appendChild(el);
    });
  }

  function renderItems() {
    var container = qs(".scd-items");
    container.innerHTML = "";

    if (!cart.items || cart.items.length === 0) {
      container.innerHTML = '<div class="scd-empty">Your cart is empty</div>';
      return;
    }

    cart.items.forEach(function (item) {
      var el = document.createElement("div");
      el.className = "scd-item";

      var imgSrc = item.image
        ? item.image.replace(/(\.\w+)(\?|$)/, "_small$1$2")
        : "";

      el.innerHTML =
        '<div class="scd-item-image">' +
          (imgSrc ? '<img src="' + imgSrc + '" alt="' + escapeHtml(item.title) + '" loading="lazy">' : "") +
        "</div>" +
        '<div class="scd-item-info">' +
          '<div class="scd-item-title">' + escapeHtml(item.title) + "</div>" +
          '<div class="scd-item-price">' + formatMoney(item.final_line_price) + "</div>" +
          '<div class="scd-item-qty">' +
            '<button class="scd-qty-btn scd-qty-minus" data-key="' + item.key + '" aria-label="Decrease quantity">−</button>' +
            '<span class="scd-qty-value">' + item.quantity + "</span>" +
            '<button class="scd-qty-btn scd-qty-plus" data-key="' + item.key + '" aria-label="Increase quantity">+</button>' +
          "</div>" +
        "</div>" +
        '<button class="scd-item-remove" data-key="' + item.key + '" aria-label="Remove item">&times;</button>';

      container.appendChild(el);
    });

    container.querySelectorAll(".scd-qty-minus").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.key;
        var item = cart.items.find(function (i) { return i.key === key; });
        if (item) changeQuantity(key, Math.max(0, item.quantity - 1));
      });
    });

    container.querySelectorAll(".scd-qty-plus").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.key;
        var item = cart.items.find(function (i) { return i.key === key; });
        if (item) changeQuantity(key, item.quantity + 1);
      });
    });

    container.querySelectorAll(".scd-item-remove").forEach(function (btn) {
      btn.addEventListener("click", function () {
        changeQuantity(btn.dataset.key, 0);
      });
    });
  }

  function renderUpsells() {
    var container = qs(".scd-upsells");
    container.innerHTML = "";

    var upsells = config.body.upsells.filter(function (u) { return u.enabled; });
    if (upsells.length === 0) return;

    var cartProductIds = cart.items.map(function (i) { return String(i.product_id); });
    var cartVariantIds = cart.items.map(function (i) { return String(i.variant_id); });

    var available = upsells.filter(function (u) {
      var pid = u.productId.replace("gid://shopify/Product/", "");
      var vid = u.variantId.replace("gid://shopify/ProductVariant/", "");

      if (cartProductIds.indexOf(pid) !== -1 || cartVariantIds.indexOf(vid) !== -1) {
        return false;
      }

      var excludeIds = u.excludeIfProductIds || [];
      for (var i = 0; i < excludeIds.length; i++) {
        var exId = excludeIds[i].replace("gid://shopify/Product/", "");
        if (cartProductIds.indexOf(exId) !== -1) return false;
      }

      return true;
    });

    if (available.length === 0) return;

    var heading = document.createElement("div");
    heading.className = "scd-upsell-heading";
    heading.textContent = "You might also like";
    container.appendChild(heading);

    available.forEach(function (upsell) {
      var card = document.createElement("div");
      card.className = "scd-upsell-card";
      card.style.backgroundColor = upsell.design.backgroundColor;
      card.style.borderRadius = upsell.design.cardRadius + "px";

      var offerText = "";
      if (upsell.offer.type === "percentage") offerText = upsell.offer.value + "% OFF";
      else if (upsell.offer.type === "fixed") offerText = "$" + upsell.offer.value + " OFF";

      var imgHtml = upsell.imageUrl
        ? '<img class="scd-upsell-img" src="' + escapeHtml(upsell.imageUrl) + '" alt="' + escapeHtml(upsell.title || "") + '" />'
        : "";

      var variants = upsell.variants || [];
      var variantHtml = "";
      if (variants.length > 1) {
        variantHtml = '<select class="scd-upsell-variant" data-upsell-id="' + upsell.id + '">';
        for (var vi = 0; vi < variants.length; vi++) {
          var sel = variants[vi].id === upsell.variantId ? " selected" : "";
          variantHtml += '<option value="' + escapeHtml(variants[vi].id) + '"' + sel + '>' + escapeHtml(variants[vi].title) + '</option>';
        }
        variantHtml += '</select>';
      }

      card.innerHTML =
        imgHtml +
        '<div class="scd-upsell-info">' +
          '<div class="scd-upsell-title" style="color:' + upsell.design.textColor + '">' + escapeHtml(upsell.title || "Recommended") + "</div>" +
          (offerText ? '<div class="scd-upsell-offer">' + offerText + "</div>" : "") +
          variantHtml +
        "</div>" +
        '<button class="scd-upsell-btn" style="background:' + upsell.design.buttonColor + ";color:" + upsell.design.buttonTextColor + ";border-radius:" + upsell.design.buttonRadius + 'px">' +
          escapeHtml(upsell.buttonText) +
        "</button>";

      card.addEventListener("click", function () {
        trackEvent("upsell_click", { productId: upsell.productId });
      });

      card.querySelector(".scd-upsell-btn").addEventListener("click", function () {
        var selectedVariantId = upsell.variantId;
        var variantSelect = card.querySelector(".scd-upsell-variant");
        if (variantSelect) selectedVariantId = variantSelect.value;

        var vid = selectedVariantId.replace("gid://shopify/ProductVariant/", "");
        addToCart({ id: parseInt(vid, 10), quantity: 1 }).then(function (addedItem) {
          if (!addedItem) return;
          trackEvent("upsell_add", {
            productId: upsell.productId,
            variantId: selectedVariantId,
          });
        });
      });

      container.appendChild(card);
    });
  }

  function renderFooter() {
    qs(".scd-subtotal-value").textContent = formatMoney(cart.total_price);
  }

  // --- OPEN / CLOSE ---
  function openDrawer() {
    var overlay = document.getElementById("supercartd-overlay");
    if (overlay) {
      overlay.classList.add("scd-open");
      isOpen = true;
      document.body.style.overflow = "hidden";
      trackEvent("drawer_open");
    }
  }

  function closeDrawer() {
    var overlay = document.getElementById("supercartd-overlay");
    if (overlay) {
      overlay.classList.remove("scd-open");
      isOpen = false;
      document.body.style.overflow = "";
      var drawer = document.getElementById("supercartd-drawer");
      if (drawer) drawer.style.transform = "";
    }
  }

  function setLoading(v) {
    isLoading = v;
    var el = qs(".scd-loading");
    if (el) el.style.display = v ? "" : "none";
  }

  // --- HELPERS ---
  function qs(sel) {
    return document.querySelector(sel);
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function formatMoney(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  // --- INIT ---
  function init() {
    // Set up interception IMMEDIATELY — even before config loads
    // This prevents the browser from navigating to /cart on add-to-cart
    setupInterception();

    // Load config (metafield → app proxy fallback) then build drawer
    loadConfig(function (c) {
      config = c;
      if (config.enabled === false) {
        console.log("SuperCartD: disabled by config");
        return;
      }
      createDrawer();
      drawerReady = true;

      fetchCart().then(function (cartData) {
        cart = cartData;
        renderCart();
        if (pendingOpen) {
          openDrawer();
          pendingOpen = false;
        }
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
