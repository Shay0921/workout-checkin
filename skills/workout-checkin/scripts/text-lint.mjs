/**
 * 文案「模式坍缩」的机器可检部分（纯函数、零依赖）
 *
 * 只做一件事：**骨架重合**（数字归一后字符 bigram Jaccard）。
 * 跨期照抄上期同栏、跨人复用同一句式，都能量化；只换数字的复制靠人眼抽查发现不了，必须由脚本拦。
 *
 * 骨架阈值按「正常改写」与「坍缩」之间的空档定：0.80 报错 / 0.65 告警。
 * 供 render.mjs（跨期）与 personal.mjs（跨人）共用。
 */

/** 骨架化：数字归一为 #，去掉标点与空白 */
export const skeleton = (s) =>
  String(s || '')
    .replace(/[0-9０-９]+(\.[0-9]+)?/g, '#')
    .replace(/[^\u4e00-\u9fa5#a-zA-Z]/g, '');

/** 字符 bigram 集合 */
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 两段文案的骨架相似度（Jaccard，0–1） */
export function skeletonSimilarity(a, b) {
  const A = bigrams(skeleton(a));
  const B = bigrams(skeleton(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 同批文案两两比对，找出骨架重合的配对（跨人同脸 / 跨栏复读）
 * @param {Array<{key:string, text:string}>} items
 * @param {{hard?:number, soft?:number}} opts hard=报错线，soft=告警线
 * @returns {{copied:Array, similar:Array}} copied 为 ≥hard，similar 为 soft–hard
 */
export function findSkeletonDuplicates(items, { hard = 0.8, soft = 0.65 } = {}) {
  const copied = [];
  const similar = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = skeletonSimilarity(items[i].text, items[j].text);
      const hit = { a: items[i].key, b: items[j].key, sim };
      if (sim >= hard) copied.push(hit);
      else if (sim >= soft) similar.push(hit);
    }
  }
  const bySim = (x, y) => y.sim - x.sim;
  return { copied: copied.sort(bySim), similar: similar.sort(bySim) };
}
