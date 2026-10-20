// 每天自动翻译推荐频道的节目标题（由 GitHub Actions 定时运行，见 .github/workflows/titles.yml）
//   1. 读取 channels.json 里的推荐频道 RSS，取每个频道最新 80 集的标题
//   2. 已经翻译过的跳过，新标题用 DeepL 翻译：英语 → 简体中文；西语 → 简体中文 + 英语；中文 → 英语
//   3. 繁体由简体经 OpenCC（台湾用词）转换，不额外花翻译额度
//   4. 写入 titles.json：{ v, updated, t: { 原标题: { zh, tw, en } } }，App 下载后显示在列表第二行
// 只用到公开的节目标题，不涉及任何用户数据
// 用法: DEEPL_API_KEY=xxx node tools/translate-titles.mjs   （需要 opencc-js）
//       DRY=1 node tools/translate-titles.mjs   只统计要翻译多少字符，不调用 DeepL、不写文件
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OpenCC = require('opencc-js');
const toTw = OpenCC.Converter({ from: 'cn', to: 'twp' });

const KEY = process.env.DEEPL_API_KEY;
const DRY = !!process.env.DRY;
const API = KEY?.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate';
const OUT = 'titles.json';
const PER_FEED = 80; // 比 App 缓存的 50 集多取一些：App 会跳过没有音频的条目，两边的"最新 50 集"不完全一样
const UA = 'AINGO/1.0 (title translation)';

// 和 App 里一样的标题规范化：解码常见实体、合并空白。App 按同样的规则查找翻译
export function normTitle(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

// 不依赖 XML 库：只取 <item> 里的 <title>
function titlesOf(xml) {
  const out = [];
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const m = item.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    if (m) out.push(normTitle(m[1]));
    if (out.length >= PER_FEED) break;
  }
  return out.filter(Boolean);
}

// 各学习语言的标题要翻成哪些语言（DeepL 的语言代码）
const TARGETS = { en: { zh: 'ZH-HANS' }, es: { zh: 'ZH-HANS', en: 'EN-US' }, zh: { en: 'EN-US' } };
const SOURCE = { en: 'EN', es: 'ES', zh: 'ZH' };

async function deepl(texts, source, target) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: texts, source_lang: source, target_lang: target }),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  return (await res.json()).translations.map((x) => x.text);
}

async function main() {
  if (!KEY && !DRY) {
    console.log('没有设置 DEEPL_API_KEY，跳过');
    return;
  }
  const channels = JSON.parse(fs.readFileSync('channels.json', 'utf8'));
  const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).t : {};

  // 1. 收集当前所有标题
  const byLang = {}; // lang -> Set(标题)
  for (const c of channels) {
    try {
      const xml = await (await fetch(c.url, { headers: { 'User-Agent': UA } })).text();
      for (const t of titlesOf(xml)) (byLang[c.lang] ||= new Set()).add(t);
    } catch (e) {
      console.log('读取失败', c.url, e.message);
    }
  }

  // 2. 只翻译新标题，按 50 条一批
  const next = {};
  let chars = 0;
  for (const [lang, set] of Object.entries(byLang)) {
    const titles = [...set];
    for (const t of titles) if (old[t]) next[t] = old[t]; // 保留旧翻译；不再出现的标题自然被清掉
    for (const [field, target] of Object.entries(TARGETS[lang] || {})) {
      const todo = titles.filter((t) => !next[t]?.[field]);
      for (let i = 0; i < todo.length; i += 50) {
        const batch = todo.slice(i, i + 50);
        const out = DRY ? batch.map((t) => `[${target}] ${t}`) : await deepl(batch, SOURCE[lang], target);
        batch.forEach((t, k) => {
          next[t] = { ...next[t], [field]: out[k] };
          if (field === 'zh') next[t].tw = toTw(out[k]);
        });
        chars += batch.join('').length;
      }
    }
  }

  if (DRY) {
    console.log('示例', Object.entries(next).slice(0, 3));
    console.log(`DRY：标题 ${Object.keys(next).length} 个，需要翻译 ${chars} 字符`);
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify({ v: 1, updated: new Date().toISOString(), t: next }));
  console.log(`标题 ${Object.keys(next).length} 个，本次翻译 ${chars} 字符`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
