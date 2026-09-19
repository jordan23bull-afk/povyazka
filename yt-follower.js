import fs from 'fs/promises';

const env = process.env;

const BOT_TOKEN = env.BOT_TOKEN || '8889273791:AAE_kh1MxwVsUqNMAJl6LhpCE00VkAwoPmE';
const CHAT_ID = env.CHAT_ID || '1601688591';
const LLM_API_KEY = env.LLM_API_KEY || 'ВАШ_КЛЮЧ';
const LLM_BASE_URL = env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_MODEL = env.LLM_MODEL || 'gpt-4o-mini';
const SEEN_FILE = env.SEEN_FILE || 'seen-videos.json';
const MAX_CHARS = Number(env.MAX_CHARS || 24000);
const LIMIT_PER_CHANNEL = Number(env.LIMIT_PER_CHANNEL || 15);
const TEST_VIDEO_ID = (env.TEST_VIDEO_ID || '').trim();
const TEST_LATEST = env.TEST_LATEST === 'true' || env.TEST_LATEST === '1';

const DEFAULT_CHANNELS = [
  'Проф_трейдер',
  'TradersUniversity888',
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
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+678',
          'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        },
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

const ID_PATTERNS = [
  /"externalId":"(UC[\w-]{22})"/,
  /"channelId":"(UC[\w-]{22})"/,
  /\/channel\/(UC[\w-]{22})/,
  /"browseId":"(UC[\w-]{22})"/,
];

async function resolveChannelId(channel) {
  if (/^UC[\w-]{22}$/.test(channel)) return channel;
  const handle = channel.replace(/^@/, '').replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/+$/, '');
  const urls = [
    `https://www.youtube.com/@${encodeURIComponent(handle)}/about`,
    `https://m.youtube.com/@${encodeURIComponent(handle)}`,
  ];
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      for (const re of ID_PATTERNS) {
        const m = html.match(re);
        if (m) return m[1];
      }
    } catch {
      console.log(`  не удалось открыть ${url}`);
    }
  }
  throw new Error(`не удалось определить channelId для ${channel}`);
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

function extractCaptionTracks(html) {
  const m = html.match(/"captionTracks":\[([\s\S]*?)\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse('[' + m[1] + ']');
    return arr.map(t => ({
      url: t.baseUrl || '',
      lang: t.languageCode || '',
      isAsr: !!t.kind,
    }));
  } catch {
    return [];
  }
}

function extractShortDescription(html) {
  const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  return m[1]
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\\\/g, '\\');
}

async function fetchCaptionBase(baseUrl) {
  const sep = baseUrl.includes('?') ? '&' : '?';
  try {
    const raw = await fetchText(baseUrl + sep + 'fmt=json3');
    const data = JSON.parse(raw);
    const out = (data.events || [])
      .map(e => (e.segs || []).map(s => s.utf8 || '').join(''))
      .filter(s => s.trim())
      .join(' ');
    if (out) return out;
  } catch (e) {
    console.log(`    json3 не вышел (${e.message}), пробую дорожку напрямую`);
  }
  try {
    const xml = await fetchText(baseUrl);
    const srv3 = [...xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => decodeEntities(m[1]).trim())
      .filter(Boolean);
    if (srv3.length) return srv3.join(' ');
    const classic = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
      .map(m => decodeEntities(m[1]).replace(/<[^>]+>/g, '').trim())
      .filter(Boolean);
    if (classic.length) return classic.join(' ');
  } catch (e) {
    console.log(`    прямая дорожка не вышла (${e.message})`);
  }
  return null;
}

async function extractTranscriptFromPage(html) {
  const tracks = extractCaptionTracks(html);
  console.log('  caption tracks:', tracks.length, tracks.length ? tracks.slice(0, 3).map(t => `${t.lang}${t.isAsr ? '/asr' : ''}`).join(', ') : '');
  if (!tracks.length) return null;
  const ru = tracks.filter(t => t.lang.toLowerCase().startsWith('ru'));
  const asr = ru.length ? ru : tracks.filter(t => t.isAsr);
  const ordered = ru.concat(asr, tracks);
  const tried = new Set();
  for (const t of ordered) {
    if (tried.has(t.url + t.lang)) continue;
    tried.add(t.url + t.lang);
    const text = await fetchCaptionBase(t.url);
    if (text) return text;
  }
  return null;
}

async function fetchGoogleTimedText(videoId) {
  const urls = [
    `https://video.google.com/timedtext?lang=ru&v=${videoId}`,
    `https://video.google.com/timedtext?lang=en&v=${videoId}`,
    `https://video.google.com/timedtext?v=${videoId}`,
  ];
  for (const url of urls) {
    try {
      const xml = await fetchText(url);
      const parts = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)]
        .map(m => decodeEntities(m[1]).replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    } catch {}
  }
  return null;
}

