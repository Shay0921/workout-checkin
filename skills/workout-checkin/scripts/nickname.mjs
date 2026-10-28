/**
 * 昵称归一与别名解析（calc / cumulative / personal 共用）
 * 归一化只保留字母、数字、文字并转小写：emoji、波浪号、标点、空白一律剥离。
 */

/** 原始昵称 → 归一化 key */
export function normalizeName(raw) {
  return String(raw ?? '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/**
 * 构建「归一化昵称/别名 → 当前规范名」索引。
 * 同一成员的 nickname 与 aliases 都指向 nickname；跨成员撞车由 preflight 拦截。
 */
export function buildNicknameIndex(members) {
  const index = new Map();
  for (const m of members || []) {
    if (!m || typeof m.nickname !== 'string') continue;
    const aliases = Array.isArray(m.aliases) ? m.aliases : [];
    for (const name of [m.nickname, ...aliases]) {
      const key = normalizeName(name);
      if (key) index.set(key, m.nickname);
    }
  }
  return index;
}

/** 原始昵称 → 当前规范名；未命中时原样返回 */
export function canonicalName(raw, index) {
  const key = normalizeName(raw);
  return (key && index.get(key)) || raw;
}
