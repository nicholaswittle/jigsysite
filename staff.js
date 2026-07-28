/**
 * Jigsy staff console → Apex Supabase.
 * Ported patterns from jigsysiteworking/staff-demo.js (alerts, prep, print, mark paid).
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://pqkremkwfkudrhtxasdj.supabase.co';
  var SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBxa3JlbWt3Zmt1ZHJodHhhc2RqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4OTU2MDUsImV4cCI6MjA5NzQ3MTYwNX0.zF-UpQs8seDPmZT182CRoMpk7ZATzQrfpKiBbLWkKhQ';
  var PUBLIC_TOKEN = 'jigsys';

  var ALERT_REPEAT_MS = 30000;
  var ALERT_ESCALATE_MS = 120000;

  var sb = null;
  var restaurant = null;
  var settings = null;
  var orders = [];
  var filter = 'waiting';
  var channel = null;
  var menuCategories = [];
  var menuItems = [];
  var activeAvailabilityCategory = null;
  var staffView = 'orders';
  var wakeLock = null;
  var alertedAt = new Map();
  var waitingSince = new Map();
  var alertTracks = {};
  var unlockPromise = null;
  var toastTimer = null;
  var alertsEnabled = false;
  var entered = false;

  function $(id) {
    return document.getElementById(id);
  }

  function showPanel(authVisible) {
    var auth = $('staffAuth');
    var app = $('staffApp');
    if (auth) {
      auth.classList.toggle('is-hidden', !authVisible);
      auth.hidden = !authVisible;
    }
    if (app) {
      app.classList.toggle('is-open', !authVisible);
      app.hidden = authVisible;
    }
  }

  function money(cents) {
    return '$' + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg) {
    var t = $('toast');
    t.hidden = false;
    t.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, 4000);
  }

  function setConn(ok, label) {
    var el = $('connStatus');
    el.textContent = label || (ok ? 'Live' : 'Offline');
    el.classList.toggle('is-live', !!ok);
  }

  function client() {
    if (!sb) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return sb;
  }

  function todayStartIso() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  async function loadRestaurant() {
    var res = await client()
      .from('restaurants')
      .select('id, organization_id, name, public_token')
      .eq('public_token', PUBLIC_TOKEN)
      .maybeSingle();
    if (res.error) throw res.error;
    if (!res.data) throw new Error('restaurant_not_found');
    restaurant = res.data;
    $('restName').textContent = restaurant.name || "Jigsy's";
  }

  async function refresh() {
    if (!restaurant) return;
    var results = await Promise.all([
      client()
        .from('restaurant_settings')
        .select(
          'paused, prep_minutes, fee_cents, tax_rate, payment_mode, restaurant_id, organization_id'
        )
        .eq('restaurant_id', restaurant.id)
        .maybeSingle(),
      client()
        .from('online_orders')
        .select(
          'id, public_token, status, submitted_at, accepted_at, completed_at, rejected_at, ' +
            'reject_reason, pickup_minutes, customer_json, notes, ' +
            'subtotal_cents, fee_cents, tax_cents, total_cents, payment_status, payment_mode, ' +
            'order_items(id, name, price_cents, quantity, notes, ' +
            'order_item_modifiers(name, price_delta_cents))'
        )
        .eq('restaurant_id', restaurant.id)
        .order('submitted_at', { ascending: false })
        .limit(80),
    ]);
    if (results[0].error) throw results[0].error;
    if (results[1].error) throw results[1].error;
    settings = results[0].data;
    orders = results[1].data || [];
    setConn(true, 'Live');
    renderControls();
    renderStats();
    renderOrders();
    reviewWaitingAlerts(orders);
  }

  function renderControls() {
    if (!settings) return;
    var pause = $('pauseToggle');
    pause.setAttribute('aria-checked', String(!!settings.paused));
    $('prepOut').textContent = (settings.prep_minutes || 30) + ' min';
    $('payMode').textContent =
      settings.payment_mode === 'square'
        ? 'Square mode'
        : 'Manual · pay at pickup (Square at counter)';
  }

  function renderStats() {
    var start = new Date(todayStartIso()).getTime();
    var today = orders.filter(function (o) {
      return new Date(o.submitted_at).getTime() >= start;
    });
    var waiting = today.filter(function (o) {
      return o.status === 'waiting';
    }).length;
    var done = today.filter(function (o) {
      return o.status === 'completed';
    });
    var rejected = today.filter(function (o) {
      return o.status === 'rejected';
    }).length;
    var sales = done.reduce(function (n, o) {
      return n + (o.total_cents || 0);
    }, 0);
    $('statWait').textContent = String(waiting);
    $('statDone').textContent = String(done.length);
    $('statRejected').textContent = String(rejected);
    $('statSales').textContent = money(sales);
  }

  function customer(order) {
    var c = order.customer_json || {};
    return { name: c.name || 'Guest', phone: c.phone || '' };
  }

  function lineDetail(item) {
    var mods = (item.order_item_modifiers || [])
      .map(function (m) {
        return m.name;
      })
      .filter(Boolean);
    var bits = mods.slice();
    if (item.notes) bits.push(item.notes);
    return bits.join(', ');
  }

  function renderOrders() {
    var list = $('orderList');
    var visible = orders.filter(function (o) {
      if (filter === 'all') return true;
      return o.status === filter;
    });
    if (!visible.length) {
      list.innerHTML = '<p class="fine">No orders in this view.</p>';
      return;
    }
    list.innerHTML = visible
      .map(function (o) {
        var cust = customer(o);
        var ageMs = Date.now() - new Date(o.submitted_at).getTime();
        var urgent = o.status === 'waiting' && ageMs >= ALERT_ESCALATE_MS;
        var when = new Date(o.submitted_at).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });
        var lines = (o.order_items || [])
          .map(function (it) {
            var d = lineDetail(it);
            return (
              '<div><strong>' +
              esc(it.quantity) +
              '× ' +
              esc(it.name) +
              '</strong>' +
              (d ? ' · ' + esc(d) : '') +
              '</div>'
            );
          })
          .join('');
        var actions = '';
        if (o.status === 'waiting') {
          actions =
            '<button type="button" class="ok" data-accept="' +
            esc(o.id) +
            '">Accept &amp; print</button>' +
            '<button type="button" class="danger" data-reject="' +
            esc(o.id) +
            '">Reject</button>';
        } else if (o.status === 'accepted' || o.status === 'completed') {
          actions =
            '<button type="button" class="action" data-print="' +
            esc(o.id) +
            '">Re-print</button>' +
            '<span class="fine">Pay at counter · ' +
            money(o.total_cents) +
            '</span>';
        } else {
          actions =
            '<span class="fine">' +
            esc(o.reject_reason || o.status) +
            '</span>';
        }
        return (
          '<article class="order-card' +
          (urgent ? ' is-urgent' : '') +
          '">' +
          '<div class="order-top"><span class="token">#' +
          esc(o.public_token) +
          '</span><span class="meta">' +
          esc(when) +
          ' · ' +
          esc(o.pickup_minutes || 30) +
          ' min · ' +
          esc(o.status) +
          '</span></div>' +
          '<div><strong>' +
          esc(cust.name) +
          '</strong> · ' +
          esc(cust.phone) +
          '</div>' +
          '<div class="due">' +
          money(o.total_cents) +
          ' due at pickup</div>' +
          (o.notes
            ? '<div class="meta">NOTE: ' + esc(o.notes) + '</div>'
            : '') +
          '<div class="lines">' +
          lines +
          '</div>' +
          '<div class="actions">' +
          actions +
          '</div></article>'
        );
      })
      .join('');
  }

  async function patchSettings(patch) {
    var res = await client()
      .from('restaurant_settings')
      .update(patch)
      .eq('restaurant_id', restaurant.id);
    if (res.error) throw res.error;
    await refresh();
  }

  async function patchOrder(id, patch) {
    var res = await client()
      .from('online_orders')
      .update(patch)
      .eq('id', id)
      .eq('restaurant_id', restaurant.id);
    if (res.error) throw res.error;
    await refresh();
  }

  async function acceptOrder(id) {
    var now = new Date().toISOString();
    // One tap: kitchen accept + ticket. Pay at counter is separate.
    await patchOrder(id, {
      status: 'completed',
      accepted_at: now,
      completed_at: now,
    });
    showToast('Accepted — printing ticket.');
    printOrder(id);
  }

  async function rejectOrder(id) {
    var reason = window.prompt('Reject reason?', 'Kitchen too busy') || '';
    if (!reason) return;
    await patchOrder(id, {
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      reject_reason: reason,
    });
    showToast('Rejected.');
  }

  function ticketMarkup(order) {
    var cust = customer(order);
    var items = (order.order_items || [])
      .map(function (item) {
        var d = lineDetail(item);
        return (
          '<div class="ticket-item"><strong>' +
          esc(item.quantity) +
          '× ' +
          esc(item.name) +
          '</strong><span>' +
          money(item.price_cents * item.quantity) +
          '</span>' +
          (d ? '<small>' + esc(d) + '</small>' : '') +
          '</div>'
        );
      })
      .join('');
    return (
      '<div class="ticket-center"><strong class="ticket-brand">JIGSY\'S</strong><br>ONLINE PICKUP</div>' +
      '<div class="ticket-rule"></div>' +
      '<div class="ticket-big">#' +
      esc(order.public_token) +
      '</div>' +
      '<div><strong>ACCEPTED:</strong> ' +
      new Date(order.accepted_at || Date.now()).toLocaleString() +
      '</div>' +
      '<div><strong>REQUESTED:</strong> ' +
      new Date(order.submitted_at).toLocaleString() +
      '</div>' +
      '<div><strong>PICKUP:</strong> About ' +
      esc(order.pickup_minutes || 30) +
      ' minutes</div>' +
      '<div class="ticket-rule"></div>' +
      '<div><strong>' +
      esc(cust.name) +
      '</strong></div>' +
      '<div>' +
      esc(cust.phone) +
      '</div>' +
      (order.notes
        ? '<div class="ticket-note">NOTE: ' + esc(order.notes) + '</div>'
        : '') +
      '<div class="ticket-rule"></div>' +
      items +
      '<div class="ticket-rule"></div>' +
      '<div class="ticket-total"><span>Subtotal</span><strong>' +
      money(order.subtotal_cents) +
      '</strong></div>' +
      '<div class="ticket-total"><span>Tax</span><strong>' +
      money(order.tax_cents) +
      '</strong></div>' +
      (order.fee_cents
        ? '<div class="ticket-total"><span>Fee</span><strong>' +
          money(order.fee_cents) +
          '</strong></div>'
        : '') +
      '<div class="ticket-total ticket-due"><span>DUE AT PICKUP</span><strong>' +
      money(order.total_cents) +
      '</strong></div>' +
      '<div class="ticket-rule"></div>' +
      '<div class="ticket-center">COLLECT ON SQUARE AT COUNTER<br>THEN MARK PAID IN THIS CONSOLE</div>'
    );
  }

  function printOrder(id) {
    var order = orders.find(function (o) {
      return o.id === id;
    });
    if (!order) return;
    var ticket = $('printTicket');
    ticket.innerHTML = ticketMarkup(order);
    ticket.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      window.print();
    }, 80);
  }

  // —— Alerts (from staff-demo.js) ————————————————————————————————

  function buildBeepTrack(beeps, frequency) {
    var sampleRate = 22050;
    var duration = beeps * 0.28;
    var samples = Math.floor(sampleRate * duration);
    var data = new Float32Array(samples);
    for (var i = 0; i < samples; i++) {
      var t = i / sampleRate;
      var beat = Math.floor(t / 0.28);
      var local = t - beat * 0.28;
      var env = local < 0.18 ? 1 - local / 0.18 : 0;
      data[i] = Math.sin(2 * Math.PI * frequency * t) * env * 0.55;
    }
    var buffer = new ArrayBuffer(44 + samples * 2);
    var view = new DataView(buffer);
    function writeText(offset, text) {
      for (var n = 0; n < text.length; n++) view.setUint8(offset + n, text.charCodeAt(n));
    }
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples * 2, true);
    var o = 44;
    for (var s = 0; s < samples; s++, o += 2) {
      var v = Math.max(-1, Math.min(1, data[s]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  function alertTrack(urgent) {
    var key = urgent ? 'urgent' : 'normal';
    if (!alertTracks[key]) {
      var el = new Audio(buildBeepTrack(urgent ? 3 : 1, urgent ? 988 : 880));
      el.preload = 'auto';
      alertTracks[key] = el;
    }
    return alertTracks[key];
  }

  function unlockAudio() {
    if (unlockPromise) return unlockPromise;
    unlockPromise = Promise.all(
      ['normal', 'urgent'].map(function (key) {
        var el = alertTrack(key === 'urgent');
        el.volume = 0.01;
        return el
          .play()
          .then(function () {
            el.pause();
            el.currentTime = 0;
            el.volume = 1;
          })
          .catch(function () {});
      })
    );
    return unlockPromise;
  }

  function playBeeps(count) {
    var el = alertTrack(count > 1);
    Promise.resolve(unlockPromise).then(function () {
      try {
        el.currentTime = 0;
        el.volume = 1;
        var p = el.play();
        if (p && p.catch) p.catch(function () {});
      } catch (_) {}
    });
  }

  function playOrderAlert(order, options) {
    var urgent = !!(options && options.urgent);
    playBeeps(urgent ? 3 : 1);
    if (window.Notification && Notification.permission === 'granted') {
      try {
        new Notification("Jigsy's · new order #" + order.public_token, {
          body:
            customer(order).name +
            ' · ' +
            money(order.total_cents) +
            ' · pay at pickup',
          tag: 'order-' + order.id,
          renotify: true,
        });
      } catch (_) {}
    }
  }

  function reviewWaitingAlerts(list) {
    if (!alertsEnabled) return;
    var now = Date.now();
    var waitingIds = new Set();
    list.forEach(function (order) {
      if (order.status !== 'waiting') return;
      waitingIds.add(order.id);
      if (!waitingSince.has(order.id)) waitingSince.set(order.id, now);
      var since = waitingSince.get(order.id);
      var last = alertedAt.get(order.id);
      var urgent = now - since >= ALERT_ESCALATE_MS;
      if (!last || now - last >= ALERT_REPEAT_MS) {
        playOrderAlert(order, { urgent: urgent });
        alertedAt.set(order.id, now);
      }
    });
    alertedAt.forEach(function (_v, id) {
      if (!waitingIds.has(id)) alertedAt.delete(id);
    });
    waitingSince.forEach(function (_v, id) {
      if (!waitingIds.has(id)) waitingSince.delete(id);
    });
  }

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () {
        wakeLock = null;
      });
    } catch (_) {}
  }

  function renderAvailability() {
    var countEl = $('availabilityCount');
    var tabsEl = $('availabilityTabs');
    var gridEl = $('menuAvailability');
    if (!countEl || !tabsEl || !gridEl) return;

    if (!menuCategories.length) {
      countEl.textContent = 'No categories';
      tabsEl.innerHTML = '';
      gridEl.innerHTML = '<p class="fine">No menu categories yet.</p>';
      return;
    }

    if (
      !activeAvailabilityCategory ||
      !menuCategories.some(function (c) {
        return c.id === activeAvailabilityCategory;
      })
    ) {
      activeAvailabilityCategory = menuCategories[0].id;
    }

    var cat = menuCategories.find(function (c) {
      return c.id === activeAvailabilityCategory;
    });
    var catItems = menuItems.filter(function (i) {
      return i.category_id === activeAvailabilityCategory;
    });
    var available = catItems.filter(function (i) {
      return i.available !== false;
    }).length;
    var totalAvail = menuItems.filter(function (i) {
      return i.available !== false;
    }).length;

    countEl.textContent =
      available +
      ' of ' +
      catItems.length +
      ' in section · ' +
      totalAvail +
      '/' +
      menuItems.length +
      ' available';

    tabsEl.innerHTML = menuCategories
      .map(function (c) {
        return (
          '<button type="button" class="availability-tab" role="tab" data-availability-category="' +
          esc(c.id) +
          '" aria-selected="' +
          String(c.id === activeAvailabilityCategory) +
          '">' +
          esc(c.name) +
          '</button>'
        );
      })
      .join('');

    if (!catItems.length) {
      gridEl.innerHTML =
        '<section class="availability-group"><h3>' +
        esc(cat ? cat.name : '') +
        '</h3><p class="fine">No items in this section.</p></section>';
      return;
    }

    gridEl.innerHTML =
      '<section class="availability-group"><h3>' +
      esc(cat ? cat.name : '') +
      '</h3><div class="availability-grid">' +
      catItems
        .map(function (item) {
          var sold = item.available === false;
          return (
            '<button type="button" data-sold="' +
            esc(item.id) +
            '" class="availability-item' +
            (sold ? ' is-sold' : '') +
            '" aria-pressed="' +
            String(sold) +
            '"><span><strong>' +
            esc(item.name) +
            '</strong><small>' +
            esc(item.description || '') +
            '</small></span><b>' +
            (sold ? 'Ordering off' : 'Available') +
            '</b></button>'
          );
        })
        .join('') +
      '</div></section>';
  }

  async function loadMenuStock() {
    if (!restaurant) return;
    var results = await Promise.all([
      client()
        .from('menu_categories')
        .select('id, name, sort_order')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order'),
      client()
        .from('menu_items')
        .select('id, category_id, name, description, available, sort_order')
        .eq('restaurant_id', restaurant.id)
        .order('sort_order'),
    ]);
    if (results[0].error) throw results[0].error;
    if (results[1].error) throw results[1].error;
    menuCategories = results[0].data || [];
    menuItems = results[1].data || [];
    renderAvailability();
  }

  async function toggleSoldOut(itemId) {
    var item = menuItems.find(function (i) {
      return i.id === itemId;
    });
    if (!item) return;
    var next = item.available === false;
    var res = await client().rpc('apex_set_menu_item_available', {
      p_item_id: itemId,
      p_available: next,
    });
    if (res.error) throw res.error;
    item.available = next;
    renderAvailability();
    showToast(next ? item.name + ' available again.' : item.name + ' marked sold out.');
  }

  function setStaffView(view) {
    staffView = view === 'menu' ? 'menu' : 'orders';
    var ordersView = $('ordersView');
    var menuView = $('menuView');
    var ordersTab = $('ordersTab');
    var menuTab = $('menuTab');
    if (ordersView) ordersView.hidden = staffView !== 'orders';
    if (menuView) menuView.hidden = staffView !== 'menu';
    if (ordersTab) ordersTab.setAttribute('aria-selected', String(staffView === 'orders'));
    if (menuTab) menuTab.setAttribute('aria-selected', String(staffView === 'menu'));
    if (staffView === 'menu') {
      loadMenuStock().catch(function (e) {
        showToast((e && e.message) || 'Could not load menu stock.');
      });
    }
  }

  function subscribeRealtime() {
    if (channel) client().removeChannel(channel);
    channel = client()
      .channel('staff-orders-' + restaurant.id)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'online_orders',
          filter: 'restaurant_id=eq.' + restaurant.id,
        },
        function () {
          refresh().catch(function () {
            setConn(false, 'Refresh failed');
          });
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
          refresh().catch(function () {});
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'menu_items',
          filter: 'restaurant_id=eq.' + restaurant.id,
        },
        function () {
          loadMenuStock().catch(function () {});
        }
      )
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') setConn(true, 'Live');
      });
  }

  async function enterApp() {
    if (entered) {
      await refresh();
      return;
    }
    showPanel(false);
    setConn(false, 'Loading…');
    await loadRestaurant();
    await refresh();
    loadMenuStock().catch(function () {});
    subscribeRealtime();
    entered = true;
    setInterval(function () {
      refresh().catch(function () {});
    }, 15000);
    setInterval(function () {
      reviewWaitingAlerts(orders);
    }, 5000);
    showToast('Console open. Tap Enable alerts for sound.');
  }

  // —— Events ————————————————————————————————————————————————

  $('staffLoginForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var err = $('staffAuthError');
    var btn = ev.target.querySelector('button[type="submit"]');
    err.hidden = true;
    err.classList.remove('is-visible');
    err.textContent = '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Opening…';
    }
    try {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error('Supabase library failed to load. Refresh and try again.');
      }
      var res = await client().auth.signInWithPassword({
        email: $('staffEmail').value.trim(),
        password: $('staffPassword').value,
      });
      if (res.error) throw res.error;
      await enterApp();
    } catch (e) {
      showPanel(true);
      entered = false;
      err.hidden = false;
      err.classList.add('is-visible');
      err.textContent =
        (e && (e.message || e.error_description)) ||
        'Sign-in failed. Use your Apex email/password.';
      console.error('staff login', e);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Open console';
      }
    }
  });

  $('btnLogout').addEventListener('click', async function () {
    if (channel) client().removeChannel(channel);
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch (_) {}
      wakeLock = null;
    }
    await client().auth.signOut();
    location.reload();
  });

  $('pauseToggle').addEventListener('click', async function () {
    try {
      await patchSettings({ paused: !settings.paused });
      showToast(settings.paused ? 'Ordering paused.' : 'Ordering reopened.');
    } catch (e) {
      showToast('Could not update pause.');
    }
  });

  $('prepDown').addEventListener('click', async function () {
    var next = Math.max(10, (settings.prep_minutes || 30) - 5);
    try {
      await patchSettings({ prep_minutes: next });
    } catch (_) {
      showToast('Could not update prep time.');
    }
  });
  $('prepUp').addEventListener('click', async function () {
    var next = Math.min(90, (settings.prep_minutes || 30) + 5);
    try {
      await patchSettings({ prep_minutes: next });
    } catch (_) {
      showToast('Could not update prep time.');
    }
  });

  $('ordersTab').addEventListener('click', function () {
    setStaffView('orders');
  });
  $('menuTab').addEventListener('click', function () {
    setStaffView('menu');
  });

  $('availabilityTabs').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-availability-category]');
    if (!btn) return;
    activeAvailabilityCategory = btn.getAttribute('data-availability-category');
    renderAvailability();
  });

  $('menuAvailability').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-sold]');
    if (!btn) return;
    toggleSoldOut(btn.getAttribute('data-sold')).catch(function (e) {
      showToast((e && e.message) || 'Could not update stock.');
    });
  });

  document.querySelector('.filters').addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-filter]');
    if (!btn) return;
    filter = btn.getAttribute('data-filter');
    document.querySelectorAll('[data-filter]').forEach(function (b) {
      b.classList.toggle('is-on', b === btn);
    });
    renderOrders();
  });

  $('orderList').addEventListener('click', function (ev) {
    var a = ev.target.closest('[data-accept]');
    var r = ev.target.closest('[data-reject]');
    var p = ev.target.closest('[data-print]');
    if (a) acceptOrder(a.getAttribute('data-accept')).catch(function (e) {
      showToast((e && e.message) || 'Accept failed');
    });
    if (r) rejectOrder(r.getAttribute('data-reject')).catch(function (e) {
      showToast((e && e.message) || 'Reject failed');
    });
    if (p) printOrder(p.getAttribute('data-print'));
  });

  $('btnAlerts').addEventListener('click', async function () {
    var btn = $('btnAlerts');
    await unlockAudio();
    await requestWakeLock();
    alertsEnabled = true;
    var granted = false;
    if (window.Notification) {
      if (Notification.permission === 'granted') granted = true;
      else if (Notification.permission !== 'denied') {
        granted = (await Notification.requestPermission()) === 'granted';
      }
    }
    playBeeps(1);
    // Seed timers so the next waiting order chimes, but don't blast old ones.
    var now = Date.now();
    orders.forEach(function (o) {
      if (o.status === 'waiting') {
        waitingSince.set(o.id, now);
        alertedAt.set(o.id, now);
      }
    });
    btn.textContent = granted ? 'Alerts on' : 'Sound on';
    showToast(
      granted
        ? 'Alerts on — screen will stay awake while this tab is open.'
        : 'Sound unlocked. Allow notifications for banners.'
    );
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') requestWakeLock();
  });

  client()
    .auth.getSession()
    .then(function (res) {
      if (res.data && res.data.session) {
        enterApp().catch(function (e) {
          showPanel(true);
          entered = false;
          var err = $('staffAuthError');
          err.hidden = false;
          err.classList.add('is-visible');
          err.textContent = (e && e.message) || 'Could not load console.';
          console.error('staff boot', e);
        });
      }
    })
    .catch(function (e) {
      console.error('staff session', e);
    });
})();
