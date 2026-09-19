import fs from 'fs/promises';
import http from 'http';

const env = process.env;

const BOT_TOKEN = env.BOT_TOKEN || '8889273791:AAE_kh1MxwVsUqNMAJl6LhpCE00VkAwoPmE';
const CHAT_ID = env.CHAT_ID || '1246093763';
const LLM_API_KEY = env.LLM_API_KEY || 'ВАШ_КЛЮЧ';
const LLM_BASE_URL = env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = env.LLM_MODEL || 'gpt-4o-mini';
const CHECK_INTERVAL_MIN = Number(env.CHECK_INTERVAL_MIN || 240);
const PORT = Number(env.PORT || 8080);
const STATE_FILE = env.STATE_FILE || 'state.json';
const MAX_PAGES = Number(env.MAX_PAGES || 5);

const DEFAULT_CHANNELS = [
  'TraderWB',
  'trader_pattern_official',
  'trtchart',
  'signals_moex',
  'Vladimir_Sochi_trading',
  'IntradingMoex',
  'ddluuxx_trading',
];

const DEFAULT_AD_WORDS = [
  'реклам', 'промокод', 'промо', 'оффер', 'спонсор', 'партнёр', 'партнер',
  'скидк', 'распродаж', 'подарок', 'розыгрыш', 'конкурс', 'оплачен',
  'сотрудничеств', 'инфоповод', 'напишите в лс', 'пишите в лс', 'первым 10',
];

const CHANNELS = env.CHANNELS ? splitList(env.CHANNELS).map(normalizeChannel) : DEFAULT_CHANNELS;
const AD_WORDS = env.AD_WORDS ? splitList(env.AD_WORDS).map(w => w.toLowerCase()) : DEFAULT_AD_WORDS;

let state = { baseline: {} };
let nextRunAt = null;
let running = false;

