/**
 * Jigsy's → Apex ordering bridge.
 * WHY: Guest site must hit the same place_order / capacity path as the staff OS.
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://pqkremkwfkudrhtxasdj.supabase.co';
  // Publishable anon key — same class as Flutter web dart-define (not a secret).
  var SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxa3JlbWt3Zmt1ZHJodHhhc2RqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU2MDUsImV4cCI6MjA5NzQ3MTYwNX0.zF-UpQs8seDPmZT182CRoMpk7ZATzQrfpKiBbLWkKhQ';
  var PUBLIC_TOKEN = 'jigsys';

  var sb = null;
  var restaurant = null;
  var settings = null;
  var categories = [];
  var items = [];
  var groupsByItem = {};
  var capacity = null;
  var cart = [];
  var view = 'menu'; // menu | cart | success
  var payNow = false;
  // Set when this page load is a return from Stripe. The ordering UI is a modal
  // that starts hidden, so a guest coming back from checkout would otherwise
  // land on the ordinary homepage with no sign their card was charged.
  var returnedFromCheckout = false;
  var placing = false;
  var lastOrder = null;
  var loaded = false;
  var loadError = null;
  var catalogChannel = null;

  function $(id) {
    return document.getElementById(id);
  }

  function money(cents) {
    return '$' + (cents / 100).toFixed(2);
  }

  function cartCount() {
    return cart.reduce(function (n, line) {
      return n + line.quantity;
    }, 0);
  }

  function cartSubtotal() {
    return cart.reduce(function (n, line) {
      return n + line.unitPriceCents * line.quantity;
    }, 0);
  }

  function taxCents(sub) {
    var rate = settings && settings.tax_rate != null ? Number(settings.tax_rate) : 0;
    return Math.round(sub * rate);
  }

  function feeCents() {
    return settings && settings.fee_cents != null ? Number(settings.fee_cents) : 0;
  }

  /// The venue's 1.5%, charged to the guest rather than taken out of the
  /// venue's money. Mirrors serviceFeeCents in the Apex app -- 1.5% of subtotal
  /// plus tax, and nothing at all for pay-at-pickup, because it covers the cost
  /// of taking a card. Keep the two in step: a guest who pays a different total
  /// here than in the app is a support call.
  ///
  /// It is a service fee, never a "card fee" or "processing fee", and it never
  /// varies by which card is used -- that distinction is what keeps it a
  /// service fee rather than a surcharge.
  function serviceFeeCents(sub) {
    if (!payNow) return 0;
    return Math.round((sub + taxCents(sub)) * 0.015);
  }

  function totalCents(sub) {
    return sub + feeCents() + taxCents(sub) + serviceFeeCents(sub);
  }

  /// Whether this venue can take a card at all, on either rail.
  ///
  /// create-guest-payment refuses with payment_provider_not_connected
  /// otherwise, so offering the choice would be offering a dead end.
  function canPayNow() {
    // Either rail will do. The guest does not care which processor is behind
    // the button, and this page must not care either -- checking only Stripe
    // meant a venue moved to Square silently lost card payments and every
    // order quietly became pay-at-pickup.
    //
    // Booleans only. The account id, merchant id and OAuth token are not
    // readable by guests and do not need to be: whoever takes the money is
    // none of a stranger's business, and the token would be a serious leak.
    if (!settings) return false;
    return !!(settings.stripe_charges_enabled || settings.square_charges_enabled);
  }

  function isPaused() {
    if (settings && settings.paused) return true;
    var state = capacity && capacity.state;
    return state === 'autoPaused' || state === 'manuallyPaused';
  }

  function capacityMessage() {
    if (!capacity) return null;
    switch (capacity.state) {
      case 'autoPaused':
      case 'manuallyPaused':
        return 'Online ordering is paused — call (717) 732-7708.';
      case 'atCapacity':
        return 'Kitchen is at capacity — new orders will have a longer wait.';
      case 'nearCapacity':
        return 'High demand — expect a slightly longer wait.';
      default:
        return null;
    }
  }

  function syncChrome() {
    var msg = capacityMessage();
    var banner = $('apexCapBanner');
    var onlineBtns = document.querySelectorAll('[data-apex-open]');
    var orderingBits = document.querySelectorAll('[data-apex-ordering]');
    var paused = isPaused();

    // Pause = website-only mode: strip every Order online entry point
    // (same behavior as the old pilot). Call / menu / hours stay.
    onlineBtns.forEach(function (btn) {
      // Reveal only when ordering is live. Default HTML is hidden so a paused
      // / website-only venue never flashes Order online before JS loads.
      btn.hidden = !!paused;
      btn.disabled = !!paused;
      btn.setAttribute('aria-hidden', paused ? 'true' : 'false');
      if (paused) btn.classList.add('apex-ordering-off');
      else btn.classList.remove('apex-ordering-off');
    });
    orderingBits.forEach(function (el) {
      el.hidden = !!paused;
    });

    document.body.classList.toggle('apex-ordering-paused', !!paused);

    // Swap hero / order copy so paused site reads as phone-order only.
    var heroLede = document.querySelector('[data-apex-hero-lede]');
    if (heroLede) {
      if (!heroLede.dataset.onlineText) {
        heroLede.dataset.onlineText = heroLede.textContent;
      }
      heroLede.textContent = paused
        ? heroLede.dataset.phoneText ||
          'Trays cut in squares. Wings that won the town. Call it in.'
        : heroLede.dataset.onlineText;
    }
    var orderLede = document.querySelector('[data-apex-order-lede]');
    if (orderLede) {
      if (!orderLede.dataset.onlineText) {
        orderLede.dataset.onlineText = orderLede.textContent;
      }
      orderLede.textContent = paused
        ? orderLede.dataset.phoneText ||
          'Call it in the old way. Same kitchen, same trays — we’ll have it hot for pickup or the table.'
        : orderLede.dataset.onlineText;
    }

    if (banner) {
      // Only show capacity warnings when ordering is still offered.
      if (msg && !paused) {
        banner.hidden = false;
        banner.textContent = msg;
        banner.classList.add('is-warn');
        banner.classList.remove('is-blocked');
      } else {
        banner.hidden = true;
      }
    }

    var barStatus = $('orderbarStatus');
    if (barStatus && paused) {
      // Don't advertise "ordering paused" on a site sold without ordering.
      if (!barStatus.dataset.openText) {
        barStatus.dataset.openText = barStatus.textContent;
      }
      // Leave open/closed status from hours script if present; only clear our pause label.
      if (barStatus.textContent === 'Ordering paused') {
        barStatus.textContent = barStatus.dataset.openText || 'Open now';
      }
    }

    if (paused && $('apexOverlay') && !$('apexOverlay').hidden) {
      closeModal();
    }

    var badge = $('apexCartBadge');
    if (badge) {
      var n = cartCount();
      badge.hidden = n === 0;
      badge.textContent = String(n);
    }
  }

  async function ensureClient() {
    if (sb) return sb;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('supabase_js_missing');
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return sb;
  }

  async function loadCatalog() {
    var client = await ensureClient();
    var restRes = await client
      .from('restaurants')
      .select('id, organization_id, name, public_token')
      .eq('public_token', PUBLIC_TOKEN)
      .maybeSingle();
    if (restRes.error) throw restRes.error;
    if (!restRes.data) throw new Error('restaurant_not_found');
    restaurant = restRes.data;

    var results = await Promise.all([
      client
        .from('restaurant_settings')
        .select('paused, fee_cents, tax_rate, prep_minutes, payment_mode, stripe_charges_enabled, square_charges_enabled')
        .eq('restaurant_id', restaurant.id)
        .maybeSingle(),
      client
        .from('menu_categories')
        .select('id, name, sort_order')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order'),
      client
        .from('menu_items')
        .select('id, category_id, name, description, price_cents, available, sort_order')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order'),
      client
        .from('modifier_groups')
        .select('id, menu_item_id, name, min_select, max_select, required')
        .eq('organization_id', restaurant.organization_id),
      client
        .from('modifier_options')
        .select('id, modifier_group_id, name, price_delta_cents')
        .eq('organization_id', restaurant.organization_id),
      client.rpc('capacity_snapshot', { p_restaurant_id: restaurant.id }),
    ]);

    if (results[0].error) throw results[0].error;
    if (results[1].error) throw results[1].error;
    if (results[2].error) throw results[2].error;
    if (results[3].error) throw results[3].error;
    if (results[4].error) throw results[4].error;

    settings = results[0].data || {
      paused: false,
      fee_cents: 0,
      tax_rate: 0,
      prep_minutes: 30,
    };
    categories = results[1].data || [];
    items = results[2].data || [];

    var groupRows = results[3].data || [];
    var optionRows = results[4].data || [];
    var optsByGroup = {};
    optionRows.forEach(function (o) {
      if (!optsByGroup[o.modifier_group_id]) optsByGroup[o.modifier_group_id] = [];
      optsByGroup[o.modifier_group_id].push(o);
    });
    groupsByItem = {};
    groupRows.forEach(function (g) {
      if (!g.menu_item_id) return;
      if (!groupsByItem[g.menu_item_id]) groupsByItem[g.menu_item_id] = [];
      groupsByItem[g.menu_item_id].push({
        id: g.id,
        name: g.name,
        required: !!g.required,
        min: g.min_select || 0,
        max: g.max_select || 1,
        options: optsByGroup[g.id] || [],
      });
    });

    var capRaw = results[5].data;
    if (!results[5].error && capRaw) {
      capacity = typeof capRaw === 'object' ? capRaw : null;
    }

    loaded = true;
    loadError = null;
    syncChrome();
  }

  async function refreshCapacity() {
    if (!restaurant) return;
    try {
      var client = await ensureClient();
      var res = await client.rpc('capacity_snapshot', {
        p_restaurant_id: restaurant.id,
      });
      if (!res.error && res.data) capacity = res.data;
      if (restaurant) {
        var s = await client
          .from('restaurant_settings')
          .select('paused, fee_cents, tax_rate, prep_minutes, payment_mode, stripe_charges_enabled, square_charges_enabled')
          .eq('restaurant_id', restaurant.id)
          .maybeSingle();
        if (!s.error && s.data) settings = s.data;
      }
      syncChrome();
      if (!$('apexOverlay').hidden) render();
    } catch (_) {}
  }

  function lineKey(itemId, mods) {
    var ids = mods
      .map(function (m) {
        return m.option_id;
      })
      .sort()
      .join(',');
    return itemId + '|' + ids;
  }

  var CART_KEY = 'apexCart';
  var GUEST_KEY = 'apexGuest';

  /// Name, phone and notes typed at checkout. Kept for the same reason the cart
  /// is: leaving for Stripe and coming back should not mean typing it all again,
  /// and the point someone has already entered their details is an expensive
  /// place to lose them.
  ///
  /// Session storage, so it belongs to this tab and this visit -- their own
  /// details on their own device, gone when the tab closes. Nothing is sent
  /// anywhere it would not already have gone with the order.
  var guest = { name: '', phone: '', notes: '' };

  function saveGuest(next) {
    guest = {
      name: (next && next.name) || '',
      phone: (next && next.phone) || '',
      notes: (next && next.notes) || '',
    };
    try {
      sessionStorage.setItem(GUEST_KEY, JSON.stringify(guest));
    } catch (ignored) {
      // Private browsing. They will retype it, which is where we started.
    }
  }

  function restoreGuest() {
    try {
      var raw = sessionStorage.getItem(GUEST_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') {
        guest = {
          name: String(saved.name || ''),
          phone: String(saved.phone || ''),
          notes: String(saved.notes || ''),
        };
      }
    } catch (ignored) {
      // Corrupt or unavailable; an empty form is a fine fallback.
    }
  }

  /// The cart lived only in memory, so paying navigated the browser to Stripe
  /// and anyone who backed out returned to an empty basket -- their order sat
  /// unpaid in the database while they had to rebuild it from scratch. Session
  /// storage keeps it for the tab without outliving the visit.
  function saveCart() {
    try {
      sessionStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch (ignored) {
      // Private browsing or a full quota. The cart still works for this page.
    }
  }

  function restoreCart() {
    var raw;
    try {
      raw = sessionStorage.getItem(CART_KEY);
    } catch (ignored) {
      return;
    }
    if (!raw) return;
    try {
      var saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return;
      // Prices and availability may have moved while they were away, so keep
      // only lines whose item is still on the menu, and re-read the price from
      // the live catalog rather than trusting what was stored.
      cart = saved.filter(function (line) {
        if (!line || !line.menu_item_id || !line.quantity) return false;
        var item = items.find(function (i) {
          return i.id === line.menu_item_id;
        });
        if (!item || item.available === false) return false;
        line.unitPriceCents =
          item.price_cents +
          (line.modifiers || []).reduce(function (n, m) {
            return n + (m.price_delta_cents || 0);
          }, 0);
        line.name = item.name;
        return true;
      });
    } catch (ignored) {
      cart = [];
    }
  }

  function addLine(item, mods) {
    var key = lineKey(item.id, mods);
    var existing = cart.find(function (l) {
      return l.key === key;
    });
    var unit =
      item.price_cents +
      mods.reduce(function (n, m) {
        return n + (m.price_delta_cents || 0);
      }, 0);
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        key: key,
        menu_item_id: item.id,
        name: item.name,
        quantity: 1,
        unitPriceCents: unit,
        modifiers: mods,
      });
    }
    saveCart();
    syncChrome();
    render();
  }

  function bump(key, delta) {
    var line = cart.find(function (l) {
      return l.key === key;
    });
    if (!line) return;
    line.quantity += delta;
    if (line.quantity <= 0) {
      cart = cart.filter(function (l) {
        return l.key !== key;
      });
    }
    saveCart();
    syncChrome();
    render();
  }

  /// Reveals the ordering panel without deciding which screen it shows.
  ///
  /// Split out from openModal because a guest returning from Stripe needs the
  /// panel opened on their receipt, not reset to the menu -- and needs it even
  /// if ordering was paused while they were away. Their card is already
  /// charged; hiding the confirmation behind a pause notice would leave them
  /// with no evidence the order exists.
  function showOverlay() {
    var ov = $('apexOverlay');
    if (!ov) return;
    ov.hidden = false;
    document.body.classList.add('apex-lock');
  }

  function openModal() {
    if (isPaused()) {
      alert('Online ordering is paused right now. Please call (717) 732-7708.');
      return;
    }
    showOverlay();
    view = 'menu';
    render();
    if (!loaded) {
      boot().then(render).catch(function (e) {
        loadError = (e && e.message) || 'Could not load the live menu.';
        render();
      });
    } else {
      refreshCapacity();
    }
  }

  function closeModal() {
    $('apexOverlay').hidden = true;
    document.body.classList.remove('apex-lock');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderMenu() {
    if (loadError) {
      return (
        '<div class="apex-empty">' +
        esc(loadError) +
        '<br><button type="button" class="apex-link" data-apex-retry>Try again</button></div>'
      );
    }
    if (!loaded) {
      return '<div class="apex-empty">Loading live menu…</div>';
    }

    var html = '';
    var cap = capacityMessage();
    if (cap) {
      html +=
        '<div class="apex-banner ' +
        (isPaused() ? 'is-blocked' : 'is-warn') +
        '">' +
        esc(cap) +
        '</div>';
    }

    // Jump links. A hundred-plus items in one scrolling column means someone
    // hunting for wings reads the whole menu to find them -- and on a phone
    // that is a lot of thumb. Built from the same filter the sections use, so
    // a chip can never point at a heading that was skipped.
    var shownCats = categories.filter(function (cat) {
      return items.some(function (i) {
        return i.category_id === cat.id && i.available !== false;
      });
    });
    if (shownCats.length > 1) {
      html += '<nav class="apex-jump" aria-label="Jump to a section">';
      shownCats.forEach(function (cat) {
        html +=
          '<button type="button" class="apex-chip" data-jump="apexCat-' +
          esc(cat.id) +
          '">' +
          esc(cat.name) +
          '</button>';
      });
      html += '</nav>';
    }

    categories.forEach(function (cat) {
      var catItems = items.filter(function (i) {
        return i.category_id === cat.id;
      });
      var availableItems = catItems.filter(function (i) {
        return i.available !== false;
      });
      // Guest view: skip archived/stub categories with nothing orderable.
      if (!availableItems.length) return;
      html +=
        '<section class="apex-cat" id="apexCat-' +
        esc(cat.id) +
        '"><h3>' +
        esc(cat.name) +
        '</h3><div class="apex-cat-items">';
      catItems.forEach(function (item) {
        var sold = item.available === false;
        if (sold) return;
        html +=
          '<button type="button" class="apex-item" data-add="' +
          esc(item.id) +
          '"' +
          (sold || isPaused() ? ' disabled' : '') +
          '>' +
          '<span class="apex-item-main"><strong>' +
          esc(item.name) +
          '</strong>' +
          (item.description
            ? '<span class="apex-desc">' + esc(item.description) + '</span>'
            : '') +
          (sold ? '<span class="apex-sold">Sold out</span>' : '') +
          '</span>' +
          '<span class="apex-price">' +
          money(item.price_cents) +
          ((groupsByItem[item.id] || []).length
            ? '<span class="apex-desc">Customize</span>'
            : '') +
          '</span></button>';
      });
      html += '</div></section>';
    });

    if (!html) {
      html = '<div class="apex-empty">No menu items available right now.</div>';
    }
    return html;
  }

  function renderCart() {
    if (!cart.length) {
      return (
        '<div class="apex-empty">Cart is empty.' +
        '<br><button type="button" class="apex-link" data-apex-view="menu">Back to menu</button></div>'
      );
    }
    var html = '<div class="apex-cart-list">';
    cart.forEach(function (line) {
      var modLabel = line.modifiers
        .map(function (m) {
          return m.name;
        })
        .join(', ');
      html +=
        '<div class="apex-cart-row">' +
        '<div><strong>' +
        esc(line.name) +
        '</strong>' +
        (modLabel ? '<div class="apex-desc">' + esc(modLabel) + '</div>' : '') +
        '<div class="apex-desc">' +
        money(line.unitPriceCents) +
        ' each</div></div>' +
        '<div class="apex-qty">' +
        '<button type="button" data-bump="' +
        esc(line.key) +
        '" data-delta="-1">−</button>' +
        '<span>' +
        line.quantity +
        '</span>' +
        '<button type="button" data-bump="' +
        esc(line.key) +
        '" data-delta="1">+</button>' +
        '</div></div>';
    });
    html += '</div>';

    var sub = cartSubtotal();

    // Pay at pickup stays the default. Someone who has always phoned this order
    // in should not have to make a payment decision to get dinner, and a card
    // form is the easiest place to lose an order.
    if (canPayNow()) {
      html +=
        '<div class="apex-paychoice" role="radiogroup" aria-label="How would you like to pay?">' +
        '<button type="button" role="radio" aria-checked="' +
        (!payNow ? 'true' : 'false') +
        '" class="apex-paybtn' +
        (!payNow ? ' is-on' : '') +
        '" data-paynow="0">Pay at pickup</button>' +
        '<button type="button" role="radio" aria-checked="' +
        (payNow ? 'true' : 'false') +
        '" class="apex-paybtn' +
        (payNow ? ' is-on' : '') +
        '" data-paynow="1">Pay now by card</button>' +
        '</div>';
    }

    html +=
      '<div class="apex-totals">' +
      '<div><span>Subtotal</span><span>' +
      money(sub) +
      '</span></div>' +
      '<div><span>Fee</span><span>' +
      money(feeCents()) +
      '</span></div>' +
      '<div><span>Tax</span><span>' +
      money(taxCents(sub)) +
      '</span></div>';

    // Only shown when it is actually being charged, so the pay-at-pickup total
    // never carries a line the guest has to work out they are not paying.
    if (serviceFeeCents(sub) > 0) {
      html +=
        '<div><span>Service fee</span><span>' +
        money(serviceFeeCents(sub)) +
        '</span></div>';
    }

    html +=
      '<div class="apex-total"><span>Total</span><span>' +
      money(totalCents(sub)) +
      '</span></div>' +
      '<p class="apex-note">' +
      (payNow
        ? 'You will be taken to a secure checkout to pay. Your food is made after payment.'
        : 'Final total is confirmed by the kitchen when you place the order.') +
      '</p>' +
      '</div>';

    html +=
      '<form class="apex-form" id="apexCheckoutForm">' +
      '<label>Name<input name="name" required autocomplete="name" value="' +
      esc(guest.name || '') +
      '" /></label>' +
      '<label>Phone<input name="phone" required autocomplete="tel" inputmode="tel" value="' +
      esc(guest.phone || '') +
      '" /></label>' +
      '<label>Notes<textarea name="notes" rows="2" placeholder="Extra ranch, no onion…">' +
      esc(guest.notes || '') +
      '</textarea></label>' +
      '<button type="submit" class="apex-primary" ' +
      (placing || isPaused() ? 'disabled' : '') +
      '>' +
      (placing
        ? payNow
          ? 'Taking you to checkout…'
          : 'Placing…'
        : (payNow ? 'Pay ' : 'Place order · ') + money(totalCents(sub))) +
      '</button>' +
      '<button type="button" class="apex-link" data-apex-view="menu">Keep browsing</button>' +
      '</form>';
    return html;
  }

  function renderSuccess() {
    var code = (lastOrder && lastOrder.public_token) || '';
    var total = (lastOrder && lastOrder.total_cents) || 0;
    var mins =
      (settings && settings.prep_minutes) || 30;
    // Coming back from Stripe we know the order code but not the amount -- the
    // browser never saw the confirmed total, and the webhook is what actually
    // marks it paid. Say what is true rather than printing $0.00.
    var fromCheckout = !!(lastOrder && lastOrder.paid_pending_confirmation);

    return (
      '<div class="apex-success">' +
      '<p class="apex-kicker">' +
      (fromCheckout ? 'Payment received' : 'Order placed') +
      '</p>' +
      '<p class="apex-code">' +
      esc(code) +
      '</p>' +
      '<p>Show this code at pickup.</p>' +
      (fromCheckout
        ? '<p>Paid by card — nothing to pay when you collect. Ready in about ' +
          mins +
          ' minutes.</p>'
        : '<p><strong>' +
          money(total) +
          '</strong> · ready in about ' +
          mins +
          ' minutes.</p>') +
      '<button type="button" class="apex-primary" data-apex-copy="' +
      esc(code) +
      '">Copy code</button>' +
      '<button type="button" class="apex-link" data-apex-done>Done</button>' +
      '</div>'
    );
  }

  function render() {
    var body = $('apexBody');
    var title = $('apexTitle');
    var cartBtn = $('apexCartBtn');
    if (!body || !title) return;

    if (view === 'cart') {
      title.textContent = 'Checkout';
      body.innerHTML = renderCart();
      var form = $('apexCheckoutForm');
      if (form) {
        form.addEventListener('submit', onCheckout);
      }
    } else if (view === 'success') {
      title.textContent = 'You’re set';
      body.innerHTML = renderSuccess();
    } else {
      title.textContent = (restaurant && restaurant.name) || 'Order online';
      body.innerHTML = renderMenu();
    }

    if (cartBtn) {
      cartBtn.hidden = view !== 'menu';
      cartBtn.disabled = cartCount() === 0 || isPaused();
    }
  }

  function pickModifiers(item, groups) {
    return new Promise(function (resolve) {
      if (!groups || !groups.length) {
        resolve([]);
        return;
      }
      var sheet = $('apexModSheet');
      var body = $('apexModBody');
      var selected = {};
      body.innerHTML =
        '<p class="apex-mod-title">' +
        esc(item.name) +
        '</p>' +
        groups
          .map(function (g) {
            return (
              '<fieldset data-group="' +
              esc(g.id) +
              '"><legend>' +
              esc(g.name) +
              (g.required ? ' *' : '') +
              '</legend>' +
              g.options
                .map(function (o) {
                  var inputType = g.max > 1 ? 'checkbox' : 'radio';
                  return (
                    '<label class="apex-mod-opt"><input type="' +
                    inputType +
                    '" name="g_' +
                    esc(g.id) +
                    '" value="' +
                    esc(o.id) +
                    '" data-name="' +
                    esc(o.name) +
                    '" data-delta="' +
                    (o.price_delta_cents || 0) +
                    '" />' +
                    '<span>' +
                    esc(o.name) +
                    (o.price_delta_cents
                      ? ' · +' + money(o.price_delta_cents)
                      : '') +
                    '</span></label>'
                  );
                })
                .join('') +
              '</fieldset>'
            );
          })
          .join('') +
        '<button type="button" class="apex-primary" id="apexModConfirm">Add to order</button>' +
        '<button type="button" class="apex-link" id="apexModCancel">Cancel</button>';

      sheet.hidden = false;

      function cleanup(result) {
        sheet.hidden = true;
        resolve(result);
      }

      $('apexModCancel').onclick = function () {
        cleanup(null);
      };
      $('apexModConfirm').onclick = function () {
        var mods = [];
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          var inputs = body.querySelectorAll(
            '[name="g_' + g.id + '"]:checked'
          );
          if (g.required && inputs.length < (g.min || 1)) {
            alert('Pick an option for ' + g.name);
            return;
          }
          if (g.max && inputs.length > g.max) {
            alert('Too many options for ' + g.name);
            return;
          }
          inputs.forEach(function (inp) {
            mods.push({
              option_id: inp.value,
              name: inp.getAttribute('data-name'),
              price_delta_cents: Number(inp.getAttribute('data-delta') || 0),
            });
          });
        }
        cleanup(mods);
      };
    });
  }

  async function onAdd(itemId) {
    var item = items.find(function (i) {
      return i.id === itemId;
    });
    if (!item || item.available === false || isPaused()) return;
    var groups = groupsByItem[item.id] || [];
    var mods = await pickModifiers(item, groups);
    if (mods === null) return;
    addLine(item, mods || []);
  }

  async function onCheckout(ev) {
    ev.preventDefault();
    if (placing || isPaused() || !cart.length || !restaurant) return;
    var fd = new FormData(ev.target);
    var name = String(fd.get('name') || '').trim();
    var phone = String(fd.get('phone') || '').trim();
    var notes = String(fd.get('notes') || '').trim();
    if (!name || !phone) {
      alert('Name and phone are required.');
      return;
    }
    saveGuest({ name: name, phone: phone, notes: notes });

    placing = true;
    render();
    try {
      await refreshCapacity();
      if (isPaused()) throw new Error('ordering_paused');

      var client = await ensureClient();
      var payload = {
        p_restaurant_id: restaurant.id,
        p_public_token: restaurant.public_token || PUBLIC_TOKEN,
        p_customer_name: name,
        p_customer_phone: phone,
        p_notes: notes,
        p_pickup_minutes: settings.prep_minutes || 30,
        p_payment_mode: payNow ? 'pay_now' : 'pay_at_pickup',
        p_items: cart.map(function (line) {
          return {
            menu_item_id: line.menu_item_id,
            quantity: line.quantity,
            modifiers: line.modifiers.map(function (m) {
              return { option_id: m.option_id };
            }),
          };
        }),
      };
      var res = await client.rpc('place_order', payload);
      if (res.error) throw res.error;
      var data = res.data;
      if (Array.isArray(data)) data = data[0];
      if (!data || !data.public_token) throw new Error('place_order_empty');

      if (payNow) {
        // The order exists but is unpaid, and the kitchen does not see it until
        // Stripe says otherwise. Keep the cart until the browser has actually
        // left for checkout, so a failure here leaves the guest where they were
        // rather than staring at an empty basket with nothing bought.
        var pay = await client.functions.invoke('create-guest-payment', {
          body: { order_id: data.id, public_token: data.public_token },
        });
        var url = pay && pay.data && pay.data.url;
        if (pay && pay.error) throw pay.error;
        if (!url) throw new Error('no_checkout_url');
        try {
          sessionStorage.setItem('apexPendingOrder', data.public_token);
        } catch (ignored) {
          // Private browsing. The return screen degrades, payment still works.
        }
        window.location.assign(url);
        return;
      }

      lastOrder = data;
      cart = [];
      saveCart();
      saveGuest(null);
      view = 'success';
      syncChrome();
    } catch (e) {
      var msg = (e && (e.message || e.error_description)) || '';
      if (/paused|ordering_paused/i.test(msg)) {
        alert('Ordering was just paused. Please call (717) 732-7708.');
      } else if (/too_many_open_orders/i.test(msg)) {
        alert('Kitchen is slammed — try again in a few minutes or call us.');
      } else if (/stripe_not_connected/i.test(msg)) {
        // The venue disconnected Stripe between page load and checkout.
        payNow = false;
        alert('Card payment is unavailable right now — you can still order and pay at pickup.');
      } else if (/no_checkout_url|create-guest-payment|FunctionsError/i.test(msg)) {
        alert(
          'We could not open the card checkout. Nothing has been charged — ' +
            'try again, or switch to Pay at pickup.'
        );
      } else {
        alert('Could not place order. Check your connection and try again.');
      }
    } finally {
      placing = false;
      render();
    }
  }

  function onBodyClick(ev) {
    var t = ev.target.closest('[data-jump]');
    if (t) {
      var target = document.getElementById(t.getAttribute('data-jump'));
      if (target) {
        // Scroll the panel body, not the page behind it.
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    t = ev.target.closest('[data-paynow]');
    if (t) {
      payNow = t.getAttribute('data-paynow') === '1';
      render(); // Totals move when this changes, so redraw rather than restyle.
      return;
    }
    t = ev.target.closest('[data-add]');
    if (t) {
      onAdd(t.getAttribute('data-add'));
      return;
    }
    t = ev.target.closest('[data-bump]');
    if (t) {
      bump(t.getAttribute('data-bump'), Number(t.getAttribute('data-delta')));
      return;
    }
    t = ev.target.closest('[data-apex-view]');
    if (t) {
      view = t.getAttribute('data-apex-view');
      render();
      return;
    }
    t = ev.target.closest('[data-apex-retry]');
    if (t) {
      boot().then(render).catch(function (e) {
        loadError = (e && e.message) || 'Could not load the live menu.';
        render();
      });
      return;
    }
    t = ev.target.closest('[data-apex-copy]');
    if (t) {
      var code = t.getAttribute('data-apex-copy') || '';
      if (navigator.clipboard && code) {
        navigator.clipboard.writeText(code).catch(function () {});
      }
      t.textContent = 'Copied';
      return;
    }
    t = ev.target.closest('[data-apex-done]');
    if (t) {
      closeModal();
      view = 'menu';
      lastOrder = null;
    }
  }

  /// Stripe sends the guest back here with ?paid=1&code=XXXX (or paid=0 if they
  /// backed out). Read it before anything else so someone returning from
  /// checkout sees their order rather than the menu again, wondering whether
  /// their card went through.
  ///
  /// Only ever a display decision. The order is marked paid by the Stripe
  /// webhook, never by this parameter -- anyone can type `?paid=1`, and a page
  /// that believed it would tell a guest their unpaid food was on its way.
  function consumePaymentReturn() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (ignored) {
      return;
    }
    var paid = params.get('paid');
    if (paid !== '1' && paid !== '0') return;

    var code = (params.get('code') || '').trim();
    if (!code) {
      try {
        code = sessionStorage.getItem('apexPendingOrder') || '';
      } catch (ignored) {
        code = '';
      }
    }
    try {
      sessionStorage.removeItem('apexPendingOrder');
    } catch (ignored) {
      // Nothing to clean up in private browsing.
    }

    returnedFromCheckout = true;

    if (paid === '1' && code) {
      cart = [];
      saveCart();
      saveGuest(null);
      lastOrder = { public_token: code, paid_pending_confirmation: true };
      view = 'success';
    } else if (paid === '0') {
      // Cancelled at Stripe. The order exists but is unpaid and the kitchen has
      // not seen it, so send them back to the cart rather than pretending
      // something happened.
      payNow = true;
      view = 'cart';
    }

    // Strip the parameters so a refresh, or a shared link, does not replay a
    // payment screen for an order this browser may not own.
    try {
      var clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, '', clean);
    } catch (ignored) {
      // Old browser. The screen is still right; the URL is just untidy.
    }
  }

  async function boot() {
    consumePaymentReturn();
    await loadCatalog();
    // After the catalog, never before -- restoring re-reads prices from the
    // live menu rather than trusting what the browser stored.
    if (!returnedFromCheckout) {
      restoreCart();
      restoreGuest();
    }
    syncChrome();
    subscribeCatalogRealtime();
  }

  function subscribeCatalogRealtime() {
    if (!restaurant || !sb) return;
    if (catalogChannel) sb.removeChannel(catalogChannel);
    catalogChannel = sb
      .channel('guest-menu-' + restaurant.id)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'menu_items',
          filter: 'restaurant_id=eq.' + restaurant.id,
        },
        function () {
          loadCatalog().then(render).catch(function () {});
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'restaurant_settings',
          filter: 'restaurant_id=eq.' + restaurant.id,
        },
        function () {
          loadCatalog().then(render).catch(function () {});
        }
      )
      .subscribe();
  }

  function init() {
    document.querySelectorAll('[data-apex-open]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.preventDefault();
        openModal();
      });
    });
    var close = $('apexClose');
    if (close) close.addEventListener('click', closeModal);
    var backdrop = $('apexBackdrop');
    if (backdrop) backdrop.addEventListener('click', closeModal);
    var cartBtn = $('apexCartBtn');
    if (cartBtn) {
      cartBtn.addEventListener('click', function () {
        view = 'cart';
        render();
      });
    }
    var body = $('apexBody');
    if (body) body.addEventListener('click', onBodyClick);

    // Warm the catalog + capacity so the bar can show pause state early.
    //
    // boot() also reads the Stripe return parameters. When it finds them, open
    // the panel on whatever screen they chose -- a guest who has just paid must
    // land on their order code, not on the homepage wondering whether the
    // charge went through.
    boot()
      .then(function () {
        if (returnedFromCheckout) {
          showOverlay();
          render();
        }
      })
      .catch(function () {
        // The menu failed to load, but a paid guest still deserves their code.
        if (returnedFromCheckout) {
          showOverlay();
          render();
        }
      });
    setInterval(refreshCapacity, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
