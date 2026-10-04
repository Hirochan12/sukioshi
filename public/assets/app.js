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
    try { saved = JSON.parse(sessionStorage.getItem('sukioshi:book3:' + id) || 'null'); } catch { /* 無視 */ }
    const p = saved ? Promise.resolve(saved) : new Promise((resolve) => { queue.push({ id, resolve, tries: 0 }); pump(); });
    bookCache.set(id, p);
    return p;
  }
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      running++;
      getJson('/api/book?id=' + encodeURIComponent(job.id) + '&v=3')
        .catch(() => ({ ok: false, code: 'network' }))
        .then((data) => {
          if (!data.ok && (data.code === 'busy' || data.code === 'network') && job.tries < 3) {
            job.tries++;
            setTimeout(() => { queue.push(job); pump(); }, 1500 * job.tries);
            return;
          }
          if (data.ok) { try { sessionStorage.setItem('sukioshi:book3:' + job.id, JSON.stringify(data)); } catch { /* 無視 */ } }
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
  $$('img[data-cover]').forEach((img) => {
    if (coverObserver) coverObserver.observe(img);
    else loadBook(img.dataset.cover).then((d) => applyBook(img, d));
  });

  // ---------- 広告 ----------
  function fillAd(slotEl) {
    if (!config.adsenseClient || slotEl.dataset.filled) return;
    const name = slotEl.dataset.adSlot;
    const unit = (config.adSlots || {})[name] || (config.adSlots || {})['ranking-inline'];
    slotEl.hidden = false;
    slotEl.dataset.filled = '1';
    if (!unit) return; // ユニットIDがなければ自動広告に任せ、場所だけ確保
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
    const state = { period: 'season', type: 'all', tag: '', phase: phase(section.dataset.voteStart, section.dataset.voteEnd) };
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

    function filterOnly() {
      for (const li of items.values()) li.hidden = state.type !== 'all' && li.dataset.type !== state.type;
    }

    function render(rows) {
      $$('.ad-slot', list).forEach((a) => a.remove());
      const shown = new Set(rows.map((r) => r.workId));
      for (const [id, li] of items) li.hidden = !shown.has(id);
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
      $$(`[data-vote][data-season="${season}"][data-work="${work}"]`).forEach(setVoted);
      if (data.status === 'already') {
        if (!isTagged(season, work)) openTagSheet(season, work, title);
        else toast('今日はもう「すき」を送りました。明日また送れます。');
        return;
      }
      flyHeart(btn);
      toast(data.rank ? `『${title}』にすきを送りました。いま${data.rank}位です` : `『${title}』にすきを送りました`);
      $$(`[data-ranking][data-season="${season}"]`).forEach((s) => s.dispatchEvent(new CustomEvent('sukioshi:voted')));
      $$(`[data-work-rank][data-season="${season}"]`).forEach((el) => loadWorkRank(el, data));
      setTimeout(() => openTagSheet(season, work, title), 700);
    } catch {
      toast('通信できませんでした。電波の良いところでもう一度お試しください。');
    } finally {
      btn.classList.remove('is-busy');
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
  function openTagSheet(season, work, title) {
    if (!sheet) return;
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
