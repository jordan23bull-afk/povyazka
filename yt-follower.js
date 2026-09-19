import fs from 'fs/promises';
import { YoutubeTranscript } from 'youtube-transcript';

const env = process.env;

const BOT_TOKEN = env.BOT_TOKEN || '8889273791:AAE_kh1MxwVsUqNMAJl6LhpCE00VkAwoPmE';
const CHAT_ID = env.CHAT_ID || '1246093763';
const LLM_API_KEY = env.LLM_API_KEY || 'ВАШ_КЛЮЧ';
const LLM_BASE_URL = env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = env.LLM_MODEL || 'gpt-4o-mini';
const SEEN_FILE = env.SEEN_FILE || 'seen-videos.json';
const MAX_CHARS = Number(env.MAX_CHARS || 24000);
const LIMIT_PER_CHANNEL = Number(env.LIMIT_PER_CHANNEL || 15);
const TEST_VIDEO_ID = (env.TEST_VIDEO_ID || '').trim();
const TEST_LATEST = env.TEST_LATEST === 'true' || env.TEST_LATEST === '1';

const DEFAULT_CHANNELS = [
  'golodgoroda',
  'stary_trader',
  'tradingnewsN1',
  'vataga',
  'Проф_трейдер',
  'aeadamovich',
  'TradersUniversity888',
  'market_insaids',
];
const CHANNELS = env.CHANNELS ? splitList(env.CHANNELS) : DEFAULT_CHANNELS;

