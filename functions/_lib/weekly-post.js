// 週間ランキングのX投稿文を作る部品。
// 将来 X API で自動投稿するときも、この関数をそのまま使える。

const OPENINGS = [
  '【すきおし 週間ランキング】',
  '今週いちばん「すき」を集めたのは…',
  '先週のすきおしランキングを発表！',
  '「すき」の数で見る、今週の推し原作',
];
const RISER_LINES = [
  (t) => `急上昇は『${t}』！`,
  (t) => `今週の注目は、順位を大きく上げた『${t}』`,
  (t) => `『${t}』がぐんぐん上昇中`,
];
const CLOSINGS = [
  'あなたの推しにも1票を',
  'すきなもの、おしえて',
  '推しの順位を上げるなら今',
];
const MEDALS = ['1位', '2位', '3位', '4位', '5位'];

// X の文字数の数え方に近い数え方（全角=2、半角=1、URL=23）
export function xLength(text) {
  const urlRe = /https?:\/\/\S+/g;
  let n = 0;
  const rest = text.replace(urlRe, () => {
    n += 23;
    return '';
  });
  for (const ch of rest) n += ch.charCodeAt(0) <= 0x7f ? 1 : 2;
  return n;
}

function shorten(title, max = 18) {
  const chars = [...title];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : title;
}

/**
 * @param {object} p
 * @param {string} p.seasonName 例: 2026秋
 * @param {{title:string,count:number}[]} p.top 上位（最大5件）
 * @param {{title:string}|null} p.riser 急上昇作品
 * @param {string} p.url ランキングページのURL
 * @param {number} p.seed 文面を週ごとに変えるための数（週番号など）
 * @returns {string[]} 投稿文の候補（3パターン）
 */
export function buildWeeklyPosts({ seasonName, top, riser, url, seed = 0 }) {
  const posts = [];
  for (let k = 0; k < 3; k++) {
    const s = seed + k;
    const opening = OPENINGS[s % OPENINGS.length];
    const closing = CLOSINGS[s % CLOSINGS.length];
    // 文字数が入りきるまで、作品数とタイトルの長さを減らしていく
    for (const [count, max] of [[5, 18], [5, 12], [3, 14], [3, 10], [1, 20]]) {
      const lines = [
        `${opening}（${seasonName}アニメ原作）`,
        '',
        ...top.slice(0, count).map((w, i) => `${MEDALS[i]} ${shorten(w.title, max)}`),
      ];
      if (riser) lines.push('', RISER_LINES[s % RISER_LINES.length](shorten(riser.title, max)));
      lines.push('', closing, url, '#すきおし');
      const text = lines.join('\n');
      if (xLength(text) <= 280) {
        posts.push(text);
        break;
      }
    }
  }
  return posts;
}