function splitList(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeChannel(s) {
  return s
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?t\.me\//, '')
    .replace(/\/+$/, '')
    .trim();
}

async function loadState() {
  try {
    state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    state = { baseline: {} };
  }
  if (!state.baseline) state.baseline = {};
  if (env.BEFORE_ID) {
    for (const part of env.BEFORE_ID.split(',')) {
      const [ch, id] = part.split(':').map(s => s.trim());
      if (ch && id && CHANNELS.includes(ch)) {
        const n = Number(id);
        if (Number.isInteger(n)) state.baseline[ch] = n;
      }
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state.baseline, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить состояние:', e.message);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

function stripTags(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#0?10;/g, '\n')
    .replace(/&#0?9;/g, '\t');
}

function cleanText(s) {
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function parsePosts(channel, html) {
  const starts = new Map();
  const postRe = /data-post="([^"]+)"/g;
  let m;
  while ((m = postRe.exec(html))) starts.set(m[1], m.index);
  const order = [...starts.entries()].sort((a, b) => a[1] - b[1]);
  const posts = [];
  for (let i = 0; i < order.length; i++) {
    const [postKey, start] = order[i];
    if (!postKey.startsWith(channel + '/')) continue;
    const idNum = Number(postKey.split('/')[1]);
    if (!Number.isInteger(idNum)) continue;
    const end = i + 1 < order.length ? order[i + 1][1] : html.length;
    const section = html.slice(start, end);
    const textMatch = section.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    if (!textMatch) continue;
    const text = cleanText(decodeEntities(stripTags(textMatch[1])));
    if (!text) continue;
    posts.push({ id: idNum, text });
  }
  posts.sort((a, b) => a.id - b.id);
  return posts;
}

async function fetchChannelPosts(channel) {
  const posts = [];
  let before = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://t.me/s/${channel}${before ? `?before=${before}` : ''}`;
    const html = await fetchText(url);
    const parsed = parsePosts(channel, html);
    if (parsed.length === 0) break;
    posts.push(...parsed);
    const oldest = parsed[0].id;
    if (oldest <= (state.baseline[channel] || 0)) break;
    before = oldest;
  }
  posts.sort((a, b) => a.id - b.id);
  return posts;
}

function isAd(text) {
  const t = text.toLowerCase();
  return AD_WORDS.some(w => t.includes(w));
}

function hasRealNumber(text) {
  const withoutPercents = text.replace(/\d+(?:[.,]\d+)?\s?%/g, '');
  return /\d/.test(withoutPercents);
}

function buildPrompt(text) {
  return `Ты — аналитик финансовых Telegram-каналов. Внимательно прочитай пост.

Пост:
"""
${text}
"""

Ответь СТРОГО в одном из двух вариантов:
1. Если в посте НЕТ информации про финансовый инструмент И его цену / ценовой уровень / ценовую зону / сигнал к действию — ответь ровно одно слово: NO_PRICE
2. Иначе дай разбор РОВНО в таком формате (каждая строчка с новой строки, в этой же очерёдности):
Инструмент: (название)
Тикер: (тикер, если нет — прочерк -)
Цена: (актуальная цена, если нет — прочерк -)
Уровень: (ценовой уровень/зона, если нет — прочерк -)
Действие: ПОКУПКА / ПРОДАЖА / НАБЛЮДЕНИЕ
Суть: (одно-два предложения, что происходит с инструментом)

Пиши только по фактам из поста, ничего не додумывай.`;
}

async function analyzePost(text) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: buildPrompt(text) }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) throw new Error(`TG HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function processPost(channel, post) {
  const text = cleanText(post.text);

  if (isAd(text)) {
    console.log(`  не интересует: ${channel}/${post.id} (реклама)`);
    return;
  }
  if (!hasRealNumber(text)) {
    console.log(`  не интересует: ${channel}/${post.id} (нет чисел)`);
    return;
  }

  let analysis;
  try {
    analysis = await analyzePost(text);
  } catch (e) {
    console.error(`  ошибка LLM: ${channel}/${post.id}: ${e.message}`);
    return;
  }

  if (!analysis.trim()) {
    console.log(`  не интересует: ${channel}/${post.id} (пустой ответ LLM)`);
    return;
  }
  if (/NO_PRICE/i.test(analysis)) {
    console.log(`  не интересует: ${channel}/${post.id} (нет цены/уровня по инструменту)`);
    return;
  }

  const link = `https://t.me/${channel}/${post.id}`;
  const fields = analysis
    .replace(/^NO_PRICE\s*/i, '')
    .split('\n')
    .map(s => s.replace(/^[*-]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const msg =
    `📊 <b>${escapeHtml(channel)}</b>\n` +
    `🔗 ${link}\n\n` +
    fields.map(escapeHtml).join('\n');

  await sendToTelegram(msg);
  console.log(`  отправлено: ${channel}/${post.id}`);
}

function printStateHint() {
  const parts = CHANNELS.map(c => `${c}:${state.baseline[c] || 0}`).join(',');
  console.log(`Состояние (для Railway Variables при редеплое):`);
  console.log(`BEFORE_ID=${parts}`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    console.log(`--- Проверка ${new Date().toISOString()} ---`);
    let processed = 0;
    for (const channel of CHANNELS) {
      try {
        const posts = await fetchChannelPosts(channel);
        if (posts.length === 0) {
          console.log(`[${channel}] постов не получено (канал скрыт/приватный?)`);
          continue;
        }
        const baseline = state.baseline[channel];
        if (baseline == null) {
          state.baseline[channel] = posts[posts.length - 1].id;
          console.log(`[${channel}] первый запуск — базовая точка ID=${state.baseline[channel]}, старых постов не шлю`);
          await saveState();
          continue;
        }
        const news = posts.filter(p => p.id > baseline);
        if (news.length) state.baseline[channel] = news[news.length - 1].id;
        console.log(`[${channel}] новых постов: ${news.length}`);
        for (const post of news) {
          try {
            await processPost(channel, post);
            processed++;
          } catch (e) {
            console.error(`  ошибка обработки ${channel}/${post.id}: ${e.message}`);
          }
          await sleep(1500);
        }
        await saveState();
      } catch (e) {
        console.error(`[${channel}] ошибка: ${e.message}`);
      }
      await sleep(1000);
    }
    console.log(`Готово. Обработано постов: ${processed}`);
    if (processed > 0) printStateHint();
  } finally {
    running = false;
  }
}

function startHealthServer() {
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 'ok',
      channels: CHANNELS.length,
      intervalMin: CHECK_INTERVAL_MIN,
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : 'на старте',
    }));
  }).listen(PORT, () => console.log(`Health-check: http://localhost:${PORT}`));
}

process.on('SIGINT', async () => { await saveState(); process.exit(0); });
process.on('SIGTERM', async () => { await saveState(); process.exit(0); });

async function main() {
  console.log('Бот запущен. Каналы:', CHANNELS.join(', '));
  console.log('Интервал проверки:', CHECK_INTERVAL_MIN, 'мин');
  await loadState();
  startHealthServer();
  await tick();
  nextRunAt = new Date(Date.now() + CHECK_INTERVAL_MIN * 60000);
  setInterval(async () => {
    nextRunAt = new Date(Date.now() + CHECK_INTERVAL_MIN * 60000);
    await tick();
  }, CHECK_INTERVAL_MIN * 60000);
}

main().catch(e => {
  console.error('Фатальная ошибка:', e);
  process.exit(1);
});