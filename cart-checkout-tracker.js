/**
 * Confianca (confianca.com.br) — Cart & Checkout Tracker
 * Plataforma: Oracle Commerce Cloud (OCC) - React + Chakra UI
 * GTM: GTM-PJM4SC
 *
 * Captura dados de carrinho/checkout e envia para events.mymetric.app/posts
 * O site NAO dispara eventos GA4 de ecommerce no carrinho/checkout,
 * entao este script faz scrape do DOM para extrair os dados.
 *
 * Deploy via GTM Custom HTML:
 *   <script src="https://cdn.jsdelivr.net/gh/{user}/{repo}/clientes/confianca/cart-checkout-tracker.js"></script>
 *
 * Eventos: view_cart, begin_checkout, add_shipping_info, add_payment_info, purchase
 */
(function() {
  'use strict';

  var ENDPOINT = 'https://events.mymetric.app/posts';
  var SOURCE = 'confianca.com.br';
  var STORAGE_KEY = '__confianca_cart_tracker';
  var DEBUG = false;

  function log() {
    if (DEBUG) console.log.apply(console, ['[CartTracker]'].concat(Array.prototype.slice.call(arguments)));
  }

  // ---- Deteccao de etapa do funil ----
  // OCC Confianca: checkout acontece dentro de /carrinho e /checkout
  // Sem login, /checkout redireciona para /{cidade}/carrinho
  // Com login, as etapas aparecem via step indicators no DOM
  function detectStage() {
    var path = location.pathname.toLowerCase();
    var title = (document.title || '').toLowerCase();

    // Confirmacao de pedido
    if (path.indexOf('/confirmacao') !== -1 || path.indexOf('/order-confirmation') !== -1) {
      return 'purchase';
    }

    // Detectar etapa ativa via step indicators no DOM (checkout com login)
    var activeStep = detectActiveStep();
    if (activeStep) return activeStep;

    // Checkout URL explicita
    if (path.indexOf('/checkout') !== -1) {
      return 'begin_checkout';
    }

    // Carrinho (URL /carrinho ou /{cidade}/carrinho)
    if (path.indexOf('/carrinho') !== -1 || path.indexOf('/cart') !== -1) {
      // Se o title indica checkout, considerar begin_checkout
      if (title.indexOf('checkout') !== -1 || title.indexOf('finalizar') !== -1) {
        return 'begin_checkout';
      }
      return 'view_cart';
    }

    return null;
  }

  // Detectar etapa ativa via elementos do DOM (step bar, tabs, headings de etapa)
  function detectActiveStep() {
    // Buscar headings ou elementos ativos que indiquem a etapa
    var indicators = [
      { sel: '[class*="step"][class*="active"], [class*="Step"][class*="Active"], [aria-selected="true"], [aria-current="step"]', key: 'text' },
      { sel: 'h1, h2, h3', key: 'text' }
    ];

    for (var i = 0; i < indicators.length; i++) {
      try {
        var els = document.querySelectorAll(indicators[i].sel);
        for (var j = 0; j < els.length; j++) {
          var text = (els[j].innerText || '').toLowerCase().trim();
          if (!text || text.length > 100) continue;
          var rect = els[j].getBoundingClientRect();
          if (rect.width < 10) continue;

          // Pagamento
          if (text.indexOf('pagamento') !== -1 || text.indexOf('forma de pagamento') !== -1 ||
              text === 'payment') return 'add_payment_info';
          // Entrega
          if (text === 'entrega' || text.indexOf('tipo de entrega') !== -1 ||
              text.indexOf('endereco de entrega') !== -1 || text.indexOf('endereço de entrega') !== -1 ||
              text === 'shipping') return 'add_shipping_info';
          // Confirmacao
          if (text.indexOf('confirmar pedido') !== -1 || text.indexOf('resumo do pedido') !== -1 ||
              text.indexOf('pedido realizado') !== -1 || text.indexOf('obrigado') !== -1) return 'purchase';
        }
      } catch(e) {}
    }

    return null;
  }

  // ---- Extrair cidade da URL ----
  function getCity() {
    var parts = location.pathname.split('/').filter(Boolean);
    var cities = ['bauru', 'botucatu', 'jau', 'marilia', 'sorocaba'];
    for (var i = 0; i < parts.length; i++) {
      if (cities.indexOf(parts[i].toLowerCase()) !== -1) return parts[i].toLowerCase();
    }
    return '';
  }

  // ---- Extrair itens do carrinho do DOM ----
  function scrapeCartItems() {
    var items = [];

    // Estrategia 1: buscar no dataLayer
    var dl = window.dataLayer || [];
    for (var i = dl.length - 1; i >= 0; i--) {
      var ecom = dl[i] && dl[i].ecommerce;
      if (ecom && ecom.items && ecom.items.length > 0) {
        items = ecom.items.map(function(it) {
          return {
            item_id: String(it.item_id || it.id || ''),
            item_name: it.item_name || it.name || '',
            item_brand: it.item_brand || it.brand || '',
            item_category: it.item_category || it.category || '',
            price: parseFloat(it.price) || 0,
            quantity: parseInt(it.quantity) || 1
          };
        });
        log('Items do dataLayer:', items.length);
        return items;
      }
    }

    // Estrategia 2: scrape do DOM (OCC/React/Chakra UI)
    var selectors = [
      '[class*="cart-item"], [class*="CartItem"], [class*="cartItem"]',
      '[class*="product-line"], [class*="ProductLine"]',
      '[class*="item-container"], [class*="itemContainer"]',
      'table tbody tr',
      '[data-testid*="cart-item"], [data-testid*="product"]'
    ];

    var itemEls = [];
    for (var s = 0; s < selectors.length; s++) {
      try {
        var els = document.querySelectorAll(selectors[s]);
        if (els.length > 0) {
          itemEls = els;
          log('Items encontrados via selector:', selectors[s], els.length);
          break;
        }
      } catch(e) {}
    }

    // Heuristica: divs com preco + imagem
    if (itemEls.length === 0) {
      var allDivs = document.querySelectorAll('div, li, article');
      var candidates = [];
      for (var d = 0; d < allDivs.length; d++) {
        var el = allDivs[d];
        var text = el.innerText || '';
        var hasPrice = /R\$\s*[\d.,]+/.test(text);
        var hasImg = el.querySelector('img') !== null;
        var rect = el.getBoundingClientRect();
        if (hasPrice && hasImg && rect.height > 60 && rect.height < 400 && rect.width > 200) {
          var childWithPrice = el.querySelector('[class*="price"], [class*="Price"]');
          if (childWithPrice || text.split('R$').length <= 3) {
            candidates.push(el);
          }
        }
      }
      candidates.sort(function(a, b) {
        return (a.getBoundingClientRect().height * a.getBoundingClientRect().width) -
               (b.getBoundingClientRect().height * b.getBoundingClientRect().width);
      });
      var filtered = [];
      for (var c = 0; c < candidates.length; c++) {
        var isChild = false;
        for (var f = 0; f < filtered.length; f++) {
          if (candidates[c].contains(filtered[f]) || filtered[f].contains(candidates[c])) {
            isChild = true;
            break;
          }
        }
        if (!isChild) filtered.push(candidates[c]);
      }
      itemEls = filtered;
      log('Items por heuristica:', itemEls.length);
    }

    // Extrair dados de cada item
    for (var idx = 0; idx < itemEls.length; idx++) {
      var itemEl = itemEls[idx];
      var itemText = itemEl.innerText || '';

      // Nome
      var nameEl = itemEl.querySelector('a[href*="/p/"], [class*="name"], [class*="Name"], [class*="title"], [class*="Title"], h3, h4, h5');
      var name = nameEl ? (nameEl.innerText || nameEl.textContent || '').trim() : '';
      if (!name) {
        var lines = itemText.split('\n').filter(function(l) {
          return l.trim().length > 3 && !/^R\$/.test(l.trim()) && !/^\d+$/.test(l.trim());
        });
        name = lines[0] ? lines[0].trim().substring(0, 100) : '';
      }

      // ID da URL ou data attribute
      var itemId = '';
      var linkEl = itemEl.querySelector('a[href*="/p/"]');
      if (linkEl) {
        var href = linkEl.getAttribute('href') || '';
        var idMatch = href.match(/\/p\/[^/]+\/([\d]+)/);
        if (idMatch) itemId = idMatch[1];
      }
      if (!itemId) {
        itemId = itemEl.getAttribute('data-product-id') ||
                 itemEl.getAttribute('data-item-id') ||
                 itemEl.getAttribute('data-sku') || '';
      }

      // Preco
      var priceMatch = itemText.match(/R\$\s*([\d]+[.,][\d]{2})/);
      var price = 0;
      if (priceMatch) {
        price = parseFloat(priceMatch[1].replace('.', '').replace(',', '.'));
      }

      // Quantidade
      var qtyInput = itemEl.querySelector('input[type="number"], input[name*="qt"], input[name*="quantity"], input[aria-label*="quantidade"]');
      var qty = 1;
      if (qtyInput) {
        qty = parseInt(qtyInput.value) || 1;
      } else {
        var qtyMatch = itemText.match(/(?:qtd|quantidade|qty)[:\s]*(\d+)/i);
        if (qtyMatch) qty = parseInt(qtyMatch[1]) || 1;
      }

      if (name || itemId) {
        items.push({
          item_id: itemId,
          item_name: name.substring(0, 150),
          item_brand: '',
          item_category: '',
          price: price,
          quantity: qty
        });
      }
    }

    log('Total items scraped:', items.length);
    return items;
  }

  // ---- Extrair valor total ----
  function scrapeTotal() {
    var totalSelectors = [
      '[class*="total"] [class*="price"]',
      '[class*="Total"] [class*="Price"]',
      '[class*="order-total"]',
      '[class*="cart-total"]',
      '[class*="subtotal"]'
    ];

    for (var s = 0; s < totalSelectors.length; s++) {
      try {
        var els = document.querySelectorAll(totalSelectors[s]);
        for (var e = 0; e < els.length; e++) {
          var text = els[e].innerText || '';
          var match = text.match(/R\$\s*([\d.,]+)/);
          if (match) {
            var val = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
            if (val > 0) {
              log('Total encontrado:', val);
              return val;
            }
          }
        }
      } catch(e) {}
    }

    // Fallback
    var allEls = document.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      var t = (el.innerText || '').toLowerCase();
      if (t.indexOf('total') !== -1 && el.children.length < 5) {
        var m = t.match(/total[^R]*R\$\s*([\d.,]+)/i);
        if (m) {
          var v = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
          if (v > 0) return v;
        }
      }
    }

    return 0;
  }

  // ---- Extrair cupom ----
  function scrapeCoupon() {
    var couponInput = document.querySelector('input[name*="coupon"], input[name*="cupom"], input[placeholder*="cupom"], input[placeholder*="coupon"]');
    if (couponInput && couponInput.value) return couponInput.value;

    var els = document.querySelectorAll('[class*="coupon"], [class*="cupom"], [class*="Coupon"], [class*="Cupom"]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || '').trim();
      if (t.length > 0 && t.length < 50) return t;
    }
    return '';
  }

  // ---- Montar payload ----
  function buildPayload(eventName, items, total) {
    return {
      event: eventName,
      timestamp: new Date().toISOString(),
      source: SOURCE,
      page_url: location.href,
      page_title: document.title,
      city: getCity(),
      ecommerce: {
        currency: 'BRL',
        value: total || items.reduce(function(sum, it) {
          return sum + (it.price || 0) * (it.quantity || 1);
        }, 0),
        coupon: scrapeCoupon(),
        items: items
      },
      user_agent: navigator.userAgent,
      referrer: document.referrer,
      screen: window.innerWidth + 'x' + window.innerHeight
    };
  }

  // ---- Enviar evento ----
  function sendEvent(payload) {
    log('Enviando evento:', payload.event, payload);
    var json = JSON.stringify(payload);

    // Preferir fetch (suporta Content-Type: application/json)
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true
      }).then(function(r) { log('fetch status:', r.status); })
        .catch(function() { log('fetch falhou'); });
      return;
    } catch(e) {}

    // Fallback: sendBeacon com Blob (para garantir content-type correto)
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([json], { type: 'application/json' });
        var sent = navigator.sendBeacon(ENDPOINT, blob);
        log('sendBeacon:', sent ? 'OK' : 'falhou');
        if (sent) return;
      }
    } catch(e) {}

    // Ultimo fallback: XHR
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(json);
    } catch(e2) {}
  }

  // ---- Dedup via sessionStorage ----
  function getSessionData() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    } catch(e) { return {}; }
  }

  function setSessionData(data) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch(e) {}
  }

  function alreadySent(eventName) {
    var data = getSessionData();
    return data[eventName] === true;
  }

  function markSent(eventName) {
    var data = getSessionData();
    data[eventName] = true;
    setSessionData(data);
  }

  // ---- Principal ----
  function track() {
    var stage = detectStage();
    if (!stage) {
      log('Fora do funil, ignorando');
      return;
    }

    if (alreadySent(stage)) {
      log('Evento ja enviado nesta sessao:', stage);
      return;
    }

    log('Stage detectado:', stage);

    var items = scrapeCartItems();
    var total = scrapeTotal();
    var payload = buildPayload(stage, items, total);

    if (stage === 'purchase') {
      var bodyText = document.body.innerText || '';
      var orderMatch = bodyText.match(/(?:pedido|order|numero)[^\d]*(\d{4,})/i);
      if (orderMatch) {
        payload.ecommerce.transaction_id = orderMatch[1];
      }
    }

    sendEvent(payload);
    markSent(stage);
    log('Evento enviado e marcado:', stage);
  }

  // ---- Init com delay para React renderizar ----
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() {
        setTimeout(track, 2000);
      });
    } else {
      setTimeout(track, 2000);
    }

    // Detectar navegacao SPA (React Router)
    var lastUrl = location.href;
    var observer = new MutationObserver(function() {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('URL mudou:', lastUrl);
        setTimeout(track, 2000);
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('popstate', function() {
      setTimeout(track, 2000);
    });
  }

  init();

})();