async function getCaptionFromInnertube(videoId) {
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      body: JSON.stringify({
        context: {
          client: { clientName: 'ANDROID', clientVersion: '19.29.37', androidSdkVersion: 30, hl: 'ru', gl: 'RU' },
        },
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!res.ok) {
      console.log(`  innertube player http ${res.status}`);
      return null;
    }
    const data = await res.json();
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    console.log('  innertube tracks:', tracks.length, tracks.length ? tracks.slice(0, 3).map(t => `${t.languageCode}${t.kind ? '/asr' : ''}`).join(', ') : '');
    if (!tracks.length) return null;
    const ru = tracks.filter(t => (t.languageCode || '').toLowerCase().startsWith('ru'));
    const asr = ru.length ? ru : tracks.filter(t => t.kind && t.kind.includes('asr'));
    const ordered = ru.concat(asr, tracks);
    const tried = new Set();
    for (const t of ordered) {
      if (!t.baseUrl || tried.has(t.baseUrl)) continue;
      tried.add(t.baseUrl);
      const text = await fetchCaptionBase(t.baseUrl);
      if (text) return text;
    }
  } catch (e) {
    console.log(`  innertube не вышел: ${e.message}`);
  }
  return null;
}

async function gatherContent(video) {
  let html = '';
  for (const u of [
    `https://www.youtube.com/watch?v=${video.id}`,
    `https://m.youtube.com/watch?v=${video.id}`,
  ]) {
    try {
      html = await fetchText(u);
      if (html && extractCaptionTracks(html).length) break;
    } catch {}
  }
  if (html) {
    console.log(`  page ${html.length}b, ytInitialPlayerResponse: ${html.includes('ytInitialPlayerResponse')}, captionTracks in page: ${html.includes('captionTracks')}`);
  }
  let desc = html ? extractShortDescription(html) : '';
  if (!desc) desc = video.description || '';
  let transcript = html ? await extractTranscriptFromPage(html) : null;
  if (!transcript) transcript = await getCaptionFromInnertube(video.id);
  if (!transcript) transcript = await fetchGoogleTimedText(video.id);
  return { transcript, desc };
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
1. Если в видео НЕТ конкретных числовых значений цены / ценового уровня / ценовой зоны по финансовому инструменту — ответь ровно одно слово: NO_PRICE. Слова без цифр («уровень коррекции», «выше/ниже», «растёт/падает») ценой НЕ считаются.
2. Иначе дай разбор РОВНО в таком формате (каждая строчка с новой строки, в этой же очерёдности):
Инструмент: (название)
Тикер: (тикер, если нет — прочерк -)
Цена: (актуальная цена ЧИСЛОМ, если нет — прочерк -)
Уровень: (ценовой уровень/зона ЧИСЛОМ, если нет — прочерк -)
Действие: ПОКУПКА / ПРОДАЖА / НАБЛЮДЕНИЕ
Суть: (одно-два предложения о том, что происходит с инструментом)

Заполняй Цена/Уровень только реальными числами из видео. Пиши только по фактам, ничего не додумывай.`;
}

const LLM_RETRIES = Number(env.LLM_RETRIES || 6);
const LLM_RETRY_DELAY_MS = Number(env.LLM_RETRY_DELAY_MS || 20000);

async function analyze(title, description, transcript) {
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [{ role: 'user', content: buildPrompt(title, description, transcript) }],
    temperature: 0,
  });
  let lastErr;
  for (let attempt = 0; attempt < LLM_RETRIES; attempt++) {
    try {
      const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_KEY}`,
        },
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`LLM HTTP ${res.status}`);
        const wait = LLM_RETRY_DELAY_MS * (attempt + 1);
        console.log(`  LLM лимит/перегрузка (${res.status}), повтор ${attempt + 1}/${LLM_RETRIES} через ${Math.round(wait / 1000)}с`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (e) {
      lastErr = e;
      if (!/LLM HTTP (429|5\d\d)/.test(e.message)) throw e;
    }
  }
  throw lastErr;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function hasNumericPrice(analysis) {
  return [...analysis.matchAll(/^(?:Цена|Уровень)\s*[:：]\s*(.*)$/gm)].some(m => /\d/.test(m[1]));
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

  const { transcript, desc } = await gatherContent(video);
  console.log('  контент: транскрипт', transcript ? `${transcript.length} симв.` : 'нет', `/ описание ${desc.length} симв.`);
  let analysis;
  try {
    analysis = await analyze(video.title, desc, transcript);
  } catch (e) {
    console.error(`  ошибка LLM: ${e.message}`);
    return;
  }

  if (!analysis.trim()) {
    console.log('  LLM: пустой ответ → не интересует');
    return;
  }
  if (/NO_PRICE/i.test(analysis)) {
    console.log('  LLM: NO_PRICE → не интересует');
    return;
  }
  if (!hasNumericPrice(analysis)) {
    console.log('  LLM: разбор без чисел → не интересует');
    console.log('  ' + analysis.replace(/\n/g, '\n  ').slice(0, 500));
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
    for (const entry of CHANNELS) {
      try {
        const [channel, knownId] = entry.split(':');
        const channelId = knownId || await resolveChannelId(channel);
        const videos = TEST_LATEST
          ? await fetchLatestVideos(channelId, 1)
          : await fetchTodayVideos(channelId);
        console.log(`[${channel}] ${TEST_LATEST ? 'последнее видео' : 'видео за сегодня'}: ${videos.length}`);
        for (const video of videos) {
          if (!testMode && seen[video.id]) continue;
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
  const { transcript, desc } = await gatherContent(video);
  console.log('  контент: транскрипт', transcript ? `${transcript.length} симв.` : 'нет', `/ описание ${desc.length} симв.`);
  const analysis = await analyze(video.title, desc, transcript);
  if (!analysis.trim() || /NO_PRICE/i.test(analysis) || !hasNumericPrice(analysis)) {
    console.log('  не интересует: нет численной цены/уровня');
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