/* すきおし ブラウザ側の処理 */
(() => {
  'use strict';

  // ---------- 小さな道具 ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');

  // 日本時間の今日（YYYY-MM-DD）
  const jstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const phase = (start, end, day = jstDay()) => (day < start ? 'before' : day > end ? 'closed' : 'open');

  // ブラウザの保存領域（使えない環境でも壊れないように）
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動作は続ける */ }
    },
  };

  // 今日投票した作品（表示用。正式な重複チェックはサーバーで行う）
  const VOTED_KEY = 'sukioshi:voted';
  const votedToday = () => {
    const v = store.get(VOTED_KEY, {});
    return v.day === jstDay() ? v : { day: jstDay(), works: {} };
  };
  const markVoted = (season, work) => {
    const v = votedToday();
    v.works[`${season}:${work}`] = 1;
    store.set(VOTED_KEY, v);
  };
  const isVoted = (season, work) => Boolean(votedToday().works[`${season}:${work}`]);

  // ---------- コレクション（「すき」を押した作品をこの端末にためる） ----------
  const COLLECTION_KEY = 'sukioshi:collection';
  const BADGES = [
    [1, 'はじめてのすき'], [5, 'すき見習い'], [10, 'すきコレクター'],
    [30, 'すきマスター'], [60, 'すき博士'], [100, 'すき伝説'],
  ];
  const badgeAt = (n) => BADGES.filter(([min]) => n >= min).pop() || null;
  const getCollection = () => {
    const c = store.get(COLLECTION_KEY, null);
    return c && c.items ? c : { v: 1, items: {} };
  };
  // 作品をコレクションに入れる。すでにあれば何もしない
  function collect(season, work) {
    const c = getCollection();
    const before = Object.keys(c.items).length;
    if (!c.items[work]) {
      c.items[work] = { s: season, t: Date.now() };
      store.set(COLLECTION_KEY, c);
    }
    const count = Object.keys(c.items).length;
    const unlocked = count > before ? BADGES.find(([min]) => min === count) || null : null;
    return { added: count > before, count, unlocked };
  }
  // 今日すでに押した分もコレクションに入れておく（この機能の前に押した票の取りこぼしを防ぐ）
  Object.keys(votedToday().works).forEach((k) => { const [season, work] = k.split(':'); if (season && work) collect(season, work); });

  // 検索用：全角半角・カタカナ/ひらがな・記号や空白の違いを吸収する
  const normKey = (t) => String(t || '')
    .normalize('NFKC').toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・\-ー～〜!！?？、。,.:：;；'"“”‘’「」『』【】（）()\[\]#＃☆★♪]/g, '');

  let toastTimer;
  function toast(msg) {
    const el = $('.toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  async function getJson(url, opts) {
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* JSONでない応答 */ }
    if (!res.ok && !data) throw new Error(`HTTP ${res.status}`);
    return data || {};
  }

  let config = { adsenseClient: '', adSlots: {}, siteUrl: location.origin };
  const configReady = getJson('/assets/config.json', { cache: 'no-cache' }).then((c) => { config = { ...config, ...c }; }).catch(() => {});

  // ---------- 表紙画像（楽天ブックス） ----------
  const bookCache = new Map();
  const queue = [];
  let running = 0;
  const MAX_PARALLEL = 2;

  function loadBook(id) {
    if (bookCache.has(id)) return bookCache.get(id);
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('sukioshi:book5:' + id) || 'null'); } catch { /* 無視 */ }
    const p = saved ? Promise.resolve(saved) : new Promise((resolve) => { queue.push({ id, resolve, tries: 0 }); pump(); });
    bookCache.set(id, p);
    return p;
  }
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      running++;
      getJson('/api/book?id=' + encodeURIComponent(job.id) + '&v=5')
        .catch(() => ({ ok: false, code: 'network' }))
        .then((data) => {
          if (!data.ok && (data.code === 'busy' || data.code === 'network') && job.tries < 3) {
            job.tries++;
            setTimeout(() => { queue.push(job); pump(); }, 1500 * job.tries);
            return;
          }
          if (data.ok) { try { sessionStorage.setItem('sukioshi:book5:' + job.id, JSON.stringify(data)); } catch { /* 無視 */ } }
          job.resolve(data);
        })
        .finally(() => { running--; setTimeout(pump, 350); });
    }
  }

  function applyBook(img, data) {
    if (!data || !data.ok || !data.imageUrl) { img.closest('.cover, .work-cover')?.classList.add('no-image'); return; }
    img.src = data.imageUrl;
    // 楽天のデータを表示している場所のリンクは、楽天の商品ページへ向ける（楽天の規約）
    const coverLink = img.closest('[data-cover-link]');
    if (coverLink && data.url) {
      coverLink.href = data.url;
      coverLink.target = '_blank';
      coverLink.rel = 'sponsored noopener';
    }
  }

  const coverObserver = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          coverObserver.unobserve(e.target);
          loadBook(e.target.dataset.cover).then((d) => applyBook(e.target, d));
        }
      }, { rootMargin: '200px' })
    : null;
  function observeCovers(root = document) {
    $$('img[data-cover]', root).forEach((img) => {
      if (coverObserver) coverObserver.observe(img);
      else loadBook(img.dataset.cover).then((d) => applyBook(img, d));
    });
  }
  observeCovers();

  // ---------- 広告 ----------
  function fillAd(slotEl) {
    if (!config.adsenseClient || slotEl.dataset.filled) return;
    const name = slotEl.dataset.adSlot;
    const unit = (config.adSlots || {})[name] || (config.adSlots || {})['ranking-inline'];
    if (!unit) return; // 手動の広告ユニットIDがなければ枠は出さない（自動広告に任せる）
    slotEl.hidden = false;
    slotEl.dataset.filled = '1';
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.dataset.adClient = config.adsenseClient;
    ins.dataset.adSlot = unit;
    ins.dataset.adFormat = 'auto';
    ins.dataset.fullWidthResponsive = 'true';
    slotEl.appendChild(ins);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* 広告の失敗でページは止めない */ }
  }
  configReady.then(() => $$('.ad-slot[data-ad-slot]').forEach(fillAd));

  // ---------- ランキング ----------
  function setupRanking(section) {
    const season = section.dataset.season;
    const state = { period: 'season', type: 'all', tag: '', expanded: false, phase: phase(section.dataset.voteStart, section.dataset.voteEnd) };
    const list = $('[data-rank-list]', section);
    const status = $('[data-rank-status]', section);
    const items = new Map($$('.rank-item', list).map((li) => [li.dataset.work, li]));

    if (state.phase === 'closed') {
      $$('[data-period-tabs] [data-period="today"], [data-period-tabs] [data-period="week"]', section).forEach((b) => b.remove());
      const t = $('[data-period="season"]', section);
      if (t) t.textContent = '最終結果';
      const note = $('[data-period-note]', section);
      if (note) note.textContent += '（投票は終了しました）';
    } else if (state.phase === 'before') {
      const note = $('[data-period-note]', section);
      if (note) note.textContent += '（まだ始まっていません）';
    }
    $$('[data-vote]', section).forEach((b) => { if (state.phase !== 'open') b.classList.add('is-closed'); });

    $$('[data-period]', section).forEach((btn) =>
      btn.addEventListener('click', () => {
        state.period = btn.dataset.period;
        $$('[data-period]', section).forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
        load();
      })
    );
    $$('[data-type-filter]', section).forEach((btn) =>
      btn.addEventListener('click', () => {
        state.type = btn.dataset.typeFilter;
        $$('[data-type-filter]', section).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        load();
      })
    );
    $$('[data-tag-filter]', section).forEach((btn) =>
      btn.addEventListener('click', () => {
        state.tag = btn.dataset.tagFilter;
        $$('[data-tag-filter]', section).forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        section.classList.toggle('is-tag-mode', Boolean(state.tag));
        load();
      })
    );

    let reqNo = 0;
    async function load() {
      const my = ++reqNo;
      status.textContent = 'ランキングを読み込んでいます…';
      try {
        const data = await getJson(`/api/ranking?season=${encodeURIComponent(season)}&period=${state.period}&type=${state.type}${state.tag ? '&tag=' + state.tag : ''}`);
        if (my !== reqNo) return; // 古い応答は捨てる
        if (!data.ok) throw new Error(data.code || 'error');
        render(data.rows);
      } catch {
        if (my !== reqNo) return;
        status.textContent = 'ランキングを読み込めませんでした。時間をおいてページを開き直してください。';
        filterOnly();
      }
    }

    // 種類・ランキングで外れた行は data-off="1"。検索はその上で作品名でしぼりこむ
    function filterOnly() {
      for (const li of items.values()) li.dataset.off = state.type !== 'all' && li.dataset.type !== state.type ? '1' : '';
      applySearch();
    }

    const searchBox = $('[data-rank-search]', section);
    const searchEmpty = $('[data-rank-search-empty]', section);
    for (const li of items.values()) li.dataset.key = normKey(li.dataset.searchKeys || $('.rank-title', li)?.textContent);
    const TOP = 10;
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'btn rank-more';
  moreBtn.addEventListener('click', () => { state.expanded = !state.expanded; applySearch(); });
  list.after(moreBtn);
  function applySearch() {
    const q = normKey(searchBox?.value);
    let total = 0;
    for (const li of $$('.rank-item', list)) {
      const match = li.dataset.off !== '1' && (!q || li.dataset.key.includes(q));
      if (match) total++;
      li.hidden = !match || (!q && !state.expanded && total > TOP);
    }
    $$('.ad-slot', list).forEach((a) => { a.style.display = q || !state.expanded ? 'none' : ''; });
    if (searchEmpty) searchEmpty.hidden = !q || total > 0;
    moreBtn.hidden = Boolean(q) || total <= TOP;
    moreBtn.textContent = state.expanded ? '上位10作品だけにする' : `11位以降もひらく（あと${total - TOP}作品）`;
  }
    searchBox?.addEventListener('input', applySearch);

    function render(rows) {
      $$('.ad-slot', list).forEach((a) => a.remove());
      const shown = new Set(rows.map((r) => r.workId));
      for (const [id, li] of items) li.dataset.off = shown.has(id) ? '' : '1';
      let n = 0;
      for (const r of rows) {
        const li = items.get(r.workId);
        if (!li) continue;
        li.dataset.rank = r.rank ?? '';
        $('.rank-no', li).textContent = r.rank ?? '–';
        $('[data-count]', li).textContent = fmt(r.count);
        $('.rank-count', li).lastChild.textContent = state.tag ? ' 人がおすすめ' : ' すき';
        list.appendChild(li);
        n++;
        // 10作品ごとに広告枠（審査に通るまでは何も出ない）
        if (config.adsenseClient && n % 10 === 0 && n < rows.length) {
          const ad = document.createElement('li');
          ad.className = 'ad-slot';
          ad.dataset.adSlot = 'ranking-inline';
          ad.innerHTML = '<span class="ad-label">広告</span>';
          ad.hidden = true;
          list.appendChild(ad);
          fillAd(ad);
        }
      }
      applySearch();
      const total = rows.reduce((s, r) => s + r.count, 0);
      const label = { today: '今日', week: '直近7日間', season: state.phase === 'closed' ? '最終結果' : 'シーズン全体' }[state.period];
      if (state.tag) {
        const tagLabel = (config.tags || []).find((t) => t.id === state.tag)?.label || '';
        status.textContent = total === 0
          ? `「${tagLabel}」を選んだ人はまだいません。「すき」を送ったあとに選べます。`
          : `「${tagLabel}」を選んだ人が多い順（${label}）`;
        return;
      }
      if (total === 0) {
        status.textContent = state.phase === 'open'
          ? `${label}の投票はまだありません。最初の1票をどうぞ。`
          : state.phase === 'before' ? '投票が始まるまでお待ちください。' : '投票はありませんでした。';
      } else {
        status.textContent = `${label}の合計 ${fmt(total)} すき`;
      }
    }

    section.addEventListener('sukioshi:voted', () => load());
    load();
  }
  configReady.then(() => $$('[data-ranking]').forEach(setupRanking));

  // ---------- 投票 ----------
  function flyHeart(btn) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const r = btn.getBoundingClientRect();
    for (let i = 0; i < 3; i++) {
      const h = document.createElement('span');
      h.className = 'fly-heart';
      h.textContent = '♥';
      h.style.left = `${r.left + r.width / 2}px`;
      h.style.top = `${r.top + r.height / 2}px`;
      h.style.setProperty('--dx', `${(i - 1) * 22}px`);
      h.style.animationDelay = `${i * 0.08}s`;
      document.body.appendChild(h);
      setTimeout(() => h.remove(), 1200);
    }
  }

  function setVoted(btn) {
    btn.classList.add('is-voted');
    btn.setAttribute('aria-pressed', 'true');
    $('.vote-text', btn).textContent = '済み';
  }

  // すでに投票した作品のボタンを「済み」にする
  $$('[data-vote]').forEach((btn) => { if (isVoted(btn.dataset.season, btn.dataset.work)) setVoted(btn); });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-vote]');
    if (!btn || btn.classList.contains('is-busy') || btn.classList.contains('is-closed')) return;
    const { season, work } = btn.dataset;
    const title = btn.parentElement.closest('[data-work], [data-work-page]')?.querySelector('.rank-title, h1')?.textContent?.trim() || 'この作品';
    if (btn.classList.contains('is-voted')) {
      if (!isTagged(season, work)) openTagSheet(season, work, title);
      else toast('今日はもう「すき」を送りました。明日また送れます。');
      return;
    }
    btn.classList.add('is-busy');
    try {
      const data = await getJson('/api/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ season, workId: work }),
        credentials: 'same-origin',
      });
      if (!data.ok) {
        toast(data.message || '投票できませんでした。時間をおいてもう一度お試しください。');
        return;
      }
      if (data.status === 'limited') {
        toast('投票が集中しています。少し時間をおいてからお試しください。');
        return;
      }
      markVoted(season, work);
      const col = collect(season, work);
      $$(`[data-vote][data-season="${season}"][data-work="${work}"]`).forEach(setVoted);
      if (data.status === 'already') {
        if (!isTagged(season, work)) openTagSheet(season, work, title);
        else toast('今日はもう「すき」を送りました。明日また送れます。');
        return;
      }
      flyHeart(btn);
      const base = data.rank ? `『${title}』にすきを送りました。いま${data.rank}位です` : `『${title}』にすきを送りました`;
      toast(col.unlocked ? `称号「${col.unlocked[1]}」を手に入れました！（コレクション${col.count}作品）`
        : col.added ? `${base}（コレクション${col.count}作品目）` : base);
      $$(`[data-ranking][data-season="${season}"]`).forEach((s) => s.dispatchEvent(new CustomEvent('sukioshi:voted')));
      $$(`[data-work-rank][data-season="${season}"]`).forEach((el) => loadWorkRank(el, data));
      setTimeout(() => openTagSheet(season, work, title, { rank: data.rank }), 700);
    } catch {
      toast('通信できませんでした。電波の良いところでもう一度お試しください。');
    } finally {
      btn.classList.remove('is-busy');
    }
  });

  // ---------- コレクションのページ ----------
  const colRoot = $('[data-collection]');
  if (colRoot) {
    const TYPE_LABEL = { manga: '漫画', novel: '小説/ライトノベル' };
    const state = { type: 'all' };
    const listEl = $('[data-col-list]', colRoot);
    const emptyEl = $('[data-col-empty]', colRoot);
    const summaryEl = $('[data-col-summary]', colRoot);
    const filtersEl = $('[data-col-filters]', colRoot);
    const errEl = $('[data-col-error]', colRoot);
    const c = getCollection();
    const total = Object.keys(c.items).length;

    function renderSummary() {
      summaryEl.hidden = total === 0;
      $('[data-col-count]', colRoot).textContent = fmt(total);
      const cur = badgeAt(total);
      const next = BADGES.find(([min]) => min > total);
      $('[data-col-title]', colRoot).textContent = cur ? `称号：${cur[1]}` : '';
      const pct = next ? Math.max(6, Math.round((total / next[0]) * 100)) : 100;
      $('[data-col-bar]', colRoot).style.width = `${pct}%`;
      $('[data-col-next]', colRoot).textContent = next
        ? `あと${next[0] - total}作品で「${next[1]}」`
        : 'すべての称号を手に入れました！';
      $('[data-col-badges]', colRoot).innerHTML = BADGES
        .map(([min, name]) => `<li class="col-badge${total >= min ? ' is-got' : ''}"><span class="col-badge-n">${min}</span>${name}</li>`)
        .join('');
    }

    function renderList(index) {
      const items = Object.entries(c.items)
        .map(([id, v]) => ({ id, s: v.s, t: v.t || 0, w: index.works[id] }))
        .filter((x) => x.w && (state.type === 'all' || x.w[1] === state.type));
      const groups = new Map();
      for (const x of items) { if (!groups.has(x.s)) groups.set(x.s, []); groups.get(x.s).push(x); }
      const order = Object.keys(index.seasons);
      const keys = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      listEl.innerHTML = keys.map((sid) => {
        const rows = groups.get(sid).sort((a, b) => b.t - a.t).map((x) => `<li class="col-item"><a href="/works/${x.id}/">
<span class="col-cover"><img data-cover="${x.id}" alt="" width="96" height="134"></span>
<span class="col-name">${x.w[0].replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))}</span>
<span class="col-type col-type-${x.w[1]}">${TYPE_LABEL[x.w[1]] || ''}</span></a></li>`).join('');
        return `<section class="col-group"><h2>${index.seasons[sid] || sid}<span class="col-group-n">${groups.get(sid).length}作品</span></h2><ul class="col-grid">${rows}</ul></section>`;
      }).join('');
      emptyEl.hidden = total > 0;
      observeCovers(listEl);
    }

    renderSummary();
    emptyEl.hidden = total > 0;
    filtersEl.hidden = total === 0;
    if (total > 0) {
      getJson(colRoot.dataset.index).then((index) => {
        renderList(index);
        $$('[data-col-type]', filtersEl).forEach((b) => b.addEventListener('click', () => {
          state.type = b.dataset.colType;
          $$('[data-col-type]', filtersEl).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          renderList(index);
        }));
      }).catch(() => { errEl.hidden = false; });
    }

    $('[data-col-share]', colRoot)?.addEventListener('click', () => {
      const cur = badgeAt(total);
      const text = `すきおしで${total}作品を「すき」コレクションしました！${cur ? `\n称号：${cur[1]}` : ''}\n#すきおし`;
      const u = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(config.siteUrl || location.origin)}`;
      window.open(u, '_blank', 'noopener');
    });
  }

  // ---------- マイすきカード（コレクションから5作品を選んで、カードにして共有する） ----------
  const meRoot = $('[data-me]');
  if (meRoot) {
    const ME_KEY = 'sukioshi:me';
    const ME_MAX = 5;
    const ME_TYPE = { manga: '漫画', novel: '小説/ライトノベル' };
    const q = (s) => $(s, meRoot);
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };
    const cleanComment = (t) => Array.from(String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 40).join('');
    const cardUrl = (ids, c) => `${location.origin}/me/?w=${ids.join(',')}${c ? '&c=' + encodeURIComponent(c) : ''}`;
    const errEl = q('[data-me-error]');

    // 作品の行（順位・表紙・作品名・種類）。decorate で操作ボタンを足せる
    function renderCard(ol, ids, index, { link = false, decorate = null } = {}) {
      ol.replaceChildren(...ids.map((id, i) => {
        const w = index.works[id];
        const li = mk('li', 'me-row');
        const main = link ? mk('a', 'me-link') : mk('div', 'me-link');
        if (link) main.href = `/works/${id}/`;
        const img = document.createElement('img');
        img.dataset.cover = id; img.alt = ''; img.width = 96; img.height = 134;
        const cv = mk('span', 'col-cover me-cover');
        cv.append(img);
        main.append(mk('span', 'me-rank', String(i + 1)), cv, mk('span', 'me-name', w[0]), mk('span', `col-type col-type-${w[1]}`, ME_TYPE[w[1]] || ''));
        li.append(main);
        if (decorate) decorate(li, i);
        return li;
      }));
      observeCovers(ol);
    }

    // 共有用の画像（作品名と一言だけ。表紙は含めない）
    async function drawImage(ids, comment, index) {
      try { await document.fonts?.ready; } catch { /* 無視 */ }
      const W = 1200, H = 675;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#fbeaf0'; g.fillRect(0, 0, W, 120);
      g.fillStyle = '#d4537e'; g.fillRect(0, 0, 14, H);
      g.textBaseline = 'middle';
      g.fillStyle = '#993556'; g.font = `700 50px ${font}`;
      g.fillText(`わたしのすき${ids.length}選`, 56, 62);
      const fit = (text, max, size) => {
        let s = size;
        g.font = `700 ${s}px ${font}`;
        while (s > 24 && g.measureText(text).width > max) { s -= 2; g.font = `700 ${s}px ${font}`; }
        if (g.measureText(text).width <= max) return text;
        let t = Array.from(text);
        while (t.length > 1 && g.measureText(t.join('') + '…').width > max) t.pop();
        return t.join('') + '…';
      };
      const rowH = 78;
      ids.forEach((id, i) => {
        const y = 170 + i * rowH;
        g.fillStyle = '#d4537e';
        g.beginPath(); g.arc(80, y, 28, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.font = `700 32px ${font}`; g.textAlign = 'center';
        g.fillText(String(i + 1), 80, y + 1);
        g.textAlign = 'left'; g.fillStyle = '#2c2c2a';
        g.fillText(fit(index.works[id][0], 960, 38), 132, y + 1);
      });
      if (comment) {
        g.fillStyle = '#6b6a65'; g.font = `400 30px ${font}`;
        g.fillText(fit(`「${comment}」`, 1060, 30), 56, 590);
      }
      g.fillStyle = '#9a988f'; g.font = `700 26px ${font}`; g.textAlign = 'right';
      g.fillText('すきおし  sukioshi.com', W - 40, H - 28);
      return cv;
    }

    function setupEdit(index) {
      const editEl = q('[data-me-edit]');
      editEl.hidden = false;
      const emptyEl = q('[data-me-empty]');
      const workEl = q('[data-me-work]');
      const pickEl = q('[data-me-pick]');
      const selEl = q('[data-me-sel]');
      const selHint = q('[data-me-sel-hint]');
      const input = q('[data-me-input]');
      const lenEl = q('[data-me-len]');
      const actions = q('[data-me-actions]');
      const col = getCollection();
      const mine = Object.entries(col.items).filter(([id]) => index.works[id]).sort((a, b) => (b[1].t || 0) - (a[1].t || 0)).map(([id]) => id);
      if (!mine.length) { emptyEl.hidden = false; workEl.hidden = true; return; }
      const saved = store.get(ME_KEY, { w: [], c: '' });
      let sel = (saved.w || []).filter((id, i, a) => mine.includes(id) && a.indexOf(id) === i).slice(0, ME_MAX);
      input.value = cleanComment(saved.c);
      const save = () => store.set(ME_KEY, { w: sel, c: cleanComment(input.value) });

      pickEl.replaceChildren(...mine.map((id) => {
        const w = index.works[id];
        const li = mk('li', 'me-pick-item');
        const b = mk('button', 'me-pick-btn');
        b.type = 'button'; b.dataset.id = id;
        const img = document.createElement('img');
        img.dataset.cover = id; img.alt = ''; img.width = 96; img.height = 134;
        const cvr = mk('span', 'col-cover');
        cvr.append(img);
        b.append(cvr, mk('span', 'col-name', w[0]));
        li.append(b);
        return li;
      }));
      observeCovers(pickEl);

      function refresh() {
        $$('.me-pick-btn', pickEl).forEach((b) => b.setAttribute('aria-pressed', String(sel.includes(b.dataset.id))));
        selHint.textContent = sel.length ? `${sel.length} / ${ME_MAX} 作品えらびました` : 'まだえらんでいません。上の作品をタップしてください。';
        renderCard(selEl, sel, index, {
          decorate: (li, i) => {
            const bar = mk('span', 'me-ctl');
            const btn = (label, aria, fn, disabled) => {
              const b = mk('button', 'me-ctl-btn', label);
              b.type = 'button'; b.setAttribute('aria-label', aria); b.disabled = Boolean(disabled);
              b.addEventListener('click', fn);
              return b;
            };
            bar.append(
              btn('↑', '1つ上へ', () => { [sel[i - 1], sel[i]] = [sel[i], sel[i - 1]]; save(); refresh(); }, i === 0),
              btn('↓', '1つ下へ', () => { [sel[i + 1], sel[i]] = [sel[i], sel[i + 1]]; save(); refresh(); }, i === sel.length - 1),
              btn('外す', 'この作品を外す', () => { sel.splice(i, 1); save(); refresh(); }),
            );
            li.append(bar);
          },
        });
        actions.hidden = sel.length === 0;
        lenEl.textContent = `${Array.from(input.value).length} / 40`;
      }

      pickEl.addEventListener('click', (ev) => {
        const b = ev.target.closest('.me-pick-btn');
        if (!b) return;
        const id = b.dataset.id;
        if (sel.includes(id)) sel = sel.filter((x) => x !== id);
        else if (sel.length >= ME_MAX) { toast(`えらべるのは${ME_MAX}作品までです`); return; }
        else sel.push(id);
        save(); refresh();
      });
      input.addEventListener('input', () => {
        const c = Array.from(input.value);
        if (c.length > 40) input.value = c.slice(0, 40).join('');
        save(); lenEl.textContent = `${Array.from(input.value).length} / 40`;
      });

      q('[data-me-x]').addEventListener('click', () => {
        const c = cleanComment(input.value);
        const text = `わたしのすき${sel.length}選${c ? `\n${c}` : ''}\n#すきおし`;
        window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(cardUrl(sel, c))}`, '_blank', 'noopener');
      });
      q('[data-me-copy]').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(cardUrl(sel, cleanComment(input.value))); toast('リンクをコピーしました'); }
        catch { toast('コピーできませんでした'); }
      });
      q('[data-me-image]').addEventListener('click', async () => {
        const cvs = await drawImage(sel, cleanComment(input.value), index);
        cvs.toBlob(async (blob) => {
          if (!blob) { toast('画像を作れませんでした'); return; }
          const file = new File([blob], 'sukioshi-my-suki.png', { type: 'image/png' });
          try {
            if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
          } catch (e) { if (e && e.name === 'AbortError') return; }
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = 'sukioshi-my-suki.png';
          document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast('画像を保存しました');
        }, 'image/png');
      });
      // みんなのすきに載せる／更新／取り下げ（サーバーには作品IDとひとことだけが送られる）
      const pubBtn = q('[data-me-pub]');
      const unpubBtn = q('[data-me-unpub]');
      const pubStatus = q('[data-me-pub-status]');
      const PUB_KEY = 'sukioshi:me-pub';
      const showPub = (on) => { unpubBtn.hidden = !on; pubBtn.textContent = on ? 'カードを更新する' : 'みんなのすきに載せる'; };
      showPub(Boolean(store.get(PUB_KEY, false)));
      const postCard = (payload) => getJson('/api/cards', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin',
      });
      pubBtn.addEventListener('click', async () => {
        pubBtn.disabled = true; pubStatus.textContent = '送っています…';
        try {
          const d = await postCard({ w: sel, c: cleanComment(input.value) });
          if (d.ok) { store.set(PUB_KEY, true); showPub(true); pubStatus.textContent = 'みんなのすきに載せました。'; toast('みんなのすきに載せました'); }
          else pubStatus.textContent = d.message || '載せられませんでした。';
        } catch { pubStatus.textContent = '載せられませんでした。時間をおいてもう一度ためしてください。'; }
        pubBtn.disabled = false;
      });
      unpubBtn.addEventListener('click', async () => {
        unpubBtn.disabled = true;
        try {
          const d = await postCard({ remove: true });
          if (d.ok) { store.set(PUB_KEY, false); showPub(false); pubStatus.textContent = '取り下げました。'; }
          else pubStatus.textContent = d.message || '取り下げられませんでした。';
        } catch { pubStatus.textContent = '取り下げられませんでした。'; }
        unpubBtn.disabled = false;
      });
      refresh();
    }

    function setupView(index, ids, comment) {
      q('[data-me-view]').hidden = false;
      renderCard(q('[data-me-card]'), ids, index, { link: true });
      const c = q('[data-me-comment]');
      if (comment) { c.textContent = `「${comment}」`; c.hidden = false; }
      q('[data-me-view-lead]').textContent = `「すき」を${ids.length}作品、えらんだカードです。`;
    }

    const params = new URLSearchParams(location.search);
    getJson(meRoot.dataset.index).then((index) => {
      const ids = (params.get('w') || '').split(',').filter((id, i, a) => /^w\d{1,4}$/.test(id) && index.works[id] && a.indexOf(id) === i).slice(0, ME_MAX);
      if (ids.length && !params.get('new')) setupView(index, ids, cleanComment(params.get('c')));
      else setupEdit(index);
    }).catch(() => { errEl.hidden = false; });
  }

  // ---------- みんなのすき（公開カードの一覧） ----------
  const minnaRoot = $('[data-minna]');
  if (minnaRoot) {
    const listEl = $('[data-minna-list]', minnaRoot);
    const emptyEl = $('[data-minna-empty]', minnaRoot);
    const moreBtn = $('[data-minna-more]', minnaRoot);
    const errEl = $('[data-minna-error]', minnaRoot);
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    let index = null; let next = null; let shown = 0;

    function cardEl(card) {
      const box = mk('article', 'minna-card');
      const href = `/me/?w=${card.w.join(',')}${card.c ? '&c=' + encodeURIComponent(card.c) : ''}`;
      const a = mk('a', 'minna-link');
      a.href = href;
      const covers = mk('span', 'minna-covers');
      card.w.forEach((id) => {
        const img = document.createElement('img');
        img.dataset.cover = id; img.alt = ''; img.width = 96; img.height = 134;
        const cv = mk('span', 'col-cover minna-cover');
        cv.append(img);
        covers.append(cv);
      });
      const ol = mk('ol', 'minna-titles');
      card.w.forEach((id) => { const li = mk('li', null, index.works[id][0]); ol.append(li); });
      a.append(covers, ol);
      box.append(a);
      if (card.c) box.append(mk('p', 'minna-comment', `「${card.c}」`));
      const rep = mk('button', 'minna-report', '通報');
      rep.type = 'button';
      rep.addEventListener('click', async () => {
        if (!confirm('このカードを通報しますか？')) return;
        try {
          const d = await getJson('/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ report: card.id }), credentials: 'same-origin' });
          if (d.ok) { toast('通報しました。ありがとうございます'); rep.disabled = true; rep.textContent = '通報済み'; }
          else toast(d.message || '通報できませんでした');
        } catch { toast('通報できませんでした'); }
      });
      box.append(rep);
      return box;
    }

    async function load() {
      moreBtn.disabled = true;
      try {
        if (!index) index = await getJson(minnaRoot.dataset.index);
        const d = await getJson('/api/cards' + (next ? `?before=${next}` : ''));
        if (!d.ok) throw new Error('api');
        const cards = (d.cards || []).filter((c) => c.w.every((id) => index.works[id]));
        cards.forEach((c) => listEl.append(cardEl(c)));
        shown += cards.length;
        observeCovers(listEl);
        next = d.next;
        moreBtn.hidden = !next;
        emptyEl.hidden = shown > 0;
      } catch { errEl.hidden = false; }
      moreBtn.disabled = false;
    }
    moreBtn.addEventListener('click', load);
    load();
  }

  // ---------- ページの一番上に戻る ----------
  const toTop = $('[data-to-top]');
  if (toTop) {
    const onScroll = () => { toTop.hidden = window.scrollY < 600; };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    toTop.addEventListener('click', () => {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      $('#main')?.focus?.({ preventScroll: true });
    });
  }

  // ---------- さがすページ ----------
  const siteSearch = $('[data-site-search]');
  if (siteSearch) {
    const input = $('[data-site-search-input]', siteSearch);
    const status = $('[data-site-search-status]', siteSearch);
    const rows = $$('.search-item', siteSearch).map((li) => ({ li, key: normKey(li.dataset.searchKeys), type: li.dataset.type }));
    let type = 'all';
    const run = () => {
      const q = normKey(input.value);
      let n = 0;
      for (const r of rows) {
        r.li.hidden = (type !== 'all' && r.type !== type) || (q && !r.key.includes(q));
        if (!r.li.hidden) n++;
      }
      status.textContent = q ? (n ? `${n}作品が見つかりました` : '見つかりませんでした。ひらがなや短いことばでも試してみてください。') : `${n}作品`;
      const u = new URL(location.href);
      if (input.value) u.searchParams.set('q', input.value); else u.searchParams.delete('q');
      history.replaceState(null, '', u);
    };
    $$('[data-search-type]', siteSearch).forEach((b) => b.addEventListener('click', () => {
      type = b.dataset.searchType;
      $$('[data-search-type]', siteSearch).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      run();
    }));
    input.value = new URLSearchParams(location.search).get('q') || '';
    input.addEventListener('input', run);
    run();
    if (!input.value && window.matchMedia?.('(pointer: fine)').matches) input.focus();
  }

  // ---------- リンクをコピー ----------
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-copy-url]');
    if (!b) return;
    const url = b.dataset.copyUrl;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ url, title: document.title });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('リンクをコピーしました');
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      window.prompt('このリンクをコピーしてください', url);
    }
  });

  // ---------- 「ここがおすすめ」タグ ----------
  const TAGGED_KEY = 'sukioshi:tagged';
  const taggedToday = () => {
    const v = store.get(TAGGED_KEY, {});
    return v.day === jstDay() ? v : { day: jstDay(), works: {} };
  };
  const isTagged = (season, work) => Boolean(taggedToday().works[`${season}:${work}`]);
  const markTagged = (season, work) => {
    const v = taggedToday();
    v.works[`${season}:${work}`] = 1;
    store.set(TAGGED_KEY, v);
  };

  const sheet = $('[data-tag-sheet]');
  let sheetTarget = null;
  // 投票した直後だけ、シート内にシェアボタンを出す（rank があれば順位も入れる）
  function setSheetShare(work, title, rank) {
    const box = sheet && $('[data-sheet-share]', sheet);
    if (!box) return;
    if (!work) { box.hidden = true; return; }
    const url = `${config.siteUrl || location.origin}/works/${work}/`;
    const text = rank ? `私の推しは${title}！ いま${rank}位 #すきおし` : `私の推しは${title}！ #すきおし`;
    $('[data-sheet-share-x]', box).href = 'https://x.com/intent/post?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url);
    $('[data-sheet-share-line]', box).href = 'https://social-plugins.line.me/lineit/share?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
    box.hidden = false;
  }
  function openTagSheet(season, work, title, share) {
    if (!sheet) return;
    setSheetShare(share ? work : null, title, share && share.rank);
    sheetTarget = { season, work };
    $('[data-tag-sheet-work]', sheet).textContent = `『${title}』`;
    $$('[data-tag-pick]', sheet).forEach((b) => b.setAttribute('aria-pressed', 'false'));
    $('[data-tag-sheet-error]', sheet).hidden = true;
    sheet.hidden = false;
    document.body.classList.add('no-scroll');
    $('[data-tag-pick]', sheet)?.focus();
  }
  function closeTagSheet() {
    if (!sheet) return;
    sheet.hidden = true;
    document.body.classList.remove('no-scroll');
    sheetTarget = null;
  }
  if (sheet) {
    const max = () => config.maxTags || 3;
    sheet.addEventListener('click', async (ev) => {
      if (ev.target === sheet) { closeTagSheet(); return; }
      const pick = ev.target.closest('[data-tag-pick]');
      const err = $('[data-tag-sheet-error]', sheet);
      if (pick) {
        const on = pick.getAttribute('aria-pressed') === 'true';
        const count = $$('[data-tag-pick][aria-pressed="true"]', sheet).length;
        if (!on && count >= max()) {
          err.textContent = `選べるのは${max()}つまでです。`;
          err.hidden = false;
          return;
        }
        err.hidden = true;
        pick.setAttribute('aria-pressed', String(!on));
        return;
      }
      if (ev.target.closest('[data-tag-skip]')) { closeTagSheet(); return; }
      if (ev.target.closest('[data-tag-send]') && sheetTarget) {
        const tags = $$('[data-tag-pick][aria-pressed="true"]', sheet).map((b) => b.dataset.tagPick);
        if (!tags.length) {
          err.textContent = 'おすすめポイントを1つ以上選んでください。';
          err.hidden = false;
          return;
        }
        const { season, work } = sheetTarget;
        try {
          const data = await getJson('/api/tags', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ season, workId: work, tags }),
            credentials: 'same-origin',
          });
          if (!data.ok) {
            err.textContent = data.message || '送れませんでした。';
            err.hidden = false;
            return;
          }
          markTagged(season, work);
          closeTagSheet();
          toast('おすすめポイントを送りました。ありがとう！');
          const box = $(`[data-work-tags][data-season="${season}"]`);
          if (box && workPage?.dataset.workPage === work) renderWorkTags(box, data.tags);
        } catch {
          err.textContent = '通信できませんでした。もう一度お試しください。';
          err.hidden = false;
        }
      }
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !sheet.hidden) closeTagSheet(); });
  }

  function renderWorkTags(box, list) {
    const ul = $('[data-work-tags-list]', box);
    const empty = $('[data-work-tags-empty]', box);
    ul.innerHTML = '';
    empty.hidden = list.length > 0;
    const top = Math.max(1, ...list.map((t) => t.count));
    for (const t of list) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tb-label"></span><span class="tb-bar"><span class="tb-fill"></span></span><span class="tb-count"></span>';
      $('.tb-label', li).textContent = t.label;
      $('.tb-fill', li).style.width = `${Math.round((t.count / top) * 100)}%`;
      $('.tb-count', li).textContent = `${fmt(t.count)}人`;
      ul.appendChild(li);
    }
  }

  // ---------- 作品ページ ----------
  const workPage = $('[data-work-page]');
  async function seasonRows(season) {
    const data = await getJson(`/api/ranking?season=${encodeURIComponent(season)}&period=season&type=all`);
    if (!data.ok) throw new Error('ranking');
    return data.rows;
  }
  async function loadWorkRank(el, fresh) {
    const workId = workPage.dataset.workPage;
    try {
      let mine = fresh;
      if (!mine) mine = (await seasonRows(el.dataset.season)).find((r) => r.workId === workId);
      $('[data-wr-rank]', el).textContent = mine?.rank ?? 'まだ順位なし';
      $('.wr-value small', el).hidden = !mine?.rank;
      $('.wr-value', el).classList.toggle('is-empty', !mine?.rank);
      $('[data-wr-count]', el).textContent = fmt(mine?.count);
    } catch { /* 表示できなくても他は動かす */ }
  }
  if (workPage) {
    const id = workPage.dataset.workPage;
    const rankEl = $('[data-work-rank]', workPage);
    const ph = phase(rankEl.dataset.voteStart, rankEl.dataset.voteEnd);
    if (ph !== 'open') {
      $$('[data-vote]', workPage).forEach((b) => b.classList.add('is-closed'));
      const note = $('[data-closed-note]', workPage);
      if (note && ph === 'closed') note.hidden = false;
    }
    loadWorkRank(rankEl);
    const tagBox = $('[data-work-tags]', workPage);
    if (tagBox) {
      getJson(`/api/tags?season=${encodeURIComponent(tagBox.dataset.season)}&workId=${encodeURIComponent(id)}`)
        .then((d) => { if (d.ok) renderWorkTags(tagBox, d.tags); })
        .catch(() => {});
    }
    $$('[data-history]', workPage).forEach(async (li) => {
      try {
        const mine = (await seasonRows(li.dataset.season)).find((r) => r.workId === id);
        $('[data-hl-rank]', li).textContent = mine?.rank ? `${mine.rank}位` : '–';
      } catch { /* 無視 */ }
    });
    // 楽天の商品リンクと作者名
    const links = $$('[data-book-link]', workPage);
    links.forEach((a) => a.classList.add('is-disabled'));
    loadBook(id).then((d) => {
      if (!d || !d.ok) return;
      links.forEach((a) => { a.href = d.url; a.classList.remove('is-disabled'); });
      const img = $('img[data-cover]', workPage);
      if (img && !img.src) img.src = d.imageUrl;
      const author = $('[data-book-author]', workPage);
      if (author && (d.author || d.publisherName)) {
        author.textContent = [d.author && `作者：${d.author}`, d.publisherName].filter(Boolean).join('　');
        author.hidden = false;
      }
    });
  }

  // ---------- シーズン一覧・バナー ----------
  $$('[data-season-row]').forEach((row) => {
    const ph = phase(row.dataset.voteStart, row.dataset.voteEnd);
    const el = $('[data-season-status]', row);
    el.textContent = { open: '投票受付中', closed: '投票終了・最終結果', before: 'これから' }[ph];
    if (ph === 'closed') el.classList.add('is-closed');
  });
  $$('[data-show-until]').forEach((el) => { if (jstDay() > el.dataset.showUntil) el.hidden = true; });

  // ---------- 運営者ページ：週間ランキング投稿 ----------
  const adminForm = $('[data-admin-form]');
  if (adminForm) {
    const xLength = (text) => {
      let n = 0;
      const rest = text.replace(/https?:\/\/\S+/g, () => { n += 23; return ''; });
      for (const ch of rest) n += ch.charCodeAt(0) <= 0x7f ? 1 : 2;
      return n;
    };
    try { adminForm.key.value = sessionStorage.getItem('sukioshi:admin') || ''; } catch { /* 無視 */ }
    adminForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('[data-admin-error]');
      err.hidden = true;
      const key = adminForm.key.value.trim();
      if (!key) { err.textContent = '合言葉を入れてください。'; err.hidden = false; return; }
      try {
        const data = await getJson(`/api/admin/weekly?season=${encodeURIComponent(adminForm.season.value)}`, { headers: { 'x-admin-key': key } });
        if (!data.ok) { err.textContent = data.message || '集計できませんでした。'; err.hidden = false; return; }
        try { sessionStorage.setItem('sukioshi:admin', key); } catch { /* 無視 */ }
        const box = $('[data-admin-result]');
        box.hidden = false;
        $('[data-admin-title]').textContent = `${data.label}（${data.from}〜${data.to}）`;
        $('[data-admin-top]').innerHTML = '';
        data.top.forEach((r) => {
          const li = document.createElement('li');
          li.textContent = `${r.title}　${fmt(r.count)}すき${r.prevRank ? `（前週${r.prevRank}位）` : '（前週圏外）'}`;
          $('[data-admin-top]').appendChild(li);
        });
        $('[data-admin-riser]').textContent = data.riser ? `急上昇：${data.riser.title}（${data.riser.prevRank ? `${data.riser.prevRank}位→` : '圏外→'}${data.riser.rank}位）` : '急上昇：なし';
        const posts = $('[data-admin-posts]');
        posts.innerHTML = '';
        if (!data.posts.length) posts.textContent = 'まだ票がないため、投稿文は作れませんでした。';
        data.posts.forEach((text, i) => {
          const wrap = document.createElement('div');
          wrap.className = 'post-box';
          wrap.innerHTML = `<label class="post-meta">投稿文 ${i + 1}（文字数 <span data-len></span>/280）</label><textarea class="post-text"></textarea><a class="btn btn-share" target="_blank" rel="noopener">Xで投稿する</a>`;
          const ta = $('textarea', wrap);
          const len = $('[data-len]', wrap);
          const a = $('a', wrap);
          const update = () => {
            const n = xLength(ta.value);
            len.textContent = n;
            len.parentElement.classList.toggle('is-over', n > 280);
            a.href = 'https://x.com/intent/post?text=' + encodeURIComponent(ta.value);
          };
          ta.value = text;
          ta.addEventListener('input', update);
          update();
          posts.appendChild(wrap);
        });
      } catch {
        err.textContent = '通信できませんでした。';
        err.hidden = false;
      }
    });
  }
})();
