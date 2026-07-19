// ==UserScript==
// @name         Japan Mapcode on Google Maps
// @name:zh-TW   Google 地圖顯示日本 Mapcode
// @namespace    https://japanmapcode.com/
// @version      1.1.0
// @description  在 Google 地圖上自動顯示目前地點的日本 Mapcode（Denso），點一下即可複製。
// @author       -
// @match        https://www.google.com/maps*
// @match        https://www.google.com.tw/maps*
// @match        https://www.google.co.jp/maps*
// @match        https://maps.google.com/*
// @match        https://maps.google.com.tw/*
// @match        https://maps.google.co.jp/*
// @connect      api.japanmapcode.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 設定
   * ------------------------------------------------------------------ */
  const ENDPOINT      = 'https://api.japanmapcode.com/mapcode';
  const POLL_MS       = 600;    // 偵測網址變化的間隔
  const DEBOUNCE_MS   = 700;    // 座標穩定多久後才送出查詢
  const CACHE_KEY     = 'jmc_cache_v1';
  const POS_KEY       = 'jmc_panel_pos_v1';
  const CACHE_MAX     = 300;
  const COORD_DP      = 5;      // 快取用的座標精度（約 1 公尺）

  // 日本大致範圍（含沖繩、北海道、小笠原）
  const JP_BOUNDS = { latMin: 20.0, latMax: 46.5, lngMin: 122.0, lngMax: 154.5 };

  /* ------------------------------------------------------------------ *
   * 快取（localStorage，失敗時自動退回純記憶體）
   * ------------------------------------------------------------------ */
  const memCache = new Map();

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return;
      for (const [k, v] of Object.entries(JSON.parse(raw))) memCache.set(k, v);
    } catch (_) { /* 忽略毀損的快取 */ }
  }

  function saveCache() {
    try {
      // 只保留最近的 CACHE_MAX 筆
      const entries = [...memCache.entries()].slice(-CACHE_MAX);
      memCache.clear();
      for (const [k, v] of entries) memCache.set(k, v);
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch (_) { /* 配額滿了就算了 */ }
  }

  const cacheKey = (lat, lng) => `${lat.toFixed(COORD_DP)},${lng.toFixed(COORD_DP)}`;

  /* ------------------------------------------------------------------ *
   * 從網址取出座標
   *   優先序：!3d/!4d（實際被選取的圖釘） > @lat,lng（畫面中心） > q=lat,lng
   * ------------------------------------------------------------------ */
  function extractCoords(href) {
    let m = href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (m) return { lat: +m[1], lng: +m[2], src: 'pin' };

    m = href.match(/[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) return { lat: +m[1], lng: +m[2], src: 'query' };

    m = href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (m) return { lat: +m[1], lng: +m[2], src: 'center' };

    return null;
  }

  const inJapan = (lat, lng) =>
    lat >= JP_BOUNDS.latMin && lat <= JP_BOUNDS.latMax &&
    lng >= JP_BOUNDS.lngMin && lng <= JP_BOUNDS.lngMax;

  /* ------------------------------------------------------------------ *
   * 解析 api.japanmapcode.com 的回應
   * 已知格式：{"success":true,"data":{"mapcode":"721 272 810*43"}}
   * 仍保留寬鬆的備援解析，之後 API 改版比較不會整個壞掉。
   * ------------------------------------------------------------------ */
  const MAPCODE_RE = /\b(\d{1,4}(?:\s+\d{2,3}){1,3}(?:\s*\*\s*\d{1,2})?)/;

  const tidy = (s) => s.replace(/\s*\*\s*/, '*').trim();

  function parseMapcode(text) {
    if (!text) return null;

    try {
      const json = JSON.parse(text);

      // 1) 已知格式
      if (typeof json?.data?.mapcode === 'string' && json.data.mapcode.trim()) {
        return tidy(json.data.mapcode);
      }

      // 2) API 明確回報失敗
      if (json?.success === false) {
        throw new Error(json.message || json.error || 'API 回報查詢失敗');
      }

      // 3) 備援：常見鍵名
      for (const k of ['mapcode', 'mapCode', 'code', 'result', 'value']) {
        if (typeof json?.[k] === 'string' && json[k].trim()) return tidy(json[k]);
      }

      // 4) 備援：整包序列化後用正規表示式撈
      const hit = JSON.stringify(json).match(MAPCODE_RE);
      if (hit) return tidy(hit[1]);
    } catch (err) {
      if (err instanceof SyntaxError) {
        // 不是 JSON，退回純文字比對
        const hit = text.match(MAPCODE_RE);
        return hit ? tidy(hit[1]) : null;
      }
      throw err;
    }

    return null;
  }

  function fetchMapcode(lat, lng) {
    const url = `${ENDPOINT}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Accept': 'application/json, text/plain, */*' },
        timeout: 12000,
        onload: (res) => {
          if (res.status < 200 || res.status >= 300) {
            return reject(new Error(`HTTP ${res.status}`));
          }
          try {
            const code = parseMapcode(res.responseText);
            code ? resolve(code) : reject(new Error('無法解析回應'));
          } catch (err) {
            reject(err);
          }
        },
        onerror:   () => reject(new Error('連線失敗')),
        ontimeout: () => reject(new Error('連線逾時')),
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 浮層 UI
   * ------------------------------------------------------------------ */
  const panel = document.createElement('div');
  panel.id = 'jmc-panel';
  panel.innerHTML = `
    <div class="jmc-label">MAPCODE</div>
    <div class="jmc-code">—</div>
    <div class="jmc-sub"></div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #jmc-panel {
      position: fixed;
      z-index: 2147483000;
      bottom: 30px;
      left: 50%;
      min-width: 168px;
      padding: 9px 14px 10px;
      background: rgba(32, 33, 36, 0.94);
      color: #fff;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,.35);
      font-family: Roboto, "Noto Sans TC", Arial, sans-serif;
      cursor: grab;
      user-select: none;
      transition: opacity .15s ease;
    }
    #jmc-panel.jmc-dragging { cursor: grabbing; }
    #jmc-panel .jmc-label {
      font-size: 10px;
      letter-spacing: 1.2px;
      opacity: .55;
      margin-bottom: 2px;
    }
    #jmc-panel .jmc-code {
      font-size: 20px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: .5px;
      line-height: 1.25;
    }
    #jmc-panel .jmc-code.jmc-muted { font-size: 13px; font-weight: 400; opacity: .7; }
    #jmc-panel .jmc-sub {
      font-size: 11px;
      opacity: .55;
      margin-top: 3px;
      min-height: 14px;
    }
    #jmc-panel.jmc-copied { background: rgba(24, 128, 56, 0.95); }
  `;

  document.head.appendChild(style);
  document.body.appendChild(panel);

  const $code = panel.querySelector('.jmc-code');
  const $sub  = panel.querySelector('.jmc-sub');

  function render(code, sub, muted) {
    $code.textContent = code;
    $code.classList.toggle('jmc-muted', !!muted);
    $sub.textContent = sub || '';
  }

  /* --- 拖曳（位置記在 localStorage） --- */
  (function makeDraggable() {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        Object.assign(panel.style, {
          left: saved.left + 'px', top: saved.top + 'px',
          bottom: 'auto', transform: 'none',
        });
      } else {
        panel.style.transform = 'translateX(-50%)';
      }
    } catch (_) { panel.style.transform = 'translateX(-50%)'; }

    let dragging = false, moved = false, offX = 0, offY = 0;

    panel.addEventListener('mousedown', (e) => {
      const r = panel.getBoundingClientRect();
      dragging = true; moved = false;
      offX = e.clientX - r.left;
      offY = e.clientY - r.top;
      Object.assign(panel.style, {
        left: r.left + 'px', top: r.top + 'px',
        bottom: 'auto', transform: 'none',
      });
      panel.classList.add('jmc-dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      moved = true;
      const left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - offX));
      const top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - offY));
      panel.style.left = left + 'px';
      panel.style.top  = top  + 'px';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('jmc-dragging');
      if (moved) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({
            left: parseFloat(panel.style.left),
            top:  parseFloat(panel.style.top),
          }));
        } catch (_) {}
      }
      // 拖曳後短暫抑制 click，避免誤觸複製
      panel.dataset.suppressClick = moved ? '1' : '';
      setTimeout(() => { panel.dataset.suppressClick = ''; }, 0);
    });
  })();

  /* --- 點一下複製 --- */
  let currentCode = null;
  panel.addEventListener('click', async () => {
    if (panel.dataset.suppressClick || !currentCode) return;
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(currentCode, 'text');
      else await navigator.clipboard.writeText(currentCode);
      panel.classList.add('jmc-copied');
      const prev = $sub.textContent;
      $sub.textContent = '已複製 ✓';
      setTimeout(() => {
        panel.classList.remove('jmc-copied');
        $sub.textContent = prev;
      }, 1100);
    } catch (_) {
      $sub.textContent = '複製失敗';
    }
  });

  /* ------------------------------------------------------------------ *
   * 主迴圈：偵測網址變化 → 去抖動 → 查詢 → 顯示
   * ------------------------------------------------------------------ */
  loadCache();

  let lastKey = null;
  let debounceTimer = null;
  let reqSeq = 0;

  async function update(lat, lng, src) {
    const key = cacheKey(lat, lng);
    const seq = ++reqSeq;
    const srcLabel = src === 'pin' ? '選取地點' : src === 'query' ? '座標查詢' : '畫面中心';

    if (memCache.has(key)) {
      currentCode = memCache.get(key);
      render(currentCode, `${srcLabel}・點一下複製`);
      return;
    }

    currentCode = null;
    render('查詢中…', srcLabel, true);

    try {
      const code = await fetchMapcode(lat, lng);
      if (seq !== reqSeq) return;           // 已有更新的請求，丟棄這次結果
      memCache.set(key, code);
      saveCache();
      currentCode = code;
      render(code, `${srcLabel}・點一下複製`);
    } catch (err) {
      if (seq !== reqSeq) return;
      currentCode = null;
      render('查詢失敗', err.message, true);
    }
  }

  function tick() {
    const c = extractCoords(location.href);

    if (!c) {
      lastKey = null;
      currentCode = null;
      render('尚未選取地點', '在地圖上點一個位置', true);
      return;
    }

    if (!inJapan(c.lat, c.lng)) {
      lastKey = null;
      currentCode = null;
      render('不在日本範圍', `${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}`, true);
      return;
    }

    const key = `${c.src}:${cacheKey(c.lat, c.lng)}`;
    if (key === lastKey) return;
    lastKey = key;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => update(c.lat, c.lng, c.src), DEBOUNCE_MS);
  }

  tick();
  setInterval(tick, POLL_MS);
})();
