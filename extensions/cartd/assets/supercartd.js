(function () {
  "use strict";

  var config = window.__SUPERCARTD_CONFIG__;
  if (!config) return;

  var cart = null;
  var isOpen = false;
  var isLoading = false;

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
    bindEvents(overlay);
    bindTouchGestures(drawer, overlay);
  }

  function applyConfig() {
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
  function bindTouchGestures(drawer, overlay) {
    var startX = 0;
    var currentX = 0;
    var isDragging = false;

    drawer.addEventListener("touchstart", function (e) {
      var touch = e.touches[0];
      startX = touch.clientX;
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
      var diff = currentX - startX;
      if (diff > 80) {
        closeDrawer();
      } else {
        drawer.style.transform = "";
      }
    }, { passive: true });
  }

  // --- EVENTS ---
  function bindEvents(overlay) {
    qs(".scd-close").addEventListener("click", closeDrawer);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeDrawer();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) closeDrawer();
    });

    // Intercept add-to-cart forms
    document.addEventListener("submit", function (e) {
      var form = e.target.closest('form[action*="/cart/add"]');
      if (!form) return;

      e.preventDefault();
      var formData = new FormData(form);
      addToCart(formDataToObj(formData));
    });

    // Intercept AJAX add-to-cart buttons
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-supercartd-add]");
      if (!btn) return;

      e.preventDefault();
      var variantId = btn.dataset.variantId;
      var qty = parseInt(btn.dataset.quantity || "1", 10);
      if (variantId) {
        addToCart({ id: variantId, quantity: qty });
      }
    });

    // Track checkout clicks
    var checkoutBtn = qs(".scd-checkout-btn");
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", function () {
        if (cart) {
          trackEvent("checkout_click", {
            cartTotal: (cart.total_price / 100).toFixed(2),
            itemCount: cart.item_count,
          });
        }
      });
    }
  }

  // --- CART API ---
  function fetchCart() {
    return fetch("/cart.js", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    }).then(function (r) { return r.json(); });
  }

  function addToCart(data) {
    setLoading(true);
    fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function () { return refreshAndOpen(); })
      .catch(function (err) {
        console.error("SuperCartD: add to cart failed", err);
        setLoading(false);
      });
  }

  function changeQuantity(lineKey, quantity) {
    setLoading(true);
    fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: lineKey, quantity: quantity }),
    })
      .then(function () { return refreshCart(); })
      .catch(function (err) {
        console.error("SuperCartD: change quantity failed", err);
        setLoading(false);
      });
  }

  function refreshCart() {
    return fetchCart().then(function (c) {
      cart = c;
      renderCart();
      setLoading(false);
    });
  }

  function refreshAndOpen() {
    return fetchCart().then(function (c) {
      cart = c;
      renderCart();
      openDrawer();
      setLoading(false);
    });
  }

  // --- RENDER ---
  function renderCart() {
    if (!cart) return;

    renderRewards();
    renderItems();
    renderUpsells();
    renderFooter();
  }

  function renderRewards() {
    var container = qs(".scd-rewards");
    container.innerHTML = "";

    var rewards = config.body.rewards.filter(function (r) { return r.enabled; });
    if (rewards.length === 0) return;

    var totalPrice = cart.total_price / 100;
    var totalQty = cart.items.reduce(function (s, i) { return s + i.quantity; }, 0);

    rewards.forEach(function (reward) {
      var current = reward.condition.type === "price" ? totalPrice : totalQty;
      var target = reward.condition.value;
      var progress = Math.min((current / target) * 100, 100);
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
      el.innerHTML =
        '<div class="scd-reward-text">' + escapeHtml(text) + "</div>" +
        '<div class="scd-progress-track">' +
          '<div class="scd-progress-fill" style="width:' + progress + "%;background:" + reward.design.progressColor + '"></div>' +
        "</div>";

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

    // Bind qty buttons
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

    // Filter out products already in cart (basic exclusion)
    var cartProductIds = cart.items.map(function (i) { return String(i.product_id); });
    var cartVariantIds = cart.items.map(function (i) { return String(i.variant_id); });

    var available = upsells.filter(function (u) {
      var pid = u.productId.replace("gid://shopify/Product/", "");
      var vid = u.variantId.replace("gid://shopify/ProductVariant/", "");

      // Don't show if own product is in cart
      if (cartProductIds.indexOf(pid) !== -1 || cartVariantIds.indexOf(vid) !== -1) {
        return false;
      }

      // Mutual exclusion: don't show if any excluded product is in cart
      var excludeIds = u.excludeIfProductIds || [];
      for (var i = 0; i < excludeIds.length; i++) {
        var exId = excludeIds[i].replace("gid://shopify/Product/", "");
        if (cartProductIds.indexOf(exId) !== -1) {
          return false;
        }
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

      card.innerHTML =
        '<div class="scd-upsell-info">' +
          '<div class="scd-upsell-title" style="color:' + upsell.design.textColor + '">' + escapeHtml(upsell.title || "Recommended") + "</div>" +
          (offerText ? '<div class="scd-upsell-offer">' + offerText + "</div>" : "") +
        "</div>" +
        '<button class="scd-upsell-btn" style="background:' + upsell.design.buttonColor + ";color:" + upsell.design.buttonTextColor + ";border-radius:" + upsell.design.buttonRadius + 'px">' +
          escapeHtml(upsell.buttonText) +
        "</button>";

      // Track upsell impression click area
      card.addEventListener("click", function (e) {
        if (!e.target.closest(".scd-upsell-btn")) {
          trackEvent("upsell_click", { productId: upsell.productId });
        }
      });

      card.querySelector(".scd-upsell-btn").addEventListener("click", function () {
        trackEvent("upsell_add", {
          productId: upsell.productId,
          variantId: upsell.variantId,
          value: upsell.offer.type !== "none" ? upsell.offer.value : 0,
        });
        var vid = upsell.variantId.replace("gid://shopify/ProductVariant/", "");
        addToCart({ id: parseInt(vid, 10), quantity: 1 });
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
      // Reset any swipe transform
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

  function formDataToObj(formData) {
    var obj = {};
    formData.forEach(function (value, key) {
      obj[key] = value;
    });
    return obj;
  }

  // --- INIT ---
  function init() {
    createDrawer();
    fetchCart().then(function (c) {
      cart = c;
      renderCart();
    });

    // Also open drawer on cart icon click (common theme pattern)
    document.addEventListener("click", function (e) {
      var cartLink = e.target.closest('a[href="/cart"]');
      if (cartLink && !e.defaultPrevented) {
        e.preventDefault();
        refreshAndOpen();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