function splitList(str) {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

async function loadSeen() {
  try {
    const data = JSON.parse(await fs.readFile(SEEN_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveSeen(seen) {
  await fs.writeFile(SEEN_FILE, JSON.stringify(seen, null, 2));
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

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#0?10;/g, '\n')
    .replace(/&#0?9;/g, '\t');
}

function parseFeed(xml) {
  const out = [];
  const entries = xml.split('<entry>').slice(1);
  for (const raw of entries) {
    const entry = raw.split('</entry>')[0];
    const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!idMatch) continue;
    const title = decodeEntities((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const description = decodeEntities((entry.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || '').trim();
    const published = (entry.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
    out.push({
      id: idMatch[1],
      title,
      description,
      published,
      link: `https://www.youtube.com/watch?v=${idMatch[1]}`,
    });
  }
  return out;
}

const MSK_OFFSET = 3 * 3600 * 1000;

function isToday(published) {
  const d = new Date(new Date(published).getTime() + MSK_OFFSET);
  if (isNaN(d.getTime())) return false;
  const now = new Date(Date.now() + MSK_OFFSET);
  return d.getUTCFullYear() === now.getUTCFullYear()
    && d.getUTCMonth() === now.getUTCMonth()
    && d.getUTCDate() === now.getUTCDate();
}

async function resolveChannelId(channel) {
  if (/^UC[\w-]{22}$/.test(channel)) return channel;
  const handle = channel.replace(/^@/, '').replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/+$/, '');
  const html = await fetchText(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
  const m = html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error(`не удалось определить channelId для ${channel}`);
  return m[1];
}

async function fetchTodayVideos(channelId) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return parseFeed(xml)
    .filter(v => isToday(v.published))
    .slice(0, LIMIT_PER_CHANNEL);
}

async function fetchLatestVideos(channelId, n) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  return parseFeed(xml).slice(0, n);
}

async function getTranscript(videoId) {
  try {
    const chunks = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'ru' })
      .catch(() => YoutubeTranscript.fetchTranscript(videoId));
    return chunks.map(c => c.text).join(' ');
  } catch {
    return null;
  }
}

function buildPrompt(title, description, transcript) {
  return `Ты — аналитик финансовых YouTube-каналов. Прочитай информацию о видео.

Название: ${title}
Описание:
"""
${(description || '').slice(0, 3000)}
"""
Транскрипт:
"""
${(transcript || '').slice(0, MAX_CHARS)}
"""

Ответь СТРОГО в одном из двух вариантов:
1. Если в видео НЕТ информации про финансовый инструмент И его цену / ценовой уровень / ценовую зону / сигнал к действию — ответь ровно одно слово: NO_PRICE
2. Иначе дай разбор РОВНО в таком формате (каждая строчка с новой строки, в этой же очерёдности):
Инструмент: (название)
Тикер: (тикер, если нет — прочерк -)
Цена: (актуальная цена, если нет — прочерк -)
Уровень: (ценовой уровень/зона, если нет — прочерк -)
Действие: ПОКУПКА / ПРОДАЖА / НАБЛЮДЕНИЕ
Суть: (одно-два предложения о том, что происходит с инструментом)

Пиши только по фактам из видео, ничего не додумывай.`;
}

async function analyze(title, description, transcript) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: buildPrompt(title, description, transcript) }],
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

async function processVideo(channelName, video) {
  console.log(`  видео: ${video.id} «${video.title}»`);

  const transcript = await getTranscript(video.id);
  let analysis;
  try {
    analysis = await analyze(video.title, video.description, transcript);
  } catch (e) {
    console.error(`  ошибка LLM: ${e.message}`);
    return;
  }

  if (!analysis.trim() || /NO_PRICE/i.test(analysis)) {
    console.log('  не интересует: нет цены/уровня по инструменту');
    return;
  }

  const fields = analysis
    .replace(/^NO_PRICE\s*/i, '')
    .split('\n')
    .map(s => s.replace(/^[*-]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  const msg =
    `🎬 <b>${escapeHtml(channelName)}</b>\n` +
    `<a href="${video.link}">${escapeHtml(video.title)}</a>\n\n` +
    fields.map(escapeHtml).join('\n');

  await sendToTelegram(msg);
  console.log('  отправлено');
}

async function main() {
  console.log('YouTube-сканер запущен');
  const testMode = !!(TEST_VIDEO_ID || TEST_LATEST);
  if (testMode) console.log('ТЕСТОВЫЙ РЕЖИМ:', TEST_VIDEO_ID || 'последнее видео каждого канала');
  console.log('Каналы:', CHANNELS.length ? CHANNELS.join(', ') : 'не заданы');

  if (CHANNELS.length === 0) {
    console.error('Список каналов пуст. Впиши их в DEFAULT_CHANNELS в yt-follower.js или задай переменную CHANNELS (через запятую).');
    process.exit(1);
  }

  const seen = await loadSeen();
  let processed = 0;

  if (TEST_VIDEO_ID) {
    const video = {
      id: TEST_VIDEO_ID,
      title: `Тест видео ${TEST_VIDEO_ID}`,
      description: '',
      published: '',
      link: `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`,
    };
    try {
      await testVideo(video);
      processed++;
    } catch (e) {
      console.error(`  ошибка: ${e.message}`);
    }
    seen[TEST_VIDEO_ID] = true;
    await saveSeen(seen);
  } else {
    for (const channel of CHANNELS) {
      try {
        const channelId = await resolveChannelId(channel);
        const videos = TEST_LATEST
          ? await fetchLatestVideos(channelId, 1)
          : await fetchTodayVideos(channelId);
        console.log(`[${channel}] ${TEST_LATEST ? 'последнее видео' : 'видео за сегодня'}: ${videos.length}`);
        for (const video of videos) {
          if (seen[video.id]) continue;
          try {
            await processVideo(channel, video);
            processed++;
          } catch (e) {
            console.error(`  ошибка обработки ${video.id}: ${e.message}`);
          }
          seen[video.id] = true;
          await saveSeen(seen);
          await sleep(1500);
        }
      } catch (e) {
        console.error(`[${channel}] ошибка: ${e.message}`);
      }
    }
  }

  await saveSeen(seen);
  console.log(testMode ? `Тест завершён. Обработано: ${processed}` : `Готово. Обработано новых видео: ${processed}`);
}

async function testVideo(video) {
  console.log(`  тест: ${video.id}`);
  const transcript = await getTranscript(video.id);
  console.log('  транскрипт:', transcript ? `${transcript.length} символов` : 'недоступен');
  const analysis = await analyze(video.title, video.description, transcript);
  if (!analysis.trim() || /NO_PRICE/i.test(analysis)) {
    console.log('  LLM ответил: не интересует (нет цены/уровня)');
    return;
  }
  const fields = analysis
    .replace(/^NO_PRICE\s*/i, '')
    .split('\n')
    .map(s => s.replace(/^[*-]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const msg =
    `🎬 <b>TEST</b>\n` +
    `<a href="${video.link}">${escapeHtml(video.title)}</a>\n\n` +
    fields.map(escapeHtml).join('\n');
  await sendToTelegram(msg);
  console.log('  отправлено');
}

main().catch(e => {
  console.error('Фатальная ошибка:', e);
  process.exit(1);
});